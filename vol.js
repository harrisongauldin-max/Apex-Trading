// ─────────────────────────────────────────────────────────────────────────────
// vol.js — 8/11: VOLATILITY + SURFACE INFRASTRUCTURE
//
// Everything here is computation on data APEX ALREADY FETCHES. No new feed, no new
// subscription. The chain snapshot in execution.js:findContract already carries per-contract
// bid/ask, greeks, openInterest and impliedVolatility for up to 50 strikes — it kept one and
// discarded the rest. This module turns that discarded material into the three things a vol
// desk actually trades on:
//
//   1. REALIZED VOL   — what the underlying is ACTUALLY doing (nothing in APEX measured this;
//                       the only stdDev in the codebase was on trade returns, in calcSharpeRatio)
//   2. IV - RV        — the variance risk premium. Positive means options are priced ABOVE what
//                       the tape is delivering, i.e. you are paying up to be long. This is the
//                       single number that says whether a naked-long book is swimming upstream.
//   3. REQUIRED MOVE  — how far the underlying must travel for THIS contract to hit its target
//                       return, compared against what the tape delivers in the holding window.
//
// Nothing in this file forecasts. Every output is a measurement of something already observed.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_BARS = 12;                 // below this, estimators are noise — return null, never a guess
const BARS_PER_YEAR_1MIN = 252 * 390; // 98,280 one-minute RTH bars in a trading year

function _finite(x) { return typeof x === "number" && Number.isFinite(x); }

// ── PARKINSON (high-low range) ───────────────────────────────────────────────
// ~5x more statistically efficient than close-to-close because a bar's high and low carry
// more information about the path than its endpoints. The right default for intraday bars.
// sigma^2 = (1 / (4 ln2)) * mean( ln(H/L)^2 )
function parkinsonVol(bars, barsPerYear = BARS_PER_YEAR_1MIN) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null;
  let s = 0, n = 0;
  for (const b of bars) {
    const h = b.h, l = b.l;
    if (!(h > 0) || !(l > 0) || h < l) continue;
    const r = Math.log(h / l);
    if (!Number.isFinite(r)) continue;
    s += r * r; n++;
  }
  if (n < MIN_BARS) return null;
  const varPer = s / (n * 4 * Math.LN2);
  if (!(varPer > 0)) return null;
  return Math.sqrt(varPer * barsPerYear);
}

// ── GARMAN-KLASS (OHLC) ──────────────────────────────────────────────────────
// Uses the open and close as well as the range. More efficient still when bars are clean,
// but more sensitive to bad opening prints — kept as a cross-check on Parkinson rather than
// as the primary. A large GK/Parkinson divergence is a data-quality signal, not a vol signal.
function garmanKlassVol(bars, barsPerYear = BARS_PER_YEAR_1MIN) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null;
  let s = 0, n = 0;
  for (const b of bars) {
    const { o, h, l, c } = b;
    if (!(o > 0) || !(h > 0) || !(l > 0) || !(c > 0) || h < l) continue;
    const hl = Math.log(h / l), co = Math.log(c / o);
    if (!Number.isFinite(hl) || !Number.isFinite(co)) continue;
    s += 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co; n++;
  }
  if (n < MIN_BARS) return null;
  const varPer = s / n;
  if (!(varPer > 0)) return null;
  return Math.sqrt(varPer * barsPerYear);
}

// ── CLOSE-TO-CLOSE ───────────────────────────────────────────────────────────
// The naive estimator. Kept only as a fallback when highs/lows are missing or degenerate
// (h === l on every bar happens on thin synthetic feeds).
function closeToCloseVol(bars, barsPerYear = BARS_PER_YEAR_1MIN) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS + 1) return null;
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c, b = bars[i].c;
    if (!(a > 0) || !(b > 0)) continue;
    const r = Math.log(b / a);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < MIN_BARS) return null;
  const m = rets.reduce((x, y) => x + y, 0) / rets.length;
  const v = rets.reduce((x, y) => x + (y - m) * (y - m), 0) / (rets.length - 1);
  if (!(v > 0)) return null;
  return Math.sqrt(v * barsPerYear);
}

// ── PRIMARY ENTRY POINT ──────────────────────────────────────────────────────
// Returns annualized realized vol as a DECIMAL (0.195 = 19.5%), matching the units of feed IV
// and of VIX/100 — so IV - RV is always apples-to-apples. Never throws; returns null when the
// data cannot support an estimate, and callers must treat null as "unknown", not as zero.
function realizedVol(bars, opts = {}) {
  const barsPerYear = opts.barsPerYear || BARS_PER_YEAR_1MIN;
  const out = {
    parkinson:   parkinsonVol(bars, barsPerYear),
    garmanKlass: garmanKlassVol(bars, barsPerYear),
    closeClose:  closeToCloseVol(bars, barsPerYear),
    rv: null, method: null, nBars: Array.isArray(bars) ? bars.length : 0,
  };
  if (_finite(out.parkinson) && out.parkinson > 0)      { out.rv = out.parkinson;   out.method = "parkinson"; }
  else if (_finite(out.garmanKlass) && out.garmanKlass > 0) { out.rv = out.garmanKlass; out.method = "garman-klass"; }
  else if (_finite(out.closeClose) && out.closeClose > 0)   { out.rv = out.closeClose;  out.method = "close-close"; }

  // ── SPARSE-BAR DETECTOR ────────────────────────────────────────────────────
  // Parkinson assumes the high/low of a CONTINUOUSLY observed path. When a bar's H/L is built
  // from few trades, the observed range is narrower than the true one and Parkinson understates
  // — verified: a 4-observation-per-bar synthetic walk reads 14.2% against a true 19.5%, and
  // converges to ~19.5% as observations rise. This is a live risk here, not a theoretical one:
  // broker.js:286 requests bars from "sip" and FALLS BACK TO "iex" — a single venue carrying a
  // few percent of volume. On an IEX fallback the H/L is sparse and RV reads low, which would
  // make IV - RV look richer than it is and bias every downstream gate toward "options are
  // expensive". Close-to-close uses only endpoints and is immune to this, so a large
  // parkinson/closeClose shortfall is the tell. Flag it rather than silently trusting the number.
  if (_finite(out.parkinson) && _finite(out.closeClose) && out.closeClose > 0) {
    out.pkRatio = out.parkinson / out.closeClose;
    // Parkinson normally reads BELOW close-to-close on clean data (it is the more efficient
    // estimator, less inflated by endpoint noise), so only a pronounced shortfall is suspicious.
    // Threshold 0.80 set empirically, not guessed: over 40 synthetic seeds, dense (SIP-like)
    // bars floored at 0.88 and moderate at 0.86, while sparse (IEX-like) bars topped out at 0.75.
    // 0.80 sits in the clean gap — no false positives on good data, no misses on sparse.
    out.sparse  = out.pkRatio < 0.80;
    if (out.sparse) { out.rv = out.closeClose; out.method = "close-close (sparse-bar fallback)"; }
  } else {
    out.pkRatio = null;
    out.sparse  = null;
  }
  return out;
}

// ── VARIANCE RISK PREMIUM ────────────────────────────────────────────────────
// vrp > 0 : implied above realized — the long book is PAYING the premium (the structural
//           headwind for naked longs, and the structural tailwind for a premium seller).
// vrp < 0 : realized above implied — options are cheap relative to what the tape is doing,
//           which is the only regime where being long premium is carry-positive.
function ivrvSpread(iv, rv) {
  if (!_finite(iv) || !_finite(rv) || iv <= 0 || rv <= 0) {
    return { iv: _finite(iv) ? iv : null, rv: _finite(rv) ? rv : null, vrp: null, ratio: null, regime: "unknown" };
  }
  const vrp = iv - rv;
  const ratio = iv / rv;
  const regime = ratio >= 1.15 ? "iv-rich" : ratio <= 0.90 ? "iv-cheap" : "fair";
  return { iv, rv, vrp, ratio, regime };
}

// ── REQUIRED MOVE ────────────────────────────────────────────────────────────
// First-order: an option gains ~delta per $1 of underlying, so to gain targetReturn of its own
// premium it needs   dS = targetReturn * premium / delta,  i.e.  dS/S = tR * P / (delta * S).
// Validated against full Black-Scholes: 1DTE $1.86/0.42d -> 0.092% here vs 0.094% BS;
// 40DTE $8.26/0.35d -> 0.49% vs 0.473% BS. The small understatement is ignored gamma, which
// works in the trade's favour, so this is the CONSERVATIVE side of the estimate.
function requiredMovePct(premium, delta, underlying, targetReturn = 0.125) {
  const d = Math.abs(delta);
  if (!(premium > 0) || !(d > 0) || !(underlying > 0) || !(targetReturn > 0)) return null;
  return (targetReturn * premium) / (d * underlying);
}

// ── AVAILABLE MOVE ───────────────────────────────────────────────────────────
// What the tape delivers over a holding window, scaled by sqrt(time) — range accumulates with
// the square root of elapsed time, not linearly.
//
// CRITICAL: rangePct is the range observed SO FAR, over `elapsedMinutes` — NOT a full-day range.
// Scaling it by sqrt(hold/390) treats an hour of observation as if it were a whole session and
// understates the available move by 3.6x at 30 minutes in, 2.6x at an hour — worst in the morning,
// which is when APEX trades most. The correct ratio is hold/ELAPSED: a range built over 60 minutes
// says what 20 minutes delivers via sqrt(20/60), not sqrt(20/390). Passing elapsedMinutes = 390
// reproduces the full-day interpretation when that is genuinely what the caller has.
function availableMovePct(rangePct, holdMinutes, elapsedMinutes = 390) {
  if (!(rangePct > 0) || !(holdMinutes > 0) || !(elapsedMinutes > 0)) return null;
  // A hold longer than the observation window cannot be extrapolated with confidence; clamp the
  // ratio at 1 so the estimate never claims more movement than has actually been observed.
  const ratio = Math.min(1, holdMinutes / elapsedMinutes);
  return (rangePct / 100) * Math.sqrt(ratio);
}

// ── THE GATE ─────────────────────────────────────────────────────────────────
// ratio < 1 : the move this contract needs is SMALLER than what the tape delivers — tradeable.
// ratio > 1 : it needs an outsized move. On the measured data every 40-DTE leg sat above 1 at
//             every range regime APEX has traded, which is the structural reason that leg drags.
function moveFeasibility(premium, delta, underlying, rangePct, holdMinutes, elapsedMinutes = 390, targetReturn = 0.125) {
  const req = requiredMovePct(premium, delta, underlying, targetReturn);
  const avail = availableMovePct(rangePct, holdMinutes, elapsedMinutes);
  if (!_finite(req) || !_finite(avail) || avail <= 0) {
    return { requiredPct: req, availablePct: avail, ratio: null, feasible: null };
  }
  const ratio = req / avail;
  return { requiredPct: req, availablePct: avail, ratio, feasible: ratio <= 1.0 };
}

// ── SURFACE STATS FROM A RETAINED CHAIN ──────────────────────────────────────
// Collapses the per-contract rows execution.js used to discard into the three surface
// measurements: ATM level, skew (IV vs strike at comparable expiry), and term structure
// (IV vs DTE). Tolerates missing IV on individual rows — the indicative feed is patchy, so
// each statistic reports its own sample count and returns null rather than a fabricated value.
function surfaceStats(chain) {
  const out = { n: 0, nWithIV: 0, atmIV: null, skew: null, termSlope: null, medSpreadPct: null, totalOI: 0 };
  if (!Array.isArray(chain) || chain.length === 0) return out;
  out.n = chain.length;

  const withIV = chain.filter(c => _finite(c.iv) && c.iv > 0);
  out.nWithIV = withIV.length;
  for (const c of chain) out.totalOI += _finite(c.oi) ? c.oi : 0;

  const spreads = chain.map(c => c.spreadPct).filter(x => _finite(x) && x >= 0).sort((a, b) => a - b);
  if (spreads.length) out.medSpreadPct = spreads[Math.floor(spreads.length / 2)];

  if (withIV.length === 0) return out;

  // ATM = nearest to 0.50 delta
  let atm = null, bestD = Infinity;
  for (const c of withIV) {
    const d = Math.abs(Math.abs(c.delta) - 0.50);
    if (d < bestD) { bestD = d; atm = c; }
  }
  if (atm) out.atmIV = atm.iv;

  // SKEW: IV difference between a low-delta (OTM) and the ATM contract, same-ish expiry.
  if (atm) {
    const near = withIV.filter(c => Math.abs(c.dte - atm.dte) <= 2);
    let otm = null, bd = Infinity;
    for (const c of near) {
      const d = Math.abs(Math.abs(c.delta) - 0.25);
      if (d < bd) { bd = d; otm = c; }
    }
    if (otm && otm.symbol !== atm.symbol) out.skew = otm.iv - atm.iv;
  }

  // TERM: slope of IV per DTE across the sampled expiries (least squares).
  const byDTE = new Map();
  for (const c of withIV) {
    if (!_finite(c.dte)) continue;
    if (!byDTE.has(c.dte)) byDTE.set(c.dte, []);
    byDTE.get(c.dte).push(c.iv);
  }
  const pts = [...byDTE.entries()].map(([d, ivs]) => [d, ivs.reduce((a, b) => a + b, 0) / ivs.length]);
  if (pts.length >= 2) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    let num = 0, den = 0;
    for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) * (x - mx); }
    if (den > 0) out.termSlope = num / den;
  }
  return out;
}

module.exports = {
  realizedVol, parkinsonVol, garmanKlassVol, closeToCloseVol,
  ivrvSpread, requiredMovePct, availableMovePct, moveFeasibility, surfaceStats,
  BARS_PER_YEAR_1MIN,
};
