// gex.js — DEALER-GAMMA / GEX regime, computed from the option chain APEX already fetches.
//
// WHY: the literature's central claim for intraday index trading is that mean-reversion is a REGIME,
// not a strategy: it works when dealers are long gamma (positive net GEX => they sell rallies / buy
// dips => price pins and ranges) and fails when they are short gamma (negative => they amplify =>
// price trends). APEX has been blind to this — pooling both regimes is why the clean fade test
// washed to zero. This module gathers that regime signal from data APEX already has, so the
// regime-conditional thesis can finally be TESTED (per the project governing principle: gather the
// literature's data, don't invent our own).
//
// CAVEATS (be honest about them; this is a first-order signal, not SpotGamma):
//   1. SIGN CONVENTION is the naive standard — dealers assumed LONG calls / SHORT puts. Public OI
//      does not identify who holds each side, so the dealer sign is an ASSUMPTION; every public GEX
//      figure depends on it.
//   2. NEAR-MONEY ONLY. APEX captures ~±0.47 delta per side, so far-OTM walls can be missed. Gamma
//      peaks ATM, so the net-sign (the regime) is robust; the walls are approximate.
//   3. OI is a prior-night snapshot, static intraday — same limitation every static-OI GEX model has.
//   4. Gamma-flip level (the zero-gamma pivot) is NOT computed here — it needs re-pricing gamma across
//      a spot grid. Deferred to v2; the net-sign regime + walls are the high-value, robust parts.

const CONTRACT = 100;

function _wall(rows) {
  let best = null, bestW = -Infinity;
  for (const r of rows || []) {
    const s = +r.strike || 0;
    const w = Math.abs(+r.gamma || 0) * Math.abs(+r.oi || 0);
    if (s > 0 && w > bestW) { bestW = w; best = s; }
  }
  return best;
}

// callRows / putRows: [{ strike, gamma, oi, ... }]; spot: underlying price.
function computeGEX(callRows, putRows, spot) {
  callRows = callRows || []; putRows = putRows || [];
  if (!(spot > 0) || (!callRows.length && !putRows.length)) return null;
  let callG = 0, putG = 0;
  for (const r of callRows) callG += (+r.gamma || 0) * (+r.oi || 0);
  for (const r of putRows)  putG  += (+r.gamma || 0) * (+r.oi || 0);
  const scale = CONTRACT * spot * spot * 0.01;          // GEX per 1% move
  const netGEX = (callG - putG) * scale;                // dealers long calls / short puts (assumption)
  const callWall = _wall(callRows), putWall = _wall(putRows);
  return {
    netGEX: Math.round(netGEX),
    netGexM: Math.round(netGEX / 1e6),                  // millions, for the tape
    regime: netGEX >= 0 ? "pos" : "neg",                // pos => range/MR-friendly; neg => trend
    callWall, putWall,
    distCallWallPct: (callWall > 0) ? parseFloat((((callWall - spot) / spot) * 100).toFixed(3)) : null,
    distPutWallPct:  (putWall  > 0) ? parseFloat((((putWall  - spot) / spot) * 100).toFixed(3)) : null,
    nStrikes: callRows.length + putRows.length,
  };
}

module.exports = { computeGEX };
