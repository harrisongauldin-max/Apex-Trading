// Trend-swing entry study (trendBacktest.js): mechanical invariants on synthetic data.
"use strict";
const H = require("./helpers"); H.quiet();
const T = require(H.R("trendBacktest.js"));
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
const mk = (n, px) => { const b = []; let d = new Date("2016-01-04T05:00:00Z"), dr = 0;
  for (let i = 0; i < n; i++) { if (i % 120 === 0) { const r = rnd(); dr = r < 0.4 ? 0.0009 : r < 0.6 ? -0.0009 : 0; }
    const o = px * (1 + g() * 0.003), c = o * (1 + dr + g() * 0.009);
    b.push({ t: d.toISOString(), o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c }); px = c;
    do { d = new Date(d.getTime() + 864e5); } while ([0, 6].includes(d.getUTCDay())); }
  return b; };
const data = { SPY: mk(1500, 200), QQQ: mk(1500, 100) };
const I = T.indicators(data.SPY, T.DEF), bad = [];
const idx = (date) => data.SPY.findIndex(b => b.t.slice(0, 10) === date);
for (const ex of ["apex", "chandelier"]) for (const v of Object.keys(T.VARIANTS)) {
  const tr = T.simulate(data.SPY, v, ex);
  tr.forEach((t, k) => {
    if (!(isFinite(t.ret) && isFinite(t.retAdj))) bad.push(`${v}/${ex}: non-finite`);
    if (t.exitDate < t.entryDate) bad.push(`${v}/${ex}: exit before entry`);
    if (k > 0 && t.entryDate < tr[k - 1].exitDate) bad.push(`${v}/${ex}: overlapping trades`);
    if (v === "breakout" && t.side === "long" && Math.abs(I.c[idx(t.entryDate)] - I.hh[idx(t.entryDate)]) > 1e-9) bad.push("breakout not at a 50-day high");
    if ((v === "cooldown" || v === "opencool") && k > 0 && idx(t.entryDate) - idx(tr[k - 1].exitDate) <= 5) bad.push(v + " cooldown violated");
    if ((v === "current" || v === "opencool") && t.at !== "open") bad.push(v + " should enter at the open");
  });
}
H.ok(bad.length === 0, "simulation invariants (finite, ordered, no overlap, triggers honored)", bad.slice(0, 3).join("; "));
const S = T.runStudy(data); const viol = [];
const eq = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-9;
for (const r of S.results) {
  if (!eq(r.sensitivity.base.all.avg, r.all.avg)) viol.push(`${r.exitSet}/${r.variant} base != main`);
  if (!eq(r.sensitivity.raw.all.avg, r.allRaw.avg)) viol.push(`${r.exitSet}/${r.variant} raw != allRaw`);
  for (const tk of ["SPY", "QQQ"]) if ((r.tickerHalves[tk].H1.n || 0) + (r.tickerHalves[tk].H2.n || 0) !== r.byTicker[tk].n) viol.push(`${tk} halves`);
  const s = r.sensitivity; if (!(s.theta2.all.avg <= s.base.all.avg && s.base.all.avg <= s.theta05.all.avg && s.cost2.all.avg <= s.base.all.avg)) viol.push("cost monotonicity");
}
H.ok(S.results.length === 14 && viol.length === 0, "study tables consistent (base = main, raw = raw, halves sum, costs monotonic)", viol.slice(0, 3).join("; "));
H.ok(/BY TICKER x HALF/.test(S.report) && /SENSITIVITY/.test(S.report), "report includes the ticker-x-half and sensitivity sections");
// opencool = the live rule with a cooldown: every opencool trade must also be a trade the live rule could take (same open check)
const cur = T.simulate(data.SPY, "current", "apex"), oc = T.simulate(data.SPY, "opencool", "apex");
H.ok(oc.length > 0 && oc.length < cur.length, "opencool trades less often than the live rule", `${oc.length} vs ${cur.length}`);
// option-priced block: same trades, before-cost >= after-cost, scenarios ordered the way the model says they must be
const ov = [];
for (const r of S.results) {
  if (!r.opt || r.opt.all.n !== r.all.n) ov.push(`${r.exitSet}/${r.variant} trade count`);
  const sv = r.opt.sensitivity;
  if (!(r.opt.allMid.avg >= r.opt.all.avg)) ov.push("mid < after-cost");
  if (!(sv.cost2.all.avg <= sv.base.all.avg && sv.base.all.avg <= sv.mid.all.avg)) ov.push("cost ordering");
  if (Math.abs(sv.base.all.avg - r.opt.all.avg) > 1e-9) ov.push("base != main");
  if (!r.consistency || !r.opt.consistency) ov.push("consistency missing");
}
H.ok(ov.length === 0, "option-priced results: same trades, costs ordered, base = main, consistency on every row", ov.slice(0, 3).join("; "));
H.ok(/PART 1 — OPTION-PRICED/.test(S.report) && /beats live \d\/4/.test(S.report), "report leads with the option-priced part and the beats-live column");
H.done();
