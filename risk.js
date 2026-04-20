// risk.js — ARGO V3.2
// Risk management: drawdown, PDT, concentration, stress test, filters.
'use strict';
const fmt = (n) => '$' + (n||0).toFixed(2);
const SUPPORT_BUFFER = 0.02;
const PDT_DAYS = 5;
const PREMARKET_NEGATIVE = -0.02;
const VIX_PAUSE = 18;
const RESISTANCE_BUFFER = 0.02;
const { state, logEvent, markDirty ,
  saveStateNow
} = require('./state');
const { openRisk, openCostBasis, heatPct, realizedPnL,
        totalCap, getETTime, getBusinessDaysAgo ,
  effectiveHeatCap, isEntryWindow, getSupportResistance
} = require('./signals');
const { CAPITAL_FLOOR, MONTHLY_BUDGET, MAX_HEAT, MAX_SECTOR_PCT,
        PDT_LIMIT, MS_PER_DAY, STOP_LOSS_PCT,
        MIN_SCORE }                              = require('./constants');
const { alpacaPost, getStockBars } = require('./broker');
const { checkSectorETF } = require('./scoring');
const { getOptionsPrice } = require('./execution');

function getDrawdownProtocol() {
  const trades    = state.closedTrades || [];
  // Use accountBaseline as the reference point - stable starting value from Alpaca sync
  // peakCash fluctuates with mark-to-market and doesn't represent actual starting capital
  const peak      = state.accountBaseline || state.peakCash || MONTHLY_BUDGET;
  const current   = state.cash + openCostBasis(); // use cost basis not MTM for drawdown
  const drawdown  = (current - peak) / peak * 100;

  // Only trigger if we have actual trade history
  if (trades.length < 3) {
    return { level: "normal", sizeMultiplier: 1.0, message: "Normal operations.", minScore: MIN_SCORE };
  }

  // Keep size reduction only - minScore always stays at MIN_SCORE
  // Score quality is now handled by agent confidence and scoring system
  // Raising the score bar after a loss day was preventing recovery entries
  if (drawdown <= -20) {
    // PAUSE: at -20% drawdown new entries are blocked entirely - only exits allowed
    // Risk manager: a system at -20% drawdown should not be adding new directional bets
    return { level: "critical", sizeMultiplier: 0.0, pauseEntries: true, message: "CRITICAL drawdown - entries paused, exits only.", minScore: MIN_SCORE };
  } else if (drawdown <= -15) {
    return { level: "severe",   sizeMultiplier: 0.25, message: "SEVERE drawdown - 25% position sizing.", minScore: MIN_SCORE };
  } else if (drawdown <= -10) {
    return { level: "caution",  sizeMultiplier: 0.50, message: "CAUTION drawdown - 50% position sizing.", minScore: MIN_SCORE };
  } else if (drawdown <= -5) {
    return { level: "watch",    sizeMultiplier: 0.75, message: "WATCH drawdown - 75% position sizing.", minScore: MIN_SCORE };
  }
  // Profit-lock: use Alpaca equity (cash + open position market value) as current value
  // Avoids double-counting bug where cash + openCostBasis() inflates value when positions are open
  // Falls back to cash + openCostBasis() if Alpaca equity not yet synced
  const monthStart  = state.accountBaseline || state.dayStartCash || MONTHLY_BUDGET;
  const currentVal  = state.alpacaEquity || (state.cash + openCostBasis());
  const monthReturn = monthStart > 0 ? (currentVal - monthStart) / monthStart : 0;
  if (monthReturn >= 0.15) {
    return { level: "profit_lock", sizeMultiplier: 0.25, message: `Profit-lock: up ${(monthReturn*100).toFixed(1)}% vs baseline $${monthStart.toFixed(0)} - protecting gains.`, minScore: MIN_SCORE };
  } else if (monthReturn >= 0.10) {
    return { level: "profit_protect", sizeMultiplier: 0.50, message: `Profit-protect: up ${(monthReturn*100).toFixed(1)}% vs baseline - reduced sizing.`, minScore: MIN_SCORE };
  }
  return { level: "normal", sizeMultiplier: 1.0, message: "Normal operations.", minScore: MIN_SCORE };
}

function checkConcentrationRisk() {
  const positions  = state.positions || [];
  const totalValue = state.cash + positions.reduce((s, p) => s + p.cost, 0);
  const alerts     = [];

  // Check single position concentration
  for (const pos of positions) {
    const pct = pos.cost / totalValue * 100;
    if (pct > 20) alerts.push(`${pos.ticker} is ${pct.toFixed(1)}% of portfolio - oversized`);
  }

  // Check sector concentration
  const sectorTotals = {};
  for (const pos of positions) {
    // pos.sector may not be set - look up from WATCHLIST as fallback
    const sector = pos.sector
      || (WATCHLIST.find(w => w.ticker === pos.ticker) || {}).sector
      || "Unknown";
    sectorTotals[sector] = (sectorTotals[sector] || 0) + pos.cost;
  }
  for (const [sector, val] of Object.entries(sectorTotals)) {
    const pct = val / totalValue * 100;
    if (pct > 40) alerts.push(`${sector} sector is ${pct.toFixed(1)}% of portfolio - concentrated`);
  }

  // Check call vs put balance
  const calls = positions.filter(p => p.optionType === "call").reduce((s, p) => s + p.cost, 0);
  const puts  = positions.filter(p => p.optionType === "put").reduce((s, p) => s + p.cost, 0);
  const total = calls + puts;
  if (total > 0) {
    const callPct = calls / total * 100;
    if (callPct > 85) alerts.push(`Portfolio is ${callPct.toFixed(0)}% calls - consider hedging with puts`);
    if (callPct < 15) alerts.push(`Portfolio is ${(100-callPct).toFixed(0)}% puts - very bearish positioning`);
  }

  return { alerts, sectorTotals, callPct: total > 0 ? parseFloat((calls/total*100).toFixed(1)) : 100 };
}

function runStressTest() {
  const scenarios = [
    { name: "Market -5%",  move: -0.05 },
    { name: "Market -10%", move: -0.10 },
    { name: "Market -20%", move: -0.20 },
    { name: "Market +5%",  move:  0.05 },
    { name: "Market +10%", move:  0.10 },
    { name: "VIX Spike +15", vixSpike: 15 },
  ];

  return scenarios.map(scenario => {
    let portfolioImpact = 0;
    for (const pos of state.positions) {
      // Use abs(delta) - direction is handled by mult separately
      const delta  = Math.abs(parseFloat(pos.greeks?.delta || 0.35));
      const gamma  = parseFloat(pos.greeks?.gamma || 0.01);
      const vega   = parseFloat(pos.greeks?.vega  || 0.10);
      const price  = pos.price || 100;
      const contracts = pos.contracts || 1;
      // Puts benefit from down moves, calls from up moves
      const mult   = pos.optionType === "put" ? -1 : 1;

      let impact = 0;
      if (scenario.move !== undefined) {
        const priceMove  = price * scenario.move;
        // Delta + gamma approximation (delta always positive, mult handles direction)
        impact = (delta * mult * priceMove + 0.5 * gamma * priceMove * priceMove) * 100 * contracts;
      } else if (scenario.vixSpike !== undefined) {
        // Vega benefits both calls and puts (IV spike increases option value)
        impact = vega * scenario.vixSpike * 100 * contracts;
      }
      portfolioImpact += impact;
    }
    return {
      scenario: scenario.name,
      impact:   parseFloat(portfolioImpact.toFixed(2)),
      newCash:  parseFloat((state.cash + portfolioImpact).toFixed(2)),
      pct:      state.cash > 0 ? parseFloat((portfolioImpact / (state.cash + portfolioImpact) * 100).toFixed(1)) : 0,
    };
  });
}

async function checkScaleIns() {
  for (const pos of state.positions) {
    if (!pos.halfPosition || pos.partialClosed) continue;
    const hoursOpen = (Date.now() - new Date(pos.openDate).getTime()) / 3600000;
    if (hoursOpen < 24) continue;

    // Spreads: skip scale-in (two-leg complexity, fixed max profit)
    if (pos.isSpread) continue;

    // Use real options price for scale-in decision
    let curP = pos.currentPrice || pos.premium;
    if (pos.contractSymbol) {
      const realP = await getOptionsPrice(pos.contractSymbol);
      if (realP) curP = realP;
    }
    const chg = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;

    // If up 5%+ after 24hrs, add second half at current market price
    const addContracts = pos.contracts;
    const addCost      = parseFloat((curP * 100 * addContracts).toFixed(2));

    if (chg >= 0.05 && state.cash > CAPITAL_FLOOR + addCost) {
      // Submit scale-in order to Alpaca
      if (pos.contractSymbol && pos.ask > 0 && !dryRunMode) {
        try {
          const scaleBody = {
            symbol:           pos.contractSymbol,
            qty:              addContracts,
            side:             "buy",
            type:             "limit",
            time_in_force:    "day",
            limit_price:      parseFloat(pos.ask.toFixed(2)),
            position_intent:  "buy_to_open",
          };
          const scaleResp = await alpacaPost("/orders", scaleBody);
          if (scaleResp && scaleResp.id) {
            logEvent("trade", `Alpaca scale-in: ${scaleResp.id} | ${pos.contractSymbol} | +${addContracts}x`);
          } else {
            logEvent("warn", `Alpaca scale-in failed: ${JSON.stringify(scaleResp)?.slice(0,100)}`);
          }
        } catch(e) { logEvent("error", `Scale-in order error: ${e.message}`); }
      }

      state.cash       = parseFloat((state.cash - addCost).toFixed(2));
      pos.contracts   += addContracts;
      pos.cost         = parseFloat((pos.cost + addCost).toFixed(2));
      pos.halfPosition = false;
      logEvent("trade", `SCALE IN ${pos.ticker} - up ${(chg*100).toFixed(1)}% - total ${pos.contracts}x contracts`);
      await saveStateNow();
    }
  }
}

async function checkAllFilters(stock, price, prefetchedBars = null) { // OPT3: accept pre-fetched bars
  const fails = [];

  // 1. Entry window — SPY/QQQ open at 9:30am, individual stocks at 9:45am
  const isIndexStock     = stock.isIndex || false;
  const eitherWindowOpen = isEntryWindow("call", isIndexStock) || isEntryWindow("put", isIndexStock);
  if (!eitherWindowOpen && !dryRunMode) return { pass:false, reason:"Outside entry window" };

  // 2. Circuit breakers
  if (!state.circuitOpen)       return { pass:false, reason:"Daily circuit breaker tripped" };
  if (!state.weeklyCircuitOpen) return { pass:false, reason:"Weekly circuit breaker tripped" };

  // 3. Capital floor — halt all operations, not just new entries
  if (state.cash <= CAPITAL_FLOOR) {
    if (!state._capitalFloorAlerted) {
      logEvent("warn", `[CAPITAL FLOOR] Cash $${state.cash.toFixed(0)} at floor $${CAPITAL_FLOOR} — all new entries suspended`);
      state._capitalFloorAlerted = true;
    }
    return { pass:false, reason:`Cash at capital floor (${fmt(CAPITAL_FLOOR)}) — operations suspended` };
  }
  state._capitalFloorAlerted = false;

  // 5. Consecutive losses — REMOVED: agent handles thesis quality, not a counter

  // 6. Same-ticker limit — allow up to 2 positions per ticker (entry + roll)
  const existingPositions = state.positions.filter(p => p.ticker === stock.ticker);
  const logicalPositions  = new Set(existingPositions.map(p => `${p.optionType}|${p.expDate}`)).size;
  const maxPerTicker = stock.isIndex ? 3 : 2;
  if (logicalPositions >= maxPerTicker) return { pass:false, reason:`Already have ${logicalPositions} logical position(s) in ${stock.ticker} (max ${maxPerTicker})` };

  // 7. Portfolio heat
  if (heatPct() >= effectiveHeatCap()) return { pass:false, reason:`Portfolio heat at ${(heatPct()*100).toFixed(0)}% max` };

  // 8. Sector cap removed (panel: 5 index ETFs, heat cap handles concentration)

  // 9. Sector concentration — rely on MAX_SECTOR_PCT and correlation blocks
  // Hard per-sector count removed — heat % and correlation blocks handle this
  // (opposite sector bet detection handled by same-ticker opposite direction check in scan loop)

  // 10. Dynamic vol filter removed (panel: credit bypass made it half-functional;
  //     elevated IV = collect rich premium on credits. R/R gate handles structure quality.)

  // 11. Earnings
  if (stock.earningsDate) {
    const dte = Math.round((new Date(stock.earningsDate) - new Date()) / MS_PER_DAY);
    if (dte >= 0 && dte <= EARNINGS_SKIP_DAYS) return { pass:false, reason:`Earnings in ${dte} days` };
  }

  // 12. Stock price
  if (price < MIN_STOCK_PRICE) return { pass:false, reason:`Price $${price} below $${MIN_STOCK_PRICE} minimum` };

  // 13. VIX check — nuanced by trade type
  const vix = state.vix || 15;
  // Index instruments: no hard VIX block — credit spreads thrive in high VIX
  // Individual stocks: pause above 35 (wide spreads, unreliable fills)
  if (!stock.isIndex && vix >= VIX_PAUSE) return { pass:false, reason:`VIX ${vix} above pause threshold (${VIX_PAUSE}) for individual stocks` };
  // Extreme VIX (50+): pause everything — market is in crisis, fills impossible
  if (vix >= 50) return { pass:false, reason:`VIX ${vix} extreme — all entries paused above 50` };

  // 14. Correlation group - max 1 position per correlated group
  const corrGroup = getCorrelatedGroup(stock.ticker);
  if (corrGroup) return { pass:false, reason:`Correlated position already open (group: ${corrGroup.join(", ")})` };

  // 15. Sector ETF confirmation
  const etfCheck = await checkSectorETF(stock);
  if (!etfCheck.pass) return { pass:false, reason:etfCheck.reason };

  // 16. Support/resistance check
  // Panel decision (7/7): index instruments skip S/R entirely.
  // 20-day high on an index in a bear regime IS the ceiling of each bounce — ideal PUT entry.
  // Blocking puts near resistance is a direction inversion for index instruments.
  // Individual stocks: keep check but direction-aware — near resistance bad for calls, near support bad for puts.
  if (!stock.isIndex) {
    try {
      // OPT3: use prefetched bars sliced to 20
      const bars = prefetchedBars ? prefetchedBars.slice(-20) : await getStockBars(stock.ticker, 20);
      if (bars.length >= 10) {
        const sr = getSupportResistance(bars);
        if (price >= sr.resistance * (1 - RESISTANCE_BUFFER)) {
          return { pass:false, reason:`Price within ${(RESISTANCE_BUFFER*100).toFixed(0)}% of 20-day resistance ($${sr.resistance.toFixed(2)}) — calls blocked at resistance` };
        }
        if (price <= sr.support * (1 + SUPPORT_BUFFER)) {
          return { pass:false, reason:`Price near 20-day support ($${sr.support.toFixed(2)}) — puts blocked at support` };
        }
      }
    } catch(e) { /* skip if data unavailable */ }
  }

  // 17. Pre-market check (only relevant in first 90 mins of session)
  const etHour = new Date().toLocaleString("en-US", {timeZone:"America/New_York", hour:"numeric", hour12:false});
  if (parseInt(etHour) < 12) {
    // OPT3: slice prefetched bars for yesterday price
    const priceYest = prefetchedBars ? (prefetchedBars[prefetchedBars.length - 2] || prefetchedBars[0])?.c : (await getStockBars(stock.ticker, 2))[0]?.c;
    if (priceYest) {
      const premarketMove = (price - priceYest) / priceYest;
      if (premarketMove <= PREMARKET_NEGATIVE) {
        return { pass:false, reason:`Pre-market negative (${(premarketMove*100).toFixed(1)}%) - bearish open` };
      }
      if (premarketMove >= PREMARKET_STRONG_MOVE) {
        logEvent("scan", `${stock.ticker} strong pre-market +${(premarketMove*100).toFixed(1)}% - boost signal`);
        stock._premarketBoost = true;
      }
    }
  }

  return { pass:true, reason:null };
}

function countRecentDayTrades() {
  // Prefer Alpaca's authoritative day trade count when available
  // Alpaca tracks the rolling 5-day window accurately including trades from previous sessions
  if (state._alpacaDayTradeCount !== undefined && state._alpacaDayTradeCount !== null) {
    return state._alpacaDayTradeCount;
  }
  // Fallback to internal counter if Alpaca count not yet synced
  const cutoff = getBusinessDaysAgo(PDT_DAYS);
  const recent = (state.dayTrades || []).filter(dt => new Date(dt.closeTime) >= cutoff);
  return recent.length;
}

function isDayTrade(pos) {
  if (!pos || !pos.openDate) return false;
  if (pos.dteLabel && pos.dteLabel.includes('RECONCIL')) return false;
  const etOptions = { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" };
  const openDay   = new Date(pos.openDate).toLocaleDateString("en-US", etOptions);
  const today     = new Date().toLocaleDateString("en-US", etOptions);
  return openDay === today;
}

function recordDayTrade(pos, reason) {
  if (!state.dayTrades) state.dayTrades = [];
  state.dayTrades.push({
    ticker:    pos.ticker,
    openTime:  pos.openDate,
    closeTime: new Date().toISOString(),
    reason,
    pnl:       0, // will be updated by closePosition
  });
  // Keep only last 20 day trade records
  if (state.dayTrades.length > 20) state.dayTrades = state.dayTrades.slice(-20);
  const count = countRecentDayTrades();
  logEvent("warn", `PDT: Day trade recorded for ${pos.ticker} — ${count}/${PDT_LIMIT} in rolling 5-day window`);
  if (count >= PDT_LIMIT) {
    logEvent("warn", `PDT LIMIT REACHED (${count}/${PDT_LIMIT}) — no new same-day CLOSES until window resets. New entries still allowed.`);
  }
}

function getStreakAnalysis() {
  const trades = state.closedTrades || [];
  if (!trades.length) return { currentStreak: 0, currentType: null, maxWinStreak: 0, maxLossStreak: 0 };
  let cur = 0, maxW = 0, maxL = 0, prev = null;
  trades.forEach(t => {
    const w = (t.pnl||0) > 0;
    if (prev === null || w === prev) cur++;
    else cur = 1;
    prev = w;
    if (w) maxW = Math.max(maxW, cur);
    else   maxL = Math.max(maxL, cur);
  });
  // currentType: '+' for win streak, '-' for loss streak
  const currentType = prev === null ? null : (prev ? '+' : '-');
  return { currentStreak: cur, currentType, maxWinStreak: maxW, maxLossStreak: maxL };
}

function calcThesisIntegrity(pos, currentRSI, currentMACD, currentMomentum, currentMacro) {
  let score = 100;
  const reasons = [];

  const entryRSI      = pos.entryRSI      || 52;
  const entryMACD     = pos.entryMACD     || "neutral";
  const entryMomentum = pos.entryMomentum || "steady";
  const entryMacro    = pos.entryMacro    || "neutral";
  const daysOpen      = ((Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY);

  if (pos.optionType === "put") {
    // RSI drifted from overbought toward neutral/oversold
    if (entryRSI >= 65 && currentRSI < 55)      { score -= 30; reasons.push(`RSI drifted ${entryRSI}-${currentRSI} (-30)`); }
    else if (entryRSI >= 65 && currentRSI < 65) { score -= 15; reasons.push(`RSI softened ${entryRSI}-${currentRSI} (-15)`); }

    // MACD flipped bullish - direct contradiction
    if (entryMACD.includes("bearish") && currentMACD.includes("bullish crossover")) { score -= 40; reasons.push("MACD flipped bullish crossover (-40)"); }
    else if (entryMACD.includes("bearish") && currentMACD.includes("bullish"))      { score -= 25; reasons.push("MACD turned bullish (-25)"); }

    // Momentum recovered
    if (entryMomentum === "recovering" && currentMomentum === "strong") { score -= 25; reasons.push("Momentum recovered to strong (-25)"); }
    else if (entryMomentum === "recovering" && currentMomentum === "steady") { score -= 10; reasons.push("Momentum stabilized (-10)"); }

    // Macro shifted against puts
    if (entryMacro.includes("bearish") && currentMacro === "neutral")            { score -= 15; reasons.push("Macro shifted neutral (-15)"); }
    if (entryMacro.includes("bearish") && currentMacro.includes("bullish"))      { score -= 30; reasons.push("Macro turned bullish (-30)"); }
    if (currentMacro === "aggressive")                                             { score -= 40; reasons.push("Macro strongly bullish (-40)"); }

  } else {
    // Call thesis
    if (entryRSI <= 35 && currentRSI > 45)       { score -= 30; reasons.push(`RSI recovered ${entryRSI}-${currentRSI} (-30)`); }
    if (entryMACD.includes("bullish") && currentMACD.includes("bearish crossover")) { score -= 40; reasons.push("MACD flipped bearish crossover (-40)"); }
    if (entryMacro.includes("bullish") && currentMacro.includes("bearish"))         { score -= 30; reasons.push("Macro turned bearish (-30)"); }
  }

  // Time decay pressure - flat positions lose conviction points over time
  if (daysOpen >= 6 && Math.abs((pos.currentPrice||pos.premium) - pos.premium) / pos.premium < 0.05) {
    score -= 20; reasons.push(`${daysOpen.toFixed(0)}d held flat (-20)`);
  } else if (daysOpen >= 3 && Math.abs((pos.currentPrice||pos.premium) - pos.premium) / pos.premium < 0.05) {
    score -= 10; reasons.push(`${daysOpen.toFixed(0)}d held flat (-10)`);
  }

  score = Math.max(0, Math.min(100, score));
  const recommendation = score >= 70 ? "HOLD" : score >= 40 ? "WATCH" : "EXIT";
  return { score, reasons, recommendation, daysOpen: parseFloat(daysOpen.toFixed(1)) };
}

function getPnLByTicker() {
  const map = {};
  (state.closedTrades || []).forEach(t => {
    if (!map[t.ticker]) map[t.ticker] = { pnl: 0, trades: 0, wins: 0 };
    map[t.ticker].pnl    += t.pnl;
    map[t.ticker].trades += 1;
    if (t.pnl > 0) map[t.ticker].wins += 1;
  });
  return map;
}

function getPnLBySector() {
  const map = {};
  (state.closedTrades || []).forEach(t => {
    const stock  = WATCHLIST.find(w => w.ticker === t.ticker);
    const sector = stock ? stock.sector : "Unknown";
    if (!map[sector]) map[sector] = { pnl: 0, trades: 0 };
    map[sector].pnl    += t.pnl;
    map[sector].trades += 1;
  });
  return map;
}

function getPnLByScoreRange() {
  const map = { "70-79": { pnl:0, trades:0 }, "80-89": { pnl:0, trades:0 }, "90-100": { pnl:0, trades:0 } };
  (state.closedTrades || []).forEach(t => {
    const j = (state.tradeJournal || []).find(e => e.action === "OPEN" && e.ticker === t.ticker);
    const score = j ? j.score : 0;
    const key = score >= 90 ? "90-100" : score >= 80 ? "80-89" : "70-79";
    if (map[key]) { map[key].pnl += t.pnl; map[key].trades += 1; }
  });
  return map;
}

function getTaxLog() {
  return (state.closedTrades || []).map((t, i) => {
    const openJ  = (state.tradeJournal || []).find(e => e.action === "OPEN" && e.ticker === t.ticker);
    const closeJ = (state.tradeJournal || []).find(e => e.action === "CLOSE" && e.ticker === t.ticker);
    return {
      id:          i + 1,
      ticker:      t.ticker,
      type:        openJ?.optionType === "put" ? "Put Option" : "Call Option",
      openDate:    openJ  ? new Date(openJ.time).toLocaleDateString()  : t.date,
      closeDate:   t.date,
      costBasis:   openJ  ? parseFloat((openJ.premium * 100 * (openJ.contracts||1)).toFixed(2)) : 0,
      proceeds:    closeJ ? parseFloat(((closeJ.exitPremium||0) * 100 * (openJ?.contracts||1)).toFixed(2)) : 0,
      pnl:         parseFloat(t.pnl.toFixed(2)),
      shortTerm:   true, // options are always short-term
      reason:      t.reason,
    };
  });
}


module.exports = {
  getDrawdownProtocol, checkConcentrationRisk, runStressTest,
  checkScaleIns, checkAllFilters, countRecentDayTrades,
  isDayTrade, recordDayTrade, getStreakAnalysis,
  calcThesisIntegrity, getPnLByTicker, getPnLBySector,
  getPnLByScoreRange, getTaxLog,
};
