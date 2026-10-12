// trendBacktest.js — HISTORICAL TEST OF TREND-SWING ENTRY LOGIC (10/6, Harrison). Pure functions; no I/O.
//
// Question: is the trend-swing ENTRY sound? The live rule is a STATE (price > 50d > 100d, not over-extended,
// daily RSI < 72) checked from the first scan, with immediate re-entry after any exit. The literature it cites
// (Clenow, *Following the Trend*; Faber's MA timing) uses the MAs as a FILTER and enters on an EVENT, once a day.
//
// Method — underlying level, daily bars, SPY & QQQ:
//   * Every entry variant is run under the SAME exits, so differences come from entries alone.
//   * Two exit sets: "apex" (live rules translated to the underlying) and "chandelier" (Clenow-style 3-ATR trail).
//   * Costs: a round-trip cost per trade (and per roll), plus an optional daily time-decay charge that
//     approximates holding an option instead of the shares. Results reported raw and cost-adjusted.
//   * Every variant is reported (no cherry-picking), per ticker and per half of the period (in/out of sample).
//
// Option -> underlying translation (defaults): a ~0.65-delta call priced at ~3.3% of spot moves ~K = 0.033/0.65
// = 0.0508 % per 1 % option move. So: stop ceiling -55% option ~ -2.8% underlying; trail arm +10% ~ +0.51%;
// trail giveback 5 pts ~ 0.25%; stale threshold +5% ~ +0.25%.

const TO = require("./trendOptions");   // 10/12: option pricing (Black-Scholes on VIX/VXN) — see trendOptions.js

const DEF = {
  MA_FAST: 50, MA_SLOW: 100, RSI_MAX: 72, OVEREXT_ATR: 4.0, ATR_N: 14, RSI_N: 14,
  OPT_K: 0.033 / 0.65,                       // underlying % per 1 % option move
  STOP_ATR: 3.5, STOP_OPT_CEIL: 0.55, STOP_OPT_FLOOR: 0.20,
  TRAIL_ARM_OPT: 0.10, TRAIL_GIVE_OPT: 0.05, STALE_DAYS: 14, STALE_PEAK_OPT: 0.05,
  MAX_HOLD_DAYS: 39,                         // ~60 DTE entry, roll at 21 DTE -> one extra round-trip cost per 39 days held
  CHANDELIER_ATR: 3.0,
  BREAKOUT_N: 50, STRENGTH_SEP_ATR: 0.5, STRENGTH_DIST_ATR: 0.25, COOLDOWN_DAYS: 5,
  COST_RT_PCT: 0.10,                         // round-trip cost, % of underlying (~2% of option premium)
  THETA_PCT_PER_DAY: 0.015,                  // ~$0.12/day theta on a ~$25 call at SPY ~$780
};

// ---------- indicators (no lookahead: value at i uses bars 0..i) ----------
function indicators(bars, P) {
  const n = bars.length, c = bars.map(b => +b.c);
  const ma = (k) => { const out = new Array(n).fill(null); let s = 0;
    for (let i = 0; i < n; i++) { s += c[i]; if (i >= k) s -= c[i - k]; if (i >= k - 1) out[i] = s / k; } return out; };
  const ma50 = ma(P.MA_FAST), ma100 = ma(P.MA_SLOW);
  const atr = new Array(n).fill(null); let a = null;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(+bars[i].h - +bars[i].l, Math.abs(+bars[i].h - c[i - 1]), Math.abs(+bars[i].l - c[i - 1]));
    if (i < P.ATR_N) { a = (a || 0) + tr / P.ATR_N; if (i === P.ATR_N - 1) atr[i] = a; }
    else { a = (a * (P.ATR_N - 1) + tr) / P.ATR_N; atr[i] = a; }
  }
  const rsi = new Array(n).fill(null); let ag = 0, al = 0;
  for (let i = 1; i < n; i++) {
    const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= P.RSI_N) { ag += g / P.RSI_N; al += l / P.RSI_N; if (i === P.RSI_N) rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    else { ag = (ag * (P.RSI_N - 1) + g) / P.RSI_N; al = (al * (P.RSI_N - 1) + l) / P.RSI_N; rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  const hh = new Array(n).fill(null), ll = new Array(n).fill(null);
  for (let i = P.BREAKOUT_N - 1; i < n; i++) { let H = -Infinity, L = Infinity;
    for (let j = i - P.BREAKOUT_N + 1; j <= i; j++) { if (c[j] > H) H = c[j]; if (c[j] < L) L = c[j]; } hh[i] = H; ll[i] = L; }
  return { c, ma50, ma100, atr, rsi, hh, ll };
}

// trend STATE using a given price against indicators of day k (k = i-1 for an open check, i for a close check)
function stateAt(I, k, px, P) {
  const m50 = I.ma50[k], m100 = I.ma100[k], atr = I.atr[k], r = I.rsi[k];
  if (m50 == null || m100 == null || atr == null || r == null) return null;
  const ext = Math.abs(px - m50) > P.OVEREXT_ATR * atr;
  if (px > m50 && m50 > m100 && !ext && r < P.RSI_MAX) return "long";
  if (px < m50 && m50 < m100 && !ext && r > 100 - P.RSI_MAX) return "short";
  return null;
}

const VARIANTS = {
  current:  "LIVE RULE — state checked at the OPEN, immediate re-entry after any exit",
  close:    "state checked once at the CLOSE (enter at close)",
  breakout: "filter + 50-day closing HIGH/LOW breakout trigger (Clenow) — at close",
  fresh:    "filter + FRESH cross trigger (first day the state turns on) — at close",
  strength: "close check + minimum trend strength (50d-100d >= 0.5 ATR, price-50d >= 0.25 ATR)",
  cooldown: "close check + 5-day re-entry cooldown after any exit",
  opencool: "LIVE RULE (open check) + 5-day re-entry cooldown — what APEX runs from 10/12",
};

function entrySignal(v, I, i, bars, P, lastExitIdx) {
  if (v === "current" || v === "opencool") {                // at the open, vs prior-close indicators
    if (i < 1) return null;
    if (v === "opencool" && lastExitIdx != null && i - lastExitIdx <= P.COOLDOWN_DAYS) return null;
    const s = stateAt(I, i - 1, +bars[i].o, P); return s ? { side: s, px: +bars[i].o, at: "open" } : null;
  }
  const s = stateAt(I, i, I.c[i], P);
  if (!s) return null;
  const at = { side: s, px: I.c[i], at: "close" };
  if (v === "close") return at;
  if (v === "breakout") {
    if (I.hh[i] == null) return null;
    if (s === "long" && I.c[i] >= I.hh[i]) return at;
    if (s === "short" && I.c[i] <= I.ll[i]) return at;
    return null;
  }
  if (v === "fresh") { const prev = i > 0 ? stateAt(I, i - 1, I.c[i - 1], P) : null; return prev !== s ? at : null; }
  if (v === "strength") {
    const atr = I.atr[i], sep = Math.abs(I.ma50[i] - I.ma100[i]), dist = Math.abs(I.c[i] - I.ma50[i]);
    return (sep >= P.STRENGTH_SEP_ATR * atr && dist >= P.STRENGTH_DIST_ATR * atr) ? at : null;
  }
  if (v === "cooldown") return (lastExitIdx == null || i - lastExitIdx > P.COOLDOWN_DAYS) ? at : null;
  return null;
}

function simulate(bars, variant, exitSet, P0 = {}) {
  const P = { ...DEF, ...P0 }, I = indicators(bars, P), trades = [];
  const warm = Math.max(P.MA_SLOW, P.BREAKOUT_N, P.ATR_N, P.RSI_N) + 1;
  let pos = null, lastExitIdx = null;
  const dayMs = 86400000, ts = (i) => Date.parse(bars[i].t);
  const close = (i, px, why) => {
    const ret = (pos.side === "long" ? 1 : -1) * (px - pos.entry) / pos.entry * 100;
    const days = Math.max(0, Math.round((ts(i) - ts(pos.i)) / dayMs));
    const rolls = Math.floor(days / P.MAX_HOLD_DAYS);   // a roll continues the trade; it only costs another round trip
    const cost = P.COST_RT_PCT * (1 + rolls);
    trades.push({ side: pos.side, ei: pos.i, xi: i, at: pos.at, entryDate: bars[pos.i].t.slice(0, 10), exitDate: bars[i].t.slice(0, 10), entry: pos.entry, exit: px,
      ret, retAdj: ret - cost - P.THETA_PCT_PER_DAY * days, days, rolls, why, R: ret / pos.stopPct });
    pos = null; lastExitIdx = i;
  };
  const tryEnter = (i, when) => {
    const s = entrySignal(variant, I, i, bars, P, lastExitIdx);
    if (!s || s.at !== when) return;
    const k = when === "open" ? i - 1 : i, atr = I.atr[k];
    const ceil = P.STOP_OPT_CEIL * P.OPT_K * 100, floor = P.STOP_OPT_FLOOR * P.OPT_K * 100;
    const stopPct = Math.min(ceil, Math.max(floor, P.STOP_ATR * atr / s.px * 100));
    pos = { side: s.side, entry: s.px, i, at: s.at, stopPct, peak: 0, hiC: s.px, loC: s.px, atr };
  };
  for (let i = warm; i < bars.length; i++) {
    const o = +bars[i].o, h = +bars[i].h, l = +bars[i].l, c = +bars[i].c;
    const L = () => pos.side === "long";
    // --- at the open: stale exit (APEX checks it on the first scan), then a possible open entry ---
    if (pos && exitSet === "apex") {
      const days = (ts(i) - ts(pos.i)) / dayMs;
      if (days >= P.STALE_DAYS && pos.peak < P.STALE_PEAK_OPT * P.OPT_K * 100) close(i, o, "stale");
    }
    if (!pos) tryEnter(i, "open");
    // --- intraday: stop, then trail (vs the peak through the PRIOR bar), then update the peak ---
    if (pos) {
      const stopPx = L() ? pos.entry * (1 - pos.stopPct / 100) : pos.entry * (1 + pos.stopPct / 100);
      const sameBar = pos.i === i && pos.at !== "open";   // close entries don't see today's range (open entries do)
      if (!sameBar) {
        if (L() ? l <= stopPx : h >= stopPx) close(i, L() ? Math.min(o, stopPx) : Math.max(o, stopPx), "stop");
        else if (exitSet === "apex") {
          const arm = P.TRAIL_ARM_OPT * P.OPT_K * 100, give = P.TRAIL_GIVE_OPT * P.OPT_K * 100;
          if (pos.peak >= arm) {
            const lvl = pos.peak - give, trailPx = L() ? pos.entry * (1 + lvl / 100) : pos.entry * (1 - lvl / 100);
            if (L() ? l <= trailPx : h >= trailPx) close(i, L() ? Math.min(o, trailPx) : Math.max(o, trailPx), "trail");
          }
          if (pos) pos.peak = Math.max(pos.peak, (L() ? (h - pos.entry) : (pos.entry - l)) / pos.entry * 100);
        } else if (exitSet === "chandelier") {
          const atr = I.atr[i - 1] || pos.atr;
          const lvl = L() ? pos.hiC - P.CHANDELIER_ATR * atr : pos.loC + P.CHANDELIER_ATR * atr;
          if (L() ? c <= lvl : c >= lvl) close(i, c, "chandelier");
          else { pos.hiC = Math.max(pos.hiC, c); pos.loC = Math.min(pos.loC, c); }
        }
      }
    }
    // --- at the close: close-checked entries ---
    if (!pos) tryEnter(i, "close");
  }
  if (pos) close(bars.length - 1, I.c[bars.length - 1], "open-at-end");
  return trades;
}

function stats(trades, key = "retAdj") {
  const n = trades.length; if (!n) return { n: 0 };
  const r = trades.map(t => t[key]), w = r.filter(x => x > 0), lo = r.filter(x => x <= 0);
  let eq = 0, pk = 0, dd = 0; for (const x of r) { eq += x; pk = Math.max(pk, eq); dd = Math.min(dd, eq - pk); }
  const gw = w.reduce((a, b) => a + b, 0), gl = -lo.reduce((a, b) => a + b, 0);
  return { n, wr: Math.round(w.length / n * 100), avg: +(r.reduce((a, b) => a + b, 0) / n).toFixed(3),
    total: +eq.toFixed(2), pf: gl > 0 ? +(gw / gl).toFixed(2) : null, avgWin: w.length ? +(gw / w.length).toFixed(3) : 0,
    avgLoss: lo.length ? +(-gl / lo.length).toFixed(3) : 0, maxDD: +dd.toFixed(2), avgDays: +(trades.reduce((a, t) => a + t.days, 0) / n).toFixed(1) };
}

// Full study: { SPY: bars[], QQQ: bars[] } -> structured results + a plain-text report.
// 10/7: re-price a trade list under different cost assumptions (exits don't depend on costs, so the trades are identical)
function repriced(trades, costRT, thetaDay) {
  return trades.map(t => ({ ...t, retAdj: t.ret - costRT * (1 + (t.rolls || 0)) - thetaDay * t.days }));
}
const SCENARIOS = [
  { key: "theta05", label: "decay x0.5", theta: 0.5, cost: 1 },
  { key: "base",    label: "base",       theta: 1,   cost: 1 },
  { key: "theta2",  label: "decay x2",   theta: 2,   cost: 1 },
  { key: "cost2",   label: "cost x2",    theta: 1,   cost: 2 },
  { key: "raw",     label: "no option costs", theta: 0, cost: 0 },
];
// 10/12: option-model scenarios — the same trades, the same contracts, re-priced under different model assumptions
const OPT_SCENARIOS = [
  { key: "base",  label: "base",           m: {} },
  { key: "uncal", label: "uncalibrated",   m: { calib: null }, needsCalib: true },
  { key: "iv08",  label: "IV x0.8",        m: { ivScale: 0.8 } },
  { key: "iv12",  label: "IV x1.2",        m: { ivScale: 1.2 } },
  { key: "flat",  label: "no skew",        m: { skew: 0 } },
  { key: "cost2", label: "cost x2",        m: { costPct: 2 * TO.OPT.COST_RT_PCT } },
  { key: "mid",   label: "no costs (mid)", m: { costPct: 0 } },
];

// ticker x half cells, and how a row compares with the live rule cell by cell
const TKS = ["SPY", "QQQ"];
const cellsOf = (blk) => TKS.flatMap(t => ["H1", "H2"].map(h => ((blk.tickerHalves || {})[t] || {})[h] || { n: 0 }));
function consistency(blk, liveBlk) {
  const cs = cellsOf(blk), lv = liveBlk ? cellsOf(liveBlk) : null;
  const positive = cs.filter(c => c.n && c.avg > 0).length;
  const beats = lv ? cs.filter((c, k) => c.n && lv[k].n && c.avg > lv[k].avg).length : null;
  return { positive, beats };
}

// all the per-row blocks are built the same way from a { ticker: trades[] } map and a metric key
function block(byTk, key, mid, midKey) {
  const all = Object.values(byTk).flat();
  const b = { all: stats(all, key), byTicker: {}, tickerHalves: {} };
  if (midKey) b.allMid = stats(all, midKey);
  b.H1 = stats(all.filter(t => t.entryDate < mid), key); b.H2 = stats(all.filter(t => t.entryDate >= mid), key);
  for (const [tk, tr] of Object.entries(byTk)) {
    b.byTicker[tk] = stats(tr, key);
    b.tickerHalves[tk] = { H1: stats(tr.filter(t => t.entryDate < mid), key), H2: stats(tr.filter(t => t.entryDate >= mid), key) };
  }
  return b;
}

// price every row's trades as options under model M
function priceRows(rows, ctx, M) {
  return rows.map(row => {
    const o = {};
    for (const [tk, tr] of Object.entries(row._trades)) o[tk] = tr.map(t => ({ ...t, ...TO.priceTrade(ctx, tk, t, M) }));
    return o;
  });
}

function simulateAll(barsByTicker, P0) {
  const rows = [];
  for (const exitSet of ["apex", "chandelier"]) for (const v of Object.keys(VARIANTS)) {
    const row = { exitSet, variant: v, _trades: {} };
    for (const [tk, bars] of Object.entries(barsByTicker)) { row._trades[tk] = simulate(bars, v, exitSet, P0); row.mid = bars[Math.floor(bars.length / 2)].t.slice(0, 10); }
    rows.push(row);
  }
  return rows;
}

// 10/12: which option contracts (and dates) to fetch real bars for — the uncalibrated model's picks, 2024+
// opts: { raw: {SPY: bars}, series: {VIX, VIX3M, VXN, DTB3} }
function optionPlan(barsByTicker, P0 = {}, opts = {}) {
  const rows = simulateAll(barsByTicker, P0);
  const ctx = TO.buildContext(barsByTicker, opts.raw || null, opts.series || {});
  const priced = priceRows(rows, ctx, TO.BASE_MODEL()), flat = {};
  priced.forEach((o, i) => { for (const [tk, tr] of Object.entries(o)) flat[`${i}/${tk}`] = tr; });
  return TO.plan(flat);
}

// opts: { raw, series, optionBars: { SYMBOL: { "YYYY-MM-DD": bar } }, optionFetch: { ...notes } }
function runStudy(barsByTicker, P0 = {}, opts = {}) {
  const PP = { ...DEF, ...P0 };
  const rows = simulateAll(barsByTicker, P0);
  const results = [];
  // ---- underlying-level (the original study; kept for comparison) ----
  for (const row of rows) {
    const r = { exitSet: row.exitSet, variant: row.variant, mid: row.mid };
    Object.assign(r, block(row._trades, "retAdj", row.mid));
    r.allRaw = stats(Object.values(row._trades).flat(), "ret");
    r.exitMix = Object.values(row._trades).flat().reduce((m, t) => (m[t.why] = (m[t.why] || 0) + 1, m), {});
    r.sensitivity = {};
    for (const sc of SCENARIOS) {
      const c = PP.COST_RT_PCT * sc.cost, th = PP.THETA_PCT_PER_DAY * sc.theta, o = {};
      const all = Object.values(row._trades).flat();
      o.all = stats(repriced(all, c, th));
      for (const tk of Object.keys(row._trades)) o[tk] = stats(repriced(row._trades[tk], c, th));
      r.sensitivity[sc.key] = o;
    }
    results.push(r);
  }
  // ---- option-priced (10/12) ----
  const ctx = TO.buildContext(barsByTicker, opts.raw || null, opts.series || {});
  const base = TO.BASE_MODEL();
  const pricedBase = priceRows(rows, ctx, base);
  let validation = null, calib = null;
  if (opts.optionBars) {
    validation = TO.validate(rows.map((row, i) => ({ exitSet: row.exitSet, variant: row.variant, trades: Object.values(pricedBase[i]).flat() })), opts.optionBars, base.costPct);
    validation.fetch = opts.optionFetch || null;
    if (validation.points >= TO.OPT.CALIB_MIN_N) calib = validation.calib;
  }
  const mainM = { ...base, calib };
  const pricedMain = calib ? priceRows(rows, ctx, mainM) : pricedBase;
  const scen = OPT_SCENARIOS.filter(sc => !sc.needsCalib || calib);
  const pricedScen = {};
  for (const sc of scen) pricedScen[sc.key] = sc.key === "base" ? pricedMain : (sc.key === "uncal" ? pricedBase : priceRows(rows, ctx, { ...mainM, ...sc.m }));
  rows.forEach((row, i) => {
    const r = results[i];
    r.opt = block(pricedMain[i], "optPct", row.mid, "optMid");
    r.opt.sensitivity = {};
    for (const sc of scen) {
      const o = {}, by = pricedScen[sc.key][i];
      o.all = stats(Object.values(by).flat(), "optPct");
      for (const tk of Object.keys(by)) o[tk] = stats(by[tk], "optPct");
      r.opt.sensitivity[sc.key] = o;
    }
  });
  // consistency vs the live rule, cell by cell
  for (const ex of ["apex", "chandelier"]) {
    const live = results.find(r => r.exitSet === ex && r.variant === "current");
    for (const r of results.filter(x => x.exitSet === ex)) {
      r.consistency = consistency(r, r === live ? null : live);
      r.opt.consistency = consistency(r.opt, r === live ? null : live.opt);
    }
  }
  const option = { model: { ...TO.OPT, calib }, sources: ctx.sources, scenarios: scen.map(s => ({ key: s.key, label: s.label })), validation };
  return { params: PP, variants: VARIANTS, scenarios: SCENARIOS, option, results, report: textReport(barsByTicker, results, option) };
}

function textReport(barsByTicker, results, option) {
  const f = (x, d = 2) => (x == null ? "  -  " : (x >= 0 ? "+" : "") + Number(x).toFixed(d));
  const span = Object.entries(barsByTicker).map(([tk, b]) => `${tk} ${b[0].t.slice(0, 10)}..${b[b.length - 1].t.slice(0, 10)} (${b.length} bars)`).join(" | ");
  const tks = Object.keys(barsByTicker);
  const consTxt = (c) => (c.beats == null ? "LIVE          " : `beats live ${c.beats}/4`) + ` · positive ${c.positive}/4` + (c.beats === 4 ? "  <== BEATS LIVE EVERYWHERE" : "");
  const L = [];
  const exitTitle = (ex) => ex === "apex" ? "APEX live exits (stop 3.5 ATR capped, tight trail, 14-day stale)" : "Clenow-style chandelier (3 ATR trail from highest close)";
  const mainTable = (ex, get, unit) => {
    L.push(""); L.push(`=== ${unit} — EXITS: ${exitTitle(ex)} ===`);
    L.push("variant    trades  WR%  avg/trade  total     PF   avgWin  avgLoss   maxDD  days | H1 avg (n)      H2 avg (n)      | SPY avg  QQQ avg | before costs");
    for (const r of results.filter(x => x.exitSet === ex)) {
      const b = get(r), a = b.all, tk = b.byTicker, raw = b.allMid || r.allRaw;
      L.push(`${r.variant.padEnd(10)} ${String(a.n || 0).padStart(5)}  ${String(a.wr ?? "-").padStart(3)}  ${f(a.avg, 3).padStart(8)}  ${f(a.total, 1).padStart(8)} ${String(a.pf ?? "-").padStart(5)} ${f(a.avgWin, 2).padStart(7)} ${f(a.avgLoss, 2).padStart(8)} ${f(a.maxDD, 1).padStart(7)} ${String(a.avgDays ?? "-").padStart(5)} | ` +
             `${f(b.H1.avg, 3).padStart(8)} (${String(b.H1.n || 0).padStart(3)})  ${f(b.H2.avg, 3).padStart(8)} (${String(b.H2.n || 0).padStart(3)}) | ${f(tk.SPY && tk.SPY.avg, 3).padStart(7)} ${f(tk.QQQ && tk.QQQ.avg, 3).padStart(8)} | ${f(raw.avg, 3)}`);
    }
  };
  const halfTable = (ex, get, unit) => {
    L.push(""); L.push(`=== ${unit} — BY TICKER x HALF (avg/trade, n) — exits: ${ex === "apex" ? "APEX live" : "chandelier"} ===`);
    L.push("variant    " + tks.map(t => `${(t + " H1").padEnd(17)}${(t + " H2").padEnd(17)}`).join("") + "vs the live rule, cell by cell");
    for (const r of results.filter(x => x.exitSet === ex)) {
      const b = get(r);
      L.push(`${r.variant.padEnd(10)} ` + cellsOf(b).map(c => `${f(c.avg, 3).padStart(8)} (${String(c.n || 0).padStart(3)})   `).join("") + consTxt(b.consistency));
    }
  };
  const sensTable = (ex, get, scen, unit) => {
    L.push(""); L.push(`=== ${unit} — SENSITIVITY (avg/trade: all | SPY | QQQ) — exits: ${ex === "apex" ? "APEX live" : "chandelier"} ===`);
    L.push("variant    " + scen.map(s => s.label.padEnd(27)).join(""));
    for (const r of results.filter(x => x.exitSet === ex)) {
      const sv = get(r);
      L.push(`${r.variant.padEnd(10)} ` + scen.map(s => { const o = sv[s.key] || {};
        return `${f((o.all || {}).avg, 2)} | ${f((o.SPY || {}).avg, 1)} | ${f((o.QQQ || {}).avg, 1)}`.padEnd(27); }).join(""));
    }
  };

  L.push("APEX TREND-SWING ENTRY STUDY — daily bars");
  L.push(span);
  L.push("");
  L.push("PART 1 — OPTION-PRICED (10/12). Every trade re-priced as the contract APEX buys: 0.65-delta, ~60 DTE, listed $1 strike,");
  L.push("Black-Scholes marks with that day's implied vol, rolled at 21 DTE, cost charged on every leg.");
  L.push("Figures are % of the INITIAL PREMIUM per trade (what one contract's capital did). Trades are identical to Part 2.");
  L.push("'total' and 'maxDD' add up the per-trade % (as if one premium were risked on every trade) — compare them between rows, not as account %.");
  const M = option.model, src = option.sources || {};
  L.push(`Implied vol: SPY ${src.SPY || "-"} | QQQ ${src.QQQ || "-"} | skew ${M.SKEW} | rates: ${src.rate || "-"} | prices: ${src.SPY_prices || "-"}`);
  L.push(`Cost: ${M.COST_RT_PCT}% of premium per round trip. ` + (M.calib ? `IV calibrated to real option prices (real/model vol): ${TKS.map(t => M.calib[t] ? `${t} call x${M.calib[t].call} put x${M.calib[t].put}` : "").filter(Boolean).join(", ")}.` : "IV NOT calibrated (no real option prices available) — see the validation section."));
  for (const ex of ["apex", "chandelier"]) mainTable(ex, r => r.opt, "OPTION % OF PREMIUM");
  for (const ex of ["apex", "chandelier"]) halfTable(ex, r => r.opt, "OPTION % OF PREMIUM");
  for (const ex of ["apex", "chandelier"]) sensTable(ex, r => r.opt.sensitivity, option.scenarios, "OPTION % OF PREMIUM");

  // validation
  L.push(""); L.push("=== VALIDATION — model vs REAL option prices (Alpaca daily option bars, " + TO.OPT.VALIDATE_FROM + " on) ===");
  const v = option.validation;
  if (!v) L.push("Not run (no real option bars supplied).");
  else {
    if (v.fetch) L.push(`Fetched: ${v.fetch.symbolsWithBars ?? "?"} of ${v.fetch.symbolsRequested ?? "?"} contracts returned bars${v.fetch.note ? " — " + v.fetch.note : ""}.`);
    L.push(`Price points compared (open/close valuations): ${v.points}. Error = (model - real) / real.`);
    L.push("group          n     median |error|  median error  after calibration |error|   real/model vol");
    for (const [k, g] of Object.entries(v.prices)) L.push(`${k.padEnd(12)} ${String(g.n).padStart(5)}   ${(g.medAbsErr == null ? "-" : g.medAbsErr + "%").padStart(10)}   ${(g.medErr == null ? "-" : f(g.medErr, 1) + "%").padStart(11)}   ${(g.medAbsErrCal == null ? "-" : g.medAbsErrCal + "%").padStart(14)}          ${g.ivRatio ?? "-"}`);
    L.push("");
    L.push("Trades re-scored on REAL prices (every leg priced from real bars; the model column is UNcalibrated, same contracts):");
    L.push("exits       variant      n   model avg   real avg   model WR  real WR  same sign");
    for (const t of v.trades) L.push(`${t.exitSet.padEnd(11)} ${t.variant.padEnd(10)} ${String(t.n).padStart(4)}   ${t.n ? f(t.modelAvg, 2).padStart(8) + "%" : "      -  "}  ${t.n ? f(t.realAvg, 2).padStart(8) + "%" : "      -  "}   ${t.n ? String(t.modelWR).padStart(5) + "%" : "    -"}  ${t.n ? String(t.realWR).padStart(5) + "%" : "    -"}   ${t.n ? String(t.signAgreePct).padStart(5) + "%" : "    -"}`);
  }

  L.push(""); L.push("PART 2 — UNDERLYING-LEVEL (the original study; option P&L approximated by a cost + flat decay charge). Kept for comparison.");
  L.push("Figures are % of the UNDERLYING per trade.");
  for (const ex of ["apex", "chandelier"]) {
    mainTable(ex, r => r, "UNDERLYING %");
    for (const r of results.filter(x => x.exitSet === ex)) L.push(`   ${r.variant.padEnd(9)} exits: ${JSON.stringify(r.exitMix)}`);
  }
  for (const ex of ["apex", "chandelier"]) halfTable(ex, r => r, "UNDERLYING %");
  for (const ex of ["apex", "chandelier"]) sensTable(ex, r => r.sensitivity, SCENARIOS, "UNDERLYING %");

  L.push(""); L.push("Variants:"); for (const [k, v2] of Object.entries(VARIANTS)) L.push(`  ${k.padEnd(9)} ${v2}`);
  L.push(""); L.push("Read it this way: a variant only 'beats' the live rule if it is better in all four ticker x half cells (beats live 4/4).");
  L.push("Limits: exits are decided on the underlying (APEX's option-% exits translated at a fixed ratio); breadth filter not modeled");
  L.push("(no history); one position per ticker; SPY and QQQ run independently (the live correlation rule is not modeled); option prices");
  L.push("are a model — the validation section says how far off it was where real prices exist; intraday exits use the day's closing vol.");
  return L.join("\n");
}

module.exports = { DEF, VARIANTS, SCENARIOS, OPT_SCENARIOS, repriced, indicators, stateAt, entrySignal, simulate, stats, runStudy, optionPlan, consistency };
