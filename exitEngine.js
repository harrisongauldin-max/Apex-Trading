// exitEngine.js — ARGO V3.2
// Exit decision engine: evaluates all open positions and returns exit decisions.
// checkExits() is a pure function — it returns decisions, never calls closePosition.
// scanner.js applies the decisions after this function returns.
'use strict';

const { state, logEvent, markDirty }           = require('./state');
const { alpacaGet, getStockBars, getStockQuote, getCached: _getCached }
                                                = require('./broker');
const { triggerRescore }                       = require('./agent');
const { calcRSI, openRisk, realizedPnL,
        getETTime, isMarketHours }             = require('./signals');
const { getCached, setCache }                  = require('./market');
const { analyzeNews }                          = require('./market');
const { calcThesisIntegrity, isDayTrade } = require('./risk');
const {
  STOP_LOSS_PCT, FAST_STOP_PCT, FAST_STOP_HOURS, TAKE_PROFIT_PCT,
  PARTIAL_CLOSE_PCT, TRAIL_ACTIVATE_PCT, TRAIL_STOP_PCT,
  BREAKEVEN_LOCK_PCT, RIDE_TARGET_PCT, TIME_STOP_DAYS, TIME_STOP_MOVE,
  PDT_RULE_ACTIVE, PDT_LIMIT, PDT_PROFIT_EXIT, PDT_STOP_LOSS, MA50_BUFFER, MS_PER_DAY,
  MONTHLY_BUDGET, IV_COLLAPSE_PCT, SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL,
  TRIGGER_COOLDOWN_MS,
  ANTHROPIC_API_KEY,
  EARNINGS_SKIP_DAYS, WATCHLIST,
} = require('./constants');



// ─── Functions that were in monolith but belong here ─────────────────────────

function getTimeOfDayAnalysis() {
  const trades = state.closedTrades || [];
  if (trades.length < 5) return { best: "insufficient data", hourly: [] };
  const hourly = {};
  for (const trade of trades) {
    if (!trade.openDate) continue;
    const hour = new Date(trade.openDate).getHours();
    if (!hourly[hour]) hourly[hour] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
    hourly[hour].trades++;
    hourly[hour].pnl += trade.pnl || 0;
    if ((trade.pnl || 0) > 0) hourly[hour].wins++;
    else hourly[hour].losses++;
  }
  const sorted = Object.entries(hourly)
    .map(([h, d]) => ({ hour: parseInt(h), ...d, winRate: d.trades ? Math.round(d.wins / d.trades * 100) : 0 }))
    .sort((a, b) => b.pnl - a.pnl);
  return {
    best:   sorted[0] ? `${sorted[0].hour}:00 ET (${sorted[0].winRate}% WR, $${sorted[0].pnl.toFixed(0)} P&L)` : "insufficient data",
    worst:  sorted[sorted.length-1] ? `${sorted[sorted.length-1].hour}:00 ET` : "--",
    hourly: sorted,
  };
}

function getTimeAdjustedStop(pos) {
  const daysOpen = (Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY;
  const chgPct   = pos.currentPrice && pos.premium
    ? (pos.currentPrice - pos.premium) / pos.premium : 0;
  const isFlat   = Math.abs(chgPct) < 0.05;
  let stopPct    = STOP_LOSS_PCT;
  if      (daysOpen >= 8) stopPct = 0.15;
  else if (daysOpen >= 6) stopPct = 0.20;
  else if (daysOpen >= 4) stopPct = 0.25;
  else if (daysOpen >= 2) stopPct = 0.30;
  if (isFlat && daysOpen >= 4) stopPct = Math.min(stopPct, 0.20);
  if (isFlat && daysOpen >= 6) stopPct = Math.min(stopPct, 0.12);
  return stopPct;
}

function getDTEExitParams(dte, daysOpen = 0) {
  const { countRecentDayTrades } = require('./risk'); // lazy to break circular dep
  // PDT_RULE_ACTIVE=false (FINRA PDT rule sunset April 2026) — day trades not enforced.
  // Force pdtLocked/pdtTight to false so exit params use standard values.
  const pdtRemaining = PDT_RULE_ACTIVE ? Math.max(0, PDT_LIMIT - countRecentDayTrades()) : 3;
  const pdtTight     = PDT_RULE_ACTIVE && pdtRemaining <= 1;
  const pdtLocked    = PDT_RULE_ACTIVE && pdtRemaining === 0;
  let overnightMult  = 1.0;
  let overnightLabel = "";
  if (dte <= 21) {
    if      (daysOpen >= 2) { overnightMult = 0.65; overnightLabel = "(2D+)"; }
    else if (daysOpen >= 1) { overnightMult = 0.80; overnightLabel = "(OVERNIGHT)"; }
  } else {
    if      (daysOpen >= 7) { overnightMult = 0.75; overnightLabel = "(7D+)"; }
    else if (daysOpen >= 3) { overnightMult = 0.85; overnightLabel = "(3D+)"; }
    else if (daysOpen >= 1) { overnightMult = 0.92; overnightLabel = "(OVERNIGHT)"; }
  }

  // V2.88 VIX-ADJUSTED TP: At elevated VIX, options cost 40-60% more than VIX 18 baseline.
  // The same underlying price move produces proportionally less % gain on premium.
  // Lower TP in high-VIX = take profits faster when they appear rather than waiting for full target.
  // This improves realized win rate in choppy/volatile environments.
  //   VIX 18-24: normal targets (40% MONTHLY, 55% LEAPS, 20% SHORT-DTE)
  //   VIX 25-29: reduce TP 20% (32% MONTHLY, 44% LEAPS, 16% SHORT-DTE) — options 35-50% expensive
  //   VIX 30+:   reduce TP 35% (26% MONTHLY, 36% LEAPS, 13% SHORT-DTE) — options 65%+ expensive
  const vix = state.vix || 22;
  const vixTPMult = vix >= 30 ? 0.65 : vix >= 25 ? 0.80 : 1.0;
  const vixLabel  = vix >= 30 ? " VIX30+" : vix >= 25 ? " VIX25+" : "";

  if (dte <= 21) {
    const base = pdtLocked ? 0.12 : pdtTight ? 0.15 : 0.20;
    const tp   = parseFloat((base * overnightMult * vixTPMult).toFixed(3));
    return { takeProfitPct: tp, partialPct: parseFloat((tp*0.60).toFixed(3)),
             ridePct: parseFloat((tp*1.30).toFixed(3)), stopLossPct: 0.30, fastStopPct: 0.15,
             trailActivate: pdtLocked ? 0.08 : pdtTight ? 0.10 : 0.12,
             trailStop: pdtLocked ? 0.05 : 0.07,
             label: "SHORT-DTE" + overnightLabel + vixLabel };
  } else if (dte <= 45) {
    const base = pdtLocked ? 0.25 : pdtTight ? 0.30 : 0.40;
    const tp   = parseFloat((base * overnightMult * vixTPMult).toFixed(3));
    return { takeProfitPct: tp, partialPct: parseFloat((tp*0.55).toFixed(3)),
             ridePct: parseFloat((tp*1.40).toFixed(3)), stopLossPct: 0.35, fastStopPct: 0.20,
             trailActivate: pdtLocked ? 0.15 : pdtTight ? 0.18 : 0.22,
             trailStop: pdtLocked ? 0.08 : pdtTight ? 0.10 : 0.12,
             label: "MONTHLY" + overnightLabel + vixLabel };
  } else {
    const base = pdtLocked ? 0.35 : pdtTight ? 0.45 : 0.55;
    const tp   = parseFloat((base * overnightMult * vixTPMult).toFixed(3));
    return { takeProfitPct: tp, partialPct: parseFloat((tp*0.55).toFixed(3)),
             ridePct: parseFloat((tp*1.50).toFixed(3)), stopLossPct: 0.35, fastStopPct: 0.20,
             trailActivate: pdtLocked ? 0.20 : pdtTight ? 0.25 : 0.30,
             trailStop: pdtLocked ? 0.10 : pdtTight ? 0.12 : 0.15,
             label: "LEAPS" + overnightLabel + vixLabel };
  }
}

function applyExitUrgency(agentResult) {
  if (!agentResult || !agentResult.exitUrgency) return;
  const urgency = agentResult.exitUrgency;
  if (urgency === "hold" || urgency === "monitor") return;
  const positions = state.positions || [];
  if (positions.length === 0) return;
  if (urgency === "trim" || urgency === "exit") {
    logEvent("macro", `[AGENT] exitUrgency=${urgency} - ${urgency === "exit" ? "scheduling exit on all losing positions" : "flagging for trim review"}`);
    positions.forEach(p => { p._exitUrgencyFlag = urgency; p._exitUrgencySetAt = Date.now(); });
  }
}

// ─── Pre-fetch position data (called by scanner before checkExits) ────
async function fetchPositionData(positions) {
  const posNewsCache = {};
  if (positions.length > 0) {
    const posNewsFetches = await Promise.all(positions.map(p => require('./market').getNewsForTicker(p.ticker)));
    positions.forEach((p, i) => { posNewsCache[p.ticker] = posNewsFetches[i] || []; });
  }

  const posSymbols = [...new Set(positions.flatMap(p => {
    if (p.isSpread) return [p.buySymbol, p.sellSymbol].filter(Boolean);
    return p.contractSymbol ? [p.contractSymbol] : [];
  }))].join(",");

  const { ALPACA_OPT_SNAP } = require('./constants');
  const [posSnapData, ...posQuotes] = await Promise.all([
    posSymbols ? alpacaGet(`/options/snapshots?symbols=${posSymbols}&feed=indicative`, ALPACA_OPT_SNAP) : Promise.resolve({}),
    ...positions.map(p => getStockQuote(p.ticker)),
  ]);
  const posSnapshots = posSnapData?.snapshots || {};
  return { posSnapshots, posQuotes, posNewsCache };
}

// ─── Main exit decision function ─────────────────────────────────────
// Returns: ExitDecision[] = [{pi, ticker, action, reason, exitPremium, contractSym}]
// Never mutates state. Never calls closePosition. Pure decision function.
async function checkExits(positions, posSnapshots, posQuotes, posNewsCache, ctx) {
  const {
    dryRunMode = false,
    scanET,
    alpacaBalance = state.alpacaCash || state.cash || 0,
    pdtCount = 0,
    marketContext = {},
  } = ctx;

  const decisions = [];

  for (let pi = 0; pi < positions.length; pi++) {
    const pos   = positions[pi];
    const price = posQuotes[pi];
    if (!price) continue;
    if (pos._dryRunWouldClose) continue; // already flagged for close this scan - skip
    // V2.88: Skip permissionBlocked positions — 40310000 error means Alpaca will always reject.
    // These need manual fix on Alpaca dashboard (enable options tier 2+).
    if (pos._permissionBlocked) {
      logEvent("warn", `${pos.ticker} exit skipped — permission blocked (40310000, fix Alpaca options tier). Stuck at ${pos.currentPrice || pos.premium}`);
      continue;
    }
    try { // wrap each position in try/catch - one bad position can't crash the whole scan

    const dte      = Math.max(1, Math.round((new Date(pos.expDate)-new Date())/MS_PER_DAY));
    const t        = dte / 365;
    let curP;
    if (pos.isSpread && pos.buySymbol && pos.sellSymbol) {
      // Spread P&L: net value = buy leg mid - sell leg mid
      const buySnap  = posSnapshots[pos.buySymbol];
      const sellSnap = posSnapshots[pos.sellSymbol];
      if (buySnap && sellSnap) {
        const buyQ  = buySnap?.latestQuote  || {};
        const sellQ = sellSnap?.latestQuote || {};
        const buyMid  = parseFloat(buyQ.bp || 0) > 0 && parseFloat(buyQ.ap || 0) > 0
          ? (parseFloat(buyQ.bp) + parseFloat(buyQ.ap)) / 2
          : parseFloat(buySnap?.lastTrade?.p || buySnap?.latestTrade?.p || 0);
        const sellMid = parseFloat(sellQ.bp || 0) > 0 && parseFloat(sellQ.ap || 0) > 0
          ? (parseFloat(sellQ.bp) + parseFloat(sellQ.ap)) / 2
          : parseFloat(sellSnap?.lastTrade?.p || sellSnap?.latestTrade?.p || 0);
        if (buyMid > 0 && sellMid > 0) {
          if (pos.isCreditSpread) {
            // Credit spread: we SOLD the sell leg and BOUGHT the buy leg (protection)
            // Current cost to close = buy back sell leg - sell long leg
            // = sellMid - buyMid (positive when spread has narrowed = profit)
            curP = parseFloat((sellMid - buyMid).toFixed(2));
          } else {
            // Debit spread: we BOUGHT the buy leg and SOLD the sell leg
            // Current value = buy leg value - sell leg value
            curP = parseFloat((buyMid - sellMid).toFixed(2));
          }
          pos.currentPrice = curP;
          pos._currentPriceUpdatedAt = Date.now();
          pos.realData = true;
          // Store individual leg prices for dashboard display
          pos._legPrices = { buy: parseFloat(buyMid.toFixed(2)), sell: parseFloat(sellMid.toFixed(2)) };
          // Compute NET spread Greeks = buy leg - sell leg
          // For credit spreads: short the sell leg (negative delta/vega/gamma, positive theta)
          // Using buy leg alone gives wrong sign — net must account for both legs
          const buyGreeks  = buySnap?.greeks  || {};
          const sellGreeks = sellSnap?.greeks || {};
          if (buyGreeks.delta || sellGreeks.delta) {
            const buyD  = parseFloat(buyGreeks.delta  || 0);
            const sellD = parseFloat(sellGreeks.delta || 0);
            const buyT  = parseFloat(buyGreeks.theta  || 0);
            const sellT = parseFloat(sellGreeks.theta || 0);
            const buyG  = parseFloat(buyGreeks.gamma  || 0);
            const sellG = parseFloat(sellGreeks.gamma || 0);
            const buyV  = parseFloat(buyGreeks.vega   || 0);
            const sellV = parseFloat(sellGreeks.vega  || 0);
            // Net = long (buy) leg minus short (sell) leg
            // Credit spread: sold sell leg, bought buy leg
            // net delta = buy delta - sell delta (negative — short call spread has negative delta)
            // net theta = buy theta - sell theta (positive — short leg theta dominates, positive for credit)
            pos.greeks = {
              delta: (buyD - sellD).toFixed(3),
              theta: (buyT - sellT).toFixed(3),
              gamma: (buyG - sellG).toFixed(4),
              vega:  (buyV - sellV).toFixed(3),
            };
          }
        }
      }
      if (!curP) curP = pos.currentPrice || pos.premium;
    } else if (pos.contractSymbol && posSnapshots[pos.contractSymbol]) {
      const snap   = posSnapshots[pos.contractSymbol];
      const quote  = snap?.latestQuote || {};
      const greeks = snap?.greeks || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const realPrice = bid > 0 && ask > 0 ? parseFloat(((bid + ask) / 2).toFixed(2)) : null;
      if (bid > 0) pos.bid = bid;
      if (ask > 0) pos.ask = ask;
      // Staleness guard: pos.currentPrice may be hours old if API has been failing.
      // A stale high price triggers false take-profit (e.g. $12.58 from 9am fires at 10am when real price is $5.50).
      // Only use pos.currentPrice if it was updated within the last 3 scan cycles (~30 seconds).
      const _staleSecs = pos._currentPriceUpdatedAt ? (Date.now() - pos._currentPriceUpdatedAt) / 1000 : 9999;
      const _freshCurrentPrice = _staleSecs < 30 ? pos.currentPrice : null;
      // V2.88 ROOT CAUSE FIX: Remove IV formula from curP fallback chain.
      // The formula `stock_price × IV × sqrt(t) × 0.4` uses the UNDERLYING price (~$674 for QQQ)
      // and produces option prices in the $10-15 range when the real option is $5.90.
      // Every time the snapshot API fails, this formula fires and produces a phantom high price
      // which becomes peakPremium, triggers take-profit, and closes positions at a loss.
      // This was the ROOT CAUSE of every "target" close that actually booked a loss:
      //   QQQ +154% phantom → exits at $5.95 vs entry $6.09 = -$28 (real loss)
      //   SPY +169% phantom → exits at $5.18 vs entry $5.25 = -$14 (real loss)
      //   GLD +89% phantom  → exits at $6.50 vs entry $6.90 = -$80 (real loss)
      // Fix: use ONLY realPrice (live bid/ask mid) or _freshCurrentPrice (<30s stale).
      // If both are unavailable (API down), hold the position — do NOT compute a phantom price.
      // pos.premium is the last resort only — it produces chg=0, which is neutral and safe.
      curP = realPrice || _freshCurrentPrice || pos.premium;
      if (realPrice) { pos.realData = true; pos._currentPriceUpdatedAt = Date.now(); }
      if (!realPrice && !_freshCurrentPrice) {
        logEvent("warn", `${pos.ticker} no live price available (API down) — using entry premium as price floor`);
      }
      // - LIVE GREEKS REFRESH -
      // Update Greeks from live snapshot - entry Greeks become stale quickly
      if (greeks.delta) {
        pos.greeks = {
          delta: parseFloat(greeks.delta || 0).toFixed(3),
          theta: parseFloat(greeks.theta || 0).toFixed(3),
          gamma: parseFloat(greeks.gamma || 0).toFixed(4),
          vega:  parseFloat(greeks.vega  || 0).toFixed(3),
        };
        if (snap.impliedVolatility) pos.iv = parseFloat(snap.impliedVolatility);
      }
    } else {
      // V2.88: No snapshot available — use last known currentPrice if fresh, else entry premium (chg=0, neutral).
      // Never use IV formula: it produces phantom prices using underlying price, not option price.
      const _noSnapStaleSecs = pos._currentPriceUpdatedAt ? (Date.now() - pos._currentPriceUpdatedAt) / 1000 : 9999;
      curP = (_noSnapStaleSecs < 30 ? pos.currentPrice : null) || pos.premium;
    }
    // Credit spreads: curP = sellMid - buyMid (profit when spread narrows)
    // premium = net credit received at entry (positive)
    // chg = (curP - premium) / premium is NEGATIVE when profitable (spread narrowed)
    // Invert so exit logic (positive chg = good) works consistently for all spread types
    const rawChg = (curP > 0 && pos.premium > 0 && !isNaN(curP)) ? (curP - pos.premium) / pos.premium : 0;
    const chg    = pos.isCreditSpread ? -rawChg : rawChg;
    const hoursOpen= (new Date() - new Date(pos.openDate)) / 3600000;
    const daysOpen = hoursOpen / 24;

    // Update peak premium for trailing stop
    if (curP > pos.peakPremium) pos.peakPremium = curP;

    // Update peak cash for drawdown tracking
    const curCash = state.cash + openRisk() + realizedPnL();
    if (curCash > (state.peakCash || MONTHLY_BUDGET)) state.peakCash = curCash;

    // - TRIGGER 1: Rapid loss - 5%+ drop since last scan -
    // Most important trigger - catches fast-moving adverse positions
    if (ANTHROPIC_API_KEY && isMarketHours()) {
      const prevChg  = pos._prevScanChg || chg;
      const scanDrop = chg - prevChg; // how much moved this scan
      if (scanDrop <= -0.05 && chg < 0) {
        // Non-blocking fire
        triggerRescore(pos, `rapid-loss: ${(scanDrop*100).toFixed(1)}% this scan`);
      }
      pos._prevScanChg = chg; // store for next scan

      // - TRIGGER 2: RSI reversal - put thesis degrading -
      // Only check once per 5 minutes to avoid RSI noise
      const lastRSICheck = pos._lastRSITriggerCheck || 0;
      if (Date.now() - lastRSICheck > 5 * 60 * 1000) {
        pos._lastRSITriggerCheck = Date.now();
        try {
          const rsiB = _posBarCache.get(pos.ticker) || await getStockBars(pos.ticker, 20);
          if (!_posBarCache.has(pos.ticker) && rsiB.length) _posBarCache.set(pos.ticker, rsiB); // OPT7
          if (rsiB.length >= 14) {
            const liveRSI   = calcRSI(rsiB);
            const entryRSI  = pos.entryRSI || 70;
            const prevRSI   = pos._prevRSI || liveRSI;
            pos._prevRSI    = liveRSI;
            // Put thesis: entered when RSI was high (overbought)
            // Trigger if RSI has recovered significantly from entry level
            const putThesisDegrading = pos.optionType === "put" &&
              entryRSI >= 65 && liveRSI < 45 && prevRSI >= 50;
            // Call thesis degradation checks:
            // 1. RSI reversal: entered oversold, now overbought (mean reversion played out)
            const callRSIDegrading = pos.optionType === "call" &&
              entryRSI <= 40 && liveRSI > 55 && prevRSI <= 50;
            // 2. MACD turned bearish on a call position - momentum reversing
            // liveStock not in scope here -- use pos._lastMACD if available (set during scan scoring)
            const _posLiveMACD = pos._lastMACD || pos.entryMACD || "";
            const callMACDDegrading = pos.optionType === "call" &&
              _posLiveMACD.includes("bearish crossover") &&
              !(pos.entryMACD || "").includes("bearish");
            const callThesisDegrading = callRSIDegrading || callMACDDegrading;
            if (putThesisDegrading || callThesisDegrading) {
              const reason = callMACDDegrading ? "macd-crossover-bearish" : `rsi-reversal: entry ${entryRSI} - now ${liveRSI.toFixed(0)}`;
              triggerRescore(pos, reason);
            }
          }
        } catch(e) {}
      }
    }

    // PDT tier stripped — PDT_RULE_ACTIVE=false (FINRA PDT rule sunset Apr 2026).
    // All PDT branches evaluated to dead code. Removed V2.87 per Trading Desk recommendation.
    // pdtProtected variable also removed (was undeclared/undefined = always falsy).

    // - DELTA-BASED EXIT for spreads -
    // Buy leg delta > 0.70 = deep ITM = near max profit - take it
    // Buy leg delta < 0.05 = far OTM = thesis failed - cut early
    if (pos.isSpread && pos.greeks && pos.greeks.delta) {
      const buyLegDelta = Math.abs(pos.greeks.delta);
      if (buyLegDelta >= 0.70 && chg >= 0.30) {
        logEvent("scan", `${pos.ticker} delta ${buyLegDelta.toFixed(2)} - spread deep ITM, near max profit - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "target", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol }); continue;
      }
      // Bug1 FIX: require 5min hold before delta-based exit to prevent same-scan stop-outs.
      // Greeks on a freshly entered position come from a pre-entry stale snapshot.
      const _holdMins = (Date.now() - new Date(pos.openDate).getTime()) / 60000;
      if (buyLegDelta <= 0.05 && chg <= -0.25 && _holdMins >= 5) {
        logEvent("scan", `${pos.ticker} delta ${buyLegDelta.toFixed(2)} - spread far OTM, thesis failed - stopping out`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "stop", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol }); continue;
      }
    }

    // - PIN RISK CHECK (McMillan) - close if price near short strike at 5 DTE -
    // "Pin risk" = spread expires exactly at short strike = max risk scenario
    // Professional rule: close or roll when within $2 of short strike inside 5 DTE
    if (pos.isSpread && pos.sellStrike && !isDayTrade(pos)) {
      const dteLeft   = Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
      const shortStrike = pos.sellStrike || pos.shortStrike || 0;
      const distToShort  = Math.abs(price - shortStrike);
      const pinThreshold = price * 0.005; // 0.5% of underlying - scales with instrument price
      if (dteLeft <= 5 && distToShort <= pinThreshold && shortStrike > 0) {
        logEvent("warn", `[PIN RISK] ${pos.ticker} price $${price} within ${(distToShort/price*100).toFixed(2)}% of short strike $${shortStrike} (threshold 0.5%) with ${dteLeft}d DTE - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "pin-risk", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol }); continue;
      }
    }

    // - EARLY ASSIGNMENT RISK (McMillan) - credit spread short leg ITM near expiry -
    // Short ITM options risk early assignment, especially near ex-dividend dates
    // For PDT accounts: early assignment creates a naked long/short = catastrophic
    if (pos.isCreditSpread && pos.sellStrike && !isDayTrade(pos)) {
      const dteLeft    = Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
      const shortStr   = pos.sellStrike || pos.shortStrike || 0;
      const shortITM   = pos.optionType === "put"  ? price < shortStr  // put short ITM if price below
                       : pos.optionType === "call" ? price > shortStr  // call short ITM if price above
                       : false;
      if (dteLeft <= 3 && shortITM) {
        logEvent("warn", `[ASSIGNMENT RISK] ${pos.ticker} short leg $${shortStr} is ITM with ${dteLeft}d DTE - closing to prevent early assignment`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "assignment-risk", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol }); continue;
      }
    }

    // - EXIT HIERARCHY -
    // Order matters - earlier checks take priority over later ones
    // Applies to: overnight positions (opened previous day or earlier)
    // OR: same-day positions on accounts above $25k

    // Refresh exit params based on current daysOpen - targets tighten overnight
    const currentExitParams = getDTEExitParams(pos.expDays || 30, daysOpen);
    // DTE-aware exits - as expiry approaches, lower the profit target
    // Carr & Wu: respect pos.takeProfitPct if it was explicitly set (harvest window)
    // pos.takeProfitPct = 0.30 during 5-day harvest window (tighter initial target)
    if (pos.takeProfitPct && pos.takeProfitPct < currentExitParams.takeProfitPct) {
      currentExitParams.takeProfitPct = pos.takeProfitPct; // harvest window overrides DTE params
    }
    // Theta accelerates dramatically inside 10 DTE - take profit sooner
    const dteLeft = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));

    // ── 21 DTE gamma review ───────────────────────────────────────────────────
    // Inside 21 DTE, gamma accelerates dramatically — a position that was safe at
    // 35 DTE can move to max loss in a single session at 15 DTE. Flag once when
    // a credit spread first crosses below 21 DTE to force a human/agent review.
    // _gammaCrossedFlag prevents the log from firing on every subsequent scan.
    if (pos.isCreditSpread && dteLeft <= 21 && dteLeft > 0 && !pos._gammaCrossedFlag) {
      pos._gammaCrossedFlag = true;
      // Credit spread entry premium is stored as pos.premium (not pos.netCredit)
      const entryPremium = pos.premium || pos.netCredit || 0;
      const pnlPct = pos.currentPrice && entryPremium
        ? ((entryPremium - pos.currentPrice) / entryPremium * 100).toFixed(0)
        : "--";
      logEvent("warn", `[GAMMA] ${pos.ticker} crossed 21 DTE (${dteLeft}d remaining) — gamma risk accelerating. P&L: ${pnlPct}%. Consider closing if thesis weakened.`);
      // If position is losing 30%+ at 21 DTE, tighten stop-loss — don't let gamma run it to max loss
      if (pos.currentPrice && entryPremium && pos.currentPrice > entryPremium * 1.3) {
        logEvent("warn", `[GAMMA] ${pos.ticker} is at ${((pos.currentPrice/entryPremium - 1)*100).toFixed(0)}% loss at 21 DTE — gamma stop engaged (35% stop tightened to 25%)`);
        pos._gammaStopEngaged = true;
      }
    }

    // Natenberg: theta decay is exponential not linear
    // DEBIT spreads: tighten targets as DTE drops - theta eating premium fast
    // CREDIT spreads: theta works FOR you - EXPAND targets at low DTE (let it expire worthless)
    const originalDTE = pos.expDays || 30;
    let dteMult;
    if (pos.isCreditSpread) {
      // Credit: theta erosion = profit - relax targets inside 10 DTE
      // Exception: if gamma stop engaged at 21 DTE crossing, use tighter params
      dteMult = dteLeft <= 3  ? 1.30  // <3 DTE: theta almost fully decayed, hold for max
              : dteLeft <= 7  ? 1.15  // <7 DTE: theta working hard, expand target
              : dteLeft <= 14 ? 1.05  // <14 DTE: mild expansion
              : 1.0;
      if (pos._gammaStopEngaged) currentExitParams.stopLossPct = 0.25; // tighter stop for losing 21 DTE positions
    } else {
      // Debit: theta is the enemy - tighten targets as expiry approaches
      dteMult = dteLeft <= 3  ? 0.45  // <3 DTE: take what's there
              : dteLeft <= 5  ? 0.55  // <5 DTE: theta burning fast
              : dteLeft <= 10 ? 0.70  // <10 DTE: acceleration zone
              : dteLeft <= 14 ? 0.82  // <14 DTE: entering acceleration
              : dteLeft <= 21 ? 0.92  // <21 DTE: slight acceleration
              : 1.0;
    }
    // - Dynamic Take Profit for credit spreads (V2.3) -
    // Base TP = 50%. Scale DOWN when thesis is degrading AND position has aged.
    // Formula: TP = max(0.25, 0.50 - (liveScore / entryScore))
    // Conditions: credit spread + used >10% of position life + score available
    // Hard floor at 40%+ profit: always exit regardless of score (don't hold a near-winner)
    // Score < 40: thesis collapsed - handled by hard exit above, so TP is moot
    let activeTakeProfitPct;
    if (pos.isCreditSpread && pos.expDays > 0) {
      const lifePctUsed = daysOpen / pos.expDays;
      // Use freshest score: _liveRescore if <30min old, otherwise integrity score
      // Take the lower (more conservative) if both are available
      const liveRescoreAge = (pos._liveRescore && pos._liveRescore.updatedAt)
        ? (Date.now() - new Date(pos._liveRescore.updatedAt).getTime()) / 60000 : 999;
      const liveScore = (liveRescoreAge < 30 && pos._liveRescore && pos._liveRescore.score)
        ? Math.min(pos._liveRescore.score, pos.entryThesisScore || 100)
        : (pos.entryThesisScore || 100);
      const entryScore = pos._originalEntryScore || 100; // stamped at confirm - never changes
      if (lifePctUsed > 0.10 && liveScore < entryScore) {
        // Thesis has degraded and position has used >10% of its life
        const scaledTP = Math.max(0.25, 0.50 * (liveScore / entryScore));
        activeTakeProfitPct = parseFloat((scaledTP * dteMult).toFixed(3));
        if (liveScore < 60) logEvent("scan", `${pos.ticker} dynamic TP: ${(activeTakeProfitPct*100).toFixed(0)}% (score ${liveScore}/${entryScore}, life ${(lifePctUsed*100).toFixed(0)}% used)`);
      } else {
        activeTakeProfitPct = parseFloat((currentExitParams.takeProfitPct * dteMult).toFixed(3));
      }
      // Hard floor: always exit at 40%+ regardless of score - don't hold a near-winner
      if (chg >= 0.40 && activeTakeProfitPct > 0.40) {
        activeTakeProfitPct = 0.40;
      }
    } else {
      activeTakeProfitPct = parseFloat((currentExitParams.takeProfitPct * dteMult).toFixed(3));
    }
    // partialPct already derived from tp (which has overnightMult) - don't apply dteMult again
    // Partial should fire at 60% of the DTE-adjusted take profit target
    const activePartialPct    = parseFloat((activeTakeProfitPct * 0.60).toFixed(3));
    const activeRidePct       = currentExitParams.ridePct || (activeTakeProfitPct * 1.30);
    if (dteMult < 1.0 && pos.isSpread) logEvent("scan", `${pos.ticker} DTE-adjusted target: ${(activeTakeProfitPct*100).toFixed(0)}% (${dteLeft}d remaining)`);

    // - THESIS INTEGRITY CHECK - proactive exit on thesis degradation -
    // V2.87: Now fires at 1 hour open for intraday positions (was 2 days).
    // Rationale: XLE entered oversold at RSI 26, recovered to RSI 72 intraday —
    // the MR thesis was COMPLETE at RSI 55-60. System held waiting for price target
    // when the thesis had already resolved. 1h threshold catches same-day reversals.
    const _thesisCheckHours = (hoursOpen < 24) ? 1 : 48; // intraday: 1h, multiday: 2d
    if (hoursOpen >= _thesisCheckHours && pos.optionType) {
      // Bug 2 FIX: WATCHLIST has static init values (rsi:50, macd:"neutral") — not live data.
      // Use live values cached on pos during this scan's trailing stop / RSI trigger checks.
      // pos._prevRSI: set by trailing stop block using live bars (best available live RSI).
      // pos._lastMACD: set during RSI reversal trigger check.
      // Fall back to entry values if live hasn't been cached yet (first 2 days).
      const curRSI      = pos._prevRSI      || pos.entryRSI      || 52;
      const curMACD     = pos._lastMACD     || pos.entryMACD     || "neutral";
      const curMomentum = pos._lastMomentum || pos.entryMomentum || "steady";
      const curMacro    = (state._agentMacro || {}).signal || "neutral";
      const integrity   = calcThesisIntegrity(pos, curRSI, curMACD, curMomentum, curMacro);

      // Update thesis score on position for dashboard display
      pos.entryThesisScore = integrity.score;
      if (!pos.thesisHistory) pos.thesisHistory = [];
      if (pos.thesisHistory.length === 0 || pos.thesisHistory[pos.thesisHistory.length-1]?.score !== integrity.score) {
        pos.thesisHistory.push({ time: new Date().toISOString(), score: integrity.score, notes: integrity.reasons.join("; ") });
        if (pos.thesisHistory.length > 10) pos.thesisHistory = pos.thesisHistory.slice(-10);
      }

      // Hard exit: thesis completely collapsed and not PDT protected
      if (integrity.score < 20 ) {
        logEvent("warn", `[THESIS] ${pos.ticker} integrity collapsed ${integrity.score}/100 - ${integrity.reasons.slice(0,2).join(", ")} - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "thesis-collapsed", exitPremium: null, contractSym: null }); continue;
      } else if (integrity.score < 40) {
        logEvent("warn", `[THESIS] ${pos.ticker} integrity degraded ${integrity.score}/100 - ${integrity.reasons.slice(0,2).join(", ")}`);
        // INVALID score - tighten stop to 25% so a losing position exits sooner
        // Thesis is broken; holding at 50% stop means taking max loss on a bad trade
        if ((pos.fastStopPct || FAST_STOP_PCT) > 0.25) {
          pos.fastStopPct = 0.25;
          logEvent("warn", `[THESIS] ${pos.ticker} stop tightened to 25% (thesis INVALID)`);
        }
      }

      // Time-adjusted stop - tightens as position ages
      const adjStop = getTimeAdjustedStop(pos);
      if (adjStop < STOP_LOSS_PCT && chg < -adjStop ) {
        logEvent("warn", `[THESIS] ${pos.ticker} time-adjusted stop ${(adjStop*100).toFixed(0)}% hit after ${daysOpen.toFixed(1)} days`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "time-stop", exitPremium: null, contractSym: null }); continue;
      }
    }

    // 0b. DTE EXPIRY URGENCY - close positions in danger near expiry
    // OT-W4: Calendar time stop misses options-specific expiry risk
    const dteDaysLeft = pos.expDate ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY)) : 30;
    if (pos.isSpread && dteDaysLeft <= 1) {
      logEvent("warn", `${pos.ticker} DTE=1 - closing spread to avoid pin/assignment risk`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "expiry-close", exitPremium: null, contractSym: null }); continue;
    }
    if (dteDaysLeft <= 5 && dteDaysLeft > 0 && chg < -0.15 ) {
      logEvent("warn", `${pos.ticker} DTE urgency: ${dteDaysLeft}d remaining, ${(chg*100).toFixed(0)}% - closing`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "dte-urgency", exitPremium: null, contractSym: null }); continue;
    }

    // V2.87: PANEL ADDITIONS — Trading Desk recommendations implemented

    // [NEW] 50% premium floor stop — professional options rule.
    // If option has lost 50% of its entry premium, structural recovery is unlikely.
    // Applies before fast stop to catch compression early.
    // MONTHLY: $6.40 call → close at $3.20. XLE: $1.05 call → close at $0.52.
    if (!pos.isSpread && pos.premium > 0 && curP > 0) {
      const premiumFloor = pos.premium * 0.50;
      if (curP <= premiumFloor) {
        logEvent("scan", `${pos.ticker} 50% premium floor stop — entry $${pos.premium} floor $${premiumFloor.toFixed(2)} cur $${curP} — exiting (professional options rule)`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "premium-floor", exitPremium: null, contractSym: null }); continue;
      }
    }

    // [NEW] Delta compression stop for naked options.
    // When live delta < 0.12, the option has lost leverage — needs 3x larger underlying move to recover.
    // Only applies to naked options (spreads have delta-based exit already).
    // Spread-only delta exit exists below; this is the naked equivalent.
    if (!pos.isSpread && pos.contractSymbol) {
      const liveSnap = posSnapshots[pos.contractSymbol];
      if (liveSnap && liveSnap.greeks) {
        const liveDelta = Math.abs(parseFloat(liveSnap.greeks.delta || 0));
        if (liveDelta > 0 && liveDelta < 0.12 && chg <= -0.15) {
          logEvent("scan", `${pos.ticker} delta compression stop — live delta ${liveDelta.toFixed(3)} < 0.12 AND down ${(chg*100).toFixed(0)}% — option has lost leverage, exiting`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "delta-compression", exitPremium: null, contractSym: null }); continue;
        }
      }
    }

    // [NEW] Overnight carry stop tightener.
    // Overnight positions already down >10% get stop tightened from 35% → 28%.
    // Rationale: overnight carry compounds losses from theta + adverse gap risk.
    // The overnight mult already reduces TP — now it also tightens the stop.
    const _isOvernightCarry = hoursOpen >= 16 && pos.premium > 0;
    const _overnightStopPct = (_isOvernightCarry && chg <= -0.10) ? 0.28 : STOP_LOSS_PCT;

    // [NEW] Macro-adverse stop tightener.
    // When agent is bearish AND position is a call already down >10%,
    // tighten fast stop to 12% (from 20%) — macro is working against the thesis.
    const _agentBearish = (state._agentMacro?.signal || "").includes("bearish");
    const _macroFastStop = (!pos.isSpread && pos.optionType === "call" && _agentBearish && chg <= -0.10)
      ? 0.12  // tightened: macro working against call thesis
      : (pos.fastStopPct || FAST_STOP_PCT);

    // 1. FAST STOP - tighter window for weeklies, wider for monthlies
    // Weeklies: 2-48hrs (theta racing, exit fast on loss)
    // Monthlies: 2-120hrs (5 days - thesis needs time to play out)
    // V2.87: MONTHLY fast stop tightened from -20% to -15% (panel recommendation)
    // At -20% premium loss the underlying move required for recovery often exceeds DTE capacity.
    const isWeeklyPos    = (pos.expiryType === "weekly" || (pos.expDays || 30) <= 21);
    const fastStopWindow = isWeeklyPos ? FAST_STOP_HOURS : 120;
    const activeFastStop = isWeeklyPos
      ? _macroFastStop                              // weeklies: use macro-adjusted
      : Math.min(0.15, _macroFastStop);             // monthlies: cap at 15% (tightened from 20%)
    const fastStopEligible = hoursOpen >= 2 && hoursOpen <= fastStopWindow;
    if (fastStopEligible && chg <= -activeFastStop) {
      logEvent("scan", `${pos.ticker} fast-stop ${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(1)}hrs (${isWeeklyPos ? 'weekly' : 'monthly'}, threshold ${(activeFastStop*100).toFixed(0)}%${_agentBearish && activeFastStop === 0.12 ? ' macro-tightened' : ''})`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "fast-stop", exitPremium: null, contractSym: null }); continue;
    }

    // 1b. CREDIT SPREAD MAX LOSS STOP - panel unanimous: 50% of max loss OR 2x credit
    // Checks actual dollar loss against max loss rather than relying on fastStopPct alone
    // This is the primary stop for credit spreads - more precise than percentage-based
    // D-FIX3: guard min premium — prevents immediate stop fire on reconciled spreads with bad avgEntry data
    if (pos.isCreditSpread && pos.maxLoss > 0 && curP > 0 && pos.premium > 0.05) {
      const creditLossDollar = (curP - pos.premium) * 100 * (pos.contracts || 1); // $ lost so far
      const halfMaxLoss      = pos.maxLoss * 100 * (pos.contracts || 1) * 0.50; // 50% of max loss in dollars (×100 to match creditLossDollar units)
      const twiceCredit      = pos.premium * 2 * 100 * (pos.contracts || 1); // lose 2x what you could gain
      const creditStopDollar = Math.min(halfMaxLoss, twiceCredit); // stricter of the two
      if (creditLossDollar >= creditStopDollar ) {
        logEvent("warn", `[CREDIT STOP] ${pos.ticker} credit spread stop triggered - loss $${creditLossDollar.toFixed(0)} exceeds ${(creditStopDollar===halfMaxLoss?'50% max loss':'2x credit')} ($${creditStopDollar.toFixed(0)}) - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "credit-stop", exitPremium: null, contractSym: null }); continue;
      }
    }

    // FIX 4: IV COLLAPSE EXIT — close when IV drops 30%+ from entry
    // Long options lose value from IV crush even when direction is correct.
    // Classic scenario: buy put before event, event passes, IV collapses, put loses value.
    // Entry IV stored at position creation; current IV updated from live snapshot.
    // Only fires when: position has entry IV data, current IV drops 30%+ from entry, position profitable or neutral
    // Don't fire if already down 20%+ (stop will handle it) — this is for IV-specific exits
    if (!pos.isSpread && pos.entryIV && pos.iv && pos.iv > 0) {
      const ivDrop = (pos.entryIV - pos.iv) / pos.entryIV;
      if (ivDrop >= IV_COLLAPSE_PCT && chg > -0.20) {
        logEvent("warn", `${pos.ticker} IV collapse: entry ${(pos.entryIV*100).toFixed(0)}% → current ${(pos.iv*100).toFixed(0)}% (${(ivDrop*100).toFixed(0)}% drop) — exiting to prevent further vega bleed`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "iv-collapse", exitPremium: null, contractSym: null }); continue;
      }
    }

    // 2. HARD STOP - unconditional. Uses tighter overnight stop for carry positions.
    // V2.87: overnight positions already down >10% use 28% stop (vs 35% standard).
    // Rationale: overnight mult already tightens TP; stop must match to avoid asymmetry.
    const _activeHardStop = _isOvernightCarry && chg <= -0.10 ? _overnightStopPct : STOP_LOSS_PCT;
    if (chg <= -_activeHardStop) {
      // V2.89 GUARD: Skip stop if position < 2 minutes old AND loss > 50%.
      // Options snapshots can return yesterday's close price for newly-entered positions.
      // A -50% loss within 2 minutes of entry is almost certainly stale data, not a real move.
      // Real options don't lose 50% in 2 minutes from a valid entry. Hold and re-evaluate.
      const _minsOpen = hoursOpen * 60;
      if (_minsOpen < 2 && chg <= -0.50) {
        logEvent("warn", `${pos.ticker} stop skipped — position only ${_minsOpen.toFixed(1)}min old, ${(chg*100).toFixed(0)}% likely stale options snapshot (re-evaluating next scan)`);
        // Fall through — don't fire stop on likely stale data
      } else {
        const _stopLabel = _activeHardStop < STOP_LOSS_PCT ? `overnight-tightened-stop (${(_activeHardStop*100).toFixed(0)}%)` : `stop-loss`;
        logEvent("scan", `${pos.ticker} ${_stopLabel} ${(chg*100).toFixed(0)}%`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "stop", exitPremium: null, contractSym: null }); continue;
      }
    }

    // 3. TRAILING STOP - activates at tier threshold, tightens on signal decay
    // TRAIL LATCH FIX: if peakPremium already exceeded entry × (1 + trailActivate),
    // trail is permanently active — don't check chg again (position may have pulled back).
    // Prevents: spike to +72%, pull back to -5%, trail never fires because chg = -5%.
    const peakChg = pos.premium > 0 ? (pos.peakPremium - pos.premium) / pos.premium : 0;
    const trailActivated = chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT)
                        || peakChg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT);
    if (trailActivated) {
      // pos.trailPct stores the % width (0.15 = 15%), pos.trailStop stores the $ floor
      // These are separate fields - reading pos.trailStop as % was the bug
      let trailPct = pos.trailPct || TRAIL_STOP_PCT; // always a percentage
      // Signal decay: tighten trail if entry thesis has reversed
      let liveRSI = pos.entryRSI || 55;
      try {
        const posBars = _posBarCache.get(pos.ticker) || await getStockBars(pos.ticker, 20); // OPT7: reuse cached bars
        if (!_posBarCache.has(pos.ticker) && posBars.length) _posBarCache.set(pos.ticker, posBars);
        if (posBars.length >= 15) liveRSI = calcRSI(posBars);
      } catch(e) {}
      if (pos.optionType === "call" && liveRSI < 45 && (pos.entryRSI || 55) >= 50) {
        trailPct = TRAIL_STOP_PCT * 0.6;
        pos.trailPct = trailPct; // persist tightened % for next scan
        logEvent("scan", `${pos.ticker} signal decay - RSI ${liveRSI} - tightening trail to ${(trailPct*100).toFixed(0)}%`);
      }
      if (pos.optionType === "put" && liveRSI > 55 && (pos.entryRSI || 55) <= 50) {
        trailPct = TRAIL_STOP_PCT * 0.6;
        pos.trailPct = trailPct;
        logEvent("scan", `${pos.ticker} signal decay (put) - RSI ${liveRSI} - tightening trail to ${(trailPct*100).toFixed(0)}%`);
      }
      const trailFloor = pos.peakPremium * (1 - trailPct); // $ floor value
      pos.trailStop    = trailFloor;                        // store $ floor separately
      if (curP <= trailFloor) {
        logEvent("scan", `${pos.ticker} trail hit - peak $${pos.peakPremium.toFixed(2)} floor $${trailFloor.toFixed(2)} (${(trailPct*100).toFixed(0)}% trail)`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "trail", exitPremium: null, contractSym: null }); continue;
      }
    }

    // 4. PARTIAL CLOSE - at 60% of active take profit target
    // Uses live overnight-adjusted params - tighter targets on older positions
    // Guard: don't fire partial if trail is already active (trail takes over above trailActivate)
    const trailAlreadyActive = chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT);
    if (!pos.partialClosed && !trailAlreadyActive && chg >= activePartialPct && chg < activeTakeProfitPct) {
      logEvent("scan", `${pos.ticker} partial close at +${(chg*100).toFixed(0)}% [${currentExitParams.label}] (partial threshold: +${(activePartialPct*100).toFixed(0)}%)`);
      decisions.push({ pi, ticker: pos.ticker, action: 'partial', reason: 'partial', exitPremium: null, contractSym: null });
      continue; // don't evaluate take profit in same scan as partial - wait for next cycle
    }

    // 4b. NEAR-MAX-PROFIT EXIT - close when spread reaches 88%+ of theoretical max
    // OT-W3: At near-max, remaining upside is tiny vs gamma/pin risk of holding
    if (pos.isSpread && !pos.partialClosed) {
      const nearMaxProfit = pos.isCreditSpread
        ? chg >= 0.88  // collected 88%+ of max credit - close to lock in
        : (pos.maxProfit > 0 && pos.currentPrice > 0 && pos.premium > 0 &&
           (pos.currentPrice - pos.premium) >= 0.88 * (pos.maxProfit / 100 / Math.max(pos.contracts || 1, 1)));
      if (nearMaxProfit) {
        logEvent("scan", `${pos.ticker} near max profit (chg:${(chg*100).toFixed(0)}%) - closing to lock in gains before gamma risk`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "near-max-profit", exitPremium: null, contractSym: null }); continue;
      }
    }

    // 5. FULL TARGET - take profit
    // After partial: remainder rides to 130% of target then closes
    if (pos.partialClosed && chg >= activeRidePct) {
      logEvent("scan", `${pos.ticker} remainder target +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "target", exitPremium: null, contractSym: null }); continue;
    }
    if (!pos.partialClosed && chg >= activeTakeProfitPct) {
      logEvent("scan", `${pos.ticker} take profit +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "target", exitPremium: null, contractSym: null }); continue;
    }

    // - F10: THESIS DEGRADATION - re-score entry conditions every hour -
    // If the original entry thesis has weakened significantly, partial close
    // regardless of price movement - the edge is gone even if position is flat
    if (hoursOpen >= 1 && Math.floor(hoursOpen) > (pos._lastThesisCheck || 0)) {
      pos._lastThesisCheck = Math.floor(hoursOpen);
      try {
        const tBars  = _posBarCache.get(pos.ticker) || await getStockBars(pos.ticker, 20); // OPT7: reuse cached bars
        if (!_posBarCache.has(pos.ticker) && tBars.length) _posBarCache.set(pos.ticker, tBars);
        if (tBars.length >= 15) {
          const curRSI = calcRSI(tBars);
          const entryRSI = pos.entryRSI || (pos.optionType === "put" ? 75 : 30);
          // For puts: if RSI has dropped from overbought to neutral, thesis weakening
          const rsiReversed = pos.optionType === "put" && entryRSI >= 65 && curRSI < 50;
          // For calls: if RSI has risen from oversold to neutral, thesis weakening
          const callRsiReversed = pos.optionType === "call" && entryRSI <= 40 && curRSI > 55;
          if ((rsiReversed || callRsiReversed) && !pos.partialClosed && chg < 0.10) {
            logEvent("scan", `${pos.ticker} thesis degradation - RSI moved from ${entryRSI} to ${curRSI.toFixed(0)} - partial close`);
            decisions.push({ pi, ticker: pos.ticker, action: 'partial', reason: 'partial', exitPremium: null, contractSym: null });
          }
        }
      } catch(e) {}
    }

    // 6. TIME STOP - 7 days with no meaningful move
    if (daysOpen >= TIME_STOP_DAYS && Math.abs(chg) < TIME_STOP_MOVE) {
      logEvent("scan", `${pos.ticker} time-stop - ${daysOpen.toFixed(0)}d, only ${(chg*100).toFixed(1)}% move`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "time-stop", exitPremium: null, contractSym: null }); continue;
    }

    // Agent rescore handled in parallel batch after scan loop (see runAgentRescore below)

    // 7. EXPIRY ROLL - DTE <= 7, close winners (losers hit stop first)
    if (dte <= 7 && chg > 0) {
      logEvent("scan", `${pos.ticker} expiry-roll - ${dte}DTE with profit`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "expiry-roll", exitPremium: null, contractSym: null }); continue;
    }

    // 8. 50MA BREAK - thesis invalidated (real 50-day MA)
    // Minimum 2 hour hold - open volatility can briefly cross 50MA and recover
    // Skip for RECONCILED individual legs — these are spread legs, must close as a pair
    // Individual leg 50MA exits create partial closes and naked positions
    if (hoursOpen >= 2 && !(pos.dteLabel && pos.dteLabel.includes("RECONCIL"))) {
      try {
        const _maCacheKey = `ma55:${pos.ticker}`;
        const maBars = getCached(_maCacheKey, 10 * 60 * 1000) // OPT-MABARS: 10min — daily bars
          || setCache(_maCacheKey, await getStockBars(pos.ticker, 55));
        if (maBars.length >= 50) {
          const ma50 = maBars.slice(-50).reduce((s, b) => s + b.c, 0) / 50;
          const ma50Break = pos.optionType === "put"
            ? price > ma50 * (1 + MA50_BUFFER)  // put: stock recovered above 50MA
            : price < ma50 * (1 - MA50_BUFFER); // call: stock broke below 50MA
          if (ma50Break) {
            logEvent("scan", `${pos.ticker} 50ma-break | price $${price.toFixed(2)} | 50MA $${ma50.toFixed(2)} | held ${hoursOpen.toFixed(1)}h`);
            decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "50ma-break", exitPremium: null, contractSym: null }); continue;
          }
        }
      } catch(e) {}
    }

    // 9. EARNINGS CLOSE - approaching earnings = IV crush risk
    if (pos.earningsDate) {
      const daysToE = Math.round((new Date(pos.earningsDate) - new Date()) / MS_PER_DAY);
      if (daysToE >= 0 && daysToE <= EARNINGS_SKIP_DAYS) {
        logEvent("scan", `${pos.ticker} earnings in ${daysToE}d - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "earnings-close", exitPremium: null, contractSym: null }); continue;
      }
    }

    // 10. NEWS EXIT - strongly opposite news + position losing (thesis broken)
    // newsCache prefetched before loop - no per-position API calls
    const newsArts = posNewsCache[pos.ticker] || [];
    const newsSent = analyzeNews(newsArts);
    if (pos.optionType === "put" && newsSent.signal === "strongly bullish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit - strongly bullish news vs losing put`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "news-exit", exitPremium: null, contractSym: null }); continue;
    }
    if (pos.optionType === "call" && newsSent.signal === "strongly bearish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit - strongly bearish news vs losing call`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "news-exit", exitPremium: null, contractSym: null }); continue;
    }

    // 11. OVERNIGHT RISK - high VIX, losing position into close
    // Panel fix (V2.82): two-tier system - close worse positions earlier for better liquidity
    // Tier 1 (3:00pm): severely losing positions (-20%+) - close while liquidity is healthy
    // Tier 2 (3:30pm): moderately losing (-8%+) or short DTE (3 or less) - close before final spread widening
    // Moved from 3:45pm to 3:30pm - execution algo: last 15min has 3-5x wider bid-ask on options
    const etHourNow = scanET.getHours() + scanET.getMinutes() / 60;
    // Tier 1: severe losses at 3pm - best liquidity window
    if (etHourNow >= 15.0 && state.vix >= 25 && chg <= -0.20) {
      logEvent("scan", `${pos.ticker} overnight-risk TIER1 - severely losing ${(chg*100).toFixed(0)}% at 3pm - closing at healthy liquidity | VIX ${state.vix}`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: null }); continue;
    }
    // Tier 2: moderate losses or short DTE at 3:30pm
    if (etHourNow >= 15.5 && state.vix >= 30) {
      if (chg <= -0.08) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 - losing ${(chg*100).toFixed(0)}% into close VIX ${state.vix}`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: null }); continue;
      }
      if (dte <= 3) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 - ${dte}DTE too short for overnight hold`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: null }); continue;
      }
      if (dte <= 7) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 - ${dte}DTE elevated overnight theta risk - monitoring`);
      }
    }

    // Update current price on position so dashboard shows live data
    pos.price        = price;
    pos.currentPrice = curP;

    // V2.82: Close-of-day range position check for hold decisions
    let bars = null;
    if (etHourNow >= 15.5) { try { bars = await getStockBars(pos.ticker, 1); } catch(_) {} }
    if (etHourNow >= 15.5 && bars && bars.length >= 1) {
      const todayBar = bars[bars.length - 1];
      const dayHigh = todayBar.h || price;
      const dayLow  = todayBar.l || price;
      const dayRange = dayHigh - dayLow;
      if (dayRange > 0) {
        const closePosition = (price - dayLow) / dayRange;
        const closeLabel = closePosition <= 0.25 ? "WEAK CLOSE - sellers in control" : closePosition >= 0.75 ? "STRONG CLOSE - buyers in control" : "neutral close";
        if (closePosition <= 0.25 && chg < 0) {
          logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD | ${closeLabel} (${(closePosition*100).toFixed(0)}th pctile of range) - elevated overnight risk`);
        } else {
          logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD | ${closeLabel}`);
        }
      } else {
        logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
      }
    } else {
      logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
    }
    markDirty(); // will be flushed at end of scan, not every tick
    } catch(posErr) {
      logEvent("error", `Position scan error for ${pos?.ticker || "unknown"}: ${posErr.message}`);
    } // end per-position try/catch
  }

  return decisions;
}

module.exports = {
  checkExits,
  fetchPositionData,
  getTimeAdjustedStop,
  getDTEExitParams,
  applyExitUrgency,
  getTimeOfDayAnalysis,
};
