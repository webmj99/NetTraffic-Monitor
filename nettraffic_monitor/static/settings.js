"use strict";
/* Settings: data retention and database maintenance. */
const ST = { data: null, poll: null };
const ST_FIELDS = { sec_days: "st-sec", minute_days: "st-min", ep_days: "st-ep" };
const TASK_NAMES = { cleanup: "Clean up now", vacuum: "Compact database", checkpoint: "Empty write buffer", check: "Check integrity" };

function stForm() {
  const v = { auto_cleanup: $("st-auto").checked, auto_vacuum: $("st-vacuum").checked };
  for (const [k, id] of Object.entries(ST_FIELDS)) {
    const x = $(id).value.trim();
    v[k] = x === "" ? 0 : Number(x);
  }
  return v;
}

function stFill(s) {
  for (const [k, id] of Object.entries(ST_FIELDS)) $(id).value = s[k] || "";
  $("st-auto").checked = s.auto_cleanup;
  $("st-vacuum").checked = s.auto_vacuum;
}

async function stLoad(fillForm) {
  const d = await api("/api/settings");
  ST.data = d;
  if (fillForm) stFill(d.settings);
  stRender();
  // keep polling while a task runs (also one started automatically after saving)
  clearTimeout(ST.poll);
  if (d.task && S.view === "settings") ST.poll = setTimeout(() => stLoad(false).catch(showErr), 1000);
}

function stLastText(task, r) {
  if (!r) return t("never run");
  if (r.error) return t("Failed: {0}", r.error);
  const x = r.result;
  let what;
  if (task === "cleanup") {
    const n = Object.values(x).reduce((a, b) => a + b, 0);
    what = n ? t("{0} rows deleted", nf0.format(n)) : t("nothing to delete");
  } else if (task === "vacuum") {
    what = t("{0} → {1}", fmtBytes(x.before), fmtBytes(x.after));
  } else if (task === "checkpoint") {
    what = t(x.busy ? "{0} → {1} (readers still active)" : "{0} → {1}", fmtBytes(x.wal_before), fmtBytes(x.wal_after));
  } else {
    what = x.ok ? t("no problems found") : t("{0} problems: {1}", x.problems.length, x.problems.join("; "));
  }
  return t("{0} · {1} s · {2}", fmtTs(r.ts), nf1.format(r.secs), what) + (r.auto ? ` (${t("automatic")})` : "");
}

function stRender() {
  const d = ST.data;
  if (!d) return;
  const db = d.db, s = d.settings;
  const keep = (days) => (days ? t("kept {0} days", nf0.format(days)) : t("kept forever"));
  const pct = db.page_bytes ? Math.round((100 * db.free_bytes) / db.page_bytes) : 0;
  const rows = [
    [t("Database file"), fmtBytes(db.file_bytes)],
    [t("Free space in file"), t("{0} ({1} %) – reclaimable by compacting", fmtBytes(db.free_bytes), pct)],
    [t("Write buffer (WAL)"), fmtBytes(db.wal_bytes)],
    [t("Per-second detail"), t("{0} seconds with traffic, oldest {1}", nf0.format(db.counts.sec), fmtTs(db.oldest.sec)) + " · " + keep(s.sec_days)],
    [t("Per-minute history"), t("oldest {0}", fmtTs(db.oldest.minute)) + " · " + keep(s.minute_days)],
    [t("Endpoints"), t("{0} endpoints, oldest {1}", nf0.format(db.counts.hosts), fmtTs(db.oldest.ep_minute)) + " · " + keep(s.ep_days)],
  ];
  $("mt-info").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  for (const task of Object.keys(TASK_NAMES)) {
    const el = $("mt-last-" + task), r = d.last[task];
    el.textContent = stLastText(task, r);
    el.classList.toggle("bad", !!(r && (r.error || (task === "check" && !r.result.ok))));
  }
  document.querySelectorAll(".tasks button[data-task]").forEach((b) => (b.disabled = !!d.task));
  $("mt-state").textContent = d.task ? t("Running: {0} …", t(TASK_NAMES[d.task])) : "";
}

// Ask before anything is deleted; true when nothing would be deleted or the user agrees.
async function stConfirmDelete(v) {
  const q = Object.entries(ST_FIELDS).map(([k]) => `${k}=${v[k]}`).join("&");
  const p = await api("/api/retention/preview?" + q);
  if (!p.sec && !p.minute && !p.ep_minute) return true;
  return confirm(t("This permanently deletes {0} per-second rows, {1} per-minute rows and {2} endpoint rows. Continue?",
    nf0.format(p.sec), nf0.format(p.minute), nf0.format(p.ep_minute)));
}

function stMsg(text, bad) {
  const m = $("st-msg");
  m.textContent = text;
  m.classList.toggle("bad", !!bad);
}

function stInit() {
  $("st-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = stForm(), btn = $("st-save");
    btn.disabled = true;
    stMsg("");
    try {
      if (v.auto_cleanup && !(await stConfirmDelete(v))) return;
      ST.data = await post("/api/settings", v);
      stFill(ST.data.settings);
      stMsg(t("Saved"));
      await stLoad(false);
    } catch (err) {
      stMsg(t(err.message), true);
    } finally {
      btn.disabled = false;
    }
  });
  document.querySelector(".tasks").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-task]");
    if (!b) return;
    const task = b.dataset.task;
    try {
      if (task === "cleanup" && !(await stConfirmDelete(ST.data.settings))) return;
      ST.data = await post("/api/maintenance?task=" + task);
      stRender();
      await stLoad(false);
    } catch (err) {
      showErr(err);
    }
  });
}
