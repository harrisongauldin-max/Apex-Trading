// server.js — APEX
// Express API shell, schedulers, and boot sequence (~600 lines).
'use strict';

const express = require('express');
const cron    = require('node-cron');
const path    = require('path');
const fs      = require('fs');

const { state, markDirty, saveStateNow, flushStateIfDirty,
        logEvent, redisSave, redisLoad, defaultState,
        saveDailyLogToRedis, getETDateStr, restoreBuffersFromRedis, parseRedisBlob,
        writeJournalEntry, updateJournalExit,
        loadJournalDay, saveJournalDay, getJournalRange }              = require('./state');
const { alpacaGet, alpacaPost, alpacaDelete,
        getCircuitState, setBrokerLogger,
        getStockQuote, getStockBars, getIntradayBars,
        alpacaHeaders, withTimeout }                      = require('./broker');
const { openRisk, openCostBasis, heatPct, realizedPnL,
        totalCap, stockValue, effectiveHeatCap, getAccountPhase,
        getETTime, isMarketHours, isEntryWindow, calcCreditSpreadTP,
        calcBetaWeightedDelta, calcDrawdownDuration,
        calcRiskOfRuin, calcSharpeRatio, calcVaR,
        setSignalsLogger, calcMAE }                       = require('./signals');
const { runScan, getScannerState, setDryRunMode,
        forceResetScanLock }                              = require('./scanner');
const { runReconciliation, syncPositionPnLFromAlpaca,
        initReconciler }                                  = require('./reconciler');
const { closePosition, syncCashFromAlpaca }               = require('./closeEngine');

async function getAlpacaTruth() {
  try {
    const todayET    = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York',
      year:'numeric', month:'2-digit', day:'2-digit'}).split('/');
    const todayStr   = `${todayET[2]}-${todayET[0]}-${todayET[1]}`;

    const [acct, positions, activities] = await Promise.all([
      alpacaGet("/account"),
      alpacaGet("/positions"),
      alpacaGet(`/account/activities?activity_type=FILL&date=${todayStr}&direction=desc&page_size=100`),
    ]);
    if (!acct) return null;

    const currentCash   = parseFloat(acct.cash || 0);
    const currentEquity = parseFloat(acct.equity || acct.portfolio_value || currentCash);
    const dayOpenEquity = parseFloat(acct.last_equity || acct.last_portfolio_value || currentEquity);
    const equityDelta   = parseFloat((currentEquity - dayOpenEquity).toFixed(2));
    const unrealizedPnL = Array.isArray(positions)
      ? positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl || 0), 0)
      : 0;
    const realizedPnL = parseFloat((equityDelta - unrealizedPnL).toFixed(2));
    const totalPnL    = equityDelta;

    const openPositions = Array.isArray(positions) ? positions.map(p => ({
      symbol:        p.symbol,
      qty:           parseInt(p.qty || 0),
      side:          p.side,
      marketValue:   parseFloat(p.market_value || 0),
      avgEntry:      parseFloat(p.avg_entry_price || 0),
      costBasis:     parseFloat(p.cost_basis || 0),
      unrealizedPnL: parseFloat(p.unrealized_pl || 0),
      unrealizedPct: parseFloat(p.unrealized_plpc || 0) * 100,
      todayPnL:      parseFloat(p.unrealized_intraday_pl || 0),
      todayPct:      parseFloat(p.unrealized_intraday_plpc || 0) * 100,
    })) : [];

    logEvent("scan",
      `[ALPACA TRUTH] realized:$${realizedPnL.toFixed(0)} ` +
      `unrealized:$${unrealizedPnL.toFixed(0)} ` +
      `total:$${totalPnL.toFixed(0)} ` +
      `| lastEquity:$${dayOpenEquity.toFixed(0)} currentEquity:$${currentEquity.toFixed(0)}`
    );

    return {
      currentCash,
      currentEquity,
      dayOpenEquity,
      realizedPnL,
      unrealizedPnL:   parseFloat(unrealizedPnL.toFixed(2)),
      totalPnL,
      openPositions,
      fillCount:       Array.isArray(activities) ? activities.length : 0,
    };
  } catch(e) {
    logEvent("warn", `[ALPACA TRUTH] Failed to fetch: ${e.message}`);
    return null;
  }
}

const { runBacktest }                                     = require('./backtest');
const { sendEmail, sendMorningBriefing, sendResendEmail,
        initReporting, setReportingContext,
        buildMonthlyReport, premarketAssessment,
        updateAfterHoursContext, buildJournalBreakdown }  = require('./reporting');
const { getAgentMacroAnalysis, initAgent,
        getAgentRescore, getAgentDayPlan, getAgentOvernightScan,
        getAgentPostMarketAssessment, getAgentPreEntryCheck } = require('./agent');
const { getRegimeRulebook, INSTRUMENT_CONSTRAINTS }       = require('./entryEngine');
const { executeCreditSpread }                             = require('./execution');
const { getTimeAdjustedStop, getTimeOfDayAnalysis }       = require('./exitEngine');
const { getMacroNews, getUpcomingMacroEvents }            = require('./market');
const { getDrawdownProtocol, getPnLByTicker,
        getPnLBySector, getPnLByScoreRange, getTaxLog,
        getStreakAnalysis, countRecentDayTrades, isDayTrade,
        calcThesisIntegrity }                             = require('./risk');
const { calcRSI }                                         = require('./signals');

const {
  ALPACA_KEY, ALPACA_SECRET, ALPACA_BASE, ALPACA_DATA, ALPACA_OPTIONS,
  ALPACA_OPT_SNAP, MONTHLY_BUDGET, CAPITAL_FLOOR, IS_PAPER_ACCOUNT,
  REDIS_URL, REDIS_TOKEN, REDIS_KEY, REDIS_SAVE_INTERVAL,
  ANTHROPIC_API_KEY, RESEND_API_KEY, GMAIL_USER, MARKETAUX_KEY,
  WATCHLIST, PDT_RULE_ACTIVE, PDT_LIMIT, MAX_HEAT, STOP_LOSS_PCT,
  TAKE_PROFIT_PCT, FAST_STOP_HOURS, MS_PER_DAY, SCAN_INTERVAL,
  TRIGGER_COOLDOWN_MS, SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL,
  MACRO_REVERSAL_PCT, SCAN_WATCHDOG_MS: _SCAN_WATCHDOG_MS,
  INDIVIDUAL_STOCKS_ENABLED, INDIVIDUAL_STOCK_WATCHLIST, STATE_FILE,
  VIX_DAILY_SEED,
} = require('./constants');

const app  = express();
const PORT = process.env.PORT || 3000;
let isShuttingDown = false;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

setBrokerLogger((type, msg) => logEvent(type, msg), null);

const ARGO_SECRET = process.env.ARGO_SECRET || "";
function requireSecret(req, res, next) {
  if (!ARGO_SECRET) {
    logEvent("warn", "[AUTH] ARGO_SECRET not set -- destructive endpoints unprotected");
    return next();
  }
  const provided = req.headers["x-argo-secret"] || req.body?.secret || "";
  if (provided !== ARGO_SECRET) {
    logEvent("warn", `[AUTH] Unauthorized request to ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function initState() {
  const saved = await redisLoad();
  if (saved) {
    const isValid = (
      typeof saved.cash === 'number' && saved.cash >= 0 &&
      Array.isArray(saved.positions) &&
      Array.isArray(saved.closedTrades)
    );

    if (!isValid) {
      console.error("[STATE] CRITICAL: Loaded state failed validation - fields missing or corrupt");
      console.error("[STATE] Raw loaded cash:", saved.cash, "| positions type:", typeof saved.positions);
      console.error("[STATE] Starting fresh - check Redis data integrity");
    } else {
      const hasTradeHistory = saved.closedTrades && saved.closedTrades.length > 0;
      const cashMatchesDefault = Math.abs(saved.cash - MONTHLY_BUDGET) < 1;
      const noPositions = !saved.positions || saved.positions.length === 0;
      if (hasTradeHistory && cashMatchesDefault && noPositions) {
        console.warn("[STATE] WARNING: State has trade history but cash reset to default - possible accidental reset");
        console.warn("[STATE] Cash: $" + saved.cash + " | Trades: " + saved.closedTrades.length + " | Positions: 0");
        console.warn("[STATE] Loading anyway - verify dashboard looks correct");
      }

      Object.assign(state, defaultState(), saved);
      console.log("[STATE] Loaded | cash: $" + state.cash + " | positions: " + state.positions.length + " | trades: " + (state.closedTrades||[]).length);
    }
  } else {
    console.log("[STATE] No saved state found - starting fresh with $" + MONTHLY_BUDGET);
  }

  if (state.customBudget && state.customBudget > 0 && state.customBudget !== MONTHLY_BUDGET) {
    const isFreshState = (state.closedTrades || []).length === 0 && (state.positions || []).length === 0;
    if (isFreshState) {
      state.cash = state.customBudget;
      console.log("[STATE] Fresh account - setting cash to custom budget: $" + state.customBudget);
    } else {
      console.log("[STATE] Custom budget: $" + state.customBudget + " | Current cash: $" + state.cash + " (preserved from Redis)");
    }
  }

  if (state.positions) {
    const creditSpreads = state.positions.filter(p => p.isCreditSpread);
    const seen = new Map();
    const toRemove = new Set();
    for (let i = 0; i < creditSpreads.length; i++) {
      const pos = creditSpreads[i];
      const key = `${pos.ticker}|${pos.optionType}|${pos.buyStrike}|${pos.sellStrike}|${pos.expDate}`;
      if (seen.has(key)) {
        const first = seen.get(key);
        first.contracts = (first.contracts || 1) + (pos.contracts || 1);
        first.cost      = parseFloat(((first.cost || 0) + (pos.cost || 0)).toFixed(2));
        toRemove.add(state.positions.indexOf(pos));
        console.log(`[STARTUP] Merging duplicate credit spread: ${pos.ticker} $${pos.sellStrike}/$${pos.buyStrike} into ${first.contracts}x`);
      } else {
        seen.set(key, pos);
      }
    }
    if (toRemove.size > 0) {
      state.positions = state.positions.filter((_, i) => !toRemove.has(i));
      console.log(`[STARTUP] Removed ${toRemove.size} duplicate credit spread position(s)`);
    }
  }

  if (state.positions) {
    for (const pos of state.positions) {
      if (pos.isCreditSpread && pos.premium && pos.buyStrike && pos.sellStrike) {
        const width = Math.abs(pos.buyStrike - pos.sellStrike);
        const contracts = pos.contracts || 1;
        const correctMaxProfit = parseFloat((pos.premium * 100 * contracts).toFixed(2));
        const correctMaxLoss   = parseFloat(((width - pos.premium) * 100 * contracts).toFixed(2));
        if (Math.abs(pos.maxProfit - correctMaxProfit) > 10) {
          console.log(`[STARTUP] Fixing maxProfit for ${pos.ticker} credit spread: ${pos.maxProfit} - ${correctMaxProfit}`);
          pos.maxProfit = correctMaxProfit;
          pos.maxLoss   = correctMaxLoss;
        }
      }
      if (pos.isSpread && !pos.isCreditSpread && pos.premium && pos.buyStrike && pos.sellStrike) {
        const width = Math.abs(pos.buyStrike - pos.sellStrike);
        const contracts = pos.contracts || 1;
        const correctMaxProfit = parseFloat(((width - pos.premium) * 100 * contracts).toFixed(2));
        const correctMaxLoss   = parseFloat((pos.premium * 100 * contracts).toFixed(2));
        if (pos.maxProfit && Math.abs(pos.maxProfit - correctMaxProfit) > 10) {
          pos.maxProfit = correctMaxProfit;
          pos.maxLoss   = correctMaxLoss;
        }
      }
    }
  }

  if (state.positions) {
    for (const pos of state.positions) {
      if (pos.isCreditSpread && pos.currentPrice && pos.premium) {
        const width = Math.abs((pos.buyStrike||0) - (pos.sellStrike||0));
        if (pos.currentPrice > width) {
          console.log(`[STARTUP] Resetting stale currentPrice for ${pos.ticker} credit spread: $${pos.currentPrice} - $${pos.premium}`);
          pos.currentPrice = pos.premium;
          pos.peakPremium  = pos.premium;
        }
      }
    }
  }

  if (state._agentMacro?.signal) {
    const modeMap = {
      "strongly bearish": "defensive", "bearish": "cautious", "mild bearish": "cautious",
      "neutral": "normal", "mild bullish": "normal", "bullish": "normal", "strongly bullish": "aggressive",
    };
    const correctedMode = modeMap[state._agentMacro.signal] || "normal";
    if (state._agentMacro.mode !== correctedMode) {
      console.log(`[STARTUP] Correcting stale agentMacro mode: ${state._agentMacro.mode} - ${correctedMode} (signal: ${state._agentMacro.signal})`);
      state._agentMacro.mode = correctedMode;
    }
  }

  if (ALPACA_KEY) {
    try {
      const openOrders = await alpacaGet("/orders?status=open&limit=50");
      if (Array.isArray(openOrders) && openOrders.length > 0) {
        console.log(`[STARTUP] Cancelling ${openOrders.length} open order(s) from previous session`);
        for (const ord of openOrders) {
          await alpacaPost(`/orders/${ord.id}/cancel`, {}).catch(() => {});
          console.log(`[STARTUP] Cancelled order ${ord.id} (${ord.symbol || 'mleg'} ${ord.status})`);
        }
      }
    } catch(e) { console.log("[STARTUP] Could not cancel open orders:", e.message); }

    try {
      const startupActiveTickers = new Set([
        ...WATCHLIST.map(w => w.ticker),
        ...(INDIVIDUAL_STOCKS_ENABLED ? INDIVIDUAL_STOCK_WATCHLIST.map(w => w.ticker) : []),
      ]);
      const allAlpacaPos = await alpacaGet("/positions");
      if (Array.isArray(allAlpacaPos)) {
        for (const alpPos of allAlpacaPos) {
          if (!/^[A-Z]+\d{6}[CP]\d{8}$/.test(alpPos.symbol)) continue;
          const underlyingTicker = alpPos.symbol.match(/^([A-Z]+)\d{6}[CP]/)?.[1];
          if (underlyingTicker && !startupActiveTickers.has(underlyingTicker)) {
            console.log(`[STARTUP] Closing stale position for removed ticker ${underlyingTicker} (${alpPos.symbol})`);
            const qty    = Math.abs(parseInt(alpPos.qty || 1));
            const side   = parseInt(alpPos.qty) > 0 ? "sell" : "buy";
            const intent = parseInt(alpPos.qty) > 0 ? "sell_to_close" : "buy_to_close";
            await alpacaPost("/orders", { symbol: alpPos.symbol, qty, side, type: "market",
              time_in_force: "day", position_intent: intent,
            }).catch(e => console.log(`[STARTUP] Could not close ${alpPos.symbol}: ${e.message}`));
          }
        }
      }
    } catch(e) { console.log("[STARTUP] Could not clean stale positions:", e.message); }
  }
  state._pendingOrder = null;

  // ── IV-Rank baseline seed (real CBOE VIX) ────────────────────────────────────
  // Seed _vixDaily from the embedded real one-year VIX window so IV Rank is correct from the
  // first boot. The scanner refreshes it daily from CBOE (getVIXDailyCloses) and ranks the
  // latest real close against it. This is REAL VIX, deliberately separate from getVIX() (the
  // VIXY share price used by the risk gates) — IVR must rank real-vs-real to be units-correct.
  // Replaces the old VIXY/0.85 seed + `range<15` re-seed loop, which manufactured a phantom
  // high-VIX baseline (P5~28) and perpetually re-injected it on every restart.
  // Reseed if missing/short OR holding legacy VIXY-price data (median > 40 ⇒ VIXY units, not real
  // VIX). A length-only check let the persisted 261-elem VIXY array survive and mask the ranking.
  let _bootVixStale = !Array.isArray(state._vixDaily) || state._vixDaily.length < 60;
  if (!_bootVixStale) {
    const _m = [...state._vixDaily].sort((a, b) => a - b)[Math.floor(state._vixDaily.length / 2)];
    _bootVixStale = !(_m > 0) || _m > 40;
  }
  if (_bootVixStale) {
    state._vixDaily = (VIX_DAILY_SEED || []).slice(-252);
    if (state._vixDaily.length >= 60) {
      const _ss   = [...state._vixDaily].sort((a, b) => a - b);
      const _sP5  = _ss[Math.floor(_ss.length * 0.05)] || _ss[0];
      const _sP95 = _ss[Math.floor(_ss.length * 0.95)] || _ss[_ss.length - 1];
      const _cur  = state._vixDaily[state._vixDaily.length - 1];
      const _cl   = Math.min(Math.max(_cur, _sP5), _sP95);
      state._ivRank = _sP95 > _sP5 ? parseFloat(((_cl - _sP5) / (_sP95 - _sP5) * 100).toFixed(1)) : 50;
      state._ivEnv  = state._ivRank >= 70 ? "high" : state._ivRank >= 50 ? "elevated" : state._ivRank >= 30 ? "normal" : "low";
      console.log(`[IVR SEED] Seeded _vixDaily with ${state._vixDaily.length} real CBOE closes | P5-P95:[${_sP5.toFixed(1)}-${_sP95.toFixed(1)}] | realVIX ${_cur} -> IVR ${state._ivRank} (${state._ivEnv})`);
      markDirty();
    } else {
      console.log("[IVR SEED] VIX_DAILY_SEED missing/short — IVR will hold until the daily CBOE refresh populates _vixDaily");
    }
  }

  await runReconciliation();
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} received - saving state before exit`);
  let saved = false;
  for (let i = 1; i <= 3; i++) {
    try {
      await redisSave(state);
      saved = true;
      console.log(`[SHUTDOWN] State saved to Redis (attempt ${i}) | cash: $${state.cash} | positions: ${state.positions.length}`);
      break;
    } catch(e) {
      console.error(`[SHUTDOWN] Redis save attempt ${i} failed: ${e.message}`);
      if (i < 3) await new Promise(r => setTimeout(r, 1000));
    }
  }
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log("[SHUTDOWN] State saved to local file backup");
  } catch(e) {
    console.error("[SHUTDOWN] Local file save failed:", e.message);
  }
  if (!saved) {
    console.error("[SHUTDOWN] CRITICAL: Could not save state to Redis - positions may be lost on restart");
  }
  console.log("[SHUTDOWN] Complete - exiting");
  process.exit(0);
}

setInterval(() => {
  const day = getETTime().getDay();
  if (day >= 1 && day <= 5) runScan();
}, 10000);

setInterval(async () => {
  const et  = getETTime();
  const day = et.getDay();
  const h   = et.getHours();
  const m   = et.getMinutes();
  if (day < 1 || day > 5) return;
  if (h < 9 || h > 16) return;
  if (h === 9 && m < 30) return;
  try {
    const truth = await getAlpacaTruth();
    if (truth) {
      state._alpacaTruth = truth;
      if (truth.openPositions && truth.openPositions.length > 0) {
        const alpacaBySymbol = {};
        truth.openPositions.forEach(ap => { alpacaBySymbol[ap.symbol] = ap; });
        let priceUpdates = 0;
        for (const pos of (state.positions || [])) {
          const sym = pos.contractSymbol || pos.buySymbol;
          const ap  = alpacaBySymbol[sym];
          if (!ap) continue;
          const mktVal  = parseFloat(ap.marketValue || 0);
          const qty     = parseInt(ap.qty || pos.contracts || 1);
          if (mktVal > 0 && qty > 0) {
            const alpacaPrice = parseFloat((mktVal / (qty * 100)).toFixed(2));
            if (alpacaPrice > 0 && alpacaPrice !== pos.currentPrice) {
              pos.currentPrice = alpacaPrice;
              pos._currentPriceUpdatedAt = Date.now();
              if (alpacaPrice > (pos.peakPremium || 0)) pos.peakPremium = alpacaPrice;
              if (qty !== pos.contracts) pos.contracts = qty;
              priceUpdates++;
            }
          }
        }
        if (priceUpdates > 0) {
          logEvent("scan", `[ALPACA TRUTH] Updated ${priceUpdates} position price(s) from Alpaca`);
        }
      }
      logEvent("scan",
        `[ALPACA TRUTH] realized:$${truth.realizedPnL.toFixed(0)} ` +
        `unrealized:$${truth.unrealizedPnL.toFixed(0)} ` +
        `total:$${truth.totalPnL.toFixed(0)} | ` +
        `cash:$${truth.currentCash.toFixed(0)} ` +
        `positions:${truth.openPositions.length}`
      );
    }
  } catch(e) {
    logEvent("warn", `[ALPACA TRUTH] refresh error: ${e.message}`);
  }
}, 5 * 60 * 1000);

setInterval(() => {
  const day = getETTime().getDay();
  if (day >= 1 && day <= 5) updateAfterHoursContext();
}, 15 * 60 * 1000);

setInterval(() => {
  flushStateIfDirty().catch(e => console.error("Flush interval error:", e.message));
}, 30000);

setInterval(async () => {
  const et  = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return;
  const etH = et.getHours() + et.getMinutes() / 60;
  if (etH < 9.5 || etH > 16.1) return;
  try { await runReconciliation(); } catch(e) { logEvent('warn', `[RECONCILE] Interval error: ${e.message}`); }
}, 3 * 60 * 1000);

const SCAN_WATCHDOG_MS = 90 * 1000;
setInterval(() => {
  const _scanState = getScannerState();
  const lastStart = _scanState.lastScanStart || 0;
  if (_scanState.scanRunning && lastStart > 0 && (Date.now() - lastStart) > SCAN_WATCHDOG_MS) {
    logEvent("warn", `[WATCHDOG] Scan stuck ${((Date.now()-lastStart)/1000).toFixed(0)}s — force-resetting lock`);
    forceResetScanLock();
  }
}, 15 * 1000);

setInterval(syncCashFromAlpaca, 5 * 60 * 1000);

let _lastAgentInterval = 0;

async function _runMacroAgent(forceRun = false) {
  try {
    const headlines = await getMacroNews(state);
    const headlineList = (headlines?.headlines || headlines?.topStories || []);
    if (!headlineList.length) return;
    const result = await getAgentMacroAnalysis(headlineList, forceRun);
    if (result) {
      const sc = getScannerState();
      sc.marketContext.macro = {
        signal:        result.signal,
        scoreModifier: result.modifier || 0,
        mode:          result.mode || 'normal',
        macroAuthority:'agent',
        confidence:    result.confidence,
        agentLastUpdated: result.timestamp || new Date().toISOString(),
        triggers:      result.catalysts || [],
      };
      state._agentMacro = {
        ...result,
        updatedAt:  new Date().toISOString(),
        timestamp:  new Date().toISOString(),
      };
      markDirty();
    }
  } catch(e) { logEvent("warn", `[AGENT] Macro interval failed: ${e.message}`); }
}

setTimeout(async () => {
  const et  = getETTime();
  const etH = et.getHours() + et.getMinutes() / 60;
  const day = et.getDay();
  if (day >= 1 && day <= 5 && etH >= 8.5 && etH <= 17.0) {
    logEvent("macro", "[AGENT] Running initial macro analysis on startup...");
    await _runMacroAgent(true);
    _lastAgentInterval = Date.now();
  }
}, 5000);

let _agentStalenessCheck = 0;
setInterval(async () => {
  const et  = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return;
  const etH = et.getHours() + et.getMinutes() / 60;
  if (etH < 8.5 || etH > 17.0) return;
  const agentAge = state._agentMacro?.fetchedAt ? Date.now() - state._agentMacro.fetchedAt : Infinity;
  if (agentAge < 90 * 60 * 1000) return;
  if (Date.now() - _agentStalenessCheck < 20 * 60 * 1000) return;
  _agentStalenessCheck = Date.now();
  logEvent("macro", `[AGENT] Signal stale ${Math.round(agentAge/60000)}min — running refresh`);
  await _runMacroAgent(true);
}, 5 * 60 * 1000);

cron.schedule("0 10,11 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 6 && et.getMinutes() === 0) {
    logEvent("macro", "[DAY PLAN] 6:00am ET deep scan starting...");
    await getAgentDayPlan("6am-deep");
  }
});

cron.schedule("30 11,12 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 7 && et.getMinutes() === 30) {
    logEvent("macro", "[DAY PLAN] 7:30am ET brief starting...");
    await getAgentDayPlan("7:30am-brief");
  }
});

cron.schedule("30 12,13 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 8 && et.getMinutes() === 30) {
    logEvent("macro", "[DAY PLAN] 8:30am ET (7:30am CT) final assessment + pre-market compute starting...");
    await getAgentDayPlan("8:30am-final");
    await new Promise(r => setTimeout(r, 3000));
    await getAgentOvernightScan("premarket-compute");
  }
});

cron.schedule("45 12,13 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 8 && et.getMinutes() === 45) {
    await premarketAssessment();
  }
});

cron.schedule("32 11,12 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 7 && et.getMinutes() === 32) {
    logEvent("scan", "[PRE-MARKET] 6:32am CT (7:32am ET) bar seeding — fetching daily bars for RSI pre-computation");
    const _primaryETFs = ["SPY","QQQ","GLD","TLT","XLE","SMH","IYR","HYG"];
    const tickers = WATCHLIST.filter(w => _primaryETFs.includes(w.ticker)).map(w => w.ticker);
    let seeded = 0;
    for (const ticker of tickers) {
      try {
        const bars = await getStockBars(ticker, 60);
        if (bars && bars.length >= 15) {
          const rsi = calcRSI(bars);
          if (rsi !== null) {
            if (!state._rsiHistory) state._rsiHistory = {};
            const todayStr = getETDateStr();
            let hist = state._rsiHistory[ticker] || [];
            if (hist.length === 0 || hist[hist.length - 1]?.date !== todayStr) {
              hist.push({ date: todayStr, rsi });
              if (hist.length > 5) hist.shift();
              state._rsiHistory[ticker] = hist;
              seeded++;
            }
          }
        }
      } catch(e) {
        logEvent("warn", `[PRE-MARKET] Bar seed failed for ${ticker}: ${e.message}`);
      }
    }
    markDirty();
    logEvent("scan", `[PRE-MARKET] Bar seeding complete — ${seeded}/${tickers.length} tickers seeded with daily RSI`);
  }
});

// 9:00am ET morning reset + briefing
cron.schedule("0 13,14 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() !== 9 || et.getMinutes() !== 0) return;
  state.dayStartCash      = state.cash;
  const eodET = getETTime();
  if (eodET.getDay() === 5) {
    state.prevWeekClose = state.cash + openCostBasis();
    logEvent("scan", `[EOD] Friday close stored: $${state.prevWeekClose.toFixed(2)} - used for weekly P&L baseline`);
  }
  if (eodET.getDay() === 1 && state.prevWeekClose) {
    state.weekStartCash = state.prevWeekClose;
    logEvent("scan", `[SOW] Week start set from Friday close: $${state.weekStartCash.toFixed(2)}`);
  }
  state.todayTrades       = 0;
  state.consecutiveLosses = 0;
  state.circuitOpen       = true;
  state.tickerBlacklist   = [];
  state._agentRescoreHour   = {};
  state._agentRescoreMinute = {};
  state._macroReversalAt    = null;
  state._macroReversalCount = 0;
  state._macroReversalSPY   = null;
  const todayStr = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York'});
  if (state._dayPlanDate && state._dayPlanDate !== todayStr) {
    state._dayPlan     = null;
    state._dayPlanDate = null;
    logEvent("scan", "[DAY PLAN] Cleared stale day plan from previous session");
  }
  if (state._oversoldCount) {
    const watchTickers = new Set(WATCHLIST.map(s => s.ticker));
    Object.keys(state._oversoldCount).forEach(t => { if (!watchTickers.has(t)) delete state._oversoldCount[t]; });
  }
  if (state.portfolioSnapshots && state.portfolioSnapshots.length > 2500) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    state.portfolioSnapshots = state.portfolioSnapshots.filter(s => new Date(s.t).getTime() > cutoff);
  }
  await saveStateNow();
  if (state.positions && state.positions.length > 0) {
    logEvent("scan", `[MORNING REVIEW] Reviewing ${state.positions.length} overnight position(s) before open...`);
    for (const pos of state.positions) {
      try {
        const rescore = await getAgentRescore(pos);
        if (rescore && rescore.recommendation === "EXIT" && rescore.confidence === "high") {
          pos._morningExitFlag = true;
          pos._morningExitReason = rescore.reasoning;
          logEvent("warn", `[MORNING REVIEW] ${pos.ticker} flagged for immediate exit at open - ${rescore.reasoning}`);
        } else if (rescore) {
          logEvent("scan", `[MORNING REVIEW] ${pos.ticker}: ${rescore.label} (${rescore.score}/95) - ${rescore.reasoning}`);
        }
      } catch(e) {
        logEvent("warn", `[MORNING REVIEW] ${pos.ticker} rescore failed: ${e.message}`);
      }
    }
    await saveStateNow();
  }
  await sendMorningBriefing();
  sendEmail("morning").catch(e => logEvent("error", `[EMAIL] Morning briefing failed: ${e.message}`));
});

cron.schedule("5 20,21 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 16 && et.getMinutes() === 5) {
    sendEmail("eod").catch(e => logEvent("error", `[EMAIL] EOD email failed: ${e.message}`));
    await saveDailyLogToRedis(true);
  }
});

cron.schedule("30 13-21 * * 1-5", async () => {
  const et = getETTime();
  const etH = et.getHours();
  const etM = et.getMinutes();
  if (etM !== 30 || etH < 9 || etH > 15) return;
  if (etH === 16) return;
  const bufLen = (state._dailyLogBuffer || []).length;
  if (bufLen === 0) return;
  logEvent("scan", `[AUTO-SAVE] Hourly log checkpoint: saving ${bufLen} entries to Redis...`);
  await saveDailyLogToRedis(false);
});

// 3:55pm ET insurance checkpoint (2:55 CT) — an independent save ~10 min before the
// 4:05 ET EOD save, so the full day is durably in Redis even if the EOD save misfires.
// Non-EOD (isEOD=false): does NOT wipe the buffer — EOD still does the final save+wipe.
// Merge-on-save makes it safe even if the buffer is thin. 19:55/20:55 UTC covers EDT/EST;
// the ET-guard fires it exactly once at 15:55 ET.
cron.schedule("55 19,20 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() !== 15 || et.getMinutes() !== 55) return;
  const bufLen = (state._dailyLogBuffer || []).length;
  logEvent("scan", `[AUTO-SAVE] 3:55 PM insurance checkpoint: saving ${bufLen} entries to Redis...`);
  await saveDailyLogToRedis(false);
});

// 3:15pm ET hard close — pure intraday
cron.schedule("15 19,20 * * 1-5", async () => {
  const et = getETTime();
  if (!(et.getHours() === 15 && et.getMinutes() === 15)) return;
  if (state._overnightCutDisabled) {
    logEvent("scan", "[EOD CLOSE] Disabled for this session — skipping 3:15pm hard close");
    return;
  }
  const positions = state.positions || [];
  if (positions.length === 0) return;
  logEvent("scan", `[EOD CLOSE] 3:15pm — closing ALL ${positions.length} position(s). Pure intraday: no overnight holds.`);
  for (const pos of [...positions]) {
    const _curPrice = (pos.currentPrice != null && !isNaN(pos.currentPrice) && pos.currentPrice > 0)
      ? pos.currentPrice : pos.premium;
    const chg    = pos.premium > 0 ? (_curPrice - pos.premium) / pos.premium : 0;
    const reason = chg > 0 ? "eod-profit-close" : "eod-close";
    logEvent("scan",
      `[EOD CLOSE] Closing ${pos.ticker} — reason:${reason} chg:${(chg*100).toFixed(0)}% ` +
      `premium:$${pos.premium} current:$${_curPrice.toFixed(2)}`
    );
    try {
      await closePosition(pos.ticker, reason, null, pos.contractSymbol || pos.buySymbol);
    } catch(e) {
      logEvent("error", `[EOD CLOSE] Failed to close ${pos.ticker}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
});

cron.schedule("15 20,21 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 16 && et.getMinutes() === 15) {
    logEvent("macro", "[POST-MARKET] 4:15pm ET assessment starting...");
    await getAgentPostMarketAssessment("4:15pm");
  }
});

cron.schedule("0 22,23 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 18 && et.getMinutes() === 0) {
    logEvent("macro", "[EVENING] 6:00pm ET scan starting...");
    await getAgentPostMarketAssessment("6pm-evening");
  }
});

cron.schedule("0 4,5 * * 2-6", async () => {
  const et = getETTime();
  if (et.getHours() === 0 && et.getMinutes() === 0) {
    logEvent("macro", "[OVERNIGHT] 11pm CT midnight digest starting...");
    await getAgentOvernightScan("midnight-digest");
  }
});

// 9:25am ET daily P&L reset
cron.schedule("25 13 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 9 && et.getMinutes() === 25) {
    const prev = state.todayRealizedPnL || 0;
    state.todayRealizedPnL  = 0;
    state._dailyPnL         = 0;
    state._dailyCircuitOpen = true;
    state.todayTrades       = 0;
    try {
      const acct = await alpacaGet("/account");
      if (acct) {
        state.dayOpenEquity = parseFloat(acct.equity || acct.portfolio_value || acct.cash || 0);
        logEvent("scan", `[ALPACA TRUTH] dayOpenEquity set: $${state.dayOpenEquity.toFixed(2)}`);
      }
    } catch(e) { logEvent("warn", `[ALPACA TRUTH] dayOpenEquity capture failed: ${e.message}`); }
    await saveStateNow();
    logEvent("circuit", `[MORNING RESET] Daily P&L zeroed before open (was $${prev.toFixed(0)}) — circuit armed for new session`);
  }
});

cron.schedule("0 12,13 * * 6", async () => {
  const et = getETTime();
  if (et.getHours() === 8 && et.getMinutes() === 0) {
    logEvent("macro", "[WEEKLY] Saturday 8:00am ET regime assessment starting...");
    await getAgentDayPlan("saturday-weekly");
  }
});

cron.schedule("*/15 12-21 * * 1-5", async () => {
  if (!isMarketHours()) return;
  const lastScan    = state.lastScan ? new Date(state.lastScan) : null;
  const minsSinceLastScan = lastScan ? (Date.now() - lastScan.getTime()) / 60000 : 999;
  if (minsSinceLastScan > 15 && minsSinceLastScan < 999 && RESEND_API_KEY && GMAIL_USER) {
    logEvent("warn", `Health check: no scan in ${minsSinceLastScan.toFixed(0)} minutes - sending alert`);
    sendResendEmail(
      "ARGO-V3.0 ALERT - Scanner may be down",
      `<p>ARGO-V3.0 has not scanned in ${minsSinceLastScan.toFixed(0)} minutes during market hours.</p>
             <p>Last scan: ${state.lastScan || "unknown"}</p>
             <p>Check Railway logs immediately.</p>`
    );
  }
});

// Weekly reset Monday 9am ET
cron.schedule("0 13,14 * * 1", async () => {
  const et = getETTime();
  if (et.getHours() !== 9 || et.getMinutes() !== 0) return;
  state.weekStartCash     = state.cash;
  state.weeklyCircuitOpen = true;
  // C1-G Sunday 6/8: reset weekly P&L accumulator and lock on Monday open
  state._weeklyRealizedPnL    = 0;
  state._weeklyLossLockActive = false;
  state._weekStartTimestamp   = Date.now();
  await saveStateNow();
  logEvent("reset", "Weekly circuit breaker reset");
});

// Monthly report - first Monday of month
cron.schedule("0 13,14 * * 1", async () => {
  const et = getETTime();
  if (et.getHours() !== 9 || et.getMinutes() !== 0) return;
  const day = et.getDate();
  if (day > 7) return;
  const report = buildMonthlyReport();
  logEvent("monthly", report);
  state.monthlyProfit = 0;
  state.monthStart    = new Date().toLocaleDateString();
  // C1-G Sunday 6/8: reset monthly loss lock on month rollover
  state._monthlyLossLockActive = false;
  await saveStateNow();
  if (RESEND_API_KEY && GMAIL_USER) {
    sendResendEmail(
      `ARGO-V3.0 Monthly Report - ${et.toLocaleDateString("en-US",{month:"long",year:"numeric"})}`,
      `<pre style="font-family:monospace;background:#07101f;color:#cce8ff;padding:20px">${report}</pre>`
    );
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", async (req, res) => {
  const enrichedPositions = (state.positions || []).map(pos => {
    const c   = pos.contracts || 1;
    const prem = parseFloat(pos.premium) || 0;
    const cur  = parseFloat(pos.currentPrice) || prem;
    const maxProfitVal = parseFloat(pos.maxProfit) || Math.max(1, prem * 100 * c);
    let displayPnL;
    if (pos.isCreditSpread) {
      displayPnL = parseFloat(((prem - cur) * 100 * c).toFixed(2));
    } else {
      displayPnL = parseFloat(((cur - prem) * 100 * c).toFixed(2));
    }
    const displayPnLPct = maxProfitVal > 0 ? parseFloat((displayPnL / maxProfitVal * 100).toFixed(1)) : 0;
    const costToClose   = parseFloat((cur * 100 * c).toFixed(2));
    return { ...pos, displayPnL, displayPnLPct, costToClose };
  });
  res.json({
    ...state,
    positions: enrichedPositions,
    heatPct:       parseFloat((heatPct()*100).toFixed(1)),
    heatCap:       parseFloat((effectiveHeatCap()*100).toFixed(0)),
    fillQuality:   state._fillQuality || { count: 0, totalSlippage: 0, misses: 0, avgSlippage: 0 },
    paperSlippage: state._paperSlippage || { trades: 0, totalEst: 0, avgEst: 0 },
    agentAccuracy: state._agentAccuracy ? {
      calls:      state._agentAccuracy.calls,
      acc30:      state._agentAccuracy.acc30  || null,
      acc120:     state._agentAccuracy.acc120 || null,
      correct30:  state._agentAccuracy.correct30,
      correct120: state._agentAccuracy.correct120,
      pending:    state._agentAccuracy.pending.length,
    } : null,
    alpacaCircuit: getCircuitState(),
    avgScanIntervalMs: state._avgScanIntervalMs || 0,
    portfolioBetaDelta: state._portfolioBetaDelta || 0,
    accountPhase: getAccountPhase(),
    agentHealth: state._agentHealth || { calls: 0, successes: 0, timeouts: 0, parseErrors: 0 },
    realizedPnL:   state._alpacaTruth
      ? parseFloat(state._alpacaTruth.totalPnL.toFixed(2))
      : parseFloat(realizedPnL().toFixed(2)),
    alpacaTruth:   state._alpacaTruth || null,
    todayRealizedPnL: state._alpacaTruth
      ? parseFloat(state._alpacaTruth.totalPnL.toFixed(2))
      : (state.todayRealizedPnL || 0),
    monthlyProfit: state._alpacaTruth
      ? parseFloat(state._alpacaTruth.totalPnL.toFixed(2))
      : (state.monthlyProfit || 0),
    totalCap:      totalCap(),
    stockValue:    parseFloat(stockValue().toFixed(2)),
    isMarketHours:      isMarketHours(),
    isEntryWindow:      isEntryWindow(),
    lastUpdated:        new Date().toISOString(),
    uptime:             process.uptime(),
    betaWeightedDelta:  calcBetaWeightedDelta(),
    dataQuality:        state.dataQuality || { realTrades: 0, estimatedTrades: 0, totalTrades: 0 },
    dataQualityPct:     (function() {
      const dq = state.dataQuality || {};
      const real = dq.realTrades || 0;
      const est  = dq.estimatedTrades || 0;
      return (real + est) > 0 ? Math.round(real / (real + est) * 100) : 100;
    })(),
    alpacaCash:         state.alpacaCash || null,
    alpacaOptBP:        state.alpacaOptBP || null,
    pdtCount:           countRecentDayTrades(),
    pdtRemaining:       Math.max(0, PDT_LIMIT - countRecentDayTrades()),
    alpacaDayTradesLeft: state._alpacaDayTradesLeft ?? null,
    pdtSource:          state._alpacaDayTradeCount !== undefined ? "alpaca" : "internal",
    patternDayTrader:   state._patternDayTrader || false,
    tickerBlacklist:    state.tickerBlacklist || [],
    pdtLimit:           PDT_LIMIT,
    pdtBlocked:         PDT_RULE_ACTIVE && countRecentDayTrades() >= PDT_LIMIT,
    pdtRuleActive:      PDT_RULE_ACTIVE,
    exitStats:          state.exitStats || {},
    agentMacro:         state._agentMacro || null,
    dayPlan:            state._dayPlan || null,
    agentAutoExitEnabled: state.agentAutoExitEnabled || false,
    portfolioSnapshots: state.portfolioSnapshots || [],
    reconcileStatus:    state.reconcileStatus || "unknown",
    orphanCount:        state.orphanCount || 0,
    lastReconcile:      state.lastReconcile || null,
    scanFailures:       state._scanFailures || 0,
    ivrDebitBlocked:    (state._ivRank || 50) < 15,
    ivrCaution:         (state._ivRank || 50) >= 15 && (state._ivRank || 50) < 25,
    macroCalendar:      getScannerState().marketContext.macroCalendar,
    upcomingEvents:     getUpcomingMacroEvents(7),
    regime:             getScannerState().marketContext.regime,
    concentration:      getScannerState().marketContext.concentration,
    stressTest:         getScannerState().marketContext.stressTest,
    drawdownProtocol:   getScannerState().marketContext.drawdownProtocol,
    benchmark:          getScannerState().marketContext.benchmark,
    timeOfDay:          getTimeOfDayAnalysis(),
    monteCarlo:         getScannerState().marketContext.monteCarlo,
    kelly:              getScannerState().marketContext.kelly,
    relativeValue:      getScannerState().marketContext.relativeValue,
    globalMarket:       getScannerState().marketContext.globalMarket,
    streaks:            getScannerState().marketContext.streaks,
    calmar:             calcCalmarRatio(),
    informationRatio:   calcInformationRatio(),
    drawdownDuration:   calcDrawdownDuration(),
    autocorrelation:    calcAutocorrelation(),
    riskOfRuin:         calcRiskOfRuin(),
    pcr:                state._pcr || null,
    termStructure:      state._termStructure || null,
    breadthMomentum:    state._breadthMomentum || 0,
    breadthTrend:       state._breadthTrend || "flat",
    zweigThrust:        state._zweigThrust || null,
    skew:               state._skew || null,
    aaii:               state._aaii || null,
    lastScanScores:     state._lastScanScores || {},
    overnightScan:      state._overnightScan || null,
    headlineCacheSize:  (state._headlineCache || []).length,
    headlineCacheAge:   state._headlineCacheTs ? Math.round((Date.now() - state._headlineCacheTs) / 60000) : null,
    watchlist:          WATCHLIST.map(w => ({ ticker: w.ticker, sector: w.sector, beta: w.beta, isPrimary: w.isPrimary, catalyst: w.catalyst })),
    // C1 Sunday 6/8 additions (will be populated after deployment):
    dailyLossLockActive:      state._dailyLossLockActive || false,
    dailyLossLockTriggeredAt: state._dailyLossLockTriggeredAt || null,
    weeklyLossLockActive:     state._weeklyLossLockActive || false,
    monthlyLossLockActive:    state._monthlyLossLockActive || false,
    weeklyRealizedPnL:        state._weeklyRealizedPnL || 0,
  });
});

app.post("/api/test-thesis", (req, res) => {
  const { ticker, mockRSI=52, mockMACD="neutral", mockMomentum="steady", mockMacro="neutral", mockDays=1 } = req.body || {};
  const pos = (state.positions || []).find(p => p.ticker === ticker);
  if (!pos && !ticker) return res.json({ error: "provide ticker" });
  const testPos = pos || {
    ticker: ticker || "TEST",
    optionType: "put",
    entryRSI: 72,
    entryMACD: "bearish",
    entryMomentum: "recovering",
    entryMacro: "bearish",
    premium: 5.00,
    currentPrice: 5.00,
    openDate: new Date(Date.now() - mockDays * MS_PER_DAY).toISOString(),
    entryThesisScore: 100,
    thesisHistory: [],
  };
  const integrity = calcThesisIntegrity(testPos, mockRSI, mockMACD, mockMomentum, mockMacro);
  const adjStop   = getTimeAdjustedStop({ ...testPos, currentPrice: testPos.premium * 0.8 });
  res.json({
    ticker: testPos.ticker,
    optionType: testPos.optionType,
    daysOpen: mockDays,
    entryConditions: { rsi: testPos.entryRSI, macd: testPos.entryMACD, momentum: testPos.entryMomentum, macro: testPos.entryMacro },
    currentConditions: { rsi: mockRSI, macd: mockMACD, momentum: mockMomentum, macro: mockMacro },
    thesisIntegrity: integrity,
    timeAdjustedStop: `${(adjStop*100).toFixed(0)}%`,
    wouldClose: integrity.score < 20 ? "YES - thesis-collapsed" : adjStop < STOP_LOSS_PCT ? `YES - time-stop at ${(adjStop*100).toFixed(0)}%` : "NO",
  });
});

app.post("/api/test-pre-entry", async (req, res) => {
  const { ticker="TEST", mockRSI=70, mockMACD="bearish", mockMomentum="recovering", mockScore=85, optionType="put" } = req.body || {};
  const mockStock = { ticker, rsi: mockRSI, macd: mockMACD, momentum: mockMomentum };
  const mockReasons = [`RSI ${mockRSI}`, `MACD ${mockMACD}`, `Momentum ${mockMomentum}`];
  try {
    const result = await getAgentPreEntryCheck(mockStock, mockScore, mockReasons, optionType);
    res.json({ ticker, mockScore, optionType, preEntryResult: result });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.post("/api/test-morning-review", async (req, res) => {
  if (!state.positions || state.positions.length === 0) {
    return res.json({ message: "no open positions to review" });
  }
  const results = [];
  for (const pos of state.positions) {
    try {
      const rescore = await getAgentRescore(pos);
      results.push({
        ticker:         pos.ticker,
        optionType:     pos.optionType,
        daysOpen:       ((Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY).toFixed(1),
        pnlPct:         pos.currentPrice && pos.premium ? ((pos.currentPrice - pos.premium) / pos.premium * 100).toFixed(1) + '%' : 'unknown',
        thesisScore:    pos.entryThesisScore || 100,
        agentRescore:   rescore || { error: "no response" },
        wouldFlag:      rescore?.recommendation === "EXIT" && rescore?.confidence === "high",
      });
    } catch(e) {
      results.push({ ticker: pos.ticker, error: e.message });
    }
  }
  res.json({ reviewed: results.length, results });
});

app.get("/api/score-debug", (req, res) => {
  try {
    const _dbRb = getRegimeRulebook(state);
    const agentMacro    = state._agentMacro || {};
    const avoidUntilStr = _dbRb.gates.avoidHoldActive
      ? new Date(state._avoidUntil).toLocaleTimeString("en-US",{timeZone:"America/New_York"}) : null;

    const gates = {
      regimeClass:         _dbRb.regimeClass,
      priceRegime:         _dbRb.regimeName,
      agentRegime:         agentMacro.regime || "unknown",
      agentTradeType:      agentMacro.tradeType || "spread",
      isChoppyRegime:      _dbRb.gates.choppyDebitBlock,
      creditModeActive:    false,
      creditCallModeActive:false,
      below200MACallBlock: _dbRb.gates.below200MACallBlock,
      macroBullish:        _dbRb.gates.macroBullishBlock,
      vixFallingPause:     _dbRb.gates.vixFallingPause,
      postReversalBlock:   _dbRb.gates.postReversalBlock,
      avoidHoldActive:     _dbRb.gates.avoidHoldActive,
      avoidUntilStr,
      ivr:                 _dbRb.ivRank,
      ivElevated:          _dbRb.ivElevated,
      creditAllowedVIX:    _dbRb.creditAllowedVIX,
      vix:                 _dbRb.vix,
      spyPrice:            state._liveSPY || 0,
      spyDayChange:        state._spyDayChange || 0,
      spy50MA:             state._spyMA50 || 0,
      spy200MA:            state._spyMA200 || 0,
      regimeDuration:      state._regimeDuration || 0,
      shortDeltaTarget:    _dbRb.spreadParams.shortDeltaTarget,
      targetDTE:           _dbRb.spreadParams.targetDTE,
      minCreditRatio:      _dbRb.spreadParams.minCreditRatio,
      creditOTMpct:        _dbRb.spreadParams.creditOTMpct,
      entryBias:           agentMacro.entryBias || "neutral",
      creditStress:        state._creditStress || false,
      nvdaWeakness:        state._nvdaWeakness || false,
      jpmStress:           state._jpmStress || false,
      breadthPct:          state._lastBreadthPct || 0,
    };

    const snapshots = state._scoreDebug || {};
    const allWatchlist = [
      ...WATCHLIST,
      ...(INDIVIDUAL_STOCKS_ENABLED ? INDIVIDUAL_STOCK_WATCHLIST : []),
    ];
    const results = allWatchlist.map(stock => {
      const snap = snapshots[stock.ticker];
      if (!snap) return { ticker: stock.ticker, noData: true };
      const ageSec = Math.round((Date.now() - snap.ts) / 1000);
      const bestScore = Math.max(snap.putScore, snap.callScore);
      const bestType  = snap.putScore >= snap.callScore ? "put" : "call";
      const blocks = [...(snap.blocked || [])];
      if (gates.isChoppyRegime && !gates.creditModeActive) blocks.push("choppy regime - debit blocked");
      if (gates.below200MACallBlock)                        blocks.push("SPY below 200MA - calls blocked");
      if (gates.macroBullish)                               blocks.push("macro aggressive - puts blocked");
      if (gates.vixFallingPause)                            blocks.push("VIX falling - puts paused");
      if (gates.avoidHoldActive)                            blocks.push(`avoid hold until ${gates.avoidUntilStr || "?"}`);
      const modeIndicators = [];
      if (gates.creditModeActive)     modeIndicators.push("credit PUT mode");
      if (gates.creditCallModeActive) modeIndicators.push("credit CALL mode");
      const instrConstraint = INSTRUMENT_CONSTRAINTS[stock.ticker] || null;
      const activeCreditScore = snap.creditScore ?? null;
      const displayScore = activeCreditScore !== null ? activeCreditScore : bestScore;
      const displayType  = snap.creditType || bestType;
      const effectiveMin = snap.effectiveMin || (snap.creditType ? 65 : 70);
      const rrEst        = snap.rrEstimate || null;
      const scorePassesMin = displayScore >= effectiveMin;
      const rrPassesMin    = !rrEst || rrEst.viable;
      const constraintPass = !instrConstraint || instrConstraint.allowedTypes.includes(
        snap.creditType || (bestType === "put" ? "debit_put" : "debit_call")
      );
      const rrBlock = (rrEst && !rrEst.viable) ? [`execution gate: ${rrEst.reason}`] : [];
      const allBlocks = [...blocks, ...rrBlock];
      return {
        ticker:       stock.ticker,
        price:        snap.price,
        ageSec,
        putScore:     snap.putScore,
        callScore:    snap.callScore,
        creditScore:  activeCreditScore,
        creditType:   snap.creditType || null,
        bestScore:    displayScore,
        bestType:     displayType,
        effectiveMin,
        rrEstimate:   rrEst,
        wouldEnter:   scorePassesMin && rrPassesMin && allBlocks.length === 0 && constraintPass,
        modeIndicators,
        blocks:       allBlocks,
        constraint:   instrConstraint ? `${instrConstraint.allowedTypes.join("/")} only${instrConstraint.reason ? " - " + instrConstraint.reason : ""}` : null,
        putReasons:   snap.putReasons  || [],
        callReasons:  snap.callReasons || [],
        signals:      snap.signals     || {},
      };
    });

    res.json({
      timestamp:   new Date().toISOString(),
      lastScan:    state.lastScan,
      lastCreditRR: state._lastCreditRR || {},
      gates,
      agentSignal: agentMacro.signal     || "unknown",
      agentConf:   agentMacro.confidence || "unknown",
      agentBias:   agentMacro.entryBias  || "unknown",
      agentReasoning: agentMacro.reasoning || "",
      results,
      gateAudit:   (state._gateAudit || []).slice(-50).reverse(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/logs", (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || 200), 30000);
  const filter = req.query.filter || null;
  const since  = req.query.since  || null;
  const search = req.query.search || null;
  const types  = filter ? filter.split(",").map(t => t.trim().toLowerCase()) : null;
  const useFullDay = !!(types || since || search);
  let logs = useFullDay
    ? (state._dailyLogBuffer || state.tradeLog || []).slice().reverse()
    : (state.tradeLog || []);
  if (since) {
    const sinceMs = new Date(since).getTime();
    logs = logs.filter(e => new Date(e.time).getTime() > sinceMs);
  }
  if (types)  logs = logs.filter(e => types.includes(e.type));
  if (search) {
    const q = search.toLowerCase();
    logs = logs.filter(e => (e.message || e.msg || "").toLowerCase().includes(q));
  }
  res.json({
    logs:      logs.slice(0, limit),
    total:     useFullDay ? (state._dailyLogBuffer || []).length : (state.tradeLog || []).length,
    source:    useFullDay ? "daily" : "recent",
    generated: new Date().toISOString(),
    cash:      state.cash,
    positions: (state.positions || []).length,
    vix:       state.vix,
  });
});

app.get("/api/analytics/history", async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: "Redis not configured" });
  try {
    const { date } = req.query;
    if (date) {
      const key  = `argo:analytics:${date}`;
      const resp = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const data = await resp.json();
      if (!data.result) return res.status(404).json({ error: `No analytics snapshot for ${date}` });
      return res.json(parseRedisBlob(data.result));
    } else {
      const resp  = await fetch(`${REDIS_URL}/keys/argo:analytics:*`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const data  = await resp.json();
      const dates = (data.result || []).map(k => k.replace('argo:analytics:', '')).sort().reverse();
      return res.json({ available: dates, count: dates.length });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/logs/history", async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: "Redis not configured" });
  try {
    const date = req.query.date;
    if (date) {
      const logKey = `argo:logs:${date}`;
      const resp   = await fetch(`${REDIS_URL}/get/${logKey}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const data = await resp.json();
      let entries, summary, source;
      const parsed       = parseRedisBlob(data.result);
      const redisEntries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      const todayStr     = getETDateStr();
      if (redisEntries.length) {
        entries = redisEntries;
        summary = parsed.summary;
        source  = "redis";
      } else if (date === todayStr && state._dailyLogBuffer && state._dailyLogBuffer.length) {
        // Redis key absent OR present-but-empty → serve today's live buffer so an
        // empty/clobbered key doesn't mask in-memory data before a save runs.
        entries = state._dailyLogBuffer;
        summary = {
          totalEntries: entries.length,
          trades:  entries.filter(e => e.type === "trade").length,
          errors:  entries.filter(e => e.type === "error").length,
          warns:   entries.filter(e => e.type === "warn").length,
          cashEOD: state.cash,
          positionsEOD: state.positions.length,
          note: "live buffer — Redis copy empty or not yet saved"
        };
        source = "live_buffer";
      } else {
        return res.status(404).json({ error: `No log found for ${date}` });
      }
      const filter = req.query.filter;
      const limit  = Math.min(parseInt(req.query.limit || 5000), 30000);
      const types  = filter ? filter.split(",").map(t => t.trim().toLowerCase()) : null;
      if (types) entries = entries.filter(e => types.includes(e.type));
      res.json({ date, entries: entries.slice(0, limit), summary, source });
    } else {
      const resp = await fetch(`${REDIS_URL}/keys/argo:logs:*`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const data  = await resp.json();
      const dates = (data.result || []).map(k => k.replace("argo:logs:", "")).sort().reverse();
      res.json({ available: dates, count: dates.length });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/logs/save-now", async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: "Redis not configured" });
  try {
    const before = (state._dailyLogBuffer || []).length;
    await saveDailyLogToRedis(false);
    const dateStr = getETDateStr();
    logEvent("scan", `[MANUAL SAVE] Daily log force-saved to Redis: argo:logs:${dateStr} | ${before} entries (buffer retained)`);
    res.json({ ok: true, date: dateStr, entries: before, note: "Buffer saved to Redis. Buffer retained in memory — logs continue accumulating." });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Compact score telemetry — CSV download for a day, or ?date=dates for the list.
// Falls back to the live in-memory buffer for today before the first checkpoint save.
app.get("/api/telemetry", async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: "Redis not configured" });
  try {
    const date = req.query.date;
    if (!date || date === "dates") {
      const resp = await fetch(`${REDIS_URL}/keys/argo:telemetry:*`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const data  = await resp.json();
      const dates = (data.result || []).map(k => k.replace("argo:telemetry:", "")).sort().reverse();
      return res.json({ available: dates, count: dates.length });
    }
    let header = "time,tkr,px,iRSI,dRSI,call,put,isMR,curl,vwap%,blocker,drivers";
    let rows = [], source = "redis";
    const resp = await fetch(`${REDIS_URL}/get/argo:telemetry:${date}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const data = await resp.json();
    if (!data.result) {
      const todayStr = getETDateStr();
      if (date === todayStr && state._telemetryBuffer && state._telemetryBuffer.length) {
        rows = state._telemetryBuffer; source = "live_buffer";
      } else {
        return res.status(404).json({ error: `No telemetry for ${date}` });
      }
    } else {
      const parsed = parseRedisBlob(data.result);
      header = (parsed && parsed.header) || header;
      rows   = (parsed && parsed.rows) || [];
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="argo-telemetry-${date}.csv"`);
    res.setHeader("X-Telemetry-Source", source);
    res.send(header + "\n" + rows.join("\n"));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scan", async (req,res) => { res.json({ok:true}); runScan(); });

app.post("/api/test-scan", async (req, res) => {
  if (getScannerState().scanRunning) return res.json({ error: "Scan already running" });
  const wasDryRun = false;
  setDryRunMode(true);
  res.json({ ok: true, message: "Test scan started - dry run forced for this cycle. Check /api/logs for results." });
  try { await runScan(); } finally { if (!wasDryRun) setDryRunMode(false); }
});

app.post("/api/close/:tkr", requireSecret, async (req,res) => {
  const t          = req.params.tkr.toUpperCase();
  const contractId = req.query.sym || null;
  const pos = contractId
    ? state.positions.find(p => p.contractSymbol === contractId || p.buySymbol === contractId)
    : state.positions.find(p => p.ticker === t);
  if (pos) {
    if (pos._permissionBlocked) {
      logEvent("warn", `[MANUAL CLOSE] Clearing stale _permissionBlocked on ${pos.ticker} — user-initiated close overrides`);
      delete pos._permissionBlocked;
      delete pos._permissionBlockedAt;
      delete pos._permBlockReason;
    }
    await closePosition(pos.ticker, "manual", null, pos.contractSymbol || pos.buySymbol);
    return res.json({ ok: true });
  }
  try {
    const alpacaPositions = await alpacaGet("/positions");
    if (alpacaPositions && Array.isArray(alpacaPositions)) {
      const matching = alpacaPositions.filter(p => p.symbol.startsWith(t) || p.symbol === t);
      if (matching.length === 0) return res.status(404).json({ error: "No position in ARGO or Alpaca" });
      for (const alpPos of matching) {
        const qty = Math.abs(parseInt(alpPos.qty));
        const side = parseInt(alpPos.qty) > 0 ? "sell" : "buy";
        const intent = parseInt(alpPos.qty) > 0 ? "sell_to_close" : "buy_to_close";
        await alpacaPost("/orders", { symbol: alpPos.symbol, qty, side, type: "market", time_in_force: "day", position_intent: intent }).catch(e => logEvent("error", `Direct close ${alpPos.symbol}: ${e.message}`));
        logEvent("trade", `[MANUAL] Direct Alpaca close: ${alpPos.symbol} | ${qty}x ${side}`);
      }
      await runReconciliation();
      return res.json({ ok: true, note: "Closed directly in Alpaca - state updated via reconciliation" });
    }
  } catch(e) { logEvent("error", `Manual close fallback failed: ${e.message}`); }
  res.status(404).json({ error: "No position found" });
});

app.post("/api/set-aaii", async (req, res) => {
  const { bullish, bearish, neutral } = req.body || {};
  if (!bullish || !bearish) return res.status(400).json({ error: "Need bullish and bearish percentages" });
  const spread  = bullish - bearish;
  const signal  = bullish < 20 ? "extreme_bearish" : bullish < 30 ? "bearish" : bullish > 55 ? "extreme_bullish" : bullish > 45 ? "bullish" : "neutral";
  state._aaiiManual = { bullish: parseFloat(bullish), bearish: parseFloat(bearish), neutral: parseFloat(neutral || (100 - bullish - bearish)), spread: parseFloat(spread.toFixed(1)), signal, date: new Date().toLocaleDateString(), manual: true };
  state._aaii = state._aaiiManual;
  markDirty();
  logEvent("scan", `[AAII] Manual update: Bulls:${bullish}% Bears:${bearish}% (${signal})`);
  res.json({ ok: true, signal, spread: spread.toFixed(1) });
});

app.post("/api/test-email", async (req, res) => {
  if (!RESEND_API_KEY || !GMAIL_USER) return res.json({ error: "Email not configured" });
  const type = (req.body && req.body.type) || "ping";
  try {
    if (type === "morning") {
      await sendMorningBriefing();
      return res.json({ ok: true, message: `Morning briefing sent to ${GMAIL_USER}` });
    }
    await sendResendEmail(`ARGO-V3.0 Email Test - ${new Date().toLocaleTimeString()}`,
      `<div style="font-family:monospace;background:#07101f;color:#00ff88;padding:20px;border-radius:8px"><h2>- ARGO-V3.0 Email Working</h2><p style="color:#cce8ff">Resend configured correctly.</p></div>`);
    res.json({ ok: true, message: `Test email sent to ${GMAIL_USER}` });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/dry-run-scan", async (req, res) => {
  let waited = 0;
  while (getScannerState().scanRunning && waited < 35000) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }
  if (getScannerState().scanRunning) return res.json({ error: "Scan still running after 35s - try again" });
  setDryRunMode(true);
  logEvent("scan", "- DRY RUN SCAN STARTED -");
  try { await runScan(); } finally { setDryRunMode(false); logEvent("scan", "- DRY RUN SCAN COMPLETE -"); }
  const dryLogs = state.tradeLog.filter(e => e.type === "dryrun" || (e.type === "filter" && new Date(e.time) > new Date(Date.now() - 120000))).slice(0, 50);
  res.json({ ok: true, message: "Dry run complete - check server log for details", entries: dryLogs });
});

app.post("/api/reset-pdt", requireSecret, async (req, res) => {
  const before = (state.dayTrades || []).length;
  state.dayTrades = [];
  await redisSave(state);
  logEvent("warn", `[PDT] Day trade counter manually reset (had ${before} records)`);
  res.json({ ok: true, message: `PDT counter reset. ${before} records cleared.` });
});

app.post("/api/reset-circuit", requireSecret, async (req, res) => {
  state.circuitOpen       = true;
  state.weeklyCircuitOpen = true;
  state.consecutiveLosses = 0;
  state.dayStartCash      = state.cash;
  const eodET = getETTime();
  if (eodET.getDay() === 5) { state.prevWeekClose = state.cash + openCostBasis(); }
  if (eodET.getDay() === 1 && state.prevWeekClose) { state.weekStartCash = state.prevWeekClose; }
  await saveStateNow();
  state._vixSpikeAt = null;
  logEvent("circuit", "Circuit breaker manually reset - resuming normal operations");
  res.json({ ok: true, cash: state.cash, positions: state.positions.length });
});

function normalizeJournalTimestamps(entries) {
  return entries.map(e => {
    if (!e.openDate) return e;
    try {
      const d = new Date(e.openDate);
      const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      return { ...e, openDateET: etStr };
    } catch(_) { return e; }
  });
}

app.get("/api/journal/today", async (req, res) => {
  try {
    const etDate  = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'}).split('/');
    const today   = `${etDate[2]}-${etDate[0]}-${etDate[1]}`;
    const entries = normalizeJournalTimestamps(await loadJournalDay(today));
    res.json({ date: today, count: entries.length, entries });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/journal", async (req, res) => {
  try {
    const { date, from, to } = req.query;
    if (date) { const entries = await loadJournalDay(date); return res.json({ date, count: entries.length, entries }); }
    if (from && to) { const entries = await getJournalRange(from, to); return res.json({ from, to, count: entries.length, entries }); }
    const today = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'}).split('/');
    const todayStr = `${today[2]}-${today[0]}-${today[1]}`;
    const entries  = normalizeJournalTimestamps(await loadJournalDay(todayStr));
    res.json({ date: todayStr, count: entries.length, entries });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/journal/summary", async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const to   = new Date();
    const from = new Date(Date.now() - parseInt(days) * 86400000);
    const entries = await getJournalRange(from.toISOString().split('T')[0], to.toISOString().split('T')[0]);
    const closed  = entries.filter(e => e.status === 'CLOSED');
    const wins    = closed.filter(e => e.isWin);
    const grossW  = wins.reduce((s,e) => s + (e.pnl_alpaca || e.pnl_apex || 0), 0);
    const grossL  = closed.filter(e => !e.isWin).reduce((s,e) => s + Math.abs(e.pnl_alpaca || e.pnl_apex || 0), 0);
    const byReason = {}; closed.forEach(e => { const r = e.exitReason || 'unknown'; if (!byReason[r]) byReason[r] = { count: 0, pnl: 0, wins: 0 }; byReason[r].count++; byReason[r].pnl += (e.pnl_alpaca || e.pnl_apex || 0); if (e.isWin) byReason[r].wins++; });
    const byTicker = {}; closed.forEach(e => { const t = e.ticker; if (!byTicker[t]) byTicker[t] = { count: 0, pnl: 0, wins: 0 }; byTicker[t].count++; byTicker[t].pnl += (e.pnl_alpaca || e.pnl_apex || 0); if (e.isWin) byTicker[t].wins++; });
    res.json({ period: { from: from.toISOString().split('T')[0], to: to.toISOString().split('T')[0], days: parseInt(days) }, totals: { trades: closed.length, open: entries.filter(e => e.status === 'OPEN').length, wins: wins.length, losses: closed.length - wins.length, winRate: closed.length > 0 ? parseFloat((wins.length / closed.length * 100).toFixed(1)) : 0, grossWins: parseFloat(grossW.toFixed(2)), grossLoss: parseFloat(grossL.toFixed(2)), netPnL: parseFloat((grossW - grossL).toFixed(2)), avgWin: wins.length > 0 ? parseFloat((grossW / wins.length).toFixed(2)) : 0, avgLoss: (closed.length - wins.length) > 0 ? parseFloat((grossL / (closed.length - wins.length)).toFixed(2)) : 0 }, byExitReason: byReason, byTicker });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Daily / weekly / monthly journal breakdown — period-bucketed P&L + win rate +
// exit-reason mix, each entry carrying its trade logic (entryReasons) and exit reason.
// e.g. /api/journal/breakdown?period=weekly&days=90
app.get("/api/journal/breakdown", async (req, res) => {
  try {
    const period = ["daily", "weekly", "monthly"].includes(req.query.period) ? req.query.period : "daily";
    const defWindow = period === "monthly" ? 365 : period === "weekly" ? 120 : 30;
    const days = Math.min(400, Math.max(1, parseInt(req.query.days) || defWindow));
    const to   = new Date();
    const from = new Date(Date.now() - days * 86400000);
    const entries = await getJournalRange(from.toISOString().split('T')[0], to.toISOString().split('T')[0]);
    res.json(buildJournalBreakdown(entries, period));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/journal/backfill", async (req, res) => {
  try {
    const { date, entries } = req.body;
    if (!date || !Array.isArray(entries)) return res.status(400).json({ error: "Requires date (YYYY-MM-DD) and entries array" });
    const existing = await loadJournalDay(date);
    const existingIds = new Set(existing.map(e => e.id));
    const newEntries = entries.filter(e => !existingIds.has(e.id));
    const merged = [...newEntries, ...existing].sort((a,b) => new Date(b.openDate) - new Date(a.openDate));
    await saveJournalDay(date, merged);
    res.json({ ok: true, date, added: newEntries.length, total: merged.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/reset-daily-pnl", requireSecret, async (req, res) => {
  const before = { todayRealizedPnL: state.todayRealizedPnL || 0, _dailyPnL: state._dailyPnL || 0, _dailyCircuitOpen: state._dailyCircuitOpen };
  state.todayRealizedPnL  = 0; state._dailyPnL = 0; state._dailyCircuitOpen = true;
  await saveStateNow();
  logEvent("circuit", `[DAILY RESET] Daily P&L reset to $0 (was $${before.todayRealizedPnL.toFixed(0)}) — circuit cleared for paper trading`);
  res.json({ ok: true, before, after: { todayRealizedPnL: 0, _dailyPnL: 0, _dailyCircuitOpen: true } });
});

// PAPER DATA MODE — single UI toggle. Lifts account-level P&L loss-locks + loosens entries
// (calls+puts) for data gathering. HARD INTERLOCK: refuses on a live account. Per-position stops,
// give-back, the 3:15 flatten, and structural halts (crisis/Regime-C, VIX>=50, capital floor) are
// untouched and stay ON. (Panel D1/D2/D3, 6/23.)
app.post("/api/paper-data-mode", requireSecret, async (req, res) => {
  if (!IS_PAPER_ACCOUNT) return res.status(403).json({ error: "PAPER DATA MODE is refused on a live account" });
  const enabled = req.body?.enabled === true;
  state.paperDataMode = enabled;
  markDirty(); await saveStateNow();
  logEvent("circuit", `[PAPER-DATA-MODE] ${enabled ? "ENABLED" : "disabled"} — P&L loss-locks ${enabled ? "LIFTED" : "restored"}, entries ${enabled ? "loosened (calls+puts)" : "disciplined"} · per-position stops + 3:15 flatten + structural halts unchanged (paper only)`);
  res.json({ ok: true, paperDataMode: state.paperDataMode });
});

app.post("/api/clear-vix-cooldown", requireSecret, async (req, res) => {
  state._vixSpikeAt = null; markDirty(); await saveStateNow();
  logEvent("circuit", "VIX spike cooldown manually cleared");
  res.json({ ok: true, message: "VIX spike cooldown cleared — debit puts re-enabled" });
});

app.post("/api/clear-avoid", requireSecret, async (req, res) => {
  state._avoidUntil = null; markDirty(); await saveStateNow();
  logEvent("circuit", "Agent avoid hold manually cleared — entries re-enabled");
  res.json({ ok: true, message: "Avoid hold cleared" });
});

app.post("/api/clear-blocker", requireSecret, async (req, res) => {
  const cleared = [];
  if (state._avoidUntil) { state._avoidUntil = null; cleared.push("avoid hold"); }
  if (state._vixSpikeAt)  { state._vixSpikeAt  = null; cleared.push("VIX cooldown"); }
  if (state._entryAttemptCooldown && Object.keys(state._entryAttemptCooldown).length) { const tickers = Object.keys(state._entryAttemptCooldown).join(", "); state._entryAttemptCooldown = {}; cleared.push(`entry cooldowns (${tickers})`); }
  if (state._pendingOrder) { const sym = state._pendingOrder.ticker || "unknown"; state._pendingOrder = null; cleared.push(`pending order (${sym})`); }
  if (state._spiralActive) { cleared.push(`spiral block (${state._spiralActive})`); state._spiralActive = null; }
  if (state._spiralTracker && (state._spiralTracker.put >= 5 || state._spiralTracker.call >= 5)) { state._spiralTracker = { put: 0, call: 0 }; cleared.push('spiral counters reset'); }
  // C1 Sunday 6/8: also clear new daily/weekly locks
  if (state._dailyLossLockActive) { state._dailyLossLockActive = false; state._dailyLossLockTriggeredAt = null; cleared.push("daily loss lock"); }
  if (state._weeklyLossLockActive) { state._weeklyLossLockActive = false; cleared.push("weekly loss lock"); }
  if (state._monthlyLossLockActive) { state._monthlyLossLockActive = false; cleared.push("monthly loss lock"); }
  markDirty(); await saveStateNow();
  const msg = cleared.length ? `Cleared: ${cleared.join(" | ")}` : "Nothing to clear — no active blockers";
  logEvent("circuit", `[CLEAR-BLOCKER] ${msg}`);
  res.json({ ok: true, message: msg, cleared });
});

// C1-G Sunday 6/8: manual endpoint to clear weekly/monthly lock
app.post("/api/clear-weekly-monthly-lock", requireSecret, async (req, res) => {
  const cleared = [];
  if (state._weeklyLossLockActive)  { state._weeklyLossLockActive  = false; cleared.push("weekly loss lock"); }
  if (state._monthlyLossLockActive) { state._monthlyLossLockActive = false; cleared.push("monthly loss lock"); }
  if (state._weeklyRealizedPnL < 0) { state._weeklyRealizedPnL = 0; cleared.push("weekly P&L accumulator reset"); }
  markDirty(); await saveStateNow();
  const msg = cleared.length ? `Cleared: ${cleared.join(" | ")}` : "No weekly/monthly locks active";
  logEvent("circuit", `[WEEKLY-MONTHLY UNLOCK] ${msg}`);
  res.json({ ok: true, message: msg, cleared });
});

app.post("/api/clear-entry-cooldown", requireSecret, async (req, res) => {
  const ticker = req.query.ticker || req.body?.ticker;
  if (ticker) {
    if (state._entryAttemptCooldown) delete state._entryAttemptCooldown[ticker.toUpperCase()];
    markDirty(); await saveStateNow();
    res.json({ ok: true, message: `Entry cooldown cleared for ${ticker.toUpperCase()}` });
  } else {
    state._entryAttemptCooldown = {}; markDirty(); await saveStateNow();
    logEvent("circuit", "All entry cooldowns cleared — re-entry enabled for all tickers");
    res.json({ ok: true, message: "All entry cooldowns cleared" });
  }
});

app.post("/api/full-reset", requireSecret, async (req, res) => {
  for (const pos of [...state.positions]) {
    try {
      const qty = Math.max(1, pos.contracts);
      if (pos.isSpread) {
        if (pos.buySymbol) await alpacaPost("/orders", { symbol: pos.buySymbol, qty, side:"sell", type:"market", time_in_force:"day", position_intent:"sell_to_close" }).catch(()=>{});
        if (pos.sellSymbol) await alpacaPost("/orders", { symbol: pos.sellSymbol, qty, side:"buy", type:"market", time_in_force:"day", position_intent:"buy_to_close" }).catch(()=>{});
      } else if (pos.contractSymbol) {
        const bidPrice = parseFloat((pos.bid > 0 ? pos.bid : pos.premium * 0.98).toFixed(2));
        await alpacaPost("/orders", { symbol: pos.contractSymbol, qty, side:"sell", type:"limit", time_in_force:"day", limit_price: bidPrice, position_intent:"sell_to_close" }).catch(()=>{});
      }
    } catch(e) {}
  }
  Object.assign(state, defaultState());
  await saveStateNow();
  logEvent("reset", `FULL RESET - state wiped, starting fresh with $${MONTHLY_BUDGET.toLocaleString()}`);
  res.json({ ok: true, message: "Full reset complete" });
});

app.post("/api/emergency-close", requireSecret, async (req, res) => {
  const snapshot = [...state.positions];
  const count    = snapshot.length;
  let closed = 0, failed = 0;
  logEvent("circuit", `EMERGENCY CLOSE ALL initiated - ${count} positions`);
  for (const pos of snapshot) {
    try {
      const result = await closePosition(pos.ticker, "emergency-manual");
      if (result !== false) closed++; else failed++;
    } catch(e) {
      failed++;
      logEvent("error", `Emergency close failed for ${pos.ticker}: ${e.message}`);
      const idx = state.positions.findIndex(p => p.ticker === pos.ticker);
      if (idx !== -1) state.positions.splice(idx, 1);
    }
  }
  logEvent("circuit", `EMERGENCY CLOSE ALL complete - ${closed} closed, ${failed} failed`);
  try { await saveStateNow(); } catch(e) {}
  res.json({ ok: true, closed, failed, total: count });
});

app.post("/api/cancel-pending-orders", requireSecret, async (req, res) => {
  try {
    const openOrders = await alpacaGet("/orders?status=open&limit=50");
    if (!openOrders || !Array.isArray(openOrders)) return res.json({ ok: true, cancelled: 0, message: "No open orders found" });
    let cancelled = 0, failed = 0;
    for (const ord of openOrders) {
      try { await alpacaPost(`/orders/${ord.id}/cancel`, {}); cancelled++; }
      catch(e) { failed++; }
    }
    if (state._pendingOrder) { state._pendingOrder = null; await saveStateNow(); }
    res.json({ ok: true, cancelled, failed, message: `Cancelled ${cancelled} open orders` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/agent-auto-exit", requireSecret, (req, res) => {
  const { enabled } = req.body;
  state.agentAutoExitEnabled = !!enabled;
  markDirty();
  logEvent("scan", `[AGENT] Auto-exit ${enabled ? "ENABLED" : "DISABLED"}`);
  res.json({ ok: true, enabled: state.agentAutoExitEnabled });
});

app.get("/api/rescore/:ticker", async (req, res) => {
  const pos = (state.positions || []).find(p => p.ticker === req.params.ticker);
  if (!pos) return res.json({ error: "Position not found" });
  if (!ANTHROPIC_API_KEY) return res.json({ error: "Agent not configured" });
  req.setTimeout(60000); res.setTimeout(60000);
  try {
    const result = await getAgentRescore(pos);
    if (!result) return res.json({ error: "Agent returned no result" });
    pos._liveRescore = { ...result, updatedAt: new Date().toISOString() };
    res.json(pos._liveRescore);
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/api/spy", async (req, res) => {
  try {
    const [quote, bars, intradayBars] = await Promise.all([getStockQuote("SPY"), getStockBars("SPY", 2), getIntradayBars("SPY")]);
    const prevClose  = bars.length >= 2 ? bars[bars.length-2].c : null;
    const dayChange  = quote && prevClose ? parseFloat(((quote - prevClose) / prevClose * 100).toFixed(2)) : 0;
    const dayChangeDollar = quote && prevClose ? parseFloat((quote - prevClose).toFixed(2)) : 0;
    const chartBars  = (intradayBars || []).slice(-60).map(b => ({ t: b.t, c: b.c, o: b.o }));
    res.json({ price: quote ? parseFloat(quote.toFixed(2)) : null, prevClose: prevClose ? parseFloat(prevClose.toFixed(2)) : null, dayChange, dayChangeDollar, vix: state.vix || null, chartBars, updatedAt: new Date().toISOString() });
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/api/qqq", async (req, res) => {
  try {
    const [quote, bars, intradayBars] = await Promise.all([getStockQuote("QQQ"), getStockBars("QQQ", 2), getIntradayBars("QQQ")]);
    const prevClose  = bars.length >= 2 ? bars[bars.length-2].c : null;
    const dayChange  = quote && prevClose ? parseFloat(((quote - prevClose) / prevClose * 100).toFixed(2)) : 0;
    const dayChangeDollar = quote && prevClose ? parseFloat((quote - prevClose).toFixed(2)) : 0;
    const chartBars  = (intradayBars || []).slice(-60).map(b => ({ t: b.t, c: b.c, o: b.o }));
    res.json({ price: quote ? parseFloat(quote.toFixed(2)) : null, prevClose: prevClose ? parseFloat(prevClose.toFixed(2)) : null, dayChange, dayChangeDollar, chartBars, updatedAt: new Date().toISOString() });
  } catch(e) { res.json({ error: e.message }); }
});

app.get("/api/health", (req, res) => {
  const lastScan = state.lastScan ? new Date(state.lastScan) : null;
  const msSinceLastScan = lastScan ? Date.now() - lastScan.getTime() : 999999;
  res.json({ status: "ok", uptime: process.uptime(), lastScan: state.lastScan, msSinceLastScan, positions: state.positions.length, cash: state.cash, vix: state.vix, marketContext: getScannerState().marketContext, sharpe: calcSharpeRatio(), var95: calcVaR(), mae: calcMAE() });
});

app.post("/api/reset-month", requireSecret, async (req, res) => {
  const fmt = n => '$' + (n||0).toFixed(2);
  state.cash=MONTHLY_BUDGET+state.extraBudget; state.todayTrades=0;
  state.monthStart=new Date().toLocaleDateString(); state.dayStartCash=state.cash;
  state.circuitOpen=true; state.weeklyCircuitOpen=true; state.monthlyProfit=0;
  logEvent("reset",`Month reset - cash: ${fmt(state.cash)}`); res.json({ok:true});
});

app.post("/api/set-budget", requireSecret, async (req, res) => {
  try {
    const { budget } = req.body;
    const newBudget = parseFloat(budget);
    if (!newBudget || isNaN(newBudget) || newBudget < 1000 || newBudget > 1000000) return res.status(400).json({ ok: false, error: "Budget must be between $1,000 and $1,000,000" });
    state.customBudget = newBudget; state.cash = newBudget; state.dayStartCash = newBudget;
    state.weekStartCash = newBudget; state.peakCash = newBudget; state.accountBaseline = newBudget;
    state.alpacaEquity = newBudget; state.monthlyProfit = 0; state.monthStart = new Date().toLocaleDateString();
    await saveStateNow();
    logEvent("reset", `Budget set to $${newBudget.toFixed(2)} - all baselines reset.`);
    res.json({ ok: true, budget: newBudget, message: `Budget set to $${newBudget.toFixed(2)}.` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/reset-baseline", requireSecret, async (req, res) => {
  try {
    const acct = await alpacaGet("/account");
    const alpacaEquity  = acct ? parseFloat(acct.equity || acct.portfolio_value || acct.cash || MONTHLY_BUDGET) : MONTHLY_BUDGET;
    const newBaseline   = alpacaEquity > 0 ? alpacaEquity : MONTHLY_BUDGET;
    state.dayStartCash = newBaseline; state.weekStartCash = newBaseline; state.peakCash = newBaseline;
    state.accountBaseline = newBaseline; state.alpacaEquity = newBaseline; state.monthlyProfit = 0;
    state.monthStart = new Date().toLocaleDateString();
    await saveStateNow();
    logEvent("reset", `Baseline reset to $${newBaseline.toFixed(2)} (from Alpaca) - profit-lock cleared.`);
    res.json({ ok: true, newBaseline, message: `Baseline reset to $${newBaseline.toFixed(2)}.` });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/reset-account", requireSecret, async (req, res) => {
  const prevCash = state.cash;
  state.positions = []; state.closedTrades = []; state.tradeJournal = [];
  state.todayTrades = 0; state.monthlyProfit = 0; state.totalRevenue = 0;
  state.cash = MONTHLY_BUDGET; state.dayStartCash = MONTHLY_BUDGET; state.weekStartCash = MONTHLY_BUDGET;
  state.peakCash = MONTHLY_BUDGET; state.accountBaseline = null;
  state._macroReversalAt = null; state._macroReversalCount = 0; state._macroReversalSPY = null;
  state._scanFailures = 0; state._pendingOrder = null;
  state._alpacaDayTradeCount = 0; state._alpacaDayTradesLeft = 3; state.dayTrades = [];
  state._fillQuality = { count: 0, totalSlippage: 0, misses: 0, avgSlippage: 0 };
  state.circuitOpen = true; state.weeklyCircuitOpen = true;
  state.monthStart = new Date().toLocaleDateString();
  state._breadthHistory = []; state._agentRescoreMinute = {};
  state._spiralTracker = { put: 0, call: 0 }; state._spiralActive = null;
  state.scoreBrackets = {}; state.portfolioSnapshots = []; state._avoidUntil = null;
  state._macroDefensiveCooldown = {}; state._agentMacro = null;
  state._agentHealth = { calls: 0, successes: 0, timeouts: 0, parseErrors: 0, lastSuccess: null };
  state.streaks = { currentStreak: 0, currentType: null, maxWinStreak: 0, maxLossStreak: 0 };
  state._portfolioBetaDelta = 0; state._scanIntervals = []; state._avgScanIntervalMs = 0;
  // C1 Sunday 6/8: reset new fields
  state._dailyLossLockActive = false; state._dailyLossLockTriggeredAt = null;
  state._instrumentLossCount = {}; state._weeklyLossLockActive = false;
  state._monthlyLossLockActive = false; state._weeklyRealizedPnL = 0;
  markDirty(); await saveStateNow();
  logEvent("reset", `[V2.5] Clean account reset - previous cash: $${prevCash?.toFixed(2)||'?'} | ARGO state cleared`);
  res.json({ ok: true, message: "Account reset complete." });
});

app.get("/api/report", (req,res) => res.json({report:buildMonthlyReport()}));

app.get("/api/journal/debug", async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'}).split('/');
    const todayStr = `${today[2]}-${today[0]}-${today[1]}`;
    const entries = await loadJournalDay(todayStr);
    res.json({ today: todayStr, todayEntries: entries.length, redisUrl: process.env.REDIS_URL ? 'configured' : 'MISSING', redisToken: process.env.REDIS_TOKEN ? 'configured' : 'MISSING', stateTradeJournalLegacy: (state.tradeJournal||[]).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("SIGHUP",  () => gracefulShutdown("SIGHUP"));
process.on("unhandledRejection", (reason, promise) => {
  console.error("[ERROR] Unhandled rejection:", reason?.message || reason);
});

initState().then(async () => {
  await restoreBuffersFromRedis();   // repopulate today's log + telemetry buffers after a restart
  initAgent({
    logFn:               logEvent,
    markDirty:           markDirty,
    saveStateNow:        saveStateNow,
    closePosition:       closePosition,
    isDayTrade:          isDayTrade,
    countRecentDayTrades: countRecentDayTrades,
    getMacroNews:        getMacroNews,
    calcRSI:             calcRSI,
  });

  initReconciler({
    state:             state,
    logFn:             logEvent,
    redisSaveFn:       saveStateNow,
    calcCreditSpreadTP: calcCreditSpreadTP,
    markDirtyFn:       markDirty,
  });

  app.listen(PORT, () => {
    console.log(`APEX running on port ${PORT}`);
    console.log(`Alpaca key:  ${ALPACA_KEY?"SET":"NOT SET"}`);
    console.log(`Gmail:       ${GMAIL_USER||"NOT SET"}`);
    console.log(`Resend:      ${RESEND_API_KEY?"SET":"NOT SET - email disabled"}`);
    console.log(`Claude Agent:${ANTHROPIC_API_KEY?"SET":"NOT SET - using keyword fallback"}`);
    console.log(`Redis:       ${REDIS_URL?"SET":"NOT SET - using file fallback"}`);
    console.log(`Budget:      $${state.cash} | Floor: $${CAPITAL_FLOOR}`);
    console.log(`Positions:   ${state.positions.length} open`);
    console.log(`Trades:      ${(state.closedTrades||[]).length} closed trades in history`);
    // C1 Sunday 6/8 — feature flag boot log (added by deployment)
    // BUILD BANNER (6/16): self-report the live resolved model string + build tag so deploys are
    // verifiable from the first log line instead of waiting for a 404. Fresh require reads the
    // constants.js value that is ACTUALLY in this build.
    const _liveModel = require('./constants').ANTHROPIC_MODEL;
    console.log(`[BUILD] model=${_liveModel} | near-miss=on | deployed=${new Date().toISOString()}`);
  });
}).catch(e => {
  console.error("[BOOT] initState failed — Redis unreachable or corrupt:", e.message);
  app.listen(PORT, () => console.log(`ARGO running (degraded — Redis failed at boot)`));
  setInterval(() => runScan(), 10000);
});

// Backtest endpoints
app.post("/api/backtest", async (req, res) => {
  try {
    const { ticker="SPY", optionType="put", startDate, endDate, minScore=70, holdDays=5, takeProfitPct=0.50, stopLossPct=0.35, capital=10000 } = req.body || {};
    if (!startDate || !endDate) return res.status(400).json({ error: "startDate and endDate required (YYYY-MM-DD)" });
    const start = new Date(startDate); const end = new Date(endDate);
    const daysDiff = (end - start) / (1000 * 60 * 60 * 24);
    if (daysDiff < 30)  return res.status(400).json({ error: "Date range must be at least 30 days" });
    if (daysDiff > 730) return res.status(400).json({ error: "Date range cannot exceed 2 years" });
    const { maxPositions=3, putOnly=false, callSizeMult=1.0 } = req.body || {};
    const result = await runBacktest({ ticker, optionType, startDate, endDate, minScore: parseInt(minScore), holdDays: parseInt(holdDays), takeProfitPct: parseFloat(takeProfitPct), stopLossPct: parseFloat(stopLossPct), capital: parseFloat(capital), maxPositions: parseInt(maxPositions), putOnly: Boolean(putOnly), callSizeMult: parseFloat(callSizeMult), useSpread: req.body.useSpread !== false, useRegimeB: req.body.useRegimeB !== false, spreadWidth: req.body.spreadWidth ? parseFloat(req.body.spreadWidth) : null });
    res.json(result);
  } catch(e) { logEvent("error", `[BACKTEST] Error: ${e.message}`); res.status(500).json({ error: e.message }); }
});

app.post("/api/backtest/stress", async (req, res) => {
  try {
    const { ticker="SPY", optionType="put", capital=10000 } = req.body || {};
    const scenarios = [
      { name: "COVID Crash (Feb-Apr 2020)", startDate: "2020-01-15", endDate: "2020-04-30" },
      { name: "Rate Hike Selloff (2022)",   startDate: "2022-01-03", endDate: "2022-10-15" },
      { name: "SVB Crisis (Mar 2023)",       startDate: "2023-02-01", endDate: "2023-04-30" },
      { name: "Aug 2024 Vol Spike",          startDate: "2024-07-01", endDate: "2024-09-30" },
      { name: "Tariff Sell-off (Mar 2025)",  startDate: "2025-02-01", endDate: "2025-04-01" },
    ];
    const results = [];
    for (const s of scenarios) {
      const r = await runBacktest({ ticker, optionType, capital, minScore: 70, holdDays: 5, takeProfitPct: 0.50, stopLossPct: STOP_LOSS_PCT, ...s });
      results.push({ scenario: s.name, ...r.summary });
    }
    res.json({ ticker, optionType, stressTests: results });
  } catch(e) { logEvent("error", `[BACKTEST/STRESS] Error: ${e.message}`); res.status(500).json({ error: e.message }); }
});

app.post('/api/force-entry', async (req, res) => {
  if (!IS_PAPER_ACCOUNT) return res.status(403).json({ error: 'force-entry disabled in live trading' });
  const { ticker, optionType, confirm } = req.body || {};
  if (!confirm) return res.status(400).json({ error: 'must include confirm:true in body' });
  if (!ticker || !optionType) return res.status(400).json({ error: 'ticker and optionType required' });
  if (!['put','call'].includes(optionType)) return res.status(400).json({ error: 'optionType must be put or call' });
  const stock = WATCHLIST.find(s => s.ticker === ticker);
  if (!stock) return res.status(400).json({ error: `${ticker} not in WATCHLIST` });
  if (!stock.isIndex) return res.status(400).json({ error: `${ticker} is not an index instrument` });
  const _lastForce = state._lastForceEntry || 0;
  if (Date.now() - _lastForce < 30000) return res.status(429).json({ error: `Rate limited — wait ${Math.ceil((30000-(Date.now()-_lastForce))/1000)}s` });
  state._lastForceEntry = Date.now();
  try {
    logEvent("scan", `[FORCE ENTRY] ${ticker} ${optionType} — bypassing score/R/R gates — PIPELINE TEST`);
    const price = await getStockQuote(ticker);
    if (!price) return res.status(500).json({ error: 'could not fetch live price from Alpaca' });
    const rb = getRegimeRulebook(state);
    const pos = await executeCreditSpread(stock, price, 99, ['[FORCE ENTRY] pipeline test'], state.vix || 25, optionType, 0.5, rb.spreadParams);
    if (pos) {
      const orderId = state._pendingOrder?.orderId || '?';
      const credit  = state._pendingOrder?.netCredit || state._pendingOrder?.premium || '?';
      logEvent("scan", `[FORCE ENTRY] ✅ ${ticker} order submitted — orderId:${orderId}`);
      if (!state._forceEntries) state._forceEntries = [];
      state._forceEntries.push({ ticker, optionType, ts: Date.now(), orderId });
      markDirty();
      res.json({ success: true, message: 'Order submitted — awaiting fill.', orderId, credit });
    } else {
      res.json({ success: false, reason: 'executeCreditSpread returned null — check server log.' });
    }
  } catch(e) {
    logEvent("error", `[FORCE ENTRY] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});
