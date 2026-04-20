// backtest.js — ARGO V3.2
// Backtesting engine and simulation.
'use strict';
const { alpacaGet, getStockBars } = require('./broker');
const { state, logEvent }         = require('./state');
const { calcRSI, calcMACD, calcATR, calcMomentum } = require('./signals');
const { WATCHLIST, MONTHLY_BUDGET, STOP_LOSS_PCT,
        TAKE_PROFIT_PCT, MS_PER_DAY ,
  ALPACA_DATA
}              = require('./constants');

async function fetchHistoricalBars(ticker, startDate, endDate) {
  // Fetch a large window of daily bars between two dates
  try {
    const feeds = ["sip", "iex"];
    for (const feed of feeds) {
      const url  = `/stocks/${ticker}/bars?timeframe=1Day&start=${startDate}&end=${endDate}&limit=1000&feed=${feed}`;
      const data = await alpacaGet(url, ALPACA_DATA);
      if (data && data.bars && data.bars.length > 5) return data.bars;
    }
    const last = await alpacaGet(`/stocks/${ticker}/bars?timeframe=1Day&start=${startDate}&end=${endDate}&limit=1000`, ALPACA_DATA);
    return last && last.bars ? last.bars : [];
  } catch(e) {
    logEvent("warn", `[BACKTEST] fetchHistoricalBars failed for ${ticker}: ${e.message}`);
    return [];
  }
}

function backtestClassifyRegime(bars, idx, vixEst) {
  const slice  = bars.slice(0, idx + 1);
  const price  = slice[slice.length - 1].c;
  const sma20  = slice.length >= 20  ? slice.slice(-20).reduce((s,b)=>s+b.c,0)/20  : price;
  const sma50  = slice.length >= 50  ? slice.slice(-50).reduce((s,b)=>s+b.c,0)/50  : price;
  const sma200 = slice.length >= 200 ? slice.slice(-200).reduce((s,b)=>s+b.c,0)/200 : price;
  const mom5   = slice.length >= 5   ? (price - slice[slice.length-5].c)/slice[slice.length-5].c*100 : 0;
  const mom20  = slice.length >= 20  ? (price - slice[slice.length-20].c)/slice[slice.length-20].c*100 : 0;

  // RSI for bounce detection
  const rsi = calcRSI(slice);

  let regimeClass = "A";
  let entryBias   = "neutral";
  let tradeType   = "spread";

  if (vixEst >= 35 && price < sma200) {
    regimeClass = "C"; entryBias = "puts_on_bounces"; tradeType = "credit";
  } else if (price < sma50 && (sma20 < sma50 || mom20 < -1)) {
    // Fix 4: loosened from (sma20<sma50 AND mom20<-2) - captures developing downtrends
    // where SMA20 hasn't crossed below SMA50 yet but momentum is already negative
    regimeClass = "B"; entryBias = "puts_on_bounces"; tradeType = "spread";
  } else if (price > sma20 && sma20 > sma50 && mom20 > 2) {
    regimeClass = "A"; entryBias = "calls_on_dips"; tradeType = "spread";
  } else {
    regimeClass = "A"; entryBias = "neutral"; tradeType = "spread";
  }

  // Fix 1: Widened bounce detection window
  // Old: RSI 45-65 AND mom5 > 0
  // New: RSI 38-72 AND mom5 > -2.0%
  // RSI 38-44: recovering from oversold = valid entry (stock bouncing back up)
  // RSI 66-72: overbought relief bounce = valid put entry (chasing rally)
  // mom5 > -2%: allows slight downward pressure, not requiring a full positive day
  const isBounce = regimeClass !== "A" && rsi >= 38 && rsi <= 72 && mom5 > -2.0 && mom20 < 0;
  const isPutsOnBounces = (regimeClass === "B" || regimeClass === "C") && isBounce;

  return { regimeClass, entryBias, tradeType, sma20, sma50, sma200, mom5, mom20, rsi, isBounce, isPutsOnBounces };
}

function backtestScoreSignal(bars, idx, optionType) {
  // Replay ARGO's scoring signals from a slice of historical bars
  // Returns score + reasons using the same calcRSI/calcMACD/calcATR functions
  if (idx < 26) return { score: 0, reasons: ["insufficient history"] };
  const slice = bars.slice(0, idx + 1); // bars up to and including today
  const rsi   = calcRSI(slice);
  const macd  = calcMACD(slice);
  const atrRaw = calcATR(slice, 14);
  const price  = slice[slice.length - 1].c;
  const atrPct = atrRaw ? atrRaw / price : 0.01;

  let score   = 50; // base
  const reasons = [];

  // RSI signal
  if (optionType === "put") {
    if (rsi >= 70)       { score += 20; reasons.push(`RSI ${rsi.toFixed(0)} overbought (+20)`); }
    else if (rsi >= 60)  { score += 10; reasons.push(`RSI ${rsi.toFixed(0)} elevated (+10)`); }
    else if (rsi <= 35)  { return { score: 0, reasons: [`RSI ${rsi.toFixed(0)} oversold - HARD BLOCK`] }; }
    else if (rsi <= 39)  { score -= 15; reasons.push(`RSI ${rsi.toFixed(0)} deeply oversold for puts (-15)`); }
    else if (rsi <= 45)  { score -= 8;  reasons.push(`RSI ${rsi.toFixed(0)} recovering from oversold (-8)`); }
    else                 { reasons.push(`RSI ${rsi.toFixed(0)} neutral`); }
  } else {
    if (rsi <= 35)       { score += 25; reasons.push(`RSI ${rsi.toFixed(0)} extreme oversold - MR call (+25)`); }
    else if (rsi <= 45)  { score += 12; reasons.push(`RSI ${rsi.toFixed(0)} oversold dip (+12)`); }
    else if (rsi >= 70)  { score -= 15; reasons.push(`RSI ${rsi.toFixed(0)} overbought for calls (-15)`); }
    else                 { reasons.push(`RSI ${rsi.toFixed(0)} neutral`); }
  }

  // MACD signal
  if (optionType === "put") {
    if (macd.signal.includes("bearish crossover"))  { score += 15; reasons.push("MACD bearish crossover (+15)"); }
    else if (macd.signal.includes("bearish"))       { score += 8;  reasons.push("MACD bearish (+8)"); }
    else if (macd.signal.includes("bullish crossover")) { score -= 12; reasons.push("MACD bullish crossover (-12)"); }
    else if (macd.signal.includes("bullish"))       { score -= 6;  reasons.push("MACD bullish (-6)"); }
  } else {
    if (macd.signal.includes("bullish crossover"))  { score += 15; reasons.push("MACD bullish crossover (+15)"); }
    else if (macd.signal.includes("bullish"))       { score += 8;  reasons.push("MACD bullish (+8)"); }
    else if (macd.signal.includes("bearish crossover")) { score -= 12; reasons.push("MACD bearish crossover (-12)"); }
    else if (macd.signal.includes("bearish"))       { score -= 6;  reasons.push("MACD bearish (-6)"); }
  }

  // Momentum
  const recent5  = (slice[slice.length-1].c - slice[slice.length-6].c) / slice[slice.length-6].c;
  const recent20 = slice.length >= 21 ? (slice[slice.length-1].c - slice[slice.length-21].c) / slice[slice.length-21].c : 0;
  if (optionType === "put") {
    if (recent5 < -0.01 && recent20 < -0.02) { score += 15; reasons.push(`Weak momentum (${(recent5*100).toFixed(1)}% 5d) (+15)`); }
    else if (recent5 > 0.01)                 { score -= 10; reasons.push(`Strong momentum - wrong for puts (-10)`); }
  } else {
    if (recent5 > 0.01 && recent20 > 0.02)   { score += 15; reasons.push(`Strong momentum (${(recent5*100).toFixed(1)}% 5d) (+15)`); }
    else if (recent5 < -0.01)                { score -= 10; reasons.push(`Weak momentum - wrong for calls (-10)`); }
  }

  // ATR normalization - penalize chasing extended moves
  const todayMove = Math.abs(slice[slice.length-1].c - slice[slice.length-2].c) / slice[slice.length-2].c;
  if (atrPct > 0 && todayMove > atrPct * 2) {
    score -= 10; reasons.push(`Move ${(todayMove*100).toFixed(1)}% > 2x ATR ${(atrPct*100).toFixed(1)}% - extended (-10)`);
  }

  // BT-3: Agent score simulation - closes the gap between backtest and live scores
  // Live ARGO gets +25-35 pts from Claude agent at high confidence. Backtest approximates
  // using technical regime signals the agent would be reading.
  const sma20 = slice.slice(-20).reduce((s,b) => s + b.c, 0) / 20;
  const sma50 = slice.length >= 50 ? slice.slice(-50).reduce((s,b) => s + b.c, 0) / 50 : sma20;
  const mom20 = slice.length >= 21 ? (price - slice[slice.length-21].c) / slice[slice.length-21].c * 100 : 0;
  const adxProxy = Math.abs(mom20) * 2 + (atrPct * 100);
  let agentBonus = 0;
  let agentRegime = "neutral";
  if (price < sma20 && sma20 < sma50 && mom20 < -2) {
    agentRegime = "trending_bear";
    // Raised from -20 to -25 - live agent reads news/VIX and gives high-confidence calls
    // worth +30-35; +25 is a more accurate approximation than +20
    agentBonus = optionType === "put" ? 25 : -25;
  } else if (price > sma20 && sma20 > sma50 && mom20 > 2) {
    agentRegime = "trending_bull";
    agentBonus  = optionType === "call" ? 25 : -25;
  } else if (Math.abs(mom20) < 1) {
    agentRegime = "choppy";
    // Neutral - no bonus or penalty. Let RSI/MACD/momentum signals carry the score.
    // Choppy markets (2023) still have valid high-signal entries; the agent is just
    // less directionally confident, not blocking. Only high-signal days (RSI extreme
    // + MACD crossover + weak/strong momentum) will clear 75+ unaided.
    agentBonus = 0;
  }
  if (agentBonus !== 0) {
    score += agentBonus;
    reasons.push(`~Agent ${agentRegime} simulation (${agentBonus > 0 ? '+' : ''}${agentBonus})`);
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, agentRegime };
}

function simulateOptionPnL(entryPrice, optionType, holdDays, outcome, ticker = "SPY", vixEst = 20) {
  // Simulate option P&L based on underlying price change
  // Uses realistic delta-based approximation with theta decay
  // outcome: { priceDelta (%), vixShift, daysToExpiry }
  const { priceDelta, daysToExpiry = 21, vixShift = 0 } = outcome;

  // Delta approximation: ATM delta ~0.50, shifts with price
  const baseDelta  = optionType === "call" ? 0.45 : -0.45;
  const deltaValue = baseDelta * priceDelta * entryPrice; // $ move in option

  // Theta decay: daily theta - premium / (2 * DTE) for ATM options
  const dailyTheta = entryPrice / (2 * Math.max(daysToExpiry, 7));
  const thetaLoss  = dailyTheta * holdDays;

  // Vega shift: VIX up = calls hurt, puts benefit (simplified)
  const vegaImpact = vixShift * entryPrice * 0.05 * (optionType === "call" ? -1 : 1);

  // BT-1: Slippage model - VIX-scaled realistic fill cost
  // Based on observed live options spreads at different volatility regimes
  // Applied at both entry AND exit (round-trip cost)
  const slippagePct = vixEst >= 30 ? 0.07   // VIX 30+: wide spreads, chaotic markets
                    : vixEst >= 20 ? 0.04   // VIX 20-30: moderate spread widening
                    :                0.02;  // VIX < 20: tight spreads, liquid
  const slippageCost = entryPrice * slippagePct; // applied as $ reduction to entry premium

  // BT-2: Bid-ask spread cost - instrument-specific, applied at entry
  // Based on typical SPY/QQQ/IWM/GLD options market width
  const spreadCost = ticker === "GLD" ? 0.20
                   : ticker === "TLT" ? 0.18  // bond ETF - moderate liquidity
                   : ticker === "QQQ" ? 0.12
                   :                   0.08; // SPY - most liquid

  // Total transaction cost: slippage + half bid-ask spread (we pay on entry, receive on exit)
  // Round-trip: slippage - 2 (entry + exit), spread - 1 (net cost of crossing spread)
  const totalTxCost = (slippageCost * 2) + spreadCost;

  const pnlRaw = (deltaValue - thetaLoss + vegaImpact);
  const pnlNet = pnlRaw - totalTxCost; // deduct realistic transaction costs
  const pnlPct = pnlNet / entryPrice;

  return Math.max(-0.95, Math.min(2.0, pnlPct)); // cap at -95% to +200%
}

function simulateSpreadPnL(netDebit, spreadWidth, optionType, tradeType, holdDays, priceDeltaPct, vixEst = 20, ticker = "SPY") {
  // Spread economics (dollar terms, per contract):
  // Debit spread: paid netDebit upfront. Max profit = spreadWidth - netDebit. Max loss = netDebit.
  // Credit spread: received netCredit. Max profit = netCredit. Max loss = spreadWidth - netCredit.
  // P&L is expressed as fraction of netDebit so it can be compared to takeProfitPct/stopLossPct.
  const isCredit  = tradeType === "credit";
  const maxProfit = isCredit ? netDebit : (spreadWidth - netDebit);
  const maxLoss   = isCredit ? (spreadWidth - netDebit) : netDebit;

  // Directed move: positive = favorable for the option type
  // Puts benefit from underlying falling, calls from rising
  const directedMove = optionType === "put" ? -priceDeltaPct : priceDeltaPct;

  // Spread value change: how much the spread moves in dollar terms
  // Net delta of ATM/OTM debit spread - 0.15
  // At full max move (15%+), spread reaches its maximum value
  const moveMagnitude = Math.min(Math.abs(directedMove), 0.15);
  const spreadValueChange = (moveMagnitude / 0.15) * spreadWidth; // $0 - $spreadWidth

  // Theta decay: daily cost of holding a debit spread (enemy) or benefit (credit)
  const dailyTheta  = netDebit / (2 * Math.max(21 - holdDays, 5));
  const thetaImpact = isCredit ? (dailyTheta * holdDays) : -(dailyTheta * holdDays);

  // Transaction costs: slippage (entry + exit round-trip) + bid-ask (two legs)
  const slippagePerLeg = vixEst >= 30 ? 0.06 : vixEst >= 20 ? 0.04 : 0.02;
  const legSpreadCost  = ticker === "SPY" ? 0.05 : ticker === "QQQ" ? 0.07 : 0.10;
  const totalTxCost    = (slippagePerLeg * 2) + legSpreadCost;

  // Gross P&L in dollar terms (before tx costs)
  // KEY FIX: spreadValueChange is the $ GAIN in spread value vs 0 baseline.
  // The cost basis (netDebit) is already captured in positionCost - do NOT subtract here.
  let grossPnL;
  if (isCredit) {
    // Credit spread: we keep credit as price moves away from short strike
    if (directedMove >= 0) {
      grossPnL = Math.min(maxProfit, maxProfit * (moveMagnitude / 0.08));
    } else {
      grossPnL = Math.max(-maxLoss, -maxLoss * (moveMagnitude / 0.08));
    }
    grossPnL += thetaImpact;
  } else {
    // Debit spread: spread gains value as underlying moves in our direction
    // Favorable: spread value increases from ~0 toward max profit
    // Unfavorable: spread value erodes from netDebit toward 0
    if (directedMove > 0) {
      // Favorable - spread gains value proportional to move, capped at maxProfit
      grossPnL = Math.min(maxProfit, spreadValueChange);
    } else {
      // Unfavorable - spread loses value proportional to move, max loss = netDebit
      grossPnL = Math.max(-maxLoss, -(maxLoss * (moveMagnitude / 0.15)));
    }
    grossPnL += thetaImpact;
  }

  const netPnL = grossPnL - totalTxCost;
  // Return as fraction of netDebit for comparison with takeProfitPct/stopLossPct
  // Capped at theoretical bounds: -1.0 (lose all) to maxProfit/netDebit (max profit multiple)
  return Math.max(-(maxLoss / netDebit), Math.min(maxProfit / netDebit, netPnL / netDebit));
}

async function runBacktest(config) {
  try {
  const {
    ticker     = "SPY",
    optionType = "put",
    startDate,
    endDate,
    minScore      = 70,
    holdDays      = 5,
    takeProfitPct = 0.50,
    stopLossPct   = 0.35,
    capital       = 10000,
    putOnly       = false,   // puts-only mode - blocks all call entries
    callSizeMult  = 1.0,     // asymmetric sizing: calls at reduced fraction (e.g. 0.5 = half size)
    useSpread     = true,    // V2.80: simulate spread P&L (capped r/r) not naked option
    useRegimeB    = true,    // V2.80: apply regime classification to scoring and trade routing
    spreadWidth   = null,    // null = VIX-scaled auto (10/15/20), or fixed dollar width
  } = config;

  const bothMode = optionType === "both";
  const modeLabel = putOnly ? "PUTS-ONLY" : bothMode ? "PUTS+CALLS" : optionType;
  const v275tag = useSpread ? "[SPREAD]" : "[NAKED]";
  logEvent("scan", `[BACKTEST] Starting: ${ticker} ${modeLabel} ${v275tag} ${startDate}-${endDate} minScore:${minScore} capital:$${capital}${callSizeMult < 1 ? ` callSize:${callSizeMult}x` : ""}`);

  // Fetch primary + auxiliary bars (SPY + UUP for gate simulation)
  // SPY bars needed for TLT gate (50MA) and GLD gate (5d return)
  // UUP bars needed for GLD DXY gate (dollar strength)
  // Fetch SPY/UUP with 300-day lookback so 200MA is valid from the start of the date range
  // Without this, the first ~175 bars of any single-year run have no 200MA data
  const extStartDate = new Date(startDate);
  extStartDate.setDate(extStartDate.getDate() - 300);
  const extStart = extStartDate.toISOString().split('T')[0];

  const [bars, spyAux, uupAux] = await Promise.all([
    fetchHistoricalBars(ticker, startDate, endDate),
    (ticker !== "SPY") ? fetchHistoricalBars("SPY", extStart, endDate) : Promise.resolve([]),
    (ticker === "GLD") ? fetchHistoricalBars("UUP", extStart, endDate) : Promise.resolve([]),
  ]);
  // For SPY runs, also fetch extended history for 200MA gate
  // spyAux already has extended history for non-SPY tickers
  const spyBarsExtended = ticker === "SPY" ? await fetchHistoricalBars("SPY", extStart, endDate) : spyAux;
  const spyBarsAux = spyBarsExtended;

  // Calculate how many extra pre-period bars are in spyBarsAux
  // These are used for 200MA lookback but NOT for aligning current-day SPY price
  // spyBarsAux covers extStart-endDate; bars covers startDate-endDate
  // The offset is how many SPY bars fall before startDate
  const spyExtendedOffset = spyBarsAux.length - (ticker === "SPY" ? bars.length : bars.length);
  // For non-SPY tickers: spyBarsAux has ~(bars.length + ~218 extended) bars
  // We need to align so that spySlice[i] corresponds to the same calendar date as bars[i]

  if (bars.length < 30) {
    return { error: `Insufficient data: only ${bars.length} bars fetched for ${ticker} ${startDate}-${endDate}` };
  }
  // Warn if SPY auxiliary bars are fewer than primary bars (alignment assumption breaks)
  if (spyBarsAux.length < bars.length) {
    logEvent("warn", `[BACKTEST] SPY aux bars (${spyBarsAux.length}) < ${ticker} bars (${bars.length}) - SPY data gap, alignment may be off`);
  }

  const { maxPositions = 3 } = config;

  const trades    = [];
  let cash        = capital;
  let peakCash    = capital;
  let maxDrawdown = 0;
  let maxDrawdownDuration = 0; // days in drawdown - behavioral context
  let drawdownStartDay = -1;
  const equityCurve = [{ date: bars[26]?.t?.split("T")[0] || startDate, value: capital }];
  const openBT = [];

  // BT-7: Spiral - independent per direction
  const btSpiral = { put: 0, call: 0 };
  const btSpiralBlocked = { put: false, call: false };
  const SPIRAL_THRESHOLD = 5;
  let spiralBlockCount = 0;

  // Phase 1: Gate skip tracking
  const gateSkips = { dxy: 0, spy5d: 0, vix: 0, tltSpy50: 0, gldRSI: 0, gldPutDxy: 0 };

  // Phase 2: Additional metrics
  let maxConsecLosses = { put: 0, call: 0 };
  let currentConsec   = { put: 0, call: 0 };
  const monthlyPnL    = {}; // "YYYY-MM" - pnl
  let totalHoldDays   = 0;
  let vixBuckets      = { low: {t:0,w:0}, medium: {t:0,w:0}, high: {t:0,w:0}, extreme: {t:0,w:0} };

  // Walk forward - skip first 26 bars (need for MACD)
  for (let i = 26; i < bars.length - holdDays; i++) {
    try {
    const bar      = bars[i];
    const barDate  = bar.t?.split("T")[0] || `day-${i}`;
    const price    = bar.c;

    // - Phase 1: Compute gate inputs from auxiliary bars at this index -
    // SPY 5-day return and 50MA for TLT gate and GLD gate
    // spyBarsAux has pre-period history prepended for 200MA computation
    // For current SPY price/momentum we want the bar aligned with bars[i] by date
    // Strategy: use the tail of spyBarsAux aligned to the end of the period
    // spyBarsAux.length >= bars.length always; the extra bars are at the start
      // Guard: spyBarsAux must be at least as long as bars. If not (data gap), skip offset.
    const spyTailOffset = Math.max(0, spyBarsAux.length - bars.length);
    const spySlice = spyBarsAux.slice(0, spyTailOffset + i + 1);
    const spy5d    = spySlice.length >= 5
      ? (spySlice[spySlice.length-1].c - spySlice[spySlice.length-5].c) / spySlice[spySlice.length-5].c
      : 0;
    const spy50MA  = spySlice.length >= 50
      ? spySlice.slice(-50).reduce((s,b) => s + b.c, 0) / 50
      : 0;
    const spyPrice = spySlice.length ? spySlice[spySlice.length-1].c : 0;

    // UUP (DXY proxy) 5-day return for GLD gate
    const uupSlice = uupAux.slice(0, Math.min(i + 1, uupAux.length));
    const uup5d    = uupSlice.length >= 5
      ? (uupSlice[uupSlice.length-1].c - uupSlice[uupSlice.length-5].c) / uupSlice[uupSlice.length-5].c * 100
      : 0;
    // UUP moves ~65% of DXY - adjust threshold proportionally (0.8% DXY - 0.5% UUP)
    const dxyProxy = { change: uup5d, trend: uup5d > 0.5 ? "strengthening" : uup5d < -0.5 ? "weakening" : "neutral" };

    // GLD RSI at this bar for put gate
    const btRSI = calcRSI(bars.slice(0, i + 1));

    // vixEst - needed for regime classification AND gate section below
    // Compute early so both can use it without duplication
    const atrEarlyPre = calcATR(bars.slice(Math.max(0, i-14), i+1), 14) || price * 0.01;
    const vixEst      = Math.min(50, Math.max(15, (atrEarlyPre / price) * 100 * 16));

    // "both" mode: score both directions, enter the better one
    let entryType = optionType;
    let entryScore, entryReasons;
    if (bothMode) {
      const putResult  = backtestScoreSignal(bars, i, "put");
      const callResult = !putOnly ? backtestScoreSignal(bars, i, "call") : { score: 0, reasons: [] };
      if (putResult.score >= callResult.score && putResult.score >= minScore) {
        entryType = "put"; entryScore = putResult.score; entryReasons = putResult.reasons;
      } else if (!putOnly && callResult.score > putResult.score && callResult.score >= minScore) {
        entryType = "call"; entryScore = callResult.score; entryReasons = callResult.reasons;
      } else {
        continue;
      }
    } else {
      const result = backtestScoreSignal(bars, i, optionType);
      entryScore = result.score; entryReasons = result.reasons;
      if (entryScore < minScore) continue;
    }

    let score   = entryScore;
    const reasons = entryReasons;

    // - V2.80: Regime classification - mirrors live ARGO regime B logic -
    const regime = useRegimeB ? backtestClassifyRegime(bars, i, vixEst) : null;
    if (regime && useRegimeB) {
      // - ENTRY BIAS GATE - enforced as hard filter, not just score modifier -
      // Live ARGO's entryBias field gates entries: puts_on_bounces means
      // ONLY enter puts when price has bounced (RSI 45-65, short-term recovery).
      // Entering puts into a fresh crash (RSI < 40) or after an exhausted bounce
      // (RSI > 68) is the wrong timing - these are the entries that stop out fast.
      // This is the single most important missing feature from the prior backtest.
      if (regime.regimeClass === "B" || regime.regimeClass === "C") {
        if (entryType === "put" && !regime.isPutsOnBounces) {
          // Not a valid bounce entry - skip
          // Allow exception: RSI >= 68 (genuinely overbought on bounce = valid put)
          const rsiOverbought = btRSI >= 68;
          if (!rsiOverbought) {
            if (!gateSkips["bounceGate"]) gateSkips["bounceGate"] = 0;
            gateSkips["bounceGate"]++;
            continue;
          }
        }
      }
      if (regime.regimeClass === "A") {
        if (entryType === "call") {
          // Fix 2: Widened dipGate - RSI 59-65 in bull market IS a valid dip
          // Old: RSI <= 42 OR RSI 43-58 (blocked RSI 59-67)
          // New: RSI <= 65 - only block clearly overbought (RSI > 65 = chasing)
          const isValidCallEntry = btRSI <= 65;
          if (!isValidCallEntry) {
            if (!gateSkips["dipGate"]) gateSkips["dipGate"] = 0;
            gateSkips["dipGate"]++;
            continue;
          }
        }
      }

      // Regime B bounce bonus - kept for scoring but no longer the only gate
      if (regime.regimeClass === "B" && entryType === "put" && regime.isPutsOnBounces) {
        score = Math.min(100, score + 8);
        reasons.push(`~Regime B bounce entry (+8)`);
      }
      // Regime B: calls only allowed as MR (RSI < 40)
      if (regime.regimeClass === "B" && entryType === "call" && btRSI > 55) {
        score = Math.max(0, score - 10);
        reasons.push(`~Regime B - calls need RSI <55 (-10)`);
      }
      if (score < minScore) continue;
    }
    if (btSpiralBlocked[entryType]) { spiralBlockCount++; continue; }

    // - Phase 1: Apply instrument-specific entry gates -
    // vixEst already computed above (before regime classification)

    if (ticker === "GLD") {
      // Compute GLD 20MA for backtest gate
      const gldMA20bt = bars.length >= 20
        ? bars.slice(Math.max(0,i-19), i+1).reduce((s,b) => s + b.c, 0) / Math.min(20, i+1)
        : 0;
      const gldGate = isGLDEntryAllowed(entryType, dxyProxy, spy5d, vixEst, btRSI, price, gldMA20bt);
      if (!gldGate.allowed) {
        if (dxyProxy.trend === "strengthening") gateSkips.dxy++;
        else if (spy5d > 0.015) gateSkips.spy5d++;
        else if (vixEst < 20) gateSkips.vix++;
        else if (btRSI < 68 && entryType === "put") gateSkips.gldRSI++;
        else gateSkips.gldPutDxy++;
        continue;
      }
      // GLD min score 75 (lowered from 80 - panel decision)
      if (score < 75) continue;
    }
    // Compute SPY 200MA once - used by both TLT gate and 200MA regime filter
    // Need full 200-bar history; if insufficient, use available bars (rolling)
    // For single-year runs (252 bars), we fetch auxiliary SPY bars back further
    const spy200MAbt = spySlice.length >= 200
      ? spySlice.slice(-200).reduce((s,b) => s + b.c, 0) / 200
      : (spySlice.length >= 50 ? spySlice.reduce((s,b) => s + b.c, 0) / spySlice.length : 0);

    if (ticker === "TLT") {
      const tltGate = isTLTEntryAllowed(entryType, spyPrice, spy50MA, spy5d, spy200MAbt, null, null);
      if (!tltGate.allowed) { gateSkips.tltSpy50++; continue; }
    }

    // XLE gate - oil trend via 20MA, RSI extremes
    if (ticker === "XLE") {
      const xleMA20bt = bars.length >= 20
        ? bars.slice(Math.max(0,i-19), i+1).reduce((s,b) => s + b.c, 0) / Math.min(20, i+1)
        : 0;
      const xleGate = isXLEEntryAllowed(entryType, btRSI, null, vixEst, price, xleMA20bt, btRSI); // backtest: use same RSI as dailyRSI proxy (best available in backtester)
      if (!xleGate.allowed) {
        if (!gateSkips["xleOilTrend"]) gateSkips["xleOilTrend"] = 0;
        gateSkips["xleOilTrend"]++;
        continue;
      }
    }

    // - 200MA regime filter - mirrors live ARGO behavior -
    // When SPY is below its 200MA: block calls entirely, require 80+ for puts
    // Uses the same spy200MAbt computed above - no duplicate computation
    const btSpyBelow200MA = spy200MAbt > 0 && spyPrice < spy200MAbt;
    if (btSpyBelow200MA) {
      if (entryType === "call") {
        // Block calls entirely in bear regime - same as live system
        if (!gateSkips["200maCall"]) gateSkips["200maCall"] = 0;
        gateSkips["200maCall"]++;
        continue;
      }
      // Fix 3: Puts need 75+ when below 200MA (was 80+)
      // The live system uses agent macro as the primary gate, not 200MA score floor
      // 80+ was blocking the highest-conviction bear market entries at score 75-79
      if (score < 75) {
        if (!gateSkips["200maPutMin"]) gateSkips["200maPutMin"] = 0;
        gateSkips["200maPutMin"]++;
        continue;
      }
    }

    // Estimate option premium using already-computed vixEst from gate section above
    const premiumPct = (vixEst / 100) * Math.sqrt(holdDays / 252) * 0.8; // simplified BSM
    const entryPrem  = parseFloat((price * premiumPct).toFixed(2));
    const minPrem = Math.max(0.10, price * 0.003);
    if (entryPrem < minPrem) continue; // too cheap to trade

    // V2.80 spread parameters - net debit -35% of spread width (stays within 40% r/r rule)
    const btSpreadWidth  = spreadWidth || (vixEst >= 35 ? 20 : vixEst >= 25 ? 15 : 10);
    const btNetDebit     = useSpread ? parseFloat((btSpreadWidth * 0.33).toFixed(2)) : entryPrem;
    const isRegimeCCredit = regime && regime.regimeClass === "C";
    const btTradeType    = isRegimeCCredit ? "credit" : "debit";

    // Asymmetric sizing - spread uses net debit as cost basis
    const sizeMult     = entryType === "call" ? callSizeMult : 1.0;
    const positionCost = useSpread
      ? parseFloat((btNetDebit * 100 * sizeMult).toFixed(2))
      : parseFloat((entryPrem  * 100 * sizeMult).toFixed(2));
    if (positionCost > cash * 0.20) continue; // max 20% per position

    // Settle expired open positions before checking capacity
    for (let j = openBT.length - 1; j >= 0; j--) {
      const op = openBT[j];
      if (i >= op.expiryIdx) {
        const exitBar2 = bars[Math.min(op.expiryIdx, bars.length-1)];
        const pd2 = (exitBar2.c - bars[op.entryIdx].c) / bars[op.entryIdx].c;
        let pnl2;
        if (op.useSpread) {
          pnl2 = simulateSpreadPnL(op.btNetDebit, op.btSpreadWidth, op.entryType, op.btTradeType,
            op.expiryIdx - op.entryIdx, pd2, op.vixEst || 20, ticker);
        } else {
          const dd2 = op.entryType === "put" ? -pd2 : pd2;
          pnl2 = simulateOptionPnL(op.entryPrem, op.entryType, op.expiryIdx - op.entryIdx,
            { priceDelta: dd2 * bars[op.entryIdx].c, daysToExpiry: 21 }, ticker, op.vixEst || 20);
        }
        pnl2 = Math.max(-stopLossPct, Math.min(takeProfitPct, pnl2));
        const pnlDollar2 = parseFloat((pnl2 * op.positionCost).toFixed(2));
        cash = parseFloat((cash + pnlDollar2).toFixed(2));
        if (cash > peakCash) peakCash = cash;
        const dd = (cash - peakCash) / peakCash;
        if (dd < maxDrawdown) maxDrawdown = dd;
        trades.push({
          date: bars[op.expiryIdx]?.t?.split("T")[0] || `day-${op.expiryIdx}`,
          ticker, optionType: op.entryType, score: op.score,
          entryPrice: bars[op.entryIdx].c, entryPrem: op.useSpread ? op.btNetDebit : op.entryPrem,
          pnlPct: parseFloat((pnl2*100).toFixed(1)), pnlDollar: pnlDollar2,
          exitReason: "hold_expired", holdDays: op.expiryIdx - op.entryIdx,
          cashAfter: cash, reasons: op.reasons, tradeType: op.useSpread ? "spread" : "naked",
          vixEst: parseFloat((op.vixEst || 20).toFixed(1)),
          agentRegime: op.agentRegime || "neutral",
        });
        openBT.splice(j, 1);
      }
    }
    if (openBT.length >= maxPositions) continue; // at capacity

    // Simulate this position with intraday TP/stop checking
    let pnlPct    = 0;
    let exitReason = "hold_expired";
    let actualDays = holdDays;
    let settled   = false;

    for (let d = 1; d <= holdDays && (i + d) < bars.length; d++) {
      const dayBar   = bars[i + d];
      const dayDelta = (dayBar.c - price) / price;
      let estPnlPct;
      if (useSpread) {
        estPnlPct = simulateSpreadPnL(btNetDebit, btSpreadWidth, entryType, btTradeType, d, dayDelta, vixEst, ticker);
      } else {
        const dayDirected = entryType === "put" ? -dayDelta : dayDelta;
        estPnlPct = simulateOptionPnL(entryPrem, entryType, d, { priceDelta: dayDirected * price, daysToExpiry: 21 }, ticker, vixEst);
      }
      if (estPnlPct >= takeProfitPct) {
        pnlPct = takeProfitPct; exitReason = "take_profit"; actualDays = d; settled = true; break;
      }
      if (estPnlPct <= -stopLossPct) {
        pnlPct = -stopLossPct; exitReason = "stop_loss"; actualDays = d; settled = true; break;
      }
      pnlPct = estPnlPct;
    }

    if (settled) {
      // TP or stop hit - settle immediately
      const pnlDollar = parseFloat((pnlPct * positionCost).toFixed(2));
      cash = parseFloat((cash + pnlDollar).toFixed(2));
      if (cash > peakCash) peakCash = cash;
      const dd = (cash - peakCash) / peakCash;
      if (dd < maxDrawdown) maxDrawdown = dd;
      equityCurve.push({ date: bars[i + actualDays]?.t?.split("T")[0] || barDate, value: cash });

      // BT-7: Update spiral counters - independent per direction
      if (pnlDollar > 0) {
        btSpiral[entryType] = 0;          // win resets only this direction
        btSpiralBlocked[entryType] = false; // clears only this direction
      } else {
        btSpiral[entryType]++;
        if (btSpiral[entryType] >= SPIRAL_THRESHOLD) {
          btSpiralBlocked[entryType] = true; // blocks only this direction
        }
      }

      // Phase 2: additional metrics tracking
      totalHoldDays += actualDays;
      const month = barDate.slice(0,7);
      monthlyPnL[month] = parseFloat(((monthlyPnL[month] || 0) + pnlDollar).toFixed(2));
      const vixBucket = vixEst >= 35 ? "extreme" : vixEst >= 25 ? "high" : vixEst >= 18 ? "medium" : "low";
      vixBuckets[vixBucket].t++;
      if (pnlDollar > 0) { vixBuckets[vixBucket].w++; currentConsec[entryType] = 0; }
      else {
        currentConsec[entryType]++;
        if (currentConsec[entryType] > maxConsecLosses[entryType]) maxConsecLosses[entryType] = currentConsec[entryType];
      }
      // Drawdown duration tracking
      if (cash < peakCash) {
        if (drawdownStartDay < 0) drawdownStartDay = i;
        const durDays = i - drawdownStartDay;
        if (durDays > maxDrawdownDuration) maxDrawdownDuration = durDays;
      } else {
        drawdownStartDay = -1;
      }
      const agentRegimeFull = reasons.find(r => r.includes("Agent")) || "";
      const agentRegime = agentRegimeFull.includes("trending_bear") ? "trending_bear"
        : agentRegimeFull.includes("trending_bull") ? "trending_bull"
        : agentRegimeFull.includes("choppy") ? "choppy" : "neutral";
      trades.push({ date: barDate, ticker, optionType: entryType, score, entryPrice: price,
        entryPrem: useSpread ? btNetDebit : entryPrem,
        pnlPct: parseFloat((pnlPct*100).toFixed(1)), pnlDollar, exitReason, holdDays: actualDays,
        cashAfter: cash, reasons: reasons.slice(0,3), vixEst: parseFloat(vixEst.toFixed(1)),
        agentRegime, tradeType: useSpread ? `${btTradeType}_spread` : "naked",
        regimeClass: regime?.regimeClass || "A" });
    } else {
      // Not yet settled - track as open position
      openBT.push({ entryIdx: i, entryType, entryPrem, positionCost, score,
        expiryIdx: Math.min(i + holdDays, bars.length-1), reasons: reasons.slice(0,3), vixEst, agentRegime,
        useSpread, btNetDebit, btSpreadWidth, btTradeType });
    }
    } catch(loopErr) {
      logEvent("error", `[BACKTEST] Loop crash at bar ${i} (${ticker} ${bars[i]?.t?.split("T")[0]}): ${loopErr.message}`);
      // Continue - don't let one bad bar crash the entire backtest
    }
  }

  // Calculate statistics
  const wins       = trades.filter(t => t.pnlDollar > 0);
  const losses     = trades.filter(t => t.pnlDollar <= 0);
  const winRate    = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const avgWin     = wins.length   ? wins.reduce((s,t)  => s + t.pnlDollar, 0) / wins.length   : 0;
  const avgLoss    = losses.length ? losses.reduce((s,t) => s + t.pnlDollar, 0) / losses.length : 0;
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : (avgWin > 0 ? 999 : 0);
  const totalPnL   = trades.reduce((s,t) => s + t.pnlDollar, 0);
  const totalReturn = (cash - capital) / capital * 100;

  // Score bracket analysis - validates QS-W2
  const brackets = { "90-100":{trades:0,wins:0}, "80-89":{trades:0,wins:0}, "70-79":{trades:0,wins:0} };
  trades.forEach(t => {
    const b = t.score >= 90 ? "90-100" : t.score >= 80 ? "80-89" : "70-79";
    brackets[b].trades++;
    if (t.pnlDollar > 0) brackets[b].wins++;
  });
  Object.keys(brackets).forEach(b => {
    brackets[b].winRate = brackets[b].trades > 0 ? parseFloat((brackets[b].wins / brackets[b].trades * 100).toFixed(1)) : 0;
  });

  // Phase 2: compute additional metrics
  const expectancy      = parseFloat(((winRate/100 * avgWin) + ((1 - winRate/100) * avgLoss)).toFixed(2));
  const calmar          = maxDrawdown !== 0 ? parseFloat((totalReturn / Math.abs(maxDrawdown * 100)).toFixed(2)) : 0;
  const avgHoldDuration = trades.length > 0 ? parseFloat((totalHoldDays / trades.length).toFixed(1)) : 0;
  const vixWinRates     = {};
  Object.entries(vixBuckets).forEach(([k,v]) => {
    vixWinRates[k] = { trades: v.t, winRate: v.t > 0 ? parseFloat((v.w/v.t*100).toFixed(1)) : 0 };
  });
  // Ensure 200MA gate counters exist even if never triggered
  if (!gateSkips["200maCall"])   gateSkips["200maCall"]   = 0;
  if (!gateSkips["200maPutMin"]) gateSkips["200maPutMin"] = 0;
  if (!gateSkips["bounceGate"])  gateSkips["bounceGate"]  = 0;
  if (!gateSkips["dipGate"])     gateSkips["dipGate"]     = 0;
  const totalGateSkips  = Object.values(gateSkips).reduce((s,v) => s+v, 0);
  const minScore_used   = config.minScore || 70;

  logEvent("scan", `[BACKTEST] ${ticker} ${minScore}+: ${trades.length} trades, ${winRate.toFixed(0)}% WR, expectancy $${expectancy}/trade, Calmar ${calmar}, spiral:${spiralBlockCount}, gates:${totalGateSkips}`);

  // Direction split - put WR vs call WR independently
  const putTrades  = trades.filter(t => t.optionType === "put");
  const callTrades = trades.filter(t => t.optionType === "call");
  const putWins    = putTrades.filter(t => t.pnlDollar > 0);
  const callWins   = callTrades.filter(t => t.pnlDollar > 0);
  const directionSplit = {
    put:  { trades: putTrades.length,  wins: putWins.length,
            winRate: putTrades.length  ? parseFloat((putWins.length/putTrades.length*100).toFixed(1))  : 0,
            pnl: parseFloat(putTrades.reduce((s,t)=>s+t.pnlDollar,0).toFixed(2)) },
    call: { trades: callTrades.length, wins: callWins.length,
            winRate: callTrades.length ? parseFloat((callWins.length/callTrades.length*100).toFixed(1)) : 0,
            pnl: parseFloat(callTrades.reduce((s,t)=>s+t.pnlDollar,0).toFixed(2)) },
  };

  // Losing streak tracking with dates
  let streakInfo = { put: { max: 0, startDate: null, endDate: null }, call: { max: 0, startDate: null, endDate: null } };
  const streakCur = { put: 0, call: 0 };
  const streakStart = { put: null, call: null };
  trades.slice().sort((a,b) => a.date < b.date ? -1 : 1).forEach(t => {
    const type = t.optionType;
    if (t.pnlDollar <= 0) {
      if (streakCur[type] === 0) streakStart[type] = t.date;
      streakCur[type]++;
      if (streakCur[type] > streakInfo[type].max) {
        streakInfo[type] = { max: streakCur[type], startDate: streakStart[type], endDate: t.date };
      }
    } else {
      streakCur[type] = 0;
      streakStart[type] = null;
    }
  });

  // Exit reason breakdown
  const exitBreakdown = {};
  trades.forEach(t => {
    if (!exitBreakdown[t.exitReason]) exitBreakdown[t.exitReason] = { count: 0, wins: 0, pnl: 0 };
    exitBreakdown[t.exitReason].count++;
    if (t.pnlDollar > 0) exitBreakdown[t.exitReason].wins++;
    exitBreakdown[t.exitReason].pnl = parseFloat((exitBreakdown[t.exitReason].pnl + t.pnlDollar).toFixed(2));
  });

  return {
    config,
    summary: {
      ticker, optionType, startDate, endDate, maxPositions, minScore: minScore_used,
      note: maxPositions > 1 ? `Multi-position simulation (max ${maxPositions} concurrent)` : "Single-position simulation",
      modelVersion: "v2.75 - slippage, bid-ask, agent sim, spiral, 200MA, IV rank, regime A/B/C, bear call credit",
      putOnlyMode:  putOnly,
      callSizeMult: callSizeMult,
      gatesApplied: ticker === "GLD" ? ["GLD-DXY","GLD-SPY5d","GLD-VIX","GLD-RSI","GLD-min80"]
                  : ticker === "TLT" ? ["TLT-SPY50MA"] : [],
      spiralBlockCount, gateSkips, totalGateSkips,
      totalTrades:     trades.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         parseFloat(winRate.toFixed(1)),
      avgWin:          parseFloat(avgWin.toFixed(2)),
      avgLoss:         parseFloat(avgLoss.toFixed(2)),
      profitFactor:    parseFloat(profitFactor.toFixed(2)),
      expectancy,
      calmar,
      avgHoldDuration,
      maxConsecLosses,
      streakInfo,
      maxDrawdownDuration,
      totalPnL:        parseFloat(totalPnL.toFixed(2)),
      totalReturn:     parseFloat(totalReturn.toFixed(1)),
      maxDrawdown:     parseFloat((maxDrawdown * 100).toFixed(1)),
      finalCash:       parseFloat(cash.toFixed(2)),
      barsAnalyzed:    bars.length,
    },
    directionSplit,
    regimeSplit: (() => {
      const rs = {};
      trades.forEach(t => {
        const rc = t.regimeClass || "A";
        if (!rs[rc]) rs[rc] = { trades: 0, wins: 0, pnl: 0 };
        rs[rc].trades++;
        if (t.pnlDollar > 0) rs[rc].wins++;
        rs[rc].pnl = parseFloat((rs[rc].pnl + t.pnlDollar).toFixed(2));
      });
      Object.keys(rs).forEach(rc => {
        rs[rc].winRate = rs[rc].trades > 0 ? parseFloat((rs[rc].wins/rs[rc].trades*100).toFixed(1)) : 0;
      });
      return rs;
    })(),
    exitBreakdown,
    scoreBrackets:  brackets,
    monthlyPnL,
    vixWinRates,
    equityCurve,
    trades,
    v275: { useSpread, useRegimeB },
  };
  } catch(e) {
    const stackLine = (e.stack || "").split("\n")[1] || "";
    logEvent("error", `[BACKTEST] runBacktest crashed for ${config?.ticker} minScore:${config?.minScore}: ${e.message} | ${stackLine.trim()}`);
    return { error: e.message, ticker: config?.ticker, minScore: config?.minScore };
  }
}


module.exports = {
  fetchHistoricalBars, backtestClassifyRegime, backtestScoreSignal,
  simulateOptionPnL, simulateSpreadPnL, runBacktest,
};
