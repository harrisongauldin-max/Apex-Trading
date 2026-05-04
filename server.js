// server.js — APEX
// Express API shell, schedulers, and boot sequence (~600 lines).
'use strict';

const express = require('express');
const cron    = require('node-cron');
const path    = require('path');
const fs      = require('fs');

const { state, markDirty, saveStateNow, flushStateIfDirty,
        logEvent, redisSave, redisLoad, defaultState,
        saveDailyLogToRedis, getETDateStr }               = require('./state');
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
const { runBacktest }                                     = require('./backtest');
const { sendEmail, sendMorningBriefing, sendResendEmail,
        initReporting, setReportingContext,
        buildMonthlyReport, premarketAssessment,
        updateAfterHoursContext }                         = require('./reporting');
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
  ALPACA_OPT_SNAP, MONTHLY_BUDGET, CAPITAL_FLOOR,
  REDIS_URL, REDIS_TOKEN, REDIS_KEY, REDIS_SAVE_INTERVAL,
  ANTHROPIC_API_KEY, RESEND_API_KEY, GMAIL_USER, MARKETAUX_KEY,
  WATCHLIST, PDT_RULE_ACTIVE, PDT_LIMIT, MAX_HEAT, STOP_LOSS_PCT,
  TAKE_PROFIT_PCT, FAST_STOP_HOURS, MS_PER_DAY, SCAN_INTERVAL,
  TRIGGER_COOLDOWN_MS, SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL,
  MACRO_REVERSAL_PCT, SCAN_WATCHDOG_MS: _SCAN_WATCHDOG_MS,
  INDIVIDUAL_STOCKS_ENABLED, INDIVIDUAL_STOCK_WATCHLIST, STATE_FILE,
} = require('./constants');

const app  = express();
const PORT = process.env.PORT || 3000;
let isShuttingDown = false;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

setBrokerLogger((type, msg) => logEvent(type, msg), null);

function requireSecret(req, res, next) {
  if (!ARGO_SECRET) {
    // No secret configured -- log warning but allow (backwards compat during deploy)
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
    // - STATE VALIDATION -
    // Validate loaded state before using it - corrupt or empty state
    // is more dangerous than starting fresh, especially in live trading
    const isValid = (
      typeof saved.cash === 'number' && saved.cash >= 0 &&
      Array.isArray(saved.positions) &&
      Array.isArray(saved.closedTrades)
    );

    if (!isValid) {
      console.error("[STATE] CRITICAL: Loaded state failed validation - fields missing or corrupt");
      console.error("[STATE] Raw loaded cash:", saved.cash, "| positions type:", typeof saved.positions);
      console.error("[STATE] Starting fresh - check Redis data integrity");
      // Don't use corrupt state - fall through to defaultState
    } else {
      // Suspicious state check - $10k cash with no trades is normal on first run
      // but $10k cash after weeks of trading means something reset unexpectedly
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

  // customBudget = the budget ceiling set by user (starting amount)
  // state.cash   = actual current cash (changes with every trade - DO NOT override)
  // Only restore customBudget on a genuinely fresh state (no trade history)
  // If we have trade history, cash is already correct from Redis - don't touch it
  if (state.customBudget && state.customBudget > 0 && state.customBudget !== MONTHLY_BUDGET) {
    const isFreshState = (state.closedTrades || []).length === 0 && (state.positions || []).length === 0;
    if (isFreshState) {
      // Fresh account - set cash to customBudget as the starting balance
      state.cash = state.customBudget;
      console.log("[STATE] Fresh account - setting cash to custom budget: $" + state.customBudget);
    } else {
      // Has trade history - cash is already accurate from Redis, don't override
      console.log("[STATE] Custom budget: $" + state.customBudget + " | Current cash: $" + state.cash + " (preserved from Redis)");
    }
  }

  // - Consolidate duplicate credit spread positions (same ticker/strikes) -
  // If ARGO entered the same credit spread multiple times (stagger bug),
  // merge them into one position with summed contracts to match Alpaca reality
  if (state.positions) {
    const creditSpreads = state.positions.filter(p => p.isCreditSpread);
    const seen = new Map();
    const toRemove = new Set();
    for (let i = 0; i < creditSpreads.length; i++) {
      const pos = creditSpreads[i];
      const key = `${pos.ticker}|${pos.optionType}|${pos.buyStrike}|${pos.sellStrike}|${pos.expDate}`;
      if (seen.has(key)) {
        // Duplicate - merge contracts into the first, remove this one
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

  // - Fix maxProfit/maxLoss for credit spread positions (were wrong values) -
  // Recalculate from spread width and premium to ensure correct total dollar values
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
      // Debit spreads: maxProfit = (width - netDebit) * 100 * contracts
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

  // - Reset stale currentPrice for credit spreads -
  // currentPrice for credit spreads should be sellMid-buyMid, not the long leg price
  // If it looks like a leg price (> spreadWidth/2 + premium), it's stale - reset to premium
  if (state.positions) {
    for (const pos of state.positions) {
      if (pos.isCreditSpread && pos.currentPrice && pos.premium) {
        const width = Math.abs((pos.buyStrike||0) - (pos.sellStrike||0));
        // If currentPrice > spread width it's definitely wrong (long leg price leaked in)
        if (pos.currentPrice > width) {
          console.log(`[STARTUP] Resetting stale currentPrice for ${pos.ticker} credit spread: $${pos.currentPrice} - $${pos.premium}`);
          pos.currentPrice = pos.premium;
          pos.peakPremium  = pos.premium;
        }
      }
    }
  }

  // - Sanitize cached agentMacro - fix stale mode field from old builds -
  // Old builds stored mode directly from agent which could be wrong
  // Always re-derive mode from signal on startup
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

  // - Cancel any open orders from previous session -
  // Prevents dangling mleg orders from partial fills or crashes
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

    // Force-close Alpaca positions for tickers not in active watchlist (e.g. IWM)
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
  // Clear any pending order state from previous session
  state._pendingOrder = null;

  // - SEED IVR ROLLING WINDOW from VIXY historical bars -
  // Cold start problem: _vixRolling starts empty or with only a few readings
  // all near today's VIX, producing a range like [30.8-31.0] - IVR 9.
  // Fix 1: try SIP feed (has full history), then IEX, then VIX-aware formula.
  // Fix 2: validate that seed produced a meaningful range (>10pt spread).
  //        If not, fall back to formula: IVR = clamp((VIX-12)/33*100, 30, 95).
  //        At VIX 31 - IVR 58 (elevated). At VIX 37 - IVR 76 (high). Correct.
  // Seed if array is empty, thin, OR has a narrow range (all same VIX = stale accumulation)
  // Range < 5pts means 252 entries all at VIX ~31 - useless for percentile calculation
  const _ivRollingRange = state._vixRolling && state._vixRolling.length >= 5
    ? Math.max(...state._vixRolling) - Math.min(...state._vixRolling) : 0;
  // Re-seed if: empty, thin, narrow range (<15pt), OR no low-VIX days seen
  // "No low-VIX baseline" = min > 22, meaning window is all-high-vol intraday
  // scans. This is the cold-start problem: 252 scans ≠ 252 trading days.
  const _ivRollingMin = state._vixRolling && state._vixRolling.length > 0
    ? Math.min(...state._vixRolling) : 99;
  const _needsSeed = !state._vixRolling || state._vixRolling.length < 30
    || _ivRollingRange < 15 || _ivRollingMin > 22;
  if (_needsSeed) {
    try {
      const endDate   = new Date().toISOString().split("T")[0];
      const startDate = new Date(Date.now() - 380 * 86400000).toISOString().split("T")[0];
      let vixyBars = null;
      // Try SIP first (has full 1yr history), then IEX
      for (const feed of ["sip", "iex"]) {
        const resp = await alpacaGet(`/stocks/VIXY/bars?timeframe=1Day&start=${startDate}&end=${endDate}&limit=260&feed=${feed}`, ALPACA_DATA);
        if (resp && resp.bars && resp.bars.length > 60) { vixyBars = resp.bars; break; }
      }
      let seeded = false;
      if (vixyBars && vixyBars.length > 60) {
        // VIXY - VIX * 0.85 - invert to approximate VIX
        const seedReadings = vixyBars.map(b => parseFloat((b.c / 0.85).toFixed(2)));
        const seedMin = Math.min(...seedReadings);
        const seedMax = Math.max(...seedReadings);
        if (seedMax - seedMin >= 10) {
          // Valid range - seed is meaningful
          // V2.83: use P5-P95 trimmed range to prevent outlier poisoning
          state._vixRolling = seedReadings.slice(-252);
          const sortedSeed  = [...state._vixRolling].sort((a, b) => a - b);
          const seedP5  = sortedSeed[Math.floor(sortedSeed.length * 0.05)] || seedMin;
          const seedP95 = sortedSeed[Math.floor(sortedSeed.length * 0.95)] || seedMax;
          const currentVIX  = state.vix || seedReadings[seedReadings.length - 1];
          const clampedVIX  = Math.min(Math.max(currentVIX, seedP5), seedP95);
          state._ivRank = seedP95 > seedP5
            ? parseFloat(((clampedVIX - seedP5) / (seedP95 - seedP5) * 100).toFixed(1))
            : 50;
          state._ivEnv  = state._ivRank >= 70 ? "high" : state._ivRank >= 50 ? "elevated" : state._ivRank >= 30 ? "normal" : "low";
          console.log(`[IVR SEED] Seeded ${state._vixRolling.length} bars | P5-P95:[${seedP5.toFixed(1)}-${seedP95.toFixed(1)}] | AbsRange:[${seedMin.toFixed(1)}-${seedMax.toFixed(1)}] | IVR:${state._ivRank} (${state._ivEnv})`);
          seeded = true;
          markDirty();
        } else {
          console.log(`[IVR SEED] Data range too narrow (${seedMin.toFixed(1)}-${seedMax.toFixed(1)}) - using VIX formula`);
        }
      }
      if (!seeded) {
        // VIX-aware formula fallback - historically accurate percentile approximation
        // Calibrated to 2012-2024 VIX distribution: VIX 12=0th, VIX 22=50th, VIX 45=95th+
        const currentVIX = state.vix || 20;
        const formulaIVR = Math.min(95, Math.max(30, parseFloat(((currentVIX - 12) / 33 * 100).toFixed(1))));
        state._ivRank = formulaIVR;
        state._ivEnv  = formulaIVR >= 70 ? "high" : formulaIVR >= 50 ? "elevated" : formulaIVR >= 30 ? "normal" : "low";
        console.log(`[IVR SEED] Formula fallback: VIX ${currentVIX} - IVR ${formulaIVR} (${state._ivEnv})`);
        markDirty();
      }
    } catch(e) {
      // Last resort: VIX-aware formula, never default to 50 blindly
      const currentVIX = state.vix || 20;
      const formulaIVR = Math.min(95, Math.max(30, parseFloat(((currentVIX - 12) / 33 * 100).toFixed(1))));
      state._ivRank = formulaIVR;
      state._ivEnv  = formulaIVR >= 70 ? "high" : formulaIVR >= 50 ? "elevated" : formulaIVR >= 30 ? "normal" : "low";
      console.log(`[IVR SEED] Error fallback: VIX ${currentVIX} - IVR ${formulaIVR} | ${e.message}`);
    }
  }

  // - POSITION RECONCILIATION - runs on startup and every 5 minutes -
  await runReconciliation();


}

function gv(v, good, warn, bad) {
  if (v === undefined || v === null) return '<span class="gray">--</span>';
  if (typeof v === 'boolean') return v ? '<span class="' + (good||'yes') + '">YES</span>' : '<span class="no">no</span>';
  return '<span>' + v + '</span>';
}

function scoreColor(s, min) {
  if (s >= min) return 'green';
  if (s >= min * 0.85) return 'gold';
  return 'red';
}

function render(d) {
  const g = d.gates || {};
  const agentSig = d.agentSignal || '?';
  const agentConf = d.agentConf || '?';
  const agentBias = d.agentBias || '?';

  const sigColor = agentSig.includes('bearish') ? 'green' :
                   agentSig.includes('bullish') ? 'warn' : 'blue';
  const biasColor = agentBias === 'puts_on_bounces' ? 'green' :
                    agentBias === 'calls_on_dips' ? 'warn' :
                    agentBias === 'avoid' ? 'err' : 'blue';

  let html = '';

  // Gates section
  html += '<div class="section">';
  html += '<div class="section-title">=== GATES & CONTEXT ===</div>';
  html += '<div class="gate-grid">';
  html += gate('Agent Signal', '<span class="' + sigColor + '">' + agentSig.toUpperCase() + '</span> (' + agentConf + ')');
  html += gate('Entry Bias', '<span class="' + biasColor + '">' + agentBias.replace(/_/g,' ').toUpperCase() + '</span>');
  html += gate('Price Regime', (g.priceRegime||'?') + ' (' + (g.regimeDuration||0) + 'd below 200MA)');
  html += gate('Agent Regime', g.agentRegime || '?');
  html += gate('Regime Class', '<span class="' + (g.regimeClass==='B'||g.regimeClass==='C'?'gold':'green') + '">' + (g.regimeClass||'?') + '</span>');
  html += gate('VIX', '<span class="' + (g.vix>=30?'err':g.vix>=25?'gold':'green') + '">' + (g.vix||0).toFixed(1) + '</span>');
  html += gate('IVR', (g.ivr||0).toFixed(0) + ' | elevated: ' + (g.ivElevated?'<span class="yes">YES</span>':'<span class="no">no</span>'));
  html += gate('SPY Price', '$' + (g.spyPrice||0).toFixed(2));
  html += gate('SPY 50MA', '$' + (g.spy50MA||0).toFixed(2));
  html += gate('SPY 200MA', '$' + (g.spy200MA||0).toFixed(2));
  html += gate('Breadth', '<span class="' + (g.breadthPct<=40?'green':g.breadthPct<=60?'gold':'red') + '">' + (g.breadthPct||0).toFixed(0) + '%</span>');
  html += gate('Credit PUT', g.creditModeActive ? '<span class="yes">ACTIVE</span>' : '<span class="no">off</span>');
  html += gate('Credit CALL', g.creditCallModeActive ? '<span class="yes">ACTIVE</span>' : '<span class="no">off</span>');
  html += gate('Credit Allowed VIX', g.creditAllowedVIX ? '<span class="yes">YES</span>' : '<span class="err">NO</span>');
  html += gate('Choppy Block', g.isChoppyRegime ? '<span class="warn">ACTIVE</span>' : '<span class="no">no</span>');
  html += gate('Macro Bullish Block', g.macroBullish ? '<span class="err">BLOCKING</span>' : '<span class="no">no</span>');
  html += gate('200MA Call Block', g.below200MACallBlock ? '<span class="warn">ACTIVE</span>' : '<span class="no">no</span>');
  html += gate('VIX Falling Pause', g.vixFallingPause ? '<span class="warn">ACTIVE</span>' : '<span class="no">no</span>');
  html += gate('Post-Reversal Block', g.postReversalBlock ? '<span class="err">ACTIVE</span>' : '<span class="no">no</span>');
  html += gate('Avoid Hold', g.avoidHoldActive ? '<span class="err">ACTIVE until ' + (g.avoidUntilStr||'?') + '</span>' : '<span class="no">no</span>');
  html += gate('Target DTE', g.targetDTE + 'd');
  html += gate('Short Delta Target', (g.shortDeltaTarget||0).toFixed(2));
  html += gate('Min Credit Ratio', (g.minCreditRatio||0).toFixed(2));
  html += gate('Credit OTM%', ((g.creditOTMpct||0)*100).toFixed(0) + '%');
  html += '</div>';

  // Data signals section
  html += '<div style="margin-top:8px"><div class="section-title">Data Signals</div>';
  html += '<div class="data-signals">';
  html += ds('Credit Stress', g.creditStress, 'HYG+TLT both falling');
  html += ds('NVDA Weakness', g.nvdaWeakness, 'AI capex signal');
  html += ds('JPM Stress', g.jpmStress, 'Credit/bank signal');
  html += '</div></div>';

  // Agent reasoning
  if (d.agentReasoning) {
    html += '<div style="margin-top:8px;font-size:10px;color:#4a9aba;font-style:italic">"' + d.agentReasoning + '"</div>';
  }
  html += '</div>';

  // Per-instrument scores
  html += '<div class="section">';
  html += '<div class="section-title">=== SCORES ===</div>';
  (d.results || []).forEach(r => {
    if (r.noData) {
      html += '<div class="card"><span class="ticker">' + r.ticker + '</span> <span class="gray">— no scan data yet</span></div>';
      return;
    }
    const min = r.effectiveMin || 70;
    const best = r.bestScore || 0;
    const type = r.bestType || 'put';
    html += '<div class="card">';
    html += '<div class="ticker">' + r.ticker + ' <span style="font-size:10px;color:#4a7a9a">$' + (r.price||0).toFixed(2) + ' · ' + r.ageSec + 's ago</span></div>';
    html += '<div class="score-row">';
    html += '<div class="score-box"><div class="label">PUT</div><div class="val ' + scoreColor(r.putScore||0,min) + '">' + (r.putScore||0) + '</div></div>';
    html += '<div class="score-box"><div class="label">CALL</div><div class="val ' + scoreColor(r.callScore||0,min) + '">' + (r.callScore||0) + '</div></div>';
    html += '<div class="score-box"><div class="label">MIN</div><div class="val blue">' + min + '</div></div>';
    html += '<div class="score-box"><div class="label">BEST</div><div class="val ' + scoreColor(best,min) + '">' + best + ' ' + type.toUpperCase() + '</div></div>';
    if (r.wouldEnter) html += '<div class="would-enter">✓ WOULD ENTER</div>';
    if (!r.wouldEnter && (r.blocks||[]).length === 0 && r.bestScore < (r.effectiveMin||70)) {
      html += '<div style="background:#fff8e1;border:0.5px solid #fcd34d;border-radius:4px;padding:4px 8px;font-size:11px;color:#713f12">⚡ Score ' + r.bestScore + ' below min ' + (r.effectiveMin||70) + '</div>';
    }
    html += '</div>';
    if (r.constraint) html += '<div class="blocked">CONSTRAINT: ' + r.constraint + '</div>';
    (r.blocks||[]).forEach(b => { html += '<div class="blocked">⊘ ' + b + '</div>'; });
    (r.modeIndicators||[]).forEach(m => { html += '<div style="background:#e3f2fd;border:0.5px solid #90caf9;border-radius:4px;padding:3px 8px;font-size:11px;color:#1565c0;margin-bottom:3px">◈ MODE: ' + m + '</div>'; });
    const sigs = r.signals || {};
    if (Object.keys(sigs).length) {
      html += '<div class="signals">';
      if (sigs.rsi !== undefined) html += '<span class="sig">RSI ' + (sigs.rsi||0).toFixed(1) + '</span>';
      if (sigs.dailyRsi !== undefined) html += '<span class="sig">dRSI ' + (sigs.dailyRsi||0).toFixed(1) + '</span>';
      if (sigs.macd) html += '<span class="sig">MACD: ' + sigs.macd + '</span>';
      if (sigs.momentum) html += '<span class="sig">MOM: ' + sigs.momentum + '</span>';
      if (sigs.vwap) html += '<span class="sig">VWAP $' + (sigs.vwap||0).toFixed(2) + '</span>';
      html += '</div>';
    }
    const reasons = type === 'put' ? (r.putReasons||[]) : (r.callReasons||[]);
    if (reasons.length) {
      html += '<div class="reasons">' + reasons.map(rr => '· ' + rr).join('<br>') + '</div>';
    }
    html += '</div>';
  });
  html += '</div>';

  // Gate audit
  const audit = d.gateAudit || [];
  if (audit.length) {
    html += '<div class="section">';
    html += '<div class="section-title">=== GATE AUDIT (last 50) ===</div>';
    html += '<div class="audit">' + audit.map(a => {
      const ts = a.ts ? new Date(a.ts).toLocaleTimeString() : '--';
      return ts + ' | ' + (a.ticker||'?') + ' | ' + (a.gate||'?') + ': ' + (a.result||'?') + (a.reason ? ' — ' + a.reason : '');
    }).join('<br>') + '</div>';
    html += '</div>';
  }

  document.getElementById('content').innerHTML = html;
}

function ds(label, active, desc) {
  const col = active ? 'err' : 'gray';
  const icon = active ? '⚠' : '·';
  return '<div class="ds"><span class="' + col + '">' + icon + ' ' + label + '</span> <span class="gray">' + desc + '</span></div>';
}

async function load() {
  try {
    const r = await fetch('/api/score-debug');
    const d = await r.json();
    document.getElementById('ts').textContent =
      'Last scan: ' + (d.lastScan ? new Date(d.lastScan).toLocaleTimeString() : '--') +
      ' | Generated: ' + new Date(d.timestamp).toLocaleTimeString();
    render(d);
  } catch(e) {
    document.getElementById('content').innerHTML = '<div class="err">Error: ' + e.message + '</div>';
  }
}

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} received - saving state before exit`);

  // Stop accepting new scans
  // scanner.js will detect shutdown via process signal

  // Save state with retries - most critical operation on shutdown
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

  // Also save to local file as backup
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

// - F3: After-hours context update - every 15 min Mon-Fri outside market hours -
// Updates macro news, VIX proxy, Fear&Greed overnight
// Ensures APEX walks into market open with fresh context, not stale data
setInterval(() => {
  const day = getETTime().getDay();
  if (day >= 1 && day <= 5) updateAfterHoursContext();
}, 15 * 60 * 1000); // every 15 minutes

// Dedicated state flush every 30 seconds - decoupled from scan timing
// Ensures dirty state is persisted even if scan is slow or skipped
setInterval(() => {
  flushStateIfDirty().catch(e => console.error("Flush interval error:", e.message));
}, 30000);

// C2: Reconciliation interval — every 3 minutes during market hours
setInterval(async () => {
  const et  = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return;
  const etH = et.getHours() + et.getMinutes() / 60;
  if (etH < 9.5 || etH > 16.1) return;
  try { await runReconciliation(); } catch(e) { logEvent('warn', `[RECONCILE] Interval error: ${e.message}`); }
}, 3 * 60 * 1000);

// C3: Scan watchdog -- prevents permanent scanRunning=true lockout
// If a scan hangs (Redis timeout, API freeze), scanRunning stays true and
// subsequent scans are skipped silently. Watchdog force-resets after 90 seconds.
const SCAN_WATCHDOG_MS = 90 * 1000;
setInterval(() => {
  const _scanState = getScannerState();
  const lastStart = _scanState.lastScanStart || 0;
  if (_scanState.scanRunning && lastStart > 0 && (Date.now() - lastStart) > SCAN_WATCHDOG_MS) {
    logEvent("warn", `[WATCHDOG] Scan stuck ${((Date.now()-lastStart)/1000).toFixed(0)}s — force-resetting lock`);
    forceResetScanLock();
  }
}, 15 * 1000);

// - F4: Alpaca account balance sync every 60 seconds -
// syncCashFromAlpaca() syncs state.cash from Alpaca account after every trade
// and every 30 seconds. This eliminates cash drift between ARGO and Alpaca.

// - Alpaca cash sync interval - calls syncCashFromAlpaca every 30s -
setInterval(syncCashFromAlpaca, 5 * 60 * 1000); // OPT4: 5min — post-trade syncs handle fills immediately

// ── Headline-driven macro agent interval ──────────────────────────────────
// Replaces keyword-based getMacroNews() with getAgentMacroAnalysis().
// The agent call is gated internally by _shouldRunMacroAgent():
//   - Skips if no new headlines since last call (holds current signal)
//   - Runs immediately on emergency triggers (circuit breaker, margin calls, etc.)
//   - Forces run if signal is stale beyond 90 minutes
// On quiet days: agent may only run 10-15x instead of 80x. Active days: every cycle.
let _lastAgentInterval = 0;

async function _runMacroAgent(forceRun = false) {
  try {
    const headlines = await getMacroNews(state);
    const headlineList = (headlines?.headlines || headlines?.topStories || []);
    if (!headlineList.length) return;
    const result = await getAgentMacroAnalysis(headlineList, forceRun);
    if (result) {
      const sc = getScannerState();
      // Build authoritative macro context from agent result (no keyword scoring)
      sc.marketContext.macro = {
        signal:        result.signal,
        scoreModifier: result.modifier || 0,
        mode:          result.mode || 'normal',
        macroAuthority:'agent',
        confidence:    result.confidence,
        agentLastUpdated: result.timestamp || new Date().toISOString(),
        triggers:      result.catalysts || [],
        // Preserve keyword triggers field for log compatibility (empty)
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

// Run on startup during market hours — 5s delay for Redis rehydration
setTimeout(async () => {
  const et  = getETTime();
  const etH = et.getHours() + et.getMinutes() / 60;
  const day = et.getDay();
  if (day >= 1 && day <= 5 && etH >= 8.5 && etH <= 17.0) {
    logEvent("macro", "[AGENT] Running initial macro analysis on startup...");
    await _runMacroAgent(true); // force on startup — fresh boot always needs a signal
    _lastAgentInterval = Date.now();
  }
}, 5000);

// Intraday 3-minute polling REMOVED — agent directional accuracy 10.1% at 30min (n=74).
// Replaced with staleness-driven check in the scan loop below.
// Agent runs on:
//   1. Startup (fresh signal for the session)
//   2. Staleness > 90min — fired from scan loop, not a fixed interval
//   3. Emergency triggers (flash crash, market halt — detected by _shouldRunMacroAgent)
//   4. Overnight digest + pre-market compute
//
// Staleness-driven scan trigger — runs _runMacroAgent when signal is old
// but rate-limits to at most once per scan cycle (prevents concurrent calls)
let _agentStalenessCheck = 0;
setInterval(async () => {
  const et  = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return;
  const etH = et.getHours() + et.getMinutes() / 60;
  if (etH < 8.5 || etH > 17.0) return;
  // Only fire if signal is stale beyond 90 minutes
  const agentAge = state._agentMacro?.fetchedAt ? Date.now() - state._agentMacro.fetchedAt : Infinity;
  if (agentAge < 90 * 60 * 1000) return;
  // Debounce — don't fire more than once per 20 minutes
  if (Date.now() - _agentStalenessCheck < 20 * 60 * 1000) return;
  _agentStalenessCheck = Date.now();
  logEvent("macro", `[AGENT] Signal stale ${Math.round(agentAge/60000)}min — running refresh`);
  await _runMacroAgent(true);
}, 5 * 60 * 1000); // check every 5 minutes

// - F2: Pre-market carry-over assessment (9:00 AM ET) -
// Checks overnight positions against pre-market conditions
// Flags positions likely to need immediate action at open

// - EXPANDED AGENT SCHEDULE -
// Gives APEX strategic context 3.5 hours before first trade fires

// - All crons use ET hour check to handle EDT/EST automatically -
// Runs every 30 min UTC 10:00-15:00 on weekdays - checks ET hour inside
// This avoids duplicate firing from EDT+EST fallback pairs

// 6:00am ET deep scan (fires at :00 past the hour, checks ET hour = 6)
cron.schedule("0 10,11 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 6 && et.getMinutes() === 0) {
    logEvent("macro", "[DAY PLAN] 6:00am ET deep scan starting...");
    await getAgentDayPlan("6am-deep");
  }
});

// 7:30am ET brief (fires at :30 past the hour, checks ET hour = 7)
cron.schedule("30 11,12 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 7 && et.getMinutes() === 30) {
    logEvent("macro", "[DAY PLAN] 7:30am ET brief starting...");
    await getAgentDayPlan("7:30am-brief");
  }
});

// 8:30am ET (7:30am CT) final assessment + pre-market strike pre-computation
// This is the most important pre-open scan — runs with live pre-market prices
cron.schedule("30 12,13 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 8 && et.getMinutes() === 30) {
    logEvent("macro", "[DAY PLAN] 8:30am ET (7:30am CT) final assessment + pre-market compute starting...");
    // Run day plan first (fast, sets regime/signal baseline)
    await getAgentDayPlan("8:30am-final");
    // Then run pre-market compute (adds strike targets, instrument biases, gap analysis)
    // Slight delay so day plan is stored first
    await new Promise(r => setTimeout(r, 3000));
    await getAgentOvernightScan("premarket-compute");
  }
});

// 8:45am ET pre-market assessment email (fires at :45, checks ET hour = 8)
cron.schedule("45 12,13 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 8 && et.getMinutes() === 45) {
    await premarketAssessment();
  }
});

// 6:30am CT (7:30am ET) — pre-market daily bar seeding
// Fetches 60-day daily bars for all watchlist instruments and seeds _rsiHistory.
// Goal: ensure RSI is computed from real data before market open at 8:30am CT.
// Without this, the first 5 minutes of each session use stale or null RSI
// because getIntradayBars returns [] (no completed 1-min bars yet at open).
// By seeding dailyRsi from fresh daily bars 1 hour before open, the fallback
// path in scanner.js has real yesterday-close RSI to work with immediately.
cron.schedule("32 11,12 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 7 && et.getMinutes() === 32) {
    logEvent("scan", "[PRE-MARKET] 6:32am CT (7:32am ET) bar seeding — fetching daily bars for RSI pre-computation");
    const tickers = WATCHLIST.map(w => w.ticker);
    let seeded = 0;
    for (const ticker of tickers) {
      try {
        const bars = await getStockBars(ticker, 60);
        if (bars && bars.length >= 15) {
          // Compute RSI from daily bars and seed _rsiHistory
          const { calcRSI } = require('./signals');
          const rsi = calcRSI(bars);
          if (rsi !== null) {
            if (!state._rsiHistory) state._rsiHistory = {};
            const todayStr = getETDateStr(); // ET date string (not UTC toISOString)
            let hist = state._rsiHistory[ticker] || [];
            // Only add if we don't already have today's entry
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

// 9:00am ET morning reset + briefing (fires at :00, checks ET hour = 9)
cron.schedule("0 13,14 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() !== 9 || et.getMinutes() !== 0) return;
  state.dayStartCash      = state.cash;
  // Store last week's close every Friday for accurate weekStartCash
  const eodET = getETTime();
  if (eodET.getDay() === 5) { // Friday
    state.prevWeekClose = state.cash + openCostBasis();
    logEvent("scan", `[EOD] Friday close stored: $${state.prevWeekClose.toFixed(2)} - used for weekly P&L baseline`);
  }
  // Reset weekStartCash on Monday using Friday's close
  if (eodET.getDay() === 1 && state.prevWeekClose) {
    state.weekStartCash = state.prevWeekClose;
    logEvent("scan", `[SOW] Week start set from Friday close: $${state.weekStartCash.toFixed(2)}`);
  }
  state.todayTrades       = 0;
  state.consecutiveLosses = 0;
  state.circuitOpen       = true;
  state.tickerBlacklist   = []; // clear daily blacklist at market open
  // Prune stale state objects to keep Redis payload lean
  state._agentRescoreHour   = {}; // reset hourly tracker daily
  state._agentRescoreMinute = {}; // reset 30-min tracker daily
  state._macroReversalAt    = null; // clear reversal cooldown daily
  state._macroReversalCount = 0;
  state._macroReversalSPY   = null;
  // dayPlan is NOT cleared at market open - 6am/7:30am/8:30am scans set it fresh
  // Only clear if it's from a previous day
  const todayStr = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York'});
  if (state._dayPlanDate && state._dayPlanDate !== todayStr) {
    state._dayPlan     = null;
    state._dayPlanDate = null;
    logEvent("scan", "[DAY PLAN] Cleared stale day plan from previous session");
  }
  if (state._oversoldCount) {
    // Only keep tickers still in watchlist - prune closed/removed tickers
    const watchTickers = new Set(WATCHLIST.map(s => s.ticker));
    Object.keys(state._oversoldCount).forEach(t => { if (!watchTickers.has(t)) delete state._oversoldCount[t]; });
  }
  // Prune portfolio snapshots older than 30 days
  if (state.portfolioSnapshots && state.portfolioSnapshots.length > 2500) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    state.portfolioSnapshots = state.portfolioSnapshots.filter(s => new Date(s.t).getTime() > cutoff);
  }
  await saveStateNow();
  // - Proactive morning thesis review -
  // Before first scan, agent reviews all overnight positions
  // Flags thesis-broken positions for immediate exit at open
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

// EOD email 4:05pm ET - hour-aware to handle EDT/EST
// V2.83: also saves daily log to Redis for persistent log history (90-day retention)
cron.schedule("5 20,21 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 16 && et.getMinutes() === 5) {
    sendEmail("eod").catch(e => logEvent("error", `[EMAIL] EOD email failed: ${e.message}`));
    await saveDailyLogToRedis(true); // isEOD=true — wipes buffer after save for next day
  }
});

// 4:15pm ET post-market assessment - ET-hour aware
cron.schedule("15 20,21 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 16 && et.getMinutes() === 15) {
    logEvent("macro", "[POST-MARKET] 4:15pm ET assessment starting...");
    await getAgentPostMarketAssessment("4:15pm");
  }
});

// 6:00pm ET evening scan - ET-hour aware
cron.schedule("0 22,23 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 18 && et.getMinutes() === 0) {
    logEvent("macro", "[EVENING] 6:00pm ET scan starting...");
    await getAgentPostMarketAssessment("6pm-evening");
  }
});

// ── OVERNIGHT SCANS (CT-aware) ─────────────────────────────────────────────
// 11:00pm CT (midnight ET) — overnight news digest
// Fires at :00 UTC 05:00 on weekdays (11pm CT = 5am UTC next day, but we use ET check)
// Using 11pm CT = midnight ET: cron at UTC 04:00/05:00, check ET hour = 0
cron.schedule("0 4,5 * * 2-6", async () => {
  const et = getETTime();
  if (et.getHours() === 0 && et.getMinutes() === 0) {
    logEvent("macro", "[OVERNIGHT] 11pm CT midnight digest starting...");
    await getAgentOvernightScan("midnight-digest");
  }
});

// 9:25am ET daily P&L reset — belt-and-suspenders before market open.
// Zeros todayRealizedPnL and clears daily circuit so fresh day starts clean.
// The scanner's per-scan date check handles this too, but Railway restarts
// during weekends can leave stale state where _lastScanDate never changes.
// This cron is the authoritative daily reset — fires 5 min before open every weekday.
cron.schedule("25 13 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 9 && et.getMinutes() === 25) {
    const prev = state.todayRealizedPnL || 0;
    state.todayRealizedPnL  = 0;
    state._dailyPnL         = 0;
    state._dailyCircuitOpen = true;
    state.todayTrades       = 0;
    await saveStateNow();
    logEvent("circuit", `[MORNING RESET] Daily P&L zeroed before open (was $${prev.toFixed(0)}) — circuit armed for new session`);
  }
});

// 7:30am CT (8:30am ET) — pre-market strike pre-computation
// Fires at :30 UTC 12:00/13:00, already handled by existing 8:30am ET cron
// We extend the existing 8:30am ET cron to ALSO run the overnight premarket scan
// (handled below by modifying the existing cron logic)

// Saturday 8:00am ET weekly assessment - ET-hour aware
cron.schedule("0 12,13 * * 6", async () => {
  const et = getETTime();
  if (et.getHours() === 8 && et.getMinutes() === 0) {
    logEvent("macro", "[WEEKLY] Saturday 8:00am ET regime assessment starting...");
    await getAgentDayPlan("saturday-weekly");
  }
});

// Health check every 15 minutes during market hours (UTC 12-21 covers both EDT and EST market hours)
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

// Weekly reset Monday 9am ET - ET-hour aware
cron.schedule("0 13,14 * * 1", async () => {
  const et = getETTime();
  if (et.getHours() !== 9 || et.getMinutes() !== 0) return;
  state.weekStartCash     = state.cash;
  state.weeklyCircuitOpen = true;
  await saveStateNow();
  logEvent("reset", "Weekly circuit breaker reset");
});

// Monthly report - first Monday of month, 9am ET
cron.schedule("0 13,14 * * 1", async () => {
  const et = getETTime();
  if (et.getHours() !== 9 || et.getMinutes() !== 0) return;
  const day = et.getDate();
  if (day > 7) return; // only first Monday of month
  const report = buildMonthlyReport();
  logEvent("monthly", report);
  state.monthlyProfit = 0;
  state.monthStart    = new Date().toLocaleDateString();
  await saveStateNow();
  if (RESEND_API_KEY && GMAIL_USER) {
    sendResendEmail(
      `ARGO-V3.0 Monthly Report - ${et.toLocaleDateString("en-US",{month:"long",year:"numeric"})}`,
      `<pre style="font-family:monospace;background:#07101f;color:#cce8ff;padding:20px">${report}</pre>`
    );
  }
});

// - Express API -
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// C12: Shared-secret auth for destructive endpoints
// Set ARGO_SECRET env var in Railway. Without it all destructive ops are blocked.
const ARGO_SECRET = process.env.ARGO_SECRET || "";
function requireSecret(req, res, next) {
  if (!ARGO_SECRET) {
    // No secret configured -- log warning but allow (backwards compat during deploy)
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

app.get("/api/state", async (req, res) => {
  // Enrich positions with correct P&L display values.
  // Source of truth priority:
  // 1. pos.unrealizedPnL (set by reconciler from leg avg_entry_price vs current_price)
  //    Note: Alpaca's raw unrealized_pl is from their perspective (inverted). The reconciler
  //    corrects this and stores the trader's actual P&L.
  // 2. Fall back to (prem - cur) * 100 * c for credit, (cur - prem) for debit.
  const enrichedPositions = (state.positions || []).map(pos => {
    const c   = pos.contracts || 1;
    const prem = parseFloat(pos.premium) || 0;
    const cur  = parseFloat(pos.currentPrice) || prem;
    const maxProfitVal = parseFloat(pos.maxProfit) || Math.max(1, prem * 100 * c);
    let displayPnL;
    // Always recompute from live currentPrice — pos.unrealizedPnL can be stale from earlier
    // scans (e.g. set when GLD was up, not updated when it fell back). Stale unrealizedPnL
    // causes the dashboard to show a phantom gain while currentPrice shows the real loss.
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
    realizedPnL:   parseFloat(realizedPnL().toFixed(2)),
    totalCap:      totalCap(),
    stockValue:    parseFloat(stockValue().toFixed(2)),
    isMarketHours:      isMarketHours(),
    isEntryWindow:      isEntryWindow(),
    lastUpdated:        new Date().toISOString(),
    uptime:             process.uptime(),
    betaWeightedDelta:  calcBetaWeightedDelta(),
    dataQuality:        state.dataQuality || { realTrades: 0, estimatedTrades: 0, totalTrades: 0 },
    dataQualityPct:     (function() {
      // F1 fix: use real/(real+estimated) not real/totalTrades
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
    riskOfRuin:         calcRiskOfRuin(), // { probability, message }
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
  });
});

// - TEST ENDPOINT: Thesis integrity simulator -
// POST /api/test-thesis { ticker, mockRSI, mockMACD, mockMomentum, mockMacro, mockDays }
app.post("/api/test-thesis", (req, res) => {
  const { ticker, mockRSI=52, mockMACD="neutral", mockMomentum="steady", mockMacro="neutral", mockDays=1 } = req.body || {};
  const pos = (state.positions || []).find(p => p.ticker === ticker);
  if (!pos && !ticker) return res.json({ error: "provide ticker" });

  // Use real position if exists, otherwise build a mock
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
    entryConditions: {
      rsi: testPos.entryRSI, macd: testPos.entryMACD,
      momentum: testPos.entryMomentum, macro: testPos.entryMacro,
    },
    currentConditions: { rsi: mockRSI, macd: mockMACD, momentum: mockMomentum, macro: mockMacro },
    thesisIntegrity: integrity,
    timeAdjustedStop: `${(adjStop*100).toFixed(0)}%`,
    wouldClose: integrity.score < 20 ? "YES - thesis-collapsed" : adjStop < STOP_LOSS_PCT ? `YES - time-stop at ${(adjStop*100).toFixed(0)}%` : "NO",
  });
});

// - TEST ENDPOINT: Pre-entry agent check simulator -
// POST /api/test-pre-entry { ticker, mockRSI, mockMACD, mockMomentum, mockScore, optionType }
app.post("/api/test-pre-entry", async (req, res) => {
  const { ticker="TEST", mockRSI=70, mockMACD="bearish", mockMomentum="recovering", mockScore=85, optionType="put" } = req.body || {};
  const mockStock = {
    ticker, rsi: mockRSI, macd: mockMACD, momentum: mockMomentum,
  };
  const mockReasons = [`RSI ${mockRSI}`, `MACD ${mockMACD}`, `Momentum ${mockMomentum}`];
  try {
    const result = await getAgentPreEntryCheck(mockStock, mockScore, mockReasons, optionType);
    res.json({ ticker, mockScore, optionType, preEntryResult: result });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// - TEST ENDPOINT: Morning review simulator -
// POST /api/test-morning-review - runs morning review without closing positions
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

// - Score Debug API - reads score snapshots saved during last real scan -
// Zero extra API calls - data is always from the most recent scan pass
// ── Score Debug HTML Page ────────────────────────────────────
// Self-contained score debugger served at /score-debug
// Replaces any broken static file in public/ that previously served this
app.get("/score-debug", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARGO Score Debug</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:monospace;background:#080f1a;color:#c8dff0;font-size:12px;padding:12px}
  h1{font-size:14px;color:#00c4ff;letter-spacing:2px;margin-bottom:12px;border-bottom:1px solid #0d2a42;padding-bottom:8px}
  .ts{font-size:10px;color:#4a7a9a;margin-bottom:12px}
  .section{background:#0a1628;border:1px solid #0d2a42;border-radius:6px;padding:10px;margin-bottom:10px}
  .section-title{font-size:10px;color:#336688;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px}
  .gate-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px}
  .gate{background:#071020;border-radius:4px;padding:6px 8px}
  .gate-label{font-size:10px;color:#4a7a9a;margin-bottom:2px}
  .gate-val{font-size:12px;font-weight:500}
  .yes{color:#00ff88}.no{color:#4a7a9a}.warn{color:#ffd700}.err{color:#ff5555}
  .card{background:#071020;border:1px solid #0d2a42;border-radius:6px;padding:10px;margin-bottom:8px}
  .ticker{font-size:14px;color:#00c4ff;font-weight:700;margin-bottom:6px}
  .score-row{display:flex;gap:12px;align-items:center;margin-bottom:6px;flex-wrap:wrap}
  .score-box{background:#050d1a;border-radius:4px;padding:4px 10px;text-align:center;min-width:70px}
  .score-box .label{font-size:9px;color:#336688}
  .score-box .val{font-size:18px;font-weight:700}
  .green{color:#00ff88}.red{color:#ff5555}.gold{color:#ffd700}.blue{color:#00c4ff}.gray{color:#4a7a9a}
  .would-enter{background:#00ff8820;border:1px solid #00ff8860;border-radius:4px;padding:4px 8px;color:#00ff88;font-size:11px}
  .blocked{background:#ff555520;border:1px solid #ff555560;border-radius:4px;padding:4px 8px;color:#ff5555;font-size:11px;margin-bottom:4px}
  .reasons{background:#050d1a;border-radius:4px;padding:6px;margin-top:6px;font-size:10px;color:#6a9aba;line-height:1.5;max-height:120px;overflow-y:auto}
  .signals{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:10px;color:#6a9aba}
  .sig{background:#050d1a;padding:2px 6px;border-radius:3px}
  .refresh-btn{background:#0d2a42;border:1px solid #1a5080;color:#00c4ff;padding:6px 14px;border-radius:4px;cursor:pointer;font-family:monospace;font-size:11px;letter-spacing:1px;margin-bottom:12px}
  .refresh-btn:hover{background:#1a3a5a}
  .data-signals{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
  .ds{background:#071820;border:1px solid #0d2a42;border-radius:4px;padding:3px 8px;font-size:10px}
  .audit{font-size:10px;color:#4a7a9a;line-height:1.6;max-height:150px;overflow-y:auto}
</style>
</head>
<body>
<h1>⚡ ARGO SCORE DEBUG</h1>
<button class="refresh-btn" onclick="load()">↻ REFRESH</button>
<div id="ts" class="ts">Loading...</div>
<div id="content">Loading...</div>

<script>
async function load() {
  try {
    const r = await fetch('/api/score-debug');
    const d = await r.json();
    document.getElementById('ts').textContent =
      'Last scan: ' + (d.lastScan ? new Date(d.lastScan).toLocaleTimeString() : '--') +
      ' | Generated: ' + new Date(d.timestamp).toLocaleTimeString();
    render(d);
  } catch(e) {
    document.getElementById('content').innerHTML = '<div class="err">Error: ' + e.message + '</div>';
  }
}

function gv(v, good, warn, bad) {
  if (v === undefined || v === null) return '<span class="gray">--</span>';
  if (typeof v === 'boolean') return v ? '<span class="' + (good||'yes') + '">YES</span>' : '<span class="no">no</span>';
  return '<span>' + v + '</span>';
}

function scoreColor(s, min) {
  if (s >= min) return 'green';
  if (s >= min * 0.85) return 'gold';
  return 'red';
}

function render(d) {
  const g = d.gates || {};
  const agentSig = d.agentSignal || '?';
  const agentConf = d.agentConf || '?';
  const agentBias = d.agentBias || '?';

  const sigColor = agentSig.includes('bearish') ? 'green' :
                   agentSig.includes('bullish') ? 'warn' : 'blue';
  const biasColor = agentBias === 'puts_on_bounces' ? 'green' :
                    agentBias === 'calls_on_dips' ? 'warn' :
                    agentBias === 'avoid' ? 'err' : 'blue';

  let html = '';

  // Gates section
  html += '<div class="section">';
  html += '<div class="section-title">=== GATES & CONTEXT ===</div>';
  html += '<div class="gate-grid">';
  html += gate('Agent Signal', '<span class="' + sigColor + '">' + agentSig.toUpperCase() + '</span> (' + agentConf + ')');
  html += gate('Entry Bias', '<span class="' + biasColor + '">' + agentBias.replace(/_/g,' ').toUpperCase() + '</span>');
  html += gate('Price Regime', (g.priceRegime||'?') + ' (' + (g.regimeDuration||0) + 'd below 200MA)');
  html += gate('Agent Regime', g.agentRegime || '?');
  html += gate('Regime Class', '<span class="' + (g.regimeClass==='B'||g.regimeClass==='C'?'gold':'green') + '">' + (g.regimeClass||'?') + '</span>');
  html += gate('VIX', '<span class="' + (g.vix>=30?'err':g.vix>=25?'gold':'green') + '">' + (g.vix||0).toFixed(1) + '</span>');
  html += gate('IVR', (g.ivr||0).toFixed(0) + ' | elevated: ' + (g.ivElevated?'<span class="yes">YES</span>':'<span class="no">no</span>'));
  html += gate('SPY Price', '$' + (g.spyPrice||0).toFixed(2));
  html += gate('SPY 50MA', '$' + (g.spy50MA||0).toFixed(2));
  html += gate('SPY 200MA', '$' + (g.spy200MA||0).toFixed(2));
  html += gate('Breadth', '<span class="' + (g.breadthPct<=40?'green':g.breadthPct<=60?'gold':'red') + '">' + (g.breadthPct||0).toFixed(0) + '%</span>');
  html += gate('Credit PUT', g.creditModeActive ? '<span class="yes">ACTIVE</span>' : '<span class="no">off</span>');
  html += gate('Credit CALL', g.creditCallModeActive ? '<span class="yes">ACTIVE</span>' : '<span class="no">off</span>');
  html += gate('Credit Allowed VIX', g.creditAllowedVIX ? '<span class="yes">YES</span>' : '<span class="err">NO</span>');
  html += gate('Choppy Block', g.isChoppyRegime ? '<span class="warn">ACTIVE</span>' : '<span class="no">no</span>');
  html += gate('Macro Bullish Block', g.macroBullish ? '<span class="err">BLOCKING</span>' : '<span class="no">no</span>');
  html += gate('200MA Call Block', g.below200MACallBlock ? '<span class="warn">ACTIVE</span>' : '<span class="no">no</span>');
  html += gate('VIX Falling Pause', g.vixFallingPause ? '<span class="warn">ACTIVE</span>' : '<span class="no">no</span>');
  html += gate('Post-Reversal Block', g.postReversalBlock ? '<span class="err">ACTIVE</span>' : '<span class="no">no</span>');
  html += gate('Avoid Hold', g.avoidHoldActive ? '<span class="err">ACTIVE until ' + (g.avoidUntilStr||'?') + '</span>' : '<span class="no">no</span>');
  html += gate('Target DTE', g.targetDTE + 'd');
  html += gate('Short Delta Target', (g.shortDeltaTarget||0).toFixed(2));
  html += gate('Min Credit Ratio', (g.minCreditRatio||0).toFixed(2));
  html += gate('Credit OTM%', ((g.creditOTMpct||0)*100).toFixed(0) + '%');
  html += '</div>';

  // Data signals section
  html += '<div style="margin-top:8px"><div class="section-title">Data Signals</div>';
  html += '<div class="data-signals">';
  html += ds('Credit Stress', g.creditStress, 'HYG+TLT both falling');
  html += ds('NVDA Weakness', g.nvdaWeakness, 'AI capex signal');
  html += ds('JPM Stress', g.jpmStress, 'Credit/bank signal');
  html += '</div></div>';

  // Agent reasoning
  if (d.agentReasoning) {
    html += '<div style="margin-top:8px;font-size:10px;color:#4a9aba;font-style:italic">"' + d.agentReasoning + '"</div>';
  }
  html += '</div>';

  // Per-instrument scores
  html += '<div class="section">';
  html += '<div class="section-title">=== SCORES ===</div>';
  (d.results || []).forEach(r => {
    if (r.noData) {
      html += '<div class="card"><span class="ticker">' + r.ticker + '</span> <span class="gray">— no scan data yet</span></div>';
      return;
    }
    const min = r.effectiveMin || 70;
    const best = r.bestScore || 0;
    const type = r.bestType || 'put';
    html += '<div class="card">';
    html += '<div class="ticker">' + r.ticker + ' <span style="font-size:10px;color:#4a7a9a">$' + (r.price||0).toFixed(2) + ' · ' + r.ageSec + 's ago</span></div>';
    html += '<div class="score-row">';
    html += '<div class="score-box"><div class="label">PUT</div><div class="val ' + scoreColor(r.putScore||0,min) + '">' + (r.putScore||0) + '</div></div>';
    html += '<div class="score-box"><div class="label">CALL</div><div class="val ' + scoreColor(r.callScore||0,min) + '">' + (r.callScore||0) + '</div></div>';
    html += '<div class="score-box"><div class="label">MIN</div><div class="val blue">' + min + '</div></div>';
    html += '<div class="score-box"><div class="label">BEST</div><div class="val ' + scoreColor(best,min) + '">' + best + ' ' + type.toUpperCase() + '</div></div>';
    if (r.wouldEnter) html += '<div class="would-enter">✓ WOULD ENTER</div>';
    if (!r.wouldEnter && (r.blocks||[]).length === 0 && r.bestScore < (r.effectiveMin||70)) {
      html += '<div style="background:#fff8e1;border:0.5px solid #fcd34d;border-radius:4px;padding:4px 8px;font-size:11px;color:#713f12">⚡ Score ' + r.bestScore + ' below min ' + (r.effectiveMin||70) + '</div>';
    }
    html += '</div>';
    if (r.constraint) html += '<div class="blocked">CONSTRAINT: ' + r.constraint + '</div>';
    (r.blocks||[]).forEach(b => { html += '<div class="blocked">⊘ ' + b + '</div>'; });
    (r.modeIndicators||[]).forEach(m => { html += '<div style="background:#e3f2fd;border:0.5px solid #90caf9;border-radius:4px;padding:3px 8px;font-size:11px;color:#1565c0;margin-bottom:3px">◈ MODE: ' + m + '</div>'; });
    const sigs = r.signals || {};
    if (Object.keys(sigs).length) {
      html += '<div class="signals">';
      if (sigs.rsi !== undefined) html += '<span class="sig">RSI ' + (sigs.rsi||0).toFixed(1) + '</span>';
      if (sigs.dailyRsi !== undefined) html += '<span class="sig">dRSI ' + (sigs.dailyRsi||0).toFixed(1) + '</span>';
      if (sigs.macd) html += '<span class="sig">MACD: ' + sigs.macd + '</span>';
      if (sigs.momentum) html += '<span class="sig">MOM: ' + sigs.momentum + '</span>';
      if (sigs.vwap) html += '<span class="sig">VWAP $' + (sigs.vwap||0).toFixed(2) + '</span>';
      html += '</div>';
    }
    const reasons = type === 'put' ? (r.putReasons||[]) : (r.callReasons||[]);
    if (reasons.length) {
      html += '<div class="reasons">' + reasons.map(rr => '· ' + rr).join('<br>') + '</div>';
    }
    html += '</div>';
  });
  html += '</div>';

  // Gate audit
  const audit = d.gateAudit || [];
  if (audit.length) {
    html += '<div class="section">';
    html += '<div class="section-title">=== GATE AUDIT (last 50) ===</div>';
    html += '<div class="audit">' + audit.map(a => {
      const ts = a.ts ? new Date(a.ts).toLocaleTimeString() : '--';
      return ts + ' | ' + (a.ticker||'?') + ' | ' + (a.gate||'?') + ': ' + (a.result||'?') + (a.reason ? ' — ' + a.reason : '');
    }).join('<br>') + '</div>';
    html += '</div>';
  }

  document.getElementById('content').innerHTML = html;
}

function gate(label, val) {
  return '<div class="gate"><div class="gate-label">' + label + '</div><div class="gate-val">' + val + '</div></div>';
}

function ds(label, active, desc) {
  const col = active ? 'err' : 'gray';
  const icon = active ? '⚠' : '·';
  return '<div class="ds"><span class="' + col + '">' + icon + ' ' + label + '</span> <span class="gray">' + desc + '</span></div>';
}

load();
setInterval(load, 15000);
</script>
</body>
</html>`);
});

app.get("/api/score-debug", (req, res) => {
  try {
    // Score-debug gates built from entryEngine getRegimeRulebook  -- single source of truth
    // Dashboard now shows exactly what fired during the scan, not a re-derived approximation
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
      creditModeActive:    _dbRb.gates.creditPutActive,
      creditCallModeActive:_dbRb.gates.creditCallActive,
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

    // Build per-instrument results from scan snapshots
    const snapshots = state._scoreDebug || {};
    // Include both index ETFs and individual stocks in score debug
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

      // Reconstruct gate blocks for display
      const blocks = [...(snap.blocked || [])];
      // Use gates object — variables from outer scope aren't available here
      // NOTE: credit mode active is a MODE indicator, not a block — shown in gates section
      if (gates.isChoppyRegime && !gates.creditModeActive) blocks.push("choppy regime - debit blocked");
      if (gates.below200MACallBlock)                        blocks.push("SPY below 200MA - calls blocked");
      if (gates.macroBullish)                               blocks.push("macro aggressive - puts blocked");
      if (gates.vixFallingPause)                            blocks.push("VIX falling - puts paused");
      if (gates.avoidHoldActive)                            blocks.push(`avoid hold until ${gates.avoidUntilStr || "?"}`);
      // Mode indicators (shown separately, not as blocks)
      const modeIndicators = [];
      if (gates.creditModeActive)     modeIndicators.push("credit PUT mode");
      if (gates.creditCallModeActive) modeIndicators.push("credit CALL mode");

      const instrConstraint = INSTRUMENT_CONSTRAINTS[stock.ticker] || null;

      // Use credit score when in credit mode — it's the actual score that determines entry
      const activeCreditScore = snap.creditScore ?? null;
      const displayScore = activeCreditScore !== null ? activeCreditScore : bestScore;
      const displayType  = snap.creditType || bestType;
      const effectiveMin = snap.effectiveMin || (snap.creditType ? 65 : 70);
      const rrEst        = snap.rrEstimate || null;

      // wouldEnter: score must pass min AND R/R must be viable AND no blocks AND constraint ok
      const scorePassesMin = displayScore >= effectiveMin;
      const rrPassesMin    = !rrEst || rrEst.viable; // no estimate = don't penalize (non-credit)
      const constraintPass = !instrConstraint || instrConstraint.allowedTypes.includes(
        snap.creditType || (bestType === "put" ? "debit_put" : "debit_call")
      );

      // Build R/R block message if estimate says it will fail
      const rrBlock = (rrEst && !rrEst.viable)
        ? [`execution gate: ${rrEst.reason}`]
        : [];
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
      gateAudit:   (state._gateAudit || []).slice(-50).reverse(), // last 50, newest first
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/logs", (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || 200), 5000);
  const filter = req.query.filter || null; // e.g. ?filter=trade,warn,circuit
  const since  = req.query.since  || null; // ISO timestamp - only return newer
  const search = req.query.search || null; // text search across message
  const types  = filter ? filter.split(",").map(t => t.trim().toLowerCase()) : null;

  // Use daily log buffer (up to 5000 entries) when filtering or searching
  // Falls back to rolling tradeLog for unfiltered recent view
  const useFullDay = !!(types || since || search);
  let logs = useFullDay
    ? (state._dailyLogBuffer || state.tradeLog || []).slice().reverse() // daily buffer is oldest-first, reverse for newest-first
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

// V2.83: Historical log retrieval from Redis
// GET /api/logs/history?date=2026-04-09 -- retrieves archived daily log
// GET /api/logs/history -- lists available log dates (last 90 days)
app.get("/api/logs/history", async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: "Redis not configured" });
  try {
    const date = req.query.date;
    if (date) {
      // Fetch specific day
      const logKey = `argo:logs:${date}`;
      const resp   = await fetch(`${REDIS_URL}/get/${logKey}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const data = await resp.json();
      // If dedicated log key missing, fall back to live _dailyLogBuffer from state
      // This happens when: server restarted during the day, EOD cron not yet fired,
      // or multiple deploys wiped the in-memory buffer before 4:05pm save.
      let entries, summary, source;
      if (!data.result) {
        const todayStr = getETTime().toISOString().slice(0, 10);
        if (date === todayStr && state._dailyLogBuffer && state._dailyLogBuffer.length) {
          entries = state._dailyLogBuffer;
          summary = {
            totalEntries: entries.length,
            trades:  entries.filter(e => e.type === "trade").length,
            errors:  entries.filter(e => e.type === "error").length,
            warns:   entries.filter(e => e.type === "warn").length,
            cashEOD: state.cash,
            positionsEOD: state.positions.length,
            note: "live buffer — EOD save not yet triggered"
          };
          source = "live_buffer";
        } else {
          return res.status(404).json({ error: `No log found for ${date} — EOD save fires at 4:05pm ET. Use the manual save endpoint (/api/logs/save-now) to force-save the current buffer.` });
        }
      } else {
        const parsed = JSON.parse(data.result);
        entries = parsed.entries || [];
        summary = parsed.summary;
        source  = "redis";
      }
      const filter = req.query.filter;
      const limit  = Math.min(parseInt(req.query.limit || 5000), 10000);
      const types  = filter ? filter.split(",").map(t => t.trim().toLowerCase()) : null;
      if (types) entries = entries.filter(e => types.includes(e.type));
      res.json({ date, entries: entries.slice(0, limit), summary, source });
    } else {
      // List available dates -- scan Redis keys with argo:logs: prefix
      const resp = await fetch(`${REDIS_URL}/keys/argo:logs:*`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const data  = await resp.json();
      const dates = (data.result || [])
        .map(k => k.replace("argo:logs:", ""))
        .sort()
        .reverse(); // most recent first
      res.json({ available: dates, count: dates.length });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Force-save current _dailyLogBuffer to Redis (manual trigger for mid-day saves)
// Useful when: multiple deploys today, EOD cron hasn't fired yet, or debugging
app.post("/api/logs/save-now", async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: "Redis not configured" });
  try {
    const before = (state._dailyLogBuffer || []).length;
    await saveDailyLogToRedis(false); // isEOD=false — buffer retained after manual save
    const dateStr = getETDateStr();
    logEvent("scan", `[MANUAL SAVE] Daily log force-saved to Redis: argo:logs:${dateStr} | ${before} entries (buffer retained)`);
    res.json({ ok: true, date: dateStr, entries: before, note: "Buffer saved to Redis. Buffer retained in memory — logs continue accumulating." });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/scan",        async (req,res) => { res.json({ok:true}); runScan(); });

// - Test scan - forces a dry run scan regardless of market hours or day -
// Use this after-hours to verify scoring, filter logic, and exit checks
// Automatically re-disables dry run after the scan completes
app.post("/api/test-scan", async (req, res) => {
  if (getScannerState().scanRunning) return res.json({ error: "Scan already running" });
  const wasDryRun = false; // scanner owns dryRunMode state
  setDryRunMode(true);
  res.json({ ok: true, message: "Test scan started - dry run forced for this cycle. Check /api/logs for results." });
  try {
    await runScan();
  } finally {
    if (!wasDryRun) setDryRunMode(false); // restore previous state
  }
});
app.post("/api/close/:tkr", requireSecret,  async (req,res) => {
  const t          = req.params.tkr.toUpperCase();
  const contractId = req.query.sym || null; // optional contractSymbol for precision
  // Try to close by ticker (or exact contractSymbol if provided)
  const pos = contractId
    ? state.positions.find(p => p.contractSymbol === contractId || p.buySymbol === contractId)
    : state.positions.find(p => p.ticker === t);
  if (pos) {
    // Manual close always executes - bypasses PDT scan hold
    // (PDT hold is scan-loop logic, manual close is user intent)
    await closePosition(pos.ticker, "manual", null, pos.contractSymbol || pos.buySymbol);
    return res.json({ ok: true });
  }
  // Position not in state - try to close directly in Alpaca by symbol
  // This handles orphaned positions that reconciliation hasn't picked up yet
  try {
    const alpacaPositions = await alpacaGet("/positions");
    if (alpacaPositions && Array.isArray(alpacaPositions)) {
      const matching = alpacaPositions.filter(p =>
        p.symbol.startsWith(t) || p.symbol === t
      );
      if (matching.length === 0) return res.status(404).json({ error: "No position in ARGO or Alpaca" });
      // Close each matching Alpaca position at market
      for (const alpPos of matching) {
        const qty = Math.abs(parseInt(alpPos.qty));
        const side = parseInt(alpPos.qty) > 0 ? "sell" : "buy";
        const intent = parseInt(alpPos.qty) > 0 ? "sell_to_close" : "buy_to_close";
        await alpacaPost("/orders", {
          symbol: alpPos.symbol, qty, side, type: "market",
          time_in_force: "day", position_intent: intent,
        }).catch(e => logEvent("error", `Direct close ${alpPos.symbol}: ${e.message}`));
        logEvent("trade", `[MANUAL] Direct Alpaca close: ${alpPos.symbol} | ${qty}x ${side}`);
      }
      // Force reconciliation to update state
      await runReconciliation();
      return res.json({ ok: true, note: "Closed directly in Alpaca - state updated via reconciliation" });
    }
  } catch(e) {
    logEvent("error", `Manual close fallback failed: ${e.message}`);
  }
  res.status(404).json({ error: "No position found" });
});
// Manual AAII sentiment override - set weekly survey results manually
// AAII doesn't have a reliable public API - use this every Thursday after survey publishes
// POST { bullish: 28.5, bearish: 42.1, neutral: 29.4 }
app.post("/api/set-aaii", async (req, res) => {
  const { bullish, bearish, neutral } = req.body || {};
  if (!bullish || !bearish) return res.status(400).json({ error: "Need bullish and bearish percentages" });
  const spread  = bullish - bearish;
  const signal  = bullish < 20 ? "extreme_bearish"
                : bullish < 30 ? "bearish"
                : bullish > 55 ? "extreme_bullish"
                : bullish > 45 ? "bullish"
                : "neutral";
  state._aaiiManual = {
    bullish: parseFloat(bullish), bearish: parseFloat(bearish),
    neutral: parseFloat(neutral || (100 - bullish - bearish)),
    spread: parseFloat(spread.toFixed(1)), signal,
    date: new Date().toLocaleDateString(), manual: true,
  };
  state._aaii = state._aaiiManual;
  markDirty();
  logEvent("scan", `[AAII] Manual update: Bulls:${bullish}% Bears:${bearish}% (${signal})`);
  res.json({ ok: true, signal, spread: spread.toFixed(1) });
});

// Test email endpoint - sends a test email immediately
app.post("/api/test-email", async (req, res) => {
  if (!RESEND_API_KEY || !GMAIL_USER) {
    return res.json({ error: "Email not configured - set RESEND_API_KEY and GMAIL_USER in Railway env vars" });
  }
  // type=morning sends the full morning briefing for testing
  const type = (req.body && req.body.type) || "ping";
  try {
    if (type === "morning") {
      await sendMorningBriefing();
      logEvent("email", `Morning briefing test email sent to ${GMAIL_USER}`);
      return res.json({ ok: true, message: `Morning briefing sent to ${GMAIL_USER}` });
    }
    await sendResendEmail(
      `ARGO-V3.0 Email Test - ${new Date().toLocaleTimeString()}`,
      `<div style="font-family:monospace;background:#07101f;color:#00ff88;padding:20px;border-radius:8px">
        <h2>- ARGO-V3.0 Email Working</h2>
        <p style="color:#cce8ff">If you received this, Resend is configured correctly.</p>
        <p style="color:#336688">Recipient: ${GMAIL_USER}</p>
        <p style="color:#336688">Sent at: ${new Date().toISOString()}</p>
      </div>`
    );
    logEvent("email", `Test email sent to ${GMAIL_USER}`);
    res.json({ ok: true, message: `Test email sent to ${GMAIL_USER}` });
  } catch(e) {
    logEvent("error", `Test email failed: ${e.message} | code: ${e.code} | smtp: ${e.response || "none"}`);
    res.json({ ok: false, error: e.message, code: e.code || null, smtp: e.response || null, hint: "Check Railway logs for SMTP verification status on startup" });
  }
});

// Dry run scan - full scan logic, no orders, no state changes
app.post("/api/dry-run-scan", async (req, res) => {
  // Wait up to 35 seconds for any running scan to complete
  let waited = 0;
  while (getScannerState().scanRunning && waited < 35000) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }
  if (getScannerState().scanRunning) return res.json({ error: "Scan still running after 35s - try again" });
  setDryRunMode(true);
  logEvent("scan", "- DRY RUN SCAN STARTED -");
  try {
    await runScan();
  } finally {
    setDryRunMode(false);
    logEvent("scan", "- DRY RUN SCAN COMPLETE -");
  }
  // Return all dryrun log entries from this scan
  const dryLogs = state.tradeLog
    .filter(e => e.type === "dryrun" || (e.type === "filter" && new Date(e.time) > new Date(Date.now() - 120000)))
    .slice(0, 50);
  res.json({ ok: true, message: "Dry run complete - check server log for details", entries: dryLogs });
});

// Reset circuit breaker only - keeps positions and cash
// Reset PDT day trade counter - use when trades were miscounted
app.post("/api/reset-pdt", requireSecret, async (req, res) => {
  const before = (state.dayTrades || []).length;
  state.dayTrades = [];
  await redisSave(state);
  logEvent("warn", `[PDT] Day trade counter manually reset (had ${before} records) - 3/3 trades available`);
  res.json({ ok: true, message: `PDT counter reset. ${before} records cleared.` });
});

app.post("/api/reset-circuit", requireSecret, async (req, res) => {
  state.circuitOpen       = true;
  state.weeklyCircuitOpen = true;
  state.consecutiveLosses = 0;
  state.dayStartCash      = state.cash;
  // Store last week's close every Friday for accurate weekStartCash
  const eodET = getETTime();
  if (eodET.getDay() === 5) { // Friday
    state.prevWeekClose = state.cash + openCostBasis();
    logEvent("scan", `[EOD] Friday close stored: $${state.prevWeekClose.toFixed(2)} - used for weekly P&L baseline`);
  }
  // Reset weekStartCash on Monday using Friday's close
  if (eodET.getDay() === 1 && state.prevWeekClose) {
    state.weekStartCash = state.prevWeekClose;
    logEvent("scan", `[SOW] Week start set from Friday close: $${state.weekStartCash.toFixed(2)}`);
  } // reset daily baseline to current cash
  await saveStateNow();
  state._vixSpikeAt = null; // also clear VIX spike cooldown — allows debit puts to resume
  logEvent("circuit", "Circuit breaker manually reset - resuming normal operations");
  res.json({ ok: true, cash: state.cash, positions: state.positions.length });
});

// Reset daily P&L loss counter + daily circuit — paper trading only
// Clears todayRealizedPnL, _dailyCircuitOpen, and _dailyPnL so the system
// can resume entries regardless of how bad the day's realized losses were.
app.post("/api/reset-daily-pnl", requireSecret, async (req, res) => {
  const before = {
    todayRealizedPnL: state.todayRealizedPnL || 0,
    _dailyPnL:        state._dailyPnL || 0,
    _dailyCircuitOpen: state._dailyCircuitOpen,
  };
  state.todayRealizedPnL  = 0;
  state._dailyPnL         = 0;
  state._dailyCircuitOpen = true;
  await saveStateNow();
  logEvent("circuit", `[DAILY RESET] Daily P&L reset to $0 (was $${before.todayRealizedPnL.toFixed(0)}) — circuit cleared for paper trading`);
  res.json({ ok: true, before, after: { todayRealizedPnL: 0, _dailyPnL: 0, _dailyCircuitOpen: true } });
});

// Clear VIX spike cooldown separately (e.g. when spike was triggered by bad data)
app.post("/api/clear-vix-cooldown", requireSecret, async (req, res) => {
  state._vixSpikeAt = null;
  markDirty();
  await saveStateNow();
  logEvent("circuit", "VIX spike cooldown manually cleared");
  res.json({ ok: true, message: "VIX spike cooldown cleared — debit puts re-enabled" });
});

// Clear agent avoid hold (e.g. when triggered by a false emergency keyword match)
app.post("/api/clear-avoid", requireSecret, async (req, res) => {
  state._avoidUntil = null;
  markDirty();
  await saveStateNow();
  logEvent("circuit", "Agent avoid hold manually cleared — entries re-enabled");
  res.json({ ok: true, message: "Avoid hold cleared" });
});

// Clear entry attempt cooldowns — fires when orders are force-cleared due to connectivity
// failures (ECONNRESET etc.) that set false cooldowns even though no position was opened.
// Optional ?ticker=SPY to clear a single ticker, or clears all if not specified.
// Nuclear blocker clear — clears all active holds simultaneously:
// avoid hold, VIX cooldown, entry attempt cooldowns, pending order state.
// Use when ARGO is stuck after a connectivity failure or bad agent signal.
app.post("/api/clear-blocker", requireSecret, async (req, res) => {
  const cleared = [];
  if (state._avoidUntil) { state._avoidUntil = null; cleared.push("avoid hold"); }
  if (state._vixSpikeAt)  { state._vixSpikeAt  = null; cleared.push("VIX cooldown"); }
  if (state._entryAttemptCooldown && Object.keys(state._entryAttemptCooldown).length) {
    const tickers = Object.keys(state._entryAttemptCooldown).join(", ");
    state._entryAttemptCooldown = {};
    cleared.push(`entry cooldowns (${tickers})`);
  }
  if (state._pendingOrder) {
    const sym = state._pendingOrder.ticker || "unknown";
    state._pendingOrder = null;
    cleared.push(`pending order (${sym})`);
  }
  // Bug-spiral FIX: clear spiral so March 25th losses don't block April+ entries
  if (state._spiralActive) {
    cleared.push(`spiral block (${state._spiralActive})`);
    state._spiralActive = null;
  }
  if (state._spiralTracker && (state._spiralTracker.put >= 5 || state._spiralTracker.call >= 5)) {
    state._spiralTracker = { put: 0, call: 0 };
    cleared.push('spiral counters reset');
  }
  markDirty();
  await saveStateNow();
  const msg = cleared.length
    ? `Cleared: ${cleared.join(" | ")}`
    : "Nothing to clear — no active blockers";
  logEvent("circuit", `[CLEAR-BLOCKER] ${msg}`);
  res.json({ ok: true, message: msg, cleared });
});

app.post("/api/clear-entry-cooldown", requireSecret, async (req, res) => {
  const ticker = req.query.ticker || req.body?.ticker;
  if (ticker) {
    if (state._entryAttemptCooldown) {
      delete state._entryAttemptCooldown[ticker.toUpperCase()];
      logEvent("circuit", `Entry cooldown cleared for ${ticker.toUpperCase()} — re-entry enabled`);
    }
    markDirty();
    await saveStateNow();
    res.json({ ok: true, message: `Entry cooldown cleared for ${ticker.toUpperCase()}` });
  } else {
    state._entryAttemptCooldown = {};
    markDirty();
    await saveStateNow();
    logEvent("circuit", "All entry cooldowns cleared — re-entry enabled for all tickers");
    res.json({ ok: true, message: "All entry cooldowns cleared" });
  }
});

// Full reset - wipes everything back to fresh $10,000 state
app.post("/api/full-reset", requireSecret, async (req, res) => {
  // Cancel all open Alpaca positions first
  for (const pos of [...state.positions]) {
    try {
      const qty = Math.max(1, pos.contracts);
      if (pos.isSpread) {
        // Close both spread legs
        if (pos.buySymbol) await alpacaPost("/orders", { symbol: pos.buySymbol, qty, side:"sell", type:"market", time_in_force:"day", position_intent:"sell_to_close" }).catch(()=>{});
        if (pos.sellSymbol) await alpacaPost("/orders", { symbol: pos.sellSymbol, qty, side:"buy", type:"market", time_in_force:"day", position_intent:"buy_to_close" }).catch(()=>{});
      } else if (pos.contractSymbol) {
        const bidPrice = parseFloat((pos.bid > 0 ? pos.bid : pos.premium * 0.98).toFixed(2));
        await alpacaPost("/orders", { symbol: pos.contractSymbol, qty, side:"sell", type:"limit", time_in_force:"day", limit_price: bidPrice, position_intent:"sell_to_close" }).catch(()=>{});
      }
    } catch(e) { /* best effort */ }
  }
  // Reset state completely
  Object.assign(state, defaultState());
  await saveStateNow();
  logEvent("reset", `FULL RESET - state wiped, starting fresh with $${MONTHLY_BUDGET.toLocaleString()}`);
  res.json({ ok: true, message: "Full reset complete" });
});

// Emergency close all positions
app.post("/api/emergency-close", requireSecret, async (req, res) => {
  const snapshot = [...state.positions]; // snapshot before any mutations
  const count    = snapshot.length;
  let closed = 0, failed = 0;

  logEvent("circuit", `EMERGENCY CLOSE ALL initiated - ${count} positions`);

  for (const pos of snapshot) {
    try {
      const result = await closePosition(pos.ticker, "emergency-manual");
      if (result !== false) closed++;
      else failed++;
    } catch(e) {
      failed++;
      logEvent("error", `Emergency close failed for ${pos.ticker}: ${e.message}`);
      // Force remove even if closePosition errored
      const idx = state.positions.findIndex(p => p.ticker === pos.ticker);
      if (idx !== -1) state.positions.splice(idx, 1);
    }
  }

  logEvent("circuit", `EMERGENCY CLOSE ALL complete - ${closed} closed, ${failed} failed`);

  // Force save regardless of errors
  try { await saveStateNow(); } catch(e) { logEvent("error", `Post-emergency save failed: ${e.message}`); }

  res.json({ ok: true, closed, failed, total: count });
});

// - Agent auto-exit toggle endpoint -
// Cancel all open/pending orders on Alpaca — does NOT affect filled positions
// Use when ARGO has ghost orders that failed to cancel during retry
app.post("/api/cancel-pending-orders", requireSecret, async (req, res) => {
  try {
    const openOrders = await alpacaGet("/orders?status=open&limit=50");
    if (!openOrders || !Array.isArray(openOrders)) {
      return res.json({ ok: true, cancelled: 0, message: "No open orders found" });
    }
    let cancelled = 0, failed = 0;
    for (const ord of openOrders) {
      try {
        await alpacaPost(`/orders/${ord.id}/cancel`, {});
        cancelled++;
        logEvent("warn", `[CANCEL] Cancelled open order ${ord.id} (${ord.symbol || "mleg"} ${ord.side || ""} ${ord.qty || ""} @ ${ord.limit_price || "mkt"})`);
      } catch(e) {
        failed++;
        logEvent("warn", `[CANCEL] Failed to cancel order ${ord.id}: ${e.message}`);
      }
    }
    // Clear any pending order state in ARGO
    if (state._pendingOrder) {
      logEvent("warn", `[CANCEL] Cleared ARGO _pendingOrder state (was ${state._pendingOrder.ticker})`);
      state._pendingOrder = null;
      await saveStateNow();
    }
    logEvent("warn", `[CANCEL] Cancelled ${cancelled} orders, ${failed} failed`);
    res.json({ ok: true, cancelled, failed, message: `Cancelled ${cancelled} open orders` });
  } catch(e) {
    logEvent("error", `cancel-pending-orders: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.post("/api/agent-auto-exit", requireSecret, (req, res) => {
  const { enabled } = req.body;
  state.agentAutoExitEnabled = !!enabled;
  markDirty();
  logEvent("scan", `[AGENT] Auto-exit ${enabled ? "ENABLED" : "DISABLED"}`);
  res.json({ ok: true, enabled: state.agentAutoExitEnabled });
});

// - Live position rescore endpoint -
// Called by dashboard to get agent-powered live rescore for each position
app.get("/api/rescore/:ticker", async (req, res) => {
  const pos = (state.positions || []).find(p => p.ticker === req.params.ticker);
  if (!pos) return res.json({ error: "Position not found" });
  if (!ANTHROPIC_API_KEY) return res.json({ error: "Agent not configured - set ANTHROPIC_API_KEY in Railway" });
  // Set longer timeout for agent calls - tool use requires 2 round trips
  req.setTimeout(60000);
  res.setTimeout(60000);
  try {
    const result = await getAgentRescore(pos);
    if (!result) return res.json({ error: "Agent returned no result - check Railway logs" });
    pos._liveRescore = { ...result, updatedAt: new Date().toISOString() };
    res.json(pos._liveRescore);
  } catch(e) {
    res.json({ error: e.message });
  }
});

// - SPY live data endpoint -
app.get("/api/spy", async (req, res) => {
  try {
    const [quote, bars, intradayBars] = await Promise.all([
      getStockQuote("SPY"),
      getStockBars("SPY", 2),          // for day change %
      getIntradayBars("SPY"),          // 1-min bars for chart
    ]);
    const prevClose  = bars.length >= 2 ? bars[bars.length-2].c : null;
    const dayChange  = quote && prevClose ? parseFloat(((quote - prevClose) / prevClose * 100).toFixed(2)) : 0;
    const dayChangeDollar = quote && prevClose ? parseFloat((quote - prevClose).toFixed(2)) : 0;
    // Return last 60 1-min bars for the mini chart
    const chartBars  = (intradayBars || []).slice(-60).map(b => ({ t: b.t, c: b.c, o: b.o }));
    res.json({
      price:          quote ? parseFloat(quote.toFixed(2)) : null,
      prevClose:      prevClose ? parseFloat(prevClose.toFixed(2)) : null,
      dayChange,
      dayChangeDollar,
      vix:            state.vix || null,
      chartBars,
      updatedAt:      new Date().toISOString(),
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Test options chain endpoint - verify Pro data access
app.get("/api/test-options/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const price  = await getStockQuote(ticker);
  if (!price) return res.json({ error: "Could not get stock price" });

  // Test raw options contracts endpoint
  const today      = getETTime();
  const minExpiry  = new Date(today.getTime() + 7  * MS_PER_DAY).toISOString().split("T")[0];
  const maxExpiry  = new Date(today.getTime() + 60 * MS_PER_DAY).toISOString().split("T")[0];
  const strikeLow  = (price * 0.95).toFixed(0);
  const strikeHigh = (price * 1.05).toFixed(0);

  const params = `?underlying_symbol=${ticker}&expiration_date_gte=${minExpiry}&expiration_date_lte=${maxExpiry}&strike_price_gte=${strikeLow}&strike_price_lte=${strikeHigh}&type=call&limit=5`;

  // Try all possible base URL + path combinations
  const bases = [
    "https://paper-api.alpaca.markets/v2",
    "https://paper-api.alpaca.markets/v1beta1",
    "https://data.alpaca.markets/v2",
    "https://data.alpaca.markets/v1beta1",
    "https://api.alpaca.markets/v2",
  ];
  const pathSuffixes = [
    `/options/contracts${params}`,
    `/options/contracts/search${params}`,
  ];

  const results = {};
  for (const base of bases) {
    for (const path of pathSuffixes) {
      const key  = base + path;
      try {
        const res2 = await withTimeout(fetch(key, { headers: alpacaHeaders() }), 5000);
        const text = await res2.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch(e) { parsed = { raw: text.slice(0, 100) }; }
        results[key] = { status: res2.status, data: parsed };
        if (parsed && parsed.option_contracts && parsed.option_contracts.length > 0) {
          const sym  = parsed.option_contracts[0].symbol;
          // Try every possible snapshot variation
          const snapTests = {};
          const snapBases = [
            "https://paper-api.alpaca.markets/v2",
            "https://data.alpaca.markets/v2",
            "https://data.alpaca.markets/v1beta1",
            "https://api.alpaca.markets/v2",
          ];
          const snapFeeds = ["indicative", "opra", "sip", "iex", ""];
          for (const sb of snapBases) {
            for (const feed of snapFeeds) {
              const feedParam = feed ? `&feed=${feed}` : "";
              const snapUrl   = `/options/snapshots?symbols=${sym}${feedParam}`;
              const snapResp  = await alpacaGet(snapUrl, sb);
              if (snapResp && snapResp.snapshots && Object.keys(snapResp.snapshots).length > 0) {
                return res.json({
                  workingBase:       base,
                  workingSnapBase:   sb,
                  workingSnapFeed:   feed || "none",
                  workingSnapUrl:    sb + snapUrl,
                  contractsFound:    parsed.option_contracts.length,
                  firstContract:     parsed.option_contracts[0],
                  snapshotData:      snapResp.snapshots[sym],
                });
              }
              snapTests[`${sb}${snapUrl}`] = snapResp;
            }
          }
          return res.json({
            workingBase:    base,
            contractsFound: parsed.option_contracts.length,
            firstContract:  parsed.option_contracts[0],
            snapshotError:  "No snapshot endpoint returned data",
            snapTests,
          });
        }
      } catch(e) {
        results[base + path] = { error: e.message };
      }
    }
  }
  return res.json({ error: "No working endpoint found", results });
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  const lastScan = state.lastScan ? new Date(state.lastScan) : null;
  const msSinceLastScan = lastScan ? Date.now() - lastScan.getTime() : 999999;
  res.json({
    status:        "ok",
    uptime:        process.uptime(),
    lastScan:      state.lastScan,
    msSinceLastScan,
    positions:     state.positions.length,
    cash:          state.cash,
    vix:           state.vix,
    marketContext: getScannerState().marketContext,
    sharpe:        calcSharpeRatio(),
    var95:         calcVaR(),
    mae:           calcMAE(),
  });
});

// [duplicate /api/reset-circuit removed]

app.post("/api/reset-month", requireSecret, async (req, res) => {
  state.cash=MONTHLY_BUDGET+state.extraBudget; state.todayTrades=0;
  state.monthStart=new Date().toLocaleDateString(); state.dayStartCash=state.cash;
  state.circuitOpen=true; state.weeklyCircuitOpen=true; state.monthlyProfit=0;
  logEvent("reset",`Month reset - cash: ${fmt(state.cash)}`); res.json({ok:true});
});

// - Reset Baseline Only - clears profit-lock without wiping history -
// Use after Alpaca account resets where Redis still has old session data
// Preserves: closedTrades, tradeJournal, positions, P&L history
// Resets: dayStartCash, weekStartCash, peakCash, accountBaseline, monthlyProfit

app.post("/api/set-budget", requireSecret, async (req, res) => {
  try {
    const { budget } = req.body;
    const newBudget = parseFloat(budget);
    if (!newBudget || isNaN(newBudget) || newBudget < 1000 || newBudget > 1000000) {
      return res.status(400).json({ ok: false, error: "Budget must be between $1,000 and $1,000,000" });
    }

    // Update all baseline references to the new budget
    state.customBudget    = newBudget;
    state.cash            = newBudget;
    state.dayStartCash    = newBudget;
    state.weekStartCash   = newBudget;
    state.peakCash        = newBudget;
    state.accountBaseline = newBudget;
    state.alpacaEquity    = newBudget;
    state.monthlyProfit   = 0;
    state.monthStart      = new Date().toLocaleDateString();

    await saveStateNow();
    logEvent("reset", `Budget set to $${newBudget.toFixed(2)} - all baselines reset. Profit-lock cleared.`);
    res.json({ ok: true, budget: newBudget, message: `Budget set to $${newBudget.toFixed(2)}. All baselines updated.` });
  } catch(e) {
    logEvent("warn", `set-budget failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/reset-baseline", requireSecret, async (req, res) => {
  try {
    // Get live Alpaca equity (cash + open position value) as the new reference point
    const acct = await alpacaGet("/account");
    const alpacaEquity  = acct ? parseFloat(acct.equity || acct.portfolio_value || acct.cash || MONTHLY_BUDGET) : MONTHLY_BUDGET;
    const newBaseline   = alpacaEquity > 0 ? alpacaEquity : MONTHLY_BUDGET;

    // Reset financial reference points only - preserves trade history
    state.dayStartCash    = newBaseline;
    state.weekStartCash   = newBaseline;
    state.peakCash        = newBaseline;
    state.accountBaseline = newBaseline;
    state.alpacaEquity    = newBaseline; // sync so profit lock uses fresh value immediately
    state.monthlyProfit   = 0;
    state.monthStart      = new Date().toLocaleDateString();

    await saveStateNow();
    logEvent("reset", `Baseline reset to $${newBaseline.toFixed(2)} (from Alpaca) - profit-lock cleared. Trade history preserved.`);
    res.json({ ok: true, newBaseline, message: `Baseline reset to $${newBaseline.toFixed(2)}. Profit-lock cleared.` });
  } catch(e) {
    logEvent("warn", `reset-baseline failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// - V2.3 Clean Account Reset -
// Call after resetting the Alpaca paper account. Clears all ARGO state that
// would carry over incorrectly (positions, trades, P&L, PDT counts, fill quality).
// Cash and baselines are re-synced from Alpaca on the next scan automatically.
app.post("/api/reset-account", requireSecret, async (req, res) => {
  const prevCash = state.cash;
  // Clear positions and trade history
  state.positions       = [];
  state.closedTrades    = [];
  state.tradeJournal    = [];
  state.todayTrades     = 0;
  state.monthlyProfit   = 0;
  state.totalRevenue    = 0;
  // Reset cash to Alpaca default - will be corrected on next account sync
  state.cash            = MONTHLY_BUDGET;
  state.dayStartCash    = MONTHLY_BUDGET;
  state.weekStartCash   = MONTHLY_BUDGET;
  state.peakCash        = MONTHLY_BUDGET;
  state.accountBaseline = null; // will be set on next Alpaca sync
  // Reset risk tracking
  state._macroReversalAt    = null;
  state._macroReversalCount = 0;
  state._macroReversalSPY   = null;
  state._scanFailures       = 0;
  state._pendingOrder       = null;
  // Reset PDT tracking - Alpaca will resync on next account poll
  state._alpacaDayTradeCount = 0;
  state._alpacaDayTradesLeft = 3;
  state.dayTrades           = [];
  // Reset fill quality - start fresh data collection
  state._fillQuality = { count: 0, totalSlippage: 0, misses: 0, avgSlippage: 0 };
  // Reset circuit breakers
  state.circuitOpen         = true;
  state.weeklyCircuitOpen   = true;
  // Reset weekly/daily counters
  state.monthStart          = new Date().toLocaleDateString();
  // Clear breadth history and agent history
  // Note: IWM removed from watchlist (panel decision - 3yr net loser)
  // TLT added as bond hedge (panel unanimous)
  state._breadthHistory       = [];
  state._agentRescoreMinute   = {};
  // STATE-2: Clear all session-specific state to prevent stale data carry-over
  state._spiralTracker        = { put: 0, call: 0 };
  state._spiralActive         = null;
  state.scoreBrackets         = {};
  state.portfolioSnapshots    = [];
  state._avoidUntil           = null;
  state._macroDefensiveCooldown = {};
  state._agentMacro           = null; // force fresh agent analysis on next scan
  state._agentHealth          = { calls: 0, successes: 0, timeouts: 0, parseErrors: 0, lastSuccess: null };
  state.streaks               = { currentStreak: 0, currentType: null, maxWinStreak: 0, maxLossStreak: 0 };
  state._portfolioBetaDelta   = 0;
  state._scanIntervals        = [];
  state._avgScanIntervalMs    = 0;
  markDirty();
  await saveStateNow();
  logEvent("reset", `[V2.5] Clean account reset - previous cash: $${prevCash?.toFixed(2)||'?'} | ARGO state cleared | awaiting Alpaca sync`);
  res.json({ ok: true, message: "Account reset complete. ARGO state cleared. Cash will sync from Alpaca on next scan." });
});
app.get("/api/journal",      (req,res) => res.json((state.tradeJournal||[]).slice(0,100))); // full unstripped entries
app.get("/api/report",       (req,res) => res.json({report:buildMonthlyReport()}));

// - New Feature Endpoints -

// - Earnings Play Engine -
// Buy ATM straddle (call + put) 14-21 days before earnings when IV is still cheap
// Exit before earnings announcement to capture IV expansion (avoid IV crush)

const EARNINGS_PLAY_MIN_DTE  = 14;  // enter at least 14 days before earnings
const EARNINGS_PLAY_MAX_DTE  = 21;  // enter no more than 21 days before earnings
const EARNINGS_PLAY_MAX_IVR  = 45;  // only when options are still cheap
const EARNINGS_PLAY_EXIT_DTE = 2;   // exit 2 days before earnings

// - Analytics stubs - simplified for SPY/QQQ strategy -
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



// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM")); // Railway deploy
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));  // Ctrl+C / manual stop
process.on("SIGHUP",  () => gracefulShutdown("SIGHUP"));  // Terminal hangup

// Unhandled rejection safety net - log but don't crash
process.on("unhandledRejection", (reason, promise) => {
  console.error("[ERROR] Unhandled rejection:", reason?.message || reason);
  // Don't exit - log and continue
});

// Boot sequence - load state from Redis then start server
initState().then(() => {
  // Wire agent dependencies — must run before any agent calls
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

  // Wire reconciler dependencies — must run before runReconciliation()
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
    console.log(`Resend:      ${RESEND_API_KEY?"SET -":"NOT SET - email disabled"}`);
    console.log(`Marketaux:   ${process.env.MARKETAUX_KEY?"SET -":"NOT SET - add key for credible source news"}`);
    console.log(`Claude Agent:${ANTHROPIC_API_KEY?"SET - - AI macro analysis + rescore enabled":"NOT SET - using keyword fallback"}`);
    console.log(`Redis:       ${REDIS_URL?"SET":"NOT SET - using file fallback"}`);
    console.log(`Budget:      $${state.cash} | Floor: $${CAPITAL_FLOOR}`);
    console.log(`Positions:   ${state.positions.length} open`);
    console.log(`Trades:      ${(state.closedTrades||[]).length} closed trades in history`);
    console.log(`Scan:        every 10 seconds, 9AM-4PM ET Mon-Fri (SPY/QQQ only)`);
    console.log(`Entry window: 9:30AM-3:45PM ET (SPY/QQQ spreads primary)`);
  });
}).catch(e => {
  console.error("[BOOT] initState failed — Redis unreachable or corrupt:", e.message);
  console.error("[BOOT] Starting with default state. Positions and cash may be wrong.");
  // Start server anyway so Railway doesn't crash-loop — state will be empty but system is alive
  app.listen(PORT, () => console.log(`ARGO running (degraded — Redis failed at boot)`));
  setInterval(() => runScan(), 10000); // still scan, will use default empty state
});;

// -
// APEX - BACKTESTING ENGINE
// Walk-forward simulation using Alpaca historical daily bars
// Replays ARGO's scoring logic against historical data without real orders
// QS-W2/GL-1: Addresses the out-of-sample validation gap identified by panel
// -




// - V2.80 Spread P&L Simulator -
// Debit spread: buy ATM, sell OTM - capped loss (net debit) and capped profit (width - debit)
// Credit spread: sell OTM, buy further OTM - capped profit (net credit) and capped loss (width - credit)
// This is fundamentally different from single-leg option P&L.
// Panel requirement: backtest must use spread structure, not naked option approximation.

// - V2.80 Regime B Scoring -
// Adds regime classification to backtest scoring - mirrors live ARGO's regime logic.
// Regime A (bull): SMA20 > SMA50, price > SMA20, positive momentum - calls favored
// Regime B (bear): price < SMA50, SMA20 < SMA50, negative momentum - puts on bounces
// Regime C (crisis): price < SMA200, sustained VIX > 35 - credit only
// Returns regime class + suggested trade type for backtest routing.


// - Backtest API endpoint -
app.post("/api/backtest", async (req, res) => {
  try {
    const {
      ticker     = "SPY",
      optionType = "put",
      startDate,
      endDate,
      minScore   = 70,
      holdDays   = 5,
      takeProfitPct = 0.50,
      stopLossPct   = 0.35,
      capital    = 10000,
    } = req.body || {};

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate required (YYYY-MM-DD)" });
    }

    // Validate date range
    const start = new Date(startDate);
    const end   = new Date(endDate);
    const daysDiff = (end - start) / (1000 * 60 * 60 * 24);
    if (daysDiff < 30)  return res.status(400).json({ error: "Date range must be at least 30 days" });
    if (daysDiff > 730) return res.status(400).json({ error: "Date range cannot exceed 2 years" });

    const { maxPositions = 3, putOnly = false, callSizeMult = 1.0 } = req.body || {};
    const result = await runBacktest({
      ticker,
      optionType, // supports "put", "call", or "both"
      startDate, endDate,
      minScore:      parseInt(minScore),
      holdDays:      parseInt(holdDays),
      takeProfitPct: parseFloat(takeProfitPct),
      stopLossPct:   parseFloat(stopLossPct),
      capital:       parseFloat(capital),
      maxPositions:  parseInt(maxPositions),
      putOnly:       Boolean(putOnly),        // puts-only mode
      callSizeMult:  parseFloat(callSizeMult), // asymmetric call sizing
      useSpread:     req.body.useSpread !== false,  // V2.80: default true - spread P&L simulation
      useRegimeB:    req.body.useRegimeB !== false, // V2.80: default true - regime classification
      spreadWidth:   req.body.spreadWidth ? parseFloat(req.body.spreadWidth) : null,
    });

    res.json(result);
  } catch(e) {
    logEvent("error", `[BACKTEST] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// - Stress test endpoint - predefined historical scenarios -
app.post("/api/backtest/stress", async (req, res) => {
  try {
    const { ticker = "SPY", optionType = "put", capital = 10000 } = req.body || {};
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
  } catch(e) {
    logEvent("error", `[BACKTEST/STRESS] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/force-entry — pipeline test endpoint (paper trading only) ──────────
// Dinesh: hard guard — 403 in live trading, confirm required, 0.5x size
// Richard: calls executeCreditSpread directly with real prices — full pipeline test
// Gilfoyle: logs [FORCE ENTRY] prominently, appears in EOD email
app.post('/api/force-entry', async (req, res) => {
  // Dinesh guard: never allow in live trading
  if (ALPACA_BASE.includes('live')) {
    return res.status(403).json({ error: 'force-entry disabled in live trading' });
  }
  const { ticker, optionType, confirm } = req.body || {};
  if (!confirm) return res.status(400).json({ error: 'must include confirm:true in body' });
  if (!ticker || !optionType) return res.status(400).json({ error: 'ticker and optionType required' });
  if (!['put','call'].includes(optionType)) return res.status(400).json({ error: 'optionType must be put or call' });

  const stock = WATCHLIST.find(s => s.ticker === ticker);
  if (!stock) return res.status(400).json({ error: `${ticker} not in WATCHLIST` });
  if (!stock.isIndex) return res.status(400).json({ error: `${ticker} is not an index instrument` });

  // D1: rate limit — prevent double-click double-order (30s cooldown)
  const _lastForce = state._lastForceEntry || 0;
  if (Date.now() - _lastForce < 30000) {
    return res.status(429).json({ error: `Rate limited — wait ${Math.ceil((30000-(Date.now()-_lastForce))/1000)}s before next force-entry` });
  }
  state._lastForceEntry = Date.now();

  try {
    logEvent("scan", `[FORCE ENTRY] ${ticker} ${optionType} — bypassing score/R/R gates — PIPELINE TEST`);
    const price = await getStockQuote(ticker);
    if (!price) return res.status(500).json({ error: 'could not fetch live price from Alpaca' });

    const rb = getRegimeRulebook(state);
    // Dinesh: 0.5x size floor — test with minimum exposure
    const pos = await executeCreditSpread(
      stock, price, 99, ['[FORCE ENTRY] pipeline test — score/R/R gates bypassed'],
      state.vix || 25, optionType, 0.5, rb.spreadParams
    );
    if (pos) {
      // D2+D3: pos={pending:true} when order submitted — read actual values from state._pendingOrder
      const orderId = state._pendingOrder?.orderId || '?';
      const credit  = state._pendingOrder?.netCredit || state._pendingOrder?.premium || '?';
      logEvent("scan", `[FORCE ENTRY] ✅ ${ticker} order submitted — orderId:${orderId} credit:$${credit} — awaiting fill confirmation`);
      // Dinesh: mark force entries in EOD email via state flag
      if (!state._forceEntries) state._forceEntries = [];
      state._forceEntries.push({ ticker, optionType, ts: Date.now(), orderId });
      markDirty();
      res.json({ success: true, message: 'Order submitted — awaiting fill. Check positions panel and server log.', orderId, credit });
    } else {
      logEvent("scan", `[FORCE ENTRY] ❌ ${ticker} executeCreditSpread returned null — check filter logs for reason`);
      res.json({ success: false, reason: 'executeCreditSpread returned null — bid-ask gate or no valid chain. Check server log.' });
    }
  } catch(e) {
    logEvent("error", `[FORCE ENTRY] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});
