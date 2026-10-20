"""Aggregates ETW network events into per-second, per-executable buckets."""
import collections
import ipaddress
import queue
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import procinfo
from .etw import NetworkTrace
from .netclass import INTERNAL, LOOP

SETTLE = 2          # seconds to wait for late ETW buffers before a second is final
FLUSH_EVERY = 5     # seconds between DB commits
RING = 900          # seconds of live history kept in memory
KEEP_EXITED = 120   # seconds an exited process stays resolvable (late network events)
DNS_BACKLOG = 500   # max reverse-DNS lookups waiting at once


class Collector:
    def __init__(self, store, classifier):
        self.store = store
        self.classifier = classifier
        self.lock = threading.Lock()      # guards pending (ETW thread)
        self.work = threading.RLock()     # serializes drain/flush between ticker and HTTP threads
        self.pending = collections.defaultdict(dict)   # sec -> {(pid, remote_addr): [iu, id, eu, ed]}
        self.pending_ports = {}                        # (remote_addr, udp, local_side, port) -> bytes
        self.last_done = int(time.time()) - SETTLE
        self.known = {}                                # pid -> (created, path): snapshot + ETW process starts
        self.exited = {}                               # pid -> (created, exit time) for pruning `known`
        self.ring = collections.deque(maxlen=RING)     # [ts, [totals], [[proc,..4]], [[proc, ip,..4]]]
        self.hosts = {}                                # ip -> reverse-DNS name (live only, never stored)
        self._ips = {}                                 # packed address -> ip string
        self._new_hosts = {}
        self._dns = ThreadPoolExecutor(max_workers=4, thread_name_prefix="rdns")
        self._dns_pending = 0                          # queued + running lookups
        self.subscribers = set()
        self.trace = None
        self.started_at = None
        self.error = None
        self.events = 0
        self._last_flush = time.time()
        threading.Thread(target=self._ticker, name="ticker", daemon=True).start()

    # ---- control ----
    @property
    def running(self):
        return self.trace is not None

    def start(self):
        with self.lock:
            if self.trace:
                return
            now = int(time.time())
            last = self.store.last_second()
            # seconds already in the DB (restart within SETTLE) must not be written again
            self.last_done = max(now - SETTLE, last if last is not None and last <= now else 0)
            self.pending.clear()
            trace = NetworkTrace(self._on_event, self._on_process)
            try:
                trace.start()
            except OSError as e:
                self.error = str(e)
                raise
            # processes that were already running; anything started from now on arrives as an ETW event
            for pid, (path, created) in procinfo.snapshot().items():
                self.known.setdefault(pid, (created, path))
            self.trace, self.error = trace, None
            self.started_at = int(time.time())
        self.store.run_start(self.started_at)
        self._publish({"type": "status", **self.status()})

    def stop(self):
        with self.lock:
            trace, self.trace = self.trace, None
        if not trace:
            return
        trace.stop()
        with self.work:
            self._drain(final=True)
            self.store.flush()
        self.store.run_stop(int(time.time()))
        self.started_at = None
        self._publish({"type": "status", **self.status()})

    def status(self):
        trace = self.trace
        return {"running": self.running, "since": self.started_at, "error": self.error, "events": self.events,
                "lost": trace.lost() if trace else [0, 0]}

    def subscribe(self):
        q = queue.Queue(maxsize=120)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q):
        self.subscribers.discard(q)

    # ---- ETW callback (hot path) ----
    def _on_event(self, sec, pid, size, upload, daddr, saddr, v6, dport, sport, udp):
        if self.classifier.swapped(daddr, saddr):
            daddr, saddr, dport, sport = saddr, daddr, sport, dport
        cls = self.classifier.classify(daddr, saddr, v6)
        if cls == LOOP:
            return
        idx = (0 if cls == INTERNAL else 2) + (0 if upload else 1)
        # the lower port is the service port (the other side is ephemeral); remember which side offers it
        port_key = (daddr, udp, False, dport) if dport <= sport else (daddr, udp, True, sport)
        with self.lock:
            self.events += 1
            if sec <= self.last_done:
                sec = self.last_done + 1
            bucket = self.pending[sec]
            key = (pid, daddr)
            acc = bucket.get(key)
            if acc is None:
                acc = bucket[key] = [0, 0, 0, 0]
            acc[idx] += size
            self.pending_ports[port_key] = self.pending_ports.get(port_key, 0) + size

    # ---- process tracking (ETW thread) ----
    def _on_process(self, started, pid, created, path):
        if started:
            if path:
                self.known[pid] = (created, procinfo.device_to_dos(path))
                self.exited.pop(pid, None)
        else:
            self.exited[pid] = (created, time.time())

    def _prune_known(self):
        cutoff = time.time() - KEEP_EXITED
        for pid, (created, when) in list(self.exited.items()):
            if when < cutoff:
                if self.known.get(pid, (None,))[0] == created:
                    del self.known[pid]
                self.exited.pop(pid, None)

    # ---- per-second processing ----
    def _resolve(self, pid, now):
        k = self.known.get(pid)
        if k is None:  # not seen at start nor via ETW (should not happen) - ask the live process
            path, created = procinfo.query(pid)
            if path is None:
                path, created = procinfo.UNKNOWN_PATH, 0
            else:
                self.known[pid] = (created, path)
        else:
            created, path = k
        proc = self.store._proc_ids.get(path)
        if proc is None:
            meta = {**procinfo.version_info(path), **procinfo.file_stats(path)}
            proc = self.store.proc_id(path, procinfo.display_name(path), meta, now)
        return proc, created

    def _drain(self, final=False):
        now = int(time.time())
        with self.lock:
            upto = max(self.pending) if final and self.pending else now - SETTLE
            if upto <= self.last_done:
                return
            secs = [(s, self.pending.pop(s, {})) for s in range(self.last_done + 1, upto + 1)]
            self.last_done = upto
            ports, self.pending_ports = self.pending_ports, {}
        for (raddr, udp, local, port), n in ports.items():
            self.store.add_port(self._ip(raddr), udp, local, port, n, upto)
        for ts, bucket in secs:
            per_proc, per_ep, pids = {}, {}, set()
            for (pid, raddr), v in bucket.items():
                proc, created = self._resolve(pid, ts)
                pids.add((proc, pid, created))
                for acc in (per_proc.setdefault(proc, [0, 0, 0, 0]), per_ep.setdefault((proc, raddr), [0, 0, 0, 0])):
                    for i in range(4):
                        acc[i] += v[i]
            entries = [(p, *v) for p, v in per_proc.items()]
            totals = [sum(e[i] for e in entries) for i in range(1, 5)]
            if entries:
                self.store.add_second(ts, totals, entries, pids)
            endpoints = [[p, self._ip(raddr), *v] for (p, raddr), v in per_ep.items()]
            if endpoints:
                self.store.add_endpoints(ts, endpoints)
            rec = [ts, totals, [list(e) for e in entries], endpoints]
            self.ring.append(rec)
            new_hosts, self._new_hosts = self._new_hosts, {}
            self._publish({"type": "tick", "d": rec, "h": new_hosts})

    # ---- remote endpoints ----
    def _ip(self, raddr):
        s = self._ips.get(raddr)
        if s is None:
            if len(self._ips) > 20_000:
                self._ips.clear()
            ip = ipaddress.ip_address(raddr)
            s = self._ips[raddr] = str(getattr(ip, "ipv4_mapped", None) or ip)
            # unanswered lookups take seconds; past DNS_BACKLOG new IPs simply stay without a name
            if s not in self.hosts and self._dns_pending < DNS_BACKLOG:
                self.hosts[s] = ""
                with self.lock:
                    self._dns_pending += 1
                self._dns.submit(self._lookup, s)
        return s

    def _lookup(self, ip):
        try:
            name = socket.gethostbyaddr(ip)[0]
        except (OSError, UnicodeError):
            return
        finally:
            with self.lock:
                self._dns_pending -= 1
        if len(self.hosts) > 20_000:
            self.hosts.clear()
        self.hosts[ip] = name
        self._new_hosts[ip] = name
        self.store.set_host_name(ip, name)

    def _publish(self, msg):
        for q in list(self.subscribers):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass

    def _ticker(self):
        while True:
            time.sleep(0.25)
            try:
                trace = self.trace
                if trace and trace.thread and not trace.thread.is_alive():
                    err = f"ETW session ended (code {trace.error})"
                    self.stop()
                    self.error = err
                    continue
                with self.work:
                    if trace:
                        self._drain()
                    if time.time() - self._last_flush >= FLUSH_EVERY and not self.store.paused:
                        self.store.flush()
                        self._last_flush = time.time()
                        if int(self._last_flush) % 30 < FLUSH_EVERY:  # pick up new/changed interfaces (VPN)
                            self.classifier.refresh_local()
                            self._prune_known()
            except Exception as e:  # keep the ticker alive no matter what
                self.error = f"{type(e).__name__}: {e}"
