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
  RSI_OVERBOUGHT:         65,     // 9/14 (Harrison): loosened 70->65. Put-fade (overbought->buy put) in POS gamma is the validated edge; at 65-70 it still reached +0.4% fav ~49% (vs 57% strict) — more fires, thinner edge. Call side (OVERSOLD) left STRICT — fade-up is weak on this tape.
  VWAP_STRETCH_PCT:       0.19,   // must be stretched at least this far from VWAP (mean)
  WALL_PROXIMITY_PCT:     0.30,   // 9/22 (Harrison): tightened 0.35→0.30. DATA: fades ≤0.30% from the wall reverted 43% vs 22% mid-range (n=87 vs 74). The wall IS the fade signal (dealers defend it) — proven on tape, not just literature.
  REQUIRE_WALL:           false,  // 9/22: when true, ONLY fade at a wall (drop the vwap-band fallback = the weak 22% mid-range group). Default false = still take band-fades but TAGGED (locationSource) so we can measure wall vs band separately, THEN flip true if band-fades confirm weak. Governing principle: measure before restricting.
  ALLOW_VWAP_BAND:        true,   // if no wall nearby, a deep VWAP-band stretch also counts as a location
  VWAP_BAND_PCT:          0.40,   // the VWAP-band distance that qualifies as a location on its own
  INVALIDATION_PCT:       0.25,   // thesis dead if price extends this % beyond entry against the fade
  // ── 9/29 (Harrison): NEGATIVE-GAMMA FADE. Data: neg-gamma fades revert MORE than pos-gamma (39% vs 18%),
  // and the precise setup "at a wall + CVD-exhaustion" reverts 64% (n=56) vs 35% neither. Literature
  // (SpotGamma: fade the overshoot AT the wall; Sinclair: only after flow EXHAUSTS) + expert panel + data
  // all converge. So: ALSO fade in neg gamma, but ONLY when at-wall AND CVD shows exhaustion (flow stalling/
  // turning against the push). Pos-gamma path unchanged. Measure-first via a flag, then confirm live.
  NEG_GAMMA_FADE:         true,   // allow neg-gamma fades (under the strict conditions below)
  NEG_REQUIRE_WALL:       true,   // neg-gamma fade REQUIRES at-wall (the 47% vs 35% split); no vwap-band fallback in neg
  NEG_REQUIRE_CVD_EXHAUST:true,   // neg-gamma fade REQUIRES CVD exhaustion at the level (the 51% vs 36% split; stacked = 64%)
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
  let _negFade = false;
  if (gex && gex.regime) {
    if (gex.regime === "pos") { regimeOK = true; }
    else if (gex.regime === "neg" && cfg.NEG_GAMMA_FADE) { regimeOK = true; _negFade = true; }   // 9/29: neg-gamma fade path (strict conditions enforced at Gate 3)
    else { regimeOK = !cfg.REQUIRE_POSITIVE_GAMMA; }
    regimeSource = `gamma:${gex.regime}${_negFade ? "-neg-fade" : ""}`;
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

  // 9/29: CVD EXHAUSTION — the flow driving the overshoot is stalling/turning. fade-down (price pushed UP,
  // side=put): exhaustion = up-flow no longer building (cvdSlope <= 0). fade-up (price pushed DOWN, side=call):
  // exhaustion = down-flow no longer building (cvdSlope >= 0). Only consumed by the neg-gamma gate below.
  const _cs = signals.cvdSlope;
  signals.cvdExhaust = (_cs == null) ? null
    : (side === "put" ? (_cs <= 0) : (_cs >= 0));

  // --- Gate 3: LOCATION — at a gamma wall, or (optionally) a deep VWAP-band stretch ---
  let location = null;
  if (gex) {
    const wallDist = side === "call" ? gex.distPutWallPct : gex.distCallWallPct;   // fade-up buys support at the PUT wall
    const wall     = side === "call" ? gex.putWall        : gex.callWall;
    if (wall != null && wallDist != null && Math.abs(wallDist) <= cfg.WALL_PROXIMITY_PCT) {
      location = `${side === "call" ? "put" : "call"}-wall@${wall} (${wallDist.toFixed(2)}%)`;
    }
  }
  let locationSource = location ? "wall" : null;
  // 9/29: NEG-GAMMA FADE strict gate — must be AT A WALL and CVD-EXHAUSTING (the 64% n=56 setup).
  if (_negFade) {
    if (!location && cfg.NEG_REQUIRE_WALL) {
      return { fire: false, reason: `neg-gamma fade but NOT at a wall (needs at-wall; data 47% vs 35%)`, regimeSource, side };
    }
    if (cfg.NEG_REQUIRE_CVD_EXHAUST && signals.cvdExhaust !== true) {
      const _why = signals.cvdExhaust == null ? "no CVD data" : "CVD still pushing (not exhausted)";
      return { fire: false, reason: `neg-gamma fade at wall but ${_why} — need exhaustion (data 51% vs 36%, stacked 64%)`, regimeSource, side };
    }
  }
  if (!location && cfg.REQUIRE_WALL) {
    return { fire: false, reason: `extreme + stretched but NOT at a wall — mid-range fade (data: 22% revert vs 43% at-wall); REQUIRE_WALL on, standing down`, regimeSource, side };
  }
  if (!location && cfg.ALLOW_VWAP_BAND && Math.abs(vwap) >= cfg.VWAP_BAND_PCT) {
    location = `vwap-band ${vwap.toFixed(2)}%`; locationSource = "vwap-band";   // 9/22: tagged — vwap-band fades are the WEAKER mid-range group (22% revert); measure them separately before trusting
  }
  if (!location) return { fire: false, reason: `extreme but not AT a level (no wall/band) — "oversold in the middle of nowhere"`, regimeSource, side };

  // --- all gates aligned: fire the fade, with an invalidation level for the exit engine ---
  const invalidationPx = side === "call"
    ? px * (1 - cfg.INVALIDATION_PCT / 100)    // long call (fade up): dead if price makes a decisive new low
    : px * (1 + cfg.INVALIDATION_PCT / 100);   // long put  (fade down): dead if price makes a decisive new high
  return {
    fire: true, side, regimeSource, location, locationSource,   // 9/22: which path qualified (wall = strong 43%, vwap-band = weak 22%) — for measuring before REQUIRE_WALL
    entryPx: px, invalidationPx,
    reason: `MR fade ${side} — ${regimeSource}, ${location}, rsi ${rsi}, vwap ${vwap.toFixed(2)}% [confluence]`,
  };
}

module.exports = { evaluateMRFade, MR };
