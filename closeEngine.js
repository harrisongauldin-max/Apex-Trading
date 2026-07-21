// closeEngine.js — ARGO V3.2
// Position closing, partial closes, and order confirmation.
'use strict';

let dryRunMode = false; // set by scanner via setDryRunMode()
function setDryRunMode(v) { dryRunMode = v; }

// Local copies from risk.js — avoids circular risk→execution→closeEngine→risk
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
    pnl:       0,
  });
  if (state.dayTrades.length > 20) state.dayTrades = state.dayTrades.slice(-20);
  const count = countRecentDayTrades();
  logEvent("warn", `PDT: Day trade recorded for ${pos.ticker} — ${count}/${PDT_LIMIT} in rolling 5-day window`);
  if (count >= PDT_LIMIT) {
    logEvent("warn", `PDT LIMIT REACHED (${count}/${PDT_LIMIT}) — no new same-day CLOSES until window resets. New entries still allowed.`);
  }
}
const WEEKLY_DD_LIMIT = 0.25;
const FAST_PROFIT_PCT = 0.65;

const { alpacaGet, alpacaPost, alpacaDelete } = require('./broker');
const { state, logEvent, markDirty, saveStateNow,
        writeJournalEntry, updateJournalExit,
        loadJournalDay, saveJournalDay } = require('./state');
const { calcCreditSpreadTP, realizedPnL ,
  openRisk, totalCap
}     = require('./signals');
const { STOP_LOSS_PCT, TAKE_PROFIT_PCT, PDT_PROFIT_EXIT,
        PDT_STOP_LOSS, FAST_STOP_PCT, MONTHLY_BUDGET,
  ALPACA_KEY, BONUS_AMOUNT, MS_PER_DAY, PDT_LIMIT, PDT_RULE_ACTIVE, REVENUE_THRESHOLD, WATCHLIST,
  TRAIL_ACTIVATE_PCT,
  // C1 Sunday 6/8
  DAILY_LOSS_LOCK_THRESHOLD, DAILY_LOSS_LOCK_MIN_SCORE,
  INSTRUMENT_LOSS_LIMIT, INSTRUMENT_LOSS_MIN_SCORE, LOSS_THRESHOLD_FOR_COUNTER,
  WEEKLY_LOSS_LIMIT, MONTHLY_LOSS_LIMIT,
}  = require('./constants');
const { countRecentDayTrades } = require('./risk');

// ─── Injected dependencies ───────────────────────────────────────
let _dryRunMode    = false;
let _getOptionsPrice = async () => 0;
let _sendAlert     = async () => {};
let _fmt           = (n) => '$' + (n||0).toFixed(2);

function initCloseEngine({ dryRunMode, getOptionsPrice, sendAlert, fmt } = {}) {
  if (dryRunMode !== undefined) _dryRunMode = dryRunMode;
  if (getOptionsPrice) _getOptionsPrice = getOptionsPrice;
  if (sendAlert) _sendAlert = sendAlert;
  if (fmt) _fmt = fmt;
}

async function syncCashFromAlpaca() {
  if (!ALPACA_KEY) return;
  try {
    const acct = await alpacaGet("/account");
    if (!acct || !acct.cash) return;
    const alpacaCash      = parseFloat(acct.cash);
    const alpacaBuyPower  = parseFloat(acct.buying_power || acct.cash);
    const alpacaOptBP     = parseFloat(acct.options_buying_power || acct.buying_power || acct.cash);
    state.alpacaCash      = alpacaCash;
    state.alpacaBuyPower  = alpacaBuyPower;
    state.alpacaOptBP     = alpacaOptBP;
    const alpacaEquity    = parseFloat(acct.equity || acct.portfolio_value || alpacaCash);
    if (alpacaEquity > 0) state.alpacaEquity = alpacaEquity;
    if (acct.pattern_day_trader !== undefined) {
      state._patternDayTrader = acct.pattern_day_trader;
    }
    if (!state.accountBaseline) state.accountBaseline = alpacaCash;
    const hasCustomBudget = state.customBudget && state.customBudget > 0 && state.customBudget !== MONTHLY_BUDGET;
    const drift = Math.abs(alpacaCash - state.cash);
    if (drift > 1.00) {
      if (drift > 500) {
        logEvent("scan", `[CASH SYNC] Drift $${drift.toFixed(2)} — syncing all baselines to Alpaca: $${alpacaCash.toFixed(2)}`);
        state.dayStartCash  = state.dayStartCash  || alpacaCash;
        state.weekStartCash = state.weekStartCash || alpacaCash;
        state.peakCash      = Math.max(state.peakCash || 0, alpacaCash);
        state.cash          = alpacaCash;
        markDirty();
      } else {
        logEvent("scan", `[CASH SYNC] Alpaca: $${alpacaCash.toFixed(2)} | APEX: $${state.cash.toFixed(2)} | drift: $${drift.toFixed(2)} — syncing`);
        state.cash = alpacaCash;
        markDirty();
      }
    }
  } catch(e) {}
}

const _closingInProgress = new Set();

async function closePosition(ticker, reason, exitPremium = null, contractSym = null, opts = {}) {
  const mutexKey = contractSym || ticker;
  if (_closingInProgress.has(mutexKey)) {
    logEvent("warn", `${ticker} close already in-flight (mutex) — skipping concurrent close (${reason})`);
    return;
  }
  _closingInProgress.add(mutexKey);
  try {
    return await _doClosePosition(ticker, reason, exitPremium, contractSym, opts);
  } finally {
    _closingInProgress.delete(mutexKey);
  }
}

async function _doClosePosition(ticker, reason, exitPremium = null, contractSym = null, opts = {}) {
  try {
    const idx = contractSym
      ? state.positions.findIndex(p => p.contractSymbol === contractSym || p.buySymbol === contractSym)
      : state.positions.findIndex(p => p.ticker === ticker);
    if (idx === -1) return;
    const pos  = state.positions[idx];
    if (pos._closingSubmitted) {
      logEvent("warn", `${ticker} close already submitted this scan — skipping duplicate`);
      return;
    }
    pos._closingSubmitted = true;

    var alpacaCloseOk = _dryRunMode;
  const mult = pos.partialClosed ? 0.5 : 1.0;

  let ep;
  if (exitPremium !== null) {
    ep = exitPremium;
  } else {
    if (pos.contractSymbol) {
      const realP = await _getOptionsPrice(pos.contractSymbol);
      if (realP) ep = realP;
    }
    if (!ep && pos.currentPrice && pos.currentPrice > 0) {
      ep = pos.currentPrice;
    }
    if (!ep) {
      const g = reason === "stop"        ? -STOP_LOSS_PCT
              : reason === "fast-stop"   ? -FAST_STOP_PCT
              : reason === "target"      ? TAKE_PROFIT_PCT
              : reason === "trail"       ? TRAIL_ACTIVATE_PCT
              : reason === "expiry-roll" ? 0.15
              : reason === "fast-profit" ? FAST_PROFIT_PCT
              : 0;
      ep = parseFloat((pos.premium * (1 + g)).toFixed(2));
      logEvent("warn", `${pos.ticker} using estimated exit price (no real data available) | reason:${reason} | ep:$${ep}`);
    }
  }
  ep = parseFloat(ep.toFixed(2));
  const contractsToSell = pos.contracts === 1 ? 1 : Math.max(1, Math.floor(pos.contracts * mult));
  const ev   = parseFloat((ep * 100 * contractsToSell).toFixed(2));
  const costBasis = parseFloat((pos.premium * 100 * contractsToSell).toFixed(2));
  let pnl;
  if (pos.isCreditSpread) {
    pnl = parseFloat(((pos.premium - ep) * 100 * contractsToSell).toFixed(2));
  } else {
    pnl = parseFloat((ev - costBasis).toFixed(2));
  }
  const pct  = pos.isCreditSpread
    ? ((pnl / (pos.maxProfit || (pos.premium * 100 * pos.contracts))) * 100).toFixed(1)
    : ((pnl / (pos.cost * mult)) * 100).toFixed(1);
  const nr   = state.totalRevenue + (pnl > 0 ? pnl : 0);
  const bonus= state.totalRevenue < REVENUE_THRESHOLD && nr >= REVENUE_THRESHOLD;

  if (_dryRunMode) {
    logEvent("dryrun", `WOULD CLOSE ${ticker} | reason:${reason} | exit:$${ep} | P&L:${pnl>=0?"+":""}$${pnl.toFixed(2)} (${pct}%)`);
    pos._dryRunWouldClose = true;
    return;
  }

  const closeQty = contractsToSell;
  const heldSeconds = (Date.now() - new Date(pos.openDate).getTime()) / 1000;
  const alpacaCloseAllowed = heldSeconds >= 60;
  if (!alpacaCloseAllowed) logEvent("warn", `${ticker} held only ${heldSeconds.toFixed(0)}s - skipping Alpaca close order to avoid wash trade`);
  if (!pos.isSpread && closeQty > 0 && !_dryRunMode && alpacaCloseAllowed) {
    const isShortLeg = !!(pos.sellSymbol && !pos.buySymbol);
    const closeSym   = pos.contractSymbol || pos.buySymbol || pos.sellSymbol;

    if (!closeSym) {
      logEvent("warn", `${ticker} cannot close - no contract symbol on position`);
    } else {
      try {
        let closeBody;
        if (isShortLeg) {
          closeBody = {
            symbol:          closeSym,
            qty:             closeQty,
            side:            "buy",
            type:            "market",
            time_in_force:   "day",
            position_intent: "buy_to_close",
          };
        } else {
          const bidPrice = parseFloat((pos.bid > 0 ? pos.bid : ep * 0.98).toFixed(2));
          closeBody = {
            symbol:          closeSym,
            qty:             closeQty,
            side:            "sell",
            type:            "limit",
            time_in_force:   "day",
            limit_price:     bidPrice,
            position_intent: "sell_to_close",
          };
        }
        const closeResp = await alpacaPost("/orders", closeBody);
        if (closeResp && closeResp.id) {
          logEvent("trade", `Alpaca close order: ${closeResp.id} | ${closeSym} | ${closeQty}x ${isShortLeg ? "buy_to_close" : "sell_to_close"} | reason:${reason}`);
          alpacaCloseOk = true;
          if (closeResp.filled_avg_price && parseFloat(closeResp.filled_avg_price) > 0) {
            ep = parseFloat(parseFloat(closeResp.filled_avg_price).toFixed(2));
          }
        } else {
          logEvent("warn", `Alpaca close order failed for ${closeSym}: ${JSON.stringify(closeResp)?.slice(0,150)}`);
          if (closeResp && closeResp.code === 40310000) {
            pos._permissionBlocked = true;
            pos._permissionBlockedAt = new Date().toISOString();
            pos._permBlockReason = "40310000 transient reject — 15min cooldown then auto-retry";
            logEvent("warn", `[PERM BLOCK] ${ticker} ${closeSym} blocked (40310000) — 15min cooldown, will auto-retry. If persists after retry, check Alpaca options tier.`);
            return;
          }
        }
      } catch(e) {
        logEvent("error", `Alpaca close order error: ${e.message}`);
      }
    }
  }

  if (!alpacaCloseOk && !_dryRunMode) {
    logEvent("warn", `${ticker} state NOT updated — Alpaca close unconfirmed. Position preserved.`);
    delete pos._closingSubmitted;
    return;
  }
  const _cashDelta = pos.isCreditSpread ? pnl : ev;
  state.cash       = parseFloat((state.cash + _cashDelta + (bonus?BONUS_AMOUNT:0)).toFixed(2));
  state.extraBudget  += bonus ? BONUS_AMOUNT : 0;
  state.totalRevenue  = nr;
  state.monthlyProfit = parseFloat((state.monthlyProfit + pnl).toFixed(2));
  const _spliceIdx = state.positions.indexOf(pos);
  if (_spliceIdx !== -1) state.positions.splice(_spliceIdx, 1);
  const bypassPDT = opts.bypassPDT === true;
  if (PDT_RULE_ACTIVE && isDayTrade(pos) && !bypassPDT) {
    recordDayTrade(pos, reason);
  } else if (PDT_RULE_ACTIVE && isDayTrade(pos) && bypassPDT) {
    logEvent("scan", `[PDT] Emergency exit (${reason}) - day trade NOT counted (bypassPDT)`);
  }
  const hasSpreadStructure = !!(pos.buySymbol && pos.sellSymbol && pos.buyStrike && pos.sellStrike);
  const tradeOutcome = {
    ticker, tradeType: pos.isCreditSpread ? "credit_spread" : (pos.isSpread || hasSpreadStructure) ? "debit_spread" : "naked",
    optionType: pos.optionType,
    pnl, pct, reason, date: new Date().toLocaleDateString(), closeTime: Date.now(),
    won: pnl > 0,
    entryScore:    pos.score || 0,
    entryRSI:      pos.entryRSI || 0,
    entryMACD:     pos.entryMACD || "neutral",
    entryMacro:    pos.entryMacro || "neutral",
    entryVIX:      pos.entryVIX || 0,
    entryMomentum: pos.entryMomentum || "steady",
    exitVIX:       state.vix || 0,
    exitRSI:       pos._lastExitRSI || 0,
    exitMACD:      pos._lastExitMACD || "unknown",
    exitBreadth:   (state._breadthHistory?.slice(-1)[0]?.v) || 0,
    exitPCR:       state._pcr?.pcr || 0,
    exitSKEW:      state._skew?.skew || 0,
    exitAgentSignal: (state._agentMacro || {}).signal || "unknown",
    exitRegime:    (state._agentMacro || {}).regime || "unknown",
    daysHeld:    Math.round((Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY),
    maxAdverseExcursion: pos.maxAdverseExcursion || 0,
    dteAtEntry:  pos.expDays || 0,
    dteAtExit:   Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY)),
    spreadWidth:  pos.spreadWidth || 0,
    buyStrike:    pos.buyStrike || pos.strike || 0,
    sellStrike:   pos.sellStrike || 0,
    maxProfit:    pos.maxProfit || 0,
    maxLoss:      pos.maxLoss || pos.premium || 0,
    pctOfMaxProfit: pos.maxProfit > 0 ? parseFloat(((pnl / (pos.maxProfit * 100 * (pos.contracts||1))) * 100).toFixed(1)) : 0,
    regime:        (state._agentMacro || {}).regime || (state._dayPlan || {}).regime || "unknown",
    regimeConf:    (state._agentMacro || {}).confidence || 0,
    agentSignal:   (state._agentMacro || {}).signal || "neutral",
  };
  state.closedTrades.push(tradeOutcome);
  // FIX 10: Track daily realized P&L for circuit breaker
  if (typeof tradeOutcome.pnl === 'number') {
    state.todayRealizedPnL = (state.todayRealizedPnL || 0) + tradeOutcome.pnl;

    // C1-A: Daily loss lock — soft gate at -$300
    if (!state._dailyLossLockActive && state.todayRealizedPnL <= DAILY_LOSS_LOCK_THRESHOLD) {
      state._dailyLossLockActive    = true;
      state._dailyLossLockTriggeredAt = new Date().toISOString();
      logEvent("circuit", `[C1-A] Daily loss lock TRIGGERED — todayRealizedPnL $${state.todayRealizedPnL.toFixed(0)} <= $${DAILY_LOSS_LOCK_THRESHOLD} — minScore raised to ${DAILY_LOSS_LOCK_MIN_SCORE}`);
    }

    // C1-B: Per-instrument loss count — increment when loss exceeds threshold
    if (tradeOutcome.pnl < LOSS_THRESHOLD_FOR_COUNTER) {
      if (!state._instrumentLossCount) state._instrumentLossCount = {};
      state._instrumentLossCount[ticker] = (state._instrumentLossCount[ticker] || 0) + 1;
      const _instrCount = state._instrumentLossCount[ticker];
      if (_instrCount >= INSTRUMENT_LOSS_LIMIT) {
        logEvent("circuit", `[C1-B] ${ticker} instrument loss count ${_instrCount} >= ${INSTRUMENT_LOSS_LIMIT} — minScore raised to ${INSTRUMENT_LOSS_MIN_SCORE} for this ticker`);
      }
    }

    // C1-G: Weekly accumulator
    state._weeklyRealizedPnL = (state._weeklyRealizedPnL || 0) + tradeOutcome.pnl;
    if (!state._weeklyLossLockActive && state._weeklyRealizedPnL <= WEEKLY_LOSS_LIMIT) {
      state._weeklyLossLockActive = true;
      logEvent("circuit", `[C1-G] Weekly loss lock TRIGGERED — weeklyRealizedPnL $${state._weeklyRealizedPnL.toFixed(0)} <= $${WEEKLY_LOSS_LIMIT} — all entries halted`);
    }
    // C1-G: Monthly accumulator (use monthlyProfit which is already tracked)
    if (!state._monthlyLossLockActive && (state.monthlyProfit || 0) <= MONTHLY_LOSS_LIMIT) {
      state._monthlyLossLockActive = true;
      logEvent("circuit", `[C1-G] Monthly loss lock TRIGGERED — monthlyProfit $${(state.monthlyProfit||0).toFixed(0)} <= $${MONTHLY_LOSS_LIMIT} — all entries halted`);
    }
  }

  if (!state.scoreBrackets) state.scoreBrackets = {};
  const entryScore = pos.score || 0;
  const bracket = entryScore >= 90 ? "90-100" : entryScore >= 80 ? "80-89" : entryScore >= 70 ? "70-79" : "below-70";
  if (!state.scoreBrackets[bracket]) state.scoreBrackets[bracket] = { trades:0, wins:0, totalPnl:0 };
  state.scoreBrackets[bracket].trades++;
  if (pnl > 0) state.scoreBrackets[bracket].wins++;
  state.scoreBrackets[bracket].totalPnl = parseFloat((state.scoreBrackets[bracket].totalPnl + pnl).toFixed(2));
  state.scoreBrackets[bracket].winRate  = parseFloat(((state.scoreBrackets[bracket].wins / state.scoreBrackets[bracket].trades) * 100).toFixed(1));

  if (!state._spiralTracker) state._spiralTracker = { put: 0, call: 0 };
  const posType = pos.optionType || "unknown";
  if (pnl <= 0) {
    state._spiralTracker[posType] = (state._spiralTracker[posType] || 0) + 1;
    const consecLosses = state._spiralTracker[posType];
    const totalTrades = (state.closedTrades || []).length;
    if (consecLosses >= 5) {
      logEvent("warn", `[SPIRAL] ${consecLosses} consecutive ${posType} losses (total trades: ${totalTrades})`);
      if (totalTrades >= 20) {
        state._spiralActive = posType;
        logEvent("warn", `[SPIRAL] ${posType} entries blocked — 20+ trade history confirms pattern`);
      } else {
        logEvent("warn", `[SPIRAL] Block NOT activated — only ${totalTrades} total trades (need 20+ to confirm spiral)`);
      }
    }
  } else {
    state._spiralTracker[posType] = 0;
    if (state._spiralActive === posType) {
      state._spiralActive = null;
      logEvent("scan", `[SPIRAL] ${posType} spiral broken - consecutive wins reset`);
    }
  }

  if (state.closedTrades.length > 200) state.closedTrades = state.closedTrades.slice(0, 200);

  if (!state.exitStats) state.exitStats = {};
  if (!state.exitStats[reason]) state.exitStats[reason] = { count:0, wins:0, totalPnl:0, avgPnl:0, winRate:0 };
  const es = state.exitStats[reason];
  es.count++;
  if (pnl > 0) es.wins++;
  es.totalPnl  = parseFloat((es.totalPnl + pnl).toFixed(2));
  es.avgPnl    = parseFloat((es.totalPnl / es.count).toFixed(2));
  es.winRate   = parseFloat(((es.wins / es.count) * 100).toFixed(1));
  logEvent("scan", `Exit stats [${reason}]: ${es.count} trades | win ${es.winRate}% | avg P&L $${es.avgPnl}`);
  await saveStateNow();

  if (pnl < 0) state.consecutiveLosses++;
  else state.consecutiveLosses = 0;

  if (pnl < 0) {
    state._recentLosses = state._recentLosses || {};
    const _lossPos = pos || {};  // fix: use the position being closed, not a ticker re-find (twin-leg ambiguity; pos already spliced above)
    const _exitRSI = _lossPos._prevRSI || _lossPos.rsi || _lossPos.entryRSI || 50;
    state._recentLosses[ticker] = {
      closedAt:    Date.now(),
      reason,
      agentSignal: (state._agentMacro || {}).signal || "neutral",
      price:       ep,
      pnlPct:      parseFloat(pct),
      entryRSI:    _lossPos.entryRSI || _lossPos.rsi || 50,
      exitRSI:     _exitRSI,
      optionType:  _lossPos.optionType || null,
    };
    logEvent("warn", `[THESIS] ${ticker} loss recorded - re-entry requires agent confirmation for 24h`);
  }

  state._recentCloses = state._recentCloses || {};
  const _closingPos = pos || {};  // fix: same — the closed position is already in scope
  state._recentCloses[ticker] = {
    closedAt:   Date.now(),
    optionType: _closingPos.optionType || null,
    pnl,
    reason,
  };

  const fullPortfolioValue = state.cash + openRisk() ;
  if (fullPortfolioValue > state.peakCash) state.peakCash = fullPortfolioValue;

  const portfolioValue = state.cash + openRisk() ;
  const dailyPnL  = portfolioValue - state.dayStartCash;
  const weeklyPnL = portfolioValue - state.weekStartCash;

  if (dailyPnL / totalCap() <= -0.25 && state.circuitOpen) {
    state.circuitOpen = false;
    logEvent("circuit", `DAILY MAX LOSS circuit - lost ${_fmt(Math.abs(dailyPnL))} (${(dailyPnL/totalCap()*100).toFixed(1)}% of total capital)`);
  }
  if (weeklyPnL / totalCap() <= -WEEKLY_DD_LIMIT && state.weeklyCircuitOpen) {
    state.weeklyCircuitOpen = false;
    logEvent("circuit", `WEEKLY circuit breaker - loss ${_fmt(Math.abs(weeklyPnL))} (${(WEEKLY_DD_LIMIT*100)}% limit)`);
  }

  if (bonus) logEvent("bonus", `REVENUE HIT $${REVENUE_THRESHOLD} - +$${BONUS_AMOUNT} bonus added!`);

  state.tradeJournal.unshift({
    time:      new Date().toISOString(),
    ticker,
    action:    "CLOSE",
    reason,
    optionType: pos.optionType,
    isSpread:   pos.isSpread || !!(pos.buySymbol && pos.sellSymbol),
    isCreditSpread: pos.isCreditSpread || false,
    tradeType:  pos.isCreditSpread ? "credit_spread" : (pos.isSpread || (pos.buySymbol && pos.sellSymbol)) ? "debit_spread" : "naked",
    strike:    pos.strike || pos.buyStrike || null,
    expDate:   pos.expDate || null,
    buyStrike: pos.buyStrike || null,
    sellStrike: pos.sellStrike || null,
    exitPremium: ep,
    pnl,
    pct,
    reasoning: `Closed ${reason}. Exit premium $${ep} vs entry $${pos.premium}. P&L: ${pnl>=0?"+":""}${_fmt(pnl)} (${pct}%).`,
  });

  const _now       = new Date();
  const _etStr2    = (dt) => new Date(dt).toLocaleString('en-US', {timeZone:'America/New_York',
    month:'2-digit', day:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'});
  const _hoursHeld = pos.openDate
    ? parseFloat(((Date.now() - new Date(pos.openDate).getTime()) / 3600000).toFixed(2))
    : null;
  const _peakPct   = pos.premium > 0
    ? parseFloat(((pos.peakPremium - pos.premium) / pos.premium * 100).toFixed(1))
    : 0;
  // MFE = peak (above). MAE = max adverse excursion from troughPremium (reconciler-tracked).
  const _maePct    = (pos.premium > 0 && pos.troughPremium != null)
    ? parseFloat(((pos.troughPremium - pos.premium) / pos.premium * 100).toFixed(1))
    : null;
  const _minsToPeak = pos.openDate && pos._peakTime
    ? parseFloat(((pos._peakTime - new Date(pos.openDate).getTime()) / 60000).toFixed(0))
    : null;
  const _pnlApex   = parseFloat(((ep - pos.premium) * 100 * (pos.contracts || contractsToSell)).toFixed(2));
  // ADD (6/14): human-readable exit "why" from the context exitEngine stashed on pos
  const _lastThesis = (pos.thesisHistory && pos.thesisHistory.length)
    ? pos.thesisHistory[pos.thesisHistory.length - 1] : null;
  const _exitPnlPct = pos.cost > 0 ? (_pnlApex / pos.cost * 100) : 0;
  const _giveback   = (typeof _peakPct === 'number' && _peakPct > 0)
    ? Math.round(_peakPct - _exitPnlPct) : null;
  let _exitDetail;
  switch (reason) {
    case 'thesis-collapsed':  _exitDetail = _lastThesis ? `thesis ${_lastThesis.score}/100 — ${_lastThesis.notes}` : 'thesis integrity collapsed (<20)'; break;
    case 'tiered-stop':       _exitDetail = pos._tierStopContext ? `tiered intraday stop @-${(pos._tierStopContext.tierStop*100).toFixed(0)}% after ${pos._tierStopContext.minsSinceEntry}min (peak was ${(pos._tierStopContext.peakChg*100).toFixed(0)}%)` : 'tiered intraday stop'; break;
    case 'trail':             _exitDetail = `trail floor — peaked +${(_peakPct||0).toFixed(0)}%${_giveback!=null?`, gave back ~${_giveback}pts`:''}`; break;
    case 'fast-stop':         _exitDetail = 'fast-stop (early loss control)'; break;
    case 'time-stop':         _exitDetail = 'time-adjusted stop'; break;
    case 'dte-urgency':       _exitDetail = 'DTE expiry urgency'; break;
    case 'iv-collapse':       _exitDetail = 'IV collapse'; break;
    case 'premium-floor':     _exitDetail = 'premium floor (-50%)'; break;
    case 'delta-compression': _exitDetail = 'delta compression'; break;
    case 'stop':              _exitDetail = 'hard stop (-35%)'; break;
    case 'target':            _exitDetail = 'profit target hit'; break;
    default:                  _exitDetail = reason;
  }

  const _exitFields = {
    closeDate:          _now.toISOString(),
    closeDateET:        _etStr2(_now),
    exitPrice:          ep,
    exitReason:         reason,
    exitDetail:         _exitDetail,
    exitThesis:         _lastThesis ? { score: _lastThesis.score, notes: _lastThesis.notes } : null,
    exitTierContext:    pos._tierStopContext || null,
    exitBreadth:        state._breadth ?? null,
    exitBreadthLab:     state._breadthLab
                          ? { spSpread: state._breadthLab.spSpread, spLabel: state._breadthLab.spLabel,
                              nqSpread: state._breadthLab.nqSpread, nqLabel: state._breadthLab.nqLabel,
                              accel: state._breadthLab.accel, trend: state._breadthLab.trend }
                          : null,
    exitRSI:            pos._prevRSI || null,
    exitVIX:            state.vix || null,
    exitScore:          pos._lastAgentScore || null,
    actualFillProceeds: null,
    peakPrice:          pos.peakPremium || ep,
    peakPct:            _peakPct,
    mfe_pct:            _peakPct,
    mae_pct:            _maePct,
    peakTime:           pos._peakTime ? new Date(pos._peakTime).toISOString() : null,
    minsToPeak:         _minsToPeak,
    _thesisFulfilled:   pos._thesisFulfilled || false,
    _thesisFailure:     pos._thesisFailure || false,
    contractsAtClose:   pos.contracts || contractsToSell,
    pnl_apex:           _pnlApex,
    pnl_alpaca:         pos.cost > 0
      ? parseFloat((ep * 100 * (pos.contracts || contractsToSell) - pos.cost).toFixed(2))
      : _pnlApex,
    pnl_pct:            pos.cost > 0 ? parseFloat((_pnlApex / pos.cost * 100).toFixed(1)) : 0,
    hoursHeld:          _hoursHeld,
    isWin:              _pnlApex > 0,
    status:             'CLOSED',
  };
  const _sym = pos.contractSymbol || pos.buySymbol;
  // ADD (6/14): one grep-able structured line per exit — pairs with [ENTRY-FIRED]
  {
    const _labE = state._breadthLab;
    const _labEStr = _labE
      ? `RSP-SPY:${_labE.spSpread ?? '?'}(${_labE.spLabel || '?'}) QQQE-QQQ:${_labE.nqSpread ?? '?'}(${_labE.nqLabel || '?'})`
      : 'lab:n/a';
    logEvent('filter', `[EXIT-FIRED] ${pos.ticker} ${(pos.optionType||'?').toUpperCase()} reason:${reason} | ${_exitDetail} | P&L:${_exitFields.pnl_pct >= 0 ? '+' : ''}${_exitFields.pnl_pct}% (${_exitFields.isWin ? 'WIN' : 'LOSS'}) | held:${_exitFields.hoursHeld}h peak:+${(_peakPct||0).toFixed(0)}% | exitRSI:${pos._prevRSI ?? '?'} breadth:${state._breadth ?? '?'}% | ${_labEStr}`);
  }

  updateJournalExit(_sym, _exitFields, {
    ticker: pos.ticker || ticker, optionType: pos.optionType, strike: pos.strike, expDate: pos.expDate
  }).then(found => {
    if (!found) {
      writeJournalEntry({
        id:             `${_sym}_exit_${Date.now()}`,
        contractSymbol: _sym,
        ticker,
        optionType:     pos.optionType,
        strike:         pos.strike,
        expDate:        pos.expDate,
        tradeType:      'naked',
        status:         'CLOSED',
        openDate:       pos.openDate || _now.toISOString(),
        openDateET:     pos.openDate ? _etStr2(new Date(pos.openDate)) : _etStr2(_now),
        entryPrice:     pos.premium,
        entryContracts: pos.contracts || contractsToSell,
        entryCost:      pos.cost,
        entryScore:     pos.score || 0,
        entryRSI:       pos.entryRSI || null,
        entryDelta:     pos.greeks?.delta || pos.entryDelta || null,
        entryIV:        pos.iv || pos.entryIV || null,
        entryVIX:       pos.entryVIX || null,
        entryIVR:       pos.ivr || pos.entryIVR || null,
        entryMACD:      pos.entryMACD || null,
        entryMomentum:  pos.entryMomentum || null,
        macroSignal:    pos.macroSignal || null,
        regimeAtEntry:  pos.regimeAtEntry || null,
        ..._exitFields,
      }).catch(e => logEvent('warn', `[JOURNAL] Standalone exit write failed: ${e.message}`));
    }
  }).catch(e => logEvent('warn', `[JOURNAL] Exit update failed for ${ticker}: ${e.message}`));

  logEvent("close",
    `${reason.toUpperCase()} ${ticker} | exit $${ep} | P&L ${pnl>=0?"+":""}${_fmt(pnl)} (${pct}%) | ` +
    `cash ${_fmt(state.cash)}`
  );
  await syncCashFromAlpaca();
  markDirty();
  return true;
  } catch(e) {
    logEvent("error", `closePosition crashed for ${ticker} (${reason}): ${e.message}`);
    const stuckIdx = state.positions.findIndex(p => p.ticker === ticker);
    if (stuckIdx !== -1) {
      state.positions.splice(stuckIdx, 1);
      logEvent("warn", `${ticker} force-removed from positions after error`);
      try { await saveStateNow(); } catch(se) {}
    }
    return false;
  }
}

async function partialClose(ticker) {
  const pos = state.positions.find(p => p.ticker === ticker);
  if (!pos || pos.partialClosed) return;

  if (pos._closingInFlight) {
    logEvent("partial", `${ticker} partial close skipped — full close in-flight (_closingInFlight=true)`);
    return;
  }

  if ((pos.contracts || 1) === 1) {
    logEvent("partial", `${ticker} 1-contract - escalating to full close`);
    await closePosition(ticker, "target");
    return;
  }

  if (pos.isSpread && pos.contracts >= 2) {
    const half = Math.floor(pos.contracts / 2);
    logEvent("partial", `${ticker} spread partial close - closing ${half}/${pos.contracts} contracts`);
    if (!_dryRunMode && pos.buySymbol && pos.sellSymbol) {
      try {
        const closeMleg = {
          order_class: "mleg", type: "market", time_in_force: "day",
          qty: String(half),
          legs: [
            { symbol: pos.buySymbol,  side: "sell", ratio_qty: "1", position_intent: "sell_to_close" },
            { symbol: pos.sellSymbol, side: "buy",  ratio_qty: "1", position_intent: "buy_to_close"  },
          ],
        };
        const resp = await alpacaPost("/orders", closeMleg);
        if (resp && resp.id) {
          logEvent("partial", `[SPREAD PARTIAL] mleg close submitted: ${resp.id} | ${half}x`);
        }
      } catch(e) {
        logEvent("error", `[SPREAD PARTIAL] mleg error: ${e.message}`);
      }
    }
    const curP  = pos.currentPrice || pos.premium;
    const pnl   = parseFloat(((curP - pos.premium) * 100 * half).toFixed(2));
    pos.contracts     -= half;
    pos.partialClosed  = true;
    pos.cost           = parseFloat((pos.premium * 100 * pos.contracts).toFixed(2));
    state.closedTrades.push({
      ticker, pnl, pct: ((pnl/(pos.premium*100*half))*100).toFixed(1),
      date: new Date().toLocaleDateString(), reason: "partial",
      tradeType: "debit_spread", optionType: pos.optionType,
      closeTime: Date.now(),
    });
    await syncCashFromAlpaca();
    await saveStateNow();
    logEvent("partial", `PARTIAL SPREAD ${ticker} - ${half}x closed | P&L: ${pnl>=0?"+":""}$${pnl.toFixed(2)} | ${pos.contracts}x remaining`);
    return;
  }

  pos.partialClosed = true;
  let ep = pos.currentPrice || pos.premium * 1.5;
  if (pos.contractSymbol) {
    const realP = await _getOptionsPrice(pos.contractSymbol);
    if (realP) ep = realP;
  }
  ep = parseFloat(ep.toFixed(2));
  const half = Math.max(1, Math.floor(pos.contracts / 2));

  if (pos.contractSymbol && half > 0 && !_dryRunMode) {
    try {
      const bidPrice = parseFloat((pos.bid > 0 ? pos.bid : ep * 0.98).toFixed(2));
      const partialBody = {
        symbol:           pos.contractSymbol,
        qty:              half,
        side:             "sell",
        type:             "limit",
        time_in_force:    "day",
        limit_price:      bidPrice,
        position_intent:  "sell_to_close",
      };
      const partialResp = await alpacaPost("/orders", partialBody);
      if (partialResp && partialResp.id) {
        logEvent("partial", `Alpaca partial close: ${partialResp.id} | ${pos.contractSymbol} | ${half}x`);
        if (partialResp.filled_avg_price && parseFloat(partialResp.filled_avg_price) > 0) {
          ep = parseFloat(parseFloat(partialResp.filled_avg_price).toFixed(2));
        }
        pos._partialOrderSubmitted = true;
      } else {
        logEvent("warn", `Alpaca partial close FAILED for ${pos.contractSymbol}: ${JSON.stringify(partialResp)?.slice(0,100)} — state NOT mutated`);
        pos._partialOrderSubmitted = false;
      }
    } catch(e) {
      logEvent("error", `Alpaca partial close error: ${e.message}`);
    }
  }

  const ev   = parseFloat((ep * 100 * half).toFixed(2));
  const pnl  = parseFloat(((ep - pos.premium) * 100 * half).toFixed(2));

  if (_dryRunMode) {
    logEvent("dryrun", `WOULD PARTIAL CLOSE ${ticker} | ${half}x @ $${ep} | P&L:+$${pnl.toFixed(2)}`);
    return;
  }

  state.cash = parseFloat((state.cash + ev).toFixed(2));
  state.monthlyProfit = parseFloat((state.monthlyProfit + pnl).toFixed(2));
  state.closedTrades.push({
    ticker, pnl, pct: ((pnl/pos.cost)*100).toFixed(1),
    date: new Date().toLocaleDateString(), reason: "partial",
    tradeType:  pos.isCreditSpread ? "credit_spread" : (pos.isSpread || (pos.buySymbol && pos.sellSymbol)) ? "debit_spread" : "naked",
    optionType: pos.optionType,
    closeTime:  Date.now(),
  });
  if (pos._partialOrderSubmitted !== false) {
    pos.contracts     = Math.max(0, pos.contracts - half);
    pos.cost          = parseFloat((pos.premium * 100 * pos.contracts).toFixed(2));
    pos.partialClosed = false;
    logEvent("partial", `PARTIAL ${ticker} - ${half}x @ $${ep} | P&L:${pnl>=0?"+":""}${_fmt(pnl)} | ${pos.contracts}x remaining @ cost $${pos.cost} | cash ${_fmt(state.cash)}`);
  } else {
    logEvent("warn", `[SPRINT-03] ${ticker} partial order rejected by Alpaca — pos.contracts unchanged at ${pos.contracts}`);
  }
  delete pos._partialOrderSubmitted;
  await saveStateNow();
}

async function closeNContracts(ticker, n, reason, exitPremium = null) {
  const pos = state.positions.find(p => p.ticker === ticker);
  if (!pos) { logEvent("warn", `closeNContracts: no position found for ${ticker}`); return; }

  if (pos._closingInFlight) {
    logEvent("partial", `${ticker} closeNContracts skipped — full close in-flight`);
    return;
  }

  if (pos._closingSubmitted) {
    logEvent("partial", `${ticker} closeNContracts skipped — _closingSubmitted`);
    return;
  }

  const remaining = pos.contracts || 1;
  if (remaining <= 1) {
    logEvent("partial", `${ticker} closeNContracts: 1 contract remaining — escalating to full close`);
    await closePosition(ticker, reason, exitPremium, pos.contractSymbol || null);
    return;
  }

  const closeQty = Math.min(n, remaining - 1);
  if (closeQty <= 0) {
    logEvent("warn", `${ticker} closeNContracts: closeQty ${closeQty} invalid — skipping`);
    return;
  }

  let ep = exitPremium || pos.currentPrice || pos.premium;
  if (!exitPremium && pos.contractSymbol) {
    const realP = await _getOptionsPrice(pos.contractSymbol);
    if (realP && realP > 0) ep = realP;
  }
  ep = parseFloat(ep.toFixed(2));

  const pnl     = parseFloat(((ep - pos.premium) * 100 * closeQty).toFixed(2));
  const ev      = parseFloat((ep * 100 * closeQty).toFixed(2));
  const bidPrice = parseFloat((pos.bid > 0 ? pos.bid : ep * 0.98).toFixed(2));

  let orderConfirmed = false;
  if (pos.contractSymbol && !_dryRunMode) {
    try {
      const body = {
        symbol:          pos.contractSymbol,
        qty:             closeQty,
        side:            "sell",
        type:            "limit",
        time_in_force:   "day",
        limit_price:     bidPrice,
        position_intent: "sell_to_close",
      };
      const resp = await alpacaPost("/orders", body);
      if (resp && resp.id) {
        orderConfirmed = true;
        logEvent("partial", `[TIERED] Alpaca close ${closeQty}x ${pos.contractSymbol} | orderId:${resp.id} | reason:${reason}`);
        if (resp.filled_avg_price && parseFloat(resp.filled_avg_price) > 0) {
          ep = parseFloat(parseFloat(resp.filled_avg_price).toFixed(2));
        }
      } else {
        logEvent("warn", `[TIERED] Alpaca order rejected for ${ticker} closeNContracts — state NOT mutated`);
        return;
      }
    } catch(e) {
      logEvent("error", `[TIERED] closeNContracts Alpaca error: ${e.message}`);
      return;
    }
  } else if (_dryRunMode) {
    orderConfirmed = true;
    logEvent("dryrun", `WOULD CLOSE ${closeQty}x ${ticker} @ $${ep} | reason:${reason} | P&L:${pnl>=0?"+":""}$${pnl.toFixed(2)}`);
  }

  if (!orderConfirmed) return;

  state.cash          = parseFloat((state.cash + ev).toFixed(2));
  state.monthlyProfit = parseFloat((state.monthlyProfit + pnl).toFixed(2));
  pos.contracts       = Math.max(0, pos.contracts - closeQty);
  pos.cost            = parseFloat((pos.premium * 100 * pos.contracts).toFixed(2));
  pos.contractsClosed = (pos.contractsClosed || 0) + closeQty;

  state.closedTrades.push({
    ticker, pnl,
    pct:        ((pnl / (pos.premium * 100 * closeQty)) * 100).toFixed(1),
    date:       new Date().toLocaleDateString(),
    reason,
    tradeType:  "naked",
    optionType: pos.optionType,
    closeTime:  Date.now(),
  });

  const nowET   = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const _todayStr = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York'}).replace(/\//g,'-');
  const journal = await loadJournalDay(_todayStr);
  const entry   = journal.find(e => e.contractSymbol === pos.contractSymbol || e.ticker === ticker);
  if (entry) {
    if (!entry.partialCloses) entry.partialCloses = [];
    entry.partialCloses.push({
      reason,
      contracts:  closeQty,
      remaining:  pos.contracts,
      exitPrice:  ep,
      pnl,
      pct:        ((pnl / (pos.premium * 100 * closeQty)) * 100).toFixed(1),
      timeET:     nowET,
    });
    await saveJournalDay(_todayStr, journal);
  }

  logEvent("partial", `[TIERED] ${ticker} ${reason} — closed ${closeQty}x @ $${ep} | P&L:${pnl>=0?"+":""}$${_fmt(pnl)} | ${pos.contracts}x remaining | cash $${_fmt(state.cash)}`);
  await saveStateNow();
}

async function confirmPendingOrder() {
  const pending = state._pendingOrder;
  if (!pending) return;
  if (pending._preSubmit) return;

  const age = (Date.now() - pending.submittedAt) / 1000;
  if (!pending.orderId) { state._pendingOrder = null; markDirty(); return; }

  try {
    const fillResp = await alpacaGet(`/orders/${pending.orderId}`);
    if (!fillResp) return;

    if (fillResp.status === 'filled') {
      const fillPrice = parseFloat(fillResp.filled_avg_price || pending.premium || 0);
      const contracts = pending.contracts || 1;
      const cost      = parseFloat((fillPrice * 100 * contracts).toFixed(2));

      state.cash = parseFloat((state.cash - cost).toFixed(2));
      const position = {
        ticker:        pending.ticker,
        optionType:    pending.optionType,
        sector:        (WATCHLIST.find(w => w.ticker === pending.ticker) || {}).sector || 'Unknown',
        contractSymbol: pending.contractSymbol,
        strike:        pending.strike,
        expDate:       pending.expDate,
        expDays:       pending.expDays,
        premium:       fillPrice,
        currentPrice:  fillPrice,
        peakPremium:   fillPrice,
        contracts,
        cost,
        score:         pending.score,
        reasons:       pending.scoreReasons,
        openDate:      new Date().toISOString(),
        isSpread:      false,
        isCreditSpread: false,
        realData:      true,
        vix:           state.vix,
        entryVIX:      state.vix,
        entryIV:       pending.iv || null,
        partialClosed: false,
        target:        parseFloat((fillPrice * (1 + TAKE_PROFIT_PCT)).toFixed(2)),
        stop:          parseFloat((fillPrice * (1 - STOP_LOSS_PCT)).toFixed(2)),
        breakeven:     pending.optionType === 'put'
          ? parseFloat((pending.strike - fillPrice).toFixed(2))
          : parseFloat((pending.strike + fillPrice).toFixed(2)),
      };

      const _tenMinAgo = Date.now() - 10 * 60 * 1000;
      const _recentSameSymbol = (state.closedTrades || []).find(t =>
        t.contractSymbol === pending.contractSymbol &&
        t.closeTime && t.closeTime > _tenMinAgo
      );
      if (_recentSameSymbol) {
        logEvent("warn",
          `[CHURN DETECTED] ${pending.ticker} ${pending.contractSymbol} re-entered ` +
          `${((Date.now() - _recentSameSymbol.closeTime)/60000).toFixed(1)}min after close. ` +
          `Prior close reason: ${_recentSameSymbol.reason || 'unknown'}. ` +
          `This may be a rapid exit/re-entry cycle — review exit logic.`
        );
        position._churnReEntry = true;
        position._priorCloseReason = _recentSameSymbol.reason;
      }

      state.positions.push(position);
      state.todayTrades = (state.todayTrades || 0) + 1;
      state._pendingOrder = null;
      logEvent('trade', `[NAKED] ENTERED ${pending.ticker} ${pending.optionType} $${pending.strike} exp ${pending.expDate} | premium $${fillPrice} | ${contracts}x | cost $${cost}`);

      state.tradeJournal.unshift({
        time:       new Date().toISOString(),
        ticker:     pending.ticker,
        action:     'OPEN',
        optionType: pending.optionType,
        strike:     pending.strike,
        expDate:    pending.expDate,
        premium:    fillPrice,
        cost,
        score:      pending.score,
        reasoning:  `[${pending.optionType.toUpperCase()} OPTION] Score ${pending.score}/100. Strike $${pending.strike} exp ${pending.expDate}. Premium $${fillPrice}. Cost $${cost}.`,
      });
      if (state.tradeJournal.length > 100) state.tradeJournal = state.tradeJournal.slice(0, 100);

      const _etStr = (dt) => new Date(dt).toLocaleString('en-US', {timeZone:'America/New_York',
        month:'2-digit', day:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'});
      const _journalEntry = {
        id:               `${pending.contractSymbol}_${Date.now()}`,
        contractSymbol:   pending.contractSymbol || `${pending.ticker}${pending.expDate}${pending.optionType[0].toUpperCase()}${pending.strike}`,
        ticker:           pending.ticker,
        optionType:       pending.optionType,
        strike:           pending.strike,
        expDate:          pending.expDate,
        tradeType:        'naked',
        isMeanReversion:  pending.isMeanReversion || false,
        openDate:         new Date().toISOString(),
        openDateET:       _etStr(new Date()),
        entryPrice:       fillPrice,
        entryContracts:   contracts,
        entryCost:        cost,
        actualFillCost:   fillResp.filled_avg_price
          ? parseFloat((parseFloat(fillResp.filled_avg_price) * 100 * contracts).toFixed(2))
          : cost,
        entryScore:       pending.score || 0,
        entryReasons:     pending.reasons || [],
        entryRSI:         pending.rsi || pending.liveRSI || null,
        entryDailyRSI:    pending.dailyRsi || null,
        entryDelta:       pending.delta || null,
        entryIV:          pending.iv || null,
        entryVIX:         state.vix || null,
        entryIVR:         state._ivRank || null,
        entryDTE:         pending.dte || null,
        entryMACD:        pending.macd || null,
        entryMomentum:    pending.momentum || null,
        macroSignal:      (state._agentMacro || {}).signal || 'neutral',
        regimeAtEntry:    (state._marketRegime || {}).regime || 'unknown',
        peakPrice:        fillPrice,
        peakPct:          0,
        peakTime:         new Date().toISOString(),
        minsToPeak:       0,
        maxAdverseMove:   0,
        _thesisFulfilled: false,
        _thesisFailure:   false,
        _churnReEntry:    position._churnReEntry || false,
        contractsAtClose: contracts,
        closeDate:        null,
        closeDateET:      null,
        exitPrice:        null,
        exitReason:       null,
        exitRSI:          null,
        exitVIX:          null,
        exitScore:        null,
        actualFillProceeds: null,
        pnl_apex:         null,
        pnl_alpaca:       null,
        pnl_pct:          null,
        hoursHeld:        null,
        isWin:            null,
        status:           'OPEN',
      };
      writeJournalEntry(_journalEntry).catch(e =>
        logEvent('warn', `[JOURNAL] Entry write failed for ${pending.ticker}: ${e.message}`)
      );

      await syncCashFromAlpaca();
      await saveStateNow();
    } else if (['canceled','expired','rejected'].includes(fillResp.status)) {
      logEvent('warn', `[NAKED] Order ${pending.orderId} ${fillResp.status} — no position opened`);
      state._pendingOrder = null;
      markDirty();
    } else if (age > 30) {
      logEvent('warn', `[NAKED] Order ${pending.orderId} unfilled after ${age.toFixed(0)}s — cancelling`);
      await alpacaDelete(`/orders/${pending.orderId}`).catch(() => {});
      state._pendingOrder = null;
      markDirty();
    }
  } catch(e) {
    logEvent('error', `[NAKED] confirmPendingOrder error: ${e.message}`);
  }
}


module.exports = {
  closePosition, partialClose, closeNContracts, confirmPendingOrder,
  syncCashFromAlpaca, initCloseEngine,
};
