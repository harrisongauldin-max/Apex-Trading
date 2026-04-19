// scanner.js — ARGO V3.2
// Main scan orchestrator: market data fetching, exit checks, entry scoring, execution.
// runScan() runs every 10 seconds during market hours.
// NOTE: This is a direct lift of runScan from server.js.
//       Phase D.2 will decompose runScan into pure sub-functions.
'use strict';

// ─── All module imports ──────────────────────────────────────────
const {
  alpacaGet, alpacaPost, alpacaDelete,
  getStockBars, getIntradayBars, getStockQuote, getCircuitState,
} = require('./broker');

const { state, logEvent, markDirty, saveStateNow, flushStateIfDirty } = require('./state');

const {
  calcRSI, calcEMA, calcMACD, calcMomentum, calcATR, calcADX, calcIVRank,
  calcGreeks, calcVWAP, calcKellySize, calcBetaWeightedDelta, calcAggregateGreeks,
  calcCreditSpreadTP, getDynamicSignals, getLiveBeta, calcSharpeRatio, calcFactorScore,
  openRisk, openCostBasis, heatPct, realizedPnL, totalCap, stockValue,
  effectiveHeatCap, getAccountPhase, getDeployableCash,
  getETTime, isDST, isMarketHours, isEntryWindow, getBusinessDaysAgo,
  getWeeklyTrend, getSupportResistance,
} = require('./signals');

const {
  getMacroNews, getFearAndGreed, getMarketBreadth, getSyntheticPCR,
  getVolTermStructure, getCBOESKEW, getSentimentSignal, getDXY,
  getYieldCurve, getEarningsDate, getNewsForTicker, analyzeNews, scoreArticle,
  getAnalystActivity, getShortInterestSignal, getUpcomingMacroEvents,
  getMacroCalendarModifier, getPreMarketData, checkVIXVelocity,
  getVIXReversionDays, getVIX,
} = require('./market');

const {
  scoreIndexSetup, scorePutSetup, scoreMeanReversionCall,
  detectMarketRegime, getRegimeModifier, applyIntradayRegimeOverride,
  updateOversoldTracker, recordGateBlock, checkMacroShift,
  checkSectorETF, isGLDEntryAllowed, isXLEEntryAllowed, isTLTEntryAllowed,
} = require('./scoring');

const {
  getRegimeRulebook, scoreCandidate: EE_scoreCandidate, evaluateEntry,
} = require('./entryEngine');

const {
  executeCreditSpread, executeDebitSpread, executeTrade, executeIronCondor,
  findContract, calcPositionSize,
} = require('./execution');

const {
  closePosition, partialClose, confirmPendingOrder, syncCashFromAlpaca,
} = require('./closeEngine');

const {
  runReconciliation, syncPositionPnLFromAlpaca,
} = require('./reconciler');

const {
  getAgentDayPlan, getAgentMacroAnalysis, runAgentRescore, triggerRescore,
} = require('./agent');

const {
  getDrawdownProtocol, checkConcentrationRisk, checkAllFilters,
  countRecentDayTrades, isDayTrade, getStreakAnalysis, runStressTest,
  checkScaleIns, calcThesisIntegrity,
} = require('./risk');

const {
  checkExits, fetchPositionData,
  getTimeAdjustedStop, getDTEExitParams, applyExitUrgency, getTimeOfDayAnalysis,
} = require('./exitEngine');

const { sendMorningBriefing, sendEmail, setReportingContext } = require('./reporting');

const {
  WATCHLIST, CAPITAL_FLOOR, MIN_SCORE, MIN_SCORE_CREDIT, MAX_HEAT,
  MAX_SECTOR_PCT, STOP_LOSS_PCT, FAST_STOP_PCT, FAST_STOP_HOURS,
  TAKE_PROFIT_PCT, PARTIAL_CLOSE_PCT, TRAIL_ACTIVATE_PCT, TRAIL_STOP_PCT,
  BREAKEVEN_LOCK_PCT, PDT_LIMIT, PDT_PROFIT_EXIT, PDT_STOP_LOSS,
  MS_PER_DAY, TRIGGER_COOLDOWN_MS, SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL,
  INDIVIDUAL_STOCKS_ENABLED, MONTHLY_BUDGET, MACRO_REVERSAL_PCT,
  TARGET_DELTA_MIN, TARGET_DELTA_MAX,
  ALPACA_KEY, ALPACA_SECRET, ALPACA_DATA, ALPACA_OPT_SNAP, ALPACA_OPTIONS,
  INDIVIDUAL_STOCK_WATCHLIST,
} = require('./constants');

let scanRunning  = false;
// Stub: getBenchmarkComparison not yet modularized
async function getBenchmarkComparison() { return null; }
// Stub: getEarningsQualityScore
async function getEarningsQualityScore() { return { signal: 'neutral' }; }
// Stub: getLiveSignals (alias for getDynamicSignals)
async function getLiveSignals(ticker, bars, intraday) { return getDynamicSignals(ticker, bars, intraday); }
// Stub: getCached/setCache
const _scanCache = new Map();
function getCached(key) { const v = _scanCache.get(key); return v && v.exp > Date.now() ? v.val : null; }
function setCache(key, val, ttlMs=300000) { _scanCache.set(key, { val, exp: Date.now() + ttlMs }); }
let _scanGen     = 0; // increments each scan - finally block only resets its own generation
let lastMedScan  = 0;  // 5 minute tier
let lastSlowScan = 0;  // 15 minute tier
let lastHourScan = 0;  // 60 minute tier
let dryRunMode   = false; // when true: skips market hours check, Alpaca orders, state mutations

// Shared market context updated on tiers
let marketContext = {
  fearGreed:      { score: 50, rating: "neutral" },
  breadth:        { advancing: 5, declining: 5, breadthPct: 50 },
  sectorRotation: { leading: "Technology", lagging: "Energy", performance: {} },
  dxy:            { trend: "neutral", change: 0 },
  yieldCurve:     { signal: "normal" },
  putCallRatio:   { ratio: 1.0, signal: "neutral" },
  macro:             { signal: "neutral", scoreModifier: 0, mode: "normal", triggers: [], sectorBearish: [], sectorBullish: [], headlines: [] },
  macroCalendar:     { modifier: 0, events: [], message: "" },
  betaWeightedDelta: 0,
  regime:            { regime: "neutral", confidence: 50, action: "Normal operations.", details: {} },
  concentration:     { alerts: [], sectorTotals: {}, callPct: 100 },
  benchmark:         null,
  stressTest:        [],
  drawdownProtocol:  { level: "normal", sizeMultiplier: 1.0, message: "Normal operations.", minScore: 70 },
  monteCarlo:        { median: null, percentile5: null, percentile95: null, probProfit: null, message: "Insufficient data" },
  kelly:             { contracts: 1, kelly: 0, halfKelly: 0, winRate: 0, payoffRatio: 0 },
  relativeValue:     {},
  globalMarket:      { signal: "neutral", modifier: 0, qqqChg: 0, iwmChg: 0, eemChg: 0 },
  streaks:           { currentStreak: 0, currentType: null, maxWinStreak: 0, maxLossStreak: 0 },
};


async function runScan() {
  if (scanRunning) { logEvent("scan", "Scan skipped - previous scan still running"); return; }
  scanRunning = true;
  _lastScanStart = Date.now(); // watchdog timestamp
  const thisScanGen = ++_scanGen; // stamp this scan's generation
  try {
  if (!ALPACA_KEY) { logEvent("warn", "No ALPACA_KEY set - check Railway variables"); scanRunning = false; return; }
  if (!isMarketHours() && !dryRunMode) { logEvent("scan", "Outside market hours - skipping trade logic"); scanRunning = false; return; }
  if (dryRunMode) logEvent("scan", "- DRY RUN MODE - no orders submitted, no state changes");
  // Clear dry run close flags from previous scan
  if (dryRunMode) state.positions.forEach(p => { delete p._dryRunWouldClose; });

  const now    = Date.now();
  const scanET = getETTime(); // single ET time reference for entire scan

  // Scan-level time and volume vars -- declared here so execution loop can access them
  // Per-stock loop also uses these; declaring at scan scope eliminates TDZ crashes
  const etHourNow  = scanET.getHours() + scanET.getMinutes() / 60;
  const isLateDay  = etHourNow >= 14.5;
  const isLastHour = etHourNow >= 15.0;

  // Scan-level memos - computed once, reused throughout scan
  // Prevents repeated iteration over state.positions on every check
  const _totalCap  = totalCap();
  const _openRisk  = openRisk();
  const _heatPct   = Math.max(0, openCostBasis()) / _totalCap; // margin deployed / total cap — matches heatPct()
  const _heatPctPc = parseFloat((_heatPct * 100).toFixed(1));

  // Scan-cycle cache - expensive fetches reused within same scan window
  if (!runScan._cache || Date.now() - (runScan._cacheTime||0) > 8000) {
    runScan._cache = {};
    runScan._cacheTime = Date.now();
  }
  const scanCache = runScan._cache;

  // Update VIX and check velocity
  const newVIX  = await getVIX() || state.vix;
  const isBlackSwan = checkVIXVelocity(newVIX);
  state.vix     = newVIX;

  // - 1B: IV RANK TRACKING -
  // Rolling 52-week VIX history to compute IV rank (VIX percentile)
  // IVR = where is today's VIX vs the last 252 trading days (0-100)
  // IVR 80+ = sell premium. IVR 20- = buy premium. IVR 50-80 = neutral.
  if (!state._vixRolling) state._vixRolling = [];
  state._vixRolling.push(newVIX);
  if (state._vixRolling.length > 252) state._vixRolling.shift(); // 1 year rolling
  // OPT-1+5: Sort once per meaningful VIX change, read min/max from sorted ends
  // Cache sorted array -- VIX moves <0.5 pts between scans 95% of the time
  const _prevSortedVix = state._sortedVixCache;
  const _prevSortedVixVal = state._sortedVixCacheVal || 0;
  let sortedVix;
  if (_prevSortedVix && Math.abs(newVIX - _prevSortedVixVal) < 0.5 && _prevSortedVix.length === state._vixRolling.length) {
    sortedVix = _prevSortedVix; // use cached sort
  } else {
    sortedVix = [...state._vixRolling].sort((a, b) => a - b);
    state._sortedVixCache    = sortedVix;
    state._sortedVixCacheVal = newVIX;
  }
  const vixMin = sortedVix[0]                    || 10;
  const vixMax = sortedVix[sortedVix.length - 1] || 80;
  const p5idx  = Math.floor(sortedVix.length * 0.05);
  const p95idx = Math.floor(sortedVix.length * 0.95);
  const vixP5  = sortedVix[p5idx]  || vixMin;
  const vixP95 = sortedVix[p95idx] || vixMax;
  // Clamp newVIX to the trimmed range for rank calculation
  const vixClamped = Math.min(Math.max(newVIX, vixP5), vixP95);
  state._ivRank = vixP95 > vixP5
    ? parseFloat(((vixClamped - vixP5) / (vixP95 - vixP5) * 100).toFixed(1))
    : 50; // default to 50 when insufficient history
  // Sanity check: if absolute range is very narrow (<5pts) fall back to VIX formula
  if (vixMax - vixMin < 5) {
    const formulaIVR = Math.min(95, Math.max(5, parseFloat(((newVIX - 12) / 33 * 100).toFixed(1))));
    state._ivRank = formulaIVR;
  }
  // V2.84 fix: if IVR comes out very low (<=5) but VIX is objectively elevated (>=25),
  // the rolling window has no low-VIX baseline (fresh start or reset during high-VIX period)
  // Fall back to formula which is calibrated on full 2012-2024 cycle
  // VIX 29 = ~52nd percentile historically. VIX 35 = ~70th. VIX 20 = ~24th.
  if (state._ivRank <= 5 && newVIX >= 20) {
    const formulaIVR = Math.min(95, Math.max(5, parseFloat(((newVIX - 12) / 33 * 100).toFixed(1))));
    // Critical: if VIX is BELOW the rolling window P5, IV is at a relative LOW.
    // Premium is contracting — credit spreads are less attractive, not more.
    // Don't let a formula-inflated IVR activate credit mode when vol is falling.
    // vixFallingPause already handles the directional block; this ensures IVR reflects reality.
    const vixBelowRecentLow = newVIX < vixP5 && vixP5 > 25 && newVIX < 25; // must be objectively low
    if (vixBelowRecentLow) {
      const cappedIVR = Math.min(40, formulaIVR);
      logEvent("scan", `[IVR] Window has no low-VIX baseline (min:${vixMin.toFixed(1)}) - VIX ${newVIX} below recent P5 ${vixP5.toFixed(1)} AND below 25 (IV contracting) - IVR capped at ${cappedIVR}`);
      state._ivRank = cappedIVR;
      state._ivEnv  = cappedIVR >= 50 ? "elevated" : cappedIVR >= 30 ? "normal" : "low";
    } else {
      logEvent("scan", `[IVR] Window has no low-VIX baseline (min:${vixMin.toFixed(1)}) - using formula fallback: VIX ${newVIX} = IVR ${formulaIVR}`);
      state._ivRank = formulaIVR;
      state._ivEnv  = formulaIVR >= 70 ? "high" : formulaIVR >= 50 ? "elevated" : formulaIVR >= 30 ? "normal" : "low";
    }
  }
  // IV environment classification
  state._ivEnv = state._ivRank >= 70 ? "high"    // sell premium aggressively
               : state._ivRank >= 50 ? "elevated" // credit spreads allowed
               : state._ivRank >= 30 ? "normal"   // neutral
               : "low";                            // buy premium (debit preferred)
  logEvent("scan", `[IV] Rank:${state._ivRank} (${state._ivEnv}) | VIX:${newVIX} | P5-P95:[${vixP5.toFixed(1)}-${vixP95.toFixed(1)}] | AbsRange:[${vixMin.toFixed(1)}-${vixMax.toFixed(1)}] | History:${state._vixRolling.length}d`);

  // - Confirm any pending mleg order from previous scan -
  // Must run before entry logic - if filled, records position and clears pending
  // If still pending, blocks new entries to prevent duplicate orders
  if (state._pendingOrder) {
    await confirmPendingOrder();
    if (state._pendingOrder) {
      // Still pending after check - skip entry section entirely this scan
      // This is the ONLY safe way to prevent duplicate mleg submissions
      logEvent("scan", `[SPREAD] Order ${state._pendingOrder.orderId} still pending (${((Date.now()-state._pendingOrder.submittedAt)/1000).toFixed(0)}s) - skipping entries`);
    }
  }

  // - 3D: SECTOR ROTATION SIGNALS -
  // Track sector ETF relative strength vs SPY (5-day return diff)
  // Used to gate XLE/KRE entries and signal cross-asset themes to agent
  if (!state._sectorRelStrChecked || Date.now() - state._sectorRelStrChecked > 600000) { // every 10min
    state._sectorRelStrChecked = Date.now();
    (async () => {
      try {
        if (!state._sectorRelStr) state._sectorRelStr = {};
        const spySnap = await alpacaGet("/stocks/SPY/snapshot", ALPACA_DATA);
        const spyChange = spySnap?.dailyBar?.c && spySnap?.prevDailyBar?.c
          ? (spySnap.dailyBar.c - spySnap.prevDailyBar.c) / spySnap.prevDailyBar.c * 100
          : 0;
        // TODO #9: Expanded sector tracking — XLF/SMH/IWM/HYG added as data-only signals
        // Each wired to specific scoring modifiers (applied in scoreIndexSetup)
        const dataSectors = ["XLE","KRE","XOP","XLF","SMH","IWM","HYG","UNH","CAT"];
        const sectorSnaps = await Promise.all(
          dataSectors.map(s => alpacaGet(`/stocks/${s}/snapshot`, ALPACA_DATA).catch(() => null))
        );
        dataSectors.forEach((sector, i) => {
          const snap = sectorSnaps[i];
          if (!snap?.dailyBar?.c || !snap?.prevDailyBar?.c) return;
          const sectorChange = (snap.dailyBar.c - snap.prevDailyBar.c) / snap.prevDailyBar.c * 100;
          const relStr = parseFloat((sectorChange - spyChange).toFixed(2));
          state._sectorRelStr[sector] = { relStr, sectorPct: parseFloat(sectorChange.toFixed(2)), spyPct: parseFloat(spyChange.toFixed(2)) };
          if (Math.abs(relStr) > 2.0) {
            logEvent("scan", `[SECTOR] ${sector} ${relStr > 0 ? "outperforming" : "underperforming"} SPY by ${relStr.toFixed(1)}% today - rotation signal`);
          }
        });
        // Credit stress flag: HYG and TLT both falling = forced liquidation signal
        const hygRelStr  = state._sectorRelStr?.HYG?.sectorPct || 0;
        const tltRelStr  = state._sectorRelStr?.TLT?.sectorPct || 0;
        state._creditStress = hygRelStr < -1.0 && tltRelStr < -0.5;
        if (state._creditStress) {
          logEvent("scan", `[CREDIT STRESS] HYG ${hygRelStr.toFixed(1)}% + TLT ${tltRelStr.toFixed(1)}% both falling — forced liquidation signal`);
        }
      } catch(e) { /* non-critical */ }
    })();
  }

  // - 2D: OPTIONS FLOW SCANNER -
  // Lightweight unusual options activity check - flags informed positioning
  // Uses Alpaca snapshot which includes options volume/OI data
  // Fire-and-forget - non-blocking, feeds agent context only
  if (!state._optFlowChecked || Date.now() - state._optFlowChecked > 300000) { // every 5 min
    state._optFlowChecked = Date.now();
    (async () => {
      try {
        for (const ticker of ["SPY","QQQ"]) {
          const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
          if (!snap) continue;
          const todayVol   = snap.dailyBar?.v || 0;
          const prevVol    = snap.prevDailyBar?.v || todayVol;
          const volRatio   = prevVol > 0 ? (todayVol / prevVol) : 1;
          if (volRatio > 2.5) {
            if (!state._optFlow) state._optFlow = {};
            state._optFlow[ticker] = { volRatio: parseFloat(volRatio.toFixed(1)), detectedAt: new Date().toISOString() };
            logEvent("scan", `[FLOW] ${ticker} unusual volume - ${volRatio.toFixed(1)}x normal. Informed positioning signal.`);
          }
        }
      } catch(e) { /* non-critical */ }
    })();
  }

  // Refresh PDT count from Alpaca at scan start - lightweight single field read
  // Runs in parallel with VIX already fetched above - no added latency
  // Keeps day trade count current without waiting for the 30s sync interval
  // Fire-and-forget Alpaca syncs - non-blocking, run in background
  alpacaGet("/account").then(acct => {
    if (acct?.daytrade_count !== undefined) {
      state._alpacaDayTradeCount = parseInt(acct.daytrade_count, 10);
    }
  }).catch(() => {});
  // Await Alpaca sync BEFORE exit evaluation - ensures pos.currentPrice is fresh
  // from Alpaca before any stop/TP checks run. Timeout prevents stalling scanner.
  // Fix for Bug 1: stale Redis currentPrice causing false stop triggers.
  await Promise.race([
    syncPositionPnLFromAlpaca(),
    new Promise(r => setTimeout(r, 2000)), // 2s max - fast Alpaca /positions call
  ]).catch(() => {});

  // Emergency close all on VIX velocity spike
  if (isBlackSwan) {
    for (const pos of [...state.positions]) await closePosition(pos.ticker, "vix-spike", null, pos.contractSymbol || pos.buySymbol, { bypassPDT: true }); // emergency exit — bypasses PDT day-trade counting
    await saveStateNow();
    scanRunning = false;
    return;
  }

  logEvent("scan", `Scan | VIX:${state.vix} | cash:${fmt(state.cash)} | positions:${state.positions.length} | breadth:${marketContext.breadth.breadthPct}% | F&G:${marketContext.fearGreed.score}`);

  // -- MEDIUM TIER (every 5 minutes) --
  if (now - lastMedScan > 3 * 60 * 1000) { // 3-minute tier - faster with only 2 instruments
    lastMedScan = now;
    const breadth = await getMarketBreadth();
    marketContext.breadth        = breadth;

    // - Breadth momentum tracking (Aronson: direction > single reading) -
    // Track last 10 breadth readings for momentum and Zweig Thrust detection
    if (!state._breadthHistory) state._breadthHistory = [];
    const bPct = parseFloat((marketContext.breadth.breadthPct || 50).toString());
    state._lastBreadthPct = bPct; // persisted for score-debug endpoint
    state._breadthHistory.push({ t: now, v: bPct });
    if (state._breadthHistory.length > 10) state._breadthHistory = state._breadthHistory.slice(-10);

    // 5-day breadth direction
    const bHist = state._breadthHistory;
    if (bHist.length >= 2) {  // lowered from 3 — 2 readings enough to establish direction
      const bRecent = bHist.slice(-Math.min(3, bHist.length)).map(b=>b.v);
      const bOld    = bHist.slice(0, Math.min(3, bHist.length)).map(b=>b.v);
      const bAvgRecent = bRecent.reduce((a,b)=>a+b,0)/bRecent.length;
      const bAvgOld    = bOld.reduce((a,b)=>a+b,0)/bOld.length;
      state._breadthMomentum = bAvgRecent - bAvgOld; // positive = rising, negative = falling
      state._breadthTrend    = state._breadthMomentum > 5 ? "rising"
                             : state._breadthMomentum < -5 ? "falling"
                             : "flat";
    }

    // - Breadth recovery detection -
    // Adapted from Zweig Thrust concept but calibrated for 4-instrument watchlist
    // Fires when breadth recovers from weak (<40%) to strong (>60%) within 5 readings
    // Much more common than true Zweig but still meaningful for small watchlists
    if (bHist.length >= 4) {
      const hadLowBreadth  = bHist.slice(0, -1).some(b => b.v < 40); // was weak recently
      const hasHighBreadth = bPct > 60;                               // now strong
      if (hadLowBreadth && hasHighBreadth) {
        if (!state._zweigThrust?.detected) {
          state._zweigThrust = { detected: true, detectedAt: new Date().toISOString() };
          logEvent("scan", "[BREADTH RECOVERY] Watchlist breadth recovered from weak to strong - call bias");
        }
      } else if (state._zweigThrust?.detected) {
        // Clear after 2 days - short-lived signal on small watchlist
        const age = (now - new Date(state._zweigThrust.detectedAt).getTime()) / MS_PER_DAY;
        if (age > 2) state._zweigThrust = { detected: false };
      }
    }

    // sectorRotation removed - SPY/QQQ index trading doesn't need sector rotation
    state.lastRebalance = now;
    // Update macro calendar and beta-weighted delta
    const calMod = getMacroCalendarModifier();
    marketContext.macroCalendar      = calMod;
    marketContext.betaWeightedDelta  = calcBetaWeightedDelta();
    if (calMod.events.length > 0) {
      logEvent("macro", `Calendar: ${calMod.message || calMod.events.map(e => e.event + " in " + e.daysTo + "d").join(", ")}`);
    }
    // Run async market context calls in parallel
    const [regime, benchmark] = await Promise.all([
      detectMarketRegime(),
      getBenchmarkComparison(),
    ]);
    marketContext.regime      = regime;
    marketContext.benchmark   = benchmark;

    // Synchronous calculations (no API calls)
    // Portfolio Greeks - track total delta/theta/vega/gamma across all positions
    const portfolioGreeks = state.positions.reduce((acc, pos) => {
      const g    = pos.greeks || {};
      const mult = (pos.contracts || 1) * 100;
      acc.delta += parseFloat(g.delta || 0) * mult;
      acc.theta += parseFloat(g.theta || 0) * mult;
      acc.gamma += parseFloat(g.gamma || 0) * mult;
      acc.vega  += parseFloat(g.vega  || 0) * mult;
      return acc;
    }, { delta: 0, theta: 0, gamma: 0, vega: 0 });
    portfolioGreeks.delta = parseFloat(portfolioGreeks.delta.toFixed(2));
    portfolioGreeks.theta = parseFloat(portfolioGreeks.theta.toFixed(2));
    portfolioGreeks.gamma = parseFloat(portfolioGreeks.gamma.toFixed(4));
    portfolioGreeks.vega  = parseFloat(portfolioGreeks.vega.toFixed(2));
    marketContext.portfolioGreeks = portfolioGreeks;
    marketContext.vegaExposure    = calcAggregateGreeks();
    if (state.positions.length > 0) {
      const ve = marketContext.vegaExposure;
      logEvent("scan", `[Vega] $${ve.vegaDollar}/pt VIX move | Risk:${ve.vegaRisk}`);
    }
    if (state.positions.length > 0) {
      logEvent("scan", `[Greeks] -:${portfolioGreeks.delta} -:${portfolioGreeks.theta}/day -:${portfolioGreeks.gamma} V:${portfolioGreeks.vega}`);
    }

    marketContext.concentration    = checkConcentrationRisk();
    marketContext.drawdownProtocol = getDrawdownProtocol();
    marketContext.stressTest       = runStressTest();
    // marketContext.monteCarlo removed - SPY/QQQ strategy doesn't use Monte Carlo
    marketContext.kelly            = calcKellySize(20);
    // relativeValue screening disabled (individual stocks off)
    marketContext.streaks          = getStreakAnalysis(); // now a stub

    if (marketContext.concentration.alerts.length > 0) {
      marketContext.concentration.alerts.forEach(a => logEvent("risk", a));
    }
    if (marketContext.drawdownProtocol.level !== "normal") {
      logEvent("risk", `Drawdown protocol: ${marketContext.drawdownProtocol.message}`);
    }

    // These need to run after context is updated
    await checkScaleIns();

    // Earnings plays removed - SPY/QQQ don't have earnings dates

    // Macro news on 5-min tier - catches breaking news within 5 minutes not 15
    // AUTHORITY: agent is primary. Keywords are fallback when agent hasn't run yet.
    const macro = await getMacroNews();
    const agentMacroForAuth = state._agentMacro;
    const agentAuthAge = agentMacroForAuth && agentMacroForAuth.timestamp
      ? (Date.now() - new Date(agentMacroForAuth.timestamp).getTime()) / 60000 : 999;
    const agentAuthFresh = agentAuthAge < 10; // agent ran within 10 minutes = use it exclusively
    if (agentAuthFresh && agentMacroForAuth) {
      // Agent is fresh - use agent signal, merge in keyword triggers for context only
      marketContext.macro = {
        ...macro,
        signal:        agentMacroForAuth.signal || macro.signal,
        scoreModifier: agentMacroForAuth.scoreModifier || macro.scoreModifier || 0,
        mode:          agentMacroForAuth.mode || macro.mode,
        macroAuthority: "agent",
        agentLastUpdated: agentMacroForAuth.timestamp,
      };
    } else {
      // Agent stale - use keywords at 50% score modifier weight
      marketContext.macro = {
        ...macro,
        scoreModifier: Math.round((macro.scoreModifier || 0) * 0.5),
        macroAuthority: "keyword_fallback",
        agentLastUpdated: agentMacroForAuth?.timestamp || null,
      };
      if (!dryRunMode) logEvent("warn", `[MACRO] Agent stale (${agentAuthAge.toFixed(0)}min) - keyword fallback active, score modifier halved`);
    }
    if (marketContext.macro.mode !== "normal") {
      logEvent("macro", `[5min] Macro: ${marketContext.macro.signal} via ${marketContext.macro.macroAuthority} (${marketContext.macro.scoreModifier > 0 ? "+" : ""}${marketContext.macro.scoreModifier}) | ${(marketContext.macro.triggers||[]).slice(0,3).join(", ")}`);
    }

    // Strongly bearish macro - close all calls immediately
    // ONLY fire if agent also confirms bearish - keyword scorer alone gives false positives
    // Agent signal takes priority: if agent ever said bullish/neutral, suppress keyword defensive
    // This protects against: keyword fires on GLD/tariff headlines while SPY is rallying
    const agentSignal      = (state._agentMacro || {}).signal || "neutral";
    const agentIsBullish   = ["bullish","strongly bullish","mild bullish"].includes(agentSignal);
    const agentIsNeutral   = agentSignal === "neutral";
    const agentIsBearish   = ["strongly bearish","bearish"].includes(agentSignal);
    const agentAge         = state._agentMacro && state._agentMacro.timestamp
      ? (Date.now() - new Date(state._agentMacro.timestamp).getTime()) / 60000 : 999;
    // Extend freshness to 60 min - agent runs every 3 min but cache + restart gaps can widen this
    // If no agent signal ever (agentAge=999), allow defensive to fire (can't suppress without data)
    const agentFresh       = agentAge < 60;
    // Suppress if: agent is fresh AND (bullish or neutral) - don't close calls on keyword alone
    // Also suppress if: agent is fresh AND bearish but NOT strongly bearish (mild disagreement)
    const defensiveSuppressed = agentFresh && !agentIsBearish; // only strongly bearish fires through
    // DEF-1: Skip defensive close entirely when no calls are open - avoids spurious log noise
    const openCallPositions = (state.positions || []).filter(p => p.optionType === "call");
    if (macro.mode === "defensive" && state.circuitOpen && !defensiveSuppressed) {
      if (openCallPositions.length === 0) {
        logEvent("macro", `[DEFENSIVE] No open calls - nothing to close (macro: ${macro.signal})`);
      } else {
      const defTriggers = (macro.triggers || []).slice(0,3).join(", ") || "strongly bearish signal";
      logEvent("macro", `DEFENSIVE MODE - keyword+agent agree bearish: ${defTriggers} - closing calls`);
      for (const pos of [...state.positions]) {
        if (pos.optionType === "call") {
          if (!state._macroDefensiveCooldown) state._macroDefensiveCooldown = {};
          state._macroDefensiveCooldown[pos.ticker] = Date.now();
          await closePosition(pos.ticker, "macro-defensive");
        }
      }
      } // end openCallPositions.length > 0
    } else if (macro.mode === "defensive" && defensiveSuppressed) {
      logEvent("macro", `[AGENT OVERRIDE] Defensive suppressed - agent ${agentSignal} (${agentAge.toFixed(0)}min ago, conf:${(state._agentMacro||{}).confidence||"unknown"}) overrides keyword - keeping calls open`);
    } else if (macro.mode === "defensive" && !agentFresh) {
      logEvent("warn", `[AGENT] Defensive triggered but agent stale (${agentAge.toFixed(0)}min) - firing anyway, redeploy to fix`);
      for (const pos of [...state.positions]) {
        if (pos.optionType === "call") {
          // BF-W2: Stamp per-ticker cooldown to prevent mechanical FOMO re-entry
          if (!state._macroDefensiveCooldown) state._macroDefensiveCooldown = {};
          state._macroDefensiveCooldown[pos.ticker] = Date.now();
          await closePosition(pos.ticker, "macro-defensive");
        }
      }
    }

    // Strongly bullish macro - close losing puts (thesis broken by macro tailwind)
    // Agent freshness gate: keyword-only "aggressive" with stale agent must not fire.
    // "ceasefire" or "tariff truce" headlines during a VIX-30 bear regime are bounce reads,
    // not regime changes. Agent must confirm bullish or be fresh to trigger puts close.
    const bullishAgentSignal   = (state._agentMacro || {}).signal || "neutral";
    const bullishAgentAge      = state._agentMacro?.timestamp
      ? (Date.now() - new Date(state._agentMacro.timestamp).getTime()) / 60000 : 999;
    const bullishAgentFresh    = bullishAgentAge < 15;
    const agentConfirmsBullish = ["strongly bullish","bullish","mild bullish"].includes(bullishAgentSignal);
    const agentContrasBullish  = ["strongly bearish","bearish","mild bearish"].includes(bullishAgentSignal);
    const macroAuthority       = (marketContext.macro || {}).macroAuthority || "keyword_fallback";
    const bullishCloseSuppressed =
      macroAuthority === "keyword_fallback" && !bullishAgentFresh && !agentConfirmsBullish;
    const bullishCloseAllowed =
      !bullishCloseSuppressed && !(agentContrasBullish && bullishAgentFresh);

    if (macro.mode === "aggressive" && !dryRunMode && bullishCloseAllowed) {
      logEvent("macro", `BULLISH MACRO - ${macro.signal}: ${macro.triggers.slice(0,3).join(", ")} - closing losing puts`);
      for (const pos of [...state.positions]) {
        if (pos.optionType !== "put") continue;
        const curP = pos.currentPrice || pos.premium;
        const chg  = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
        if (chg < -0.05) await closePosition(pos.ticker, "macro-bullish", null, pos.contractSymbol || pos.buySymbol);
      }
    } else if (macro.mode === "aggressive" && !dryRunMode && !bullishCloseAllowed) {
      const suppressReason = bullishCloseSuppressed
        ? `keyword-only + agent stale ${bullishAgentAge.toFixed(0)}min + no agent bullish confirmation`
        : `agent ${bullishAgentSignal} (${bullishAgentAge.toFixed(0)}min) contradicts keyword bullish`;
      logEvent("macro", `[BULLISH SUPPRESSED] Signal suppressed - ${suppressReason} - keeping puts open`);
    }
    // Always compute streaks live from closedTrades - avoids stale Redis values
    const liveStreaks = getStreakAnalysis();
    logEvent("scan", `[5min] Regime:${regime.regime}(${regime.confidence}%) | Kelly:${marketContext.kelly?.contracts||1}x | Streak:${liveStreaks.currentStreak}x${liveStreaks.currentType||'--'}`);
    // Record portfolio value snapshot every 5 minutes during market hours
    if (!state.portfolioSnapshots) state.portfolioSnapshots = [];
    const snapValue = state.cash + openRisk();
    state.portfolioSnapshots.push({ t: new Date().toISOString(), v: parseFloat(snapValue.toFixed(2)) });
    // Cap at 2500 entries (~8 trading days at 5-min intervals)
    if (state.portfolioSnapshots.length > 2500) state.portfolioSnapshots = state.portfolioSnapshots.slice(-2500);
    runAgentRescore();        // parallel hourly rescore for overnight positions (non-blocking)
    runReconciliation().catch(e => logEvent("error", `[RECONCILE] 5-min sync failed: ${e.message}`)); // non-blocking

    // - Agent accuracy resolution (non-blocking) -
    // Checks pending agent calls that are 30+ or 120+ minutes old
    // Resolves directional accuracy: did SPY move the way the agent predicted?
    if (state._agentAccuracy && state._agentAccuracy.pending.length > 0) {
      const spyNow = state._liveSPY || state.spy || 0;
      if (spyNow > 0) {
        const now = Date.now();
        let resolved30 = 0, resolved120 = 0;
        state._agentAccuracy.pending.forEach(p => {
          const minsElapsed = (now - p.timestamp) / 60000;
          const spyChange   = (spyNow - p.spyAtCall) / p.spyAtCall;
          // bearish signals expect SPY to fall (negative change = correct)
          // bullish signals expect SPY to rise (positive change = correct)
          const expectsFall = ["strongly bearish","bearish"].includes(p.signal);
          const expectsRise = ["strongly bullish","bullish"].includes(p.signal);
          const correct     = (expectsFall && spyChange < -0.001) || (expectsRise && spyChange > 0.001);

          if (!p.resolved30 && minsElapsed >= 30) {
            p.resolved30 = true;
            if (correct) state._agentAccuracy.correct30++;
            resolved30++;
          }
          if (!p.resolved120 && minsElapsed >= 120) {
            p.resolved120 = true;
            if (correct) state._agentAccuracy.correct120++;
            resolved120++;
          }
        });
        // Remove fully resolved entries (both windows done)
        state._agentAccuracy.pending = state._agentAccuracy.pending.filter(p => !p.resolved120);
        // Compute accuracy rates
        const resolved30Total  = state._agentAccuracy.calls - state._agentAccuracy.pending.filter(p => !p.resolved30).length;
        const resolved120Total = state._agentAccuracy.calls - state._agentAccuracy.pending.length;
        if (resolved30Total > 0)  state._agentAccuracy.acc30  = parseFloat((state._agentAccuracy.correct30  / resolved30Total  * 100).toFixed(1));
        if (resolved120Total > 0) state._agentAccuracy.acc120 = parseFloat((state._agentAccuracy.correct120 / resolved120Total * 100).toFixed(1));
        if (resolved30 > 0 || resolved120 > 0) {
          logEvent("scan", `[AGENT ACC] 30min: ${state._agentAccuracy.acc30 || "--"}% | 120min: ${state._agentAccuracy.acc120 || "--"}% | n=${state._agentAccuracy.calls} directional calls`);
        }
      }
    }
  }



  // -- SLOW TIER (every 15 minutes) --
  if (now - lastSlowScan > 10 * 60 * 1000) { // 10-minute tier (was 15)
    lastSlowScan = now;
    const [fg, dxy, yc, pcrSynth, termStruct, skew, sentiment] = await Promise.all([
      getFearAndGreed(), getDXY(), getYieldCurve(),
      getSyntheticPCR(),        // synthetic put/call ratio from SPY options chain
      getVolTermStructure(),    // near vs far month IV term structure
      getCBOESKEW(),            // synthetic SKEW from IV smirk (Alpaca-native)
      getSentimentSignal(),     // VIX momentum + price action sentiment (replaces AAII)
    ]);

    // PCR - use synthetic (Alpaca options chain) - CBOE CDN blocked on Railway
    const pcr = pcrSynth;
    if (pcr) {
      marketContext.pcr = pcr;
      state._pcr = { ...pcr, updatedAt: Date.now() };
      logEvent("scan", `[PCR:synthetic] ${pcr.pcr} (${pcr.signal})`);
    } else {
      logEvent("scan", `[PCR] synthetic unavailable - scoring uses cached value`);
    }
    if (termStruct) {
      marketContext.termStructure = termStruct;
      state._termStructure = { ...termStruct, updatedAt: Date.now() };
      logEvent("scan", `[VOL TERM] near:${(termStruct.nearIV*100).toFixed(1)}% far:${(termStruct.farIV*100).toFixed(1)}% ratio:${termStruct.ratio} (${termStruct.structure})`);
    }
    if (skew) {
      marketContext.skew = skew;
      state._skew = { ...skew, updatedAt: Date.now() };
      logEvent("scan", `[SKEW] ${skew.skew} (${skew.signal}) ${skew.creditPutIdeal ? "- CREDIT PUT IDEAL" : ""}`);
    } else {
      // Fix #8: Fallback synthetic SKEW from VIX when options chain fetch returns null
      // VIX 30+ ≈ SKEW 130+ (extreme), VIX 25-30 ≈ SKEW 120-130 (elevated), VIX <25 ≈ normal
      // This ensures _skew is never empty during elevated VIX environments
      const vixNow = state.vix || 20;
      if (!state._skew && vixNow >= 25) {
        const synthSkew = vixNow >= 32 ? 135 : vixNow >= 28 ? 128 : vixNow >= 25 ? 122 : 110;
        const synthSignal = synthSkew >= 130 ? "extreme" : synthSkew >= 120 ? "elevated" : "moderate";
        const synthSmirk  = parseFloat(((synthSkew - 100) / 200 + 1).toFixed(3));
        const synthResult = {
          skew: synthSkew, smirkRatio: synthSmirk, signal: synthSignal,
          creditPutIdeal: synthSkew >= 120 && vixNow >= 25,
          synthetic: true, vixBased: true,
          updatedAt: Date.now(),
        };
        state._skew = synthResult;
        marketContext.skew = synthResult;
        logEvent("scan", `[SKEW] VIX-based fallback: ${synthSkew} (${synthSignal}) - chain fetch returned null`);
      }
    }
    if (sentiment) {
      marketContext.aaii = sentiment; // scoring reads state._aaii — wire sentiment here
      state._aaii = { ...sentiment, updatedAt: Date.now() };
      logEvent("scan", `[SENTIMENT] ${sentiment.signal} | vixMom:${sentiment.vixMomentum} spyDd:${sentiment.spyDrawdown}%`);
    }
    marketContext.fearGreed   = fg;
    marketContext.dxy         = dxy;
    marketContext.yieldCurve  = yc;
    // Real put/call ratio — OPT-PCCE: 15min gate, daily bar
    if (!state._pcceCheckedAt || Date.now() - state._pcceCheckedAt > 15 * 60 * 1000) {
      state._pcceCheckedAt = Date.now();
      try {
        const pcceData = await alpacaGet(`/stocks/PCCE/bars?timeframe=1Day&limit=5`, ALPACA_DATA);
        if (pcceData && pcceData.bars && pcceData.bars.length > 0) {
          const pcRatio = parseFloat(pcceData.bars[pcceData.bars.length-1].c);
          const signal  = pcRatio > 0.9 ? "fear" : pcRatio > 0.7 ? "elevated" : pcRatio < 0.5 ? "greed" : "neutral";
          state._pcceRatio = { ratio: parseFloat(pcRatio.toFixed(2)), signal, source: "CBOE-PCCE" };
        }
      } catch(e) {}
    }
    marketContext.putCallRatio = state._pcceRatio ||
      (state.vix > 30 ? { ratio: 1.3, signal: "fear" } : state.vix > 20 ? { ratio: 1.0, signal: "neutral" } : { ratio: 0.7, signal: "greed" });
    logEvent("scan", `[15min] F&G:${fg.score} | DXY:${dxy.trend} | Yield:${yc.signal}`);
  }

  // -- HOUR TIER (every 60 minutes) --
  if (now - lastHourScan > 60 * 60 * 1000) {
    lastHourScan = now;
    const today  = getETTime().toISOString().split("T")[0];
    let updated  = 0;
    let cleared  = 0;
    for (const stock of WATCHLIST) {
      // Clear stale past earnings dates
      if (stock.earningsDate && stock.earningsDate < today) {
        stock.earningsDate = null;
        cleared++;
      }
      // Fetch new upcoming earnings date
      const ed = await getEarningsDate(stock.ticker);
      if (ed) { stock.earningsDate = ed; updated++; }
    }
    logEvent("scan", `[1hr] Earnings: ${updated} updated, ${cleared} stale dates cleared`);
  }

  // Individual stock positions disabled - SPY/QQQ only

  // 1. Exit checks for open positions
  // Pre-compute ctx values for exitEngine
  const alpacaBalance = state.alpacaCash || state.cash || 0;
  const pdtCount      = countRecentDayTrades();

  // Fetch live prices + news for all open positions (parallel, non-blocking)
  const { posSnapshots, posQuotes, posNewsCache } = await fetchPositionData(state.positions);

  // Evaluate all exit conditions — pure function, returns decisions, never mutates state
  const exitDecisions = await checkExits(
    state.positions, posSnapshots, posQuotes, posNewsCache,
    { dryRunMode, scanET, alpacaBalance, pdtCount, marketContext }
  );

  // Apply decisions — closePosition/partialClose are the only side effects
  for (const d of exitDecisions) {
    if (d.action === 'close')
      await closePosition(d.ticker, d.reason, d.exitPremium, d.contractSym);
    else if (d.action === 'partial')
      await partialClose(d.ticker);
  }
  if (exitDecisions.length > 0) markDirty();

  // 2. New entries - check if any entry type is valid
  // Skip entirely if a pending mleg order is in flight - prevents duplicate submissions
  if (state._pendingOrder) {
    // Already logged above - just skip to end of scan
  } else {
  // Fetch SPY data in parallel - all three are independent requests
  const [spyPrice, spyBars, spyIntraday] = await Promise.all([
    getStockQuote("SPY").then(p => p || 500),
    getStockBars("SPY", 5),
    getIntradayBars("SPY"),
  ]);
  if (spyPrice) state._liveSPY = spyPrice;
  // Compute SPY 200MA once per day at scan time — needed for below200MACallBlock gate
  const _ma200Date = state._spyMA200Date || "";
  const _todayStr  = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
  if (!state._spyMA200 || _ma200Date !== _todayStr) {
    try {
      const _spyBars200 = await getStockBars("SPY", 200);
      if (_spyBars200.length >= 50) {
        const _closes200 = _spyBars200.slice(-200).map(b => b.c);
        state._spyMA200    = parseFloat((_closes200.reduce((s,c) => s+c, 0) / _closes200.length).toFixed(2));
        state._spyMA200Date = _todayStr;
        logEvent("scan", `[MA] SPY 200MA: $${state._spyMA200} (${_closes200.length} bars)`);
      } else {
        // Dinesh: log warning so gate-disabled state is visible, not silent
        logEvent("warn", `[MA] SPY 200MA: only ${_spyBars200.length} bars returned (need 50+) — below200MACallBlock disabled until data available`);
      }
    } catch(e) { logEvent("warn", `[MA] SPY 200MA fetch failed: ${e.message} — below200MACallBlock disabled`); }
  }
  const spyReturn    = spyBars.length >= 5 ? (spyBars[spyBars.length-1].c - spyBars[0].o) / spyBars[0].o : 0;
  const spyRecovering = (() => {
    if (spyIntraday.length >= 15) {
      const recent  = spyIntraday.slice(-15);
      const spyMove = (recent[recent.length-1].c - recent[0].c) / recent[0].c;
      if (spyMove > 0.003) return true;
    }
    if (spyBars.length >= 2) {
      const dayReturn = (spyBars[spyBars.length-1].c - spyBars[spyBars.length-2].c) / spyBars[spyBars.length-2].c;
      if (dayReturn > 0.005) return true;
    }
    if (spyIntraday.length >= 3) {
      const fromOpen = (spyIntraday[spyIntraday.length-1].c - spyIntraday[0].o) / spyIntraday[0].o;
      if (fromOpen > 0.005) return true;
    }
    return false;
  })();
  // SPY recovery: agent macro handles this - spyRecovering no longer blocks puts
  // spyAlreadyDown: removed - agent scores this into individual stock signals already
  const spyAlreadyDown = false; // disabled - agent macro signal replaces this

  // - SPY 200MA REGIME FILTER - panel consensus (6/8) -
  // When SPY is below its 200MA, market is in bearish regime
  // Block calls entirely + require score 80+ for puts + 50% size reduction
  // Addresses 2022 knife-catching problem: RSI "oversold" signals in prolonged downtrend
  const spyBelow200MA = state._spyMA200 && state._liveSPY && state._liveSPY < state._spyMA200;
  if (spyBelow200MA && !dryRunMode) {
    logEvent("filter", `[200MA] SPY $${state._liveSPY?.toFixed(2)} below 200MA $${state._spyMA200?.toFixed(2)} - bear regime: calls blocked, puts need 80+ score, 50% size`);
  }

  // - FINAL HOUR BLOCK - no new entries after 3:45pm -
  const etHourEntry    = scanET.getHours() + scanET.getMinutes() / 60;
  const finalHourBlock = etHourEntry >= 15.75 && !dryRunMode; // 3:45pm
  if (finalHourBlock) logEvent("filter", `Final hour block - no new entries after 3:45pm`);

  // - DAY PLAN: suppressUntil gate -
  // Agent sets suppressUntil on high-impact event days (CPI, FOMC, NFP)
  // Blocks all entries until after the event reaction settles
  const dayPlan = state._dayPlan;
  let suppressBlock = false;
  if (dayPlan && dayPlan.suppressUntil && !dryRunMode) {
    const [supH, supM] = dayPlan.suppressUntil.split(":").map(Number);
    const suppressMins = supH * 60 + supM;
    const currentMins  = scanET.getHours() * 60 + scanET.getMinutes();
    if (currentMins < suppressMins) {
      suppressBlock = true;
      logEvent("filter", `[DAY PLAN] Entries suppressed until ${dayPlan.suppressUntil} ET - high impact event`);
    }
  }

  // - DAY PLAN: riskLevel sizing modifier -
  // High risk days (FOMC, CPI) get 50% size reduction on top of drawdown protocol
  const dayPlanRiskMult = (dayPlan && dayPlan.riskLevel === "high" && !dryRunMode) ? 0.50 : 1.0;
  if (dayPlanRiskMult < 1.0) logEvent("filter", `[DAY PLAN] High risk day - position sizing reduced 50%`);

  // -- ENTRY ENGINE: Regime Rulebook ----------------------------------------
  // Moved here (before any rb.gates references) to prevent temporal dead zone crash
  // OPT-7: Compute rulebook once -- dryRun overrides specific gates only
  const _rbBase = getRegimeRulebook(state);
  const rb = dryRunMode
    ? { ..._rbBase, gates: { ..._rbBase.gates,
        choppyDebitBlock: false, crisisDebitBlock: false, avoidHoldActive: false,
        postReversalBlock: false, vixFallingPause: false } }
    : _rbBase;

  const macroBullish      = rb.gates.macroBullishBlock; // from rulebook (replaces old derivation)
  // pdtCount already computed before exit checks
  const pdtBlocked    = !dryRunMode && pdtCount >= PDT_LIMIT;
  if (pdtBlocked) logEvent("filter", `PDT limit reached (${pdtCount}/${PDT_LIMIT} day trades in 5 days) - same-day exits blocked, new entries still allowed`);

  // Agent macro signal gates puts - replaces blunt SPY recovery detector
  // puts blocked only when agent explicitly says aggressive/bullish AND SPY gap is large
  const spyGapUp = (() => {
    if (spyBars.length >= 2) {
      const prevClose  = spyBars[spyBars.length-2].c;
      const curSPY     = spyBars[spyBars.length-1].c;
      const gapPct     = (curSPY - prevClose) / prevClose;
      const etMinSince = (scanET.getHours() - 9) * 60 + scanET.getMinutes() - 30;
      if (!(gapPct > 0.015 && etMinSince >= 0)) return false; // no gap or outside window

      // PM/TA panel modification: shorten delay to 10min when gap is already fading
      // Gap fading = current price already below intraday VWAP (selling into the gap)
      // In that case the gap-up thesis has failed - weaker reason to delay puts
      const spyVWAP = spyIntraday.length >= 5 ? calcVWAP(spyIntraday) : 0;
      const gapFading = spyVWAP > 0 && curSPY < spyVWAP;
      const delayMins = gapFading ? 10 : 15;

      return etMinSince < delayMins;
    }
    return false;
  })();
  if (spyGapUp && !dryRunMode) {
    const etMinSince = (scanET.getHours() - 9) * 60 + scanET.getMinutes() - 30;
    const spyVWAP    = spyIntraday.length >= 5 ? calcVWAP(spyIntraday) : 0;
    const gapFading  = spyVWAP > 0 && spyPrice < spyVWAP;
    logEvent("filter", `SPY gap-up open >1.5% - delaying puts ${gapFading ? "10" : "15"}min${gapFading ? " (gap fading, below VWAP - shortened)" : " for price discovery"} (${etMinSince.toFixed(0)}min elapsed)`);
  }

  // - CONDITION-BASED POST-REVERSAL COOLDOWN -
  // FIX 2: Uses marketContext.macro (authoritative merged signal) not state._agentMacro (raw)
  // Prevents split-brain where cooldown and entry gate use different macro objects
  // Also requires agent update to postdate the reversal event
  let postReversalBlock = false;
  if (state._macroReversalAt && !dryRunMode) {
    const minsSinceReversal = (Date.now() - state._macroReversalAt) / 60000;
    // Use marketContext.macro - same authoritative object the entry gate reads
    const macroSignal     = (marketContext.macro || {}).signal || "neutral";
    const macroBearish    = ["bearish", "strongly bearish", "mild bearish"].includes(macroSignal);
    const macroAuthority  = (marketContext.macro || {}).macroAuthority || "keyword_fallback";
    const agentUpdatedAt  = (marketContext.macro || {}).agentLastUpdated || null;
    const agentConfidence = (state._agentMacro || {}).agentConfidence || (state._agentMacro || {}).confidence || "low";

    // Condition 1: minimum 30 minutes
    const minTimeElapsed = minsSinceReversal >= 30;

    // Condition 2: marketContext.macro (authoritative) must be bearish
    const macroConfirmedBearish = macroBearish;

    // Condition 3: SPY must not be above reversal level
    const spyAboveReversal = state._macroReversalSPY && spyPrice > state._macroReversalSPY * 1.005;

    // Condition 4: agent update must postdate the reversal event (no stale pre-reversal reads)
    const agentPostdatesReversal = !agentUpdatedAt ||
      new Date(agentUpdatedAt).getTime() > state._macroReversalAt;

    // Extra gate: large reversal (5+ positions) requires high confidence
    const largeReversal = (state._macroReversalCount || 0) >= 5;
    const confidenceOk  = !largeReversal || agentConfidence === "high";

    if (!minTimeElapsed || !macroConfirmedBearish || spyAboveReversal || !confidenceOk || !agentPostdatesReversal) {
      postReversalBlock = true;
      const reasons = [];
      if (!minTimeElapsed)           reasons.push(`${minsSinceReversal.toFixed(0)}min elapsed (need 30)`);
      if (!macroConfirmedBearish)    reasons.push(`macro: ${macroSignal} via ${macroAuthority} (need bearish)`);
      if (spyAboveReversal)          reasons.push(`SPY above reversal $${state._macroReversalSPY?.toFixed(2)}`);
      if (!agentPostdatesReversal)   reasons.push(`waiting for post-reversal agent update`);
      if (!confidenceOk)             reasons.push(`large reversal needs high confidence (have: ${agentConfidence})`);
      logEvent("filter", `[REVERSAL COOLDOWN] Active - ${reasons.join(" | ")}`);
    } else {
      // All conditions met - clear the cooldown
      logEvent("filter", `[REVERSAL COOLDOWN] Cleared - macro confirmed bearish via ${macroAuthority}, all conditions met`);
      state._macroReversalAt    = null;
      state._macroReversalCount = 0;
      state._macroReversalSPY   = null;
      markDirty();
    }
  }

  // Macro authority - which system is driving decisions this scan
  // Agent is primary (if fresh), keyword is fallback (halved weight)
  const macroAuthStamp    = (marketContext.macro || {}).macroAuthority || "keyword_fallback";
  const agentMacroSignal  = (marketContext.macro || {}).signal || "neutral"; // use authoritative merged signal
  const putsMacroAllowed  = ["bearish", "strongly bearish", "mild bearish", "neutral"].includes(agentMacroSignal);
  const agentHasRun       = !!state._agentMacro;
  const macroClearForPuts = !agentHasRun || putsMacroAllowed;
  if (!dryRunMode) logEvent("scan", `[MACRO AUTH] ${macroAuthStamp} | signal: ${agentMacroSignal} | agent age: ${agentHasRun ? ((Date.now()-new Date((state._agentMacro||{}).timestamp||0).getTime())/60000).toFixed(0)+"min" : "never"}`);

  const isIndexScan  = true; // scan loop handles both index and stocks

  // - REGIME GATE - choppy blocks debit entries, credit still allowed -
  // UNIFIED REGIME SOURCE: _agentMacro.regime is authoritative (updated every 3min).
  // _dayPlan.regime is the morning baseline, used only when _agentMacro hasn't run yet.
  // applyIntradayRegimeOverride updates _dayPlan for the morning context - but scoring
  // uses _agentMacro directly so intraday shifts are immediately reflected.
  // (rb rulebook computed earlier in runScan -- before first rb.gates reference)

  // Surface key flags for the rest of runScan that references them directly
  const authRegimeName    = rb.regimeName;
  const isChoppyRegime    = rb.gates.choppyDebitBlock; // agent said none
  const creditModeActive  = rb.gates.creditPutActive;
  const creditCallModeActive = rb.gates.creditCallActive;
  const choppyDebitBlock  = rb.gates.choppyDebitBlock;
  const crisisDebitBlock  = rb.gates.crisisDebitBlock;
  const inBullRegime      = rb.isBullRegime;
  const isBearTrend       = rb.isBearRegime;
  const ivRankNow         = rb.ivRank;
  const ivElevated        = rb.ivElevated;
  const ivHigh            = rb.ivHigh;
  const regimeClass       = rb.regimeClass;
  const skewElevated      = (state._skew?.skew || 0) >= 130;
  const creditAllowedVIX  = rb.creditAllowedVIX; // entryEngine v2.0: IVR>=50 AND VIX>=25 (both required)

  // Strategy log
  const strategyMode = regimeClass === "C" ? "CRISIS - bear call credits only"
    : regimeClass === "B" ? "BEAR TREND - bear call credits + debit puts on bounces"
    : "BULL - mean reversion, both directions";
  logEvent("scan", `[STRATEGY] Regime ${regimeClass}: ${strategyMode} | IVR:${ivRankNow} (${state._ivEnv})`);
  if (rb.gates.choppyDebitBlock) logEvent("filter", `Choppy regime - debit entries blocked${creditModeActive ? ", credit PUT mode active" : creditCallModeActive ? ", credit CALL mode active" : ", VIX too low for credits"}`);
  if (creditCallModeActive && isBearTrend) logEvent("filter", `[CREDIT CALL] Trending bear + VIX ${state.vix} + IVR ${ivRankNow} - bear call spread mode active`);
  if (crisisDebitBlock && !dryRunMode) logEvent("filter", `[REGIME C] Crisis mode - debit put entries blocked, mean reversion unreliable`);
  if (skewElevated && state.vix >= 22 && state.vix < 28) logEvent("filter", `SKEW ${(state._skew?.skew||0)} elevated - credit VIX threshold lowered to 22`);


  // AVOID HOLD TIME: when agent says avoid, stamp _avoidUntil for 30 minutes
  // Prevents the avoid -> immediate re-entry pattern (agent flips to calls_on_dips next cycle)
  const agentBias = (state._agentMacro || {}).entryBias || (state._dayPlan || {}).entryBias || "neutral";
  if (agentBias === "avoid") {
    const holdUntil = Date.now() + 30 * 60 * 1000;
    if (!state._avoidUntil || holdUntil > state._avoidUntil) {
      state._avoidUntil = holdUntil;
      // V2.84: Track daily avoid stamp count -- panel flagged this as a hidden entry blocker
      // If firing 5+ times per day it is blocking entries for hours cumulatively
      if (!state._avoidStampsToday) state._avoidStampsToday = { date: "", count: 0 };
      const todayStr = getETTime().toISOString().slice(0, 10);
      if (state._avoidStampsToday.date !== todayStr) {
        state._avoidStampsToday = { date: todayStr, count: 0 };
      }
      state._avoidStampsToday.count++;
      logEvent("filter", `[AVOID] Entry block stamped #${state._avoidStampsToday.count} today - 30min hold until ${new Date(holdUntil).toLocaleTimeString("en-US",{timeZone:"America/New_York"})}`);
      if (state._avoidStampsToday.count >= 4) {
        logEvent("warn", `[AVOID] Stamped ${state._avoidStampsToday.count} times today - agent is repeatedly returning avoid bias - may be suppressing entries excessively`);
      }
    }
  }
  // avoidHoldActive: timestamp is authoritative - agent can EXTEND but not CANCEL
  // Removed: agentBias !== "avoid" escape hatch - it turned a 30min hold into a ~5min speedbump
  // If early cancellation is ever needed, build an explicit /api/clear-avoid endpoint
  const avoidHoldActive = !!(state._avoidUntil && Date.now() < state._avoidUntil);
  if (avoidHoldActive) {
    const minsLeft = ((state._avoidUntil - Date.now()) / 60000).toFixed(0);
    logEvent("filter", `[AVOID] Entry hold active - ${minsLeft}min remaining (timestamp authoritative)`);
  }
  // Agent can extend hold if still saying avoid when timer expires
  if (!avoidHoldActive && agentBias === "avoid" && state._avoidUntil) {
    const extendUntil = Date.now() + 30 * 60 * 1000;
    state._avoidUntil = extendUntil;
    logEvent("filter", `[AVOID] Hold extended - agent still says avoid, 30min extension stamped`);
  }
  // BF-W2: Enforce macro-defensive cooldown - 30min block on same ticker after defensive close
  if (state._macroDefensiveCooldown) {
    // Clean expired entries
    const now30 = Date.now();
    for (const tk of Object.keys(state._macroDefensiveCooldown)) {
      if (now30 - state._macroDefensiveCooldown[tk] > 30 * 60 * 1000) delete state._macroDefensiveCooldown[tk];
    }
  }

  // MR calls bypass choppy block  -- extreme oversold in high-VIX is the ideal MR setup
  const spyRSIForMR   = (marketContext.spySignals && marketContext.spySignals.rsi) || state._lastSpyRSI || 50;
  const isMRCondition = spyRSIForMR <= 35 && state.vix >= 25;
  const below200MACallBlock = rb.gates.below200MACallBlock;
  // Derive allowed flags from rulebook gates (entry window still checked here for timing)
  const entryWindowOpen   = isEntryWindow("put", true) && !finalHourBlock && !suppressBlock;
  const callWindowOpen    = isEntryWindow("call", true) && !finalHourBlock && !suppressBlock;
  // Credit spreads: 9:45am start — options market needs 15min for reliable quotes
  // dryRunMode bypass: test-scan after hours needs to simulate credit execution
  const creditWindowOpen  = (isEntryWindow("call", false) && !finalHourBlock && !suppressBlock) || dryRunMode;
  // ── V3.2: Compute new regime gates inline ───────────────────────────────
  // Post-crisis lock: block debit puts for 10 trading days after C→B transition
  const postCrisisLockActive = !!(state._postCrisisLock && state._postCrisisLockExpiry && Date.now() < state._postCrisisLockExpiry);
  if (postCrisisLockActive && !dryRunMode) {
    const daysLeft = Math.ceil((state._postCrisisLockExpiry - Date.now()) / 86400000);
    logEvent("filter", `[REGIME] Post-crisis recovery lock active — debit puts blocked (${daysLeft}d remaining)`);
  }

  // VIX spike cooldown: block debit puts for 48h after VIX spike > 8pt
  // Credit spreads still allowed (elevated IV benefits premium selling)
  const SPIKE_COOLDOWN_MS = 48 * 3600 * 1000;
  const vixSpikeCooldownActive = !!(state._vixSpikeAt && (Date.now() - state._vixSpikeAt) < SPIKE_COOLDOWN_MS);
  if (vixSpikeCooldownActive && !dryRunMode) {
    const hoursLeft = Math.ceil((SPIKE_COOLDOWN_MS - (Date.now() - state._vixSpikeAt)) / 3600000);
    logEvent("filter", `[REGIME] VIX spike cooldown active — debit puts blocked (${hoursLeft}h remaining). Credits still allowed.`);
  }
  // Auto-clear _vixSpikeAt after cooldown window expires (48h elapsed)
  // The primary guard is the 48h window — no additional VIX recovery check needed
  // (VIX recovery is monitored separately via _vixSustained and vixFallingPause)
  if (state._vixSpikeAt && !vixSpikeCooldownActive) {
    logEvent("filter", "[REGIME] VIX spike cooldown expired — debit put entries re-enabled");
    state._vixSpikeAt = null;
    markDirty();
  }

  // B1 gate: log sub-regime on CHANGE only (not every scan — would flood 500-entry log buffer)
  const _prevSubClass = state._lastLoggedSubClass;
  if (state._regimeSubClass !== _prevSubClass && !dryRunMode) {
    state._lastLoggedSubClass = state._regimeSubClass;
    if (state._regimeSubClass === "B1") {
      logEvent("warn", `[REGIME B1] Entered early bear sub-regime — min score 75, sizing 0.75x, reversal threshold 2.0%`);
    } else if (state._regimeSubClass === "B2") {
      logEvent("warn", `[REGIME B2] Entered confirmed bear sub-regime — full puts-on-bounces conviction, min score 70, sizing 1.0x`);
    } else if (_prevSubClass && !state._regimeSubClass) {
      logEvent("warn", `[REGIME] Exited Regime B sub-classification (now Regime ${state._regimeClass})`);
    }
  }

  const putsAllowed       = (entryWindowOpen && !rb.gates.vixFallingPause && !rb.gates.spyGapUpBlockPuts
                             && !rb.gates.postReversalBlock && !rb.gates.macroBullishBlock
                             && !rb.gates.choppyDebitBlock && !rb.gates.avoidHoldActive
                             && !rb.gates.crisisDebitBlock
                             && !postCrisisLockActive       // V3.2: no puts in post-crisis window
                             && !vixSpikeCooldownActive     // V3.2: no puts for 48h after VIX spike
                             ) || dryRunMode;
  const callsAllowed      = (callWindowOpen && !rb.gates.below200MACallBlock
                             && (!rb.gates.choppyDebitBlock || isMRCondition)
                             && !rb.gates.avoidHoldActive) || dryRunMode;
  const creditAllowed     = creditModeActive  && creditWindowOpen && !rb.gates.avoidHoldActive && !rb.gates.vixFallingPause;
  const callCreditAllowed = creditCallModeActive && creditWindowOpen && !rb.gates.avoidHoldActive;
  if (isMRCondition && choppyDebitBlock) logEvent("filter", `MR call allowed in choppy - SPY RSI ${spyRSIForMR.toFixed(1)} extreme oversold + VIX ${state.vix}`);
  if (creditAllowed && !putsAllowed) logEvent("filter", "Debit puts blocked - credit put spread mode active");
  if (callCreditAllowed)             logEvent("filter", "Bear call credit mode active");
  if (macroBullish && !dryRunMode)  logEvent("filter", `Macro bullish (${marketContext.macro?.signal}) - puts blocked`);
  if (rb.gates.vixFallingPause && !dryRunMode) logEvent("filter", "VIX falling - put entries paused");
  if (rb.gates.postReversalBlock && !dryRunMode) logEvent("filter", "Post-reversal cooldown active - puts blocked 30min");

  // - VIX SPIKE EXIT - close call positions on sharp VIX spike -
  // VIX jumping 8+ points intraday crushes call delta AND increases IV on short leg
  if (!dryRunMode) {
    const vixPrev = state._prevScanVIX || state.vix;
    const vixMove = state.vix - vixPrev;
    if (vixMove >= 8) {
      for (const pos of [...state.positions]) {
        if (pos.optionType === "call" && !isDayTrade(pos)) {
          const chgPct = pos.currentPrice && pos.premium
            ? (pos.currentPrice - pos.premium) / pos.premium : 0;
          if (chgPct <= -0.10) {
            logEvent("warn", `[VIX SPIKE] VIX +${vixMove.toFixed(1)}pts, call ${pos.ticker} down ${(chgPct*100).toFixed(0)}% - closing`);
            await closePosition(pos.ticker, "vix-spike", null, pos.contractSymbol || pos.buySymbol, { bypassPDT: true }); // emergency exit
          } else {
            logEvent("warn", `[VIX SPIKE] VIX +${vixMove.toFixed(1)}pts, call ${pos.ticker} at ${(chgPct*100).toFixed(0)}% - monitoring`);
          }
        }
      }
    }
    state._prevScanVIX = state.vix;
  }

  // - BREADTH COLLAPSE EXIT - close calls on sharp breadth deterioration -
  if (!dryRunMode) {
    const breadthNow  = typeof marketContext?.breadth === "number" ? marketContext.breadth * 100 : parseFloat((marketContext?.breadth || "50").toString()) || 50;
    const breadthPrev = state._prevBreadth || breadthNow;
    const breadthDrop = breadthPrev - breadthNow;
    if (breadthDrop >= 30 && breadthNow <= 35) {
      for (const pos of [...state.positions]) {
        if (pos.optionType === "call" && !isDayTrade(pos)) {
          logEvent("warn", `[BREADTH COLLAPSE] Breadth dropped ${breadthDrop.toFixed(0)}pts - ${breadthNow}% - closing call ${pos.ticker}`);
          await closePosition(pos.ticker, "breadth-collapse", null, pos.contractSymbol || pos.buySymbol);
        }
      }
    }
    state._prevBreadth = breadthNow;
  }

  // - SPY STRONG RECOVERY - exit losing puts -
  // If SPY is up 1%+ from prior close, the macro environment has reversed
  // This catches gap-up opens driven by news (ceasefire, Fed pivot, etc)
  // Close puts that are underwater - thesis is broken by the macro move
  if (!dryRunMode && spyBars.length >= 2) {
    const prevClose  = spyBars[spyBars.length-2].c;
    const curSPY     = spyBars[spyBars.length-1].c;
    const spyDayMove = (curSPY - prevClose) / prevClose;
    // V3.2: B1 uses tighter 2.0% threshold (early-bear bounces more likely real reversals)
    const _macroRevThreshold = (_rbBase && _rbBase.macroReversalThreshold) ? _rbBase.macroReversalThreshold : 0.025;
    if (spyDayMove > _macroRevThreshold) { // SPY up threshold% = genuine macro reversal (2.0% B1, 2.5% B2)
      let reversalCount = 0;
      // Panel CRITICAL #4: close ALL puts on macro-reversal, not just losing ones.
      // A 2.5% SPY spike breaks the puts-on-bounces thesis categorically.
      // A winning put left open through a genuine reversal can rapidly become a loss.
      // P&L at reversal time is not predictive of P&L after continuation.
      for (const pos of [...state.positions]) {
        if (pos.optionType !== "put") continue;
        const snap = posSnapshots[pos.contractSymbol];
        const quote  = snap ? (snap.latestQuote || {}) : {};
        const bid    = parseFloat(quote.bp || 0);
        const ask    = parseFloat(quote.ap || 0);
        const curP   = bid > 0 && ask > 0 ? (bid + ask) / 2 : pos.premium;
        const chg    = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
        const pnlLabel = chg >= 0 ? `+${(chg*100).toFixed(0)}%` : `${(chg*100).toFixed(0)}%`;
        logEvent("scan", `${pos.ticker} SPY macro reversal +${(spyDayMove*100).toFixed(1)}% - closing ALL puts (${pnlLabel}) - thesis broken`);
        await closePosition(pos.ticker, "macro-reversal", null, pos.contractSymbol || pos.buySymbol, { bypassPDT: true });
        reversalCount++;
      }
      // Record reversal event for condition-based cooldown
      if (reversalCount > 0) {
        state._macroReversalAt    = Date.now();
        state._macroReversalCount = reversalCount;
        state._macroReversalSPY   = spyBars[spyBars.length-1].c;
        logEvent("warn", `[REVERSAL COOLDOWN] ${reversalCount} position(s) closed - put entries gated until conditions confirm bearish`);
        markDirty();
      }
    }
  }
  if (!callsAllowed && !putsAllowed && !creditAllowed && !callCreditAllowed) return;

  // [opening/final hour blocks moved above callsAllowed]
  if (state.circuitOpen === false || state.weeklyCircuitOpen === false) return;

  // - ACT ON MORNING EXIT FLAGS -
  // Positions flagged by morning review get closed at open
  for (const pos of [...(state.positions || [])]) {
    if (pos._morningExitFlag) {
      logEvent("warn", `[MORNING REVIEW] Closing ${pos.ticker} flagged overnight - ${pos._morningExitReason}`);
      await closePosition(pos.ticker, "morning-review");
      delete pos._morningExitFlag;
      delete pos._morningExitReason;
    }
  }

  // consecutive loss gate removed - agent macro and score quality gates entries
  if (state.cash <= CAPITAL_FLOOR) return;

  // - PORTFOLIO GREEKS LIMITS -
  // Prevent extreme one-sided exposure
  const pgr = marketContext.portfolioGreeks || { delta: 0, vega: 0 };
  const MAX_PORTFOLIO_DELTA = -500; // max short delta (puts) = -$500 per 1% SPY move
  // RM-C1 fix: heat cap does not prevent adding OPPOSITE-direction positions when PDT-locked
  // If all positions are PDT-locked and losing, allowing a hedge is risk-reducing not risk-adding
  const allPDTLocked = state.positions.length > 0 &&
    state.positions.every(p => {
      const alpacaBal = state.alpacaCash || state.cash || 0;
      return alpacaBal < 25000 && ((Date.now() - new Date(p.openDate).getTime()) < MS_PER_DAY);
    });
  // Natenberg: VIX-scaled vega cap - high VIX = more volatile IV = tighter cap
  // At VIX 37, a $2000 vega position loses $2000 on a 1pt VIX move - too much
  const MAX_PORTFOLIO_VEGA  = state.vix >= 35 ? 500 : state.vix >= 25 ? 1000 : 2000;
  if (pgr.delta < MAX_PORTFOLIO_DELTA) {
    logEvent("filter", `Portfolio delta ${pgr.delta} too short - blocking new put entries`);
    if (!callsAllowed) return;
  }
  // Directional concentration + Beta-adjusted portfolio delta check (DB-1/GL-3)
  // Simple directional count
  const openPuts  = (state.positions || []).filter(p => p.optionType === "put").length;
  const openCalls = (state.positions || []).filter(p => p.optionType === "call").length;
  const totalOpen = state.positions.length;
  if (totalOpen >= 3 && openPuts === totalOpen) {
    logEvent("filter", `Directional concentration: ${totalOpen} puts, 0 calls - blocking new put entries`);
    if (!callsAllowed) return;
  }
  if (totalOpen >= 3 && openCalls === totalOpen) {
    logEvent("filter", `Directional concentration: ${totalOpen} calls, 0 puts - blocking new call entries`);
    if (!putsAllowed) return;
  }
  // Beta-adjusted net delta - measures true correlated directional exposure
  // Each put = -1 delta unit - beta; each call = +1 delta unit - beta
  // Index instruments (beta ~1): SPY/QQQ/IWM/GLD each count as 1 unit
  const betaDelta = (state.positions || []).reduce((sum, p) => {
    const beta = Math.min(p.beta || 1.0, 2.0); // cap beta at 2 for sizing purposes
    const dir  = p.optionType === "put" ? -1 : 1;
    const contracts = p.contracts || 1;
    return sum + (dir * beta * contracts);
  }, 0);
  state._portfolioBetaDelta = parseFloat(betaDelta.toFixed(1));
  const MAX_BETA_DELTA = 6; // max 6 beta-weighted contracts in any direction
  if (betaDelta < -MAX_BETA_DELTA) {
    logEvent("filter", `Beta-adjusted delta ${betaDelta.toFixed(1)} - too short, blocking puts (max: -${MAX_BETA_DELTA})`);
    if (!callsAllowed) return;
  }
  if (betaDelta > MAX_BETA_DELTA) {
    logEvent("filter", `Beta-adjusted delta +${betaDelta.toFixed(1)} - too long, blocking calls (max: +${MAX_BETA_DELTA})`);
    if (!putsAllowed) return;
  }
  if (Math.abs(pgr.vega) > MAX_PORTFOLIO_VEGA) {
    logEvent("filter", `Portfolio vega $${pgr.vega.toFixed(0)} at VIX-scaled limit $${MAX_PORTFOLIO_VEGA} - blocking entries`);
    return;
  }

  // - DURATION DIVERSIFICATION CHECK -
  // PM-W1: Prevent all positions expiring in same cycle - one event hits everything
  // Allow entry only if there's at least one position expiring in a different month, OR no positions yet
  if (state.positions.length >= 2) {
    const expDates  = state.positions.map(p => p.expDate).filter(Boolean);
    const uniqueExp = new Set(expDates.map(d => d.slice(0, 7))); // YYYY-MM
    if (uniqueExp.size === 1 && state.positions.length >= 3) {
      // All in same month - check if new entry would be in the same month
      const sameMonthCap = 4; // max 4 positions in same expiry month
      if (state.positions.length >= sameMonthCap) {
        logEvent("filter", `Duration concentration: all ${state.positions.length} positions expire ${[...uniqueExp][0]} - capped at ${sameMonthCap}`);
        // Don't return - just log. Entry scoring will naturally space out expiries.
      }
    }
  }

  // - F8: High-beta correlation block -
  // Max 2 simultaneous positions with beta > 1.5 - prevents HOOD+ROKU+DKNG all open
  // These are effectively the same bet - all crash together in a market reversal
  const highBetaPositions = state.positions.filter(p => (p.beta || 1) > 1.5).length;
  if (highBetaPositions >= 2) {
    logEvent("filter", `High-beta correlation block - ${highBetaPositions} positions with beta>1.5 already open`);
    // Only block high-beta new entries - let lower beta through
  }

  // Burst entry cooldown - max 3 new positions per 10 minutes
  // Prevents over-concentration at a single market moment (e.g. after reset)
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const recentEntries = state.positions.filter(p => new Date(p.openDate).getTime() > tenMinAgo).length;
  if (recentEntries >= 3) {
    logEvent("filter", `Burst entry cooldown - ${recentEntries} positions opened in last 10min - waiting`);
    return;
  }

  // [SPY fetch moved above callsAllowed]

  // Gap detection - large gap down = put opportunity, gap up = call opportunity
  let marketGapDirection = null;
  if (spyBars.length >= 2) {
    const todayOpen = spyBars[spyBars.length-1].o;
    const prevClose = spyBars[spyBars.length-2].c;
    const gapPct    = (todayOpen - prevClose) / prevClose;
    if (Math.abs(gapPct) > MAX_GAP_PCT) {
      marketGapDirection = gapPct < 0 ? "down" : "up";
      logEvent("filter", `Market gap ${marketGapDirection} ${(Math.abs(gapPct)*100).toFixed(1)}% - blocking calls, allowing puts only`);
      // Don't return - allow puts to be evaluated on gap down days
    }
  }

  // Score and rank candidates
  // - PARALLEL PREFETCH - fetch all data for all stocks simultaneously -
  // This is the key performance optimization: instead of sequential API calls
  // per stock (~70s total), we fetch everything in parallel (~4s total)
  logEvent("scan", `Prefetching data for ${WATCHLIST.length} instruments in parallel...`);
  // OPT-4: declare before prefetch loop -- used in aggregate log after prefetch completes
  const scored = []; // moved here to avoid TDZ with the OPT-4 log
  let _zeroScoreCount = 0;

  const prefetchStart = Date.now();

  // OPT-8: Pre-filter -- skip full prefetch for stocks with no realistic path to entry
  // Mandatory include: open positions (need exit monitoring), news-flagged, stale cache
  // Saves 40-50% of prefetch API calls on typical scans where 20+ stocks score 0
  const _openPosTickers = new Set(state.positions.map(p => p.ticker));
  const _newsAlertTickers = new Set(
    (state._recentNewsAlerts || [])
      .filter(n => Date.now() - new Date(n.ts||0).getTime() < 30 * 60 * 1000)
      .map(n => n.ticker)
  );
  const PREFETCH_WATCHLIST = WATCHLIST.filter(stock => {
    if (_openPosTickers.has(stock.ticker)) return true; // always include open positions
    if (_newsAlertTickers.has(stock.ticker)) return true; // always include news-flagged
    if (stock.isIndex) return true; // always include index instruments (SPY/QQQ/TLT/GLD/XLE)
    const lastScore = state._scoreDebug?.[stock.ticker]?.putScore || state._scoreDebug?.[stock.ticker]?.callScore || 50;
    const lastTs    = state._scoreDebug?.[stock.ticker]?.ts || 0;
    const cacheAge  = Date.now() - lastTs;
    if (cacheAge > 5 * 60 * 1000) return true; // stale cache -- must refresh
    return lastScore >= 35; // only prefetch if last score was within striking distance
  });
  if (PREFETCH_WATCHLIST.length < WATCHLIST.length) {
    logEvent("scan", `[OPT-8] Pre-filter: prefetching ${PREFETCH_WATCHLIST.length}/${WATCHLIST.length} stocks (${WATCHLIST.length - PREFETCH_WATCHLIST.length} skipped -- low score + no position/news)`);
  }

  // Batch stock prefetch in groups of 10 - prevents 288 simultaneous connections
  const STOCK_BATCH = 10;
  const stockData = [];
  for (let i = 0; i < PREFETCH_WATCHLIST.length; i += STOCK_BATCH) {
    const batch = PREFETCH_WATCHLIST.slice(i, i + STOCK_BATCH);
    const results = await Promise.all(
      batch.map(async stock => {
        try {
          if (stock.isIndex) {
            // SPY/QQQ: skip individual stock calls (sector ETF, analyst, earnings quality)
            // Only fetch what matters for macro regime trading
            const [price, bars, intradayBars, preMarket, newsArticles] = await Promise.all([
              getStockQuote(stock.ticker),
              getStockBars(stock.ticker, 60),
              getIntradayBars(stock.ticker),
              getPreMarketData(stock.ticker),
              getNewsForTicker(stock.ticker),
            ]);
            return { stock, price, bars, intradayBars, sectorResult: { pass:true, putBoost:0 }, preMarket, newsArticles, analystData:{ modifier:0, signal:"neutral", upgrades:[], downgrades:[] }, eqScore:{ signal:"neutral" } };
          }
          // Individual stocks: full prefetch (used when INDIVIDUAL_STOCKS_ENABLED = true at $25k)
          const [price, bars, intradayBars, sectorResult, preMarket, newsArticles, analystData, eqScore, liveBeta, weeklyTrend] = await Promise.all([
            getStockQuote(stock.ticker),
            getStockBars(stock.ticker, 60),
            getIntradayBars(stock.ticker),
            checkSectorETF(stock),
            getPreMarketData(stock.ticker),
            getNewsForTicker(stock.ticker),
            getAnalystActivity(stock.ticker),
            getEarningsQualityScore(stock.ticker, []),
            (function() {
              const cached = getCached('beta:' + stock.ticker);
              if (cached) return Promise.resolve(cached);
              return getLiveBeta(stock.ticker);
            })(),
            getWeeklyTrend(stock.ticker),
          ]);
          if (liveBeta && liveBeta > 0) {
            stock._liveBeta = liveBeta;
            setCache('beta:' + stock.ticker, liveBeta);
          }
          if (weeklyTrend) stock._weeklyTrend = weeklyTrend;
          return { stock, price, bars, intradayBars, sectorResult, preMarket, newsArticles, analystData, eqScore };
        } catch(e) {
          return { stock, price: null, bars: [], intradayBars: [], sectorResult: { pass:true, putBoost:0 }, preMarket:null, newsArticles:[], analystData:{ modifier:0, signal:"neutral", upgrades:[], downgrades:[] }, eqScore:{ signal:"neutral" } };
        }
      })
    );
    stockData.push(...results);
  }

  if (_zeroScoreCount > 0) logEvent("filter", `[OPT-4] ${_zeroScoreCount} stocks scored 0 (no price/filtered before scoring) -- skipped verbose logs`);
  logEvent("scan", `Prefetch complete in ${((Date.now()-prefetchStart)/1000).toFixed(1)}s for ${WATCHLIST.length} instruments`);
  for (const { stock, price, bars, intradayBars, sectorResult, preMarket, newsArticles, analystData, eqScore } of stockData) {
    // Skip if already at max positions for this ticker
    const maxPerTicker = stock.isIndex ? 3 : 2;
    const existingForTicker = state.positions.filter(p => p.ticker === stock.ticker);
    const logicalExisting = new Set(existingForTicker.map(p => `${p.optionType}|${p.expDate}`)).size;
    const maxCombined = stock.isIndex ? 2 : 1;
    if (logicalExisting >= maxCombined) continue;

    // - F14: Check ticker blacklist -
    if ((state.tickerBlacklist || []).includes(stock.ticker)) {
      logEvent("filter", `${stock.ticker} blacklisted - skipping`);
      continue;
    }

    // Ticker cooldown - differentiated by exit reason
    // fast-stop: 15 min (fell fast, might keep falling, short buffer)
    // stop/hard-stop: 60 min (real losing trade, need confirmation before re-entry)
    // target/partial: 0 min (hit profit, conditions may still be valid)
    // 50ma-break/thesis/manual: 0 min (thesis-based exit, re-entry needs fresh signal anyway)
    const COOLDOWN_BY_REASON = { "fast-stop": 15, "stop": 60, "stop-loss": 60 };
    const recentClose = (state.closedTrades || []).find(t =>
      t.ticker === stock.ticker && t.closeTime &&
      (Date.now() - t.closeTime) < ((COOLDOWN_BY_REASON[t.reason] || 0) * 60 * 1000)
    );
    if (recentClose) {
      const cooldownMins = COOLDOWN_BY_REASON[recentClose.reason] || 0;
      const minsAgo   = ((Date.now() - recentClose.closeTime) / 60000).toFixed(0);
      const waitMins  = Math.ceil((cooldownMins * 60 * 1000 - (Date.now() - recentClose.closeTime)) / 60000);
      logEvent("filter", `${stock.ticker} cooldown - closed ${minsAgo}min ago (${recentClose.reason}) - wait ${waitMins}min`);
      continue;
    }

    // Wash sale detection - IRS disallows loss if same security re-entered within 30 days
    // Options on same underlying = "substantially identical" security under wash sale rules
    const WASH_SALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const washSaleClose = (state.closedTrades || []).filter(t => t.reason !== "reconcile-removed").find(t =>
      t.ticker === stock.ticker &&
      t.pnl < 0 &&               // was a loss
      t.closeTime &&
      (Date.now() - t.closeTime) < WASH_SALE_MS
    );
    if (washSaleClose) {
      const daysAgo = ((Date.now() - washSaleClose.closeTime) / MS_PER_DAY).toFixed(0);
      const daysRemaining = Math.ceil((WASH_SALE_MS - (Date.now() - washSaleClose.closeTime)) / MS_PER_DAY);
      logEvent("filter", `${stock.ticker} wash sale warning - loss of $${Math.abs(washSaleClose.pnl).toFixed(0)} closed ${daysAgo}d ago - ${daysRemaining}d remaining - entering anyway but flagging`);
      // Flag on the trade journal but don't block - trader may want to re-enter
      // The wash sale only matters for tax purposes, not trading logic
      stock._washSaleWarning = true;
    }

    if (!price || price < MIN_STOCK_PRICE) {
      _zeroScoreCount++;
      if (state._scoreDebug?.[stock.ticker]) logEvent("filter", `${stock.ticker} price $${price||0} unavailable or below min - skip`);
      if (!state._scoreDebug) state._scoreDebug = {};
      state._scoreDebug[stock.ticker] = { ts: Date.now(), price: price||0, putScore: 0, callScore: 0, effectiveMin: MIN_SCORE, putReasons: [], callReasons: [], signals: {}, blocked: ["no price data"] };
      continue;
    }

    // GLD-1: Gap check BEFORE passesFilter - prevents vol gap FAVORABLE logging on skipped tickers
    if (bars.length >= 2) {
      const overnightGap = Math.abs(bars[bars.length-1].o - bars[bars.length-2].c) / bars[bars.length-2].c;
      if (overnightGap > MAX_GAP_PCT) {
        logEvent("filter", `${stock.ticker} gap ${(overnightGap*100).toFixed(1)}% overnight - skip`);
        continue;
      }
      const intradayCrash = (bars[bars.length-1].o - price) / bars[bars.length-1].o;
      if (intradayCrash > 0.15) {
        logEvent("filter", `${stock.ticker} intraday crash ${(intradayCrash*100).toFixed(1)}% below open - skip (broken options market)`);
        continue;
      }
    }

    // Check for opposite sector bets before filtering
    const sectorPositions = state.positions.filter(p => p.sector === stock.sector);
    const hasSectorCall   = sectorPositions.some(p => p.optionType === "call");
    const hasSectorPut    = sectorPositions.some(p => p.optionType === "put");

    // Get filter result - even on fail, collect weakness signals for put scoring
    const filterResult = await checkAllFilters(stock, price, bars); // OPT3: pass prefetched bars

    // Collect weakness signals that boost put scores
    // CAP: max +20 total weakness boost - prevents whole-sector selloffs
    // from pushing every stock to 100 with no differentiation
    let weaknessBoost = 0;
    const weaknessReasons = [];
    const MAX_WEAKNESS_BOOST = 20;

    const avgVol      = bars.length ? bars.slice(0,-1).reduce((s,b)=>s+b.v,0)/Math.max(bars.length-1,1) : 0;
    const todayVol    = bars.length ? bars[bars.length-1].v : 0;

    // Relative strength vs SPY - declared early so weakness boost can use it
    const stockReturn = bars.length >= 5 ? (bars[bars.length-1].c - bars[0].o) / bars[0].o : 0;
    const relStrength = spyReturn !== 0 ? (1 + stockReturn) / (1 + spyReturn) : 1;

    if (!filterResult.pass) {
      const putRelevantFails = ["sector ETF", "support", "VWAP", "breakdown"];
      const isPutRelevant = putRelevantFails.some(f => filterResult.reason?.includes(f));
      if (!isPutRelevant) {
        logEvent("filter", `${stock.ticker} filter fail: ${filterResult.reason}`);
        if (!state._scoreDebug) state._scoreDebug = {};
        state._scoreDebug[stock.ticker] = { ts: Date.now(), price: price||0, putScore: 0, callScore: 0, effectiveMin: MIN_SCORE, putReasons: [], callReasons: [], signals: {}, blocked: [`pre-score filter: ${filterResult.reason}`] };
        continue;
      }
      // Sector ETF boost - scaled by how much this stock lags its ETF
      // If stock and ETF both down equally = market risk, not stock-specific weakness
      const etfReturn  = sectorResult.etfReturn || 0;
      const stockVsEtf = etfReturn !== 0 ? (1 + stockReturn) / (1 + etfReturn) - 1 : 0;
      const etfBoost   = stockVsEtf < -0.02 ? 15  // stock down 2%+ more than ETF = real weakness
                       : stockVsEtf < 0      ? 8   // stock lagging ETF slightly
                       : 5;                         // keeping pace = sector-wide move only
      weaknessBoost += etfBoost;
      weaknessReasons.push(`Sector ETF down, stock ${stockVsEtf < 0 ? "lagging" : "in line"} (+${etfBoost})`);
      if (filterResult.reason?.includes("support")) { weaknessBoost += 10; weaknessReasons.push(`Near support breakdown (+10)`); }
    }

    // Relative weakness vs sector peers - only meaningful edge if stock is lagging ITS sector
    // If everything scores 100 because the whole market is down, that's not signal
    // Calculate average return of same-sector stocks and compare this stock against it
    const sectorPeers  = stockData.filter(d => d.stock.sector === stock.sector && d.stock.ticker !== stock.ticker && d.bars && d.bars.length >= 5);
    const sectorAvgRet = sectorPeers.length
      ? sectorPeers.reduce((s, d) => s + (d.bars[d.bars.length-1].c - d.bars[0].o) / d.bars[0].o, 0) / sectorPeers.length
      : stockReturn;
    const relToSector  = sectorAvgRet !== 0 ? (1 + stockReturn) / (1 + sectorAvgRet) : 1;
    // Store on liveStock for use in scoring
    // relToSector < 1.0 = underperforming peers = genuine relative weakness

    // Gap check moved above checkAllFilters (GLD-1 fix)

    // Anomaly detection - skip if price is zero or clearly bad data
    if (!price || price <= 0 || price > 100000) { logEvent("filter", `${stock.ticker} price anomaly: invalid price $${price} - skip`); continue; }

    // Dynamic signals - calculated live from real price bars
    if (bars.length < 10) {
      logEvent("filter", `${stock.ticker} insufficient bars (${bars.length}) - skip`);
      if (!state._scoreDebug) state._scoreDebug = {};
      state._scoreDebug[stock.ticker] = { ts: Date.now(), price: price||0, putScore: 0, callScore: 0, effectiveMin: MIN_SCORE, putReasons: [], callReasons: [], signals: {}, blocked: [`insufficient bars (${bars.length})`] };
      continue;
    }
    const signals = await getDynamicSignals(stock.ticker, bars, intradayBars, stock._realIV || null);

    // Earnings quality score
    // eqScore already prefetched in parallel above

    // VWAP - use intraday VWAP from signals (available before liveStock is built)
    const vwap = signals.intradayVWAP > 0 ? signals.intradayVWAP : calcVWAP(bars.slice(-5));
    // 1D: VWAP as entry timing soft filter
    // Bear call entries: prefer when price is BELOW VWAP (confirms bearish intraday bias)
    // Bull put / debit put entries: prefer when price is below VWAP (momentum aligned)
    // This is a soft filter - logged but doesn't hard-block
    if (vwap > 0) {
      const vwapBias = price < vwap ? "below_vwap" : "above_vwap";
      const vwapPct  = ((price - vwap) / vwap * 100).toFixed(1);
      if (Math.abs(price - vwap) / vwap > 0.005) { // only log if >0.5% from VWAP
        logEvent("scan", `[VWAP] ${stock.ticker} $${price.toFixed(2)} vs VWAP $${vwap.toFixed(2)} (${vwapPct}%) - ${vwapBias}`);
      }
      // Bear call credit: strongly prefer below VWAP (market already weak intraday)
      // putSetup/callSetup not yet initialized here -- creditCallModeActive already implies call direction
      if (creditCallModeActive && price > vwap * 1.03) { // panel: raised 1%→3% — 1% fired on normal intraday moves
        logEvent("filter", `[VWAP] ${stock.ticker} bear call skipped - price ABOVE VWAP by ${vwapPct}% (wait for intraday weakness)`);
        continue;
      }
    }
    if (vwap > 0 && price < vwap * 0.99) {
      // Scale VWAP boost by how far below - more below = stronger signal
      const vwapGap   = (vwap - price) / vwap;
      const vwapPts   = vwapGap > 0.03 ? 10 : vwapGap > 0.01 ? 6 : 3;
      logEvent("filter", `${stock.ticker} price $${price} below ${signals.intradayVWAP > 0 ? 'intraday' : 'daily'} VWAP $${vwap} (${(vwapGap*100).toFixed(1)}% gap) - put boost +${vwapPts}`);
      weaknessBoost += vwapPts;
      weaknessReasons.push(`Below VWAP ${(vwapGap*100).toFixed(1)}% (+${vwapPts})`);
    }

    // Pre-market gap - logged for context, direction-aware penalty applied after optionType resolved
    // Gap day context log (Richard/panel): explicit line when gap >4% so dashboard is readable at a glance
    if (preMarket && Math.abs(preMarket.gapPct || 0) > 4) {
      logEvent("scan", `[GAP DAY] ${stock.ticker} ${(preMarket.gapPct > 0 ? 'gap-up' : 'gap-down')} ${Math.abs(preMarket.gapPct).toFixed(1)}% — bear calls need intraday confirmation`);
    }
    if (preMarket && Math.abs(preMarket.gapPct) > 3) {
      logEvent("filter", `${stock.ticker} pre-market gap ${preMarket.gapPct > 0 ? "+" : ""}${preMarket.gapPct}%`);
    }

    // Short interest - computed from prefetched bars
    const shortSignal = { signal: "neutral", modifier: 0 }; // short interest disabled

    // News sentiment - already prefetched
    const newsSentiment = analyzeNews(newsArticles);

    // Merge live signals into stock object - intraday signals override static seed values
    // Attempt live beta fetch - use watchlist beta as fallback
    const liveBeta  = stock._liveBeta || stock.beta || 1.0;

    const liveStock = {
      ...stock,
      price:         price,
      rsi:           signals.rsi,       // intraday RSI -- display/timing only
      dailyRsi:      (signals && typeof signals.dailyRsi === "number") ? signals.dailyRsi : (signals?.rsi || 50), // daily RSI -- scoring thresholds (V2.81), null-guarded
      macd:          signals.macd,
      momentum:      signals.momentum,  // now intraday momentum when available
      ivr:           signals.ivr,
      beta:          liveBeta,          // live beta overrides static watchlist value
      newsSentiment: newsSentiment.signal,
      intradayVWAP:  signals.intradayVWAP || 0,
      atrPct:        signals.atrPct || null,
      volPaceRatio:  signals.volPaceRatio || 1,
      hasIntraday:   signals.hasIntraday || false,
      ivPercentile:  signals.ivPercentile || 50,
    };
    // Log intraday data quality -- show both RSI values for transparency
    if (signals.hasIntraday) {
      logEvent("filter", `${stock.ticker} intraday RSI:${signals.rsi} dailyRSI:${signals.dailyRsi} MACD:${signals.macd} MOM:${signals.momentum} VWAP:$${signals.intradayVWAP?.toFixed(2)} VolPace:${signals.volPaceRatio?.toFixed(1)}x`);
      // V2.81: oversold tracker now uses daily RSI -- panel fix (scan-level was seconds, not days)
      // Daily RSI <=35 increments once per day via date-gated logic below
      updateOversoldTracker(stock.ticker, signals.dailyRsi);

      // V2.81: RSI history tracker for velocity penalty (3-session window)
      // Stores up to 5 daily RSI readings per ticker to detect fast RSI moves
      if (!state._rsiHistory) state._rsiHistory = {};
      // Always keep as array of objects {date, rsi} -- never flatten to numbers in place
      // Flatten only happens when passing to scoreIndexSetup (read-only, not stored)
      let rsiHist = state._rsiHistory[stock.ticker] || [];
      // Migrate legacy flat number arrays from previous builds
      if (rsiHist.length > 0 && typeof rsiHist[0] !== 'object') {
        rsiHist = []; // reset malformed history -- will rebuild correctly
      }
      const todayStr = getETTime().toISOString().slice(0, 10);
      // Only add one reading per day
      if (rsiHist.length === 0 || rsiHist[rsiHist.length - 1]?.date !== todayStr) {
        // V2.81 null guard: signals.dailyRsi can be undefined when bars are empty
        const dailyRsiVal = (signals && typeof signals.dailyRsi === "number") ? signals.dailyRsi : null;
        if (dailyRsiVal !== null) {
          rsiHist.push({ date: todayStr, rsi: dailyRsiVal });
          if (rsiHist.length > 5) rsiHist.shift(); // keep last 5 days only
        }
      }
      // Store as objects -- scoreIndexSetup reads rsiHist.map(r => r.rsi) at call time
      state._rsiHistory[stock.ticker] = rsiHist;

      // V2.81: Intraday oversold scan counter for MR stabilization gate
      // Counts consecutive intraday scans where RSI <=35 -- resets when RSI recovers
      // Used to prevent entering mean reversion calls at exact bottom (worst fills)
      if (!state._intradayOversoldScans) state._intradayOversoldScans = {};
      if (signals.rsi <= 35) {
        state._intradayOversoldScans[stock.ticker] = (state._intradayOversoldScans[stock.ticker] || 0) + 1;
      } else {
        state._intradayOversoldScans[stock.ticker] = 0;
      }
    }

    // Time of day adjustment - panel fix (V2.82)
    // Entry window: normal entries close at 3:00pm, MR calls allowed until 3:30pm
    // Score gate: replace 0.80x multiplier with flat min score (cleaner, no cliff effect)
    //   VIX 25-30 after 2:30pm: min score 85
    //   VIX 30+   after 2:30pm: min score 90
    // IV expansion into close makes last-hour options more expensive in high-VIX environments
    // Execution algo: spread partial fill risk rises significantly after 3:30pm
    // etHour/isLastHour/isLateDay use scan-level vars (etHourNow/isLastHour/isLateDay)
    const volDecline  = todayVol < avgVol * 0.7;

    // Panel fix: flat min score replaces 0.80x multiplier
    // timeOfDayMult kept at 1.0 - score penalty is now applied via timeOfDayMinScore gate below
    const timeOfDayMult = 1.0; // no longer used as multiplier - kept for compatibility
    // Entry window gate: block new entries after 3pm (MR exception handled at execution)
    // Normal entries: 3:00pm cutoff
    // Mean reversion calls: 3:30pm cutoff (capitulation has genuine overnight edge)
    const entryWindowClosed = etHourNow >= 15.0; // scan-level etHourNow
    // Afternoon minimum handled by evaluateEntry via rb.gates.afternoonMinActive

    // - F7: Weekly trend filter -
    // Fetch cached weekly trend (60-min cache, no extra API call)
    const weeklyTrend = stock._weeklyTrend || { trend: 'neutral', above10wk: null };

    // Score both call and put setups using live signals
    // Index instruments (SPY/QQQ) use dedicated macro-driven scoring
    let callSetup, putSetup;
    if (stock.isIndex) {
      const agentMacro  = state._agentMacro || {};
      // V2.81: use daily RSI for scoring thresholds (panel fix -- 1-min RSI is noise at regime level)
      // intraday RSI (liveStock.rsi) retained for VWAP/timing logs only
      const spyRSI      = liveStock.dailyRsi || liveStock.rsi || 50;
      const spyMACD     = liveStock.macd || "neutral";
      const spyMomentum = liveStock.momentum || "steady";
      // FIX B: breadth is now an object {breadthPct, advancing, declining, breadthStrength}
      // Previous code returned NaN→50 because parseFloat({object}) = NaN
      const breadthVal  = typeof marketContext?.breadth === "number"
        ? marketContext.breadth * 100
        : marketContext?.breadth?.breadthPct ?? 50;
      // Pass credit mode to scoreIndexSetup so RSI block and scoring adjust correctly
      // Scoring uses authRegimeName (price-based, computed once at scan top)
      // Agent signal/confidence/entryBias used for magnitude -- regime overridden by price classifier
      const scoringMacroBase  = { ...(agentMacro || {}), regime: authRegimeName, spyGapUp: !!spyGapUp };
      const scoringMacro = creditModeActive
        ? { ...scoringMacroBase, tradeType: "credit" }
        : scoringMacroBase;
      const putResult  = scoreIndexSetup(liveStock, "put",  spyRSI, spyMACD, spyMomentum, breadthVal, state.vix, scoringMacro);
      const callResult = scoreIndexSetup(liveStock, "call", spyRSI, spyMACD, spyMomentum, breadthVal, state.vix, scoringMacro);
      putSetup  = { score: putResult.score,  reasons: putResult.reasons,  tradeType: putResult.tradeType  || "spread", isMeanReversion: false };
      callSetup = { score: callResult.score, reasons: callResult.reasons, tradeType: callResult.tradeType || "spread", isMeanReversion: false };
      // Correlation suppression: QQQ correlated to SPY (0.90+)
      // Panel decision (7/8): allow both simultaneously at score -80 same direction
      // High conviction overrides correlation block - both signals are independently strong
      // Keep block when: score <80 OR directions are opposite
      // Combined heat cap enforced separately via heat % check
      if (stock.ticker === "QQQ") {
        const spyPutOpen  = state.positions.some(p => p.ticker === "SPY" && p.optionType === "put");
        const spyCallOpen = state.positions.some(p => p.ticker === "SPY" && p.optionType === "call");
        // Only suppress if score is below 80 - high conviction entries allowed through
        if (spyPutOpen  && putSetup.score  < 80) { putSetup.score  = Math.min(putSetup.score,  30); logEvent("filter", `QQQ corr-block: SPY put open, QQQ put score ${putSetup.score}<80 suppressed`); }
        if (spyCallOpen && callSetup.score < 80) { callSetup.score = Math.min(callSetup.score, 30); logEvent("filter", `QQQ corr-block: SPY call open, QQQ call score ${callSetup.score}<80 suppressed`); }
        // Also suppress opposite directions (SPY put + QQQ call = contradictory thesis)
        if (spyPutOpen  && callSetup.score > 0) { callSetup.score = Math.min(callSetup.score, 30); logEvent("filter", `QQQ corr-block: SPY put open, QQQ call contradicts direction`); }
        if (spyCallOpen && putSetup.score  > 0) { putSetup.score  = Math.min(putSetup.score,  30); logEvent("filter", `QQQ corr-block: SPY call open, QQQ put contradicts direction`); }
      }
      // Symmetric: suppress SPY at <80 when QQQ is open in same direction
      if (stock.ticker === "SPY") {
        const qqqPutOpen  = state.positions.some(p => p.ticker === "QQQ" && p.optionType === "put");
        const qqqCallOpen = state.positions.some(p => p.ticker === "QQQ" && p.optionType === "call");
        if (qqqPutOpen  && putSetup.score  < 80) { putSetup.score  = Math.min(putSetup.score,  30); logEvent("filter", `SPY corr-block: QQQ put open, SPY put score <80 suppressed`); }
        if (qqqCallOpen && callSetup.score < 80) { callSetup.score = Math.min(callSetup.score, 30); logEvent("filter", `SPY corr-block: QQQ call open, SPY call score <80 suppressed`); }
        if (qqqPutOpen  && callSetup.score > 0) { callSetup.score = Math.min(callSetup.score, 30); }
        if (qqqCallOpen && putSetup.score  > 0) { putSetup.score  = Math.min(putSetup.score,  30); }
        // Update scoreDebug after correlation suppression so tab shows actual scores
        if (state._scoreDebug?.[stock.ticker]) {
          state._scoreDebug[stock.ticker].putScore  = putSetup.score;
          state._scoreDebug[stock.ticker].callScore = callSetup.score;
          if (qqqPutOpen && putSetup.score <= 30) {
            state._scoreDebug[stock.ticker].blocked = [...(state._scoreDebug[stock.ticker].blocked||[]), "corr-block: QQQ put open, SPY suppressed to 30"];
          }
        }
      }

      // - GLD entry gate - DXY + SPY momentum + VIX (panel-validated) -
      if (stock.ticker === "GLD") {
        const dxy5d       = marketContext.dxy || { trend: "neutral", change: 0 };
        const spy5dReturn = spyBars.length >= 5 ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
        // Compute GLD 20MA for trend gate (needs recent GLD bars - use cached price as fallback)
        const gldMA20Live = (state._gldBars && state._gldBars.length >= 20)
          ? state._gldBars.slice(-20).reduce((s,b) => s + b.c, 0) / 20
          : 0;
        const gldCallGate = isGLDEntryAllowed("call", dxy5d, spy5dReturn, state.vix, liveStock.rsi, liveStock.price || 0, gldMA20Live);
        // Pass tradeIntent type so GLD gate can bypass RSI check for credit puts
        // In bear regime, credit mode routes to credit_call (sell calls above market)
        // In choppy/bull, credit mode routes to credit_put (sell puts below market)
        const _gldCreditType  = isBearTrend ? "credit_call" : "credit_put";
        const _gldIntentType  = (creditModeActive && putSetup.score >= MIN_SCORE) ? _gldCreditType : "debit_put";
        const gldPutGate  = isGLDEntryAllowed("put",  dxy5d, spy5dReturn, state.vix, liveStock.rsi, liveStock.price || 0, gldMA20Live, _gldIntentType);
        if (!gldCallGate.allowed) { callSetup.score = 0; logEvent("filter", gldCallGate.reason); }
        if (!gldPutGate.allowed)  { putSetup.score  = 0; logEvent("filter", gldPutGate.reason);  }
        // GLD min score 75 (panel decision: 80 was triple-locking with DXY + RSI gates)
        // Lowered to 75 - consistent with other instruments. Gates still require RSI >68 for puts.
        if (callSetup.score > 0 && callSetup.score < 75) { callSetup.score = 0; logEvent("filter", `GLD call score ${callSetup.score} below 75 minimum - hedge instrument requires high conviction`); }
        if (putSetup.score > 0  && putSetup.score  < 75) { putSetup.score  = 0; logEvent("filter", `GLD put score ${putSetup.score} below 75 minimum`); }
      }

      // - TLT entry gate - SPY 50MA + TLT own signals -
      if (stock.ticker === "TLT") {
        const spy5dReturn = spyBars.length >= 5 ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
        const spyPriceNow = spyBars.length ? spyBars[spyBars.length-1].c : 0;
        const tltRSILive  = liveStock.rsi || signals.rsi || null;
        const tltMomLive  = liveStock.momentum || signals.momentum || null;
        const tltCallGate = isTLTEntryAllowed("call", spyPriceNow, state._spyMA50 || 0, spy5dReturn, state._spyMA200 || 0, tltRSILive, tltMomLive);
        const tltPutGate  = isTLTEntryAllowed("put",  spyPriceNow, state._spyMA50 || 0, spy5dReturn, state._spyMA200 || 0, tltRSILive, tltMomLive);
        if (!tltCallGate.allowed) { callSetup.score = 0; logEvent("filter", tltCallGate.reason); }
        if (!tltPutGate.allowed)  { putSetup.score  = 0; logEvent("filter", tltPutGate.reason);  }
      }

      // - XLE entry gate - oil trend + RSI extremes -
      if (stock.ticker === "XLE") {
        const xleMA20Live = (state._xleBars && state._xleBars.length >= 20)
          ? state._xleBars.slice(-20).reduce((s,b) => s + b.c, 0) / 20
          : 0;
        const xleCallGate = isXLEEntryAllowed("call", liveStock.rsi, liveStock.momentum, state.vix, liveStock.price || 0, xleMA20Live, liveStock.dailyRsi);
        const xlePutGate  = isXLEEntryAllowed("put",  liveStock.rsi, liveStock.momentum, state.vix, liveStock.price || 0, xleMA20Live, liveStock.dailyRsi); // panel M4: passes dailyRsi for dual-condition block
        if (!xleCallGate.allowed) { callSetup.score = 0; logEvent("filter", xleCallGate.reason); }
        if (!xlePutGate.allowed)  { putSetup.score  = 0; logEvent("filter", xlePutGate.reason);  }
        // XLE is NOT correlated with SPY/QQQ group - independent oil driver
        // Do not suppress based on SPY/QQQ positions
      }
    } else {
      // Individual stocks: use scorePutSetup/scoreCallSetup
      // scoreSetup removed - scoreIndexSetup handles SPY/QQQ, scorePutSetup handles individual stocks
      callSetup = { score: 0, reasons: ["Individual stocks disabled"], tradeType: "none" };
      putSetup  = scorePutSetup(liveStock, relStrength, signals.adx, todayVol, avgVol, state.vix);
    }

    // Weekly trend adjustment - applies symmetrically to both puts and calls
    if (weeklyTrend.above10wk === true) {
      putSetup.score  = Math.max(0,  putSetup.score  - 10);
      putSetup.reasons.push(`Above 10-wk MA $${weeklyTrend.ma10w} - puts fighting trend (-10)`);
      callSetup.score = Math.min(95, callSetup.score + 8);
      callSetup.reasons.push(`Above 10-wk MA $${weeklyTrend.ma10w} - calls aligned with trend (+8)`);
      // Store for scoreIndexSetup reference
      liveStock._weeklyTrend = weeklyTrend;
    } else if (weeklyTrend.above10wk === false) {
      putSetup.score  = Math.min(95, putSetup.score  + 8);
      putSetup.reasons.push(`Below 10-wk MA $${weeklyTrend.ma10w} - aligned with downtrend (+8)`);
      callSetup.score = Math.max(0,  callSetup.score - 8);
      callSetup.reasons.push(`Below 10-wk MA $${weeklyTrend.ma10w} - calls fighting downtrend (-8)`);
      liveStock._weeklyTrend = weeklyTrend;
    }

    // Track relative weakness points to enforce group cap below
    let relWeaknessPoints = 0;

    // Volume scoring - applies to BOTH puts and calls, direction-aware
    const volRatio = avgVol > 0 ? todayVol / avgVol : 1;

    // Call volume scoring - accumulation days boost calls, distribution days penalize
    const priceAboveOpen = liveStock.price > (liveStock.intradayOpen || liveStock.price);
    if (callSetup.score > 0) {
      if (volRatio > 1.5 && priceAboveOpen) {
        callSetup.score = Math.min(100, callSetup.score + 10);
        callSetup.reasons.push(`High volume UP day - accumulation signal (+10)`);
      } else if (volRatio < 0.7 && !priceAboveOpen) {
        callSetup.score = Math.min(100, callSetup.score + 8);
        callSetup.reasons.push(`Low volume pullback - healthy dip, call entry (+8)`);
      } else if (volRatio > 1.5 && !priceAboveOpen) {
        callSetup.score = Math.max(0, callSetup.score - 8);
        callSetup.reasons.push(`High volume DOWN day - distribution, wrong for calls (-8)`);
      }
    }

    // Put volume context - high volume confirms distribution, but capitulation
    // (extreme high volume) can signal reversal. Use nuanced scoring.
    if (volRatio > 2.0) {
      // Extreme volume - could be capitulation (reversal) or panic (continuation)
      // Slight put boost but less than moderate high volume
      putSetup.score = Math.min(100, putSetup.score + 5);
      putSetup.reasons.push(`Extreme volume - possible capitulation (+5)`);
    } else if (volRatio > 1.3) {
      // Above average volume - confirms selling pressure
      putSetup.score = Math.min(100, putSetup.score + 8);
      putSetup.reasons.push(`High volume confirms selling pressure (+8)`);
    } else if (volRatio < 0.6) {
      // Low volume selloff - exempt Regime B: low vol pullbacks are normal in bear trends
      const inBearForVol = ["B","C"].includes(state._regimeClass);
      if (!inBearForVol) {
        putSetup.score = Math.max(0, putSetup.score - 3);
        putSetup.reasons.push(`Low volume selloff (-3)`);
      } else {
        putSetup.reasons.push(`Low volume selloff - Regime B exempt (+0)`);
      }
    }

    // V2.82: time of day multiplier replaced by flat min score gate (see timeOfDayMinScore above)
    // Scores are no longer modified - the gate is applied in finalMinScore below

    // Unusual options activity boost - high vol/OI ratio means big money is moving
    // This uses today's options volume vs open interest on the selected contract
    // Applied after contract selection since volOIRatio comes from executeTrade context
    // Note: logged in executeTrade when volOIRatio > 3

    // SPY recovery suppresses puts - market bouncing = puts fighting the tape
    // BYPASS: when agent says puts_on_bounces, the gap-up IS the entry signal - don't penalize
    // The agent already assessed the bounce and determined it's a fade opportunity
    // BYPASS: credit puts - SPY recovering is GOOD for credit puts (short put moves further OTM)
    //   selling premium above the market, recovery = more cushion, not a headwind
    const putsOnBouncesBias  = (state._agentMacro || {}).entryBias === "puts_on_bounces";
    const bearRegimeRecovery = ["trending_bear","breakdown"].includes(state._regimeClass === "B" ? "trending_bear" : state._regimeClass === "C" ? "breakdown" : "other");
    const isCreditPutMode    = creditModeActive; // credit put = sell premium, recovery = good
    if (spyRecovering && !(putsOnBouncesBias && bearRegimeRecovery) && !isCreditPutMode) {
      putSetup.score = Math.max(0, putSetup.score - 20);
      putSetup.reasons.push("SPY recovering - tape fighting puts (-20)");
    } else if (spyRecovering && putsOnBouncesBias) {
      putSetup.reasons.push("SPY recovering but agent says puts_on_bounces - bounce fade thesis (+0)");
    } else if (spyRecovering && isCreditPutMode) {
      putSetup.reasons.push("SPY recovering - credit put benefits (short put moves further OTM) (+0)");
    }

    // Relative sector weakness - real edge vs just broad market selloff
    // GROUP CAP: SPY weakness + sector peer weakness + weekly MA together capped at 25pts
    // Prevents broad selloffs from adding 38+ pts of undifferentiated market weakness
    const SPY_WEAKNESS_GROUP_CAP = 25;

    if (relToSector < 0.97) {
      const relBoost = relToSector < 0.93 ? 15 : 8;
      const cappedRelBoost = Math.min(relBoost, Math.max(0, SPY_WEAKNESS_GROUP_CAP - relWeaknessPoints));
      if (cappedRelBoost > 0) {
        putSetup.score = Math.min(95, putSetup.score + cappedRelBoost);
        putSetup.reasons.push(`Weak vs sector peers: ${((relToSector-1)*100).toFixed(1)}% (+${cappedRelBoost})`);
        relWeaknessPoints += cappedRelBoost;
      } else {
        putSetup.reasons.push(`Weak vs sector peers: ${((relToSector-1)*100).toFixed(1)}% (+0 - group cap reached)`);
      }
    } else if (relToSector > 1.03) {
      putSetup.score = Math.max(0, putSetup.score - 10);
      putSetup.reasons.push(`Outperforming sector peers (+${((relToSector-1)*100).toFixed(1)}%) - sector-wide move (-10)`);
    }

    // Volume pace boost - if running 2x+ expected volume, strong signal either direction
    if (signals.volPaceRatio > 2.0 && signals.hasIntraday) {
      putSetup.score  = Math.min(100, putSetup.score + 8);
      putSetup.reasons.push(`Volume running ${signals.volPaceRatio.toFixed(1)}x pace (+8)`);
      callSetup.score = Math.min(100, callSetup.score + 8);
      callSetup.reasons.push(`Volume running ${signals.volPaceRatio.toFixed(1)}x pace (+8)`);
    } else if (signals.volPaceRatio < 0.4 && signals.hasIntraday) {
      // Quiet tape - reduce conviction on both sides
      putSetup.score  = Math.max(0, putSetup.score - 5);
      callSetup.score = Math.max(0, callSetup.score - 5);
    }

    // Apply weakness boost to puts - filters that block calls become put signals
    if (weaknessBoost > 0) {
      // Hard cap at MAX_WEAKNESS_BOOST (20pts) - prevents market-wide selloffs
      // from pushing every stock to 100 with no differentiation
      // Raw boost can be 5-35 (sector ETF + VWAP + support) - always capped to 20
      const cappedBoost = Math.min(weaknessBoost, MAX_WEAKNESS_BOOST);
      putSetup.score  = Math.min(100, putSetup.score + cappedBoost);
      putSetup.reasons.push(...weaknessReasons);
      callSetup.score = Math.max(0, callSetup.score - cappedBoost);
      logEvent("filter", `${stock.ticker} weakness signals - put boost +${cappedBoost}${cappedBoost < weaknessBoost ? " (capped from +" + weaknessBoost + ")" : ""}`);
    }

    // VIX boost for puts - scaled, not flat
    // Flat +10 for all stocks when VIX>30 is undifferentiated - every stock gets same boost
    // Use a smaller base boost (max +5) so individual stock signals still matter
    if (state.vix >= 25) {
      const vixPutBoost = state.vix >= 35 ? 5 : state.vix >= 30 ? 3 : 2;
      putSetup.score = Math.min(100, putSetup.score + vixPutBoost);
      putSetup.reasons.push(`VIX ${state.vix.toFixed(1)} environment (+${vixPutBoost})`);
    }

    // Apply stock-level news modifier
    callSetup.score = Math.min(100, Math.max(0, callSetup.score + (newsSentiment.modifier || 0)));
    putSetup.score  = Math.min(100, Math.max(0, putSetup.score  - (newsSentiment.modifier || 0)));

    if (newsSentiment.signal !== "neutral") {
      logEvent("news", `${stock.ticker} news: ${newsSentiment.signal} | modifier: ${newsSentiment.modifier > 0 ? "+" : ""}${newsSentiment.modifier}`);
    }

    // Apply analyst modifier
    if (analystData.modifier !== 0) {
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + analystData.modifier));
      putSetup.score  = Math.min(100, Math.max(0, putSetup.score  - analystData.modifier));
      if (analystData.signal !== "neutral") {
        logEvent("news", `${stock.ticker} analyst: ${analystData.signal} | ${analystData.upgrades.length} upgrades / ${analystData.downgrades.length} downgrades`);
      }
    }

    // Earnings quality modifier
    if (eqScore.signal === "positive") { callSetup.score = Math.min(100, callSetup.score + 8);  callSetup.reasons.push("Positive earnings history (+8)"); }
    if (eqScore.signal === "negative") { callSetup.score = Math.max(0,   callSetup.score - 8);  putSetup.score = Math.min(100, putSetup.score + 8); }

    // Factor model cross-check - use as secondary confirmation
    const factorResult = calcFactorScore(liveStock, signals, relStrength, newsSentiment.modifier, analystData.modifier);
    if (factorResult.total >= 70 && callSetup.score >= MIN_SCORE) {
      callSetup.score = Math.min(100, callSetup.score + 5);
      callSetup.reasons.push(`Factor model: ${factorResult.total}/100 (+5)`);
    }

    // Apply short squeeze signal
    if (shortSignal.modifier > 0) {
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + shortSignal.modifier));
      logEvent("filter", `${stock.ticker} squeeze potential: ${shortSignal.squeezeRisk} (+${shortSignal.modifier})`);
    }

    // Apply macro calendar modifier
    const calMod = (marketContext.macroCalendar || {}).modifier || 0;
    if (calMod !== 0) {
      // FOMC/macro calendar reduces calls only - puts are unaffected
      // FOMC day weakness = valid put opportunity, don't suppress it
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + calMod));
      // puts: no penalty on macro event days - market weakness is the signal
    }

    // Apply global market signal modifier
    const globalMod   = (marketContext.globalMarket || {}).modifier || 0;
    if (globalMod !== 0) {
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + globalMod));
      putSetup.score  = Math.min(100, Math.max(0, putSetup.score  - globalMod));
    }

    // Apply regime modifier
    const regimeMod   = getRegimeModifier(marketContext.regime?.regime || "neutral", "call");
    const regimePutMod= getRegimeModifier(marketContext.regime?.regime || "neutral", "put");
    // Apply regime to regular calls first - MR calls bypass this (applied after MR check below)
    putSetup.score    = Math.min(100, Math.max(0, putSetup.score  + regimePutMod));
    if (regimeMod !== 0) {
      callSetup.reasons.push(`Regime ${marketContext.regime?.regime}: ${regimeMod > 0 ? "+" : ""}${regimeMod}`);
    }

    // Mean reversion call scoring - runs AFTER regime so bypass works correctly
    // MR fires here so isMeanReversion flag is set before regime penalty check below
    const mrSetup = scoreMeanReversionCall(liveStock, relStrength, signals.adx, bars, state.vix);
    if (mrSetup.score > callSetup.score) {
      // MR liquidity check - contract not yet fetched at this stage
      // Use stock-level proxy: beta > 1.2 and sector with active options = liquid enough
      // Real OI/spread check happens at execution time via _cachedContract after prefetch
      const mrBeta    = stock.beta || 1.0;
      const mrSector  = stock.sector || "";
      // Index instruments (SPY/QQQ) are always liquid - most active options market in the world
      // For individual stocks: require beta >= 1.2 and non-Financial sector
      const mrLiquid  = stock.isIndex || (mrBeta >= 1.2 && mrSector !== "Financial");
      if (mrLiquid) {
        callSetup.score   = mrSetup.score;
        callSetup.reasons = mrSetup.reasons;
        callSetup.isMeanReversion = true;
        logEvent("filter", `${stock.ticker} MEAN REVERSION: score ${mrSetup.score} | beta:${mrBeta} | liquidity check deferred to execution`);
      } else {
        logEvent("filter", `${stock.ticker} MEAN REVERSION skipped - beta:${mrBeta} sector:${mrSector} (low liquidity proxy)`);
      }
    }

    // Now apply regime to calls - MR calls bypass this penalty (they're designed for bear markets)
    if (!callSetup.isMeanReversion) {
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + regimeMod));
    }

    // Apply drawdown protocol min score
    const ddProtocol  = marketContext.drawdownProtocol || { minScore: MIN_SCORE, sizeMultiplier: 1.0 };
    if (ddProtocol.pauseEntries) {
      logEvent("filter", `[DRAWDOWN] Entries paused - drawdown critical (${ddProtocol.message})`);
      continue;
    }
    const _circuit = getCircuitState();
    if (_circuit.open) {
      logEvent("filter", `[CIRCUIT] Entries paused - Alpaca API degraded (${_circuit.consecFails} consecutive failures)`);
      continue;
    }
    // BF-W4: Block entries when spiral is active for the same type
    if (state._spiralActive) {
      const spiralType = state._spiralActive;
      const spiralCount = (state._spiralTracker || {})[spiralType] || 0;
      logEvent("filter", `[SPIRAL] ${spiralType} spiral active (${spiralCount} consecutive losses) - ${spiralType} entries blocked. Fix thesis before re-entering.`);
      if (spiralType === "call") { callSetup = { score: 0, reasons: ["Spiral block"] }; }
      if (spiralType === "put")  { putSetup  = { score: 0, reasons: ["Spiral block"] }; }
    }

    // Apply macro modifier - boosts or suppresses all entries based on current events
    const macro       = marketContext.macro || { scoreModifier: 0, sectorBearish: [], sectorBullish: [] };
    let macroCallMod  = macro.scoreModifier || 0;
    // Puts only benefit from genuinely bearish macro - neutral is not a put signal
    // If macro is neutral (modifier = 0), puts get 0 boost not a bonus
    // If macro is bullish (modifier > 0), puts get penalized
    // EXCEPTION: puts_on_bounces in Regime B — mild bullish IS the fade setup, no penalty
    const agentMacroForScoring = (state._agentMacro || {}).signal || "neutral";
    const isBearishMacro = ["bearish", "strongly bearish", "mild bearish"].includes(agentMacroForScoring);
    const entryBiasNow   = (state._agentMacro || {}).entryBias || "neutral";
    // Belt-and-suspenders: check regime class directly in case entryBias is stale between agent runs
    const putsOnBouncesFade = (entryBiasNow === "puts_on_bounces" || ["B","C"].includes(state._regimeClass))
      && agentMacroForScoring === "mild bullish";
    // puts_on_bounces + mild bullish = bounce fade thesis — treat macro as neutral (0), not penalty
    let macroPutMod = isBearishMacro
      ? Math.abs(macro.scoreModifier || 0)
      : putsOnBouncesFade
        ? 0
        : -(macro.scoreModifier || 0);

    // Extra sector-specific adjustment
    if (macro.sectorBearish.includes(stock.sector)) { macroCallMod -= 10; macroPutMod += 10; }
    if (macro.sectorBullish.includes(stock.sector)) { macroCallMod += 8;  macroPutMod -= 8; }

    callSetup.score = Math.min(100, Math.max(0, callSetup.score + macroCallMod));
    putSetup.score  = Math.min(100, Math.max(0, putSetup.score  + macroPutMod));

    if (macroCallMod !== 0) {
      callSetup.reasons.push(`Macro ${macro.signal}: ${macroCallMod > 0 ? "+" : ""}${macroCallMod}`);
      putSetup.reasons.push(`Macro ${macro.signal}: ${macroPutMod > 0 ? "+" : ""}${macroPutMod}`);
    }

    // Apply gap direction constraint
    let callScore = callSetup.score;
    let putScore  = putSetup.score;
    // Gap direction filter: only applies in Regime A (bull market mean reversion)
    // In Regime B (bear trend), a gap UP is the puts_on_bounces entry signal - do NOT zero puts
    const inBearRegimeForGap = rb.isBearRegime; // from entryEngine rulebook
    const agentWantsPutsOnBounce = (state._agentMacro || {}).entryBias === "puts_on_bounces";
    if (marketGapDirection === "down" && !inBearRegimeForGap) { callScore = 0; recordGateBlock(stock.ticker, "gap_direction_down", authRegimeName, callScore); }
    if (marketGapDirection === "up"   && !inBearRegimeForGap && !agentWantsPutsOnBounce) { putScore = 0; recordGateBlock(stock.ticker, "gap_direction_up", authRegimeName, putScore); }
    // Apply entry window constraint
    if (!callsAllowed) { callScore = 0; recordGateBlock(stock.ticker, "calls_not_allowed", authRegimeName, callScore); }
    // Credit mode: allow put scoring even when debit puts blocked
    if (!putsAllowed && !creditAllowed) { putScore = 0; recordGateBlock(stock.ticker, "puts_not_allowed", authRegimeName, putScore); }
    else if (!putsAllowed && creditAllowed) {
      // Only credit spread entries allowed - still score for credit
      putSetup.tradeType = "credit";
    }

    // - Persist scores for dashboard watchlist ticker display -
    if (!state._lastScanScores) state._lastScanScores = {};
    state._lastScanScores[stock.ticker] = {
      call:      callScore,
      put:       putScore,
      best:      Math.max(callScore, putScore),
      direction: putScore >= callScore ? "put" : "call",
      rsi:       signals.rsi,
      macd:      signals.macd,
      momentum:  signals.momentum,
      price:     price,
      vwap:      signals.intradayVWAP || 0,
      updatedAt: Date.now(),
    };
    // Save score snapshot AFTER all zeroing/adjustments - reflects actual execution scores
    if (!state._scoreDebug) state._scoreDebug = {};
    state._scoreDebug[stock.ticker] = {
      ts: Date.now(), price, putScore, callScore,
      effectiveMin: MIN_SCORE,
      putReasons: putSetup.reasons, callReasons: callSetup.reasons,
      signals: { rsi: signals.rsi, dailyRsi: signals.dailyRsi, macd: signals.macd,
        momentum: signals.momentum, ivPercentile: signals.ivPercentile,
        volPaceRatio: signals.volPaceRatio, intradayVWAP: signals.intradayVWAP },
      blocked: [],
    };
    // In defensive mode - zero out call scores
    if (macro.mode === "defensive") callScore = 0;

    const bestScore = Math.max(callScore, putScore);
    const optionType = putScore > callScore ? "put" : "call";

    // Skip if defensive and best setup is still a call
    if (macro.mode === "defensive" && optionType === "call") {
      logEvent("filter", `${stock.ticker} - macro defensive mode - skipping calls`);
      continue;
    }
    const bestReasons = optionType === "put" ? putSetup.reasons : callSetup.reasons;

    // Score debug snapshot saved BELOW after gap/gate adjustments so it reflects actual execution scores
    // Score debug snapshot saved after gap/gate adjustments below

    // Pre-market gap direction-aware penalty - applied after optionType is known
    // Gap >3% up on a put entry = fading into rally = -8 conviction penalty
    // Gap >3% down on a call entry = buying into gap-down = -8 conviction penalty
    if (preMarket && Math.abs(preMarket.gapPct) > 3) {
      if ((optionType === "put" && preMarket.gapPct > 3) ||
          (optionType === "call" && preMarket.gapPct < -3)) {
        const chosenSetup = optionType === "put" ? putSetup : callSetup;
        chosenSetup.score = Math.max(0, chosenSetup.score - 8);
        chosenSetup.reasons.push(`Pre-market gap ${preMarket.gapPct > 0 ? "+" : ""}${preMarket.gapPct}% - entry into gap (-8)`);
      }
    }

    // Agent/regime minimums owned by entryEngine rulebook
    // etHourNow/isLateDay/isLastHour use scan-level vars declared at top of runScan
    const agentConf     = (state._agentMacro || {}).confidence || "low";
    const agentSig      = (state._agentMacro || {}).signal || "neutral";
    const agentLastRun  = (state._agentMacro || {}).timestamp || null;
    const agentStale    = !agentLastRun || ((Date.now() - new Date(agentLastRun).getTime()) / 60000) > 30;
    // Instrument-specific min scores - IWM removed (3yr net loser)
    // GLD uses 80+ with DXY/SPY gates applied upstream
    // below200MAPutMin REMOVED - regimeProfile already handles this via trending_bear/crash minScore
    // Keeping it created a conflict where isBearishHigh (score 65) was silently overridden to 80
    // - IVR floor gate - debit entries require elevated vol environment -
    // IVR < 15: options are historically cheap - buying premium has near-zero edge
    //           seen in 2023 Q2 where VIX<18 had 0% win rate across all instruments
    // IVR 15-25: options cheap - require higher conviction (80+ score) for debit entries
    // IVR >= 25: normal operating range - no extra gate
    // Credit spreads are EXEMPT - they benefit from selling in low-vol environments
    //
    // - BYPASS: VIX - 25 or Regime B/C -
    // Panel unanimous (7/7): the IVR gate was designed to prevent buying debit
    // options in calm, low-vol markets (VIX 12-18). It has no valid application
    // when VIX is already elevated (-25) or regime is already confirmed bear (B/C).
    // Problem: rolling window includes COVID spike (VIX 68), making VIX 31 appear
    // as the 3rd percentile. Gate fires incorrectly, blocking ideal put entries.
    // Fix: bypass entirely when vol is objectively elevated or regime is bear/crisis.
    // Panel fix: VIX - 25 alone is not sufficient - a single-day spike in Regime A
    // would bypass the floor, then IV collapses and the debit spread loses vega.
    // Require VIX - 25 AND regime not A (structural, not just a spike).
    // IVR diagnostics (gate logic owned by entryEngine rulebook)
    const ivrNow          = ivRankNow;
    const ivrDebitFloor   = 15;
    const ivrDebitCaution = 25;
    const ivrBypass       = rb.ivElevated || rb.isBearRegime || rb.isCrisis;
    if (!ivrBypass && ivrNow < ivrDebitFloor && !dryRunMode)
      logEvent("filter", `${stock.ticker} IVR ${ivrNow} low - debit options cheap (entryEngine gates)`);
    else if (!ivrBypass && ivrNow < ivrDebitCaution && !dryRunMode)
      logEvent("filter", `${stock.ticker} IVR ${ivrNow} below caution threshold`);
    const effectiveMinScore = MIN_SCORE; // stub -- entryEngine is min score authority
    if (agentStale && !dryRunMode) {
      const agentStaleMins = agentLastRun
        ? ((Date.now() - new Date(agentLastRun).getTime()) / 60000)
        : 999;
      logEvent("filter", `Agent macro stale (${agentStaleMins.toFixed(0)}min) - using keyword fallback. Last signal: ${agentSig || "none"}`);
      if (agentStaleMins > 90 && isMarketHours()) {
        logEvent("warn", `[AGENT] Macro analysis has not run in ${agentStaleMins.toFixed(0)} minutes - check API key and headlines`);
      }
    }

    // Stagger gate -- now owned by evaluateEntry (entryEngine.js)
    // evaluateEntry receives recentSameDir + existingProfitPct in context and handles blocking
    // BF-W2: Per-ticker macro-defensive cooldown kept here (separate from stagger -- ticker-level)
    if (state._macroDefensiveCooldown && state._macroDefensiveCooldown[stock.ticker]) {
      const cooldownMins = (Date.now() - state._macroDefensiveCooldown[stock.ticker]) / 60000;
      if (cooldownMins < 30) {
        logEvent("filter", `${stock.ticker} defensive cooldown ${cooldownMins.toFixed(0)}/30min - skipping re-entry`);
        continue;
      }
    }
    // sameTickerSameDir still needed to pass stagger context to evaluateEntry below
    const sameTickerSameDir = state.positions.filter(p => p.ticker === stock.ticker && p.optionType === optionType);
    // Credit spreads: hard limit 1 per ticker per direction (premium exposure management)
    if (creditModeActive && sameTickerSameDir.length >= 1) {
      logEvent("filter", `${stock.ticker} credit spread - already have ${sameTickerSameDir.length} position(s) in this direction`);
      continue;
    }

    // MACD contradiction  -- rulebook handles regime-awareness (A only, bypass in B via gate flag)
    const macdSignal    = liveStock.macd || "neutral";
    const macdBullish   = macdSignal.includes("bullish");
    const macdBearish   = macdSignal.includes("bearish");
    const isMRCall      = callSetup.isMeanReversion && optionType === "call";
    const dailyRsiNow   = liveStock.dailyRsi || liveStock.rsi || 50;
    // [Regime A only] gate  -- rb.gates.macdContradictsGate is false in B/C (bypassed)
    // MS panel: genuine contradiction requires MACD opposing AND RSI < 65 (not extended)
    const macdContradicts = rb.gates.macdContradictsGate && !creditModeActive &&
      ((optionType === "put" && macdBullish && dailyRsiNow < 65) ||
       (optionType === "call" && macdBearish && !isMRCall));
    // macdContradicts: server.js applies its own MACD check here (evaluateEntry gate removed)
    if (!rb.gates.macdContradictsGate && optionType === "put" && macdBullish && dailyRsiNow >= 68)
      logEvent("filter", `${liveStock.ticker} MACD bypass - RSI ${dailyRsiNow.toFixed(0)} overbought + bullish MACD in Regime B = bounce fade`);
    if (macdContradicts) logEvent("filter", `${liveStock.ticker} MACD ${macdSignal} contradicts ${optionType} - evaluateEntry raises minimum`);

    // Sizing modifier logged after EE_scoreCandidate runs (eeCandidate declared below)

    // V2.82: entry window gate - block new entries after 3pm (MR exception below)
    // Mean reversion calls (capitulation bounce) allowed until 3:30pm
    const isMREntry = (callSetup.isMeanReversion || putSetup.isMeanReversion);
    const mrWindowOpen = etHourNow < 15.5; // scan-level etHourNow
    if (entryWindowClosed && !dryRunMode) {
      if (!isMREntry) {
        logEvent("filter", `${stock.ticker} entry window closed (after 3pm) - normal entries blocked`);
        continue;
      } else if (!mrWindowOpen) {
        logEvent("filter", `${stock.ticker} MR entry window closed (after 3:30pm) - all entries blocked`);
        continue;
      }
    }
    // finalMinScore gate removed -- evaluateEntry (entryEngine.js) is the single authority
    // scoreDebug effectiveMin updated by entryEngine result below
    // macdMinScore / timeOfDayMinScore passed to evaluateEntry via context

    // - Correlation-aware directional heat cap -
    // SPY/QQQ/IWM are highly correlated - count combined as single direction
    // GLD has negative beta - call spreads on GLD during equity selloff = hedge
    // Don't count GLD toward put heat cap (it's an uncorrelated asset)
    const MAX_DIR_HEAT = 0.40;
    const isGLDHedge = stock.ticker === "GLD" && optionType === "call";
    const correlatedTickers = ["SPY","QQQ"]; // high correlation group (IWM removed - not in watchlist)
    const dirCost = state.positions
      .filter(p => {
        if (p.ticker === "GLD") return false; // GLD is a hedge, exclude from heat
        return p.optionType === optionType;
      })
      .reduce((s,p) => s + p.cost, 0);
    const dirHeat = dirCost / totalCap();
    // GLD call spreads bypass put heat cap - they're hedges not directional bets
    if (!isGLDHedge && dirHeat >= MAX_DIR_HEAT && !dryRunMode) {
      logEvent("filter", `${stock.ticker} ${optionType} directional heat ${(dirHeat*100).toFixed(0)}% at 40% cap - skip`);
      continue;
    }
    // Prevent 3 correlated equity index positions simultaneously (too concentrated)
    const correlatedPositions = state.positions.filter(p =>
      correlatedTickers.includes(p.ticker) && p.optionType === optionType
    );
    if (correlatedPositions.length >= 2 && correlatedTickers.includes(stock.ticker) && !dryRunMode) {
      logEvent("filter", `${stock.ticker} correlation cap - already have ${correlatedPositions.length} correlated ${optionType} positions`);
      continue;
    }

    // Block opposite direction on same ticker - directional strategy only
    const sameTickerOpposite = state.positions.find(p =>
      p.ticker === stock.ticker &&
      p.optionType !== optionType
    );
    if (sameTickerOpposite) {
      logEvent("filter", `${stock.ticker} same ticker opposite direction blocked - already have ${sameTickerOpposite.optionType}`);
      continue;
    }

    // Fast RSI move gate - rapid RSI moves signal potential reversals for DEBIT entries
    // Credit spreads: fast RSI crash = ideal (max fear premium) - bypass gate
    // TODO #2 FIX: Regime B exception — in bear regime, a fast RSI drop IS the puts_on_bounces setup
    // not a warning sign. Lower required score from 85→75 when entryBias=puts_on_bounces and RSI falling.
    const prevRSI = bars.length >= 2 ? calcRSI(bars.slice(0, -1)) : signals.rsi;
    const rsiMove = Math.abs(signals.rsi - prevRSI);  // intraday RSI move
    // Credit-only instruments (TLT) benefit from fast RSI moves — high IV = rich premium
    const instrAllowedTypes = (INSTRUMENT_CONSTRAINTS[stock.ticker] || {}).allowedTypes || [];
    const isCreditOnlyInstr = instrAllowedTypes.length > 0 && instrAllowedTypes.every(t => t.startsWith("credit"));
    // Fast RSI gate uses INTRADAY RSI which is noisy. Exempt when dailyRSI is in valid range.
    // V2.81 established daily RSI as the regime signal — a fast intraday drop with healthy
    // daily RSI (35-65) is the puts_on_bounces setup, not a warning sign.
    // Panel HIGH #2: tightened exemption band from 35-65 to 40-60.
    // At daily RSI edges (35-40 or 60-65), a fast intraday drop is more likely
    // trend-confirming than noise — the gate should still enforce there.
    const dailyRsiValid = (stock.dailyRsi || 50) >= 40 && (stock.dailyRsi || 50) <= 60;
    const fastRSIMove = rsiMove >= 15 && !creditModeActive && !isCreditOnlyInstr && !dailyRsiValid;
    if (fastRSIMove) {
      const putsOnBouncesBias = (state._agentMacro || {}).entryBias === "puts_on_bounces";
      const rsiIsFalling      = signals.rsi < prevRSI; // reversal, not momentum chase
      // Regime B bounce-fade: fast RSI drop + puts_on_bounces = exactly the setup
      const regimeBException  = putsOnBouncesBias && rsiIsFalling && optionType === "put";
      const fastRSIMin = regimeBException ? 75 : 85;
      if (bestScore < fastRSIMin) {
        logEvent("filter", `${stock.ticker} fast RSI move ${prevRSI.toFixed(0)}-${signals.rsi.toFixed(0)} (+${rsiMove.toFixed(0)}pts) - need score ${fastRSIMin}${regimeBException ? " (Regime B exception)" : ""}, have ${bestScore} - skip`);
        continue;
      }
      logEvent("filter", `${stock.ticker} fast RSI move ${rsiMove.toFixed(0)}pts - requiring high conviction (score ${bestScore} >= ${fastRSIMin}${regimeBException ? " Regime B" : ""})`);
    }
    logEvent("filter", `${stock.ticker} best setup: ${optionType.toUpperCase()} score ${bestScore} | RSI:${signals.rsi} MACD:${signals.macd} MOM:${signals.momentum}`);
    // Queue for execution - heat is rechecked live in the execution loop below
    const isMR = optionType === "call" && callSetup.isMeanReversion;
    // ENTRY ENGINE: score candidate  -- locks tradeIntent at score time
    const eeCandidate = EE_scoreCandidate(
      { ...liveStock, isMeanReversion: isMR },
      putSetup.score, callSetup.score,
      putSetup.reasons, callSetup.reasons,
      { rsi: signals.rsi, dailyRsi: signals.dailyRsi, macd: signals.macd,
        spyRecovering: !!(spyRecovering) },
      rb, state
    );
    // Size modifier log (eeCandidate now declared above)
    if (eeCandidate.sizeMod < 1.0) {
      logEvent("filter", `${stock.ticker} size modifier ${eeCandidate.sizeMod.toFixed(2)}x (entryEngine: oversold/crisis/IV)`);
    }
    // Merge entry engine result with scan data
    scored.push({
      stock: liveStock, price,
      score:           eeCandidate.score,
      reasons:         eeCandidate.reasons,
      optionType:      eeCandidate.optionType,
      isMeanReversion: isMR,
      tradeIntent:     eeCandidate.tradeIntent,
      sizeMod:         eeCandidate.sizeMod,
      constraintPass:  eeCandidate.constraintPass,
      constraintReason: eeCandidate.constraintReason || null,
      heatMultiplier:  eeCandidate.heatMultiplier || 1.0, // Bug 3 fix: was missing, execution loop destructures this
    });
  }

  // Sort by score descending
  scored.sort((a,b) => b.score - a.score);

  // - Relative score ranking - only enter top 20% of today's candidates -
  // Prevents entering 8 positions simultaneously on a broad selloff day
  // where every stock scores 90+ just because the market is down
  if (scored.length >= 5) {
    // For small watchlists (<=7), keep top 40% with minimum 2 candidates
    // For larger lists, keep top 20% — prevents flooding on broad selloffs
    // With only 5 instruments, 20% = 1 candidate which is too restrictive
    const pct  = scored.length <= 7 ? 0.40 : 0.20;
    const topN = Math.max(2, Math.ceil(scored.length * pct));
    const cutoffScore = scored[topN - 1]?.score || 0;
    const aboveCutoff = scored.filter(s => s.score >= cutoffScore);
    scored.length = 0;
    aboveCutoff.forEach(s => scored.push(s));
    logEvent("filter", `Score ranking: keeping top ${aboveCutoff.length} of ${scored.length + aboveCutoff.length} (cutoff: ${cutoffScore}, pct: ${Math.round(pct*100)}%)`);
  }

  // - PARALLEL OPTIONS PREFETCH -
  // Fetch options chains for all scored stocks simultaneously before executing
  // Skip options prefetch entirely if choppy and credit mode not active (nothing will enter)
  // Also skip if already at heat cap - entry will be blocked anyway, no need to fetch chains
  const skipPrefetch = (choppyDebitBlock && !creditModeActive) || (_heatPct >= effectiveHeatCap());
  if (skipPrefetch && !dryRunMode) {
    if (_heatPct >= effectiveHeatCap())
      logEvent("filter", `Heat ${_heatPctPc}% at cap - skipping options prefetch`);
    else
      logEvent("filter", `Choppy regime + low VIX - skipping options prefetch (no entries possible)`);
  }
  if (scored.length > 0 && !skipPrefetch) {
    logEvent("scan", `Prefetching options chains for ${scored.length} candidates in parallel...`);
    const optPrefetchStart = Date.now();
    // Process in batches of 5 to avoid exhausting Railway connection pool
    // 5 concurrent options fetches - up to 40 snapshot batches each = 200 max connections
    const BATCH_SIZE = 5;
    for (let i = 0; i < scored.length; i += BATCH_SIZE) {
      const batch = scored.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async ({ stock, price, optionType, score }) => {
        try {
          const isMR = optionType === "call" && (stock._isMeanReversion || false);
        const contract = await findContract(stock.ticker, optionType, isMR ? 0.40 : 0.35, isMR ? 21 : 28, state.vix, stock);
          if (contract) {
            stock._cachedContract = contract;
            // Store real IV from options market for use in scoring
            // This replaces the approximated IV from price bars
            if (contract.iv && contract.iv > 0) stock._realIV = contract.iv;
          }
        } catch(e) {}
      }));
    }
    logEvent("scan", `Options prefetch complete in ${((Date.now()-optPrefetchStart)/1000).toFixed(1)}s`);
  }

  // Enter trades - sorted by score, best first
  // heatPct() is live and updates after every executeTrade call
  for (const { stock, price, score, reasons, optionType, isMeanReversion, tradeIntent, constraintPass, constraintReason, sizeMod } of scored) {
    // Heat cap — panel: correlation multiplier removed (heat cap handles concentration)
    if (heatPct() >= effectiveHeatCap()) break;
    if (state.cash <= CAPITAL_FLOOR) break;

    const { pass, reason } = await checkAllFilters(stock, price, tradeIntent?.type || null);
    if (!pass) {
      const putBypassReasons = ["sector ETF", "support", "VWAP", "breakdown"];
      const canBypassForPut  = optionType === "put" && putBypassReasons.some(r => reason?.includes(r));
      if (!canBypassForPut) {
        logEvent("filter", `${stock.ticker} - ${reason}`);
        continue;
      }
      logEvent("filter", `${stock.ticker} - bypassing filter for PUT: ${reason}`);
    }

    // High-beta limit removed (panel: irrelevant for 5 index ETFs — SPY/QQQ/GLD/TLT/XLE)

    // Liquidity pre-check removed (panel: bid-ask gate in executeCreditSpread handles this)
    // Pre-entry agent check removed (panel: redundant API cost — score provides signal quality)

    // ENTRY ENGINE: evaluateEntry  -- single gate check using locked tradeIntent
    const intent     = tradeIntent || {};
    const intentType = intent.type || (optionType === "put" ? "debit_put" : "debit_call");

    // Build stagger context
    const sameTickerSameDirPos = state.positions.filter(p =>
      p.ticker === stock.ticker &&
      ((intentType.includes("put") && p.optionType === "put") ||
       (intentType.includes("call") && p.optionType === "call"))
    );
    const recentSameDirMins = sameTickerSameDirPos.length > 0
      ? Math.min(...sameTickerSameDirPos.map(p => (Date.now() - new Date(p.entryTime||0).getTime()) / 60000))
      : null;
    const existingProfitPct = sameTickerSameDirPos.length > 0
      ? Math.max(...sameTickerSameDirPos.map(p => parseFloat(p.pnlPct || 0)))
      : 0;
    // Panel M3: credit spread profit % = (premium - currentSpreadValue) / maxProfit
    // pnlPct for credit is negative when profitable (inverted), so compute separately
    const existingCreditProfitPct = sameTickerSameDirPos.length > 0
      ? Math.max(...sameTickerSameDirPos.map(p => {
          if (!p.isCreditSpread) return 0;
          const earned = (p.premium || 0) - (p.currentPrice || p.premium || 0);
          const maxP   = p.maxProfit || p.premium || 0;
          return maxP > 0 ? Math.min(1, Math.max(-1, earned / maxP)) : 0; // clamped -100% to +100%, 0.01 fallback removed (unsafe)
        }))
      : 0;
    const ddProtocol = marketContext.drawdownProtocol || { minScore: MIN_SCORE };

    // volDecline is per-stock (today vol < 70% avg) -- not available at execution scope
    // Pass false as safe default; evaluateEntry only uses it for afternoon gate edge case
    const _volDeclineExec = false;
    const eeResult = evaluateEntry(
      { ticker: stock.ticker, optionType, tradeType: intentType, score,
        constraintPass: constraintPass !== false,
        constraintReason: constraintReason || null,
        tradeIntent: intent },
      rb, state,
      { etHour: etHourNow, isLateDay, isLastHour, volDecline: _volDeclineExec,
        signals: { dailyRsi: stock.dailyRsi || stock.rsi || 50,
                   macd: stock.macd || "neutral" },
        recentSameDir:          recentSameDirMins,
        existingProfitPct,
        existingCreditProfitPct, // panel M3: % of max profit earned on credit spreads
        drawdownMinScore:    ddProtocol.minScore || MIN_SCORE }
    );
    if (!eeResult.pass) {
      logEvent("filter", `${stock.ticker} entry blocked - ${eeResult.reason}`);
      if (!dryRunMode) recordGateBlock(stock.ticker, eeResult.reason, rb.regimeName, score);
      continue;
    }

    // Derive execution path from locked intentType
    // Richard/Gilfoyle: log intentType immediately after pass — makes the dark gap visible
    logEvent("filter", `${stock.ticker} entry approved — intent:${intentType} score:${score} regime:${rb.regimeName}`);
    const useCreditSpread     = intentType === "credit_put"  && stock.isIndex && !isMeanReversion;
    const useCreditCallSpread = intentType === "credit_call" && stock.isIndex && !isMeanReversion;
    const useIronCondor       = intentType === "iron_condor" && stock.isIndex && !isMeanReversion && !dryRunMode
      && !state.positions.some(p => p.ticker === stock.ticker);
    const useSpread           = !useCreditSpread && !useCreditCallSpread && !useIronCondor
      && stock.isIndex && !isMeanReversion && intentType !== "debit_naked";
    const ivSizeMult          = rb.sizeMult.ivBoostCredit && intentType.startsWith("credit")
      ? rb.sizeMult.ivBoostCredit : 1.0;
    if ((useCreditSpread || useCreditCallSpread) && ivSizeMult > 1.0) {
      logEvent("scan", `[IV] ${stock.ticker} credit spread - IVR ${rb.ivRank} HIGH, size mult ${ivSizeMult}x`);
    }

    let entered = false;
    state._lastEntryType = null; // reset before each entry attempt
    // Gilfoyle: log which execution branch fires — critical for diagnosing silent non-entries
    const _branch = useIronCondor ? "iron_condor"
      : (useCreditSpread || useCreditCallSpread) ? `credit_${optionType}`
      : (useSpread || isMeanReversion) ? `debit_${optionType}`
      : "none";
    logEvent("filter", `${stock.ticker} execution branch: ${_branch} (creditSpread:${useCreditSpread} creditCall:${useCreditCallSpread} debit:${useSpread} MR:${isMeanReversion})`);
    if (useIronCondor) {
      state._lastEntryType = "iron_condor";
      logEvent("scan", `[IRON CONDOR] ${stock.ticker} choppy + IVR ${ivRankNow} - attempting iron condor`);
      const icPos = await executeIronCondor(stock, price, score, reasons, state.vix);
      entered = !!icPos;
    } else if (useCreditSpread || useCreditCallSpread) {
      state._lastEntryType = "credit";
      const _sizeMod = sizeMod || 1.0;
      // Panel/Gilfoyle: minIVPct gate — skip credit spreads when IV too low to reach 25% R/R
      // Uses ivPercentile (0-100 rank) rather than raw IV% — reliable across all instruments
      const _instrConstraint = INSTRUMENT_CONSTRAINTS[stock.ticker];
      const _ivPct = stock.ivPercentile || 50;
      if (_instrConstraint && _instrConstraint.minIVPct && _ivPct < _instrConstraint.minIVPct) {
        logEvent("filter", `${stock.ticker} credit spread skipped — IV rank ${_ivPct} below min ${_instrConstraint.minIVPct} (R/R math fails at low IV)`);
        entered = false;
      } else {
      const creditPos = await executeCreditSpread(stock, price, score, reasons, state.vix, optionType, _sizeMod, rb.spreadParams);
      entered = !!creditPos;
      } // end minIVPct gate
      // No debit fallback here — credit and debit are mutually exclusive strategies.
      // If credit R/R fails, the market is saying premium isn't rich enough to sell.
      // The correct response is to wait, not switch to buying puts into a crashed market.
    } else if (useSpread || isMeanReversion) {
      // Debit spread (directional) or MR call spread - both handled by executeDebitSpread
      const debitPos = await executeDebitSpread(stock, price, optionType, state.vix, score, reasons, sizeMod || 1.0, isMeanReversion);
      entered = !!debitPos;
      if (!debitPos) {
        continue;
      }
    } else {
      // useSpread=false, not credit, not MR - agent said naked or non-index
      // For index instruments this shouldn't happen - log and skip
      if (stock.isIndex) {
        logEvent("filter", `${stock.ticker} index trade type unclear (agent: ${agentTradeType}) - skipping`);
        continue;
      }
      const _sizeModDebit = sizeMod || 1.0;
      entered = await executeTrade(stock, price, score, reasons, state.vix, optionType, isMeanReversion, _sizeModDebit);
    }
    if (entered) await new Promise(r=>setTimeout(r,500));
  }

  // Individual stock buys disabled - SPY/QQQ only

  } // end else (no pending order)

  // SE-W4/SE-C2: Track actual scan interval for frequency drift monitoring
  const scanNow = Date.now();
  const lastScanMs = state.lastScan ? scanNow - new Date(state.lastScan).getTime() : 0;
  // Only record intervals that are plausible scan gaps (5s-120s)
  // Excludes: first boot gap (hours since last Redis write), hung scans >2min
  const isPlausibleInterval = lastScanMs >= 5000 && lastScanMs <= 120000;
  if (lastScanMs > 0 && isPlausibleInterval) {
    if (!state._scanIntervals) state._scanIntervals = [];
    state._scanIntervals.push(lastScanMs);
    if (state._scanIntervals.length > 30) state._scanIntervals = state._scanIntervals.slice(-30);
    const avgInterval = state._scanIntervals.reduce((s,v)=>s+v,0) / state._scanIntervals.length;
    state._avgScanIntervalMs = Math.round(avgInterval);
    // Alert if average scan interval >15s - only log once per boot to avoid spam
    if (avgInterval > 15000 && state._scanIntervals.length >= 5 && !state._perfWarnedThisBoot) {
      state._perfWarnedThisBoot = true;
      logEvent("warn", `[PERF] Scan frequency degraded - avg ${(avgInterval/1000).toFixed(1)}s (target: 10s)`);
    } else if (avgInterval <= 12000 && state._perfWarnedThisBoot) {
      // Clear flag once performance recovers
      state._perfWarnedThisBoot = false;
    }
  } else if (lastScanMs > 120000) {
    // Gap > 2min - log but don't pollute interval stats (restart gap, not scan drift)
    logEvent("scan", `[PERF] Scan gap ${(lastScanMs/1000/60).toFixed(1)}min since last scan (boot/restart)`);
  }
  // TODO #10: Data-only scoring pass for individual stocks
  // Scores all panel-approved stocks every scan but NEVER executes trades on them
  // Purpose: (1) validation data on scoring model, (2) surface manual opportunities,
  //          (3) provide scoring context signals (NVDA leading QQQ, JPM credit stress, etc.)
  // Panel hard cap: 10 stocks max. dataOnly:true stocks are always excluded from execution.
  const DATA_ONLY_STOCKS = INDIVIDUAL_STOCK_WATCHLIST.filter(s =>
    ["NVDA","JPM","TSLA","META","AMZN","PLTR","CRWD","UNH","CAT","COIN"].includes(s.ticker)
  );
  if (DATA_ONLY_STOCKS.length > 0 && isMarketHours()) {
    (async () => {
      try {
        if (!state._dataOnlyScores) state._dataOnlyScores = {};
        const agentMacro   = state._agentMacro || {};
        const regime       = agentMacro.regime || "neutral";
        const entryBias    = agentMacro.entryBias || "neutral";
        const dataFetches  = await Promise.all(
          DATA_ONLY_STOCKS.map(async stock => {
            try {
              const [price, bars, intradayBars] = await Promise.all([
                getStockQuote(stock.ticker),
                getStockBars(stock.ticker, 14).catch(() => []),
                getIntradayBars(stock.ticker, 78).catch(() => []),
              ]);
              if (!price || !bars || bars.length < 5) return null;
              const signals  = await getLiveSignals(stock.ticker, bars, intradayBars).catch(() => null);
              if (!signals) return null;
              const optionType  = entryBias === "calls_on_dips" ? "call" : "put";
              const spyRelStr   = price && state._liveSPY
                ? price / state._liveSPY
                : 1.0;
              // Use simplified scoring — no sector ETF fetch, just RSI/MACD/momentum
              const baseScore   = optionType === "put"
                ? scorePutSetup(stock, spyRelStr, signals.adx || 25, 1, 1, state.vix || 20)
                : scoreMeanReversionCall(stock, spyRelStr, signals.adx || 25, bars, state.vix || 20);
              const scoreVal    = baseScore?.score || 0;
              state._dataOnlyScores[stock.ticker] = {
                score: scoreVal,
                optionType,
                rsi:   signals.rsi,
                macd:  signals.macd,
                momentum: signals.momentum,
                updatedAt: Date.now(),
              };
              if (scoreVal >= 70) {
                logEvent("scan", `[DATA] ${stock.ticker} ${optionType.toUpperCase()} score ${scoreVal} — data-only signal (not trading)`);
              }
            } catch(e) { /* non-critical — don't let data pass crash main scan */ }
          })
        );
        // Wire key individual stock signals into scoring context
        // NVDA vs QQQ: if NVDA underperforms QQQ significantly, tech weakness is leading
        const nvdaScore = state._dataOnlyScores?.NVDA;
        const jpmScore  = state._dataOnlyScores?.JPM;
        if (nvdaScore?.rsi && nvdaScore.rsi < 35) {
          state._nvdaWeakness = true;
          logEvent("scan", `[DATA] NVDA RSI ${nvdaScore.rsi.toFixed(0)} — AI capex weakness signal, QQQ puts more valid`);
        } else { state._nvdaWeakness = false; }
        if (jpmScore?.rsi && jpmScore.rsi < 35) {
          state._jpmStress = true;
          logEvent("scan", `[DATA] JPM RSI ${jpmScore.rsi.toFixed(0)} — credit/banking stress signal`);
        } else { state._jpmStress = false; }
      } catch(e) { /* non-critical */ }
    })();
  }

  state.lastScan    = new Date().toISOString();
  state._scanFailures = 0;
  // Single Redis write at scan end - with timeout so a Redis hang can't block the scanner
  // If Redis is slow, markDirty() ensures the periodic flush interval catches it
  await Promise.race([
    saveStateNow(),
    new Promise(r => setTimeout(r, 3000)), // 3s timeout - don't let Redis block next scan
  ]).catch(() => { markDirty(); }); // on timeout: mark dirty, periodic flush will handle it
  } catch(e) {
    logEvent("error", `runScan crashed: ${e.message} | stack: ${e.stack?.split("\n")[1]?.trim() || "unknown"}`);
    // Track consecutive scan failures
    state._scanFailures = (state._scanFailures || 0) + 1;
    const n = state._scanFailures;
    // Email throttle: send on failures 1, 2, 3 (so you know immediately), then every 30
    // Prevents inbox flooding during extended crashes (7 emails per crash was too many)
    const shouldEmail = (n <= 3) || (n % 30 === 0);
    if (shouldEmail && RESEND_API_KEY && GMAIL_USER && isMarketHours()) {
      const subject = n <= 3
        ? `ARGO ALERT - Scanner crash #${n} (${e.message.slice(0,50)})`
        : `ARGO ALERT - Scanner still failing (${n} consecutive errors)`;
      Promise.race([
        sendResendEmail(
          subject,
          `<div style="font-family:monospace;background:#07101f;color:#ff5555;padding:20px">
          <h2>!! ARGO Scanner Error</h2>
          <p>Consecutive scan failures: <strong>${n}</strong></p>
          <p>Last error: ${e.message}</p>
          <p>Stack: ${e.stack?.split("\n")[1]?.trim() || "unknown"}</p>
          <p>Time: ${new Date().toISOString()}</p>
          <p>Open positions: ${state.positions.length}</p>
          <p>Cash: $${state.cash?.toFixed(2)}</p>
          ${n > 3 ? `<p style="color:#ffaa00">Note: emails suppressed between failure #4 and this one to avoid inbox flooding. Alerting every 30 failures.</p>` : ''}
          <p><strong>Check Railway logs immediately.</strong></p>
        </div>`
        ),
        new Promise(r => setTimeout(r, 5000)),
      ]).catch(() => {});
      logEvent("warn", `Scan failure alert sent - ${n} consecutive errors`);
    } else if (!shouldEmail) {
      logEvent("warn", `Scan failure #${n} - email suppressed (next alert at #${Math.ceil(n/30)*30})`);
    }
  } finally {
    // Reset failure counter on successful scan completion
    if (!state._scanFailures) state._scanFailures = 0;
    // Only reset scanRunning if this scan still owns it
    // (poll loops release scanRunning early - a new scan may have started)
    if (_scanGen === thisScanGen) scanRunning = false;
  }
}

// - TA-W2: ATR (Average True Range) calculation -
// Normalizes RSI/MACD signals by whether the current move is within normal range
// A 2% SPY move with ATR=0.5% is extreme; same 2% with ATR=2% is noise

// - ADX Calculation -

// - Email System -
// - F12: Enhanced morning briefing -


module.exports = {
  runScan,
  // Export mutable scanner state for server.js dashboard and API endpoints
  getScannerState: () => ({
    scanRunning, dryRunMode, marketContext,
    circuit: getCircuitState(),
  }),
  setDryRunMode: (v) => { dryRunMode = v; },
};
