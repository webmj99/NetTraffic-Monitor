"""Compact SQLite storage.

Layout (all integers are SQLite varints, so small values take 1-3 bytes):
  sec     one row per second with traffic: totals + BLOB of per-process values
          BLOB = repeated varints (proc_id, int_up, int_down, ext_up, ext_down)
  minute  per-process per-minute rollup (WITHOUT ROWID), for fast long-range queries
  procs   one row per executable path (name, description, company, ...)
  pids    which PIDs/start times belonged to which executable
  runs    monitoring start/stop intervals (to show gaps)
  settings  key -> JSON value (retention and maintenance, see maintenance.py)
"""
import contextlib
import json
import os
import sqlite3
import threading
import time

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS procs(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT, description TEXT,
  company TEXT, product TEXT, file_size INT, file_mtime INT, first_seen INT, last_seen INT);
CREATE TABLE IF NOT EXISTS pids(
  proc INT, pid INT, created INT, first_seen INT, last_seen INT,
  PRIMARY KEY(proc, pid, created)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sec(ts INTEGER PRIMARY KEY, iu INT, id INT, eu INT, ed INT, d BLOB);
CREATE TABLE IF NOT EXISTS minute(
  ts INT, proc INT, iu INT, id INT, eu INT, ed INT, PRIMARY KEY(ts, proc)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS runs(start INTEGER PRIMARY KEY, stop INT);
CREATE TABLE IF NOT EXISTS hosts(
  id INTEGER PRIMARY KEY, ip TEXT UNIQUE NOT NULL, name TEXT, lan INT, first_seen INT, last_seen INT);
CREATE TABLE IF NOT EXISTS ep_minute(
  ts INT, host INT, proc INT, iu INT, id INT, eu INT, ed INT, PRIMARY KEY(ts, host, proc)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ep_minute_host ON ep_minute(host, ts);
CREATE TABLE IF NOT EXISTS host_ports(
  host INT, udp INT, local INT, port INT, bytes INT, first_seen INT, last_seen INT,
  PRIMARY KEY(host, udp, local, port)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
"""
HOST_COLS = "id, ip, name, lan, first_seen, last_seen"

PROC_COLS = "id, path, name, description, company, product, file_size, file_mtime, first_seen, last_seen"


def encode(rows):
    out = bytearray()
    for row in rows:
        for v in row:
            while v >= 0x80:
                out.append((v & 0x7F) | 0x80)
                v >>= 7
            out.append(v)
    return bytes(out)


def decode(blob):
    vals, v, shift = [], 0, 0
    for b in blob:
        v |= (b & 0x7F) << shift
        if b & 0x80:
            shift += 7
        else:
            vals.append(v)
            v, shift = 0, 0
    return [vals[i:i + 5] for i in range(0, len(vals), 5)]


class Store:
    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA journal_size_limit=1048576")  # truncate the WAL back to 1 MB after checkpoints
        self.lock = threading.Lock()
        self._proc_ids = {p: i for i, p in self.db.execute("SELECT id, path FROM procs")}
        self._sec_rows = []
        self._minute_delta = {}
        self._seen_procs = {}
        self._seen_pids = {}
        self._host_ids = {ip: i for i, ip in self.db.execute("SELECT id, ip FROM hosts")}
        self._ep_delta = {}       # (minute, host, proc) -> [iu, id, eu, ed]
        self._seen_hosts = {}     # host -> (ts, lan)
        self._port_delta = {}     # (host, udp, local, port) -> [bytes, ts]
        self._names = {}          # ip -> reverse-DNS name (written by resolver threads)
        self.sec_days = 0         # per-second retention (0 = forever); older ranges are read from `minute`
        self.paused = False       # set during VACUUM: the ticker keeps buffering instead of flushing
        # close runs left open by a crash
        self.db.execute("UPDATE runs SET stop=COALESCE((SELECT MAX(ts) FROM sec WHERE ts>=runs.start), start) WHERE stop IS NULL")
        self.db.commit()
        # counting `sec` walks the whole table, so count once and keep it current in flush() / cleanup
        self.sec_count = self.db.execute("SELECT COUNT(*) FROM sec").fetchone()[0]

    @contextlib.contextmanager
    def reader(self):
        db = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        try:
            yield db
        finally:
            db.close()

    def sec_floor(self):
        """Oldest timestamp still guaranteed to have per-second rows."""
        return int(time.time()) - self.sec_days * 86400 if self.sec_days else 0

    def get_settings(self):
        with self.lock:
            return {k: json.loads(v) for k, v in self.db.execute("SELECT key, value FROM settings")}

    def put_settings(self, values):
        with self.lock:
            self.db.executemany("INSERT OR REPLACE INTO settings VALUES(?,?)",
                                [(k, json.dumps(v)) for k, v in values.items()])
            self.db.commit()

    # ---- writer side (collector thread) ----
    def proc_id(self, path, name, meta, now):
        pid = self._proc_ids.get(path)
        if pid is not None:
            return pid
        with self.lock:
            cur = self.db.execute(
                "INSERT INTO procs(path,name,description,company,product,file_size,file_mtime,first_seen,last_seen)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (path, name, meta.get("description"), meta.get("company"), meta.get("product"),
                 meta.get("size"), meta.get("mtime"), now, now))
            self.db.commit()
        self._proc_ids[path] = cur.lastrowid
        return cur.lastrowid

    def add_second(self, ts, totals, entries, pids):
        """entries: list of (proc_id, iu, id, eu, ed); pids: {(proc, pid, created)}"""
        self._sec_rows.append((ts, *totals, encode(entries)))
        m = ts - ts % 60
        for e in entries:
            acc = self._minute_delta.setdefault((m, e[0]), [0, 0, 0, 0])
            for i in range(4):
                acc[i] += e[i + 1]
            self._seen_procs[e[0]] = ts
        for key in pids:
            first = self._seen_pids.get(key, (ts, ts))[0]
            self._seen_pids[key] = (first, ts)

    def host_id(self, ip, lan, now):
        hid = self._host_ids.get(ip)
        if hid is not None:
            return hid
        with self.lock:
            cur = self.db.execute("INSERT INTO hosts(ip, lan, first_seen, last_seen) VALUES(?,?,?,?)", (ip, lan, now, now))
            self.db.commit()
        self._host_ids[ip] = cur.lastrowid
        return cur.lastrowid

    def add_endpoints(self, ts, endpoints):
        """endpoints: [[proc, ip, iu, id, eu, ed], ...] for one second -> per-minute rollup."""
        m = ts - ts % 60
        for proc, ip, *v in endpoints:
            lan = 1 if v[0] or v[1] else 0
            hid = self.host_id(ip, lan, ts)
            acc = self._ep_delta.setdefault((m, hid, proc), [0, 0, 0, 0])
            for i in range(4):
                acc[i] += v[i]
            self._seen_hosts[hid] = (ts, lan)

    def add_port(self, ip, udp, local, port, n, ts):
        hid = self.host_id(ip, None, ts)
        acc = self._port_delta.setdefault((hid, int(udp), int(local), port), [0, ts])
        acc[0] += n
        acc[1] = ts

    def set_host_name(self, ip, name):
        self._names[ip] = name

    def flush(self):
        if not (self._sec_rows or self._minute_delta or self._ep_delta or self._port_delta or self._names):
            return
        names, self._names = self._names, {}
        # one transaction: on any error it all rolls back and the buffers are kept for the next try
        try:
            with self.lock:
                with self.db:
                    self.db.executemany(
                        "INSERT INTO ep_minute VALUES(?,?,?,?,?,?,?) ON CONFLICT(ts,host,proc) DO UPDATE SET"
                        " iu=iu+excluded.iu, id=id+excluded.id, eu=eu+excluded.eu, ed=ed+excluded.ed",
                        [(*k, *v) for k, v in self._ep_delta.items()])
                    self.db.executemany("UPDATE hosts SET last_seen=?, lan=? WHERE id=?",
                                        [(ts, lan, h) for h, (ts, lan) in self._seen_hosts.items()])
                    self.db.executemany(
                        "INSERT INTO host_ports VALUES(?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET"
                        " bytes=bytes+excluded.bytes, last_seen=excluded.last_seen",
                        [(*k, n, ts, ts) for k, (n, ts) in self._port_delta.items()])
                    self.db.executemany("UPDATE hosts SET name=? WHERE ip=?", [(n, ip) for ip, n in names.items()])
                    self.db.executemany("INSERT OR REPLACE INTO sec VALUES(?,?,?,?,?,?)", self._sec_rows)
                    self.db.executemany(
                        "INSERT INTO minute VALUES(?,?,?,?,?,?) ON CONFLICT(ts,proc) DO UPDATE SET"
                        " iu=iu+excluded.iu, id=id+excluded.id, eu=eu+excluded.eu, ed=ed+excluded.ed",
                        [(m, p, *v) for (m, p), v in self._minute_delta.items()])
                    self.db.executemany("UPDATE procs SET last_seen=? WHERE id=?",
                                        [(ts, p) for p, ts in self._seen_procs.items()])
                    self.db.executemany(
                        "INSERT INTO pids VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET last_seen=excluded.last_seen",
                        [(*k, f, l) for k, (f, l) in self._seen_pids.items()])
                self.sec_count += len(self._sec_rows)  # only after the commit succeeded
        except BaseException:
            self._names = {**names, **self._names}
            raise
        for buf in (self._ep_delta, self._seen_hosts, self._port_delta,
                    self._sec_rows, self._minute_delta, self._seen_procs, self._seen_pids):
            buf.clear()

    def last_second(self):
        with self.reader() as db:
            return db.execute("SELECT MAX(ts) FROM sec").fetchone()[0]

    def run_start(self, ts):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO runs VALUES(?, NULL)", (ts,))
            self.db.commit()

    def run_stop(self, ts):
        with self.lock:
            self.db.execute("UPDATE runs SET stop=? WHERE stop IS NULL", (ts,))
            self.db.commit()

    # ---- reader side (HTTP threads, own connection each call) ----
    def history(self, frm, to, step):
        """Totals bucketed by `step` seconds: list of [ts, iu, id, eu, ed]."""
        with self.reader() as db:
            if step >= 60:
                q = "SELECT ts/?*? b, SUM(iu),SUM(id),SUM(eu),SUM(ed) FROM minute WHERE ts>=? AND ts<? GROUP BY b ORDER BY b"
            else:
                q = "SELECT ts/?*? b, SUM(iu),SUM(id),SUM(eu),SUM(ed) FROM sec WHERE ts>=? AND ts<? GROUP BY b ORDER BY b"
            return [list(r) for r in db.execute(q, (step, step, frm - frm % 60 if step >= 60 else frm, to))]

    def top(self, frm, to):
        """Per-process totals over a range: {proc_id: [iu, id, eu, ed]} (same rules as apps())."""
        return {p: a["v"] for p, a in self.apps(frm, to).items()}

    def seconds(self, frm, to):
        """Per-second records with per-process breakdown: [[ts, totals, [[proc,..4]], None]]."""
        with self.reader() as db:
            return [[ts, [iu, id_, eu, ed], decode(blob), None] for ts, iu, id_, eu, ed, blob in db.execute(
                "SELECT ts, iu, id, eu, ed, d FROM sec WHERE ts>=? AND ts<? ORDER BY ts", (frm, to))]

    def apps(self, frm, to):
        """All executables with traffic in range: {proc: {..meta, v:[iu,id,eu,ed], minutes, pids}}."""
        sums, minutes = {}, {}
        with self.reader() as db:
            if to - frm <= 3600 and frm >= self.sec_floor():
                active = {}
                for ts, blob in db.execute("SELECT ts, d FROM sec WHERE ts>=? AND ts<?", (frm, to)):
                    for p, *v in decode(blob):
                        acc = sums.setdefault(p, [0, 0, 0, 0])
                        for i in range(4):
                            acc[i] += v[i]
                        active.setdefault(p, set()).add(ts // 60)
                minutes = {p: len(s) for p, s in active.items()}
            else:
                for p, iu, id_, eu, ed, n in db.execute(
                        "SELECT proc, SUM(iu),SUM(id),SUM(eu),SUM(ed),COUNT(*) FROM minute WHERE ts>=? AND ts<? GROUP BY proc",
                        (frm - frm % 60, to)):
                    sums[p], minutes[p] = [iu, id_, eu, ed], n
            pids = dict(db.execute(
                "SELECT proc, COUNT(*) FROM pids WHERE first_seen<? AND last_seen>=? GROUP BY proc", (to, frm)))
        meta = self.procs(sums.keys()) if sums else {}
        return {p: {**meta.get(p, {}), "v": v, "minutes": minutes.get(p, 0), "pids": pids.get(p, 0)}
                for p, v in sums.items()}

    CHANNELS = {"iu": 0, "id": 1, "eu": 2, "ed": 3}

    def stack(self, frm, to, step, chan, n):
        """Top-n executables for one channel (or 'all') bucketed by step, plus an 'other' column."""
        idx = self.CHANNELS.get(chan)
        val = (lambda v: v[idx]) if idx is not None else sum
        buckets = {}  # b -> {proc: bytes}
        with self.reader() as db:
            if step >= 60:
                rows = ((ts - ts % step, p, v) for ts, p, *v in db.execute(
                    "SELECT ts, proc, iu, id, eu, ed FROM minute WHERE ts>=? AND ts<?", (frm - frm % 60, to)))
            else:
                rows = ((ts - ts % step, p, v) for ts, blob in db.execute(
                    "SELECT ts, d FROM sec WHERE ts>=? AND ts<?", (frm, to)) for p, *v in decode(blob))
            totals = {}
            for b, p, v in rows:
                x = val(v)
                if x:
                    bp = buckets.setdefault(b, {})
                    bp[p] = bp.get(p, 0) + x
                    totals[p] = totals.get(p, 0) + x
        top = [p for p, _ in sorted(totals.items(), key=lambda kv: -kv[1])[:n]]
        out = []
        for b in sorted(buckets):
            bp = buckets[b]
            vals = [bp.get(p, 0) for p in top]
            out.append([b, *vals, sum(bp.values()) - sum(vals)])
        return top, out

    # ---- remote endpoints (minute resolution) ----
    def hosts_summary(self, frm, to):
        """Every remote endpoint with traffic in range, incl. top processes and service ports."""
        frm -= frm % 60
        with self.reader() as db:
            out = {}
            for hid, ip, name, lan, first, last, iu, id_, eu, ed, mins in db.execute(
                    "SELECT h.id, h.ip, h.name, h.lan, h.first_seen, h.last_seen,"
                    " SUM(e.iu), SUM(e.id), SUM(e.eu), SUM(e.ed), COUNT(DISTINCT e.ts)"
                    " FROM ep_minute e JOIN hosts h ON h.id = e.host WHERE e.ts>=? AND e.ts<? GROUP BY e.host",
                    (frm, to)):
                out[hid] = {"id": hid, "ip": ip, "name": name or "", "lan": lan, "first_seen": first,
                            "last_seen": last, "v": [iu, id_, eu, ed], "minutes": mins, "procs": [], "ports": []}
            for hid, proc, n in db.execute(
                    "SELECT host, proc, SUM(iu+id+eu+ed) n FROM ep_minute WHERE ts>=? AND ts<?"
                    " GROUP BY host, proc ORDER BY n DESC", (frm, to)):
                if hid in out:
                    out[hid]["procs"].append([proc, n])
            for hid, udp, local, port, n in db.execute(
                    "SELECT host, udp, local, port, bytes FROM host_ports WHERE last_seen>=? AND first_seen<?"
                    " ORDER BY bytes DESC", (frm, to)):
                if hid in out:
                    out[hid]["ports"].append([udp, local, port, n])
        return out

    def host_stack(self, frm, to, step, chan, n):
        """Top-n endpoints for one channel bucketed by step (>= 60 s), plus an 'other' column."""
        step = max(step - step % 60, 60)
        idx = self.CHANNELS.get(chan)
        expr = ("iu", "id", "eu", "ed")[idx] if idx is not None else "iu+id+eu+ed"
        with self.reader() as db:
            rows = db.execute(f"SELECT ts/?*? b, host, SUM({expr}) FROM ep_minute WHERE ts>=? AND ts<?"
                              f" GROUP BY b, host", (step, step, frm - frm % 60, to)).fetchall()
            totals = {}
            for _, h, x in rows:
                totals[h] = totals.get(h, 0) + x
            top = [h for h, x in sorted(totals.items(), key=lambda kv: -kv[1])[:n] if x]
            buckets = {}
            for b, h, x in rows:
                if x:
                    bp = buckets.setdefault(b, {})
                    bp[h] = x
            meta = {}
            if top:
                meta = {r[0]: dict(zip(HOST_COLS.split(", "), r)) for r in db.execute(
                    f"SELECT {HOST_COLS} FROM hosts WHERE id IN ({','.join('?' * len(top))})", top)}
        out = []
        for b in sorted(buckets):
            bp = buckets[b]
            vals = [bp.get(h, 0) for h in top]
            out.append([b, *vals, sum(bp.values()) - sum(vals)])
        return step, top, out, meta

    def host_detail(self, ip, frm, to, step):
        step = max(step - step % 60, 60)
        with self.reader() as db:
            r = db.execute(f"SELECT {HOST_COLS} FROM hosts WHERE ip=?", (ip,)).fetchone()
            if not r:
                return None
            meta = dict(zip(HOST_COLS.split(", "), r))
            hid = meta["id"]
            series = [list(x) for x in db.execute(
                "SELECT ts/?*? b, SUM(iu),SUM(id),SUM(eu),SUM(ed) FROM ep_minute WHERE host=? AND ts>=? AND ts<?"
                " GROUP BY b ORDER BY b", (step, step, hid, frm - frm % 60, to))]
            procs = [list(x) for x in db.execute(
                "SELECT proc, SUM(iu),SUM(id),SUM(eu),SUM(ed), COUNT(*) FROM ep_minute WHERE host=? AND ts>=? AND ts<?"
                " GROUP BY proc ORDER BY SUM(iu+id+eu+ed) DESC", (hid, frm - frm % 60, to))]
            ports = [list(x) for x in db.execute(
                "SELECT udp, local, port, bytes, first_seen, last_seen FROM host_ports WHERE host=? ORDER BY bytes DESC",
                (hid,))]
            total = db.execute("SELECT SUM(iu+id+eu+ed), COUNT(DISTINCT ts) FROM ep_minute WHERE host=?",
                               (hid,)).fetchone()
        return {"meta": meta, "step": step, "rows": series, "procs": procs, "ports": ports,
                "all_time": {"bytes": total[0] or 0, "minutes": total[1]}}

    def proc_hosts(self, proc, frm, to, limit=15):
        with self.reader() as db:
            return [dict(zip(("ip", "name", "lan", "iu", "id", "eu", "ed"), r)) for r in db.execute(
                "SELECT h.ip, h.name, h.lan, SUM(e.iu), SUM(e.id), SUM(e.eu), SUM(e.ed) FROM ep_minute e"
                " JOIN hosts h ON h.id = e.host WHERE e.proc=? AND e.ts>=? AND e.ts<? GROUP BY e.host"
                " ORDER BY SUM(e.iu+e.id+e.eu+e.ed) DESC LIMIT ?", (proc, frm - frm % 60, to, limit))]

    def proc_series(self, proc, frm, to, step):
        with self.reader() as db:
            if step >= 60:
                return [list(r) for r in db.execute(
                    "SELECT ts/?*? b, SUM(iu),SUM(id),SUM(eu),SUM(ed) FROM minute WHERE proc=? AND ts>=? AND ts<?"
                    " GROUP BY b ORDER BY b", (step, step, proc, frm - frm % 60, to))]
            buckets = {}
            for ts, blob in db.execute("SELECT ts, d FROM sec WHERE ts>=? AND ts<?", (frm, to)):
                for p, *v in decode(blob):
                    if p == proc:
                        acc = buckets.setdefault(ts - ts % step, [0, 0, 0, 0])
                        for i in range(4):
                            acc[i] += v[i]
            return [[b, *v] for b, v in sorted(buckets.items())]

    def procs(self, ids=None):
        with self.reader() as db:
            if ids is None:
                rows = db.execute(f"SELECT {PROC_COLS} FROM procs")
            else:
                ids = list(ids)
                rows = db.execute(f"SELECT {PROC_COLS} FROM procs WHERE id IN ({','.join('?' * len(ids))})", ids)
            cols = PROC_COLS.split(", ")
            return {r[0]: dict(zip(cols, r)) for r in rows}

    def proc_pids(self, proc):
        with self.reader() as db:
            return [dict(zip(("pid", "created", "first_seen", "last_seen"), r)) for r in db.execute(
                "SELECT pid, created, first_seen, last_seen FROM pids WHERE proc=? ORDER BY last_seen DESC LIMIT 50",
                (proc,))]

    def runs(self, frm, to):
        with self.reader() as db:
            return [list(r) for r in db.execute(
                "SELECT start, stop FROM runs WHERE start<? AND (stop IS NULL OR stop>=?) ORDER BY start", (to, frm))]

    def stats(self):
        wal = os.path.getsize(self.path + "-wal") if os.path.exists(self.path + "-wal") else 0
        with self.reader() as db:
            # actual data size: used pages as seen through the WAL (current state), excluding free pages
            pages, free, psize = (db.execute(f"PRAGMA {p}").fetchone()[0] for p in ("page_count", "freelist_count", "page_size"))
            size = (pages - free) * psize
            # per-second rows may be pruned earlier than the per-minute rollup
            first = min((x for x in (db.execute(f"SELECT MIN(ts) FROM {t}").fetchone()[0] for t in ("sec", "minute"))
                         if x is not None), default=None)
            procs = db.execute("SELECT COUNT(*) FROM procs").fetchone()[0]
            hosts = db.execute("SELECT COUNT(*) FROM hosts").fetchone()[0]
            ep_first = db.execute("SELECT MIN(first_seen) FROM hosts").fetchone()[0]
        return {"db_bytes": size, "wal_bytes": wal, "seconds": self.sec_count, "procs": procs, "hosts": hosts, "first_ts": first,
                "hosts_first_ts": ep_first, "now": int(time.time())}

    def db_info(self):
        """File and table details for the maintenance page."""
        def size(p):
            return os.path.getsize(p) if os.path.exists(p) else 0
        with self.reader() as db:
            pages, free, psize = (db.execute(f"PRAGMA {p}").fetchone()[0] for p in ("page_count", "freelist_count", "page_size"))
            oldest = {t: db.execute(f"SELECT MIN(ts) FROM {t}").fetchone()[0] for t in ("sec", "minute", "ep_minute")}
            counts = {"sec": self.sec_count,
                      **{t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("procs", "hosts")}}
        return {"file_bytes": size(self.path), "wal_bytes": size(self.path + "-wal"), "page_bytes": pages * psize,
                "free_bytes": free * psize, "oldest": oldest, "counts": counts}
