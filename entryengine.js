// ============================================================
// ARGO Entry Engine — v2.0
// ============================================================
// Single source of truth for all entry decisions.
// Three exports: getRegimeRulebook, scoreCandidate, evaluateEntry
//
// v2.0 changes (panel 19/19 unanimous — professional calibration):
//   1. OTM% raised to 8-10% in Regime B, 10-12% in Regime C
//      (PM2/CBOE: short delta target 0.15-0.20, not 0.28-0.30)
//   2. Min credit ratio raised to 0.30 floor, 0.35 target
//      (QS: Simon & Campasano 2014 — EV requires >25% at 8%+ OTM)
//   3. DTE targets added to spreadParams per regime
//      (OT + Natenberg 1994 Ch.8: 21-28 DTE in B, 14-21 in C)
//   4. Portfolio vega cap added — maxPortfolioVega per VIX point
//      (GS/VS: Natenberg Ch.8 — vega dominates early in trade life)
//   5. SPY+QQQ correlated heat — count as 1.5x not 2x
//      (TR: Kelly criterion, tastytrade 2014 small account research)
//   6. IVR as primary credit gate (ivRank >= 50), raw VIX as floor
//      (QS: Simon & Campasano — IVR more stable than raw VIX level)
// ============================================================

"use strict";

// ── Constants ────────────────────────────────────────────────
const BASE_MIN_SCORE    = 70;
const SCORE_CAP         = 95;

// ── INSTRUMENT CONSTRAINTS ───────────────────────────────────
// Hard enforcement at execution — survives any gate shift
// Panel unanimous: structure must match instrument's volatility profile
const INSTRUMENT_CONSTRAINTS = {
  TLT: { allowedTypes: ["credit_put","credit_call"],
         reason: "Bond ETF — slow movement, only collect premium. Debit spreads need large directional moves TLT rarely delivers." },
  GLD: { allowedTypes: ["credit_put","credit_call","debit_put"],
         reason: "Commodity hedge — credit puts and calls appropriate. Debit calls only on confirmed equity selloff + DXY weakness." },
  SPY: { allowedTypes: ["credit_put","credit_call","debit_put","debit_call","iron_condor"] },
  QQQ: { allowedTypes: ["credit_put","credit_call","debit_put","debit_call","iron_condor"] },
  XLE: { allowedTypes: ["debit_put"],
         reason: "Energy ETF — oil-correlated, directional puts on downtrend only. Credits too risky in oil spike environments." },
};

// ── Correlated instrument groups ─────────────────────────────
// TR panel: SPY+QQQ at 0.95 correlation are one directional bet
// Count combined as 1.5x heat not 2x — Kelly criterion applied
const CORRELATED_GROUPS = [
  { tickers: ["SPY","QQQ"], heatMultiplier: 1.5, label: "SPY/QQQ large-cap tech" },
];

// ============================================================
// 1. REGIME RULEBOOK — v2.0
// Computed once per scan. All downstream reads from this object.
// Professional calibration per 19-member panel review.
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

  // ── Regime classification (price-based, authoritative) ────
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
  const isLowConf         = agentConf === "low" || agentStale;
  const isMacroBullish    = agentMacro.mode === "aggressive";

  // ── IV / VIX conditions ───────────────────────────────────
  // Change 6 (QS/Simon & Campasano 2014):
  //   IVR >= 50 is the primary credit entry condition — measures options
  //   expensiveness relative to historical percentile, more stable than raw VIX
  //   Raw VIX >= 25 retained as structural floor (prevents credit entries in
  //   calm low-vol markets where IV can keep falling post-entry)
  const skewElevated      = (state._skew?.skew || 0) >= 130;
  // IVR threshold lowered 50→45: at IVR 45-50 with VIX >= 25, options are expensive enough
  // for credit spreads. The hard 50 cutoff was too rigid — IVR 49 with VIX 28 is credit-favorable.
  // Belt: require VIX >= 27 when IVR is in the 45-50 borderline zone for extra confirmation.
  const ivElevated        = ivRank >= 45;         // primary credit gate (was 50 — too rigid)
  const ivHigh            = ivRank >= 70;         // aggressive credit sizing
  const vixFloor          = vix >= 25 || (skewElevated && vix >= 22); // structural floor
  const vixEnhanced       = vix >= 27;            // extra confirmation when IVR borderline
  const creditAllowedVIX  = (ivElevated && vixFloor) && (ivRank >= 50 || vixEnhanced); // IVR>=50 OR (IVR>=45 AND VIX>=27)

  // ── Credit mode flags ─────────────────────────────────────
  // Credit PUT: direction is uncertain (choppy) OR bear regime with elevated premium
  //   Professional: selling puts below a confirmed downtrend is a high-probability
  //   premium collection trade when IVR is elevated — the trend provides directional
  //   confirmation and fear premium provides the edge (Sosnoff/tastytrade 2014)
  const creditPutActive  = (agentChoppy || agentSaysCredit ||
                            (isBearRegime && creditAllowedVIX)) && vixFloor;

  // Credit CALL: bear regime + elevated IV — sell calls above a falling market
  //   Professional: bear call spreads in confirmed downtrends capture doubly elevated
  //   premium — both trend direction and elevated IV align with the position
  const spyNearResistance = (() => {
    const res = agentMacro.keyLevels?.spyResistance;
    return res && state._liveSPY ? Math.abs(state._liveSPY - res) / res < 0.015 : false;
  })();
  const creditCallActive = ((agentChoppy && vixFloor && spyNearResistance) ||
                            (isBearRegime && creditAllowedVIX));

  // ── Minimum scores by regime ──────────────────────────────
  // Regime A: puts fight the uptrend — need RSI overbought signal, high bar
  // Regime B: puts align with trend — lower bar, but still need clear signal
  // Credits: defined-risk structure lowers bar — premium collection not directional
  const minScorePut    = isBullRegime ? 85 : 70;
  const minScoreCall   = isBullRegime ? 75 : 85;
  const minScoreCredit = 65;
  // Low confidence raises bar — less willing to enter without clear signal
  // High confidence does NOT lower bar — score carries conviction (RM panel)
  const agentMinAdj    = isLowConf ? +10 : 0;

  // ── Gate flags — regime-tagged ────────────────────────────
  const gates = {
    // [All regimes] Hard stops
    choppyDebitBlock:    agentChoppy,
    crisisDebitBlock:    isCrisis,
    macroBullishBlock:   isMacroBullish,
    below200MACallBlock: !!(state._spyMA200 && state._liveSPY && state._liveSPY < state._spyMA200),

    // [Regime A only] — not applicable in bear/crisis
    spyGapUpBlockPuts:   !!(state._spyGapUp && isBullRegime),
    afternoonMinActive:  isBullRegime,   // late-day risk reduction in bull only
    macdContradictsGate: isBullRegime,   // MACD contradiction only meaningful in A

    // [Regime B specific]
    putsOnBounceMode:    isBearRegime && agentPutsOnBounce,
    oversoldSizeReduce:  isBearRegime,   // 0.75x when daily RSI <= 40

    // [Mode flags]
    creditPutActive,
    creditCallActive,
    avoidHoldActive:     !!(state._avoidUntil && Date.now() < state._avoidUntil),
    agentStale,
    vixFallingPause:     !!(state._vixFallingPause),
    postReversalBlock:   !!(state._macroReversalAt &&
                           (Date.now() - state._macroReversalAt) < 30 * 60 * 1000),
  };

  // ── Sizing multipliers ────────────────────────────────────
  // Change 4 (GS/VS + Natenberg Ch.8): ivBoost now gated by portfolio vega cap
  //   The boost is valid — sell more when premium is rich — but must be checked
  //   against maxPortfolioVega before applying. ivBoostCredit is the CANDIDATE
  //   multiplier; actual application requires vega check in server.js execution.
  // Change 5 (TR/Kelly): crisis base sizing 0.5x — defined-risk but gap risk real in C
  const sizeMult = {
    base:          isCrisis ? 0.5 : 1.0,
    ivBoostCredit: ivHigh   ? 1.5 : 1.0,  // only applied when under vega cap
    ivBoostDebit:  1.0,                    // never boost debit size in high IV
    oversold:      0.75,                   // RSI <= 40 in Regime B
    creditCrisis:  isCrisis && ivHigh ? 0.75 : isCrisis ? 0.5 : 1.0,
  };

  // ── Spread structure — professionally calibrated ──────────
  // Change 1 (PM2/CBOE + QS): OTM% calibrated to match delta 0.15-0.20 target.
  //   CORRECTED: prior values (8-11% OTM) were based on a wrong formula.
  //   At VIX 29, 21 DTE, Black-Scholes gives:
  //     5% OTM = delta -0.21   |   6% OTM = delta -0.17   |   7% OTM = delta -0.13
  //   Professional target delta 0.15-0.20 = 5-6% OTM at VIX ~29.
  //   Regime C (crisis, VIX 35+): 6-7% OTM at higher vol still hits delta 0.15-0.17.
  // Black-Scholes verified at VIX 29, 21 DTE:
  //   4% OTM = delta -0.25  |  5% OTM = delta -0.21  |  6% OTM = delta -0.17
  // Target delta 0.15-0.20 on short leg.
  // With minCreditRatio now 0.25, need 5-6% OTM spread to collect enough premium.
  const creditOTMpct = isCrisis     ? 0.06          // C: VIX 35+, 6% OTM ~ delta 0.17-0.20
                     : isBearRegime ? (vix >= 35 ? 0.06 : 0.05)  // B: 5-6% OTM ~ delta 0.17-0.21
                     : 0.04;                         // A: 4% OTM ~ delta 0.25, mean rev

  // Panel correction (CRITICAL #1): minCreditRatio raised 0.20 → 0.25.
  //   EV math: at delta 0.20 (80% win rate): EV = 0.80*0.20 - 0.20*0.80 = 0.00 (breakeven).
  //   Need >20% R/R for positive EV after commissions and slippage.
  //   0.25 floor provides ~4% EV buffer above breakeven at delta 0.20.
  //   Breakeven R/R formula: loss_prob / win_prob = delta / (1-delta)
  //   At delta 0.20: breakeven = 0.20/0.80 = 25%. So 0.25 is the TRUE minimum.
  const minCreditRatio  = 0.25;  // floor — EV-positive minimum at delta 0.20 (panel CRITICAL #1)
  const targetCreditRatio = 0.30; // target — seek 30% when conditions allow

  // Change 3 (OT + Natenberg 1994 Ch.8): DTE targets per regime
  //   Theta accelerates sharply inside 21 DTE — capture the theta curve
  //   efficiently. Vega exposure per dollar of premium collected is minimized
  //   in the 21-28 DTE window. Never open credit spreads with < 14 DTE
  //   (gamma risk dominates — small moves cause large P&L swings).
  const targetDTE = isCrisis     ? 14   // C: richest premium, shortest exposure
                  : isBearRegime ? 21   // B: optimal theta/vega ratio window
                  : 28;                 // A: longer hold, mean reversion needs time
  const minDTE    = isCrisis     ? 7    // C: accept shorter in crisis premium richness
                  : 14;                 // B+A: below 14 DTE gamma risk unacceptable

  // Short delta target for credit spread short leg (QS/PM2):
  //   Professional range: 0.15-0.25. At 5% OTM, VIX 29, 21 DTE: delta = 0.21.
  //   Raised ceiling from 0.20 to 0.25 — the 0.20 ceiling rejected valid 5% OTM contracts.
  //   Black-Scholes verified: 5% OTM at 14 DTE = 0.17, at 21 DTE = 0.21, at 28 DTE = 0.24.
  //   All of these are in the professional range and should be accepted.
  const shortDeltaTarget = isCrisis ? 0.17 : 0.20;  // center — 5% OTM at 21 DTE
  const shortDeltaMax    = 0.25;                      // ceiling raised: covers 5% OTM at 28 DTE
  const shortDeltaMin    = 0.12;                      // floor — below this too little premium

  // Change 4 (GS/VS): portfolio vega cap
  //   $300 per VIX point total portfolio vega. At 3 positions each with $120 vega,
  //   portfolio vega = $360/VIX pt — above cap. ivBoost blocked until under 50% cap.
  //   Formula: vega cap = $300/VIX pt. ivBoost threshold = $150/VIX pt.
  const maxPortfolioVega   = 300;   // $ per VIX point — portfolio-level ceiling
  const ivBoostVegaThresh  = 150;   // $ per VIX point — ivBoost only below this

  const spreadParams = {
    // Debit spread parameters
    debitWidth:        vix >= 35 ? 20 : vix >= 25 ? 15 : 10,
    maxDebitRatio:     0.40,

    // Credit spread parameters — professionally calibrated
    creditWidth:       isCrisis ? 7 : 15,
    creditOTMpct,
    minCreditRatio,
    targetCreditRatio,

    // DTE management (Change 3)
    targetDTE,
    minDTE,

    // Short leg delta targeting (Change 1 — PM2/QS)
    shortDeltaTarget,
    shortDeltaMax,
    shortDeltaMin,

    // Vega exposure management (Change 4 — GS/VS + Natenberg)
    maxPortfolioVega,
    ivBoostVegaThresh,
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
    creditAllowedVIX,
    agentSig,
    agentConf,
    agentBias,
    agentStale,
    agentPutsOnBounce,
    agentMinAdj,
    gates,
    sizeMult,
    spreadParams,
    correlatedGroups: CORRELATED_GROUPS,
    instrumentConstraints: INSTRUMENT_CONSTRAINTS,
    minScorePut,
    minScoreCall,
    minScoreCredit,
    baseMinScore: BASE_MIN_SCORE,
  };
}

// ============================================================
// 2. SCORE CANDIDATE
// Takes pre-computed raw scores from scoreIndexSetup/scorePutSetup,
// applies regime-aware modifiers, locks tradeIntent at score time.
// ============================================================
function scoreCandidate(stock, rawPutScore, rawCallScore, putReasons, callReasons, signals, rulebook, state) {
  const rb      = rulebook;
  const ticker  = stock.ticker;
  const isIndex = stock.isIndex || false;

  // ── Base scores ───────────────────────────────────────────
  let putScore  = Math.min(SCORE_CAP, Math.max(0, rawPutScore));
  let callScore = Math.min(SCORE_CAP, Math.max(0, rawCallScore));

  // ── Direction first — score determines optionType ─────────
  const optionType = putScore >= callScore ? "put" : "call";

  // ── Trade type — instrument constraints override credit mode ─
  // Instrument constraints checked first: XLE allows debit_put only,
  // so credit mode never applies to XLE regardless of rulebook state
  const instrConstraint = rb.instrumentConstraints[ticker];
  const allowsCredit    = !instrConstraint || instrConstraint.allowedTypes.some(t => t.startsWith("credit"));
  let tradeType;
  // TODO #5 FIX: Iron condor now reachable — activates when regime is choppy + IVR >= 60
  // Choppy regime = no clear directional bias = ideal for premium collection on both sides
  // IVR >= 60 = elevated IV makes both legs rich enough to collect meaningful premium
  const isChoppy     = (rb.regimeName || "").includes("choppy") || rb.isChoppy;
  const ironCondorOk = isIndex && isChoppy && rb.ivRank >= 60 && allowsCredit && !stock.isMeanReversion;
  if (stock.isMeanReversion)
    tradeType = "debit_naked";
  else if (ironCondorOk && instrConstraint?.allowedTypes?.includes("iron_condor"))
    tradeType = "iron_condor";
  // Use rb.creditAllowedVIX which respects the lowered 45 threshold with VIX belt (Fix #13)
  else if (optionType === "put" && rb.gates.creditPutActive && isIndex && rb.creditAllowedVIX && allowsCredit)
    tradeType = "credit_put";
  else if (optionType === "call" && rb.gates.creditCallActive && isIndex && allowsCredit)
    tradeType = "credit_call";
  else
    tradeType = optionType === "put" ? "debit_put" : "debit_call";

  // ── Regime score modifiers (applied after tradeType known) ──
  // SPY recovering penalty:
  //   Debit put:   -20 (recovery fights the directional thesis)
  //   Credit put:  +0  (recovery moves short put further OTM — beneficial)
  //   Puts_on_bounces: +0 (recovery IS the entry signal — fade the bounce)
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
  // Change 4 (GS/VS): ivBoost is a CANDIDATE multiplier
  //   Actual application requires checking portfolio vega against maxPortfolioVega
  //   in server.js executeCreditSpread. The sizeMod here is pre-vega-check.
  const dailyRsi      = signals.dailyRsi || signals.rsi || 50;
  const oversoldInBear = rb.gates.oversoldSizeReduce && dailyRsi <= 40 && optionType === "put";
  const isCrisis      = rb.isCrisis;
  const isCredit      = tradeType.startsWith("credit");
  const ivBoost       = isCredit ? rb.sizeMult.ivBoostCredit : rb.sizeMult.ivBoostDebit;
  const crisisAdj     = isCrisis && isCredit ? rb.sizeMult.creditCrisis : rb.sizeMult.base;
  const sizeMod       = crisisAdj * ivBoost * (oversoldInBear ? rb.sizeMult.oversold : 1.0);

  // Change 5 (TR): correlated heat multiplier
  //   SPY and QQQ count as 1.5x combined heat — their 0.95 correlation means
  //   holding both simultaneously is effectively one directional bet
  const corrGroup    = rb.correlatedGroups.find(g => g.tickers.includes(ticker));
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
    heatMultiplier,  // 1.5 for SPY/QQQ, 1.0 for others
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
// Single pass/fail gate check. All gate logic lives here.
// One place, one decision. evaluateEntry is the authority.
// ============================================================
function evaluateEntry(candidate, rulebook, state, context = {}) {
  const rb  = rulebook;
  const g   = rb.gates;
  const {
    ticker, optionType, tradeType, score,
    constraintPass, constraintReason,
  } = candidate;

  const etHour     = context.etHour   || 12;
  const isLateDay  = etHour >= 14.5;
  const signals    = context.signals  || {};
  const dailyRsi   = signals.dailyRsi || signals.rsi || 50;
  const macdSignal = signals.macd     || "neutral";
  const macdBullish = macdSignal.includes("bullish");
  const macdBearish = macdSignal.includes("bearish");

  // ── Hard blocks — always apply regardless of score ────────
  if (!constraintPass)
    return { pass: false, reason: constraintReason };
  if (g.avoidHoldActive)
    return { pass: false, reason: "avoid hold active" };
  if (g.macroBullishBlock && optionType === "put")
    return { pass: false, reason: "macro aggressive — puts blocked" };

  // ── Put-specific blocks ───────────────────────────────────
  if (optionType === "put") {
    if (g.crisisDebitBlock && !tradeType.startsWith("credit"))
      return { pass: false, reason: "Regime C — debit puts blocked, credit structures only" };
    if (g.choppyDebitBlock && !tradeType.startsWith("credit"))
      return { pass: false, reason: "agent:none — debit puts blocked, credit mode only" };
    if (g.spyGapUpBlockPuts)
      return { pass: false, reason: "SPY gap-up — puts paused in Regime A (mean reversion thesis weakened)" };
    if (g.vixFallingPause)
      return { pass: false, reason: "VIX falling — IV crush risk, debit puts lose value as vol compresses" };
    if (g.postReversalBlock)
      return { pass: false, reason: "post-reversal cooldown — 30min re-entry block (macro-reversal pattern)" };
  }

  // ── Call-specific blocks ──────────────────────────────────
  if (optionType === "call") {
    if (g.below200MACallBlock && !tradeType.startsWith("credit"))
      return { pass: false, reason: "SPY below 200MA — debit calls fight the trend in Regime B" };
    if (g.crisisDebitBlock && !tradeType.startsWith("credit"))
      return { pass: false, reason: "Regime C — debit calls blocked" };
  }

  // ── Stagger gate ──────────────────────────────────────────
  // Prevents pile-ons: entering same-ticker same-direction within 30min
  // requires existing position to be profitable (thesis confirmation)
  // Panel M3: stagger gate threshold split by trade type.
  // Debit spreads: 5% profit = meaningful confirmation (spread moved $0.30+ on a $6 spread).
  // Credit spreads: pnlPct is NEGATIVE when profitable (spread value decays toward 0).
  //   For credit, profit = (premium - currentSpreadValue). 5% on pnlPct = noise within bid-ask.
  //   Use maxProfitPct (% of max profit earned) instead. 15% of max profit = genuine confirmation.
  // existingProfitPct: for debit = positive when profitable. For credit = negative (inverted).
  // existingCreditProfitPct: provided by context as (premium - currentValue) / maxProfit.
  const recentSameDir = context.recentSameDir ?? null;
  if (recentSameDir !== null && recentSameDir < 30) {
    const isCredit = tradeType && tradeType.startsWith("credit");
    if (isCredit) {
      // Credit: use % of max profit earned (positive when profitable)
      const creditProfitPct = context.existingCreditProfitPct ?? 0;
      if (creditProfitPct < 0.15)
        return { pass: false, reason: `stagger — ${recentSameDir.toFixed(0)}min since last credit ${optionType} on ${ticker} (need 30min gap or >15% of max profit to add)` };
    } else {
      // Debit: standard pnlPct (positive when profitable)
      const existingProfit = context.existingProfitPct ?? 0;
      if (existingProfit < 0.05)
        return { pass: false, reason: `stagger — ${recentSameDir.toFixed(0)}min since last ${optionType} on ${ticker} (need 30min gap or >5% profit to add)` };
    }
  }

  // ── Effective minimum score ───────────────────────────────
  // Regime B debit puts in puts_on_bounces mode: structural regime conviction replaces
  // the RSI overbought signal that score minimum was designed to ensure.
  // Lower to 65 (same as credit) — regime provides the edge, not just RSI.
  const isPutsOnBouncesDebit = tradeType === "debit_put"
    && (rb.regimeClass === "B" || rb.regimeClass === "C")
    && rb.gates.putsOnBounceMode;
  let minScore = tradeType.startsWith("credit")   ? rb.minScoreCredit
               : isPutsOnBouncesDebit             ? rb.minScoreCredit  // 65 in Regime B fade mode
               : optionType === "put"             ? rb.minScorePut
               : rb.minScoreCall;

  // Agent confidence raises bar when weak — does not lower when strong
  minScore = Math.max(0, minScore + rb.agentMinAdj);

  // Afternoon minimum [Regime A only]
  // Late-day entries in bull market have elevated overnight gap risk
  // In Regime B, afternoon is when bounces run out of steam — best put timing
  // Afternoon minimum: Regime A only, debit puts/calls only
  // Credit spreads don't have overnight gap risk (defined risk structure)
  // and don't need the afternoon bar raise
  const isCredit = tradeType && tradeType.startsWith("credit");
  if (g.afternoonMinActive && isLateDay && !isCredit) {
    const afternoonMin = rb.vix >= 30 ? 90 : rb.vix >= 25 ? 85 : minScore;
    minScore = Math.max(minScore, afternoonMin);
  }

  // MACD contradiction [Regime A only]
  // In bear/crisis regimes, macdContradictsGate=false — entire check skipped
  // MS panel: genuine contradiction requires both MACD opposing AND RSI < 65
  // If RSI >= 65, the stock is extended — a put is a fade, not a contradiction
  if (g.macdContradictsGate) {
    const genuineContradiction = (optionType === "put" && macdBullish && dailyRsi < 65)
                               || (optionType === "call" && macdBearish);
    if (genuineContradiction) minScore = Math.max(minScore, 85);
  }

  // Drawdown protocol (explicit context param — no hidden state dependency)
  const ddMinScore = context.drawdownMinScore ?? BASE_MIN_SCORE;
  minScore = Math.max(minScore, ddMinScore);

  if (score < minScore)
    return { pass: false, reason: `score ${score} below min ${minScore}`, minScore };

  return { pass: true, minScore, tradeType, optionType };
}

// ── Exports ───────────────────────────────────────────────────
module.exports = { getRegimeRulebook, scoreCandidate, evaluateEntry, INSTRUMENT_CONSTRAINTS, CORRELATED_GROUPS };
