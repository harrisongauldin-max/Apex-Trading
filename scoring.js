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

    // Calculate key indicators
    const sma20   = closes.slice(-20).reduce((s, c) => s + c, 0) / 20;
    const sma50   = closes.slice(-50).reduce((s, c) => s + c, 0) / 50;
    const current = closes[closes.length - 1];
    const adx     = calcADX(bars);

    // 20-day volatility (annualized)
    const returns  = closes.slice(-20).map((c, i) => i > 0 ? Math.log(c / closes[closes.length - 21 + i]) : 0).slice(1);
    const stdDev   = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) * Math.sqrt(252) * 100;

    // Recent momentum
    const mom5   = (current - closes[closes.length - 5])  / closes[closes.length - 5]  * 100;
    const mom20  = (current - closes[closes.length - 20]) / closes[closes.length - 20] * 100;

    // Determine regime
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

  // Only override if intraday signal is HIGH confidence AND meaningfully different
  const dayPlanBias = (state._dayPlan || {}).entryBias || "neutral";
  // Require BOTH regime AND bias to change for non-extreme shifts
  // Prevents spurious overrides when only confidence level changes
  const regimeChanged = dayPlanRegime !== intradayRegime;
  const biasChanged   = dayPlanBias   !== newMacro.entryBias;
  const strongShift   = confidence === "high" && (regimeChanged && biasChanged);
  const extremeShift = ["strongly bearish","strongly bullish"].includes(intradaySignal);

  // Check if previous override should expire (2-hour cooldown)
  const prevOverrideAt = state._dayPlan?._overrideAt;
  const overrideAge = prevOverrideAt ? (Date.now() - new Date(prevOverrideAt).getTime()) / 3600000 : 99;
  const overrideExpired = overrideAge >= 2.0; // expire override after 2 hours

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
  const today = getETTime().toISOString().slice(0, 10); // YYYY-MM-DD
  const lastDate = state._oversoldDate[ticker] || '';
  if (dailyRsi <= 35) {
    // Only increment once per trading day -- prevent scan-level inflation
    if (lastDate !== today) {
      state._oversoldCount[ticker] = (state._oversoldCount[ticker] || 0) + 1;
      state._oversoldDate[ticker]  = today;
    }
  } else {
    // Daily RSI recovered -- reset both counter and date
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
    // Significant macro shift - rescore all positions
    const direction = newTier < prevTier ? "bearish shift" : "bullish shift";
    logEvent("warn", `[MACRO] Signal shift: ${_prevMacroSignal} - ${newSignal} (${direction}) - triggering position rescores`);
    const positions = state.positions || [];
    // Fire in parallel - non-blocking
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

  // Fetch all sector ETFs in parallel
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

function isGLDEntryAllowed(optionType, dxy, spyReturn5d, vix, gldRSI, gldPrice, gldMA20) {
  if (optionType === "call") {
    // Panel decision (8/8): remove SPY 5d momentum gate - too restrictive
    // Gold rallies on dollar weakness + uncertainty, not only equity stress
    // Replacement: GLD above its own 20MA (Quant + Technical Analyst, 3/8)
    const dxyStrengthening = dxy && dxy.change > 0.8;  // dollar up >0.8% in 5d
    // VIX gate restored to 20 - backtest data showed lowering to 16 admitted losing trades
    // GLD 2023: 8-13 trades but WR dropped 37%-23% with extra entries - gate was right at 20
    const vixTooLow        = vix < 20;                 // restored to 20
    const gldDowntrend     = gldMA20 > 0 && gldPrice > 0 && gldPrice < gldMA20; // gold below 20MA = downtrend
    if (dxyStrengthening) return { allowed: false, reason: `GLD call blocked - DXY strengthening (+${dxy.change.toFixed(2)}% 5d, dollar headwind for gold)` };
    if (vixTooLow)        return { allowed: false, reason: `GLD call blocked - VIX ${vix.toFixed(1)} below 20, insufficient uncertainty for gold catalyst` };
    if (gldDowntrend)     return { allowed: false, reason: `GLD call blocked - GLD $${gldPrice.toFixed(2)} below 20MA $${gldMA20.toFixed(2)}, don't buy calls in downtrend` };
    return { allowed: true };
  } else {
    // GLD puts  -- two paths by trade type:
    // Debit puts: RSI >= 68 required (directional bet  -- gold must fall to profit)
    // Credit puts: RSI irrelevant  -- selling premium above current price, not predicting direction
    // [Regime A] RSI gate applies fully
    // [Regime B credit] bypass RSI overbought  -- IV level is what matters for premium collection
    const gldOverbought  = gldRSI >= 68;
    const dxyRising      = dxy && dxy.change > 0;
    const isGLDCreditPut = arguments[7] === "credit_put";
    if (!gldOverbought && !isGLDCreditPut) return { allowed: false, reason: `GLD put blocked - RSI ${gldRSI?.toFixed(0)||'?'} not overbought (need >68 for debit put thesis)` };
    if (dxyRising) return { allowed: false, reason: `GLD put blocked - DXY rising (+${dxy?.change||0}%), dollar strength supports gold` };
    return { allowed: true };
  }
}

function isXLEEntryAllowed(optionType, xleRSI, xleMomentum, vix, xlePrice, xleMA20, xleDailyRSI) {
  // XLE puts: need RSI elevated (not deeply oversold - that's a call, not put, setup)
  // Panel C3/M4: XLE RSI hard block now requires BOTH intraday RSI <= 35 AND dailyRSI <= 40.
  // During energy sector selloffs, intraday RSI can hit 25-30 while dailyRSI stays 55+.
  // If dailyRSI >= 40, the intraday crash is noise within a valid daily trend — allow entry.
  // If dailyRSI <= 40, the selloff is a genuine trend move — block debit put (already crashed).
  if (optionType === "put") {
    const dailyRsiOversold = !xleDailyRSI || xleDailyRSI <= 40; // conservative: block if unknown
    if (xleRSI && xleRSI <= 35 && dailyRsiOversold) return { allowed: false, reason: `XLE put blocked - RSI ${xleRSI?.toFixed(0)} intraday oversold + dailyRSI ${xleDailyRSI?.toFixed(0)||"?"} confirms trend exhaustion` };
    if (xleRSI && xleRSI <= 35 && !dailyRsiOversold) { logEvent("filter", `XLE intraday RSI ${xleRSI?.toFixed(0)} oversold but dailyRSI ${xleDailyRSI?.toFixed(0)} valid — intraday noise, allowing put entry`); }
    // Oil confirmed uptrend (XLE above 20MA by >3%) - puts into strong uptrend discouraged
    const xleAbove20MA = xleMA20 > 0 && xlePrice > xleMA20 * 1.03;
    if (xleAbove20MA) return { allowed: false, reason: `XLE put blocked - price $${xlePrice?.toFixed(2)} >3% above 20MA $${xleMA20?.toFixed(2)} (oil uptrend - don't fade)` };
    return { allowed: true };
  } else {
    // XLE calls: need RSI not deeply overbought (chasing energy run)
    if (xleRSI && xleRSI >= 78) return { allowed: false, reason: `XLE call blocked - RSI ${xleRSI?.toFixed(0)} deeply overbought (energy extended - wrong for calls)` };
    // Oil confirmed downtrend (XLE >3% below 20MA) - calls into strong downtrend discouraged
    const xleBelow20MA = xleMA20 > 0 && xlePrice < xleMA20 * 0.97;
    if (xleBelow20MA) return { allowed: false, reason: `XLE call blocked - price $${xlePrice?.toFixed(2)} >3% below 20MA $${xleMA20?.toFixed(2)} (oil downtrend - don't catch falling knife)` };
    return { allowed: true };
  }
}

function isTLTEntryAllowed(optionType, spyPrice, spyMA50, spyReturn5d, spyMA200, tltRSI, tltMomentum) {
  if (!spyMA50 || spyMA50 === 0) return { allowed: true }; // no data, don't block
  // Panel decision (5/8): SPY below 50MA OR below 200MA allows TLT calls
  // In 2022, bonds fell while SPY was still above 50MA (both fell on rate hikes)
  // Adding 200MA catch handles sustained bear market where SPY/bonds decorrelate differently
  const spyBelow50MA  = spyPrice < spyMA50;
  const spyBelow200MA = spyMA200 && spyMA200 > 0 && spyPrice < spyMA200;
  const spyWeak       = spyBelow50MA || spyBelow200MA;
  if (optionType === "call") {
    if (!spyWeak) return { allowed: false, reason: `TLT call blocked - SPY $${spyPrice.toFixed(2)} above both 50MA $${spyMA50.toFixed(2)} and 200MA, no equity weakness for bond rally` };
    const maLabel = spyBelow200MA ? "200MA" : "50MA";
    return { allowed: true, reason: `TLT call allowed - SPY below ${maLabel}` };
  } else {
    // TLT puts: bonds falling = rates rising
    // Panel fix: pure SPY-MA gate blocks ALL Regime B - bonds can fall on rate/inflation
    // fears even while equities are weak. Refine to check TLT's own signals:
    // Allow TLT put when TLT itself is overbought (RSI > 65) OR SPY is recovering
    const tltOverbought = tltRSI && tltRSI >= 65;
    const tltMomentumWeak = tltMomentum && ["recovering", "steady"].includes(tltMomentum);
    const spyRecovering = !spyWeak || spyReturn5d >= 0.01;

    // Block if: SPY still weak AND TLT not overbought on its own signals
    // Allow if: TLT RSI is elevated (bond overvaluation) regardless of SPY, OR SPY recovering
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

  // Momentum - weak is good for puts (20pts)
  // Steady momentum = no directional signal = 0 points (not a put catalyst)
  if (stock.momentum === "recovering")       { score += 20; reasons.push("Weak momentum - bearish (+20)"); }
  else if (stock.momentum === "steady")      { score += 0;  reasons.push("Momentum steady - neutral for put (+0)"); }
  else                                       { score += 0;  reasons.push("Strong momentum - bad for put (+0)"); }

  // RSI - RAISED to 20pts (more reliable signal, especially in trending markets)
  // RSI - 35 = stock already crashed - put thesis is GONE, not a valid entry
  // RSI 36-45 = oversold, apply meaningful penalty not a bonus
  if (stock.rsi >= 72)                       { score += 20; reasons.push(`RSI ${stock.rsi} - overbought (+20)`); }
  else if (stock.rsi >= 65 && stock.rsi < 72){ score += 12; reasons.push(`RSI ${stock.rsi} - elevated (+12)`); }
  else if (stock.rsi <= 35)                  { score -= 30; reasons.push(`RSI ${stock.rsi} - stock already crashed, put thesis gone (-30)`); }
  else if (stock.rsi <= 45)                  { score -= 10; reasons.push(`RSI ${stock.rsi} - oversold, put thesis weak (-10)`); }
  else                                       { reasons.push(`RSI ${stock.rsi} neutral for put (+0)`); }

  // MACD - confirms direction. Bullish MACD on a put = contradicting signal = PENALTY
  if (stock.macd.includes("bearish crossover")) { score += 10; reasons.push("MACD bearish crossover (+10)"); }
  else if (stock.macd.includes("bearish"))      { score += 7;  reasons.push("MACD bearish (+7)"); }
  else if (stock.macd.includes("neutral"))      { score += 3;  reasons.push("MACD neutral (+3)"); }
  else if (stock.macd.includes("bullish crossover")) { score -= 12; reasons.push("MACD bullish crossover - contradicts put (-12)"); }
  else                                          { score -= 8;  reasons.push("MACD bullish - contradicts put (-8)"); }

  // IV Percentile - ADJUSTED for VIX environment
  // High VIX: high IVP is expected and acceptable - options are expensive but moves are big
  // Low VIX: penalize high IVP more - no reason to buy expensive puts in calm market
  const ivpP = stock.ivPercentile || 50;
  const highVIX = vix > 30;
  if (ivpP < 30)       { score += 15; reasons.push(`IVP ${ivpP}% - cheap options (+15)`); }
  else if (ivpP < 50)  { score += 10; reasons.push(`IVP ${ivpP}% - moderate (+10)`); }
  else if (ivpP < 70)  { score += highVIX ? 8 : 5; reasons.push(`IVP ${ivpP}% - elevated (${highVIX ? "+8 high VIX" : "+5"})`); }
  else                 { score += highVIX ? 5 : 0; reasons.push(`IVP ${ivpP}% - expensive (${highVIX ? "+5 high VIX justified" : "+0"})`); }

  // News sentiment (15pts) - replaces static bearishCatalyst
  // Live bearish news is much more meaningful than a hardcoded string
  const newsMod = stock.newsSentiment === "bearish" ? 15
                : stock.newsSentiment === "mild bearish" ? 8
                : stock.newsSentiment === "neutral" ? 3
                : 0; // bullish news = bad for puts
  if (newsMod > 0) reasons.push(`News ${stock.newsSentiment} (+${newsMod})`);
  else if (stock.momentum === "recovering" && stock.hasIntraday) {
    score += 8; reasons.push("Intraday confirmed bearish move (+8)");
  }
  score += newsMod;

  // Volume confirmation - DIRECTIONAL: below VWAP + high vol = stronger put signal
  const belowVWAP = stock.intradayVWAP > 0 && (stock.price || 0) < stock.intradayVWAP;
  if (volume && avgVolume && volume > avgVolume * 1.2) {
    const volPts = belowVWAP ? 12 : 8; // directional bonus when below VWAP
    score += volPts; reasons.push(`Above-avg volume ${belowVWAP ? "+ below VWAP" : ""} (+${volPts})`);
  } else if (volume && avgVolume && volume > avgVolume) {
    score += 5; reasons.push("Average volume (+5)");
  } else { reasons.push("Low volume (+0)"); }

  // Relative weakness vs SPY - capped at 15pts, tracked for group cap
  let spyWeakPts = 0;
  if (relStrength < 0.93)      { spyWeakPts = 15; reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+15)`); }
  else if (relStrength < 0.97) { spyWeakPts = 8;  reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+8)`); }
  else if (relStrength < 1.0)  { spyWeakPts = 3;  reasons.push(`Slightly weak vs SPY (+3)`); }
  else                         { reasons.push(`Outperforming SPY - bad for put (+0)`); }
  score += spyWeakPts;

  // ADX - RAISED to 15pts max (strong downtrend is a top-tier confirmation)
  if (adx && adx > 35)      { score += 15; reasons.push(`ADX ${adx} - very strong downtrend (+15)`); }
  else if (adx && adx > 25) { score += 10; reasons.push(`ADX ${adx} - strong trend (+10)`); }
  else if (adx && adx > 18) { score += 5;  reasons.push(`ADX ${adx} - emerging trend (+5)`); }

  // - F6: Signal consensus gate -
  // 90+ score requires at least 3 independent bullish signals
  // Prevents weak setups from hitting 100 on environmental factors alone
  // Hard block: RSI - 35 means stock already crashed - force score to 0, never enters
  if (stock.rsi <= 35) {
    return { score: 0, reasons }; // hard zero - RSI crashed stocks never get put entries
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
    score = 80; // cap at 80 - not enough independent signals
    reasons.push(`Score capped at 80 - only ${bullishSignals}/3 required signals agree`);
  }

  // - F11: Entry quality gate - RSI and MACD must agree -
  // If RSI says overbought (bearish for stock) but MACD says bullish,
  // the two primary signals conflict. Flag it.
  const rsiPutSignal  = stock.rsi >= 65;
  const macdPutSignal = stock.macd.includes("bearish");
  if (!rsiPutSignal && !macdPutSignal) {
    score = Math.max(0, score - 15);
    reasons.push("Neither RSI nor MACD confirm put direction (-15)");
  }

  // Hard cap at 95 - a 100/100 is now mathematically impossible
  // Forces discrimination between setups even in broad selloffs
  const _sigResult = { score: Math.min(Math.max(score, 0), 95), reasons };
  setCache(sigKey, _sigResult);
  return _sigResult;
}

function scoreMeanReversionCall(stock, relStrength, adx, bars, vix) {
  let score = 0;
  const reasons = [];

  // Only applies when VIX is elevated (high fear = cheap relative calls)
  if (vix < 25) return { score: 0, reasons: ["VIX too low for mean reversion (+0)"] };

  // Stock must be a quality name - use beta as proxy for quality/liquidity
  if ((stock.beta || 1) < 1.0) return { score: 0, reasons: ["Low beta - not a mean reversion candidate (+0)"] };

  // RSI oversold - stock is beaten down (20pts)
  if (stock.rsi <= 35)                        { score += 20; reasons.push(`RSI ${stock.rsi} - deeply oversold (+20)`); }
  else if (stock.rsi <= 42)                   { score += 12; reasons.push(`RSI ${stock.rsi} - oversold (+12)`); }
  else if (stock.rsi <= 48)                   { score += 5;  reasons.push(`RSI ${stock.rsi} - near oversold (+5)`); }
  else return { score: 0, reasons: [`RSI ${stock.rsi} not oversold - skip mean reversion`] };

  // Multi-scan oversold bonus - RSI - 35 for 2+ consecutive scans = genuine capitulation
  const oversoldScans = state._oversoldCount ? (state._oversoldCount[stock.ticker] || 0) : 0;
  if (oversoldScans >= 3)      { score += 15; reasons.push(`Oversold ${oversoldScans} consecutive scans - capitulation (+15)`); }
  else if (oversoldScans >= 2) { score += 8;  reasons.push(`Oversold ${oversoldScans} consecutive scans (+8)`); }

  // Drawdown from recent high - how cheap is the stock? (25pts)
  if (bars && bars.length >= 20) {
    const recentHigh = Math.max(...bars.slice(-20).map(b => b.h));
    const currentPrice = bars[bars.length - 1].c;
    const drawdown = (recentHigh - currentPrice) / recentHigh;
    if (drawdown >= 0.20)      { score += 25; reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high - deep discount (+25)`); }
    else if (drawdown >= 0.12) { score += 15; reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high - discount (+15)`); }
    else if (drawdown >= 0.07) { score += 8;  reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high (+8)`); }
    else                       { score += 0;  reasons.push(`Only down ${(drawdown*100).toFixed(0)}% - not enough discount (+0)`); }
  }

  // MACD forming base or bullish crossover = possible reversal (15pts)
  if (stock.macd.includes("bullish crossover")) { score += 15; reasons.push("MACD bullish crossover - reversal signal (+15)"); }
  else if (stock.macd.includes("forming"))      { score += 10; reasons.push("MACD forming base - bottom building (+10)"); }
  else if (stock.macd.includes("bullish"))      { score += 5;  reasons.push("MACD bullish (+5)"); }
  else                                          { reasons.push("MACD bearish - wait for base (+0)"); }

  // VIX level bonus - higher VIX = cheaper calls relative to intrinsic move potential (15pts)
  if (vix >= 35)      { score += 15; reasons.push(`VIX ${vix} - extreme fear, calls historically cheap (+15)`); }
  else if (vix >= 30) { score += 10; reasons.push(`VIX ${vix} - elevated fear (+10)`); }
  else if (vix >= 25) { score += 5;  reasons.push(`VIX ${vix} - moderate fear (+5)`); }

  // Quality / catalyst (15pts)
  if (stock.catalyst)  { score += 10; reasons.push(`Recovery catalyst: ${stock.catalyst} (+10)`); }

  // ADX - low ADX means trend is weakening (good for reversal) (10pts)
  if (adx && adx < 20) { score += 10; reasons.push(`ADX ${adx} - weak trend, reversal likely (+10)`); }
  else if (adx && adx < 30) { score += 5; reasons.push(`ADX ${adx} - trend weakening (+5)`); }

  return { score: Math.min(score, 100), reasons, isMeanReversion: true };
}

function scoreIndexSetup(stock, optionType, spyRSI, spyMACD, spyMomentum, breadth, vix, agentMacro) {
  let score = 0;
  const reasons = [];
  const signal     = (agentMacro || {}).signal     || "neutral";
  const confidence = (agentMacro || {}).confidence || "low";
  const regime     = (agentMacro || {}).regime     || "neutral";
  const entryBias  = (agentMacro || {}).entryBias  || "neutral";
  const tradeType  = (agentMacro || {}).tradeType  || "spread";
  // Derive vixOutlook deterministically when agent returns unknown/missing
  // Agent is often right but can omit this field — VIX level is objective
  const rawVixOutlook = (agentMacro || {}).vixOutlook || "unknown";
  const vixOutlook = rawVixOutlook !== "unknown" ? rawVixOutlook
    : vix >= 32 ? "spiking"
    : vix >= 25 ? "elevated_stable"
    : vix >= 20 ? "mean_reverting"
    : "falling";

  // Supplementary signals - capped at +25 total, declared at function scope
  // so both put and call branches can use it
  // - QS-W1: Macro correlation discount (diminishing returns) -
  // When multiple primary signals all share one macro driver (e.g. all bearish because
  // SPY sold off today), adding them independently creates false precision.
  // Rule: count how many primary signals fired in the SAME direction as the entry.
  // 1-2 signals: full weight. 3rd signal: 70%. 4th+: 50%.
  // Primary signals = agent, regime, RSI, MACD, breadth. Supplementary are separate.
  // Count the number of primary pro-entry reasons already in the score
  // QS-W1: Correlation discount — only apply to EVENT-driven signals, not structural ones.
  // Structural signals (regime, entryBias, VIX level) legitimately co-fire in Regime B by definition.
  // Event signals (agent bearish + MACD crossover + breadth crash) may reflect one macro event.
  // Threshold raised 4→5: Regime B routinely has 4 valid independent signals.
  // Gilfoyle/Richard: eventKeywords counts INDEPENDENT EVENT signals only
  // Structural signals (Regime:, VIX level, entry bias) are deliberately absent —
  // they legitimately co-fire in Regime B and don't indicate false correlation
  // Breadth IS an event signal (single reading) — kept in list correctly
  // Dinesh: "Breadth falling" was wrong — it only matches supplementary signal
  //         "Breadth" matches primary breadth score reasons (e.g. "Breadth 38% - weak")
  const eventKeywords = optionType === "put"
    ? ["Agent strongly bearish","Agent bearish","Agent mild bearish","MACD bearish","Breadth"]
    : ["Agent strongly bullish","Agent bullish","Agent mild bullish","MACD bullish","Breadth"];
  const primaryFired = reasons.filter(r => eventKeywords.some(kw => r.includes(kw))).length;
  if (primaryFired >= 5) {
    const discountPct = 10;
    score = Math.round(score * (1 - discountPct/100));
    reasons.push(`Macro correlation discount: ${primaryFired} event signals (-${discountPct}% on total)`);
  } else if (primaryFired >= 4) {
    const discountPct = 5;
    score = Math.round(score * (1 - discountPct/100));
    reasons.push(`Macro correlation discount: ${primaryFired} event signals (-${discountPct}% on total)`);
  }

  let supplementScore = 0;
  // Supplementary signal staleness - max age for each signal type
  // PCR/SKEW update every 15 minutes, AAII weekly, term structure every 15 min
  const SUPP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour - stale beyond this, ignore
  const isDataFresh = (data) => data && data.updatedAt && (Date.now() - data.updatedAt) < SUPP_MAX_AGE_MS;

  if (optionType === "put") {
    // - Supplementary signals - capped at +25 total contribution -
    // These signals CONFIRM the primary thesis (agent + regime + RSI + MACD)
    // They should not dominate the score on their own
    // Cap: track supplement score separately, add min(supplementScore, 25) at end

    // - Put/Call Ratio signal (Bollen & Whaley 2004) -
    const pcrData = isDataFresh(state._pcr) ? state._pcr : null;
    if (pcrData && optionType === "put") {
      if (pcrData.signal === "extreme_fear")       { supplementScore += 10; reasons.push(`PCR ${pcrData.pcr} - extreme fear, put momentum strong (+10)`); }
      else if (pcrData.signal === "fear")          { supplementScore += 6;  reasons.push(`PCR ${pcrData.pcr} - elevated fear, put bias (+6)`); }
      else if (pcrData.signal === "extreme_greed") { score -= 12; reasons.push(`PCR ${pcrData.pcr} - extreme greed, puts risky (-12)`); }
      else if (pcrData.signal === "greed")         { score -= 6;  reasons.push(`PCR ${pcrData.pcr} - greed, puts less favorable (-6)`); }
    }
    if (pcrData && optionType === "call") {
      if (pcrData.signal === "extreme_fear")       { supplementScore += 12; reasons.push(`PCR ${pcrData.pcr} - extreme fear = contrarian call signal (+12)`); }
      else if (pcrData.signal === "fear")          { supplementScore += 6;  reasons.push(`PCR ${pcrData.pcr} - elevated fear, contrarian call (+6)`); }
      else if (pcrData.signal === "extreme_greed") { score -= 10; reasons.push(`PCR ${pcrData.pcr} - extreme greed, calls overextended (-10)`); }
    }

    // - Vol term structure (Natenberg) -
    const ts = isDataFresh(state._termStructure) ? state._termStructure : null;
    if (ts && optionType === "put") {
      if (ts.creditFavorable) { supplementScore += 8; reasons.push(`Vol backwardation (${ts.ratio}) - near-term fear premium elevated (+8)`); }
    }
    if (ts && optionType === "call") {
      if (ts.callFavorable)   { supplementScore += 8; reasons.push(`Vol contango (${ts.ratio}) - calls relatively cheap (+8)`); }
    }

    // - CBOE SKEW Index -
    // SKEW elevated + VIX elevated = put premium doubly rich = ideal credit puts
    // SKEW low = tail risk not priced = normal environment
    const skewData = isDataFresh(state._skew) ? state._skew : null;
    if (skewData) {
      if (optionType === "put") {
        if (skewData.signal === "extreme" && skewData.creditPutIdeal) {
          supplementScore += 12; reasons.push(`SKEW ${skewData.skew} extreme + VIX elevated - put premium doubly rich (+12)`);
        } else if (skewData.signal === "elevated") {
          supplementScore += 8; reasons.push(`SKEW ${skewData.skew} elevated - tail risk premium high (+8)`);
        } else if (skewData.signal === "low") {
          score -= 5; reasons.push(`SKEW ${skewData.skew} low - tail risk not priced (-5)`);
        }
      }
      if (optionType === "call") {
        if (skewData.signal === "low") {
          supplementScore += 8; reasons.push(`SKEW ${skewData.skew} low - tail risk not priced, calls favorable (+8)`);
        } else if (skewData.signal === "extreme") {
          score -= 8; reasons.push(`SKEW ${skewData.skew} extreme - market fearing tail event, wrong for calls (-8)`);
        }
      }
    }

    // - AAII Sentiment (Ned Davis Research validation) -
    // Extreme retail bearishness = contrarian call signal (bulls historically wrong at extremes)
    // Extreme retail bullishness = contrarian put signal
    const aaiiData = (state._aaii && state._aaii.updatedAt && (Date.now() - state._aaii.updatedAt) < 8 * 24 * 60 * 60 * 1000) ? state._aaii : null; // 8-day TTL (weekly data)
    if (aaiiData) {
      if (optionType === "call") {
        if (aaiiData.signal === "extreme_bearish") {
          supplementScore += 12; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail bearishness = contrarian call (+12)`);
        } else if (aaiiData.signal === "bearish") {
          supplementScore += 6; reasons.push(`AAII bulls ${aaiiData.bullish}% - retail bearish = mild contrarian call (+6)`);
        } else if (aaiiData.signal === "extreme_bullish") {
          score -= 10; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail greed, wrong for calls (-10)`);
        }
      }
      if (optionType === "put") {
        if (aaiiData.signal === "extreme_bullish") {
          supplementScore += 10; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail greed = contrarian put (+10)`);
        } else if (aaiiData.signal === "bullish") {
          supplementScore += 5; reasons.push(`AAII bulls ${aaiiData.bullish}% - retail complacent = mild contrarian put (+5)`);
        } else if (aaiiData.signal === "extreme_bearish") {
          score -= 8; reasons.push(`AAII extreme bearish - contrary indicator, puts may be exhausted (-8)`);
        }
      }
    }

    // - Breadth momentum (Aronson: direction > single reading) -
    const bMom = state._breadthTrend || "flat";
    const bMomVal = state._breadthMomentum || 0;
    if (optionType === "put" && bMom === "falling") {
      supplementScore += 8; reasons.push(`Breadth falling (${bMomVal.toFixed(1)}pts) - distribution (+8)`);
    } else if (optionType === "call" && bMom === "rising") {
      supplementScore += 8; reasons.push(`Breadth rising (${bMomVal.toFixed(1)}pts) - accumulation (+8)`);
    }

    // - Breadth recovery signal -
    // Note: True Zweig Thrust requires NYSE breadth (thousands of stocks)
    // With 4-instrument watchlist, use gentler "breadth recovery" signal
    // Only fires when breadth went from <40% to >60% in recent sessions
    if (optionType === "call" && state._zweigThrust?.detected) {
      supplementScore += 10; reasons.push("Breadth recovery signal - watchlist went from weak to strong (+10)");
    }

    // - Agent macro signal - primary gate -
    // Panel fix: mild bullish in bear regime = bounce read, not regime change.
    // -20 penalty only fires when agent is genuinely bullish AND regime confirms it.
    // entryBias "puts_on_bounces" means the bounce IS the put entry signal - treat as neutral.
    const bearRegimeForPuts = ["trending_bear","breakdown"].includes(regime);
    const putsBiasOk = entryBias === "puts_on_bounces";
    if (["strongly bearish","bearish"].includes(signal) && confidence === "high") { score += 35; reasons.push(`Agent ${signal} high confidence (+35)`); }
    else if (["strongly bearish","bearish"].includes(signal))                     { score += 25; reasons.push(`Agent ${signal} (+25)`); }
    else if (signal === "mild bearish")                                            { score += 8;  reasons.push(`Agent mild bearish (+8)`); }
    else if (signal === "neutral")                                                 { score += 0;  reasons.push("Agent neutral (+0)"); }
    else if (signal === "mild bullish" && (bearRegimeForPuts || putsBiasOk)) {
      score += 0;
      reasons.push(`Agent mild bullish in ${bearRegimeForPuts ? "bear regime" : "puts_on_bounces bias"} - bounce entry, treating as neutral (+0)`);
    }
    else if (signal === "mild bullish") {
      if (tradeType === "credit") {
        reasons.push(`Agent mild bullish in bear regime - bounce entry, treating as neutral (+0)`);
      } else {
        const inBearPutsOnBounces = ["trending_bear","breakdown"].includes(regime) && entryBias === "puts_on_bounces";
        const penalty = inBearPutsOnBounces ? -4 : -8;
        score += penalty; reasons.push(`Agent mild bullish (${penalty})${inBearPutsOnBounces ? " - regime cap" : ""}`);
      }
    }
    else if (signal === "bullish") {
      if (tradeType === "credit") {
        score -= 8; reasons.push("Agent bullish (-8) - regime cap");
      } else {
        const inBearPutsOnBounces2 = ["trending_bear","breakdown"].includes(regime) && entryBias === "puts_on_bounces";
        const penalty = inBearPutsOnBounces2 ? -8 : -15;
        score += penalty; reasons.push(`Agent bullish (${penalty})${inBearPutsOnBounces2 ? " - regime cap" : ""}`);
      }
    }
    else { // strongly bullish
      if (tradeType === "credit") {
        score -= 12; reasons.push("Agent strongly bullish (-12) - regime cap");
      } else {
        const inBearPutsOnBounces3 = ["trending_bear","breakdown"].includes(regime) && entryBias === "puts_on_bounces";
        const penalty = inBearPutsOnBounces3 ? -8 : -20;
        score += penalty; reasons.push(`Agent ${signal} (${penalty})${inBearPutsOnBounces3 ? " - regime cap" : ""}`);
      }
    }

    // - Regime confirmation -
    if (["trending_bear","breakdown"].includes(regime))                           { score += 20; reasons.push(`Regime: ${regime} (+20)`); }
    else if (regime === "choppy")                                                  { score -= 10; reasons.push("Choppy regime - puts risky (-10)"); }
    else if (["trending_bull","recovery"].includes(regime))                       { score -= 25; reasons.push(`Regime: ${regime} - wrong for puts (-25)`); }

    // V2.84: Regime B duration boost (panel fix -- Stat Arb + Quant Strategist)
    // The longer the bear trend is confirmed, the higher confidence puts are the right trade
    // Research: sustained regime (3+ days below 200MA) has higher directional accuracy than intraday regime calls
    // _regimeDuration tracks days SPY has been below 200MA (incremented daily in regime classifier)
    // Regime duration bonus — two paths:
    // 1. SPY below 200MA for N days (classic bear regime duration, tracked by _regimeDuration)
    // 2. VIX 5-day rolling average >= 25 (sustained fear — Regime B can exist above 200MA)
    // _vixHistory is a 5-entry intraday window (not days). Use _vixSustained (actual 5-day avg).
    // _vixSustained is computed once per scan: avg of _vixHistory entries. Already maintained.
    const regimeDuration    = state._regimeDuration || 0;
    const vixSustainedAvg   = state._vixSustained   || 0;  // actual 5-day rolling average
    const vixSustainedBonus = vixSustainedAvg >= 28 ? 5    // sustained elevated fear
                            : vixSustainedAvg >= 25 ? 3    // moderate sustained fear
                            : 0;
    const effectiveDuration = regimeDuration; // 200MA days remains the primary metric
    if (["trending_bear","breakdown"].includes(regime) && effectiveDuration >= 5) {
      score += 15; reasons.push(`Bear trend ${effectiveDuration}d below 200MA - high confidence (+15)`);
    } else if (["trending_bear","breakdown"].includes(regime) && effectiveDuration >= 3) {
      score += 10; reasons.push(`Bear trend ${effectiveDuration}d below 200MA - regime confirmed (+10)`);
    } else if (["trending_bear","breakdown"].includes(regime) && effectiveDuration >= 1) {
      score += 5; reasons.push(`Bear trend ${effectiveDuration}d below 200MA - regime establishing (+5)`);
    }
    // Separate VIX sustained bonus — additive but capped independently
    if (["trending_bear","breakdown"].includes(regime) && vixSustainedBonus > 0) {
      score += vixSustainedBonus; reasons.push(`VIX 5d avg ${vixSustainedAvg.toFixed(1)} sustained elevated (+${vixSustainedBonus})`);
    }

    // - SPY technicals (V2.81 - all thresholds now use daily RSI) -
    // V2.81 change 1: Regime-gate overbought put bonus
    // RSI >=70 in Regime A (bull trend) = healthy trend, not a fade signal (+5 only)
    // RSI >=70 in Regime B/C (bear/choppy) = extended bounce, genuine fade signal (+20)
    const inBearOrChoppy = ["trending_bear","breakdown","choppy"].includes(regime);
    if (spyRSI >= 70) {
      // V2.81 change 2: Joint RSI+IVR scoring
      // RSI >=70 (overbought) + IVR <=30 (cheap options) = ideal debit put entry
      // RSI >=70 + IVR >=70 (expensive options) = move may be priced in, reduce bonus
      const ivpNow = stock.ivPercentile || 50;
      if (ivpNow <= 30 && inBearOrChoppy) {
        score += 25; reasons.push(`SPY RSI ${spyRSI} overbought + IVP ${ivpNow}% cheap puts - ideal debit put entry (+25)`);
      } else if (inBearOrChoppy) {
        score += 20; reasons.push(`SPY RSI ${spyRSI} overbought in bear/choppy regime (+20)`);
      } else {
        score += 5;  reasons.push(`SPY RSI ${spyRSI} overbought in bull regime - trend may continue, reduced bonus (+5)`);
      }
    }
    else if (spyRSI >= 60)                                                        { score += 10; reasons.push(`SPY RSI ${spyRSI} elevated (+10)`); }
    else if (spyRSI >= 45 && spyRSI < 60 && inBearOrChoppy && entryBias === "puts_on_bounces") {
      // RSI 45-60 in Regime B bounce-fade = mild overbought recovery — valid put entry zone
      score += 8; reasons.push(`SPY RSI ${spyRSI} in bounce zone - puts_on_bounces Regime B (+8)`);
    }
    else if (spyRSI <= 35)                                                        {
      // Credit spreads: oversold = sell fear premium (survivable, not ideal) - reduced bonus
      // Debit put spreads: oversold = stock already crashed - hard zero
      // V2.81 change 3: Reduced credit put bonus from +15 to +5
      // Oversold is survivable for credit puts but not an ideal setup - score reflects that
      if (tradeType === "credit") {
        // V2.81 change 2 (joint): RSI <=35 + IVP >=70 = ideal credit put (fear premium at peak)
        const ivpNow = stock.ivPercentile || 50;
        if (ivpNow >= 70) {
          score += 10; reasons.push(`SPY RSI ${spyRSI} oversold + IVP ${ivpNow}% - fear premium elevated, credit put viable (+10)`);
        } else {
          score += 5;  reasons.push(`SPY RSI ${spyRSI} oversold - credit put survivable but not ideal (+5)`);
        }
      } else {
        score = 0; reasons.push(`SPY RSI ${spyRSI} oversold - debit put hard block (stock already crashed) (+0)`); return { score: 0, reasons, tradeType };
      }
    }
    else if (spyRSI <= 45) {
      // V2.84: Regime-aware RSI penalty (panel fix -- Technical Analyst + Stat Arb)
      // Regime A (bull): RSI <=45 means stock already sold off -- put thesis weak (-15)
      // Regime B (bear trend): RSI <=45 means downtrend intact -- neutral for puts (0)
      // Regime B + RSI <=40: valid but elevated overnight gap risk -- apply 0.75x sizing via _rsiBearOversold flag
      const inBearTrend = ["trending_bear","breakdown"].includes(regime);
      if (inBearTrend) {
        if (spyRSI <= 40) {
          score += 0; reasons.push(`SPY RSI ${spyRSI} oversold in bear trend - trend intact, no penalty but size reduced (+0)`);
          // Note: 0.75x sizing applied at execution via regimeBOversoldMod check
          reasons.push(`[OVERSOLD-BEAR] RSI ${spyRSI} <=40 in Regime B - 0.75x sizing applied at execution`);
        } else {
          score += 0; reasons.push(`SPY RSI ${spyRSI} oversold in bear trend - downtrend intact, no penalty (+0)`);
        }
      } else {
        score -= 15; reasons.push(`SPY RSI ${spyRSI} oversold for puts - stock already crashed in bull regime (-15)`);
      }
    }

    // V2.81 change 4: RSI velocity penalty
    // Fast RSI moves are statistically less reliable than sustained readings
    // If daily RSI moved 20+ points in recent sessions, the signal is a fast bounce/crash not a regime condition
    // RSI velocity penalty — exempt Regime B: wide RSI swings are normal in bear trends
    // This penalty was designed for Regime A (bull) where fast RSI moves indicate chasing
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
      if (rsiChange >= 30) { // higher threshold in bear regime - wide swings are normal
        score -= 4; reasons.push(`RSI velocity: ${rsiChange.toFixed(0)}pt swing - extreme even for bear trend (-4)`);
      }
    }

    // TA-C1: Dampen MACD when RSI is extreme opposite (intraday RSI more current than daily MACD)
    const macdRSIConflictPut = spyRSI >= 70 && spyMACD && spyMACD.includes("bullish");
    const macdMultPut = macdRSIConflictPut ? 0.4 : 1.0;
    if (macdRSIConflictPut) reasons.push(`MACD/RSI conflict - RSI ${spyRSI} overbought, bullish MACD dampened`);
    if (spyMACD && spyMACD.includes("bearish crossover"))      { score += Math.round(15*macdMultPut); reasons.push(`SPY MACD bearish crossover (+${Math.round(15*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bearish"))           { score += Math.round(10*macdMultPut); reasons.push(`SPY MACD bearish (+${Math.round(10*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bullish crossover")) { score -= Math.round(15*macdMultPut); reasons.push(`SPY MACD bullish crossover (-${Math.round(15*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bullish"))           { score -= Math.round(8*macdMultPut);  reasons.push(`SPY MACD bullish (-${Math.round(8*macdMultPut)})`); }

    // - Breadth confirmation -
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

    // - VIX context -
    if (vixOutlook === "spiking")          { score += 10; reasons.push("VIX spiking - put premium expanding (+10)"); }
    else if (vixOutlook === "elevated_stable") { score += 5; reasons.push("VIX elevated stable (+5)"); }
    else if (vixOutlook === "falling")     { score -= 10; reasons.push("VIX falling - puts losing value (-10)"); }
    if (vix >= 25)                         { score += 5;  reasons.push(`VIX ${vix.toFixed(1)} elevated (+5)`); }

    // - Entry bias alignment -
    // Bounce quality scoring - best put entries are on relief bounces not crashes
    if (entryBias === "puts_on_bounces") {
      const agentAlreadyBearish = ["strongly bearish","bearish","mild bearish"].includes(signal);
      if (spyMomentum === "steady" && spyRSI >= 45 && spyRSI <= 65) { // panel: 65 — RSI 64 bounce is a valid fade
        const biasBonus = agentAlreadyBearish ? 8 : 15;
        score += biasBonus; reasons.push(`Entry bias: fading bounce RSI ${spyRSI} (+${biasBonus})`);
      } else if (spyMomentum === "steady") {
        const biasBonus = agentAlreadyBearish ? 4 : 8;
        score += biasBonus; reasons.push(`Entry bias: puts on bounces (+${biasBonus})`);
      } else if (spyMomentum === "recovering" && spyRSI >= 40) {
        score += 3; reasons.push("Entry bias: momentum recovering - timing not ideal (+3)");
      }
    }
    if (entryBias === "avoid") { score = Math.min(score, 0); reasons.push("Agent says avoid - blocked"); }

    // - VWAP for puts (TA-C2) -
    const putVWAP  = stock.intradayVWAP || 0;
    const putPrice = stock.price || 0;
    if (putVWAP > 0 && putPrice > 0) {
      const vwapDiffPut = (putPrice - putVWAP) / putVWAP;
      if (vwapDiffPut < -0.01)     { score += 8; reasons.push(`Below VWAP ${(vwapDiffPut*100).toFixed(1)}% - weakness confirmed (+8)`); }
      else if (vwapDiffPut > 0.02) { score -= 6; reasons.push(`Extended above VWAP ${(vwapDiffPut*100).toFixed(1)}% - overbought vs today (+6 short)`); }
    }

    // - IV Percentile for puts - high IVR is partially favorable (richer premium)
    // but very high IVR means move already happened (less upside)
    const ivpPut = stock.ivPercentile || 50;
    if (ivpPut < 25)        { score += 8;  reasons.push(`IVP ${ivpPut}% - cheap puts, favorable entry (+8)`); }
    else if (ivpPut >= 90)  {
      // IVP 90%+: extreme IV. For debit puts: move may already be priced in (-5).
      // For credit spreads: ideal — collect extremely rich premium (+12).
      // tradeType === "credit" is passed in via scoringMacro when creditModeActive
      const isInCreditMode90 = tradeType === "credit";
      if (isInCreditMode90) {
        supplementScore += 12; reasons.push(`IVP ${ivpPut}% - extreme IV, ideal credit premium collection (+12)`);
      } else {
        score -= 5; reasons.push(`IVP ${ivpPut}% - extreme IV, debit put risk: move priced in (-5)`);
      }
    }
    else if (ivpPut >= 70)  {
      // Credit spreads: high IVP = selling overpriced premium = MORE favorable
      // Derive credit mode from agentMacro.tradeType (passed into scoreIndexSetup)
      const isInCreditMode = tradeType === "credit";
      const ivpBonus = isInCreditMode ? 10 : 5;
      supplementScore += ivpBonus;
      reasons.push(`IVP ${ivpPut}% - ${isInCreditMode ? "credit spread premium rich" : "elevated IV"} (+${ivpBonus})`);
    }

    // - QQQ secondary - only when tech thesis clear -
    // Panel fix: in Regime B/C with only 4 instruments, agent.bearishTickers is
    // almost never populated with FAANG names - gate fires on every scan.
    // QQQ put in a macro bear regime IS the thesis - no additional tech confirmation needed.
    // Gate only applies in Regime A (bull) or when individual stocks are enabled
    // (where SPY vs QQQ distinction matters more).
    if (stock.ticker === "QQQ") {
      const qqqGateApplies = !["trending_bear","breakdown"].includes(regime) || INDIVIDUAL_STOCKS_ENABLED;
      if (qqqGateApplies) {
        const techBearish = (agentMacro || {}).bearishTickers && (agentMacro.bearishTickers.some(t => ["NVDA","MSFT","AAPL","META","GOOGL"].includes(t)));
        if (!techBearish) { score -= 15; reasons.push("QQQ: no clear tech bearish thesis in bull regime (-15)"); }
        else { reasons.push("QQQ: tech names in agent bearish list (+0)"); }
      } else {
        reasons.push(`QQQ: Regime ${regime} - macro bear thesis sufficient, no tech confirmation needed (+0)`);
      }
    }

  } else {
    // - CALL SCORING - two distinct theses handled separately -
    // Thesis A: Mean Reversion Call - RSI crash + high VIX + capitulation
    // Thesis B: Trending Bull Call  - VIX compression + breadth thrust + momentum
    // Both share this path but scoring weights differ by regime/RSI context

    // - Agent macro signal - primary gate -
    if (["strongly bullish","bullish"].includes(signal) && confidence === "high") { score += 35; reasons.push(`Agent ${signal} high confidence (+35)`); }
    else if (["strongly bullish","bullish"].includes(signal))                     { score += 25; reasons.push(`Agent ${signal} (+25)`); }
    else if (signal === "mild bullish")                                            { score += 8;  reasons.push("Agent mild bullish (+8)"); }
    else if (signal === "neutral" && spyRSI <= 35)                                { score += 20; reasons.push("Mean reversion call - SPY oversold on neutral macro (+20)"); }
    else if (signal === "neutral")                                                 { score += 0;  reasons.push("Agent neutral (+0)"); }
    else if (signal === "mild bearish") {
      score -= 8; reasons.push(`Agent mild bearish (-8)`);
    }
    else if (signal === "bearish") {
      score -= 15; reasons.push(`Agent bearish (-15)`);
    }
    else { // strongly bearish
      // Scale by signal strength - mild = -8, bullish = -15, strongly = -20
      const callPenalty = signal === "mild bearish" ? -8 : signal === "bearish" ? -15 : -20;
      score += callPenalty; reasons.push(`Agent ${signal} (${callPenalty})`);
    }

    // - Regime confirmation -
    if (["trending_bull","recovery"].includes(regime))                            { score += 20; reasons.push(`Regime: ${regime} (+20)`); }
    else if (regime === "choppy")                                                  { score -= 10; reasons.push("Choppy regime - calls risky (-10)"); }
    else if (["trending_bear","breakdown"].includes(regime)) {
      // Credit calls (bear call spreads) in Regime B: legitimate directional premium trade
      // Debit calls in bear regime: wrong — fighting the trend
      // tradeType === "credit" when creditModeActive (scoringMacro has tradeType:"credit")
      const isCreditCallMode = tradeType === "credit";
      if (isCreditCallMode) {
        // Bear call spread: structural alignment bonus — selling calls above a falling market
        score += 5; reasons.push(`Regime: ${regime} - bear call spread aligned with downtrend (+5)`);
      } else {
        // Capitulation bypass for mean reversion debit calls
        const oversoldDays = state._oversoldCount?.[stock.ticker] || 0;
        const vixNotSpiking = (state._agentMacro?.vixOutlook || "") !== "spiking";
        const capitulationConfirmed = spyRSI <= 30 && oversoldDays >= 2 && vixNotSpiking;
        if (capitulationConfirmed) {
          score -= 10; reasons.push(`Regime: ${regime} - capitulation bypass active (RSI ${spyRSI} for ${oversoldDays}d + VIX stabilizing) (-10 vs normal -25)`);
        } else {
          score -= 25; reasons.push(`Regime: ${regime} - wrong for debit calls (-25)`);
        }
      }
    }

    // - RSI - context-aware for two theses (V2.81 - now uses daily RSI) -
    // Mean reversion: deeply oversold RSI = ideal call entry
    // Trending bull: healthy RSI (45-60) on a dip = ideal call entry
    // Overbought RSI (70+) = wrong entry point for both theses
    // V2.81 change 5 continued: RSI stabilization gate for mean reversion calls
    // Require 3 consecutive intraday scans of RSI <=35 before MR call entry fires
    // Prevents entering at the exact moment of maximum spread width and worst fills
    const intradayOversoldScans = state._intradayOversoldScans?.[stock.ticker] || 0;
    const mrStabilized = intradayOversoldScans >= 3; // 3 scans = ~30 seconds of stability
    if (spyRSI <= 25) {
      if (mrStabilized) { score += 25; reasons.push(`SPY RSI ${spyRSI} extreme oversold - stabilized (${intradayOversoldScans} scans) - mean reversion call (+25)`); }
      else              { score += 10; reasons.push(`SPY RSI ${spyRSI} extreme oversold - not yet stabilized (${intradayOversoldScans}/3 scans) - partial credit (+10)`); }
    }
    else if (spyRSI <= 35) {
      if (mrStabilized) { score += 18; reasons.push(`SPY RSI ${spyRSI} deeply oversold - stabilized - mean reversion (+18)`); }
      else              { score += 8;  reasons.push(`SPY RSI ${spyRSI} deeply oversold - awaiting stabilization (${intradayOversoldScans}/3 scans) (+8)`); }
    }
    else if (spyRSI <= 42)                                                        { score += 10; reasons.push(`SPY RSI ${spyRSI} oversold (+10)`); }
    else if (spyRSI >= 45 && spyRSI <= 58 && ["trending_bull","recovery"].includes(regime)) {
      score += 12; reasons.push(`SPY RSI ${spyRSI} healthy dip in bull trend - ideal call entry (+12)`);
    }
    else if (spyRSI >= 70)                                                        { score -= 15; reasons.push(`SPY RSI ${spyRSI} overbought for calls (-15)`); }

    // V2.81 change 4 (call side): RSI velocity penalty
    const rsiHistoryCallRaw = state._rsiHistory?.[stock.ticker] || [];
    const rsiHistoryCall = rsiHistoryCallRaw.map(r => typeof r === 'object' ? (r?.rsi || 50) : r);
    if (rsiHistoryCall.length >= 3) {
      const rsiChangeCall = Math.abs(spyRSI - rsiHistoryCall[rsiHistoryCall.length - 3]);
      if (rsiChangeCall >= 20) {
        score -= 8; reasons.push(`RSI velocity: ${rsiChangeCall.toFixed(0)}pt move in 3 sessions - fast bounce less reliable (-8)`);
      }
    }

    // - MACD (with RSI contradiction dampening) -
    // TA-C1: Intraday RSI (responsive) and daily MACD (slow) can conflict on fast-moving days
    // When RSI is deeply oversold (<35) but MACD is bearish - RSI signal is more current
    // Dampen MACD penalty when it contradicts an extreme RSI reading
    const macdRSIConflict = spyRSI <= 35 && spyMACD && spyMACD.includes("bearish");
    const macdMult = macdRSIConflict ? 0.4 : 1.0; // reduce MACD weight when RSI is extreme opposite
    if (macdRSIConflict) reasons.push(`MACD/RSI conflict - intraday RSI ${spyRSI} oversold, MACD dampened`);
    if (spyMACD && spyMACD.includes("bullish crossover"))  { score += Math.round(15*macdMult); reasons.push(`SPY MACD bullish crossover (+${Math.round(15*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bullish"))       { score += Math.round(8*macdMult);  reasons.push(`SPY MACD bullish (+${Math.round(8*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bearish crossover")) { score -= Math.round(15*macdMult); reasons.push(`SPY MACD bearish crossover (-${Math.round(15*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bearish"))       { score -= Math.round(5*macdMult);  reasons.push(`SPY MACD bearish (-${Math.round(5*macdMult)})`); }

    // - Breadth - normalized to recent history -
    // Raw 80% means nothing without context - normalized reading is more meaningful
    // Compare current breadth to recent 10-reading range
    const bHist10 = (state._breadthHistory || []).map(b => b.v);
    const bMin = bHist10.length >= 3 ? Math.min(...bHist10) : 0;
    const bMax = bHist10.length >= 3 ? Math.max(...bHist10) : 100;
    const bRange = bMax - bMin;
    // Normalized breadth: 0-100 within recent range (above/below recent midpoint)
    const bNorm = bRange > 5 ? ((breadth - bMin) / bRange) * 100 : 50; // 50 = neutral if no range
    if (bNorm >= 75 && breadth >= 60)      { score += 10; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - strong relative to recent (+10)`); }
    else if (bNorm >= 60)                  { score += 6;  reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - recovering (+6)`); }
    else if (bNorm <= 30 && ["trending_bull","recovery"].includes(regime)) {
      score += 12; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - low relative to recent in bull regime - ideal dip entry (+12)`);
    }
    else if (bNorm <= 20)                  { score -= 8; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - very weak relative to recent (-8)`); }

    // - VIX - absolute level matters for calls, not just direction -
    // Low VIX = cheap call premium = historically excellent call entry cost
    // High VIX = expensive calls + wrong macro environment for bull thesis
    if (vix <= 18)            { score += 12; reasons.push(`VIX ${vix} - calls historically cheap, low premium (+12)`); }
    else if (vix <= 22)       { score += 8;  reasons.push(`VIX ${vix} - moderate, calls reasonably priced (+8)`); }
    else if (vix >= 35)       { score -= 10; reasons.push(`VIX ${vix} - calls expensive in fear environment (-10)`); }
    // VIX direction (falling = calls gaining value, spiking = calls losing)
    if (vixOutlook === "falling")      { score += 12; reasons.push("VIX compressing - call premium expanding (+12)"); }
    else if (vixOutlook === "mean_reverting") { score += 6; reasons.push("VIX mean reverting - calls improving (+6)"); }
    else if (vixOutlook === "spiking") { score -= 12; reasons.push("VIX spiking - calls losing value fast (-12)"); }

    // - VWAP (TA-C2: now used for index instruments) -
    // VWAP is calculated but was discarded for index instruments - fixed here
    const callVWAP = stock.intradayVWAP || 0;
    const callPrice = stock.price || 0;
    if (callVWAP > 0 && callPrice > 0) {
      const vwapDiff = (callPrice - callVWAP) / callVWAP;
      if (vwapDiff < -0.005)      { score += 8; reasons.push(`Below VWAP ${(vwapDiff*100).toFixed(1)}% - dip entry (+8)`); }
      else if (vwapDiff > 0.015)  { score -= 5; reasons.push(`Extended above VWAP ${(vwapDiff*100).toFixed(1)}% - chasing (+-5)`); }
    }

    // - IV Percentile - cost of entry matters for spreads -
    // High IVR = expensive spreads = worse risk/reward even with same directional thesis
    // Low IVR = cheap spreads = same expected move costs less
    // Note: debit spreads partially offset high IV by selling the short leg
    // so penalty is softer than for naked options
    const ivpCall = stock.ivPercentile || 50;
    const highVIXNow = vix >= 30;
    if (ivpCall < 25)      { score += 10; reasons.push(`IVP ${ivpCall}% - cheap call spreads, favorable entry (+10)`); }
    else if (ivpCall < 45) { score += 5;  reasons.push(`IVP ${ivpCall}% - moderate IV, reasonable entry (+5)`); }
    else if (ivpCall >= 75 && !highVIXNow) { score -= 8; reasons.push(`IVP ${ivpCall}% - expensive calls in calm VIX (-8)`); }
    else if (ivpCall >= 75)  { score -= 3; reasons.push(`IVP ${ivpCall}% - expensive but VIX elevated, partial offset (-3)`); }

    // - Weekly trend alignment (slope-aware) -
    // TA-W3: MA slope matters more than price position
    const weeklyTrend    = stock._weeklyTrend || {};
    const trendCtx       = weeklyTrend.trendContext;
    if (trendCtx === 'aligned_bull')   { score += 10; reasons.push(`10-wk MA aligned bull (${weeklyTrend.maSlopeDir}) (+10)`); }
    else if (trendCtx === 'pullback_bull') { score += 6; reasons.push(`10-wk MA rising - pullback buy (+6)`); }
    else if (trendCtx === 'confirmed_bear') { score -= 12; reasons.push(`10-wk MA falling + price below - confirmed bear (-12)`); }
    else if (weeklyTrend.above10wk === true)  { score += 5; reasons.push("Above 10-wk MA (+5)"); }
    else if (weeklyTrend.above10wk === false) { score -= 5; reasons.push("Below 10-wk MA (-5)"); }

    // - Momentum -
    // Recovering momentum in bull regime = dip is done, resuming uptrend
    if (spyMomentum === "recovering" && ["trending_bull","recovery"].includes(regime)) {
      score += 10; reasons.push("Momentum recovering in bull regime - resuming uptrend (+10)");
    } else if (spyMomentum === "steady") {
      score += 3; reasons.push("Momentum steady (+3)");
    }

    // - Entry bias -
    // Market maker fix: halve bonus when agent already scored bullish to avoid double-counting
    // Agent signal + regime already capture the macro view - bias refines TIMING not direction
    const agentAlreadyBullish = ["strongly bullish","bullish","mild bullish"].includes(signal);
    if (entryBias === "calls_on_dips") {
      if (spyMomentum === "recovering" || spyRSI <= 45) {
        const biasBonus = agentAlreadyBullish ? 6 : 12;
        score += biasBonus; reasons.push(`Entry bias: calls on dips - dip confirmed (+${biasBonus})`);
      } else {
        const biasBonus = agentAlreadyBullish ? 3 : 6;
        score += biasBonus; reasons.push(`Entry bias: calls on dips (+${biasBonus})`);
      }
    }
    if (entryBias === "avoid") { score = Math.min(score, 0); reasons.push("Agent says avoid - blocked"); }

    // - QQQ - requires tech bullish confirmation -
    // Relaxed: QQQ can lead in tech rallies - only penalize if NO bullish thesis
    if (stock.ticker === "QQQ") {
      const techBullish = (agentMacro || {}).bullishTickers &&
        agentMacro.bullishTickers.some(t => ["NVDA","MSFT","AAPL","META","GOOGL","AMD"].includes(t));
      if (!techBullish && !["trending_bull","recovery"].includes(regime)) {
        score -= 10; reasons.push("QQQ: no tech bullish thesis in non-bull regime (-10)");
      } else if (techBullish) {
        score += 5; reasons.push("QQQ: tech names bullish (+5)");
      }
    }

    // - IWM - small caps confirm broad market strength -
    if (stock.ticker === "IWM" && ["trending_bull","recovery"].includes(regime)) {
      score += 8; reasons.push("IWM in bull/recovery regime - small cap confirmation (+8)");
    }
  }

  // TODO #9: Wire data ETF sector signals into scoring
  // XLF: financial sector health → SPY put signal
  // SMH: semiconductor leading indicator → QQQ put signal
  // IWM: market breadth quality → put/call modifier
  // HYG credit stress: both HYG+TLT falling → bear regime confidence boost
  const sectorData = state._sectorRelStr || {};
  if (optionType === "put") {
    const xlfRelStr = sectorData.XLF?.relStr || 0;
    const smhRelStr = sectorData.SMH?.relStr || 0;
    const iwmRelStr = sectorData.IWM?.relStr || 0;
    // XLF underperforming SPY = financial stress = bearish signal for SPY puts
    if (xlfRelStr < -2.0) { score += 8; reasons.push(`XLF underperforming SPY by ${Math.abs(xlfRelStr).toFixed(1)}% - financial stress (+8)`); }
    else if (xlfRelStr < -1.0) { score += 4; reasons.push(`XLF lagging SPY by ${Math.abs(xlfRelStr).toFixed(1)}% (+4)`); }
    else if (xlfRelStr > 2.0)  { score -= 5; reasons.push(`XLF outperforming SPY by ${xlfRelStr.toFixed(1)}% - financials strong (-5)`); }
    // SMH underperforming QQQ = tech weakness is broad, QQQ puts more valid
    if (stock.ticker === "QQQ" || stock.ticker === "SPY") {
      if (smhRelStr < -3.0) { score += 10; reasons.push(`SMH underperforming by ${Math.abs(smhRelStr).toFixed(1)}% - semi weakness leading QQQ down (+10)`); }
      else if (smhRelStr < -1.5) { score += 5; reasons.push(`SMH lagging ${Math.abs(smhRelStr).toFixed(1)}% - tech breadth narrowing (+5)`); }
      else if (smhRelStr > 3.0)  { score -= 5; reasons.push(`SMH outperforming - semis strong, QQQ puts less valid (-5)`); }
    }
    // IWM underperforming = narrow market = puts more valid
    if (iwmRelStr < -2.0)  { score += 5; reasons.push(`IWM lagging SPY ${Math.abs(iwmRelStr).toFixed(1)}% - narrow rally, puts valid (+5)`); }
    else if (iwmRelStr > 2.0) { score -= 5; reasons.push(`IWM outperforming - broad participation, puts less valid (-5)`); }
    // Credit stress flag — HYG + TLT both falling = forced liquidation
    if (state._creditStress) { score += 8; reasons.push("Credit stress: HYG+TLT both falling - forced liquidation, bear regime confirmed (+8)"); }
  }
  if (optionType === "call") {
    const xlfRelStr = sectorData.XLF?.relStr || 0;
    const iwmRelStr = sectorData.IWM?.relStr || 0;
    if (xlfRelStr > 2.0)   { score += 5; reasons.push(`XLF outperforming SPY - financial strength, calls favorable (+5)`); }
    if (iwmRelStr > 2.0)   { score += 5; reasons.push(`IWM outperforming - broad participation, calls favorable (+5)`); }
    if (state._creditStress) { score -= 8; reasons.push("Credit stress: HYG+TLT falling - calls risky in liquidation (-8)"); }
  }

  // Apply supplementary signals - capped at +25 total to prevent domination
  if (supplementScore > 0) {
    const cappedSupp = Math.min(25, supplementScore);
    score += cappedSupp;
    if (cappedSupp < supplementScore) {
      reasons.push(`Supplementary signals capped at +${cappedSupp} (raw: +${supplementScore})`);
    }
  }
  // Full 100-point scale - cap at 100 not 95 to preserve resolution at high conviction
  score = Math.max(0, Math.min(100, score));
  return { score, reasons, tradeType: tradeType || "spread" };
}


module.exports = {
  scoreIndexSetup, scorePutSetup, scoreMeanReversionCall,
  detectMarketRegime, getRegimeModifier, applyIntradayRegimeOverride,
  updateOversoldTracker, recordGateBlock, checkMacroShift,
  checkSectorETF, isGLDEntryAllowed, isXLEEntryAllowed, isTLTEntryAllowed,
  initScoring,
};
