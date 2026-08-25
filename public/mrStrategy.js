// mrStrategy.js — a CLEAN, self-contained mean-reversion entry, faithful to the literature.
//
// WHY THIS EXISTS: APEX's entry engine is a momentum/breakout web (OR-break structure, momentum
// confirmation, falling-knife veto) with a VIX>=25-gated MR channel bolted on and mostly dormant.
// Surgically mutating that web into a mean-reversion system produces a THIRD hybrid — the exact
// "committed to neither" disease. Instead this module implements the literature's MR entry as one
// coherent decision, so it can run as its own strategy and be measured on its own terms.
//
// THE LITERATURE'S MEAN-REVERSION SETUP (each gate traced to its source; see project context log §4):
//   1. REGIME (dealer gamma) — MR works only in POSITIVE gamma: dealers sell rallies / buy dips, so
//      price pins and ranges. In negative gamma they amplify and price trends; fading is a falling
//      knife. So: fade ONLY in positive-gamma. [SpotGamma/MenthorQ; the regime input APEX lacked.]
//   2. LOCATION (levels) — enter AT a level, not "oversold in the middle of nowhere": the put wall
//      (downside magnet/support) for a fade-up, the call wall for a fade-down, or the VWAP band.
//      [Harris, microstructure; the gamma walls from gex.js.]
//   3. EXTREME + STRETCH (confluence) — oversold/overbought AND stretched from VWAP. A CONJUNCTION,
//      not a score sum (summing a good signal with noise produces noise — why APEX's score is
//      anti-predictive). [Chan; Aronson.]
//   4. INVALIDATION — MR trades are underwater-first, so the exit is a LEVEL, not a tight timer: the
//      thesis is dead if price makes a decisive new extreme beyond the wall or the regime flips.
//      [Chan (exit as first-class); returned here for the exit engine to enforce.]
//
// This module DECIDES; it does not place orders. It returns a fade decision only when the full
// confluence aligns — otherwise it stands down (standing down is the correct action most of the time).

// --- tunables (conservative defaults; every one is a hypothesis to be tested on paper) ---
const MR = {
  REQUIRE_POSITIVE_GAMMA: true,   // core regime gate. If GEX is unavailable, fall back to ADX proxy below.
  ADX_RANGE_MAX:          15,     // proxy regime when GEX missing: low ADX = range. Gamma is the real signal.
  RSI_OVERSOLD:           30,     // fade-up trigger (buy call)
  RSI_OVERBOUGHT:         70,     // fade-down trigger (buy put)
  VWAP_STRETCH_PCT:       0.19,   // must be stretched at least this far from VWAP (mean)
  WALL_PROXIMITY_PCT:     0.35,   // "at a level" = within this % of the relevant gamma wall
  ALLOW_VWAP_BAND:        true,   // if no wall nearby, a deep VWAP-band stretch also counts as a location
  VWAP_BAND_PCT:          0.40,   // the VWAP-band distance that qualifies as a location on its own
  INVALIDATION_PCT:       0.25,   // thesis dead if price extends this % beyond entry against the fade
};

// signals: { rsi, vwapPct, adx }         (vwapPct = (px - vwap)/vwap * 100)
// gex:     { regime:'pos'|'neg', callWall, putWall, distCallWallPct, distPutWallPct } | null
// px:      current underlying price
// returns: { fire, side, reason, entryPx, invalidationPx, location, regimeSource } | { fire:false, reason }
function evaluateMRFade(signals = {}, gex, px, cfg = MR) {
  const rsi  = signals.rsi;
  const vwap = signals.vwapPct;
  const adx  = signals.adx;
  if (rsi == null || vwap == null || !(px > 0)) return { fire: false, reason: "missing signals" };

  // --- Gate 1: REGIME (positive gamma; ADX-low proxy only if GEX absent) ---
  let regimeOK, regimeSource;
  if (gex && gex.regime) {
    regimeOK = !cfg.REQUIRE_POSITIVE_GAMMA || gex.regime === "pos";
    regimeSource = `gamma:${gex.regime}`;
  } else {
    regimeOK = (adx != null && adx <= cfg.ADX_RANGE_MAX);   // proxy — the real gate is gamma
    regimeSource = `adx-proxy:${adx != null ? adx.toFixed(0) : "?"}`;
  }
  if (!regimeOK) return { fire: false, reason: `regime not fade-friendly (${regimeSource})`, regimeSource };

  // --- Gate 2: which side, from the extreme (fade the extreme) ---
  let side = null;
  if (rsi <= cfg.RSI_OVERSOLD  && vwap <= -cfg.VWAP_STRETCH_PCT) side = "call";   // oversold + below VWAP -> fade UP
  if (rsi >= cfg.RSI_OVERBOUGHT && vwap >=  cfg.VWAP_STRETCH_PCT) side = "put";    // overbought + above VWAP -> fade DOWN
  if (!side) return { fire: false, reason: `no extreme+stretch (rsi ${rsi}, vwap ${vwap.toFixed(2)}%)`, regimeSource };

  // --- Gate 3: LOCATION — at a gamma wall, or (optionally) a deep VWAP-band stretch ---
  let location = null;
  if (gex) {
    const wallDist = side === "call" ? gex.distPutWallPct : gex.distCallWallPct;   // fade-up buys support at the PUT wall
    const wall     = side === "call" ? gex.putWall        : gex.callWall;
    if (wall != null && wallDist != null && Math.abs(wallDist) <= cfg.WALL_PROXIMITY_PCT) {
      location = `${side === "call" ? "put" : "call"}-wall@${wall} (${wallDist.toFixed(2)}%)`;
    }
  }
  if (!location && cfg.ALLOW_VWAP_BAND && Math.abs(vwap) >= cfg.VWAP_BAND_PCT) {
    location = `vwap-band ${vwap.toFixed(2)}%`;
  }
  if (!location) return { fire: false, reason: `extreme but not AT a level (no wall/band) — "oversold in the middle of nowhere"`, regimeSource, side };

  // --- all gates aligned: fire the fade, with an invalidation level for the exit engine ---
  const invalidationPx = side === "call"
    ? px * (1 - cfg.INVALIDATION_PCT / 100)    // long call (fade up): dead if price makes a decisive new low
    : px * (1 + cfg.INVALIDATION_PCT / 100);   // long put  (fade down): dead if price makes a decisive new high
  return {
    fire: true, side, regimeSource, location,
    entryPx: px, invalidationPx,
    reason: `MR fade ${side} — ${regimeSource}, ${location}, rsi ${rsi}, vwap ${vwap.toFixed(2)}% [confluence]`,
  };
}

module.exports = { evaluateMRFade, MR };
