// scanner.js — ARGO V3.2
// Main scan orchestrator: market data fetching, exit checks, entry scoring, execution.
// runScan() runs every 10 seconds during market hours.
'use strict';

const {
  alpacaGet, alpacaPost, alpacaDelete,
  getStockBars, getIntradayBars, getStockQuote, getCircuitState,
} = require('./broker');

const { state, logEvent, markDirty, saveStateNow, flushStateIfDirty, paperDataActive } = require('./state');
const { recordTelemetry } = require('./telemetry');

const {
  calcRSI, calcEMA, calcMACD, calcMomentum, calcATR, calcADX,
  calcGreeks, calcVWAP, calcKellySize, calcBetaWeightedDelta, calcAggregateGreeks,
  calcCreditSpreadTP, getDynamicSignals, getLiveBeta, calcSharpeRatio, calcFactorScore,
  openRisk, openCostBasis, heatPct, realizedPnL, totalCap, stockValue,
  effectiveHeatCap, getAccountPhase, getDeployableCash,
  getETTime, isDST, isMarketHours, isEntryWindow, getBusinessDaysAgo,
  getWeeklyTrend, getSupportResistance,
} = require('./signals');

const {
  getMacroNews, getFearAndGreed, getMarketBreadth, computeBreadthLab, getSyntheticPCR,
  getVolTermStructure, getCBOESKEW, getSentimentSignal, getDXY,
  getYieldCurve, getEarningsDate, getNewsForTicker, analyzeNews, scoreArticle,
  getAnalystActivity, getShortInterestSignal, getUpcomingMacroEvents,
  getMacroCalendarModifier, getPreMarketData, checkVIXVelocity,
  getVIXReversionDays, getVIX, getVIXDailyCloses,
  getCached, setCache } = require('./market');

const {
  scoreIndexSetup, scorePutSetup, scoreMeanReversionCall,
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
  closePosition, partialClose, closeNContracts, confirmPendingOrder,
  syncCashFromAlpaca,
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

const { sendMorningBriefing, sendEmail, setReportingContext, getBenchmarkComparison, sendResendEmail } = require('./reporting');

const {
  WATCHLIST, CAPITAL_FLOOR, MIN_SCORE, MIN_SCORE_CREDIT, MAX_HEAT,
  MAX_SECTOR_PCT, STOP_LOSS_PCT, FAST_STOP_PCT, FAST_STOP_HOURS,
  TAKE_PROFIT_PCT, PARTIAL_CLOSE_PCT, TRAIL_ACTIVATE_PCT, TRAIL_STOP_PCT,
  BREAKEVEN_LOCK_PCT, PDT_RULE_ACTIVE, PDT_LIMIT, PDT_PROFIT_EXIT, PDT_STOP_LOSS,
  MS_PER_DAY, TRIGGER_COOLDOWN_MS, SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL,
  INDIVIDUAL_STOCKS_ENABLED, INDIVIDUAL_STOCK_WATCHLIST, MONTHLY_BUDGET, MACRO_REVERSAL_PCT,
  TARGET_DELTA_MIN, TARGET_DELTA_MAX,
  ALPACA_KEY, ALPACA_SECRET, ALPACA_DATA, ALPACA_OPT_SNAP, ALPACA_OPTIONS,
  MAX_GAP_PCT, GAP_MIN_PCT, MIN_STOCK_PRICE, GMAIL_USER, RESEND_API_KEY, VIX_PAUSE, VIX_REDUCE25, VIX_REDUCE50,
  VIX_CREDIT_PRIMARY, VIX_CALLS_BLOCKED,
  VIX_HIGH_CALL_SCORE, VIX_HIGH_CALL_RSI,
  MR_LABEL_DECOUPLED = false,   // V3.2 (6/19) MR-label decoupling: default OFF; set true in constants.js to enable
  APEX_PAPER_EXPERIMENT = false, EXPERIMENT_CALL_FLOOR = 50, EXPERIMENT_PUT_FLOOR = 60,   // V3.2 (6/22) paper-experiment mode: default OFF
  VIX_DAILY_SEED = [],   // V3.2 (6/23) real CBOE VIX year — seeds the IV-Rank baseline (_vixDaily)
  SPIRAL_COOLDOWN_MIN = 45,   // D3 (6/24) spiral-block auto-clear cooldown (min) — fallback 45 if not in constants
  MR_INTRA_LIFTOFF_PTS = 4,   // D3 (6/24) intraday RSI lift-off pts off session low — shared early-turn threshold (scoring + VWAP gate)
} = require('./constants');

let scanRunning  = false;
let _scanGen       = 0;
let _lastScanStart = 0;
let _lastScanTelemetryAt = 0;   // prev full-scan completion time for the inter-scan interval metric; decoupled from the state.lastScan heartbeat below

const fmt = (n) => '$' + (n || 0).toFixed(2);
let lastMedScan  = 0;
let lastSlowScan = 0;
let lastHourScan = 0;
let dryRunMode   = false;

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
  _lastScanStart = Date.now();
  const thisScanGen = ++_scanGen;
  try {
  if (!ALPACA_KEY) { logEvent("warn", "No ALPACA_KEY set - check Railway variables"); scanRunning = false; return; }
  if (!isMarketHours() && !dryRunMode) { logEvent("scan", "Outside market hours - skipping trade logic"); scanRunning = false; return; }
  // Heartbeat — a real scan is now proceeding. Set lastScan BEFORE any entry-halt early-return
  // (e.g. the `if (!callsAllowed && !putsAllowed) return` below when loss-locks block all entries),
  // otherwise lastScan starves during halts and the market-hours health check false-alarms.
  state.lastScan = new Date().toISOString();
  if (dryRunMode) logEvent("scan", "- DRY RUN MODE - no orders submitted, no state changes");
  if (dryRunMode) state.positions.forEach(p => { delete p._dryRunWouldClose; });

  const now    = Date.now();
  const scanET = getETTime();

  const todayScanDate = scanET.toLocaleDateString("en-US", { timeZone: "America/New_York" });
  if (todayScanDate !== (state._lastScanDate || "")) {
    state._lastScanDate     = todayScanDate;
    // IVR baseline: refresh the real-VIX year from CBOE once per trading day. Self-healing —
    // on any fetch failure getVIXDailyCloses returns null and we keep the existing seeded _vixDaily.
    try {
      const _freshVix = await getVIXDailyCloses(252);
      if (Array.isArray(_freshVix) && _freshVix.length >= 60) {
        state._vixDaily = _freshVix;
        logEvent("scan", `[IVR] _vixDaily refreshed from CBOE — ${_freshVix.length} real closes, latest ${_freshVix[_freshVix.length - 1]}`);
      }
    } catch (_e) { /* getVIXDailyCloses logs + returns null on failure; keep existing _vixDaily */ }
    state._dailyCircuitOpen = true;
    state._dailyPnL         = 0;
    const _prevDayPnL = state.todayRealizedPnL || 0;
    state.todayRealizedPnL       = 0;
    state._intradayOversoldScans = {};
    state._sessionLowRSI         = {};
    state._sessionLowRSIAt       = {};
    state._gapReversalDay   = false;
    state._todayMaxGap      = 0;
    state._todayGapDirection = null;
    state._dailyThesisComplete = {};
    // C1-N Sunday 6/8: clear daily loss lock and instrument loss counts at session start
    state._dailyLossLockActive    = false;
    state._dailyLossLockTriggeredAt = null;
    state._instrumentLossCount    = {};
    logEvent("scan", `[DAILY RESET] New trading day ${todayScanDate} — circuit reset, P&L zeroed (was $${_prevDayPnL.toFixed(0)}), gap + thesis state cleared`);
    // #4: effective-config audit — surface the behavior flags that change what the system does,
    // so the active configuration is legible each session (the flag combinatorics were hard to
    // reason about). Add new safety-affecting flags here as they're introduced.
    logEvent("scan", `[CONFIG] paperDataMode:${state.paperDataMode === true ? 'ON — loss-locks + circuit-breaker + gap blocks DISABLED' : 'off'} | paperExperiment:${APEX_PAPER_EXPERIMENT ? 'ON' : 'off'} | callFloor:${EXPERIMENT_CALL_FLOOR} putFloor:${EXPERIMENT_PUT_FLOOR} | MIN_SCORE:${MIN_SCORE}`);
    markDirty();
  }

  const etHourNow  = scanET.getHours() + scanET.getMinutes() / 60;
  const isLateDay  = etHourNow >= 14.5;
  const isLastHour = etHourNow >= 15.0;

  const _totalCap  = totalCap();
  const _openRisk  = openRisk();
  const _heatPct   = Math.max(0, openCostBasis()) / _totalCap;
  const _heatPctPc = parseFloat((_heatPct * 100).toFixed(1));

  if (!runScan._cache || Date.now() - (runScan._cacheTime||0) > 8000) {
    runScan._cache = {};
    runScan._cacheTime = Date.now();
  }
  const scanCache = runScan._cache;

  const newVIX  = await getVIX() || state.vix;
  const isBlackSwan = checkVIXVelocity(newVIX);
  state.vix     = newVIX;

  // ── IV Rank (real-VIX subsystem, Path 1.5) ───────────────────────────────────
  // Ranks the latest REAL CBOE VIX close against a REAL one-year VIX window (_vixDaily,
  // seeded from VIX_DAILY_SEED, refreshed once/day from CBOE in the daily-reset block).
  // Intentionally NOT keyed off newVIX/state.vix — that is the VIXY share price the risk
  // gates use; IVR must rank real-vs-real to be units-correct (a VIXY value ranked against
  // a real-VIX window reads ~3x too high). No "no-baseline" cap is needed: the baseline is
  // real, so a genuine 1yr-low VIX correctly yields a low rank instead of a phantom floor.
  // Reseed if missing/short OR holding legacy VIXY-PRICE data. A length-only check let the old
  // persisted VIXY array (261 elems, prices ~30-74) sail past and mask the real-VIX ranking. Real
  // VIX never year-medians above ~40 (this window medians ~17); VIXY prices median ~50.
  {
    const _vdChk = state._vixDaily;
    let _vdStale = !Array.isArray(_vdChk) || _vdChk.length < 60;
    if (!_vdStale) {
      const _med = [..._vdChk].sort((a, b) => a - b)[Math.floor(_vdChk.length / 2)];
      _vdStale = !(_med > 0) || _med > 40;                    // >40 ⇒ VIXY units, not real VIX
    }
    if (_vdStale) {
      const _wasLen = Array.isArray(_vdChk) ? _vdChk.length : 0;
      state._vixDaily = VIX_DAILY_SEED.slice(-252);
      if (_wasLen >= 60) logEvent("scan", `[IVR] reseeded — discarded legacy/units-wrong _vixDaily (${_wasLen}d) for real-VIX seed`);
    }
  }
  const _vd = state._vixDaily;
  if (!Array.isArray(_vd) || _vd.length < 60) {
    // Baseline missing/short even after the reseed above (only possible if VIX_DAILY_SEED itself were
    // empty) — hold the last-known/neutral rank rather than crash the scan on undefined percentiles.
    state._ivRank = (typeof state._ivRank === "number") ? state._ivRank : 50;
    state._ivEnv  = state._ivEnv || "normal";
    logEvent("scan", `[IV] baseline unavailable (_vixDaily ${Array.isArray(_vd) ? _vd.length : 0}d) — holding Rank:${state._ivRank} (${state._ivEnv}) until CBOE refresh`);
  } else {
    const _curRealVIX = _vd[_vd.length - 1];                    // most recent real CBOE close
    const _sortedVD   = [..._vd].sort((a, b) => a - b);
    const _vdP5  = _sortedVD[Math.floor(_sortedVD.length * 0.05)] || _sortedVD[0];
    const _vdP95 = _sortedVD[Math.floor(_sortedVD.length * 0.95)] || _sortedVD[_sortedVD.length - 1];
    const _vdClamped = Math.min(Math.max(_curRealVIX, _vdP5), _vdP95);
    state._ivRank = _vdP95 > _vdP5
      ? parseFloat(((_vdClamped - _vdP5) / (_vdP95 - _vdP5) * 100).toFixed(1))
      : 50;
    state._ivEnv = state._ivRank >= 70 ? "high"
                 : state._ivRank >= 50 ? "elevated"
                 : state._ivRank >= 30 ? "normal"
                 : "low";
    logEvent("scan", `[IV] Rank:${state._ivRank} (${state._ivEnv}) | realVIX:${_curRealVIX} | P5-P95:[${_vdP5.toFixed(1)}-${_vdP95.toFixed(1)}] | History:${_vd.length}d (real CBOE)`);
  }

  if (state._pendingOrder) {
    await confirmPendingOrder();
    if (state._pendingOrder) {
      logEvent("scan", `[SPREAD] Order ${state._pendingOrder.orderId} still pending (${((Date.now()-state._pendingOrder.submittedAt)/1000).toFixed(0)}s) - skipping entries`);
    }
  }

  if (!state._sectorRelStrChecked || Date.now() - state._sectorRelStrChecked > 600000) {
    state._sectorRelStrChecked = Date.now();
    (async () => {
      try {
        if (!state._sectorRelStr) state._sectorRelStr = {};
        const spySnap = await alpacaGet("/stocks/SPY/snapshot", ALPACA_DATA);
        const spyChange = spySnap?.dailyBar?.c && spySnap?.prevDailyBar?.c
          ? (spySnap.dailyBar.c - spySnap.prevDailyBar.c) / spySnap.prevDailyBar.c * 100
          : 0;
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
            logEvent("scan", `[SECTOR] ${sector} ${relStr > 0 ? "outperforming" : "underperforming"} SPY by ${relStr.toFixed(1)}% today`);
          }
        });
        const hygRelStr  = state._sectorRelStr?.HYG?.sectorPct || 0;
        const tltRelStr  = state._sectorRelStr?.TLT?.sectorPct || 0;
        state._creditStress = hygRelStr < -1.0 && tltRelStr < -0.5;
        if (state._creditStress) {
          logEvent("scan", `[CREDIT STRESS] HYG ${hygRelStr.toFixed(1)}% + TLT ${tltRelStr.toFixed(1)}% both falling — forced liquidation signal`);
        }
      } catch(e) {}
    })();
  }

  if (!state._optFlowChecked || Date.now() - state._optFlowChecked > 300000) {
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
            logEvent("scan", `[FLOW] ${ticker} unusual volume - ${volRatio.toFixed(1)}x normal.`);
          }
        }
      } catch(e) {}
    })();
  }

  alpacaGet("/account").then(acct => {
    if (acct?.daytrade_count !== undefined) {
      state._alpacaDayTradeCount = parseInt(acct.daytrade_count, 10);
    }
  }).catch(() => {});
  await Promise.race([
    syncPositionPnLFromAlpaca(),
    new Promise(r => setTimeout(r, 2000)),
  ]).catch(() => {});

  if (isBlackSwan) {
    for (const pos of [...state.positions]) await closePosition(pos.ticker, "vix-spike", null, pos.contractSymbol || pos.buySymbol, { bypassPDT: true });
    await saveStateNow();
    scanRunning = false;
    return;
  }

  logEvent("scan", `Scan | VIX:${state.vix} | cash:${fmt(state.cash)} | positions:${state.positions.length} | breadth:${marketContext.breadth.breadthPct}% (${marketContext.breadth.advancing ?? '?'}\u2191/${marketContext.breadth.declining ?? '?'}\u2193) | F&G:${marketContext.fearGreed.score}`);

  // C1-A: Daily loss lock check at scan top — halt entries if lock active
  if (state._dailyLossLockActive && !dryRunMode && !paperDataActive(state)) {
    logEvent("circuit", `[C1-A] Daily loss lock ACTIVE — entries blocked. todayRealizedPnL: $${(state.todayRealizedPnL||0).toFixed(0)}`);
    // exits still run — fall through, don't return early
  }

  // C1-G: Weekly/monthly halt check
  if (state._weeklyLossLockActive && !dryRunMode && !paperDataActive(state)) {
    logEvent("circuit", `[C1-G] Weekly loss lock ACTIVE — entries blocked. weeklyRealizedPnL: $${(state._weeklyRealizedPnL||0).toFixed(0)}`);
  }
  if (state._monthlyLossLockActive && !dryRunMode && !paperDataActive(state)) {
    logEvent("circuit", `[C1-G] Monthly loss lock ACTIVE — entries blocked.`);
  }

  // -- MEDIUM TIER (every 3 minutes) --
  if (now - lastMedScan > 3 * 60 * 1000) {
    lastMedScan = now;
    const breadth = await getMarketBreadth();
    marketContext.breadth        = breadth;

    if (!state._breadthHistory) state._breadthHistory = [];
    const bPct = parseFloat((marketContext.breadth.breadthPct || 50).toString());
    state._lastBreadthPct = bPct;
    state._breadth        = bPct;   // BUGFIX: was never assigned → scorer read a phantom 50
    state._breadthHistory.push({ t: now, v: bPct });
    if (state._breadthHistory.length > 10) state._breadthHistory = state._breadthHistory.slice(-10);

    // BUG-2 fix: DAILY breadth buffer (one entry/session) so scoring's breadth "percentile"
    // ranks today vs recent SESSIONS, not the last ~10 intraday scans (noise). Persists
    // wholesale via redisSave(state). Window (20 sessions) is panel-tunable.
    if (!state._breadthDaily) state._breadthDaily = [];
    {
      const _etDate = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const _lastD  = state._breadthDaily[state._breadthDaily.length - 1];
      if (_lastD && _lastD.d === _etDate) _lastD.v = bPct;           // update today's live value
      else state._breadthDaily.push({ d: _etDate, v: bPct });        // new session
      if (state._breadthDaily.length > 20) state._breadthDaily = state._breadthDaily.slice(-20);
    }

    const bHist = state._breadthHistory;
    if (bHist.length >= 2) {
      const bRecent = bHist.slice(-Math.min(3, bHist.length)).map(b=>b.v);
      const bOld    = bHist.slice(0, Math.min(3, bHist.length)).map(b=>b.v);
      const bAvgRecent = bRecent.reduce((a,b)=>a+b,0)/bRecent.length;
      const bAvgOld    = bOld.reduce((a,b)=>a+b,0)/bOld.length;
      state._breadthMomentum = bAvgRecent - bAvgOld;
      state._breadthTrend    = state._breadthMomentum > 5 ? "rising"
                             : state._breadthMomentum < -5 ? "falling"
                             : "flat";
    }

    if (bHist.length >= 4) {
      const hadLowBreadth  = bHist.slice(0, -1).some(b => b.v < 40);
      const hasHighBreadth = bPct > 60;
      if (hadLowBreadth && hasHighBreadth) {
        if (!state._zweigThrust?.detected) {
          state._zweigThrust = { detected: true, detectedAt: new Date().toISOString() };
          logEvent("scan", "[BREADTH RECOVERY] Watchlist breadth recovered from weak to strong - call bias");
        }
      } else if (state._zweigThrust?.detected) {
        const age = (now - new Date(state._zweigThrust.detectedAt).getTime()) / MS_PER_DAY;
        if (age > 2) state._zweigThrust = { detected: false };
      }
    }

    // ── Parallel breadth lab (informational; freeze-window data gathering) ──
    // Logs candidate metrics next to live breadth. NOT used by scoring/entries.
    try {
      const _lab = await computeBreadthLab(bPct);
      state._breadthLab = _lab.data;
      logEvent("scan", _lab.line);
    } catch (_e) { logEvent("warn", `[BREADTH-LAB] failed: ${_e.message}`); }

    state.lastRebalance = now;
    const calMod = getMacroCalendarModifier();
    marketContext.macroCalendar      = calMod;
    marketContext.betaWeightedDelta  = calcBetaWeightedDelta();
    if (calMod.events.length > 0) {
      logEvent("macro", `Calendar: ${calMod.message || calMod.events.map(e => e.event + " in " + e.daysTo + "d").join(", ")}`);
    }
    const [regime, benchmark] = await Promise.all([
      detectMarketRegime(),
      getBenchmarkComparison(),
    ]);
    marketContext.regime      = regime;
    marketContext.benchmark   = benchmark;

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

    marketContext.concentration    = checkConcentrationRisk();
    marketContext.drawdownProtocol = getDrawdownProtocol();
    marketContext.stressTest       = runStressTest();
    marketContext.kelly            = calcKellySize(20);
    marketContext.streaks          = getStreakAnalysis();

    if (marketContext.concentration.alerts.length > 0) {
      marketContext.concentration.alerts.forEach(a => logEvent("risk", a));
    }
    if (marketContext.drawdownProtocol.level !== "normal") {
      logEvent("risk", `Drawdown protocol: ${marketContext.drawdownProtocol.message}`);
    }

    await checkScaleIns();

    const agentMacroForAuth = state._agentMacro;
    const agentAuthAge = agentMacroForAuth?.timestamp
      ? (Date.now() - new Date(agentMacroForAuth.timestamp).getTime()) / 60000 : 999;

    if (agentMacroForAuth) {
      const staleSuffix = agentAuthAge > 30 ? ` (${agentAuthAge.toFixed(0)}min stale)` : '';
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
        logEvent("warn", `[MACRO] Agent signal is ${agentAuthAge.toFixed(0)}min old`);
      }
      if (marketContext.macro.mode !== 'normal') {
        logEvent("macro", `[5min] Macro: ${marketContext.macro.signal} via agent (${marketContext.macro.scoreModifier > 0 ? '+' : ''}${marketContext.macro.scoreModifier}) age:${agentAuthAge.toFixed(0)}min`);
      }
    } else {
      marketContext.macro = { signal: 'neutral', scoreModifier: 0, mode: 'normal', macroAuthority: 'pending', triggers: [] };
      if (!dryRunMode) logEvent("warn", `[MACRO] No agent signal yet — neutral until startup analysis completes`);
    }

    const macro = marketContext.macro;

    const _agentAgeForDefensive = state._agentMacro?.timestamp
      ? (Date.now() - new Date(state._agentMacro.timestamp).getTime()) / 60000 : 999;
    const _agentFreshForDefensive = _agentAgeForDefensive < 120;

    const agentSignal      = (state._agentMacro || {}).signal || "neutral";
    const agentIsBullish   = ["bullish","strongly bullish","mild bullish"].includes(agentSignal);
    const agentIsNeutral   = agentSignal === "neutral";
    const agentIsBearish   = ["strongly bearish","bearish"].includes(agentSignal);
    const agentFresh       = _agentFreshForDefensive;
    const defensiveSuppressed = agentFresh && !agentIsBearish;
    const openCallPositions = (state.positions || []).filter(p => p.optionType === "call");
    if (macro.mode === "defensive" && state.circuitOpen && !defensiveSuppressed) {
      if (openCallPositions.length === 0) {
        logEvent("macro", `[DEFENSIVE] No open calls - nothing to close (macro: ${macro.signal})`);
      } else {
        const defTriggers = (macro.triggers || []).slice(0,3).join(", ") || "strongly bearish signal";
        logEvent("macro", `DEFENSIVE MODE - closing calls: ${defTriggers}`);
        for (const pos of [...state.positions]) {
          if (pos.optionType === "call") {
            if (!state._macroDefensiveCooldown) state._macroDefensiveCooldown = {};
            state._macroDefensiveCooldown[pos.ticker] = Date.now();
            await closePosition(pos.ticker, "macro-defensive");
          }
        }
      }
    } else if (macro.mode === "defensive" && defensiveSuppressed) {
      logEvent("macro", `[AGENT OVERRIDE] Defensive suppressed - agent ${agentSignal} overrides - keeping calls open`);
    } else if (macro.mode === "defensive" && !agentFresh) {
      logEvent("warn", `[AGENT] Defensive triggered but agent stale (${_agentAgeForDefensive.toFixed(0)}min) — NOT closing calls`);
    }

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
      logEvent("macro", `BULLISH MACRO - closing losing puts`);
      for (const pos of [...state.positions]) {
        if (pos.optionType !== "put") continue;
        const curP = pos.currentPrice || pos.premium;
        const chg  = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
        if (chg < -0.05) await closePosition(pos.ticker, "macro-bullish", null, pos.contractSymbol || pos.buySymbol);
      }
    }

    const liveStreaks = getStreakAnalysis();
    logEvent("scan", `[5min] Regime:${regime.regime}(${regime.confidence}%) | Kelly:${marketContext.kelly?.contracts||1}x | Streak:${liveStreaks.currentStreak}x${liveStreaks.currentType||'--'}`);

    if (!state.portfolioSnapshots) state.portfolioSnapshots = [];
    const snapValue = state.cash + openRisk();
    state.portfolioSnapshots.push({ t: new Date().toISOString(), v: parseFloat(snapValue.toFixed(2)) });
    if (state.portfolioSnapshots.length > 2500) state.portfolioSnapshots = state.portfolioSnapshots.slice(-2500);
    runAgentRescore();
    runReconciliation().catch(e => logEvent("error", `[RECONCILE] 5-min sync failed: ${e.message}`));

    if (state._agentAccuracy && state._agentAccuracy.pending.length > 0) {
      const spyNow = state._liveSPY || state.spy || 0;
      if (spyNow > 0) {
        const now = Date.now();
        let resolved30 = 0, resolved120 = 0;
        state._agentAccuracy.pending.forEach(p => {
          const minsElapsed = (now - p.timestamp) / 60000;
          const spyChange   = (spyNow - p.spyAtCall) / p.spyAtCall;
          const expectsFall = ["strongly bearish","bearish"].includes(p.signal);
          const expectsRise = ["strongly bullish","bullish"].includes(p.signal);
          const correct     = (expectsFall && spyChange < -0.001) || (expectsRise && spyChange > 0.001);
          if (!p.resolved30 && minsElapsed >= 30) { p.resolved30 = true; if (correct) state._agentAccuracy.correct30++; resolved30++; }
          if (!p.resolved120 && minsElapsed >= 120) { p.resolved120 = true; if (correct) state._agentAccuracy.correct120++; resolved120++; }
        });
        state._agentAccuracy.pending = state._agentAccuracy.pending.filter(p => !p.resolved120);
        const resolved30Total  = state._agentAccuracy.calls - state._agentAccuracy.pending.filter(p => !p.resolved30).length;
        const resolved120Total = state._agentAccuracy.calls - state._agentAccuracy.pending.length;
        if (resolved30Total > 0)  state._agentAccuracy.acc30  = parseFloat((state._agentAccuracy.correct30  / resolved30Total  * 100).toFixed(1));
        if (resolved120Total > 0) state._agentAccuracy.acc120 = parseFloat((state._agentAccuracy.correct120 / resolved120Total * 100).toFixed(1));
      }
    }
  }

  // -- SLOW TIER (every 10 minutes) --
  if (now - lastSlowScan > 10 * 60 * 1000) {
    lastSlowScan = now;
    const [fg, dxy, yc, pcrSynth, termStruct, skew, sentiment] = await Promise.all([
      getFearAndGreed(), getDXY(), getYieldCurve(),
      getSyntheticPCR(), getVolTermStructure(), getCBOESKEW(), getSentimentSignal(),
    ]);

    const pcr = pcrSynth;
    if (pcr) {
      marketContext.pcr = pcr;
      state._pcr = { ...pcr, updatedAt: Date.now() };
      logEvent("scan", `[PCR:synthetic] ${pcr.pcr} (${pcr.signal})`);
    }
    if (termStruct) {
      marketContext.termStructure = termStruct;
      state._termStructure = { ...termStruct, updatedAt: Date.now() };
    }
    if (skew) {
      marketContext.skew = skew;
      state._skew = { ...skew, updatedAt: Date.now() };
    } else if (!state._skew && (state.vix || 0) >= 25) {
      const vixNow = state.vix || 20;
      const synthSkew = vixNow >= 32 ? 135 : vixNow >= 28 ? 128 : vixNow >= 25 ? 122 : 110;
      const synthSignal = synthSkew >= 130 ? "extreme" : synthSkew >= 120 ? "elevated" : "moderate";
      const synthSmirk  = parseFloat(((synthSkew - 100) / 200 + 1).toFixed(3));
      state._skew = { skew: synthSkew, smirkRatio: synthSmirk, signal: synthSignal, creditPutIdeal: synthSkew >= 120 && vixNow >= 25, synthetic: true, vixBased: true, updatedAt: Date.now() };
      marketContext.skew = state._skew;
    }
    if (sentiment) { marketContext.aaii = sentiment; state._aaii = { ...sentiment, updatedAt: Date.now() }; }
    marketContext.fearGreed   = fg; state._fearGreed = fg;
    marketContext.dxy         = dxy;
    marketContext.yieldCurve  = yc;
    if (dxy) state._dxy = { ...dxy, updatedAt: Date.now() };
    if (yc && yc.signal) {
      state._yieldEnv = yc.signal === "steepening" ? "steepening" : yc.signal === "flattening" ? "inverted" : "normal";
    }
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
    let updated  = 0, cleared = 0;
    for (const stock of WATCHLIST) {
      if (stock.earningsDate && stock.earningsDate < today) { stock.earningsDate = null; cleared++; }
      const ed = await getEarningsDate(stock.ticker);
      if (ed) { stock.earningsDate = ed; updated++; }
    }
    logEvent("scan", `[1hr] Earnings: ${updated} updated, ${cleared} stale dates cleared`);
  }

  let _liveDailyRsiMap = {};

  const alpacaBalance = state.alpacaCash || state.cash || 0;
  const pdtCount      = countRecentDayTrades();

  const { posSnapshots, posQuotes, posNewsCache } = await fetchPositionData(state.positions);

  for (const pos of state.positions) {
    const _liveDR = _liveDailyRsiMap[pos.ticker];
    if (_liveDR != null) pos.dailyRsi = _liveDR;
  }

  const exitDecisions = await checkExits(
    state.positions, posSnapshots, posQuotes, posNewsCache,
    { dryRunMode, scanET, alpacaBalance, pdtCount, marketContext }
  );

  for (const d of exitDecisions) {
    if (d.action === 'close')
      await closePosition(d.ticker, d.reason, d.exitPremium, d.contractSym);
    else if (d.action === 'partial')
      await partialClose(d.ticker);
    else if (d.action === 'partial-n')
      await closeNContracts(d.ticker, d.contractsToClose || 1, d.reason, d.exitPremium);
  }
  if (exitDecisions.length > 0) markDirty();

  if (state._pendingOrder) {
    // pending order in flight — skip entry section
  } else {
  const [spyPrice, spyBars, spyIntraday] = await Promise.all([
    getStockQuote("SPY").then(p => p || 500),
    getStockBars("SPY", 5),
    getIntradayBars("SPY"),
  ]);
  if (spyPrice) {
    state._liveSPY = spyPrice;
    const spyPrevClose = state._spyPrevClose || spyPrice;
    state._spyDayChange = spyPrevClose > 0 ? (spyPrice - spyPrevClose) / spyPrevClose : 0;
  }
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
      }
    } catch(e) { logEvent("warn", `[MA] SPY 200MA fetch failed: ${e.message}`); }
  }
  const spyReturn    = spyBars.length >= 5 ? (spyBars[spyBars.length-1].c - spyBars[0].o) / spyBars[0].o : 0;

  if (spyBars.length >= 2) {
    const todayBar = spyBars[spyBars.length - 1];
    const todayRange = todayBar.o > 0 ? (todayBar.h - todayBar.l) / todayBar.o : 0;
    if (!state._spyRangeHistory) state._spyRangeHistory = [];
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
  const spyAlreadyDown = false;

  const spyBelow200MA = state._spyMA200 && state._liveSPY && state._liveSPY < state._spyMA200;
  if (spyBelow200MA && !dryRunMode) {
    logEvent("filter", `[200MA] SPY $${state._liveSPY?.toFixed(2)} below 200MA $${state._spyMA200?.toFixed(2)} - bear regime`);
  }

  const etHourEntry    = scanET.getHours() + scanET.getMinutes() / 60;
  const finalHourBlock = false;

  const dayPlan = state._dayPlan;
  let suppressBlock = false;
  if (dayPlan && dayPlan.suppressUntil && !dryRunMode) {
    const [supH, supM] = dayPlan.suppressUntil.split(":").map(Number);
    const suppressMins = supH * 60 + supM;
    const currentMins  = scanET.getHours() * 60 + scanET.getMinutes();
    if (currentMins < suppressMins) {
      suppressBlock = true;
      logEvent("filter", `[DAY PLAN] Entries suppressed until ${dayPlan.suppressUntil} ET`);
    }
  }

  const dayPlanRiskMult = (dayPlan && dayPlan.riskLevel === "high" && !dryRunMode) ? 0.50 : 1.0;
  if (dayPlanRiskMult < 1.0) logEvent("filter", `[DAY PLAN] High risk day - position sizing reduced 50%`);

  const _rbBase = getRegimeRulebook(state);
  const rb = dryRunMode
    ? { ..._rbBase, gates: { ..._rbBase.gates, choppyDebitBlock: false, crisisDebitBlock: false, avoidHoldActive: false, postReversalBlock: false, vixFallingPause: false } }
    : _rbBase;

  // C1-C: HIGH RISK day plan raises effective minScore to 85
  const _dayPlanHighRisk = (state._dayPlan?.riskLevel === 'high') && !dryRunMode;
  if (_dayPlanHighRisk) {
    logEvent("filter", `[C1-C] Day plan HIGH RISK — effective minScore raised to 85`);
  }

  // C1-A: Compute effective min score based on daily loss lock state
  function _computeEffectiveMinScore(baseMin) {
    let effectiveMin = baseMin;
    // C1-C: HIGH RISK day plan
    if (_dayPlanHighRisk) effectiveMin = Math.max(effectiveMin, 85);
    // C1-A: Daily loss lock active → raise to 85
    if (state._dailyLossLockActive && !paperDataActive(state)) effectiveMin = Math.max(effectiveMin, 85);
    // C1-B: Per-instrument loss count >= 2 → raise to 90
    return effectiveMin;
  }

  const macroBullish      = rb.gates.macroBullishBlock;
  const pdtBlocked    = PDT_RULE_ACTIVE && !dryRunMode && pdtCount >= PDT_LIMIT;
  if (pdtBlocked) logEvent("filter", `PDT limit reached (${pdtCount}/${PDT_LIMIT}) - same-day exits blocked`);

  const spyGapUp = (() => {
    if (spyBars.length >= 2) {
      const prevClose  = spyBars[spyBars.length-2].c;
      if (prevClose) state._spyPrevClose = prevClose;
      const curSPY     = spyBars[spyBars.length-1].c;
      const gapPct     = (curSPY - prevClose) / prevClose;
      state._spyDayChangePct = gapPct;
      const etMinSince = (scanET.getHours() - 9) * 60 + scanET.getMinutes() - 30;
      if (!(gapPct > 0.015 && etMinSince >= 0)) return false;
      const spyVWAP = spyIntraday.length >= 5 ? calcVWAP(spyIntraday) : 0;
      const gapFading = spyVWAP > 0 && curSPY < spyVWAP;
      const delayMins = gapFading ? 10 : 15;
      return etMinSince < delayMins;
    }
    return false;
  })();
  if (spyGapUp && !dryRunMode) logEvent("filter", `[INFO] SPY gap-up >1.5% — gap-up entry context noted`);

  if (spyBars.length >= 3) {
    const _dayBeforeYesterday = spyBars[spyBars.length-3].c;
    const _yesterday          = spyBars[spyBars.length-2].c;
    if (_dayBeforeYesterday > 0) {
      const _yesterdayMove = (_yesterday - _dayBeforeYesterday) / _dayBeforeYesterday;
      state._yesterdayGapPct = parseFloat((_yesterdayMove * 100).toFixed(2));
      if (Math.abs(_yesterdayMove) >= 0.03) {
        state._gapReversalDay = true;
        logEvent("filter", `[GAP-REVERSAL] Yesterday SPY moved ${state._yesterdayGapPct > 0 ? '+' : ''}${state._yesterdayGapPct.toFixed(1)}% — day-2 reversal risk elevated`);
      } else {
        state._gapReversalDay = false;
      }
    }
  }

  let postReversalBlock = false;
  if (state._macroReversalAt && !dryRunMode) {
    const minsSinceReversal = (Date.now() - state._macroReversalAt) / 60000;
    const macroSignal     = (marketContext.macro || {}).signal || "neutral";
    const macroBearish    = ["bearish", "strongly bearish", "mild bearish"].includes(macroSignal);
    const agentUpdatedAt  = (marketContext.macro || {}).agentLastUpdated || null;
    const agentConfidence = (state._agentMacro || {}).agentConfidence || (state._agentMacro || {}).confidence || "low";
    const minTimeElapsed = minsSinceReversal >= 30;
    const macroConfirmedBearish = macroBearish;
    const spyAboveReversal = state._macroReversalSPY && spyPrice > state._macroReversalSPY * 1.005;
    const agentPostdatesReversal = !agentUpdatedAt || new Date(agentUpdatedAt).getTime() > state._macroReversalAt;
    const largeReversal = (state._macroReversalCount || 0) >= 5;
    const confidenceOk  = !largeReversal || agentConfidence === "high";

    if (!minTimeElapsed || !macroConfirmedBearish || spyAboveReversal || !confidenceOk || !agentPostdatesReversal) {
      postReversalBlock = true;
      const reasons = [];
      if (!minTimeElapsed)         reasons.push(`${minsSinceReversal.toFixed(0)}min elapsed (need 30)`);
      if (!macroConfirmedBearish)  reasons.push(`macro: ${macroSignal} (need bearish)`);
      if (spyAboveReversal)        reasons.push(`SPY above reversal $${state._macroReversalSPY?.toFixed(2)}`);
      if (!agentPostdatesReversal) reasons.push(`waiting for post-reversal agent update`);
      if (!confidenceOk)           reasons.push(`large reversal needs high confidence`);
      logEvent("filter", `[REVERSAL COOLDOWN] Active - ${reasons.join(" | ")}`);
    } else {
      logEvent("filter", `[REVERSAL COOLDOWN] Cleared`);
      state._macroReversalAt    = null;
      state._macroReversalCount = 0;
      state._macroReversalSPY   = null;
      markDirty();
    }
  }

  const macroAuthStamp    = (marketContext.macro || {}).macroAuthority || "keyword_fallback";
  const agentMacroSignal  = (marketContext.macro || {}).signal || "neutral";
  const _defAgentAge   = state._agentMacro?.timestamp
    ? (Date.now() - new Date(state._agentMacro.timestamp).getTime()) / 60000 : 999;
  const _defAgentFresh = _defAgentAge < 120;
  const effectiveDefensive = (marketContext.macro || {}).mode === "defensive" && _defAgentFresh;
  const putsMacroAllowed  = ["bearish", "strongly bearish", "mild bearish", "neutral"].includes(agentMacroSignal);
  const agentHasRun       = !!state._agentMacro;
  const macroClearForPuts = !agentHasRun || putsMacroAllowed;
  if (!dryRunMode) logEvent("scan", `[MACRO AUTH] ${macroAuthStamp} | signal: ${agentMacroSignal}`);

  const isIndexScan  = true;

  const authRegimeName    = rb.regimeName;
  const isChoppyRegime    = rb.gates.choppyDebitBlock;
  const creditModeActive  = false; // APEX is naked-only — credit mode removed (rb.gates.creditPutActive was never set → always falsy)
  const creditCallModeActive = false; // APEX is naked-only — credit mode removed
  const choppyDebitBlock  = rb.gates.choppyDebitBlock;
  const crisisDebitBlock  = rb.gates.crisisDebitBlock;
  const inBullRegime      = rb.isBullRegime;
  const isBearTrend       = rb.isBearRegime;
  const ivRankNow         = rb.ivRank;
  const ivElevated        = rb.ivElevated;
  const ivHigh            = rb.ivHigh;
  const regimeClass       = rb.regimeClass;
  const skewElevated      = (state._skew?.skew || 0) >= 130;
  const creditAllowedVIX  = rb.creditAllowedVIX;

  const overnightScan = state._overnightScan || null;
  const useOvernightBias = false;

  const strategyMode = regimeClass === "C" ? "CRISIS - long puts, careful sizing"
    : regimeClass === "B" ? "BEAR TREND - long puts + MR calls on oversold"
    : "BULL - long puts on overbought, MR calls on oversold";
  logEvent("scan", `[STRATEGY] Regime ${regimeClass}: ${strategyMode} | IVR:${ivRankNow} (${state._ivEnv})`);
  if (crisisDebitBlock && !dryRunMode) logEvent("filter", `[REGIME C] Crisis mode - debit put entries blocked`);

  const agentBias = (state._agentMacro || {}).entryBias || (state._dayPlan || {}).entryBias || "neutral";
  if (agentBias === "avoid") {
    const _lastAvoidWarn = state._lastAvoidWarnAt || 0;
    if (Date.now() - _lastAvoidWarn > 15 * 60 * 1000) {
      logEvent("warn", `[AVOID] Agent recommends avoid bias — NOT auto-blocked (10.1% accuracy).`);
      state._lastAvoidWarnAt = Date.now();
    }
  }
  const avoidHoldActive = !!(state._avoidUntil && Date.now() < state._avoidUntil);
  if (avoidHoldActive) {
    const minsLeft = ((state._avoidUntil - Date.now()) / 60000).toFixed(0);
    logEvent("filter", `[AVOID] Entry hold active - ${minsLeft}min remaining`);
  }
  if (state._macroDefensiveCooldown) {
    const now30 = Date.now();
    for (const tk of Object.keys(state._macroDefensiveCooldown)) {
      if (now30 - state._macroDefensiveCooldown[tk] > 30 * 60 * 1000) delete state._macroDefensiveCooldown[tk];
    }
  }

  const spyRSIForMR   = (marketContext.spySignals && marketContext.spySignals.rsi) || state._lastSpyRSI || 50;
  const isMRCondition = spyRSIForMR <= 35 && state.vix >= 25;
  const below200MACallBlock = rb.gates.below200MACallBlock;
  const entryWindowOpen   = isEntryWindow("put", true) && !finalHourBlock && !suppressBlock;
  const callWindowOpen    = isEntryWindow("call", true) && !finalHourBlock && !suppressBlock;
  const creditWindowOpen  = (isEntryWindow("call", false) && !finalHourBlock && !suppressBlock) || dryRunMode;

  const postCrisisLockActive = !!(state._postCrisisLock && state._postCrisisLockExpiry && Date.now() < state._postCrisisLockExpiry);
  if (postCrisisLockActive && !dryRunMode) {
    const daysLeft = Math.ceil((state._postCrisisLockExpiry - Date.now()) / 86400000);
    logEvent("filter", `[REGIME] Post-crisis recovery lock active (${daysLeft}d remaining)`);
  }

  const SPIKE_COOLDOWN_MS = 48 * 3600 * 1000;
  const vixSpikeCooldownActive = !!(state._vixSpikeAt && (Date.now() - state._vixSpikeAt) < SPIKE_COOLDOWN_MS);
  if (vixSpikeCooldownActive && !dryRunMode) {
    const hoursLeft = Math.ceil((SPIKE_COOLDOWN_MS - (Date.now() - state._vixSpikeAt)) / 3600000);
    logEvent("filter", `[REGIME] VIX spike cooldown active (${hoursLeft}h remaining)`);
  }
  if (state._vixSpikeAt && !vixSpikeCooldownActive) {
    logEvent("filter", "[REGIME] VIX spike cooldown expired — debit put entries re-enabled");
    state._vixSpikeAt = null;
    markDirty();
  }

  // C1-A + C1-B + C1-D: gated entry flags
  // C1-D: stagger bypass disabled on HIGH RISK days
  const _c1dHighRiskDay = _dayPlanHighRisk;

  // putsAllowed / callsAllowed incorporate C1-A and C1-G locks
  const _paperData = paperDataActive(state);   // PAPER DATA MODE lifts the account-level P&L loss-locks (paper only)
  const _c1aLockBlocking  = state._dailyLossLockActive && !dryRunMode && !_paperData;
  const _c1gWeeklyBlocking = state._weeklyLossLockActive && !dryRunMode && !_paperData;
  const _c1gMonthlyBlocking = state._monthlyLossLockActive && !dryRunMode && !_paperData;
  const _c1AnyLockActive   = _c1aLockBlocking || _c1gWeeklyBlocking || _c1gMonthlyBlocking;

  const putsAllowed       = (entryWindowOpen
                             && !rb.gates.postReversalBlock && !rb.gates.macroBullishBlock
                             && !rb.gates.avoidHoldActive
                             && !_c1AnyLockActive
                             ) || dryRunMode;
  const callsAllowed      = (callWindowOpen && !rb.gates.avoidHoldActive && !_c1AnyLockActive) || dryRunMode;
  const creditAllowed     = false;
  const callCreditAllowed = false;

  if (macroBullish && !dryRunMode)  logEvent("filter", `Macro bullish (${marketContext.macro?.signal}) - puts blocked`);
  if (rb.gates.postReversalBlock && !dryRunMode) logEvent("filter", "Post-reversal cooldown active - puts blocked 30min");

  if (!dryRunMode) {
    const vixPrev = state._prevScanVIX || state.vix;
    const vixMove = state.vix - vixPrev;
    if (vixMove >= 8) {
      for (const pos of [...state.positions]) {
        if (pos.optionType === "call" && !isDayTrade(pos)) {
          const chgPct = pos.currentPrice && pos.premium ? (pos.currentPrice - pos.premium) / pos.premium : 0;
          if (chgPct <= -0.10) {
            logEvent("warn", `[VIX SPIKE] VIX +${vixMove.toFixed(1)}pts, call ${pos.ticker} down ${(chgPct*100).toFixed(0)}% - closing`);
            await closePosition(pos.ticker, "vix-spike", null, pos.contractSymbol || pos.buySymbol, { bypassPDT: true });
          }
        }
      }
    }
    state._prevScanVIX = state.vix;
  }

  if (!dryRunMode) {
    const breadthNow  = parseFloat(marketContext?.breadth?.breadthPct ?? state._breadth ?? 50) || 50;
    const breadthPrev = state._prevBreadth || breadthNow;
    const breadthDrop = breadthPrev - breadthNow;
    if (breadthDrop >= 30 && breadthNow <= 35) {
      for (const pos of [...state.positions]) {
        if (pos.optionType === "call" && !isDayTrade(pos)) {
          logEvent("warn", `[BREADTH COLLAPSE] Breadth dropped ${breadthDrop.toFixed(0)}pts - closing call ${pos.ticker}`);
          await closePosition(pos.ticker, "breadth-collapse", null, pos.contractSymbol || pos.buySymbol);
        }
      }
    }
    state._prevBreadth = breadthNow;
  }

  if (!dryRunMode && spyBars.length >= 2) {
    const prevClose  = spyBars[spyBars.length-2].c;
    const curSPY     = spyBars[spyBars.length-1].c;
    const spyDayMove = (curSPY - prevClose) / prevClose;
    const _macroRevThreshold = (_rbBase && _rbBase.macroReversalThreshold) ? _rbBase.macroReversalThreshold : 0.025;
    if (spyDayMove > _macroRevThreshold) {
      let reversalCount = 0;
      for (const pos of [...state.positions]) {
        if (pos.optionType !== "put") continue;
        const snap = posSnapshots[pos.contractSymbol];
        const quote  = snap ? (snap.latestQuote || {}) : {};
        const bid    = parseFloat(quote.bp || 0);
        const ask    = parseFloat(quote.ap || 0);
        const curP   = bid > 0 && ask > 0 ? (bid + ask) / 2 : pos.premium;
        const chg    = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
        const pnlLabel = chg >= 0 ? `+${(chg*100).toFixed(0)}%` : `${(chg*100).toFixed(0)}%`;
        logEvent("scan", `${pos.ticker} SPY macro reversal +${(spyDayMove*100).toFixed(1)}% - closing ALL puts (${pnlLabel})`);
        await closePosition(pos.ticker, "macro-reversal", null, pos.contractSymbol || pos.buySymbol, { bypassPDT: true });
        reversalCount++;
      }
      if (reversalCount > 0) {
        state._macroReversalAt    = Date.now();
        state._macroReversalCount = reversalCount;
        state._macroReversalSPY   = spyBars[spyBars.length-1].c;
        logEvent("warn", `[REVERSAL COOLDOWN] ${reversalCount} position(s) closed`);
        markDirty();
      }
    }
  }
  if (!callsAllowed && !putsAllowed) return;

  for (const pos of [...(state.positions || [])]) {
    if (pos._morningExitFlag) {
      logEvent("warn", `[MORNING REVIEW] Closing ${pos.ticker} flagged overnight - ${pos._morningExitReason}`);
      await closePosition(pos.ticker, "morning-review");
      delete pos._morningExitFlag;
      delete pos._morningExitReason;
    }
  }

  if (state.cash <= CAPITAL_FLOOR) return;

  {
    const MAX_PRICE_STALE_MS = 60000;
    const todayOpen = new Date(); todayOpen.setHours(0,0,0,0);
    const unrealizedPnL = (state.positions || []).reduce((s, p) => {
      const openedToday = p.openDate && new Date(p.openDate) >= todayOpen;
      if (!openedToday) return s;
      const priceAge = p._currentPriceUpdatedAt ? Date.now() - p._currentPriceUpdatedAt : Infinity;
      const safeCurrentPrice = priceAge < MAX_PRICE_STALE_MS ? p.currentPrice : null;
      if (!safeCurrentPrice || !p.premium) return s;
      const chg = (safeCurrentPrice - p.premium) / p.premium;
      return s + chg * p.premium * 100 * (p.contracts || 1);
    }, 0);
    const todayPnL = (state.todayRealizedPnL || 0) + unrealizedPnL;
    const dailyLossLimit = (state.alpacaCash || state.cash || 30000) * -0.03;
    state._dailyPnL = parseFloat(todayPnL.toFixed(2));
    if (todayPnL < dailyLossLimit && !dryRunMode) {
      logEvent("warn", `[DAILY CIRCUIT] Daily P&L $${todayPnL.toFixed(0)} below -3% limit — halting new entries`);
      state._dailyCircuitOpen = false;
    } else if (state._dailyCircuitOpen === false && todayPnL >= dailyLossLimit * 0.75) {
      logEvent("scan", `[DAILY CIRCUIT] Auto-reset — P&L $${todayPnL.toFixed(0)} recovered`);
      state._dailyCircuitOpen = true;
    }
    if (state._dailyCircuitOpen === false) {
      state._circuitHaltEntries = true;
    } else {
      state._circuitHaltEntries = false;
    }
  }

  const _circuitEntryHalt = !paperDataActive(state) && ((state.circuitOpen === false) || (state._circuitHaltEntries === true));

  const _macroSignal    = (state._agentMacro?.signal || "").toLowerCase();
  const _macroIsBearish = _macroSignal.includes("bearish");
  const _vixCallGate    = (state.vix || 0) >= 28 && _macroIsBearish;
  const _vixFullHalt    = (state.vix || 0) >= VIX_PAUSE;

  const pgr = marketContext.portfolioGreeks || { delta: 0, vega: 0 };
  const MAX_PORTFOLIO_DELTA = -500;
  const MAX_PORTFOLIO_VEGA  = state.vix >= 35 ? 500 : state.vix >= 25 ? 1000 : 2000;
  const portfolioDeltaBreached = pgr.delta < MAX_PORTFOLIO_DELTA;
  if (portfolioDeltaBreached) {
    logEvent("filter", `[DELTA CAP] Portfolio delta ${pgr.delta.toFixed(0)} below -500 limit`);
    state._portfolioDeltaCapped = true;
  } else {
    state._portfolioDeltaCapped = false;
  }
  const openPuts  = (state.positions || []).filter(p => p.optionType === "put").length;
  const openCalls = (state.positions || []).filter(p => p.optionType === "call").length;
  const totalOpen = state.positions.length;
  if (totalOpen >= 3 && openPuts === totalOpen) logEvent("filter", `[INFO] All ${totalOpen} positions are puts (heat cap governs)`);
  if (totalOpen >= 3 && openCalls === totalOpen) logEvent("filter", `[INFO] All ${totalOpen} positions are calls (heat cap governs)`);

  const betaDelta = (state.positions || []).reduce((sum, p) => {
    const beta = Math.min(p.beta || 1.0, 2.0);
    const dir  = p.optionType === "put" ? -1 : 1;
    const contracts = p.contracts || 1;
    return sum + (dir * beta * contracts);
  }, 0);
  state._portfolioBetaDelta = parseFloat(betaDelta.toFixed(1));
  const MAX_BETA_DELTA = 50;
  if (betaDelta < -MAX_BETA_DELTA) logEvent("filter", `[INFO] Beta delta ${betaDelta.toFixed(1)} (heat cap governs)`);
  if (betaDelta > MAX_BETA_DELTA) logEvent("filter", `[INFO] Beta delta +${betaDelta.toFixed(1)} (heat cap governs)`);

  if (state.positions.length >= 2) {
    const expDates  = state.positions.map(p => p.expDate).filter(Boolean);
    const uniqueExp = new Set(expDates.map(d => d.slice(0, 7)));
    if (uniqueExp.size === 1 && state.positions.length >= 3) {
      const sameMonthCap = 4;
      if (state.positions.length >= sameMonthCap) {
        logEvent("filter", `Duration concentration: all ${state.positions.length} positions expire ${[...uniqueExp][0]}`);
      }
    }
  }

  const MAX_SIMULTANEOUS_CALLS = 3;
  const SLOT3_MIN_SCORE = 85;
  const CORR_GROUPS = {
    SPY: 'equity', QQQ: 'equity', SMH: 'equity',
    GLD: 'macro',  TLT: 'macro',
    XLE: 'sector', IYR: 'sector', HYG: 'sector',
  };
  const openCallPositions = (state.positions || []).filter(p => p.optionType === 'call');
  const occupiedGroups    = new Set(openCallPositions.map(p => CORR_GROUPS[p.ticker] || 'other'));
  state._occupiedCorrGroups = [...occupiedGroups];
  state._openCallCount = openCalls;

  if (openCalls >= MAX_SIMULTANEOUS_CALLS) {
    logEvent("filter", `[CALL CAP] ${openCalls} calls already open (max ${MAX_SIMULTANEOUS_CALLS})`);
    state._callCapActive = true;
    state._slot3Active   = false;
  } else if (openCalls === 2) {
    state._callCapActive = false;
    state._slot3Active   = true;
    logEvent("filter", `[CALL CAP] 2 calls open — slot 3 available (score >= ${SLOT3_MIN_SCORE} + uncorrelated group only)`);
  } else {
    state._callCapActive = false;
    state._slot3Active   = false;
  }

  const _rb               = getRegimeRulebook(state);
  const _creditPutActive  = false; // APEX naked-only — credit mode removed (gate never set)
  const _choppyDebitBlock = _rb.gates.choppyDebitBlock;
  const _vixNow           = state.vix || 20;
  const _vixCreditMode    = _vixNow >= VIX_CREDIT_PRIMARY;
  const _vixCallsBlocked  = _vixNow >= VIX_CALLS_BLOCKED;

  if (_vixCreditMode && !_vixCallsBlocked) {
    logEvent("filter", `[VIX REGIME] VIX ${_vixNow.toFixed(1)} >= ${VIX_CREDIT_PRIMARY} — RSI gate ACTIVE | calls require RSI < ${VIX_HIGH_CALL_RSI}`);
  } else if (_vixCallsBlocked) {
    logEvent("filter", `[VIX REGIME] VIX ${_vixNow.toFixed(1)} >= ${VIX_CALLS_BLOCKED} — calls FULLY BLOCKED`);
  }

  const _etHourForGateC   = etHourNow;
  const _isPMWindow       = _etHourForGateC >= 13.0;
  const _isGapUpDay       = Math.abs(state._todayMaxGap || 0) >= 2.0 &&
                            (state._todayGapDirection || 'up') === 'up';
  const _gateCActive      = _isPMWindow && _isGapUpDay;
  const GATE_C_RSI_FLOOR  = 28;
  if (_gateCActive) {
    logEvent("filter", `[GATE-C] PM gap-up day — calls require RSI < ${GATE_C_RSI_FLOOR} after 1PM`);
  }

  const _sessionMinsNow   = etHourNow >= 9.5 ? (etHourNow - 9.5) * 60 : 0;
  const _msSinceLastEntry = Date.now() - (state._lastEntryAt || 0);
  const _minsSinceEntry   = _msSinceLastEntry / 60000;
  const _todayGapAbs      = Math.abs(state._todayMaxGap || 0);
  const _staggerMins      = _todayGapAbs >= 3.0 ? 25 : 20;
  const _staggerCooling   = state._lastEntryAt && _minsSinceEntry < _staggerMins;
  const _hardBlock        = _sessionMinsNow < 15;
  const _softBlock        = _sessionMinsNow >= 15 && _sessionMinsNow < 30;
  const _tooEarlyToTrade  = _hardBlock;

  if (_hardBlock) {
    logEvent("filter", `[STAGGER] Session only ${_sessionMinsNow.toFixed(0)}min old — hard block until 9:45 AM`);
  } else if (_softBlock) {
    logEvent("filter", `[STAGGER] Session ${_sessionMinsNow.toFixed(0)}min old — soft block (9:45-10:00 AM window, score >= 85 can bypass)`);
  } else if (_staggerCooling) {
    const _remaining = (_staggerMins - _minsSinceEntry).toFixed(0);
    logEvent("filter", `[STAGGER] Last entry ${_minsSinceEntry.toFixed(0)}min ago — cooling ${_staggerMins}min (${_remaining}min remaining)`);
  }
  state._tooEarlyToTrade = _tooEarlyToTrade;
  state._hardBlock       = _hardBlock;
  state._softBlock       = _softBlock;
  state._staggerCooling  = _staggerCooling;

  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const recentEntries = state.positions.filter(p => new Date(p.openDate).getTime() > tenMinAgo).length;
  if (recentEntries >= 3) logEvent("filter", `[INFO] ${recentEntries} entries in last 10min (heat cap governs)`);

  let marketGapDirection = null;
  if (spyBars.length >= 2) {
    const todayOpen = spyBars[spyBars.length-1].o;
    const prevClose = spyBars[spyBars.length-2].c;
    const gapPct    = (todayOpen - prevClose) / prevClose;
    if (Math.abs(gapPct) > MAX_GAP_PCT) {
      marketGapDirection = gapPct < 0 ? "down" : "up";
      logEvent("filter", `Market gap ${marketGapDirection} ${(Math.abs(gapPct)*100).toFixed(1)}%`);
    }
  }

  logEvent("scan", `Prefetching data for ${WATCHLIST.length} instruments in parallel...`);
  const scored = [];
  let _zeroScoreCount = 0;
  const prefetchStart = Date.now();

  const _openPosTickers = new Set(state.positions.map(p => p.ticker));
  const _newsAlertTickers = new Set(
    (state._recentNewsAlerts || [])
      .filter(n => Date.now() - new Date(n.ts||0).getTime() < 30 * 60 * 1000)
      .map(n => n.ticker)
  );
  const PREFETCH_WATCHLIST = WATCHLIST.filter(stock => {
    if (_openPosTickers.has(stock.ticker)) return true;
    if (_newsAlertTickers.has(stock.ticker)) return true;
    if (stock.isIndex) return true;
    const lastScore = state._scoreDebug?.[stock.ticker]?.putScore || state._scoreDebug?.[stock.ticker]?.callScore || 50;
    const lastTs    = state._scoreDebug?.[stock.ticker]?.ts || 0;
    const cacheAge  = Date.now() - lastTs;
    if (cacheAge > 5 * 60 * 1000) return true;
    return lastScore >= 35;
  });
  if (PREFETCH_WATCHLIST.length < WATCHLIST.length) {
    logEvent("scan", `[OPT-8] Pre-filter: prefetching ${PREFETCH_WATCHLIST.length}/${WATCHLIST.length} stocks`);
  }

  const STOCK_BATCH = 10;
  const stockData = [];
  for (let i = 0; i < PREFETCH_WATCHLIST.length; i += STOCK_BATCH) {
    const batch = PREFETCH_WATCHLIST.slice(i, i + STOCK_BATCH);
    const results = await Promise.all(
      batch.map(async stock => {
        try {
          if (stock.isIndex) {
            const [price, bars, intradayBars, preMarket, newsArticles] = await Promise.all([
              getStockQuote(stock.ticker),
              getStockBars(stock.ticker, 60),
              getIntradayBars(stock.ticker),
              getPreMarketData(stock.ticker),
              getNewsForTicker(stock.ticker),
            ]);
            return { stock, price, bars, intradayBars, sectorResult: { pass:true, putBoost:0 }, preMarket, newsArticles, analystData:{ modifier:0, signal:"neutral", upgrades:[], downgrades:[] }, eqScore:{ signal:"neutral" } };
          }
          const [price, bars, intradayBars, sectorResult, preMarket, newsArticles, analystData, eqScore, liveBeta, weeklyTrend] = await Promise.all([
            getStockQuote(stock.ticker),
            getStockBars(stock.ticker, 60),
            getIntradayBars(stock.ticker),
            checkSectorETF(stock),
            getPreMarketData(stock.ticker),
            getNewsForTicker(stock.ticker),
            getAnalystActivity(stock.ticker),
            Promise.resolve({ signal:"neutral" }),
            (function() {
              const cached = getCached('beta:' + stock.ticker);
              if (cached) return Promise.resolve(cached);
              return getLiveBeta(stock.ticker);
            })(),
            getWeeklyTrend(stock.ticker),
          ]);
          if (liveBeta && liveBeta > 0) { stock._liveBeta = liveBeta; setCache('beta:' + stock.ticker, liveBeta); }
          if (weeklyTrend) stock._weeklyTrend = weeklyTrend;
          return { stock, price, bars, intradayBars, sectorResult, preMarket, newsArticles, analystData, eqScore };
        } catch(e) {
          return { stock, price: null, bars: [], intradayBars: [], sectorResult: { pass:true, putBoost:0 }, preMarket:null, newsArticles:[], analystData:{ modifier:0, signal:"neutral", upgrades:[], downgrades:[] }, eqScore:{ signal:"neutral" } };
        }
      })
    );
    stockData.push(...results);
  }

  logEvent("scan", `Prefetch complete in ${((Date.now()-prefetchStart)/1000).toFixed(1)}s`);

  for (const { stock, price, bars, intradayBars, sectorResult, preMarket, newsArticles, analystData, eqScore } of stockData) {
    let entryBlocked = false;
    const maxPerTicker = stock.isIndex ? 3 : 2;
    const existingForTicker = state.positions.filter(p => p.ticker === stock.ticker);
    const logicalExisting = new Set(existingForTicker.map(p => `${p.optionType}|${p.expDate}`)).size;
    const maxCombined = stock.isIndex ? 3 : 2;
    if (logicalExisting >= maxCombined) continue;

    if ((state.tickerBlacklist || []).includes(stock.ticker)) {
      logEvent("filter", `${stock.ticker} blacklisted - skipping`);
      continue;
    }

    const WASH_SALE_MS = 30 * 24 * 60 * 60 * 1000;
    const washSaleClose = (state.closedTrades || []).filter(t => t.reason !== "reconcile-removed").find(t =>
      t.ticker === stock.ticker && t.pnl < 0 && t.closeTime && (Date.now() - t.closeTime) < WASH_SALE_MS
    );
    if (washSaleClose) {
      const daysAgo = ((Date.now() - washSaleClose.closeTime) / MS_PER_DAY).toFixed(0);
      logEvent("filter", `${stock.ticker} wash sale warning - loss closed ${daysAgo}d ago - entering anyway but flagging`);
      stock._washSaleWarning = true;
    }

    if (!price || price < MIN_STOCK_PRICE) {
      _zeroScoreCount++;
      if (!state._scoreDebug) state._scoreDebug = {};
      state._scoreDebug[stock.ticker] = { ts: Date.now(), price: price||0, putScore: 0, callScore: 0, effectiveMin: MIN_SCORE, putReasons: [], callReasons: [], signals: {}, blocked: ["no price data"] };
      continue;
    }

    if (bars.length >= 2) {
      const overnightGap = Math.abs(bars[bars.length-1].o - bars[bars.length-2].c) / bars[bars.length-2].c;
      const _gapDir = bars[bars.length-1].o - bars[bars.length-2].c;
      const _isCreditPutMode = false;
      const _skipForGap = overnightGap > MAX_GAP_PCT && _gapDir > 0;
      if (_skipForGap) {
        logEvent("filter", `${stock.ticker} gap UP ${(overnightGap*100).toFixed(1)}% overnight - skip`);
        continue;
      }
      if (overnightGap > MAX_GAP_PCT && _gapDir < 0) {
        logEvent("filter", `${stock.ticker} gap DOWN ${(overnightGap*100).toFixed(1)}% — put thesis possible, scoring continues`);
      }
      const intradayCrash = (bars[bars.length-1].o - price) / bars[bars.length-1].o;
      if (intradayCrash > 0.15) {
        logEvent("filter", `${stock.ticker} intraday crash ${(intradayCrash*100).toFixed(1)}% below open - skip`);
        continue;
      }
    }

    const sectorPositions = state.positions.filter(p => p.sector === stock.sector);
    const hasSectorCall   = sectorPositions.some(p => p.optionType === "call");
    const hasSectorPut    = sectorPositions.some(p => p.optionType === "put");

    const filterResult = await checkAllFilters(stock, price, bars);

    let weaknessBoost = 0;
    const weaknessReasons = [];
    const MAX_WEAKNESS_BOOST = 20;

    const avgVol      = bars.length ? bars.slice(0,-1).reduce((s,b)=>s+b.v,0)/Math.max(bars.length-1,1) : 0;
    const todayVol    = bars.length ? bars[bars.length-1].v : 0;
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
      const etfReturn  = sectorResult.etfReturn || 0;
      const stockVsEtf = etfReturn !== 0 ? (1 + stockReturn) / (1 + etfReturn) - 1 : 0;
      const etfBoost   = stockVsEtf < -0.02 ? 15 : stockVsEtf < 0 ? 8 : 5;
      weaknessBoost += etfBoost;
      weaknessReasons.push(`Sector ETF down, stock ${stockVsEtf < 0 ? "lagging" : "in line"} (+${etfBoost})`);
      if (filterResult.reason?.includes("support")) { weaknessBoost += 10; weaknessReasons.push(`Near support breakdown (+10)`); }
    }

    const sectorPeers  = stockData.filter(d => d.stock.sector === stock.sector && d.stock.ticker !== stock.ticker && d.bars && d.bars.length >= 5);
    const sectorAvgRet = sectorPeers.length
      ? sectorPeers.reduce((s, d) => s + (d.bars[d.bars.length-1].c - d.bars[0].o) / d.bars[0].o, 0) / sectorPeers.length
      : stockReturn;
    const relToSector  = sectorAvgRet !== 0 ? (1 + stockReturn) / (1 + sectorAvgRet) : 1;

    if (!price || price <= 0 || price > 100000) { logEvent("filter", `${stock.ticker} price anomaly: invalid price $${price} - skip`); continue; }

    if (bars.length < 10) {
      logEvent("filter", `${stock.ticker} insufficient bars (${bars.length}) - skip`);
      if (!state._scoreDebug) state._scoreDebug = {};
      state._scoreDebug[stock.ticker] = { ts: Date.now(), price: price||0, putScore: 0, callScore: 0, effectiveMin: MIN_SCORE, putReasons: [], callReasons: [], signals: {}, blocked: [`insufficient bars (${bars.length})`] };
      continue;
    }
    const signals = await getDynamicSignals(stock.ticker, bars, intradayBars, stock._realIV || null);

    const vwap = signals.intradayVWAP > 0 ? signals.intradayVWAP : calcVWAP(bars.slice(-5));
    let _carveGapState = "flat";   // #3: present-tense gap state, set by classifier below if vwap valid
    let _carveVwapRatio = 1;       // #3: price/vwap, <1 below >1 above
    if (vwap > 0) {
      const vwapBias = price < vwap ? "below_vwap" : "above_vwap";
      const vwapPct  = ((price - vwap) / vwap * 100).toFixed(1);
      if (Math.abs(price - vwap) / vwap > 0.005) {
        logEvent("scan", `[VWAP] ${stock.ticker} $${price.toFixed(2)} vs VWAP $${vwap.toFixed(2)} (${vwapPct}%) - ${vwapBias}`);
      }
      // [GAP] classifier (6/26, LOGGED-ONLY — no scoring effect). gapPct off today's regular
      // open vs prior regular close; gapState combines gapType with the live VWAP relationship.
      // Faded = gapped one way but price now on the other side of VWAP (the trap to watch).
      if (Array.isArray(bars) && bars.length >= 2) {
        const _gapOpen  = bars[bars.length - 1].o;
        const _gapPrevC = bars[bars.length - 2].c;
        if (_gapOpen > 0 && _gapPrevC > 0) {
          const _gapPct  = (_gapOpen - _gapPrevC) / _gapPrevC;
          const _gapType = _gapPct >=  GAP_MIN_PCT ? "up"
                         : _gapPct <= -GAP_MIN_PCT ? "down" : "flat";
          const _aboveVwap = price >= vwap;
          let _gapState = "flat";
          if (_gapType === "up")   _gapState = _aboveVwap ? "gap-up-holding"   : "gap-up-faded";
          if (_gapType === "down") _gapState = _aboveVwap ? "gap-down-reclaimed" : "gap-down-holding";
          // #3 carve-out inputs: capture present-tense tape state; assigned onto liveStock below
          // (liveStock is constructed later in this loop, ~1462, so stash in loop-scoped vars now).
          _carveGapState = _gapState;
          _carveVwapRatio = vwap > 0 ? price / vwap : 1;   // <1 below, >1 above
          logEvent("scan",
            `[GAP] ${stock.ticker} gapPct ${(_gapPct*100).toFixed(2)}% (${_gapType}) | ` +
            `open ${_gapOpen.toFixed(2)} prevC ${_gapPrevC.toFixed(2)} | px ${price.toFixed(2)} ` +
            `${_aboveVwap ? "≥" : "<"} vwap ${vwap.toFixed(2)} → ${_gapState}`
          );
        }
      }
      const _sessionMinutes = etHourNow >= 9.5 ? (etHourNow - 9.5) * 60 : 0;
      const _vwapReliable = _sessionMinutes >= 30;
      const _callLikelyPath = signals.rsi !== null && signals.rsi < 40;
      if (_vwapReliable && _callLikelyPath && price < vwap * 0.99) {
        // D3 (6/24, panel Option 3): block a below-VWAP call ONLY while it's still making new
        // session lows (a true falling knife). Once intraday RSI lifts MR_INTRA_LIFTOFF_PTS off
        // its own session low the dip is turning — let it through. Same early-turn model as the MR
        // scorer (scoring.js), so scoring and this gate now share one confirmation rule instead of
        // contradicting each other. Both outcomes are logged for measurement.
        const _vwSessLowRSI = state._sessionLowRSI?.[stock.ticker] ?? signals.rsi;
        const _vwLiftOff    = signals.rsi - _vwSessLowRSI;
        const _vwPctBelow   = ((price/vwap-1)*100).toFixed(1);
        if (_vwLiftOff < MR_INTRA_LIFTOFF_PTS) {
          logEvent("filter", `[VWAP] ${stock.ticker} MR call path blocked — ${_vwPctBelow}% below VWAP, still falling (RSI ${signals.rsi.toFixed(0)} vs sessLow ${_vwSessLowRSI.toFixed(0)}, liftoff ${_vwLiftOff.toFixed(0)}<${MR_INTRA_LIFTOFF_PTS})`);
          continue;
        }
        logEvent("filter", `[VWAP] ${stock.ticker} below-VWAP call ALLOWED (early turn) — ${_vwPctBelow}% below VWAP but RSI lifting off (sessLow ${_vwSessLowRSI.toFixed(0)}→${signals.rsi.toFixed(0)}, +${_vwLiftOff.toFixed(0)})`);
      }
      const _putsOnBounceActive = rb.gates.putsOnBounceMode && rb.isBearRegime;
      if (_putsOnBounceActive && price > vwap * 1.02) {
        const _bounceVwapPct = ((price - vwap) / vwap * 100).toFixed(1);
        const _bounceBoost   = price > vwap * 1.04 ? 15 : price > vwap * 1.02 ? 10 : 5;
        weaknessBoost += _bounceBoost;
        weaknessReasons.push(`Bounce: ${_bounceVwapPct}% above VWAP (+${_bounceBoost})`);
      }
    }
    if (vwap > 0 && price < vwap * 0.99) {
      const vwapGap   = (vwap - price) / vwap;
      const vwapPts   = vwapGap > 0.03 ? 10 : vwapGap > 0.01 ? 6 : 3;
      logEvent("filter", `${stock.ticker} below VWAP (${(vwapGap*100).toFixed(1)}%) - put boost +${vwapPts}`);
      weaknessBoost += vwapPts;
      weaknessReasons.push(`Below VWAP ${(vwapGap*100).toFixed(1)}% (+${vwapPts})`);
    }

    if (preMarket && Math.abs(preMarket.gapPct || 0) > 4) {
      logEvent("scan", `[GAP DAY] ${stock.ticker} ${(preMarket.gapPct > 0 ? 'gap-up' : 'gap-down')} ${Math.abs(preMarket.gapPct).toFixed(1)}%`);
    }
    if (preMarket && Math.abs(preMarket.gapPct) > 3) {
      logEvent("filter", `${stock.ticker} pre-market gap ${preMarket.gapPct > 0 ? "+" : ""}${preMarket.gapPct}%`);
    }

    const _gapPctForGate  = parseFloat(preMarket?.gapPct || 0);
    const _absGap         = Math.abs(_gapPctForGate);
    const _priceAboveVWAP = vwap > 0 && price > vwap;
    const _priceBelowVWAP = vwap > 0 && price < vwap;

    if (_absGap > Math.abs(state._todayMaxGap || 0)) {
      state._todayMaxGap       = _gapPctForGate;
      state._todayGapDirection = _gapPctForGate > 0 ? 'up' : 'down';
      if (_absGap >= 2.0) {
        state._gapReversalDay = true;
        logEvent("filter", `[GAP-REVERSAL] Today's pre-market gap ${_gapPctForGate > 0 ? '+' : ''}${_gapPctForGate.toFixed(1)}% — gap-reversal mode ACTIVE`);
      }
    }

    const _todayMaxGapAbs  = Math.abs(state._todayMaxGap || 0);
    const _todayMaxGapDir  = state._todayGapDirection || 'up';
    const _effectiveGapAbs = Math.max(_absGap, _todayMaxGapAbs);
    const _effectiveGapPct = _effectiveGapAbs > _absGap
      ? (_todayMaxGapDir === 'up' ? _effectiveGapAbs : -_effectiveGapAbs)
      : _gapPctForGate;

    let _tmpGapCallBlocked  = false;
    let _tmpGapPutBlocked   = false;
    let _tmpGapCallBoost    = 0;
    let _tmpGapPutBoost     = 0;
    let _tmpGapCallStrictRSI = false;

    if (_effectiveGapPct >= 2.0) {
      const _gapSource = _effectiveGapAbs > _absGap ? `session-high ${_effectiveGapAbs.toFixed(1)}%` : `live ${_gapPctForGate.toFixed(1)}%`;
      if (_priceAboveVWAP) {
        _tmpGapCallBlocked = true;
        logEvent("filter", `[GAP-VWAP] ${stock.ticker} gap-up (${_gapSource}) + price > VWAP — calls BLOCKED`);
      } else {
        _tmpGapCallStrictRSI = true;
        logEvent("filter", `[GAP-VWAP] ${stock.ticker} gap-up (${_gapSource}) below VWAP — calls need RSI < 37`);
      }
      _tmpGapPutBoost = 10;
    } else if (_effectiveGapPct <= -2.0) {
      const _gapSource = _effectiveGapAbs > _absGap ? `session-low ${_effectiveGapAbs.toFixed(1)}%` : `live ${_gapPctForGate.toFixed(1)}%`;
      if (_priceBelowVWAP) {
        _tmpGapPutBlocked = true;
        logEvent("filter", `[GAP-VWAP] ${stock.ticker} gap-down (${_gapSource}) + price < VWAP — puts BLOCKED`);
      }
      _tmpGapCallBoost = 10;
    }

    const shortSignal = { signal: "neutral", modifier: 0 };
    const newsSentiment = analyzeNews(newsArticles);
    const liveBeta  = stock._liveBeta || stock.beta || 1.0;

    const liveStock = {
      ...stock,
      price,
      rsi:           signals.rsi,
      dailyRsi:      (signals && signals.dailyRsi != null) ? parseFloat(signals.dailyRsi) : parseFloat(signals?.rsi || 50),
      macd:          signals.macd,
      macdCurl:      signals.macdCurl || "none",   // V3.2 (6/19) histogram bull/bear-curl → scoreIndexSetup
      _gapState:     _carveGapState,                // #3 carve-out: present-tense gap/VWAP state
      _gapVwapRatio: _carveVwapRatio,               // #3 carve-out: price/vwap ratio
      macdHist:      typeof signals.macdHist === 'number' ? signals.macdHist : null,
      momentum:      signals.momentum,
      ivr:           signals.ivr,
      beta:          liveBeta,
      newsSentiment: newsSentiment.signal,
      intradayVWAP:  signals.intradayVWAP || 0,
      atrPct:        signals.atrPct || null,
      volPaceRatio:  signals.volPaceRatio || 1,
      hasIntraday:   signals.hasIntraday || false,
      ivPercentile:  signals.ivPercentile || 50,
    };

    liveStock._gapDayCallBlocked  = _tmpGapCallBlocked;
    liveStock._gapDayPutBlocked   = _tmpGapPutBlocked;
    liveStock._gapCallBoost       = _tmpGapCallBoost;
    liveStock._gapPutBoost        = _tmpGapPutBoost;
    liveStock._gapCallStrictRSI   = _tmpGapCallStrictRSI;

    if (liveStock.dailyRsi != null) {
      _liveDailyRsiMap[stock.ticker] = liveStock.dailyRsi;
    }

    if (signals.rsi === null || signals.dailyRsi === null) {
      const _rsiHist = (state._rsiHistory || {})[stock.ticker] || [];
      const _lastKnownRsi = _rsiHist.length > 0 ? _rsiHist[_rsiHist.length - 1].rsi : null;
      if (_lastKnownRsi !== null) {
        if (signals.rsi    === null) signals.rsi    = _lastKnownRsi;
        if (signals.dailyRsi === null) signals.dailyRsi = _lastKnownRsi;
        logEvent("filter", `${stock.ticker} RSI fallback — using last known daily RSI ${_lastKnownRsi.toFixed(1)}`);
      } else {
        logEvent("filter", `${stock.ticker} scan skipped — no RSI data`);
        continue;
      }
    }

    if (signals.hasIntraday) {
      logEvent("filter", `${stock.ticker} intraday RSI:${signals.rsi} dailyRSI:${signals.dailyRsi} MACD:${signals.macd} MOM:${signals.momentum}`);
      updateOversoldTracker(stock.ticker, signals.dailyRsi);

      if (!state._rsiHistory) state._rsiHistory = {};
      let rsiHist = state._rsiHistory[stock.ticker] || [];
      if (rsiHist.length > 0 && typeof rsiHist[0] !== 'object') rsiHist = [];
      const todayStr = getETTime().toISOString().slice(0, 10);
      if (rsiHist.length === 0 || rsiHist[rsiHist.length - 1]?.date !== todayStr) {
        const dailyRsiVal = (signals && typeof signals.dailyRsi === "number") ? signals.dailyRsi : null;
        if (dailyRsiVal !== null) {
          rsiHist.push({ date: todayStr, rsi: dailyRsiVal });
          if (rsiHist.length > 5) rsiHist.shift();
        }
      }
      state._rsiHistory[stock.ticker] = rsiHist;

      if (!state._intradayOversoldScans)  state._intradayOversoldScans  = {};
      if (!state._sessionLowRSI)          state._sessionLowRSI          = {};
      if (!state._sessionLowRSIAt)        state._sessionLowRSIAt        = {};

      const curRSI = signals.rsi;
      if (curRSI !== null && curRSI !== undefined) {
        const prevLow = state._sessionLowRSI[stock.ticker] ?? 100;
        if (curRSI < prevLow) {
          state._sessionLowRSI[stock.ticker]   = curRSI;
          state._sessionLowRSIAt[stock.ticker] = Date.now();
        }
        const sessionLow = state._sessionLowRSI[stock.ticker] ?? 100;
        if (curRSI <= sessionLow + 2) {
          state._intradayOversoldScans[stock.ticker] = 0;
        } else if (sessionLow <= 30 && curRSI >= 38) {
          state._intradayOversoldScans[stock.ticker] = (state._intradayOversoldScans[stock.ticker] || 0) + 1;
        } else {
          state._intradayOversoldScans[stock.ticker] = 0;
        }
      }
    }

    const volDecline  = todayVol < avgVol * 0.7;
    const timeOfDayMult = 1.0;
    const entryWindowClosed = etHourNow >= 15.5;
    const weeklyTrend = stock._weeklyTrend || { trend: 'neutral', above10wk: null };

    // Score both put and call setups
    let callSetup, putSetup;
    if (stock.isIndex) {
      const agentMacro  = state._agentMacro || {};
      const spyRSIPut   = liveStock.dailyRsi || liveStock.rsi || 50;
      const spyRSICall  = liveStock.dailyRsi || liveStock.rsi || 50;
      const spyMACD     = liveStock.macd || "neutral";
      const spyMomentum = liveStock.momentum || "steady";
      const breadthVal  = typeof marketContext?.breadth === "number"
        ? marketContext.breadth * 100
        : marketContext?.breadth?.breadthPct ?? 50;
      const scoringMacro  = { ...(agentMacro || {}), regime: authRegimeName, spyGapUp: !!spyGapUp, spyDayChange: state._spyDayChangePct };
      const putResult  = scoreIndexSetup(liveStock, "put",  spyRSIPut,  spyMACD, spyMomentum, breadthVal, state.vix, scoringMacro, liveStock.rsi);
      const callResult = scoreIndexSetup(liveStock, "call", spyRSICall, spyMACD, spyMomentum, breadthVal, state.vix, scoringMacro, liveStock.rsi);

      putSetup  = { score: putResult.score,  reasons: putResult.reasons,  tradeType: "put",  isMeanReversion: false, _isOverboughtMRPut: !!putResult._isOverboughtMRPut };
      callSetup = { score: callResult.score, reasons: callResult.reasons, tradeType: "call", isMeanReversion: false };

      if (stock.ticker === "QQQ") {
        const spyPutOpen  = state.positions.some(p => p.ticker === "SPY" && p.optionType === "put");
        const spyCallOpen = state.positions.some(p => p.ticker === "SPY" && p.optionType === "call");
        logEvent("filter", `[PUT-AUDIT] QQQ pre-corr scores: put=${putSetup.score} call=${callSetup.score} | dailyRSI:${(liveStock.dailyRsi||0).toFixed(0)}`);
        if (spyPutOpen  && putSetup.score  < MIN_SCORE_CREDIT) { putSetup.score  = Math.min(putSetup.score,  30); logEvent("filter", `QQQ corr-block: SPY put open, QQQ put score below minimum`); }
        if (spyCallOpen && callSetup.score < MIN_SCORE_CREDIT) { callSetup.score = Math.min(callSetup.score, 30); logEvent("filter", `QQQ corr-block: SPY call open, QQQ call score below minimum`); }
      }
      if (stock.ticker === "SPY") {
        const qqqPutOpen  = state.positions.some(p => p.ticker === "QQQ" && p.optionType === "put");
        const qqqCallOpen = state.positions.some(p => p.ticker === "QQQ" && p.optionType === "call");
        logEvent("filter", `[PUT-AUDIT] SPY pre-corr scores: put=${putSetup.score} call=${callSetup.score} | dailyRSI:${(liveStock.dailyRsi||0).toFixed(0)}`);
        if (qqqPutOpen  && putSetup.score  < MIN_SCORE_CREDIT) { putSetup.score  = Math.min(putSetup.score,  30); logEvent("filter", `SPY corr-block: QQQ put open, SPY put score below minimum`); }
        if (qqqCallOpen && callSetup.score < MIN_SCORE_CREDIT) { callSetup.score = Math.min(callSetup.score, 30); logEvent("filter", `SPY corr-block: QQQ call open, SPY call score below minimum`); }
        if (state._scoreDebug?.[stock.ticker]) {
          state._scoreDebug[stock.ticker].putScore  = putSetup.score;
          state._scoreDebug[stock.ticker].callScore = callSetup.score;
        }
      }

      if (stock.ticker === "GLD") {
        const dxy5d       = marketContext.dxy || { trend: "neutral", change: 0 };
        const spy5dReturn = spyBars.length >= 5 ? (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c : 0;
        const _gldBarsForMA = (state._gldBars?.length >= 20) ? state._gldBars : (bars?.length >= 20) ? bars : null;
        const gldMA20Live   = _gldBarsForMA ? _gldBarsForMA.slice(-20).reduce((s,b) => s + b.c, 0) / 20 : 0;
        const _gldBarsFor5d = (state._gldBars?.length >= 5) ? state._gldBars : (bars?.length >= 5) ? bars : null;
        const gld5dReturn   = _gldBarsFor5d ? (_gldBarsFor5d[_gldBarsFor5d.length-1].c - _gldBarsFor5d[_gldBarsFor5d.length-5].c) / _gldBarsFor5d[_gldBarsFor5d.length-5].c : null;
        const _gldSessionMins = _sessionMinsNow;
        const _gldMomentum    = liveStock.momentum || signals.momentum || 'steady';
        const _gldDailyRSI    = parseFloat(liveStock.dailyRsi || liveStock.dailyRSI || 0) || null;
        const _gldVolPace     = liveStock.volPaceRatio || signals.volPaceRatio || 1.0;
        const _gldMacdNow     = (liveStock.macd || signals.macd || '').toLowerCase();
        const _gldVWAP        = signals.intradayVWAP || 0;

        if (_gldMacdNow.includes('bullish') && !state._gldMacdWasBullish) {
          state._gldMacdCrossoverAt  = Date.now();
          state._gldMacdWasBullish   = true;
        } else if (!_gldMacdNow.includes('bullish')) {
          state._gldMacdWasBullish   = false;
        }
        const _gldMacdCrossoverDays = state._gldMacdCrossoverAt ? (Date.now() - state._gldMacdCrossoverAt) / 86400000 : null;

        const gldCallGate = isGLDEntryAllowed("call", dxy5d, spy5dReturn, state.vix, liveStock.rsi, liveStock.price || 0, gldMA20Live, _gldSessionMins, _gldMomentum, gld5dReturn, _gldDailyRSI, _gldMacdCrossoverDays, _gldVolPace, _gldVWAP, gldMA20Live);
        const _gldBestScore   = isBearTrend ? callSetup.score : putSetup.score;
        const _gldCreditMode  = creditCallModeActive || creditModeActive;
        const _gldIntentType  = (_gldCreditMode && _gldBestScore >= MIN_SCORE_CREDIT) ? "credit_put" : "debit_put";
        const gldPutGate  = isGLDEntryAllowed("put",  dxy5d, spy5dReturn, state.vix, liveStock.rsi, liveStock.price || 0, gldMA20Live, _gldSessionMins, _gldMomentum, gld5dReturn, _gldDailyRSI, _gldMacdCrossoverDays, _gldVolPace, _gldVWAP, gldMA20Live);
        if (!gldCallGate.allowed) { callSetup.score = 0; logEvent("filter", gldCallGate.reason); }
        if (!gldPutGate.allowed)  { putSetup.score  = 0; logEvent("filter", gldPutGate.reason);  }
        if (callSetup.score > 0 && state.vix > 32) { callSetup.score = Math.max(0, callSetup.score - 10); }
        if (callSetup.score > 0) {
          if (_gldVolPace < 0.7) { callSetup.score = Math.max(0, callSetup.score - 10); }
          else if (_gldVolPace > 1.2) { callSetup.score += 10; }
        }
        if (callSetup.score > 0 && callSetup.score < 85) { callSetup.score = 0; logEvent("filter", `GLD call score ${callSetup.score} below 85 minimum`); }
        if (putSetup.score > 0  && putSetup.score  < 75) { putSetup.score  = 0; logEvent("filter", `GLD put score ${putSetup.score} below 75 minimum`); }
        const _gldAboveMA20 = gldMA20Live > 0 && (liveStock.price || price) > gldMA20Live;
        const _gldDailyRsi  = _gldDailyRSI || parseFloat(liveStock.dailyRsi || 50);
        if (putSetup.score > 0 && _gldDailyRsi > 65 && _gldAboveMA20) { putSetup.score = 0; logEvent("filter", `GLD put blocked — dailyRSI ${_gldDailyRsi.toFixed(1)} > 65 AND above 20MA`); }
      }

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

      if (stock.ticker === "XLE") {
        const xleMA20Live = (state._xleBars && state._xleBars.length >= 20) ? state._xleBars.slice(-20).reduce((s,b) => s + b.c, 0) / 20 : 0;
        const xleCallGate = isXLEEntryAllowed("call", liveStock.rsi, liveStock.momentum, state.vix, liveStock.price || 0, xleMA20Live, liveStock.dailyRsi);
        const xlePutGate  = isXLEEntryAllowed("put",  liveStock.rsi, liveStock.momentum, state.vix, liveStock.price || 0, xleMA20Live, liveStock.dailyRsi);
        if (!xleCallGate.allowed) { callSetup.score = 0; logEvent("filter", xleCallGate.reason); }
        if (!xlePutGate.allowed)  { putSetup.score  = 0; logEvent("filter", xlePutGate.reason);  }
        const _xleDailyRsi = parseFloat(liveStock.dailyRsi || 50);
        if (callSetup.score > 0 && _xleDailyRsi >= 45) { callSetup.score = 0; logEvent("filter", `XLE call blocked — dailyRSI ${_xleDailyRsi.toFixed(1)} not oversold`); }
        const _xleGap = parseFloat(preMarket?.gapPct || 0);
        if (callSetup.score > 0 && _xleGap < -3) { callSetup.score = 0; logEvent("filter", `XLE call blocked — gap ${_xleGap.toFixed(1)}%`); }
      }

      if (stock.ticker === "HYG") {
        if ((state.vix || 20) < 30) {
          logEvent("filter", `HYG skipped — VIX ${(state.vix||20).toFixed(1)} < 30`);
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
      callSetup = { score: 0, reasons: ["Individual stocks disabled"], tradeType: "none" };
      putSetup  = scorePutSetup(liveStock, relStrength, signals.adx, todayVol, avgVol, state.vix);
    }

    if (weeklyTrend.above10wk !== null) liveStock._weeklyTrend = weeklyTrend;

    let relWeaknessPoints = 0;
    const volRatio = avgVol > 0 ? todayVol / avgVol : 1;
    const priceAboveOpen = liveStock.price > (liveStock.intradayOpen || liveStock.price);

    if (callSetup.score > 0) {
      if (volRatio > 1.5 && priceAboveOpen) { callSetup.score = Math.min(100, callSetup.score + 10); callSetup.reasons.push(`High volume UP day (+10)`); }
      else if (volRatio < 0.7 && !priceAboveOpen) { callSetup.score = Math.min(100, callSetup.score + 8); callSetup.reasons.push(`Low volume pullback (+8)`); }
      else if (volRatio > 1.5 && !priceAboveOpen) { callSetup.score = Math.max(0, callSetup.score - 8); callSetup.reasons.push(`High volume DOWN day (-8)`); }
    }

    if (volRatio > 2.0) { putSetup.score = Math.min(100, putSetup.score + 5); putSetup.reasons.push(`Extreme volume (+5)`); }
    else if (volRatio > 1.3) { putSetup.score = Math.min(100, putSetup.score + 8); putSetup.reasons.push(`High volume confirms selling (+8)`); }
    else if (volRatio < 0.6) {
      const inBearForVol = ["B","C"].includes(state._regimeClass);
      if (!inBearForVol) { putSetup.score = Math.max(0, putSetup.score - 3); putSetup.reasons.push(`Low volume selloff (-3)`); }
    }

    const putsOnBouncesBias  = (state._agentMacro || {}).entryBias === "puts_on_bounces";
    const isCreditPutMode    = creditModeActive;
    if (spyRecovering && !(putsOnBouncesBias) && !isCreditPutMode) {
      putSetup.score = Math.max(0, putSetup.score - 20);
      putSetup.reasons.push("SPY recovering (-20)");
    }

    const SPY_WEAKNESS_GROUP_CAP = 25;
    if (relToSector < 0.97) {
      const relBoost = relToSector < 0.93 ? 15 : 8;
      const cappedRelBoost = Math.min(relBoost, Math.max(0, SPY_WEAKNESS_GROUP_CAP - relWeaknessPoints));
      if (cappedRelBoost > 0) {
        putSetup.score = Math.min(95, putSetup.score + cappedRelBoost);
        putSetup.reasons.push(`Weak vs sector peers (+${cappedRelBoost})`);
        relWeaknessPoints += cappedRelBoost;
      }
    } else if (relToSector > 1.03) {
      putSetup.score = Math.max(0, putSetup.score - 10);
      putSetup.reasons.push(`Outperforming sector peers (-10)`);
    }

    if (signals.volPaceRatio > 2.0 && signals.hasIntraday) {
      putSetup.score  = Math.min(100, putSetup.score + 8); putSetup.reasons.push(`Volume ${signals.volPaceRatio.toFixed(1)}x pace (+8)`);
      callSetup.score = Math.min(100, callSetup.score + 8); callSetup.reasons.push(`Volume ${signals.volPaceRatio.toFixed(1)}x pace (+8)`);
    } else if (signals.volPaceRatio < 0.4 && signals.hasIntraday) {
      putSetup.score  = Math.max(0, putSetup.score - 5);
      callSetup.score = Math.max(0, callSetup.score - 5);
    }

    if (weaknessBoost > 0) {
      const cappedBoost = Math.min(weaknessBoost, MAX_WEAKNESS_BOOST);
      putSetup.score  = Math.min(100, putSetup.score + cappedBoost);
      putSetup.reasons.push(...weaknessReasons);
      callSetup.score = Math.max(0, callSetup.score - cappedBoost);
      logEvent("filter", `${stock.ticker} weakness signals - put boost +${cappedBoost}`);
    }

    if (state.vix >= 25) {
      const vixPutBoost = state.vix >= 35 ? 5 : state.vix >= 30 ? 3 : 2;
      putSetup.score = Math.min(100, putSetup.score + vixPutBoost);
      putSetup.reasons.push(`VIX ${state.vix.toFixed(1)} environment (+${vixPutBoost})`);
    }

    callSetup.score = Math.min(100, Math.max(0, callSetup.score + (newsSentiment.modifier || 0)));
    putSetup.score  = Math.min(100, Math.max(0, putSetup.score  - (newsSentiment.modifier || 0)));
    if (newsSentiment.signal !== "neutral") logEvent("news", `${stock.ticker} news: ${newsSentiment.signal} | modifier: ${newsSentiment.modifier > 0 ? "+" : ""}${newsSentiment.modifier}`);

    if (analystData.modifier !== 0) {
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + analystData.modifier));
      putSetup.score  = Math.min(100, Math.max(0, putSetup.score  - analystData.modifier));
    }

    if (eqScore.signal === "positive") { callSetup.score = Math.min(100, callSetup.score + 8); callSetup.reasons.push("Positive earnings history (+8)"); }
    if (eqScore.signal === "negative") { callSetup.score = Math.max(0, callSetup.score - 8); putSetup.score = Math.min(100, putSetup.score + 8); }

    const factorResult = calcFactorScore(liveStock, signals, relStrength, newsSentiment.modifier, analystData.modifier);
    if (factorResult.total >= 70 && callSetup.score >= MIN_SCORE) {
      callSetup.score = Math.min(100, callSetup.score + 5);
      callSetup.reasons.push(`Factor model: ${factorResult.total}/100 (+5)`);
    }

    if (shortSignal.modifier > 0) callSetup.score = Math.min(100, Math.max(0, callSetup.score + shortSignal.modifier));

    const calMod = (marketContext.macroCalendar || {}).modifier || 0;
    if (calMod !== 0) callSetup.score = Math.min(100, Math.max(0, callSetup.score + calMod));

    const globalMod = (marketContext.globalMarket || {}).modifier || 0;
    if (globalMod !== 0) {
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + globalMod));
      putSetup.score  = Math.min(100, Math.max(0, putSetup.score  - globalMod));
    }

    const regimeMod = getRegimeModifier(marketContext.regime?.regime || "neutral", "call");

    const mrSetup = scoreMeanReversionCall(liveStock, relStrength, signals.adx, bars, state.vix, intradayBars);
    const _mrDailyRsi       = liveStock.dailyRsi || 50;
    const _idxBullExempt    = (liveStock.isIndex === true || stock.isIndex === true) && (state._regimeClass || "A") === "A";
    const mrBearishTrend    = _idxBullExempt
      ? false  // index MR call in Regime A: oversold daily IS the entry signal, not a disqualifier (mirrors scoring.js C2 put-path)
      : (_mrDailyRsi < 45 || (_mrDailyRsi < 52 && (liveStock.macd || "").includes("bearish")));
    const mrDailyOverbought = _mrDailyRsi > 75;
    const _mrBeta   = stock.beta || 1.0;
    const _mrSector = stock.sector || "";
    const mrLiquid  = stock.isIndex || (_mrBeta >= 1.2 && _mrSector !== "Financial");
    // V3.2 (6/19) MR-LABEL DECOUPLING (panel-decided; flag MR_LABEL_DECOUPLED, default OFF).
    // _mrStrong = the original score-beat win — the STRICT tier. Gates the aggressive contract
    // profile (0.42Δ/14DTE), sizing, and defensive-mode survival (unchanged semantics).
    const _mrStrong = (mrSetup.score > callSetup.score) && !mrBearishTrend && !mrDailyOverbought && mrLiquid;
    callSetup._mrStrong = _mrStrong;   // always carried (strict tier) — read by contract/defensive gates
    // LIBERAL eligibility: when decoupled, the LABEL is granted on the SETUP (mrSetup recognized an
    // oversold index MR dip) regardless of which scorer won — floor/carve-out eligibility only. The
    // carve-out's own intraday-RSI<=35 gate stays the binding entry boundary. Flag OFF ⇒ _mrStrong
    // (exact prior behavior, since isMeanReversion ⟺ _mrStrong then).
    const _mrEligible = MR_LABEL_DECOUPLED
      ? (mrSetup.isMeanReversion === true && !mrBearishTrend && !mrDailyOverbought && mrLiquid)
      : _mrStrong;
    if (_mrEligible) {
      // SCORE: keep the higher of the two (never lose points); reasons follow the score used.
      if (mrSetup.score >= callSetup.score) { callSetup.score = mrSetup.score; callSetup.reasons = mrSetup.reasons; }
      callSetup.isMeanReversion = true;
      const _mrVixContext = state.vix >= 28 ? ` | VIX ${state.vix?.toFixed(1)} elevated` : "";
      logEvent("filter", `${stock.ticker} MEAN REVERSION${_mrStrong ? "" : " (label-only, std profile)"}: score ${Math.max(mrSetup.score, callSetup.score)}${_mrVixContext}`);
    }

    const ddProtocol  = marketContext.drawdownProtocol || { minScore: MIN_SCORE, sizeMultiplier: 1.0 };
    if (ddProtocol.pauseEntries) { logEvent("filter", `[DRAWDOWN] Entries paused`); continue; }
    const _circuit = getCircuitState();
    if (_circuit.open) { logEvent("filter", `[CIRCUIT] Entries paused - Alpaca API degraded`); continue; }

    if (state._spiralActive) {
      // D3 (6/24) time-decay auto-clear: the spiral block could previously only clear on a WINNING
      // trade of the blocked side — but that side was blocked, so it could never win → permanent
      // deadlock until the daily reset. Now it auto-clears after SPIRAL_COOLDOWN_MIN so entries
      // resume for data-gathering. Reset the tracker too, else the next single loss re-triggers at 5→6.
      const _spiralAgeMin = state._spiralActiveSince ? (Date.now() - state._spiralActiveSince) / 60000 : Infinity;
      if (_spiralAgeMin >= SPIRAL_COOLDOWN_MIN) {
        logEvent("scan", `[SPIRAL] ${state._spiralActive} block auto-cleared after ${Math.round(_spiralAgeMin)}min (cooldown ${SPIRAL_COOLDOWN_MIN}min) — resuming entries`);
        if (state._spiralTracker) state._spiralTracker[state._spiralActive] = 0;
        state._spiralActive = null;
        state._spiralActiveSince = null;
      } else {
        const spiralType = state._spiralActive;
        if (spiralType === "call") { callSetup = { score: 0, reasons: ["Spiral block"] }; }
        if (spiralType === "put")  { putSetup  = { score: 0, reasons: ["Spiral block"] }; }
      }
    }

    const macro = marketContext.macro || { scoreModifier: 0, sectorBearish: [], sectorBullish: [] };
    const _macroSectorBearish = macro.sectorBearish || [];
    const _macroSectorBullish = macro.sectorBullish || [];

    const agentMacroForScoring = (state._agentMacro || {}).signal || "neutral";
    const _regimeClass = state._regimeClass || "A";
    const agentAlignsBear = ["bearish","strongly bearish","mild bearish"].includes(agentMacroForScoring) && ["B","C"].includes(_regimeClass);
    const agentAlignsBull = ["bullish","strongly bullish","mild bullish"].includes(agentMacroForScoring) && _regimeClass === "A";
    const putsOnBouncesFade = (state._agentMacro || {}).entryBias === "puts_on_bounces" && agentMacroForScoring === "mild bullish" && ["B","C"].includes(_regimeClass);
    const alignedModifier = agentAlignsBear || agentAlignsBull ? Math.abs(macro.scoreModifier || 0) : 0;
    let macroCallMod = agentAlignsBear ? alignedModifier : agentAlignsBull ? Math.round(alignedModifier * 0.5) : 0;
    let macroPutMod  = agentAlignsBear ? alignedModifier : 0;

    if (!agentAlignsBear) {
      const _agentTriggers = (state._agentMacro || {}).triggers || [];
      const _hasRealTrigger = _agentTriggers.length > 0;
      if (agentMacroForScoring === "strongly bearish") { macroCallMod -= 10; }
      else if (agentMacroForScoring === "bearish" && _hasRealTrigger) { macroCallMod -= 8; }
    }

    if (_macroSectorBearish.includes(stock.sector)) { macroCallMod -= 10; macroPutMod += 10; }
    if (_macroSectorBullish.includes(stock.sector)) { macroCallMod += 8;  macroPutMod -= 8; }

    callSetup.score = Math.min(100, Math.max(0, callSetup.score + macroCallMod));
    putSetup.score  = Math.min(100, Math.max(0, putSetup.score  + macroPutMod));

    const _liveIVR = parseFloat(liveStock.ivr || state._ivRank || 0);
    if (_liveIVR > 50 && callSetup.score > 0) {
      const _ivrPenalty = _liveIVR > 65 ? 15 : 10;
      callSetup.score = Math.max(0, callSetup.score - _ivrPenalty);
      callSetup.reasons.push(`High IV penalty: IVR ${_liveIVR.toFixed(0)} > 50 (-${_ivrPenalty})`);
    }

    if (liveStock._gapDayCallBlocked) {
      callSetup.reasons.push('[SHADOW-BLOCK:gap-vwap]');   // shadow-mode: record would-block (gate stays OFF in paper for data-gathering; enforced in live)
      if (!paperDataActive(state)) { callSetup.score = 0; callSetup.reasons.push('Gap-day VWAP block'); }
    }

    const _gateARecord = (state._dailyThesisComplete || {})[stock.ticker];
    if (_gateARecord && _gateARecord.optionType === 'call' && callSetup.score > 0) {
      const _gateARSIFloor  = (_gateARecord.entryRSI || 50) - 15;
      const _gateARSICurrent = liveStock.rsi || signals.rsi || 50;
      if (_gateARSICurrent > _gateARSIFloor) {
        callSetup.score = 0;
        logEvent("filter", `[GATE-A] ${stock.ticker} call blocked — thesis extracted today at RSI ${(_gateARecord.entryRSI||50).toFixed(0)}`);
      }
    }

    if (_gateCActive && callSetup.score > 0) {
      const _gateCRSI = liveStock.dailyRsi || liveStock.rsi || signals.rsi || 50;
      if (_gateCRSI >= GATE_C_RSI_FLOOR) {
        callSetup.reasons.push('[SHADOW-BLOCK:gate-c]');   // shadow-mode: record would-block
        if (!paperDataActive(state)) {
          callSetup.score = 0;
          logEvent("filter", `[GATE-C] ${stock.ticker} call blocked — PM gap-up day, RSI ${_gateCRSI.toFixed(0)}`);
        }
      }
    }

    if (state._gapReversalDay && callSetup.score > 0) {
      const _grRSI       = liveStock.rsi || signals.rsi || 50;
      const _grVWAP      = signals.intradayVWAP || 0;
      const _grAboveVWAP = _grVWAP > 0 && price > _grVWAP;
      const _grRSITooHigh = _grRSI >= 35;
      if (_grRSITooHigh || _grAboveVWAP) {
        callSetup.reasons.push('[SHADOW-BLOCK:gap-reversal]');   // shadow-mode: record would-block
        if (!paperDataActive(state)) {
          callSetup.score = 0;
          logEvent("filter", `[GAP-REVERSAL] ${stock.ticker} call blocked`);
        }
      }
    }

    if (liveStock._gapPutBoost > 0) {
      putSetup.score += liveStock._gapPutBoost;
      putSetup.reasons.push(`Gap-up put fade boost (+${liveStock._gapPutBoost})`);
    }
    if (liveStock._gapCallBoost > 0 && callSetup.score > 0) {
      const _breadthNow = parseFloat(marketContext?.breadth?.breadthPct ?? state._breadth ?? 50) || 50;
      const _broadWeakness = _breadthNow < 30;
      if (!_broadWeakness) {
        callSetup.score += liveStock._gapCallBoost;
        callSetup.reasons.push(`Gap-down call boost (+${liveStock._gapCallBoost})`);
      }
    }
    if (liveStock._gapCallStrictRSI && callSetup.score > 0) {
      const _strictRSI = liveStock.dailyRsi || liveStock.rsi || signals.rsi || 50;
      if (_strictRSI >= 37) {
        callSetup.reasons.push('[SHADOW-BLOCK:strict-rsi]');   // shadow-mode: record would-block
        if (!paperDataActive(state)) { callSetup.score = 0; logEvent("filter", `[GAP-STRICT-RSI] ${stock.ticker} call blocked — RSI ${_strictRSI.toFixed(0)}`); }
      }
    }

    const _liveRSIForMom  = liveStock.rsi || signals.rsi || 50;
    const _liveMomentum   = liveStock.momentum || signals.momentum || 'steady';
    if (callSetup.score > 0) {
      if (_liveMomentum === 'recovering' && _liveRSIForMom < 45) { callSetup.score += 5; callSetup.reasons.push('MOM:recovering confirmation (+5)'); }
      else if (_liveMomentum === 'bearish' && _liveRSIForMom >= 25 && _liveRSIForMom <= 38) { callSetup.score -= 10; callSetup.reasons.push('MOM:bearish in RSI 25-38 zone (-10)'); }
    }
    if (putSetup.score > 0 && _liveMomentum === 'recovering' && _liveRSIForMom > 55) {
      putSetup.score += 5; putSetup.reasons.push('MOM:recovering from overbought (+5)');
    }

    if (stock._premarketBoost && callSetup.score > 0) {
      const _pmGap = parseFloat(preMarket?.gapPct || 0);
      if (_pmGap > 0 && _pmGap < 2.0) { callSetup.score = Math.max(0, callSetup.score - 5); }
    }
    if (stock._premarketBoost && putSetup.score > 0) {
      const _pmGap = parseFloat(preMarket?.gapPct || 0);
      if (_pmGap > 0 && _pmGap < 2.0) { putSetup.score += 5; }
    }

    let callScore = callSetup.score;
    let putScore  = putSetup.score;

    const inBearRegimeForGap = rb.isBearRegime;
    const agentWantsPutsOnBounce = (state._agentMacro || {}).entryBias === "puts_on_bounces";
    if (marketGapDirection === "down" && !inBearRegimeForGap) { callScore = 0; recordGateBlock(stock.ticker, "gap_direction_down", authRegimeName, callScore); }
    const _gapExemptMRPut = putSetup._isOverboughtMRPut;
    if (marketGapDirection === "up" && !inBearRegimeForGap && !agentWantsPutsOnBounce && !_gapExemptMRPut) {
      putScore = 0; recordGateBlock(stock.ticker, "gap_direction_up", authRegimeName, putScore);
    }
    if (!callsAllowed) { callScore = 0; recordGateBlock(stock.ticker, "calls_not_allowed", authRegimeName, callScore); }
    if (!putsAllowed) { putScore = 0; recordGateBlock(stock.ticker, "puts_not_allowed", authRegimeName, putScore); }

    if (!state._lastScanScores) state._lastScanScores = {};
    state._lastScanScores[stock.ticker] = { call: callScore, put: putScore, best: Math.max(callScore, putScore), direction: putScore >= callScore ? "put" : "call", rsi: signals.rsi, macd: signals.macd, momentum: signals.momentum, price, vwap: signals.intradayVWAP || 0, updatedAt: Date.now() };

    if (!state._scoreDebug) state._scoreDebug = {};
    const _creditScore   = null;
    const _creditType    = null;
    const _debitCallScore = (!isBearTrend) ? callSetup.score : null;
    const _debitCallActive = (!isBearTrend && _debitCallScore !== null);
    const _effectiveMin  = _creditType ? MIN_SCORE_CREDIT : (_debitCallActive ? 75 : MIN_SCORE);
    const _rrEst = (state._lastCreditRR && state._lastCreditRR[stock.ticker]) ? state._lastCreditRR[stock.ticker] : null;

    state._scoreDebug[stock.ticker] = {
      ts: Date.now(), price, putScore, callScore,
      creditScore: _creditScore, creditType: _creditType,
      debitCallScore: _debitCallScore, debitCallActive: _debitCallActive,
      effectiveMin: _effectiveMin, rrEstimate: _rrEst,
      putReasons: putSetup.reasons, callReasons: callSetup.reasons,
      signals: { rsi: signals.rsi, dailyRsi: signals.dailyRsi, macd: signals.macd, momentum: signals.momentum, adx: signals.adx, ivPercentile: signals.ivPercentile, volPaceRatio: signals.volPaceRatio, intradayVWAP: signals.intradayVWAP },
      blocked: [],
    };

    if (effectiveDefensive && !callSetup._mrStrong) callScore = 0;   // D4: only strict/deep MR survives defensive

    const bestScore = Math.max(callScore, putScore);
    const optionType = putScore > callScore ? "put" : "call";
    // V3.2 (6/19) Consolidated SCAN VERDICT — one bottom-line per ticker per scan, so a no-entry
    // stretch is diagnosable same-day instead of reconstructed from ~40 scattered gate logs. Reads
    // only the scoring-layer result already computed; the FINAL floor + MACD-contradiction lift live
    // in entryEngine, so this reports the scanner-floor disposition + isMR (entryEngine floor is lower
    // when isMR=Y) and flags the handoff. Headline = the chosen path's likely blocker. Rides the
    // existing "filter" channel so it surfaces wherever filter logs do.
    {
      const _vReasons = (optionType === "put" ? putSetup.reasons : callSetup.reasons) || [];
      const _vFloor   = _effectiveMin;
      const _clears   = bestScore >= _vFloor;
      const _killer   = _vReasons.find(r => /\(-|too low|not oversold|wrong|bearish|no bounce|skip|block|\+0\)/i.test(r)) || _vReasons[_vReasons.length - 1] || "no reasons";
      logEvent("filter",
        `[VERDICT] ${stock.ticker} ${optionType.toUpperCase()} ${bestScore} vs scanner-floor ${_vFloor} → ${_clears ? "CLEARS→entryEngine" : "BELOW"}` +
        ` | isMR:${callSetup.isMeanReversion ? "Y" : "N"} curl:${liveStock.macdCurl || "none"} dRSI:${(liveStock.dailyRsi || 0).toFixed(0)} c/p:${callScore}/${putScore}` +
        (_clears ? "" : ` | headline: ${_killer}`));

      // Compact score telemetry (V3.2 6/23) — projects the just-computed verdict into one
      // material-change/heartbeat CSV row. try/catch: instrumentation must never halt a scan.
      try {
        const _vwapPx = signals.intradayVWAP || 0;
        recordTelemetry(state, {
          tkr: stock.ticker, px: price,
          iRSI: signals.rsi, dRSI: signals.dailyRsi,
          call: callScore, put: putScore,
          isMR: callSetup.isMeanReversion === true,
          curl: liveStock.macdCurl || "none",
          vwapPct: _vwapPx ? ((price - _vwapPx) / _vwapPx) * 100 : null,
          blocker: _clears ? "" : _killer,
          callReasons: callSetup.reasons, putReasons: putSetup.reasons,
          direction: optionType,
        });
      } catch (_telErr) { /* telemetry must never break the scan */ }
    }

    if (effectiveDefensive && optionType === "call" && !callSetup._mrStrong) {
      logEvent("filter", `${stock.ticker} - macro defensive mode - skipping non-MR calls`);
      continue;
    }
    if (effectiveDefensive && optionType === "call" && callSetup._mrStrong) {
      logEvent("filter", `${stock.ticker} - MR call proceeds despite defensive mode`);
    }
    const bestReasons = optionType === "put" ? putSetup.reasons : callSetup.reasons;

    if (preMarket && Math.abs(preMarket.gapPct) > 3) {
      if ((optionType === "put" && preMarket.gapPct > 3) || (optionType === "call" && preMarket.gapPct < -3)) {
        const chosenSetup = optionType === "put" ? putSetup : callSetup;
        chosenSetup.score = Math.max(0, chosenSetup.score - 8);
        chosenSetup.reasons.push(`Pre-market gap penalty (-8)`);
      }
    }

    const agentConf     = (state._agentMacro || {}).confidence || "low";
    const agentSig      = (state._agentMacro || {}).signal || "neutral";
    const agentLastRun  = (state._agentMacro || {}).timestamp || null;
    const agentStale    = !agentLastRun || ((Date.now() - new Date(agentLastRun).getTime()) / 60000) > 30;

    const ivrNow          = ivRankNow;
    const ivrDebitFloor   = 15;
    const ivrDebitCaution = 25;
    const ivrBypass       = rb.ivElevated || rb.isBearRegime || rb.isCrisis;

    const effectiveMinScore = MIN_SCORE;

    if (agentStale && !dryRunMode) {
      const agentStaleMins = agentLastRun ? ((Date.now() - new Date(agentLastRun).getTime()) / 60000) : 999;
      if (agentStaleMins > 90 && isMarketHours()) {
        if (!state._lastAgentStaleWarn || Date.now() - state._lastAgentStaleWarn > 15 * 60 * 1000) {
          logEvent("warn", `[AGENT] Macro analysis stale ${agentStaleMins.toFixed(0)}min`);
          state._lastAgentStaleWarn = Date.now();
        }
      }
    }

    if (state._macroDefensiveCooldown && state._macroDefensiveCooldown[stock.ticker]) {
      const cooldownMins = (Date.now() - state._macroDefensiveCooldown[stock.ticker]) / 60000;
      if (cooldownMins < 30) { logEvent("filter", `${stock.ticker} defensive cooldown ${cooldownMins.toFixed(0)}/30min`); continue; }
    }
    const sameTickerSameDir = state.positions.filter(p => p.ticker === stock.ticker && p.optionType === optionType);
    if (sameTickerSameDir.length >= 1) { logEvent("filter", `${stock.ticker} already have ${sameTickerSameDir.length} position(s)`); continue; }

    const macdSignal    = liveStock.macd || "neutral";
    const macdBullish   = macdSignal.includes("bullish");
    const macdBearish   = macdSignal.includes("bearish");
    const isMRCall      = callSetup.isMeanReversion && optionType === "call";
    const dailyRsiNow   = liveStock.dailyRsi || liveStock.rsi || 50;
    const macdContradicts = rb.gates.macdContradictsGate && !creditModeActive &&
      ((optionType === "put" && macdBullish && dailyRsiNow < 65) || (optionType === "call" && macdBearish && !isMRCall));

    const isMREntry = (callSetup.isMeanReversion || putSetup.isMeanReversion);
    const mrWindowOpen = etHourNow < 15.5;
    if (entryWindowClosed && !dryRunMode) {
      if (!isMREntry) { logEvent("filter", `${stock.ticker} entry window closed`); continue; }
      else if (!mrWindowOpen) { logEvent("filter", `${stock.ticker} MR entry window closed`); continue; }
    }

    if (optionType === "put" && rb.isBullRegime && !isMREntry && !dryRunMode) {
      const putVWAP  = liveStock.intradayVWAP || signals.intradayVWAP || 0;
      const putPrice = liveStock.price || price;
      if (putVWAP > 0 && putPrice > 0) {
        const aboveVWAP = putPrice > putVWAP;
        const pctAbove  = ((putPrice - putVWAP) / putVWAP) * 100;
        if (aboveVWAP && pctAbove > 1.5 && liveStock.momentum === "recovering" && !putSetup._isOverboughtMRPut) {
          logEvent("filter", `${stock.ticker} VWAP timing: ${pctAbove.toFixed(1)}% above VWAP — wait`);
          continue;
        }
      }
    }

    if (optionType === "put" && state._portfolioDeltaCapped && optionType === "put") {
      const effectiveScore = Math.max(putSetup.score, callSetup.score);
      if (effectiveScore < 85) { logEvent("filter", `${stock.ticker} portfolio delta capped`); continue; }
    }

    const MAX_DIR_HEAT = effectiveHeatCap();
    const isGLDHedge = stock.ticker === "GLD" && optionType === "call";
    const dirCost = state.positions.filter(p => { if (p.ticker === "GLD") return false; return p.optionType === optionType; }).reduce((s,p) => s + p.cost, 0);
    const dirHeat = dirCost / totalCap();
    if (!isGLDHedge && dirHeat >= MAX_DIR_HEAT && !dryRunMode) {
      logEvent("filter", `${stock.ticker} ${optionType} directional heat ${(dirHeat*100).toFixed(0)}% at cap`);
      continue;
    }

    const sameTickerOpposite = state.positions.find(p => p.ticker === stock.ticker && p.optionType !== optionType);
    if (sameTickerOpposite) { logEvent("filter", `${stock.ticker} same ticker opposite direction blocked`); continue; }

    // C1-B: per-instrument loss count check
    const _instrLossCount = (state._instrumentLossCount || {})[stock.ticker] || 0;
    const _c1bMinScore = _instrLossCount >= 2 ? 90 : MIN_SCORE;
    if (_instrLossCount >= 2 && bestScore < 90 && !dryRunMode) {
      logEvent("filter", `[C1-B] ${stock.ticker} ${_instrLossCount} losses today — require score 90 (have ${bestScore})`);
      continue;
    }

    const recentLoss = (state._recentLosses || {})[stock.ticker];
    if (optionType === "call" && (stock.dailyRsi || 50) > 80) {
      logEvent("filter", `${stock.ticker} call blocked — dailyRSI overbought daily (>80)`);
      continue;
    }

    const recentClose = (state._recentCloses || {})[stock.ticker];
    const recentCloseSameDir = recentClose && (!recentClose.optionType || recentClose.optionType === optionType);
    if (recentCloseSameDir) {
      const minsSinceClose = (Date.now() - recentClose.closedAt) / 60000;
      const _closePnl = parseFloat(recentClose.pnl) || 0;
      const CLOSE_COOLDOWN_MINS = _closePnl > 0 ? 5 : 10;   // 6/29: shortened win 10→5, loss 20→10 (Harrison, data-gather)
      if (minsSinceClose < CLOSE_COOLDOWN_MINS) {
        const wasWin = _closePnl > 0 ? `win (+$${_closePnl.toFixed(0)})` : _closePnl < 0 ? `loss (-$${Math.abs(_closePnl).toFixed(0)})` : 'cooldown';
        logEvent("filter", `${stock.ticker} re-entry cooldown — ${wasWin} closed ${minsSinceClose.toFixed(0)}min ago`);
        continue;
      }
    }

    // 6/30 (Harrison): the post-loss lockout should punish a BLOWN THESIS, not a managed exit.
    // A hard stop (thesis wrong, adverse move) keeps the 4h/score-75 penalty. A protective tier
    // exit that minimized the loss (trail-floor giving back to ~breakeven, time/give-back/dte
    // tighten) is not a thesis failure and should NOT bench the instrument for hours. Gated on the
    // stored exit reason. Default-deny (unknown reason → treat as stop) keeps it conservative.
    const _STOP_REASONS = new Set(["stop","fast-stop","tiered-stop","thesis-collapsed","thesis-no-follow","50ma-break"]);
    const _wasHardStop = !recentLoss || !recentLoss.reason || _STOP_REASONS.has(recentLoss.reason);
    const recentLossSameDir = recentLoss && (!recentLoss.optionType || recentLoss.optionType === optionType);
    // 6/30 (Harrison): window shortened 4h→2h. The score-75 floor is the real filter — a stopped
    // name re-entering must print a high-conviction setup regardless of clock — so the duration is
    // backup, not the gate. 2h lets a name re-base after a stop without benching it most of a session.
    if (recentLossSameDir && _wasHardStop && (Date.now() - recentLoss.closedAt) < 2 * 3600 * 1000) {
      const hoursSinceLoss = ((Date.now() - recentLoss.closedAt) / 3600000).toFixed(1);
      const lossRSI    = recentLoss.exitRSI || recentLoss.entryRSI || 50;
      const currentRSI = liveStock.rsi || signals.rsi || 50;
      const rsidelta   = Math.abs(currentRSI - lossRSI);
      const instrMin75 = Math.max(75, stock.minScore || 65);
      if (bestScore < instrMin75) { logEvent("filter", `${stock.ticker} re-entry blocked — loss ${hoursSinceLoss}h ago, need score ${instrMin75}`); continue; }
      if (rsidelta < 10) { logEvent("filter", `${stock.ticker} re-entry blocked — RSI only moved ${rsidelta.toFixed(0)}pts`); continue; }
      const _rsiDirectionOk = optionType === "call" ? currentRSI <= lossRSI : currentRSI >= lossRSI;
      if (!_rsiDirectionOk) { logEvent("filter", `${stock.ticker} re-entry blocked — RSI wrong direction`); continue; }
      logEvent("filter", `${stock.ticker} re-entry allowed — loss ${hoursSinceLoss}h ago, score ${bestScore}, RSI moved ${rsidelta.toFixed(0)}pts`);
    }

    const prevRSI = bars.length >= 2 ? calcRSI(bars.slice(0, -1)) : signals.rsi;
    const rsiMove = Math.abs(signals.rsi - prevRSI);
    const instrAllowedTypes = (INSTRUMENT_CONSTRAINTS[stock.ticker] || {}).allowedTypes || [];
    const isCreditOnlyInstr = instrAllowedTypes.length > 0 && instrAllowedTypes.every(t => t.startsWith("credit"));
    const dailyRsiValid = (stock.dailyRsi || 50) >= 40 && (stock.dailyRsi || 50) <= 60;
    const fastRSIMove = rsiMove >= 15 && !creditModeActive && !isCreditOnlyInstr && !dailyRsiValid;
    if (fastRSIMove) {
      const putsOnBouncesBias2 = (state._agentMacro || {}).entryBias === "puts_on_bounces";
      const rsiIsFalling      = signals.rsi < prevRSI;
      const regimeBException  = putsOnBouncesBias2 && rsiIsFalling && optionType === "put";
      const fastRSIMin = regimeBException ? 75 : 85;
      if (bestScore < fastRSIMin) { logEvent("filter", `${stock.ticker} fast RSI move ${rsiMove.toFixed(0)}pts - need ${fastRSIMin}, have ${bestScore}`); continue; }
    }

    logEvent("filter", `${stock.ticker} best setup: ${optionType.toUpperCase()} score ${bestScore} | RSI:${signals.rsi} MACD:${signals.macd} MOM:${signals.momentum}`);
    if (entryBlocked) {
      // INSTRUMENTATION (6/16): near-miss attribution. Emit the winning side's full score trail so
      // post-core modifier reductions (e.g. pre-corr 84 -> final 72) and gate-zeroing are visible and
      // countable per scan, instead of only logging pre-corr and final. grep [NEAR-MISS] to tally.
      try {
        const _nmTrail = bestReasons || [];
        logEvent("filter", `[NEAR-MISS] ${stock.ticker} ${optionType.toUpperCase()} final:${bestScore} | trail: ${_nmTrail.join(" \u00b7 ") || "none"}`);
      } catch (_nmErr) { /* instrumentation must never halt the scan */ }
      continue;
    }
    const isMR = optionType === "call" && callSetup.isMeanReversion;
    liveStock._isMeanReversion = isMR;
    liveStock._mrStrong = (optionType === "call" && callSetup._mrStrong === true);   // strict tier → contract/size (two-tier)

    const eeCandidate = EE_scoreCandidate(
      { ...liveStock, isMeanReversion: isMR },
      putSetup.score, callSetup.score,
      putSetup.reasons, callSetup.reasons,
      { rsi: signals.rsi, dailyRsi: signals.dailyRsi, macd: signals.macd, spyRecovering: !!(spyRecovering) },
      rb, state
    );
    if (eeCandidate.sizeMod < 1.0) {
      logEvent("filter", `${stock.ticker} size modifier ${eeCandidate.sizeMod.toFixed(2)}x`);
    }
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
      heatMultiplier:  eeCandidate.heatMultiplier || 1.0,
    });
  }

  scored.sort((a,b) => b.score - a.score);

  if (scored.length > 0) {
    logEvent("filter", `Score ranking: ${scored.length} candidate(s) above minimum`);
  }

  const skipPrefetch = _heatPct >= effectiveHeatCap();
  if (skipPrefetch && !dryRunMode) logEvent("filter", `Heat ${_heatPctPc}% at cap - skipping options prefetch`);
  if (scored.length > 0 && !skipPrefetch) {
    logEvent("scan", `Prefetching options chains for ${scored.length} candidates...`);
    const optPrefetchStart = Date.now();
    const BATCH_SIZE = 5;
    for (let i = 0; i < scored.length; i += BATCH_SIZE) {
      const batch = scored.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async ({ stock, price, optionType, score }) => {
        try {
          const isMR = optionType === "call" && (stock._mrStrong || false);   // D3: aggressive 0.42Δ/14DTE profile only on STRICT tier
          const contract = await findContract(stock.ticker, optionType, isMR ? 0.42 : 0.35, isMR ? 14 : 38, state.vix, stock);
          if (contract) {
            stock._cachedContract = contract;
            if (contract.iv && contract.iv > 0) stock._realIV = contract.iv;
          }
        } catch(e) {}
      }));
    }
    logEvent("scan", `Options prefetch complete in ${((Date.now()-optPrefetchStart)/1000).toFixed(1)}s`);
  }

  for (const { stock, price, score, reasons, optionType, isMeanReversion, tradeIntent, constraintPass, constraintReason, sizeMod } of scored) {
    if (heatPct() >= effectiveHeatCap()) break;
    if (state.cash <= CAPITAL_FLOOR) break;

    const { pass, reason } = await checkAllFilters(stock, price, null);
    if (!pass) {
      const putBypassReasons = ["sector ETF", "support", "VWAP", "breakdown"];
      const canBypassForPut  = optionType === "put" && putBypassReasons.some(r => reason?.includes(r));
      if (!canBypassForPut) { logEvent("filter", `${stock.ticker} - ${reason}`); continue; }
      logEvent("filter", `${stock.ticker} - bypassing filter for PUT: ${reason}`);
    }

    const intent     = tradeIntent || {};
    const intentType = intent.type || optionType;

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
    const existingCreditProfitPct = sameTickerSameDirPos.length > 0
      ? Math.max(...sameTickerSameDirPos.map(p => {
          if (!p.isCreditSpread) return 0;
          const earned = (p.premium || 0) - (p.currentPrice || p.premium || 0);
          const maxP   = p.maxProfit || p.premium || 0;
          return maxP > 0 ? Math.min(1, Math.max(-1, earned / maxP)) : 0;
        }))
      : 0;
    const ddProtocol = marketContext.drawdownProtocol || { minScore: MIN_SCORE };
    const _volDeclineExec = false;

    const eeResult = evaluateEntry(
      { ticker: stock.ticker, optionType, tradeType: intentType, score, constraintPass: constraintPass !== false, constraintReason: constraintReason || null, tradeIntent: intent,
        isMeanReversion: isMeanReversion === true, isIndex: stock.isIndex === true },  // V3.2 (6/19) FIX: evaluateEntry carve-outs depend on these — were absent, forcing oversold MR calls to the 85 floor
      rb, state,
      { etHour: etHourNow, isLateDay, isLastHour, volDecline: _volDeclineExec,
        signals: { rsi: stock.rsi, dailyRsi: stock.dailyRsi || 50, macd: stock.macd || "neutral", macdCurl: stock.macdCurl || "none" },  // FIX (6/23, scope-corrected): plumb intraday rsi from the scored candidate. `stock` here is liveStock (see scored.push ~2093), and liveStock.rsi IS the intraday RSI. The prior version referenced `signals`, which lives in the SCORING loop (closes ~2104), not this execution loop — so it threw "signals is not defined" and crashed every scan at the evaluateEntry call.
        gapState: stock._gapState || "flat", gapVwapRatio: stock._gapVwapRatio ?? 1, breadthMom: state._breadthMomentum ?? 0,  // #3 D2 carve-out inputs (present-tense tape)
        recentSameDir: recentSameDirMins, existingProfitPct, existingCreditProfitPct,
        drawdownMinScore: ddProtocol.minScore || MIN_SCORE, drawdownLevel: ddProtocol.level || "normal",
        agentSignal: (state._agentMacro || {}).signal || "neutral",
        experimentMode: paperDataActive(state), experimentMinScore: EXPERIMENT_CALL_FLOOR, experimentMinScorePut: EXPERIMENT_PUT_FLOOR }
    );
    if (eeResult.pass && eeResult.minScoreTrace && eeResult.minScoreTrace.experiment) {
      const _expSideTag = optionType === "put" ? "PUT under-85-wall" : "CALL";
      logEvent("filter", `[EXPERIMENT-ENTRY ${_expSideTag}] ${stock.ticker} ${optionType.toUpperCase()} score ${score} @ exp-floor ${eeResult.minScore} (gap-bypass ${paperDataActive(state) ? "ON" : "OFF"}) — TAGGED for P&L isolation`);
    }
    if (!eeResult.pass) {
      logEvent("filter", `${stock.ticker} entry blocked - ${eeResult.reason}`);
      // INSTRUMENTATION (6/16): the real score-below-min / gate rejections short-circuit HERE at the
      // eeResult gate. This is the EXECUTION loop (line ~2065), a separate loop from the scoring loop
      // where bestReasons lives — so use `reasons`, which is destructured from the scored candidate at
      // the top of this loop (it carries eeCandidate.reasons, the winning-side trail). grep [NEAR-MISS].
      try {
        const _nmTrail = reasons || [];
        const _tr = eeResult.minScoreTrace;
        const _trStr = _tr
          ? ` | floor:${_tr.base}${_tr.afternoonLift ? `→aft${_tr.afternoonLift}` : ""}${_tr.macdLift85 ? "→macd85" : ""}${_tr.ddLift ? `→dd${_tr.ddLift}` : ""}=${_tr.final} carveOut:${_tr.carveOut ? "Y" : "N"} isMR:${_tr.isMR ? "Y" : "N"} isIdx:${_tr.isIndex ? "Y" : "N"}`
          : "";
        logEvent("filter", `[NEAR-MISS] ${stock.ticker} ${optionType.toUpperCase()} final:${score} | ${eeResult.reason} | trail: ${_nmTrail.join(" \u00b7 ") || "none"}${_trStr}`);
      } catch (_nmErr) { /* instrumentation must never halt the scan */ }
      if (!dryRunMode) recordGateBlock(stock.ticker, eeResult.reason, rb.regimeName, score);
      continue;
    }

    if (_circuitEntryHalt) { logEvent("filter", `${stock.ticker} entry blocked — circuit halt`); continue; }
    if (_vixFullHalt) { logEvent("filter", `${stock.ticker} entry blocked — VIX ${state.vix?.toFixed(1)} >= ${VIX_PAUSE}`); continue; }
    if (_vixCallGate && optionType === "call") { logEvent("filter", `${stock.ticker} call blocked — VIX >= 28 + bearish macro`); continue; }
    if (isLastHour) { logEvent("filter", `[EOD-BLOCK] ${stock.ticker} entry blocked — past 3:00 PM ET cutoff`); continue; }

    if (state._hardBlock) { logEvent("filter", `[STAGGER] ${stock.ticker} entry blocked — hard block`); continue; }
    if (state._softBlock) {
      const _earlyBypassScore = 85;
      // C1-D: stagger bypass disabled on HIGH RISK days
      if (_c1dHighRiskDay) {
        logEvent("filter", `[C1-D] ${stock.ticker} stagger bypass DISABLED — HIGH RISK day plan`);
        continue;
      }
      if (score >= _earlyBypassScore) {
        logEvent("filter", `[STAGGER-BYPASS] ${stock.ticker} score ${score} >= ${_earlyBypassScore} — early entry allowed`);
      } else {
        logEvent("filter", `[STAGGER] ${stock.ticker} entry blocked — soft block (score ${score} < ${_earlyBypassScore})`);
        continue;
      }
    }
    if (state._staggerCooling) { logEvent("filter", `${stock.ticker} entry blocked — stagger cooldown`); continue; }

    if (state._callCapActive && optionType === "call") { logEvent("filter", `${stock.ticker} call blocked — call cap`); continue; }
    if (openCalls === 1 && optionType === "call") {
      const SLOT2_MIN_SCORE = 75;
      if (score < SLOT2_MIN_SCORE) { logEvent("filter", `${stock.ticker} call blocked — slot 2 requires score >= ${SLOT2_MIN_SCORE}`); continue; }
    }
    if (state._slot3Active && optionType === "call") {
      const _ticker3 = stock.ticker;
      const _group3  = (CORR_GROUPS || {})[_ticker3] || 'other';
      const _occupied3 = state._occupiedCorrGroups || [];
      if (score < SLOT3_MIN_SCORE) { logEvent("filter", `${_ticker3} call blocked — slot 3 requires score >= ${SLOT3_MIN_SCORE}`); continue; }
      if (_occupied3.includes(_group3)) { logEvent("filter", `${_ticker3} call blocked — slot 3 group ${_group3} occupied`); continue; }
    }

    // C1-A: daily loss lock gates entries (catches here in case c1AnyLock was bypassed above in dryRun)
    if (state._dailyLossLockActive && !dryRunMode && !paperDataActive(state)) {
      const _effectiveMin = _computeEffectiveMinScore(MIN_SCORE);
      if (score < _effectiveMin) {
        logEvent("filter", `[C1-A] ${stock.ticker} blocked — daily loss lock active, need score ${_effectiveMin} (have ${score})`);
        continue;
      }
      logEvent("filter", `[C1-A] ${stock.ticker} entry PERMITTED — score ${score} >= ${_effectiveMin} despite daily loss lock`);
    }

    logEvent("filter", `${stock.ticker} entry approved — intent:${intentType} score:${score} regime:${rb.regimeName}`);

    const _contractDelta = parseFloat(stock._cachedContract?.delta || 0.35);
    const MIN_ENTRY_DELTA = 0.28;
    if (_contractDelta > 0 && _contractDelta < MIN_ENTRY_DELTA) {
      logEvent("filter", `${stock.ticker} entry blocked — delta ${_contractDelta.toFixed(3)} below minimum`);
      continue;
    }

    let entered = false;
    state._lastEntryType = isMeanReversion ? `mr_${optionType}` : `naked_${optionType}`;

    const _entryRSI_now = stock.rsi || stock.liveRSI || 50;
    const _callRSIOk = _entryRSI_now < VIX_HIGH_CALL_RSI;

    if (optionType === "call" && _vixCallsBlocked) {
      logEvent("filter", `${stock.ticker} call BLOCKED — VIX ${_vixNow.toFixed(1)} >= ${VIX_CALLS_BLOCKED}`);
      continue;
    } else if (optionType === "call" && _vixCreditMode && !_callRSIOk) {
      logEvent("filter", `${stock.ticker} call BLOCKED — VIX ${_vixNow.toFixed(1)} >= ${VIX_CREDIT_PRIMARY}, RSI ${_entryRSI_now.toFixed(0)} >= ${VIX_HIGH_CALL_RSI}`);
      continue;
    } else {
      if (optionType === "call" && _vixCreditMode && _callRSIOk) {
        logEvent("filter", `${stock.ticker} call PERMITTED — VIX high but RSI ${_entryRSI_now.toFixed(0)} deeply oversold`);
      }
      logEvent("filter", `${stock.ticker} execution: naked_${optionType} (MR:${isMeanReversion}) delta:${_contractDelta.toFixed(3)}`);
      const _sizeModNaked = sizeMod || 1.0;
      entered = await executeTrade(stock, price, score, reasons, state.vix, optionType, isMeanReversion, _sizeModNaked);
    }

    if (entered) {
      state._lastEntryAt = Date.now();
      markDirty();
      await new Promise(r=>setTimeout(r,500));
    }
  }

  } // end else (no pending order)

  const scanNow = Date.now();
  const lastScanMs = _lastScanTelemetryAt ? scanNow - _lastScanTelemetryAt : 0;
  const isPlausibleInterval = lastScanMs >= 5000 && lastScanMs <= 120000;
  if (lastScanMs > 0 && isPlausibleInterval) {
    if (!state._scanIntervals) state._scanIntervals = [];
    state._scanIntervals.push(lastScanMs);
    if (state._scanIntervals.length > 30) state._scanIntervals = state._scanIntervals.slice(-30);
    const avgInterval = state._scanIntervals.reduce((s,v)=>s+v,0) / state._scanIntervals.length;
    state._avgScanIntervalMs = Math.round(avgInterval);
  } else if (lastScanMs > 120000) {
    logEvent("scan", `[PERF] Scan gap ${(lastScanMs/1000/60).toFixed(1)}min since last scan`);
  }

  _lastScanTelemetryAt = scanNow;
  state.lastScan    = new Date().toISOString();
  state._scanFailures = 0;
  await Promise.race([
    saveStateNow(),
    new Promise(r => setTimeout(r, 3000)),
  ]).catch(() => { markDirty(); });
  } catch(e) {
    logEvent("error", `runScan crashed: ${e.message} | stack: ${e.stack?.split("\n")[1]?.trim() || "unknown"}`);
    state._scanFailures = (state._scanFailures || 0) + 1;
    const n = state._scanFailures;
    const shouldEmail = (n <= 3) || (n % 30 === 0);
    if (shouldEmail && RESEND_API_KEY && GMAIL_USER && isMarketHours()) {
      Promise.race([
        sendResendEmail(
          `APEX ALERT - Scanner crash #${n} (${e.message.slice(0,50)})`,
          `<div style="font-family:monospace;background:#07101f;color:#ff5555;padding:20px"><h2>!! APEX Scanner Error</h2><p>Consecutive scan failures: <strong>${n}</strong></p><p>Last error: ${e.message}</p><p>Time: ${new Date().toISOString()}</p><p>Open positions: ${state.positions.length}</p></div>`
        ),
        new Promise(r => setTimeout(r, 5000)),
      ]).catch(() => {});
    }
  } finally {
    if (!state._scanFailures) state._scanFailures = 0;
    scanRunning = false;
  }
}

module.exports = {
  runScan,
  getScannerState: () => ({
    scanRunning, dryRunMode, marketContext,
    lastScanStart: _lastScanStart,
    circuit: getCircuitState(),
  }),
  forceResetScanLock: () => {
    logEvent('warn', '[WATCHDOG] Force-resetting stuck scanRunning lock');
    scanRunning = false;
    _lastScanStart = 0;
  },
  setDryRunMode: (v) => { dryRunMode = v; if (state) state._dryRunMode = v; },
};
