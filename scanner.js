// scanner.js — ARGO V3.2
// Main scan orchestrator: market data fetching, exit checks, entry scoring, execution.
// runScan() runs every 10 seconds during market hours.
'use strict';

const {
  alpacaGet, alpacaPost, alpacaDelete,
  getStockBars, getIntradayBars, getStockQuote, getCircuitState,
} = require('./broker');

const { state, logEvent, markDirty, saveStateNow, flushStateIfDirty, paperDataActive, dataGatherActive, mrFadeActive, recordStandDown , markFresh, auditFreshness } = require('./state');
const { recordTelemetry } = require('./telemetry');
// 8/12: DEFENSIVE REQUIRE. vol.js is OPTIONAL instrumentation — realized vol, IV-RV, surface,
// feasibility. It gates nothing and executes no trades. A hard top-level require made a missing
// file fatal: server.js -> scanner.js -> vol.js, so one absent module killed the whole process and
// Railway crash-looped it. That is not a degraded mode, it is a DEAD BOT — no stops, no fast-cut,
// no 3:15 flatten, open positions unmanaged. Optional instrumentation must never be able to do
// that. If vol.js is absent the measurement layer goes dark and everything else runs normally.
let VOL = null;
try {
  VOL = require('./vol.js');
} catch (_volReqErr) {
  console.error('[VOL] vol.js not found — vol instrumentation DISABLED, trading and exits unaffected. Add vol.js to the repo root to enable it.');
}

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
  isIYREntryAllowed, isHYGEntryAllowed, computeIntradayScore,
} = require('./scoring');

const {
  getRegimeRulebook, scoreCandidate: EE_scoreCandidate, evaluateEntry,
} = require('./entryEngine');
let GEX = null; try { GEX = require('./gex'); } catch (_gexReqErr) { /* gex module optional */ }
let MRSTRAT = null; try { MRSTRAT = require('./mrStrategy'); } catch (_mrReqErr) { /* mr strategy optional */ }
const { INSTRUMENT_CONSTRAINTS } = require('./entryEngine');

const {
  executeTrade,
  findContract, calcPositionSize, fetchGexChain,
} = require('./execution');

const {
  closePosition, partialClose, closeNContracts, confirmPendingOrder,
  syncCashFromAlpaca,
} = require('./closeEngine');

const {
  runReconciliation, syncPositionPnLFromAlpaca,
} = require('./reconciler');

const {
  getAgentDayPlan, getAgentMacroAnalysis, runAgentRescore, triggerRescore, updateRegimeState } = require('./agent');

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
  WATCHLIST, CAPITAL_FLOOR, MIN_SCORE, MIN_SCORE_CREDIT, MAX_HEAT, DATA_GATHER_MODE,
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
  MR_INTRA_LIFTOFF_PTS = 4,   // D3 (6/24) intraday RSI lift-off pts off session low — shared early-turn threshold (scoring + VWAP gate),
  CALL_MOMENTUM_MIN, CALL_MOMENTUM_ENFORCE, CALL_MOMO_STRICT,
  CALL_MOMO_SLOPE_MIN, CALL_MOMO_VOLPACE_MIN, CALL_MOMO_BREADTH_MIN,
  MOMO_SHADOW_MINS, MOMO_SHADOW_MAX,
  CALL_BREAKOUT_MODE = false,   // 8/05: when true, scoring enforces call momentum → the standalone gate below stands down
  RANGE_GOVERNOR_ENABLED = false, RANGE_GOVERNOR_ENFORCE = false, RANGE_GOVERNOR_FLOOR_PCT = 1.0, RANGE_GOVERNOR_MIN_SESSION_MIN = 60,
  RANGE_GOVERNOR_FULL_SESSION_MIN = 390, RANGE_GOVERNOR_REF_DTE = 40,
  MR_SCALP_TARGET_DTE = 1,
  VOL_INFRA_ENABLED = false, FEASIBILITY_ENABLED = false, FEASIBILITY_ENFORCE = false,
  GREEK_LIMITS_ENABLED = false, GREEK_LIMITS_ENFORCE = false,
  MAX_DELTA_DOLLARS_POS = 15000, MAX_DELTA_DOLLARS_NEG = -15000,
  FEASIBILITY_MAX_RATIO = 1.0, FEASIBILITY_HOLD_MIN = 20, SPREAD_COST_LOG = false,
  MACRO_MAX_AGE_MIN = 240, NEARMISS_LEDGER_ENABLED = false,
  VOLPACE_ARM_ENABLED = false, VOLPACE_ARM_MIN = 0, VOLPACE_ARM_PCTILE = 50, VOLPACE_ARM_WINDOW = 300, VOLPACE_ARM_WARMUP = 20,
  MR_FADE_ENABLED = false,
  BREAK_TRIGGER_ENABLED = false, BREAK_TRIGGER_ENFORCE = false, BREAK_TRIGGER_ALLOW_MRSCALP = true,
  GEX_FETCH_ENABLED = true, GEX_FETCH_THROTTLE_MS = 120000,
  TREND_ENABLED = false, TREND_CUTOFF_ET = 15.0, TREND_MA_FAST = 50, TREND_MA_SLOW = 100,
  TREND_RSI_MIN = 50, TREND_RSI_MAX = 72, TREND_OVEREXT_ATR = 4.0, TREND_BREADTH_MIN = 52,
  ITREND_ENABLED = false, ITREND_ADX_MIN = 25, ITREND_VWAP_MIN = 0.05, ITREND_BREADTH_STRONG = 55,
  ITREND_START_ET = 10.0, ITREND_END_ET = 13.5, ITREND_COOLDOWN_MIN = 30,
  BREAK_ENTRY_SCORE = 80, BREAK_CONFIRM_BARS = 1, BREAK_MAX_AGE_MIN = 10, BREAK_VOL_LOOKBACK = 10,
  BREAK_VOL_MULT_PUT = 1.8, BREAK_VOL_MULT_CALL = 2.2, BREAK_ADX_MIN_PUT = 18, BREAK_ADX_MIN_CALL = 22,
  BREAK_VWAP_SLOPE_MIN = 0.0002, BREAK_MAX_EXT_PCT = 0.006, BREAK_CALL_CUTOFF_ET = 12.0,
  BREAK_MIN_SESSION_MIN = 16,
  MR_SCALP_ENABLED = false, MR_SCALP_SESSLOW_RSI_MAX = 32, MR_SCALP_FLUSH_DD_MIN = 0.007, MR_SCALP_VWAP_EXT_MIN = 0.005,
  MR_SCALP_LIFTOFF_PTS = 4, MR_SCALP_LOW_AGE_MIN_MIN = 3, MR_SCALP_LOW_AGE_MAX_MIN = 25, MR_SCALP_RANGE_MIN_PCT = 0.6,
  MR_SCALP_VIX_MIN = 20, MR_SCALP_SESSION_MIN_MIN = 30, MR_SCALP_CUTOFF_ET = 14.5, MR_SCALP_MIN_SCORE = 78, MR_SCALP_SIZE_MOD = 0.5,
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


// ── 8/11: STRUCTURAL BREAK DETECTOR ─────────────────────────────────────────────────
// Entry mechanics v2. Answers "did something actually happen" instead of "is this a good
// setup". Every term is an OBSERVED event, nothing here forecasts. A break counts only if a
// 1-min bar CLOSED through the opening-range level (not touched it), on expanded break-bar
// volume, with VWAP agreeing, enough trend strength, price not already chased, and the next
// bar did not reclaim the level. Breakdown -> put. Breakout -> call, stricter and morning-only,
// because index up-moves grind while down-moves are fast.
// Fails CLOSED on every bad input: a null/short/foreign-day bar array, a missing or unlocked
// opening range, NaN adx/slope, or a zero price all return {side:null} with a stated reason.
// 8/27: daily trend inputs (50/100d MA + ATR14) for the trend-swing sleeve. Cached per ticker per day.
async function ensureDailyTrend(ticker) {
  try {
    if (!state._dailyMA) state._dailyMA = {};
    const _today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
    const cached = state._dailyMA[ticker];
    if (cached && cached.date === _today) return cached;
    const bars = await getStockBars(ticker, 120);
    if (!bars || bars.length < 50) return cached || null;
    const closes = bars.map(b => b.c);
    const _ma = (n) => { const s = closes.slice(-n); return s.length ? s.reduce((a,c)=>a+c,0)/s.length : null; };
    const ma50 = _ma(50), ma100 = _ma(Math.min(100, closes.length));
    let atr = null;
    if (bars.length >= 15) {
      const tr = [];
      for (let i = bars.length - 14; i < bars.length; i++) tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c)));
      atr = tr.reduce((a,x)=>a+x,0) / tr.length;
    }
    if (!ma50 || !ma100 || !atr) return cached || null;
    const rec = { ma50: +ma50.toFixed(2), ma100: +ma100.toFixed(2), atr: +atr.toFixed(2), date: _today };
    state._dailyMA[ticker] = rec;
    logEvent("scan", `[TREND-MA] ${ticker} 50d:$${rec.ma50} 100d:$${rec.ma100} atr:$${rec.atr}`);
    return rec;
  } catch (e) { logEvent("warn", `[TREND-MA] ${ticker} failed — ${e && e.message}`); return (state._dailyMA || {})[ticker] || null; }
}

function detectStructuralBreak(ctx) {
  const out = { side: null, level: null, ageMin: null, volMult: null, extPct: null, blocked: null, why: null };
  try {
    const { intradayBars, or, vwapSlope, adx, price, etHour, sessionMin, todayStr, nowMs } = ctx || {};
    const _now = nowMs || Date.now();

    if (!or || !or.locked)                      { out.blocked = "OR not locked"; return out; }
    if (!(sessionMin >= BREAK_MIN_SESSION_MIN)) { out.blocked = `session ${Math.round(sessionMin || 0)}m < ${BREAK_MIN_SESSION_MIN}m`; return out; }
    if (!(price > 0))                           { out.blocked = "no price"; return out; }
    if (!(or.low > 0) || !(or.high > 0))        { out.blocked = "OR levels invalid"; return out; }

    const bars = Array.isArray(intradayBars)
      ? intradayBars.filter(b => String(b.t || b.timestamp || "").startsWith(todayStr))
      : [];
    const need = BREAK_VOL_LOOKBACK + BREAK_CONFIRM_BARS + 2;
    if (bars.length < need) { out.blocked = `${bars.length} bars < ${need} needed`; return out; }

    // most recent bar that CLOSED through a level, leaving room for the confirm bar(s) behind it
    const last = bars.length - 1;
    let bi = -1, side = null, level = null;
    for (let i = last - BREAK_CONFIRM_BARS; i >= BREAK_VOL_LOOKBACK; i--) {
      const c = bars[i].c, pc = bars[i - 1].c;
      if (!(c > 0) || !(pc > 0)) continue;
      if (c < or.low  && pc >= or.low)  { bi = i; side = "put";  level = or.low;  break; }
      if (c > or.high && pc <= or.high) { bi = i; side = "call"; level = or.high; break; }
    }
    if (bi < 0) { out.blocked = "no fresh level break"; return out; }

    const bBar = bars[bi];
    const bT = new Date(bBar.t || bBar.timestamp || _now).getTime();
    const ageMin = Number.isFinite(bT) ? (_now - bT) / 60000 : 999;
    if (!(ageMin <= BREAK_MAX_AGE_MIN)) {
      // 8/26: the most-recent cross is the freshest one (loop runs recent->old). If IT is past the age
      // window, there is no FRESH break — report the honest "no fresh level break" state, not the aged
      // break's growing age. On a sustained move one cross would otherwise be re-counted as "stale"
      // every scan for hours, burying the real signal (vol / reclaim) in the stand-down tally.
      out.blocked = "no fresh level break"; out.ageMin = ageMin; return out;
    }

    for (let j = bi + 1; j <= Math.min(last, bi + BREAK_CONFIRM_BARS); j++) {
      const cj = bars[j].c;
      if (!(cj > 0)) continue;
      if (side === "put"  && cj >= level) { out.blocked = "level reclaimed on confirm bar"; return out; }
      if (side === "call" && cj <= level) { out.blocked = "level reclaimed on confirm bar"; return out; }
    }

    // break-bar force. NOTE: signals.volPaceRatio is SESSION-CUMULATIVE and cannot express a
    // single-bar expansion, so this is computed from the bars directly.
    let vs = 0, vn = 0;
    for (let k = bi - BREAK_VOL_LOOKBACK; k < bi; k++) {
      const v = bars[k].v;
      if (v > 0) { vs += v; vn++; }
    }
    const avgV   = vn > 0 ? vs / vn : 0;
    const volMult = avgV > 0 ? (bBar.v || 0) / avgV : 0;
    const needVol = side === "put" ? BREAK_VOL_MULT_PUT : BREAK_VOL_MULT_CALL;
    if (!(volMult >= needVol)) { out.blocked = `break-bar vol ${volMult.toFixed(2)}x < ${needVol}x`; return out; }

    const sl = Number.isFinite(vwapSlope) ? vwapSlope : 0;
    if (side === "put"  && !(sl <= -BREAK_VWAP_SLOPE_MIN)) { out.blocked = `vwap slope ${sl.toFixed(5)} not falling`; return out; }
    if (side === "call" && !(sl >=  BREAK_VWAP_SLOPE_MIN)) { out.blocked = `vwap slope ${sl.toFixed(5)} not rising`; return out; }

    const a = Number.isFinite(adx) ? adx : 0;
    const needAdx = side === "put" ? BREAK_ADX_MIN_PUT : BREAK_ADX_MIN_CALL;
    if (!(a >= needAdx)) { out.blocked = `adx ${a.toFixed(0)} < ${needAdx}`; return out; }

    const extPct = Math.abs(price - level) / level;
    if (!(extPct <= BREAK_MAX_EXT_PCT)) { out.blocked = `extended ${(extPct * 100).toFixed(2)}% past level > ${(BREAK_MAX_EXT_PCT * 100).toFixed(2)}%`; return out; }

    if (side === "call" && !(etHour < BREAK_CALL_CUTOFF_ET)) { out.blocked = `breakout call after ${BREAK_CALL_CUTOFF_ET}h ET`; return out; }

    out.side = side; out.level = level; out.ageMin = ageMin; out.volMult = volMult; out.extPct = extPct;
    out.why = `${side === "put" ? "breakdown" : "breakout"} ${level.toFixed(2)} | ${ageMin.toFixed(0)}m old | vol ${volMult.toFixed(2)}x | adx ${a.toFixed(0)} | ext ${(extPct * 100).toFixed(2)}%`;
    return out;
  } catch (e) {
    out.blocked = `detector error: ${e.message}`;
    return out;
  }
}


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
        markFresh('_creditStress');   // 7/31: scoring input, boolean — freshness tracked alongside
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

  logEvent("scan", `Scan | VIX:${state.vix} | cash:${fmt(state.cash)} | positions:${state.positions.length} | breadth:${marketContext.breadth.breadthPct}% (${marketContext.breadth.advancing ?? '?'}\u2191/${marketContext.breadth.declining ?? '?'}\u2193) | F&G:${marketContext.fearGreed?.score ?? '--'}`);

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
    markFresh('_breadth');           // 7/31: scoring input, number — freshness tracked alongside
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
        if (age > 2 || bPct < 50) state._zweigThrust = { detected: false };  // 7/7 (Harrison): also clear when breadth falls back below 50 — the recovery is invalidated the moment current breadth no longer supports it. Was time-only (2 days), so on weak-breadth sessions scoring kept emitting "recovery stale (+0)" every scan.
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

    // 8/12: NEUTRALISE A GHOST SIGNAL. Previously this labelled the age and used the modifier
    // regardless — a 22-day-old "mild bearish (-5)" was tilting every score on 8/12. Past
    // MACRO_MAX_AGE_MIN the block still reports its true age (so the staleness stays visible in
    // the dashboard) but contributes ZERO: neutral signal, no modifier, normal mode.
    const _macroGhost = agentAuthAge > MACRO_MAX_AGE_MIN;
    if (_macroGhost && !state._macroGhostLogged) {
      state._macroGhostLogged = true;
      logEvent("scan", `[MACRO] signal is ${agentAuthAge.toFixed(0)}min old (> ${MACRO_MAX_AGE_MIN}min) — NEUTRALISED. Scores no longer carry it.`);
    }
    if (agentMacroForAuth) {
      const staleSuffix = agentAuthAge > 30 ? ` (${agentAuthAge.toFixed(0)}min stale${_macroGhost ? ", NEUTRALISED" : ""})` : '';
      marketContext.macro = {
        signal:        _macroGhost ? 'neutral' : (agentMacroForAuth.signal || 'neutral'),
        scoreModifier: _macroGhost ? 0 : (agentMacroForAuth.modifier || 0),
        mode:          _macroGhost ? 'normal' : (agentMacroForAuth.mode || 'normal'),
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
    // 8/05: getFearAndGreed now returns NULL on failure instead of a fabricated {score:50}.
    // Only overwrite on a real reading — otherwise keep the last known good value (or the
    // initialised default at the top of this file). Without this guard the null propagates to
    // `marketContext.fearGreed.score` in the per-scan log line and throws a TypeError.
    if (fg && fg.score != null) { marketContext.fearGreed = fg; state._fearGreed = fg; }
    else if (fg === null) { state._fearGreedStale = true; }
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

  // C1-C: HIGH RISK day plan. 8/04 — THIS NO LONGER TOUCHES THE SCORE FLOOR, and the log below
  // now says what actually happens instead of what used to be claimed.
  //
  // History, so nobody "restores" this by accident: the 85 floor lived in _computeEffectiveMinScore,
  // which was only ever called INSIDE the daily-loss-lock branch — so C1-C only applied when C1-A
  // was also active, and never worked as an independent gate. When C1-A became a hard block (8/03)
  // that call site disappeared and the function went dead while the log kept claiming a raise.
  // The function is deleted rather than re-wired, because:
  //   - HIGH RISK days ARE still guarded, by C1-D below (~:2499): it disables the stagger bypass
  //     outright, which is a real behavioural block, not a score nudge.
  //   - the standing rule since 8/03 is that no loss/risk breaker raises the entry-score floor;
  //     per-trade risk is carried by the stop, the trail floor and the time-cut.
  // NOTE state._dayPlan is written only by agent.js, so this flag depends on the macro agent
  // actually running — it is currently failing on API credit and may not fire at all.
  const _dayPlanHighRisk = (state._dayPlan?.riskLevel === 'high') && !dryRunMode;
  if (_dayPlanHighRisk) {
    logEvent("filter", `[C1-C] Day plan HIGH RISK — stagger bypass disabled for the session (C1-D); entry score floor unchanged`);
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
      state._spyDayChangeFrac = gapPct;   // 8/11: renamed from _spyDayChangePct. gapPct is a FRACTION
                                          // ((cur-prev)/prev), NOT a percentage — the old "Pct" suffix invited a
                                          // x100 bug against DIP_MAX_DAYCHANGE (0.003), which is also a fraction.
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
  // 8/11 FIX 2: effectiveDefensive REVIVED FROM LIVE REGIME. This was `mode === "defensive" && _defAgentFresh`.
  // With AGENT_ENABLED=false the agent never stamps state._agentMacro, so _defAgentAge stayed 999 and
  // _defAgentFresh was permanently FALSE — which silently disabled the entire "defensive tape → suppress
  // weak calls" rail (the D4 callScore=0 at ~2218 and the two gates at ~2315/2319 could never fire).
  // Now: trust the agent's mode WHEN it is fresh, else fall back to the live regime class (B/C = defensive).
  // updateRegimeState() is called every scan from runScan and is NOT gated by AGENT_ENABLED, so
  // _regimeClass is always current. Regime A (the common tape) resolves to false exactly as before —
  // this only restores the rail on genuinely hostile tapes.
  const _defRegimeClass    = state._regimeClass || "A";
  const effectiveDefensive = _defAgentFresh
    ? (marketContext.macro || {}).mode === "defensive"
    : (_defRegimeClass === "B" || _defRegimeClass === "C");
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
    if (todayPnL < dailyLossLimit && !dryRunMode && !dataGatherActive(DATA_GATHER_MODE)) {
      logEvent("warn", `[DAILY CIRCUIT] Daily P&L $${todayPnL.toFixed(0)} below -3% limit — halting new entries`);
      state._dailyCircuitOpen = false;
    } else if (state._dailyCircuitOpen === false && todayPnL >= dailyLossLimit * 0.75) {
      logEvent("scan", `[DAILY CIRCUIT] Auto-reset — P&L $${todayPnL.toFixed(0)} recovered`);
      state._dailyCircuitOpen = true;
    }
    if (dataGatherActive(DATA_GATHER_MODE) && todayPnL < dailyLossLimit && !dryRunMode) {
      logEvent("scan", `[DAILY CIRCUIT] data-gather mode — P&L $${todayPnL.toFixed(0)} below -3% but NOT halting (gathering data)`);
    }
    if (dataGatherActive(DATA_GATHER_MODE)) {
      state._circuitHaltEntries = false;   // data-gather: never let a stale _dailyCircuitOpen=false keep entries halted
      state._dailyCircuitOpen   = true;    // and clear any stale trip, so flipping back OFF mid-day starts clean
    } else if (state._dailyCircuitOpen === false) {
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
  // ── 8/11 ITEM 2: TWO-SIDED GREEK LIMITS IN DELTA-DOLLARS ────────────────────────
  // Two defects here. (a) MAX_PORTFOLIO_DELTA is a FLOOR only (-500) — a book that is all calls
  // could run unbounded LONG delta with nothing to stop it. (b) MAX_PORTFOLIO_VEGA is computed
  // on the line above and read by NOTHING — a dead limit.
  // Measured in DELTA-DOLLARS (delta x underlying x 100 x contracts) rather than raw delta,
  // because a cheap 1DTE leg and an expensive 40DTE leg with the same delta represent very
  // different money at risk and must not count equally against one budget. SHADOW until
  // GREEK_LIMITS_ENFORCE — the existing -500 floor keeps behaving exactly as it does today.
  if (GREEK_LIMITS_ENABLED) {
    try {
      let _dd = 0, _vg = 0;
      for (const p of (state.positions || [])) {
        const d = parseFloat(p.greeks && p.greeks.delta) || 0;
        const u = p.price || 0;
        const q = p.contracts || 0;
        _dd += d * u * 100 * q;
        _vg += (parseFloat(p.greeks && p.greeks.vega) || 0) * 100 * q;
      }
      state._deltaDollars = parseFloat(_dd.toFixed(0));
      state._vegaDollars  = parseFloat(_vg.toFixed(0));
      const _ddHigh = _dd > MAX_DELTA_DOLLARS_POS;
      const _ddLow  = _dd < MAX_DELTA_DOLLARS_NEG;
      const _vgHigh = Math.abs(_vg) > MAX_PORTFOLIO_VEGA;
      state._greekBreached = !!(_ddHigh || _ddLow || _vgHigh);
      // THROTTLE: a breach persists across scans, so an unguarded log repeats every scan for as
      // long as the book stays over budget. Speak only on the TRANSITION into or out of breach.
      const _gWas = state._greekBreachedPrev === true;
      if (state._greekBreached && !_gWas) {
        logEvent("filter", `[GREEK-LIMIT] BREACH — delta-$ ${_dd.toFixed(0)} (limits ${MAX_DELTA_DOLLARS_NEG}..${MAX_DELTA_DOLLARS_POS}) | vega-$ ${_vg.toFixed(0)} (limit ±${MAX_PORTFOLIO_VEGA}) — ${_ddHigh ? "LONG DELTA" : _ddLow ? "SHORT DELTA" : "VEGA"}${GREEK_LIMITS_ENFORCE ? "" : " | SHADOW"}`);
      } else if (!state._greekBreached && _gWas) {
        logEvent("filter", `[GREEK-LIMIT] cleared — delta-$ ${_dd.toFixed(0)} vega-$ ${_vg.toFixed(0)} back inside budget`);
      }
      state._greekBreachedPrev = state._greekBreached;
    } catch (_gErr) { /* greek accounting is observational — never break the scan */ }
  }

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
  state._sessionMinsNow   = _sessionMinsNow;   // persisted so per-ticker session signals below can read it
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
    // 7/1 (Harrison): PRICE-SANITY at the source. getStockQuote can return a stale/FROZEN value when a
    // reused keep-alive socket serves a buffered old response during a connection storm — 7/1 telemetry
    // showed QQQ quotes frozen flat at ~729/~735 while real QQQ drifted ~719, with 0.06 correlation to
    // SPY (so NOT an SPY cross — QQQ's own desynced responses). The ticker's own most-recent minute-bar
    // close is the reliable price, so if the quote disagrees with it by >0.75%, distrust the quote and
    // use the bar close. This corrects BOTH scoring and strike selection deterministically, and unlike a
    // skip it keeps the real price in play. Root cure is keepAlive:false in broker.js (no socket reuse →
    // no stale responses); this is the net that holds even if a desynced response slips through. 0.0075 tunable.
    for (const _r of results) {
      const _ref = (_r.intradayBars && _r.intradayBars.length && _r.intradayBars[_r.intradayBars.length-1]?.c > 0)
                     ? _r.intradayBars[_r.intradayBars.length-1].c
                     : (_r.bars && _r.bars.length && _r.bars[_r.bars.length-1]?.c > 0 ? _r.bars[_r.bars.length-1].c : 0);
      if (_ref > 0 && _r.price > 0 && Math.abs(_r.price - _ref) / _ref > 0.0075) {
        logEvent("filter", `${_r.stock.ticker} PRICE-SANITY: quote $${_r.price.toFixed(2)} is ${(((_r.price-_ref)/_ref)*100).toFixed(1)}% off own bar $${_ref.toFixed(2)} — distrusting quote, using bar price`);
        _r.price = parseFloat(_ref.toFixed(2));
      }
    }
    stockData.push(...results);
  }

  logEvent("scan", `Prefetch complete in ${((Date.now()-prefetchStart)/1000).toFixed(1)}s`);

  for (const { stock, price, bars, intradayBars, sectorResult, preMarket, newsArticles, analystData, eqScore } of stockData) {
    // 8/26: DEDICATED GEX CHAIN FETCH — throttled per ticker. Populates _gexChain[ticker] with BOTH
    // sides at the same near expiry so the regime gate (enforce + MR-fade) can actually resolve, instead
    // of running blind on the incidental one-side findContract stash. Kill switch: GEX_FETCH_ENABLED.
    if (GEX_FETCH_ENABLED) {
      if (typeof fetchGexChain !== "function") {
        // 8/27: LOUD wiring check. The old `&& fetchGexChain` guard silently no-op'd when the import
        // didn't resolve — i.e. when scanner.js and execution.js are deployed from different builds,
        // the reference is undefined and the fetch vanished with zero trace. Never silent again.
        if (!state._gexWiringWarned) { state._gexWiringWarned = true; logEvent("scan", "[GEX-FETCH] WIRING ERROR — fetchGexChain is undefined (deploy scanner.js + execution.js as a matched pair; execution.js must export fetchGexChain)"); }
      } else if (stock && price > 0) {
        try {
          if (!state._gexFetchLast) state._gexFetchLast = {};
          if ((Date.now() - (state._gexFetchLast[stock.ticker] || 0)) >= GEX_FETCH_THROTTLE_MS) {
            state._gexFetchLast[stock.ticker] = Date.now();
            await fetchGexChain(stock.ticker, price);
          }
        } catch (_gfe) { logEvent("scan", `[GEX-FETCH] ${stock.ticker} threw — ${_gfe && _gfe.message}`); }
      }
    }
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
    // 7/31: computed HERE, not inside the gap classifier below. This is a pure price/VWAP
    // ratio that needs no daily bars, but it used to be assigned only inside the bars block —
    // so whenever daily bars were missing, short or stale it stayed at 1 ("exactly at VWAP"),
    // which makes _intradayDown false at entryEngine:330 and silently blinds the call
    // falling-knife veto AND the put carve-out. The live tape read must never depend on bars.
    let _carveVwapRatio = vwap > 0 ? price / vwap : 1;   // <1 below, >1 above
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
        // ── 7/31: VERIFY THE BARS ARE TODAY'S BEFORE CLASSIFYING A GAP. ──────────────
        // This block used to read bars[last].o / bars[last-1].c unconditionally. On 7/30
        // and 7/31 it printed IDENTICAL values on both days (QQQ open 703.62 prevC 708.97,
        // SPY open 746.62 prevC 748.28) — a days-old bar set presented as today's gap.
        // It is not just a log cosmetic: _carveGapState below feeds entryEngine's PUT
        // CARVE-OUT, so a frozen "gap-down-holding" gates live put entries on stale data.
        // If the newest bar is not today's, emit NOTHING and leave _carveGapState at its
        // "flat" default — the carve-out then falls back to _intradayDown, which is
        // computed fresh every scan. A loud unknown beats a confident wrong number.
        // ── 8/05 REWRITE. The 7/31 version demanded the newest DAILY bar be dated TODAY, but
        // Alpaca does not publish today's daily bar at the open — so it skipped every morning
        // (seen live 8/05 09:00:58 on both tickers) exactly when the gap matters most.
        //
        // A gap is (today's open − yesterday's close), and those two numbers live in DIFFERENT
        // places. Yesterday's close is the newest COMPLETED daily bar and is available all day.
        // Today's open is the first INTRADAY bar of the session and is never in the daily set
        // until after the close. Reading both from the daily bars was the original mistake.
        const _todayET     = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const _lastBarRaw  = bars[bars.length - 1].t || bars[bars.length - 1].timestamp || null;
        const _lastBarDate = _lastBarRaw ? String(_lastBarRaw).split('T')[0] : null;
        const _lastBarIsToday = _lastBarDate === _todayET;

        // Staleness is now an AGE check, not an exact-date match. >4 days covers a long weekend
        // and still catches the real 9-day bar-truncation failure this guard was built for.
        const _barAgeDays = _lastBarRaw ? (Date.now() - new Date(_lastBarRaw).getTime()) / 86400000 : Infinity;

        // Today's open, from intraday. getIntradayBars can serve a cached 390-bar window that
        // spans sessions, so filter by date rather than trusting index 0.
        const _todaysIntraday = Array.isArray(intradayBars)
          ? intradayBars.filter(b => String(b.t || b.timestamp || "").startsWith(_todayET))
          : [];
        const _sessionOpen = (_todaysIntraday.length && _todaysIntraday[0].o > 0) ? _todaysIntraday[0].o : null;

        if (_barAgeDays > 4) {
          logEvent("warn",
            `[GAP] ${stock.ticker} SKIPPED — newest daily bar is ${_lastBarDate || "undated"}, ${_barAgeDays.toFixed(0)} days old. ` +
            `prevClose would be stale; gapState left "flat" so the put carve-out uses the live intraday read instead.`
          );
        } else if (_sessionOpen == null) {
          // Normal before the first intraday bars land. Quiet on purpose — not a fault.
        } else {
        const _gapOpen  = _sessionOpen;
        const _gapPrevC = _lastBarIsToday ? bars[bars.length - 2].c : bars[bars.length - 1].c;
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
          // _carveVwapRatio is set above, outside this bars-dependent block (7/31) — do not
          // reassign it here; that is what tied the live VWAP read to the daily bar fetch.
          logEvent("scan",
            `[GAP] ${stock.ticker} gapPct ${(_gapPct*100).toFixed(2)}% (${_gapType}) | ` +
            `open ${_gapOpen.toFixed(2)} prevC ${_gapPrevC.toFixed(2)} | px ${price.toFixed(2)} ` +
            `${_aboveVwap ? "≥" : "<"} vwap ${vwap.toFixed(2)} → ${_gapState}`
          );
        }
        }   // end else (bars are today's)
      }
      // 8/03: refresh market regime every scan. It used to update only when the news agent ran,
      // so a dead or throttled agent froze _vixSustained / _regimeClass — and regime drives
      // strategy selection. Day counters inside are date-guarded, so this cadence is safe.
      await updateRegimeState();

      // 7/31: one freshness sweep per scan. Self-throttles to one report per 5 minutes, and only
      // speaks when something is actually past its expected refresh interval — silent otherwise.
      auditFreshness();

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

    // 8/09 RANGE GOVERNOR input: intraday realized range SO FAR today, as % of session open —
    // "is there enough movement for a call to reach the +12.5% rung." Filtered to today's session
    // (getIntradayBars can serve a multi-session window). Best-effort; never breaks a scan.
    let _intraRangePct = null;
    try {
      const _todayET_r = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const _todayBars = Array.isArray(intradayBars)
        ? intradayBars.filter(b => String(b.t || b.timestamp || "").startsWith(_todayET_r))
        : [];
      if (_todayBars.length >= 3) {
        const _hi = Math.max(..._todayBars.map(b => (b.h ?? b.c)));
        const _lo = Math.min(..._todayBars.map(b => (b.l ?? b.c)));
        const _op = _todayBars[0].o || _todayBars[0].c;
        if (_op > 0 && _hi >= _lo) _intraRangePct = parseFloat(((_hi - _lo) / _op * 100).toFixed(3));
      }
    } catch (_rgErr) { /* range is best-effort */ }

    // ── 8/11 ITEM 2+3: REALIZED VOL + VARIANCE RISK PREMIUM ───────────────────────
    // Nothing in APEX measured what the underlying is ACTUALLY doing — the only stdDev in the
    // codebase was on trade returns, inside calcSharpeRatio. Without RV there is no way to ask
    // the question a vol desk asks first: are options priced above or below what the tape is
    // delivering? Parkinson on the 1-min bars already in hand, annualized to match feed IV.
    // SHADOW: logged and carried on liveStock, gating nothing.
    let _rvOut = null, _vrpOut = null;
    if (VOL_INFRA_ENABLED && VOL) {
      try {
        const _todayET_v = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const _vBars = Array.isArray(intradayBars)
          ? intradayBars.filter(b => String(b.t || b.timestamp || "").startsWith(_todayET_v))
          : [];
        _rvOut = VOL.realizedVol(_vBars);
        // 8/12 FIX: NO VIX SUBSTITUTION. This previously fell back to state.vix/100 when no feed IV
        // had been observed, and that fallback fired constantly: _realIV is only written inside the
        // options prefetch at ~2801, which is gated on `scored.length > 0`. On a morning where nothing
        // clears the score floor the prefetch never runs, _realIV stays empty, and every VRP reading
        // silently became "30-day index-wide VIX vs this ticker's realized intraday vol".
        // Observed 8/12: SPY logged "IV 19.1% ... ratio 1.78 iv-rich" while the chosen contract's
        // actual feed IV was 0.117 — the honest ratio was ~1.09, "fair". A fabricated number is worse
        // than no number, because it looks like evidence. Feed IV or nothing.
        const _ivForVrp = (stock._realIV > 0) ? stock._realIV
                        : (stock._cachedContract && stock._cachedContract.iv > 0) ? stock._cachedContract.iv
                        : null;
        _vrpOut = VOL.ivrvSpread(_ivForVrp, _rvOut && _rvOut.rv);
        if (_ivForVrp == null) {
          if (!state._ivMissingLogged) state._ivMissingLogged = {};
          const _ivDay = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          if (state._ivMissingLogged[stock.ticker] !== _ivDay) {
            state._ivMissingLogged[stock.ticker] = _ivDay;
            logEvent("scan", `[VOL] ${stock.ticker} no per-contract feed IV observed yet — VRP suppressed (RV ${_rvOut && _rvOut.rv ? (_rvOut.rv*100).toFixed(1)+"%" : "n/a"} still logged). Populates once a contract is fetched for this ticker.`);
          }
        }
        // THROTTLE: sparse-bar is a DATA-QUALITY condition, not a market one — it does not change
        // scan to scan. Once per ticker per session is the whole signal.
        if (_rvOut && _rvOut.sparse) {
          if (!state._sparseLogged) state._sparseLogged = {};
          const _sparseDay = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
          if (state._sparseLogged[stock.ticker] !== _sparseDay) {
            state._sparseLogged[stock.ticker] = _sparseDay;
            logEvent("scan", `[VOL] ${stock.ticker} SPARSE BARS — parkinson/close-close ${_rvOut.pkRatio.toFixed(2)} < 0.80; likely an IEX fallback, RV would read low. Using close-to-close instead.`);
          }
        }
        // THROTTLE: this fired unconditionally for every ticker on every scan — ~6 scans/min x 2
        // tickers x 390 min ≈ 4,700 identical lines a day, burying everything else in the log.
        // Same failure the [BREAK] no-signal line had. VRP moves slowly, so speak on a REGIME
        // change or every 15 minutes, whichever comes first.
        if (_vrpOut && _vrpOut.vrp != null) {
          if (!state._volLogged) state._volLogged = {};
          const _vlPrev = state._volLogged[stock.ticker];
          const _vlDue  = !_vlPrev || _vlPrev.regime !== _vrpOut.regime
                          || (Date.now() - _vlPrev.ts) > 15 * 60 * 1000;
          if (_vlDue) {
            state._volLogged[stock.ticker] = { regime: _vrpOut.regime, ts: Date.now() };
            logEvent("scan", `[VOL] ${stock.ticker} IV ${(_vrpOut.iv*100).toFixed(1)}% RV ${(_vrpOut.rv*100).toFixed(1)}% | VRP ${(_vrpOut.vrp*100).toFixed(1)}pts ratio ${_vrpOut.ratio.toFixed(2)} — ${_vrpOut.regime} | via ${_rvOut.method}`);
          }
        }
      } catch (_vErr) { logEvent("scan", `[VOL] ${stock.ticker} vol calc failed — ${_vErr.message}`); }
    }

    // ── 8/17: NEAR-MISS FORWARD STAMP ──────────────────────────────────────
    // This was originally nested inside the [CALL-MOMO-SHADOW] report, which only fires when a
    // momo block matures. With CALL_MOMO_STRICT off there are far fewer blocks, so near-miss rows
    // would have sat with fwdPct permanently blank — the exact failure the ledger exists to
    // prevent, and the same shape as the 8/14 buffer eviction (524 blocks, 4 stamps). It belongs
    // here: the per-ticker scan loop runs every scan for every ticker and always has a live price,
    // so stamping is independent of any other subsystem.
    if (NEARMISS_LEDGER_ENABLED && price > 0 && Array.isArray(state._nearMiss)) {
      try {
        for (const _nm of state._nearMiss) {
          if (_nm.fwdPct != null || _nm.ticker !== stock.ticker || !(_nm.px > 0)) continue;
          const _nmAge = (Date.now() - _nm.at) / 60000;
          if (_nmAge >= MOMO_SHADOW_MINS) {
            _nm.fwdPct  = parseFloat((((price - _nm.px) / _nm.px) * 100).toFixed(3));
            _nm.fwdMins = Math.round(_nmAge);
          }
        }
      } catch (_nmsErr) { /* observational */ }
    }

    // 8/24: ENTRY forward-move stamp — same loop, for taken entries (state._entryFwd). Stamps
    // where the underlying went MOMO_SHADOW_MINS after each entry, independent of when it exited.
    if (price > 0 && Array.isArray(state._entryFwd)) {
      try {
        for (const _ef of state._entryFwd) {
          if (_ef.fwdPct != null || _ef.ticker !== stock.ticker || !(_ef.px > 0)) continue;
          const _efAge = (Date.now() - _ef.at) / 60000;
          if (_efAge >= MOMO_SHADOW_MINS) {
            _ef.fwdPct  = parseFloat((((price - _ef.px) / _ef.px) * 100).toFixed(3));
            _ef.fwdMins = Math.round(_efAge);
          }
        }
      } catch (_efsErr) { /* observational */ }
    }

    // 8/24: VF-SKIP forward-move stamp — same loop, for signals the vf arm declined (state._vfSkip).
    if (price > 0 && Array.isArray(state._vfSkip)) {
      try {
        for (const _vs of state._vfSkip) {
          if (_vs.fwdPct != null || _vs.ticker !== stock.ticker || !(_vs.px > 0)) continue;
          const _vsAge = (Date.now() - _vs.at) / 60000;
          if (_vsAge >= MOMO_SHADOW_MINS) {
            _vs.fwdPct  = parseFloat((((price - _vs.px) / _vs.px) * 100).toFixed(3));
            _vs.fwdMins = Math.round(_vsAge);
          }
        }
      } catch (_vssErr) { /* observational */ }
    }

    // 8/24: FALLING-KNIFE VETO forward stamp — same loop, for the oversold dips APEX refused.
    if (price > 0 && Array.isArray(state._vetoBlocks)) {
      try {
        for (const _vk of state._vetoBlocks) {
          if (_vk.fwdPct != null || _vk.ticker !== stock.ticker || !(_vk.px > 0)) continue;
          const _vkAge = (Date.now() - _vk.at) / 60000;
          if (_vkAge >= MOMO_SHADOW_MINS) {
            _vk.fwdPct  = parseFloat((((price - _vk.px) / _vk.px) * 100).toFixed(3));
            _vk.fwdMins = Math.round(_vkAge);
          }
        }
      } catch (_vksErr) { /* observational */ }
    }

    // ── 8/17: RANGE REGIME ───────────────────────────────────────────────
    // A/B/C classifies on SPY-vs-200MA and 5-day VIX — a crisis taxonomy for a book that holds
    // for months. APEX flattens at 3:15. Over 8/12-8/14 that label read "A" on 100% of scans
    // while realized range moved 6.6x and forward movement 30x (r=+0.906). This is the axis the
    // book actually lives on. LOG-ONLY: it gates nothing, it rides on the outcome row so the
    // question "does range regime predict?" becomes answerable instead of argued.
    let _rrOut = null;
    if (VOL_INFRA_ENABLED && VOL) {
      try {
        // required move for the tenor actually being bought — mirrors execution.js targetDTE
        // and the range-governor scale. Premium is approximated from the cached contract when
        // available; without one there is nothing to size against and the regime stays unknown.
        const _rrC   = stock._cachedContract;
        const _rrReq = (_rrC && _rrC.premium > 0 && _rrC.greeks)
          ? VOL.requiredMovePct(_rrC.premium, parseFloat(_rrC.greeks.delta) || 0, price)
          : null;
        if (_rrReq != null) {
          _rrOut = VOL.rangeRegime(stock._intraRangePct, state._sessionMinsNow ?? 0, _rrReq);
          if (!state._rrLast) state._rrLast = {};
          if (_rrOut.regime !== "unknown" && state._rrLast[stock.ticker] !== _rrOut.regime) {
            state._rrLast[stock.ticker] = _rrOut.regime;
            logEvent("scan", `[RANGE-REGIME] ${stock.ticker} ${_rrOut.regime.toUpperCase()} — range ${stock._intraRangePct}% projects to ${_rrOut.projRange.toFixed(2)}% vs ${_rrOut.minRange.toFixed(2)}% needed (ratio ${_rrOut.ratio.toFixed(2)})`);
          }
        }
      } catch (_rrErr) { /* observational — never break the scan */ }
    }

    const liveStock = {
      ...stock,
      price,
      _intraRangePct,
      _rv:        _rvOut ? _rvOut.rv : null,
      _rvMethod:  _rvOut ? _rvOut.method : null,
      _rvSparse:  _rvOut ? _rvOut.sparse : null,
      _vrp:       _vrpOut ? _vrpOut.vrp : null,
      _ivrvRatio: _vrpOut ? _vrpOut.ratio : null,
      _volRegime: _vrpOut ? _vrpOut.regime : null,
      _rangeRegime:     _rrOut ? _rrOut.regime    : null,
      _rangeProj:       _rrOut ? _rrOut.projRange : null,
      _rangeRatio:      _rrOut ? _rrOut.ratio     : null,
      rsi:           signals.rsi,
      dailyRsi:      (signals && signals.dailyRsi != null) ? parseFloat(signals.dailyRsi) : parseFloat(signals?.rsi || 50),
      macd:          signals.macd,
      macdCurl:      signals.macdCurl || "none",   // V3.2 (6/19) histogram bull/bear-curl → scoreIndexSetup
      adx:           signals.adx,                    // intraday ADX(14) — carried to the entry gate for the trend-strength veto gate
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

      // ═══ EARLY-BREAKDOWN SIGNALS (7/27) — catch the START of a move, not its confirmation ═══
      // ADX/depth are CONFIRMING measures: by construction they only read high once the move is
      // largely done (7/27: the breakdown window opened after SPY had already made its move, and
      // every re-fire after the first 30min lost money). These three fire at or near the start.
      // Stored on `state` keyed by ticker so ordering vs the liveStock build can't matter.
      if (!state._openRange) state._openRange = {};
      if (!state._vwapSlope) state._vwapSlope = {};
      if (!state._vwapHist)  state._vwapHist  = {};
      if (!state._bdEpisode) state._bdEpisode = {};
      if (!state._buEpisode) state._buEpisode = {};   // 8/05: breakout (up) episode — call-side mirror of _bdEpisode
      {
        const _tk   = stock.ticker;
        const _sm   = state._sessionMinsNow ?? 0;
        const _pxN  = price;
        const _vwN  = signals.intradayVWAP || 0;

        // (1) OPENING RANGE — zero lag by construction: the level is fixed BEFORE the break, so
        // the instant price crosses it we know, with no indicator to catch up.
        // FRESHNESS GUARD (7/28): the first 2 scans of every session carry a STALE cached price
        // (7/28 QQQ read 696.06 vs a real 675.48 open). Today the stale value was HIGH so only
        // _or.high was poisoned and nothing used it — but on a GAP-UP day the stale price sits
        // BELOW the session range, poisoning _or.low too low so `_orBreak` could never fire, with
        // no error and no log. intradayVWAP needs >=5 intraday bars, so `_vwN > 0` is exactly the
        // proof that the feed is live — the stale scans have no VWAP.
        if (_pxN > 0 && _vwN > 0) {
          if (!state._openRange[_tk] || state._openRange[_tk].day !== new Date().toDateString()) {
            state._openRange[_tk] = { high: _pxN, low: _pxN, locked: false, day: new Date().toDateString() };
          }
          const _or = state._openRange[_tk];
          if (!_or.locked) {
            if (_pxN > _or.high) _or.high = _pxN;
            if (_pxN < _or.low)  _or.low  = _pxN;
            if (_sm >= 15) _or.locked = true;      // OR = first 15 session minutes — matches APEX's 9:45 entry hard-block, so the level is ready the moment entries are
          }
        }

        // (2) VWAP SLOPE — the first derivative. VWAP TURNING DOWN precedes price being a fixed
        // distance below it, so it leads the depth measure the breakdown tier currently uses.
        if (_vwN > 0) {
          const _h = state._vwapHist[_tk] || [];
          const _lastT = _h.length ? _h[_h.length - 1].t : 0;
          if (Date.now() - _lastT > 60000) {                 // sample at most once a minute
            _h.push({ v: _vwN, t: Date.now() });
            while (_h.length > 3) _h.shift();
            state._vwapHist[_tk] = _h;
          }
          state._vwapSlope[_tk] = _h.length >= 2 ? (_h[_h.length - 1].v - _h[0].v) / _h[0].v : 0;
        }

        // (3) BREAKDOWN EPISODE AGE — a breakdown stays "true" for hours, so the signal re-fires
        // all day. 7/27: first 30min = +$528, every later re-fire = -$317. Track when the episode
        // STARTED so entries can be gated on its age instead of its mere existence.
        // HYSTERESIS: start on a raw breakdown, but end ONLY when price RECLAIMS its VWAP.
        // Measured on 7/27 SPY: without hysteresis the episode fragments into 8 pieces (price
        // ticks briefly back above the 0.3% line), the age gate then fails to block the losing
        // re-fires, and the gated day is +$411. With hysteresis it is ONE episode 09:59->close
        // and the gated day is +$528 (vs +$211 actual). The move is one event; track it as one.
        const _bdOn  = _vwN > 0 && _pxN > 0
          && ((_vwN - _pxN) / _vwN) >= 0.003
          && (signals.adx ?? 0) >= 20;
        const _bdOff = _vwN > 0 && _pxN > 0 && _pxN > _vwN;     // reclaimed VWAP => episode over
        const _today = new Date().toDateString();
        let _epNow = state._bdEpisode[_tk];
        if (_epNow && _epNow.day !== _today) { _epNow = null; delete state._bdEpisode[_tk]; }
        if (_bdOn && (!_epNow || !_epNow.active)) {
          state._bdEpisode[_tk] = { active: true, startedAt: Date.now(), day: _today, extreme: _pxN, extremeAt: Date.now() };
        } else if (_epNow && _epNow.active && _bdOff) {
          _epNow.active = false;
          _epNow.endedAt = Date.now();
        }
        // 7/29: track the episode's EXTREME so scoring can ask "is this breakdown still
        // PROGRESSING?" rather than only "how old is it?". Age conflates two states: old-and-
        // stalled (7/27 pm, SPY sideways, late re-fires lost -$317) vs old-and-still-trending
        // (7/29, QQQ made new lows all morning). Only the first should stop trading.
        const _epLive = state._bdEpisode[_tk];
        if (_epLive && _epLive.active && _pxN > 0) {
          if (!(_epLive.extreme > 0) || _pxN < _epLive.extreme) {
            _epLive.extreme = _pxN; _epLive.extremeAt = Date.now();
          }
        }

        // ── (4) BREAKOUT EPISODE AGE — the call-side MIRROR of the breakdown episode above ──
        // Same rationale, flipped: the edge is in the FIRST break ABOVE value, not its persistence.
        // Tracks price >=0.3% ABOVE its own VWAP with ADX>=20 (up-trend strength); extreme = new
        // HIGHS; and (hysteresis, matching _bdEpisode) the episode ends ONLY when price LOSES its
        // VWAP — a brief tick back below the 0.3% line does not fragment it. scoring reads this to
        // gate the call breakout channel on freshness + progression, exactly as the put side does.
        const _buOn  = _vwN > 0 && _pxN > 0
          && ((_pxN - _vwN) / _vwN) >= 0.003
          && (signals.adx ?? 0) >= 20;
        const _buOff = _vwN > 0 && _pxN > 0 && _pxN < _vwN;     // lost VWAP => episode over
        let _buNow = state._buEpisode[_tk];
        if (_buNow && _buNow.day !== _today) { _buNow = null; delete state._buEpisode[_tk]; }
        if (_buOn && (!_buNow || !_buNow.active)) {
          state._buEpisode[_tk] = { active: true, startedAt: Date.now(), day: _today, extreme: _pxN, extremeAt: Date.now() };
        } else if (_buNow && _buNow.active && _buOff) {
          _buNow.active = false;
          _buNow.endedAt = Date.now();
        }
        const _buLive = state._buEpisode[_tk];
        if (_buLive && _buLive.active && _pxN > 0) {
          if (!(_buLive.extreme > 0) || _pxN > _buLive.extreme) {   // new HIGH => still progressing
            _buLive.extreme = _pxN; _buLive.extremeAt = Date.now();
          }
        }
      }

      // INTRADAY SCORE (7/28) — computed here because every input above is now in state.
      // LOGGED ONLY: INTRADAY_SCORE_GATING is false, so nothing routes on it yet. The point is
      // to collect it alongside the legacy score so we can measure whether it actually RANKS
      // (corr with peak%/P&L) before letting it decide anything. The legacy score fails that
      // test — corr -0.11 / -0.14 — and we should not swap one unvalidated ranker for another.
      if (!state._intradayScore) state._intradayScore = {};
      try {
        state._intradayScore[stock.ticker] = {
          call: computeIntradayScore(stock.ticker, "call", price, signals, state),
          put:  computeIntradayScore(stock.ticker, "put",  price, signals, state),
          at:   Date.now(),
        };
      } catch (e) {
        // Logging must never break a scan — but a BARE silent catch is the exact anti-pattern
        // that hid the dead sector signals for weeks (fire-and-forget + `catch(e){}` = a broken
        // feature indistinguishable from an inactive one). Log ONCE per session so a failure is
        // visible without spamming the scan loop.
        if (!state._intradayScoreErrLogged) {
          state._intradayScoreErrLogged = true;
          logEvent("error", `[INTRADAY-SCORE] disabled for this session — ${e.message}`);
        }
      }

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
      // 8/11 FAIL-CLOSED: _spyDayChangeFrac is ONLY written at ~880, inside the spyGapUp IIFE, behind
      // `if (spyBars.length >= 2)`. On a cold start, the first scan after a restart, or any bar-data
      // hiccup it is never set. Scoring reads it as `?? 0`, and 0 <= DIP_MAX_DAYCHANGE(0.003) is TRUE,
      // so the "only reward dips when SPY is flat/red on the day" anchor silently PASSED exactly when
      // the data was degraded. Pass an explicit null instead: scoring now treats null as "unknown ->
      // block the dip bonus" rather than coercing it to a neutral-looking zero.
      const _spyDayChg    = Number.isFinite(state._spyDayChangeFrac) ? state._spyDayChangeFrac : null;
      const scoringMacro  = { ...(agentMacro || {}), regime: authRegimeName, spyGapUp: !!spyGapUp, spyDayChange: _spyDayChg };
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
      // 7/28: this awarded +8 to BOTH sides identically, but volume expansion CONFIRMS whichever
      // direction the tape is already moving — it is not symmetric evidence. On the 7/28 QQQ
      // breakdown "Volume 2.4x pace (+8)" was handed to a CALL that was buying into a confirmed
      // decline (heavy volume on a decline is DISTRIBUTION). Award it to the side the tape is on.
      if (priceAboveOpen) {
        callSetup.score = Math.min(100, callSetup.score + 8); callSetup.reasons.push(`Volume ${signals.volPaceRatio.toFixed(1)}x pace on an UP tape (+8)`);
      } else {
        putSetup.score  = Math.min(100, putSetup.score  + 8); putSetup.reasons.push(`Volume ${signals.volPaceRatio.toFixed(1)}x pace on a DOWN tape (+8)`);
      }
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
    const _effectiveMin  = dataGatherActive(DATA_GATHER_MODE) ? 50 : (_creditType ? MIN_SCORE_CREDIT : (_debitCallActive ? 75 : MIN_SCORE));  // 7/1: verdict floor tracks the data-gather gate (50) so [VERDICT] logs + dashboard match actual entries
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

    // ── 8/11: STRUCTURAL BREAK TRIGGER ───────────────────────────────────────────────
    // Runs BEFORE the MR-scalp detector so the scalp (its own scoreless channel) can still
    // override under enforce. SHADOW until BREAK_TRIGGER_ENFORCE: computes, logs, and tags
    // liveStock every scan so the signal is validated against real outcomes before it gates
    // a single dollar.
    let _brk = { side: null, ageMin: null, volMult: null, blocked: "trigger disabled", why: null };
    if (BREAK_TRIGGER_ENABLED) {
      _brk = detectStructuralBreak({
        intradayBars,
        or:         state._openRange ? state._openRange[stock.ticker] : null,
        vwapSlope:  state._vwapSlope ? state._vwapSlope[stock.ticker] : 0,
        adx:        signals.adx,
        price,
        etHour:     scanET.getHours() + scanET.getMinutes() / 60,
        sessionMin: state._sessionMinsNow ?? 0,
        todayStr:   new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        nowMs:      Date.now(),
      });
      liveStock._breakSide    = _brk.side;
      liveStock._breakAgeMin  = _brk.ageMin;
      liveStock._breakVolMult = _brk.volMult;
      liveStock._breakBlocked = _brk.blocked;
      if (_brk.side) {
        logEvent("filter", `[BREAK] ${stock.ticker} ${_brk.side.toUpperCase()} — ${_brk.why}${BREAK_TRIGGER_ENFORCE ? "" : " | SHADOW ONLY"}`);
      } else {
        // No-signal is the COMMON case — it fires for every ticker on every scan (~6/min each).
        // Logging it unconditionally buries the shadow evidence under ~700 identical lines/hour,
        // so speak only when the blocking reason CHANGES. That turns the log into a transition
        // trace ("no fresh level break" -> "break-bar vol 1.2x < 1.8x") which is what is
        // actually diagnostic when tuning the thresholds.
        if (!state._breakLastBlocked) state._breakLastBlocked = {};
        // 8/12: throttle on a DIGIT-STRIPPED key. The reason string embeds the break age
        // ("break 11m old > 10m"), which increments every scan — so comparing raw strings made the
        // reason "change" every minute and the throttle logged ~1 line/min for 26 straight minutes
        // on 8/12. Stripping digits collapses those to one stable key, so only a genuine change of
        // REASON speaks.
        const _brkKey = String(_brk.blocked).replace(/[0-9.]+/g, "#");
        if (state._breakLastBlocked[stock.ticker] !== _brkKey) {
          state._breakLastBlocked[stock.ticker] = _brkKey;
          logEvent("scan", `[BREAK] ${stock.ticker} no signal — ${_brk.blocked}`);
        }
      }
    }

    if (BREAK_TRIGGER_ENFORCE) {
      // The trigger is authoritative: it picks the side AND decides whether a trade exists; the score
      // is a CARRIER, not a decider. 8/25: REGIME-GATED — a break is only chased in NEGATIVE gamma
      // (trend regime). In POSITIVE gamma (range) the literature says fade, not chase, so the break
      // stands down and the MR fade covers that regime. Tag stock._structBreak so execution buys the
      // deep-ITM trend instrument and the exit lets it run.
      // TAG ON liveStock — that is the object carried into the candidate/executeTrade; the raw `stock`
      // is a different object (built separately), so tagging it would silently no-op the whole sleeve.
      // 8/25: compute regime INLINE from the freshest chain (same calc as the telemetry stash below),
      // not last scan's _gexNow — closes the one-scan lag on the gate that routes the whole sleeve.
      const _reg = (() => { try {
        const _gc = state._gexChain && state._gexChain[liveStock.ticker];
        if (GEX && _gc && _gc.call && _gc.put && _gc.call.dte === _gc.put.dte &&
            (Date.now() - Math.min(_gc.call.ts || 0, _gc.put.ts || 0) < 300000)) {
          const _g = GEX.computeGEX(_gc.call.rows, _gc.put.rows, price);
          // 8/26: LIVE GEX STAMP (per ticker — SPY and QQQ each). Prints raw netGEX + netGexM + regime
          // AND the strike counts / total OI, so the "is netGexM stuck at 0, and if so why" question is
          // answerable in the live log, not just the EOD telemetry CSV. Throttled ~60s/ticker.
          if (_g) {
            try {
              if (!state._gexLogLast) state._gexLogLast = {};
              if ((Date.now() - (state._gexLogLast[liveStock.ticker] || 0)) >= 60000) {
                state._gexLogLast[liveStock.ticker] = Date.now();
                const _coi = _gc.call.rows.reduce((s, r) => s + (r.oi || 0), 0);
                const _poi = _gc.put.rows.reduce((s, r) => s + (r.oi || 0), 0);
                logEvent("scan", `[GEX] ${liveStock.ticker} netGEX=${_g.netGEX} (${_g.netGexM}M) regime=${_g.regime} | ${_gc.call.rows.length}c/${_gc.put.rows.length}p oi=${_coi}c/${_poi}p ${_gc.call.dte}DTE`);
              }
            } catch (_gxl) {}
          }
          return _g ? _g.regime : null;
        }
      } catch (_gxr) {} return null; })();
      // 8/26 FIX: the enforce must reach the ENTRY, not just side-selection + the verdict log. The
      // candidate (EE_scoreCandidate below) reads callSetup.score/putSetup.score — the RAW composite,
      // NOT callScore/putScore — so modifying only the latter left the composite STILL gating entry,
      // and the paper-experiment path (exp-floor 50) fired dip-buy calls straight past the cutover.
      // Mirror the mr-scalp dual-write: stamp the enforce decision onto the setup scores too. Preserve
      // the raw composite on _scoreRaw first so "keep + log the score" still holds.
      liveStock._scoreRaw = { call: callSetup.score, put: putSetup.score };
      if (_reg === "pos") {
        putScore = 0; callScore = 0; putSetup.score = 0; callSetup.score = 0; liveStock._structBreak = null;
        recordStandDown("brk", _brk.side ? "positive-gamma standdown" : (_brk.blocked || "no break"));
        if (_brk.side) logEvent("filter", `[BREAK] ${liveStock.ticker} ${_brk.side.toUpperCase()} stood down — positive-gamma regime (fade, don't chase)`);
      } else if (_brk.side === "put")  { callScore = 0; callSetup.score = 0; putScore = Math.max(putScore, BREAK_ENTRY_SCORE); putSetup.score = Math.max(putSetup.score, BREAK_ENTRY_SCORE); liveStock._structBreak = "put";  recordStandDown("brk", "FIRED"); }
      else if (_brk.side === "call")   { putScore = 0; putSetup.score = 0; callScore = Math.max(callScore, BREAK_ENTRY_SCORE); callSetup.score = Math.max(callSetup.score, BREAK_ENTRY_SCORE); liveStock._structBreak = "call"; recordStandDown("brk", "FIRED"); }
      else                             { putScore  = 0; callScore = 0; putSetup.score = 0; callSetup.score = 0; liveStock._structBreak = null; recordStandDown("brk", _brk.blocked || "no break"); }
    }

    // ── 8/09: MR-SCALP DETECTOR — a disciplined capitulation-snap CALL that runs LIVE alongside
    // breakout calls, tagged mr-scalp. Placed right before direction selection so it survives the
    // context-call penalties (IVP/momentum/gap) it is DESIGNED to counter — but it still requires
    // macro to permit calls (callsAllowed && !defensive above) and respects every downstream
    // safety/cap/cooldown gate. The strict conditions ARE the edge (score is a weak ranker), so on a
    // pass we floor the call score + label it; execution buys the low-vega 0-1DTE/0.42Δ leg at half
    // size, exitEngine runs the fast scalp exits. All thresholds in constants.js (MR_SCALP_*).
    // 8/11 FIX 5: macro backdrop collapsed to ONE signal (Regime A, tested inside _msPass). The old
    // arming gate stacked !effectiveDefensive here on top of !_msSpyBelow200 && !_msRegimeC below —
    // three overlapping proxies for the same "is the tape hostile" question, one of which was dead.
    if (MR_SCALP_ENABLED && (liveStock.isIndex || stock.isIndex) && callsAllowed
        && (!BREAK_TRIGGER_ENFORCE || BREAK_TRIGGER_ALLOW_MRSCALP)) {
      try {
        const _msVwap  = liveStock.intradayVWAP || 0;
        const _msRsi   = signals.rsi;
        const _msSessLow   = state._sessionLowRSI?.[stock.ticker];
        const _msSessLowAt = state._sessionLowRSIAt?.[stock.ticker] || 0;
        const _msLowAge    = _msSessLowAt ? (Date.now() - _msSessLowAt) / 60000 : Infinity;
        const _msTET   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const _msTb    = Array.isArray(intradayBars) ? intradayBars.filter(b => String(b.t||b.timestamp||"").startsWith(_msTET)) : [];
        const _msSessHigh = _msTb.length ? Math.max(..._msTb.map(b => (b.h ?? b.c ?? 0))) : 0;
        const _msLastBar  = _msTb.length ? _msTb[_msTb.length-1] : null;
        const _msBarGreen = !!(_msLastBar && (_msLastBar.c ?? 0) > (_msLastBar.o ?? 0));
        const _msFlushDD  = (_msSessHigh > 0 && price > 0) ? (_msSessHigh - price) / _msSessHigh : 0;
        const _msExtBelow = _msVwap > 0 && price > 0 && price <= _msVwap * (1 - MR_SCALP_VWAP_EXT_MIN);
        const _msLiftoff  = (_msRsi != null && _msSessLow != null) ? (_msRsi - _msSessLow) : -1;
        const _msCorrob   = (liveStock.macdCurl === "bull_curl") || _msBarGreen;
        const _msAdx      = Number.isFinite(signals.adx) ? signals.adx : 0;
        const _msOr       = state._openRange?.[stock.ticker];
        const _msKnife    = _msAdx >= 20 && _msExtBelow && !!(_msOr && _msOr.locked && price < _msOr.low);   // structural breakdown = trend, not dip
        const _msRange    = (typeof liveStock._intraRangePct === "number") ? liveStock._intraRangePct : 0;
        const _msSessMin  = state._sessionMinsNow ?? 0;
        const _msEtHour   = scanET.getHours() + scanET.getMinutes() / 60;
        const _msRegimeA  = (state._regimeClass || "A") === "A";   // 8/11 FIX 5: the single macro backdrop signal

        const _msPass =
             (_msSessLow != null && _msSessLow <= MR_SCALP_SESSLOW_RSI_MAX)                          // capitulation printed
          && (_msFlushDD >= MR_SCALP_FLUSH_DD_MIN)                                                    // real flush off session high
          && _msExtBelow                                                                              // extended below own VWAP
          && (_msLiftoff >= MR_SCALP_LIFTOFF_PTS)                                                     // turn has started
          && (_msLowAge >= MR_SCALP_LOW_AGE_MIN_MIN && _msLowAge <= MR_SCALP_LOW_AGE_MAX_MIN)         // fresh, not a new low, not a dead cat
          && _msCorrob                                                                                // curl or green bar
          && !_msKnife                                                                                // not a structural breakdown
          && (_msRange >= MR_SCALP_RANGE_MIN_PCT)                                                     // not a dead tape
          && ((state.vix || 0) >= MR_SCALP_VIX_MIN)                                                   // enough vol
          && (_msSessMin >= MR_SCALP_SESSION_MIN_MIN)                                                 // VWAP reliable
          && (_msEtHour < MR_SCALP_CUTOFF_ET)                                                         // before 2:30pm ET
          && _msRegimeA;                                                                              // 8/11 FIX 5: macro not hostile — ONE signal. Regime A uses 5-day SUSTAINED VIX, so it stays true through a spot VIX>=20 flush, which is exactly the window this scalp targets.

        if (_msPass) {
          liveStock._mrScalp     = true;
          liveStock._mrEntryVWAP = parseFloat(_msVwap.toFixed(2));
          callSetup.isMeanReversion = true;
          callSetup.score = Math.max(callSetup.score, MR_SCALP_MIN_SCORE);
          callScore       = Math.max(callScore, MR_SCALP_MIN_SCORE);
          const _msReason = `MR-SCALP capitulation snap — sessLowRSI ${_msSessLow} flush ${(_msFlushDD*100).toFixed(1)}% belowVWAP ${((1 - price/_msVwap)*100).toFixed(2)}% liftoff ${_msLiftoff.toFixed(0)}pt age ${_msLowAge.toFixed(0)}m range ${_msRange.toFixed(2)}%`;
          callSetup.reasons = [_msReason, ...((callSetup.reasons) || [])];
          logEvent("filter", `[MR-SCALP] ${stock.ticker} ARMED — ${_msReason} | VIX ${(state.vix||0).toFixed(1)} @ ${_msEtHour.toFixed(2)}h`);
        }
      } catch (_msErr) { logEvent("warn", `[MR-SCALP] detector error ${stock.ticker}: ${_msErr.message}`); }
    }

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
      const _killer   = _vReasons.find(r => /\(-|too low|not oversold|wrong|bearish|no bounce|skip|block/i.test(r)) || _vReasons[_vReasons.length - 1] || "no reasons";  // 7/7 (Harrison): dropped |\+0\) — a (+0) reason has ZERO score impact and never blocks anything; matching it mislabeled neutral reasons (e.g. "recovery stale (+0)") as the headline blocker, which is what dominated the 7/2 blocker column. Now only genuinely negative reasons qualify; falls back to last reason otherwise.
      logEvent("filter",
        `[VERDICT] ${stock.ticker} ${optionType.toUpperCase()} ${bestScore} vs scanner-floor ${_vFloor} → ${_clears ? "CLEARS→entryEngine" : "BELOW"}` +
        ` | isMR:${callSetup.isMeanReversion ? "Y" : "N"} curl:${liveStock.macdCurl || "none"} dRSI:${(liveStock.dailyRsi || 0).toFixed(0)} c/p:${callScore}/${putScore}` +
        (_clears ? "" : ` | headline: ${_killer}`));

      // Compact score telemetry (V3.2 6/23) — projects the just-computed verdict into one
      // material-change/heartbeat CSV row. try/catch: instrumentation must never halt a scan.
      try {
        const _vwapPx = signals.intradayVWAP || 0;
        const _gexRec = (() => { try {
        const _gc = state._gexChain && state._gexChain[stock.ticker];
        if (GEX && _gc && _gc.call && _gc.put && _gc.call.dte === _gc.put.dte &&
            (Date.now() - Math.min(_gc.call.ts || 0, _gc.put.ts || 0) < 300000))
          return GEX.computeGEX(_gc.call.rows, _gc.put.rows, price);   // same near expiry only
      } catch (_gxe) {} return null; })();
      if (_gexRec) { if (!state._gexNow) state._gexNow = {}; state._gexNow[stock.ticker] = _gexRec; }   // 8/24: expose regime to the MR fade
      recordTelemetry(state, {
          tkr: stock.ticker, px: price, adx: signals.adx,
          iRSI: signals.rsi, dRSI: signals.dailyRsi,
          call: callScore, put: putScore,
          isMR: callSetup.isMeanReversion === true,
          curl: liveStock.macdCurl || "none",
          vwapPct: _vwapPx ? ((price - _vwapPx) / _vwapPx) * 100 : null,
          blocker: _clears ? "" : _killer,
          callReasons: callSetup.reasons, putReasons: putSetup.reasons,
          direction: optionType,
          volPace: signals.volPaceRatio, breadth: signals.breadth,   // 8/24: enrich the tape for backtesting
          gexRegime: _gexRec ? _gexRec.regime : null, netGexM: _gexRec ? _gexRec.netGexM : null,   // 8/24: dealer-gamma REGIME on the tape (pos=range/MR-friendly, neg=trend)
          callWall: _gexRec ? _gexRec.callWall : null, putWall: _gexRec ? _gexRec.putWall : null,
          distCW: _gexRec ? _gexRec.distCallWallPct : null, distPW: _gexRec ? _gexRec.distPutWallPct : null,
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
    if (sameTickerSameDir.length >= 1 && !dataGatherActive(DATA_GATHER_MODE)) { logEvent("filter", `${stock.ticker} already have ${sameTickerSameDir.length} position(s)`); continue; }

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

    // C1-B: 8/03 — THE ENTRY GATE IS REMOVED. It used to require score 90 after 2 counted losses
    // on a ticker. Two problems: the threshold and the 90 were HARDCODED here, so the constants
    // INSTRUMENT_LOSS_LIMIT / INSTRUMENT_LOSS_MIN_SCORE only ever affected the log message; and
    // raising the entry bar is the wrong instrument now that stop + trail floor + time-cut carry
    // per-trade risk. The dollar-based daily lock (C1-A, now -$500) is the daily guard.
    // The counter is still maintained in closeEngine for telemetry — it just no longer gates.
    const _instrLossCount = (state._instrumentLossCount || {})[stock.ticker] || 0;
    if (_instrLossCount >= 2 && !dryRunMode) {
      logEvent("scan", `[C1-B] ${stock.ticker} ${_instrLossCount} counted losses today — noted, not blocking (entry gate removed 8/03)`);
    }

    const recentLoss = (state._recentLosses || {})[stock.ticker];
    if (optionType === "call" && (stock.dailyRsi || 50) > 80) {
      logEvent("filter", `${stock.ticker} call blocked — dailyRSI overbought daily (>80)`);
      continue;
    }

    const recentClose = (state._recentCloses || {})[stock.ticker];
    const recentCloseSameDir = recentClose && (!recentClose.optionType || recentClose.optionType === optionType);
    if (recentCloseSameDir && !dataGatherActive(DATA_GATHER_MODE)) {
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
    if (recentLossSameDir && _wasHardStop && !dataGatherActive(DATA_GATHER_MODE) && (Date.now() - recentLoss.closedAt) < 2 * 3600 * 1000) {
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
          const isMR = optionType === "call" && (stock._mrStrong || false);   // D3: aggressive 0.42Δ profile only on STRICT tier
          // 8/17: DTE 38 -> 3. This prefetch was the REAL source of the tenor, not
          // execution.js:361. It writes stock._cachedContract, and executeTrade does
          // `contract = stock._cachedContract || await findContract(...)` — so the cached contract
          // WINS and the targetDTE computed in executeTrade is never reached. The 8/14 default
          // change (40 -> 3) shipped live and did nothing: 8/17 still logged SPY 44DTE / QQQ 46DTE
          // all session. Two hardcoded tenors, one of which silently overrode the other.
          // MR keeps a slightly longer leg (its own gate is stricter); everything else is 3.
          const contract = await findContract(stock.ticker, optionType, isMR ? 0.42 : 0.35, isMR ? 3 : 3, state.vix, stock);
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

    // 8/27: TREND-SWING sleeve (daily-momentum, multi-day hold). Own path — bypasses the score/enforce gate
    // like mr-fade. Daily thesis: price vs 50/100d MA + daily RSI/MACD + breadth, not overextended.
    if (TREND_ENABLED && stock && price > 0) {
      try {
        const _etH = (() => { const d = getETTime(); return d.getHours() + d.getMinutes() / 60; })();
        if (_etH < TREND_CUTOFF_ET) {
          const _tm = await ensureDailyTrend(stock.ticker);
          if (_tm && _tm.ma50 && _tm.ma100 && _tm.atr) {
            const _drsi  = (typeof stock.dailyRsi === "number") ? stock.dailyRsi : 50;
            const _macd  = stock.macd || "neutral";
            const _brdth = (marketContext && marketContext.breadth && typeof marketContext.breadth.breadthPct === "number") ? marketContext.breadth.breadthPct : 50;
            const _upTrend   = price > _tm.ma50 && _tm.ma50 > _tm.ma100;
            const _downTrend = price < _tm.ma50 && _tm.ma50 < _tm.ma100;
            const _overExt   = Math.abs(price - _tm.ma50) > TREND_OVEREXT_ATR * _tm.atr;
            let _tSide = null, _tReason = null;
            // 8/27: LOOSENED to the literature (Moskowitz/Clenow) — price-vs-MA IS the signal.
            // Dropped the MACD-bullish + RSI>=50 confirmation (my add-ons, not the momentum edge).
            // KEPT: not-overextended (Daniel-Moskowitz crash filter), RSI upper guardrail (exhaustion),
            // breadth not actively against (light participation check, not a hard gate).
            const _rsiOverbought = _drsi >= TREND_RSI_MAX;      // don't buy a blow-off top
            const _rsiOversold   = _drsi <= (100 - TREND_RSI_MAX);
            const _brdthAgainstCall = _brdth < (100 - TREND_BREADTH_MIN);   // breadth actively bearish
            const _brdthAgainstPut  = _brdth > TREND_BREADTH_MIN;           // breadth actively bullish
            if (_upTrend && !_overExt && !_rsiOverbought && !_brdthAgainstCall) {
              _tSide = "call"; _tReason = `daily uptrend $${price.toFixed(2)}>50d$${_tm.ma50}>100d$${_tm.ma100} dRSI${_drsi.toFixed(0)} brdth${_brdth}% [lit: price-vs-MA]`;
            } else if (_downTrend && !_overExt && !_rsiOversold && !_brdthAgainstPut) {
              _tSide = "put";  _tReason = `daily downtrend $${price.toFixed(2)}<50d$${_tm.ma50}<100d$${_tm.ma100} dRSI${_drsi.toFixed(0)} brdth${_brdth}% [lit: price-vs-MA]`;
            }
            const _haveTrend = (state.positions || []).some(p => p.ticker === stock.ticker && p.entryStrategy === "trend-swing" && p.optionType === _tSide && !p.closed);
            if (_tSide && !_haveTrend) {
              stock._isTrend = _tSide;
              const _tSig = `${stock.ticker}-${_tSide}-trend-${Date.now()}`;
              const _tOK = await executeTrade(stock, price, 0, [_tReason], state.vix, _tSide, false, 1.0, null, null, _tSig);
              stock._isTrend = null;
              if (_tOK) { recordStandDown("trend", "FIRED"); logEvent("scan", `[TREND-SWING] ${stock.ticker} ${_tSide.toUpperCase()} FIRED — ${_tReason}`); continue; }
            } else {
              recordStandDown("trend", (_upTrend || _downTrend) ? (_overExt ? "overextended from 50d" : "momentum/breadth gate") : "no daily trend");
            }
          } else { recordStandDown("trend", "daily MA unavailable"); }
        } else { recordStandDown("trend", "past 3pm cutoff"); }
      } catch (_te) { logEvent("warn", `[TREND-SWING] ${stock.ticker} eval failed — ${_te && _te.message}`); }
    }

    // 8/28: INTRADAY-TREND sleeve — same-day directional (ORB + VWAP + slope + ADX confluence, NO score).
    // Own path, bypasses the score/enforce like the other sleeves. Deliberate paper experiment: the tape
    // test said continuation doesn't continue, so this is gated HARD (ADX>=25 + real OR break) and fully
    // logged so forward fills settle it. Fires 10:00-13:30 ET only.
    if (ITREND_ENABLED && stock && price > 0) {
      try {
        const _iH = (() => { const d = getETTime(); return d.getHours() + d.getMinutes() / 60; })();
        if (_iH >= ITREND_START_ET && _iH < ITREND_END_ET) {
          const _ior   = state._openRange ? state._openRange[stock.ticker] : null;
          const _iVw   = (stock.intradayVWAP > 0 && price > 0) ? ((price - stock.intradayVWAP) / stock.intradayVWAP) * 100 : null;
          const _iSlope = (state._vwapSlope || {})[stock.ticker] ?? 0;
          const _iAdx  = (typeof stock.adx === "number") ? stock.adx : 0;
          const _iBr   = (marketContext && marketContext.breadth && typeof marketContext.breadth.breadthPct === "number") ? marketContext.breadth.breadthPct : 50;
          if (_ior && _ior.locked && _ior.low > 0 && _ior.high > 0 && _iVw !== null && _iAdx >= ITREND_ADX_MIN) {
            // breadth is SOFT/fail-open: block only when actively against (neutral ~50 passes both sides)
            const _brAgainstPut  = _iBr > ITREND_BREADTH_STRONG;          // breadth actively bullish
            const _brAgainstCall = _iBr < (100 - ITREND_BREADTH_STRONG);  // breadth actively bearish
            let _iSide = null, _iReason = null;
            if (_iVw <= -ITREND_VWAP_MIN && _iSlope < 0 && price < _ior.low && !_brAgainstPut) {
              _iSide = "put";  _iReason = `intraday downtrend: vwap${_iVw.toFixed(2)}% slope<0 px$${price.toFixed(2)}<ORlow$${_ior.low.toFixed(2)} adx${_iAdx.toFixed(0)} brdth${_iBr}%`;
            } else if (_iVw >= ITREND_VWAP_MIN && _iSlope > 0 && price > _ior.high && !_brAgainstCall) {
              _iSide = "call"; _iReason = `intraday uptrend: vwap+${_iVw.toFixed(2)}% slope>0 px$${price.toFixed(2)}>ORhigh$${_ior.high.toFixed(2)} adx${_iAdx.toFixed(0)} brdth${_iBr}%`;
            }
            const _iHave = (state.positions || []).some(p => p.ticker === stock.ticker && p.entryStrategy === "intraday-trend" && p.optionType === _iSide && !p.closed);
            if (!state._iTrendLast) state._iTrendLast = {};
            const _iCoolKey = `${stock.ticker}-${_iSide}`;
            const _iCooling = _iSide && (Date.now() - (state._iTrendLast[_iCoolKey] || 0)) < ITREND_COOLDOWN_MIN * 60000;
            if (_iSide && !_iHave && !_iCooling) {
              stock._iTrend = _iSide;
              state._iTrendLast[_iCoolKey] = Date.now();
              const _iOK = await executeTrade(stock, price, 0, [_iReason], state.vix, _iSide, false, 1.0, null, null, `${stock.ticker}-${_iSide}-itrend-${Date.now()}`);
              stock._iTrend = null;
              if (_iOK) { recordStandDown("itrend", "FIRED"); logEvent("filter", `[INTRADAY-TREND] ${stock.ticker} ${_iSide.toUpperCase()} FIRED — ${_iReason}`); continue; }
            } else {
              recordStandDown("itrend", !_iSide ? "no aligned intraday trend (need vwap+slope+ORbreak agree)" : _iHave ? "position already open" : "cooldown (recent fire)");
            }
          } else {
            recordStandDown("itrend", (!_ior || !_ior.locked) ? "OR not locked" : (_iAdx < ITREND_ADX_MIN ? `ADX ${_iAdx.toFixed(0)}<${ITREND_ADX_MIN} (chop)` : "no vwap"));
          }
        } else { recordStandDown("itrend", "outside 10:00-13:30 window"); }
      } catch (_ie) { logEvent("warn", `[INTRADAY-TREND] ${stock.ticker} eval failed — ${_ie && _ie.message}`); }
    }

    // 8/11 FIX 1: MR-SCALP IS CALL-ONLY — revoked ONCE, here, before anything downstream reads the flag.
    // The detector arms liveStock._mrScalp during SCORING, i.e. before direction is resolved (and before
    // entryEngine gets its say and can flip the side). If the candidate came back as a put, the stale flag
    // still routed execution down the scalp path at ~2791: a single 0-1 DTE / 0.42-delta / half-size leg
    // tagged entryStrategy="mr-scalp" — a call setup's contract spec and exit schedule applied to a PUT,
    // which then gets managed by the scalp exits in exitEngine. Revoking here means `_mrScalp === true`
    // means exactly one thing everywhere downstream: a live CALL scalp.
    if (stock._mrScalp && optionType !== "call") {
      stock._mrScalp = false;
      logEvent("filter", `[MR-SCALP] ${stock.ticker} scalp flag REVOKED — candidate resolved to ${optionType}; the scalp is call-only`);
    }

    // ═══ LITERATURE MR FADE (mrStrategy.js) ═══ a coherent mean-reversion entry, gated on
    // regime(gamma) + level(gamma wall / VWAP band) + confluence. Fires its OWN fade side when the
    // full confluence aligns, reusing executeTrade. Bypasses the momentum-era gates by design — it is
    // a DIFFERENT strategy — but respects the position guard below. Kill switch: MR_FADE_ENABLED.
    // Wrapped so a fault can never disturb the scan.
    if (mrFadeActive(MR_FADE_ENABLED) && MRSTRAT && stock) {   // runtime kill switch (dashboard toggle)
      try {
        const _mrVwap = (stock.intradayVWAP > 0 && price > 0) ? ((price - stock.intradayVWAP) / stock.intradayVWAP) * 100 : null;
        const _mrDec  = MRSTRAT.evaluateMRFade({ rsi: stock.rsi, vwapPct: _mrVwap, adx: stock.adx },
                                               (state._gexNow && state._gexNow[stock.ticker]) || null, price);
        if (_mrDec.fire) {
          // 8/27: don't fade AGAINST the daily trend (Chan regime-conditional MR). Fading strength in a
          // daily uptrend (puts) / weakness in a downtrend (calls) is the falling knife — 4/5 puts died this way 8/27.
          const _dt = await ensureDailyTrend(stock.ticker);
          let _fadeVsTrend = false;
          if (_dt && _dt.ma50 && _dt.ma100) {
            const _dUp = price > _dt.ma50 && _dt.ma50 > _dt.ma100;
            const _dDn = price < _dt.ma50 && _dt.ma50 < _dt.ma100;
            if (_mrDec.side === "put"  && _dUp) _fadeVsTrend = true;
            if (_mrDec.side === "call" && _dDn) _fadeVsTrend = true;
          } else {
            // fail-open (don't block on missing data) but LOG it so the protection gap is visible
            logEvent("filter", `[MR-FADE] ${stock.ticker} daily-trend check unavailable (no MA) — fade NOT gated this scan`);
          }
          // VWAP slope — INFORMATIONAL tag only (logged, NOT a blocker; promote to a gate later only if data earns it)
          const _vwSlope = (state._vwapSlope || {})[stock.ticker] ?? 0;
          const _vwTag = _vwSlope > 0.0001 ? "up" : (_vwSlope < -0.0001 ? "down" : "flat");
          const _vwWith = (_vwTag === (_mrDec.side === "put" ? "down" : "up")) ? "with" : (_vwTag === "flat" ? "flat" : "against");
          if (_fadeVsTrend) {
            recordStandDown("mrf", "fade vs daily trend");
            logEvent("filter", `[MR-FADE] ${stock.ticker} ${_mrDec.side} BLOCKED — fading against the daily trend (px vs 50d/100d); vwapSlope ${_vwTag}`);
          } else {
          const _hasPos = (state.positions || []).some(p => p.ticker === stock.ticker && p.optionType === _mrDec.side && !p.closed);
          if (_hasPos) {
            recordStandDown("mrf", "position already open");
            logEvent("filter", `[MR-FADE] ${stock.ticker} ${_mrDec.side} setup, but a ${_mrDec.side} position is already open — standing down`);
          } else {
            recordStandDown("mrf", "FIRED");
            logEvent("filter", `[MR-FADE] ${stock.ticker} FIRE — ${_mrDec.reason} | vwapSlope ${_vwTag} (${_vwWith} fade)`);
            stock._mrFade = _mrDec;                     // tags entryStrategy + carries invalidation into _entryX
            const _mrSigId = `${stock.ticker}-${_mrDec.side}-mrfade-${Date.now()}`;   // own signalId (the momentum _sigId is defined later — TDZ)
            const _mrScore = (typeof score === "number") ? score : 0;
            const _mrOK = await executeTrade(stock, price, _mrScore, [_mrDec.reason], state.vix, _mrDec.side, true, 1.0, null, null, _mrSigId);
            stock._mrFade = null;
            if (_mrOK) continue;                         // handled by the MR path this scan; skip the momentum entry
          }
          }
        } else {
          recordStandDown("mrf", _mrDec.reason);        // 8/25: tally the decline reason (regime / not-at-level / not-extreme)
        }
      } catch (_mrErr) { stock._mrFade = null; logEvent("filter", `[MR-FADE] ${stock.ticker} error: ${_mrErr && _mrErr.message}`); }
    }

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
        isMeanReversion: isMeanReversion === true, isIndex: stock.isIndex === true,
      structBreak: stock._structBreak || null, mrScalp: stock._mrScalp === true },   // 8/26: event-driven entries carve out score-era gates in evaluateEntry  // V3.2 (6/19) FIX: evaluateEntry carve-outs depend on these — were absent, forcing oversold MR calls to the 85 floor
      rb, state,
      { etHour: etHourNow, isLateDay, isLastHour, volDecline: _volDeclineExec,
        signals: { rsi: stock.rsi, dailyRsi: stock.dailyRsi || 50, macd: stock.macd || "neutral", macdCurl: stock.macdCurl || "none", adx: stock.adx ?? 20, orBreak: (() => {
          // 7/29 LATCH FIX: orBreak was a raw price-vs-level test, so once price broke the
          // opening-range low it stayed TRUE for the whole session with no way to clear. On a
          // sustained trend that is correct (7/29: QQQ faded 6% from the open and every blocked
          // call was iRSI 15-25 into it) — but on a BREAK-THEN-RECOVER day it would veto the
          // entire recovery leg. Release on a VWAP RECLAIM: the same signal that already ends the
          // put breakdown episode (_bdOff), so both sides now agree on when a breakdown is over.
          const _or = state._openRange?.[stock.ticker];
          const _px = stock.lastPrice || stock.price || 0;
          const _vw = stock.intradayVWAP || 0;   // liveStock carries it (scanner:1506); `signals` is scoped to the SCAN loop, not this execution loop
          if (!_or || !_or.locked || _px <= 0) return false;
          const _brokeOR   = _px < _or.low;
          const _reclaimed = _vw > 0 && _px > _vw;      // above own VWAP => breakdown is over
          return _brokeOR && !_reclaimed;
        })() },  // FIX (6/23, scope-corrected): plumb intraday rsi from the scored candidate. +orBreak (7/27) for the os-carve suppression. `stock` here is liveStock (see scored.push ~2093), and liveStock.rsi IS the intraday RSI. The prior version referenced `signals`, which lives in the SCORING loop (closes ~2104), not this execution loop — so it threw "signals is not defined" and crashed every scan at the evaluateEntry call.
        // 8/05: the UPSIDE mirror of orBreak — price above the opening-range HIGH and still above
        // its own VWAP. Same shape as the orBreak IIFE above, same scoping caveat (`stock` is
        // liveStock; `signals` is not in scope in this execution loop). Feeds the call momentum gate.
        orBreakUp: (() => {
          const _or = state._openRange?.[stock.ticker];
          const _px = stock.lastPrice || stock.price || 0;
          const _vw = stock.intradayVWAP || 0;
          if (!_or || !_or.locked || _px <= 0) return false;
          return _px > _or.high && (_vw <= 0 || _px > _vw);
        })(),
        vwapSlope: (state._vwapSlope || {})[stock.ticker] ?? 0,
        volPace:   stock.volPaceRatio ?? 1,
        gapState: stock._gapState || "flat", gapVwapRatio: stock._gapVwapRatio ?? 1, breadthMom: state._breadthMomentum ?? 0,  // #3 D2 carve-out inputs (present-tense tape)
        recentSameDir: recentSameDirMins, existingProfitPct, existingCreditProfitPct,
        drawdownMinScore: ddProtocol.minScore || MIN_SCORE, drawdownLevel: ddProtocol.level || "normal",
        agentSignal: (state._agentMacro || {}).signal || "neutral",
        experimentMode: paperDataActive(state), experimentMinScore: EXPERIMENT_CALL_FLOOR, experimentMinScorePut: EXPERIMENT_PUT_FLOOR,
        dataGather: dataGatherActive(DATA_GATHER_MODE) }   // 7/1 (Harrison): data-gather → entryEngine floors the gate at score 50
    );
    if (eeResult.pass && eeResult.minScoreTrace && eeResult.minScoreTrace.experiment) {
      const _expSideTag = optionType === "put" ? "PUT under-85-wall" : "CALL";
      logEvent("filter", `[EXPERIMENT-ENTRY ${_expSideTag}] ${stock.ticker} ${optionType.toUpperCase()} score ${score} @ exp-floor ${eeResult.minScore} (gap-bypass ${paperDataActive(state) ? "ON" : "OFF"}) — TAGGED for P&L isolation`);
    }
    if (!eeResult.pass) {
      logEvent("filter", `${stock.ticker} entry blocked - ${eeResult.reason}`);
      // 8/24: FALLING-KNIFE VETO LEDGER — the oversold/bearish-MACD dips APEX REFUSES to buy, stamped
      // with where the underlying went next. The direct mean-reversion test: if the vetoed dips bounced
      // (fwdPct > 0), the MR side is the edge and the veto is backwards. Same forward-stamp mechanism as
      // momoblocks/entryfwd. Observation only; wrapped so it can never disturb the scan.
      if (optionType === "call" && /falling-knife veto/.test(String(eeResult.reason || ""))) {
        try {
          if (!Array.isArray(state._vetoBlocks)) state._vetoBlocks = [];
          state._vetoBlocks.push({
            ticker: stock.ticker, side: optionType, at: Date.now(), px: price, score,
            rsi:      (typeof stock.rsi      === "number") ? parseFloat(stock.rsi.toFixed(1))      : null,
            dailyRsi: (typeof stock.dailyRsi === "number") ? parseFloat(stock.dailyRsi.toFixed(1)) : null,
            macd: stock.macd || "neutral",
            adx:      (typeof stock.adx      === "number") ? parseFloat(stock.adx.toFixed(0))      : null,
            fwdPct: null, fwdMins: null,
          });
          while (state._vetoBlocks.length > 500) state._vetoBlocks.shift();
        } catch (_vkErr) { /* observation only */ }
      }
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

      // ── 8/17: NEAR-MISS LEDGER ────────────────────────────────────────────
      // APEX only ever learns about trades it TOOK. Candidates rejected at the floor vanish into a
      // log line, so the floor itself has never been testable: you cannot ask "would the rejects
      // have won?" without the rejects. This records them with the same features the outcome row
      // carries, stamped 30 minutes later with where the underlying actually went — the momo-block
      // pattern applied to the score gate. Zero capital, roughly doubles the usable dataset, and it
      // is the only way to find out whether a floor of 75 discriminates or just reduces count.
      // Deduped per ticker+side+minute, same as the momo ledger, so it records EVENTS not scans.
      if (NEARMISS_LEDGER_ENABLED && !dryRunMode) {
        try {
          if (!state._nmLastMin) state._nmLastMin = {};
          const _nmKey = `${stock.ticker}-${optionType}`;
          const _nmMin = `${_nmKey}-${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }).slice(0, 5)}`;
          if (state._nmLastMin[_nmKey] !== _nmMin && price > 0) {
            state._nmLastMin[_nmKey] = _nmMin;
            if (!Array.isArray(state._nearMiss)) state._nearMiss = [];
            state._nearMiss.push({
              id: `${_nmKey}-${Date.now()}`, at: Date.now(), ticker: stock.ticker, side: optionType,
              score, reason: String(eeResult.reason || "").slice(0, 60), px: price,
              rsi: stock.rsi ?? null, dRsi: stock.dailyRsi ?? null, adx: signals.adx ?? null,
              rangePct: stock._intraRangePct ?? null, rangeRegime: stock._rangeRegime || null,
              rv: stock._rv ?? null, fwdPct: null, fwdMins: null,
            });
            while (state._nearMiss.length > 2000) state._nearMiss.shift();
          }
        } catch (_nmlErr) { /* observational */ }
      }
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

    // ── 8/05: CALL MOMENTUM GATE ────────────────────────────────────────────────────────
    // SUPERSEDED by CALL_BREAKOUT_MODE (constants.js). When breakout mode is ON, momentum is now
    // enforced inside scoring.js (the breakout channel + the suppression of the dip bonuses), so a
    // context-only or dip call no longer clears the floor and this standalone gate is redundant —
    // exactly how the PUT side works, where the score IS the gate (there is no separate put gate).
    // The `!CALL_BREAKOUT_MODE` guard on the gate below stands it down; flip the flag false to
    // re-arm it and restore the legacy dip-scoring path in one move. The shadow-report loop that
    // follows becomes a no-op because nothing populates state._momoShadow while the gate is off.
    //
    // Rationale kept for history: over 7/06-8/05 the put conjunction produced 25 puts, +$664, ZERO
    // never-green; the ungated call path produced 193 calls, -$2,348, 12% never-green. The score
    // was not missing an input — it pooled ~26 momentum pts with ~60+ of context and let context
    // alone clear the floor. Breakout mode fixes that in the score itself, not with a bolt-on gate.
    try {
      const _spxNow = stock.lastPrice || stock.price || 0;
      if (_spxNow > 0 && Array.isArray(state._momoShadow) && state._momoShadow.length) {
        const _now = Date.now(); const _keep = [];
        for (const _sh of state._momoShadow) {
          if (_sh.t !== stock.ticker) { _keep.push(_sh); continue; }
          const _mins = (_now - _sh.at) / 60000;
          if (_mins < MOMO_SHADOW_MINS) { _keep.push(_sh); continue; }
          const _mv = _sh.px > 0 ? ((_spxNow - _sh.px) / _sh.px * 100) : 0;
          logEvent("scan",
            `[CALL-MOMO-SHADOW] ${_sh.t} blocked ${_mins.toFixed(0)}min ago at ${_sh.px.toFixed(2)} ` +
            `(score ${_sh.score}, evidence ${_sh.ev}) — underlying now ${_spxNow.toFixed(2)}, ` +
            `moved ${_mv >= 0 ? "+" : ""}${_mv.toFixed(2)}%`);
          // stamp the outcome onto the durable ledger row so the EOD report can score the gate
          try {
            const _row = (state._momoBlocks || []).find(r => r.id === _sh.id);
            if (_row) { _row.fwdPct = parseFloat(_mv.toFixed(3)); _row.fwdMins = Math.round(_mins); }
          } catch (_ldgErr) { /* ledger stamping is observational */ }
        }
        state._momoShadow = _keep;
      }
    } catch (_shErr) { /* observation only */ }

    if (!CALL_BREAKOUT_MODE && optionType === "call") {
      const _or        = state._openRange?.[stock.ticker];
      const _px        = stock.lastPrice || stock.price || 0;
      const _vw        = stock.intradayVWAP || 0;
      const _mOrUp     = !!(_or && _or.locked && _px > 0 && _px > _or.high && (_vw <= 0 || _px > _vw));
      // 8/14: capture the RAW inputs alongside the booleans so the ledger can record how far each
      // confirmation missed by, not merely that it missed.
      const _mSlopeV   = (state._vwapSlope || {})[stock.ticker] ?? 0;
      const _mVolV     = stock.volPaceRatio ?? 1;
      const _mBrV      = state._breadthMomentum ?? 0;
      const _mSlope    = _mSlopeV >= CALL_MOMO_SLOPE_MIN;
      const _mVol      = _mVolV > CALL_MOMO_VOLPACE_MIN && _vw > 0 && _px >= _vw;
      const _mBreadth  = _mBrV >= CALL_MOMO_BREADTH_MIN;
      const _mCount    = [_mOrUp, _mSlope, _mVol, _mBreadth].filter(Boolean).length;
      const _mWhich    = [_mOrUp && "OR-high", _mSlope && "vwap-up", _mVol && "vol-pace", _mBreadth && "breadth-up"]
                           .filter(Boolean).join("+") || "none";
      // STRICT: mirror the put conjunction — structure mandatory, plus one confirmation.
      const _mPass = CALL_MOMO_STRICT
        ? (_mOrUp && (_mSlope || _mVol || _mBreadth))
        : (_mCount >= CALL_MOMENTUM_MIN);
      if (!_mPass) {
        if (CALL_MOMENTUM_ENFORCE) {
          logEvent("filter", `[CALL-MOMO] ${stock.ticker} BLOCKED — ${CALL_MOMO_STRICT ? "strict: needs OR-high + 1 confirm" : `needs ${CALL_MOMENTUM_MIN}`}, have ${_mWhich} | score ${score}`);
          try {
            if (!Array.isArray(state._momoShadow)) state._momoShadow = [];
            // 8/12: _momoShadow is DRAINED as each block is reported (the _keep filter above), so
            // by the close it holds only the last 30 minutes. The gate blocks all day and that
            // evidence was going nowhere but the server log — not the outcome table, not the EOD
            // report, not efficacy. On a day where CALL-MOMO blocks everything, these ARE the only
            // records the session produces. _momoBlocks is a parallel ledger that is never drained:
            // one row per block, stamped with the forward move when the shadow fires.
            const _mId = `${stock.ticker}-${Date.now()}-${Math.round(_px * 100)}`;
            // 8/14 FIX: DEDUPE THE SHADOW BUFFER TOO. The per-minute dedupe below was applied only to
            // _momoBlocks; _momoShadow kept pushing on EVERY scan against MOMO_SHADOW_MAX=200. At ~8s
            // scans x 2 tickers that is ~15 pushes/min, so the buffer held only ~13 minutes of history
            // and shift() evicted each entry LONG before its 30-minute follow-up could fire. Live cost:
            // 8/14 recorded 524 blocks and stamped only 4 forward moves. 8/13 survived purely because
            // block volume was low enough (90) never to saturate. Gate both buffers on the same key:
            // 2 pushes/min x 30 min = 60 entries needed, well inside the 200 cap.
            if (!state._momoLastMin) state._momoLastMin = {};
            const _mMinKey = `${stock.ticker}-${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }).slice(0, 5)}`;
            const _mDupe   = state._momoLastMin[stock.ticker] === _mMinKey;
            state._momoLastMin[stock.ticker] = _mMinKey;
            if (_px > 0 && !_mDupe) state._momoShadow.push({ id: _mId, t: stock.ticker, at: Date.now(), px: _px, score, ev: _mWhich });
            while (state._momoShadow.length > MOMO_SHADOW_MAX) state._momoShadow.shift();
            // 8/12 FIX: DEDUPE TO ONE ROW PER TICKER PER MINUTE. The first live file recorded 600
            // rows in 82 minutes — one every 8.2s, i.e. one per SCAN, not one per event. Only 124
            // were distinct (ticker, evidence, minute): 4.8x duplication. Worse, the cap evicts
            // OLDEST first, so a full session at that rate (~2,850 rows) would retain only the last
            // 82 minutes and DROP the entire morning — which is exactly where intraday range lives
            // and where the DTE question gets answered. One row per ticker per minute keeps a whole
            // session inside the cap and makes each row an event rather than a sample.
            if (!Array.isArray(state._momoBlocks)) state._momoBlocks = [];
            if (_px > 0 && !_mDupe) state._momoBlocks.push({
              id: _mId, ticker: stock.ticker, at: Date.now(), px: _px, score,
              evidence: _mWhich, orHigh: _mOrUp, slope: _mSlope, volPace: _mVol, breadth: _mBreadth,
              // 8/14: RAW VALUES, not just the booleans. Three sessions of blocks told us the
              // confirmations never fire but not HOW FAR off they were, so the recalibration above
              // had to be part guess. Recording the actuals means the next tune reads a distribution.
              slopeVal:   (typeof _mSlopeV === 'number' && Number.isFinite(_mSlopeV)) ? parseFloat(_mSlopeV.toFixed(6)) : null,
              volPaceVal: (typeof _mVolV   === 'number' && Number.isFinite(_mVolV))   ? parseFloat(_mVolV.toFixed(3))   : null,
              breadthVal: (typeof _mBrV    === 'number' && Number.isFinite(_mBrV))    ? parseFloat(_mBrV.toFixed(2))    : null,
              fwdPct: null, fwdMins: null,
            });
            while (state._momoBlocks.length > 2000) state._momoBlocks.shift();
          } catch (_shErr2) { /* observation only */ }
          continue;
        }
        logEvent("filter", `[CALL-MOMO] ${stock.ticker} would BLOCK — ${CALL_MOMO_STRICT ? "strict: needs OR-high + 1 confirm" : `needs ${CALL_MOMENTUM_MIN}`}, have ${_mWhich} | score ${score} | SHADOW ONLY`);
      } else {
        logEvent("scan", `[CALL-MOMO] ${stock.ticker} pass — ${_mCount} evidence (${_mWhich})`);
      }
    }

    // ── 8/09: RANGE GOVERNOR (call-only, shadow-first) ──────────────────────────────────
    // Five days of telemetry: the -$1000 days had ~0.5% intraday range and APEX fired MOST trades
    // on them; the green days had 1.6-3.6%. A call needs a real up-move to reach +12.5%, and a
    // <1% tape has none. This throttles calls when the range-so-far is compressed, but only after
    // the range has had time to develop. SHADOW until RANGE_GOVERNOR_ENFORCE — it records eRangePct
    // on every outcome row so the floor is validated from data before it blocks anything.
    // 8/11 FIX 3: MR-SCALP IS EXEMPT. The scalp carries its own range gate (MR_SCALP_RANGE_MIN_PCT = 0.6%)
    // and the two rails were fighting: the governor's flat 1.0% floor blocked scalps that the scalp's own
    // gate had already cleared, so the one disciplined call channel could never fire on a 0.6-1.0% tape.
    // Safe because FIX 1 above revoked _mrScalp on every non-call candidate — reaching here with the flag
    // set means a genuine call scalp that already passed a stricter, purpose-built range test.
    // 8/11 FIX 4: THE FLOOR IS NOW SESSION-SCALED. 1.0% is a FULL-DAY target but was compared against
    // range-SO-FAR, so at 10:30am it demanded a whole day's range from one hour of tape and over-blocked
    // perfectly normal mornings. Now pro-rated by sqrt(elapsed session fraction) — sqrt, not linear,
    // because realized range grows ~with the square root of time. ~0.39% at 60min, ~0.62% at 2.5h, 1.0%
    // at the close. The 8/10 0.25% dead tape still fails at every hour of the day; a normal 0.5%-by-11am
    // morning now passes instead of being blocked on a target it could not yet have met.
    if (optionType === "call" && RANGE_GOVERNOR_ENABLED && !stock._mrScalp) {
      const _rng     = stock._intraRangePct;
      const _sessMin = state._sessionMinsNow ?? 0;
      const _rgFullMin   = RANGE_GOVERNOR_FULL_SESSION_MIN > 0 ? RANGE_GOVERNOR_FULL_SESSION_MIN : 390;
      const _rgSessFrac  = Math.min(1, Math.max(0, _sessMin / _rgFullMin));
      // 8/17: SCALE THE FLOOR BY THE TENOR BEING BOUGHT. Mirrors the targetDTE resolution in
      // execution.js:~294 — these two MUST stay in sync; if the DTE default changes there, this
      // reads the wrong tenor and the governor silently mis-gates. Required move scales ~with
      // premium, which scales ~sqrt(DTE), so the floor does too. 40DTE -> 1.00%, 3DTE -> 0.27%.
      const _rgDTE       = stock._mrScalp ? MR_SCALP_TARGET_DTE : 3;
      const _rgDteScale  = Math.sqrt(Math.max(1, _rgDTE) / Math.max(1, RANGE_GOVERNOR_REF_DTE));
      const _rgFloor     = RANGE_GOVERNOR_FLOOR_PCT * Math.sqrt(_rgSessFrac) * _rgDteScale;
      if (_rng != null && _sessMin >= RANGE_GOVERNOR_MIN_SESSION_MIN && _rng < _rgFloor) {
        if (RANGE_GOVERNOR_ENFORCE) {
          logEvent("filter", `[RANGE-GOVERNOR] ${stock.ticker} call BLOCKED — intraday range ${_rng}% < ${_rgFloor.toFixed(2)}% scaled floor (${_sessMin.toFixed(0)}min in; ${RANGE_GOVERNOR_FLOOR_PCT}% full-day target, ${_rgDTE}DTE scale ${_rgDteScale.toFixed(2)}) — dead tape, no move to catch | score ${score}`);
          continue;
        }
        logEvent("filter", `[RANGE-GOVERNOR] ${stock.ticker} call would BLOCK — intraday range ${_rng}% < ${_rgFloor.toFixed(2)}% scaled floor (${_sessMin.toFixed(0)}min) | score ${score} | SHADOW ONLY`);
      }
    }

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
      // 8/03: was a score raise to 85 with a high-score bypass; now a HARD HALT. With C1-B no
      // longer gating entries, this dollar-based lock at -$500 is the only daily guard left, so
      // it should stop trading rather than make trading marginally harder. A bypass would defeat
      // the point. Exits are unaffected and keep running.
      logEvent("filter", `[C1-A] ${stock.ticker} blocked — daily loss lock active (todayRealizedPnL $${(state.todayRealizedPnL||0).toFixed(0)} ); no new entries for the rest of the session`);
      continue;
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
      // 8/17: ONE id per DECISION, shared by every leg it fans out to. Without it the A/B/C
      // triple-leg writes three outcome rows that no downstream analysis can tell apart from
      // three independent trades, and every N inflates 3x.
      // counter suffix: Date.now() has 1ms resolution, so two decisions for the same ticker+side
      // inside one millisecond would share an id and be silently clustered as one. The exec loop
      // makes that impossible today, but nothing enforces it and a collision is unrecoverable
      // after the fact.
      state._sigSeq = (state._sigSeq || 0) + 1;
      const _sigId = `${stock.ticker}-${optionType}-${Date.now()}-${state._sigSeq}`;
      // 8/24: VOLPACE SPLIT-BOOK ARM. "vf" enters ONLY on elevated volume pace (the one pre-trade
      // signal with a real within-day direction pulse); "ctl" is the unchanged control. Assignment is
      // a HASH of the full signal id, NOT sequence parity — the entry loop is score-sorted and
      // _sigSeq is a running counter, so raw parity pins the top-scored ticker to one arm every scan
      // (SPY always odd -> ctl, QQQ always even -> vf), confounding the A/B with ticker. mr-scalp is
      // exempt from the gate (its own channel; excluded in analysis via entryStrategy). feasRatio rides
      // every row, so volPace x feasibility is evaluated in analysis, not as a live (post-fill) reject.
      let _armH = 0; for (let _c = 0; _c < _sigId.length; _c++) _armH = ((_armH * 31) + _sigId.charCodeAt(_c)) | 0;
      const _arm = (Math.abs(_armH) % 2 === 0) ? "vf" : "ctl";
      stock._arm = _arm;
      // 8/24: SELF-CALIBRATING vf gate. volPace runs on an unknown/drifting scale (day-1 median ~0.64,
      // nowhere near the old 1.5 guess), so gate on a rolling PERCENTILE of recent signal volPace rather
      // than a fixed number — the vf arm takes the top (100-PCTILE)% by pace regardless of scale. Buffer
      // carries across days (persisted, not daily-reset) and warms after WARMUP obs; before that vf takes all.
      const _vp = (typeof stock.volPaceRatio === "number") ? stock.volPaceRatio : null;
      if (!Array.isArray(state._vpBuf)) state._vpBuf = [];
      let _vpThresh = -Infinity;
      if (state._vpBuf.length >= VOLPACE_ARM_WARMUP) {
        const _vs = state._vpBuf.slice().sort((a, b) => a - b);
        _vpThresh = _vs[Math.floor((VOLPACE_ARM_PCTILE / 100) * (_vs.length - 1))];
      }
      if (_vp != null) { state._vpBuf.push(_vp); if (state._vpBuf.length > VOLPACE_ARM_WINDOW) state._vpBuf.shift(); }
      if (VOLPACE_ARM_ENABLED && _arm === "vf" && !stock._mrScalp &&
          !(_vp != null && _vp >= _vpThresh && _vp >= VOLPACE_ARM_MIN)) {
        // 8/24: VF-SKIP LEDGER — record what the vf arm PASSED ON, with a forward-move stamp, so
        // "did the filter avoid bad trades" is answerable (the skip counterfactual). Same shape as entryFwd.
        try {
          if (!Array.isArray(state._vfSkip)) state._vfSkip = [];
          state._vfSkip.push({
            signalId: _sigId, ticker: stock.ticker, side: optionType, at: Date.now(), px: price, score,
            volPace: (typeof stock.volPaceRatio === "number") ? parseFloat(stock.volPaceRatio.toFixed(3)) : null,
            fwdPct: null, fwdMins: null,
          });
          while (state._vfSkip.length > 500) state._vfSkip.shift();
        } catch (_vfsErr) { /* observation only */ }
        logEvent("filter", `[VF-ARM] ${stock.ticker} ${optionType} skip — volPace ${(_vp ?? 0).toFixed(2)} < p${VOLPACE_ARM_PCTILE} ${(_vpThresh === -Infinity ? "warmup" : _vpThresh.toFixed(2))} (n=${state._vpBuf.length}; logged to vf-skip ledger)`);
        continue;
      }
      if (stock._mrScalp) {
        // 8/09: MR-SCALP is a SINGLE low-vega leg (NOT the A/B/C twin-entry), half size. executeTrade
        // reads stock._mrScalp → forces 0-1 DTE + 0.42Δ and tags the position entryStrategy="mr-scalp".
        logEvent("filter", `[MR-SCALP] ${stock.ticker} entering single 0-1DTE leg @ ${MR_SCALP_SIZE_MOD}x size`);
        entered = await executeTrade(stock, price, score, reasons, state.vix, "call", true, MR_SCALP_SIZE_MOD, "sameweek", null, _sigId);
      } else if (dataGatherActive(DATA_GATHER_MODE)) {
        // 6/30 (Harrison): A/B twin-entry. One signal → two positions, one per DTE band, each sized
        // independently under the normal caps. Legs tagged (dteBand) for comparison. A leg failing to
        // fill (no contract in its band) does not block the other.
        // 8/03 (Harrison): now A/B/C. The 9-16 DTE band had ZERO trades in 20 sessions, so the
        // biweekly leg is here to BUY that data, not because it is expected to win. Cost-matched
        // to the standard leg like same-week, so the three are directly comparable on P&L.
        // NOTE this deploys ~50% more capital per signal — watch heat rejections.
        logEvent("filter", `[TWIN-ENTRY] ${stock.ticker} ${optionType.toUpperCase()} score ${score} — opening same-week + biweekly + standard legs`);
        const _legStd = await executeTrade(stock, price, score, reasons, state.vix, optionType, isMeanReversion, _sizeModNaked, "standard", null, _sigId);
        const _stdCost = (_legStd && _legStd.cost) ? _legStd.cost : null;   // 7/7 (Harrison): standard leg's actual cost → size the other legs to match it (equal capital A/B/C). null if standard didn't fill → they fall back to normal 1-contract sizing.
        const _legSW  = await executeTrade(stock, price, score, reasons, state.vix, optionType, isMeanReversion, _sizeModNaked, "sameweek", _stdCost, _sigId);
        const _legBW  = await executeTrade(stock, price, score, reasons, state.vix, optionType, isMeanReversion, _sizeModNaked, "biweekly", _stdCost, _sigId);
        entered = _legSW || _legBW || _legStd;
        logEvent("filter", `[TWIN-ENTRY] ${stock.ticker} result — sameweek:${_legSW ? "FILLED" : "no-fill"} biweekly:${_legBW ? "FILLED" : "no-fill"} standard:${_legStd ? "FILLED" : "no-fill"}`);
      } else {
        entered = await executeTrade(stock, price, score, reasons, state.vix, optionType, isMeanReversion, _sizeModNaked, null, null, _sigId);
      }
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
  ensureDailyTrend,
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
