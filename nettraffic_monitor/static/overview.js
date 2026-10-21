"use strict";
/* Overview: combined charts per network, KPI tiles and process table for a selectable range. */
const OV = {
  range: "live", hist: null, top: {}, rate: {}, charts: {},
  sort: { key: "total", dir: -1 }, filter: "",
};
const OV_LIVE = 300;

function ovBounds() {
  const to = OV.range === "live" ? liveEnd() + 1 : now() + 1;
  return { from: to - (OV.range === "live" ? OV_LIVE : +OV.range), to };
}

function ovBuildCharts() {
  destroyChart(OV.charts.ext); destroyChart(OV.charts.int);
  const defs = () => [lineSeries("Download", cssVar("--dl")), lineSeries("Upload", cssVar("--ul"))];
  OV.charts.ext = makeChart($("chartExt"), defs());
  OV.charts.int = makeChart($("chartInt"), defs());
}

function ovLiveSeries() {
  const end = liveEnd(), start = end - OV_LIVE + 1;
  const x = [], cols = [[], [], [], []];
  for (let ts = start; ts <= end; ts++) {
    const rec = S.live.get(ts);
    x.push(ts);
    for (let i = 0; i < 4; i++) cols[i].push(rec ? rec.t[i] : inRun(ts) ? 0 : null);
  }
  return { x, cols, step: 1 };
}

function ovHistSeries() {
  const h = OV.hist;
  if (!h) return { x: [], cols: [[], [], [], []], step: 1 };
  const byTs = new Map(h.rows.map((r) => [r[0], r]));
  const x = [], cols = [[], [], [], []];
  for (let b = h.from - (h.from % h.step); b < h.to; b += h.step) {
    const r = byTs.get(b);
    x.push(b);
    for (let i = 0; i < 4; i++) cols[i].push(r ? r[i + 1] / h.step : inRun(b, b + h.step) ? 0 : null);
  }
  return { x, cols, step: h.step };
}

function ovLiveTop(x) {
  const top = {};
  for (const ts of x) {
    for (const [id, ...v] of S.live.get(ts)?.p || []) {
      const acc = top[id] || (top[id] = [0, 0, 0, 0]);
      for (let i = 0; i < 4; i++) acc[i] += v[i];
    }
  }
  return top;
}

function ovRender() {
  const d = OV.range === "live" ? ovLiveSeries() : ovHistSeries();
  if (OV.range === "live") OV.top = ovLiveTop(d.x);
  OV.charts.ext?.setData([d.x, d.cols[T.ED], d.cols[T.EU]]);
  OV.charts.int?.setData([d.x, d.cols[T.ID], d.cols[T.IU]]);
  $("stepHint").textContent = d.step > 1 ? t("Ø per {0}", fmtStep(d.step)) : t("per second");
  const end = liveEnd();
  for (const c of CHANS) {
    let n = 0, s = 0;
    for (let ts = end - 2; ts <= end; ts++) { const r = S.live.get(ts); if (r) { s += r.t[c.i]; n++; } }
    $("ov-" + c.k).textContent = S.running && n ? fmtRate(s / 3) : "–";
    const sum = d.cols[c.i].reduce((a, v) => a + (v || 0), 0) * d.step;
    $("ov-" + c.k + "-sub").innerHTML = `${t("Sum")} <span>${fmtBytes(sum)}</span>`;
  }
  ovRenderTable();
}

function ovRenderTable() {
  const ids = new Set([...Object.keys(OV.top), ...Object.keys(OV.rate)]);
  const f = OV.filter.toLowerCase();
  let rows = [];
  for (const id of ids) {
    const m = S.procs[id];
    const v = OV.top[id] || [0, 0, 0, 0];
    const r = { id, name: procName(id), path: m?.path || "", iu: v[0], id_: v[1], eu: v[2], ed: v[3],
      total: v[0] + v[1] + v[2] + v[3], rate: OV.rate[id] || 0 };
    if (f && !(r.name.toLowerCase().includes(f) || r.path.toLowerCase().includes(f))) continue;
    rows.push(r);
  }
  const key = OV.sort.key === "id" ? "id_" : OV.sort.key;
  rows.sort((a, b) => (key === "name" ? a.name.localeCompare(b.name) : a[key] - b[key]) * OV.sort.dir);
  rows = rows.slice(0, 300);
  const max = Math.max(1, ...rows.map((r) => r.total));
  const cell = (v, rate) => `<td class="num${v ? "" : " zero"}">${rate ? fmtRate(v) : fmtBytes(v)}</td>`;
  renderRows($("rows"), rows.map((r) => `<tr tabindex="0" data-id="${r.id}" aria-describedby="row-hint">
    <td><span class="pname">${esc(r.name)}</span><span class="ppath" title="${esc(r.path)}">${esc(r.path)}</span></td>
    ${cell(r.ed)}${cell(r.eu)}${cell(r.id_)}${cell(r.iu)}
    <td class="num">${fmtBytes(r.total)}<span class="bar" style="width:${(r.total / max) * 100}%"></span></td>
    ${cell(r.rate, true)}</tr>`).join(""));
  $("empty").hidden = rows.length > 0;
}

async function ovLoadTop() {
  if (OV.range === "live") return;  // computed from the live seconds in ovRender
  const { from, to } = ovBounds();
  OV.top = await api(`/api/top?from=${from}&to=${to}`);
  await ensureProcs(Object.keys(OV.top));
  scheduleRender();
}

async function ovLoadHistory() {
  if (OV.range === "live") return;
  const { from, to } = ovBounds();
  OV.hist = await api(`/api/history?from=${from}&to=${to}`);
  S.runs = OV.hist.runs.length ? mergeRuns(OV.hist.runs) : S.runs;
  scheduleRender();
}

function ovOnTick(ts) {
  const rate = {};
  for (let t = ts - 2; t <= ts; t++) {
    for (const p of S.live.get(t)?.p || []) rate[p[0]] = (rate[p[0]] || 0) + (p[1] + p[2] + p[3] + p[4]) / 3;
  }
  OV.rate = rate;
}

function ovInit() {
  $("ov-kpis").innerHTML = CHANS.map((c) => kpiTile(c, "ov")).join("");
  ovBuildCharts();
  wireSeg($("ranges"), (b) => {
    OV.range = b.dataset.range;
    OV.hist = null; OV.top = {};
    scheduleRender();
    ovLoadHistory().catch(showErr);
    ovLoadTop().catch(showErr);
  });
  wireSort($("ov-table"), OV, ovRenderTable);
  $("filter").addEventListener("input", (e) => { OV.filter = e.target.value; ovRenderTable(); });
  const open = (tr) => { const { from, to } = ovBounds(); openDetail(tr.dataset.id, from, to).catch(showErr); };
  $("rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) open(tr); });
  $("rows").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(tr); }
  });
  let n = 0;
  setInterval(() => {
    if (S.view !== "overview") return;
    if (OV.range === "live" || ++n % 3 === 0) ovLoadTop().catch(() => {});
    if (OV.range !== "live" && n % 3 === 0) ovLoadHistory().catch(() => {});
  }, 5000);
}
