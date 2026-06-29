// scoring.js — ARGO V3.2
// All entry scoring: index spreads, put setups, mean reversion calls.
// scoreIndexSetup reads state for VIX history, breadth, regime data.
'use strict';

const SEMIS = ["NVDA", "AMD", "SMCI", "ARM", "AVGO", "MU"]; // semiconductor group for sector ETF check
let _prevMacroSignal = null; // tracks previous macro signal for shift detection
const MACRO_TIERS = { strongly_bearish: -20, bearish: -10, mild_bearish: -5, neutral: 0, mild_bullish: 5, bullish: 10, strongly_bullish: 20 };

const { getStockBars }                    = require('./broker');
const { state, logEvent, markDirty }      = require('./state');

const { MIN_SCORE, MIN_SCORE_CREDIT ,
  ANTHROPIC_API_KEY
,
  INDIVIDUAL_STOCKS_ENABLED
,
  MR_BOUNCE_RSI_OFFLOW = 6, MR_BOUNCE_VWAP_TOL = 0.004,
  MR_INTRA_LIFTOFF_PTS = 4, MR_INTRA_SESSLOW_MAX = 35,
  MR_FLUSH_DD1 = 0.005, MR_FLUSH_DD2 = 0.009, MR_FLUSH_DD3 = 0.015,
  MR_SESSLOW_RECENCY_MIN = 60,
  IVP_CALL_PENALTY_STEEP = false, DIP_REQUIRES_MULTIDAY_ANCHOR = false, DIP_MAX_DAYCHANGE = 0.003,
  MR_INTRADAY_OVERSOLD = false,
  OVERSOLD_CALL_NEEDS_CORROBORATION = false, CORROBORATION_MAX_BREADTH = 45,
  MACD_CURL_SCORING = true   // V3.2 (6/19) Phase-1 curl: default ON; add MACD_CURL_SCORING:false to constants.js to disable
}     = require('./constants');
const { calcADX, getETTime } = require('./signals');
const { setCache } = require('./market');

// ─── Injected dependencies ───────────────────────────────────────
let _triggerRescore = () => {};
let _log = (type, msg) => logEvent(type, msg);
function initScoring({ triggerRescore } = {}) {
  if (triggerRescore) _triggerRescore = triggerRescore;
}

function getRegimeModifier(regime, optionType) {
  const modifiers = {
    trending_bull: { call: 15,  put: -15 },
    trending_bear: { call: -15, put: 15  },
    choppy:        { call: -10, put: -10 },
    breakdown:     { call: -25, put: 10  },
    neutral:       { call: 0,   put: 0   },
    unknown:       { call: 0,   put: 0   },
  };
  return (modifiers[regime] || modifiers.neutral)[optionType] || 0;
}

async function detectMarketRegime() {
  try {
    const bars  = await getStockBars("SPY", 60);
    if (bars.length < 50) return { regime: "unknown", confidence: 0, details: {} };

    const closes  = bars.map(b => b.c);
    const highs   = bars.map(b => b.h);
    const lows    = bars.map(b => b.l);

    const sma20   = closes.slice(-20).reduce((s, c) => s + c, 0) / 20;
    const sma50   = closes.slice(-50).reduce((s, c) => s + c, 0) / 50;
    const current = closes[closes.length - 1];
    const adx     = calcADX(bars);

    const returns  = closes.slice(-20).map((c, i) => i > 0 ? Math.log(c / closes[closes.length - 21 + i]) : 0).slice(1);
    const stdDev   = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) * Math.sqrt(252) * 100;

    const mom5   = (current - closes[closes.length - 5])  / closes[closes.length - 5]  * 100;
    const mom20  = (current - closes[closes.length - 20]) / closes[closes.length - 20] * 100;

    let regime, confidence, action;

    if (current > sma20 && sma20 > sma50 && adx > 25 && mom20 > 2) {
      regime     = "trending_bull";
      confidence = Math.min(100, Math.round(adx + mom20 * 3));
      action     = "Full position sizing. Favor calls. Aggressive entries.";
    } else if (current < sma20 && sma20 < sma50 && adx > 25 && mom20 < -2) {
      regime     = "trending_bear";
      confidence = Math.min(100, Math.round(adx + Math.abs(mom20) * 3));
      action     = "Reduced sizing. Favor puts. Avoid new calls.";
    } else if (adx < 20 && stdDev < 15) {
      regime     = "choppy";
      confidence = Math.min(100, Math.round((20 - adx) * 3));
      action     = "Minimal entries. Wait for breakout. Tighten stops.";
    } else if (mom5 < -3 && stdDev > 25) {
      regime     = "breakdown";
      confidence = Math.min(100, Math.round(stdDev + Math.abs(mom5) * 5));
      action     = "Defensive mode. Close calls. Consider puts only.";
    } else {
      regime     = "neutral";
      confidence = 50;
      action     = "Normal operations. Standard position sizing.";
    }

    return {
      regime, confidence, action,
      details: { sma20: sma20.toFixed(2), sma50: sma50.toFixed(2), adx: adx.toFixed(1), stdDev: stdDev.toFixed(1), mom5: mom5.toFixed(1), mom20: mom20.toFixed(1), current: current.toFixed(2) }
    };
  } catch(e) { return { regime: "unknown", confidence: 0, action: "Normal operations.", details: {} }; }
}

function applyIntradayRegimeOverride(newMacro) {
  const dayPlanRegime  = (state._dayPlan || {}).regime    || "neutral";
  const intradaySignal = (newMacro || {}).signal           || "neutral";
  const intradayRegime = (newMacro || {}).regime           || "neutral";
  const confidence     = (newMacro || {}).confidence       || "low";

  const dayPlanBias = (state._dayPlan || {}).entryBias || "neutral";
  const regimeChanged = dayPlanRegime !== intradayRegime;
  const biasChanged   = dayPlanBias   !== newMacro.entryBias;
  const biasFliped    = biasChanged &&
                        ((dayPlanBias === "calls_on_dips" && newMacro.entryBias === "puts_on_bounces") ||
                         (dayPlanBias === "puts_on_bounces" && newMacro.entryBias === "calls_on_dips") ||
                         (newMacro.entryBias === "avoid"));
  const strongShift   = (confidence === "high" && regimeChanged && biasChanged) || biasFliped;
  const extremeShift = ["strongly bearish","strongly bullish"].includes(intradaySignal);

  const prevOverrideAt = state._dayPlan?._overrideAt;
  const overrideAge = prevOverrideAt ? (Date.now() - new Date(prevOverrideAt).getTime()) / 3600000 : 99;
  const overrideExpired = overrideAge >= 2.0;

  if ((strongShift || extremeShift) && overrideExpired) {
    state._dayPlan = {
      ...(state._dayPlan || {}),
      regime:    intradayRegime,
      entryBias: newMacro.entryBias || state._dayPlan?.entryBias || "neutral",
      tradeType: newMacro.tradeType || state._dayPlan?.tradeType || "spread",
      _intradayOverride: true,
      _overrideAt: new Date().toISOString(),
    };
    markDirty();
    logEvent("macro", `[REGIME OVERRIDE] ${dayPlanRegime}-${intradayRegime} / ${dayPlanBias}-${newMacro.entryBias} (${confidence} confidence)`);
  } else if ((strongShift || extremeShift) && !overrideExpired) {
    logEvent("macro", `[REGIME OVERRIDE] Skipped - previous override still active (${overrideAge.toFixed(1)}h ago)`);
  }
}

function updateOversoldTracker(ticker, dailyRsi) {
  if (!state._oversoldCount) state._oversoldCount = {};
  if (!state._oversoldDate)  state._oversoldDate  = {};
  const today = getETTime().toISOString().slice(0, 10);
  const lastDate = state._oversoldDate[ticker] || '';
  if (dailyRsi <= 35) {
    if (lastDate !== today) {
      state._oversoldCount[ticker] = (state._oversoldCount[ticker] || 0) + 1;
      state._oversoldDate[ticker]  = today;
    }
  } else {
    state._oversoldCount[ticker] = 0;
    state._oversoldDate[ticker]  = '';
  }
  return state._oversoldCount[ticker] || 0;
}

function recordGateBlock(ticker, gate, regime, score) {
  if (!state._gateAudit) state._gateAudit = [];
  state._gateAudit.push({ ts: Date.now(), ticker, gate, regime, score });
  if (state._gateAudit.length > 100) state._gateAudit = state._gateAudit.slice(-100);
}

function checkMacroShift(newSignal) {
  if (!newSignal || !ANTHROPIC_API_KEY) return;
  const prevTier = MACRO_TIERS[_prevMacroSignal] ?? 3;
  const newTier  = MACRO_TIERS[newSignal] ?? 3;
  const shift    = Math.abs(newTier - prevTier);
  if (shift >= 2) {
    const direction = newTier < prevTier ? "bearish shift" : "bullish shift";
    logEvent("warn", `[MACRO] Signal shift: ${_prevMacroSignal} - ${newSignal} (${direction}) - triggering position rescores`);
    const positions = state.positions || [];
    Promise.allSettled(
      positions.map(pos => _triggerRescore(pos, `macro-shift: ${_prevMacroSignal}-${newSignal}`))
    );
  }
  _prevMacroSignal = newSignal;
}

async function checkSectorETF(stock) {
  const etfMap = { "Technology":"XLK", "Financial":"XLF", "Consumer":"XLY" };
  const etfs   = [];

  if (etfMap[stock.sector]) etfs.push(etfMap[stock.sector]);
  if (SEMIS.includes(stock.ticker)) etfs.push("SMH");
  if (!etfs.length) return { pass: true, reason: null, putBoost: 0 };

  const allEtfBars = await Promise.all(etfs.map(etf => getStockBars(etf, 5)));
  for (let i = 0; i < etfs.length; i++) {
    const etf  = etfs[i];
    const bars = allEtfBars[i];
    if (bars.length < 2) continue;
    const etfReturn = (bars[bars.length-1].c - bars[0].o) / bars[0].o;
    if (etfReturn < -0.015) {
      return { pass: false, reason: `${etf} sector ETF down ${(etfReturn*100).toFixed(1)}% - sector headwind`, putBoost: 20, etfReturn };
    } else if (etfReturn < -0.01) {
      return { pass: false, reason: `${etf} sector ETF down ${(etfReturn*100).toFixed(1)}% - sector headwind`, putBoost: 12, etfReturn };
    }
  }
  return { pass: true, reason: null, putBoost: 0 };
}

function isGLDEntryAllowed(optionType, dxy, spyReturn5d, vix, gldRSI, gldPrice, gldMA20,
                           sessionMins, momentum, gld5dReturn, gldDailyRSI,
                           macdCrossoverDays, volPaceRatio, gldVWAP, gldMA20live) {
  if (optionType === "call") {
    const _dxyTrend = dxy?.trend || 'neutral';
    const _dxyChange = dxy?.change || 0;
    const dxyStrengthening = _dxyTrend === 'strengthening' && _dxyChange > 0.5;
    if (dxyStrengthening) return { allowed: false, reason: `GLD call blocked — DXY trend:strengthening +${_dxyChange.toFixed(2)}% 5d (dollar headwind for gold)` };

    if (vix < 20) return { allowed: false, reason: `GLD call blocked — VIX ${vix?.toFixed(1)} < 20 (need macro uncertainty for gold catalyst)` };

    const _dailyRSI = gldDailyRSI ?? gldRSI ?? 50;
    const _inNoTradeZone = _dailyRSI >= 32 && _dailyRSI < 55;
    if (_inNoTradeZone) return { allowed: false, reason: `GLD call blocked — dailyRSI ${_dailyRSI.toFixed(1)} in no-trade zone (32-55), need < 32 oversold or >= 55 bullish` };

    if (_dailyRSI < 32) {
      if (momentum !== 'recovering') return { allowed: false, reason: `GLD call blocked — oversold path (dailyRSI ${_dailyRSI.toFixed(1)}) requires MOM:recovering, got MOM:${momentum} (wait for price to stabilize)` };
    } else {
      const _aboveVWAP  = gldVWAP > 0 && gldPrice > gldVWAP;
      const _aboveMA20  = gldMA20live > 0 && gldPrice > gldMA20live;
      if (!_aboveVWAP)  return { allowed: false, reason: `GLD call blocked — momentum path (dailyRSI ${_dailyRSI.toFixed(1)}) requires price above VWAP (intraday trend not intact)` };
      if (!_aboveMA20)  return { allowed: false, reason: `GLD call blocked — momentum path (dailyRSI ${_dailyRSI.toFixed(1)}) requires price above 20MA (daily trend not intact)` };
    }

    if (gld5dReturn !== null && gld5dReturn !== undefined) {
      const _freefalling   = gld5dReturn < -0.05;
      const _dxyReversal   = _dxyTrend === 'weakening';
      if (_freefalling && !_dxyReversal) return { allowed: false, reason: `GLD call blocked — 5-day return ${(gld5dReturn*100).toFixed(1)}% < -5% with no DXY reversal (accelerating decline, no catalyst)` };
      if (_freefalling && _dxyReversal)  logEvent && logEvent('filter', `[GLD FREEFALL SUSPENDED] 5d return ${(gld5dReturn*100).toFixed(1)}% < -5% but DXY weakening — macro reversal catalyst present, gate suspended`);
    }

    if (sessionMins !== null && sessionMins !== undefined && sessionMins < 60) {
      return { allowed: false, reason: `GLD call blocked — session only ${sessionMins.toFixed(0)}min old (need 60min for macro flows to settle)` };
    }

    if (momentum !== 'recovering') return { allowed: false, reason: `GLD call blocked — MOM:${momentum} (only MOM:recovering allowed — need confirmed price stabilization before entry)` };

    if (macdCrossoverDays !== null && macdCrossoverDays !== undefined) {
      if (macdCrossoverDays > 3) return { allowed: false, reason: `GLD call blocked — MACD bullish crossover ${macdCrossoverDays.toFixed(1)} days old (> 3d stale, no confirming rally — signal may have failed)` };
    }

    return { allowed: true };
  } else {
    const gldOverbought  = gldRSI >= 65;
    const gldFalling     = gldRSI !== null && gldRSI < 50 && gldMA20 > 0 && gldPrice < gldMA20;
    const dxyRising      = dxy && dxy.change > 0;
    const isGLDCreditPut = false;
    const gldPutAllowed = gldOverbought || gldFalling || isGLDCreditPut;
    if (!gldPutAllowed) return { allowed: false, reason: `GLD put blocked - RSI ${gldRSI?.toFixed(0)||'?'} not overbought and GLD not in downtrend (need RSI>65 or GLD below 20MA)` };
    return { allowed: true };
  }
}

function isXLEEntryAllowed(optionType, xleRSI, xleMomentum, vix, xlePrice, xleMA20, xleDailyRSI) {
  if (optionType === "put") {
    if (xleDailyRSI && xleDailyRSI <= 35) return { allowed: false, reason: `XLE put blocked - dailyRSI ${xleDailyRSI?.toFixed(0)} deeply oversold (stock already crashed, put thesis gone)` };
    const dailyRsiOversold = !xleDailyRSI || xleDailyRSI <= 40;
    if (xleRSI && xleRSI <= 35 && dailyRsiOversold) return { allowed: false, reason: `XLE put blocked - RSI ${xleRSI?.toFixed(0)} intraday oversold + dailyRSI ${xleDailyRSI?.toFixed(0)||"?"} confirms trend exhaustion` };
    if (xleRSI && xleRSI <= 35 && !dailyRsiOversold) { logEvent("filter", `XLE intraday RSI ${xleRSI?.toFixed(0)} oversold but dailyRSI ${xleDailyRSI?.toFixed(0)} valid — intraday noise, allowing put entry`); }
    const xleAbove20MA = xleMA20 > 0 && xlePrice > xleMA20 * 1.03;
    if (xleAbove20MA) return { allowed: false, reason: `XLE put blocked - price $${xlePrice?.toFixed(2)} >3% above 20MA $${xleMA20?.toFixed(2)} (oil uptrend - don't fade)` };
    return { allowed: true };
  } else {
    if (xleRSI && xleRSI >= 72) return { allowed: false, reason: `XLE call blocked - RSI ${xleRSI?.toFixed(0)} overbought (energy extended - wrong for calls)` };
    const xleBelow20MA = xleMA20 > 0 && xlePrice < xleMA20 * 0.97;
    if (xleBelow20MA) return { allowed: false, reason: `XLE call blocked - price $${xlePrice?.toFixed(2)} >3% below 20MA $${xleMA20?.toFixed(2)} (oil downtrend - don't catch falling knife)` };
    return { allowed: true };
  }
}

function isTLTEntryAllowed(optionType, spyPrice, spyMA50, spyReturn5d, spyMA200, tltRSI, tltMomentum) {
  if (!spyMA50 || spyMA50 === 0) return { allowed: true };
  const spyBelow50MA  = spyPrice < spyMA50;
  const spyBelow200MA = spyMA200 && spyMA200 > 0 && spyPrice < spyMA200;
  const spyWeak       = spyBelow50MA || spyBelow200MA;
  if (optionType === "call") {
    if (!spyWeak) return { allowed: false, reason: `TLT call blocked - SPY $${spyPrice.toFixed(2)} above both 50MA $${spyMA50.toFixed(2)} and 200MA, no equity weakness for bond rally` };
    const maLabel = spyBelow200MA ? "200MA" : "50MA";
    return { allowed: true, reason: `TLT call allowed - SPY below ${maLabel}` };
  } else {
    const tltOverbought = tltRSI && tltRSI >= 65;
    const tltMomentumWeak = tltMomentum && ["recovering", "steady"].includes(tltMomentum);
    const spyRecovering = !spyWeak || spyReturn5d >= 0.01;
    if (spyWeak && !tltOverbought) {
      return { allowed: false, reason: `TLT put blocked - SPY below MA and TLT RSI ${tltRSI || "?"}  not overbought (need RSI >65 for bond-specific put thesis)` };
    }
    if (spyReturn5d < 0.01 && !tltOverbought) {
      return { allowed: false, reason: `TLT put blocked - SPY not recovering (${(spyReturn5d*100).toFixed(1)}% 5d) and TLT not overbought` };
    }
    return { allowed: true, reason: `TLT put allowed - ${tltOverbought ? `TLT RSI ${tltRSI} overbought` : "SPY recovering"}` };
  }
}

function scorePutSetup(stock, relStrength, adx, volume, avgVolume, vix = 20) {
  let score = 0;
  const reasons = [];

  if (stock.momentum === "recovering")       { score += 20; reasons.push("Weak momentum - bearish (+20)"); }
  else if (stock.momentum === "steady")      { score += 0;  reasons.push("Momentum steady - neutral for put (+0)"); }
  else                                       { score += 0;  reasons.push("Strong momentum - bad for put (+0)"); }

  if (stock.rsi >= 72)                       { score += 20; reasons.push(`RSI ${stock.rsi} - overbought (+20)`); }
  else if (stock.rsi >= 65 && stock.rsi < 72){ score += 12; reasons.push(`RSI ${stock.rsi} - elevated (+12)`); }
  else if (stock.rsi <= 35)                  { score -= 30; reasons.push(`RSI ${stock.rsi} - stock already crashed, put thesis gone (-30)`); }
  else if (stock.rsi <= 45)                  { score -= 10; reasons.push(`RSI ${stock.rsi} - oversold, put thesis weak (-10)`); }
  else                                       { reasons.push(`RSI ${stock.rsi} neutral for put (+0)`); }

  if (stock.macd.includes("bearish crossover")) { score += 10; reasons.push("MACD bearish crossover (+10)"); }
  else if (stock.macd.includes("bearish"))      { score += 7;  reasons.push("MACD bearish (+7)"); }
  else if (stock.macd.includes("neutral"))      { score += 3;  reasons.push("MACD neutral (+3)"); }
  else if (stock.macd.includes("bullish crossover")) { score -= 12; reasons.push("MACD bullish crossover - contradicts put (-12)"); }
  else                                          { score -= 8;  reasons.push("MACD bullish - contradicts put (-8)"); }

  const ivpP = stock.ivPercentile || 50;
  const highVIX = vix > 30;
  if (ivpP < 30)       { score += 15; reasons.push(`IVP ${ivpP}% - cheap options (+15)`); }
  else if (ivpP < 50)  { score += 10; reasons.push(`IVP ${ivpP}% - moderate (+10)`); }
  else if (ivpP < 70)  { score += highVIX ? 8 : 5; reasons.push(`IVP ${ivpP}% - elevated (${highVIX ? "+8 high VIX" : "+5"})`); }
  else                 { score += highVIX ? 5 : 0; reasons.push(`IVP ${ivpP}% - expensive (${highVIX ? "+5 high VIX justified" : "+0"})`); }

  const newsMod = stock.newsSentiment === "bearish" ? 15
                : stock.newsSentiment === "mild bearish" ? 8
                : stock.newsSentiment === "neutral" ? 3
                : 0;
  if (newsMod > 0) reasons.push(`News ${stock.newsSentiment} (+${newsMod})`);
  else if (stock.momentum === "recovering" && stock.hasIntraday) {
    score += 8; reasons.push("Intraday confirmed bearish move (+8)");
  }
  score += newsMod;

  const belowVWAP = stock.intradayVWAP > 0 && (stock.price || 0) < stock.intradayVWAP;
  if (volume && avgVolume && volume > avgVolume * 1.2) {
    const volPts = belowVWAP ? 12 : 8;
    score += volPts; reasons.push(`Above-avg volume ${belowVWAP ? "+ below VWAP" : ""} (+${volPts})`);
  } else if (volume && avgVolume && volume > avgVolume) {
    score += 5; reasons.push("Average volume (+5)");
  } else { reasons.push("Low volume (+0)"); }

  let spyWeakPts = 0;
  if (relStrength < 0.93)      { spyWeakPts = 15; reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+15)`); }
  else if (relStrength < 0.97) { spyWeakPts = 8;  reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+8)`); }
  else if (relStrength < 1.0)  { spyWeakPts = 3;  reasons.push(`Slightly weak vs SPY (+3)`); }
  else                         { reasons.push(`Outperforming SPY - bad for put (+0)`); }
  score += spyWeakPts;

  if (adx && adx > 35)      { score += 15; reasons.push(`ADX ${adx} - very strong downtrend (+15)`); }
  else if (adx && adx > 25) { score += 10; reasons.push(`ADX ${adx} - strong trend (+10)`); }
  else if (adx && adx > 18) { score += 5;  reasons.push(`ADX ${adx} - emerging trend (+5)`); }

  if (stock.rsi <= 35) {
    return { score: 0, reasons };
  }

  const bullishSignals = [
    stock.rsi >= 65,
    stock.macd.includes("bearish"),
    stock.momentum === "recovering",
    (relStrength < 0.97),
    (adx && adx > 25),
    (volume > avgVolume * 1.2),
  ].filter(Boolean).length;
  if (score >= 90 && bullishSignals < 3) {
    score = 80;
    reasons.push(`Score capped at 80 - only ${bullishSignals}/3 required signals agree`);
  }

  const rsiPutSignal  = stock.rsi >= 65;
  const macdPutSignal = stock.macd.includes("bearish");
  if (!rsiPutSignal && !macdPutSignal) {
    score = Math.max(0, score - 15);
    reasons.push("Neither RSI nor MACD confirm put direction (-15)");
  }

  const _sigResult = { score: Math.min(Math.max(score, 0), 95), reasons };
  return _sigResult;
}

function scoreMeanReversionCall(stock, relStrength, adx, bars, vix, intradayBars) {
  let score = 0;
  const reasons = [];

  const inRecoveryRegime = (state._regimeClass === "A") && (state._vixSustained || 0) >= 22;
  const vixFloorMR = inRecoveryRegime ? 20 : 25;
  if (vix < vixFloorMR) return { score: 0, reasons: [`VIX ${vix} too low for mean reversion${inRecoveryRegime ? " (recovery: floor 20)" : " (floor 25)"} (+0)`] };

  // FIX (6/15): exempt indices. SPY's computed liveBeta can dip just under 1.0 and silently
  // zero all SPY mean-reversion calls; the downstream liquidity check already gates on isIndex.
  if (!stock.isIndex && (stock.beta || 1) < 1.0) return { score: 0, reasons: ["Low beta - not a mean reversion candidate (+0)"] };

  // RSI daily-contract enforcement (panel P0): mean-reversion oversold tiers key off DAILY RSI,
  // not the display/timing intraday rsi (signals.js contract). Intraday whipsaw must never authorize entry.
  // RSI oversold tiers. Historically keyed off DAILY RSI only (panel P0 anti-whipsaw). F+G (6/23):
  // when MR_INTRADAY_OVERSOLD is on, a bull_curl-CONFIRMED intraday dip is scored at its intraday
  // depth — so the score scales with how oversold the dip actually is (fixing the flat ~+5 that
  // disqualified QQQ and never rewarded depth). The bull_curl gate is the anti-whipsaw guard the
  // daily contract provided: an unconfirmed intraday spike down still falls back to daily RSI.
  const _mrDailyRSI = stock.dailyRsi || stock.rsi || 50;
  const _mrIntraRSI = (stock.rsi != null) ? stock.rsi : _mrDailyRSI;
  // D2 (6/24) early-turn confirmation. The old gate required a MACD bull_curl, which only sets
  // AFTER the histogram turns up — i.e. after the bounce has begun. On deep intraday dips
  // (RSI 14-30) with neutral daily RSI, that meant the intraday path never engaged, the dip
  // scored on daily RSI (~53 → "not oversold" → score 0, isMeanReversion never set), and the
  // system sat out the exact moment price was most stretched. Replaced with a turn signal that
  // fires DURING the dip: the session reached oversold (low <= MR_INTRA_SESSLOW_MAX) AND intraday
  // RSI has lifted MR_INTRA_LIFTOFF_PTS off its own session low. bull_curl still qualifies (sharp
  // V-bottoms where the curl leads). A knife still making new lows (liftOff ~0, no curl) stays
  // unconfirmed and falls back to daily RSI — preserving the anti-whipsaw guard, without waiting
  // on the lagging curl. Depth tiers below still scale the reward by how oversold it actually is.
  const _mrCurlOK     = (stock.macdCurl || "none") === "bull_curl";
  const _mrSessLowRSI = state._sessionLowRSI?.[stock.ticker] ?? _mrIntraRSI;
  const _mrLiftOff    = _mrIntraRSI - _mrSessLowRSI;
  // 6/25 fix: the session low must be RECENT, else a deep early print (e.g. a stuck 2.2)
  // keeps this gate permanently open all day. _sessionLowRSIAt is the ms timestamp of the low.
  const _mrSessLowAt     = state._sessionLowRSIAt?.[stock.ticker] ?? 0;
  const _mrSessLowAgeMin = _mrSessLowAt ? (Date.now() - _mrSessLowAt) / 60000 : Infinity;
  const _mrLowRecent     = _mrSessLowAgeMin <= MR_SESSLOW_RECENCY_MIN;
  const _mrEarlyTurn  = _mrSessLowRSI <= MR_INTRA_SESSLOW_MAX
                        && _mrLiftOff >= MR_INTRA_LIFTOFF_PTS
                        && _mrLowRecent;
  // Gate visibility (6/25): log whenever the session reached oversold, so a stale low shows
  // up as recent:N earlyTurn:N instead of silently producing no flush line. Fires even when
  // the gate is CLOSED — this is how we verify the recency fix is doing its job.
  if (_mrSessLowRSI <= MR_INTRA_SESSLOW_MAX) {
    reasons.push(
      `[MR-GATE] sessLowRSI ${Number(_mrSessLowRSI).toFixed(1)} liftOff ${Number(_mrLiftOff).toFixed(1)} ` +
      `lowAge ${Number(_mrSessLowAgeMin).toFixed(0)}m recent:${_mrLowRecent ? 'Y' : 'N'} earlyTurn:${_mrEarlyTurn ? 'Y' : 'N'}`
    );
  }
  const _mrConfirmed  = _mrCurlOK || _mrEarlyTurn;
  const _useIntra     = MR_INTRADAY_OVERSOLD && _mrConfirmed && _mrIntraRSI < _mrDailyRSI;
  const _mrRSI      = _useIntra ? _mrIntraRSI : _mrDailyRSI;
  const _mrSrc      = _useIntra ? (_mrCurlOK ? "intraday(curl)" : "intraday(liftoff)") : "dailyRSI";
  if (_mrRSI <= 35)      { score += 20; reasons.push(`${_mrSrc} ${_mrRSI} - deeply oversold (+20)`); }
  else if (_mrRSI <= 42) { score += 12; reasons.push(`${_mrSrc} ${_mrRSI} - oversold (+12)`); }
  else if (_mrRSI <= 48) { score += 5;  reasons.push(`${_mrSrc} ${_mrRSI} - near oversold (+5)`); }
  else return { score: 0, reasons: [`${_mrSrc} ${_mrRSI} not oversold - skip mean reversion`] };

  const oversoldScans = state._oversoldCount ? (state._oversoldCount[stock.ticker] || 0) : 0;
  if (oversoldScans >= 3)      { score += 15; reasons.push(`Oversold ${oversoldScans} consecutive scans - capitulation (+15)`); }
  else if (oversoldScans >= 2) { score += 8;  reasons.push(`Oversold ${oversoldScans} consecutive scans (+8)`); }

  let _dailyDiscount = 0;
  if (bars && bars.length >= 20) {
    const recentHigh = Math.max(...bars.slice(-20).map(b => b.h));
    const currentPrice = bars[bars.length - 1].c;
    const drawdown = (recentHigh - currentPrice) / recentHigh;
    if (drawdown >= 0.20)      { _dailyDiscount = 25; reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high - deep discount (+25)`); }
    else if (drawdown >= 0.12) { _dailyDiscount = 15; reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high - discount (+15)`); }
    else if (drawdown >= 0.07) { _dailyDiscount = 8;  reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high (+8)`); }
    else                       { _dailyDiscount = 0;  reasons.push(`Only down ${(drawdown*100).toFixed(0)}% - not enough discount (+0)`); }
    score += _dailyDiscount;
  }

  // ── Intraday flush discount (6/25) — LIVE (paper). Scores off the newly-bridged
  // intraday series. The daily tier above is blind to intraday flushes (a ~1% session
  // drop never clears its 7% floor → +0 on the deep intraday dips this strategy targets,
  // e.g. the RSI-19.9 SPY setup that died at 48<50 on 6/25). Credit scales with intraday
  // drawdown off the SESSION HIGH; gated on _mrEarlyTurn so a knife still making new lows
  // earns nothing — the RSI gate confirms the session got oversold AND has lifted off
  // (quality), the price drawdown supplies magnitude. Taken as MAX vs the daily discount
  // (same concept, two timeframes, never summed). The D2 falling-knife veto downstream is
  // UNCHANGED and remains the final gate. Thresholds are starting values; tune from the
  // logged [MR-FLUSH] data.
  if (Array.isArray(intradayBars) && intradayBars.length >= 2 && _mrEarlyTurn) {
    const _ibHigh = Math.max(...intradayBars.map(b => b.h));
    const _ibLow  = Math.min(...intradayBars.map(b => b.l));
    const _ibCur  = intradayBars[intradayBars.length - 1].c;
    const _prevClose = (bars && bars.length >= 2) ? bars[bars.length - 2].c : 0;
    const _intraDD = _ibHigh > 0 ? (_ibHigh - _ibCur) / _ibHigh : 0;   // off session high (new-data signal)
    const _sessRng = _ibHigh > 0 ? (_ibHigh - _ibLow) / _ibHigh : 0;
    const _ddPrev  = _prevClose > 0 ? (_prevClose - _ibCur) / _prevClose : 0;
    let _flush = 0;
    if      (_intraDD >= MR_FLUSH_DD3) _flush = 15;
    else if (_intraDD >= MR_FLUSH_DD2) _flush = 10;
    else if (_intraDD >= MR_FLUSH_DD1) _flush = 6;
    const _applied = Math.max(0, _flush - _dailyDiscount);   // max vs daily, no double-count
    if (_applied > 0) score += _applied;
    reasons.push(
      `[MR-FLUSH] intraDD ${(_intraDD*100).toFixed(2)}% offHigh → flush +${_flush} ` +
      `(applied +${_applied} max-vs-daily +${_dailyDiscount}) | sessLowRSI ${Number(_mrSessLowRSI).toFixed(1)} ` +
      `liftOff ${Number(_mrLiftOff).toFixed(1)} | diag ${(_ddPrev*100).toFixed(2)}% vsPrevClose, sessRange ${(_sessRng*100).toFixed(2)}%`
    );
  }

  if (stock.macd.includes("bullish crossover")) { score += 15; reasons.push("MACD bullish crossover - reversal signal (+15)"); }
  else if (stock.macd.includes("bullish"))      { score += 5;  reasons.push("MACD bullish (+5)"); }
  else                                          { reasons.push("MACD bearish - wait for base (+0)"); }

  if (vix >= 35)      { score += 15; reasons.push(`VIX ${vix} - extreme fear, calls historically cheap (+15)`); }
  else if (vix >= 30) { score += 10; reasons.push(`VIX ${vix} - elevated fear (+10)`); }
  else if (vix >= 25) { score += 5;  reasons.push(`VIX ${vix} - moderate fear (+5)`); }

  if (stock.catalyst)  { score += 10; reasons.push(`Recovery catalyst: ${stock.catalyst} (+10)`); }

  if (adx && adx < 20) { score += 10; reasons.push(`ADX ${adx} - weak trend, reversal likely (+10)`); }
  else if (adx && adx < 30) { score += 5; reasons.push(`ADX ${adx} - trend weakening (+5)`); }

  return { score: Math.min(score + 2, 100), reasons, isMeanReversion: true };   // 6/29: global +2 data-gather bump (Harrison)
}

// scoreCreditSpread removed — APEX uses naked options, not credit spreads

function scoreIndexSetup(stock, optionType, spyRSI, spyMACD, spyMomentum, breadth, vix, agentMacro, intradayRsi) {
  let score = 0;
  const reasons = [];

  let _isOverboughtMRPut = false;  // hoisted from the put branch (read at supplement-cap ~L953); optionType-guarded below
  const _agentAcc30  = state._agentAccuracy?.acc30  ?? 50;
  const _agentAccN   = state._agentAccuracy?.calls   ?? 0;
  const _agentDegraded = _agentAccN >= 30 && _agentAcc30 < 25;
  const signal     = _agentDegraded ? "neutral" : ((agentMacro || {}).signal     || "neutral");
  const confidence = _agentDegraded ? "low"     : ((agentMacro || {}).confidence || "low");

  const priceRegimeClass = state._regimeClass || "A";
  const regime = priceRegimeClass === "B" ? "trending_bear"
               : priceRegimeClass === "C" ? "breakdown"
               : "trending_bull";
  const entryBias  = (agentMacro || {}).entryBias  || "neutral";
  const tradeType  = null;
  const rawVixOutlook = (agentMacro || {}).vixOutlook || "unknown";
  const vixOutlook = rawVixOutlook !== "unknown" ? rawVixOutlook
    : vix >= 32 ? "spiking"
    : vix >= 25 ? "elevated_stable"
    : vix >= 20 ? "mean_reverting"
    : "falling";

  let supplementScore = 0;
  let _curlPts = 0;   // V3.2 (6/19) MACD bull-curl pts added to supplementScore (0 or 3) — for cap-aware net
  const SUPP_MAX_AGE_MS = 60 * 60 * 1000;
  const isDataFresh = (data) => data && data.updatedAt && (Date.now() - data.updatedAt) < SUPP_MAX_AGE_MS;

  {
    const pcrData = isDataFresh(state._pcr) ? state._pcr : null;
    if (pcrData) {
      if (optionType === "put") {
        if (pcrData.signal === "extreme_fear")       { supplementScore += 10; reasons.push(`PCR ${pcrData.pcr} - extreme fear, put momentum strong (+10)`); }
        else if (pcrData.signal === "fear")          { supplementScore += 6;  reasons.push(`PCR ${pcrData.pcr} - elevated fear, put bias (+6)`); }
        else if (pcrData.signal === "extreme_greed") { score -= 12; reasons.push(`PCR ${pcrData.pcr} - extreme greed, puts risky (-12)`); }
        else if (pcrData.signal === "greed")         { score -= 6;  reasons.push(`PCR ${pcrData.pcr} - greed, puts less favorable (-6)`); }
      } else {
        const vixFalling = (state._agentMacro?.vixOutlook || "") === "mean_reverting" ||
                           (state._agentMacro?.vixOutlook || "") === "falling";
        const pcrCallOk  = vix < 25 || (vix < 28 && vixFalling);
        if (pcrCallOk) {
          if (pcrData.signal === "extreme_fear")  { supplementScore += 12; reasons.push(`PCR ${pcrData.pcr} - extreme fear = contrarian call (VIX normalizing) (+12)`); }
          else if (pcrData.signal === "fear")     { supplementScore += 6;  reasons.push(`PCR ${pcrData.pcr} - elevated fear, contrarian call (+6)`); }
        } else {
          if (pcrData.signal === "extreme_fear" || pcrData.signal === "fear") {
            reasons.push(`PCR ${pcrData.pcr} - elevated fear but VIX ${vix} too high for contrarian call (+0)`);
          }
        }
        if (pcrData.signal === "extreme_greed") { score -= 10; reasons.push(`PCR ${pcrData.pcr} - extreme greed, calls overextended (-10)`); }
      }
    }

    const ts = isDataFresh(state._termStructure) ? state._termStructure : null;
    if (ts) {
      if (optionType === "put"  && ts.creditFavorable) { supplementScore += 8; reasons.push(`Vol backwardation (${ts.ratio}) - near-term fear premium elevated (+8)`); }
      if (optionType === "call" && ts.callFavorable && (vix || 25) < 24) {
        supplementScore += 8; reasons.push(`Vol contango (${ts.ratio}) - calls relatively cheap at VIX ${vix} (+8)`);
      } else if (optionType === "call" && ts.callFavorable) {
        reasons.push(`Vol contango (${ts.ratio}) - calls not cheap at VIX ${vix} (+0)`);
      }
    }

    const skewData = isDataFresh(state._skew) ? state._skew : null;
    if (skewData) {
      if (optionType === "put") {
        if (skewData.signal === "extreme" && skewData.creditPutIdeal) { supplementScore += 12; reasons.push(`SKEW ${skewData.skew} extreme + VIX elevated - put premium doubly rich (+12)`); }
        else if (skewData.signal === "elevated") { supplementScore += 8; reasons.push(`SKEW ${skewData.skew} elevated - tail risk premium high (+8)`); }
        else if (skewData.signal === "low")      { score -= 5; reasons.push(`SKEW ${skewData.skew} low - tail risk not priced (-5)`); }
      } else {
        if (skewData.signal === "low")      { supplementScore += 8; reasons.push(`SKEW ${skewData.skew} low - tail risk not priced, calls favorable (+8)`); }
        else if (skewData.signal === "extreme") { score -= 8; reasons.push(`SKEW ${skewData.skew} extreme - market fearing tail event, wrong for calls (-8)`); }
      }
    }

    const aaiiData = (state._aaii && state._aaii.updatedAt && (Date.now() - state._aaii.updatedAt) < 8 * 24 * 60 * 60 * 1000) ? state._aaii : null;
    if (aaiiData) {
      if (optionType === "call") {
        if (aaiiData.signal === "extreme_bearish")  { supplementScore += 12; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail bearishness = contrarian call (+12)`); }
        else if (aaiiData.signal === "bearish")     { supplementScore += 6;  reasons.push(`AAII bulls ${aaiiData.bullish}% - retail bearish = mild contrarian call (+6)`); }
        else if (aaiiData.signal === "extreme_bullish") { score -= 10; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail greed, wrong for calls (-10)`); }
      } else {
        if (aaiiData.signal === "extreme_bullish")  { supplementScore += 10; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail greed = contrarian put (+10)`); }
        else if (aaiiData.signal === "bullish")     { supplementScore += 5;  reasons.push(`AAII bulls ${aaiiData.bullish}% - retail complacent = mild contrarian put (+5)`); }
        else if (aaiiData.signal === "extreme_bearish") { score -= 8; reasons.push(`AAII extreme bearish - contrary indicator, puts may be exhausted (-8)`); }
      }
    }

    const bMom = state._breadthTrend || "flat";
    const bMomVal = state._breadthMomentum || 0;
    if (optionType === "put"  && bMom === "falling") { supplementScore += 8; reasons.push(`Breadth falling (${bMomVal.toFixed(1)}pts) - distribution (+8)`); }
    if (optionType === "call" && bMom === "rising")  { supplementScore += 8; reasons.push(`Breadth rising (${bMomVal.toFixed(1)}pts) - accumulation (+8)`); }
    const _currentBreadth = state._breadth || 50;
    if (optionType === "call" && state._zweigThrust?.detected && _currentBreadth >= 50) {
      supplementScore += 10; reasons.push(`Breadth recovery signal — breadth still strong at ${_currentBreadth}% (+10)`);
    } else if (optionType === "call" && state._zweigThrust?.detected) {
      reasons.push(`Breadth recovery signal stale — current breadth ${_currentBreadth}% too weak (+0)`);
    }
  }

  if (optionType === "put") {
    if (signal) reasons.push(`Agent signal: ${signal} (${confidence}) — scoring impact removed, threshold-only`);

    const _dailyRsiForPut   = stock.dailyRsi || spyRSI || 50;
    _isOverboughtMRPut = optionType === "put" && ["trending_bull","recovery"].includes(regime)
      && spyRSI >= 65
      && _dailyRsiForPut >= 75;
    // ADD (6/14): near-miss tier ramps the dailyRSI≥75 cliff. dailyRSI 70–75 gets partial
    // overbought credit instead of falling all the way to the "wrong for puts -25" branch.
    const _isOverboughtMRPutSoft = ["trending_bull","recovery"].includes(regime)
      && spyRSI >= 65
      && _dailyRsiForPut >= 70 && _dailyRsiForPut < 75;

    if (["trending_bear","breakdown"].includes(regime))                           { score += 20; reasons.push(`Regime: ${regime} (+20)`); }
    else if (regime === "choppy")                                                  { score -= 10; reasons.push("Choppy regime - puts risky (-10)"); }
    else if (_isOverboughtMRPut) {
      score -= 5; reasons.push(`Regime: ${regime} - overbought MR put, reduced penalty (-5)`);
    }
    else if (_isOverboughtMRPutSoft) {
      score -= 15; reasons.push(`Regime: ${regime} - overbought MR put (soft, dailyRSI 70-75) (-15)`);
    }
    else if (["trending_bull","recovery"].includes(regime))                       { score -= 25; reasons.push(`Regime: ${regime} - wrong for puts (-25)`); }

    const regimeDuration    = state._regimeDuration || 0;
    const vixSustainedAvg   = state._vixSustained   || 0;
    const vixSustainedBonus = vixSustainedAvg >= 28 ? 5 : vixSustainedAvg >= 25 ? 3 : 0;
    const effectiveDuration = regimeDuration;
    if (["trending_bear","breakdown"].includes(regime) && effectiveDuration >= 5) {
      score += 15; reasons.push(`Bear trend ${effectiveDuration}d below 200MA - high confidence (+15)`);
    } else if (["trending_bear","breakdown"].includes(regime) && effectiveDuration >= 3) {
      score += 10; reasons.push(`Bear trend ${effectiveDuration}d below 200MA - regime confirmed (+10)`);
    } else if (["trending_bear","breakdown"].includes(regime) && effectiveDuration >= 1) {
      score += 5; reasons.push(`Bear trend ${effectiveDuration}d below 200MA - regime establishing (+5)`);
    }
    if (["trending_bear","breakdown"].includes(regime) && vixSustainedBonus > 0) {
      score += vixSustainedBonus; reasons.push(`VIX 5d avg ${vixSustainedAvg.toFixed(1)} sustained elevated (+${vixSustainedBonus})`);
    }

    const inBearOrChoppy = ["trending_bear","breakdown","choppy"].includes(regime);
    if (spyRSI >= 70) {
      const ivpNow = stock.ivPercentile || 50;
      if (ivpNow <= 30 && inBearOrChoppy) {
        score += 25; reasons.push(`${stock.ticker} RSI ${spyRSI} overbought + IVP ${ivpNow}% cheap puts - ideal debit put entry (+25)`);
      } else if (inBearOrChoppy) {
        score += 20; reasons.push(`${stock.ticker} RSI ${spyRSI} overbought in bear/choppy regime (+20)`);
      } else if (_isOverboughtMRPut) {
        score += 20; reasons.push(`${stock.ticker} RSI ${spyRSI} overbought MR put in bull regime - dailyRSI ${_dailyRsiForPut.toFixed(0)} confirms (+20)`);
      } else if (_isOverboughtMRPutSoft) {
        score += 12; reasons.push(`${stock.ticker} RSI ${spyRSI} overbought MR put (soft, dailyRSI ${_dailyRsiForPut.toFixed(0)}) (+12)`);
      } else {
        score += 5;  reasons.push(`${stock.ticker} RSI ${spyRSI} overbought in bull regime - trend may continue, reduced bonus (+5)`);
      }
    }
    else if (spyRSI >= 60)                                                        { score += 10; reasons.push(`${stock.ticker} RSI ${spyRSI} elevated (+10)`); }
    else if (spyRSI >= 45 && spyRSI < 60 && inBearOrChoppy && entryBias === "puts_on_bounces") {
      score += 8; reasons.push(`${stock.ticker} RSI ${spyRSI} in bounce zone - puts_on_bounces Regime B (+8)`);
    }
    else if (spyRSI <= 35) {
      // ── C2 FIX: Index instrument path — RSI <= 35 in bull regime ──────────────
      // BEFORE: hard return { score: 0 } for ALL instruments in Regime A.
      // Problem: On macro catalyst days (NFP, CPI, FOMC surprise), RSI <=35 on SPY/QQQ
      // means the move has JUST STARTED, not that it's exhausted. Hard-zeroing put scores
      // eliminated all put entries on June 5 NFP day despite 7 losing calls being taken.
      //
      // Fix: Index instruments (stock.isIndex === true) skip the hard-zero and take a
      // regime penalty instead. Individual stocks retain the hard-zero — stock-specific
      // crashes in a bull market ARE exhausted moves. Index crashes can be catalysts.
      //
      // The -10 penalty + -25 regime penalty still produces a negative base score,
      // so puts won't fire on normal dip days. They can only score above 70 when
      // other signals (bearish MACD, low breadth, VIX elevated, credit stress) pile on.
      const inBearRegimeForPuts = ["trending_bear","breakdown"].includes(regime);
      if (inBearRegimeForPuts) {
        score += 5; reasons.push(`${stock.ticker} RSI ${spyRSI} oversold in bear trend — brief bounce, put thesis intact (+5)`);
      } else if (stock.isIndex) {
        // C2 FIX: Index macro catalyst path — no hard zero
        score -= 10;
        reasons.push(`${stock.ticker} RSI ${spyRSI} oversold in bull regime — index catalyst path, other signals decide (-10)`);
        logEvent("filter", `[C2-PUT] ${stock.ticker} RSI ${spyRSI} oversold in Regime A — index path, no hard zero. Scoring continues.`);
      } else {
        // Individual stocks: hard zero retained — stock crash in bull market = thesis exhausted
        score = 0;
        reasons.push(`${stock.ticker} RSI ${spyRSI} oversold in bull regime — debit put hard block, stock already crashed`);
        return { score: 0, reasons, tradeType: "put" };
      }
    }
    else if (spyRSI <= 45) {
      const inBearTrend = ["trending_bear","breakdown"].includes(regime);
      if (inBearTrend) {
        if (spyRSI <= 40) {
          score += 0; reasons.push(`${stock.ticker} RSI ${spyRSI} oversold in bear trend - trend intact, no penalty but size reduced (+0)`);
          reasons.push(`[OVERSOLD-BEAR] RSI ${spyRSI} <=40 in Regime B - 0.75x sizing applied at execution`);
        } else {
          score += 0; reasons.push(`${stock.ticker} RSI ${spyRSI} oversold in bear trend - downtrend intact, no penalty (+0)`);
        }
      } else {
        score -= 15; reasons.push(`${stock.ticker} RSI ${spyRSI} oversold for puts - stock already crashed in bull regime (-15)`);
      }
    }

    const rsiHistRaw = state._rsiHistory?.[stock.ticker] || [];
    const rsiHistory = rsiHistRaw.map(r => typeof r === 'object' ? (r?.rsi || 50) : r);
    const inBearForVelocity = ["trending_bear","breakdown"].includes(regime);
    if (rsiHistory.length >= 3 && !inBearForVelocity) {
      const rsiChange = Math.abs(spyRSI - rsiHistory[rsiHistory.length - 3]);
      if (rsiChange >= 20) {
        score -= 8; reasons.push(`RSI velocity: ${rsiChange.toFixed(0)}pt move in 3 sessions - fast moves less reliable (-8)`);
      }
    } else if (rsiHistory.length >= 3 && inBearForVelocity) {
      const rsiChange = Math.abs(spyRSI - rsiHistory[rsiHistory.length - 3]);
      if (rsiChange >= 30) {
        score -= 4; reasons.push(`RSI velocity: ${rsiChange.toFixed(0)}pt swing - extreme even for bear trend (-4)`);
      }
    }

    const macdRSIConflictPut = spyRSI >= 70 && spyMACD && spyMACD.includes("bullish");
    const macdMultPut = macdRSIConflictPut ? 0.4 : 1.0;
    if (macdRSIConflictPut) reasons.push(`MACD/RSI conflict - RSI ${spyRSI} overbought, bullish MACD dampened`);
    if (spyMACD && spyMACD.includes("bearish crossover"))      { score += Math.round(15*macdMultPut); reasons.push(`SPY MACD bearish crossover (+${Math.round(15*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bearish"))           { score += Math.round(10*macdMultPut); reasons.push(`SPY MACD bearish (+${Math.round(10*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bullish crossover")) { score -= Math.round(15*macdMultPut); reasons.push(`SPY MACD bullish crossover (-${Math.round(15*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bullish"))           { score -= Math.round(8*macdMultPut);  reasons.push(`SPY MACD bullish (-${Math.round(8*macdMultPut)})`); }

    if (breadth <= 30)       { score += 15; reasons.push(`Breadth ${breadth}% - severe weakness (+15)`); }
    else if (breadth <= 45)  { score += 8;  reasons.push(`Breadth ${breadth}% - weak (+8)`); }
    else if (breadth <= 65 && inBearOrChoppy) { score += 4; reasons.push(`Breadth ${breadth}% - below neutral in bear regime (+4)`); }
    else if (breadth >= 70)  {
      const isGapDayBreadth = !!(agentMacro && agentMacro.spyGapUp);
      if (isGapDayBreadth) {
        score -= 5; reasons.push(`Breadth ${breadth}% - elevated but gap-day mechanics, discounted (-5)`);
      } else {
        score -= 15; reasons.push(`Breadth ${breadth}% - strong, wrong for puts (-15)`);
      }
    }

    if (vixOutlook === "spiking")          { score += 10; reasons.push("VIX spiking - put premium expanding (+10)"); }
    else if (vixOutlook === "elevated_stable") { score += 5; reasons.push("VIX elevated stable (+5)"); }
    else if (vixOutlook === "falling")     { score -= 10; reasons.push("VIX falling - puts losing value (-10)"); }
    if (vix >= 25)                         { score += 5;  reasons.push(`VIX ${vix.toFixed(1)} elevated (+5)`); }

    if (entryBias === "puts_on_bounces") {
      const volPace         = stock.volPaceRatio || 1.0;
      const thinBounce      = volPace < 0.8;
      const heavyBounce     = volPace >= 1.3;
      const qualityMult     = thinBounce ? 1.3 : heavyBounce ? 0.6 : 1.0;
      const agentAlreadyBearish = ["strongly bearish","bearish","mild bearish"].includes(signal);

      if (spyMomentum === "steady" && spyRSI >= 45 && spyRSI <= 65) {
        const baseBiasBonus = agentAlreadyBearish ? 8 : 15;
        const biasBonus     = Math.round(baseBiasBonus * qualityMult);
        const qualityNote   = thinBounce ? " (thin vol, ideal fade)" : heavyBounce ? " (heavy vol, harder fade)" : "";
        score += biasBonus; reasons.push(`Entry bias: fading bounce RSI ${spyRSI}${qualityNote} (+${biasBonus})`);
      } else if (spyMomentum === "steady") {
        const baseBiasBonus = agentAlreadyBearish ? 4 : 8;
        const biasBonus     = Math.round(baseBiasBonus * qualityMult);
        score += biasBonus; reasons.push(`Entry bias: puts on bounces vol ${volPace.toFixed(1)}x (+${biasBonus})`);
      } else if (spyMomentum === "recovering" && spyRSI >= 40) {
        const biasBonus = heavyBounce ? 0 : 3;
        if (biasBonus > 0) score += biasBonus;
        reasons.push(`Entry bias: momentum recovering${heavyBounce ? " - heavy vol, skip bonus" : " - timing not ideal"} (+${biasBonus})`);
      }
    }
    if (entryBias === "avoid") { score = Math.min(score, 0); reasons.push("Agent says avoid - blocked"); }

    const putVWAP  = stock.intradayVWAP || 0;
    const putPrice = stock.price || 0;
    if (putVWAP > 0 && putPrice > 0) {
      const vwapDiffPut = (putPrice - putVWAP) / putVWAP;
      if (vwapDiffPut < -0.01)     { score += 8; reasons.push(`Below VWAP ${(vwapDiffPut*100).toFixed(1)}% - weakness confirmed (+8)`); }
      else if (vwapDiffPut > 0.02) { score -= 6; reasons.push(`Extended above VWAP ${(vwapDiffPut*100).toFixed(1)}% - overbought vs today (+6 short)`); }
    }

    const ivpPut = stock.ivPercentile || 50;
    if (ivpPut < 25)        { score += 8;  reasons.push(`IVP ${ivpPut}% - cheap puts, favorable entry (+8)`); }
    else if (ivpPut >= 90)  { score -= 3; reasons.push(`IVP ${ivpPut}% - buying expensive premium, cost drag (-3)`); }
    else if (ivpPut >= 70)  { supplementScore += 3; reasons.push(`IVP ${ivpPut}% - elevated IV, active market (+3)`); }

    if (stock.ticker === "QQQ") {
      const qqqGateApplies = !["trending_bear","breakdown"].includes(regime) || INDIVIDUAL_STOCKS_ENABLED;
      if (qqqGateApplies) {
        // CUT (6/14): was a -15 gated on agentMacro.bearishTickers (NVDA/MSFT/AAPL/...).
        // The agent is cut, so bearishTickers is never populated → this had become a
        // permanent unsatisfiable -15 on every QQQ put. The breadth -15 (broad-grind brake)
        // and weekly-trend block already suppress QQQ puts in a healthy bull. No penalty here.
        reasons.push("QQQ: tech-bearish agent gate retired — breadth/weekly carry the discrimination (+0)");
      } else {
        reasons.push(`QQQ: Regime ${regime} - macro bear thesis sufficient, no tech confirmation needed (+0)`);
      }
    }

    {
      const weeklyTrend = stock._weeklyTrend || {};
      const trendCtx    = weeklyTrend.trendContext;
      if (trendCtx === 'confirmed_bear') { score += 12; reasons.push(`10-wk MA confirmed bear (${weeklyTrend.maSlopeDir}) - puts aligned with weekly trend (+12)`); }
      else if (trendCtx === 'pullback_bull' && weeklyTrend.above10wk === false) { score += 6; reasons.push(`10-wk MA rising but price below - tentative bear (+6)`); }
      else if (trendCtx === 'aligned_bull') { score -= 10; reasons.push(`10-wk MA aligned bull - puts fighting weekly trend (-10)`); }
      else if (weeklyTrend.above10wk === false) { score += 5;  reasons.push("Below 10-wk MA - weekly downtrend (+5)"); }
      else if (weeklyTrend.above10wk === true)  { score -= 5;  reasons.push("Above 10-wk MA - weekly uptrend, puts against grain (-5)"); }
    }

  } else {
    const sessionLowRSIForBypass = state._sessionLowRSI?.[stock.ticker] ?? 100;
    const mrCapitulationActive = sessionLowRSIForBypass <= 22 && spyRSI <= 28;
    const mrMildCapitulation   = sessionLowRSIForBypass <= 30 && spyRSI <= 35 && !mrCapitulationActive;

    if (["strongly bullish","bullish"].includes(signal) && confidence === "high") { score += 35; reasons.push(`Agent ${signal} high confidence (+35)`); }
    else if (["strongly bullish","bullish"].includes(signal))                     { score += 25; reasons.push(`Agent ${signal} (+25)`); }
    else if (signal === "mild bullish")                                            { score += 8;  reasons.push("Agent mild bullish (+8)"); }
    else if (signal === "neutral" && spyRSI <= 35)                                {
        const _px = stock.lastPrice || stock.price || 0;
        const _belowVWAP = (stock.intradayVWAP || 0) > 0 && _px < stock.intradayVWAP;
        const _mrCorrob = !OVERSOLD_CALL_NEEDS_CORROBORATION || (_belowVWAP && breadth <= CORROBORATION_MAX_BREADTH);
        if (_mrCorrob) { score += 20; reasons.push("Mean reversion call - SPY oversold on neutral macro (+20)"); }
        else { reasons.push(`Oversold but uncorroborated (breadth ${breadth}% ${_belowVWAP ? "below" : "above"} VWAP) - no MR credit (+0)`); }
      }
    // 6/29 (Harrison): restore the +20 on a genuine INTRADAY flush even when daily RSI > 35.
    // Root cause of the 70→40s score drop: the +20 above was rekeyed (6/22) from intraday to
    // DAILY spyRSI, so an intraday flush (iRSI 15, dRSI ~50) never qualified. Gate it on the same
    // earlyTurn signal the MR-gate uses — session reached oversold AND RSI lifted MR_INTRA_LIFTOFF_PTS
    // off its recent session low — so it fires on confirmed intraday turns, not on daily-neutral chop.
    // NOTE: 3-day sim of this entry showed ~33% 15m-forward win rate on a down tape; shipped for
    // data-gather, NOT as a proven edge. D2 falling-knife veto and stop downstream unchanged.
    else if (signal === "neutral") {
        const _intraRSInow    = (typeof intradayRsi === "number" ? intradayRsi : spyRSI) || 50;
        const _intraSessLow   = state._sessionLowRSI?.[stock.ticker] ?? 100;
        const _intraSessLowAt  = state._sessionLowRSIAt?.[stock.ticker] ?? 0;
        const _intraLowAgeMin  = _intraSessLowAt ? (Date.now() - _intraSessLowAt) / 60000 : Infinity;
        const _intraLift       = _intraRSInow - _intraSessLow;   // REAL intraday lift off session low (not daily RSI)
        const _intraEarlyTurn  = _intraSessLow   <= MR_INTRA_SESSLOW_MAX
                                 && _intraRSInow <= 40                       // still oversold-ish now (not a recovered spike)
                                 && _intraLift   >= MR_INTRA_LIFTOFF_PTS
                                 && _intraLowAgeMin <= MR_SESSLOW_RECENCY_MIN;
        if (_intraEarlyTurn) {
          score += 20;
          reasons.push(`Mean reversion call - intraday flush oversold on neutral macro (+20) [iRSI ${_intraRSInow.toFixed(0)} sessLow ${_intraSessLow.toFixed(0)} lift ${_intraLift.toFixed(0)} age ${_intraLowAgeMin.toFixed(0)}m]`);
        } else {
          score += 0;  reasons.push("Agent neutral (+0)");
        }
      }
    else if (mrCapitulationActive) {
      score += 5; reasons.push(`Agent ${signal} bypassed — session panic RSI ${sessionLowRSIForBypass.toFixed(0)}, confirming MR capitulation entry (+5)`);
    } else if (mrMildCapitulation) {
      score += 0; reasons.push(`Agent ${signal} — mild oversold (session low ${sessionLowRSIForBypass.toFixed(0)}), impact softened (+0)`);
    }
    else if (["mild bearish","bearish","strongly bearish"].includes(signal)) {
      reasons.push(`Agent signal: ${signal} — scoring impact removed, threshold-only`);
    }

    if (["trending_bull","recovery"].includes(regime)) {
      const _breadthNow  = state._breadth || 50;
      const _aboveVWAP   = (stock.intradayVWAP || 0) > 0 && (stock.lastPrice || stock.price || 0) >= stock.intradayVWAP * 0.995;
      if (_aboveVWAP && _breadthNow >= 40) {
        score += 20; reasons.push(`Regime: ${regime} (+20) — intraday aligned (above VWAP, breadth ${_breadthNow}%)`);
      } else if (_aboveVWAP || _breadthNow >= 30) {
        score += 10; reasons.push(`Regime: ${regime} (+10) — partial intraday alignment`);
      } else {
        score += 3;  reasons.push(`Regime: ${regime} (+3) — weekly bull but intraday bearish context`);
      }
    }
    else if (regime === "choppy")                                                  { score -= 10; reasons.push("Choppy regime - calls risky (-10)"); }
    else if (["trending_bear","breakdown"].includes(regime)) {
      if (mrCapitulationActive) {
        const oversoldDays = state._oversoldCount?.[stock.ticker] || 0;
        score += 10; reasons.push(`Regime: ${regime} - MR call capitulation bypass (RSI ${spyRSI}, ${oversoldDays}d oversold) - regime is the entry signal (+10 vs normal -25)`);
      } else if (spyRSI <= 35) {
        const oversoldDays = state._oversoldCount?.[stock.ticker] || 0;
        const vixNotSpiking = (state._agentMacro?.vixOutlook || "") !== "spiking";
        const capitulationConfirmed = oversoldDays >= 1 && vixNotSpiking;
        if (capitulationConfirmed) {
          score -= 10; reasons.push(`Regime: ${regime} - oversold bypass (RSI ${spyRSI} for ${oversoldDays}d + VIX stable) (-10 vs normal -25)`);
        } else {
          score -= 25; reasons.push(`Regime: ${regime} - wrong for debit calls (-25)`);
        }
      } else {
        score -= 25; reasons.push(`Regime: ${regime} - wrong for debit calls (-25)`);
      }
    }

    const intradayOversoldScans = state._intradayOversoldScans?.[stock.ticker] || 0;
    const sessionLowRSI         = state._sessionLowRSI?.[stock.ticker] ?? 100;
    // (6/17) Bounce confirmation is now relative + price-aware. The old absolute (spyRSI>=38)
    // missed violent V-bottoms (session low 18 → 30 is a 12pt rip but 30<38 → only +2).
    // Confirms on EITHER the original absolute RSI>=38, OR a real turn: RSI lifted
    // MR_BOUNCE_RSI_OFFLOW off its own session low AND price reclaimed to within
    // MR_BOUNCE_VWAP_TOL of VWAP. Price gate blocks rewarding RSI noise on a falling tape.
    const _rsiLiftOffLow = (spyRSI || 50) - sessionLowRSI;
    const _bounceVWAP    = stock.intradayVWAP || stock.vwap || 0;
    const _bouncePrice   = stock.price || stock.lastPrice || 0;
    const _priceReclaim  = _bounceVWAP > 0 && _bouncePrice > 0 && _bouncePrice >= _bounceVWAP * (1 - MR_BOUNCE_VWAP_TOL);
    const _bounceConfirmed = (spyRSI || 50) >= 38
      || (sessionLowRSI <= 30 && _rsiLiftOffLow >= MR_BOUNCE_RSI_OFFLOW && _priceReclaim);
    const mrStabilized = sessionLowRSI <= 30 && _bounceConfirmed && intradayOversoldScans >= 3;
    const mrBouncing   = sessionLowRSI <= 30 && _bounceConfirmed && intradayOversoldScans >= 1;
    // V3.2 (6/19) MACD histogram bull-curl — supplementary bounce CONFIRMATION (Phase 1).
    // Capped under _suppCap; gated to ONLY agree with a price-bounce that already fired
    // (mrStabilized/mrBouncing) so it can never originate or veto a setup. Flag MACD_CURL_SCORING
    // (default ON; set false in constants.js → reverts to observational +0).
    if (stock.macdCurl === "bull_curl" && (mrStabilized || mrBouncing)) {
      if (MACD_CURL_SCORING) {
        _curlPts = 3; supplementScore += _curlPts;
        reasons.push(`MACD histogram bull-curl confirms ${mrStabilized ? "stabilized" : "bouncing"} bounce (+${_curlPts})`);
      } else {
        reasons.push(`MACD histogram bull-curl present — observational only (+0)`);
      }
      try { logEvent("filter", `${stock.ticker} CURL bull_curl tier:${mrStabilized?"stabilized":"bouncing"} rawPts:${_curlPts} flag:${MACD_CURL_SCORING?"ON":"OFF"}`); } catch(e) {}
    }
    if (spyRSI <= 25) {
      if (mrStabilized) { score += 25; reasons.push(`${stock.ticker} RSI bounced from session low ${sessionLowRSI.toFixed(0)} to ${spyRSI} - mean reversion confirmed (+25)`); }
      else if (mrBouncing) { score += 12; reasons.push(`${stock.ticker} RSI bouncing from session low ${sessionLowRSI.toFixed(0)} - not yet confirmed (+12)`); }
      else { score += 2; reasons.push(`${stock.ticker} RSI ${spyRSI} extreme oversold - no bounce yet, waiting for recovery (+2)`); }
    }
    else if (spyRSI <= 35) {
      if (mrStabilized) { score += 18; reasons.push(`${stock.ticker} RSI bounced from session low ${sessionLowRSI.toFixed(0)} to ${spyRSI} - mean reversion (+18)`); }
      else if (mrBouncing) { score += 8; reasons.push(`${stock.ticker} RSI bouncing from session low ${sessionLowRSI.toFixed(0)} - partial credit (+8)`); }
      else { score += 2; reasons.push(`${stock.ticker} RSI ${spyRSI} deeply oversold - no bounce yet (+2)`); }
    }
    else if (spyRSI <= 42)                                                        { score += 10; reasons.push(`${stock.ticker} RSI ${spyRSI} oversold (+10)`); }
    else if (spyRSI >= 45 && spyRSI <= 58 && ["trending_bull","recovery"].includes(regime)) {
      // V3.00: "healthy dip" bonus removed — MR system requires RSI < 45
    }
    else if (spyRSI >= 70) {
      score -= 15; reasons.push(`${stock.ticker} RSI ${spyRSI} overbought — wrong entry for naked calls (-15)`);
    }

    const rsiHistoryCallRaw = state._rsiHistory?.[stock.ticker] || [];
    const rsiHistoryCall = rsiHistoryCallRaw.map(r => typeof r === 'object' ? (r?.rsi || 50) : r);
    const dailyRsiForVelocity = stock.dailyRsi || spyRSI;
    if (rsiHistoryCall.length >= 3) {
      const rsiChangeCall = Math.abs(dailyRsiForVelocity - rsiHistoryCall[rsiHistoryCall.length - 3]);
      if (rsiChangeCall >= 20) {
        score -= 8; reasons.push(`RSI velocity: ${rsiChangeCall.toFixed(0)}pt move in 3 sessions - fast bounce less reliable (-8)`);
      }
    }

    const macdRSIConflict = spyRSI <= 35 && spyMACD && spyMACD.includes("bearish");
    const macdMult = macdRSIConflict ? 0.4 : 1.0;
    if (macdRSIConflict) reasons.push(`MACD/RSI conflict - intraday RSI ${spyRSI} oversold, MACD dampened`);
    if (spyMACD && spyMACD.includes("bullish crossover"))  { score += Math.round(5*macdMult); reasons.push(`SPY MACD bullish crossover (+${Math.round(5*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bullish"))       { score += Math.round(3*macdMult);  reasons.push(`SPY MACD bullish (+${Math.round(3*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bearish crossover")) { score -= Math.round(5*macdMult); reasons.push(`SPY MACD bearish crossover (-${Math.round(5*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bearish"))       { score -= Math.round(3*macdMult);  reasons.push(`SPY MACD bearish (-${Math.round(3*macdMult)})`); }

    // BUG-2 fix: rank today's breadth against the DAILY buffer (recent sessions) as a TRUE
    // percentile, instead of a min-max over the last ~10 intraday scans (noise, and mislabeled
    // "pctile"). Neutral (50) until >=5 sessions accumulate. Daily buffer built in scanner.js.
    const bDaily = (state._breadthDaily || []).map(b => b.v);
    const bNorm  = bDaily.length >= 5
      ? (bDaily.filter(v => v < breadth).length / bDaily.length) * 100
      : 50;
    if (bNorm >= 75 && breadth >= 60)      { score += 10; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - strong relative to recent (+10)`); }
    else if (bNorm >= 60)                  { score += 6;  reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - recovering (+6)`); }
    else if (bNorm <= 30 && ["trending_bull","recovery"].includes(regime) && (!DIP_REQUIRES_MULTIDAY_ANCHOR || ((agentMacro||{}).spyDayChange ?? 0) <= DIP_MAX_DAYCHANGE)) {
      score += 12; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - low relative to recent in bull regime - ideal dip entry (+12)`);
    }
    else if (bNorm <= 20 && !mrCapitulationActive) { score -= 8; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - very weak relative to recent (-8)`); }
    else if (bNorm <= 20 && mrCapitulationActive)  { score += 5;  reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - capitulation breadth, MR setup confirmed (+5)`); }

    if (mrCapitulationActive) {
      if (vix >= 35)      { score += 15; reasons.push(`VIX ${vix} - extreme fear, MR calls historically cheap at capitulation (+15)`); }
      else if (vix >= 25) { score += 8;  reasons.push(`VIX ${vix} - elevated fear, MR call entry (+8)`); }
      if (vixOutlook === "spiking")       { score += 8;  reasons.push("VIX spiking - fear at peak, MR call entry signal (+8)"); }
      else if (vixOutlook === "mean_reverting") { score += 5; reasons.push("VIX mean reverting - MR improving (+5)"); }
    } else {
      if (vix <= 18)            { score += 12; reasons.push(`VIX ${vix} - calls historically cheap, low premium (+12)`); }
      else if (vix <= 22)       { score += 8;  reasons.push(`VIX ${vix} - moderate, calls reasonably priced (+8)`); }
      else if (vix >= 35)       { score -= 10; reasons.push(`VIX ${vix} - calls expensive in fear environment (-10)`); }
      if (vixOutlook === "falling")      { score += 12; reasons.push("VIX compressing - call premium expanding (+12)"); }
      else if (vixOutlook === "mean_reverting") { score += 6; reasons.push("VIX mean reverting - calls improving (+6)"); }
      else if (vixOutlook === "spiking") { score -= 12; reasons.push("VIX spiking - calls losing value fast (-12)"); }
    }

    const callVWAP = stock.intradayVWAP || 0;
    const callPrice = stock.price || 0;
    if (callVWAP > 0 && callPrice > 0) {
      const vwapDiff = (callPrice - callVWAP) / callVWAP;
      if (vwapDiff < -0.005)      { score += 8; reasons.push(`Below VWAP ${(vwapDiff*100).toFixed(1)}% - dip entry (+8)`); }
      else if (vwapDiff > 0.015)  { score -= 5; reasons.push(`Extended above VWAP ${(vwapDiff*100).toFixed(1)}% - chasing (+-5)`); }
    }

    const ivpCall = stock.ivPercentile || 50;
    const highVIXNow = vix >= 30;
    if (ivpCall < 25)      { score += 10; reasons.push(`IVP ${ivpCall}% - cheap call spreads, favorable entry (+10)`); }
    else if (ivpCall < 45) { score += 5;  reasons.push(`IVP ${ivpCall}% - moderate IV, reasonable entry (+5)`); }
    else if (ivpCall >= (IVP_CALL_PENALTY_STEEP ? 70 : 75) && !highVIXNow) { const _ivpPen = IVP_CALL_PENALTY_STEEP ? 15 : 8; score -= _ivpPen; reasons.push(`IVP ${ivpCall}% - expensive calls in calm VIX (-${_ivpPen})`); }
    else if (ivpCall >= (IVP_CALL_PENALTY_STEEP ? 70 : 75))  { const _ivpPen2 = IVP_CALL_PENALTY_STEEP ? 5 : 3; score -= _ivpPen2; reasons.push(`IVP ${ivpCall}% - expensive but VIX elevated, partial offset (-${_ivpPen2})`); }

    const weeklyTrend    = stock._weeklyTrend || {};
    const trendCtx       = weeklyTrend.trendContext;
    if (trendCtx === 'aligned_bull')   { score += 10; reasons.push(`10-wk MA aligned bull (${weeklyTrend.maSlopeDir}) (+10)`); }
    else if (trendCtx === 'pullback_bull') { score += 6; reasons.push(`10-wk MA rising - pullback buy (+6)`); }
    else if (trendCtx === 'confirmed_bear') { score -= 12; reasons.push(`10-wk MA falling + price below - confirmed bear (-12)`); }
    else if (weeklyTrend.above10wk === true)  { score += 5; reasons.push("Above 10-wk MA (+5)"); }
    else if (weeklyTrend.above10wk === false) { score -= 5; reasons.push("Below 10-wk MA (-5)"); }

    if (spyMomentum === "recovering" && ["trending_bull","recovery"].includes(regime)) {
      score += 10; reasons.push("Momentum recovering in bull regime - resuming uptrend (+10)");
    } else if (spyMomentum === "steady") {
      score += 3; reasons.push("Momentum steady (+3)");
    }

    const agentAlreadyBullish = ["strongly bullish","bullish","mild bullish"].includes(signal);
    if (entryBias === "calls_on_dips") {
      const _aboveVWAPNow = (stock.intradayVWAP || 0) > 0 && (stock.lastPrice || stock.price || 0) >= stock.intradayVWAP * 0.995;
      const _dipConfirmed = _aboveVWAPNow && (spyMomentum === "recovering" || spyRSI <= 45) && (!DIP_REQUIRES_MULTIDAY_ANCHOR || ((agentMacro||{}).spyDayChange ?? 0) <= DIP_MAX_DAYCHANGE);
      if (_dipConfirmed) {
        const biasBonus = agentAlreadyBullish ? 6 : 12;
        score += biasBonus; reasons.push(`Entry bias: calls on dips - dip confirmed near VWAP (+${biasBonus})`);
      } else if (_aboveVWAPNow) {
        const biasBonus = agentAlreadyBullish ? 3 : 6;
        score += biasBonus; reasons.push(`Entry bias: calls on dips (+${biasBonus})`);
      } else {
        reasons.push(`Entry bias: calls on dips — but below VWAP, bias stale (+0)`);
      }
    }
    if (entryBias === "avoid") { score = Math.min(score, 0); reasons.push("Agent says avoid - blocked"); }

    if (stock.ticker === "QQQ") {
      const techBullish = (agentMacro || {}).bullishTickers &&
        agentMacro.bullishTickers.some(t => ["NVDA","MSFT","AAPL","META","GOOGL","AMD"].includes(t));
      if (!techBullish && !["trending_bull","recovery"].includes(regime)) {
        score -= 10; reasons.push("QQQ: no tech bullish thesis in non-bull regime (-10)");
      } else if (techBullish) {
        score += 5; reasons.push("QQQ: tech names bullish (+5)");
      }
    }

    if (stock.ticker === "IWM" && ["trending_bull","recovery"].includes(regime)) {
      score += 8; reasons.push("IWM in bull/recovery regime - small cap confirmation (+8)");
    }
  }

  const sectorData = state._sectorRelStr || {};
  if (optionType === "put") {
    const xlfRelStr = sectorData.XLF?.relStr || 0;
    const smhRelStr = sectorData.SMH?.relStr || 0;
    const iwmRelStr = sectorData.IWM?.relStr || 0;
    if (xlfRelStr < -2.0) { score += 8; reasons.push(`XLF underperforming SPY by ${Math.abs(xlfRelStr).toFixed(1)}% - financial stress (+8)`); }
    else if (xlfRelStr < -1.0) { score += 4; reasons.push(`XLF lagging SPY by ${Math.abs(xlfRelStr).toFixed(1)}% (+4)`); }
    else if (xlfRelStr > 2.0)  { score -= 5; reasons.push(`XLF outperforming SPY by ${xlfRelStr.toFixed(1)}% - financials strong (-5)`); }
    if (stock.ticker === "QQQ" || stock.ticker === "SPY") {
      if (smhRelStr < -3.0) { score += 10; reasons.push(`SMH underperforming by ${Math.abs(smhRelStr).toFixed(1)}% - semi weakness leading QQQ down (+10)`); }
      else if (smhRelStr < -1.5) { score += 5; reasons.push(`SMH lagging ${Math.abs(smhRelStr).toFixed(1)}% - tech breadth narrowing (+5)`); }
      else if (smhRelStr > 3.0)  { score -= 5; reasons.push(`SMH outperforming - semis strong, QQQ puts less valid (-5)`); }
    }
    if (iwmRelStr < -2.0)  { score += 5; reasons.push(`IWM lagging SPY ${Math.abs(iwmRelStr).toFixed(1)}% - narrow rally, puts valid (+5)`); }
    else if (iwmRelStr > 2.0) { score -= 5; reasons.push(`IWM outperforming - broad participation, puts less valid (-5)`); }
    if (state._creditStress) { score += 8; reasons.push("Credit stress: HYG+TLT both falling - forced liquidation, bear regime confirmed (+8)"); }
  }
  if (optionType === "call") {
    const xlfRelStr = sectorData.XLF?.relStr || 0;
    const iwmRelStr = sectorData.IWM?.relStr || 0;
    if (xlfRelStr > 2.0)   { score += 5; reasons.push(`XLF outperforming SPY - financial strength, calls favorable (+5)`); }
    if (iwmRelStr > 2.0)   { score += 5; reasons.push(`IWM outperforming - broad participation, calls favorable (+5)`); }
    if (state._creditStress) { score -= 8; reasons.push("Credit stress: HYG+TLT falling - calls risky in liquidation (-8)"); }
  }

  const _isOverboughtMRPutForCap = typeof _isOverboughtMRPut !== 'undefined' && _isOverboughtMRPut;
  const _suppCap = _isOverboughtMRPutForCap ? 25 : 20;   // panel A (6/23): general cap 15->20 — was clipping the best-confluence days (raw 19 -> 15)
  if (supplementScore > 0) {
    const cappedSupp = Math.min(_suppCap, supplementScore);
    score += cappedSupp;
    if (cappedSupp < supplementScore) {
      reasons.push(`Supplementary signals capped at +${cappedSupp} (raw: +${supplementScore})`);
    }
  }
  score = Math.max(0, Math.min(100, score));
  const _mrCapitulationFlag = optionType === "call" && spyRSI <= 30 && !["trending_bull","recovery"].includes(regime);
  const _isMRPutExport = (typeof _isOverboughtMRPut !== 'undefined') && !!_isOverboughtMRPut;
  // V3.2 (6/19) cap-aware curl contribution: how many of the +3 actually survived _suppCap
  // (0 if the supplement cap was already saturated without curl). Lets the journal tell whether
  // curl truly moved the final score — and, vs the entryEngine floor, whether it was decisive.
  const _curlNet = _curlPts > 0
    ? Math.min(_suppCap, supplementScore) - Math.min(_suppCap, supplementScore - _curlPts)
    : 0;
  return { score: Math.min(score + 2, 100), reasons, tradeType: "naked", mrCapitulation: _mrCapitulationFlag,   // 6/29: global +2 data-gather bump (Harrison)
           _isOverboughtMRPut: _isMRPutExport, macdCurl: stock.macdCurl || "none", curlPts: _curlPts, curlNet: _curlNet };
}

// estimateCreditRR removed — no credit spreads in APEX

function isIYREntryAllowed(optionType, yieldEnv, iyrRSI) {
  if (optionType === "call") {
    if (yieldEnv === "steepening") {
      return { allowed: false, reason: `IYR call blocked — yield curve steepening (rising long rates = REIT headwind)` };
    }
    if (iyrRSI && iyrRSI >= 72) {
      return { allowed: false, reason: `IYR call blocked — RSI ${iyrRSI.toFixed(0)} overbought (extended, wrong entry)` };
    }
    return { allowed: true };
  } else {
    const ratesRising  = yieldEnv === "steepening";
    const rsiOverbought = iyrRSI && iyrRSI >= 65;
    if (!ratesRising && !rsiOverbought) {
      return { allowed: false, reason: `IYR put blocked — rates not rising (${yieldEnv}) and RSI ${iyrRSI?.toFixed(0)||"?"} not overbought (need rate catalyst for REIT put)` };
    }
    return { allowed: true };
  }
}

function isHYGEntryAllowed(optionType, creditStress, hygRelStr, hygRSI) {
  if (optionType === "call") {
    if (creditStress) {
      return { allowed: false, reason: "HYG call blocked — credit stress active (HYG+TLT both falling = spreads widening)" };
    }
    if (hygRSI && hygRSI >= 70) {
      return { allowed: false, reason: `HYG call blocked — RSI ${hygRSI.toFixed(0)} overbought (credit rally extended)` };
    }
    if (hygRelStr && hygRelStr < -1.5) {
      return { allowed: false, reason: `HYG call blocked — HYG underperforming by ${Math.abs(hygRelStr).toFixed(1)}% (credit diverging from equities)` };
    }
    return { allowed: true };
  } else {
    const stressBuilding = creditStress || (hygRelStr && hygRelStr < -0.5);
    const overbought     = hygRSI && hygRSI >= 68;
    if (!stressBuilding && !overbought) {
      return { allowed: false, reason: `HYG put blocked — no credit stress signal and RSI ${hygRSI?.toFixed(0)||"?"} not elevated (need credit deterioration for HYG put)` };
    }
    return { allowed: true };
  }
}

module.exports = {
  scoreIndexSetup, scorePutSetup, scoreMeanReversionCall,
  detectMarketRegime, getRegimeModifier, applyIntradayRegimeOverride,
  updateOversoldTracker, recordGateBlock, checkMacroShift,
  checkSectorETF, isGLDEntryAllowed, isXLEEntryAllowed, isTLTEntryAllowed,
  isIYREntryAllowed, isHYGEntryAllowed,
  initScoring,
};

// scoreDebitCallSpread removed — APEX uses naked options only
