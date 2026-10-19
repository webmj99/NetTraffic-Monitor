"use strict";
/* History: every application with traffic in a chosen period, stacked top-8 chart, CSV export. */
const HV = {
  preset: "86400", from: 0, to: 0, chan: "all", apps: {}, stack: null,
  sort: { key: "total", dir: -1 }, filter: "", book: new ColorBook(8), chart: null, loading: false,
};

const toLocalInput = (s) => {
  const d = new Date(s * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000);

function hvBounds() {
  if (HV.preset === "custom") return { from: HV.from, to: HV.to };
  const to = now() + 1;
  const from = HV.preset === "all" ? (S.firstTs || to - 86400) : to - +HV.preset;
  return { from, to };
}

async function hvLoad() {
  if (HV.loading) return;
  HV.loading = true;
  try {
    const { from, to } = hvBounds();
    HV.from = from; HV.to = to;
    $("hv-from").value = toLocalInput(from);
    $("hv-to").value = toLocalInput(to);
    const [apps, stack] = await Promise.all([
      api(`/api/apps?from=${from}&to=${to}`),
      api(`/api/stack?from=${from}&to=${to}&chan=${HV.chan}&n=8`),
    ]);
    HV.apps = apps;
    HV.stack = stack;
    Object.assign(S.procs, stack.meta);
    for (const [id, a] of Object.entries(apps)) S.procs[id] = S.procs[id] || a;
    S.runs = mergeRuns(stack.runs);
    hvRender();
  } finally {
    HV.loading = false;
  }
}

function hvRender() {
  const st = HV.stack;
  if (!st) return;
  const ids = st.procs.map(String);
  HV.book.assign(ids);
  const key = [...ids, HV.chan].join("|");
  if (!HV.chart || HV.chart._keys !== key) {
    destroyChart(HV.chart);
    HV.chart = makeStack($("hv-chart"), [
      ...ids.map((id) => ({ key: id, label: procName(id), color: HV.book.color(id) })),
      { key: "other", label: t("Other"), color: cssVar("--c-other") }]);
    HV.chart._keys = key;
  }
  const byTs = new Map(st.rows.map((r) => [r[0], r]));
  const x = [], raw = [...ids, "o"].map(() => []);
  for (let b = st.from - (st.from % st.step); b < st.to; b += st.step) {
    const r = byTs.get(b);
    x.push(b);
    raw.forEach((col, j) => col.push(r ? r[j + 1] / st.step : inRun(b, b + st.step) ? 0 : null));
  }
  setStack(HV.chart, x, raw);
  $("hv-step").textContent = t("Ø rate per {0}", fmtStep(st.step));

  const apps = Object.entries(HV.apps);
  const tot = [0, 0, 0, 0];
  for (const [, a] of apps) a.v.forEach((v, i) => (tot[i] += v));
  const span = Math.max(1, HV.to - HV.from);
  for (const c of CHANS) {
    $("hv-" + c.k).textContent = fmtBytes(tot[c.i]);
    $("hv-" + c.k + "-sub").innerHTML = `Ø <span>${fmtRate(tot[c.i] / span)}</span>`;
  }
  $("hv-apps").textContent = nf0.format(apps.length);
  $("hv-apps-sub").innerHTML = `${dtfShort.format(new Date(HV.from * 1000))} – ${dtfShort.format(new Date(HV.to * 1000))}`;
  hvRenderTable();
}

function hvRows() {
  const all = Object.entries(HV.apps);
  const grand = Math.max(1, all.reduce((s, [, a]) => s + a.v[0] + a.v[1] + a.v[2] + a.v[3], 0));
  const f = HV.filter.toLowerCase();
  const rows = [];
  for (const [id, a] of all) {
    const total = a.v[0] + a.v[1] + a.v[2] + a.v[3];
    const r = { id, name: procName(id), path: a.path || "", company: a.company || "", description: a.description || "",
      iu: a.v[0], id_: a.v[1], eu: a.v[2], ed: a.v[3], total, share: total / grand,
      minutes: a.minutes, pids: a.pids, last: Math.min(a.last_seen || 0, HV.to) };
    if (f && ![r.name, r.path, r.company, r.description].some((s) => s.toLowerCase().includes(f))) continue;
    rows.push(r);
  }
  const key = HV.sort.key === "id" ? "id_" : HV.sort.key;
  rows.sort((a, b) => (["name", "company"].includes(key) ? a[key].localeCompare(b[key]) : a[key] - b[key]) * HV.sort.dir);
  return rows;
}

function hvRenderTable() {
  const rows = hvRows();
  const cell = (v) => `<td class="num${v ? "" : " zero"}">${fmtBytes(v)}</td>`;
  $("hv-rows").innerHTML = rows.slice(0, 500).map((r) => `<tr tabindex="0" data-id="${r.id}">
    <td><span class="pname">${HV.book.has(r.id) ? `<span class="sw" style="background:${HV.book.color(r.id)}"></span>` : ""}${esc(r.name)}</span>
      <span class="ppath" title="${esc(r.path)}">${esc(r.path)}</span></td>
    <td class="co">${esc(r.company) || '<span class="zero">–</span>'}</td>
    ${cell(r.ed)}${cell(r.eu)}${cell(r.id_)}${cell(r.iu)}
    <td class="num">${fmtBytes(r.total)}</td>
    <td class="num">${nf1.format(r.share * 100)} %<span class="bar" style="width:${r.share * 100}%"></span></td>
    <td class="num">${fmtDur(r.minutes)}</td>
    <td class="num">${r.pids}</td>
    <td class="num">${r.last ? dtfShort.format(new Date(r.last * 1000)) : "–"}</td></tr>`).join("");
  $("hv-empty").hidden = rows.length > 0;
  $("hv-count").textContent = `(${nf0.format(rows.length)})`;
}

function hvCsv() {
  const head = ["Application", "Path", "Vendor", "Description", "Internet download (bytes)", "Internet upload (bytes)",
    "LAN download (bytes)", "LAN upload (bytes)", "Total (bytes)", "Share (%)", "Active (minutes)", "Processes", "Last active"].map((s) => t(s));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(CSV_SEP)].concat(hvRows().map((r) => [
    r.name, r.path, r.company, r.description, r.ed, r.eu, r.id_, r.iu, r.total,
    nf2.format(r.share * 100), r.minutes, r.pids, r.last ? dtfShort.format(new Date(r.last * 1000)) : "",
  ].map(q).join(CSV_SEP)));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const stamp = (s) => toLocalInput(s).replace(/[-:]/g, "").replace("T", "-");
  a.href = URL.createObjectURL(blob);
  a.download = `nettraffic-monitor-${t("applications")}-${stamp(HV.from)}_${stamp(HV.to)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function hvInit() {
  $("hv-kpis").innerHTML = CHANS.map((c) => kpiTile(c, "hv")).join("") +
    `<article class="kpi"><h2><svg class="ic"><use href="#i-grid"/></svg>${t("Applications")}</h2>
      <p class="big" id="hv-apps">–</p><p class="sub" id="hv-apps-sub">–</p></article>`;
  wireSeg($("hv-presets"), (b) => { HV.preset = b.dataset.preset; hvLoad().catch(showErr); });
  wireSeg($("hv-chan"), (b) => { HV.chan = b.dataset.chan; hvLoad().catch(showErr); });
  $("hv-custom").addEventListener("submit", (e) => {
    e.preventDefault();
    const from = fromLocalInput($("hv-from").value), to = fromLocalInput($("hv-to").value);
    if (!(to > from)) return showErr(new Error(t("\"To\" must be after \"From\".")));
    HV.preset = "custom"; HV.from = from; HV.to = to;
    for (const x of $("hv-presets").children) x.setAttribute("aria-checked", "false");
    S.error = null;
    hvLoad().catch(showErr);
  });
  wireSort($("hv-table"), HV, hvRenderTable);
  $("hv-filter").addEventListener("input", (e) => { HV.filter = e.target.value; hvRenderTable(); });
  $("hv-csv").addEventListener("click", hvCsv);
  const open = (tr) => openDetail(tr.dataset.id, HV.from, HV.to).catch(showErr);
  $("hv-rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) open(tr); });
  $("hv-rows").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(tr); }
  });
  // presets ending "now" keep themselves current
  setInterval(() => { if (S.view === "history" && HV.preset !== "custom") hvLoad().catch(() => {}); }, 30000);
}
