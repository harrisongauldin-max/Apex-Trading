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

function getDTEExitParams(dte, daysOpen = 0, optionType = "call") {
  const { countRecentDayTrades } = require('./risk'); // lazy to break circular dep
  // PDT_RULE_ACTIVE=false (FINRA PDT rule sunset April 2026) — day trades not enforced.
  // Force pdtLocked/pdtTight to false so exit params use standard values.
  // SPRINT-04: PDT_RULE_ACTIVE=false (FINRA PDT rule sunset April 2026).
  // pdtLocked/pdtTight are always false — keeping variables for easy re-enable if needed.
  const pdtRemaining = PDT_RULE_ACTIVE ? Math.max(0, PDT_LIMIT - countRecentDayTrades()) : 3;
  const pdtTight     = false; // PDT_RULE_ACTIVE=false
  const pdtLocked    = false; // PDT_RULE_ACTIVE=false
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
  // CALLS: Lower TP in high-VIX = take profits faster (options expensive, likely to mean-revert).
  // PUTS:  V2.98 FIX A — vixTPMult is INVERTED for puts. Elevated VIX means underlying is
  //        falling and puts are performing. Reducing TP exits winning puts early on exactly
  //        the days when they have the most room to run. Puts get a HIGHER TP at elevated VIX.
  //   Calls VIX 25-29: 0.80x (28% MONTHLY) — take faster, options expensive
  //   Calls VIX 30+:   0.65x (22.75% MONTHLY) — take much faster
  //   Puts  VIX 25-29: 1.20x (42% MONTHLY) — give more room, thesis intact in volatile env
  //   Puts  VIX 30+:   1.30x (45.5% MONTHLY) — most room, strong directional move underway
  const vix = state.vix || 22;
  const isPut      = optionType === "put";
  const vixTPMult  = vix >= 30 ? (isPut ? 1.30 : 0.65)
                   : vix >= 25 ? (isPut ? 1.20 : 0.80)
                   : 1.0;
  const vixLabel   = vix >= 30 ? (isPut ? " VIX30+P" : " VIX30+")
                   : vix >= 25 ? (isPut ? " VIX25+P" : " VIX25+")
                   : "";

  if (dte <= 21) {
    const base = 0.20; // SPRINT-04: PDT_RULE_ACTIVE=false, pdtLocked/pdtTight always false
    const tp   = parseFloat((base * overnightMult * vixTPMult).toFixed(3));
    return { takeProfitPct: tp, partialPct: parseFloat((tp*0.60).toFixed(3)),
             ridePct: parseFloat((tp*1.30).toFixed(3)), stopLossPct: 0.30, fastStopPct: 0.15,
             trailActivate: 0.12, // SPRINT-04: PDT dead code removed
             trailStop: 0.07, // SPRINT-04: PDT dead code removed
             label: "SHORT-DTE" + overnightLabel + vixLabel };
  } else if (dte <= 45) {
    const base = 0.35; // trail floor governs exits — TP is gap-scenario ceiling only
    const tp   = parseFloat((base * overnightMult * vixTPMult).toFixed(3));
    return { takeProfitPct: tp, partialPct: parseFloat((tp*0.55).toFixed(3)),
             ridePct: parseFloat((tp*1.40).toFixed(3)), stopLossPct: 0.35, fastStopPct: 0.20,
             trailActivate: 0.22, // SPRINT-04: PDT dead code removed
             trailStop: 0.12, // SPRINT-04: PDT dead code removed
             label: "MONTHLY" + overnightLabel + vixLabel };
  } else {
    // V2.94: LEAPS tier retired — merged into MONTHLY parameters.
    // Previously LEAPS used base 55% TP giving 44% at VIX 27.
    // Problem: APEX enters 46-65 DTE options, not true LEAPS. These positions
    // behave like MONTHLY in terms of delta/theta/vega dynamics. Higher TP just
    // caused over-holding into vega compression. MONTHLY params apply universally
    // for all positions > 45 DTE.
    const base = 0.35; // trail floor governs exits — TP is gap-scenario ceiling only
    const tp   = parseFloat((base * overnightMult * vixTPMult).toFixed(3));
    return { takeProfitPct: tp, partialPct: parseFloat((tp*0.55).toFixed(3)),
             ridePct: parseFloat((tp*1.40).toFixed(3)), stopLossPct: 0.35, fastStopPct: 0.20,
             trailActivate: 0.22, // SPRINT-04: PDT dead code removed
             trailStop: 0.12, // SPRINT-04: PDT dead code removed
             label: "MONTHLY+" + overnightLabel + vixLabel };
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

// ─── Bar cache for RSI checks (per scan cycle) ────────────────────────
const _posBarCache = new Map();

// ─── Main exit decision function ─────────────────────────────────────────────
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
  // V2.98 FIX: Per-cycle close dedup set.
  const _closedThisCycle  = new Set();
  const _partialThisCycle = new Set();

  for (let pi = 0; pi < positions.length; pi++) {
    const pos   = positions[pi];
    const price = posQuotes[pi];
    if (!price) continue;
    if (pos._dryRunWouldClose) continue;
    if (pos._permissionBlocked) {
      const _blockedMins = pos._permissionBlockedAt
        ? (Date.now() - new Date(pos._permissionBlockedAt).getTime()) / 60000
        : 999;
      if (_blockedMins < 15) {
        logEvent("warn", `${pos.ticker} exit skipped — permission blocked (40310000), retrying in ${(15 - _blockedMins).toFixed(0)}min`);
        continue;
      }
      logEvent("warn", `${pos.ticker} permission block cooldown expired (${_blockedMins.toFixed(0)}min) — clearing flag and retrying close`);
      delete pos._permissionBlocked;
      delete pos._permissionBlockedAt;
      delete pos._permBlockReason;
    }
    try {

    const dte      = Math.max(1, Math.round((new Date(pos.expDate)-new Date())/MS_PER_DAY));
    const t        = dte / 365;
    let curP;
    if (pos.isSpread && pos.buySymbol && pos.sellSymbol) {
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
            curP = parseFloat((sellMid - buyMid).toFixed(2));
          } else {
            curP = parseFloat((buyMid - sellMid).toFixed(2));
          }
          pos.currentPrice = curP;
          pos._currentPriceUpdatedAt = Date.now();
          pos.realData = true;
          pos._legPrices = { buy: parseFloat(buyMid.toFixed(2)), sell: parseFloat(sellMid.toFixed(2)) };
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
      const _staleSecs = pos._currentPriceUpdatedAt ? (Date.now() - pos._currentPriceUpdatedAt) / 1000 : 9999;
      const _freshCurrentPrice = _staleSecs < 30 ? pos.currentPrice : null;
      curP = realPrice || _freshCurrentPrice || pos.premium;
      if (realPrice) { pos.realData = true; pos._currentPriceUpdatedAt = Date.now(); }
      if (!realPrice && !_freshCurrentPrice) {
        logEvent("warn", `${pos.ticker} no live price available (API down) — using entry premium as price floor`);
      }
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
      const _noSnapStaleSecs = pos._currentPriceUpdatedAt
        ? (Date.now() - pos._currentPriceUpdatedAt) / 1000
        : 0;
      const _currentPriceValid = pos.currentPrice > 0 && pos.currentPrice !== pos.premium;
      curP = (_noSnapStaleSecs < 300 && _currentPriceValid ? pos.currentPrice : null)
          || (pos.currentPrice > 0 ? pos.currentPrice : null)
          || pos.premium;
    }
    const rawChg = (curP > 0 && pos.premium > 0 && !isNaN(curP)) ? (curP - pos.premium) / pos.premium : 0;
    const chg    = pos.isCreditSpread ? -rawChg : rawChg;
    const hoursOpen= (new Date() - new Date(pos.openDate)) / 3600000;
    const daysOpen = hoursOpen / 24;

    if (curP > pos.peakPremium) {
      pos.peakPremium = curP;
      pos._peakTime = Date.now();
    }
    if (!pos._peakTime) pos._peakTime = new Date(pos.openDate || Date.now()).getTime();

    const curCash = state.cash + openRisk() + realizedPnL();
    if (curCash > (state.peakCash || MONTHLY_BUDGET)) state.peakCash = curCash;

    // - TRIGGER 1: Rapid loss -
    if (ANTHROPIC_API_KEY && isMarketHours()) {
      const prevChg  = pos._prevScanChg || chg;
      const scanDrop = chg - prevChg;
      if (scanDrop <= -0.05 && chg < 0) {
        triggerRescore(pos, `rapid-loss: ${(scanDrop*100).toFixed(1)}% this scan`);
      }
      pos._prevScanChg = chg;

      // - TRIGGER 2: RSI reversal -
      const lastRSICheck = pos._lastRSITriggerCheck || 0;
      if (Date.now() - lastRSICheck > 5 * 60 * 1000) {
        pos._lastRSITriggerCheck = Date.now();
        try {
          const rsiB = _posBarCache.get(pos.ticker) || await getStockBars(pos.ticker, 20);
          if (!_posBarCache.has(pos.ticker) && rsiB.length) _posBarCache.set(pos.ticker, rsiB);
          if (rsiB.length >= 14) {
            const liveRSI   = calcRSI(rsiB);
            const entryRSI  = pos.optionType === "put"
              ? (pos.entryDailyRSI || pos.entryRSI || 70)
              : (pos.entryRSI || 70);
            const prevRSI   = pos._prevRSI || liveRSI;
            pos._prevRSI    = liveRSI;
            const putThesisDegrading = pos.optionType === "put" &&
              entryRSI >= 65 && liveRSI > 60 && prevRSI <= 55;
            const callRSIDegrading = pos.optionType === "call" &&
              entryRSI <= 40 && liveRSI > 55 && prevRSI <= 50;
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

    // - DELTA-BASED EXIT for spreads -
    if (pos.isSpread && pos.greeks && pos.greeks.delta) {
      const buyLegDelta = Math.abs(pos.greeks.delta);
      if (buyLegDelta >= 0.70 && chg >= 0.30) {
        logEvent("scan", `${pos.ticker} delta ${buyLegDelta.toFixed(2)} - spread deep ITM, near max profit - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "target", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol }); continue;
      }
      const _holdMins = (Date.now() - new Date(pos.openDate).getTime()) / 60000;
      if (buyLegDelta <= 0.05 && chg <= -0.25 && _holdMins >= 5) {
        logEvent("scan", `${pos.ticker} delta ${buyLegDelta.toFixed(2)} - spread far OTM, thesis failed - stopping out`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "stop", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol }); continue;
      }
    }

    // - PIN RISK CHECK -
    if (pos.isSpread && pos.sellStrike && !isDayTrade(pos)) {
      const dteLeft   = Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
      const shortStrike = pos.sellStrike || pos.shortStrike || 0;
      const distToShort  = Math.abs(price - shortStrike);
      const pinThreshold = price * 0.005;
      if (dteLeft <= 5 && distToShort <= pinThreshold && shortStrike > 0) {
        logEvent("warn", `[PIN RISK] ${pos.ticker} price $${price} within ${(distToShort/price*100).toFixed(2)}% of short strike $${shortStrike} with ${dteLeft}d DTE - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "pin-risk", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol }); continue;
      }
    }

    // - EARLY ASSIGNMENT RISK -
    if (pos.isCreditSpread && pos.sellStrike && !isDayTrade(pos)) {
      const dteLeft    = Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
      const shortStr   = pos.sellStrike || pos.shortStrike || 0;
      const shortITM   = pos.optionType === "put"  ? price < shortStr
                       : pos.optionType === "call" ? price > shortStr
                       : false;
      if (dteLeft <= 3 && shortITM) {
        logEvent("warn", `[ASSIGNMENT RISK] ${pos.ticker} short leg $${shortStr} is ITM with ${dteLeft}d DTE - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "assignment-risk", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol }); continue;
      }
    }

    const currentExitParams = getDTEExitParams(pos.expDays || 30, daysOpen);
    if (pos.takeProfitPct && pos.takeProfitPct < currentExitParams.takeProfitPct) {
      currentExitParams.takeProfitPct = pos.takeProfitPct;
    }
    const dteLeft = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));

    // ── 21 DTE gamma review ───────────────────────────────────────────────────
    if (pos.isCreditSpread && dteLeft <= 21 && dteLeft > 0 && !pos._gammaCrossedFlag) {
      pos._gammaCrossedFlag = true;
      const entryPremium = pos.premium || pos.netCredit || 0;
      const pnlPct = pos.currentPrice && entryPremium
        ? ((entryPremium - pos.currentPrice) / entryPremium * 100).toFixed(0)
        : "--";
      logEvent("warn", `[GAMMA] ${pos.ticker} crossed 21 DTE (${dteLeft}d remaining) — gamma risk accelerating. P&L: ${pnlPct}%. Consider closing if thesis weakened.`);
      if (pos.currentPrice && entryPremium && pos.currentPrice > entryPremium * 1.3) {
        logEvent("warn", `[GAMMA] ${pos.ticker} is at ${((pos.currentPrice/entryPremium - 1)*100).toFixed(0)}% loss at 21 DTE — gamma stop engaged (35% stop tightened to 25%)`);
        pos._gammaStopEngaged = true;
      }
    }

    const originalDTE = pos.expDays || 30;
    let dteMult;
    if (pos.isCreditSpread) {
      dteMult = dteLeft <= 3  ? 1.30
              : dteLeft <= 7  ? 1.15
              : dteLeft <= 14 ? 1.05
              : 1.0;
      if (pos._gammaStopEngaged) currentExitParams.stopLossPct = 0.25;
    } else {
      dteMult = dteLeft <= 3  ? 0.45
              : dteLeft <= 5  ? 0.55
              : dteLeft <= 10 ? 0.70
              : dteLeft <= 14 ? 0.82
              : dteLeft <= 21 ? 0.92
              : 1.0;
    }
    let activeTakeProfitPct;
    if (pos.isCreditSpread && pos.expDays > 0) {
      const lifePctUsed = daysOpen / pos.expDays;
      const liveRescoreAge = (pos._liveRescore && pos._liveRescore.updatedAt)
        ? (Date.now() - new Date(pos._liveRescore.updatedAt).getTime()) / 60000 : 999;
      const liveScore = (liveRescoreAge < 30 && pos._liveRescore && pos._liveRescore.score)
        ? Math.min(pos._liveRescore.score, pos.entryThesisScore || 100)
        : (pos.entryThesisScore || 100);
      const entryScore = pos._originalEntryScore || 100;
      if (lifePctUsed > 0.10 && liveScore < entryScore) {
        const scaledTP = Math.max(0.25, 0.50 * (liveScore / entryScore));
        activeTakeProfitPct = parseFloat((scaledTP * dteMult).toFixed(3));
        if (liveScore < 60) logEvent("scan", `${pos.ticker} dynamic TP: ${(activeTakeProfitPct*100).toFixed(0)}% (score ${liveScore}/${entryScore}, life ${(lifePctUsed*100).toFixed(0)}% used)`);
      } else {
        activeTakeProfitPct = parseFloat((currentExitParams.takeProfitPct * dteMult).toFixed(3));
      }
      if (chg >= 0.40 && activeTakeProfitPct > 0.40) {
        activeTakeProfitPct = 0.40;
      }
    } else {
      // ── V2.97: GLD CALL SPECIFIC EXIT LOGIC ─────────────────────────────
      if (pos.ticker === "GLD" && pos.optionType === "call") {
        const _gldChgPct   = chg;
        const _gldDailyRSI = parseFloat(pos._curDailyRSI || pos.dailyRSI || 0) || null;
        const _gldDaysOpen = hoursOpen / 6.5;

        const _alpacaLoss = pos._alpacaUnrealizedPct ? pos._alpacaUnrealizedPct : null;
        const _emergencyStop = (_gldChgPct <= -0.35) || (_alpacaLoss && _alpacaLoss <= -0.35);
        if (_emergencyStop && !pos._gldExitFired) {
          pos._gldExitFired = true;
          logEvent("warn", `[GLD EMERGENCY STOP] ${pos.ticker} down ${(_gldChgPct*100).toFixed(1)}% — fast-stop may have failed, forcing close`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'gld-emergency-stop', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
        }
        else if (_gldChgPct >= 0.20 && !pos._gldExitFired) {
          pos._gldExitFired = true;
          logEvent("scan", `[GLD EXIT A] ${pos.ticker} +${(_gldChgPct*100).toFixed(1)}% gain target hit — closing`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'gld-target', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
        }
        else if (_gldDailyRSI && _gldDailyRSI >= 45 && !pos._gldExitFired && hoursOpen >= 4) {
          pos._gldExitFired = true;
          logEvent("scan", `[GLD EXIT B] ${pos.ticker} dailyRSI recovered to ${_gldDailyRSI.toFixed(1)} (≥45) after ${hoursOpen.toFixed(1)}h — daily thesis fulfilled`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'gld-daily-rsi', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
        }
        else if (_gldDaysOpen >= 5 && !pos._gldExitFired) {
          pos._gldExitFired = true;
          logEvent("scan", `[GLD EXIT C] ${pos.ticker} ${_gldDaysOpen.toFixed(1)} trading days elapsed — time backstop`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'gld-time-limit', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
        }
        else {
          logEvent("scan", `[GLD HOLD] ${pos.ticker} ${(_gldChgPct*100).toFixed(1)}% | dailyRSI ${_gldDailyRSI?.toFixed(1)||'?'} | ${_gldDaysOpen.toFixed(1)}d open — waiting for daily thesis`);
        }
      }

      const _entryRSI  = pos.entryRSI || 50;
      const _curRSI    = pos._prevRSI || _entryRSI;
      const _isReconstructed = pos._reconstructed === true;
      const _reconCallFulfilled = _isReconstructed
        && pos.optionType === "call"
        && pos.ticker !== "GLD"
        && chg >= 0.08
        && _curRSI > 52;
      const _callFulfilled = pos.ticker !== "GLD" && pos.optionType === "call" && (
        (!_isReconstructed && _entryRSI <= 45 && _curRSI > 55) ||
        _reconCallFulfilled
      );
      const _entryDailyRSI = pos.entryDailyRSI || pos.entryRSI || 50;
      const _curDailyRSI   = pos.dailyRsi || _curRSI;
      const _putFulfilled  = pos.optionType === "put"
        && _entryDailyRSI >= 65
        && _curDailyRSI   < 50;

      // ── TIER 3 EXIT FRAMEWORK ───────────────────────────────────────────
      if (pos.isTier3 && !pos.isMeanReversion) {
        const _t3Chg      = chg;
        const _t3FastStop = -0.25;
        const _t3MinHold  = 24;
        const _t3DailyRSITarget = 55;
        const _t3DailyRSI = pos.dailyRsi || pos.entryDailyRSI || 50;

        if (_t3Chg <= _t3FastStop) {
          logEvent("scan", `${pos.ticker} [TIER3] emergency stop ${(_t3Chg*100).toFixed(0)}% — closing`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'tier3-emergency-stop', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
          continue;
        }
        if (hoursOpen < _t3MinHold) {
          logEvent("scan", `${pos.ticker} [TIER3] holding — ${hoursOpen.toFixed(1)}h open (min ${_t3MinHold}h)`);
          continue;
        }
        if (_t3DailyRSI >= _t3DailyRSITarget && _t3Chg > 0) {
          logEvent("scan", `${pos.ticker} [TIER3] swing thesis complete — dailyRSI ${_t3DailyRSI.toFixed(0)} >= ${_t3DailyRSITarget}`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'tier3-thesis-complete', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
          continue;
        }
        const _t3Peak = pos.premium > 0 ? (pos.peakPremium - pos.premium) / pos.premium : 0;
        if (_t3Chg < -0.15 && _t3Peak < 0.05) {
          logEvent("scan", `${pos.ticker} [TIER3] stuck loser — closing`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'tier3-stuck-loser', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
          continue;
        }
        logEvent("scan", `${pos.ticker} [TIER3] holding — dailyRSI ${_t3DailyRSI.toFixed(0)} (target ${_t3DailyRSITarget})`);
        continue;
      }

      const _thesisFulfilled = _callFulfilled || _putFulfilled;

      if (_thesisFulfilled && !pos._thesisFulfilled) {
        pos._thesisFulfilled    = true;
        pos._thesisFulfilledAt  = Date.now();
        const _gainPct = (chg * 100).toFixed(1);
        logEvent("scan", `[THESIS FULFILLED] ${pos.ticker} RSI ${_entryRSI}→${_curRSI.toFixed(0)} | gain: ${_gainPct >= 0 ? '+' : ''}${_gainPct}% — evaluating auto-exit`);
      }

      if (pos._thesisFulfilled && !pos._thesisAutoClose && hoursOpen >= 0.5) {
        if (chg >= 0.03) {
          pos._thesisAutoClose = true;
          const _t2Contracts = pos.contracts || 1;
          const _t2UsePartial = pos._tier1Closed && _t2Contracts > 1;
          if (_t2UsePartial) {
            logEvent("scan", `[THESIS COMPLETE T2] ${pos.ticker} RSI normalized | gain: +${(chg*100).toFixed(1)}% | T1 fired — closing 1/${_t2Contracts}, leaving runner`);
            pos._tier2Closed = true;
            if (!_closedThisCycle.has(pi) && !_partialThisCycle.has(pi)) {
              _partialThisCycle.add(pi);
              decisions.push({ pi, ticker: pos.ticker, action: 'partial-n', contractsToClose: 1, reason: 'partial-profit-t2', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
            }
          } else {
            logEvent("scan", `[THESIS COMPLETE] ${pos.ticker} RSI normalized (${_entryRSI}→${_curRSI.toFixed(0)}) | gain: +${(chg*100).toFixed(1)}% — closing all`);
            if (!_closedThisCycle.has(pi)) {
              _closedThisCycle.add(pi);
              decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'thesis-complete', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
            }
          }
          if (!state._dailyThesisComplete) state._dailyThesisComplete = {};
          const _gateAEntryRSI = pos.optionType === "put"
            ? (pos.entryDailyRSI || pos.entryRSI || 50)
            : (pos.entryRSI || 50);
          state._dailyThesisComplete[pos.ticker] = {
            entryRSI:  _gateAEntryRSI,
            closedAt:  new Date().toISOString(),
            optionType: pos.optionType,
          };
          markDirty();
          logEvent("scan", `[GATE-A] ${pos.ticker} thesis-complete recorded — re-entry requires RSI < ${(_gateAEntryRSI - 15).toFixed(0)}`);
          continue;

        } else if (chg > -0.05) {
          if (!pos._thesisFulfilledAt) pos._thesisFulfilledAt = Date.now();
          const _hrsAfterFulfill = (Date.now() - pos._thesisFulfilledAt) / 3600000;
          if (_hrsAfterFulfill >= 4) {
            pos._thesisAutoClose = true;
            logEvent("scan", `[THESIS COMPLETE] ${pos.ticker} RSI normalized ${_hrsAfterFulfill.toFixed(1)}h ago, flat at ${(chg*100).toFixed(1)}% — closing`);
            if (!_closedThisCycle.has(pi)) {
              _closedThisCycle.add(pi);
              decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'thesis-no-follow', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
            }
            continue;
          } else {
            if (pos.trailPct > 0.06) {
              pos.trailPct = 0.06;
              logEvent("scan", `[THESIS COMPLETE] ${pos.ticker} RSI normalized, flat — trail tightened to 6%, ${(4 - _hrsAfterFulfill).toFixed(1)}h until auto-close`);
            }
          }

        } else {
          if (!pos._thesisCaseCLogged) {
            pos._thesisCaseCLogged = true;
            logEvent("warn", `[THESIS COMPLETE] ${pos.ticker} RSI normalized but position is ${(chg*100).toFixed(1)}% — stop active`);
          }
        }
      }

      if (pos._thesisFulfilled && chg > 0 && !pos._thesisAutoClose) {
        activeTakeProfitPct = parseFloat(Math.max(chg - 0.01, currentExitParams.takeProfitPct * 0.70).toFixed(3));
        if (!pos._trail4Active && pos.trailPct > 0.03) {
          pos.trailPct = 0.03;
          logEvent("scan", `[THESIS FULFILLED] ${pos.ticker} trail tightened to 3% — profit protection active`);
        }
        logEvent("scan", `[THESIS FULFILLED] ${pos.ticker} phase 2 TP: ${(activeTakeProfitPct*100).toFixed(0)}% | cur gain: ${(chg*100).toFixed(0)}%`);
      } else if (!pos._thesisFulfilled) {
        activeTakeProfitPct = parseFloat((currentExitParams.takeProfitPct * dteMult).toFixed(3));
      }

      if (chg > 0.10 && !pos._thesisFulfilled) {
        const _posVega   = Math.abs(parseFloat(pos.greeks?.vega || 0));
        const _vegaRisk3 = _posVega * 3 * 100 * (pos.contracts || 1);
        const _vegaRatio = pos.cost > 0 ? _vegaRisk3 / (pos.currentPrice * 100 * (pos.contracts || 1)) : 0;
        if (_vegaRatio > 0.25) {
          pos._thesisFulfilled = true;
          if (pos.trailPct > 0.03) pos.trailPct = 0.03;
          activeTakeProfitPct = parseFloat(Math.max(chg - 0.01, currentExitParams.takeProfitPct * 0.70).toFixed(3));
          logEvent("scan", `[VEGA DOMINANT] ${pos.ticker} vega risk ${(_vegaRatio*100).toFixed(0)}% of value — entering profit protection mode`);
        }
      }
    }
    const activePartialPct    = parseFloat((activeTakeProfitPct * 0.60).toFixed(3));

    pos.activeTarget = parseFloat((pos.premium * (1 + activeTakeProfitPct)).toFixed(2));
    const activeRidePct       = currentExitParams.ridePct || (activeTakeProfitPct * 1.30);
    if (dteMult < 1.0 && pos.isSpread) logEvent("scan", `${pos.ticker} DTE-adjusted target: ${(activeTakeProfitPct*100).toFixed(0)}% (${dteLeft}d remaining)`);

    // - THESIS INTEGRITY CHECK -
    const _thesisCheckHours = (hoursOpen < 24) ? 1 : 48;
    if (hoursOpen >= _thesisCheckHours && pos.optionType) {
      const curRSI      = pos._prevRSI      || pos.entryRSI      || 52;
      const curMACD     = pos._lastMACD     || pos.entryMACD     || "neutral";
      const curMomentum = pos._lastMomentum || pos.entryMomentum || "steady";
      const curMacro    = (state._agentMacro || {}).signal || "neutral";
      const integrity   = calcThesisIntegrity(pos, curRSI, curMACD, curMomentum, curMacro);

      pos.entryThesisScore = integrity.score;
      if (!pos.thesisHistory) pos.thesisHistory = [];
      if (pos.thesisHistory.length === 0 || pos.thesisHistory[pos.thesisHistory.length-1]?.score !== integrity.score) {
        pos.thesisHistory.push({ time: new Date().toISOString(), score: integrity.score, notes: integrity.reasons.join("; ") });
        if (pos.thesisHistory.length > 10) pos.thesisHistory = pos.thesisHistory.slice(-10);
      }

      if (integrity.score < 20 ) {
        logEvent("warn", `[THESIS] ${pos.ticker} integrity collapsed ${integrity.score}/100 - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "thesis-collapsed", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      } else if (integrity.score < 40) {
        logEvent("warn", `[THESIS] ${pos.ticker} integrity degraded ${integrity.score}/100`);
        if ((pos.fastStopPct || FAST_STOP_PCT) > 0.25) {
          pos.fastStopPct = 0.25;
          logEvent("warn", `[THESIS] ${pos.ticker} stop tightened to 25% (thesis INVALID)`);
        }
      }

      const adjStop = getTimeAdjustedStop(pos);
      if (adjStop < STOP_LOSS_PCT && chg < -adjStop ) {
        logEvent("warn", `[THESIS] ${pos.ticker} time-adjusted stop ${(adjStop*100).toFixed(0)}% hit after ${daysOpen.toFixed(1)} days`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "time-stop", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
    }

    // DTE EXPIRY URGENCY
    const dteDaysLeft = pos.expDate ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY)) : 30;
    if (pos.isSpread && dteDaysLeft <= 1) {
      logEvent("warn", `${pos.ticker} DTE=1 - closing spread to avoid pin/assignment risk`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "expiry-close", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }
    if (dteDaysLeft <= 5 && dteDaysLeft > 0 && chg < -0.15 ) {
      logEvent("warn", `${pos.ticker} DTE urgency: ${dteDaysLeft}d remaining, ${(chg*100).toFixed(0)}% - closing`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "dte-urgency", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }

    // 50% premium floor stop
    if (!pos.isSpread && pos.premium > 0 && curP > 0) {
      const premiumFloor = pos.premium * 0.50;
      if (curP <= premiumFloor) {
        logEvent("scan", `${pos.ticker} 50% premium floor stop — entry $${pos.premium} floor $${premiumFloor.toFixed(2)} cur $${curP}`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "premium-floor", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
    }

    // Delta compression stop
    if (!pos.isSpread && pos.contractSymbol) {
      const liveSnap = posSnapshots[pos.contractSymbol];
      if (liveSnap && liveSnap.greeks) {
        const liveDelta = Math.abs(parseFloat(liveSnap.greeks.delta || 0));
        if (liveDelta > 0 && liveDelta < 0.12 && chg <= -0.15) {
          logEvent("scan", `${pos.ticker} delta compression stop — live delta ${liveDelta.toFixed(3)} < 0.12 AND down ${(chg*100).toFixed(0)}%`);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "delta-compression", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
        }
      }
    }

    const _isOvernightCarry = hoursOpen >= 16 && pos.premium > 0;
    const _overnightStopPct = (_isOvernightCarry && chg <= -0.10) ? 0.28 : STOP_LOSS_PCT;

    const _agentBearish = (state._agentMacro?.signal || "").includes("bearish");
    const _macroFastStop = (!pos.isSpread && pos.optionType === "call" && _agentBearish && chg <= -0.10)
      ? 0.12
      : (pos.fastStopPct || FAST_STOP_PCT);

    // 1. FAST STOP
    const isWeeklyPos    = (pos.expiryType === "weekly" || (pos.expDays || 30) <= 21);
    const fastStopWindow = isWeeklyPos ? FAST_STOP_HOURS : 120;
    const activeFastStop = isWeeklyPos
      ? _macroFastStop
      : Math.min(0.15, _macroFastStop);
    const fastStopEligible = hoursOpen >= 2 && hoursOpen <= fastStopWindow;
    if (fastStopEligible && chg <= -activeFastStop) {
      logEvent("scan", `${pos.ticker} fast-stop ${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(1)}hrs (threshold ${(activeFastStop*100).toFixed(0)}%)`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "fast-stop", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }

    // Credit spread max loss stop
    if (pos.isCreditSpread && pos.maxLoss > 0 && curP > 0 && pos.premium > 0.05) {
      const creditLossDollar = (curP - pos.premium) * 100 * (pos.contracts || 1);
      const halfMaxLoss      = pos.maxLoss * 100 * (pos.contracts || 1) * 0.50;
      const twiceCredit      = pos.premium * 2 * 100 * (pos.contracts || 1);
      const creditStopDollar = Math.min(halfMaxLoss, twiceCredit);
      if (creditLossDollar >= creditStopDollar ) {
        logEvent("warn", `[CREDIT STOP] ${pos.ticker} credit spread stop triggered - loss $${creditLossDollar.toFixed(0)} - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "credit-stop", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
    }

    // IV COLLAPSE EXIT
    if (!pos.isSpread && pos.entryIV && pos.iv && pos.iv > 0) {
      const ivDrop = (pos.entryIV - pos.iv) / pos.entryIV;
      const _ivCollapseSkip = pos.optionType === "put" && chg > 0;
      if (_ivCollapseSkip) {
        logEvent("scan", `${pos.ticker} iv-collapse skipped — put is profitable (+${(chg*100).toFixed(0)}%)`);
      } else if (ivDrop >= IV_COLLAPSE_PCT && chg > -0.20) {
        logEvent("warn", `${pos.ticker} IV collapse: entry ${(pos.entryIV*100).toFixed(0)}% → current ${(pos.iv*100).toFixed(0)}% (${(ivDrop*100).toFixed(0)}% drop)`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "iv-collapse", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
    }

    // 2. HARD STOP
    const _activeHardStop = _isOvernightCarry && chg <= -0.10 ? _overnightStopPct : STOP_LOSS_PCT;
    if (chg <= -_activeHardStop) {
      const _minsOpen = hoursOpen * 60;
      if (_minsOpen < 2 && chg <= -0.50) {
        logEvent("warn", `${pos.ticker} stop skipped — position only ${_minsOpen.toFixed(1)}min old, ${(chg*100).toFixed(0)}% likely stale snapshot`);
      } else {
        const _stopLabel = _activeHardStop < STOP_LOSS_PCT ? `overnight-tightened-stop (${(_activeHardStop*100).toFixed(0)}%)` : `stop-loss`;
        logEvent("scan", `${pos.ticker} ${_stopLabel} ${(chg*100).toFixed(0)}%`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "stop", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
    }

    // 3. TRAILING STOP / FLOOR SYSTEM
    const peakChg = pos.premium > 0 ? (pos.peakPremium - pos.premium) / pos.premium : 0;
    const trailActivated = chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT)
                        || peakChg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT);

    // ── V3.01: PROGRESS CHECK ──────────────────────────────────────────────
    if (!pos._progressCheckFired) {
      const _entryTime      = new Date(pos.openDate || pos.entryTime || Date.now()).getTime();
      const _minsOpen       = (Date.now() - _entryTime) / 60000;
      const _entryRSI       = pos.entryRSI || 50;
      const _macroIsBearish = (pos.macroSignal || '').includes('bearish');
      const _isGapDayEntry  = pos._isGapDayEntry || false;

      let _checkMins = 90;
      if (_entryRSI < 20) _checkMins = 120;
      else if (_macroIsBearish || _isGapDayEntry) _checkMins = 60;

      if (_minsOpen >= _checkMins && peakChg < 0.05) {
        pos._progressCheckFired = true;
        logEvent("scan",
          `[PROGRESS-CHECK] ${pos.ticker} — held ${_minsOpen.toFixed(0)}min, peak only +${(peakChg*100).toFixed(1)}% ` +
          `(threshold: ${_checkMins}min / +5%). Thesis not gaining traction — exiting.`
        );
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'progress-check',
            exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
          continue;
        }
      }
    }

    // ── V3.01 SPRINT 6/8/2026: FLOOR-BASED TRAILING STOP — 7-TIER RATCHET ──
    // Tiers above +17.5% use 2.5pt width to protect large runners.
    // Ratchet is implicit: peakPremium only increases, so floor only moves up.
    // Simulation: QQQ peaked +22% → old floor +12%, new floor +17.5% → +$57 more captured.
    const contracts = pos.contracts || 1;
    const _entryPremium = pos.premium || curP;

    let _trailFloor = null;
    let _trailLabel = null;
    if (peakChg >= 0.25) {
      _trailFloor = _entryPremium * 1.225;
      _trailLabel = '+22.5% lock (peak 25%+)';
    } else if (peakChg >= 0.225) {
      _trailFloor = _entryPremium * 1.20;
      _trailLabel = '+20% lock (peak 22.5-25%)';
    } else if (peakChg >= 0.20) {
      _trailFloor = _entryPremium * 1.175;
      _trailLabel = '+17.5% lock (peak 20-22.5%)';
    } else if (peakChg >= 0.175) {
      _trailFloor = _entryPremium * 1.15;
      _trailLabel = '+15% lock (peak 17.5-20%)';
    } else if (peakChg >= 0.15) {
      _trailFloor = _entryPremium * 1.10;
      _trailLabel = '+10% lock (peak 15-17.5%)';
    } else if (peakChg >= 0.10) {
      _trailFloor = _entryPremium * 1.05;
      _trailLabel = '+5% lock (peak 10-15%)';
    } else if (peakChg >= 0.05) {
      _trailFloor = _entryPremium * 1.00;
      _trailLabel = 'breakeven lock (peak 5-10%)';
    }
    // peakChg < 5%: no floor — hard stop governs

    if (_trailFloor && !pos[`_floorLogged_${_trailLabel}`]) {
      pos[`_floorLogged_${_trailLabel}`] = true;
      logEvent("scan", `[TRAIL-FLOOR] ${pos.ticker} peak +${(peakChg*100).toFixed(1)}% — floor set at $${_trailFloor.toFixed(2)} (${_trailLabel})`);
    }

    if (_trailFloor && curP <= _trailFloor && !_closedThisCycle.has(pi)) {
      logEvent("scan",
        `[TRAIL-EXIT] ${pos.ticker} cur $${curP.toFixed(2)} <= floor $${_trailFloor.toFixed(2)} ` +
        `(${_trailLabel}) — peak was +${(peakChg*100).toFixed(1)}%, exiting to protect gain`
      );
      _closedThisCycle.add(pi);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'trail-floor',
        exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
      continue;
    }
    // ── END FLOOR-BASED TRAILING STOP ────────────────────────────────────────

    // 4. PARTIAL CLOSE
    const trailAlreadyActive = chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT);
    if (!pos.partialClosed && !trailAlreadyActive && chg >= activePartialPct && chg < activeTakeProfitPct) {
      logEvent("scan", `${pos.ticker} partial close at +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      if (!_closedThisCycle.has(pi) && !_partialThisCycle.has(pi)) {
        _partialThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'partial', reason: 'partial', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
      }
      continue;
    }

    // Near-max-profit for spreads
    if (pos.isSpread && !pos.partialClosed) {
      const nearMaxProfit = pos.isCreditSpread
        ? chg >= 0.88
        : (pos.maxProfit > 0 && pos.currentPrice > 0 && pos.premium > 0 &&
           (pos.currentPrice - pos.premium) >= 0.88 * (pos.maxProfit / 100 / Math.max(pos.contracts || 1, 1)));
      if (nearMaxProfit) {
        logEvent("scan", `${pos.ticker} near max profit (chg:${(chg*100).toFixed(0)}%) - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "near-max-profit", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
    }

    // 5. FULL TARGET
    if (pos.partialClosed && chg >= activeRidePct) {
      logEvent("scan", `${pos.ticker} remainder target +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "target", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }
    if (!pos.partialClosed && chg >= activeTakeProfitPct) {
      logEvent("scan", `${pos.ticker} take profit +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "target", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }

    // F10: THESIS DEGRADATION - re-score entry conditions every hour
    if (hoursOpen >= 1 && Math.floor(hoursOpen) > (pos._lastThesisCheck || 0)) {
      pos._lastThesisCheck = Math.floor(hoursOpen);
      try {
        const tBars  = _posBarCache.get(pos.ticker) || await getStockBars(pos.ticker, 20);
        if (!_posBarCache.has(pos.ticker) && tBars.length) _posBarCache.set(pos.ticker, tBars);
        if (tBars.length >= 15) {
          const curRSI   = calcRSI(tBars);
          const entryRSI = pos.entryRSI || (pos.optionType === "put" ? 75 : 30);
          const curMacro = (state._agentMacro || {}).signal || "neutral";
          const macroIsBullish = curMacro.includes("bullish");
          const macroIsNeutral = curMacro === "neutral";

          const rsiReversed = pos.optionType === "put" && entryRSI >= 65 && curRSI < 50;
          if (rsiReversed && !pos.partialClosed && chg < 0.10) {
            logEvent("scan", `${pos.ticker} PUT thesis degradation — RSI ${entryRSI}→${curRSI.toFixed(0)}, partial close`);
            decisions.push({ pi, ticker: pos.ticker, action: 'partial', reason: 'partial', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
          }

          const callRsiRecovered = pos.optionType === "call" && entryRSI <= 40 && curRSI > 55;
          if (callRsiRecovered && !pos.partialClosed) {
            if (macroIsBullish || macroIsNeutral) {
              logEvent("scan", `${pos.ticker} CALL RSI recovered ${entryRSI}→${curRSI.toFixed(0)} — thesis fulfilled, macro ${curMacro}, holding`);
            } else if (chg < -0.10) {
              logEvent("scan", `${pos.ticker} CALL RSI recovered but down ${(chg*100).toFixed(0)}% with bearish macro — IV crush likely, partial close`);
              decisions.push({ pi, ticker: pos.ticker, action: 'partial', reason: 'partial', exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null });
            } else {
              logEvent("scan", `${pos.ticker} CALL RSI recovered ${entryRSI}→${curRSI.toFixed(0)}, chg ${(chg*100).toFixed(0)}%, bearish macro — monitoring`);
            }
          }
        }
      } catch(e) {}
    }

    // 6. TIME STOP
    if (daysOpen >= TIME_STOP_DAYS && Math.abs(chg) < TIME_STOP_MOVE) {
      logEvent("scan", `${pos.ticker} time-stop - ${daysOpen.toFixed(0)}d, only ${(chg*100).toFixed(1)}% move`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "time-stop", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }

    // 7. EXPIRY ROLL
    if (dte <= 7 && chg > 0) {
      logEvent("scan", `${pos.ticker} expiry-roll - ${dte}DTE with profit`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "expiry-roll", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }

    // 8. 50MA BREAK
    if (hoursOpen >= 2 && !(pos.dteLabel && pos.dteLabel.includes("RECONCIL"))) {
      try {
        const _maCacheKey = `ma55:${pos.ticker}`;
        const maBars = getCached(_maCacheKey, 10 * 60 * 1000)
          || setCache(_maCacheKey, await getStockBars(pos.ticker, 55));
        if (maBars.length >= 50) {
          const ma50 = maBars.slice(-50).reduce((s, b) => s + b.c, 0) / 50;
          const ma50Break = pos.optionType === "put"
            ? price > ma50 * (1 + MA50_BUFFER)
            : price < ma50 * (1 - MA50_BUFFER);
          if (ma50Break) {
            logEvent("scan", `${pos.ticker} 50ma-break | price $${price.toFixed(2)} | 50MA $${ma50.toFixed(2)} | held ${hoursOpen.toFixed(1)}h`);
            decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "50ma-break", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
          }
        }
      } catch(e) {}
    }

    // 9. EARNINGS CLOSE
    if (pos.earningsDate) {
      const daysToE = Math.round((new Date(pos.earningsDate) - new Date()) / MS_PER_DAY);
      if (daysToE >= 0 && daysToE <= EARNINGS_SKIP_DAYS) {
        logEvent("scan", `${pos.ticker} earnings in ${daysToE}d - closing`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "earnings-close", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
    }

    // 10. NEWS EXIT
    const newsArts = posNewsCache[pos.ticker] || [];
    const newsSent = analyzeNews(newsArts);
    if (pos.optionType === "put" && newsSent.signal === "strongly bullish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit - strongly bullish news vs losing put`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "news-exit", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }
    if (pos.optionType === "call" && newsSent.signal === "strongly bearish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit - strongly bearish news vs losing call`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "news-exit", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }

    // 11. OVERNIGHT RISK
    const etHourNow = scanET.getHours() + scanET.getMinutes() / 60;
    if (etHourNow >= 15.0 && state.vix >= 25 && chg <= -0.20) {
      logEvent("scan", `${pos.ticker} overnight-risk TIER1 - severely losing ${(chg*100).toFixed(0)}% at 3pm - closing | VIX ${state.vix}`);
      decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
    }
    if (etHourNow >= 15.5 && state.vix >= 30) {
      if (chg <= -0.08) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 - losing ${(chg*100).toFixed(0)}% into close VIX ${state.vix}`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
      if (dte <= 3) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 - ${dte}DTE too short for overnight hold`);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: pos.contractSymbol || pos.buySymbol || null }); continue;
      }
    }

    pos.price        = price;
    pos.currentPrice = curP;

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
        logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD | ${closeLabel}`);
      } else {
        logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
      }
    } else {
      logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
    }
    markDirty();
    } catch(posErr) {
      logEvent("error", `Position scan error for ${pos?.ticker || "unknown"}: ${posErr.message}`);
    }
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
