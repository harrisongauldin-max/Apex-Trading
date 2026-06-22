// ============================================================
// APEX Entry Engine — v3.0
// ============================================================
// Single source of truth for all entry decisions.
// Three exports: getRegimeRulebook, scoreCandidate, evaluateEntry
//
// v3.0 changes (APEX naked options agent):
//   - SPY/QQQ only, debit_naked always — all spread types removed
//   - INSTRUMENT_CONSTRAINTS: SPY/QQQ only with debit_naked
//   - getRegimeRulebook: spreadParams removed, credit mode removed
//   - scoreCandidate: always routes to debit_naked
//   - evaluateEntry: credit branches removed, simplified gates
// ============================================================

"use strict";

// ── Constants ────────────────────────────────────────────────
const BASE_MIN_SCORE = 70;
const SCORE_CAP      = 95;

// ── Phase 1 (6/18): release the MR-call choke ────────────────
// Two reversible knobs. The drawdown protocol still enforces ddMinScore (normally 70)
// via Math.max below, so MR_CALL_MIN_SCORE cannot drop the effective floor under 70.
const MR_CALL_MIN_SCORE      = 70;  // bull-regime mean-reversion (dip-buy) calls clear this instead of the 75 generic call floor. Set to 75 to revert to carve-out-only.
const CALL_MACD_CARVEOUT_RSI = 35;  // an index MR call with intraday RSI <= this is exempt from the bearish-MACD floor lift (bearish daily MACD IS the dip). Set to 0 to disable the carve-out.
const MACD_BEARISH_CALL_VETO = true; // D2: true => re-key carve-out off DAILY RSI + require bull_curl, and HARD-VETO a bearish-MACD call that is not even daily-oversold (falling knife). false = prior 85-lift behavior.

// ── INSTRUMENT CONSTRAINTS ───────────────────────────────────
// APEX trades SPY and QQQ naked options only.
const INSTRUMENT_CONSTRAINTS = {
  SPY: { allowedTypes: ["debit_naked"] },
  QQQ: { allowedTypes: ["debit_naked"] },
};

// ── Correlated instrument groups ─────────────────────────────
// SPY+QQQ at 0.95 correlation — count as 1.5x heat (Kelly criterion)
const CORRELATED_GROUPS = [
  { tickers: ["SPY","QQQ"], heatMultiplier: 1.5, label: "SPY/QQQ large-cap tech" },
];

// ============================================================
// 1. REGIME RULEBOOK — v3.0
// Computed once per scan. All downstream reads from this object.
// ============================================================
function getRegimeRulebook(state) {
  const regimeClass = state._regimeClass || "A";
  const vix         = state.vix || 20;
  const ivRank      = state._ivRank || 50;
  const agentMacro  = state._agentMacro || {};
  const agentSig    = agentMacro.signal     || "neutral";
  const agentConf   = agentMacro.confidence || "low";
  const agentBias   = agentMacro.entryBias  || "neutral";
  const agentType   = agentMacro.tradeType  || "spread";
  const agentTS     = agentMacro.timestamp  || null;
  const agentAge    = agentTS ? (Date.now() - new Date(agentTS).getTime()) / 60000 : 999;
  const agentStale  = agentAge > 30;

  // ── Regime classification ─────────────────────────────────
  const regimeName   = regimeClass === "B" ? "trending_bear"
                     : regimeClass === "C" ? "breakdown"
                     : "trending_bull";
  const isBullRegime = regimeName === "trending_bull";
  const isBearRegime = regimeName === "trending_bear" || regimeName === "breakdown";
  const isCrisis     = regimeClass === "C";

  // ── Agent state ───────────────────────────────────────────
  const agentChoppy       = agentType === "none";
  const agentPutsOnBounce = agentBias === "puts_on_bounces";
  const isLowConf         = agentConf === "low" || agentStale;
  const isMacroBullish    = agentMacro.mode === "aggressive";

  // ── IV / VIX (retained for dashboard/logging) ────────────
  const ivElevated = ivRank >= 45;
  const ivHigh     = ivRank >= 70;

  // ── V3.1: B1/B2 sub-regime ───────────────────────────────
  const isB1 = isBearRegime && state._regimeSubClass === "B1";
  const isB2 = isBearRegime && state._regimeSubClass === "B2";

  const minScorePut  = isBullRegime ? 85 : isB1 ? 75 : 70;
  const minScoreCall = isBullRegime ? 75 : 85;
  const agentMinAdj  = 0;                  // CUT (6/14): was isLowConf?+10:0. A stale/low-conf agent could silently raise the call floor 75→85. Agent no longer adjusts min score; isLowConf/agentStale still computed for logging.
  const macroReversalThreshold = isB1 ? 0.020 : 0.025;

  // ── Gate flags ────────────────────────────────────────────
  const gates = {
    choppyDebitBlock:    false,
    crisisDebitBlock:    isCrisis,       // crisis blocks ALL entries
    macroBullishBlock:   false,          // CUT (6/14): was isMacroBullish (agent mode==="aggressive"). Agent no longer blocks puts. Plumbing kept false.
    below200MACallBlock: !!(state._spyMA200 && state._liveSPY && state._liveSPY < state._spyMA200),

    spyGapUpBlockPuts:   !!(state._spyGapUp && isBullRegime),
    afternoonMinActive:  isBullRegime,
    macdContradictsGate: isBullRegime,

    putsOnBounceMode:    false,          // CUT (6/14): was isBearRegime && agentPutsOnBounce. Agent no longer steers bear-regime put timing. Plumbing kept false.
    oversoldSizeReduce:  isBearRegime,

    avoidHoldActive:   !!(state._avoidUntil && Date.now() < state._avoidUntil),
    agentStale,
    vixFallingPause:   !!(state._vixFallingPause),
    postReversalBlock: !!(state._macroReversalAt && (Date.now() - state._macroReversalAt) < 30 * 60 * 1000),
    postCrisisLock:    !!(state._postCrisisLock),
    vixSpikeCooldown:  !!(state._vixSpikeAt),
    isB1,
    isB2,
  };

  // ── Sizing multipliers ────────────────────────────────────
  const sizeMult = {
    base:         isCrisis ? 0.5 : isB1 ? 0.75 : 1.0,
    ivBoostDebit: 1.0,
    oversold:     0.75,
  };

  return {
    regimeClass,
    regimeName,
    isBullRegime,
    isBearRegime,
    isCrisis,
    isB1,
    isB2,
    macroReversalThreshold,
    vix,
    ivRank,
    ivElevated,
    ivHigh,
    agentSig,
    agentConf,
    agentBias,
    agentStale,
    agentPutsOnBounce,
    agentMinAdj,
    gates,
    sizeMult,
    correlatedGroups:     CORRELATED_GROUPS,
    instrumentConstraints: INSTRUMENT_CONSTRAINTS,
    minScorePut,
    minScoreCall,
    baseMinScore: BASE_MIN_SCORE,
  };
}

// ============================================================
// 2. SCORE CANDIDATE
// APEX: always debit_naked. No credit/spread routing.
// ============================================================
function scoreCandidate(stock, rawPutScore, rawCallScore, putReasons, callReasons, signals, rulebook, state) {
  const rb      = rulebook;
  const ticker  = stock.ticker;

  let putScore  = Math.min(SCORE_CAP, Math.max(0, rawPutScore));
  let callScore = Math.min(SCORE_CAP, Math.max(0, rawCallScore));

  const optionType = putScore >= callScore ? "put" : "call";

  // APEX is a naked options agent — always debit_naked regardless of regime or credit mode.
  const tradeType = "debit_naked";

  // SPY recovering penalty applies to debit puts only
  if (signals.spyRecovering && optionType === "put" && !rb.gates.putsOnBounceMode) {
    putScore = Math.max(0, putScore - 20);
    putReasons.push("SPY recovering — tape fighting debit puts (-20)");
  } else if (signals.spyRecovering && rb.gates.putsOnBounceMode) {
    putReasons.push("SPY recovering — puts_on_bounces fade thesis (+0)");
  }

  const bestScore   = Math.max(putScore, callScore);
  const bestReasons = optionType === "put" ? putReasons : callReasons;

  const constraint     = rb.instrumentConstraints[ticker];
  // True whitelist (fail-closed): a ticker with no constraint entry is NOT tradeable.
  // Combined with the SPY/QQQ-only WATCHLIST this makes any other instrument
  // structurally un-enterable, not merely gate-dependent.
  const constraintPass = !!constraint && constraint.allowedTypes.includes(tradeType);

  const dailyRsi       = signals.dailyRsi || signals.rsi || 50;
  const oversoldInBear = rb.gates.oversoldSizeReduce && dailyRsi <= 40 && optionType === "put";
  const sizeMod        = rb.sizeMult.base * (oversoldInBear ? rb.sizeMult.oversold : 1.0);

  const corrGroup      = rb.correlatedGroups.find(g => g.tickers.includes(ticker));
  const heatMultiplier = corrGroup ? corrGroup.heatMultiplier : 1.0;

  return {
    stock,
    ticker,
    optionType,
    tradeType,
    score:     bestScore,
    putScore,
    callScore,
    reasons:   bestReasons,
    putReasons,
    callReasons,
    sizeMod,
    heatMultiplier,
    constraintPass,
    constraintReason: constraintPass
      ? null
      : (constraint
          ? `[CONSTRAINT] ${tradeType} not in allowed [${constraint.allowedTypes.join(",")}]`
          : `[CONSTRAINT] ${ticker} not in tradeable whitelist (SPY/QQQ only)`),
    tradeIntent: {
      type:       tradeType,
      regimeSnap: rb.regimeName,
      ivRankSnap: rb.ivRank,
      lockedAt:   Date.now(),
    },
  };
}

// ============================================================
// 3. EVALUATE ENTRY
// Single pass/fail gate. All gate logic here. One decision.
// ============================================================
function evaluateEntry(candidate, rulebook, state, context = {}) {
  const rb  = rulebook;
  const g   = rb.gates;
  const { ticker, optionType, tradeType, score, constraintPass, constraintReason } = candidate;

  const etHour    = context.etHour   || 12;
  const isLateDay = etHour >= 14.5;
  const signals   = context.signals  || {};
  const dailyRsi  = signals.dailyRsi || signals.rsi || 50;
  const intradayRsi = (signals.rsi != null) ? signals.rsi : dailyRsi;
  const macdSignal = signals.macd    || "neutral";
  const macdBullish = macdSignal.includes("bullish");
  const macdBearish = macdSignal.includes("bearish");

  // Hard blocks
  if (!constraintPass)       return { pass: false, reason: constraintReason };
  if (g.avoidHoldActive)     return { pass: false, reason: "avoid hold active" };
  if (g.macroBullishBlock && optionType === "put") return { pass: false, reason: "macro aggressive — puts blocked" };

  // Choppy/crisis block ALL entries (no credit fallback in APEX)
  if (g.crisisDebitBlock)    return { pass: false, reason: "Regime C — all naked entries blocked" };
  if (g.choppyDebitBlock)    return { pass: false, reason: "agent:none — all entries blocked in choppy regime" };

  // Put-specific
  if (optionType === "put") {
    if (g.spyGapUpBlockPuts)  return { pass: false, reason: "SPY gap-up — puts paused in Regime A" };
    if (g.vixFallingPause)    return { pass: false, reason: "VIX falling — IV crush risk, debit puts lose value" };
    if (g.postReversalBlock)  return { pass: false, reason: "post-reversal cooldown — 30min re-entry block" };
  }

  // Call-specific
  if (optionType === "call") {
    if (g.below200MACallBlock) return { pass: false, reason: "SPY below 200MA — debit calls fight the trend in Regime B" };
  }

  // Stagger gate — debit naked: 5% profit confirmation within 30min
  const recentSameDir = context.recentSameDir ?? null;
  if (recentSameDir !== null && recentSameDir < 30) {
    const existingProfit = context.existingProfitPct ?? 0;
    if (existingProfit < 0.05)
      return { pass: false, reason: `stagger — ${recentSameDir.toFixed(0)}min since last ${optionType} on ${ticker} (need 30min gap or >5% profit)` };
  }

  // Minimum score
  // Phase 1 (6/18): with-trend mean-reversion dip-buys clear MR_CALL_MIN_SCORE instead of the
  // generic call floor. Against-trend puts keep rb.minScorePut (85 in bull) — Risk's wall, untouched.
  let minScore;
  if (optionType === "put") {
    minScore = rb.minScorePut;
  } else if (candidate.isMeanReversion === true && rb.isBullRegime) {
    minScore = MR_CALL_MIN_SCORE;
  } else {
    minScore = rb.minScoreCall;
  }
  minScore     = Math.max(0, minScore + rb.agentMinAdj);
  const _trBase = minScore;                 // V3.2 (6/19) floor-composition trace (additive, no behavior change)
  let _trAfternoon = false, _trMacdLift = false, _trCarveOut = false;

  // Afternoon minimum [Regime A only]
  if (g.afternoonMinActive && isLateDay) {
    const afternoonMin = rb.vix >= 30 ? 90 : rb.vix >= 25 ? 85 : minScore;
    if (afternoonMin > minScore) _trAfternoon = true;
    minScore = Math.max(minScore, afternoonMin);
  }

  // MACD contradiction [Regime A only]
  if (g.macdContradictsGate) {
    // Phase 1 carve-out: an index mean-reversion call with deeply-oversold intraday RSI is NOT a
    // MACD contradiction — bearish daily MACD IS the oversold dip it is buying. Exempting it stops
    // the dip from raising its own floor 75->85. Everything else (bullish-MACD puts, and non-MR /
    // non-index / not-oversold bearish-MACD calls) still gets lifted to 85.
    if (!MACD_BEARISH_CALL_VETO) {
      // Flag OFF: prior behavior — carve-out (effectively daily; intradayRsi falls back to dailyRsi) + flat 85 lift.
      const oversoldIndexMRCall = optionType === "call"
        && candidate.isMeanReversion === true
        && candidate.isIndex === true
        && intradayRsi <= CALL_MACD_CARVEOUT_RSI;
      _trCarveOut = oversoldIndexMRCall;
      const genuineContradiction = (optionType === "put"  && macdBullish && dailyRsi < 65)
                                 || (optionType === "call" && macdBearish && !oversoldIndexMRCall);
      if (genuineContradiction) { _trMacdLift = true; minScore = Math.max(minScore, 85); }
    } else {
      // D2 (flag ON): carve-out re-keyed off DAILY RSI + bull_curl confirmation; tiered call-side response.
      const _curl        = signals.macdCurl || "none";
      const _oversoldDay = dailyRsi <= CALL_MACD_CARVEOUT_RSI;
      const carvedOut    = optionType === "call"
        && candidate.isMeanReversion === true
        && candidate.isIndex === true
        && _oversoldDay
        && _curl === "bull_curl";                 // confirmed bottoming dip — not a contradiction
      _trCarveOut = carvedOut;
      if (optionType === "put" && macdBullish && dailyRsi < 65) {
        _trMacdLift = true; minScore = Math.max(minScore, 85);             // puts: unchanged
      } else if (optionType === "call" && macdBearish && !carvedOut) {
        if (_oversoldDay) {
          _trMacdLift = true; minScore = Math.max(minScore, 85);           // oversold, curl unconfirmed → high floor, not veto
        } else {
          return { pass: false, reason: `MACD bearish on long call & daily RSI ${dailyRsi.toFixed(0)} not oversold (D2 falling-knife veto)` };
        }
      }
    }
  }

  // Drawdown protocol
  const ddMinScore = context.drawdownMinScore ?? BASE_MIN_SCORE;
  const _trBeforeDD = minScore;
  minScore = Math.max(minScore, ddMinScore);
  const _trDD = minScore > _trBeforeDD ? ddMinScore : null;

  // V3.2 (6/22) PAPER-EXPERIMENT floor override (panel-decided; flag-gated via context from constants.js).
  // Caps the CALL floor at experimentMinScore so marginal paper setups can enter for data collection.
  // CALLS ONLY — puts stay disciplined. Tagged in the trace so these fills are isolable. Reverts via flag.
  let _expApplied = false;
  if (context.experimentMode === true && optionType === "call") {
    const _expFloor = context.experimentMinScore ?? 50;
    if (_expFloor < minScore) { minScore = _expFloor; _expApplied = true; }
  }

  // V3.2 (6/19) additive floor-composition trace — observability only, never alters pass/fail.
  // carveOut shows at a glance whether the oversold-dip exemption fired; isMR/isIndex are the
  // candidate fields it depends on (both were silently absent from the eeCandidate before 6/19,
  // which forced every oversold index MR call to the 85 MACD-contradiction floor).
  const minScoreTrace = {
    base: _trBase,
    afternoonLift: _trAfternoon ? minScore : null,
    macdLift85: _trMacdLift,
    ddLift: _trDD,
    final: minScore,
    isMR: candidate.isMeanReversion === true,
    isIndex: candidate.isIndex === true,
    carveOut: _trCarveOut,
    intradayRsi,
    experiment: _expApplied,
  };

  if (score < minScore)
    return { pass: false, reason: `score ${score} below min ${minScore}`, minScore, minScoreTrace };

  return { pass: true, minScore, tradeType, optionType, minScoreTrace };
}

// ── Exports ───────────────────────────────────────────────────
module.exports = { getRegimeRulebook, scoreCandidate, evaluateEntry, INSTRUMENT_CONSTRAINTS, CORRELATED_GROUPS };
