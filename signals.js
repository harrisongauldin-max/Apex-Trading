// signals.js — ARGO V3.2
// Technical indicators, portfolio math, market utilities.
'use strict';
const { alpacaGet, getStockBars, getIntradayBars } = require('./broker');
const { state } = require('./state');
const { MAX_HEAT, CAPITAL_FLOOR, MONTHLY_BUDGET } = require('./constants');
let _log = (type, msg) => console.log(`[signals][${type}] ${msg}`);
function setSignalsLogger(fn) { _log = fn; }

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-x*x);
  return x >= 0 ? y : -y;
}

function calcRSI(bars, period = 14) {
  if (bars.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const change = bars[i].c - bars[i-1].c;
    if (change > 0) gains  += change;
    else            losses -= change;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs  = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcMACD(bars) {
  if (bars.length < 26) return { signal: "neutral", value: 0 };
  const closes  = bars.map(b => b.c);
  const ema12   = calcEMA(closes.slice(-12), 12);
  const ema26   = calcEMA(closes.slice(-26), 26);
  const macdVal = ema12 - ema26;
  const signal  = calcEMA(
    bars.slice(-9).map((_, i) => {
      const e12 = calcEMA(closes.slice(-(26 - 8 + i)), 12);
      const e26 = calcEMA(closes.slice(-(26)), 26);
      return e12 - e26;
    }), 9
  );
  const histogram = macdVal - signal;
  if (histogram > 0.5)       return { signal: "bullish crossover", value: macdVal };
  if (histogram > 0)         return { signal: "bullish",           value: macdVal };
  if (histogram < -0.5)      return { signal: "bearish crossover", value: macdVal };
  if (histogram < 0)         return { signal: "bearish",           value: macdVal };
  return { signal: "neutral", value: macdVal };
}

function calcMomentum(bars) {
  if (bars.length < 20) return "steady";
  const recent5  = (bars[bars.length-1].c - bars[bars.length-5].c)  / bars[bars.length-5].c;
  const recent20 = (bars[bars.length-1].c - bars[bars.length-20].c) / bars[bars.length-20].c;
  if (recent5 > 0.03 && recent20 > 0.05)  return "strong";
  if (recent5 < -0.03 || recent20 < -0.05) return "recovering";
  return "steady";
}

function calcATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const recent = bars.slice(-(period + 1));
  let atrSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const high  = recent[i].h || recent[i].c;
    const low   = recent[i].l || recent[i].c;
    const prev  = recent[i-1].c;
    atrSum += Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  }
  return parseFloat((atrSum / period).toFixed(4));
}

function calcADX(bars, period = 14) {
  if (bars.length < period + 1) return 20;
  let dmPlus = 0, dmMinus = 0, atr = 0;
  for (let i = bars.length-period; i < bars.length; i++) {
    const high = bars[i].h, low = bars[i].l, prevClose = bars[i-1]?.c || bars[i].c;
    const prevHigh = bars[i-1]?.h || high, prevLow = bars[i-1]?.l || low;
    dmPlus  += Math.max(high - prevHigh, 0);
    dmMinus += Math.max(prevLow - low, 0);
    atr     += Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose));
  }
  if (atr === 0) return 20;
  const diPlus  = (dmPlus/atr)*100;
  const diMinus = (dmMinus/atr)*100;
  const dx      = Math.abs(diPlus-diMinus) / (diPlus+diMinus||1) * 100;
  return parseFloat(dx.toFixed(1));
}

function calcIVRank(currentIV, bars) {
  if (bars.length < 30) return 50;
  // Approximate historical vol from price bars
  const returns = [];
  for (let i = 1; i < bars.length; i++) {
    returns.push(Math.abs(Math.log(bars[i].c / bars[i-1].c)));
  }
  const avgVol  = returns.reduce((s, r) => s + r, 0) / returns.length;
  const annVol  = avgVol * Math.sqrt(252) * 100;
  const minVol  = Math.min(...returns) * Math.sqrt(252) * 100;
  const maxVol  = Math.max(...returns) * Math.sqrt(252) * 100;
  const ivr     = maxVol > minVol ? ((currentIV * 100 - minVol) / (maxVol - minVol)) * 100 : 50;
  return Math.min(Math.max(parseFloat(ivr.toFixed(0)), 0), 100);
}

function calcGreeks(price, strike, daysToExpiry, iv, optionType = "call") {
  const t   = Math.max(daysToExpiry, 1) / 365;
  const d1  = (Math.log(price/strike) + (0.05 + iv*iv/2)*t) / (iv*Math.sqrt(t));
  const nd1 = Math.exp(-d1*d1/2) / Math.sqrt(2*Math.PI);
  const Nd1 = 0.5*(1+erf(d1/Math.sqrt(2)));
  // Put delta = Nd1 - 1 (negative), call delta = Nd1 (positive)
  const rawDelta = optionType === "put" ? Nd1 - 1 : Nd1;
  return {
    delta: parseFloat(Math.max(-0.99, Math.min(0.99, rawDelta)).toFixed(3)),
    gamma: parseFloat((nd1 / (price * iv * Math.sqrt(t))).toFixed(4)),
    vega:  parseFloat((price * nd1 * Math.sqrt(t) * 0.01).toFixed(2)),
    theta: parseFloat((-(price * nd1 * iv) / (2*Math.sqrt(t)) / 365).toFixed(2)),
  };
}

function calcVWAP(bars) {
  if (!bars || !bars.length) return 0;
  let cumTPV = 0, cumVol = 0;
  for (const bar of bars) {
    const tp = (bar.h + bar.l + bar.c) / 3;
    cumTPV += tp * bar.v;
    cumVol += bar.v;
  }
  return cumVol > 0 ? parseFloat((cumTPV / cumVol).toFixed(2)) : 0;
}

function calcSharpeRatio() {
  const trades = state.closedTrades || [];
  if (trades.length < 5) return 0;
  const returns  = trades.map(t => t.pct || 0);
  const avg      = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / returns.length;
  const stdDev   = Math.sqrt(variance);
  const riskFree = 0.05 / 252;
  return stdDev > 0 ? parseFloat(((avg - riskFree) / stdDev).toFixed(2)) : 0;
}

function calcVaR() {
  const trades = state.closedTrades || [];
  if (trades.length < 10) return 0;
  const losses = trades.map(t => t.pnl).sort((a, b) => a - b);
  return Math.abs(losses[Math.floor(losses.length * 0.05)] || 0);
}

function calcMAE() {
  const losses = (state.closedTrades || []).filter(t => t.pnl < 0).map(t => Math.abs(t.pnl));
  return losses.length ? Math.max(...losses) : 0;
}

function calcCalmarRatio() {
  const trades = state.closedTrades || [];
  if (!trades.length) return null;
  const totalPnL = trades.reduce((s,t) => s + (t.pnl||0), 0);
  const annualized = totalPnL * (252 / Math.max(trades.length, 1));
  const maxDD = Math.min(...trades.map((_,i) => trades.slice(0,i+1).reduce((s,t)=>s+(t.pnl||0),0)));
  return maxDD < 0 ? parseFloat((annualized / Math.abs(maxDD)).toFixed(2)) : null;
}

function calcInformationRatio() {
  const trades = state.closedTrades || [];
  if (trades.length < 5) return null;
  const returns = trades.map(t => (t.pnl||0) / Math.max(t.cost||100, 1));
  const avg = returns.reduce((s,r)=>s+r,0) / returns.length;
  const std = Math.sqrt(returns.reduce((s,r)=>s+(r-avg)**2,0) / returns.length);
  return std > 0 ? parseFloat((avg / std * Math.sqrt(252)).toFixed(2)) : null;
}

function calcAutocorrelation() {
  const trades = state.closedTrades || [];
  if (trades.length < 10) return null;
  const returns = trades.slice(0,20).map(t => (t.pnl||0));
  const n = returns.length - 1;
  const mean = returns.reduce((s,r)=>s+r,0) / returns.length;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) num += (returns[i]-mean)*(returns[i+1]-mean);
  for (let i = 0; i < returns.length; i++) den += (returns[i]-mean)**2;
  return den > 0 ? parseFloat((num/den).toFixed(3)) : null;
}

function calcRiskOfRuin() {
  const trades = state.closedTrades || [];
  if (trades.length < 5) return { probability: 0, message: `Need ${5 - trades.length} more trades for estimate` };
  const wins  = trades.filter(t => (t.pnl||0) > 0).length;
  const losses = trades.length - wins;
  const wr    = wins / trades.length;
  if (wr === 0) return { probability: 99.9, message: "No winning trades yet" };
  if (wr === 1) return { probability: 0.0,  message: "100% win rate (small sample)" };
  const avgW = trades.filter(t=>(t.pnl||0)>0).reduce((s,t)=>s+(t.pnl||0),0) / Math.max(wins,1);
  const avgL = Math.abs(trades.filter(t=>(t.pnl||0)<=0).reduce((s,t)=>s+(t.pnl||0),0)) / Math.max(losses,1);
  const edge = wr * avgW - (1-wr) * avgL;
  if (edge <= 0) return { probability: 99.9, message: "Negative edge - review strategy" };
  // Risk of ruin formula: ((1-wr)/wr)^(capital/avgL)
  // Simplified: use 10 unit approximation
  const ratio = (1 - wr) / wr;
  const ror   = Math.min(99.9, parseFloat((Math.pow(ratio, 10) * 100).toFixed(1)));
  const msg   = ror < 1   ? "Excellent - very low ruin risk"
              : ror < 5   ? "Good - manageable risk profile"
              : ror < 20  ? "Moderate - watch position sizing"
              : ror < 50  ? "High - reduce size or improve edge"
              : "Critical - strategy needs review";
  return { probability: isNaN(ror) ? 0 : ror, message: msg };
}

function calcDrawdownDuration() {
  const trades = state.closedTrades || [];
  if (!trades.length) return { avgDuration: 0, maxDuration: 0, currentDuration: 0 };
  let maxDuration = 0, currentDuration = 0, totalDuration = 0, ddCount = 0;
  let peak = 0, running = 0, inDD = false;
  trades.forEach(t => {
    running += (t.pnl||0);
    if (running > peak) {
      if (inDD && currentDuration > 0) { totalDuration += currentDuration; ddCount++; }
      peak = running; inDD = false; currentDuration = 0;
    } else {
      inDD = true; currentDuration++;
      maxDuration = Math.max(maxDuration, currentDuration);
    }
  });
  if (inDD && currentDuration > 0) { totalDuration += currentDuration; ddCount++; }
  const avgDuration = ddCount > 0 ? parseFloat((totalDuration / ddCount).toFixed(1)) : 0;
  return { avgDuration, maxDuration, currentDuration: inDD ? currentDuration : 0 };
}

function calcFactorScore(stock, signals, relStrength, newsModifier, analystModifier) {
  const factors = {};
  factors.momentum    = signals.momentum === "strong" ? 25 : signals.momentum === "steady" ? 15 : 5;
  const rsi           = signals.rsi || 50;
  factors.trend       = rsi >= 50 && rsi <= 65 ? 20 : rsi >= 45 && rsi < 50 ? 12 : rsi > 65 && rsi <= 75 ? 8 : 5;
  factors.relStrength = relStrength > 1.05 ? 20 : relStrength > 1.02 ? 15 : relStrength > 1.0 ? 10 : 5;
  const ivr           = signals.ivr || stock.ivr || 50;
  factors.value       = ivr < 25 ? 20 : ivr < 40 ? 15 : ivr < 55 ? 10 : 5;
  const sentimentRaw  = (newsModifier || 0) + (analystModifier || 0);
  factors.sentiment   = parseFloat(Math.min(15, Math.max(0, 7 + sentimentRaw / 3)).toFixed(1));
  const total         = Object.values(factors).reduce((s, v) => s + v, 0);
  return { total: Math.min(100, Math.round(total)), factors };
}

async function getLiveBeta(ticker) {
  // Fetch beta from Alpaca snapshot fundamentals
  // Falls back to watchlist value if unavailable
  try {
    const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
    if (snap && snap.fundamentals && snap.fundamentals.beta) {
      return parseFloat(snap.fundamentals.beta);
    }
    // Some snapshots return beta in a different field
    if (snap && snap.beta) return parseFloat(snap.beta);
  } catch(e) {}
  return null; // null = use watchlist fallback
}

async function getDynamicSignals(ticker, bars, intradayBars = null, realOptionsIV = null) {
  // Cache signals within scan window - same bars = same signals
  const sigKey = `sigs:${ticker}:${(bars||[]).length}`;
  // OPT-3: 90s TTL -- intraday momentum changes minute-to-minute, 5min cache is too stale
  const sigCached = _slowCache.get(sigKey);
  if (sigCached && (Date.now() - sigCached.ts) < 90000) return sigCached.data;
  // Use prefetched intraday bars if provided, otherwise fetch now
  if (!intradayBars) intradayBars = await getIntradayBars(ticker);
  const signalBars   = intradayBars.length >= 10 ? intradayBars : bars;

  // RSI: TWO values calculated separately (V2.81 panel fix)
  // rsi: 1-min intraday bars -- for display, VWAP timing, and momentum direction only
  // dailyRsi: daily bars -- for ALL entry scoring thresholds (70/35 calibrated on daily data by Wilder)
  // Panel finding: RSI can move 7+ points in 10 seconds on 1-min bars -- not a regime signal
  // MACD: daily bars ONLY - intraday MACD (12/26/9) produces false crossovers on sub-daily data
  // Technical analyst fix: standardize MACD to daily timeframe
  const rsi      = calcRSI(signalBars);                          // intraday RSI -- display/timing only
  const dailyRsi = bars.length >= 14 ? calcRSI(bars) : rsi;     // daily RSI -- all scoring thresholds
  const macd     = calcMACD(bars.length >= 26 ? bars : signalBars); // daily preferred
  // TA-W2: ATR from daily bars - normalizes signal interpretation
  const atrRaw   = calcATR(bars.length >= 15 ? bars : signalBars, 14);
  const atrPct   = atrRaw && bars.length > 0 ? atrRaw / bars[bars.length-1].c : null; // ATR as % of price

  // Momentum from intraday - is it moving up or down TODAY?
  let momentum;
  if (intradayBars.length >= 10) {
    const first = intradayBars[0].c;
    const last  = intradayBars[intradayBars.length - 1].c;
    const move  = (last - first) / first;
    const recentMove = intradayBars.length >= 6
      ? (last - intradayBars[intradayBars.length - 6].c) / intradayBars[intradayBars.length - 6].c
      : move;
    // Strong intraday move > 1.5% = strong, 0.5-1.5% = steady, negative = recovering (bearish)
    if (move > 0.015 && recentMove > 0.005)        momentum = "strong";
    else if (move < -0.005 || recentMove < -0.005) momentum = "recovering"; // bearish intraday
    else                                            momentum = "steady";
  } else {
    momentum = calcMomentum(bars); // fall back to daily
  }

  const adx = calcADX(signalBars.length >= 14 ? signalBars : bars);

  // IV rank + IV Percentile - both use daily bars for historical context
  // IVR: where is IV in its 52-week range
  // IV Percentile: what % of days had lower IV (more accurate measure)
  const recentBars = bars.slice(-20);
  const returns    = recentBars.slice(1).map((b, i) => Math.log(b.c / recentBars[i].c));
  const stdDev     = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
  const currentIV  = stdDev * Math.sqrt(252);
  const ivr        = calcIVRank(currentIV, bars);

  // IV Percentile - % of days where IV was lower than today
  // Uses realized vol from price bars as proxy for IV history
  // When real options IV is available (passed in), it replaces the approximation
  let ivPercentile = 50; // default
  if (bars.length >= 30) {
    const allIVs = [];
    for (let i = 1; i < bars.length; i++) {
      const ret = Math.log(bars[i].c / bars[i-1].c);
      allIVs.push(Math.abs(ret) * Math.sqrt(252));
    }
    // Use real options IV if available, else use approximation
    const ivForPercentile = (typeof realOptionsIV === 'number' && realOptionsIV > 0) ? realOptionsIV : currentIV;
    const daysBelow = allIVs.filter(iv => iv < ivForPercentile).length;
    ivPercentile = Math.round((daysBelow / allIVs.length) * 100);
  }

  // Intraday VWAP
  const intradayVWAP = intradayBars.length >= 5 ? calcVWAP(intradayBars) : 0;

  // Volume ratio - today's intraday volume vs expected (based on time of day)
  const intradayVol  = intradayBars.reduce((s, b) => s + b.v, 0);
  const avgDailyVol  = bars.length ? bars.slice(-20).reduce((s,b)=>s+b.v,0)/20 : 0;
  // Adjust for time of day - if 2 hours into session, expect ~40% of daily vol
  const etH = getETTime().getHours() + getETTime().getMinutes() / 60;
  const sessionPct = Math.min(1, Math.max(0.1, (etH - 9.5) / 6.5)); // 0-100% through session
  const expectedVol = avgDailyVol * sessionPct;
  const volPaceRatio = expectedVol > 0 ? intradayVol / expectedVol : 1;

  return {
    rsi,           // intraday RSI -- display and timing only
    dailyRsi,      // daily RSI -- use this for all scoring thresholds (V2.81)
    macd:          macd.signal,
    momentum,
    adx,
    ivr,
    ivPercentile,  // % of days with lower IV - high = options expensive
    intradayVWAP,
    intradayVol,
    volPaceRatio,
    atrPct:        atrPct || null, // ATR as % of price - TA-W2 normalization
    hasIntraday:   intradayBars.length >= 10,
  };
}

function calcBetaWeightedDelta() {
  if (!state.positions || !state.positions.length) return 0;
  // Use cached SPY price from scan context, or fetch fresh - never use hardcoded value
  const spyPrice = (state.positions.find(p => p.ticker === "SPY")?.price) || state._liveSPY || 560;
  let totalBWD   = 0;
  for (const pos of state.positions) {
    const delta    = parseFloat(pos.greeks?.delta || 0);
    const beta     = pos.beta || 1;
    const price    = pos.price || 100;
    const contracts= pos.contracts || 1;
    // Beta-weighted delta = delta * beta * (stock price / SPY price) * 100 * contracts
    const bwd      = delta * beta * (price / spyPrice) * 100 * contracts;
    totalBWD      += pos.optionType === "put" ? -bwd : bwd;
  }
  return parseFloat(totalBWD.toFixed(2));
}

function calcAggregateGreeks() {
  if (!state.positions || !state.positions.length) return { vega: 0, gamma: 0, vegaDollar: 0, vegaRisk: "LOW" };
  let totalVega = 0, totalGamma = 0;
  for (const pos of state.positions) {
    const vega     = parseFloat(pos.greeks?.vega  || 0);
    const gamma    = parseFloat(pos.greeks?.gamma || 0);
    const mult     = (pos.contracts || 1) * 100;
    totalVega  += vega  * mult;
    totalGamma += gamma * mult;
  }
  const vegaDollar = parseFloat((totalVega * 0.01 * 100).toFixed(2));
  return {
    vega:       parseFloat(totalVega.toFixed(4)),
    gamma:      parseFloat(totalGamma.toFixed(4)),
    vegaDollar, // $ change per 1pt VIX move
    vegaRisk:   Math.abs(vegaDollar) > 500 ? "HIGH" : Math.abs(vegaDollar) > 200 ? "MEDIUM" : "LOW",
  };
}

function calcKellySize(recentTrades = 20) {
  const trades  = (state.closedTrades || []).slice(0, recentTrades);
  // QS-W3: Kelly needs minimum 10 trades for any statistical relevance
  // Below 10 trades, Kelly is noise not signal - default to 1 contract
  // Below 20 trades, Kelly is unreliable - cap its influence at half weight
  if (trades.length < 5)  return { contracts: 1, kelly: null, halfKelly: null, winRate: null, payoffRatio: null, note: "Need 5+ trades" };
  if (trades.length < 10) return { contracts: 1, kelly: null, halfKelly: null, winRate: null, payoffRatio: null, note: "Need 10+ trades for Kelly" };
  const wins      = trades.filter(t => t.pnl > 0);
  const losses    = trades.filter(t => t.pnl <= 0);
  const winRate   = wins.length / trades.length;
  const avgWin    = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss   = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  const payoff    = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kelly     = winRate - (1 - winRate) / payoff;
  const halfKelly = Math.max(0, kelly * 0.5);
  // Hard cap: max 2 contracts until 30 validated trades
  // Kelly on small samples produces dangerously high sizing
  // Chan: adjust Kelly for current drawdown - deeper drawdown = smaller fraction
  // Vince: Kelly fraction should DECAY on consecutive losses, not reset
  const peakCap    = state.peakCash || MONTHLY_BUDGET;
  // Use mark-to-market value not cost basis - openRisk() uses currentPrice
  const currentVal = state.cash + openRisk();
  const drawdownPct = peakCap > 0 ? (peakCap - currentVal) / peakCap : 0;
  const ddAdj      = drawdownPct > 0.15 ? 0.50   // >15% drawdown: half Kelly
                   : drawdownPct > 0.10 ? 0.65   // >10% drawdown: 65% of Kelly
                   : drawdownPct > 0.05 ? 0.80   // >5% drawdown: 80% of Kelly
                   : 1.0;                          // <5% drawdown: full Kelly
  // Vince: consecutive losses decay Kelly fraction - don't just reset
  const consecLoss = state.consecutiveLosses || 0;
  const consAdj    = consecLoss >= 3 ? 0.50      // 3+ losses: half Kelly
                   : consecLoss >= 2 ? 0.70       // 2 losses: 70% of Kelly
                   : consecLoss >= 1 ? 0.85       // 1 loss: 85% of Kelly
                   : 1.0;
  const adjustedHalfKelly = halfKelly * ddAdj * consAdj;
  const rawContracts = Math.min(3, Math.max(1, Math.round(adjustedHalfKelly * 10)));
  const contracts    = trades.length < 30 ? Math.min(2, rawContracts) : rawContracts;
  return { contracts, kelly: parseFloat(kelly.toFixed(3)), halfKelly: parseFloat(adjustedHalfKelly.toFixed(3)), winRate: parseFloat((winRate*100).toFixed(1)), payoffRatio: parseFloat(payoff.toFixed(2)), cappedPre30: trades.length < 30, ddAdj, consAdj };
}

function getDeployableCash() {
  // Everything above the floor is deployable - floor itself is managed separately
  return Math.max(0, state.cash - CAPITAL_FLOOR);
}

const effectiveHeatCap = (strategyType) => {
  const phase = getAccountPhase();
  // 3C: Heat cap differentiation by strategy type (panel decision)
  // Debit spreads / correlated credit spreads: standard caps (defined below)
  // Iron condors (defined risk both sides): 80% max - panel endorsed
  // Credit spreads, sector-diverse: 75% max - only when XLE/KRE added
  if (strategyType === "iron_condor") {
    if (phase === "preservation") return 0.40;
    return 0.80; // defined risk both directions
  }
  if (strategyType === "credit_diverse") {
    if (phase === "preservation") return 0.45;
    return 0.75; // diverse sectors, defined risk
  }
  // Default: debit spreads and correlated credit spreads
  if (phase === "preservation") return state.vix >= 25 ? 0.30 : 0.40;
  if (phase === "transition")   return state.vix >= 30 ? 0.35 : state.vix >= 25 ? 0.45 : 0.50;
  return state.vix >= 30 ? 0.40 : state.vix >= 25 ? 0.50 : MAX_HEAT;
}

function getAccountPhase() {
  const accountVal = (state.alpacaCash || state.cash || 0) + openCostBasis();
  if (accountVal >= 20000) return "preservation";
  if (accountVal >= 15000) return "transition";
  return "growth";
}

function calcCreditSpreadTP(entryVix) {
  const vix = entryVix || state.vix || 20;
  if (vix >= 25) return 0.35;
  if (vix >= 20) return 0.40;
  return 0.50;
}

function getETTime(date) {
  const str = (date || new Date()).toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(str);
}

function isDST(date) {
  // Kept for compatibility but getETTime() is now used everywhere
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return Math.max(jan, jul) !== date.getTimezoneOffset();
}

function isMarketHours() {
  const et   = getETTime();
  const h    = et.getHours(), m = et.getMinutes();
  const day  = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = h * 60 + m;
  return mins >= 570 && mins <= 960; // 9:30 AM - 4:00 PM ET
}

function isEntryWindow(optionType = null, isIndex = false) {
  const et  = getETTime();
  const h   = et.getHours(), m = et.getMinutes();
  const day = et.getDay();
  if (day === 0 || day === 6) return false;

  const minsSinceMidnight = h * 60 + m;
  const marketClose       = 15 * 60 + 45; // 3:45 PM - index options stay open later
  const indexStart        = 9 * 60 + 30;  // 9:30 AM - SPY/QQQ open at bell
  const stockStart        = 9 * 60 + 45;  // 9:45 AM - individual stocks need price discovery

  if (minsSinceMidnight > marketClose) return false;
  return minsSinceMidnight >= (isIndex ? indexStart : stockStart);
}

function getBusinessDaysAgo(n) {
  // Returns the date n business days ago (skips weekends)
  let date = new Date();
  let count = 0;
  while (count < n) {
    date.setDate(date.getDate() - 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) count++; // skip Sat/Sun
  }
  return date;
}

async function getWeeklyTrend(ticker) {
  try {
    const cached = getCached('weekly:' + ticker);
    if (cached) return cached;
    const bars = await getStockBars(ticker, 70); // 70 days = ~14 weeks
    if (bars.length < 50) return setCache('weekly:' + ticker, { trend: 'neutral', above10wk: null });
    const ma10w = bars.slice(-50).reduce((s, b) => s + b.c, 0) / 50;
    const price = bars[bars.length-1].c;
    const pctFromMA = (price - ma10w) / ma10w;
    const trend = pctFromMA > 0.02 ? 'above' : pctFromMA < -0.02 ? 'below' : 'at';
    // TA-W3: MA slope matters more than price position
    // Rising MA with price below = bullish context; falling MA with price above = bearish
    const ma10w_prev  = bars.length >= 55 ? bars.slice(-55,-5).reduce((s,b)=>s+b.c,0)/50 : ma10w;
    const maSlope     = (ma10w - ma10w_prev) / ma10w_prev; // positive = rising, negative = falling
    const maSlopeDir  = maSlope > 0.005 ? 'rising' : maSlope < -0.005 ? 'falling' : 'flat';
    // Bullish when: above MA or (below MA but MA rising = pullback in uptrend)
    // Bearish when: below MA and MA falling (confirmed downtrend)
    const trendContext = (price > ma10w && maSlopeDir !== 'falling') ? 'aligned_bull'
                       : (price < ma10w && maSlopeDir === 'rising')  ? 'pullback_bull'
                       : (price < ma10w && maSlopeDir === 'falling') ? 'confirmed_bear'
                       : 'neutral';
    return setCache('weekly:' + ticker, { trend, ma10w: parseFloat(ma10w.toFixed(2)), pctFromMA: parseFloat((pctFromMA*100).toFixed(1)), above10wk: price > ma10w, maSlope: parseFloat((maSlope*100).toFixed(2)), maSlopeDir, trendContext });
  } catch(e) { return { trend: 'neutral', above10wk: null }; }
}

function getSupportResistance(bars) {
  if (bars.length < 20) return { support: 0, resistance: Infinity };
  const recent = bars.slice(-20);
  const highs  = recent.map(b => b.h);
  const lows   = recent.map(b => b.l);
  return {
    resistance: Math.max(...highs),
    support:    Math.min(...lows),
  };
}

// ─── Portfolio analytics ─────────────────────────────────────────
const totalCap    = () => Math.max(state.customBudget || 0, state.cash || 0, state.accountBaseline || 0, MONTHLY_BUDGET);
// Mark-to-market: use current price not entry cost for real portfolio value
// currentPrice is updated every reconciliation from Alpaca market values
const openRisk    = () => state.positions.reduce((s,p) => {
  const curP     = p.currentPrice || p.premium || 0;
  const mktValue = curP * 100 * (p.contracts || 1) * (p.partialClosed ? 0.5 : 1);
  return s + mktValue;
}, 0);
// Entry cost basis (for heat calculations - should use cost not market value)
const openCostBasis = () => state.positions.reduce((s,p) => s + p.cost * (p.partialClosed ? 0.5 : 1), 0);
const heatPct     = () => Math.max(0, openCostBasis()) / totalCap(); // margin deployed / total cap — 0% with no positions
const realizedPnL = () => state.closedTrades.reduce((s,t) => s + t.pnl, 0);
const stockValue  = () => state.stockPositions.reduce((s,p) => s + p.cost, 0);

module.exports = {
  calcRSI, calcEMA, calcMACD, calcMomentum, calcATR, calcADX,
  calcIVRank, calcGreeks, calcVWAP, calcKellySize,
  calcSharpeRatio, calcVaR, calcRiskOfRuin, calcDrawdownDuration,
  getLiveBeta, getDynamicSignals, calcBetaWeightedDelta, calcAggregateGreeks,
  totalCap, openRisk, openCostBasis, heatPct, realizedPnL, stockValue,
  getDeployableCash, effectiveHeatCap, getAccountPhase, calcCreditSpreadTP,
  getETTime, isDST, isMarketHours, isEntryWindow, getBusinessDaysAgo,
  getWeeklyTrend, getSupportResistance, setSignalsLogger,
  calcMAE, calcFactorScore,
};;
