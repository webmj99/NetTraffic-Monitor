"""Local HTTP server: static dashboard, JSON API and a Server-Sent-Events live stream."""
import ctypes
import json
import mimetypes
import os
import queue
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATIC = os.path.join(os.path.dirname(__file__), "static")
CSP = ("default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
mimetypes.add_type("font/woff2", ".woff2")  # not in every Python/Windows mime table
_session = ctypes.c_ulong()
ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(_session))
SERVICE_MODE = _session.value == 0  # session 0 = Windows service; nobody would see an explorer window there


def pick_step(span):
    """Bucket size so a chart gets roughly <= 720 points."""
    for s in (1, 5, 10, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 86400):
        if span / s <= 720:
            return s
    return 86400


def make_handler(collector, store, maint, port):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
            if not isinstance(body, bytes):
                body = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _guard(self):
            # Block DNS-rebinding: only answer requests addressed to localhost.
            if self.headers.get("Host") not in allowed_hosts:
                self._send(403, {"error": "forbidden host"})
                return False
            return True

        def _range(self, q):
            now = int(time.time())
            to = int(q.get("to", [now + 1])[0])
            frm = int(q.get("from", [to - 300])[0])
            step = int(q.get("step", [0])[0]) or pick_step(to - frm)
            if step < 60 and frm < store.sec_floor():  # per-second rows are pruned there: use minutes
                step = 60
            return frm, to, step

        def do_GET(self):
            if not self._guard():
                return
            url = urlparse(self.path)
            q = parse_qs(url.query)
            p = url.path
            try:
                if p == "/api/stream":
                    return self._stream()
                if p == "/api/status":
                    return self._send(200, {**collector.status(), **store.stats()})
                if p == "/api/live":
                    ring = list(collector.ring)
                    # older seconds (e.g. from before a restart) come from the DB, without endpoints
                    first = ring[0][0] if ring else int(time.time())
                    older = store.seconds(int(time.time()) - 900, first) if len(ring) < 900 else []
                    return self._send(200, {"ring": older + ring,
                                            "hosts": {k: v for k, v in collector.hosts.items() if v}})
                if p == "/api/apps":
                    frm, to, _ = self._range(q)
                    return self._send(200, {str(k): v for k, v in store.apps(frm, to).items()})
                if p == "/api/stack":
                    frm, to, step = self._range(q)
                    chan = q.get("chan", ["all"])[0]
                    top, rows = store.stack(frm, to, step, chan, min(int(q.get("n", [8])[0]), 12))
                    return self._send(200, {"step": step, "from": frm, "to": to, "procs": top, "rows": rows,
                                            "meta": {str(k): v for k, v in store.procs(top).items()} if top else {},
                                            "runs": store.runs(frm, to)})
                if p == "/api/history":
                    frm, to, step = self._range(q)
                    return self._send(200, {"step": step, "from": frm, "to": to,
                                            "rows": store.history(frm, to, step), "runs": store.runs(frm, to)})
                if p == "/api/top":
                    frm, to, _ = self._range(q)
                    return self._send(200, {str(k): v for k, v in store.top(frm, to).items()})
                if p == "/api/hosts":
                    frm, to, _ = self._range(q)
                    return self._send(200, {str(k): v for k, v in store.hosts_summary(frm, to).items()})
                if p == "/api/hoststack":
                    frm, to, step = self._range(q)
                    chan = q.get("chan", ["all"])[0]
                    step, top, rows, meta = store.host_stack(frm, to, step, chan, min(int(q.get("n", [8])[0]), 12))
                    return self._send(200, {"step": step, "from": frm, "to": to, "hosts": top, "rows": rows,
                                            "meta": {str(k): v for k, v in meta.items()}, "runs": store.runs(frm, to)})
                if p == "/api/host":
                    frm, to, step = self._range(q)
                    d = store.host_detail(q["ip"][0], frm, to, step)
                    if not d:
                        return self._send(404, {"error": "unknown endpoint"})
                    d["procs_meta"] = {str(k): v for k, v in store.procs([r[0] for r in d["procs"]]).items()} if d["procs"] else {}
                    return self._send(200, d)
                if p == "/api/procs":
                    ids = [int(i) for i in q["ids"][0].split(",") if i] if "ids" in q else None
                    return self._send(200, {str(k): v for k, v in store.procs(ids).items()})
                if p == "/api/proc":
                    pid = int(q["id"][0])
                    frm, to, step = self._range(q)
                    meta = store.procs([pid]).get(pid)
                    if not meta:
                        return self._send(404, {"error": "unknown process"})
                    return self._send(200, {"meta": meta, "pids": store.proc_pids(pid), "step": step,
                                            "rows": store.proc_series(pid, frm, to, step),
                                            "hosts": store.proc_hosts(pid, frm, to)})
                if p == "/api/settings":
                    return self._send(200, maint.status())
                if p == "/api/retention/preview":
                    return self._send(200, maint.preview({k: int(v[0]) for k, v in q.items()}))
                return self._static(p)
            except (ValueError, KeyError) as e:
                return self._send(400, {"error": str(e)})

        def do_POST(self):
            if not self._guard():
                return
            # A custom header cannot be sent cross-origin without a CORS preflight we never allow.
            if self.headers.get("X-NetTraffic-Monitor") != "1":
                return self._send(403, {"error": "missing X-NetTraffic-Monitor header"})
            url = urlparse(self.path)
            try:
                if url.path == "/api/start":
                    collector.start()
                    return self._send(200, collector.status())
                if url.path == "/api/stop":
                    collector.stop()
                    return self._send(200, collector.status())
                if url.path == "/api/reveal":
                    if SERVICE_MODE:
                        return self._send(409, {"error": "Not available in service mode"})
                    pid = int(parse_qs(url.query)["id"][0])
                    meta = store.procs([pid]).get(pid)
                    path = meta and meta["path"]
                    if not path or not os.path.isfile(path):
                        return self._send(404, {"error": "File not found"})
                    subprocess.Popen(["explorer.exe", "/select,", path])
                    return self._send(200, {"ok": True})
                if url.path == "/api/settings":
                    maint.update(self._json())
                    return self._send(200, maint.status())
                if url.path == "/api/maintenance":
                    if not maint.start(parse_qs(url.query)["task"][0]):
                        return self._send(409, {"error": "Another maintenance task is running"})
                    return self._send(202, maint.status())
            except OSError as e:
                return self._send(500, {"error": str(e)})
            except (ValueError, KeyError) as e:
                return self._send(400, {"error": str(e)})
            self._send(404, {"error": "not found"})

        def _json(self):
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= 4096:
                self.close_connection = True  # the unread body would otherwise be parsed as the next request
                raise ValueError("invalid request body")
            body = json.loads(self.rfile.read(n))
            if not isinstance(body, dict):
                raise ValueError("invalid request body")
            return body

        def _static(self, path):
            if path == "/":
                path = "/index.html"
            full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
            if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
                return self._send(404, b"not found", "text/plain")
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                self._send(200, f.read(), ctype)

        def _stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            sub = collector.subscribe()
            try:
                self._event({"type": "status", **collector.status()})
                while True:
                    try:
                        msg = sub.get(timeout=15)
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        continue
                    self._event(msg)
            except (ConnectionError, OSError):
                pass
            finally:
                collector.unsubscribe(sub)
                self.close_connection = True

        def _event(self, msg):
            self.wfile.write(b"data: " + json.dumps(msg, separators=(",", ":")).encode() + b"\n\n")
            self.wfile.flush()

    return Handler


class QuietServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # Browsers drop idle keep-alive connections (tab reload/close) - not worth a traceback.
        if isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def serve(collector, store, maint, port):
    httpd = QuietServer(("127.0.0.1", port), make_handler(collector, store, maint, port))
    httpd.daemon_threads = True
    return httpd
