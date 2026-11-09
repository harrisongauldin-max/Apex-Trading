// straddleStrategy.js — VOL-CONDITIONAL LONG STRADDLE for the NEGATIVE-gamma regime.
//
// Why this exists (9/14, from the full 431-trade audit + telemetry study):
//   Every DIRECTIONAL entry we tested loses in negative gamma on this tape — fade (-$842),
//   momentum (-$929), gamma-flip breakout (1% continuation). Negative gamma at VIX~17 produces
//   WHIPSAW, not sustained trends, so you cannot predict DIRECTION. But you CAN predict
//   PERSISTENCE: corr(trailing-30min range, forward-60min move) = +0.87 across 2167 windows.
//   When the trailing 30-min range is already > ~0.50%, the next 60 min delivers a straddle-
//   payable move (>0.55%) ~89% of the time; when it's dead (<0.15%), ~0%.
//
// The play: a LONG straddle (ATM call + ATM put) is NON-directional — it profits from the move
//   itself, whichever way. That is the one negative-gamma edge the literature endorses (long vol
//   while dealers are short gamma) AND the only one this tape confirms. We gate it hard on
//   realized vol so we only arm it when the move that pays for two legs is actually coming.
//
// This module DECIDES ONLY. It returns a straddle decision; the scanner places the two legs and
// tags them so the exit engine manages them as a linked pair.
//
// Governing principle: neg-gamma + vol-trigger is theory-backed (dealer gamma + vol clustering)
//   AND data-validated (the +0.87 / 89% test). It is NON-directional by construction.

const STRADDLE = {
  ENABLED:             false,   // 9/27 (Harrison): AXED. Week 9/21-25 side-by-side: WITH straddle expectancy +$12.27/trade, WITHOUT +$15.60 — it DILUTED the intraday engine (was -$5.00/trade itself, 50% WR, regimeflip churn). Also structurally wrong side of the volatility risk premium (long vol on liquid indices = buying overpriced options). Kill switch; existing positions close normally, other sleeves untouched.
  REQUIRE_NEG_GAMMA:   true,    // core gate: only in negative gamma (the amplifying regime)
  VOL_MIN_PCT:         0.50,    // trailing 30-min range must exceed this % (the +0.87 trigger; <0.50% = dead, 0% payable)
  RANGE_WINDOW_MIN:    30,      // trailing window for the range calc (minutes)
  MIN_BARS:            10,      // need at least this many 1-min bars in the window to trust the range
  COOLDOWN_MIN:        45,      // don't re-arm a straddle on the same ticker within this window
  TARGET_DELTA:        0.50,    // ATM legs
};

// Compute the trailing-N-minute realized range % from 1-min intraday bars.
// bars: [{ t|timestamp, o,h,l,c }, ...] ascending. nowMs: current time. windowMin: lookback.
// Returns rangePct (high-low over the window, as % of the window's first open) or null if insufficient.
function trailingRangePct(bars, nowMs, windowMin, minBars) {
  if (!Array.isArray(bars) || bars.length < minBars) return null;
  const cutoff = nowMs - windowMin * 60 * 1000;
  const win = bars.filter(b => {
    const t = typeof b.t === "number" ? b.t : Date.parse(b.t || b.timestamp || 0);
    return Number.isFinite(t) && t >= cutoff;
  });
  if (win.length < minBars) return null;
  let hi = -Infinity, lo = Infinity, base = null;
  for (const b of win) {
    const h = +b.h, l = +b.l;
    if (Number.isFinite(h)) hi = Math.max(hi, h);
    if (Number.isFinite(l)) lo = Math.min(lo, l);
    if (base == null && Number.isFinite(+b.o)) base = +b.o;
  }
  if (base == null || !(base > 0) || hi <= 0 || lo === Infinity) return null;
  return ((hi - lo) / base) * 100;
}

// signals: { intradayBars, nowMs }
// gex:     { regime:'pos'|'neg', ... } | null
// px:      current underlying price
// state:   for cooldown lookup (optional): state._lastStraddleAt[ticker]
// returns: { fire:true, kind:'straddle', reason, rangePct, targetDelta } | { fire:false, reason }
function evaluateStraddle(ticker, signals = {}, gex, px, state = {}, cfg = STRADDLE) {
  if (!cfg.ENABLED) return { fire: false, reason: "straddle disabled" };
  if (!(px > 0))    return { fire: false, reason: "no price" };

  // --- Gate 1: REGIME — negative gamma only ---
  if (cfg.REQUIRE_NEG_GAMMA) {
    if (!gex || !gex.regime) return { fire: false, reason: "no gex regime (straddle needs confirmed neg gamma)" };
    if (gex.regime !== "neg") return { fire: false, reason: `regime ${gex.regime} — straddle is neg-gamma only` };
  }

  // --- Gate 2: VOL TRIGGER — trailing 30-min range must exceed the threshold ---
  const rangePct = trailingRangePct(signals.intradayBars, signals.nowMs || Date.now(),
                                    cfg.RANGE_WINDOW_MIN, cfg.MIN_BARS);
  if (rangePct == null) return { fire: false, reason: `insufficient bars for ${cfg.RANGE_WINDOW_MIN}min range` };
  if (rangePct < cfg.VOL_MIN_PCT) {
    return { fire: false, reason: `trailing ${cfg.RANGE_WINDOW_MIN}min range ${rangePct.toFixed(2)}% < ${cfg.VOL_MIN_PCT}% — vol too low, straddle would bleed theta` };
  }

  // --- Gate 3: COOLDOWN — don't stack straddles on the same ticker ---
  const last = state._lastStraddleAt && state._lastStraddleAt[ticker];
  if (last && (Date.now() - last) / 60000 < cfg.COOLDOWN_MIN) {
    return { fire: false, reason: `straddle cooldown (${((Date.now() - last) / 60000).toFixed(0)}min < ${cfg.COOLDOWN_MIN}min)` };
  }

  return {
    fire: true, kind: "straddle", targetDelta: cfg.TARGET_DELTA, rangePct,
    reason: `VOL-STRADDLE ${ticker} — neg gamma + trailing ${cfg.RANGE_WINDOW_MIN}min range ${rangePct.toFixed(2)}% >= ${cfg.VOL_MIN_PCT}% (persistence trigger, non-directional)`,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 11/08 (Harrison): V2 — LONG STRADDLE WHEN IMPLIED VOL IS BELOW REALIZED, NEGATIVE GAMMA, LIVE ON PAPER.
// The 9/14 rule above stays retired (STRADDLE.ENABLED false). Rules and literature: constants.js STRADDLE_*.
//   entry  : first check 10:00-12:00 ET with the ticker's gamma regime negative AND ATM IV / today's realized vol < 1.0
//   pair   : 1 ATM call + 1 ATM put, SAME strike, the 1-7 DTE expiry with the lowest ATM IV
//   exit   : both legs at 3:58 ET (3:59 crossing retry); no stop, no take-profit. One per ticker per day.
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const _C = (() => { try { return require("./constants"); } catch (_) { return {}; } })();
const _num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const V2 = {
  ENABLED:     _C.STRADDLE_ENABLED === true,
  MODE:        _C.STRADDLE_MODE === "shadow" ? "shadow" : "live",
  TICKERS:     Array.isArray(_C.STRADDLE_TICKERS) ? _C.STRADDLE_TICKERS : ["SPY", "QQQ"],
  START_ET:    _num(_C.STRADDLE_ENTRY_START_ET, 10),
  END_ET:      _num(_C.STRADDLE_ENTRY_END_ET, 12),
  IVRV_MAX:    _num(_C.STRADDLE_IVRV_MAX, 1.0),
  DTE_MIN:     Math.max(1, _num(_C.STRADDLE_DTE_MIN, 1)),
  DTE_MAX:     _num(_C.STRADDLE_DTE_MAX, 7),
  STRIKE_BAND: _num(_C.STRADDLE_STRIKE_BAND, 0.01),
  MAX_SPREAD:  _num(_C.STRADDLE_MAX_SPREAD_PCT, 0.05),
  CONTRACTS:   Math.max(1, Math.round(_num(_C.STRADDLE_CONTRACTS, 1))),
  EVAL_SEC:    _num(_C.STRADDLE_EVAL_SEC, 60),
  MAX_TRIES:   _num(_C.STRADDLE_MAX_TRIES, 3),
};
const _etDay = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const isHoldStraddle = (p) => !!(p && p._straddleHold);

function dayState(state, now = Date.now()) {
  const d = _etDay(now);
  if (!state._strad || state._strad.day !== d) state._strad = { day: d, done: {}, tries: {}, lastEval: {}, lastLog: {} };
  return state._strad;
}
function tally(state, reason) {
  try {
    if (!state._standDownTally) state._standDownTally = { brk: {}, mrf: {}, trend: {}, itrend: {} };
    if (!state._standDownTally.straddle) state._standDownTally.straddle = {};
    const r = String(reason).replace(/\d+(\.\d+)?/g, "N");
    state._standDownTally.straddle[r] = (state._standDownTally.straddle[r] || 0) + 1;
  } catch (_) {}
}

// cheap checks before any chain fetch. ctx: { etHour, regime, rv, now }. quiet = not worth a stand-down tally.
function preGate(ticker, state, ctx = {}) {
  if (!V2.ENABLED) return { ok: false, quiet: true, reason: "straddle off" };
  if (!V2.TICKERS.includes(ticker)) return { ok: false, quiet: true, reason: "ticker not traded" };
  const h = ctx.etHour, now = ctx.now || Date.now();
  if (!(h >= V2.START_ET && h < V2.END_ET)) return { ok: false, quiet: true, reason: "outside 10:00-12:00 ET" };
  const ds = dayState(state, now);
  if (ds.done[ticker]) return { ok: false, quiet: true, reason: `done today (${ds.done[ticker]})` };
  if ((state.positions || []).some(p => p.ticker === ticker && isHoldStraddle(p))) { ds.done[ticker] = "open"; return { ok: false, quiet: true, reason: "already open" }; }
  if (ctx.regime !== "neg") return { ok: false, reason: `gamma ${ctx.regime || "unknown"} — straddle is negative-gamma only` };
  if (!(ctx.rv > 0)) return { ok: false, reason: "no realized vol yet" };
  if (ds.lastEval[ticker] && now - ds.lastEval[ticker] < V2.EVAL_SEC * 1000) return { ok: false, quiet: true, reason: "checked this minute" };
  return { ok: true };
}

// rows: [{ symbol, type:'call'|'put', strike, exp:'YYYY-MM-DD', dte, bid, ask, iv, delta, theta, gamma, vega, oi }]
// -> the lowest-ATM-IV expiry's same-strike pair, or { none: reason }. Pure (tested).
function pickPair(rows, spot, cfg = V2) {
  if (!Array.isArray(rows) || !rows.length || !(spot > 0)) return { none: "no chain" };
  // |delta| 0.40-0.60 = the window executeTrade accepts for straddle legs, so leg 2 can't be refused after leg 1 fills
  const ok = (r) => r && r.bid > 0 && r.ask > r.bid && r.iv > 0 && (r.ask - r.bid) / r.ask <= cfg.MAX_SPREAD && r.dte >= cfg.DTE_MIN && r.dte <= cfg.DTE_MAX
                    && (!r.delta || (Math.abs(r.delta) >= 0.40 && Math.abs(r.delta) <= 0.60));
  const byExp = {};
  for (const r of rows) { if (!ok(r)) continue; const e = byExp[r.exp] || (byExp[r.exp] = {}); (e[r.strike] || (e[r.strike] = {}))[r.type] = r; }
  const per = [];
  for (const [exp, ks] of Object.entries(byExp)) {
    let best = null;
    for (const [k, legs] of Object.entries(ks)) {
      if (!legs.call || !legs.put) continue;
      const d = Math.abs(+k - spot);
      if (!best || d < best.d - 1e-9) best = { d, k: +k, call: legs.call, put: legs.put };
    }
    if (best) per.push({ exp, dte: best.call.dte, strike: best.k, call: best.call, put: best.put, iv: (best.call.iv + best.put.iv) / 2 });
  }
  if (!per.length) return { none: `no quoted same-strike pair in ${cfg.DTE_MIN}-${cfg.DTE_MAX} DTE (spread <= ${(cfg.MAX_SPREAD * 100).toFixed(0)}%)` };
  per.sort((a, b) => a.iv - b.iv || a.dte - b.dte);
  const w = per[0];
  return { ...w, cost: +(((w.call.ask + w.call.bid) / 2 + (w.put.ask + w.put.bid) / 2) * 100).toFixed(2),
           expiries: per.map(x => ({ exp: x.exp, dte: x.dte, strike: x.strike, iv: +x.iv.toFixed(4) })) };
}
// the contract object executeTrade expects (findContract's shape)
function asContract(r) {
  const mid = +((r.bid + r.ask) / 2).toFixed(2);
  return { symbol: r.symbol, strike: r.strike, expDate: r.exp, expDays: r.dte, premium: mid, bid: r.bid, ask: r.ask,
           spread: r.ask > 0 ? (r.ask - r.bid) / r.ask : 1, oi: r.oi || 0, iv: r.iv,
           greeks: { delta: (+r.delta || 0).toFixed(3), theta: (+r.theta || 0).toFixed(3), gamma: (+r.gamma || 0).toFixed(4), vega: (+r.vega || 0).toFixed(3) } };
}
function decide(pair, rv, cfg = V2) {
  if (!pair || pair.none) return { fire: false, reason: pair && pair.none ? pair.none : "no pair" };
  if (!(rv > 0)) return { fire: false, reason: "no realized vol" };
  const ratio = pair.iv / rv;
  const txt = `ATM IV ${(pair.iv * 100).toFixed(1)}% (${pair.dte}DTE $${pair.strike}) / realized ${(rv * 100).toFixed(1)}% = ${ratio.toFixed(2)}`;
  if (!(ratio < cfg.IVRV_MAX)) return { fire: false, ratio, reason: `${txt} — not below ${cfg.IVRV_MAX.toFixed(2)} (options not cheap vs the tape)` };
  return { fire: true, ratio, reason: `LONG STRADDLE — negative gamma, ${txt} < ${cfg.IVRV_MAX.toFixed(2)}; hold both legs to 3:58 ET` };
}

// pass 1 = 3:58 (sell at the live bid), pass 2 = 3:59 (crossing). deps: { state, closePosition, logEvent }
async function runExit(deps, pass = 1) {
  const { state, closePosition, logEvent } = deps;
  const open = (state.positions || []).filter(isHoldStraddle);
  for (const pos of open) {
    try {
      logEvent("scan", `[STRADDLE] ${pos.ticker} ${pos.optionType} leg ${pos.contractSymbol} closing at the ${pass === 1 ? "3:58" : "3:59 (crossing)"} exit`);
      await closePosition(pos.ticker, "straddle-close", null, pos.contractSymbol || pos.buySymbol, pass >= 2 ? { aggressive: true } : {});
    } catch (e) { logEvent("error", `[STRADDLE] ${pos.ticker} close failed: ${e && e.message}`); }
  }
  const left = (state.positions || []).filter(isHoldStraddle);
  if (left.length) logEvent(pass >= 2 ? "error" : "warn", `[STRADDLE] ${left.length} leg(s) STILL OPEN after the ${pass === 1 ? "3:58" : "3:59"} exit: ${left.map(p => p.contractSymbol || p.ticker).join(", ")}${pass >= 2 ? " — CHECK ALPACA" : " — retrying at 3:59"}`);
  return { closed: open.length - left.length, left: left.length };
}

// ── 11/08: PAIR RESULTS — each closed leg is recorded against its pair (signalId); the EOD report scores the pairs ──
// Pass line (set 11/08): after ~30 pairs, mean pair P&L (real fills, so already after the spread) > 0 with t >= 2.
function recordLeg(state, pos, o = {}) {
  try {
    if (!state || !pos || !pos._straddleHold) return null;
    const L = state._stradPairs || (state._stradPairs = []);
    const opened = Date.parse(pos.openDate || "") || Date.now();
    const sig = pos.signalId || `${pos.ticker}-${_etDay(opened)}`;
    let p = L.find(x => x.sig === sig);
    if (!p) { p = { sig, day: _etDay(opened), ticker: pos.ticker, strike: pos.strike, exp: pos.expDate || null, dte: pos.expiryDays != null ? pos.expiryDays : (pos.expDays != null ? pos.expDays : null), ivrv: pos._stradIvRv != null ? pos._stradIvRv : null, legs: [] }; L.push(p); }
    const q = Math.max(1, +o.qty || +pos.contracts || 1);
    const half = (b, a) => (b > 0 && a > b ? (a - b) / 2 : null);
    const es = half(pos._stradBid, pos._stradAsk), xs = half(pos.bid, pos.ask);
    p.legs.push({ type: pos.optionType, sym: pos.contractSymbol || null, qty: q, entry: +pos.premium || 0, exit: o.exitPremium != null ? +o.exitPremium : null,
                  cost: +((+pos.premium || 0) * 100 * q).toFixed(2), pnl: +(+o.pnl || 0).toFixed(2), reason: o.reason || null,
                  spread: es != null ? +(((es + (xs != null ? xs : 0)) * 100 * q)).toFixed(2) : null, at: Date.now() });
    while (L.length > 150) L.shift();
    return p;
  } catch (_) { return null; }
}
function pairStats(pairs, day) {
  const rows = (pairs || []).map(p => {
    const cost = p.legs.reduce((a, l) => a + (l.cost || 0), 0), pnl = p.legs.reduce((a, l) => a + (l.pnl || 0), 0);
    const sp = p.legs.every(l => l.spread != null) ? p.legs.reduce((a, l) => a + l.spread, 0) : null;
    return { ...p, complete: p.legs.length >= 2, cost: +cost.toFixed(2), pnl: +pnl.toFixed(2), pct: cost > 0 ? +(pnl / cost * 100).toFixed(1) : null, spread: sp != null ? +sp.toFixed(2) : null,
             reasons: [...new Set(p.legs.map(l => l.reason).filter(Boolean))].join("/") };
  });
  const done = rows.filter(r => r.complete), n = done.length;
  const mean = n ? done.reduce((a, r) => a + r.pnl, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(done.reduce((a, r) => a + (r.pnl - mean) ** 2, 0) / (n - 1)) : null;
  const t = n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
  return { today: rows.filter(r => r.day === day), n, wins: done.filter(r => r.pnl > 0).length, total: +done.reduce((a, r) => a + r.pnl, 0).toFixed(2),
           mean: mean != null ? +mean.toFixed(2) : null, sd: sd != null ? +sd.toFixed(2) : null, t: t != null ? +t.toFixed(2) : null,
           spread: +done.reduce((a, r) => a + (r.spread || 0), 0).toFixed(2), incomplete: rows.filter(r => !r.complete).length,
           verdict: n < 30 ? `collecting (${n} of ~30 pairs)` : (mean > 0 && t >= 2 ? "PASS — keep live" : "FAIL — to shadow per the pass line") };
}
function eodCSV(pairs) {
  const head = ["day", "ticker", "strike", "exp", "dte", "ivrv", "complete", "cost", "pnl", "pctOfCost", "spreadPaidEst", "exitReasons", "callEntry", "callExit", "putEntry", "putExit", "sig"];
  const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const out = [head.join(",")];
  for (const p of (pairs || [])) {
    const s = pairStats([p], p.day).today[0], c = p.legs.find(l => l.type === "call") || {}, pu = p.legs.find(l => l.type === "put") || {};
    out.push([p.day, p.ticker, p.strike, p.exp, p.dte, p.ivrv, s.complete, s.cost, s.pnl, s.pct, s.spread, s.reasons, c.entry, c.exit, pu.entry, pu.exit, p.sig].map(q).join(","));
  }
  return out.join("\n");
}
function eodSection(pairs, day) {
  const S = pairStats(pairs, day);
  if (!S.today.length && !S.n) return "";
  const money = (v) => (v == null ? "—" : `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`);
  const td = (v, st = "") => `<td style="padding:3px 6px;border-bottom:1px solid #eee;${st}">${v}</td>`;
  let h = `<h3 style="margin:18px 0 6px">Long straddle (negative gamma, IV &lt; realized, hold to 3:58)</h3>`;
  if (S.today.length) {
    h += `<table style="border-collapse:collapse;font-size:12px"><tr>${["Ticker", "Strike / DTE", "IV/RV at entry", "Cost", "P&amp;L", "% of cost", "Spread paid (est.)", "Exit"].map(x => `<th style="text-align:left;padding:3px 6px;border-bottom:2px solid #ccc">${x}</th>`).join("")}</tr>`;
    for (const r of S.today) h += `<tr>${td(r.ticker)}${td(`$${r.strike} / ${r.dte != null ? r.dte + "DTE" : "?"}`)}${td(r.ivrv != null ? r.ivrv.toFixed(2) : "—")}${td(`$${r.cost.toFixed(0)}`)}${td(money(r.pnl), `font-weight:700;color:${r.pnl >= 0 ? "#1a7f37" : "#c62828"}`)}${td(r.pct != null ? r.pct + "%" : "—")}${td(r.spread != null ? "$" + r.spread.toFixed(2) : "—")}${td((r.complete ? "" : "ONE LEG ONLY — ") + (r.reasons || "open"))}</tr>`;
    h += `</table>`;
  } else h += `<div style="font-size:12px;color:#666">No straddle today.</div>`;
  h += `<div style="font-size:12px;margin-top:6px">Running: <b>${S.n}</b> pair${S.n === 1 ? "" : "s"}, ${S.wins} won, total ${money(S.total)}, mean ${money(S.mean)}${S.t != null ? `, t = ${S.t.toFixed(2)}` : ""}, est. spread paid $${S.spread.toFixed(0)}${S.incomplete ? `, ${S.incomplete} one-leg` : ""} — <b>${S.verdict}</b>. Pass line (set 11/08): after ~30 pairs, mean &gt; 0 with t ≥ 2.</div>`;
  return h;
}

module.exports = { evaluateStraddle, trailingRangePct, STRADDLE, V2, preGate, pickPair, asContract, decide, runExit, isHoldStraddle, dayState, tally,
                   recordLeg, pairStats, eodCSV, eodSection };
