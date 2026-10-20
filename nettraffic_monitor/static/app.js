"use strict";
/* Router, live stream, monitoring status and boot. */

function mergeRuns(runs) {
  const m = new Map(S.runs.map((r) => [r[0], r]));
  for (const r of runs) m.set(r[0], r);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (S.view === "overview") ovRender();
    else if (S.view === "live") lvRender();
    renderStatus();
  });
}

/* ---------- views ---------- */
const ROUTES = { "": "overview", "#/": "overview", "#/live": "live", "#/verlauf": "history", "#/gegenstellen": "hosts", "#/einstellungen": "settings" };
function route() {
  const view = ROUTES[location.hash] || "overview";
  S.view = view;
  for (const v of ["overview", "live", "history", "hosts", "settings"]) $("view-" + v).hidden = v !== view;
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (view === "live") LV.lastSets = 0;
  if (view === "overview") { ovLoadTop().catch(showErr); ovLoadHistory().catch(showErr); }
  if (view === "history") hvLoad().catch(showErr);
  if (view === "hosts") epLoad().catch(showErr);
  if (view === "settings") stLoad(true).catch(showErr);
  scheduleRender();
}

/* ---------- status ---------- */
function renderStatus() {
  const el = $("status"), txt = $("statusText"), btn = $("toggle");
  el.className = "status" + (S.running ? " on" : "") + (S.error ? " err" : "");
  let msg = S.running ? t("Running since {0}", tf.format(new Date(S.since * 1000))) : t("Stopped");
  if (S.running && S.lastTick && now() - S.lastTick > 5) msg = t("No data for {0} s", now() - S.lastTick);
  if (S.running && (S.lost[0] || S.lost[1])) msg += " · " + t("lost: {0} events, {1} buffers", nf0.format(S.lost[0]), nf0.format(S.lost[1]));
  if (S.error) msg = t("Error");
  txt.textContent = msg;
  btn.className = "btn " + (S.running ? "danger" : "primary");
  btn.querySelector("use").setAttribute("href", S.running ? "#i-stop" : "#i-play");
  btn.querySelector("span").textContent = S.running ? t("Stop") : t("Start");
  btn.setAttribute("aria-label", S.running ? t("Stop monitoring") : t("Start monitoring"));
  const err = $("error");
  err.hidden = !S.error;
  err.textContent = S.error ? t("Error: {0}", t(S.error)) : "";
}

function applyStatus(s) {
  const was = S.running;
  S.running = s.running; S.since = s.since; S.error = s.error; S.lost = s.lost || [0, 0];
  $("toggle").disabled = false;
  if (s.running && !was && !S.runs.some((r) => r[1] == null)) S.runs.push([s.since, null]);
  if (!s.running && was) S.runs.forEach((r) => { if (r[1] == null) r[1] = now(); });
  scheduleRender();
}

async function loadStatus() {
  const s = await api("/api/status");
  applyStatus(s);
  S.firstTs = s.first_ts;
  S.hostsFirstTs = s.hosts_first_ts;
  $("dbinfo").textContent = t("Data {0} (+ {1} write buffer) · {2} seconds with traffic · {3} programs · {4} endpoints · data since {5}",
    fmtBytes(s.db_bytes), fmtBytes(s.wal_bytes), nf0.format(s.seconds), nf0.format(s.procs), nf0.format(s.hosts), fmtTs(s.first_ts));
}

/* ---------- live data ---------- */
async function loadLive() {
  const to = now() + 1;
  const [h, live] = await Promise.all([api(`/api/history?from=${to - KEEP}&to=${to}&step=1`), api("/api/live")]);
  S.runs = mergeRuns(h.runs);
  for (const r of h.rows) if (!S.live.has(r[0])) S.live.set(r[0], { t: r.slice(1), p: null, e: null });
  for (const [ts, t, p, e] of live.ring) S.live.set(ts, { t, p, e });
  if (live.ring.length) S.lastTs = Math.max(S.lastTs, live.ring[live.ring.length - 1][0]);
  S.live = new Map([...S.live].sort((a, b) => a[0] - b[0]));
  Object.assign(S.hosts, live.hosts);
  const ids = new Set();
  for (const r of S.live.values()) for (const p of r.p || []) ids.add(p[0]);
  await ensureProcs([...ids]);
  scheduleRender();
}

function onTick(m) {
  const [ts, t, p, e] = m.d;
  S.live.set(ts, { t, p, e });
  Object.assign(S.hosts, m.h);
  S.lastTick = now();
  S.lastTs = Math.max(S.lastTs, ts);
  const cut = ts - KEEP;
  for (const k of S.live.keys()) { if (k < cut) S.live.delete(k); else break; }
  ovOnTick(ts);
  ensureProcs(p.map((x) => x[0])).catch(() => {});
  scheduleRender();
}

function connect() {
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "tick") onTick(m);
    else if (m.type === "status") applyStatus(m);
  };
  es.onerror = () => { $("statusText").textContent = t("Disconnected – retrying …"); $("status").className = "status err"; };
  es.onopen = () => { loadLive().catch(showErr); };
}

/* ---------- events ---------- */
$("toggle").addEventListener("click", async () => {
  const btn = $("toggle");
  btn.disabled = true;
  try { applyStatus(await post(S.running ? "/api/stop" : "/api/start")); }
  catch (e) { showErr(e); }
  finally { btn.disabled = false; }
});
$("d-close").addEventListener("click", closeDetail);
$("scrim").addEventListener("click", () => (S.hostDetail ? closeHost() : closeDetail()));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (S.hostDetail) closeHost();
  else if (S.detail) closeDetail();
});
$("d-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("d-path").textContent);
  const lbl = $("d-copy").querySelector("span");
  lbl.textContent = t("Copied");
  setTimeout(() => (lbl.textContent = t("Copy")), 1500);
});
$("d-reveal").addEventListener("click", () => post("/api/reveal?id=" + S.detail).catch(showErr));
/* ---------- theme: explicit choice in data-theme (see theme.js), otherwise the system setting ---------- */
const darkMq = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme || (darkMq.matches ? "dark" : "light")) === "dark";
function renderThemeBtn() {
  const b = $("theme"), label = isDark() ? t("Switch to light mode") : t("Switch to dark mode");
  b.querySelector("use").setAttribute("href", isDark() ? "#i-sun" : "#i-moon");
  b.setAttribute("aria-label", label);
  b.title = label;
}
function onThemeChange() {  // charts read their colors from CSS variables once, so rebuild them
  renderThemeBtn();
  ovBuildCharts(); lvResetCharts();
  destroyChart(HV.chart); HV.chart = null; hvRender();
  destroyChart(EP.chart); EP.chart = null; epRender();
  scheduleRender();
}
darkMq.addEventListener("change", onThemeChange);
$("theme").addEventListener("click", () => {
  const th = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = th;
  try { localStorage.setItem("theme", th); } catch {}
  onThemeChange();
});
window.addEventListener("hashchange", route);
wireSeg($("st-lang"), (b) => {
  if (b.dataset.lang === LANG) return;
  try { localStorage.setItem("lang", b.dataset.lang); } catch {}
  location.reload();
});

/* ---------- boot ---------- */
translatePage();
renderThemeBtn();
ovInit();
lvInit();
hvInit();
epInit();
stInit();
document.querySelectorAll("table.procs").forEach(wireResize);
connect();
loadStatus().catch(showErr);
route();
setInterval(() => loadStatus().catch(() => {}), 10000);
setInterval(scheduleRender, 1000);   // keep live windows moving even when no ticks arrive
