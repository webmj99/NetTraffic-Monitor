"use strict";
/* Endpoints: historical view of all remote endpoints (minute resolution), with ports, processes and details. */
const EP = {
  preset: "86400", from: 0, to: 0, chan: "all", net: "all", hosts: {}, stack: null,
  sort: { key: "total", dir: -1 }, filter: "", book: new ColorBook(8), chart: null, loading: false,
};

const SERVICES = {
  20: "FTP-Data", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 67: "DHCP", 68: "DHCP", 80: "HTTP",
  110: "POP3", 123: "NTP", 135: "RPC", 137: "NetBIOS", 138: "NetBIOS", 139: "NetBIOS", 143: "IMAP", 161: "SNMP",
  389: "LDAP", 443: "HTTPS", 445: "SMB", 465: "SMTPS", 500: "IKE", 514: "Syslog", 547: "DHCPv6", 587: "SMTP",
  853: "DNS-over-TLS", 993: "IMAPS", 995: "POP3S", 1194: "OpenVPN", 1900: "SSDP", 3389: "RDP", 3478: "STUN",
  4500: "IPsec", 5060: "SIP", 5353: "mDNS", 5355: "LLMNR", 8080: "HTTP-Alt", 8443: "HTTPS-Alt", 51820: "WireGuard",
};
// ports = [udp, local, port, ...]
const svc = (p) => (p[0] && p[2] === 443 ? "QUIC" : SERVICES[p[2]] || "");
const portLabel = (p) => `${svc(p)}${svc(p) ? " · " : ""}${p[0] ? "UDP" : "TCP"} ${p[2]}${p[1] ? " " + t("(local)") : ""}`;
const portShort = (p) => `${svc(p) || (p[0] ? "UDP " : "TCP ") + p[2]}${p[1] ? "↩" : ""}`;
const hostLabel = (h) => h.name || h.ip;
const netBadge = (lan) => (lan ? `<span class="badge lan">LAN</span>` : `<span class="badge ext">Internet</span>`);

function epBounds() {
  if (EP.preset === "custom") return { from: EP.from, to: EP.to };
  const to = now() + 1;
  const from = EP.preset === "all" ? (S.hostsFirstTs || S.firstTs || to - 86400) : to - +EP.preset;
  return { from, to };
}

async function epLoad() {
  if (EP.loading) return;
  EP.loading = true;
  try {
    const { from, to } = epBounds();
    EP.from = from; EP.to = to;
    $("ep-from").value = toLocalInput(from);
    $("ep-to").value = toLocalInput(to);
    const [hosts, stack] = await Promise.all([
      api(`/api/hosts?from=${from}&to=${to}`),
      api(`/api/hoststack?from=${from}&to=${to}&chan=${EP.chan}&n=8`),
    ]);
    EP.hosts = hosts;
    EP.stack = stack;
    S.runs = mergeRuns(stack.runs);
    const procIds = new Set();
    for (const h of Object.values(hosts)) for (const [p] of h.procs) procIds.add(p);
    await ensureProcs([...procIds]);
    epRender();
  } finally {
    EP.loading = false;
  }
}

function epRender() {
  const st = EP.stack;
  if (!st) return;
  const ids = st.hosts.map(String);
  EP.book.assign(ids);
  const key = [...ids, EP.chan].join("|");
  if (!EP.chart || EP.chart._keys !== key) {
    destroyChart(EP.chart);
    EP.chart = makeStack($("ep-chart"), [
      ...ids.map((id) => ({ key: id, label: hostLabel(st.meta[id]), color: EP.book.color(id) })),
      { key: "other", label: t("Other"), color: cssVar("--c-other") }]);
    EP.chart._keys = key;
  }
  const byTs = new Map(st.rows.map((r) => [r[0], r]));
  const x = [], raw = [...ids, "o"].map(() => []);
  for (let b = st.from - (st.from % st.step); b < st.to; b += st.step) {
    const r = byTs.get(b);
    x.push(b);
    raw.forEach((col, j) => col.push(r ? r[j + 1] / st.step : inRun(b, b + st.step) ? 0 : null));
  }
  setStack(EP.chart, x, raw);
  $("ep-step").textContent = t("Ø rate per {0}", fmtStep(st.step));

  const all = Object.values(EP.hosts);
  const sum = (h) => h.v[0] + h.v[1] + h.v[2] + h.v[3];
  const ext = all.filter((h) => !h.lan), lan = all.filter((h) => h.lan);
  const fresh = all.filter((h) => h.first_seen >= EP.from);
  const top = all.reduce((a, h) => (!a || sum(h) > sum(a) ? h : a), null);
  $("ep-k-count").textContent = nf0.format(all.length);
  $("ep-k-count-sub").innerHTML = `${t("Traffic")} <span>${fmtBytes(all.reduce((s, h) => s + sum(h), 0))}</span>`;
  $("ep-k-ext").textContent = nf0.format(ext.length);
  $("ep-k-ext-sub").innerHTML = `↓ <span>${fmtBytes(ext.reduce((s, h) => s + h.v[3], 0))}</span> · ↑ <span>${fmtBytes(ext.reduce((s, h) => s + h.v[2], 0))}</span>`;
  $("ep-k-lan").textContent = nf0.format(lan.length);
  $("ep-k-lan-sub").innerHTML = `↓ <span>${fmtBytes(lan.reduce((s, h) => s + h.v[1], 0))}</span> · ↑ <span>${fmtBytes(lan.reduce((s, h) => s + h.v[0], 0))}</span>`;
  $("ep-k-new").textContent = nf0.format(fresh.length);
  $("ep-k-top").textContent = top ? hostLabel(top) : "–";
  $("ep-k-top").title = top ? `${top.name} ${top.ip}` : "";
  $("ep-k-top-sub").innerHTML = top ? `<span>${fmtBytes(sum(top))}</span> · ${esc(procName(top.procs[0]?.[0]))}` : "–";
  epRenderTable();
}

function epRows() {
  const all = Object.values(EP.hosts);
  const grand = Math.max(1, all.reduce((s, h) => s + h.v[0] + h.v[1] + h.v[2] + h.v[3], 0));
  const f = EP.filter.toLowerCase();
  const rows = [];
  for (const h of all) {
    if (EP.net === "lan" && !h.lan) continue;
    if (EP.net === "ext" && h.lan) continue;
    const total = h.v[0] + h.v[1] + h.v[2] + h.v[3];
    const r = {
      id: String(h.id), ip: h.ip, host: h.name, name: hostLabel(h), lan: h.lan ? 1 : 0,
      down: h.v[1] + h.v[3], up: h.v[0] + h.v[2], total, share: total / grand, minutes: h.minutes,
      first: h.first_seen, last: Math.min(h.last_seen || 0, EP.to), isNew: h.first_seen >= EP.from,
      ports: h.ports, procs: h.procs,
      portsTxt: h.ports.map(portLabel).join(", "),
      procsTxt: h.procs.map(([p]) => procName(p)).join(", "),
    };
    if (f && ![r.name, r.ip, r.portsTxt, r.procsTxt].some((s) => s.toLowerCase().includes(f))) continue;
    rows.push(r);
  }
  const key = EP.sort.key;
  const textual = ["name", "portsTxt", "procsTxt"].includes(key);
  rows.sort((a, b) => (textual ? a[key].localeCompare(b[key]) : a[key] - b[key]) * EP.sort.dir);
  return rows;
}

function epRenderTable() {
  const rows = epRows();
  const more = (n) => (n > 0 ? ` <span class="more">+${n}</span>` : "");
  $("ep-rows").innerHTML = rows.slice(0, 500).map((r) => `<tr tabindex="0" data-ip="${esc(r.ip)}">
    <td><span class="pname">${EP.book.has(r.id) ? `<span class="sw" style="background:${EP.book.color(r.id)}"></span>` : ""}${esc(r.name)}${r.isNew ? ` <span class="badge new">${t("new")}</span>` : ""}</span>
      <span class="ppath">${r.host ? esc(r.ip) : t("no hostname")}</span></td>
    <td>${netBadge(r.lan)}</td>
    <td class="tags" title="${esc(r.portsTxt)}">${r.ports.slice(0, 3).map((p) => `<span class="tag">${esc(portShort(p))}</span>`).join("")}${more(r.ports.length - 3)}</td>
    <td class="tags" title="${esc(r.procsTxt)}">${r.procs.slice(0, 2).map(([p]) => `<span class="tag">${esc(procName(p))}</span>`).join("")}${more(r.procs.length - 2)}</td>
    <td class="num${r.down ? "" : " zero"}">${fmtBytes(r.down)}</td>
    <td class="num${r.up ? "" : " zero"}">${fmtBytes(r.up)}</td>
    <td class="num">${fmtBytes(r.total)}</td>
    <td class="num">${nf1.format(r.share * 100)} %<span class="bar" style="width:${r.share * 100}%"></span></td>
    <td class="num">${fmtDur(r.minutes)}</td>
    <td class="num">${dtfShort.format(new Date(r.first * 1000))}</td>
    <td class="num">${r.last ? dtfShort.format(new Date(r.last * 1000)) : "–"}</td></tr>`).join("");
  $("ep-empty").hidden = rows.length > 0;
  $("ep-count").textContent = `(${nf0.format(rows.length)})`;
}

function epCsv() {
  const head = ["Hostname", "IP", "Network", "Services/ports", "Processes", "Download (bytes)", "Upload (bytes)", "Total (bytes)",
    "Share (%)", "Active (minutes)", "First seen", "Last seen", "New in period"].map((s) => t(s));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const d = (s) => (s ? dtfShort.format(new Date(s * 1000)) : "");
  const lines = [head.map(q).join(CSV_SEP)].concat(epRows().map((r) => [
    r.host, r.ip, r.lan ? "LAN" : "Internet", r.portsTxt, r.procsTxt, r.down, r.up, r.total,
    nf2.format(r.share * 100), r.minutes, d(r.first), d(r.last), r.isNew ? t("yes") : t("no"),
  ].map(q).join(CSV_SEP)));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const stamp = (s) => toLocalInput(s).replace(/[-:]/g, "").replace("T", "-");
  a.href = URL.createObjectURL(blob);
  a.download = `nettraffic-monitor-${t("endpoints")}-${stamp(EP.from)}_${stamp(EP.to)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- endpoint drawer ---------- */
let hostChart = null, hostFocus = null;
async function openHost(ip, from, to) {
  if (!$("drawer").hidden) closeDetail();
  hostFocus = document.activeElement;
  const d = await api(`/api/host?ip=${encodeURIComponent(ip)}&from=${from}&to=${to}`);
  Object.assign(S.procs, d.procs_meta);
  const m = d.meta;
  S.hostDetail = ip;
  $("h-name").textContent = m.name || m.ip;
  $("h-sub").innerHTML = `${netBadge(m.lan)} ${m.name ? esc(m.ip) : ""}`;
  $("h-ip").textContent = m.ip;
  $("h-host").textContent = m.name || t("– (no reverse DNS entry)");
  $("h-net").textContent = m.lan ? t("LAN (local/private network)") : "Internet";
  $("h-first").textContent = fmtTs(m.first_seen);
  $("h-last").textContent = fmtTs(m.last_seen);
  $("h-total").textContent = t("{0} in {1} of active time", fmtBytes(d.all_time.bytes), fmtDur(d.all_time.minutes));
  const inRange = d.procs.reduce((s, p) => s + p[1] + p[2] + p[3] + p[4], 0);
  $("h-range").textContent = `${fmtBytes(inRange)} · ${dtfShort.format(new Date(from * 1000))} – ${dtfShort.format(new Date(to * 1000))}`;
  $("h-procs").innerHTML = d.procs.map(([p, iu, id_, eu, ed, mins]) => `<tr class="link" data-proc="${p}" tabindex="0">
    <td>${esc(procName(p))}</td><td class="num">${fmtBytes(id_ + ed)}</td><td class="num">${fmtBytes(iu + eu)}</td><td class="num">${fmtDur(mins)}</td></tr>`).join("")
    || `<tr><td colspan="4">${t("No data in period")}</td></tr>`;
  $("h-ports").innerHTML = d.ports.map((p) => `<tr><td>${esc(svc(p) || "–")}</td>
    <td>${p[0] ? "UDP" : "TCP"} ${p[2]}${p[1] ? " " + t("(local)") : ""}</td><td class="num">${fmtBytes(p[3])}</td>
    <td>${dtfShort.format(new Date(p[4] * 1000))} – ${dtfShort.format(new Date(p[5] * 1000))}</td></tr>`).join("")
    || `<tr><td colspan="4">–</td></tr>`;
  $("scrim").hidden = false;
  $("hdrawer").hidden = false;
  $("h-close").focus();
  destroyChart(hostChart);
  hostChart = makeChart($("chartHost"), [lineSeries("Download", cssVar("--dl")), lineSeries("Upload", cssVar("--ul"))]);
  const byTs = new Map(d.rows.map((r) => [r[0], r]));
  const x = [], dn = [], up = [];
  for (let b = from - (from % d.step); b < to; b += d.step) {
    const r = byTs.get(b);
    x.push(b);
    const gap = inRun(b, b + d.step) ? 0 : null;
    dn.push(r ? (r[2] + r[4]) / d.step : gap);
    up.push(r ? (r[1] + r[3]) / d.step : gap);
  }
  hostChart.setData([x, dn, up]);
  $("h-procs").onclick = $("h-procs").onkeydown = (e) => {
    const tr = e.target.closest("tr[data-proc]");
    if (!tr || (e.type === "keydown" && e.key !== "Enter")) return;
    closeHost(false);
    openDetail(tr.dataset.proc, from, to).catch(showErr);
  };
}

function closeHost(restore = true) {
  $("hdrawer").hidden = true;
  $("scrim").hidden = true;
  destroyChart(hostChart);
  hostChart = null;
  S.hostDetail = null;
  if (restore) hostFocus?.focus();
}

function epInit() {
  wireSeg($("ep-presets"), (b) => { EP.preset = b.dataset.preset; epLoad().catch(showErr); });
  wireSeg($("ep-chan"), (b) => { EP.chan = b.dataset.chan; epLoad().catch(showErr); });
  wireSeg($("ep-net"), (b) => { EP.net = b.dataset.net; epRenderTable(); });
  $("ep-custom").addEventListener("submit", (e) => {
    e.preventDefault();
    const from = fromLocalInput($("ep-from").value), to = fromLocalInput($("ep-to").value);
    if (!(to > from)) return showErr(new Error(t("\"To\" must be after \"From\".")));
    EP.preset = "custom"; EP.from = from; EP.to = to;
    for (const x of $("ep-presets").children) x.setAttribute("aria-checked", "false");
    S.error = null;
    epLoad().catch(showErr);
  });
  wireSort($("ep-table"), EP, epRenderTable);
  $("ep-filter").addEventListener("input", (e) => { EP.filter = e.target.value; epRenderTable(); });
  $("ep-csv").addEventListener("click", epCsv);
  const open = (tr) => openHost(tr.dataset.ip, EP.from, EP.to).catch(showErr);
  $("ep-rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-ip]"); if (tr) open(tr); });
  $("ep-rows").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-ip]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(tr); }
  });
  $("h-close").addEventListener("click", () => closeHost());
  $("h-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("h-ip").textContent);
    const lbl = $("h-copy").querySelector("span");
    lbl.textContent = t("Copied");
    setTimeout(() => (lbl.textContent = t("Copy")), 1500);
  });
  setInterval(() => { if (S.view === "hosts" && EP.preset !== "custom") epLoad().catch(() => {}); }, 30000);
}
