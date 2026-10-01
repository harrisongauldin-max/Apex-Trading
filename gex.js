// gex.js — DEALER-GAMMA / GEX regime, computed from the option chain APEX fetches.
//
// v1 (8/24): nearest single future expiry, net sign only.
// v2 (9/30, Harrison): full-book version. The published GEX research uses dealers' whole options book, not
// one day of it; the v1 single-expiry read did not reproduce the literature on APEX's tape (neg "regime"
// days moved no more than pos days). v2:
//   1. AGGREGATES every expiry in the fetched chain (fetchGexChain v2 = first N future expiries,
//      strikes +/-5% of spot). Longer expiries carry less gamma per contract, so gamma*OI weights them
//      naturally — no hand-tuned expiry weights.
//   2. WALLS from total |gamma|*OI per STRIKE across expiries (not one day's).
//   3. GAMMA-FLIP level: reprices each contract's gamma (Black-Scholes, its own IV and time-to-expiry)
//      across a spot grid and finds where net GEX crosses zero — the level the literature treats as the
//      real regime boundary. Cached per chain fetch (WeakMap on the row array), recomputed only if spot
//      drifts >2% from the grid centre.
//   4. Also reports the NEAR-expiry-only regime (the v1 number) as regimeNear/netGexNearM so the two can
//      be compared in logs before trusting v2.
//
// Output shape is a superset of v1: regime, netGEX, netGexM, callWall, putWall, distCallWallPct,
// distPutWallPct, nStrikes are unchanged in meaning (now full-book), so mr-fade, the itrend gate and
// telemetry keep working.
//
// Assumptions (unchanged from v1, stated plainly):
//   - Sign convention: dealers long calls / short puts (the standard naive GEX assumption). Real dealer
//     positioning can differ; this is the same approximation the public GEX work uses.
//   - 0DTE is excluded upstream (Alpaca returns no greeks/OI for same-day expiry). 0DTE carries a lot of
//     gamma in SPY, so the full-book read still under-counts the very nearest positioning.

const CONTRACT = 100;
const _flipCache = new WeakMap();

function _normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

// Black-Scholes gamma (r ~ 0 over these horizons). Returns 0 on bad inputs.
function _bsGamma(S, K, T, iv) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(iv > 0)) return 0;
  const v = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / v;
  return _normPdf(d1) / (S * v);
}

function _sumGO(rows) {
  let g = 0;
  for (const r of rows) g += (+r.gamma || 0) * (+r.oi || 0);
  return g;
}

// |gamma|*OI aggregated per strike across expiries; returns the heaviest strike.
function _wall(rows) {
  const byStrike = new Map();
  for (const r of rows || []) {
    const s = +r.strike || 0;
    if (!(s > 0)) continue;
    byStrike.set(s, (byStrike.get(s) || 0) + Math.abs(+r.gamma || 0) * Math.abs(+r.oi || 0));
  }
  let best = null, bestW = -Infinity;
  for (const [s, w] of byStrike) if (w > bestW) { bestW = w; best = s; }
  return best;
}

// Net GEX (per 1% move) if the underlying were at S, repricing gamma from IV/T.
function _netAt(S, callRows, putRows) {
  let c = 0, p = 0;
  for (const r of callRows) if (r.iv > 0 && r.T > 0) c += _bsGamma(S, r.strike, r.T, r.iv) * (+r.oi || 0);
  for (const r of putRows)  if (r.iv > 0 && r.T > 0) p += _bsGamma(S, r.strike, r.T, r.iv) * (+r.oi || 0);
  return (c - p) * CONTRACT * S * S * 0.01;
}

// Zero-crossing of net GEX over a +/-5% grid, nearest to spot. null if net GEX never changes sign.
function _computeFlip(callRows, putRows, spot) {
  const hasIV = callRows.some(r => r.iv > 0 && r.T > 0) && putRows.some(r => r.iv > 0 && r.T > 0);
  if (!hasIV) return { flipLevel: null, flipNote: "no-iv" };
  const pts = [];
  for (let i = -50; i <= 50; i++) {
    const S = spot * (1 + i * 0.001);
    pts.push([S, _netAt(S, callRows, putRows)]);
  }
  let best = null, bestDist = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [s0, n0] = pts[i - 1], [s1, n1] = pts[i];
    if (n0 === 0 || (n0 < 0) !== (n1 < 0)) {
      const x = n0 === 0 ? s0 : s0 + (s1 - s0) * (0 - n0) / (n1 - n0);   // linear interpolation
      const d = Math.abs(x - spot);
      if (d < bestDist) { bestDist = d; best = x; }
    }
  }
  if (best === null) return { flipLevel: null, flipNote: pts[50][1] >= 0 ? "all-pos" : "all-neg" };
  return { flipLevel: parseFloat(best.toFixed(2)), flipNote: "ok" };
}

function _flipCached(callRows, putRows, spot) {
  const c = _flipCache.get(callRows);
  if (c && c.putRows === putRows && Math.abs(spot - c.centre) / c.centre < 0.02) return c.result;
  const result = _computeFlip(callRows, putRows, spot);
  _flipCache.set(callRows, { putRows, centre: spot, result });
  return result;
}

// callRows / putRows: [{ strike, gamma, oi, iv?, T?, exp? }]; spot: underlying price.
function computeGEX(callRows, putRows, spot) {
  callRows = callRows || []; putRows = putRows || [];
  if (!(spot > 0) || (!callRows.length && !putRows.length)) return null;

  const scale = CONTRACT * spot * spot * 0.01;              // GEX per 1% move
  const netGEX = (_sumGO(callRows) - _sumGO(putRows)) * scale;

  // near-expiry-only read (= the v1 number) for comparison
  const exps = [...new Set([...callRows, ...putRows].map(r => r.exp).filter(Boolean))].sort();
  let netGexNear = netGEX;
  if (exps.length > 1) {
    const near = exps[0];
    netGexNear = (_sumGO(callRows.filter(r => r.exp === near)) - _sumGO(putRows.filter(r => r.exp === near))) * scale;
  }

  const callWall = _wall(callRows), putWall = _wall(putRows);
  const flip = _flipCached(callRows, putRows, spot);

  return {
    netGEX: Math.round(netGEX),
    netGexM: Math.round(netGEX / 1e6),                      // millions, for the tape
    regime: netGEX >= 0 ? "pos" : "neg",                    // FULL-BOOK regime (v2)
    netGexNearM: Math.round(netGexNear / 1e6),
    regimeNear: netGexNear >= 0 ? "pos" : "neg",            // nearest-expiry regime (what v1 reported)
    nExpiries: exps.length || 1,
    callWall, putWall,
    distCallWallPct: (callWall > 0) ? parseFloat((((callWall - spot) / spot) * 100).toFixed(3)) : null,
    distPutWallPct:  (putWall  > 0) ? parseFloat((((putWall  - spot) / spot) * 100).toFixed(3)) : null,
    flipLevel: flip.flipLevel,
    distFlipPct: (flip.flipLevel > 0) ? parseFloat((((flip.flipLevel - spot) / spot) * 100).toFixed(3)) : null,
    flipNote: flip.flipNote,                                 // ok | all-pos | all-neg | no-iv
    nStrikes: callRows.length + putRows.length,
  };
}

module.exports = { computeGEX };
