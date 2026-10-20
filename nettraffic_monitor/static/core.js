"use strict";
/* Shared state, formatting, API, chart helpers and the process drawer. */
const $ = (id) => document.getElementById(id);
const T = { IU: 0, ID: 1, EU: 2, ED: 3 };
const KEEP = 900;          // seconds of per-second data kept in the browser

/* ---------- language: English source strings, German via DE_TEXT ---------- */
const LANG = (() => { try { return localStorage.getItem("lang") === "de" ? "de" : "en"; } catch { return "en"; } })();
const LOCALE = LANG === "de" ? "de-DE" : "en-US";
const CSV_SEP = LANG === "de" ? ";" : ",";  // what Excel expects for that locale
const DE_TEXT = {
  "Views": "Ansichten", "Overview": "Übersicht", "Live detail": "Live-Detail", "History": "Verlauf", "Endpoints": "Gegenstellen",
  "Connecting …": "Verbinde …", "Period": "Zeitraum", "Live 5 min": "Live 5 Min", "1 h": "1 Std", "6 h": "6 Std", "24 h": "24 Std",
  "7 days": "7 Tage", "30 days": "30 Tage", "All time": "Gesamt", "Internet traffic": "Internet-Traffic", "LAN traffic": "LAN-Traffic",
  "Processes": "Prozesse", "Process": "Prozess", "Filter processes": "Prozesse filtern", "Filter by name or path": "Name oder Pfad filtern",
  "Process / path": "Prozess / Pfad", "Total": "Gesamt", "Current": "Aktuell",
  "No processes with traffic in this period.": "Keine Prozesse mit Traffic in diesem Zeitraum.",
  "per second · upload and download separately for internet and LAN": "sekündlich · Upload und Download getrennt für Internet und LAN",
  "Time window": "Zeitfenster", "1 min": "1 Min", "5 min": "5 Min", "15 min": "15 Min", "Pause": "Pausieren", "Resume": "Fortsetzen",
  "From": "Von", "To": "Bis", "Show": "Anzeigen", "Top applications over time": "Top-Anwendungen im Zeitverlauf", "Channel": "Kanal",
  "All": "Alle", "All applications": "Alle Anwendungen", "Filter applications": "Anwendungen filtern",
  "Name, path or vendor": "Name, Pfad oder Hersteller", "Application / path": "Anwendung / Pfad", "Vendor": "Hersteller",
  "Share": "Anteil", "Active": "Aktiv", "Last active": "Zuletzt aktiv",
  "No applications with traffic in this period.": "Keine Anwendungen mit Traffic in diesem Zeitraum.",
  "New in period": "Neu im Zeitraum", "first seen": "erstmals gesehen", "Largest endpoint": "Größte Gegenstelle",
  "Top endpoints over time": "Top-Gegenstellen im Zeitverlauf", "All endpoints": "Alle Gegenstellen", "Network": "Netz",
  "Filter endpoints": "Gegenstellen filtern", "Host, IP, port or process": "Host, IP, Port oder Prozess",
  "Endpoint / IP": "Gegenstelle / IP", "Endpoint": "Gegenstelle", "Services / ports": "Dienste / Ports", "First": "Erstmals", "Last": "Zuletzt",
  "No endpoints in this period.": "Keine Gegenstellen in diesem Zeitraum.", "Close details": "Details schließen", "Path": "Pfad",
  "Copy": "Kopieren", "Copied": "Kopiert", "Show in Explorer": "Im Explorer zeigen", "Product": "Produkt", "File size": "Dateigröße",
  "File modified": "Datei geändert", "First seen": "Erstmals gesehen", "Last seen": "Zuletzt gesehen",
  "Endpoints in period": "Gegenstellen im Zeitraum", "Process IDs": "Prozess-IDs", "Started": "Gestartet",
  "Active from – to": "Aktiv von – bis", "IP address": "IP-Adresse", "Total traffic": "Traffic gesamt", "In period": "Im Zeitraum",
  "Traffic in period": "Traffic im Zeitraum", "(total)": "(gesamt)", "Service": "Dienst", "First – last": "Erstmals – zuletzt",
  "{0} min": "{0} Min", "{0} h {1} min": "{0} Std {1} Min", "{0} days": "{0} Tage", "{0} h": "{0} Std", "{0} day": "{0} Tag",
  "Time": "Zeit", "No file description": "Keine Dateibeschreibung", "No endpoints recorded": "Keine Gegenstellen aufgezeichnet",
  "Column width {0}": "Spaltenbreite {0}", "Running since {0}": "Läuft seit {0}", "Language": "Sprache", "Switch to dark mode": "Zum dunklen Modus wechseln", "Switch to light mode": "Zum hellen Modus wechseln", "Interface language": "Sprache der Oberfläche",
  "Saved in this browser. The page reloads to apply it.": "Wird in diesem Browser gespeichert. Die Seite lädt dafür neu.", "lost: {0} events, {1} buffers": "verloren: {0} Events, {1} Puffer", "Stopped": "Gestoppt",
  "No data for {0} s": "Keine Daten seit {0} s", "Error": "Fehler", "Error: {0}": "Fehler: {0}", "Stop": "Stopp",
  "Start monitoring": "Monitoring starten", "Stop monitoring": "Monitoring stoppen",
  "Data {0} (+ {1} write buffer) · {2} seconds with traffic · {3} programs · {4} endpoints · data since {5}":
    "Daten {0} (+ {1} Schreibpuffer) · {2} Sekunden mit Traffic · {3} Programme · {4} Gegenstellen · Daten seit {5}",
  "Disconnected – retrying …": "Verbindung getrennt – versuche erneut …", "Ø per {0}": "Ø je {0}", "per second": "sekündlich",
  "Sum": "Summe", "Ø 1 min": "Ø 1 Min", "Peak": "Spitze", "Other": "Andere", "Details for {0}": "Details zu {0}",
  "No traffic in time window": "Kein Traffic im Zeitfenster", "No endpoints in time window": "Keine Gegenstellen im Zeitfenster",
  "Ø rate per {0}": "Ø Rate je {0}", "Applications": "Anwendungen", "applications": "anwendungen", "endpoints": "gegenstellen",
  "\"To\" must be after \"From\".": "„Bis“ muss nach „Von“ liegen.", "(local)": "(lokal)", "new": "neu", "no hostname": "kein Hostname",
  "yes": "ja", "no": "nein", "– (no reverse DNS entry)": "– (kein Reverse-DNS-Eintrag)",
  "LAN (local/private network)": "LAN (lokales/privates Netz)", "{0} in {1} of active time": "{0} in {1} aktiver Zeit",
  "No data in period": "Keine Daten im Zeitraum",
  "Application": "Anwendung", "Description": "Beschreibung", "Internet download (bytes)": "Internet Download (Bytes)",
  "Internet upload (bytes)": "Internet Upload (Bytes)", "LAN download (bytes)": "LAN Download (Bytes)", "LAN upload (bytes)": "LAN Upload (Bytes)",
  "Total (bytes)": "Gesamt (Bytes)", "Share (%)": "Anteil (%)", "Active (minutes)": "Aktiv (Minuten)", "Services/ports": "Dienste/Ports",
  "Download (bytes)": "Download (Bytes)", "Upload (bytes)": "Upload (Bytes)",
  "unknown endpoint": "Gegenstelle unbekannt", "unknown process": "Prozess unbekannt",
  "Not available in service mode": "Im Dienstmodus nicht verfügbar", "File not found": "Datei nicht gefunden",
  "Settings": "Einstellungen", "Data retention": "Datenaufbewahrung",
  "Data older than this is deleted permanently. Leave empty (or 0) to keep it forever.":
    "Ältere Daten werden endgültig gelöscht. Leer lassen (oder 0), um sie für immer zu behalten.",
  "Per-second detail": "Sekundendaten", "forever": "für immer", "days": "Tage",
  "Live view and periods up to 1 hour. Older periods are shown from per-minute data. This is the bulk of the database.":
    "Live-Ansicht und Zeiträume bis 1 Stunde. Ältere Zeiträume werden aus Minutendaten angezeigt. Der Großteil der Datenbank.",
  "Per-minute history": "Minutenverlauf",
  "Charts and tables for longer periods. Must be kept at least as long as per-second detail.":
    "Diagramme und Tabellen für längere Zeiträume. Muss mindestens so lange wie die Sekundendaten aufbewahrt werden.",
  "Remote endpoints with their ports and processes (per minute).": "Gegenstellen mit Ports und Prozessen (minutengenau).",
  "Clean up automatically: after saving and every 6 hours": "Automatisch aufräumen: nach dem Speichern und alle 6 Stunden",
  "Compact the database after an automatic cleanup once at least 25 % of the file is free space":
    "Datenbank nach automatischem Aufräumen komprimieren, sobald mindestens 25 % der Datei frei sind",
  "Save": "Speichern", "Saved": "Gespeichert", "Database maintenance": "Datenbankpflege",
  "Clean up now": "Jetzt aufräumen", "Deletes data older than the saved retention periods.":
    "Löscht Daten, die älter als die gespeicherten Aufbewahrungsfristen sind.",
  "Clean up": "Aufräumen", "Compact database": "Datenbank komprimieren",
  "Rebuilds the file to give free space back to the disk (VACUUM). Needs free disk space about the size of the database; new data waits in memory meanwhile.":
    "Baut die Datei neu auf und gibt freien Platz an die Festplatte zurück (VACUUM). Braucht freien Speicher etwa in Größe der Datenbank; neue Daten warten solange im Arbeitsspeicher.",
  "Compact": "Komprimieren", "Empty write buffer": "Schreibpuffer leeren",
  "Moves the write-ahead log (WAL) into the database and truncates it.": "Überträgt das Write-Ahead-Log (WAL) in die Datenbank und kürzt es.",
  "Empty": "Leeren", "Check integrity": "Integrität prüfen",
  "Quick read-only consistency check of the database file.": "Schnelle, nur lesende Konsistenzprüfung der Datenbankdatei.",
  "Check": "Prüfen", "Database file": "Datenbankdatei", "Free space in file": "Freier Platz in der Datei",
  "Write buffer (WAL)": "Schreibpuffer (WAL)", "{0} ({1} %) – reclaimable by compacting": "{0} ({1} %) – durch Komprimieren freizugeben",
  "{0} seconds with traffic, oldest {1}": "{0} Sekunden mit Traffic, älteste {1}", "oldest {0}": "älteste {0}",
  "{0} endpoints, oldest {1}": "{0} Gegenstellen, älteste {1}", "kept forever": "unbegrenzt aufbewahrt",
  "kept {0} days": "{0} Tage aufbewahrt", "Running: {0} …": "Läuft: {0} …", "never run": "noch nie ausgeführt",
  "automatic": "automatisch", "Failed: {0}": "Fehlgeschlagen: {0}", "nothing to delete": "nichts zu löschen",
  "{0} rows deleted": "{0} Zeilen gelöscht", "{0} → {1} (readers still active)": "{0} → {1} (Leser noch aktiv)",
  "no problems found": "keine Probleme gefunden", "{0} problems: {1}": "{0} Probleme: {1}",
  "This permanently deletes {0} per-second rows, {1} per-minute rows and {2} endpoint rows. Continue?":
    "Dies löscht endgültig {0} Sekunden-, {1} Minuten- und {2} Gegenstellen-Zeilen. Fortfahren?",
  "Another maintenance task is running": "Eine andere Wartungsaufgabe läuft gerade",
  "Retention must be a whole number of days between 0 and 36500":
    "Die Aufbewahrung muss eine ganze Zahl von Tagen zwischen 0 und 36500 sein",
  "Per-minute history must be kept at least as long as per-second detail":
    "Der Minutenverlauf muss mindestens so lange wie die Sekundendaten aufbewahrt werden",
};
const t = (s, ...a) => ((LANG === "de" && DE_TEXT[s]) || s).replace(/\{(\d)\}/g, (_, i) => a[i]);
function translatePage() {
  document.documentElement.lang = LANG;
  for (const b of $("st-lang").children) b.setAttribute("aria-checked", String(b.dataset.lang === LANG));
  if (LANG !== "de") return;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const k = n.nodeValue.trim();
    if (DE_TEXT[k]) n.nodeValue = n.nodeValue.replace(k, () => DE_TEXT[k]);
  }
  for (const a of ["placeholder", "aria-label"]) {
    for (const el of document.querySelectorAll(`[${a}]`)) if (DE_TEXT[el.getAttribute(a)]) el.setAttribute(a, DE_TEXT[el.getAttribute(a)]);
  }
}

// The four traffic channels, in display order.
const CHANS = [
  { k: "ed", i: T.ED, net: "Internet", dir: "Download", icon: "i-globe", arrow: "i-down" },
  { k: "eu", i: T.EU, net: "Internet", dir: "Upload", icon: "i-globe", arrow: "i-up" },
  { k: "id", i: T.ID, net: "LAN", dir: "Download", icon: "i-lan", arrow: "i-down" },
  { k: "iu", i: T.IU, net: "LAN", dir: "Upload", icon: "i-lan", arrow: "i-up" },
];

const S = {
  view: "overview",
  running: false, since: null, error: null, lost: [0, 0], lastTick: 0, lastTs: 0, firstTs: null,
  live: new Map(),          // ts -> {t: totals, p: [[proc,..4]]|null, e: [[proc, ip,..4]]|null}
  runs: [],                 // [[start, stop|null]]
  procs: {}, hosts: {},
  detail: null,
};

/* ---------- formatting ---------- */
const nf1 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
function fmtBytes(n) {
  if (n == null) return "–";
  const u = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i === 0 || n >= 100 ? nf0 : nf1).format(n) + " " + u[i];
}
const fmtRate = (n) => (n == null ? "–" : fmtBytes(n) + "/s");
const dtf = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "medium" });
const dtfShort = new Intl.DateTimeFormat(LOCALE, { dateStyle: "short", timeStyle: "short" });
const tf = new Intl.DateTimeFormat(LOCALE, { timeStyle: "medium" });
const fmtTs = (s) => (s ? dtf.format(new Date(s * 1000)) : "–");
const fmtFiletime = (ft) => (ft ? fmtTs(Math.floor((ft - 116444736000000000) / 1e7)) : "–");
function fmtDur(min) {
  if (min < 60) return t("{0} min", min);
  const h = Math.floor(min / 60), m = min % 60;
  return h < 48 ? t("{0} h {1} min", h, m) : t("{0} days", nf1.format(min / 1440));
}
function fmtStep(s) {
  if (s < 60) return s + " s";
  if (s < 3600) return t("{0} min", s / 60);
  if (s < 86400) return t("{0} h", s / 3600);
  return t("{0} day", s / 86400);
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const now = () => Math.floor(Date.now() / 1000);
// Last complete second: follow the server's ticks so the window moves exactly when data arrives.
const liveEnd = () => (S.running && now() - S.lastTs <= 5 ? S.lastTs : now() - 2);
// Name, plus description (or parent folder) when several executables share that name.
function procName(id) {
  const m = S.procs[id];
  if (!m) return "…";
  const twins = Object.entries(S.procs).filter(([k, o]) => k !== String(id) && o && o.name === m.name);
  if (!twins.length) return m.name;
  const parts = (m.path || "").split("\\");
  const descUnique = m.description && twins.every(([, o]) => o.description !== m.description);
  return `${m.name} (${descUnique ? m.description : parts[parts.length - 2] || "?"})`;
}

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
const post = (path, body) => api(path, body === undefined ? { method: "POST", headers: { "X-NetTraffic-Monitor": "1" } }
  : { method: "POST", headers: { "X-NetTraffic-Monitor": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function ensureProcs(ids) {
  const missing = ids.filter((id) => !(id in S.procs));
  if (!missing.length) return;
  missing.forEach((id) => (S.procs[id] = null));
  Object.assign(S.procs, await api("/api/procs?ids=" + missing.join(",")));
}

const inRun = (a, b = a + 1) => S.runs.some(([s, e]) => s < b && (e == null || e >= a));

/* ---------- charts ---------- */
const DE = {
  MMMM: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
  MMM: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
  WWWW: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
  WWW: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
};
const axHms = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const axHm = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const axDay = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit" });
const axDayHm = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
function fmtAxisTime(v, incr) {
  const d = new Date(v * 1000);
  if (incr < 60) return axHms.format(d);
  if (incr < 3600 * 6) return axHm.format(d);
  if (incr < 86400) return axDayHm.format(d);
  return axDay.format(d);
}

// Draw markers only for isolated values - a line needs two neighbours to be visible.
function isolated(u, si) {
  const d = u.data[si], out = [];
  for (let i = 0; i < d.length; i++) if (d[i] != null && d[i - 1] == null && d[i + 1] == null) out.push(i);
  return out;
}

function lineSeries(label, color, dash) {
  return {
    label, stroke: color, width: 2, dash, spanGaps: false,
    points: { show: true, size: 6, fill: color, filter: isolated },
    fill: dash ? undefined : color + "26",
    value: (u, v) => fmtRate(v),
  };
}

function makeChart(el, series, extra = {}) {
  el.textContent = "";
  const grid = { stroke: cssVar("--grid"), width: 1 };
  const axis = { stroke: cssVar("--text-3"), grid, ticks: { show: false }, font: "12px " + cssVar("--font") };
  // plot height comes from CSS (--plot-h); the container grows with the (wrapping) legend
  const plotH = parseInt(getComputedStyle(el).getPropertyValue("--plot-h")) || 220;
  const opts = {
    width: el.clientWidth || 600, height: plotH,
    fmtDate: (tpl) => uPlot.fmtDate(tpl, LANG === "de" ? DE : undefined),
    cursor: { drag: { x: false, y: false }, points: { size: 8 } },
    legend: { live: true },
    scales: { x: { time: true }, y: { range: (u, mn, mx) => [0, Math.max(mx * 1.1, 1000)] } },
    axes: [{ ...axis, space: 80, values: (u, vals, ai, space, incr) => vals.map((v) => fmtAxisTime(v, incr)) },
      { ...axis, size: 72, values: (u, vals) => vals.map(fmtRate) }],
    series: [{ label: t("Time"), value: (u, v) => (v == null ? "–" : dtfShort.format(new Date(v * 1000))) }, ...series],
    ...extra,
  };
  const chart = new uPlot(opts, [[], ...series.map(() => [])], el);
  let lastW = el.clientWidth;
  chart._ro = new ResizeObserver(() => {
    if (el.clientWidth && el.clientWidth !== lastW) { lastW = el.clientWidth; chart.setSize({ width: el.clientWidth, height: plotH }); }
  });
  chart._ro.observe(el);
  return chart;
}

function destroyChart(c) {
  if (!c) return;
  c._ro?.disconnect();
  c.destroy();
}

/* Stacked areas: defs = [{label, color}], bottom first. Legend/tooltip shows raw (unstacked) values.
   A legend click leaves the series out of the stack (chart._off) instead of hiding it in uPlot: each band*/
function makeStack(el, defs) {
  const series = defs.map((d, i) => ({
    // fills only: with spiky per-second data an outline would trace the whole stack in the top color
    label: d.label, stroke: "transparent", width: 0, spanGaps: false,
    fill: i === 0 ? d.color + "d9" : undefined,
    points: { show: true, size: 6, fill: d.color, filter: (u, si) => (u._off.has(si) ? [] : isolated(u, si)) },
    value: (u, v, si, idx) => (idx == null ? "–" : fmtRate(u._raw?.[si - 1]?.[idx])),
  }));
  const bands = defs.slice(1).map((d, i) => ({ series: [i + 2, i + 1], fill: d.color + "d9" }));
  const chart = makeChart(el, series, { bands });
  chart._keys = defs.map((d) => d.key).join("|");
  chart._off = new Set();
  chart.root.querySelectorAll(".u-legend .u-series").forEach((row, i) => {
    if (i === 0) return;
    // solid legend swatches (stacked series have no own fill, "Other" has no stroke)
    const mk = row.querySelector(".u-marker");
    if (mk) { mk.style.background = defs[i - 1].color; mk.style.borderColor = defs[i - 1].color; }
    row.addEventListener("click", (e) => {  // capture phase: runs before (and replaces) uPlot's own toggle
      e.stopPropagation();
      if (!chart._off.delete(i)) chart._off.add(i);
      row.classList.toggle("u-off", chart._off.has(i));
      if (chart._raw) setStack(chart, chart.data[0], chart._raw);
    }, true);
  });
  return chart;
}

function setStack(chart, x, raw) {
  const cum = [];
  raw.forEach((col, i) => {
    const off = chart._off.has(i + 1);  // left out: zero height, keeps gaps (null) for the bands
    cum.push(col.map((v, j) => (v == null ? null : (off ? 0 : v) + (i ? cum[i - 1][j] ?? 0 : 0))));
  });
  chart._raw = raw;
  chart.setData([x, ...cum]);
}

/* Stable colors per process: a process keeps its slot while it stays in the wanted set. */
class ColorBook {
  constructor(n = 8) { this.n = n; this.map = new Map(); }
  assign(ids) {
    const want = new Set(ids.map(String));
    for (const id of [...this.map.keys()]) if (!want.has(id)) this.map.delete(id);
    const used = new Set(this.map.values());
    for (const id of want) {
      if (this.map.has(id)) continue;
      for (let s = 1; s <= this.n; s++) if (!used.has(s)) { this.map.set(id, s); used.add(s); break; }
    }
  }
  has(id) { return this.map.has(String(id)); }
  color(id) { const s = this.map.get(String(id)); return cssVar(s ? "--c" + s : "--c-other"); }
}

/* ---------- process drawer ---------- */
let lastFocus = null, procChart = null;
async function openDetail(id, from, to) {
  if (!$("hdrawer").hidden) closeHost(false);
  lastFocus = document.activeElement;
  S.detail = id;
  const d = await api(`/api/proc?id=${id}&from=${from}&to=${to}`);
  const m = d.meta;
  $("d-name").textContent = m.name;
  $("d-desc").textContent = m.description || t("No file description");
  $("d-path").textContent = m.path;
  $("d-company").textContent = m.company || "–";
  $("d-product").textContent = m.product || "–";
  $("d-size").textContent = m.file_size != null ? `${fmtBytes(m.file_size)} (${nf0.format(m.file_size)} Bytes)` : "–";
  $("d-mtime").textContent = fmtTs(m.file_mtime);
  $("d-first").textContent = fmtTs(m.first_seen);
  $("d-last").textContent = fmtTs(m.last_seen);
  $("d-range").textContent = `${dtfShort.format(new Date(from * 1000))} – ${dtfShort.format(new Date(to * 1000))}`;
  $("d-reveal").disabled = m.path.startsWith("[");
  $("d-pids").innerHTML = d.pids.map((p) => `<tr><td>${p.pid}</td><td>${fmtFiletime(p.created)}</td>
    <td>${dtfShort.format(new Date(p.first_seen * 1000))} – ${tf.format(new Date(p.last_seen * 1000))}</td></tr>`).join("")
    || `<tr><td colspan="3">–</td></tr>`;
  $("d-hosts").innerHTML = (d.hosts || []).map((h) => `<tr class="link" data-ip="${esc(h.ip)}" tabindex="0">
    <td>${esc(h.name || h.ip)}${h.name ? `<span class="ppath">${esc(h.ip)}</span>` : ""}</td><td>${h.lan ? "LAN" : "Internet"}</td>
    <td class="num">${fmtBytes(h.id + h.ed)}</td><td class="num">${fmtBytes(h.iu + h.eu)}</td></tr>`).join("")
    || `<tr><td colspan="4">${t("No endpoints recorded")}</td></tr>`;
  $("d-hosts").onclick = $("d-hosts").onkeydown = (e) => {
    const tr = e.target.closest("tr[data-ip]");
    if (!tr || (e.type === "keydown" && e.key !== "Enter")) return;
    closeDetail();
    openHost(tr.dataset.ip, from, to).catch(showErr);
  };
  $("scrim").hidden = false;
  $("drawer").hidden = false;
  $("d-close").focus();
  destroyChart(procChart);
  procChart = makeChart($("chartProc"), [
    lineSeries("Internet ↓", cssVar("--dl")), lineSeries("Internet ↑", cssVar("--ul")),
    lineSeries("LAN ↓", cssVar("--c3"), [5, 4]), lineSeries("LAN ↑", cssVar("--c4"), [5, 4])]);
  const byTs = new Map(d.rows.map((r) => [r[0], r]));
  const x = [], c = [[], [], [], []];
  for (let b = from - (from % d.step); b < to; b += d.step) {
    const r = byTs.get(b);
    x.push(b);
    for (let i = 0; i < 4; i++) c[i].push(r ? r[i + 1] / d.step : inRun(b, b + d.step) ? 0 : null);
  }
  procChart.setData([x, c[T.ED], c[T.EU], c[T.ID], c[T.IU]]);
}

function closeDetail() {
  $("drawer").hidden = true;
  $("scrim").hidden = true;
  destroyChart(procChart);
  procChart = null;
  S.detail = null;
  lastFocus?.focus();
}

function showErr(e) {
  S.error = e.message;
  renderStatus();
}

/* Generic sortable-table header wiring. */
function wireSort(table, state, onChange) {
  table.querySelector("thead").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    const key = b.dataset.sort;
    const textual = ["name", "company"].includes(key);
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : textual ? 1 : -1 };
    table.querySelectorAll("th button").forEach((x) => x.removeAttribute("aria-sort"));
    b.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
    onChange();
  });
}

/* Resizable columns: a grip on each header's right edge (drag, or focus + ←/→). On first use the
   current widths are frozen and the table switches to fixed layout; .table-wrap scrolls if it grows. */
function wireResize(table) {
  const ths = [...table.querySelectorAll("thead th")];
  const freeze = () => {
    if (table.classList.contains("resized")) return;
    const ws = ths.map((th) => Math.ceil(th.getBoundingClientRect().width)); // offsetWidth may round down -> ellipsis
    ths.forEach((th, i) => (th.style.width = ws[i] + "px"));
    table.style.width = ws.reduce((a, b) => a + b, 0) + "px";
    table.classList.add("resized");
  };
  const setW = (th, w) => {
    w = Math.max(48, Math.round(w));
    table.style.width = table.offsetWidth + w - th.offsetWidth + "px";
    th.style.width = w + "px";
  };
  for (const th of ths) {
    const g = document.createElement("span");
    g.className = "col-grip";
    g.tabIndex = 0;
    g.setAttribute("role", "separator");
    g.setAttribute("aria-orientation", "vertical");
    g.setAttribute("aria-label", t("Column width {0}", th.textContent.trim()));
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      freeze();
      g.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = th.offsetWidth;
      const move = (ev) => setW(th, w0 + ev.clientX - x0);
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", () => g.removeEventListener("pointermove", move), { once: true });
    });
    g.addEventListener("keydown", (e) => {
      const d = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
      if (!d) return;
      e.preventDefault();
      freeze();
      setW(th, th.offsetWidth + d);
    });
    th.append(g);
  }
}

/* Generic radiogroup (segmented control) wiring with arrow-key support. */
function wireSeg(el, onPick) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[role=radio]");
    if (!b) return;
    for (const x of el.children) x.setAttribute("aria-checked", String(x === b));
    onPick(b);
  });
  el.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const btns = [...el.children], i = btns.indexOf(document.activeElement);
    const n = btns[(i + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length];
    n.focus(); n.click();
  });
}

function kpiTile(c, idPrefix) {
  return `<article class="kpi"><h2><svg class="ic"><use href="#${c.icon}"/></svg>${c.net}
    <span class="dir ${c.dir === "Download" ? "dl" : "ul"}"><svg class="ic"><use href="#${c.arrow}"/></svg>${c.dir}</span></h2>
    <p class="big" id="${idPrefix}-${c.k}">–</p><p class="sub" id="${idPrefix}-${c.k}-sub">–</p></article>`;
}
