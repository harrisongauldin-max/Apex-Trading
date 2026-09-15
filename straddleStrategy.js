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
  ENABLED:             true,
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

module.exports = { evaluateStraddle, trailingRangePct, STRADDLE };
