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
  getCached, setCache } = require('./market');

const {
  scoreIndexSetup, scorePutSetup, scoreMeanReversionCall, // APEX: scoreCreditSpread and scoreDebitCallSpread removed — no spread scoring
  detectMarketRegime, getRegimeModifier, applyIntradayRegimeOverride,
  updateOversoldTracker, recordGateBlock, checkMacroShift,
  checkSectorETF, isGLDEntryAllowed, isXLEEntryAllowed, isTLTEntryAllowed,
  isIYREntryAllowed, isHYGEntryAllowed,
} = require('./scoring');

const {
  getRegimeRulebook, scoreCandidate: EE_scoreCandidate, evaluateEntry,
} = require('./entryEngine');
const { INSTRUMENT_CONSTRAINTS } = require('./entryEngine');

const {
  executeTrade,
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

const { sendMorningBriefing, sendEmail, setReportingContext , getBenchmarkComparison, sendResendEmail } = require('./reporting');

const {
  WATCHLIST, CAPITAL_FLOOR, MIN_SCORE, MIN_SCORE_CREDIT, MAX_HEAT,
  MAX_SECTOR_PCT, STOP_LOSS_PCT, FAST_STOP_PCT, FAST_STOP_HOURS,
  TAKE_PROFIT_PCT, PARTIAL_CLOSE_PCT, TRAIL_ACTIVATE_PCT, TRAIL_STOP_PCT,
  BREAKEVEN_LOCK_PCT, PDT_RULE_ACTIVE, PDT_LIMIT, PDT_PROFIT_EXIT, PDT_STOP_LOSS,
  MS_PER_DAY, TRIGGER_COOLDOWN_MS, SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL,
  INDIVIDUAL_STOCKS_ENABLED, INDIVIDUAL_STOCK_WATCHLIST, MONTHLY_BUDGET, MACRO_REVERSAL_PCT,
  TARGET_DELTA_MIN, TARGET_DELTA_MAX,
  ALPACA_KEY, ALPACA_SECRET, ALPACA_DATA, ALPACA_OPT_SNAP, ALPACA_OPTIONS,
  MAX_GAP_PCT, MIN_STOCK_PRICE, GMAIL_USER, RESEND_API_KEY, VIX_PAUSE, VIX_REDUCE25, VIX_REDUCE50,
} = require('./constants');

let scanRunning  = false;
let _scanGen       = 0;   // increments each scan - finally block only resets its own generation
let _lastScanStart = 0;   // timestamp of last scan start — read by watchdog via getScannerState()

// ─── Local utilities ─────────────────────────────────────────
const fmt = (n) => '$' + (n || 0).toFixed(2);
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

  // FIX 10: Reset daily circuit and P&L tracker at start of each new trading day
  const todayScanDate = scanET.toLocaleDateString("en-US", { timeZone: "America/New_York" });
  if (todayScanDate !== (state._lastScanDate || "")) {
    state._lastScanDate    = todayScanDate;
    state._dailyCircuitOpen = true;
    state._dailyPnL        = 0;
    state.todayRealizedPnL = state.todayRealizedPnL || 0; // reset in server.new.js at midnight
    logEvent("scan", `[DAILY RESET] New trading day ${todayScanDate} — daily circuit reset`);
    markDirty();
  }

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
  // V2.84 fix: if IVR comes out very low (<=20) but VIX is objectively elevated (>=25),
  // the rolling window has no low-VIX baseline (fresh start or reset during high-VIX period).
  // Also fires when P5 of rolling window is within 2pts of current VIX — meaning VIX is
  // near the bottom of the observed range, so rank underestimates true expensiveness.
  // Fall back to formula which is calibrated on full 2012-2024 cycle.
  // VIX 29 = ~52nd percentile historically. VIX 35 = ~70th. VIX 20 = ~24th.
  const _windowTooNarrowForRank = vixP5 > 0 && (newVIX - vixP5) < 2.0 && newVIX >= 25;
  if ((state._ivRank <= 20 || _windowTooNarrowForRank) && newVIX >= 20) {
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

    // ── Macro authority — agent is the only signal source ─────────────────
    // Keywords eliminated. Agent runs on headline delta in server.new.js interval.
    // Scanner reads state._agentMacro directly — no keyword scoring, no fallback.
    // Staleness: agent internally caps at 90 minutes. Scanner warns if > 30 min.
    const agentMacroForAuth = state._agentMacro;
    const agentAuthAge = agentMacroForAuth?.timestamp
      ? (Date.now() - new Date(agentMacroForAuth.timestamp).getTime()) / 60000 : 999;

    if (agentMacroForAuth) {
      // Use agent signal — fresh or held (stability threshold filters noise)
      const staleSuffix = agentAuthAge > 30 ? ` (⚠️ ${agentAuthAge.toFixed(0)}min stale)` : '';
      marketContext.macro = {
        signal:        agentMacroForAuth.signal || 'neutral',
        scoreModifier: agentMacroForAuth.modifier || 0,
        mode:          agentMacroForAuth.mode || 'normal',
        macroAuthority:'agent',
        confidence:    agentMacroForAuth.confidence || 'low',
        agentLastUpdated: agentMacroForAuth.timestamp,
        triggers:      agentMacroForAuth.catalysts || [],
      };
      if (agentAuthAge > 30 && !dryRunMode) {
        logEvent("warn", `[MACRO] Agent signal is ${agentAuthAge.toFixed(0)}min old — headline delta may be suppressing calls`);
      }
      if (marketContext.macro.mode !== 'normal') {
        logEvent("macro", `[5min] Macro: ${marketContext.macro.signal} via agent (${marketContext.macro.scoreModifier > 0 ? '+' : ''}${marketContext.macro.scoreModifier}) age:${agentAuthAge.toFixed(0)}min${staleSuffix}`);
      }
    } else {
      // No agent signal yet — neutral until first call completes
      marketContext.macro = { signal: 'neutral', scoreModifier: 0, mode: 'normal', macroAuthority: 'pending', triggers: [] };
      if (!dryRunMode) logEvent("warn", `[MACRO] No agent signal yet — neutral until startup analysis completes`);
    }

    // Alias marketContext.macro as 'macro' for backward compatibility with all scan loop references
    // Previously macro = await getMacroNews() — now it's set via agent authority block above
    const macro = marketContext.macro;

    // Bug 4 FIX: Compute agent staleness ONCE at scan scope for use in both:
    // (a) defensive close block below, and (b) per-instrument defensive zero/skip in scan loop.
    // Agent stale > 120min → treat defensive mode as neutral — don't block entries or close positions.
    const _agentAgeForDefensive = state._agentMacro?.timestamp
      ? (Date.now() - new Date(state._agentMacro.timestamp).getTime()) / 60000 : 999;
    const _agentFreshForDefensive = _agentAgeForDefensive < 120;
    // effectiveDefensive defined at scan scope above — available throughout runScan

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
    const agentFresh       = _agentFreshForDefensive; // Bug 4 FIX: uses scan-scope staleness
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
      // Bug 4 FIX: Agent stale >120min — do NOT fire defensive close.
      // A 5-hour-old bearish signal should not close calls at tomorrow's open.
      // Stale agent = treat as neutral. Log warning, resume normal operations.
      logEvent("warn", `[AGENT] Defensive triggered but agent stale (${agentAge.toFixed(0)}min) — treating as neutral, NOT closing calls`);
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
          const acc30val  = state._agentAccuracy.acc30;
          const acc120val = state._agentAccuracy.acc120;
          logEvent("scan", `[AGENT ACC] 30min: ${acc30val || "--"}% | 120min: ${acc120val || "--"}% | n=${state._agentAccuracy.calls} directional calls`);
          // Flag calibration concern if 30min accuracy is below random chance (50%)
          // Agent macro is used for timing and regime framing — low short-term accuracy is expected
          // but worth surfacing when sample size is sufficient (10+ resolved calls)
          const resolved30Total = state._agentAccuracy.calls - state._agentAccuracy.pending.filter(p => !p.resolved30).length;
          if (acc30val !== null && acc30val < 45 && resolved30Total >= 10) {
            logEvent("warn", `[AGENT ACC] 30min accuracy ${acc30val}% below 45% threshold (n=${resolved30Total}) — agent useful for regime framing, not short-term direction`);
          }
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
    // Wire DXY and yield curve into state so scoreCreditSpread can read them
    // scoreCreditSpread reads state._dxy and state._yieldEnv — these were never set
    if (dxy) state._dxy = { ...dxy, updatedAt: Date.now() };
    // _yieldEnv: derive from yield curve signal for TLT scoring
    // yc.signal: "steepening" = rising long rates (TLT falls), "flattening" = falling long rates (TLT rallies)
    // "normal" = flat curve. Map to _yieldEnv for TLT augmentation in scoreCreditSpread.
    if (yc && yc.signal) {
      state._yieldEnv = yc.signal === "steepening" ? "steepening"
                      : yc.signal === "flattening" ? "inverted"  // flattening = long rates falling = TLT bid = like inverted
                      : "normal";
    }
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
  if (spyPrice) {
    state._liveSPY = spyPrice;
    // Track SPY day change for debit call gate (don't buy calls into a down day)
    const spyPrevClose = state._spyPrevClose || spyPrice;
    state._spyDayChange = spyPrevClose > 0 ? (spyPrice - spyPrevClose) / spyPrevClose : 0;
  }
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

  // - SPY 5-DAY AVERAGE INTRADAY RANGE -
  // Measures how much SPY moves high-to-low each day as % of open
  // High range (2.5%+) = volatile chop — short strikes less safe, credit spread risk elevated
  // Updated every scan from daily bars. Same rolling pattern as _vixSustained.
  if (spyBars.length >= 2) {
    const todayBar = spyBars[spyBars.length - 1];
    const todayRange = todayBar.o > 0 ? (todayBar.h - todayBar.l) / todayBar.o : 0;
    if (!state._spyRangeHistory) state._spyRangeHistory = [];
    // Only push once per day — check last entry date vs today
    const _lastRangeDate = state._spyRangeDateLast || '';
    if (_lastRangeDate !== _todayStr && todayRange > 0) {
      state._spyRangeHistory.push(parseFloat(todayRange.toFixed(5)));
      if (state._spyRangeHistory.length > 5) state._spyRangeHistory.shift();
      state._spyRangeDateLast = _todayStr;
    }
    if (state._spyRangeHistory.length >= 1) {
      state._spyAvgRange = parseFloat(
        (state._spyRangeHistory.reduce((s, r) => s + r, 0) / state._spyRangeHistory.length).toFixed(5)
      );
    }
  }
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

  // finalHourBlock REMOVED — entry window already closes at 3pm (panel consensus).
  // 3:45pm block was redundant secondary backup. One clear rule: entries close at 3pm.
  const etHourEntry    = scanET.getHours() + scanET.getMinutes() / 60;
  const finalHourBlock = false; // removed — entry window governs

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
  const pdtBlocked    = PDT_RULE_ACTIVE && !dryRunMode && pdtCount >= PDT_LIMIT;
  if (pdtBlocked) logEvent("filter", `PDT limit reached (${pdtCount}/${PDT_LIMIT} day trades in 5 days) - same-day exits blocked, new entries still allowed`);

  // Agent macro signal gates puts - replaces blunt SPY recovery detector
  // puts blocked only when agent explicitly says aggressive/bullish AND SPY gap is large
  const spyGapUp = (() => {
    if (spyBars.length >= 2) {
      const prevClose  = spyBars[spyBars.length-2].c;
    if (prevClose) state._spyPrevClose = prevClose; // used for _spyDayChange
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
  // SPY gap-up delay REMOVED — gap up is supportive for bull put spreads (further from short strike).
  // Was designed for debit puts; wrong for current credit spread architecture (panel consensus).
  // Agent handles macro context from 8:30am including gap events.
  if (spyGapUp && !dryRunMode) logEvent("filter", `[INFO] SPY gap-up >1.5% — gap-up entry context noted (intraday RSI watch active)`);

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
  // Scan-scope effectiveDefensive — used both in defensive close block AND per-instrument loop (line ~2205).
  // Must be at runScan scope so both references resolve. Defined once, read everywhere.
  const _defAgentAge   = state._agentMacro?.timestamp
    ? (Date.now() - new Date(state._agentMacro.timestamp).getTime()) / 60000 : 999;
  const _defAgentFresh = _defAgentAge < 120; // Bug 4 FIX: 60→120min threshold
  const effectiveDefensive = (marketContext.macro || {}).mode === "defensive" && _defAgentFresh;
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

  // ── Overnight scan intelligence — read pre-market compute if available ────
  // Stored by getAgentOvernightScan("premarket-compute") at 7:30am CT (8:30am ET)
  // Provides: instrument biases, suppress window, wait-for-open flag, strike targets
  const overnightScan = state._overnightScan || null;
  const overnightAge  = overnightScan?.generatedAt
    ? (Date.now() - new Date(overnightScan.generatedAt).getTime()) / 3600000 // hours
    : 999;
  const useOvernightBias = false; // Overnight bias disabled — no all-day instrument blockers.

  if (useOvernightBias) {
    // Suppress entries until specified CT time (FOMC, CPI, etc.)
    if (overnightScan.suppressUntil) {
      const [supHH, supMM] = overnightScan.suppressUntil.replace(/[^0-9:]/g,'').split(':').map(Number);
      const etNow = getETTime();
      const ctHour = etNow.getHours() - 1; // ET → CT (rough, handles EDT)
      const ctMin  = etNow.getMinutes();
      if (ctHour < supHH || (ctHour === supHH && ctMin < supMM)) {
        logEvent("scan", `[OVERNIGHT] Entries suppressed until ${overnightScan.suppressUntil} CT (${overnightScan.catalysts?.join(', ') || 'scheduled event'})`);
      }
    }
    // Log wait-for-open flag if set
    if (overnightScan.waitForOpen && etHourNow < 10.5) { // before 9:30am CT
      logEvent("scan", `[OVERNIGHT] Wait-for-open flag set: ${overnightScan.waitReason || 'pre-market volatility'}`);
    }
    // Log overnight regime assessment
    if (overnightScan.scanType === 'premarket-compute') {
      logEvent("scan", `[OVERNIGHT] Pre-market: ${overnightScan.regime} | ${overnightScan.signal} (${overnightScan.confidence}) | bias: ${overnightScan.entryBias} | risk: ${overnightScan.riskLevel}`);
    }
  }

  // Strategy log
  const strategyMode = regimeClass === "C" ? "CRISIS - long puts, careful sizing"
    : regimeClass === "B" ? "BEAR TREND - long puts + MR calls on oversold"
    : "BULL - long puts on overbought, MR calls on oversold";
  logEvent("scan", `[STRATEGY] Regime ${regimeClass}: ${strategyMode} | IVR:${ivRankNow} (${state._ivEnv})`);
  // NAKED OPTIONS: choppyDebitBlock removed from logs — no credit mode in APEX
  // Bug 2 FIX: creditCallModeActive log removed — APEX has no credit call mode. Dead spread-era log.
  if (crisisDebitBlock && !dryRunMode) logEvent("filter", `[REGIME C] Crisis mode - debit put entries blocked, mean reversion unreliable`);
  if (skewElevated && state.vix >= 22 && state.vix < 28) logEvent("filter", `SKEW ${(state._skew?.skew||0)} elevated - credit VIX threshold lowered to 22`);


  // AVOID HOLD: agent entryBias:avoid no longer auto-stamps a 30-minute block.
  // Agent directional accuracy is 10.1% at 30min — automatic blocks based on this signal
  // caused more harm than protection (today's startup chaos blocked entries for 23+ minutes).
  //
  // entryBias:avoid now logs a prominent warning only. Human can manually set avoid via
  // dashboard if needed. _avoidUntil can still be set by /api/clear-avoid (inverse) or
  // manually via dashboard. Emergency triggers (VIX spike, flash crash) still auto-block
  // via separate mechanisms that don't depend on agent direction accuracy.
  const agentBias = (state._agentMacro || {}).entryBias || (state._dayPlan || {}).entryBias || "neutral";
  if (agentBias === "avoid") {
    // Log a warning every 15 minutes at most — don't spam every scan
    const _lastAvoidWarn = state._lastAvoidWarnAt || 0;
    if (Date.now() - _lastAvoidWarn > 15 * 60 * 1000) {
      logEvent("warn", `[AVOID] Agent recommends avoid bias — entries NOT auto-blocked (10.1% accuracy). Use dashboard to manually set hold if needed.`);
      state._lastAvoidWarnAt = Date.now();
    }
  }
  // Manual avoid hold still respected — set via dashboard or /api endpoints
  const avoidHoldActive = !!(state._avoidUntil && Date.now() < state._avoidUntil);
  if (avoidHoldActive) {
    const minsLeft = ((state._avoidUntil - Date.now()) / 60000).toFixed(0);
    logEvent("filter", `[AVOID] Entry hold active - ${minsLeft}min remaining (manually set or legacy stamp)`);
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

  // APEX: puts allowed whenever entry window is open. choppyDebitBlock/crisisDebitBlock removed.
  // Directional filters (RSI, MACD, regime) live in scoring and evaluateEntry — not here.
  const putsAllowed       = (entryWindowOpen
                             && !rb.gates.postReversalBlock && !rb.gates.macroBullishBlock
                             && !rb.gates.avoidHoldActive
                             ) || dryRunMode;
  // APEX: calls allowed when entry window open. No choppyDebitBlock restriction.
  const callsAllowed      = (callWindowOpen && !rb.gates.avoidHoldActive) || dryRunMode;
  // APEX: no credit modes — all entries are naked puts or calls
  const creditAllowed     = false;
  const callCreditAllowed = false;
  if (macroBullish && !dryRunMode)  logEvent("filter", `Macro bullish (${marketContext.macro?.signal}) - puts blocked`);
  // vixFallingPause removed — falling VIX is good for credit spreads (less downside risk).
  // Was correct for debit puts (IV crush) but wrong for current credit spread architecture (panel consensus).
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
  if (!callsAllowed && !putsAllowed) return; // APEX: only need puts and calls

  // [opening/final hour blocks moved above callsAllowed]
  // Weekly circuit breaker REMOVED — penalizes new code for old code's losses (panel consensus).
  // Daily circuit breaker retained for paper trading safety.
  if (state.circuitOpen === false) return;

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

  // FIX 10: Max daily loss circuit breaker
  // Tracks intraday unrealized + realized P&L against daily limit.
  // If daily loss exceeds 3% of account, halt all new entries for the session.
  //
  // V2.86: Staleness guard on unrealized P&L — stale currentPrice from API failures
  //    was masking real losses (phantom gains from hours-old prices skipped circuit).
  //    NOTE: unrealized P&L only counts positions opened TODAY (openedToday flag).
  //    Overnight carry positions are excluded — their losses belong to the prior day's session.
  //    todayRealizedPnL includes all closed P&L from today's session.
  {
    const MAX_PRICE_STALE_MS = 60000; // 60s — if currentPrice is older, treat as flat
    const todayOpen = new Date(); todayOpen.setHours(0,0,0,0);
    const unrealizedPnL = (state.positions || []).reduce((s, p) => {
      // Only count unrealized from TODAY's entries — carry positions excluded from daily circuit
      const openedToday = p.openDate && new Date(p.openDate) >= todayOpen;
      if (!openedToday) return s;
      const priceAge = p._currentPriceUpdatedAt ? Date.now() - p._currentPriceUpdatedAt : Infinity;
      const safeCurrentPrice = priceAge < MAX_PRICE_STALE_MS ? p.currentPrice : null;
      if (!safeCurrentPrice || !p.premium) return s; // skip stale — treat as flat
      const chg = (safeCurrentPrice - p.premium) / p.premium;
      return s + chg * p.premium * 100 * (p.contracts || 1);
    }, 0);
    const todayPnL = (state.todayRealizedPnL || 0) + unrealizedPnL;
    const dailyLossLimit = (state.alpacaCash || state.cash || 30000) * -0.03; // -3% daily loss limit
    state._dailyPnL = parseFloat(todayPnL.toFixed(2));
    if (todayPnL < dailyLossLimit && !dryRunMode) {
      logEvent("warn", `[DAILY CIRCUIT] Daily P&L $${todayPnL.toFixed(0)} below -3% limit ($${dailyLossLimit.toFixed(0)}) — halting new entries`);
      state._dailyCircuitOpen = false;
    } else if (state._dailyCircuitOpen === false && todayPnL >= dailyLossLimit * 0.75) {
      // Auto-reset if losses recover to within 75% of limit (e.g. -$627 vs -$836 limit)
      // Allows resumption after a partial recovery without requiring full return to flat
      logEvent("scan", `[DAILY CIRCUIT] Auto-reset — P&L $${todayPnL.toFixed(0)} recovered to within 75% of limit ($${(dailyLossLimit * 0.75).toFixed(0)})`);
      state._dailyCircuitOpen = true;
    }
    if (state._dailyCircuitOpen === false) return; // halt entries
  }

  // - PORTFOLIO GREEKS LIMITS -
  // Prevent extreme one-sided exposure
  const pgr = marketContext.portfolioGreeks || { delta: 0, vega: 0 };
  const MAX_PORTFOLIO_DELTA = -500; // max short delta (puts) = -$500 per 1% SPY move
  // RM-C1 fix: heat cap does not prevent adding OPPOSITE-direction positions when PDT-locked
  // If all positions are PDT-locked and losing, allowing a hedge is risk-reducing not risk-adding
  // allPDTLocked removed — PDT_RULE_ACTIVE=false, rule sunset April 2026
  // Natenberg: VIX-scaled vega cap - high VIX = more volatile IV = tighter cap
  // At VIX 37, a $2000 vega position loses $2000 on a 1pt VIX move - too much
  const MAX_PORTFOLIO_VEGA  = state.vix >= 35 ? 500 : state.vix >= 25 ? 1000 : 2000;
  // FIX 7: Portfolio delta hard gate — block new same-direction entries when delta is extreme.
  // Heat cap tracks cost, not directional exposure. Five SPY puts + two QQQ puts all move together.
  // MAX_PORTFOLIO_DELTA = -500 means net -$500 per 1% SPY move. Beyond this, concentrate risk further only on very high conviction (score 85+).
  // This runs BEFORE per-instrument scoring — if portfolio is already max short, skip low-conviction adds.
  const portfolioDeltaBreached = pgr.delta < MAX_PORTFOLIO_DELTA;
  if (portfolioDeltaBreached) {
    logEvent("filter", `[DELTA CAP] Portfolio delta ${pgr.delta.toFixed(0)} below -500 limit — only score >= 85 can add more puts`);
    state._portfolioDeltaCapped = true;
  } else {
    state._portfolioDeltaCapped = false;
  }
  // Directional concentration + Beta-adjusted portfolio delta check (DB-1/GL-3)
  // Simple directional count
  const openPuts  = (state.positions || []).filter(p => p.optionType === "put").length;
  const openCalls = (state.positions || []).filter(p => p.optionType === "call").length;
  const totalOpen = state.positions.length;
  // Directional concentration blocks removed — correct behavior in trending market (panel consensus).
  // Heat cap governs concentration. Log for visibility only.
  if (totalOpen >= 3 && openPuts === totalOpen) logEvent("filter", `[INFO] All ${totalOpen} positions are puts (heat cap governs)`);
  if (totalOpen >= 3 && openCalls === totalOpen) logEvent("filter", `[INFO] All ${totalOpen} positions are calls (heat cap governs)`);
  // Beta-adjusted net delta — tracks directional exposure across positions.
  // MAX was 6 (calibrated for 1-2 contract individual stock positions).
  // New contract sizing targets 9-10 contracts per position on index ETFs.
  // At 9x per position: 1 position = -9, 2 = -18, 3 = -27, 4 = -37, 5 = -46.
  // The directional heat cap (40% of cash) is the correct portfolio-level governor.
  // Beta-delta is retained for logging/dashboard visibility but scaled to max 3 positions
  // at full 10-contract sizing = 30. Beyond that the heat cap fires first anyway.
  const betaDelta = (state.positions || []).reduce((sum, p) => {
    const beta = Math.min(p.beta || 1.0, 2.0);
    const dir  = p.optionType === "put" ? -1 : 1;
    const contracts = p.contracts || 1;
    return sum + (dir * beta * contracts);
  }, 0);
  state._portfolioBetaDelta = parseFloat(betaDelta.toFixed(1));
  const MAX_BETA_DELTA = 50; // scaled for 9-10 contract index ETF positions (5 max × 10 = 50)
  // MAX_BETA_DELTA blocks removed — heat cap fires first at 5 positions × 10 contracts (panel consensus).
  if (betaDelta < -MAX_BETA_DELTA) logEvent("filter", `[INFO] Beta delta ${betaDelta.toFixed(1)} (heat cap governs)`);
  if (betaDelta > MAX_BETA_DELTA) logEvent("filter", `[INFO] Beta delta +${betaDelta.toFixed(1)} (heat cap governs)`);
  // MAX_PORTFOLIO_VEGA block removed — heat cap fires first across 5 ETF instruments (panel consensus).
  if (Math.abs(pgr.vega) > MAX_PORTFOLIO_VEGA) logEvent("filter", `[INFO] Portfolio vega $${pgr.vega.toFixed(0)} (heat cap governs)`);

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

  // High-beta block removed — ARGO trades index ETFs (SPY, QQQ, GLD, TLT, XLE),
  // none of which have beta > 1.5 relative to each other. Vestigial from individual stock mode.

  // Burst entry cooldown - max 3 new positions per 10 minutes
  // Prevents over-concentration at a single market moment (e.g. after reset)
  // Burst entry cooldown removed — startup burst is fixed by agent mutex. This was a workaround (panel consensus).
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const recentEntries = state.positions.filter(p => new Date(p.openDate).getTime() > tenMinAgo).length;
  if (recentEntries >= 3) logEvent("filter", `[INFO] ${recentEntries} entries in last 10min (heat cap governs)`);

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
    // SKIP FIX: entryBlocked separates "score for context" from "allow entry".
    // SKIPped instruments still run full scoring/logging — only scored.push is gated.
    let entryBlocked = false;
    // Skip if already at max positions for this ticker
    const maxPerTicker = stock.isIndex ? 3 : 2;
    const existingForTicker = state.positions.filter(p => p.ticker === stock.ticker);
    const logicalExisting = new Set(existingForTicker.map(p => `${p.optionType}|${p.expDate}`)).size;
    // Bug13 FIX: maxCombined was 2 for index (same as risk.js maxPerTicker=3 discrepancy).
    // A ghost TLT position (logicalExisting=2) would skip TLT scoring entirely here.
    // Align with risk.js: index instruments allow up to 3 logical positions.
    // The heat cap and risk.js maxPerTicker are the real enforcers.
    const maxCombined = stock.isIndex ? 3 : 2;
    if (logicalExisting >= maxCombined) continue;

    // - F14: Check ticker blacklist -
    if ((state.tickerBlacklist || []).includes(stock.ticker)) {
      logEvent("filter", `${stock.ticker} blacklisted - skipping`);
      continue;
    }

    // Cooldown removed: the scoring system, regime check, and R/R gate already prevent
    // re-entering bad setups. An arbitrary timer adds no value and blocks valid credit put
    // entries after stops (underlying dropped = short strike further OTM = better setup).

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
      // Bug2 FIX: gap skip exempts credit put mode.
      // Gap UP: underlying moved away from short strike = credit put is safer, not a reason to skip.
      // Gap DOWN: underlying moved toward short strike = genuinely dangerous, always skip.
      const _gapDir = bars[bars.length-1].o - bars[bars.length-2].c;
      const _isCreditPutMode = false; // APEX: no credit mode
      // Fix 3: Gap-down is a PUT entry signal in APEX — don't skip, let scoring decide.
      // Only skip on gap-UP (stock moved away from put strike = puts less attractive).
      // Gap-down: flag it, allow scoring to run. Gap-up on a put: scoring will suppress via RSI/MACD.
      const _skipForGap = overnightGap > MAX_GAP_PCT && _gapDir > 0; // gap UP skips (not gap down)
      if (_skipForGap) {
        logEvent("filter", `${stock.ticker} gap UP ${(overnightGap*100).toFixed(1)}% overnight - skip (puts not chasing gap up)`);
        continue;
      }
      if (overnightGap > MAX_GAP_PCT && _gapDir < 0) {
        logEvent("filter", `${stock.ticker} gap DOWN ${(overnightGap*100).toFixed(1)}% — put thesis possible, scoring continues`);
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
      const _putsOnBounceActive = rb.gates.putsOnBounceMode && rb.isBearRegime;
      if (false && price > vwap * 1.03 && !_putsOnBounceActive) { // APEX: credit call mode removed
        // Block credit calls when price is extended above VWAP — UNLESS puts_on_bounces is active
        // (in that case, the above-VWAP condition is exactly what we want for a put fade entry)
        logEvent("filter", `[VWAP] ${stock.ticker} bear call skipped - price ABOVE VWAP by ${vwapPct}% (wait for intraday weakness)`);
        continue;
      }
      // Bounce mode: above VWAP is a PUT SIGNAL not a block — boost put score
      if (_putsOnBounceActive && price > vwap * 1.02) {
        const _bounceVwapPct = ((price - vwap) / vwap * 100).toFixed(1);
        const _bounceBoost   = price > vwap * 1.04 ? 15 : price > vwap * 1.02 ? 10 : 5;
        weaknessBoost += _bounceBoost;
        weaknessReasons.push(`Bounce: $${_bounceVwapPct}% above VWAP — fade opportunity (+${_bounceBoost})`);
        logEvent("filter", `[BOUNCE] ${stock.ticker} ${_bounceVwapPct}% above VWAP in puts_on_bounces mode — put fade boost +${_bounceBoost}`);
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
    // Entry window gate: block new entries after 3:30pm ET (2:30pm CT)
    // Normal entries: 3:30pm cutoff — was incorrectly 3:00pm, fixed
    // Mean reversion calls: also 3:30pm cutoff (capitulation has genuine overnight edge)
    const entryWindowClosed = etHourNow >= 15.5; // scan-level etHourNow
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
      // Overnight instrument bias — skip instrument if flagged
      // Overnight instrumentBias SKIP removed — no all-day instrument blockers.
      // The scoring + RSI/MACD gates decide entries. Overnight context is advisory only.

      // V2.85: RSI split by direction.
      // Puts score on dailyRSI — need to know if instrument is GENUINELY overbought on multi-day basis.
      //   dailyRSI 90 = truly extended, valid fade. intraday RSI is noise for put thesis.
      // Calls score on intradayRSI — MR calls triggered by intraday capitulation (RSI 22-35).
      //   dailyRSI 90 on a day SPY dipped intraday was killing all call scores.
      //   Directional calls also use intraday RSI for timing (45-58 healthy dip in bull trend).
      const spyRSIPut   = liveStock.dailyRsi || liveStock.rsi || 50;  // daily for puts
      const spyRSICall  = liveStock.rsi || liveStock.dailyRsi || 50;  // intraday for calls
      const spyRSI      = spyRSIPut; // default for legacy refs below (put path uses this)
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
      // APEX: no credit mode injection — scoring uses optionType directly
      const scoringMacro = scoringMacroBase;
      const putResult  = scoreIndexSetup(liveStock, "put",  spyRSIPut,  spyMACD, spyMomentum, breadthVal, state.vix, scoringMacro);
      const callResult = scoreIndexSetup(liveStock, "call", spyRSICall, spyMACD, spyMomentum, breadthVal, state.vix, scoringMacro);

      // NAKED OPTIONS: use scoreIndexSetup directly for put and call.
      // No spread-specific scoring — tradeType is always 'put' or 'call'.
      putSetup  = { score: putResult.score,  reasons: putResult.reasons,  tradeType: "put",  isMeanReversion: false };
      callSetup = { score: callResult.score, reasons: callResult.reasons, tradeType: "call", isMeanReversion: false };
      // Correlation suppression: QQQ correlated to SPY (0.90+)
      // Panel decision (7/8): allow both simultaneously at score -80 same direction
      // High conviction overrides correlation block - both signals are independently strong
      // Keep block when: score <80 OR directions are opposite
      // Combined heat cap enforced separately via heat % check
      if (stock.ticker === "QQQ") {
        const spyPutOpen  = state.positions.some(p => p.ticker === "SPY" && p.optionType === "put");
        const spyCallOpen = state.positions.some(p => p.ticker === "SPY" && p.optionType === "call");
        // Only suppress if score is below 80 - high conviction entries allowed through
        // Same-direction suppression threshold lowered: 80 → MIN_SCORE_CREDIT (65).
        // Old threshold (80) was correlation-cap thinking — raise the bar on the second position.
        // Now heat cap governs concentration; QQQ just needs to clear the normal minimum independently.
        // Opposite-direction suppression kept — SPY put + QQQ call is a contradictory thesis.
        if (spyPutOpen  && putSetup.score  < MIN_SCORE_CREDIT) { putSetup.score  = Math.min(putSetup.score,  30); logEvent("filter", `QQQ corr-block: SPY put open, QQQ put score below minimum — suppressed`); }
        if (spyCallOpen && callSetup.score < MIN_SCORE_CREDIT) { callSetup.score = Math.min(callSetup.score, 30); logEvent("filter", `QQQ corr-block: SPY call open, QQQ call score below minimum — suppressed`); }
        // Opposite directions — contradictory thesis, keep blocking
        if (spyPutOpen  && callSetup.score > 0) { callSetup.score = Math.min(callSetup.score, 30); logEvent("filter", `QQQ corr-block: SPY put open, QQQ call contradicts direction`); }
        if (spyCallOpen && putSetup.score  > 0) { putSetup.score  = Math.min(putSetup.score,  30); logEvent("filter", `QQQ corr-block: SPY call open, QQQ put contradicts direction`); }
      }
      // Symmetric: suppress SPY at <80 when QQQ is open in same direction
      if (stock.ticker === "SPY") {
        const qqqPutOpen  = state.positions.some(p => p.ticker === "QQQ" && p.optionType === "put");
        const qqqCallOpen = state.positions.some(p => p.ticker === "QQQ" && p.optionType === "call");
        if (qqqPutOpen  && putSetup.score  < MIN_SCORE_CREDIT) { putSetup.score  = Math.min(putSetup.score,  30); logEvent("filter", `SPY corr-block: QQQ put open, SPY put score below minimum — suppressed`); }
        if (qqqCallOpen && callSetup.score < MIN_SCORE_CREDIT) { callSetup.score = Math.min(callSetup.score, 30); logEvent("filter", `SPY corr-block: QQQ call open, SPY call score below minimum — suppressed`); }
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
        // APEX: GLD uses put/call directly
        // Fix: use best available score to determine GLD credit intent
        // In bear trend, creditCallModeActive → check callSetup.score; in bull/choppy → putSetup.score
        const _gldBestScore   = isBearTrend ? callSetup.score : putSetup.score;
        const _gldCreditMode  = creditCallModeActive || creditModeActive;
        // Bug12 FIX: was using MIN_SCORE (70) — GLD credit puts at score 65-69 were misclassified as debit_put
        // and blocked by DXY gate unnecessarily. Use MIN_SCORE_CREDIT (65) for correct classification.
        const _gldIntentType  = (_gldCreditMode && _gldBestScore >= MIN_SCORE_CREDIT) ? _gldCreditType : "debit_put";
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
      }

      // P3: IYR (Real Estate) — rate-sensitive entry gates
      if (stock.ticker === "IYR") {
        const iyrRSI     = liveStock.rsi || liveStock.dailyRsi || 50;
        const yieldEnv   = state._yieldEnv || "normal";
        const iyrCallGate = isIYREntryAllowed("call", yieldEnv, iyrRSI);
        const iyrPutGate  = isIYREntryAllowed("put",  yieldEnv, iyrRSI);
        if (!iyrCallGate.allowed) { callSetup.score = 0; logEvent("filter", iyrCallGate.reason); }
        if (!iyrPutGate.allowed)  { putSetup.score  = 0; logEvent("filter", iyrPutGate.reason);  }
      }

      // P3: HYG (High Yield Bonds) — credit stress entry gates
      if (stock.ticker === "HYG") {
        // V2.87 FIX 8: Early HYG minimum premium screen before chain fetch.
        // HYG options at VIX < 30 are structurally below the $0.50 minimum premium —
        // bond ETF IV is too low. Skip entirely at VIX < 30 to avoid wasting the chain fetch.
        // Heuristic: HYG $80 × 10% IV × √(38/365) × 0.6 ≈ $0.14 at VIX 27. Always below floor.
        if ((state.vix || 20) < 30) {
          logEvent("filter", `HYG skipped — VIX ${(state.vix||20).toFixed(1)} < 30, HYG options structurally below $0.50 minimum (bond ETF low IV)`);
          callSetup.score = 0; putSetup.score = 0;
        } else {
          const hygRelStr   = state._sectorRelStr?.HYG?.relStr || 0;
          const hygRSI      = liveStock.rsi || liveStock.dailyRsi || 50;
          const creditStress = !!state._creditStress;
          const hygCallGate  = isHYGEntryAllowed("call", creditStress, hygRelStr, hygRSI);
          const hygPutGate   = isHYGEntryAllowed("put",  creditStress, hygRelStr, hygRSI);
          if (!hygCallGate.allowed) { callSetup.score = 0; logEvent("filter", hygCallGate.reason); }
          if (!hygPutGate.allowed)  { putSetup.score  = 0; logEvent("filter", hygPutGate.reason);  }
        }
      }
    } else {
      // Individual stocks: use scorePutSetup/scoreCallSetup
      // scoreSetup removed - scoreIndexSetup handles SPY/QQQ, scorePutSetup handles individual stocks
      callSetup = { score: 0, reasons: ["Individual stocks disabled"], tradeType: "none" };
      putSetup  = scorePutSetup(liveStock, relStrength, signals.adx, todayVol, avgVol, state.vix);
    }

    // Fix 1: Weekly trend external adjustment REMOVED — double-counting with scoreIndexSetup.
    // scoreIndexSetup already applies trendCtx bonuses (+12/-10) and above10wk (+5/-5).
    // Keeping only the _weeklyTrend assignment so scoreIndexSetup can read it.
    if (weeklyTrend.above10wk !== null) {
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

    // P1 FIX: External getRegimeModifier removed — scoreIndexSetup handles regime internally.
    // Double-counting was: +20 (internal) + 15 (external) = +35 for puts in Regime B.
    // Regime bonuses now live exclusively inside scoreIndexSetup where they belong.
    // regimeMod kept for MR bypass logic below (checks if regime is bear before applying).
    const regimeMod   = getRegimeModifier(marketContext.regime?.regime || "neutral", "call");
    // (not applied to scores — informational only for MR bypass below)

    // Mean reversion call scoring - runs AFTER regime so bypass works correctly
    // MR fires here so isMeanReversion flag is set before regime penalty check below
    const mrSetup = scoreMeanReversionCall(liveStock, relStrength, signals.adx, bars, state.vix);
    // MR call gates — two blocking conditions:
    // 1. mrBearishTrend: dailyRSI < 40 AND MACD bearish = trending crash, not intraday capitulation.
    //    V2.87: threshold tightened from 35→40. XLE at 26.5 daily RSI was blocked at 35 — correct.
    //    But instruments at 37-40 daily RSI with bearish MACD are also in trend crash mode.
    //    Genuine MR: intraday RSI compressed BUT daily trend still intact (dailyRSI 45+).
    // 2. mrDailyOverbought: dailyRSI > 75 = already extended daily.
    //    SPY/QQQ at dailyRSI 90+ with intraday dip at 37 → score 75 MR call.
    //    But the daily trend is stretched — the "oversold" intraday signal is noise within
    //    a strong daily uptrend. MR calls require the stock to actually be oversold on some timeframe.
    //    If daily RSI is 90, the stock is overbought daily — entering a MR call here is
    //    purely momentum chasing, not mean reversion. Block when dailyRSI > 75.
    const _mrDailyRsi       = liveStock.dailyRsi || 50;
    const mrBearishTrend    = _mrDailyRsi < 40 && (liveStock.macd || "").includes("bearish");
    const mrDailyOverbought = _mrDailyRsi > 75; // daily RSI overbought = no MR thesis
    if (mrSetup.score > callSetup.score && !mrBearishTrend && !mrDailyOverbought) {
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
        // V2.87 FIX 5: VIX premium context log for MR calls.
        // At VIX 27+ the option premium is 40-60% elevated vs VIX 18 baseline.
        // The underlying needs a proportionally larger move to overcome the premium paid.
        // This is informational — logged so post-trade analysis can track VIX-adjusted win rate.
        // Future sprint: apply score penalty when VIX > 28 on MR calls (needs backtest calibration).
        const _mrVixContext = state.vix >= 28 ? ` | VIX ${state.vix?.toFixed(1)} elevated — premium ~${Math.round((state.vix/18-1)*100)}% above baseline` : "";
        logEvent("filter", `${stock.ticker} MEAN REVERSION: score ${mrSetup.score} | beta:${mrBeta} | liquidity check deferred to execution${_mrVixContext}`);
      } else {
        logEvent("filter", `${stock.ticker} MEAN REVERSION skipped - beta:${mrBeta} sector:${mrSector} (low liquidity proxy)`);
      }
    }

    // P1 FIX: Call regime modifier also removed — scoreIndexSetup handles this internally.
    // MR calls already bypass regime inside scoreIndexSetup (mrCapitulationActive path).
    // Non-MR calls get the correct regime penalty inside scoreIndexSetup.

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
    // macro.sectorBearish/sectorBullish existed on keyword macro — agent macro may not have them
    const _macroSectorBearish = macro.sectorBearish || [];
    const _macroSectorBullish = macro.sectorBullish || [];

    // ── FIX: Agent modifier scoped to regime confirmation only ────────────────
    // The agent's ±modifier was originally applied as a directional score adjustment
    // (mild bearish → -5 on puts in Regime A, etc.). Panel audit (4/24/2026) showed
    // this was suppressing bull put scores by 5-18 points based on a signal with
    // 10.6% directional accuracy on 30-min horizons — worse than a coin flip.
    //
    // New logic: the modifier is ONLY applied when agent and regime AGREE on direction.
    // - Regime B + bearish agent: bear call scores get boost, put redirect gets boost.
    // - Regime A + bullish agent: call scores get small boost.
    // - Disagreement or neutral: modifier = 0. The regime classifier (price-based,
    //   computed every scan) is authoritative. Agent is a timing refinement, not a veto.
    //
    // Sector signals are kept — they're aggregate, not directional noise.
    const agentMacroForScoring = (state._agentMacro || {}).signal || "neutral";
    const regimeClass = state._regimeClass || "A";
    const agentAlignsBear = ["bearish","strongly bearish","mild bearish"].includes(agentMacroForScoring) && ["B","C"].includes(regimeClass);
    const agentAlignsBull = ["bullish","strongly bullish","mild bullish"].includes(agentMacroForScoring) && regimeClass === "A";
    const putsOnBouncesFade = (state._agentMacro || {}).entryBias === "puts_on_bounces"
      && agentMacroForScoring === "mild bullish" && ["B","C"].includes(regimeClass);

    // Only apply modifier when agent confirms the regime direction
    const alignedModifier = agentAlignsBear || agentAlignsBull ? Math.abs(macro.scoreModifier || 0) : 0;
    let macroCallMod = agentAlignsBear ? alignedModifier : agentAlignsBull ? Math.round(alignedModifier * 0.5) : 0;
    let macroPutMod  = agentAlignsBear ? alignedModifier : putsOnBouncesFade ? 0 : 0;

    // Extra sector-specific adjustment (kept — aggregate signal, not directional noise)
    if (_macroSectorBearish.includes(stock.sector)) { macroCallMod -= 10; macroPutMod += 10; }
    if (_macroSectorBullish.includes(stock.sector)) { macroCallMod += 8;  macroPutMod -= 8; }

    callSetup.score = Math.min(100, Math.max(0, callSetup.score + macroCallMod));
    putSetup.score  = Math.min(100, Math.max(0, putSetup.score  + macroPutMod));

    if (macroCallMod !== 0 || macroPutMod !== 0) {
      if (macroCallMod !== 0) callSetup.reasons.push(`Macro ${agentMacroForScoring} (regime-aligned): ${macroCallMod > 0 ? "+" : ""}${macroCallMod}`);
      if (macroPutMod  !== 0) putSetup.reasons.push(`Macro ${agentMacroForScoring} (regime-aligned): ${macroPutMod > 0 ? "+" : ""}${macroPutMod}`);
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
    // APEX: simple — puts blocked only when putsAllowed is false
    if (!putsAllowed) { putScore = 0; recordGateBlock(stock.ticker, "puts_not_allowed", authRegimeName, putScore); }

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
    // Determine effective score from the setup that was actually used
    const _creditCallScore  = (creditCallModeActive && isBearTrend) ? callSetup.score : null;
    const _creditPutScore   = (creditModeActive && !isBearTrend)    ? putSetup.score  : null;
    const _debitCallScore   = (!isBearTrend && !creditCallModeActive) ? callSetup.score : null;
    const _creditScore      = _creditCallScore ?? _creditPutScore ?? null;
    const _creditType       = (creditCallModeActive && isBearTrend) ? "credit_call"
                            : (creditModeActive && !isBearTrend)    ? "credit_put" : null;
    const _debitCallActive  = (!isBearTrend && !creditCallModeActive && _debitCallScore !== null);
    const _effectiveMin     = _creditType ? MIN_SCORE_CREDIT : (_debitCallActive ? 75 : MIN_SCORE);

    // Use real market R/R from last execution attempt — far more accurate than any estimate
    // _lastCreditRR is written by execution.js every time the R/R gate fires
    const _rrEst = (state._lastCreditRR && state._lastCreditRR[stock.ticker])
      ? state._lastCreditRR[stock.ticker]
      : null;

    state._scoreDebug[stock.ticker] = {
      ts: Date.now(), price, putScore, callScore,
      creditScore: _creditScore,      // from scoreCreditSpread (dedicated scorer)
      creditType:  _creditType,       // credit_call or credit_put
      debitCallScore: _debitCallScore, // from scoreDebitCallSpread (Regime A)
      debitCallActive: _debitCallActive,
      effectiveMin: _effectiveMin,    // 65 credits, 75 debit_call, 70 debits
      rrEstimate:  _rrEst,         // analytical R/R viability check
      putReasons: putSetup.reasons, callReasons: callSetup.reasons,
      signals: { rsi: signals.rsi, dailyRsi: signals.dailyRsi, macd: signals.macd,
        momentum: signals.momentum, ivPercentile: signals.ivPercentile,
        volPaceRatio: signals.volPaceRatio, intradayVWAP: signals.intradayVWAP },
      blocked: [],
    };
    // Bug 3 FIX: Defensive mode zeros calls EXCEPT mean reversion calls.
    // MR calls are specifically designed for strongly bearish macro — that's the entry signal.
    // RSI 22 + VIX 28 + "strongly bearish" macro = textbook MR call setup.
    // callSetup.isMeanReversion is set before this point (line ~2062).
    if (effectiveDefensive && !callSetup.isMeanReversion) callScore = 0; // Bug 4 FIX: stale agent skipped

    const bestScore = Math.max(callScore, putScore);
    const optionType = putScore > callScore ? "put" : "call";

    // Bug 3 FIX: Skip defensive calls EXCEPT mean reversion — MR calls exempt from defensive block.
    // A genuine capitulation (RSI 22, VIX spike) is exactly when MR calls should fire.
    if (effectiveDefensive && optionType === "call" && !callSetup.isMeanReversion) { // Bug 4 FIX
      logEvent("filter", `${stock.ticker} - macro defensive mode - skipping non-MR calls`);
      continue;
    }
    // Log MR call proceeding despite defensive mode
    if (effectiveDefensive && optionType === "call" && callSetup.isMeanReversion) { // MR exempt
      logEvent("filter", `${stock.ticker} - MR call proceeds despite defensive mode (RSI capitulation is the signal)`);
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
        // Rate-limit to once per 15 minutes — fires per-instrument so can flood logs
        if (!state._lastAgentStaleWarn || Date.now() - state._lastAgentStaleWarn > 15 * 60 * 1000) {
          logEvent("warn", `[AGENT] Macro analysis has not run in ${agentStaleMins.toFixed(0)} minutes - using keyword fallback`);
          state._lastAgentStaleWarn = Date.now();
        }
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
      logEvent("filter", `${stock.ticker} already have ${sameTickerSameDir.length} position(s) in this direction`);
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
        logEvent("filter", `${stock.ticker} entry window closed (after 3:30pm ET) - normal entries blocked`);
        continue;
      } else if (!mrWindowOpen) {
        logEvent("filter", `${stock.ticker} MR entry window closed (after 3:30pm) - all entries blocked`);
        continue;
      }
    }
    // finalMinScore gate removed -- evaluateEntry (entryEngine.js) is the single authority
    // scoreDebug effectiveMin updated by entryEngine result below
    // macdMinScore / timeOfDayMinScore passed to evaluateEntry via context

    // FIX 8: VWAP timing gate for PUT entries
    // Don't enter a put while price is above VWAP and making intraday higher lows — wait for rejection.
    // This improves entry timing: the overbought DAILY signal is valid, but intraday
    // strength means the move hasn't stalled yet. Wait for VWAP rejection.
    // Gate applies only in Regime A (bull market) where mean reversion is the put thesis.
    // In Regime B (confirmed bear), below-VWAP is common and not a timing signal.
    // MR calls are exempt — you want to enter AT the low, not wait for rejection.
    if (optionType === "put" && rb.isBullRegime && !isMREntry && !dryRunMode) {
      const putVWAP  = liveStock.intradayVWAP || signals.intradayVWAP || 0;
      const putPrice = liveStock.price || price;
      if (putVWAP > 0 && putPrice > 0) {
        const aboveVWAP = putPrice > putVWAP;
        const pctAbove  = ((putPrice - putVWAP) / putVWAP) * 100;
        // Block put entries when price is >1.5% above VWAP with strong intraday momentum
        // <1.5% above VWAP is within normal noise — don't over-filter
        if (aboveVWAP && pctAbove > 1.5 && liveStock.momentum === "recovering") {
          logEvent("filter", `${stock.ticker} VWAP timing: ${pctAbove.toFixed(1)}% above VWAP ($${putVWAP.toFixed(2)}) with recovering momentum — wait for rejection`);
          continue;
        }
      }
    }

    // FIX 7 cont: Portfolio delta cap — block low-conviction puts when delta is maxed
    if (optionType === "put" && state._portfolioDeltaCapped && optionType === "put") {
      const effectiveScore = Math.max(putSetup.score, callSetup.score);
      if (effectiveScore < 85) {
        logEvent("filter", `${stock.ticker} portfolio delta capped — score ${effectiveScore} below 85 required when delta maxed`);
        continue;
      }
    }

    // - Correlation-aware directional heat cap -
    // SPY/QQQ/IWM are highly correlated - count combined as single direction
    // GLD has negative beta - call spreads on GLD during equity selloff = hedge
    // Don't count GLD toward put heat cap (it's an uncorrelated asset)
    // Directional heat cap matches overall heat cap — in Regime A (all puts), one direction fills all.
    // The total heat cap (40% at VIX 25+) is the true concentration governor.
    const MAX_DIR_HEAT = effectiveHeatCap();
    const isGLDHedge = stock.ticker === "GLD" && optionType === "call";
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
    // Correlation cap removed — heat cap (60%) and directional cap (40%) govern concentration.
    // With 5 instruments and defined-risk spreads, explicit correlation blocking is redundant.

    // Block opposite direction on same ticker - directional strategy only
    const sameTickerOpposite = state.positions.find(p =>
      p.ticker === stock.ticker &&
      p.optionType !== optionType
    );
    if (sameTickerOpposite) {
      logEvent("filter", `${stock.ticker} same ticker opposite direction blocked - already have ${sameTickerOpposite.optionType}`);
      continue;
    }

    // Fix 3: Same-day loss re-entry gate — _recentLosses was written but never read.
    // If this instrument was stopped out today in the same direction, require:
    //   (a) score >= 75 (not just 65) — higher conviction needed after a loss
    //   (b) RSI has moved at least 10 points since the losing entry RSI
    // Prevents the pattern of re-entering the same thesis 3x on the same day.
    const recentLoss = (state._recentLosses || {})[stock.ticker];
    // Only block re-entry in the SAME direction as the loss — opposite direction has a different thesis
    // recentLossSameDir = true → gate triggers → re-entry requires score>=75 + RSI delta
    // !recentLoss.optionType = direction unknown → conservative: treat as same direction (block)
    // V2.87 FIX 7: Maximum daily RSI gate for calls.
    // Entering calls when dailyRSI > 80 = stock already extended daily.
    // SPY at dailyRSI 90.2, QQQ at 94.1 — these are not call entry conditions,
    // they are conditions for PUTS or no trade. A "dip" in an overbought-daily
    // instrument is not mean reversion — it's noise within an extended trend.
    // Applied to ALL calls (not just MR) — daily RSI > 80 means the intraday
    // oversold signal is structurally unreliable as a reversal indicator.
    if (optionType === "call" && (stock.dailyRsi || 50) > 80) {
      logEvent("filter", `${stock.ticker} call blocked — dailyRSI ${(stock.dailyRsi||50).toFixed(1)} overbought daily (>80). Intraday dip is noise, not MR signal.`);
      continue;
    }

    // --- Same-day close cooldown gate (30 min) ---
    // Blocks re-entry for 30 minutes after ANY close (win or loss) on the same instrument.
    // Prevents: GLD wins at 9:23am → system re-enters at 9:27am same direction, worse strike.
    // Losses already have a 24-hour gate via _recentLosses. This 30-min gate covers wins too.
    const recentClose = (state._recentCloses || {})[stock.ticker];
    const recentCloseSameDir = recentClose && (!recentClose.optionType || recentClose.optionType === optionType);
    if (recentCloseSameDir) {
      const minsSinceClose = (Date.now() - recentClose.closedAt) / 60000;
      const CLOSE_COOLDOWN_MINS = 30;
      if (minsSinceClose < CLOSE_COOLDOWN_MINS) {
        const wasWin = recentClose.pnl > 0 ? `win (+$${recentClose.pnl.toFixed(0)})` : `loss (-$${Math.abs(recentClose.pnl).toFixed(0)})`;
        logEvent("filter", `${stock.ticker} re-entry cooldown — ${wasWin} closed ${minsSinceClose.toFixed(0)}min ago, need ${CLOSE_COOLDOWN_MINS}min`);
        continue;
      }
    }

    // recentLoss.optionType !== optionType = opposite direction → don't block (different thesis)
    const recentLossSameDir = recentLoss && (!recentLoss.optionType || recentLoss.optionType === optionType);
    if (recentLossSameDir && (Date.now() - recentLoss.closedAt) < 24 * 3600 * 1000) {
      const hoursSinceLoss = ((Date.now() - recentLoss.closedAt) / 3600000).toFixed(1);
      const lossRSI    = recentLoss.entryRSI || 50; // RSI at losing entry
      const currentRSI = signals.rsi || liveStock.rsi || 50;
      const rsidelta   = Math.abs(currentRSI - lossRSI);
      const instrMin75 = Math.max(75, stock.minScore || 65); // raise floor to 75 after a loss
      if (bestScore < instrMin75) {
        logEvent("filter", `${stock.ticker} re-entry blocked — loss ${hoursSinceLoss}h ago, need score ${instrMin75} (have ${bestScore})`);
        continue;
      }
      if (rsidelta < 10) {
        logEvent("filter", `${stock.ticker} re-entry blocked — RSI only moved ${rsidelta.toFixed(0)}pts since loss (need 10pt shift for new thesis)`);
        continue;
      }
      logEvent("filter", `${stock.ticker} re-entry allowed — loss ${hoursSinceLoss}h ago, score ${bestScore} >= ${instrMin75}, RSI moved ${rsidelta.toFixed(0)}pts`);
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
    logEvent("filter", `${stock.ticker} best setup: ${optionType.toUpperCase()} score ${bestScore} | RSI:${signals.rsi} MACD:${signals.macd} MOM:${signals.momentum}${entryBlocked ? " [CONTEXT ONLY — entry blocked]" : ""}`);
    // Queue for execution - heat is rechecked live in the execution loop below
    // SKIP FIX: entryBlocked instruments contribute scoring context but don't enter scored[]
    if (entryBlocked) continue; // scoring + logging done — skip execution queue
    const isMR = optionType === "call" && callSetup.isMeanReversion;
    // BUG A FIX: stamp isMR on liveStock so prefetch can read it for correct DTE/delta.
    // callSetup.isMeanReversion is set but was never copied to stock object.
    // Prefetch iterated scored[] and read stock._isMeanReversion → always false → wrong DTE.
    liveStock._isMeanReversion = isMR;
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

  // Score ranking cutoff removed — all instruments scoring above minimum are viable entries.
  // With only 5 instruments, the heat cap (60%) and directional cap (40%) govern concentration
  // far more precisely than a blunt percentage cutoff. Scored list is already sorted best-first
  // so execution loop processes highest-conviction entries first and stops at heat cap.
  if (scored.length > 0) {
    logEvent("filter", `Score ranking: ${scored.length} candidate(s) above minimum — proceeding (heat cap governs concentration)`);
  }

  // - PARALLEL OPTIONS PREFETCH -
  // Fetch options chains for all scored stocks simultaneously before executing
  // Bug 1 FIX: choppyDebitBlock removed from skipPrefetch.
  // Agent saying "choppy/none" should not blind the options data layer.
  // creditModeActive is always false in APEX — previous condition always skipped on choppy.
  // MR calls in particular need options data even when agent is bearish/choppy.
  // Only skip on heat cap — entry scoring will handle directional filtering.
  const skipPrefetch = _heatPct >= effectiveHeatCap();
  if (skipPrefetch && !dryRunMode) {
    logEvent("filter", `Heat ${_heatPctPc}% at cap - skipping options prefetch`);
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
          // Bug 6 FIX: Prefetch DTE/delta must match execution.js Fix 5 targets.
        // MR calls: 14 DTE / 0.42 delta (short-dated, need fast move, higher gamma)
        // Directional: 38 DTE / 0.35 delta (time for thesis to play out)
        // Mismatch was: prefetch used 21/28 DTE, execution used 14/38 → wrong contract cached.
        const isMR = optionType === "call" && (stock._isMeanReversion || false);
        const contract = await findContract(stock.ticker, optionType, isMR ? 0.42 : 0.35, isMR ? 14 : 38, state.vix, stock);
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

    // Tag stock with credit mode so checkAllFilters can exempt credit puts from debit-era blocks
    // _creditPutMode removed — APEX trades naked options only, no credit put routing
    // BUG5 FIX: was passing tradeIntent.type as prefetchedBars arg (wrong). Pass null.
    const { pass, reason } = await checkAllFilters(stock, price, null);
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
    // BUG C FIX: fallback was "debit_put"/"debit_call" — blocked by INSTRUMENT_CONSTRAINTS allowedTypes ["put","call"].
    const intentType = intent.type || optionType; // APEX: always "put" or "call"

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
        existingCreditProfitPct,
        drawdownMinScore:    ddProtocol.minScore || MIN_SCORE,
        drawdownLevel:       ddProtocol.level || "normal",  // BUG3 FIX: pass level so entryEngine only applies when in actual drawdown
        agentSignal:         (state._agentMacro || {}).signal || "neutral" }
    );
    if (!eeResult.pass) {
      logEvent("filter", `${stock.ticker} entry blocked - ${eeResult.reason}`);
      if (!dryRunMode) recordGateBlock(stock.ticker, eeResult.reason, rb.regimeName, score);
      continue;
    }

    // Derive execution path from locked intentType
    // Richard/Gilfoyle: log intentType immediately after pass — makes the dark gap visible
    logEvent("filter", `${stock.ticker} entry approved — intent:${intentType} score:${score} regime:${rb.regimeName}`);
    // NAKED OPTIONS MODE: single-leg long calls and puts only.
    // Spreads, iron condors, and multi-leg strategies removed.
    // All instruments route to executeTrade (limit order, long only).
    let entered = false;
    state._lastEntryType = isMeanReversion ? `mr_${optionType}` : `naked_${optionType}`;
    logEvent("filter", `${stock.ticker} execution branch: naked_${optionType} (MR:${isMeanReversion})`);
    const _sizeModNaked = sizeMod || 1.0;
    entered = await executeTrade(stock, price, score, reasons, state.vix, optionType, isMeanReversion, _sizeModNaked);
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
        ? `APEX ALERT - Scanner crash #${n} (${e.message.slice(0,50)})`
        : `APEX ALERT - Scanner still failing (${n} consecutive errors)`;
      Promise.race([
        sendResendEmail(
          subject,
          `<div style="font-family:monospace;background:#07101f;color:#ff5555;padding:20px">
          <h2>!! APEX Scanner Error</h2>
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
    // Always release the lock — the generation guard was causing permanent deadlocks
    // when a crash in catch() allowed a new scan to start and increment _scanGen
    // before finally ran, leaving scanRunning=true forever.
    scanRunning = false;
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
    lastScanStart: _lastScanStart,
    circuit: getCircuitState(),
  }),
  // Watchdog escape hatch — called by server.new.js if scan is stuck > 90s
  forceResetScanLock: () => {
    logEvent('warn', '[WATCHDOG] Force-resetting stuck scanRunning lock');
    scanRunning = false;
    _lastScanStart = 0;
  },
  setDryRunMode: (v) => { dryRunMode = v; if (state) state._dryRunMode = v; },
};
