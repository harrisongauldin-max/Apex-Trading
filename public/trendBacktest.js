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
};

function entrySignal(v, I, i, bars, P, lastExitIdx) {
  if (v === "current") {                                     // at the open, vs prior-close indicators
    if (i < 1) return null;
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
    trades.push({ side: pos.side, entryDate: bars[pos.i].t.slice(0, 10), exitDate: bars[i].t.slice(0, 10), entry: pos.entry, exit: px,
      ret, retAdj: ret - cost - P.THETA_PCT_PER_DAY * days, days, why, R: ret / pos.stopPct });
    pos = null; lastExitIdx = i;
  };
  const tryEnter = (i, when) => {
    const s = entrySignal(variant, I, i, bars, P, lastExitIdx);
    if (!s || s.at !== when) return;
    const k = when === "open" ? i - 1 : i, atr = I.atr[k];
    const ceil = P.STOP_OPT_CEIL * P.OPT_K * 100, floor = P.STOP_OPT_FLOOR * P.OPT_K * 100;
    const stopPct = Math.min(ceil, Math.max(floor, P.STOP_ATR * atr / s.px * 100));
    pos = { side: s.side, entry: s.px, i, stopPct, peak: 0, hiC: s.px, loC: s.px, atr };
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
      const sameBar = pos.i === i && variant !== "current" ? true : false;   // close entries don't see today's range
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
function runStudy(barsByTicker, P0 = {}) {
  const results = [];
  for (const exitSet of ["apex", "chandelier"]) for (const v of Object.keys(VARIANTS)) {
    const row = { exitSet, variant: v, byTicker: {}, halves: {} };
    let all = [];
    for (const [tk, bars] of Object.entries(barsByTicker)) {
      const tr = simulate(bars, v, exitSet, P0); all = all.concat(tr);
      row.byTicker[tk] = stats(tr);
      const mid = bars[Math.floor(bars.length / 2)].t.slice(0, 10);
      for (const [hk, sel] of [["H1", tr.filter(t => t.entryDate < mid)], ["H2", tr.filter(t => t.entryDate >= mid)]]) {
        row.halves[hk] = row.halves[hk] || []; row.halves[hk].push(...sel);
      }
      row.mid = mid;
    }
    row.all = stats(all); row.allRaw = stats(all, "ret");
    row.H1 = stats(row.halves.H1 || []); row.H2 = stats(row.halves.H2 || []); delete row.halves;
    row.exitMix = all.reduce((m, t) => (m[t.why] = (m[t.why] || 0) + 1, m), {});
    results.push(row);
  }
  return { params: { ...DEF, ...P0 }, variants: VARIANTS, results, report: textReport(barsByTicker, results) };
}

function textReport(barsByTicker, results) {
  const f = (x, d = 2) => (x == null ? "  -  " : (x >= 0 ? "+" : "") + Number(x).toFixed(d));
  const span = Object.entries(barsByTicker).map(([tk, b]) => `${tk} ${b[0].t.slice(0, 10)}..${b[b.length - 1].t.slice(0, 10)} (${b.length} bars)`).join(" | ");
  const L = [];
  L.push("APEX TREND-SWING ENTRY STUDY — underlying-level, daily bars");
  L.push(span);
  L.push("All figures are % of the UNDERLYING per trade, after costs (round trip + daily time-decay charge) unless marked raw.");
  L.push("Same exits for every entry variant. 'H1'/'H2' = first/second half of the period (out-of-sample check).");
  for (const ex of ["apex", "chandelier"]) {
    L.push(""); L.push(ex === "apex" ? "=== EXITS: APEX live rules (stop 3.5 ATR capped, tight trail, 14-day stale; rolls charged) ==="
                                      : "=== EXITS: Clenow-style chandelier (3 ATR trail from highest close), rolls charged ===");
    L.push("variant    trades  WR%  avg/trade  total   PF   avgWin  avgLoss  maxDD  days | H1 avg (n)     H2 avg (n)     | SPY avg  QQQ avg | raw avg");
    for (const r of results.filter(x => x.exitSet === ex)) {
      const a = r.all, tk = r.byTicker;
      L.push(`${r.variant.padEnd(10)} ${String(a.n || 0).padStart(5)}  ${String(a.wr ?? "-").padStart(3)}  ${f(a.avg, 3).padStart(8)}  ${f(a.total, 1).padStart(7)} ${String(a.pf ?? "-").padStart(5)} ${f(a.avgWin, 2).padStart(7)} ${f(a.avgLoss, 2).padStart(8)} ${f(a.maxDD, 1).padStart(6)} ${String(a.avgDays ?? "-").padStart(5)} | ` +
             `${f(r.H1.avg, 3).padStart(7)} (${String(r.H1.n || 0).padStart(3)})  ${f(r.H2.avg, 3).padStart(7)} (${String(r.H2.n || 0).padStart(3)}) | ${f(tk.SPY && tk.SPY.avg, 3).padStart(7)} ${f(tk.QQQ && tk.QQQ.avg, 3).padStart(8)} | ${f(r.allRaw.avg, 3)}`);
    }
    for (const r of results.filter(x => x.exitSet === ex)) L.push(`   ${r.variant.padEnd(9)} exits: ${JSON.stringify(r.exitMix)}`);
  }
  L.push(""); L.push("Variants:"); for (const [k, v] of Object.entries(VARIANTS)) L.push(`  ${k.padEnd(9)} ${v}`);
  L.push(""); L.push("Read it this way: a variant only 'beats' the live rule if it is better in BOTH halves AND on BOTH tickers.");
  L.push("Limits: underlying-level (option P&L approximated by a cost + decay charge); breadth filter not modeled (no history);");
  L.push("one position per ticker; SPY and QQQ run independently (the live correlation rule is not modeled).");
  return L.join("\n");
}

module.exports = { DEF, VARIANTS, indicators, stateAt, entrySignal, simulate, stats, runStudy };
