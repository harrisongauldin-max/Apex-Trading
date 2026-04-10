// ============================================================
// ARGO Entry Engine — v1.0
// ============================================================
// Single source of truth for all entry decisions.
// Three exports: getRegimeRulebook, scoreCandidate, evaluateEntry
//
// Architecture (panel unanimous 14/14):
//   getRegimeRulebook(state)  → rulebook object, computed once per scan
//   scoreCandidate(stock, signals, rulebook, state) → { score, tradeIntent, reasons }
//   evaluateEntry(candidate, rulebook, state)       → { pass, reason }
//
// All regime-specific parameters live in the rulebook.
// No gate re-derives regime conditions independently.
// No scattered constants. No stacked conditional patches.
// ============================================================

"use strict";

// ── Constants ────────────────────────────────────────────────
const BASE_MIN_SCORE    = 70;
const SCORE_CAP         = 95;

// ── INSTRUMENT CONSTRAINTS ───────────────────────────────────
// Hard enforcement at execution — survives any gate shift
const INSTRUMENT_CONSTRAINTS = {
  TLT: { allowedTypes: ["credit_put","credit_call"],                    reason: "Bond ETF — collect premium only" },
  GLD: { allowedTypes: ["credit_put","credit_call","debit_put"],        reason: "Commodity hedge" },
  SPY: { allowedTypes: ["credit_put","credit_call","debit_put","debit_call","iron_condor"] },
  QQQ: { allowedTypes: ["credit_put","credit_call","debit_put","debit_call","iron_condor"] },
  XLE: { allowedTypes: ["debit_put"],                                   reason: "Energy ETF — directional puts only" },
};

// ============================================================
// 1. REGIME RULEBOOK
// Computed once at scan start. Every downstream function reads
// from this object — nothing re-derives regime on its own.
// ============================================================
function getRegimeRulebook(state) {
  const regimeClass  = state._regimeClass || "A";
  const vix          = state.vix || 20;
  const ivRank       = state._ivRank || 50;
  const agentMacro   = state._agentMacro || {};
  const agentSig     = agentMacro.signal     || "neutral";
  const agentConf    = agentMacro.confidence || "low";
  const agentBias    = agentMacro.entryBias  || "neutral";
  const agentType    = agentMacro.tradeType  || "spread";
  const agentTS      = agentMacro.timestamp  || null;
  const agentAge     = agentTS ? (Date.now() - new Date(agentTS).getTime()) / 60000 : 999;
  const agentStale   = agentAge > 30;

  // ── Derived regime name (price-based, authoritative) ──────
  const regimeName   = regimeClass === "B" ? "trending_bear"
                     : regimeClass === "C" ? "breakdown"
                     : "trending_bull";
  const isBullRegime = regimeName === "trending_bull";
  const isBearRegime = regimeName === "trending_bear" || regimeName === "breakdown";
  const isCrisis     = regimeClass === "C";

  // ── Agent state ───────────────────────────────────────────
  const agentChoppy       = agentType === "none";
  const agentSaysCredit   = agentType === "credit";
  const agentPutsOnBounce = agentBias === "puts_on_bounces";
  const agentAvoid        = agentBias === "avoid";
  const isBearishHigh     = ["bearish","strongly bearish"].includes(agentSig) && agentConf === "high" && !agentStale;
  const isLowConf         = agentConf === "low" || agentStale;
  const isMacroBullish    = agentMacro.mode === "aggressive";

  // ── IV / VIX conditions ───────────────────────────────────
  const skewElevated      = (state._skew?.skew || 0) >= 130;
  const creditAllowedVIX  = vix >= 25 || (skewElevated && vix >= 22);
  const ivElevated        = ivRank >= 50;
  const ivHigh            = ivRank >= 70;

  // ── Credit mode flags ─────────────────────────────────────
  // Credit PUT:
  //   Choppy (agent:none) + VIX gate — sell premium when direction is uncertain
  //   Agent says credit — explicit agent instruction
  //   Regime B + VIX ≥ 25 + IVR ≥ 50 — sell puts below falling market (panel rulebook)
  const creditPutActive   = (agentChoppy || agentSaysCredit || (isBearRegime && creditAllowedVIX && ivElevated)) && creditAllowedVIX;
  // Credit CALL (bear call spread): bear regime + VIX + IV
  const spyNearResistance = (() => {
    const res = agentMacro.keyLevels?.spyResistance;
    return res && state._liveSPY ? Math.abs(state._liveSPY - res) / res < 0.015 : false;
  })();
  const creditCallActive  = ((agentChoppy && creditAllowedVIX && spyNearResistance) ||
                              (isBearRegime && creditAllowedVIX && ivElevated));

  // ── Minimum scores by regime ──────────────────────────────
  // Regime A: puts need 85 (fight the trend), calls need 75
  // Regime B: puts need 70 (trend aligned), credits need 65
  // Regime C: credits only, need 65
  const minScorePut      = isBullRegime ? 85 : 70;
  const minScoreCall     = isBullRegime ? 75 : 85; // calls blocked in B/C except MR
  const minScoreCredit   = 65;
  // Agent confidence adjustment
  // RM panel: high confidence should NOT lower the bar — let the score carry conviction
  // Only raise minimum when confidence is low/stale (be more selective with weak signal)
  const agentMinAdj      = isLowConf ? +10 : 0;

  // ── Gate flags — regime-tagged ────────────────────────────
  const gates = {
    // [All regimes] Hard stops
    choppyDebitBlock:    agentChoppy,          // agent said none → debit blocked
    crisisDebitBlock:    isCrisis,             // Regime C → no debit at all
    macroBullishBlock:   isMacroBullish,       // agent aggressive → puts blocked
    below200MACallBlock: !!(state._spyMA200 && state._liveSPY && state._liveSPY < state._spyMA200),

    // [Regime A only] — do NOT apply in B/C
    spyGapUpBlockPuts:   !!(state._spyGapUp && isBullRegime),
    afternoonMinActive:  isBullRegime,         // elevated min after 2:30pm only in A
    macdContradictsGate: isBullRegime,         // MACD contradiction only meaningful in A

    // [Regime B specific]
    putsOnBounceMode:    isBearRegime && agentPutsOnBounce,
    oversoldSizeReduce:  isBearRegime,         // 0.75x when daily RSI ≤ 40 in B

    // [Mode flags]
    creditPutActive,
    creditCallActive,
    avoidHoldActive:     !!(state._avoidUntil && Date.now() < state._avoidUntil),
    agentStale,

    // [Missing from v1.0 — panel fixes 3/4/5]
    // VIX falling pause: buying puts into falling VIX destroys value via IV crush
    vixFallingPause:     !!(state._vixFallingPause),
    // Post-reversal cooldown: block re-entry 30min after macro-reversal close (March 25 pattern)
    postReversalBlock:   !!(state._macroReversalAt &&
                            (Date.now() - state._macroReversalAt) < 30 * 60 * 1000),
  };

  // ── Sizing multipliers ────────────────────────────────────
  const sizeMult = {
    base:       isCrisis ? 0.5 : 1.0,
    // VS panel: ivBoost applies to CREDIT entries only — buying debit in high IV is expensive
    // For credit: sell more when premium is rich (1.5x at IVR ≥ 70)
    // For debit: no boost — high IV means expensive options, edge is reduced
    ivBoostCredit: ivHigh ? 1.5 : 1.0,
    ivBoostDebit:  1.0,                        // never amplify debit size in high IV
    oversold:      0.75,                       // applied when daily RSI ≤ 40 in B
    // RM panel: crisis credit sizing — 0.75x when IV rich (IVR ≥ 70), 0.5x otherwise
    creditCrisis:  isCrisis && ivHigh ? 0.75 : isCrisis ? 0.5 : 1.0,
  };

  // ── Spread structure by regime ────────────────────────────
  const spreadParams = {
    // Debit spread widths (VIX-scaled)
    debitWidth:      vix >= 35 ? 20 : vix >= 25 ? 15 : 10,
    // Credit spread widths — tighter in crisis (gap risk)
    creditWidth:     isCrisis  ? 7  : 15,
    // Min OTM% for credit short strike
    creditOTMpct:    isCrisis  ? 0.10 : 0.06,
    // Min credit/width ratio
    minCreditRatio:  0.25,
    // Max debit/width ratio (R/R gate)
    maxDebitRatio:   0.40,
  };

  return {
    regimeClass,
    regimeName,
    isBullRegime,
    isBearRegime,
    isCrisis,
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
    spreadParams,
    instrumentConstraints: INSTRUMENT_CONSTRAINTS,
    minScorePut,
    minScoreCall,
    minScoreCredit,
    baseMinScore: BASE_MIN_SCORE,
  };
}

// ============================================================
// 2. SCORE CANDIDATE
// Takes a pre-computed raw score + signals, applies regime
// modifiers, locks tradeIntent. Returns enriched candidate.
// ============================================================
function scoreCandidate(stock, rawPutScore, rawCallScore, putReasons, callReasons, signals, rulebook, state) {
  const rb      = rulebook;
  const ticker  = stock.ticker;
  const isIndex = stock.isIndex || false;

  // ── Base scores ───────────────────────────────────────────
  let putScore  = Math.min(SCORE_CAP, Math.max(0, rawPutScore));
  let callScore = Math.min(SCORE_CAP, Math.max(0, rawCallScore));

  // ── Pick best direction first ─────────────────────────────
  const optionType  = putScore >= callScore ? "put" : "call";

  // ── Determine trade type ──────────────────────────────────
  // Check instrument constraints first — they override credit mode
  // (XLE allows debit_put only, so credit mode never applies to XLE)
  const instrConstraint = rb.instrumentConstraints[ticker];
  const allowsCredit    = !instrConstraint || instrConstraint.allowedTypes.some(t => t.startsWith("credit"));
  let tradeType;
  if (stock.isMeanReversion)                                                                    tradeType = "debit_naked";
  else if (optionType === "put" && rb.gates.creditPutActive && isIndex && rb.ivRank >= 50 && allowsCredit)  tradeType = "credit_put";
  else if (optionType === "call" && rb.gates.creditCallActive && isIndex && allowsCredit)       tradeType = "credit_call";
  else                                                                                          tradeType = optionType === "put" ? "debit_put" : "debit_call";

  // ── Apply regime score modifiers (after tradeType is known) ──
  const isCreditPutTrade = tradeType === "credit_put";
  if (signals.spyRecovering) {
    if (!isCreditPutTrade && !rb.gates.putsOnBounceMode) {
      putScore = Math.max(0, putScore - 20);
      putReasons.push("SPY recovering — tape fighting debit puts (-20)");
    } else if (isCreditPutTrade) {
      putReasons.push("SPY recovering — credit put benefits, short strike moves further OTM (+0)");
    } else {
      putReasons.push("SPY recovering — puts_on_bounces fade thesis (+0)");
    }
  }

  const bestScore   = Math.max(putScore, callScore);
  const bestReasons = optionType === "put" ? putReasons : callReasons;

  // ── Instrument constraint check ───────────────────────────
  const constraint = rb.instrumentConstraints[ticker];
  const constraintPass = !constraint || constraint.allowedTypes.includes(tradeType);

  // ── Sizing modifier ───────────────────────────────────────
  const dailyRsi = signals.dailyRsi || signals.rsi || 50;
  const oversoldInBear = rb.gates.oversoldSizeReduce && dailyRsi <= 40 && optionType === "put";
  const isCrisis  = rb.isCrisis;
  const isCredit  = tradeType.startsWith("credit");
  const ivBoost   = isCredit ? rb.sizeMult.ivBoostCredit : rb.sizeMult.ivBoostDebit;
  const crisisAdj = isCrisis && isCredit ? rb.sizeMult.creditCrisis : rb.sizeMult.base;
  const sizeMod   = crisisAdj * ivBoost * (oversoldInBear ? rb.sizeMult.oversold : 1.0);

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
    constraintPass,
    constraintReason: constraint && !constraintPass
      ? `[CONSTRAINT] ${tradeType} not in allowed [${constraint.allowedTypes.join(",")}]${constraint.reason ? " — " + constraint.reason : ""}`
      : null,
    tradeIntent: {
      type:                 tradeType,
      instrumentConstraint: constraint || null,
      creditPutSnap:        rb.gates.creditPutActive,
      creditCallSnap:       rb.gates.creditCallActive,
      ivRankSnap:           rb.ivRank,
      regimeSnap:           rb.regimeName,
      lockedAt:             Date.now(),
    },
  };
}

// ============================================================
// 3. EVALUATE ENTRY
// Given a scored candidate and rulebook, returns pass/fail.
// All gate logic lives here — one place, one read.
// ============================================================
function evaluateEntry(candidate, rulebook, state, context = {}) {
  const rb  = rulebook;
  const g   = rb.gates;
  const {
    ticker, optionType, tradeType, score,
    constraintPass, constraintReason, tradeIntent,
  } = candidate;

  const etHour    = context.etHour    || 12;
  const isLateDay = etHour >= 14.5;
  const isLastHour = etHour >= 15.0;
  const volDecline = context.volDecline || false;
  const signals    = context.signals   || {};
  const dailyRsi   = signals.dailyRsi  || signals.rsi || 50;
  const macdSignal = signals.macd      || "neutral";
  const macdBullish = macdSignal.includes("bullish");
  const macdBearish = macdSignal.includes("bearish");

  // ── Hard blocks (always apply) ────────────────────────────
  if (!constraintPass)                return { pass: false, reason: constraintReason };
  if (g.avoidHoldActive)              return { pass: false, reason: "avoid hold active" };
  if (g.macroBullishBlock && optionType === "put") return { pass: false, reason: "macro aggressive — puts blocked" };

  // ── Direction-specific hard blocks ────────────────────────
  if (optionType === "put") {
    if (g.crisisDebitBlock && !tradeType.startsWith("credit")) return { pass: false, reason: "Regime C — debit puts blocked" };
    if (g.choppyDebitBlock && !tradeType.startsWith("credit")) return { pass: false, reason: "choppy (agent:none) — debit puts blocked, credit mode only" };
    if (g.spyGapUpBlockPuts)           return { pass: false, reason: "SPY gap-up — puts paused in Regime A" };
    if (g.macroBullishBlock)           return { pass: false, reason: "macro bullish — puts blocked" };
    if (g.vixFallingPause)             return { pass: false, reason: "VIX falling — IV crush risk, put entries paused" };
    if (g.postReversalBlock)           return { pass: false, reason: "post-reversal cooldown — 30min re-entry block after macro-reversal close" };
  }
  if (optionType === "call") {
    if (g.below200MACallBlock && !tradeType.startsWith("credit")) return { pass: false, reason: "SPY below 200MA — debit calls blocked in Regime B" };
    if (g.crisisDebitBlock && !tradeType.startsWith("credit"))    return { pass: false, reason: "Regime C — debit calls blocked" };
  }

  // ── Stagger gate (TA panel fix) ──────────────────────────
  // Prevent pile-ons: same-ticker same-direction entry within 30min requires +5 conviction
  // context.recentSameDir = minutes since last same-direction entry on this ticker (null if none)
  const recentSameDir = context.recentSameDir ?? null;
  const staggerActive = recentSameDir !== null && recentSameDir < 30;
  const staggerMinBoost = staggerActive ? 5 : 0;
  if (staggerActive) {
    // Still allow if existing position is profitable (confirms thesis)
    const existingProfit = context.existingProfitPct ?? 0;
    if (existingProfit < 0.05) {
      return { pass: false, reason: `stagger blocked — ${recentSameDir.toFixed(0)}min since last ${optionType} on ${ticker} (need 30min gap or >5% profit)` };
    }
  }

  // ── Determine effective minimum score ─────────────────────
  let minScore = tradeType.startsWith("credit") ? rb.minScoreCredit
               : optionType === "put"           ? rb.minScorePut
               : rb.minScoreCall;

  // Agent confidence adjustment
  minScore = Math.max(0, minScore + rb.agentMinAdj);

  // Afternoon minimum [Regime A only, bypassed in B when puts_on_bounces confirmed]
  if (g.afternoonMinActive && isLateDay) {
    const afternoonMin = rb.vix >= 30 ? 90 : rb.vix >= 25 ? 85 : minScore;
    minScore = Math.max(minScore, afternoonMin);
  }

  // MACD contradiction [Regime A only — macdContradictsGate=false bypasses entirely in B/C]
  // MS panel: contradiction only applies when MACD bullish AND RSI < 65
  // If RSI ≥ 65 the stock is extended — put is a fade, not a contradiction
  if (g.macdContradictsGate) {
    const genuineContradiction = (optionType === "put" && macdBullish && dailyRsi < 65)
                               || (optionType === "call" && macdBearish);
    if (genuineContradiction) minScore = Math.max(minScore, 85);
  }
  // In Regime B/C: macdContradictsGate=false, entire block skipped — no MACD minimum raise

  // Drawdown protocol adjustment — RM panel: explicit param, not hidden state dependency
  // context.drawdownMinScore passed by server.js from its drawdown calculation
  const ddMinScore = context.drawdownMinScore ?? BASE_MIN_SCORE;
  minScore = Math.max(minScore, ddMinScore);

  if (score < minScore) {
    return { pass: false, reason: `score ${score} below min ${minScore}`, minScore };
  }

  return { pass: true, minScore, tradeType, optionType };
}

// ── Exports ───────────────────────────────────────────────────
module.exports = { getRegimeRulebook, scoreCandidate, evaluateEntry, INSTRUMENT_CONSTRAINTS };
