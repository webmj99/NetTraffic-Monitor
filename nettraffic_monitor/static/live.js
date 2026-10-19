"use strict";
/* Live-Detail: one panel per channel with per-second stacked rates and live rankings. */
const LV = { win: 300, paused: false, sets: {}, charts: {}, book: new ColorBook(8), lastSets: 0 };
const LV_TOP = 5, LV_LIST = 6;

function lvInit() {
  $("lv-panels").innerHTML = CHANS.map((c) => `
    <article class="card lv" aria-labelledby="lv-${c.k}-h">
      <header class="card-h"><h2 id="lv-${c.k}-h"><svg class="ic"><use href="#${c.icon}"/></svg>${c.net}
        <span class="dir ${c.dir === "Download" ? "dl" : "ul"}"><svg class="ic"><use href="#${c.arrow}"/></svg>${c.dir}</span></h2></header>
      <div class="lv-stats">
        <div class="stat main"><span class="lbl">${t("Current")} <small>Ø 3 s</small></span><span class="val" id="lv-${c.k}-now">–</span></div>
        <div class="stat"><span class="lbl">${t("Ø 1 min")}</span><span class="val" id="lv-${c.k}-avg">–</span></div>
        <div class="stat"><span class="lbl">${t("Peak")}</span><span class="val" id="lv-${c.k}-peak">–</span></div>
        <div class="stat"><span class="lbl">${t("Sum")}</span><span class="val" id="lv-${c.k}-sum">–</span></div>
      </div>
      <div class="chart" id="lv-${c.k}-chart"></div>
      <div class="lv-lists">
        <div><h3>${t("Processes")}</h3><ol class="rank" id="lv-${c.k}-procs"></ol></div>
        <div><h3>${t("Endpoints")}</h3><ol class="rank" id="lv-${c.k}-eps"></ol></div>
      </div>
    </article>`).join("");

  wireSeg($("lv-win"), (b) => { LV.win = +b.dataset.win; LV.lastSets = 0; lvRender(); });
  $("lv-pause").addEventListener("click", () => {
    LV.paused = !LV.paused;
    const b = $("lv-pause");
    b.setAttribute("aria-pressed", String(LV.paused));
    b.querySelector("use").setAttribute("href", LV.paused ? "#i-play" : "#i-pause");
    b.querySelector("span").textContent = LV.paused ? t("Resume") : t("Pause");
    if (!LV.paused) lvRender();
  });
  $("lv-panels").addEventListener("click", (e) => {
    const li = e.target.closest("[data-proc],[data-ip]");
    if (!li) return;
    const to = now() + 1;
    if (li.dataset.ip) openHost(li.dataset.ip, to - LV.win, to).catch(showErr);
    else openDetail(li.dataset.proc, to - LV.win, to).catch(showErr);
  });
  $("lv-panels").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-proc],[data-ip]")) { e.preventDefault(); e.target.click(); }
  });
}

function lvResetCharts() {
  for (const k in LV.charts) destroyChart(LV.charts[k]);
  LV.charts = {};
}

function lvRender() {
  if (S.view !== "live" || LV.paused) return;
  const end = now() - 2, start = end - LV.win + 1;

  // One pass over the window: per channel sums, 3 s rates, peaks, endpoint sums.
  const A = CHANS.map(() => ({ sum: 0, peak: 0, rate: 0, avg: 0, procs: new Map(), pr: new Map(), eps: new Map(), er: new Map() }));
  for (let ts = start; ts <= end; ts++) {
    const r = S.live.get(ts);
    if (!r) continue;
    const recent = ts > end - 3, minute = ts > end - 60;
    CHANS.forEach((c, ci) => {
      const a = A[ci], v = r.t[c.i];
      a.sum += v;
      if (v > a.peak) a.peak = v;
      if (recent) a.rate += v / 3;
      if (minute) a.avg += v / 60;
    });
    for (const p of r.p || []) {
      CHANS.forEach((c, ci) => {
        const v = p[c.i + 1];
        if (!v) return;
        A[ci].procs.set(p[0], (A[ci].procs.get(p[0]) || 0) + v);
        if (recent) A[ci].pr.set(p[0], (A[ci].pr.get(p[0]) || 0) + v / 3);
      });
    }
    for (const e of r.e || []) {
      CHANS.forEach((c, ci) => {
        const v = e[c.i + 2];
        if (!v) return;
        const key = e[0] + "|" + e[1];
        A[ci].eps.set(key, (A[ci].eps.get(key) || 0) + v);
        if (recent) A[ci].er.set(key, (A[ci].er.get(key) || 0) + v / 3);
      });
    }
  }

  // Re-pick the stacked processes every 5 s so series (and colors) don't flicker every second.
  if (Date.now() - LV.lastSets > 5000) {
    LV.lastSets = Date.now();
    const overall = new Map();
    CHANS.forEach((c, ci) => {
      LV.sets[c.k] = [...A[ci].procs].sort((a, b) => b[1] - a[1]).slice(0, LV_TOP).map((x) => String(x[0]));
      for (const [id, v] of A[ci].procs) overall.set(String(id), (overall.get(String(id)) || 0) + v);
    });
    const wanted = [...new Set(CHANS.flatMap((c) => LV.sets[c.k]))].sort((a, b) => overall.get(b) - overall.get(a));
    LV.book.assign(wanted);
    ensureProcs(wanted).catch(() => {});
  }

  CHANS.forEach((c, ci) => {
    const a = A[ci];
    const ids = (LV.sets[c.k] || []).filter((id) => LV.book.has(id));
    const key = [...ids, "other", LV.win].join("|");
    let chart = LV.charts[c.k];
    if (!chart || chart._keys !== key) {
      destroyChart(chart);
      chart = LV.charts[c.k] = makeStack($(`lv-${c.k}-chart`),
        [...ids.map((id) => ({ key: id, label: procName(id), color: LV.book.color(id) })),
          { key: "other", label: t("Other"), color: cssVar("--c-other") }]);
      chart._keys = key;
    }
    const x = [], raw = [...ids, "o"].map(() => []);
    for (let ts = start; ts <= end; ts++) {
      const r = S.live.get(ts);
      x.push(ts);
      if (!r) { raw.forEach((col) => col.push(inRun(ts) ? 0 : null)); continue; }
      let rest = r.t[c.i];
      ids.forEach((id, j) => {
        const p = r.p?.find((q) => String(q[0]) === id);
        const v = p ? p[c.i + 1] : 0;
        rest -= v;
        raw[j].push(v);
      });
      raw[ids.length].push(Math.max(rest, 0));
    }
    setStack(chart, x, raw);

    $(`lv-${c.k}-now`).textContent = S.running ? fmtRate(a.rate) : "–";
    $(`lv-${c.k}-avg`).textContent = fmtRate(a.avg);
    $(`lv-${c.k}-peak`).textContent = fmtRate(a.peak);
    $(`lv-${c.k}-sum`).textContent = fmtBytes(a.sum);

    const rank = (m, r) => [...m].map(([k, s]) => [k, s, r.get(k) || 0])
      .sort((p, q) => q[2] - p[2] || q[1] - p[1]).slice(0, LV_LIST);
    const procs = rank(a.procs, a.pr);
    const maxP = Math.max(1, ...procs.map((p) => p[1]));
    $(`lv-${c.k}-procs`).innerHTML = procs.map(([id, sum, rate]) => `
      <li data-proc="${id}" tabindex="0" role="button" aria-label="${esc(t("Details for {0}", procName(id)))}">
        <span class="sw" style="background:${LV.book.color(id)}"></span>
        <span class="who"><span class="nm">${esc(procName(id))}</span><span class="bar" style="width:${(sum / maxP) * 100}%"></span></span>
        <span class="r">${fmtRate(rate)}</span><span class="s">${fmtBytes(sum)}</span></li>`).join("")
      || `<li class="none">${t("No traffic in time window")}</li>`;

    const eps = rank(a.eps, a.er);
    $(`lv-${c.k}-eps`).innerHTML = eps.map(([k, sum, rate]) => {
      const [proc, ip] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
      const host = S.hosts[ip];
      return `<li data-ip="${esc(ip)}" tabindex="0" role="button"><span class="who"><span class="nm" title="${esc(ip)}">${esc(host || ip)}</span>
        <span class="sub2">${host ? esc(ip) + " · " : ""}${esc(procName(proc))}</span></span>
        <span class="r">${fmtRate(rate)}</span><span class="s">${fmtBytes(sum)}</span></li>`;
    }).join("") || `<li class="none">${t("No endpoints in time window")}</li>`;
  });
}
