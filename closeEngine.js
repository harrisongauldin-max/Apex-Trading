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
const WEEKLY_DD_LIMIT = 0.25;
const FAST_PROFIT_PCT = 0.65;

const { alpacaGet, alpacaPost, alpacaDelete } = require('./broker');
const { state, logEvent, markDirty, saveStateNow } = require('./state');
const { calcCreditSpreadTP, realizedPnL ,
  openRisk, totalCap
}     = require('./signals');
const { STOP_LOSS_PCT, TAKE_PROFIT_PCT, PDT_PROFIT_EXIT,
        PDT_STOP_LOSS, FAST_STOP_PCT, MONTHLY_BUDGET,
  ALPACA_KEY, BONUS_AMOUNT, MS_PER_DAY, PDT_LIMIT, PDT_RULE_ACTIVE, REVENUE_THRESHOLD, WATCHLIST,
  TRAIL_ACTIVATE_PCT
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
    state.alpacaOptBP     = alpacaOptBP; // options-specific buying power — gates new option entries
    // Store full portfolio value (cash + open position market value) for profit lock
    const alpacaEquity    = parseFloat(acct.equity || acct.portfolio_value || alpacaCash);
    if (alpacaEquity > 0) state.alpacaEquity = alpacaEquity;

    // Alpaca tracks day trades authoritatively — use their count as source of truth
    // acct.daytrade_count = rolling 5-day day trade count (resets as old trades age out)
    // acct.pattern_day_trader = true if account has been flagged as PDT
    if (acct.daytrade_count !== undefined) {
      const alpacaDTCount = parseInt(acct.daytrade_count, 10);
      if (!isNaN(alpacaDTCount)) {
        const dtLeft = Math.max(0, PDT_LIMIT - alpacaDTCount);
        if (alpacaDTCount !== (state._alpacaDayTradeCount || 0)) {
          logEvent("scan", `[PDT] Alpaca count: ${alpacaDTCount}/3 — ${dtLeft} day trade${dtLeft===1?'':'s'} remaining (rolling 5-day window)`);
        }
        state._alpacaDayTradeCount = alpacaDTCount;
        state._alpacaDayTradesLeft = dtLeft;
      }
    }
    if (acct.pattern_day_trader !== undefined) {
      state._patternDayTrader = acct.pattern_day_trader;
    }
    // Set accountBaseline on first sync if not already established
    if (!state.accountBaseline) state.accountBaseline = alpacaCash;
    const hasCustomBudget = state.customBudget && state.customBudget > 0 && state.customBudget !== MONTHLY_BUDGET;
    // Alpaca is the single source of truth for cash.
    // Always sync state.cash to Alpaca's actual value — no exceptions.
    // Previous "custom budget protection" was preventing correct sync on account resets.
    const drift = Math.abs(alpacaCash - state.cash);
    if (drift > 1.00) {
      if (drift > 500) {
        // Large drift — reset all baselines to Alpaca's actual values
        logEvent("scan", `[CASH SYNC] Drift $${drift.toFixed(2)} — syncing all baselines to Alpaca: $${alpacaCash.toFixed(2)}`);
        state.dayStartCash  = state.dayStartCash  || alpacaCash; // preserve today's start if set
        state.weekStartCash = state.weekStartCash || alpacaCash;
        state.peakCash      = Math.max(state.peakCash || 0, alpacaCash);
        state.cash          = alpacaCash;
        markDirty();
      } else {
        // Small drift — routine fill/credit/premium change
        logEvent("scan", `[CASH SYNC] Alpaca: $${alpacaCash.toFixed(2)} | APEX: $${state.cash.toFixed(2)} | drift: $${drift.toFixed(2)} — syncing`);
        state.cash = alpacaCash;
        markDirty();
      }
    }
  } catch(e) {} // silent
}

// Module-level close semaphore — prevents concurrent closes from submitting duplicate orders
// when VIX spike close-all fires simultaneously with a stop-loss from the scan loop.
// _closingInProgress tracks tickers currently in-flight; per-position _closingSubmitted
// handles within-position duplicate calls. Together they form a two-layer mutex.
const _closingInProgress = new Set();

async function closePosition(ticker, reason, exitPremium = null, contractSym = null, opts = {}) {
  // Layer 1: module-level mutex — block concurrent closes on the same ticker
  // (e.g. stop-loss + VIX spike firing simultaneously for the same instrument)
  const mutexKey = contractSym || ticker;
  if (_closingInProgress.has(mutexKey)) {
    logEvent("warn", `${ticker} close already in-flight (mutex) — skipping concurrent close (${reason})`);
    return;
  }
  _closingInProgress.add(mutexKey);
  try {
    // Layer 2: position-level guard (per-position _closingSubmitted handled below)
    return await _doClosePosition(ticker, reason, exitPremium, contractSym, opts);
  } finally {
    _closingInProgress.delete(mutexKey);
  }
}

async function _doClosePosition(ticker, reason, exitPremium = null, contractSym = null, opts = {}) {
  try {
    // If contractSym provided, find exact position - handles multiple same-ticker positions
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

    // NAKED OPTIONS: no spread close logic — single leg close handled below via sell order
    var alpacaCloseOk = _dryRunMode;
  const mult = pos.partialClosed ? 0.5 : 1.0;

  // Use real exit price in order of priority:
  // 1. Explicitly passed exitPremium
  // 2. Real-time options price from Alpaca
  // 3. Tracked currentPrice from last scan
  // 4. Estimated based on reason (last resort)
  let ep;
  if (exitPremium !== null) {
    ep = exitPremium;
  } else {
    // Try real-time price first
    // Spreads: use currentPrice (net spread value), not individual leg price
    if (pos.contractSymbol) {
      const realP = await _getOptionsPrice(pos.contractSymbol);
      if (realP) ep = realP;
    }
    // Fall back to last tracked price
    if (!ep && pos.currentPrice && pos.currentPrice > 0) {
      ep = pos.currentPrice;
    }
    // Last resort - use fixed estimates based on reason (no random - deterministic P&L)
    if (!ep) {
      const g = reason === "stop"        ? -STOP_LOSS_PCT
              : reason === "fast-stop"   ? -FAST_STOP_PCT
              : reason === "target"      ? TAKE_PROFIT_PCT
              : reason === "trail"       ? TRAIL_ACTIVATE_PCT
              : reason === "expiry-roll" ? 0.15
              : reason === "fast-profit" ? FAST_PROFIT_PCT
              : 0; // all other exits - use entry premium (breakeven)
      ep = parseFloat((pos.premium * (1 + g)).toFixed(2));
      logEvent("warn", `${pos.ticker} using estimated exit price (no real data available) | reason:${reason} | ep:$${ep}`);
    }
  }
  ep = parseFloat(ep.toFixed(2));
  const ev   = parseFloat((ep*100*pos.contracts*mult).toFixed(2));
  // Credit spreads: P&L = (premium received - cost to close) - 100 - contracts
  // Debit spreads:  P&L = (current value - premium paid) - 100 - contracts
  let pnl;
  if (pos.isCreditSpread) {
    pnl = parseFloat(((pos.premium - ep) * 100 * pos.contracts * mult).toFixed(2));
  } else {
    pnl = parseFloat((ev - pos.cost * mult).toFixed(2));
  }
  const pct  = pos.isCreditSpread
    ? ((pnl / (pos.maxProfit || (pos.premium * 100 * pos.contracts))) * 100).toFixed(1)
    : ((pnl / (pos.cost * mult)) * 100).toFixed(1);
  const nr   = state.totalRevenue + (pnl > 0 ? pnl : 0);
  const bonus= state.totalRevenue < REVENUE_THRESHOLD && nr >= REVENUE_THRESHOLD;

  // In dry run - log what would happen but don't mutate state or submit orders
  if (_dryRunMode) {
    logEvent("dryrun", `WOULD CLOSE ${ticker} | reason:${reason} | exit:$${ep} | P&L:${pnl>=0?"+":""}$${pnl.toFixed(2)} (${pct}%)`);
    pos._dryRunWouldClose = true; // flag so position loop skips further exit checks this scan
    return;
  }

  // Submit close order to Alpaca if we have a contract symbol
  // For partial closes (mult=0.5), sell half; for full closes (mult=1.0), sell all
  // But minimum 1 contract - if only 1 contract, full close regardless
  const contractsToSell = pos.contracts === 1 ? 1 : Math.max(1, Math.floor(pos.contracts * mult));
  const closeQty = contractsToSell;
  // Minimum 60 seconds hold before Alpaca close - prevents wash trade rejections
  const heldSeconds = (Date.now() - new Date(pos.openDate).getTime()) / 1000;
  const alpacaCloseAllowed = heldSeconds >= 60;
  if (!alpacaCloseAllowed) logEvent("warn", `${ticker} held only ${heldSeconds.toFixed(0)}s - skipping Alpaca close order to avoid wash trade`);
  // alpacaCloseOk declared above, near start of try block
  if (!pos.isSpread && closeQty > 0 && !_dryRunMode && alpacaCloseAllowed) {
    // Determine if this is a long or short leg
    // Long leg (bought): has buySymbol or positive qty → close with sell_to_close
    // Short leg (sold):  has sellSymbol, no buySymbol → close with buy_to_close
    const isShortLeg = !!(pos.sellSymbol && !pos.buySymbol);
    const closeSym   = pos.contractSymbol || pos.buySymbol || pos.sellSymbol;

    if (!closeSym) {
      logEvent("warn", `${ticker} cannot close - no contract symbol on position`);
    } else {
      try {
        let closeBody;
        if (isShortLeg) {
          // Short option: buy it back to close
          closeBody = {
            symbol:          closeSym,
            qty:             closeQty,
            side:            "buy",
            type:            "market",
            time_in_force:   "day",
            position_intent: "buy_to_close",
          };
        } else {
          // Long option: sell it to close
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
          // Error 40310000: account not eligible to trade uncovered option contracts.
          // This means the paper account lacks options permissions for this contract type.
          // Mark position as permissionBlocked — stop infinite retry loop and alert.
          // Manual resolution: fix paper account options permissions on Alpaca dashboard.
          if (closeResp && closeResp.code === 40310000) {
            // V2.88 FIX: Do NOT set alpacaCloseOk=true here. Previous behavior wiped the position
            // from APEX state but left it in Alpaca → reconciler reconstructed it as an orphan
            // every scan → 40310000 loop repeated indefinitely.
            // Fix: leave position in state with _permissionBlocked=true. Suppress close retries
            // by checking this flag before attempting close. Position stays visible in dashboard
            // until paper account options permissions are fixed on Alpaca.
            pos._permissionBlocked = true;
            pos._permissionBlockedAt = new Date().toISOString();
            pos._permBlockReason = "account not eligible to trade uncovered option contracts";
            logEvent("warn", `[PERM BLOCK] ${ticker} ${closeSym} PERMANENTLY BLOCKED (40310000) — position retained in state. Fix paper account options tier on Alpaca dashboard. All further close attempts suppressed.`);
            // alpacaCloseOk stays false — state NOT wiped, position visible until manually resolved
            return; // exit closePosition, don't update state, don't retry
          }
        }
      } catch(e) {
        logEvent("error", `Alpaca close order error: ${e.message}`);
      }
    }
  }

  // Only update state if Alpaca confirmed the close (or dry run)
  // Prevents ghost positions: ARGO thinks closed, Alpaca still holds → reconcile loop
  if (!alpacaCloseOk && !_dryRunMode) {
    logEvent("warn", `${ticker} state NOT updated — Alpaca close unconfirmed. Position preserved.`);
    delete pos._closingSubmitted; // allow retry on next scan
    return;
  }
  // D-FIX4: credit spreads: cash += pnl (delta only — credit already collected at entry)
  // debit spreads: cash += ev (proceeds received on sale)
  // syncCashFromAlpaca() called immediately after corrects any residual drift
  const _cashDelta = pos.isCreditSpread ? pnl : ev;
  state.cash       = parseFloat((state.cash + _cashDelta + (bonus?BONUS_AMOUNT:0)).toFixed(2));
  state.extraBudget  += bonus ? BONUS_AMOUNT : 0;
  state.totalRevenue  = nr;
  state.monthlyProfit = parseFloat((state.monthlyProfit + pnl).toFixed(2));
  const _spliceIdx = state.positions.indexOf(pos);
  if (_spliceIdx !== -1) state.positions.splice(_spliceIdx, 1);
  // PDT tracking - only when PDT_RULE_ACTIVE=true (FINRA PDT rule sunset April 2026)
  // PDT_RULE_ACTIVE=false: rule is off, Alpaca not enforcing. Do not count day trades.
  const bypassPDT = opts.bypassPDT === true;
  if (PDT_RULE_ACTIVE && isDayTrade(pos) && !bypassPDT) {
    recordDayTrade(pos, reason);
  } else if (PDT_RULE_ACTIVE && isDayTrade(pos) && bypassPDT) {
    logEvent("scan", `[PDT] Emergency exit (${reason}) - day trade NOT counted (bypassPDT)`);
  }
  // - Trade Outcome Tracker - full data for post-30 analysis -
  // Derive tradeType from position structure - isSpread may be false if state was corrupted
  const hasSpreadStructure = !!(pos.buySymbol && pos.sellSymbol && pos.buyStrike && pos.sellStrike);
  const tradeOutcome = {
    // Identity
    ticker, tradeType: pos.isCreditSpread ? "credit_spread" : (pos.isSpread || hasSpreadStructure) ? "debit_spread" : "naked",
    optionType: pos.optionType,
    // Outcome
    pnl, pct, reason, date: new Date().toLocaleDateString(), closeTime: Date.now(),
    won: pnl > 0,
    // Entry conditions - for validating score/regime predictive power
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
    // Timing
    daysHeld:    Math.round((Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY),
    maxAdverseExcursion: pos.maxAdverseExcursion || 0, // Chan: worst drawdown before close
    dteAtEntry:  pos.expDays || 0,
    dteAtExit:   Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY)),
    // Spread specifics
    spreadWidth:  pos.spreadWidth || 0,
    buyStrike:    pos.buyStrike || pos.strike || 0,
    sellStrike:   pos.sellStrike || 0,
    maxProfit:    pos.maxProfit || 0,
    maxLoss:      pos.maxLoss || pos.premium || 0,
    pctOfMaxProfit: pos.maxProfit > 0 ? parseFloat(((pnl / (pos.maxProfit * 100 * (pos.contracts||1))) * 100).toFixed(1)) : 0,
    // Regime context
    regime:        (state._agentMacro || {}).regime || (state._dayPlan || {}).regime || "unknown",
    regimeConf:    (state._agentMacro || {}).confidence || 0,
    agentSignal:   (state._agentMacro || {}).signal || "neutral",
  };
  state.closedTrades.push(tradeOutcome);
  // FIX 10: Track daily realized P&L for circuit breaker
  if (typeof tradeOutcome.pnl === 'number') {
    state.todayRealizedPnL = (state.todayRealizedPnL || 0) + tradeOutcome.pnl;
  }

  // - Score bracket win rate - updated on every close -
  if (!state.scoreBrackets) state.scoreBrackets = {};
  const entryScore = pos.score || 0; // extract here - not in scope from tradeOutcome object
  const bracket = entryScore >= 90 ? "90-100" : entryScore >= 80 ? "80-89" : entryScore >= 70 ? "70-79" : "below-70";
  if (!state.scoreBrackets[bracket]) state.scoreBrackets[bracket] = { trades:0, wins:0, totalPnl:0 };
  state.scoreBrackets[bracket].trades++;
  if (pnl > 0) state.scoreBrackets[bracket].wins++;
  state.scoreBrackets[bracket].totalPnl = parseFloat((state.scoreBrackets[bracket].totalPnl + pnl).toFixed(2));
  state.scoreBrackets[bracket].winRate  = parseFloat(((state.scoreBrackets[bracket].wins / state.scoreBrackets[bracket].trades) * 100).toFixed(1));

  // BF-W4: Spiral detection - track consecutive losses by option type
  // A put spiral (5+ consecutive put losses) = system keeps entering the same losing trade
  if (!state._spiralTracker) state._spiralTracker = { put: 0, call: 0 };
  const posType = pos.optionType || "unknown";
  if (pnl <= 0) {
    state._spiralTracker[posType] = (state._spiralTracker[posType] || 0) + 1;
    const consecLosses = state._spiralTracker[posType];
    // Bug-spiral FIX: spiral requires 20+ total trades to be meaningful.
    // During paper trading validation, 5 consecutive losses in a new system is noise.
    // March 25th: 9 puts closed via macro-reversal → spiral active → all puts blocked.
    // At <20 trades, log the warning but do not activate the block.
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
    // Win resets that type's spiral counter
    state._spiralTracker[posType] = 0;
    if (state._spiralActive === posType) {
      state._spiralActive = null;
      logEvent("scan", `[SPIRAL] ${posType} spiral broken - consecutive wins reset`);
    }
  }

  // Cap closedTrades at 200
  if (state.closedTrades.length > 200) state.closedTrades = state.closedTrades.slice(0, 200);

  // - Exit performance tracking -
  if (!state.exitStats) state.exitStats = {};
  if (!state.exitStats[reason]) state.exitStats[reason] = { count:0, wins:0, totalPnl:0, avgPnl:0, winRate:0 };
  const es = state.exitStats[reason];
  es.count++;
  if (pnl > 0) es.wins++;
  es.totalPnl  = parseFloat((es.totalPnl + pnl).toFixed(2));
  es.avgPnl    = parseFloat((es.totalPnl / es.count).toFixed(2));
  es.winRate   = parseFloat(((es.wins / es.count) * 100).toFixed(1));
  logEvent("scan", `Exit stats [${reason}]: ${es.count} trades | win ${es.winRate}% | avg P&L $${es.avgPnl}`);
  await saveStateNow(); // force immediate save on trade close

  // Update consecutive losses
  if (pnl < 0) state.consecutiveLosses++;
  else state.consecutiveLosses = 0;

  // Record recent losses for re-entry veto (24hr agent confirmation required)
  if (pnl < 0) {
    state._recentLosses = state._recentLosses || {};
    // Fix 3 SUPPORT: stamp entryRSI so scanner can check RSI delta on re-entry attempt
    const _lossPos = state.positions.find(p => p.ticker === ticker) || {};
    state._recentLosses[ticker] = {
      closedAt:    Date.now(),
      reason,
      agentSignal: (state._agentMacro || {}).signal || "neutral",
      price:       ep,
      pnlPct:      parseFloat(pct),
      entryRSI:    _lossPos.entryRSI || _lossPos.rsi || 50,
      optionType:  _lossPos.optionType || null,
    };
    logEvent("warn", `[THESIS] ${ticker} loss recorded - re-entry requires agent confirmation for 24h`);
  }

  // Record all closes (wins AND losses) for same-day cooldown gate.
  // After any close, block same-instrument re-entry for 30 minutes.
  // Prevents: win at 9:23am → re-enter at 9:27am same direction at worse strike.
  state._recentCloses = state._recentCloses || {};
  const _closingPos = state.positions.find(p => p.ticker === ticker) || {};
  state._recentCloses[ticker] = {
    closedAt:   Date.now(),
    optionType: _closingPos.optionType || null,
    pnl,
    reason,
  };

  // Peak cash tracking for drawdown
  const fullPortfolioValue = state.cash + openRisk() ;
  if (fullPortfolioValue > state.peakCash) state.peakCash = fullPortfolioValue;

  // Circuit breaker checks -- use total portfolio value (cash + open positions)
  const portfolioValue = state.cash + openRisk() ;
  const dailyPnL  = portfolioValue - state.dayStartCash;
  const weeklyPnL = portfolioValue - state.weekStartCash;

  // Daily max loss - 25% of TOTAL capital (not just deployed)
  // Using deployed capital caused false triggers when few positions were open
  if (dailyPnL / totalCap() <= -0.25 && state.circuitOpen) {
    state.circuitOpen = false;
    logEvent("circuit", `DAILY MAX LOSS circuit - lost ${_fmt(Math.abs(dailyPnL))} (${(dailyPnL/totalCap()*100).toFixed(1)}% of total capital)`);
  }
  // Weekly circuit - 25% of total capital using weeklyPnL
  if (weeklyPnL / totalCap() <= -WEEKLY_DD_LIMIT && state.weeklyCircuitOpen) {
    state.weeklyCircuitOpen = false;
    logEvent("circuit", `WEEKLY circuit breaker - loss ${_fmt(Math.abs(weeklyPnL))} (${(WEEKLY_DD_LIMIT*100)}% limit)`);
  }

  // Bonus notification
  if (bonus) logEvent("bonus", `REVENUE HIT $${REVENUE_THRESHOLD} - +$${BONUS_AMOUNT} bonus added!`);

  // Journal entry
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

  logEvent("close",
    `${reason.toUpperCase()} ${ticker} | exit $${ep} | P&L ${pnl>=0?"+":""}${_fmt(pnl)} (${pct}%) | ` +
    `cash ${_fmt(state.cash)}`
  );
  await syncCashFromAlpaca(); // sync cash from Alpaca after close
  markDirty(); // caller saves - prevents N Redis writes when multiple positions close together
  return true;
  } catch(e) {
    logEvent("error", `closePosition crashed for ${ticker} (${reason}): ${e.message}`);
    // Force remove from positions on error - don't leave stuck positions
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

  // 1-contract positions can't be split - full close
  if ((pos.contracts || 1) === 1) {
    logEvent("partial", `${ticker} 1-contract - escalating to full close`);
    await closePosition(ticker, "target");
    return;
  }

  // Spreads: partial close = close half contracts via separate mleg orders
  // This is valid - close half the spread position, leave half open
  if (pos.isSpread && pos.contracts >= 2) {
    const half = Math.floor(pos.contracts / 2);
    logEvent("partial", `${ticker} spread partial close - closing ${half}/${pos.contracts} contracts`);
    if (!_dryRunMode && pos.buySymbol && pos.sellSymbol) {
      try {
        // Close half via mleg - both legs simultaneously
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
    // Update state - reduce contracts, mark partial
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
  // Use real options price if available, otherwise use current tracked price
  let ep = pos.currentPrice || pos.premium * 1.5;
  if (pos.contractSymbol) {
    const realP = await _getOptionsPrice(pos.contractSymbol);
    if (realP) ep = realP;
  }
  ep = parseFloat(ep.toFixed(2));
  const half = Math.max(1, Math.floor(pos.contracts / 2));

  // Submit partial close order to Alpaca
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
      } else {
        logEvent("warn", `Alpaca partial close failed for ${pos.contractSymbol}: ${JSON.stringify(partialResp)?.slice(0,100)}`);
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
    ticker, pnl, pct: ((pnl/(pos.cost*0.5))*100).toFixed(1),
    date: new Date().toLocaleDateString(), reason: "partial",
    tradeType:  pos.isCreditSpread ? "credit_spread" : (pos.isSpread || (pos.buySymbol && pos.sellSymbol)) ? "debit_spread" : "naked",
    optionType: pos.optionType,
    closeTime:  Date.now(),
  });
  logEvent("partial", `PARTIAL ${ticker} - ${half}/${pos.contracts} @ $${ep} | +${_fmt(pnl)} | cash ${_fmt(state.cash)}`);
  await saveStateNow();
}

async function confirmPendingOrder() {
  // NAKED OPTIONS: confirm single-leg long option fill
  const pending = state._pendingOrder;
  if (!pending) return;

  // Skip if pre-submit placeholder not yet sent to Alpaca
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
        entryIV:       pending.iv || null, // FIX 4: store entry IV for collapse detection
        partialClosed: false,
        target:        parseFloat((fillPrice * (1 + TAKE_PROFIT_PCT)).toFixed(2)),
        stop:          parseFloat((fillPrice * (1 - STOP_LOSS_PCT)).toFixed(2)),
        breakeven:     pending.optionType === 'put'
          ? parseFloat((pending.strike - fillPrice).toFixed(2))
          : parseFloat((pending.strike + fillPrice).toFixed(2)),
      };

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

      await syncCashFromAlpaca();
      await saveStateNow();
    } else if (['canceled','expired','rejected'].includes(fillResp.status)) {
      logEvent('warn', `[NAKED] Order ${pending.orderId} ${fillResp.status} — no position opened`);
      state._pendingOrder = null;
      markDirty();
    } else if (age > 30) {
      // Unfilled after 30s — cancel
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
  closePosition, partialClose, confirmPendingOrder, syncCashFromAlpaca,
  initCloseEngine,

};
