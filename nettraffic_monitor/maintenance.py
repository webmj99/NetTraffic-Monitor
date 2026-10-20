"""Data retention and database maintenance: cleanup, VACUUM, WAL checkpoint, integrity check.

Settings live in the `settings` table. A retention of 0 days keeps that data forever (the default).
Deletes run in small transactions so the collector's flushes interleave; only VACUUM pauses flushing.
"""
import threading
import time

DAY = 86400
CHUNK = 6 * 3600          # seconds of data deleted per transaction
AUTO_EVERY = 6 * 3600     # seconds between automatic cleanups
AUTO_VACUUM_FREE = 0.25   # compact after an automatic cleanup once this share of the file is free pages
MAX_DAYS = 36500
DEFAULTS = {"sec_days": 0, "minute_days": 0, "ep_days": 0, "auto_cleanup": True, "auto_vacuum": False}
TASKS = ("cleanup", "vacuum", "checkpoint", "check")


def validate(cfg):
    out = {}
    for k in ("sec_days", "minute_days", "ep_days"):
        v = cfg.get(k)
        if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= MAX_DAYS:
            raise ValueError(f"Retention must be a whole number of days between 0 and {MAX_DAYS}")
        out[k] = v
    for k in ("auto_cleanup", "auto_vacuum"):
        if not isinstance(cfg.get(k), bool):
            raise ValueError(f"{k} must be true or false")
        out[k] = cfg[k]
    inf = float("inf")
    if (out["minute_days"] or inf) < (out["sec_days"] or inf):
        raise ValueError("Per-minute history must be kept at least as long as per-second detail")
    return out


class Maintenance:
    def __init__(self, store):
        self.store = store
        saved = store.get_settings()
        try:
            self.settings = validate({**DEFAULTS, **saved.get("retention", {})})
        except ValueError:
            self.settings = dict(DEFAULTS)
        self.last = saved.get("maintenance_last", {})   # task -> {ts, secs, result | error}
        store.sec_days = self.settings["sec_days"]
        self.task = None
        self._busy = threading.Lock()
        threading.Thread(target=self._auto, name="maintenance", daemon=True).start()

    # ---- API ----
    def status(self):
        return {"settings": self.settings, "task": self.task, "last": self.last, "db": self.store.db_info(),
                "auto_every": AUTO_EVERY}

    def update(self, values):
        new = validate({**self.settings, **values})
        self.store.put_settings({"retention": new})
        shorter = any(new[k] and (not self.settings[k] or new[k] < self.settings[k])
                      for k in ("sec_days", "minute_days", "ep_days"))
        self.settings = new
        self.store.sec_days = new["sec_days"]
        if shorter and new["auto_cleanup"]:
            self.start("cleanup", auto=True)

    def start(self, task, auto=False):
        """Run a task in the background; False if another one is still running."""
        if task not in TASKS:
            raise ValueError("unknown task")
        if not self._busy.acquire(blocking=False):
            return False
        self.task = task
        threading.Thread(target=self._run, args=(task, auto), name="maintenance-task", daemon=True).start()
        return True

    def preview(self, values):
        """Rows a cleanup with these settings would delete right now."""
        cfg = validate({**self.settings, **values})
        cut = self._cutoffs(cfg)
        out = {}
        with self.store.reader() as db:
            for table, key in (("sec", "sec"), ("minute", "minute"), ("ep_minute", "ep")):
                out[table] = db.execute(f"SELECT COUNT(*) FROM {table} WHERE ts<?", (cut[key],)).fetchone()[0] \
                    if cut[key] else 0
        return out

    # ---- tasks ----
    def _run(self, task, auto):
        t0 = time.time()
        try:
            entry = {"result": getattr(self, "_" + task)()}
            if task == "cleanup" and auto and self.settings["auto_vacuum"]:
                info = self.store.db_info()
                if info["page_bytes"] and info["free_bytes"] / info["page_bytes"] >= AUTO_VACUUM_FREE:
                    self.task = "vacuum"
                    self._record("vacuum", {"result": self._vacuum()}, time.time())
        except Exception as e:  # report any failure on the page instead of killing the thread
            entry = {"error": f"{type(e).__name__}: {e}"}
        try:
            self._record(task, entry, t0, auto)
        finally:
            self.task = None
            self._busy.release()

    def _record(self, task, entry, t0, auto=False):
        self.last[task] = {**entry, "ts": int(t0), "secs": round(time.time() - t0, 1), "auto": auto}
        self.store.put_settings({"maintenance_last": self.last})

    @staticmethod
    def _cutoffs(cfg):
        now = int(time.time())
        cut = lambda days: now - now % 60 - days * DAY if days else 0
        return {"sec": cut(cfg["sec_days"]), "minute": cut(cfg["minute_days"]), "ep": cut(cfg["ep_days"])}

    def _cleanup(self):
        st, cut = self.store, self._cutoffs(self.settings)
        res = dict.fromkeys(("sec", "minute", "ep_minute", "hosts", "host_ports", "pids", "runs"), 0)
        if cut["sec"]:
            res["sec"] = self._delete_before("sec", cut["sec"])
            with st.lock:
                st.sec_count -= res["sec"]
        if cut["minute"]:
            res["minute"] = self._delete_before("minute", cut["minute"])
            with st.lock:
                res["pids"] = st.db.execute("DELETE FROM pids WHERE last_seen<?", (cut["minute"],)).rowcount
                res["runs"] = st.db.execute("DELETE FROM runs WHERE stop<?", (cut["minute"],)).rowcount
                st.db.commit()
        if cut["ep"]:
            res["ep_minute"] = self._delete_before("ep_minute", cut["ep"])
            with st.lock:
                # hosts with buffered (unflushed) traffic still look old in the DB - keep them
                busy = set(st._seen_hosts) | {k[1] for k in list(st._ep_delta)} | {k[0] for k in list(st._port_delta)}
                gone = [(h, ip) for h, ip in st.db.execute(
                    "SELECT id, ip FROM hosts WHERE last_seen<? AND NOT EXISTS"
                    " (SELECT 1 FROM ep_minute WHERE host=hosts.id)", (cut["ep"],)) if h not in busy]
                res["host_ports"] = st.db.execute("DELETE FROM host_ports WHERE last_seen<?", (cut["ep"],)).rowcount
                st.db.executemany("DELETE FROM host_ports WHERE host=?", [(h,) for h, _ in gone])
                st.db.executemany("DELETE FROM hosts WHERE id=?", [(h,) for h, _ in gone])
                st.db.commit()
                for _, ip in gone:
                    st._host_ids.pop(ip, None)
                res["hosts"] = len(gone)
        return res

    def _delete_before(self, table, cutoff):
        st, n = self.store, 0
        with st.reader() as db:
            lo = db.execute(f"SELECT MIN(ts) FROM {table}").fetchone()[0]
        while lo is not None and lo < cutoff:
            with st.lock:
                n += st.db.execute(f"DELETE FROM {table} WHERE ts<?", (min(lo + CHUNK, cutoff),)).rowcount
                st.db.commit()
                lo = st.db.execute(f"SELECT MIN(ts) FROM {table}").fetchone()[0]
        return n

    def _vacuum(self):
        st = self.store
        before = st.db_info()
        st.paused = True
        try:
            with st.lock:
                st.db.commit()
                st.db.execute("VACUUM")
                st.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            st.paused = False
        after = st.db_info()
        return {"before": before["file_bytes"], "after": after["file_bytes"]}

    def _checkpoint(self):
        st = self.store
        wal = st.db_info()["wal_bytes"]
        with st.lock:
            st.db.commit()
            busy = st.db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]
        return {"wal_before": wal, "wal_after": st.db_info()["wal_bytes"], "busy": bool(busy)}

    def _check(self):
        with self.store.reader() as db:
            rows = [r[0] for r in db.execute("PRAGMA quick_check(20)")]
        return {"ok": rows == ["ok"], "problems": [] if rows == ["ok"] else rows}

    def _auto(self):
        time.sleep(60)  # let startup finish first
        while True:
            s = self.settings
            due = time.time() - self.last.get("cleanup", {}).get("ts", 0) >= AUTO_EVERY
            if s["auto_cleanup"] and (s["sec_days"] or s["minute_days"] or s["ep_days"]) and due:
                self.start("cleanup", auto=True)
            time.sleep(300)
