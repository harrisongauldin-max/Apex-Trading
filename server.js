// -
// ARGO V2.84 - Systematic SPY/QQQ Options Trading Agent
// Alpaca Paper Trading Edition
// -
const express    = require("express");
const { getRegimeRulebook, scoreCandidate: EE_scoreCandidate, evaluateEntry } = require("./entryengine.js");
const cron       = require("node-cron");
const fetch      = require("node-fetch");
const fs         = require("fs");
const path       = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// - Environment Variables (set in Railway) -
const ALPACA_KEY        = process.env.ALPACA_API_KEY    || "";
const ALPACA_SECRET     = process.env.ALPACA_SECRET_KEY || "";
const ALPACA_BASE       = "https://paper-api.alpaca.markets/v2";
const ALPACA_DATA       = "https://data.alpaca.markets/v2";
const ALPACA_OPTIONS    = "https://paper-api.alpaca.markets/v2";    // confirmed: options contracts
const ALPACA_OPT_SNAP   = "https://data.alpaca.markets/v1beta1";    // confirmed: options snapshots/greeks
const ALPACA_NEWS       = "https://data.alpaca.markets/v1beta1";    // news endpoint lives on v1beta1 not v2

// - Data Cache - declared early so all functions can use it -
// Slow-changing data cached to reduce API calls and Railway connection pressure
const _slowCache     = new Map(); // key: "type:ticker", value: { data, ts }
const SLOW_CACHE_TTL = 5  * 60 * 1000; // 5 min - news, analyst, premarket
const BARS_CACHE_TTL = 60 * 60 * 1000; // 60 min - daily bars don't change intraday

function getCached(key, ttl = SLOW_CACHE_TTL) {
  const entry = _slowCache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}
function setCache(key, data) { _slowCache.set(key, { data, ts: Date.now() }); return data; }
const GMAIL_USER        = process.env.GMAIL_USER        || "";
const RESEND_API_KEY    = process.env.RESEND_API_KEY    || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL   = "claude-sonnet-4-5";  // Best quality/cost for financial reasoning
const STATE_FILE        = path.join(__dirname, "state.json");
const REDIS_URL         = process.env.UPSTASH_REDIS_REST_URL  || "";
const REDIS_TOKEN       = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REDIS_KEY         = "spt1:state";
const REDIS_SAVE_INTERVAL = 30 * 1000; // 30s minimum between Redis writes
let lastRedisSave = 0;     // timestamp of last successful Redis save
let stateDirty    = false; // true when state has unsaved changes

// - Trading Constants -
const MONTHLY_BUDGET      = 10000;
const CAPITAL_FLOOR       = 7500; // max 25% drawdown on $10k account - raised from $3k (70% drawdown was unsafe)
const REVENUE_THRESHOLD   = 2000;
const BONUS_AMOUNT        = 1000;
const MAX_HEAT            = 0.60; // base cap - reduced dynamically at elevated VIX (see effectiveHeatCap())
// PM-C1: Growth vs preservation phase switch
// Below $15k: growth mode - full risk budget to reach PDT threshold
// $15k-$20k: transition - moderate controls while protecting gains
// Above $20k: preservation - protect the capital needed for live deployment
function getAccountPhase() {
  const accountVal = (state.alpacaCash || state.cash || 0) + openCostBasis();
  if (accountVal >= 20000) return "preservation";
  if (accountVal >= 15000) return "transition";
  return "growth";
}
const effectiveHeatCap = (strategyType) => {
  const phase = getAccountPhase();
  // 3C: Heat cap differentiation by strategy type (panel decision)
  // Debit spreads / correlated credit spreads: standard caps (defined below)
  // Iron condors (defined risk both sides): 80% max - panel endorsed
  // Credit spreads, sector-diverse: 75% max - only when XLE/KRE added
  if (strategyType === "iron_condor") {
    if (phase === "preservation") return 0.40;
    return 0.80; // defined risk both directions
  }
  if (strategyType === "credit_diverse") {
    if (phase === "preservation") return 0.45;
    return 0.75; // diverse sectors, defined risk
  }
  // Default: debit spreads and correlated credit spreads
  if (phase === "preservation") return state.vix >= 25 ? 0.30 : 0.40;
  if (phase === "transition")   return state.vix >= 30 ? 0.35 : state.vix >= 25 ? 0.45 : 0.50;
  return state.vix >= 30 ? 0.40 : state.vix >= 25 ? 0.50 : MAX_HEAT;
};
const MAX_SECTOR_PCT      = 0.50;
const STOP_LOSS_PCT       = 0.35;
const FAST_STOP_PCT       = 0.20;   // -20% in first 48hrs
const FAST_STOP_HOURS     = 48;
const TAKE_PROFIT_PCT     = 0.50;  // fallback only - spread positions use per-position takeProfitPct stamped at entry
const PARTIAL_CLOSE_PCT   = 0.18;  // partial at 18% - lock in gains early
const TRAIL_ACTIVATE_PCT  = 0.15;   // start trailing at +15% - tightened with new targets
const TRAIL_STOP_PCT      = 0.15;   // trail 15% below peak
const BREAKEVEN_LOCK_PCT  = 0.40;   // lock to breakeven at +40%
const RIDE_TARGET_PCT     = 1.00;   // let remainder ride to +100%
const TIME_STOP_DAYS      = 7;
const TIME_STOP_MOVE      = 0.05;
const IV_COLLAPSE_PCT     = 0.30;
const MA50_BUFFER         = 0.01;
const IVR_MAX             = 70;
const EARNINGS_SKIP_DAYS  = 5;
const MIN_OPEN_INTEREST   = 100;  // used in contract scoring as OI proxy threshold
const MIN_STOCK_PRICE     = 20;
const MIN_OPTION_PREMIUM  = 0.50;  // minimum $50 per contract - filters out lottery tickets
const MIN_OI              = 5;     // hard block - OI < 5 means essentially no market
const MAX_SPREAD_PCT      = 0.30;  // hard block - spread > 30% makes fills unprofitable (was 0.15)
const EARLY_SPREAD_PCT    = 0.10;  // tighter spread required for early 9:45AM put entries
const MAX_GAP_PCT         = 0.03;
const TARGET_DELTA_MIN    = 0.28;
const TARGET_DELTA_MAX    = 0.42;
// MM-C1: Contract selection priority order (explicit):
// 1. OTM% target from VIX level sets the strike zone
// 2. Delta filtering WITHIN that zone - rejects contracts outside 0.28-0.42
// 3. If no contract in delta range, widen delta range (crash mode) rather than use OTM%
// OTM% wins for strike zone; delta wins for contract selection within that zone
// MAX_TRADES_PER_DAY removed - portfolio heat (60%) controls position limits
// CONSEC_LOSS_LIMIT removed - consecutive loss counter was removed (gambler's fallacy).
// Each trade is independent. Size reduction handles drawdown, not entry blocking.
const WEEKLY_DD_LIMIT     = 0.25;
const MAX_LOSS_PER_TRADE  = 900;
const MIN_SCORE           = 70;

// Instrument-level execution constraints - enforced at execution entry, not inferred from gate state
// This is the authoritative rule for what trade types each instrument may execute
// Panel unanimous: these constraints must survive any gate condition shift between scoring and execution
const INSTRUMENT_CONSTRAINTS = {
  TLT: { allowedTypes: ["credit_put", "credit_call"], reason: "Bond ETF - slow movement, only collect premium" },
  GLD: { allowedTypes: ["credit_put", "credit_call", "debit_put"], reason: "Commodity hedge - debit calls only on equity selloffs" },
  SPY: { allowedTypes: ["credit_put", "credit_call", "debit_put", "debit_call", "iron_condor", "debit_naked"] },
  QQQ: { allowedTypes: ["credit_put", "credit_call", "debit_put", "debit_call", "iron_condor", "debit_naked"] },
  XLE: { allowedTypes: ["debit_put"], reason: "Energy ETF - directional puts on downtrend only" },
};
// Entry windows handled by isEntryWindow() - see function below
const STOCK_PROFIT_THRESH = 1000;   // monthly profit threshold for stock buys
const STOCK_ALLOC_PCT     = 0.20;   // 20% of profits above threshold
const MAX_STOCK_PCT       = 0.30;   // max 30% of account in stocks
const STOCK_STOP_PCT      = 0.15;   // -15% stop on stock positions

// Cash ETF parking - floor is split 50/50 between liquid and BIL

// VIX tiers
const VIX_REDUCE25  = 25;
const VIX_REDUCE50  = 30;
const VIX_PAUSE     = 35;

// New feature constants
const DRAWDOWN_RECOVERY_PCT    = 0.15;  // trigger recovery mode at -15% drawdown
const DRAWDOWN_SIZING_REDUCE   = 0.25;  // reduce sizing by 25% in recovery mode
const FAST_PROFIT_PCT          = 0.40;  // accelerate target if +40% in 48hrs
const FAST_PROFIT_HOURS        = 48;
const PREMARKET_STRONG_MOVE    = 0.015; // 1.5% pre-market move = strong signal
const PREMARKET_NEGATIVE       = -0.01; // -1% pre-market = skip entry
const RESISTANCE_BUFFER        = 0.02;  // skip if within 2% of resistance
const SUPPORT_BUFFER           = 0.03;  // skip if within 3% of support breaking

// Time constants
const MS_PER_DAY = 86400000; // milliseconds per day

// Correlation groups - max 1 position per group
const CORRELATION_GROUPS = [
  ["NVDA", "AMD", "SMCI", "ARM", "AVGO", "MU"],           // Semiconductors
  ["AAPL", "MSFT", "GOOGL", "CRM", "NOW", "SNOW"],         // Mega-cap / cloud tech
  ["AMZN", "META", "TTD", "ROKU"],                          // Ad / cloud / e-commerce / streaming
  ["JPM", "BAC", "WFC", "C"],                                            // Money center banks
  ["MS"],                                                                 // Investment banks
  ["COIN", "HOOD", "MSTR", "SQ", "MARA"],                              // Crypto / fintech
  ["TSLA", "UBER"],                                          // Consumer mobility / EV
  ["CRWD", "PANW", "NET"],                                   // Cybersecurity
  ["NFLX", "SHOP", "DKNG", "NKE"],                          // Consumer / retail
  ["PLTR"],                                                   // High momentum
];

// Always check SMH for semiconductor stocks
const SEMIS = ["NVDA", "AMD", "SMCI", "ARM", "AVGO", "MU"];

// - Watchlist (36 high-liquidity stocks) -
// - ARGO-V2.5 Instrument Configuration -
// Phase 1: SPY primary, QQQ secondary - building to $25k
// At $25k: set INDIVIDUAL_STOCKS_ENABLED = true to unlock full watchlist
const INDIVIDUAL_STOCKS_ENABLED = false;
const ACCOUNT_THRESHOLD_25K     = 25000; // PDT-free threshold

const PDT_LIMIT = 3;   // max day trades before block (limit is 3, 4th triggers PDT flag)
const PDT_DAYS  = 5;   // rolling business day window

const WATCHLIST = [
  // - PRIMARY: SPY - macro regime trading -
  {
    ticker:    "SPY",
    sector:    "Index",
    momentum:  "steady",
    rsi:       50,
    macd:      "neutral",
    catalyst:  "Macro regime",
    ivr:       30,
    beta:      1.0,
    earningsDate: null,
    isIndex:   true,
    isPrimary: true,
  },
  // - SECONDARY: QQQ - tech-heavy, use when tech thesis is clear -
  {
    ticker:    "QQQ",
    sector:    "Index",
    momentum:  "steady",
    rsi:       50,
    macd:      "neutral",
    catalyst:  "Tech macro regime",
    ivr:       32,
    beta:      1.2,
    earningsDate: null,
    isIndex:   true,
    isPrimary: false,
  },
  // IWM REMOVED - 3-year backtest confirmed net loser at all score thresholds
  // 2022: -$1,826 | 2023: -$985 | 2024: -$985 | 3yr @ 75: -$1,305
  // Panel unanimous 8/8: instrument not compatible with mean-reversion scoring
  // - HEDGE 1: GLD - gold ETF, inverse correlation in risk-off environments -
  // Entry gated by: DXY not strengthening + SPY stressed + VIX>20 + Score 80+
  {
    ticker:    "GLD",
    sector:    "Commodity",
    momentum:  "steady",
    rsi:       50,
    macd:      "neutral",
    catalyst:  "Risk-off flight to gold",
    ivr:       20,
    beta:      -0.1,  // negative beta = hedge against equity drawdown
    earningsDate: null,
    isIndex:   true,  // treated as index for liquidity/OI purposes
    isPrimary: false,
  },
  // - HEDGE 2: TLT - 20yr Treasury Bond ETF -
  // Panel unanimous (8/8): best portfolio hedge for equity stress
  // Negative correlation to SPY (-0.50 in stress), RSI/MACD signals work cleanly
  // Entry gated by: SPY below 50MA + score 75+ + direction-aware
  {
    ticker:    "TLT",
    sector:    "Bonds",
    momentum:  "steady",
    rsi:       50,
    macd:      "neutral",
    catalyst:  "Rate/recession hedge - bonds rally when equities fall",
    ivr:       20,
    beta:      -0.5,  // strong negative beta = best equity stress hedge
    earningsDate: null,
    isIndex:   true,
    isPrimary: false,
  },
  // - ENERGY: XLE - Energy Select Sector SPDR -
  // Panel unanimous (9/9): first expansion beyond 4-instrument universe
  // Driven by oil price + geopolitics - independent of equity sentiment (corr 0.55 vs SPY)
  // Options ADV 26,153 - liquid enough for spread fills
  // Entry gated by: oil trend + VIX context + score 75+
  {
    ticker:    "XLE",
    sector:    "Energy",
    momentum:  "steady",
    rsi:       50,
    macd:      "neutral",
    catalyst:  "Oil price + energy geopolitics - independent macro driver",
    ivr:       30,
    beta:      0.80,
    earningsDate: null,
    isIndex:   true,   // treated as index - same scoring path as SPY/QQQ
    isPrimary: false,
  },
];

// - Individual stocks - unlocked at $25k -
// Full watchlist preserved here, activated when INDIVIDUAL_STOCKS_ENABLED = true
const INDIVIDUAL_STOCK_WATCHLIST = [
  { ticker:"NVDA",  sector:"Technology",  momentum:"strong",     rsi:58, macd:"bullish crossover",  catalyst:"AI infrastructure demand",      ivr:52, beta:1.8, earningsDate:null },
  { ticker:"AAPL",  sector:"Technology",  momentum:"steady",     rsi:52, macd:"mild bullish",       catalyst:"Services revenue growth",       ivr:28, beta:1.1, earningsDate:null },
  { ticker:"MSFT",  sector:"Technology",  momentum:"strong",     rsi:56, macd:"bullish",            catalyst:"Copilot enterprise adoption",   ivr:30, beta:1.2, earningsDate:null },
  { ticker:"AMZN",  sector:"Technology",  momentum:"strong",     rsi:61, macd:"bullish",            catalyst:"AWS acceleration",              ivr:35, beta:1.3, earningsDate:null },
  { ticker:"META",  sector:"Technology",  momentum:"strong",     rsi:63, macd:"bullish",            catalyst:"AI ad revenue momentum",        ivr:40, beta:1.4, earningsDate:null },
  { ticker:"GOOGL", sector:"Technology",  momentum:"steady",     rsi:54, macd:"mild bullish",       catalyst:"Search + cloud strength",       ivr:32, beta:1.2, earningsDate:null },
  { ticker:"AMD",   sector:"Technology",  momentum:"recovering", rsi:47, macd:"forming base",       catalyst:"MI300X server demand",          ivr:55, beta:1.7, earningsDate:null },
  { ticker:"ARM",   sector:"Technology",  momentum:"strong",     rsi:62, macd:"bullish crossover",  catalyst:"AI chip architecture demand",   ivr:58, beta:1.9, earningsDate:null },
  { ticker:"AVGO",  sector:"Technology",  momentum:"strong",     rsi:57, macd:"bullish",            catalyst:"AI networking chips",           ivr:38, beta:1.4, earningsDate:null },
  { ticker:"TSLA",  sector:"Consumer",    momentum:"recovering", rsi:44, macd:"neutral",            catalyst:"Q1 delivery data",              ivr:61, beta:2.0, earningsDate:null },
  { ticker:"PLTR",  sector:"Technology",  momentum:"strong",     rsi:65, macd:"bullish crossover",  catalyst:"Government AI contracts",       ivr:62, beta:2.0, earningsDate:null },
  { ticker:"SHOP",  sector:"Consumer",    momentum:"steady",     rsi:52, macd:"mild bullish",       catalyst:"E-commerce market share gains", ivr:52, beta:1.6, earningsDate:null },
  { ticker:"CRWD",  sector:"Technology",  momentum:"strong",     rsi:60, macd:"bullish",            catalyst:"Cybersecurity spending surge",  ivr:48, beta:1.6, earningsDate:null },
  { ticker:"PANW",  sector:"Technology",  momentum:"strong",     rsi:57, macd:"bullish",            catalyst:"Platform consolidation wins",   ivr:40, beta:1.4, earningsDate:null },
  { ticker:"JPM",   sector:"Financial",   momentum:"strong",     rsi:57, macd:"bullish",            catalyst:"Net interest income strength",  ivr:28, beta:1.1, earningsDate:null },
  { ticker:"MS",    sector:"Financial",   momentum:"steady",     rsi:52, macd:"mild bullish",       catalyst:"Investment banking cycle",      ivr:28, beta:1.4, earningsDate:null },
  { ticker:"NFLX",  sector:"Consumer",    momentum:"strong",     rsi:60, macd:"bullish",            catalyst:"Ad-supported tier growth",      ivr:38, beta:1.4, earningsDate:null },
];

// - Default State -
function defaultState() {
  return {
    cash:             MONTHLY_BUDGET,
    extraBudget:      0,
    customBudget:     0,
    totalRevenue:     0,
    positions:        [],
    stockPositions:   [],
    closedTrades:     [],
    tradeLog:         [],
    tradeJournal:     [],
    todayTrades:      0,
    consecutiveLosses:0,
    dayTrades:        [],   // rolling log of day trades [{date, ticker, openTime, closeTime}]
    monthStart:       new Date().toLocaleDateString(),
    weekStartCash:    MONTHLY_BUDGET,
    dayStartCash:     MONTHLY_BUDGET,
    circuitOpen:      true,
    weeklyCircuitOpen:true,
    monthlyProfit:    0,
    peakCash:         MONTHLY_BUDGET,
    lastScan:         null,
    vix:              15,
    dataQuality:      { realTrades: 0, estimatedTrades: 0, totalTrades: 0 },
    tickerBlacklist:  [], // tickers blocked for today - clears on morning reset
    exitStats:        {}, // running tally per exit reason: { count, wins, totalPnl, avgPnl, winRate }
    agentAutoExitEnabled: false, // controlled by dashboard toggle
    _agentRescoreHour:   {}, // tracks last rescore hour per ticker (overnight)
    _agentRescoreMinute: {}, // tracks last rescore time per ticker (same-day)
    _avoidUntil:         null,  // timestamp until which entries are blocked after avoid signal
    _agentHealth:        { calls: 0, successes: 0, timeouts: 0, parseErrors: 0, lastSuccess: null },
    _macroReversalAt:    null,  // timestamp of last macro-reversal exit batch
    _macroReversalCount: 0,     // how many positions closed in the reversal batch
    _macroReversalSPY:   null,  // SPY price at time of reversal - for comparison
    _dayPlan:            null,  // agent day plan - set at 6am, updated at 7:30am and 8:30am
    _dayPlanDate:        null,  // date of last day plan - reset daily
    _recentLosses:       {},    // ticker -> {closedAt, reason, agentSignal, price} for re-entry veto
    _agentHistory:       {},    // ticker -> last 5 rescore results for agent memory
    portfolioSnapshots: [], // time-series portfolio value: [{t, v}] sampled every 5 min
    _pendingOrder:       null, // in-flight mleg order: {orderId, ticker, type, submittedAt, ...}
    // V2.81 RSI tracking fields (panel fix)
    _oversoldCount:      {},   // ticker -> consecutive DAYS with daily RSI <=35
    _oversoldDate:       {},   // ticker -> last date _oversoldCount was incremented (prevents scan-level inflation)
    _rsiHistory:         {},   // ticker -> last 5 daily RSI readings for velocity penalty
    _intradayOversoldScans: {}, // ticker -> consecutive intraday scans with RSI <=35 (stabilization gate)
  };
}

// - Redis Helpers -
// - Local filesystem backup for Redis failure protection -
// If Redis fails during open positions, ARGO loads from this backup on restart
// Written after every trade - prevents catastrophic state loss
const BACKUP_FILE = path.join(__dirname, "state_backup.json");
async function writeLocalBackup(data) {
  try {
    const critical = {
      positions:      data.positions      || [],
      dayTrades:      data.dayTrades      || [],
      cash:           data.cash           || 0,
      dayStartCash:   data.dayStartCash   || 0,
      weekStartCash:  data.weekStartCash  || 0,
      peakCash:       data.peakCash       || 0,
      closedTrades:   (data.closedTrades  || []).slice(-50),
      scoreBrackets:  data.scoreBrackets  || {},
      consecutiveLosses: data.consecutiveLosses || 0,
      _savedAt:       new Date().toISOString(),
      _backup:        true,
    };
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(critical));
  } catch(e) {} // non-blocking - never throw on backup failure
}

async function redisSave(data) {
  // Always write local backup first - protects against Redis failure during open positions
  await writeLocalBackup(data);
  // Strip large recalculable fields before saving - reduces payload from ~10MB to <500KB
  // marketContext is rebuilt every 5 minutes - no need to persist to Redis
  // scoreReasons in tradeJournal are display-only - trim to save space
  const slim = {
    ...data,
    // Trim tradeJournal entries - keep essentials, drop verbose scoreReasons
    tradeJournal: (data.tradeJournal || []).slice(0, 100).map(function(t) {
      return {
        time: t.time, ticker: t.ticker, action: t.action, strike: t.strike,
        expDate: t.expDate, premium: t.premium, contracts: t.contracts,
        cost: t.cost, score: t.score, delta: t.delta, iv: t.iv, vix: t.vix,
        optionType: t.optionType, pnl: t.pnl, pct: t.pct, reason: t.reason,
        washSaleFlag: t.washSaleFlag || false,
        scoreReasons: (t.scoreReasons || []).slice(0, 8), // F13: keep up to 8 for transparency
      };
    }),
    // tradeLog is display-only - keep last 100
    tradeLog: (data.tradeLog || []).slice(0, 100),
    // closedTrades - keep last 200 (was 500)
    closedTrades: (data.closedTrades || []).slice(0, 200),
    // stockTrades - keep last 50
  };
  // Never persist marketContext - it's recalculated every 5 min
  delete slim._marketContextCache;

  // Always write full state to local file as backup
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); } catch(e) {}

  if (!REDIS_URL || !REDIS_TOKEN) return;

  try {
    const serialized = JSON.stringify(slim);
    const sizeKB = Math.round(serialized.length / 1024);
    if (sizeKB > 8000) {
      console.error(`[REDIS] WARNING: Payload ${sizeKB}KB approaching 10MB limit`);
    }
    // Use Upstash pipeline endpoint - most reliable format, no double-encoding ambiguity
    // Pipeline body: array of commands, each command is [cmd, key, value]
    // C3: Redis fetch with 5-second timeout -- prevents scan freeze on hung write
    const _redisController = new AbortController();
    const _redisTimeout = setTimeout(() => _redisController.abort(), 5000);
    let res;
    try {
      res = await fetch(`${REDIS_URL}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify([["set", REDIS_KEY, serialized]]),
        signal: _redisController.signal,
      });
    } finally { clearTimeout(_redisTimeout); }
    const result = await res.json();
    // Pipeline returns array of results: [{result:"OK"}]
    if (result[0] && result[0].error) {
      console.error("[REDIS] Save error:", result[0].error);
    } else {
      console.log(`[REDIS] Saved OK (${sizeKB}KB)`);
    }
  } catch(e) { console.error("[REDIS] Save error:", e.message); }
}

async function redisLoad() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    // Fallback to file
    try {
      if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch(e) {}
    return null;
  }
  // Retry up to 3 times - Redis may not be reachable on cold container start
  // Silent failure here causes state to reset to $10k default - catastrophic in live trading
  const MAX_RETRIES  = 3;
  const RETRY_DELAY  = 2000; // 2 seconds between retries
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Use pipeline GET - consistent with how we save
      // C3: 5-second timeout prevents startup hang on unresponsive Redis
      const _loadCtrl  = new AbortController();
      const _loadTimer = setTimeout(() => _loadCtrl.abort(), 5000);
      let res;
      try {
        res = await fetch(`${REDIS_URL}/pipeline`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${REDIS_TOKEN}`,
            "Content-Type": "application/json"
          },
          body:   JSON.stringify([["get", REDIS_KEY]]),
          signal: _loadCtrl.signal,
        });
      } finally { clearTimeout(_loadTimer); }
      const data = await res.json();
      // Pipeline returns [{result: "value_string"}]
      const raw = data && data[0] && data[0].result;
      if (raw) {
        if (attempt > 1) console.log(`[REDIS] Loaded on attempt ${attempt}`);
        // raw is the JSON string we saved - parse it directly
        let parsed = JSON.parse(raw);
        // Safety: handle any legacy double-encoded formats
        if (typeof parsed === 'string') {
          console.log("[REDIS] Detected double-encoded string - parsing again");
          parsed = JSON.parse(parsed);
        }
        // Handle old {value:"..."} wrapped format from very early versions
        if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string' && !parsed.cash) {
          console.log("[REDIS] Detected old wrapped format - unwrapping");
          parsed = JSON.parse(parsed.value);
        }
        return parsed;
      }
      // Null result = key doesn't exist yet (fresh account)
      return null;
    } catch(e) {
      console.error(`[REDIS] Load attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`[REDIS] Retrying in ${RETRY_DELAY/1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  // All retries failed - this is dangerous in live trading
  console.error("[REDIS] CRITICAL: All load attempts failed - starting with saved file or defaults");
  console.error("[REDIS] If live trading, check Upstash connection immediately");
  // Try file fallback as last resort
  try {
    if (fs.existsSync(STATE_FILE)) {
      console.log("[REDIS] Using local file fallback");
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch(e) {
    console.log("[REDIS] Load failed:", e.message, "- trying local backup");
    try {
      if (fs.existsSync(BACKUP_FILE)) {
        const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
        if (backup._backup && backup.positions) {
          console.log(`[REDIS] Loaded local backup (${backup.positions.length} positions)`);
          return backup;
        }
      }
    } catch(be) { console.log("[REDIS] Backup load failed:", be.message); }
    return null;
  }
}
async function saveState() {
  stateDirty = true;
  const now = Date.now();
  if (now - lastRedisSave >= REDIS_SAVE_INTERVAL) {
    try {
      await redisSave(state);
      lastRedisSave = now;
      stateDirty    = false;
    } catch(e) { console.error("saveState error:", e.message); }
  }
}

// Mark state as dirty - flushed by dedicated 30s interval
// Use instead of saveState() for non-critical updates that don't need immediate persist
function markDirty() { stateDirty = true; }

// Force save - used for critical state changes (trade open/close, circuit breaker)
async function saveStateNow() {
  try {
    await redisSave(state);
    lastRedisSave = Date.now();
    stateDirty    = false;
  } catch(e) { console.error("saveStateNow error:", e.message); }
}

// Periodic flush - saves if dirty but not recently saved
async function flushStateIfDirty() {
  if (stateDirty && Date.now() - lastRedisSave >= REDIS_SAVE_INTERVAL) {
    // C5: Trim unbounded arrays before each save -- prevents Redis payload bloat
    // Upstash has a 1MB value limit. Silent write failures lose state on restart.
    if (state.closedTrades && state.closedTrades.length > 250)
      state.closedTrades = state.closedTrades.slice(-200);
    if (state._gateAudit && state._gateAudit.length > 150)
      state._gateAudit = state._gateAudit.slice(-100);
    if (state._agentAccuracy && state._agentAccuracy.pending && state._agentAccuracy.pending.length > 100)
      state._agentAccuracy.pending = state._agentAccuracy.pending.slice(-50);
    try {
      await redisSave(state);
      lastRedisSave = Date.now();
      stateDirty    = false;
    } catch(e) { console.error("flushStateIfDirty error:", e.message); }
  }
}

// State initialized async on startup
let state = defaultState();
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

      state = { ...defaultState(), ...saved };
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
  if (!state._vixRolling || state._vixRolling.length < 30 || _ivRollingRange < 5) {
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

// - Standalone reconciliation - runs on startup AND every 5 minutes -
// Detects ghost positions (ARGO has them, Alpaca doesn't) and orphans (Alpaca
// has them, ARGO doesn't). Reconstructs orphaned positions so ARGO can track
// and exit them properly. Also syncs BIL ETF shares.
async function runReconciliation() {
  if (!ALPACA_KEY) return;
  try {
    const alpacaPositions = await alpacaGet("/positions");
    if (!alpacaPositions || !Array.isArray(alpacaPositions)) return;

    const alpacaSymbols = new Set(alpacaPositions.map(p => p.symbol));
    let ghosts = 0, orphans = 0;

    // - Update currentPrice on existing positions from Alpaca data -
    for (const pos of state.positions) {
      const alpPos = alpacaPositions.find(p =>
        p.symbol === pos.contractSymbol ||
        p.symbol === pos.buySymbol ||
        p.symbol === pos.sellSymbol
      );
      if (alpPos) {
        const mktVal  = parseFloat(alpPos.market_value || 0);
        const qty     = Math.abs(parseInt(alpPos.qty || 1));
        const curP    = qty > 0 && mktVal > 0 ? parseFloat((mktVal / (qty * 100)).toFixed(2)) : pos.currentPrice;
        if (curP > 0) pos.currentPrice = curP;
        // Update POP from live delta (market maker: track current not entry POP)
        if (alpPos.greeks?.delta) {
          pos.probabilityOfProfit = parseFloat(((1 - Math.abs(parseFloat(alpPos.greeks.delta))) * 100).toFixed(1));
        }
      }
    }

    // - Ghost detection - ARGO has position, Alpaca doesn't -
    for (const pos of [...state.positions]) {
      const symbols = [pos.contractSymbol, pos.buySymbol, pos.sellSymbol].filter(Boolean);
      // A spread is a ghost only if BOTH legs are missing from Alpaca
      const allMissing = symbols.length > 0 && symbols.every(s => !alpacaSymbols.has(s));
      // V2.84 fix: positions with NO symbols stored (estimated entries, pre-spread architecture)
      // cannot be matched by symbol -- fall back to checking if Alpaca has ANY option on this ticker
      const noSymbolsStored = symbols.length === 0;
      const alpacaHasTickerOption = alpacaPositions.some(p => {
        const underlying = p.symbol?.match(/^([A-Z]+)\d{6}[CP]/)?.[1];
        return underlying === pos.ticker;
      });
      const symbollessGhost = noSymbolsStored && !alpacaHasTickerOption;
      if (allMissing || symbollessGhost) {
        const ghostReason = symbollessGhost ? "no contract symbols stored + Alpaca empty for ticker" : "closed externally";
        logEvent("warn", `[RECONCILE] Ghost: ${pos.ticker} ${pos.contractSymbol||pos.buySymbol||"(no symbol)"} - ${ghostReason}`);
        const idx = state.positions.indexOf(pos);
        if (idx === -1) { logEvent("warn", `[RECONCILE] splice guard: ${pos.ticker} not found in positions array`); continue; }
        state.positions.splice(idx, 1);
        state.closedTrades.push({
          ticker: pos.ticker, pnl: 0, pct: "0", reason: "reconcile-removed",
          date: new Date().toLocaleDateString(), score: pos.score || 0, closeTime: Date.now(),
          tradeType: pos.isCreditSpread ? "credit_spread" : pos.isSpread ? "debit_spread" : "naked",
        });
        ghosts++;
      }
    }

    // - Orphan detection - Alpaca has position, ARGO doesn't -
    // Only reconstruct orphans for active watchlist tickers - prevents IWM and removed
    // instruments from being resurrected on every restart causing reconciliation loops
    const activeTickers = new Set([
      ...WATCHLIST.map(w => w.ticker),
      ...(INDIVIDUAL_STOCKS_ENABLED ? INDIVIDUAL_STOCK_WATCHLIST.map(w => w.ticker) : []),
    ]);

    const orphanedAlpaca = alpacaPositions.filter(alpPos => {
      if (!/^[A-Z]+\d{6}[CP]\d{8}$/.test(alpPos.symbol)) return false;
      const underlyingTicker = alpPos.symbol.match(/^([A-Z]+)\d{6}[CP]/)?.[1];
      if (underlyingTicker && !activeTickers.has(underlyingTicker)) {
        logEvent("warn", `[RECONCILE] Skipping orphan for removed ticker ${underlyingTicker} (${alpPos.symbol}) - not in active watchlist`);
        return false;
      }
      return !state.positions.find(p =>
        p.contractSymbol === alpPos.symbol ||
        p.buySymbol      === alpPos.symbol ||
        p.sellSymbol     === alpPos.symbol
      );
    });

    if (orphanedAlpaca.length > 0) {
      orphans = orphanedAlpaca.length;
      // Parse each orphan
      const parsed = orphanedAlpaca.map(alpPos => {
        const sym      = alpPos.symbol;
        const isCall   = /\d{6}C\d{8}$/.test(sym);
        const optType  = isCall ? 'call' : 'put';
        const strikeM  = sym.match(/[CP](\d{8})$/);
        const strike   = strikeM ? parseFloat(strikeM[1]) / 1000 : 0;
        const expM     = sym.match(/(\d{2})(\d{2})(\d{2})[CP]/);
        const expDate  = expM
          ? new Date(`20${expM[1]}-${expM[2]}-${expM[3]}`).toLocaleDateString('en-US', {month:'short',day:'2-digit',year:'numeric'})
          : '';
        const expDays  = expDate ? Math.max(1, Math.round((new Date(expDate) - new Date()) / MS_PER_DAY)) : 30;
        const qty      = parseInt(alpPos.qty || 1);
        const avgEntry = parseFloat(alpPos.avg_entry_price || 0);
        const mktVal   = parseFloat(alpPos.market_value || 0);
        const ticker   = sym.match(/^([A-Z]+)\d/)?.[1] || 'SPY';
        return { sym, ticker, optType, strike, expDate, expDays, qty, avgEntry, mktVal, alpPos };
      });

      // Pair spread legs: long + short, same ticker+expiry, ~$10 apart
      const used = new Set();
      for (let i = 0; i < parsed.length; i++) {
        if (used.has(i)) continue;
        const a = parsed[i];
        let paired = false;
        for (let j = i + 1; j < parsed.length; j++) {
          if (used.has(j)) continue;
          const b = parsed[j];
          const sameTickerExp = a.ticker === b.ticker && a.expDate === b.expDate && a.optType === b.optType;
          // Width cap raised to 25 - spread widths scale with VIX (up to $20 at VIX 35)
          // Previous cap of 12 caused $14+ wide spreads to be reconciled as individual legs
          const widthOk = Math.abs(a.strike - b.strike) >= 5 && Math.abs(a.strike - b.strike) <= 25;
          const oppDir  = (a.qty > 0 && b.qty < 0) || (a.qty < 0 && b.qty > 0);
          if (sameTickerExp && widthOk && oppDir) {
            const longLeg  = a.qty > 0 ? a : b;
            const shortLeg = a.qty > 0 ? b : a;
            const buyLeg   = a.optType === 'put'
              ? (longLeg.strike > shortLeg.strike ? longLeg : shortLeg)
              : (longLeg.strike < shortLeg.strike ? longLeg : shortLeg);
            const sellLeg  = buyLeg === longLeg ? shortLeg : longLeg;
            const netDebit = parseFloat((buyLeg.avgEntry - Math.abs(sellLeg.avgEntry)).toFixed(2));
            const spreadWidth = Math.abs(buyLeg.strike - sellLeg.strike);
            state.positions.push({
              ticker: a.ticker, optionType: a.optType,
              isSpread: true, buyStrike: buyLeg.strike, sellStrike: sellLeg.strike,
              spreadWidth, buySymbol: buyLeg.sym, sellSymbol: sellLeg.sym,
              contractSymbol: buyLeg.sym,
              premium: Math.max(0.01, netDebit), maxProfit: parseFloat((spreadWidth - Math.max(0.01, netDebit)).toFixed(2)),
              maxLoss: Math.max(0.01, netDebit), contracts: Math.abs(buyLeg.qty),
              expDate: a.expDate, expDays: a.expDays,
              cost: parseFloat((Math.max(0.01, netDebit) * 100 * Math.abs(buyLeg.qty)).toFixed(2)),
              score: 75, reasons: ['Reconstructed spread from Alpaca reconciliation'],
              openDate: buyLeg.alpPos.created_at || new Date().toISOString(),
              currentPrice: Math.max(0.01, netDebit), peakPremium: Math.max(0.01, netDebit),
              entryRSI: 50, entryMACD: 'neutral', entryMomentum: 'steady', entryMacro: 'neutral',
              entryThesisScore: 100, thesisHistory: [], agentHistory: [],
              realData: true, vix: state.vix || 20, entryVIX: state.vix || 20,
              expiryType: 'monthly', dteLabel: 'RECONCILED-SPREAD',
              partialClosed: false, isMeanReversion: false, trailStop: null,
              breakevenLocked: false, halfPosition: false,
              target: parseFloat((Math.max(0.01, netDebit) * 1.5).toFixed(2)),
              stop: parseFloat((Math.max(0.01, netDebit) * 0.65).toFixed(2)),
              takeProfitPct: TAKE_PROFIT_PCT, fastStopPct: STOP_LOSS_PCT,
            });
            used.add(i); used.add(j); paired = true;
            logEvent("warn", `[RECONCILE] Reconstructed SPREAD: ${a.ticker} \$${buyLeg.strike}/\$${sellLeg.strike} ${a.optType.toUpperCase()} exp ${a.expDate}`);
            break;
          }
        }
        if (!paired) {
          const p = a;
          const curP = p.mktVal > 0 ? p.mktVal / (Math.abs(p.qty) * 100) : p.avgEntry;
          state.positions.push({
            ticker: p.ticker, optionType: p.optType, isSpread: false,
            strike: p.strike, contractSymbol: p.sym,
            buySymbol: p.qty > 0 ? p.sym : null,
            sellSymbol: p.qty < 0 ? p.sym : null,
            premium: p.avgEntry, currentPrice: curP,
            breakeven: p.optType === 'put'
              ? parseFloat((p.strike - p.avgEntry).toFixed(2))
              : parseFloat((p.strike + p.avgEntry).toFixed(2)),
            contracts: Math.abs(p.qty), expDate: p.expDate, expDays: p.expDays,
            cost: Math.abs(p.mktVal) || parseFloat((p.avgEntry * 100 * Math.abs(p.qty)).toFixed(2)),
            score: 75, reasons: ['Reconstructed from Alpaca reconciliation'],
            openDate: p.alpPos.created_at || new Date().toISOString(), peakPremium: p.avgEntry,
            entryRSI: 50, entryMACD: 'neutral', entryMomentum: 'steady', entryMacro: 'neutral',
            entryThesisScore: 100, thesisHistory: [], agentHistory: [],
            realData: true, vix: state.vix || 20, entryVIX: state.vix || 20,
            expiryType: 'monthly', dteLabel: 'RECONCILED',
            partialClosed: false, isMeanReversion: false, trailStop: null,
            breakevenLocked: false, halfPosition: false,
            target: parseFloat((p.avgEntry * 1.5).toFixed(2)),
            stop: parseFloat((p.avgEntry * 0.65).toFixed(2)),
            takeProfitPct: TAKE_PROFIT_PCT, fastStopPct: STOP_LOSS_PCT,
          });
          used.add(i);
          logEvent("warn", `[RECONCILE] Reconstructed leg: ${p.ticker} ${p.optType.toUpperCase()} \$${p.strike} exp ${p.expDate} | ${Math.abs(p.qty)}x @ \$${p.avgEntry}`);
        }
      }
    }

    // BIL ETF removed - cash parked in spreads instead

    if (ghosts > 0 || orphans > 0) {
      logEvent("warn", `[RECONCILE] ${ghosts} ghost(s) removed, ${orphans} orphan(s) reconstructed`);
      await redisSave(state);
    }

    // - Re-pair existing individual legs into spreads -
    // Handles case where legs were previously reconciled individually
    // but should be tracked as a spread pair
    let pairsFound = 0;
    const toRemove = new Set();
    const toAdd    = [];

    for (let i = 0; i < state.positions.length; i++) {
      if (toRemove.has(i)) continue;
      const a = state.positions[i];
      if (a.isSpread) continue; // already a spread
      if (!a.contractSymbol) continue;

      for (let j = i + 1; j < state.positions.length; j++) {
        if (toRemove.has(j)) continue;
        const b = state.positions[j];
        if (b.isSpread) continue;
        if (!b.contractSymbol) continue;

        // Same ticker, same expiry, same option type, ~$10 apart, opposite direction
        const sameTickerExp = a.ticker === b.ticker && a.expDate === b.expDate && a.optionType === b.optionType;
        const strikeA = a.strike || 0;
        const strikeB = b.strike || 0;
        const width   = Math.abs(strikeA - strikeB);
        const widthOk = width >= 8 && width <= 22; // allow up to $20 wide
        // One should be long (no sellSymbol), one short (has sellSymbol or negative cost)
        const aIsShort = a.sellSymbol && !a.buySymbol;
        const bIsShort = b.sellSymbol && !b.buySymbol;
        const oppDir   = aIsShort !== bIsShort;

        if (sameTickerExp && widthOk && oppDir) {
          const buyLeg  = !aIsShort ? a : b;
          const sellLeg = aIsShort  ? a : b;
          const buyIdx  = !aIsShort ? i : j;
          const sellIdx = aIsShort  ? i : j;
          const netDebit = parseFloat((buyLeg.premium - sellLeg.premium).toFixed(2));
          const curNet   = parseFloat(((buyLeg.currentPrice || buyLeg.premium) - (sellLeg.currentPrice || sellLeg.premium)).toFixed(2));

          const merged = {
            ticker:      a.ticker, optionType: a.optionType,
            isSpread:    true,
            buyStrike:   buyLeg.strike, sellStrike: sellLeg.strike,
            spreadWidth: width,
            buySymbol:   buyLeg.contractSymbol,
            sellSymbol:  sellLeg.contractSymbol,
            contractSymbol: buyLeg.contractSymbol,
            premium:     Math.max(0.01, netDebit),
            maxProfit:   parseFloat((width - Math.max(0.01, netDebit)).toFixed(2)),
            maxLoss:     Math.max(0.01, netDebit),
            contracts:   Math.max(buyLeg.contracts || 1, sellLeg.contracts || 1),
            expDate:     a.expDate, expDays: a.expDays,
            cost:        parseFloat((Math.max(0.01, netDebit) * 100 * Math.max(buyLeg.contracts||1, sellLeg.contracts||1)).toFixed(2)),
            score:       Math.max(buyLeg.score || 75, sellLeg.score || 75),
            reasons:     ['Re-paired from individual legs'],
            openDate:    buyLeg.openDate || new Date().toISOString(),
            currentPrice: Math.max(0.01, curNet),
            peakPremium: Math.max(0.01, netDebit),
            entryRSI: buyLeg.entryRSI || 50, entryMACD: 'neutral',
            entryMomentum: 'steady', entryMacro: 'neutral',
            entryThesisScore: 100, thesisHistory: [], agentHistory: [],
            realData: true, vix: state.vix || 20, entryVIX: state.vix || 20,
            expiryType: 'monthly', dteLabel: 'RECONCILED-SPREAD',
            partialClosed: false, isMeanReversion: false, trailStop: null,
            breakevenLocked: false, halfPosition: false,
            target: parseFloat((Math.max(0.01, netDebit) * 1.5).toFixed(2)),
            stop:   parseFloat((Math.max(0.01, netDebit) * 0.65).toFixed(2)),
            takeProfitPct: TAKE_PROFIT_PCT, fastStopPct: STOP_LOSS_PCT,
          };
          toRemove.add(buyIdx);
          toRemove.add(sellIdx);
          toAdd.push(merged);
          pairsFound++;
          logEvent("warn", `[RECONCILE] Re-paired: ${a.ticker} $${buyLeg.strike}/$${sellLeg.strike} ${a.optionType.toUpperCase()} exp ${a.expDate}`);
          break;
        }
      }
    }

    if (pairsFound > 0) {
      state.positions = state.positions.filter((_, idx) => !toRemove.has(idx));
      state.positions.push(...toAdd);
      logEvent("warn", `[RECONCILE] Re-paired ${pairsFound} spread(s) from individual legs`);
      await redisSave(state);
    }

    state.lastReconcile    = new Date().toISOString();
    state.reconcileStatus  = ghosts === 0 && orphans === 0 && pairsFound === 0 ? "ok" : "warning";
    state.orphanCount      = orphans;

  } catch(e) {
    logEvent("error", `[RECONCILE] Failed: ${e.message}`);
  }
}


function logEvent(type, message) {
  const entry = { time: new Date().toISOString(), type, message };
  state.tradeLog.unshift(entry);
  if (state.tradeLog.length > 500) state.tradeLog = state.tradeLog.slice(0, 500);
  // V2.83: also append to daily log buffer for EOD archival to Redis
  // Separate from tradeLog so the live 500-entry rolling buffer is not affected
  if (!state._dailyLogBuffer) state._dailyLogBuffer = [];
  state._dailyLogBuffer.push(entry);
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// V2.83: Save daily log to Redis at EOD
// Key format: argo:logs:YYYY-MM-DD -- stores full day's log entries
// At ~500 entries/day avg 150 chars = ~75KB/day compressed
// Upstash free tier 256MB = 3+ years of daily logs before hitting limit
async function saveDailyLogToRedis() {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    const dateStr  = getETTime().toISOString().slice(0, 10); // YYYY-MM-DD
    const logKey   = `argo:logs:${dateStr}`;
    const logData  = JSON.stringify({
      date:     dateStr,
      entries:  state._dailyLogBuffer || [],
      summary: {
        totalEntries: (state._dailyLogBuffer || []).length,
        trades:       (state._dailyLogBuffer || []).filter(e => e.type === "trade").length,
        errors:       (state._dailyLogBuffer || []).filter(e => e.type === "error").length,
        warns:        (state._dailyLogBuffer || []).filter(e => e.type === "warn").length,
        closedToday:  (state.closedTrades || []).filter(t => t.closeTime && new Date(t.closeTime).toISOString().slice(0,10) === dateStr).length,
        cashEOD:      state.cash,
        positionsEOD: state.positions.length,
      }
    });
    // Save with 90-day TTL (7,776,000 seconds) -- auto-expire old logs
    const res = await fetch(`${REDIS_URL}/set/${logKey}`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ value: logData, ex: 7776000 }),
    });
    if (res.ok) {
      logEvent("scan", `[EOD LOG] Daily log saved to Redis: ${logKey} | ${(state._dailyLogBuffer||[]).length} entries`);
      state._dailyLogBuffer = []; // reset buffer for next day
      markDirty();
    } else {
      console.error("[EOD LOG] Redis save failed:", res.status);
    }
  } catch(e) {
    console.error("[EOD LOG] Daily log save error:", e.message);
  }
}

// - Dynamic Signal Calculators -
// Calculate RSI from price bars
function calcRSI(bars, period = 14) {
  if (bars.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const change = bars[i].c - bars[i-1].c;
    if (change > 0) gains  += change;
    else            losses -= change;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs  = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

// Calculate EMA from array of closes
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// Calculate MACD signal from price bars
function calcMACD(bars) {
  if (bars.length < 26) return { signal: "neutral", value: 0 };
  const closes  = bars.map(b => b.c);
  const ema12   = calcEMA(closes.slice(-12), 12);
  const ema26   = calcEMA(closes.slice(-26), 26);
  const macdVal = ema12 - ema26;
  const signal  = calcEMA(
    bars.slice(-9).map((_, i) => {
      const e12 = calcEMA(closes.slice(-(26 - 8 + i)), 12);
      const e26 = calcEMA(closes.slice(-(26)), 26);
      return e12 - e26;
    }), 9
  );
  const histogram = macdVal - signal;
  if (histogram > 0.5)       return { signal: "bullish crossover", value: macdVal };
  if (histogram > 0)         return { signal: "bullish",           value: macdVal };
  if (histogram < -0.5)      return { signal: "bearish crossover", value: macdVal };
  if (histogram < 0)         return { signal: "bearish",           value: macdVal };
  return { signal: "neutral", value: macdVal };
}

// Determine momentum from bars
function calcMomentum(bars) {
  if (bars.length < 20) return "steady";
  const recent5  = (bars[bars.length-1].c - bars[bars.length-5].c)  / bars[bars.length-5].c;
  const recent20 = (bars[bars.length-1].c - bars[bars.length-20].c) / bars[bars.length-20].c;
  if (recent5 > 0.03 && recent20 > 0.05)  return "strong";
  if (recent5 < -0.03 || recent20 < -0.05) return "recovering";
  return "steady";
}

// Calculate IV Rank - where is current IV vs 52-week range
// - F15: OI clustering / max pain -

function calcATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const recent = bars.slice(-(period + 1));
  let atrSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const high  = recent[i].h || recent[i].c;
    const low   = recent[i].l || recent[i].c;
    const prev  = recent[i-1].c;
    atrSum += Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  }
  return parseFloat((atrSum / period).toFixed(4));
}

function calcADX(bars, period = 14) {
  if (bars.length < period + 1) return 20;
  let dmPlus = 0, dmMinus = 0, atr = 0;
  for (let i = bars.length-period; i < bars.length; i++) {
    const high = bars[i].h, low = bars[i].l, prevClose = bars[i-1]?.c || bars[i].c;
    const prevHigh = bars[i-1]?.h || high, prevLow = bars[i-1]?.l || low;
    dmPlus  += Math.max(high - prevHigh, 0);
    dmMinus += Math.max(prevLow - low, 0);
    atr     += Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose));
  }
  if (atr === 0) return 20;
  const diPlus  = (dmPlus/atr)*100;
  const diMinus = (dmMinus/atr)*100;
  const dx      = Math.abs(diPlus-diMinus) / (diPlus+diMinus||1) * 100;
  return parseFloat(dx.toFixed(1));
}

function calcIVRank(currentIV, bars) {
  if (bars.length < 30) return 50;
  // Approximate historical vol from price bars
  const returns = [];
  for (let i = 1; i < bars.length; i++) {
    returns.push(Math.abs(Math.log(bars[i].c / bars[i-1].c)));
  }
  const avgVol  = returns.reduce((s, r) => s + r, 0) / returns.length;
  const annVol  = avgVol * Math.sqrt(252) * 100;
  const minVol  = Math.min(...returns) * Math.sqrt(252) * 100;
  const maxVol  = Math.max(...returns) * Math.sqrt(252) * 100;
  const ivr     = maxVol > minVol ? ((currentIV * 100 - minVol) / (maxVol - minVol)) * 100 : 50;
  return Math.min(Math.max(parseFloat(ivr.toFixed(0)), 0), 100);
}

// Full dynamic signal analysis for a stock
// Uses intraday 1-min bars for RSI/MACD/momentum (real-time, prefetched in parallel)
// Falls back to daily bars for trend context and IV calculation
async function getLiveBeta(ticker) {
  // Fetch beta from Alpaca snapshot fundamentals
  // Falls back to watchlist value if unavailable
  try {
    const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
    if (snap && snap.fundamentals && snap.fundamentals.beta) {
      return parseFloat(snap.fundamentals.beta);
    }
    // Some snapshots return beta in a different field
    if (snap && snap.beta) return parseFloat(snap.beta);
  } catch(e) {}
  return null; // null = use watchlist fallback
}

async function getDynamicSignals(ticker, bars, intradayBars = null, realOptionsIV = null) {
  // Cache signals within scan window - same bars = same signals
  const sigKey = `sigs:${ticker}:${(bars||[]).length}`;
  // OPT-3: 90s TTL -- intraday momentum changes minute-to-minute, 5min cache is too stale
  const sigCached = _slowCache.get(sigKey);
  if (sigCached && (Date.now() - sigCached.ts) < 90000) return sigCached.data;
  // Use prefetched intraday bars if provided, otherwise fetch now
  if (!intradayBars) intradayBars = await getIntradayBars(ticker);
  const signalBars   = intradayBars.length >= 10 ? intradayBars : bars;

  // RSI: TWO values calculated separately (V2.81 panel fix)
  // rsi: 1-min intraday bars -- for display, VWAP timing, and momentum direction only
  // dailyRsi: daily bars -- for ALL entry scoring thresholds (70/35 calibrated on daily data by Wilder)
  // Panel finding: RSI can move 7+ points in 10 seconds on 1-min bars -- not a regime signal
  // MACD: daily bars ONLY - intraday MACD (12/26/9) produces false crossovers on sub-daily data
  // Technical analyst fix: standardize MACD to daily timeframe
  const rsi      = calcRSI(signalBars);                          // intraday RSI -- display/timing only
  const dailyRsi = bars.length >= 14 ? calcRSI(bars) : rsi;     // daily RSI -- all scoring thresholds
  const macd     = calcMACD(bars.length >= 26 ? bars : signalBars); // daily preferred
  // TA-W2: ATR from daily bars - normalizes signal interpretation
  const atrRaw   = calcATR(bars.length >= 15 ? bars : signalBars, 14);
  const atrPct   = atrRaw && bars.length > 0 ? atrRaw / bars[bars.length-1].c : null; // ATR as % of price

  // Momentum from intraday - is it moving up or down TODAY?
  let momentum;
  if (intradayBars.length >= 10) {
    const first = intradayBars[0].c;
    const last  = intradayBars[intradayBars.length - 1].c;
    const move  = (last - first) / first;
    const recentMove = intradayBars.length >= 6
      ? (last - intradayBars[intradayBars.length - 6].c) / intradayBars[intradayBars.length - 6].c
      : move;
    // Strong intraday move > 1.5% = strong, 0.5-1.5% = steady, negative = recovering (bearish)
    if (move > 0.015 && recentMove > 0.005)        momentum = "strong";
    else if (move < -0.005 || recentMove < -0.005) momentum = "recovering"; // bearish intraday
    else                                            momentum = "steady";
  } else {
    momentum = calcMomentum(bars); // fall back to daily
  }

  const adx = calcADX(signalBars.length >= 14 ? signalBars : bars);

  // IV rank + IV Percentile - both use daily bars for historical context
  // IVR: where is IV in its 52-week range
  // IV Percentile: what % of days had lower IV (more accurate measure)
  const recentBars = bars.slice(-20);
  const returns    = recentBars.slice(1).map((b, i) => Math.log(b.c / recentBars[i].c));
  const stdDev     = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
  const currentIV  = stdDev * Math.sqrt(252);
  const ivr        = calcIVRank(currentIV, bars);

  // IV Percentile - % of days where IV was lower than today
  // Uses realized vol from price bars as proxy for IV history
  // When real options IV is available (passed in), it replaces the approximation
  let ivPercentile = 50; // default
  if (bars.length >= 30) {
    const allIVs = [];
    for (let i = 1; i < bars.length; i++) {
      const ret = Math.log(bars[i].c / bars[i-1].c);
      allIVs.push(Math.abs(ret) * Math.sqrt(252));
    }
    // Use real options IV if available, else use approximation
    const ivForPercentile = (typeof realOptionsIV === 'number' && realOptionsIV > 0) ? realOptionsIV : currentIV;
    const daysBelow = allIVs.filter(iv => iv < ivForPercentile).length;
    ivPercentile = Math.round((daysBelow / allIVs.length) * 100);
  }

  // Intraday VWAP
  const intradayVWAP = intradayBars.length >= 5 ? calcVWAP(intradayBars) : 0;

  // Volume ratio - today's intraday volume vs expected (based on time of day)
  const intradayVol  = intradayBars.reduce((s, b) => s + b.v, 0);
  const avgDailyVol  = bars.length ? bars.slice(-20).reduce((s,b)=>s+b.v,0)/20 : 0;
  // Adjust for time of day - if 2 hours into session, expect ~40% of daily vol
  const etH = getETTime().getHours() + getETTime().getMinutes() / 60;
  const sessionPct = Math.min(1, Math.max(0.1, (etH - 9.5) / 6.5)); // 0-100% through session
  const expectedVol = avgDailyVol * sessionPct;
  const volPaceRatio = expectedVol > 0 ? intradayVol / expectedVol : 1;

  return {
    rsi,           // intraday RSI -- display and timing only
    dailyRsi,      // daily RSI -- use this for all scoring thresholds (V2.81)
    macd:          macd.signal,
    momentum,
    adx,
    ivr,
    ivPercentile,  // % of days with lower IV - high = options expensive
    intradayVWAP,
    intradayVol,
    volPaceRatio,
    atrPct:        atrPct || null, // ATR as % of price - TA-W2 normalization
    hasIntraday:   intradayBars.length >= 10,
  };
}

// - Helpers -
const fmt         = n  => "$" + parseFloat(n).toFixed(2);
// Use actual account baseline (set from Alpaca on first sync) not hardcoded constant
// state.accountBaseline tracks the real starting value for performance calculations
const totalCap    = () => state.customBudget || Math.max(state.cash || 0, state.accountBaseline || 0, MONTHLY_BUDGET);
// Mark-to-market: use current price not entry cost for real portfolio value
// currentPrice is updated every reconciliation from Alpaca market values
const openRisk    = () => state.positions.reduce((s,p) => {
  const curP     = p.currentPrice || p.premium || 0;
  const mktValue = curP * 100 * (p.contracts || 1) * (p.partialClosed ? 0.5 : 1);
  return s + mktValue;
}, 0);
// Entry cost basis (for heat calculations - should use cost not market value)
const openCostBasis = () => state.positions.reduce((s,p) => s + p.cost * (p.partialClosed ? 0.5 : 1), 0);
const heatPct     = () => openCostBasis() / totalCap(); // heat uses entry cost not MTM
const realizedPnL = () => state.closedTrades.reduce((s,t) => s + t.pnl, 0);
const stockValue  = () => state.stockPositions.reduce((s,p) => s + p.cost, 0);

// Drawdown recovery mode check
const isDrawdownRecovery = () => {
  const dd = (state.cash - (state.peakCash || MONTHLY_BUDGET)) / (state.peakCash || MONTHLY_BUDGET);
  return dd <= -DRAWDOWN_RECOVERY_PCT;
};

// Correlation check - returns group if stock is correlated with existing position
const getCorrelatedGroup = (ticker) => {
  for (const group of CORRELATION_GROUPS) {
    if (!group.includes(ticker)) continue;
    const existingInGroup = state.positions.filter(p => group.includes(p.ticker));
    if (existingInGroup.length > 0) return group;
  }
  return null;
};

// Support/resistance from price bars
function getSupportResistance(bars) {
  if (bars.length < 20) return { support: 0, resistance: Infinity };
  const recent = bars.slice(-20);
  const highs  = recent.map(b => b.h);
  const lows   = recent.map(b => b.l);
  return {
    resistance: Math.max(...highs),
    support:    Math.min(...lows),
  };
}

// Performance attribution helpers
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

// Tax tracking - build full trade log with cost basis
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

// Bulletproof ET time - uses Intl API which handles DST correctly on any server timezone
function getETTime(date) {
  const str = (date || new Date()).toLocaleString("en-US", { timeZone: "America/New_York" });
  return new Date(str);
}

function isEntryWindow(optionType = null, isIndex = false) {
  const et  = getETTime();
  const h   = et.getHours(), m = et.getMinutes();
  const day = et.getDay();
  if (day === 0 || day === 6) return false;

  const minsSinceMidnight = h * 60 + m;
  const marketClose       = 15 * 60 + 45; // 3:45 PM - index options stay open later
  const indexStart        = 9 * 60 + 30;  // 9:30 AM - SPY/QQQ open at bell
  const stockStart        = 9 * 60 + 45;  // 9:45 AM - individual stocks need price discovery

  if (minsSinceMidnight > marketClose) return false;
  return minsSinceMidnight >= (isIndex ? indexStart : stockStart);
}

function isDST(date) {
  // Kept for compatibility but getETTime() is now used everywhere
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return Math.max(jan, jul) !== date.getTimezoneOffset();
}

function isMarketHours() {
  const et   = getETTime();
  const h    = et.getHours(), m = et.getMinutes();
  const day  = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = h * 60 + m;
  return mins >= 570 && mins <= 960; // 9:30 AM - 4:00 PM ET
}

// - Greeks (Black-Scholes) -
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-x*x);
  return x >= 0 ? y : -y;
}

function calcGreeks(price, strike, daysToExpiry, iv, optionType = "call") {
  const t   = Math.max(daysToExpiry, 1) / 365;
  const d1  = (Math.log(price/strike) + (0.05 + iv*iv/2)*t) / (iv*Math.sqrt(t));
  const nd1 = Math.exp(-d1*d1/2) / Math.sqrt(2*Math.PI);
  const Nd1 = 0.5*(1+erf(d1/Math.sqrt(2)));
  // Put delta = Nd1 - 1 (negative), call delta = Nd1 (positive)
  const rawDelta = optionType === "put" ? Nd1 - 1 : Nd1;
  return {
    delta: parseFloat(Math.max(-0.99, Math.min(0.99, rawDelta)).toFixed(3)),
    gamma: parseFloat((nd1 / (price * iv * Math.sqrt(t))).toFixed(4)),
    vega:  parseFloat((price * nd1 * Math.sqrt(t) * 0.01).toFixed(2)),
    theta: parseFloat((-(price * nd1 * iv) / (2*Math.sqrt(t)) / 365).toFixed(2)),
  };
}

// - Trade Quality Score -
// V2.81: Tracks daily RSI persistence -- panel fix
// Increments once per trading day when DAILY RSI <= 35 (not per scan)
// Research basis: mean reversion edge requires 2+ DAYS of oversold (not 2+ scans = seconds)
function updateOversoldTracker(ticker, dailyRsi) {
  if (!state._oversoldCount) state._oversoldCount = {};
  if (!state._oversoldDate)  state._oversoldDate  = {};
  const today = getETTime().toISOString().slice(0, 10); // YYYY-MM-DD
  const lastDate = state._oversoldDate[ticker] || '';
  if (dailyRsi <= 35) {
    // Only increment once per trading day -- prevent scan-level inflation
    if (lastDate !== today) {
      state._oversoldCount[ticker] = (state._oversoldCount[ticker] || 0) + 1;
      state._oversoldDate[ticker]  = today;
    }
  } else {
    // Daily RSI recovered -- reset both counter and date
    state._oversoldCount[ticker] = 0;
    state._oversoldDate[ticker]  = '';
  }
  return state._oversoldCount[ticker] || 0;
}

function scoreMeanReversionCall(stock, relStrength, adx, bars, vix) {
  let score = 0;
  const reasons = [];

  // Only applies when VIX is elevated (high fear = cheap relative calls)
  if (vix < 25) return { score: 0, reasons: ["VIX too low for mean reversion (+0)"] };

  // Stock must be a quality name - use beta as proxy for quality/liquidity
  if ((stock.beta || 1) < 1.0) return { score: 0, reasons: ["Low beta - not a mean reversion candidate (+0)"] };

  // RSI oversold - stock is beaten down (20pts)
  if (stock.rsi <= 35)                        { score += 20; reasons.push(`RSI ${stock.rsi} - deeply oversold (+20)`); }
  else if (stock.rsi <= 42)                   { score += 12; reasons.push(`RSI ${stock.rsi} - oversold (+12)`); }
  else if (stock.rsi <= 48)                   { score += 5;  reasons.push(`RSI ${stock.rsi} - near oversold (+5)`); }
  else return { score: 0, reasons: [`RSI ${stock.rsi} not oversold - skip mean reversion`] };

  // Multi-scan oversold bonus - RSI - 35 for 2+ consecutive scans = genuine capitulation
  const oversoldScans = state._oversoldCount ? (state._oversoldCount[stock.ticker] || 0) : 0;
  if (oversoldScans >= 3)      { score += 15; reasons.push(`Oversold ${oversoldScans} consecutive scans - capitulation (+15)`); }
  else if (oversoldScans >= 2) { score += 8;  reasons.push(`Oversold ${oversoldScans} consecutive scans (+8)`); }

  // Drawdown from recent high - how cheap is the stock? (25pts)
  if (bars && bars.length >= 20) {
    const recentHigh = Math.max(...bars.slice(-20).map(b => b.h));
    const currentPrice = bars[bars.length - 1].c;
    const drawdown = (recentHigh - currentPrice) / recentHigh;
    if (drawdown >= 0.20)      { score += 25; reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high - deep discount (+25)`); }
    else if (drawdown >= 0.12) { score += 15; reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high - discount (+15)`); }
    else if (drawdown >= 0.07) { score += 8;  reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high (+8)`); }
    else                       { score += 0;  reasons.push(`Only down ${(drawdown*100).toFixed(0)}% - not enough discount (+0)`); }
  }

  // MACD forming base or bullish crossover = possible reversal (15pts)
  if (stock.macd.includes("bullish crossover")) { score += 15; reasons.push("MACD bullish crossover - reversal signal (+15)"); }
  else if (stock.macd.includes("forming"))      { score += 10; reasons.push("MACD forming base - bottom building (+10)"); }
  else if (stock.macd.includes("bullish"))      { score += 5;  reasons.push("MACD bullish (+5)"); }
  else                                          { reasons.push("MACD bearish - wait for base (+0)"); }

  // VIX level bonus - higher VIX = cheaper calls relative to intrinsic move potential (15pts)
  if (vix >= 35)      { score += 15; reasons.push(`VIX ${vix} - extreme fear, calls historically cheap (+15)`); }
  else if (vix >= 30) { score += 10; reasons.push(`VIX ${vix} - elevated fear (+10)`); }
  else if (vix >= 25) { score += 5;  reasons.push(`VIX ${vix} - moderate fear (+5)`); }

  // Quality / catalyst (15pts)
  if (stock.catalyst)  { score += 10; reasons.push(`Recovery catalyst: ${stock.catalyst} (+10)`); }

  // ADX - low ADX means trend is weakening (good for reversal) (10pts)
  if (adx && adx < 20) { score += 10; reasons.push(`ADX ${adx} - weak trend, reversal likely (+10)`); }
  else if (adx && adx < 30) { score += 5; reasons.push(`ADX ${adx} - trend weakening (+5)`); }

  return { score: Math.min(score, 100), reasons, isMeanReversion: true };
}

// - SPY/QQQ Index Scoring -
// Dedicated scoring for index instruments - macro-driven, not stock-specific
function scoreIndexSetup(stock, optionType, spyRSI, spyMACD, spyMomentum, breadth, vix, agentMacro) {
  let score = 0;
  const reasons = [];
  const signal     = (agentMacro || {}).signal     || "neutral";
  const confidence = (agentMacro || {}).confidence || "low";
  const regime     = (agentMacro || {}).regime     || "neutral";
  const entryBias  = (agentMacro || {}).entryBias  || "neutral";
  const tradeType  = (agentMacro || {}).tradeType  || "spread";
  const vixOutlook = (agentMacro || {}).vixOutlook || "unknown";

  // Supplementary signals - capped at +25 total, declared at function scope
  // so both put and call branches can use it
  // - QS-W1: Macro correlation discount (diminishing returns) -
  // When multiple primary signals all share one macro driver (e.g. all bearish because
  // SPY sold off today), adding them independently creates false precision.
  // Rule: count how many primary signals fired in the SAME direction as the entry.
  // 1-2 signals: full weight. 3rd signal: 70%. 4th+: 50%.
  // Primary signals = agent, regime, RSI, MACD, breadth. Supplementary are separate.
  // Count the number of primary pro-entry reasons already in the score
  const proEntryKeywords = optionType === "put"
    ? ["Agent strongly bearish","Agent bearish","Agent mild bearish","Regime: trending_bear","Regime: breakdown","RSI","MACD bearish","Breadth","VIX spiking"]
    : ["Agent strongly bullish","Agent bullish","Agent mild bullish","Regime: recovery","Regime: trending_bull","RSI","MACD bullish","Breadth","VIX compressing","VIX mean reverting"];
  const primaryFired = reasons.filter(r => proEntryKeywords.some(kw => r.includes(kw))).length;
  if (primaryFired >= 4) {
    // 4+ macro signals all firing together = likely same event counted multiple times
    const discountPct = 15;
    score = Math.round(score * (1 - discountPct/100));
    reasons.push(`Macro correlation discount: ${primaryFired} correlated signals (-${discountPct}% on total)`);
  } else if (primaryFired === 3) {
    const discountPct = 8;
    score = Math.round(score * (1 - discountPct/100));
    reasons.push(`Macro correlation discount: ${primaryFired} correlated signals (-${discountPct}% on total)`);
  }

  let supplementScore = 0;
  // Supplementary signal staleness - max age for each signal type
  // PCR/SKEW update every 15 minutes, AAII weekly, term structure every 15 min
  const SUPP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour - stale beyond this, ignore
  const isDataFresh = (data) => data && data.updatedAt && (Date.now() - data.updatedAt) < SUPP_MAX_AGE_MS;

  if (optionType === "put") {
    // - Supplementary signals - capped at +25 total contribution -
    // These signals CONFIRM the primary thesis (agent + regime + RSI + MACD)
    // They should not dominate the score on their own
    // Cap: track supplement score separately, add min(supplementScore, 25) at end

    // - Put/Call Ratio signal (Bollen & Whaley 2004) -
    const pcrData = isDataFresh(state._pcr) ? state._pcr : null;
    if (pcrData && optionType === "put") {
      if (pcrData.signal === "extreme_fear")       { supplementScore += 10; reasons.push(`PCR ${pcrData.pcr} - extreme fear, put momentum strong (+10)`); }
      else if (pcrData.signal === "fear")          { supplementScore += 6;  reasons.push(`PCR ${pcrData.pcr} - elevated fear, put bias (+6)`); }
      else if (pcrData.signal === "extreme_greed") { score -= 12; reasons.push(`PCR ${pcrData.pcr} - extreme greed, puts risky (-12)`); }
      else if (pcrData.signal === "greed")         { score -= 6;  reasons.push(`PCR ${pcrData.pcr} - greed, puts less favorable (-6)`); }
    }
    if (pcrData && optionType === "call") {
      if (pcrData.signal === "extreme_fear")       { supplementScore += 12; reasons.push(`PCR ${pcrData.pcr} - extreme fear = contrarian call signal (+12)`); }
      else if (pcrData.signal === "fear")          { supplementScore += 6;  reasons.push(`PCR ${pcrData.pcr} - elevated fear, contrarian call (+6)`); }
      else if (pcrData.signal === "extreme_greed") { score -= 10; reasons.push(`PCR ${pcrData.pcr} - extreme greed, calls overextended (-10)`); }
    }

    // - Vol term structure (Natenberg) -
    const ts = isDataFresh(state._termStructure) ? state._termStructure : null;
    if (ts && optionType === "put") {
      if (ts.creditFavorable) { supplementScore += 8; reasons.push(`Vol backwardation (${ts.ratio}) - near-term fear premium elevated (+8)`); }
    }
    if (ts && optionType === "call") {
      if (ts.callFavorable)   { supplementScore += 8; reasons.push(`Vol contango (${ts.ratio}) - calls relatively cheap (+8)`); }
    }

    // - CBOE SKEW Index -
    // SKEW elevated + VIX elevated = put premium doubly rich = ideal credit puts
    // SKEW low = tail risk not priced = normal environment
    const skewData = isDataFresh(state._skew) ? state._skew : null;
    if (skewData) {
      if (optionType === "put") {
        if (skewData.signal === "extreme" && skewData.creditPutIdeal) {
          supplementScore += 12; reasons.push(`SKEW ${skewData.skew} extreme + VIX elevated - put premium doubly rich (+12)`);
        } else if (skewData.signal === "elevated") {
          supplementScore += 8; reasons.push(`SKEW ${skewData.skew} elevated - tail risk premium high (+8)`);
        } else if (skewData.signal === "low") {
          score -= 5; reasons.push(`SKEW ${skewData.skew} low - tail risk not priced (-5)`);
        }
      }
      if (optionType === "call") {
        if (skewData.signal === "low") {
          supplementScore += 8; reasons.push(`SKEW ${skewData.skew} low - tail risk not priced, calls favorable (+8)`);
        } else if (skewData.signal === "extreme") {
          score -= 8; reasons.push(`SKEW ${skewData.skew} extreme - market fearing tail event, wrong for calls (-8)`);
        }
      }
    }

    // - AAII Sentiment (Ned Davis Research validation) -
    // Extreme retail bearishness = contrarian call signal (bulls historically wrong at extremes)
    // Extreme retail bullishness = contrarian put signal
    const aaiiData = (state._aaii && state._aaii.updatedAt && (Date.now() - state._aaii.updatedAt) < 8 * 24 * 60 * 60 * 1000) ? state._aaii : null; // 8-day TTL (weekly data)
    if (aaiiData) {
      if (optionType === "call") {
        if (aaiiData.signal === "extreme_bearish") {
          supplementScore += 12; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail bearishness = contrarian call (+12)`);
        } else if (aaiiData.signal === "bearish") {
          supplementScore += 6; reasons.push(`AAII bulls ${aaiiData.bullish}% - retail bearish = mild contrarian call (+6)`);
        } else if (aaiiData.signal === "extreme_bullish") {
          score -= 10; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail greed, wrong for calls (-10)`);
        }
      }
      if (optionType === "put") {
        if (aaiiData.signal === "extreme_bullish") {
          supplementScore += 10; reasons.push(`AAII bulls ${aaiiData.bullish}% - extreme retail greed = contrarian put (+10)`);
        } else if (aaiiData.signal === "bullish") {
          supplementScore += 5; reasons.push(`AAII bulls ${aaiiData.bullish}% - retail complacent = mild contrarian put (+5)`);
        } else if (aaiiData.signal === "extreme_bearish") {
          score -= 8; reasons.push(`AAII extreme bearish - contrary indicator, puts may be exhausted (-8)`);
        }
      }
    }

    // - Breadth momentum (Aronson: direction > single reading) -
    const bMom = state._breadthTrend || "flat";
    const bMomVal = state._breadthMomentum || 0;
    if (optionType === "put" && bMom === "falling") {
      supplementScore += 8; reasons.push(`Breadth falling (${bMomVal.toFixed(1)}pts) - distribution (+8)`);
    } else if (optionType === "call" && bMom === "rising") {
      supplementScore += 8; reasons.push(`Breadth rising (${bMomVal.toFixed(1)}pts) - accumulation (+8)`);
    }

    // - Breadth recovery signal -
    // Note: True Zweig Thrust requires NYSE breadth (thousands of stocks)
    // With 4-instrument watchlist, use gentler "breadth recovery" signal
    // Only fires when breadth went from <40% to >60% in recent sessions
    if (optionType === "call" && state._zweigThrust?.detected) {
      supplementScore += 10; reasons.push("Breadth recovery signal - watchlist went from weak to strong (+10)");
    }

    // - Agent macro signal - primary gate -
    // Panel fix: mild bullish in bear regime = bounce read, not regime change.
    // -20 penalty only fires when agent is genuinely bullish AND regime confirms it.
    // entryBias "puts_on_bounces" means the bounce IS the put entry signal - treat as neutral.
    const bearRegimeForPuts = ["trending_bear","breakdown"].includes(regime);
    const putsBiasOk = entryBias === "puts_on_bounces";
    if (["strongly bearish","bearish"].includes(signal) && confidence === "high") { score += 35; reasons.push(`Agent ${signal} high confidence (+35)`); }
    else if (["strongly bearish","bearish"].includes(signal))                     { score += 25; reasons.push(`Agent ${signal} (+25)`); }
    else if (signal === "mild bearish")                                            { score += 8;  reasons.push(`Agent mild bearish (+8)`); }
    else if (signal === "neutral")                                                 { score += 0;  reasons.push("Agent neutral (+0)"); }
    else if (signal === "mild bullish" && (bearRegimeForPuts || putsBiasOk)) {
      score += 0;
      reasons.push(`Agent mild bullish in ${bearRegimeForPuts ? "bear regime" : "puts_on_bounces bias"} - bounce entry, treating as neutral (+0)`);
    }
    else if (signal === "mild bullish") {
      // Regime cap: trending_bear + puts_on_bounces - structural regime wins over tactical bounce headline
      const inBearPutsOnBounces = ["trending_bear","breakdown"].includes(regime) && entryBias === "puts_on_bounces";
      const penalty = inBearPutsOnBounces ? -4 : -8;
      score += penalty; reasons.push(`Agent mild bullish (${penalty})${inBearPutsOnBounces ? " - regime cap" : ""}`);
    }
    else if (signal === "bullish") {
      const inBearPutsOnBounces2 = ["trending_bear","breakdown"].includes(regime) && entryBias === "puts_on_bounces";
      const penalty = inBearPutsOnBounces2 ? -8 : -15;
      score += penalty; reasons.push(`Agent bullish (${penalty})${inBearPutsOnBounces2 ? " - regime cap" : ""}`);
    }
    else { // strongly bullish
      const inBearPutsOnBounces3 = ["trending_bear","breakdown"].includes(regime) && entryBias === "puts_on_bounces";
      const penalty = inBearPutsOnBounces3 ? -8 : -20;
      score += penalty; reasons.push(`Agent ${signal} (${penalty})${inBearPutsOnBounces3 ? " - regime cap" : ""}`);
    }

    // - Regime confirmation -
    if (["trending_bear","breakdown"].includes(regime))                           { score += 20; reasons.push(`Regime: ${regime} (+20)`); }
    else if (regime === "choppy")                                                  { score -= 10; reasons.push("Choppy regime - puts risky (-10)"); }
    else if (["trending_bull","recovery"].includes(regime))                       { score -= 25; reasons.push(`Regime: ${regime} - wrong for puts (-25)`); }

    // V2.84: Regime B duration boost (panel fix -- Stat Arb + Quant Strategist)
    // The longer the bear trend is confirmed, the higher confidence puts are the right trade
    // Research: sustained regime (3+ days below 200MA) has higher directional accuracy than intraday regime calls
    // _regimeDuration tracks days SPY has been below 200MA (incremented daily in regime classifier)
    const regimeDuration = state._regimeDuration || 0;
    if (["trending_bear","breakdown"].includes(regime) && regimeDuration >= 10) {
      score += 15; reasons.push(`Bear trend confirmed ${regimeDuration}d - sustained regime high confidence (+15)`);
    } else if (["trending_bear","breakdown"].includes(regime) && regimeDuration >= 5) {
      score += 10; reasons.push(`Bear trend confirmed ${regimeDuration}d - sustained regime (+10)`);
    } else if (["trending_bear","breakdown"].includes(regime) && regimeDuration >= 3) {
      score += 5; reasons.push(`Bear trend confirmed ${regimeDuration}d - regime establishing (+5)`);
    }

    // - SPY technicals (V2.81 - all thresholds now use daily RSI) -
    // V2.81 change 1: Regime-gate overbought put bonus
    // RSI >=70 in Regime A (bull trend) = healthy trend, not a fade signal (+5 only)
    // RSI >=70 in Regime B/C (bear/choppy) = extended bounce, genuine fade signal (+20)
    const inBearOrChoppy = ["trending_bear","breakdown","choppy"].includes(regime);
    if (spyRSI >= 70) {
      // V2.81 change 2: Joint RSI+IVR scoring
      // RSI >=70 (overbought) + IVR <=30 (cheap options) = ideal debit put entry
      // RSI >=70 + IVR >=70 (expensive options) = move may be priced in, reduce bonus
      const ivpNow = stock.ivPercentile || 50;
      if (ivpNow <= 30 && inBearOrChoppy) {
        score += 25; reasons.push(`SPY RSI ${spyRSI} overbought + IVP ${ivpNow}% cheap puts - ideal debit put entry (+25)`);
      } else if (inBearOrChoppy) {
        score += 20; reasons.push(`SPY RSI ${spyRSI} overbought in bear/choppy regime (+20)`);
      } else {
        score += 5;  reasons.push(`SPY RSI ${spyRSI} overbought in bull regime - trend may continue, reduced bonus (+5)`);
      }
    }
    else if (spyRSI >= 60)                                                        { score += 10; reasons.push(`SPY RSI ${spyRSI} elevated (+10)`); }
    else if (spyRSI <= 35)                                                        {
      // Credit spreads: oversold = sell fear premium (survivable, not ideal) - reduced bonus
      // Debit put spreads: oversold = stock already crashed - hard zero
      // V2.81 change 3: Reduced credit put bonus from +15 to +5
      // Oversold is survivable for credit puts but not an ideal setup - score reflects that
      if (tradeType === "credit") {
        // V2.81 change 2 (joint): RSI <=35 + IVP >=70 = ideal credit put (fear premium at peak)
        const ivpNow = stock.ivPercentile || 50;
        if (ivpNow >= 70) {
          score += 10; reasons.push(`SPY RSI ${spyRSI} oversold + IVP ${ivpNow}% - fear premium elevated, credit put viable (+10)`);
        } else {
          score += 5;  reasons.push(`SPY RSI ${spyRSI} oversold - credit put survivable but not ideal (+5)`);
        }
      } else {
        score = 0; reasons.push(`SPY RSI ${spyRSI} oversold - debit put hard block (stock already crashed) (+0)`); return { score: 0, reasons, tradeType };
      }
    }
    else if (spyRSI <= 45) {
      // V2.84: Regime-aware RSI penalty (panel fix -- Technical Analyst + Stat Arb)
      // Regime A (bull): RSI <=45 means stock already sold off -- put thesis weak (-15)
      // Regime B (bear trend): RSI <=45 means downtrend intact -- neutral for puts (0)
      // Regime B + RSI <=40: valid but elevated overnight gap risk -- apply 0.75x sizing via _rsiBearOversold flag
      const inBearTrend = ["trending_bear","breakdown"].includes(regime);
      if (inBearTrend) {
        if (spyRSI <= 40) {
          score += 0; reasons.push(`SPY RSI ${spyRSI} oversold in bear trend - trend intact, no penalty but size reduced (+0)`);
          // Note: 0.75x sizing applied at execution via regimeBOversoldMod check
          reasons.push(`[OVERSOLD-BEAR] RSI ${spyRSI} <=40 in Regime B - 0.75x sizing applied at execution`);
        } else {
          score += 0; reasons.push(`SPY RSI ${spyRSI} oversold in bear trend - downtrend intact, no penalty (+0)`);
        }
      } else {
        score -= 15; reasons.push(`SPY RSI ${spyRSI} oversold for puts - stock already crashed in bull regime (-15)`);
      }
    }

    // V2.81 change 4: RSI velocity penalty
    // Fast RSI moves are statistically less reliable than sustained readings
    // If daily RSI moved 20+ points in recent sessions, the signal is a fast bounce/crash not a regime condition
    const rsiHistRaw = state._rsiHistory?.[stock.ticker] || [];
    const rsiHistory = rsiHistRaw.map(r => typeof r === 'object' ? (r?.rsi || 50) : r);
    if (rsiHistory.length >= 3) {
      const rsiChange = Math.abs(spyRSI - rsiHistory[rsiHistory.length - 3]);
      if (rsiChange >= 20) {
        score -= 8; reasons.push(`RSI velocity: ${rsiChange.toFixed(0)}pt move in 3 sessions - fast moves less reliable (-8)`);
      }
    }

    // TA-C1: Dampen MACD when RSI is extreme opposite (intraday RSI more current than daily MACD)
    const macdRSIConflictPut = spyRSI >= 70 && spyMACD && spyMACD.includes("bullish");
    const macdMultPut = macdRSIConflictPut ? 0.4 : 1.0;
    if (macdRSIConflictPut) reasons.push(`MACD/RSI conflict - RSI ${spyRSI} overbought, bullish MACD dampened`);
    if (spyMACD && spyMACD.includes("bearish crossover"))      { score += Math.round(15*macdMultPut); reasons.push(`SPY MACD bearish crossover (+${Math.round(15*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bearish"))           { score += Math.round(10*macdMultPut); reasons.push(`SPY MACD bearish (+${Math.round(10*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bullish crossover")) { score -= Math.round(15*macdMultPut); reasons.push(`SPY MACD bullish crossover (-${Math.round(15*macdMultPut)})`); }
    else if (spyMACD && spyMACD.includes("bullish"))           { score -= Math.round(8*macdMultPut);  reasons.push(`SPY MACD bullish (-${Math.round(8*macdMultPut)})`); }

    // - Breadth confirmation -
    if (breadth <= 30)       { score += 15; reasons.push(`Breadth ${breadth}% - severe weakness (+15)`); }
    else if (breadth <= 45)  { score += 8;  reasons.push(`Breadth ${breadth}% - weak (+8)`); }
    else if (breadth >= 70)  { score -= 15; reasons.push(`Breadth ${breadth}% - strong, wrong for puts (-15)`); }

    // - VIX context -
    if (vixOutlook === "spiking")          { score += 10; reasons.push("VIX spiking - put premium expanding (+10)"); }
    else if (vixOutlook === "elevated_stable") { score += 5; reasons.push("VIX elevated stable (+5)"); }
    else if (vixOutlook === "falling")     { score -= 10; reasons.push("VIX falling - puts losing value (-10)"); }
    if (vix >= 25)                         { score += 5;  reasons.push(`VIX ${vix.toFixed(1)} elevated (+5)`); }

    // - Entry bias alignment -
    // Bounce quality scoring - best put entries are on relief bounces not crashes
    if (entryBias === "puts_on_bounces") {
      const agentAlreadyBearish = ["strongly bearish","bearish","mild bearish"].includes(signal);
      if (spyMomentum === "steady" && spyRSI >= 45 && spyRSI <= 60) {
        const biasBonus = agentAlreadyBearish ? 8 : 15;
        score += biasBonus; reasons.push(`Entry bias: fading bounce RSI ${spyRSI} (+${biasBonus})`);
      } else if (spyMomentum === "steady") {
        const biasBonus = agentAlreadyBearish ? 4 : 8;
        score += biasBonus; reasons.push(`Entry bias: puts on bounces (+${biasBonus})`);
      } else if (spyMomentum === "recovering" && spyRSI >= 40) {
        score += 3; reasons.push("Entry bias: momentum recovering - timing not ideal (+3)");
      }
    }
    if (entryBias === "avoid") { score = Math.min(score, 0); reasons.push("Agent says avoid - blocked"); }

    // - VWAP for puts (TA-C2) -
    const putVWAP  = stock.intradayVWAP || 0;
    const putPrice = stock.price || 0;
    if (putVWAP > 0 && putPrice > 0) {
      const vwapDiffPut = (putPrice - putVWAP) / putVWAP;
      if (vwapDiffPut < -0.01)     { score += 8; reasons.push(`Below VWAP ${(vwapDiffPut*100).toFixed(1)}% - weakness confirmed (+8)`); }
      else if (vwapDiffPut > 0.02) { score -= 6; reasons.push(`Extended above VWAP ${(vwapDiffPut*100).toFixed(1)}% - overbought vs today (+6 short)`); }
    }

    // - IV Percentile for puts - high IVR is partially favorable (richer premium)
    // but very high IVR means move already happened (less upside)
    const ivpPut = stock.ivPercentile || 50;
    if (ivpPut < 25)       { score += 8;  reasons.push(`IVP ${ivpPut}% - cheap puts, favorable entry (+8)`); }
    else if (ivpPut >= 70) { score += 5;  reasons.push(`IVP ${ivpPut}% - elevated IV, rich put premium (+5)`); }
    else if (ivpPut >= 90) { score -= 5;  reasons.push(`IVP ${ivpPut}% - extreme IV, move may be priced in (-5)`); }

    // - QQQ secondary - only when tech thesis clear -
    // Panel fix: in Regime B/C with only 4 instruments, agent.bearishTickers is
    // almost never populated with FAANG names - gate fires on every scan.
    // QQQ put in a macro bear regime IS the thesis - no additional tech confirmation needed.
    // Gate only applies in Regime A (bull) or when individual stocks are enabled
    // (where SPY vs QQQ distinction matters more).
    if (stock.ticker === "QQQ") {
      const qqqGateApplies = !["trending_bear","breakdown"].includes(regime) || INDIVIDUAL_STOCKS_ENABLED;
      if (qqqGateApplies) {
        const techBearish = (agentMacro || {}).bearishTickers && (agentMacro.bearishTickers.some(t => ["NVDA","MSFT","AAPL","META","GOOGL"].includes(t)));
        if (!techBearish) { score -= 15; reasons.push("QQQ: no clear tech bearish thesis in bull regime (-15)"); }
        else { reasons.push("QQQ: tech names in agent bearish list (+0)"); }
      } else {
        reasons.push(`QQQ: Regime ${regime} - macro bear thesis sufficient, no tech confirmation needed (+0)`);
      }
    }

  } else {
    // - CALL SCORING - two distinct theses handled separately -
    // Thesis A: Mean Reversion Call - RSI crash + high VIX + capitulation
    // Thesis B: Trending Bull Call  - VIX compression + breadth thrust + momentum
    // Both share this path but scoring weights differ by regime/RSI context

    // - Agent macro signal - primary gate -
    if (["strongly bullish","bullish"].includes(signal) && confidence === "high") { score += 35; reasons.push(`Agent ${signal} high confidence (+35)`); }
    else if (["strongly bullish","bullish"].includes(signal))                     { score += 25; reasons.push(`Agent ${signal} (+25)`); }
    else if (signal === "mild bullish")                                            { score += 8;  reasons.push("Agent mild bullish (+8)"); }
    else if (signal === "neutral" && spyRSI <= 35)                                { score += 20; reasons.push("Mean reversion call - SPY oversold on neutral macro (+20)"); }
    else if (signal === "neutral")                                                 { score += 0;  reasons.push("Agent neutral (+0)"); }
    else if (signal === "mild bearish") {
      score -= 8; reasons.push(`Agent mild bearish (-8)`);
    }
    else if (signal === "bearish") {
      score -= 15; reasons.push(`Agent bearish (-15)`);
    }
    else { // strongly bearish
      // Scale by signal strength - mild = -8, bullish = -15, strongly = -20
      const callPenalty = signal === "mild bearish" ? -8 : signal === "bearish" ? -15 : -20;
      score += callPenalty; reasons.push(`Agent ${signal} (${callPenalty})`);
    }

    // - Regime confirmation -
    if (["trending_bull","recovery"].includes(regime))                            { score += 20; reasons.push(`Regime: ${regime} (+20)`); }
    else if (regime === "choppy")                                                  { score -= 10; reasons.push("Choppy regime - calls risky (-10)"); }
    else if (["trending_bear","breakdown"].includes(regime)) {
      // V2.81 change 5: Capitulation bypass for mean reversion calls
      // When daily RSI <=30 for 2+ consecutive DAYS and VIX is not spiking,
      // capitulation has genuinely occurred - reduce regime B penalty from -25 to -10
      // Research basis: daily RSI <=35 for 2+ days has +1.2% excess 5-day forward return on SPY
      const oversoldDays = state._oversoldCount?.[stock.ticker] || 0;
      const vixNotSpiking = (state._agentMacro?.vixOutlook || "") !== "spiking";
      const capitulationConfirmed = spyRSI <= 30 && oversoldDays >= 2 && vixNotSpiking;
      if (capitulationConfirmed) {
        score -= 10; reasons.push(`Regime: ${regime} - capitulation bypass active (RSI ${spyRSI} for ${oversoldDays}d + VIX stabilizing) (-10 vs normal -25)`);
      } else {
        score -= 25; reasons.push(`Regime: ${regime} - wrong for calls (-25)`);
      }
    }

    // - RSI - context-aware for two theses (V2.81 - now uses daily RSI) -
    // Mean reversion: deeply oversold RSI = ideal call entry
    // Trending bull: healthy RSI (45-60) on a dip = ideal call entry
    // Overbought RSI (70+) = wrong entry point for both theses
    // V2.81 change 5 continued: RSI stabilization gate for mean reversion calls
    // Require 3 consecutive intraday scans of RSI <=35 before MR call entry fires
    // Prevents entering at the exact moment of maximum spread width and worst fills
    const intradayOversoldScans = state._intradayOversoldScans?.[stock.ticker] || 0;
    const mrStabilized = intradayOversoldScans >= 3; // 3 scans = ~30 seconds of stability
    if (spyRSI <= 25) {
      if (mrStabilized) { score += 25; reasons.push(`SPY RSI ${spyRSI} extreme oversold - stabilized (${intradayOversoldScans} scans) - mean reversion call (+25)`); }
      else              { score += 10; reasons.push(`SPY RSI ${spyRSI} extreme oversold - not yet stabilized (${intradayOversoldScans}/3 scans) - partial credit (+10)`); }
    }
    else if (spyRSI <= 35) {
      if (mrStabilized) { score += 18; reasons.push(`SPY RSI ${spyRSI} deeply oversold - stabilized - mean reversion (+18)`); }
      else              { score += 8;  reasons.push(`SPY RSI ${spyRSI} deeply oversold - awaiting stabilization (${intradayOversoldScans}/3 scans) (+8)`); }
    }
    else if (spyRSI <= 42)                                                        { score += 10; reasons.push(`SPY RSI ${spyRSI} oversold (+10)`); }
    else if (spyRSI >= 45 && spyRSI <= 58 && ["trending_bull","recovery"].includes(regime)) {
      score += 12; reasons.push(`SPY RSI ${spyRSI} healthy dip in bull trend - ideal call entry (+12)`);
    }
    else if (spyRSI >= 70)                                                        { score -= 15; reasons.push(`SPY RSI ${spyRSI} overbought for calls (-15)`); }

    // V2.81 change 4 (call side): RSI velocity penalty
    const rsiHistoryCallRaw = state._rsiHistory?.[stock.ticker] || [];
    const rsiHistoryCall = rsiHistoryCallRaw.map(r => typeof r === 'object' ? (r?.rsi || 50) : r);
    if (rsiHistoryCall.length >= 3) {
      const rsiChangeCall = Math.abs(spyRSI - rsiHistoryCall[rsiHistoryCall.length - 3]);
      if (rsiChangeCall >= 20) {
        score -= 8; reasons.push(`RSI velocity: ${rsiChangeCall.toFixed(0)}pt move in 3 sessions - fast bounce less reliable (-8)`);
      }
    }

    // - MACD (with RSI contradiction dampening) -
    // TA-C1: Intraday RSI (responsive) and daily MACD (slow) can conflict on fast-moving days
    // When RSI is deeply oversold (<35) but MACD is bearish - RSI signal is more current
    // Dampen MACD penalty when it contradicts an extreme RSI reading
    const macdRSIConflict = spyRSI <= 35 && spyMACD && spyMACD.includes("bearish");
    const macdMult = macdRSIConflict ? 0.4 : 1.0; // reduce MACD weight when RSI is extreme opposite
    if (macdRSIConflict) reasons.push(`MACD/RSI conflict - intraday RSI ${spyRSI} oversold, MACD dampened`);
    if (spyMACD && spyMACD.includes("bullish crossover"))  { score += Math.round(15*macdMult); reasons.push(`SPY MACD bullish crossover (+${Math.round(15*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bullish"))       { score += Math.round(8*macdMult);  reasons.push(`SPY MACD bullish (+${Math.round(8*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bearish crossover")) { score -= Math.round(15*macdMult); reasons.push(`SPY MACD bearish crossover (-${Math.round(15*macdMult)})`); }
    else if (spyMACD && spyMACD.includes("bearish"))       { score -= Math.round(5*macdMult);  reasons.push(`SPY MACD bearish (-${Math.round(5*macdMult)})`); }

    // - Breadth - normalized to recent history -
    // Raw 80% means nothing without context - normalized reading is more meaningful
    // Compare current breadth to recent 10-reading range
    const bHist10 = (state._breadthHistory || []).map(b => b.v);
    const bMin = bHist10.length >= 3 ? Math.min(...bHist10) : 0;
    const bMax = bHist10.length >= 3 ? Math.max(...bHist10) : 100;
    const bRange = bMax - bMin;
    // Normalized breadth: 0-100 within recent range (above/below recent midpoint)
    const bNorm = bRange > 5 ? ((breadth - bMin) / bRange) * 100 : 50; // 50 = neutral if no range
    if (bNorm >= 75 && breadth >= 60)      { score += 10; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - strong relative to recent (+10)`); }
    else if (bNorm >= 60)                  { score += 6;  reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - recovering (+6)`); }
    else if (bNorm <= 30 && ["trending_bull","recovery"].includes(regime)) {
      score += 12; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - low relative to recent in bull regime - ideal dip entry (+12)`);
    }
    else if (bNorm <= 20)                  { score -= 8; reasons.push(`Breadth ${breadth}% (${bNorm.toFixed(0)}th pctile) - very weak relative to recent (-8)`); }

    // - VIX - absolute level matters for calls, not just direction -
    // Low VIX = cheap call premium = historically excellent call entry cost
    // High VIX = expensive calls + wrong macro environment for bull thesis
    if (vix <= 18)            { score += 12; reasons.push(`VIX ${vix} - calls historically cheap, low premium (+12)`); }
    else if (vix <= 22)       { score += 8;  reasons.push(`VIX ${vix} - moderate, calls reasonably priced (+8)`); }
    else if (vix >= 35)       { score -= 10; reasons.push(`VIX ${vix} - calls expensive in fear environment (-10)`); }
    // VIX direction (falling = calls gaining value, spiking = calls losing)
    if (vixOutlook === "falling")      { score += 12; reasons.push("VIX compressing - call premium expanding (+12)"); }
    else if (vixOutlook === "mean_reverting") { score += 6; reasons.push("VIX mean reverting - calls improving (+6)"); }
    else if (vixOutlook === "spiking") { score -= 12; reasons.push("VIX spiking - calls losing value fast (-12)"); }

    // - VWAP (TA-C2: now used for index instruments) -
    // VWAP is calculated but was discarded for index instruments - fixed here
    const callVWAP = stock.intradayVWAP || 0;
    const callPrice = stock.price || 0;
    if (callVWAP > 0 && callPrice > 0) {
      const vwapDiff = (callPrice - callVWAP) / callVWAP;
      if (vwapDiff < -0.005)      { score += 8; reasons.push(`Below VWAP ${(vwapDiff*100).toFixed(1)}% - dip entry (+8)`); }
      else if (vwapDiff > 0.015)  { score -= 5; reasons.push(`Extended above VWAP ${(vwapDiff*100).toFixed(1)}% - chasing (+-5)`); }
    }

    // - IV Percentile - cost of entry matters for spreads -
    // High IVR = expensive spreads = worse risk/reward even with same directional thesis
    // Low IVR = cheap spreads = same expected move costs less
    // Note: debit spreads partially offset high IV by selling the short leg
    // so penalty is softer than for naked options
    const ivpCall = stock.ivPercentile || 50;
    const highVIXNow = vix >= 30;
    if (ivpCall < 25)      { score += 10; reasons.push(`IVP ${ivpCall}% - cheap call spreads, favorable entry (+10)`); }
    else if (ivpCall < 45) { score += 5;  reasons.push(`IVP ${ivpCall}% - moderate IV, reasonable entry (+5)`); }
    else if (ivpCall >= 75 && !highVIXNow) { score -= 8; reasons.push(`IVP ${ivpCall}% - expensive calls in calm VIX (-8)`); }
    else if (ivpCall >= 75)  { score -= 3; reasons.push(`IVP ${ivpCall}% - expensive but VIX elevated, partial offset (-3)`); }

    // - Weekly trend alignment (slope-aware) -
    // TA-W3: MA slope matters more than price position
    const weeklyTrend    = stock._weeklyTrend || {};
    const trendCtx       = weeklyTrend.trendContext;
    if (trendCtx === 'aligned_bull')   { score += 10; reasons.push(`10-wk MA aligned bull (${weeklyTrend.maSlopeDir}) (+10)`); }
    else if (trendCtx === 'pullback_bull') { score += 6; reasons.push(`10-wk MA rising - pullback buy (+6)`); }
    else if (trendCtx === 'confirmed_bear') { score -= 12; reasons.push(`10-wk MA falling + price below - confirmed bear (-12)`); }
    else if (weeklyTrend.above10wk === true)  { score += 5; reasons.push("Above 10-wk MA (+5)"); }
    else if (weeklyTrend.above10wk === false) { score -= 5; reasons.push("Below 10-wk MA (-5)"); }

    // - Momentum -
    // Recovering momentum in bull regime = dip is done, resuming uptrend
    if (spyMomentum === "recovering" && ["trending_bull","recovery"].includes(regime)) {
      score += 10; reasons.push("Momentum recovering in bull regime - resuming uptrend (+10)");
    } else if (spyMomentum === "steady") {
      score += 3; reasons.push("Momentum steady (+3)");
    }

    // - Entry bias -
    // Market maker fix: halve bonus when agent already scored bullish to avoid double-counting
    // Agent signal + regime already capture the macro view - bias refines TIMING not direction
    const agentAlreadyBullish = ["strongly bullish","bullish","mild bullish"].includes(signal);
    if (entryBias === "calls_on_dips") {
      if (spyMomentum === "recovering" || spyRSI <= 45) {
        const biasBonus = agentAlreadyBullish ? 6 : 12;
        score += biasBonus; reasons.push(`Entry bias: calls on dips - dip confirmed (+${biasBonus})`);
      } else {
        const biasBonus = agentAlreadyBullish ? 3 : 6;
        score += biasBonus; reasons.push(`Entry bias: calls on dips (+${biasBonus})`);
      }
    }
    if (entryBias === "avoid") { score = Math.min(score, 0); reasons.push("Agent says avoid - blocked"); }

    // - QQQ - requires tech bullish confirmation -
    // Relaxed: QQQ can lead in tech rallies - only penalize if NO bullish thesis
    if (stock.ticker === "QQQ") {
      const techBullish = (agentMacro || {}).bullishTickers &&
        agentMacro.bullishTickers.some(t => ["NVDA","MSFT","AAPL","META","GOOGL","AMD"].includes(t));
      if (!techBullish && !["trending_bull","recovery"].includes(regime)) {
        score -= 10; reasons.push("QQQ: no tech bullish thesis in non-bull regime (-10)");
      } else if (techBullish) {
        score += 5; reasons.push("QQQ: tech names bullish (+5)");
      }
    }

    // - IWM - small caps confirm broad market strength -
    if (stock.ticker === "IWM" && ["trending_bull","recovery"].includes(regime)) {
      score += 8; reasons.push("IWM in bull/recovery regime - small cap confirmation (+8)");
    }
  }

  // Apply supplementary signals - capped at +25 total to prevent domination
  if (supplementScore > 0) {
    const cappedSupp = Math.min(25, supplementScore);
    score += cappedSupp;
    if (cappedSupp < supplementScore) {
      reasons.push(`Supplementary signals capped at +${cappedSupp} (raw: +${supplementScore})`);
    }
  }
  // Full 100-point scale - cap at 100 not 95 to preserve resolution at high conviction
  score = Math.max(0, Math.min(100, score));
  return { score, reasons, tradeType: tradeType || "spread" };
}

// - Put Setup Scoring -
function scorePutSetup(stock, relStrength, adx, volume, avgVolume, vix = 20) {
  let score = 0;
  const reasons = [];

  // Momentum - weak is good for puts (20pts)
  // Steady momentum = no directional signal = 0 points (not a put catalyst)
  if (stock.momentum === "recovering")       { score += 20; reasons.push("Weak momentum - bearish (+20)"); }
  else if (stock.momentum === "steady")      { score += 0;  reasons.push("Momentum steady - neutral for put (+0)"); }
  else                                       { score += 0;  reasons.push("Strong momentum - bad for put (+0)"); }

  // RSI - RAISED to 20pts (more reliable signal, especially in trending markets)
  // RSI - 35 = stock already crashed - put thesis is GONE, not a valid entry
  // RSI 36-45 = oversold, apply meaningful penalty not a bonus
  if (stock.rsi >= 72)                       { score += 20; reasons.push(`RSI ${stock.rsi} - overbought (+20)`); }
  else if (stock.rsi >= 65 && stock.rsi < 72){ score += 12; reasons.push(`RSI ${stock.rsi} - elevated (+12)`); }
  else if (stock.rsi <= 35)                  { score -= 30; reasons.push(`RSI ${stock.rsi} - stock already crashed, put thesis gone (-30)`); }
  else if (stock.rsi <= 45)                  { score -= 10; reasons.push(`RSI ${stock.rsi} - oversold, put thesis weak (-10)`); }
  else                                       { reasons.push(`RSI ${stock.rsi} neutral for put (+0)`); }

  // MACD - confirms direction. Bullish MACD on a put = contradicting signal = PENALTY
  if (stock.macd.includes("bearish crossover")) { score += 10; reasons.push("MACD bearish crossover (+10)"); }
  else if (stock.macd.includes("bearish"))      { score += 7;  reasons.push("MACD bearish (+7)"); }
  else if (stock.macd.includes("neutral"))      { score += 3;  reasons.push("MACD neutral (+3)"); }
  else if (stock.macd.includes("bullish crossover")) { score -= 12; reasons.push("MACD bullish crossover - contradicts put (-12)"); }
  else                                          { score -= 8;  reasons.push("MACD bullish - contradicts put (-8)"); }

  // IV Percentile - ADJUSTED for VIX environment
  // High VIX: high IVP is expected and acceptable - options are expensive but moves are big
  // Low VIX: penalize high IVP more - no reason to buy expensive puts in calm market
  const ivpP = stock.ivPercentile || 50;
  const highVIX = vix > 30;
  if (ivpP < 30)       { score += 15; reasons.push(`IVP ${ivpP}% - cheap options (+15)`); }
  else if (ivpP < 50)  { score += 10; reasons.push(`IVP ${ivpP}% - moderate (+10)`); }
  else if (ivpP < 70)  { score += highVIX ? 8 : 5; reasons.push(`IVP ${ivpP}% - elevated (${highVIX ? "+8 high VIX" : "+5"})`); }
  else                 { score += highVIX ? 5 : 0; reasons.push(`IVP ${ivpP}% - expensive (${highVIX ? "+5 high VIX justified" : "+0"})`); }

  // News sentiment (15pts) - replaces static bearishCatalyst
  // Live bearish news is much more meaningful than a hardcoded string
  const newsMod = stock.newsSentiment === "bearish" ? 15
                : stock.newsSentiment === "mild bearish" ? 8
                : stock.newsSentiment === "neutral" ? 3
                : 0; // bullish news = bad for puts
  if (newsMod > 0) reasons.push(`News ${stock.newsSentiment} (+${newsMod})`);
  else if (stock.momentum === "recovering" && stock.hasIntraday) {
    score += 8; reasons.push("Intraday confirmed bearish move (+8)");
  }
  score += newsMod;

  // Volume confirmation - DIRECTIONAL: below VWAP + high vol = stronger put signal
  const belowVWAP = stock.intradayVWAP > 0 && (stock.price || 0) < stock.intradayVWAP;
  if (volume && avgVolume && volume > avgVolume * 1.2) {
    const volPts = belowVWAP ? 12 : 8; // directional bonus when below VWAP
    score += volPts; reasons.push(`Above-avg volume ${belowVWAP ? "+ below VWAP" : ""} (+${volPts})`);
  } else if (volume && avgVolume && volume > avgVolume) {
    score += 5; reasons.push("Average volume (+5)");
  } else { reasons.push("Low volume (+0)"); }

  // Relative weakness vs SPY - capped at 15pts, tracked for group cap
  let spyWeakPts = 0;
  if (relStrength < 0.93)      { spyWeakPts = 15; reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+15)`); }
  else if (relStrength < 0.97) { spyWeakPts = 8;  reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+8)`); }
  else if (relStrength < 1.0)  { spyWeakPts = 3;  reasons.push(`Slightly weak vs SPY (+3)`); }
  else                         { reasons.push(`Outperforming SPY - bad for put (+0)`); }
  score += spyWeakPts;

  // ADX - RAISED to 15pts max (strong downtrend is a top-tier confirmation)
  if (adx && adx > 35)      { score += 15; reasons.push(`ADX ${adx} - very strong downtrend (+15)`); }
  else if (adx && adx > 25) { score += 10; reasons.push(`ADX ${adx} - strong trend (+10)`); }
  else if (adx && adx > 18) { score += 5;  reasons.push(`ADX ${adx} - emerging trend (+5)`); }

  // - F6: Signal consensus gate -
  // 90+ score requires at least 3 independent bullish signals
  // Prevents weak setups from hitting 100 on environmental factors alone
  // Hard block: RSI - 35 means stock already crashed - force score to 0, never enters
  if (stock.rsi <= 35) {
    return { score: 0, reasons }; // hard zero - RSI crashed stocks never get put entries
  }

  const bullishSignals = [
    stock.rsi >= 65,
    stock.macd.includes("bearish"),
    stock.momentum === "recovering",
    (relStrength < 0.97),
    (adx && adx > 25),
    (volume > avgVolume * 1.2),
  ].filter(Boolean).length;
  if (score >= 90 && bullishSignals < 3) {
    score = 80; // cap at 80 - not enough independent signals
    reasons.push(`Score capped at 80 - only ${bullishSignals}/3 required signals agree`);
  }

  // - F11: Entry quality gate - RSI and MACD must agree -
  // If RSI says overbought (bearish for stock) but MACD says bullish,
  // the two primary signals conflict. Flag it.
  const rsiPutSignal  = stock.rsi >= 65;
  const macdPutSignal = stock.macd.includes("bearish");
  if (!rsiPutSignal && !macdPutSignal) {
    score = Math.max(0, score - 15);
    reasons.push("Neither RSI nor MACD confirm put direction (-15)");
  }

  // Hard cap at 95 - a 100/100 is now mathematically impossible
  // Forces discrimination between setups even in broad selloffs
  const _sigResult = { score: Math.min(Math.max(score, 0), 95), reasons };
  setCache(sigKey, _sigResult);
  return _sigResult;
}

// - Alpaca API -
const alpacaHeaders = () => ({
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type":        "application/json",
});

// API call tracking - informational only, Pro tier has no rate limit
let apiCallsThisMinute = 0;
let apiWindowStart     = Date.now();

function trackAPICall() {
  const now = Date.now();
  if (now - apiWindowStart > 60000) {
    apiCallsThisMinute = 0;
    apiWindowStart     = now;
  }
  apiCallsThisMinute++;
  return true;
}

// Timeout wrapper - kills hung API calls after 5 seconds
function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("API timeout")), ms))
  ]);
}

// - SE-W1: Alpaca circuit breaker -
// Consecutive Alpaca failures pause trading to prevent state corruption
// Resets on first successful call
let _alpacaConsecFails = 0;
const ALPACA_CIRCUIT_THRESHOLD = 5; // 5 consecutive failures = circuit open
let _alpacaCircuitOpen = false;

async function alpacaGet(endpoint, base = ALPACA_BASE) {
  try {
    trackAPICall();
    const res  = await withTimeout(fetch(`${base}${endpoint}`, { headers: alpacaHeaders() }));
    const text = await res.text();
    if (text.startsWith("<")) {
      _alpacaConsecFails++;
      if (res.status === 429) { logEvent("warn", `Rate limit hit: ${endpoint} - slowing down`); await new Promise(r => setTimeout(r, 2000)); }
      else if (res.status === 401 || res.status === 403) { logEvent("error", `Auth error ${res.status} on ${endpoint} - check API keys`); }
      else { logEvent("warn", `API returned HTML on ${endpoint} (status ${res.status}) - skipping`); }
      if (_alpacaConsecFails >= ALPACA_CIRCUIT_THRESHOLD && !_alpacaCircuitOpen) {
        _alpacaCircuitOpen = true;
        logEvent("warn", `[CIRCUIT] Alpaca API degraded (${_alpacaConsecFails} consecutive failures) - new entries paused`);
        if (RESEND_API_KEY && GMAIL_USER) sendResendEmail("ARGO-V2.5 ALERT - Alpaca API degraded",
          `<p>${_alpacaConsecFails} consecutive Alpaca failures. New entries paused. Check Railway logs.</p>`).catch(()=>{});
      }
      return null;
    }
    // Successful call - reset circuit
    if (_alpacaConsecFails > 0) {
      logEvent("scan", `[CIRCUIT] Alpaca API recovered after ${_alpacaConsecFails} failures`);
      _alpacaConsecFails = 0;
      _alpacaCircuitOpen = false;
    }
    return JSON.parse(text);
  } catch(e) {
    _alpacaConsecFails++;
    if (_alpacaConsecFails >= ALPACA_CIRCUIT_THRESHOLD && !_alpacaCircuitOpen) {
      _alpacaCircuitOpen = true;
      logEvent("warn", `[CIRCUIT] Alpaca API circuit open after network failures`);
    }
    logEvent("error", `alpacaGet(${endpoint}): ${e.message}`);
    return null;
  }
}

async function alpacaPost(endpoint, body, method = "POST") {
  try {
    const opts = { method, headers: alpacaHeaders() };
    if (body && Object.keys(body).length > 0) opts.body = JSON.stringify(body);
    const res = await withTimeout(fetch(`${ALPACA_BASE}${endpoint}`, opts), 8000);
    const text = await res.text();
    if (!text || text.trim() === "") return { ok: true }; // DELETE returns empty
    // Alpaca cancel endpoint returns plain text "Not Found" when order already gone
    if (res.status === 404 || text.trim() === "Not Found") return { status: "not_found" };
    try { return JSON.parse(text); }
    catch(e) { return { status: res.status, raw: text }; } // non-JSON fallback
  } catch(e) { logEvent("error", `alpacaPost(${endpoint}): ${e.message}`); return null; }
}

async function alpacaDelete(endpoint) {
  return alpacaPost(endpoint, {}, "DELETE");
}

// Get latest stock quote
async function getStockQuote(ticker) {
  const data = await alpacaGet(`/stocks/${ticker}/quotes/latest`, ALPACA_DATA);
  if (data && data.quote) {
    // Stale data check - reject quotes older than 5 minutes during market hours
    const quoteTime = data.quote.t ? new Date(data.quote.t).getTime() : Date.now();
    const ageMs     = Date.now() - quoteTime;
    const STALE_MS  = 5 * 60 * 1000; // 5 minutes
    if (ageMs > STALE_MS && isMarketHours()) {
      logEvent("warn", `${ticker} quote is ${(ageMs/60000).toFixed(1)}min old - stale data, skipping`);
      return null; // return null so calling code skips this stock
    }
    return parseFloat(data.quote.ap || data.quote.bp || 0);
  }
  // Fallback to snapshot
  const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
  if (snap && snap.latestTrade) return parseFloat(snap.latestTrade.p || 0);
  return null;
}

// Get stock bars for volume and MA calculation
async function getStockBars(ticker, limit = 60) {
  // Daily bars only update once per day - cache for 60 minutes
  const cacheKey = 'bars:' + ticker + ':' + limit;
  const cached = getCached(cacheKey, BARS_CACHE_TTL);
  if (cached) return cached;
  try {
    // Always use date range - more reliable than limit param across all Alpaca tiers
    const end   = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - Math.ceil(limit * 1.6) * MS_PER_DAY).toISOString().split("T")[0];
    // Try SIP feed first (Pro tier), fall back to IEX (free tier)
    const feeds = ["sip", "iex"];
    for (const feed of feeds) {
      const url  = `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&feed=${feed}`;
      const data = await alpacaGet(url, ALPACA_DATA);
      if (data && data.bars && data.bars.length > 1) {
        // Daily bars don't change intraday - cache for 60 minutes
        return setCache('bars:' + ticker + ':' + limit, data.bars);
      }
    }
    // Last resort - no feed param
    const last = await alpacaGet(`/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}`, ALPACA_DATA);
    return last && last.bars ? last.bars : [];
  } catch(e) { return []; }

}

// Get intraday bars - 1-minute candles for today's session
// Used for real-time RSI, MACD, VWAP, momentum signals
// 1-minute gives maximum real-time accuracy - updated every scan cycle
async function getIntradayBars(ticker, minutes = 390) {
  try {
    // Calculate market open in ET (Railway runs UTC - must use ET explicitly)
    const nowET       = getETTime();
    const marketOpen  = new Date(nowET);
    marketOpen.setHours(9, 30, 0, 0);

    // Convert ET market open back to UTC ISO for Alpaca API
    // getETTime returns a Date object representing ET - get its UTC equivalent
    const etOffsetMs  = nowET.getTime() - new Date().getTime(); // ET offset from UTC
    const openUTC     = new Date(marketOpen.getTime() - etOffsetMs);
    const startISO    = openUTC.toISOString();
    const endISO      = new Date().toISOString();

    const feeds = ["sip", "iex"];
    for (const feed of feeds) {
      const url  = `/stocks/${ticker}/bars?timeframe=1Min&start=${startISO}&end=${endISO}&limit=390&feed=${feed}`;
      const data = await alpacaGet(url, ALPACA_DATA);
      if (data && data.bars && data.bars.length >= 5) return data.bars;
    }
    return [];
  } catch(e) { return []; }
}

// Get VIX - cached for 60 seconds to avoid redundant API calls
let _vixCache = { value: 15, ts: 0 };
async function getVIX() {
  // OPT-2: 60s TTL -- VIX at 30s granularity has zero trading value, saves 1 API call/scan
  if (Date.now() - _vixCache.ts < 60000) return _vixCache.value;
  const data = await alpacaGet(`/stocks/VIXY/quotes/latest`, ALPACA_DATA);
  if (data && data.quote) {
    _vixCache = { value: parseFloat(data.quote.ap || 15), ts: Date.now() };
    return _vixCache.value;
  }
  return _vixCache.value; // return last known on error
}

// Get real options chain from Alpaca OPRA feed
// Returns best contract matching our delta target and expiry window
// - Earnings Calendar -
async function getEarningsDate(ticker) {
  try {
    const today = getETTime().toISOString().split("T")[0];
    const end   = new Date(Date.now() + 60 * MS_PER_DAY).toISOString().split("T")[0];
    const data  = await alpacaGet(`/corporate_actions/announcements?ca_types=Earnings&symbols=${ticker}&since=${today}&until=${end}`, ALPACA_DATA);
    if (data && data.announcements && data.announcements.length > 0) {
      return data.announcements[0].ex_date || null;
    }
    return null;
  } catch(e) { return null; }
}

// - News Feed -
// [cache block moved to top of file]

// Company name map for Marketaux search fallback
const COMPANY_NAMES = {
  NVDA:"Nvidia", AAPL:"Apple", MSFT:"Microsoft", AMZN:"Amazon", META:"Meta",
  GOOGL:"Alphabet Google", AMD:"AMD Advanced Micro", AVGO:"Broadcom", ARM:"ARM Holdings",
  MU:"Micron", SMCI:"Super Micro", CRM:"Salesforce", NOW:"ServiceNow", SNOW:"Snowflake",
  CRWD:"CrowdStrike", PANW:"Palo Alto Networks", NET:"Cloudflare",
  JPM:"JPMorgan", BAC:"Bank of America", C:"Citigroup", MS:"Morgan Stanley",
  COIN:"Coinbase", HOOD:"Robinhood", MSTR:"MicroStrategy", SQ:"Block Square",
  TSLA:"Tesla", NFLX:"Netflix", UBER:"Uber", SHOP:"Shopify",
  DKNG:"DraftKings", NKE:"Nike", ROKU:"Roku", PLTR:"Palantir",
  WFC:"Wells Fargo", BABA:"Alibaba", TTD:"The Trade Desk",
  SPY:"S&P 500", QQQ:"Nasdaq",
};

async function getNewsForTicker(ticker) {
  const cached = getCached('news:' + ticker);
  if (cached) return cached;
  try {
    const data = await alpacaGet(`/news?symbols=${ticker}&limit=5`, ALPACA_NEWS);
    const articles = data && data.news ? data.news : [];
    if (articles.length > 0) return setCache('news:' + ticker, articles);

    // Alpaca returned nothing - try Marketaux with company name
    const MARKETAUX_KEY = process.env.MARKETAUX_KEY || "";
    if (MARKETAUX_KEY) {
      const name    = COMPANY_NAMES[ticker] || ticker;
      const url     = `https://api.marketaux.com/v1/news/all?search=${encodeURIComponent(name)}&language=en&limit=3&api_token=${MARKETAUX_KEY}`;
      const res     = await withTimeout(fetch(url), 6000);
      if (res.ok) {
        const mxData = await res.json();
        if (mxData.data && mxData.data.length > 0) {
          // Normalize to Alpaca format
          const normalized = mxData.data.map(a => ({
            headline:   a.title || "",
            summary:    a.description || "",
            created_at: a.published_at || new Date().toISOString(),
            author:     a.source || "Marketaux",
          }));
          return setCache('news:' + ticker, normalized);
        }
      }
    }
    return setCache('news:' + ticker, []);
  } catch(e) { return []; }
}

function analyzeNews(articles) {
  if (!articles || !articles.length) return { modifier: 0, signal: "neutral", headlines: [] };
  const bullishWords = ["beat","beats","raised","upgrade","strong","surge","record","growth","positive","bullish","buy","outperform","exceeds"];
  const bearishWords = ["miss","misses","cut","downgrade","weak","falls","concern","negative","bearish","sell","underperform","below","warning","recall","investigation","lawsuit","fraud"];
  let bullCount = 0, bearCount = 0;
  const headlines = [];
  for (const article of articles.slice(0, 5)) {
    const text = (article.headline + " " + (article.summary || "")).toLowerCase();
    if (bullishWords.some(w => text.includes(w))) bullCount++;
    if (bearishWords.some(w => text.includes(w))) bearCount++;
    headlines.push(article.headline);
  }
  const net = bullCount - bearCount;
  if (net >= 2)  return { modifier: 10,  signal: "bullish",      headlines };
  if (net === 1) return { modifier: 5,   signal: "mild bullish", headlines };
  if (net <= -2) return { modifier: -15, signal: "bearish",      headlines };
  if (net === -1)return { modifier: -8,  signal: "mild bearish", headlines };
  return { modifier: 0, signal: "neutral", headlines };
}

// - VIX Velocity -
let lastVIXReading  = 0;   // 0 = uninitialized
let vixFallingPause = false; // true when VIX is falling - suppresses new put entries
// - VIX Mean Reversion Timing (Guo & Whitelaw 2006) -
// High VIX historically reverts to mean within 15-20 trading days on average
// Use current VIX level to estimate expected reversion time
// This informs DTE selection - if VIX at 37, put spreads should mature before reversion
function getVIXReversionDays(vix) {
  // Based on G&W empirical half-life estimates by VIX regime
  if (vix >= 40) return 8;   // extreme VIX reverts fastest (mean-pull strongest)
  if (vix >= 35) return 12;  // very elevated - expect 2-3 week reversion
  if (vix >= 30) return 18;  // elevated - 3-4 week typical reversion
  if (vix >= 25) return 25;  // moderately elevated
  return 40;                  // near normal - slow reversion
}

function checkVIXVelocity(currentVIX) {
  if (lastVIXReading === 0) { lastVIXReading = currentVIX; return false; }
  const delta   = currentVIX - lastVIXReading;
  const prevVIX = lastVIXReading; // save before updating
  lastVIXReading = currentVIX;
  const fallPct = prevVIX > 0 ? (delta / prevVIX) : 0;

  // Black swan: VIX spiked 8+ points - close all positions
  if (delta >= 8) {
    logEvent("circuit", `VIX VELOCITY ALERT - jumped ${delta.toFixed(1)} points to ${currentVIX} - closing all positions`);
    return true;
  }

  // VIX falling >3% = market recovering = pause new put entries
  // Falling VIX means options premiums deflating - puts entered now lose value fast
  if (delta <= -1.0 && fallPct <= -0.03) {
    if (!vixFallingPause) logEvent("filter", `VIX falling (${delta.toFixed(1)} pts) - pausing new PUT entries until VIX stabilizes`);
    vixFallingPause = true;
  } else if (delta >= 0) {
    // VIX stable or rising - resume put entries
    if (vixFallingPause) logEvent("filter", `VIX stabilized - resuming PUT entries`);
    vixFallingPause = false;
  }
  return false;
}

// - Pre-Market Gap Scanner -
async function getPreMarketData(ticker) {
  const cached = getCached('premarket:' + ticker);
  if (cached) return cached;
  try {
    // Get latest quote - pre-market activity shows in extended hours
    const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
    if (!snap) return null;
    const prevClose   = snap.prevDailyBar  ? snap.prevDailyBar.c  : null;
    const preMarket   = snap.minuteBar     ? snap.minuteBar.c     : null;
    const dailyOpen   = snap.dailyBar      ? snap.dailyBar.o      : null;
    if (!prevClose || !preMarket) return null;
    const gapPct      = (preMarket - prevClose) / prevClose * 100;
    return setCache('premarket:' + ticker, { prevClose, preMarket, gapPct: parseFloat(gapPct.toFixed(2)) });
  } catch(e) { return null; }
}

// - Beta-Weighted Portfolio Delta -
// - F16: Aggregate vega + gamma -
function calcAggregateGreeks() {
  if (!state.positions || !state.positions.length) return { vega: 0, gamma: 0, vegaDollar: 0, vegaRisk: "LOW" };
  let totalVega = 0, totalGamma = 0;
  for (const pos of state.positions) {
    const vega     = parseFloat(pos.greeks?.vega  || 0);
    const gamma    = parseFloat(pos.greeks?.gamma || 0);
    const mult     = (pos.contracts || 1) * 100;
    totalVega  += vega  * mult;
    totalGamma += gamma * mult;
  }
  const vegaDollar = parseFloat((totalVega * 0.01 * 100).toFixed(2));
  return {
    vega:       parseFloat(totalVega.toFixed(4)),
    gamma:      parseFloat(totalGamma.toFixed(4)),
    vegaDollar, // $ change per 1pt VIX move
    vegaRisk:   Math.abs(vegaDollar) > 500 ? "HIGH" : Math.abs(vegaDollar) > 200 ? "MEDIUM" : "LOW",
  };
}

function calcBetaWeightedDelta() {
  if (!state.positions || !state.positions.length) return 0;
  // Use cached SPY price from scan context, or fetch fresh - never use hardcoded value
  const spyPrice = (state.positions.find(p => p.ticker === "SPY")?.price) || state._liveSPY || 560;
  let totalBWD   = 0;
  for (const pos of state.positions) {
    const delta    = parseFloat(pos.greeks?.delta || 0);
    const beta     = pos.beta || 1;
    const price    = pos.price || 100;
    const contracts= pos.contracts || 1;
    // Beta-weighted delta = delta * beta * (stock price / SPY price) * 100 * contracts
    const bwd      = delta * beta * (price / spyPrice) * 100 * contracts;
    totalBWD      += pos.optionType === "put" ? -bwd : bwd;
  }
  return parseFloat(totalBWD.toFixed(2));
}

// - Analyst Upgrades/Downgrades via Alpaca news -
async function getAnalystActivity(ticker) {
  const cached = getCached('analyst:' + ticker);
  if (cached) return cached;
  try {
    const data = await alpacaGet(`/news?symbols=${ticker}&limit=10`, ALPACA_NEWS);
    const articles = data && data.news ? data.news : [];
    const upgrades   = [];
    const downgrades = [];
    const upgradeKW  = ["upgrade", "upgraded", "outperform", "overweight", "buy rating", "price target raised", "pt raised"];
    const downgradeKW= ["downgrade", "downgraded", "underperform", "underweight", "sell rating", "price target cut", "pt cut", "pt lowered"];
    for (const a of articles) {
      const text = (a.headline + " " + (a.summary || "")).toLowerCase();
      if (upgradeKW.some(k => text.includes(k)))   upgrades.push(a.headline);
      if (downgradeKW.some(k => text.includes(k))) downgrades.push(a.headline);
    }
    return setCache('analyst:' + ticker, { upgrades, downgrades,
      signal: upgrades.length > downgrades.length ? "bullish" : downgrades.length > upgrades.length ? "bearish" : "neutral",
      modifier: (upgrades.length - downgrades.length) * 5
    });
  } catch(e) { return { upgrades: [], downgrades: [], signal: "neutral", modifier: 0 }; }
}

// - Short Interest (FINRA publishes bi-monthly, approximate via price action) -
async function getShortInterestSignal(ticker, bars) {
  // True short interest requires paid data feed
  // Approximate squeeze potential from: price momentum + volume spike + RSI
  try {
    if (!bars || bars.length < 10) return { squeezeRisk: "low", modifier: 0 };
    const recentVol  = bars.slice(-5).reduce((s, b) => s + b.v, 0) / 5;
    const avgVol     = bars.slice(-20).reduce((s, b) => s + b.v, 0) / 20;
    const volRatio   = avgVol > 0 ? recentVol / avgVol : 1;
    const priceMove  = bars.length >= 5 ? (bars[bars.length-1].c - bars[bars.length-5].c) / bars[bars.length-5].c : 0;
    // High volume + strong upward move = potential short squeeze
    if (volRatio > 2.5 && priceMove > 0.05)  return { squeezeRisk: "high",   modifier: 15 };
    if (volRatio > 1.5 && priceMove > 0.02)  return { squeezeRisk: "medium", modifier: 8  };
    return { squeezeRisk: "low", modifier: 0 };
  } catch(e) { return { squeezeRisk: "low", modifier: 0 }; }
}

// - Macro Calendar -
const MACRO_EVENTS_2025 = [
  // FOMC meetings 2025
  { date: "2025-03-19", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2025-05-07", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2025-06-18", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2025-07-30", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2025-09-17", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2025-11-05", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2025-12-17", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  // FOMC 2026
  { date: "2026-01-29", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2026-03-18", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2026-04-29", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2026-06-17", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2026-07-29", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2026-09-16", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2026-11-04", event: "FOMC Meeting", impact: "high",   type: "fed"       },
  { date: "2026-12-16", event: "FOMC Meeting", impact: "high",   type: "fed"       },
];

function getUpcomingMacroEvents(daysAhead = 7) {
  // Compare date strings to avoid timezone/time-of-day issues
  const todayStr = getETTime().toISOString().split("T")[0]; // "2026-03-17"
  const todayDate = new Date(todayStr);
  const events = [];
  for (const ev of MACRO_EVENTS_2025) {
    const evDate = new Date(ev.date);
    const daysTo = Math.round((evDate - todayDate) / MS_PER_DAY);
    if (daysTo >= 0 && daysTo <= daysAhead) {
      events.push({ ...ev, daysTo });
    }
  }
  return events;
}

function getMacroCalendarModifier() {
  const events = getUpcomingMacroEvents(3);
  if (!events.length) return { modifier: 0, events: [] };
  const highImpact = events.filter(e => e.impact === "high");
  // Within 3 days of FOMC - reduce position sizing, avoid new entries day-of
  if (highImpact.length > 0) {
    const soonest = highImpact.sort((a, b) => a.daysTo - b.daysTo)[0];
    if (soonest.daysTo === 0) return { modifier: -25, events, message: `${soonest.event} TODAY - minimal new entries` };
    if (soonest.daysTo <= 1) return { modifier: -15, events, message: `${soonest.event} tomorrow - reduced sizing` };
    if (soonest.daysTo <= 3) return { modifier: -8,  events, message: `${soonest.event} in ${soonest.daysTo} days - caution` };
  }
  return { modifier: 0, events };
}


// - Earnings Quality Scoring -
async function getEarningsQualityScore(ticker, bars) {
  try {
    if (!bars || bars.length < 30) return { score: 50, signal: "unknown" };
    const bigMoves = [];
    for (let i = 1; i < bars.length; i++) {
      const move = Math.abs((bars[i].c - bars[i-1].c) / bars[i-1].c * 100);
      if (move > 3) bigMoves.push({ move, direction: bars[i].c > bars[i-1].c ? 1 : -1 });
    }
    if (!bigMoves.length) return { score: 50, signal: "neutral" };
    const positiveMoves = bigMoves.filter(m => m.direction > 0).length;
    const score = Math.round((positiveMoves / bigMoves.length) * 100);
    return { score, signal: score >= 65 ? "positive" : score <= 35 ? "negative" : "mixed", bigMoves: bigMoves.length, positiveReactions: positiveMoves };
  } catch(e) { return { score: 50, signal: "unknown" }; }
}

// - Factor Model -
function calcFactorScore(stock, signals, relStrength, newsModifier, analystModifier) {
  const factors = {};
  factors.momentum    = signals.momentum === "strong" ? 25 : signals.momentum === "steady" ? 15 : 5;
  const rsi           = signals.rsi || 50;
  factors.trend       = rsi >= 50 && rsi <= 65 ? 20 : rsi >= 45 && rsi < 50 ? 12 : rsi > 65 && rsi <= 75 ? 8 : 5;
  factors.relStrength = relStrength > 1.05 ? 20 : relStrength > 1.02 ? 15 : relStrength > 1.0 ? 10 : 5;
  const ivr           = signals.ivr || stock.ivr || 50;
  factors.value       = ivr < 25 ? 20 : ivr < 40 ? 15 : ivr < 55 ? 10 : 5;
  const sentimentRaw  = (newsModifier || 0) + (analystModifier || 0);
  factors.sentiment   = parseFloat(Math.min(15, Math.max(0, 7 + sentimentRaw / 3)).toFixed(1));
  const total         = Object.values(factors).reduce((s, v) => s + v, 0);
  return { total: Math.min(100, Math.round(total)), factors };
}

// - Monte Carlo Simulation -
function calcKellySize(recentTrades = 20) {
  const trades  = (state.closedTrades || []).slice(0, recentTrades);
  // QS-W3: Kelly needs minimum 10 trades for any statistical relevance
  // Below 10 trades, Kelly is noise not signal - default to 1 contract
  // Below 20 trades, Kelly is unreliable - cap its influence at half weight
  if (trades.length < 5)  return { contracts: 1, kelly: null, halfKelly: null, winRate: null, payoffRatio: null, note: "Need 5+ trades" };
  if (trades.length < 10) return { contracts: 1, kelly: null, halfKelly: null, winRate: null, payoffRatio: null, note: "Need 10+ trades for Kelly" };
  const wins      = trades.filter(t => t.pnl > 0);
  const losses    = trades.filter(t => t.pnl <= 0);
  const winRate   = wins.length / trades.length;
  const avgWin    = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss   = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  const payoff    = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kelly     = winRate - (1 - winRate) / payoff;
  const halfKelly = Math.max(0, kelly * 0.5);
  // Hard cap: max 2 contracts until 30 validated trades
  // Kelly on small samples produces dangerously high sizing
  // Chan: adjust Kelly for current drawdown - deeper drawdown = smaller fraction
  // Vince: Kelly fraction should DECAY on consecutive losses, not reset
  const peakCap    = state.peakCash || MONTHLY_BUDGET;
  // Use mark-to-market value not cost basis - openRisk() uses currentPrice
  const currentVal = state.cash + openRisk();
  const drawdownPct = peakCap > 0 ? (peakCap - currentVal) / peakCap : 0;
  const ddAdj      = drawdownPct > 0.15 ? 0.50   // >15% drawdown: half Kelly
                   : drawdownPct > 0.10 ? 0.65   // >10% drawdown: 65% of Kelly
                   : drawdownPct > 0.05 ? 0.80   // >5% drawdown: 80% of Kelly
                   : 1.0;                          // <5% drawdown: full Kelly
  // Vince: consecutive losses decay Kelly fraction - don't just reset
  const consecLoss = state.consecutiveLosses || 0;
  const consAdj    = consecLoss >= 3 ? 0.50      // 3+ losses: half Kelly
                   : consecLoss >= 2 ? 0.70       // 2 losses: 70% of Kelly
                   : consecLoss >= 1 ? 0.85       // 1 loss: 85% of Kelly
                   : 1.0;
  const adjustedHalfKelly = halfKelly * ddAdj * consAdj;
  const rawContracts = Math.min(3, Math.max(1, Math.round(adjustedHalfKelly * 10)));
  const contracts    = trades.length < 30 ? Math.min(2, rawContracts) : rawContracts;
  return { contracts, kelly: parseFloat(kelly.toFixed(3)), halfKelly: parseFloat(adjustedHalfKelly.toFixed(3)), winRate: parseFloat((winRate*100).toFixed(1)), payoffRatio: parseFloat(payoff.toFixed(2)), cappedPre30: trades.length < 30, ddAdj, consAdj };
}

// - Regime Detection -
// Identifies current market regime: trending_bull, trending_bear, choppy, breakdown
async function detectMarketRegime() {
  try {
    const bars  = await getStockBars("SPY", 60);
    if (bars.length < 50) return { regime: "unknown", confidence: 0, details: {} };

    const closes  = bars.map(b => b.c);
    const highs   = bars.map(b => b.h);
    const lows    = bars.map(b => b.l);

    // Calculate key indicators
    const sma20   = closes.slice(-20).reduce((s, c) => s + c, 0) / 20;
    const sma50   = closes.slice(-50).reduce((s, c) => s + c, 0) / 50;
    const current = closes[closes.length - 1];
    const adx     = calcADX(bars);

    // 20-day volatility (annualized)
    const returns  = closes.slice(-20).map((c, i) => i > 0 ? Math.log(c / closes[closes.length - 21 + i]) : 0).slice(1);
    const stdDev   = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) * Math.sqrt(252) * 100;

    // Recent momentum
    const mom5   = (current - closes[closes.length - 5])  / closes[closes.length - 5]  * 100;
    const mom20  = (current - closes[closes.length - 20]) / closes[closes.length - 20] * 100;

    // Determine regime
    let regime, confidence, action;

    if (current > sma20 && sma20 > sma50 && adx > 25 && mom20 > 2) {
      regime     = "trending_bull";
      confidence = Math.min(100, Math.round(adx + mom20 * 3));
      action     = "Full position sizing. Favor calls. Aggressive entries.";
    } else if (current < sma20 && sma20 < sma50 && adx > 25 && mom20 < -2) {
      regime     = "trending_bear";
      confidence = Math.min(100, Math.round(adx + Math.abs(mom20) * 3));
      action     = "Reduced sizing. Favor puts. Avoid new calls.";
    } else if (adx < 20 && stdDev < 15) {
      regime     = "choppy";
      confidence = Math.min(100, Math.round((20 - adx) * 3));
      action     = "Minimal entries. Wait for breakout. Tighten stops.";
    } else if (mom5 < -3 && stdDev > 25) {
      regime     = "breakdown";
      confidence = Math.min(100, Math.round(stdDev + Math.abs(mom5) * 5));
      action     = "Defensive mode. Close calls. Consider puts only.";
    } else {
      regime     = "neutral";
      confidence = 50;
      action     = "Normal operations. Standard position sizing.";
    }

    return {
      regime, confidence, action,
      details: { sma20: sma20.toFixed(2), sma50: sma50.toFixed(2), adx: adx.toFixed(1), stdDev: stdDev.toFixed(1), mom5: mom5.toFixed(1), mom20: mom20.toFixed(1), current: current.toFixed(2) }
    };
  } catch(e) { return { regime: "unknown", confidence: 0, action: "Normal operations.", details: {} }; }
}

// Regime-based score modifier
// - F9: Regime strategy profiles -
// Each regime has different min score, max positions, and exit tightness

function getRegimeModifier(regime, optionType) {
  const modifiers = {
    trending_bull: { call: 15,  put: -15 },
    trending_bear: { call: -15, put: 15  },
    choppy:        { call: -10, put: -10 },
    breakdown:     { call: -25, put: 10  },
    neutral:       { call: 0,   put: 0   },
    unknown:       { call: 0,   put: 0   },
  };
  return (modifiers[regime] || modifiers.neutral)[optionType] || 0;
}

// - Stress Test -
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

// - Time of Day Analysis -
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

// - Concentration Risk -
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

// - Drawdown Recovery Protocol -
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

// - Benchmark Comparison -
async function getBenchmarkComparison() {
  try {
    const spyBars = await getStockBars("SPY", 30);
    if (spyBars.length < 2) return null;
    const spyReturn   = (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c * 100;
    const apexReturn  = ((state.cash + (state.positions||[]).reduce((s,p)=>s+p.cost,0)) - MONTHLY_BUDGET) / MONTHLY_BUDGET * 100;
    const alpha       = apexReturn - spyReturn;
    return {
      spyReturn:  parseFloat(spyReturn.toFixed(2)),
      apexReturn: parseFloat(apexReturn.toFixed(2)),
      alpha:      parseFloat(alpha.toFixed(2)),
      beating:    alpha > 0,
    };
  } catch(e) { return null; }
}


// - Position Scaling -
// Enter half position first, add second half if trade confirms (+5% in 24hrs)
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

// - Macro News Scanner -
// - Macro keyword scoring with weights -
// Each keyword has a weight (1-3) - high-impact events score more than minor ones
// Weight 3 = major market-moving event (Fed decision, war, ceasefire)
// Weight 2 = significant but not immediate (data misses, sector-specific)
// Weight 1 = minor signal (single company, regional story)

const MACRO_BEARISH_KEYWORDS = [
  // Fed / monetary tightening (weight 3)
  { kw: "fed rate hike",          w: 3 }, { kw: "rate hike",               w: 2 },
  { kw: "hawkish",                w: 2 }, { kw: "quantitative tightening", w: 2 },
  { kw: "tightening",             w: 1 },
  // Inflation (weight 2-3)
  { kw: "inflation surge",        w: 3 }, { kw: "cpi beat",                w: 3 },
  { kw: "inflation hot",          w: 2 }, { kw: "pce beat",                w: 2 },
  { kw: "core inflation",         w: 2 },
  // Trade / tariffs (weight 2-3)
  { kw: "tariff",                 w: 2 }, { kw: "trade war",               w: 3 },
  { kw: "sanctions",              w: 2 }, { kw: "export controls",         w: 2 },
  { kw: "chip ban",               w: 2 }, { kw: "china tariff",            w: 3 },
  { kw: "china tensions",         w: 2 }, { kw: "taiwan strait",           w: 3 },
  // Geopolitical conflict (weight 2-3)
  { kw: "war",                    w: 3 }, { kw: "military strike",         w: 3 },
  { kw: "invasion",               w: 3 }, { kw: "conflict escalation",     w: 3 },
  { kw: "blockade",               w: 2 }, { kw: "strait",                  w: 2 },
  // Economic weakness (weight 2-3)
  { kw: "recession",              w: 3 }, { kw: "gdp miss",                w: 3 },
  { kw: "gdp contraction",        w: 3 }, { kw: "unemployment rise",       w: 2 },
  { kw: "jobless claims surge",   w: 2 }, { kw: "layoffs",                 w: 2 },
  { kw: "job cuts",               w: 1 },
  // Financial stress (weight 2-3)
  { kw: "bank failure",           w: 3 }, { kw: "credit crunch",           w: 3 },
  { kw: "debt ceiling",           w: 2 }, { kw: "default",                 w: 3 },
  { kw: "downgrade",              w: 2 }, { kw: "bank run",                w: 3 },
  { kw: "regional banks",         w: 2 }, { kw: "liquidity crisis",        w: 3 },
  // Energy / supply (weight 1-2)
  { kw: "oil spike",              w: 2 }, { kw: "energy crisis",           w: 2 },
  { kw: "supply shock",           w: 2 }, { kw: "shortage",                w: 1 },
  { kw: "opec cut",               w: 2 }, { kw: "production cut",          w: 2 },
  // Market stress (weight 2-3)
  { kw: "yield inversion",        w: 2 }, { kw: "10-2 spread",             w: 2 },
  { kw: "volatility surge",       w: 2 }, { kw: "government shutdown",     w: 2 },
  { kw: "shutdown",               w: 1 }, { kw: "dollar strengthening",    w: 1 },
  { kw: "earnings miss",          w: 2 }, { kw: "guidance cut",            w: 2 },
  { kw: "profit warning",         w: 2 },
];

const MACRO_BULLISH_KEYWORDS = [
  // Fed / monetary easing (weight 3)
  { kw: "fed rate cut",           w: 3 }, { kw: "rate cut",                w: 2 },
  { kw: "dovish",                 w: 2 }, { kw: "quantitative easing",     w: 2 },
  { kw: "easing",                 w: 1 }, { kw: "stimulus",                w: 2 },
  { kw: "soft landing",           w: 2 }, { kw: "pause rate",              w: 2 },
  // Inflation cooling (weight 2-3)
  { kw: "inflation cooling",      w: 2 }, { kw: "cpi miss",                w: 3 },
  { kw: "inflation slows",        w: 2 }, { kw: "pce miss",                w: 2 },
  { kw: "disinflation",           w: 2 },
  // Economic strength (weight 2)
  { kw: "strong jobs",            w: 2 }, { kw: "unemployment falls",      w: 2 },
  { kw: "gdp beat",               w: 3 }, { kw: "gdp growth",              w: 2 },
  { kw: "beat expectations",      w: 1 }, { kw: "consumer confidence rises",w: 2 },
  { kw: "retail sales beat",      w: 2 }, { kw: "earnings beat",           w: 2 },
  { kw: "record earnings",        w: 2 }, { kw: "guidance raised",         w: 2 },
  { kw: "profit beat",            w: 2 },
  // Geopolitical resolution (weight 2-3)
  { kw: "ceasefire",              w: 3 }, { kw: "peace deal",              w: 3 },
  { kw: "peace talks",            w: 2 }, { kw: "truce",                   w: 3 },
  { kw: "accord",                 w: 2 }, { kw: "end to conflict",         w: 3 },
  { kw: "deescalation",           w: 2 }, { kw: "de-escalation",           w: 2 },
  { kw: "diplomatic",             w: 1 },
  // Trade resolution (weight 2-3)
  { kw: "tariff pause",           w: 3 }, { kw: "tariff suspended",        w: 3 },
  { kw: "tariff removed",         w: 3 }, { kw: "tariff cut",              w: 2 },
  { kw: "trade deal",             w: 3 }, { kw: "trade agreement",         w: 3 },
  { kw: "trade truce",            w: 2 }, { kw: "sanctions lifted",        w: 2 },
  { kw: "sanctions relief",       w: 2 }, { kw: "iran deal",               w: 3 },
  { kw: "us-iran",                w: 2 }, { kw: "trump deal",              w: 2 },
  { kw: "trade resolution",       w: 2 }, { kw: "agreement reached",       w: 2 },
  // China positive (weight 2)
  { kw: "china stimulus",         w: 2 }, { kw: "pboc",                    w: 2 },
  { kw: "beijing stimulus",       w: 2 },
  // Debt / budget resolution (weight 2)
  { kw: "debt deal",              w: 2 }, { kw: "budget deal",             w: 2 },
  { kw: "continuing resolution",  w: 1 },
  // Tech / AI optimism (weight 1-2)
  { kw: "ai breakthrough",        w: 1 }, { kw: "nvidia beat",             w: 2 },
  // Market / energy relief (weight 1-2)
  { kw: "oil falls",              w: 2 }, { kw: "energy prices drop",      w: 2 },
  { kw: "supply chain recovery",  w: 2 }, { kw: "risk on",                 w: 1 },
  { kw: "market rally",           w: 1 }, { kw: "stocks surge",            w: 1 },
];

// Credible source list - articles from these sources get a 1.5x weight multiplier
// Lower-tier sources (blogs, forums) stay at 1.0x
const CREDIBLE_SOURCES = [
  "reuters", "bloomberg", "ap ", "associated press", "wall street journal", "wsj",
  "financial times", "ft ", "cnbc", "federal reserve", "fed ", "white house",
  "treasury", "sec ", "imf", "world bank", "ecb", "bank of england",
  "new york times", "washington post", "the economist"
];

// Sector-specific impact from macro events
const SECTOR_MACRO_IMPACT = {
  "rate hike":     { bearish: ["Technology", "Financial"], bullish: [] },
  "rate cut":      { bearish: [], bullish: ["Technology", "Financial"] },
  "oil spike":     { bearish: ["Consumer", "Technology"], bullish: ["Energy"] },
  "opec cut":      { bearish: ["Consumer", "Technology"], bullish: ["Energy"] },
  "oil falls":     { bearish: ["Energy"], bullish: ["Consumer", "Technology"] },
  "tariff":        { bearish: ["Technology", "Consumer"], bullish: [] },
  "china tariff":  { bearish: ["Technology", "Consumer"], bullish: [] },
  "trade deal":    { bearish: [], bullish: ["Technology", "Consumer"] },
  "recession":     { bearish: ["Financial", "Consumer", "Technology"], bullish: [] },
  "stimulus":      { bearish: [], bullish: ["Technology", "Financial", "Consumer"] },
  "chip ban":      { bearish: ["Technology"], bullish: [] },
  "bank failure":  { bearish: ["Financial"], bullish: [] },
  "ai breakthrough":{ bearish: [], bullish: ["Technology"] },
};

// - Marketaux news fetch -
// Returns top financial headlines from credible sources
// Requires MARKETAUX_KEY env var - gracefully skips if not set
// - Claude Agent Helper -
// Single reusable function for all Claude API calls in APEX
// Falls back gracefully if key not set or call fails
// Agent tools definition - passed to Claude API for tool use
const AGENT_TOOLS = [
  {
    name: "getQuote",
    description: "Get current live price and day change % for a stock ticker",
    input_schema: { type: "object", properties: { ticker: { type: "string", description: "Stock ticker symbol e.g. AAPL" } }, required: ["ticker"] }
  },
  {
    name: "getLiveSignals",
    description: "Get live technical signals for a stock: RSI, momentum, VWAP",
    input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] }
  },
  {
    name: "getPositionStatus",
    description: "Get full status of an open position including P&L, DTE, Greeks, entry reasons",
    input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] }
  },
  {
    name: "getMarketStatus",
    description: "Get overall market status: SPY price/change, VIX, breadth, PDT remaining, cash",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "getIVRank",
    description: "Get IV rank (0-100) for the market. IVR 70+ = sell premium aggressively. IVR 50-70 = credit spreads favorable. IVR <30 = buy premium preferred.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "getRegimeStatus",
    description: "Get current regime class (A/B/C), days below 200MA, sustained VIX, SPY drawdown, and recommended strategy mode.",
    input_schema: { type: "object", properties: {} }
  }
];

async function callClaudeAgent(systemPrompt, userPrompt, maxTokens = 800, useTools = false, enableCache = true, timeoutMs = 30000) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const messages = [{ role: "user", content: userPrompt }];

    // Prompt caching - system prompt is identical per call type, cache it
    // Cache writes: 125% of normal input price. Cache reads: 10% of normal input price.
    // Break-even: ~2 reads. After that, ~90% savings on input tokens.
    // getAgentMacroAnalysis runs ~80x/day - saves ~$1.50/day in input costs
    const systemBlock = enableCache
      ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
      : systemPrompt;

    const body = {
      model:      ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system:     systemBlock,
      messages,
    };
    if (useTools) body.tools = AGENT_TOOLS;

    const headers = {
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    };
    if (enableCache) headers["anthropic-beta"] = "prompt-caching-2024-07-31";

    const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers,
      body: JSON.stringify(body),
    }), timeoutMs);

    if (!res.ok) {
      const err = await res.text();
      logEvent("warn", `[AGENT] API error ${res.status}: ${err.slice(0, 120)}`);
      return null;
    }

    const data = await res.json();

    // Handle tool use - agent wants to fetch live data
    if (useTools && data.stop_reason === "tool_use") {
      const toolCalls  = data.content.filter(b => b.type === "tool_use");
      const toolResults= await dispatchAgentTools(toolCalls);

      // Continue conversation with tool results
      const followMessages = [
        { role: "user",      content: userPrompt },
        { role: "assistant", content: data.content },
        {
          role: "user",
          content: toolCalls.map(tc => ({
            type:        "tool_result",
            tool_use_id: tc.id,
            content:     JSON.stringify(toolResults[tc.name + (tc.input.ticker ? '_' + tc.input.ticker : '')] || toolResults[tc.name] || {}),
          }))
        }
      ];

      const followHeaders = {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      };
      if (enableCache) followHeaders["anthropic-beta"] = "prompt-caching-2024-07-31";
      const followRes = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
        method:  "POST",
        headers: followHeaders,
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemBlock, messages: followMessages }),
      }), timeoutMs);

      if (!followRes.ok) {
        const ferr = await followRes.text().catch(() => '');
        logEvent("warn", `[AGENT] Tool follow error ${followRes.status}: ${ferr.slice(0,80)}`);
        return null;
      }
      const followData = await followRes.json();
      const text = followData.content?.find(b => b.type === "text")?.text || "";
      return text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    }

    // Log cache performance when available
    if (enableCache && data.usage) {
      const u = data.usage;
      const cacheRead  = u.cache_read_input_tokens  || 0;
      const cacheWrite = u.cache_creation_input_tokens || 0;
      const uncached   = u.input_tokens || 0;
      if (cacheRead > 0 || cacheWrite > 0) {
        logEvent("scan", `[CACHE] read:${cacheRead} write:${cacheWrite} uncached:${uncached} - saved ~$${(cacheRead*3/1000000).toFixed(4)}`);
      }
    }
    // Normal text response
    const text = data.content?.find(b => b.type === "text")?.text || "";
    return text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  } catch(e) {
    logEvent("warn", `[AGENT] Call failed: ${e.message}`);
    return null;
  }
}

// Marketaux cache - only fetch every 30 minutes to stay within free tier (100/day)
let _marketauxCache = { data: [], fetchedAt: 0 };
const MARKETAUX_CACHE_MS = 60 * 60 * 1000; // 60 minutes - stays well under free tier 100/day limit

async function getMarketauxNews() {
  const MARKETAUX_KEY = process.env.MARKETAUX_KEY || "";
  if (!MARKETAUX_KEY) return [];
  // Return cached data if fresh enough
  if (_marketauxCache.data.length > 0 && Date.now() - _marketauxCache.fetchedAt < MARKETAUX_CACHE_MS) {
    return _marketauxCache.data;
  }
  try {
    const url = `https://api.marketaux.com/v1/news/all?language=en&limit=20&api_token=${MARKETAUX_KEY}&filter_entities=true&must_have_entities=false`;
    const res  = await withTimeout(fetch(url), 8000);
    if (!res.ok) return _marketauxCache.data; // return stale on error
    const data = await res.json();
    if (!data.data) return _marketauxCache.data;
    _marketauxCache = {
      fetchedAt: Date.now(),
      data: data.data.map(a => ({
        headline:    a.title || "",
        summary:     a.description || "",
        source:      (a.source || "").toLowerCase(),
        publishedAt: a.published_at || new Date().toISOString(),
        url:         a.url || "",
      }))
    };
    console.log(`[MARKETAUX] Fetched ${_marketauxCache.data.length} articles`);
    return _marketauxCache.data;
  } catch(e) {
    console.log("[MARKETAUX] Fetch error:", e.message);
    return _marketauxCache.data; // return stale on error
  }
}

// - Agent-powered macro analysis -
// Replaces keyword matching with genuine language understanding
// Falls back to keyword system if agent unavailable
let _agentMacroCache = { result: null, fetchedAt: 0 };
const AGENT_MACRO_CACHE_MS = 3 * 60 * 1000; // 3 minutes - faster macro reaction with only 2 instruments

// - Agent Day Plan - pre-market strategic assessment -
// Runs at 6am, 7:30am, 8:30am ET before market opens
// Gives APEX a full strategic picture before first scan fires at 9:30am
// Returns structured dayPlan object used to gate entries all session
async function getAgentDayPlan(scanType = "morning") {
  if (!ANTHROPIC_API_KEY) return null;

  const systemPrompt = `You are the head macro strategist for ARGO-V2.5, a systematic SPY/QQQ options spread trading system. Return ONLY valid JSON - no markdown, no preamble.

{"regime":"trending_bear"|"trending_bull"|"choppy"|"breakdown"|"recovery"|"neutral","signal":"strongly bearish"|"bearish"|"mild bearish"|"neutral"|"mild bullish"|"bullish"|"strongly bullish","confidence":"high"|"medium"|"low","entryBias":"puts_on_bounces"|"calls_on_dips"|"neutral"|"avoid","tradeType":"spread"|"credit"|"naked"|"none","suppressUntil":null|"HH:MM","riskLevel":"low"|"medium"|"high","vixOutlook":"spiking"|"elevated_stable"|"mean_reverting"|"falling","keyLevels":{"spySupport":null,"spyResistance":null},"catalysts":[],"reasoning":"2 sentences max","weeklyBias":"bullish"|"bearish"|"neutral","overnightMove":"string describing futures direction"}

Rules:
- suppressUntil: set to "HH:MM" ET if high-impact event today (CPI 08:30, FOMC 14:00, NFP 08:30) - ARGO-V2.5 will not enter before this time
- riskLevel high = FOMC day, CPI day, major geopolitical event - reduce position size
- entryBias puts_on_bounces = bearish trend, wait for intraday relief before entering puts
- entryBias calls_on_dips = bullish trend, wait for intraday weakness before entering calls
- tradeType naked = sharp mean-reversion expected (quick move), spread = grinding trend
- Focus on 3-10 day outlook, not just today`;

  // Fetch overnight context
  const [headlines, mktStatus] = await Promise.all([
    getMacroNews().catch(() => ({ headlines: [] })),
    agentTool_getMarketStatus().catch(() => ({})),
  ]);
  const headlineList = (headlines.headlines || headlines.topStories || []).slice(0, 15);

  const userPrompt = `Pre-market ${scanType} assessment - ${new Date().toLocaleString('en-US', {timeZone:'America/New_York'})} ET

Market snapshot:
- VIX: ${mktStatus.vix || state.vix || '--'} | SPY: ${mktStatus.spy?.price || '--'} (${mktStatus.spy?.dayChangePct || '--'}% today)
- Breadth: ${mktStatus.breadth ? (mktStatus.breadth*100).toFixed(0)+'%' : '--'} | F&G: ${mktStatus.fearGreed || '--'}
- Open positions: ${(state.positions||[]).map(p => `${p.ticker}(${p.optionType==='put'?'P':'C'}${p.isSpread?'-SPRD':''})`).join(', ') || 'none'}

${headlineList.length > 0 ? 'Key headlines:\n' + headlineList.map((h,i) => `${i+1}. ${h}`).join('\n') : 'No headlines available'}

What is your strategic assessment for today's trading session?`;

  try {
    const raw = await callClaudeAgent(systemPrompt, userPrompt, 500, false);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.signal || !parsed.regime) return null;
    parsed.generatedAt = new Date().toISOString();
    parsed.scanType = scanType;
    state._dayPlan = parsed;
    state._dayPlanDate = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York'});
    logEvent("macro", `[DAY PLAN] ${scanType.toUpperCase()} | ${parsed.regime} | ${parsed.signal} (${parsed.confidence}) | bias: ${parsed.entryBias} | risk: ${parsed.riskLevel}${parsed.suppressUntil ? ' | suppress until ' + parsed.suppressUntil : ''} | ${parsed.reasoning?.slice(0,80)}`);
    await saveStateNow();
    return parsed;
  } catch(e) {
    logEvent("warn", `[DAY PLAN] ${scanType} failed: ${e.message}`);
    return null;
  }
}

// - Agent Post-Market Assessment -
// Runs at 4:15pm and 6pm ET - reviews session, sets overnight risk flags
async function getAgentPostMarketAssessment(scanType = "post-market") {
  if (!ANTHROPIC_API_KEY) return null;

  const systemPrompt = `Post-market analyst for ARGO-V2.5. Return ONLY valid JSON - no markdown.
{"overnightRisk":"low"|"medium"|"high","holdRecommendations":{},"tomorrowBias":"bullish"|"bearish"|"neutral","catalystsTomorrow":[],"reasoning":"1-2 sentences"}
holdRecommendations: {ticker: "HOLD"|"MONITOR"|"EXIT_AT_OPEN"} for each open position.`;

  const positions = (state.positions || []).map(p => ({
    ticker: p.ticker, type: p.optionType, isSpread: p.isSpread,
    pnlPct: p.currentPrice && p.premium ? ((p.currentPrice - p.premium)/p.premium*100).toFixed(1) : '0',
    daysOpen: ((Date.now() - new Date(p.openDate).getTime())/MS_PER_DAY).toFixed(1),
    expDate: p.expDate,
  }));

  const [headlines, mktStatus] = await Promise.all([
    getMacroNews().catch(() => ({ headlines: [] })),
    agentTool_getMarketStatus().catch(() => ({})),
  ]);

  const userPrompt = `${scanType} assessment - ${new Date().toLocaleString('en-US', {timeZone:'America/New_York'})} ET
VIX: ${mktStatus.vix || state.vix} | SPY close: ${mktStatus.spy?.price || '--'}
Open positions: ${JSON.stringify(positions)}
Recent headlines: ${(headlines.headlines || []).slice(0,5).join(' | ')}
What is the overnight risk and tomorrow's bias?`;

  try {
    const raw = await callClaudeAgent(systemPrompt, userPrompt, 500, false);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    parsed.generatedAt = new Date().toISOString();
    logEvent("macro", `[POST-MARKET] overnight risk: ${parsed.overnightRisk} | tomorrow: ${parsed.tomorrowBias} | ${parsed.reasoning?.slice(0,80)}`);

    // Flag positions for exit at open if agent says so
    for (const pos of (state.positions || [])) {
      const rec = parsed.holdRecommendations?.[pos.ticker];
      if (rec === "EXIT_AT_OPEN") {
        pos._morningExitFlag = true;
        pos._morningExitReason = `Post-market agent: overnight risk ${parsed.overnightRisk}`;
        logEvent("warn", `[POST-MARKET] ${pos.ticker} flagged for exit at open - ${parsed.reasoning}`);
      }
    }
    await saveStateNow();
    return parsed;
  } catch(e) {
    logEvent("warn", `[POST-MARKET] ${scanType} failed: ${e.message}`);
    return null;
  }
}

// - SE/BF note: Claude agent is inherently probabilistic (LLM) -
// The same market conditions presented on different days may produce different signals
// due to LLM temperature and context variation. This is expected behavior - not a bug.
// The system is not purely deterministic: rules are deterministic, agent is probabilistic.
// Do not assume identical inputs produce identical outputs from the agent.
// - AG-6: exitUrgency handler - check after agent macro update -
function applyExitUrgency(agentResult) {
  if (!agentResult || !agentResult.exitUrgency) return;
  const urgency = agentResult.exitUrgency;
  if (urgency === "hold" || urgency === "monitor") return; // no action
  const positions = state.positions || [];
  if (positions.length === 0) return;
  if (urgency === "trim" || urgency === "exit") {
    logEvent("macro", `[AGENT] exitUrgency=${urgency} - ${urgency === "exit" ? "scheduling exit on all losing positions" : "flagging for trim review"}`);
    // Flag positions for rescore - actual close happens via rescore path with user confirmation
    positions.forEach(p => {
      p._exitUrgencyFlag = urgency;
      p._exitUrgencySetAt = Date.now();
    });
  }
}

async function getAgentMacroAnalysis(headlines) {
  if (!ANTHROPIC_API_KEY || !headlines || headlines.length === 0) return null;
  // Return cached result if fresh
  if (_agentMacroCache.result && Date.now() - _agentMacroCache.fetchedAt < AGENT_MACRO_CACHE_MS) {
    return _agentMacroCache.result;
  }
  const systemPrompt = `You are the head macro strategist for ARGO-V2.5, a systematic SPY/QQQ options trading system. Return ONLY valid JSON - no markdown, no preamble.

{"signal":"strongly bearish"|"bearish"|"mild bearish"|"neutral"|"mild bullish"|"bullish"|"strongly bullish","modifier":-20to20,"confidence":"high"|"medium"|"low","mode":"defensive"|"cautious"|"normal"|"aggressive","reasoning":"1 sentence","regime":"trending_bear"|"trending_bull"|"choppy"|"breakdown"|"recovery"|"neutral","regimeDuration":"intraday"|"1-3 days"|"3-7 days"|"1-2 weeks"|"multi-week","entryBias":"puts_on_bounces"|"calls_on_dips"|"neutral"|"avoid","tradeType":"spread"|"credit"|"naked"|"none","vixOutlook":"spiking"|"elevated_stable"|"mean_reverting"|"falling"|"unknown","keyLevels":{"spySupport":null,"spyResistance":null},"catalysts":[],"bearishTickers":[],"bullishTickers":[],"themes":[],"exitUrgency":"hold"|"monitor"|"trim"|"exit","positionSizeMult":0.25|0.5|0.75|1.0|1.25|1.5,"schemaVersion":2}

Rules: regime=what SPY does next 3-10 days. entryBias: puts_on_bounces=bearish trend wait for relief; calls_on_dips=bullish wait for weakness. tradeType: spread=grinding trend, naked=sharp mean-reversion, none=unclear. vixOutlook: spiking=buy puts aggressively, falling=puts losing value. exitUrgency: hold=thesis intact, monitor=watch closely, trim=close half, exit=close all. positionSizeMult: 0.25=minimal, 1.0=normal, 1.5=high conviction. Focus on 3-10 day outlook not just today. schemaVersion always 2.`;

  // Pre-fetch market status so agent doesn't need to tool-call for it
  const mktStatus = await agentTool_getMarketStatus().catch(() => ({}));

  // - AG-1: Gap status - tells agent if today opened with a gap -
  const spyBarsForAgent = await getStockBars("SPY", 60).catch(() => []);
  let gapStatus = "no_gap";
  if (spyBarsForAgent.length >= 2) {
    const prevClose   = spyBarsForAgent[spyBarsForAgent.length-2].c;
    const todayOpen   = spyBarsForAgent[spyBarsForAgent.length-1].o;
    const todayClose  = spyBarsForAgent[spyBarsForAgent.length-1].c;
    const gapPctAgent = (todayOpen - prevClose) / prevClose;
    const isHolding   = Math.abs(todayClose - todayOpen) / Math.abs(todayOpen - prevClose || 1) < 0.5;
    if (gapPctAgent > 0.01) gapStatus = isHolding ? "gap_up_holding" : "gap_up_fading";
    else if (gapPctAgent < -0.01) gapStatus = isHolding ? "gap_down_holding" : "gap_down_fading";
  }

  // - AG-2: SPY 50MA/200MA injection -
  let spyMA50 = null, spyMA200 = null, spyMA50Slope = null;
  // Also stored in state._spyMA50 so TLT gate can access it in scan loop
  if (spyBarsForAgent.length >= 50) {
    const closes50  = spyBarsForAgent.slice(-50).map(b => b.c);
    spyMA50  = parseFloat((closes50.reduce((s,c)=>s+c,0)/50).toFixed(2));
    const prev50Closes = spyBarsForAgent.length >= 55 ? spyBarsForAgent.slice(-55,-5).map(b=>b.c) : closes50;
    const prevMA50 = prev50Closes.reduce((s,c)=>s+c,0)/prev50Closes.length;
    spyMA50Slope = ((spyMA50 - prevMA50) / prevMA50 * 100).toFixed(2);
  }
  if (spyBarsForAgent.length >= 200) {
    const closes200 = spyBarsForAgent.slice(-200).map(b => b.c);
    spyMA200 = parseFloat((closes200.reduce((s,c)=>s+c,0)/200).toFixed(2));
  }
  const spyPrice = mktStatus.spy?.price || state._liveSPY || 0;
  const spyVsMA50  = spyMA50  ? ((spyPrice - spyMA50)  / spyMA50  * 100).toFixed(1) : null;
  const spyVsMA200 = spyMA200 ? ((spyPrice - spyMA200) / spyMA200 * 100).toFixed(1) : null;
  // Persist SPY 50MA for TLT gate and 200MA regime filter
  if (spyMA50)  state._spyMA50  = spyMA50;
  if (spyMA200) state._spyMA200 = spyMA200;

  // - 1C: REGIME DURATION TRACKING -
  // Track how long SPY has been below 200MA, sustained VIX, SPY drawdown
  // Powers regime A/B/C classification and strategy selection
  const spyBelowNow = spyMA200 && spyPrice && spyPrice < spyMA200;
  if (spyBelowNow) {
    state._regimeDuration = (state._regimeDuration || 0) + 1; // days below 200MA
  } else {
    state._regimeDuration = 0; // reset when SPY recovers above 200MA
  }
  // 5-day rolling VIX average (sustained fear vs spike)
  if (!state._vixHistory) state._vixHistory = [];
  state._vixHistory.push(mktStatus.vix || state.vix || 20);
  if (state._vixHistory.length > 5) state._vixHistory.shift();
  state._vixSustained = parseFloat((state._vixHistory.reduce((s,v)=>s+v,0)/state._vixHistory.length).toFixed(1));
  // SPY drawdown from 52-week high
  const spy52wHigh = spyBarsForAgent.length > 0 ? Math.max(...spyBarsForAgent.map(b=>b.h)) : spyPrice;
  state._spyDrawdown = spy52wHigh > 0 ? parseFloat(((spyPrice - spy52wHigh) / spy52wHigh * 100).toFixed(1)) : 0;
  // Regime classification: A (bull), B (bear/trending), C (crisis)
  const regimeA = !spyBelowNow && state._vixSustained < 20;
  const regimeC = state._spyDrawdown < -20 && state._vixSustained > 35 && state._regimeDuration > 10;
  const regimeB = !regimeA && !regimeC; // trending/transitional - the current environment
  state._regimeClass = regimeC ? "C" : regimeB ? "B" : "A";

  // _regimeDuration: days SPY has been below 200MA - increment once per trading day
  // Used for regime duration boost in scoring (+5 after 3d, +10 after 5d, +15 after 10d)
  if (!state._regimeDurationDate) state._regimeDurationDate = "";
  const todayDateStr = new Date().toISOString().slice(0, 10);
  if (spyBelowNow && state._regimeDurationDate !== todayDateStr) {
    state._regimeDuration = (state._regimeDuration || 0) + 1;
    state._regimeDurationDate = todayDateStr;
  } else if (!spyBelowNow) {
    state._regimeDuration = 0; // reset when SPY recovers above 200MA
    state._regimeDurationDate = "";
  }

  logEvent("scan", `[REGIME] Class:${state._regimeClass} | Below200MA:${state._regimeDuration}d | VIX5d:${state._vixSustained} | SPYdd:${state._spyDrawdown}%`);

  // - AG-3: Account drawdown context -
  const acctBaseline = state.accountBaseline || state.peakCash || 10000;
  const acctCurrent  = state.cash + (state.positions||[]).reduce((s,p)=>s+p.cost,0);
  const acctDrawdown = ((acctCurrent - acctBaseline) / acctBaseline * 100).toFixed(1);
  const acctPhaseNow = getAccountPhase();

  // - AG-4: Portfolio heat -
  const openCost  = (state.positions||[]).reduce((s,p)=>s+p.cost,0);
  const heatPctNow = acctBaseline > 0 ? (openCost / acctBaseline * 100).toFixed(0) : 0;
  const heatCapNow = (effectiveHeatCap() * 100).toFixed(0);

  // - AG-5: Correlation alert -
  const openPutsCount  = (state.positions||[]).filter(p=>p.optionType==="put").length;
  const openCallsCount = (state.positions||[]).filter(p=>p.optionType==="call").length;
  const correlAlert    = openPutsCount >= 3 && openCallsCount === 0 ? "all_puts"
                       : openCallsCount >= 3 && openPutsCount === 0 ? "all_calls"
                       : "balanced";

  const userPrompt = `Market snapshot (live data - no need to call getMarketStatus):
- VIX: ${mktStatus.vix || state.vix || 20} | SPY: ${spyPrice || '--'} (${mktStatus.spy?.dayChangePct || '--'}%)
- Breadth: ${mktStatus.breadth ? (mktStatus.breadth*100).toFixed(0)+'%' : '--'} | Fear&Greed: ${mktStatus.fearGreed || '--'}
- Gap status: ${gapStatus}${spyMA50 ? ` | SPY vs 50MA: ${spyVsMA50}% (slope: ${spyMA50Slope}%/50d)` : ''}${spyMA200 ? ` | SPY vs 200MA: ${spyVsMA200}%` : ''}
- IV Rank: ${state._ivRank || '--'} (${state._ivEnv || '--'}) | Regime: ${state._regimeClass || 'A'} (${state._regimeDuration || 0}d below 200MA) | VIX 5d avg: ${state._vixSustained || '--'}
- SPY drawdown from 52wk high: ${state._spyDrawdown || '--'}% | Credit call mode: ${state.vix >= 25 && (state._regimeClass === 'B' || state._regimeClass === 'C') ? 'ACTIVE' : 'inactive'}
- Account: $${acctCurrent.toFixed(0)} (${acctDrawdown}% vs baseline) | Phase: ${acctPhaseNow} | Heat: ${heatPctNow}%/${heatCapNow}% cap
- Portfolio: ${openPutsCount}P / ${openCallsCount}C open | Correlation: ${correlAlert} | PDT remaining: ${mktStatus.pdtRemaining || '--'}
- Options flow: ${state._optFlow ? Object.entries(state._optFlow).map(([t,f])=>`${t} ${f.volRatio}x vol`).join(', ') : 'no unusual activity'}
- Time: ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York'})} ET
- Open positions: ${(state.positions||[]).map(p => p.ticker + '(' + (p.optionType==='put'?'P':'C') + '@' + (p.chgPct !== undefined ? (p.chgPct*100).toFixed(0)+'%' : '--') + ')').join(', ') || 'none'}

Headlines to analyze (newest first):
${headlines.slice(0, 15).map((h, i) => (i+1) + '. ' + h).join('\n')}

Respond with ONLY the JSON object. No words before or after. Start your response with { and end with }.`;

  // AG-8: Track agent health
  if (!state._agentHealth) state._agentHealth = { calls: 0, successes: 0, timeouts: 0, parseErrors: 0, lastSuccess: null };
  state._agentHealth.calls++;

  // Panel decision (7/7): disable tools on macro analysis - all data pre-injected.
  // useTools=true caused 2 sequential round-trips (4.9% timeout rate).
  // Pre-injected: VIX, SPY, MAs, breadth, regime, IV rank, headlines, positions.
  // Tools kept on rescore/briefing where live per-ticker data adds real value.
  logEvent("scan", `[AGENT] Macro call - useTools:false (pre-injected data sufficient)`);
  const raw = await callClaudeAgent(systemPrompt, userPrompt, 1200, false, true, 30000); // useTools=false - single round-trip
  if (!raw) {
    state._agentHealth.timeouts++;
    logEvent("warn", `[AGENT HEALTH] Timeout/null - ${state._agentHealth.timeouts} timeouts of ${state._agentHealth.calls} calls`);
    return null;
  }
  try {
    // Strip extended thinking tags - model may prepend <thinking>...</thinking> before JSON
    let cleanRaw = raw || "";
    if (cleanRaw.includes("<thinking>")) {
      cleanRaw = cleanRaw.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
      logEvent("warn", `[AGENT] Stripped <thinking> block - model outputting chain-of-thought before JSON`);
    }
    cleanRaw = cleanRaw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    // V2.84: If response starts with prose instead of {, extract the JSON object
    // Handles "Looking at the market..." preamble before the actual JSON
    if (!cleanRaw.startsWith("{")) {
      const jsonStart = cleanRaw.indexOf("{");
      const jsonEnd   = cleanRaw.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        logEvent("warn", `[AGENT] Response started with prose - extracting JSON from position ${jsonStart}`);
        cleanRaw = cleanRaw.slice(jsonStart, jsonEnd + 1);
      }
    }
    const parsed = JSON.parse(cleanRaw);
    // Validate required fields
    if (!parsed.signal || parsed.modifier === undefined) {
      state._agentHealth.parseErrors++;
      logEvent("warn", `[AGENT HEALTH] Parse error - missing required fields. Raw: ${raw?.slice(0,60)}`);
      return null;
    }
    state._agentHealth.successes++;
    state._agentHealth.lastSuccess = new Date().toISOString();
    const successRate = (state._agentHealth.successes / state._agentHealth.calls * 100).toFixed(0);
    _agentMacroCache = { result: parsed, fetchedAt: Date.now() };
    logEvent("macro", `[AGENT] Macro: ${parsed.signal} (${parsed.confidence}) | ${parsed.reasoning?.slice(0,80)} | health:${successRate}%`);

    // - Agent accuracy tracking (panel requirement) -
    // Record this call with current SPY price. A deferred job resolves it
    // 30min and 120min later to measure directional accuracy.
    // Accuracy = did SPY move in the direction the signal implied?
    // bearish/strongly bearish - expects SPY to fall
    // bullish/strongly bullish - expects SPY to rise
    // neutral/mild = no directional prediction - excluded from accuracy calc
    const spyNow = state._liveSPY || state.spy || 0;
    const isDirectional = !["neutral","mild bullish","mild bearish"].includes(parsed.signal);
    if (spyNow > 0 && isDirectional) {
      if (!state._agentAccuracy) state._agentAccuracy = { calls: 0, correct30: 0, correct120: 0, pending: [] };
      state._agentAccuracy.calls++;
      state._agentAccuracy.pending.push({
        id:         state._agentAccuracy.calls,
        timestamp:  Date.now(),
        signal:     parsed.signal,
        confidence: parsed.confidence,
        spyAtCall:  spyNow,
        resolved30:  false,
        resolved120: false,
      });
      // Cap pending list at 50 - resolved entries cleaned up by the deferred job
      if (state._agentAccuracy.pending.length > 50) {
        state._agentAccuracy.pending = state._agentAccuracy.pending.slice(-50);
      }
    }

    checkMacroShift(parsed.signal);
    return parsed;
  } catch(e) {
    state._agentHealth.parseErrors++;
    logEvent("warn", `[AGENT HEALTH] JSON parse exception: ${e.message} | Raw: ${raw?.slice(0,60)}`);
    return null;
  }
}


// Strip model chain-of-thought and markdown fences before JSON parsing
function stripThinking(raw) {
  if (!raw) return "";
  let clean = raw;
  if (clean.includes("<thinking>")) {
    clean = clean.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
  }
  return clean.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
}

// - Live rescore agent -
// Rescores an open position against current conditions
// Returns { score, label, reasoning, recommendation }
// - Agent Pre-Entry Check -
// Called before any order submits - lightweight yes/no from agent
// Only fires on stocks that pass scoring threshold (saves API calls)
async function getAgentPreEntryCheck(stock, score, reasons, optionType, isCreditMode = false) {
  if (!ANTHROPIC_API_KEY) return { approved: true, reason: "no API key" };

  // Check re-entry veto first (no API call needed)
  const recentLoss = (state._recentLosses || {})[stock.ticker];
  if (recentLoss) {
    const hrsSinceLoss = (Date.now() - recentLoss.closedAt) / 3600000;
    if (hrsSinceLoss < 24) {
      // Needs agent confirmation - build compact prompt
      const systemPrompt = `Options pre-entry analyst. Return JSON only: {"approved":true|false,"confidence":"high"|"medium"|"low","reason":"one sentence"}`;
      const userPrompt = `Re-entry check: ${stock.ticker} ${optionType.toUpperCase()}
Closed at a loss ${hrsSinceLoss.toFixed(1)}h ago (reason: ${recentLoss.reason}, P&L: ${recentLoss.pnlPct}%)
Current: RSI ${stock.rsi} | MACD ${stock.macd} | Momentum ${stock.momentum}
Entry macro was: ${recentLoss.agentSignal} | Current macro: ${(state._agentMacro||{}).signal||'neutral'}
Score now: ${score}/100 | Top reasons: ${reasons.slice(0,3).join('; ')}
Has the thesis genuinely changed since the loss? Approve re-entry?`;
      const raw = await callClaudeAgent(systemPrompt, userPrompt, 200, false);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          logEvent("filter", `[PRE-ENTRY] ${stock.ticker} re-entry check: ${parsed.approved ? 'APPROVED' : 'BLOCKED'} (${parsed.confidence}) - ${parsed.reason}`);
          return parsed;
        } catch(e) { return { approved: true, reason: "parse error - allowing" }; }
      }
      return { approved: true, reason: "agent unavailable - allowing" };
    }
  }

  // Hard RSI block - agent shouldn't even see this but double-check
  // Credit spreads: RSI crash = ideal (max fear premium) - bypass
  if (optionType === "put" && stock.rsi <= 35 && !isCreditMode) {
    logEvent("filter", `[PRE-ENTRY] ${stock.ticker} hard blocked - RSI ${stock.rsi} - 35`);
    return { approved: false, confidence: "high", reason: `RSI ${stock.rsi} - stock already crashed` };
  }
  // Credit spread with oversold RSI - auto-approve (this is the ideal entry condition)
  if (optionType === "put" && stock.rsi <= 35 && isCreditMode) {
    return { approved: true, confidence: "high", reason: `RSI ${stock.rsi} oversold - ideal credit put spread entry (max fear premium)` };
  }

  // Only call agent for borderline scores (70-79) or contradicting signals
  const hasBullishMACD = (stock.macd || "").includes("bullish");
  const borderline = score < 80;
  if (!borderline && !hasBullishMACD) {
    return { approved: true, reason: "high-confidence setup - skipping pre-entry check" };
  }

  const systemPrompt = `Options pre-entry analyst. Return JSON only: {"approved":true|false,"confidence":"high"|"medium"|"low","reason":"one sentence"}`;
  const userPrompt = `Pre-entry check: ${stock.ticker} ${optionType.toUpperCase()}
RSI: ${stock.rsi} | MACD: ${stock.macd} | Momentum: ${stock.momentum}
Score: ${score}/100 | Top reasons: ${reasons.slice(0,4).join('; ')}
Macro: ${(state._agentMacro||{}).signal||'neutral'} (${(state._agentMacro||{}).confidence||'unknown'})
VIX: ${state.vix}
Should ARGO-V2.5 enter this ${optionType} position?`;

  const raw = await callClaudeAgent(systemPrompt, userPrompt, 200, false);
  if (!raw) return { approved: true, reason: "agent unavailable - allowing" };
  try {
    const parsed = JSON.parse(raw);
    logEvent("filter", `[PRE-ENTRY] ${stock.ticker} ${optionType}: ${parsed.approved ? 'APPROVED' : 'BLOCKED'} (${parsed.confidence}) - ${parsed.reason}`);
    return parsed;
  } catch(e) { return { approved: true, reason: "parse error - allowing" }; }
}

async function getAgentRescore(pos) {
  if (!ANTHROPIC_API_KEY) return null;

  const daysOpen = ((Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY).toFixed(1);
  const chgPct   = pos.currentPrice && pos.premium
    ? ((pos.currentPrice - pos.premium) / pos.premium * 100).toFixed(1) : '0';
  const isProfit = parseFloat(chgPct) > 0;
  const isPDT    = isDayTrade(pos); // opened today
  const pdtLeft  = Math.max(0, PDT_LIMIT - countRecentDayTrades());
  const alpacaBal= state.alpacaCash || state.cash || 0;
  const pdtProtected = alpacaBal < 25000 && isPDT;

  const systemPrompt = `Options position analyst. Does the entry thesis still hold? Return JSON only.

{"score":0-95,"label":"STRONG"|"VALID"|"WEAK"|"DEGRADED"|"INVALID","confidence":"high"|"medium"|"low","reasoning":"1 sentence","recommendation":"HOLD"|"WATCH"|"EXIT"}

Critical rules:
- NEVER recommend EXIT on a profitable position (P&L > 0) - the exit system handles profit taking
- If PDT protected (same-day position, account <$25k): max recommendation is WATCH, never EXIT
- Score: 85+=intact, 70-84=mostly valid, 50-69=weakening, <50=broken
- Use getLiveSignals to check current RSI/momentum before deciding`;

  // Build agent history context - last 2 rescores for trend awareness
  const agentHistoryLines = (pos.agentHistory || []).slice(-2).map((h,i) =>
    `  ${i===0?'2 rescores ago':'Last rescore'}: ${h.label} (${h.score}/95) - ${h.reasoning}`
  ).join('\n');

  // Thesis integrity for context
  const thesisScore = pos.entryThesisScore || 100;
  const thesisTrend = pos.thesisHistory && pos.thesisHistory.length >= 2
    ? (pos.thesisHistory[pos.thesisHistory.length-1].score - pos.thesisHistory[pos.thesisHistory.length-2].score)
    : 0;

  const userPrompt = `Position to rescore:
- ${pos.ticker} ${pos.optionType.toUpperCase()} ${pos.isSpread ? `$${pos.buyStrike}/$${pos.sellStrike} SPREAD` : `$${pos.strike}`} exp ${pos.expDate}
- Entry: $${pos.premium} | Current: $${pos.currentPrice || pos.premium} | P&L: ${chgPct}% ${isProfit ? '(PROFITABLE - do not recommend EXIT)' : ''}
${pos.isCreditSpread ? '- CREDIT SPREAD: profit = time decay, spread value DECREASING is GOOD. Only recommend EXIT if underlying moved strongly against short strike.' : ''}
- Opened: ${daysOpen} days ago | DTE: ${Math.max(0, Math.round((new Date(pos.expDate)-new Date())/MS_PER_DAY))}d
- Entry score: ${pos.score}/100 | Entry reasons: ${(pos.reasons||[]).slice(0,4).join('; ')}
- Stock: $${pos.price || '--'} | Entry RSI: ${pos.entryRSI || '--'} | Entry MACD: ${pos.entryMACD || '--'}
- Thesis integrity: ${thesisScore}/100 ${thesisTrend < 0 ? '(degrading ' + thesisTrend + ')' : thesisTrend > 0 ? '(improving +' + thesisTrend + ')' : '(stable)'}
- VIX: ${state.vix} | Macro: ${(state._agentMacro || {}).signal || 'neutral'}
${agentHistoryLines ? '- Recent history:\n' + agentHistoryLines : ''}
${pdtProtected ? '- PDT PROTECTED: opened today, account <$25k - max recommendation is WATCH' : ''}
${pdtLeft <= 1 && !pdtProtected ? '- PDT WARNING: only ' + pdtLeft + ' day trade(s) remaining - avoid EXIT unless thesis clearly broken' : ''}

Does the thesis still hold? Score and recommend.`;

  const raw = await callClaudeAgent(systemPrompt, userPrompt, 600, true, true, 45000); // 45s - tool use needs headroom
  if (!raw) return null;
  try {
    const parsed = JSON.parse(stripThinking(raw));
    // Server-side safety guards - never trust agent alone
    if (isProfit && parsed.recommendation === "EXIT") {
      parsed.recommendation = "WATCH";
      parsed.reasoning = "(Auto-adjusted: position profitable - exit system manages profit taking) " + (parsed.reasoning || '');
    }
    if (pdtProtected && parsed.recommendation === "EXIT") {
      parsed.recommendation = "WATCH";
      parsed.reasoning = "(Auto-adjusted: PDT protected same-day position) " + (parsed.reasoning || '');
    }
    // Store in position agentHistory for future context
    const posRef = (state.positions || []).find(p => p.ticker === pos.ticker);
    if (posRef && parsed) {
      if (!posRef.agentHistory) posRef.agentHistory = [];
      posRef.agentHistory.push({
        time:           new Date().toISOString(),
        score:          parsed.score,
        label:          parsed.label,
        confidence:     parsed.confidence,
        reasoning:      parsed.reasoning,
        recommendation: parsed.recommendation,
      });
      if (posRef.agentHistory.length > 5) posRef.agentHistory = posRef.agentHistory.slice(-5);
    }
    return parsed;
  } catch(e) { return null; }
}

// - Agent Tool Functions -
// These are called by the agent mid-reasoning to fetch live data from Alpaca

// Tool 1: Live quote + pre-market
async function agentTool_getQuote(ticker) {
  try {
    const quote    = await getStockQuote(ticker);
    const bars     = await getStockBars(ticker, 2);
    const prevClose= bars.length >= 2 ? bars[bars.length-2].c : null;
    const dayChg   = quote && prevClose ? ((quote - prevClose) / prevClose * 100).toFixed(2) : null;
    return { ticker, price: quote, dayChangePct: dayChg, prevClose };
  } catch(e) { return { ticker, error: e.message }; }
}

// Tool 2: Live RSI + MACD + momentum from fresh bars
async function agentTool_getLiveSignals(ticker) {
  try {
    const bars = await getStockBars(ticker, 30);
    if (!bars || bars.length < 14) return { ticker, error: "insufficient data" };
    const rsi  = calcRSI(bars);
    const intraday = await getIntradayBars(ticker, 78);
    const vwap = intraday && intraday.length > 0
      ? intraday.reduce((s,b) => s + b.c, 0) / intraday.length : null;
    const price = bars[bars.length-1].c;
    const momentum = bars.length >= 5
      ? (price > bars[bars.length-5].c * 1.02 ? "strong"
        : price < bars[bars.length-5].c * 0.98 ? "recovering" : "steady")
      : "steady";
    return { ticker, rsi: parseFloat(rsi.toFixed(1)), momentum, vwap: vwap ? parseFloat(vwap.toFixed(2)) : null, price: parseFloat(price.toFixed(2)) };
  } catch(e) { return { ticker, error: e.message }; }
}

// Tool 3: Full position status
async function agentTool_getPositionStatus(ticker) {
  const pos = (state.positions || []).find(p => p.ticker === ticker);
  if (!pos) return { ticker, error: "not in portfolio" };
  const chgPct = pos.currentPrice && pos.premium
    ? ((pos.currentPrice - pos.premium) / pos.premium * 100).toFixed(1) : "0";
  const dteLeft = pos.expDate
    ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY)) : null;
  const daysOpen = ((Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY).toFixed(1);
  return {
    ticker, optionType: pos.optionType, strike: pos.isSpread ? `${pos.buyStrike}/${pos.sellStrike}` : pos.strike, expDate: pos.expDate,
    entryPrice: pos.premium, currentPrice: pos.currentPrice || pos.premium,
    pnlPct: parseFloat(chgPct), pnlDollar: parseFloat(((pos.currentPrice||pos.premium) - pos.premium) * 100).toFixed(0),
    dteLeft, daysOpen: parseFloat(daysOpen),
    entryScore: pos.score, entryRSI: pos.entryRSI,
    delta: pos.greeks?.delta, theta: pos.greeks?.theta,
    partialClosed: pos.partialClosed,
    entryReasons: (pos.reasons || []).slice(0, 4),
  };
}

// Tool 4: SPY + market breadth
async function agentTool_getMarketStatus() {
  try {
    const spyQuote = await getStockQuote("SPY");
    const spyBars  = await getStockBars("SPY", 5);
    const prevClose= spyBars.length >= 2 ? spyBars[spyBars.length-2].c : null;
    const dayChg   = spyQuote && prevClose ? ((spyQuote - prevClose) / prevClose * 100).toFixed(2) : null;
    return {
      spy: { price: spyQuote, dayChangePct: dayChg },
      vix: state.vix,
      breadth: state._breadth || null,
      fearGreed: marketContext.fearGreed?.score || null,
      pdtRemaining: Math.max(0, PDT_LIMIT - countRecentDayTrades()),
      cash: parseFloat((state.cash||0).toFixed(2)),
      openPositions: (state.positions||[]).length,
    };
  } catch(e) { return { error: e.message }; }
}

// Dispatch tool calls from agent response
async function dispatchAgentTools(toolCalls) {
  const results = {};
  for (const call of toolCalls) {
    try {
      if (call.name === "getQuote")          results[call.name + '_' + call.input.ticker] = await agentTool_getQuote(call.input.ticker);
      else if (call.name === "getLiveSignals")   results[call.name + '_' + call.input.ticker] = await agentTool_getLiveSignals(call.input.ticker);
      else if (call.name === "getPositionStatus") results[call.name + '_' + call.input.ticker] = await agentTool_getPositionStatus(call.input.ticker);
      else if (call.name === "getMarketStatus")   results["getMarketStatus"] = await agentTool_getMarketStatus();
      else if (call.name === "getIVRank")         results["getIVRank"] = { ivRank: state._ivRank||50, ivEnv: state._ivEnv||"normal", vix: state.vix, recommendation: (state._ivRank||50)>=70?"Sell premium aggressively":(state._ivRank||50)>=50?"Credit spreads favorable":(state._ivRank||50)>=30?"Neutral":"Buy premium preferred" };
      else if (call.name === "getRegimeStatus")   results["getRegimeStatus"] = { regimeClass: state._regimeClass||"A", daysBelow200MA: state._regimeDuration||0, vixSustained5d: state._vixSustained||state.vix, spyDrawdownPct: state._spyDrawdown||0, ivRank: state._ivRank||50, strategyMode: state._regimeClass==="C"?"Crisis: bear call credits only":state._regimeClass==="B"?"Bear trend: bear call credits + debit puts on bounces":"Bull: mean reversion, both directions", creditCallActive: !!(state.vix>=25&&(state._regimeClass==="B"||state._regimeClass==="C")) };
    } catch(e) { results[call.name] = { error: e.message }; }
  }
  return results;
}

// - Agent morning briefing writer -
// Called at 8:45am ET - writes the analyst narrative for the morning email
async function getAgentMorningBriefing(positions, macro, headlines) {
  if (!ANTHROPIC_API_KEY) return null;

  const systemPrompt = `You are the head of a proprietary options trading desk writing a morning briefing for a solo trader.
Write in the style of a senior analyst - direct, confident, actionable.
No fluff, no disclaimers, no "please note". Just what matters.

You have tools to fetch live market data - use them to get current prices and signals before writing.

Your briefing has three parts:
1. MARKET OPEN (2-3 sentences): What is the macro setup going into today's open? VIX, SPY direction, key themes.
2. POSITION REVIEW (1 sentence per position): For each open position, check its current status and say whether to hold, watch, or exit and why.
3. OPPORTUNITIES (1-2 sentences): Any mean reversion call opportunities forming? Any positions approaching targets?

Keep the entire briefing under 200 words. Be specific with numbers.`;

  const positionList = positions.map(p =>
    p.ticker + ' ' + p.optionType.toUpperCase() + ' $' + p.strike +
    ' | Entry $' + p.premium + ' | DTE ' + (p.expDate ? Math.max(0,Math.round((new Date(p.expDate)-new Date())/MS_PER_DAY)) : '?') + 'd'
  ).join('\n');

  const userPrompt = `Today is ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}.

Current macro signal: ${macro.signal || 'neutral'} ${macro.agentReasoning ? '- ' + macro.agentReasoning : ''}
VIX: ${state.vix} | Cash: $${(state.cash||0).toFixed(0)} | PDT remaining: ${Math.max(0,3-countRecentDayTrades())}/3

Open positions:
${positionList || 'None'}

Key headlines overnight:
${headlines.slice(0,5).join('\n')}

Use your tools to check current prices and signals for each position, then write the morning briefing.`;

  try {
    const raw = await callClaudeAgent(systemPrompt, userPrompt, 600, true, true, 45000); // 45s - briefing tool use needs headroom
    if (!raw) return null;
    // Return as plain text - not JSON
    return raw;
  } catch(e) {
    console.log("[AGENT] Morning briefing error:", e.message);
    return null;
  }
}

// - Score a single article against keyword lists -
// Returns { bearishScore, bullishScore, triggers, sectorImpact }
// Applies: keyword weight - source credibility - recency multiplier
function scoreArticle(article) {
  const text       = (article.headline + " " + (article.summary || "")).toLowerCase();
  const source     = (article.source || "").toLowerCase();
  const ageMinutes = (Date.now() - new Date(article.publishedAt || 0).getTime()) / 60000;

  // Source credibility multiplier
  const isCredible    = CREDIBLE_SOURCES.some(s => source.includes(s) || text.includes(s));
  const sourceMult    = isCredible ? 1.5 : 1.0;

  // Recency multiplier - news within 2 hours is most relevant
  const recencyMult   = ageMinutes < 120  ? 2.0   // last 2 hours - breaking news
                      : ageMinutes < 360  ? 1.5   // last 6 hours
                      : ageMinutes < 720  ? 1.2   // last 12 hours
                      : ageMinutes < 1440 ? 1.0   // last 24 hours
                      : 0.5;                      // older - deprioritize

  let bearishScore = 0, bullishScore = 0;
  const triggers = [], sectorImpact = { bearish: new Set(), bullish: new Set() };

  for (const entry of MACRO_BEARISH_KEYWORDS) {
    if (text.includes(entry.kw)) {
      const pts = entry.w * sourceMult * recencyMult;
      bearishScore += pts;
      triggers.push({ kw: entry.kw, pts: parseFloat(pts.toFixed(1)), direction: "bearish" });
      const impact = SECTOR_MACRO_IMPACT[entry.kw];
      if (impact) {
        impact.bearish.forEach(s => sectorImpact.bearish.add(s));
        impact.bullish.forEach(s => sectorImpact.bullish.add(s));
      }
    }
  }

  for (const entry of MACRO_BULLISH_KEYWORDS) {
    if (text.includes(entry.kw)) {
      const pts = entry.w * sourceMult * recencyMult;
      bullishScore += pts;
      triggers.push({ kw: entry.kw, pts: parseFloat(pts.toFixed(1)), direction: "bullish" });
      const impact = SECTOR_MACRO_IMPACT[entry.kw];
      if (impact) {
        impact.bullish.forEach(s => sectorImpact.bullish.add(s));
        impact.bearish.forEach(s => sectorImpact.bearish.add(s));
      }
    }
  }

  return { bearishScore, bullishScore, triggers, sectorImpact,
    sourceMult, recencyMult, isCredible };
}

async function getMacroNews() {
  // Cache for 60 seconds - news doesn't change faster than this
  // Prevents redundant fetches when both the 3-min interval and scan medium tier fire close together
  const cached = getCached("macronews:v1");
  if (cached) return cached;
  try {
    // Fetch from both sources in parallel - Alpaca + Marketaux
    const [alpacaData, marketauxArticles] = await Promise.all([
      alpacaGet(`/news?limit=50`, ALPACA_NEWS),
      getMarketauxNews(),
    ]);

    const alpacaArticles = (alpacaData && alpacaData.news ? alpacaData.news : []).map(a => ({
      headline:    a.headline || "",
      summary:     a.summary  || "",
      source:      (a.author  || "alpaca").toLowerCase(),
      publishedAt: a.created_at || new Date().toISOString(),
    }));

    // Deduplicate by headline similarity - avoid double-counting same story
    const allArticles = [...alpacaArticles];
    for (const ma of marketauxArticles) {
      const isDupe = alpacaArticles.some(a =>
        a.headline.toLowerCase().slice(0,40) === ma.headline.toLowerCase().slice(0,40)
      );
      if (!isDupe) allArticles.push(ma);
    }

    let totalBearish = 0, totalBullish = 0;
    const allTriggers  = [];
    const sectorImpact = { bearish: new Set(), bullish: new Set() };
    const headlines    = []; // for email display
    const topStories   = []; // credible/recent stories for email

    for (const article of allArticles) {
      const scored = scoreArticle(article);
      totalBearish += scored.bearishScore;
      totalBullish += scored.bullishScore;
      scored.triggers.forEach(t => allTriggers.push(t));
      scored.sectorImpact.bearish.forEach(s => sectorImpact.bearish.add(s));
      scored.sectorImpact.bullish.forEach(s => sectorImpact.bullish.add(s));

      if (article.headline) headlines.push(article.headline);

      // Track top stories for email - credible sources with meaningful scores
      if (scored.isCredible && (scored.bearishScore > 0 || scored.bullishScore > 0)) {
        topStories.push({
          headline:  article.headline,
          source:    article.source,
          direction: scored.bullishScore > scored.bearishScore ? "bullish" : "bearish",
          score:     Math.max(scored.bullishScore, scored.bearishScore),
          recencyMult: scored.recencyMult,
        });
      }
    }

    // Sort top stories by score desc, keep top 5
    topStories.sort((a, b) => b.score - a.score);

    const net = totalBullish - totalBearish;
    let signal = "neutral", scoreModifier = 0, mode = "normal";
    // Weighted scoring needs higher threshold than count-based
    if (net <= -10)     { signal = "strongly bearish"; scoreModifier = -20; mode = "defensive"; } // raised from -6: prevents single story triggering defensive
    else if (net <= -3) { signal = "bearish";          scoreModifier = -10; mode = "cautious";  }
    else if (net <= -1) { signal = "mild bearish";     scoreModifier = -5;  mode = "cautious";  }
    else if (net >= 6)  { signal = "strongly bullish"; scoreModifier = 15;  mode = "aggressive";}
    else if (net >= 3)  { signal = "bullish";          scoreModifier = 8;   mode = "normal";    }
    else if (net >= 1)  { signal = "mild bullish";     scoreModifier = 4;   mode = "normal";    }

    // Get unique top triggers by score
    const triggerMap = {};
    for (const t of allTriggers) {
      if (!triggerMap[t.kw] || triggerMap[t.kw] < t.pts) triggerMap[t.kw] = t.pts;
    }
    // MACRO-1: Only include direction-matching triggers in the summary
    // In bearish macro, bullish keywords (e.g. "stocks surge", "accord") are noise
    const isBearishSignal  = net < 0;
    const directionTriggers = Object.entries(triggerMap)
      .filter(([kw]) => {
        // Keep only keywords that match the dominant direction
        const isBearishKw = MACRO_BEARISH_KEYWORDS.some(e => typeof e === 'object' ? e.keyword === kw : e === kw);
        return isBearishSignal ? isBearishKw : !isBearishKw;
      })
      .sort((a,b) => b[1]-a[1])
      .slice(0, 5)
      .map(([kw]) => kw);
    const uniqueTriggers = directionTriggers.length > 0 ? directionTriggers : Object.entries(triggerMap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([kw])=>kw);

    const sourceCount = marketauxArticles.length > 0
      ? `Alpaca(${alpacaArticles.length}) + Marketaux(${marketauxArticles.length})`
      : `Alpaca(${alpacaArticles.length})`;

    if (uniqueTriggers.length > 0) {
      logEvent("macro", `Macro: ${signal} | ${sourceCount} | triggers: ${uniqueTriggers.join(", ")} | modifier: ${scoreModifier > 0 ? "+" : ""}${scoreModifier}`);
    }
    // Check for macro shift even on keyword path
    checkMacroShift(signal);
    // SCORE-1: Seed _agentMacro from keyword result when agent hasn't run yet
    // Without this, first scan after boot scores with no agent signal (neutral default)
    // even when macro is clearly bearish from keywords
    if (!state._agentMacro || !state._agentMacro.timestamp) {
      const seededSignal = signal; // keyword signal as temporary seed
      const seedRegime   = signal === "strongly bearish" ? "trending_bear"
                         : signal === "bearish"          ? "trending_bear"
                         : signal === "mild bearish"     ? "choppy"
                         : signal === "strongly bullish" ? "trending_bull"
                         : signal === "bullish"          ? "trending_bull"
                         : "neutral";
      markDirty(); // C6: persist agent macro immediately -- drives all gate decisions
      state._agentMacro = {
        signal:      seededSignal,
        confidence:  "medium", // keyword is less reliable than agent - medium confidence
        regime:      seedRegime,
        entryBias:   signal.includes("bearish") ? "puts_on_bounces" : signal.includes("bullish") ? "calls_on_dips" : "neutral",
        tradeType:   "spread",
        vixOutlook:  state.vix >= 30 ? "spiking" : state.vix >= 25 ? "elevated_stable" : "unknown",
        timestamp:   new Date().toISOString(),
        _seededFromKeyword: true, // flag - will be overwritten when agent runs
      };
      logEvent("scan", `[AGENT] No prior signal - seeding _agentMacro from keyword: ${seededSignal} (medium conf) - agent will override on next run`);
    }

    // - Agent enhancement - replace keyword scoring with Claude analysis -
    // Only use agent during market hours + 30min pre/post - saves ~40% API cost
    const etNow = getETTime();
    const etH = etNow.getHours() + etNow.getMinutes() / 60;
    const agentWindowOpen = etH >= 8.5 && etH <= 17.0; // 8:30am-5pm ET
    if (ANTHROPIC_API_KEY && headlines.length > 0 && agentWindowOpen) {
      try {
        logEvent("macro", `[AGENT] Running macro analysis (${headlines.length} headlines)...`);
        const agentResult = await getAgentMacroAnalysis(headlines);
        if (agentResult) {
          // Store for rescore use
          state._agentMacro = {
            ...agentResult,
            timestamp: new Date().toISOString(),
            // AG-6: exitUrgency - trim/exit open positions if thesis broken
            exitUrgency:      agentResult.exitUrgency      || "hold",
            // AG-7: positionSizeMult - continuous sizing vs binary riskLevel
            positionSizeMult: agentResult.positionSizeMult || 1.0,
            // AG-9: schemaVersion - backward compat
            schemaVersion:    agentResult.schemaVersion    || 1,
          };
          // Apply intraday regime override if signal is strong enough
          applyIntradayRegimeOverride(agentResult);
          // AG-6: Apply exit urgency signal
          applyExitUrgency(agentResult);
          // Map agent result to expected format
          const agentModeMap = {
            "strongly bearish": { modifier: -20, mode: "defensive" },
            "bearish":          { modifier: -10, mode: "cautious"  },
            "mild bearish":     { modifier: -5,  mode: "cautious"  },
            "neutral":          { modifier: 0,   mode: "normal"    },
            "mild bullish":     { modifier: 4,   mode: "normal"    },
            "bullish":          { modifier: 8,   mode: "normal"    },
            "strongly bullish": { modifier: 15,  mode: "aggressive"},
          };
          const mapped = agentModeMap[agentResult.signal] || { modifier: 0, mode: "normal" };
          const result = {
            signal:       agentResult.signal,
            scoreModifier:mapped.modifier,
            mode:         mapped.mode, // always derive from signal - never trust agent mode field directly
            triggers:     agentResult.keyThemes || [],
            topStories:   (agentResult.topStories || []).slice(0, 5).map(s => ({
              headline:    s.headline,
              source:      s.source || "agent",
              direction:   s.direction || "neutral",
              score:       s.importance === "high" ? 10 : s.importance === "medium" ? 5 : 2,
              recencyMult: 2.0,
            })),
            sectorBearish: [...sectorImpact.bearish],
            sectorBullish: [...sectorImpact.bullish],
            headlines:     headlines.slice(0, 15),
            agentReasoning: agentResult.reasoning || "",
            agentConfidence: agentResult.confidence || "medium",
            bearishTickers: agentResult.bearishTickers || [],
            bullishTickers: agentResult.bullishTickers || [],
            sourceCount:   sourceCount + " + Claude",
            updatedAt:     new Date().toISOString(),
          };
          setCache("macronews:v1", result, 60);
          return result;
        }
      } catch(agentErr) {
        logEvent("warn", `[AGENT] Macro analysis failed, using keywords: ${agentErr.message}`);
      }
    }

    // Keyword fallback
    const kwResult = {
      signal, scoreModifier, mode,
      bearishScore: parseFloat(totalBearish.toFixed(1)),
      bullishScore: parseFloat(totalBullish.toFixed(1)),
      triggers: uniqueTriggers,
      topStories: topStories.slice(0, 5),
      sectorBearish: [...sectorImpact.bearish],
      sectorBullish: [...sectorImpact.bullish],
      headlines: headlines.slice(0, 15),
      sourceCount,
      updatedAt: new Date().toISOString(),
    };
    setCache("macronews:v1", kwResult, 60);
    return kwResult;
  } catch(e) {
    logEvent("error", `getMacroNews: ${e.message}`);
    return { signal: "neutral", scoreModifier: 0, mode: "normal", triggers: [], topStories: [], sectorBearish: [], sectorBullish: [] };
  }
}

// - Fear & Greed -
async function getFearAndGreed() {
  const cached = getCached("feargreed:v1");
  if (cached) return cached;
  try {
    const res  = await withTimeout(fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata"), 5000);
    const data = await res.json();
    const score  = data?.fear_and_greed?.score || 50;
    const rating = data?.fear_and_greed?.rating || "neutral";
    const result = { score: parseFloat(parseFloat(score).toFixed(0)), rating };
    setCache("feargreed:v1", result, 300); // 5 minute TTL - updates once per day
    return result;
  } catch(e) { return { score: 50, rating: "neutral" }; }
}

// - Market Breadth -
async function getMarketBreadth() {
  try {
    const sectors = ["XLK","XLF","XLE","XLV","XLI","XLY","XLP","XLU","XLB","XLRE"];
    // Fetch all breadth ETFs in parallel
    const allBars = await Promise.all(sectors.map(etf => getStockBars(etf, 2)));
    let advancing = 0, declining = 0;
    allBars.forEach(bars => {
      if (bars.length >= 2) {
        if (bars[bars.length-1].c > bars[bars.length-2].c) advancing++;
        else declining++;
      }
    });
    const total      = advancing + declining;
    const breadthPct = total > 0 ? (advancing / total) * 100 : 50;
    return { advancing, declining, breadthPct: parseFloat(breadthPct.toFixed(0)) };
  } catch(e) { return { advancing: 5, declining: 5, breadthPct: 50 }; }
}

// - DXY proxy via UUP ETF -
// - Synthetic Put/Call Ratio from SPY options chain -
// Academic basis: Bollen & Whaley (2004) - PCR predicts short-term reversals
// Extreme readings: PCR > 1.2 = excessive fear = contrarian call entry
//                  PCR < 0.5 = excessive greed = contrarian put entry
// Uses OI-weighted ratio (more accurate than raw count per Pan & Poteshman 2006)
async function getSyntheticPCR() {
  try {
    const cached = getCached("pcr:spy");
    if (cached) return cached;

    // Fetch SPY options chain - already have this infrastructure
    const today  = new Date().toISOString().split("T")[0];
    const expiry = new Date(Date.now() + 45 * MS_PER_DAY).toISOString().split("T")[0]; // 0-45 DTE full range
    const url    = `/options/snapshots/SPY?feed=indicative&limit=1000&expiration_date_gte=${today}&expiration_date_lte=${expiry}`;
    const data   = await alpacaGet(url, ALPACA_OPT_SNAP);

    if (!data || !data.snapshots) return null;

    let putOI = 0, callOI = 0, putVol = 0, callVol = 0;
    let contractsFound = 0;
    for (const [sym, snap] of Object.entries(data.snapshots)) {
      // Alpaca snapshot fields: openInterest (not greeks.open_interest), dailyBar.v (not .volume)
      const oi  = parseFloat(snap.openInterest || snap.greeks?.open_interest || 0);
      const vol = parseFloat(snap.dailyBar?.v || snap.dailyBar?.volume || 0);
      // Option type character after the 6-digit date: SPY260419P00500000
      const optChar = sym.match(/\d{6}([CP])\d/)?.[1];
      if (optChar === "P") { putOI  += oi; putVol  += vol; }
      else if (optChar === "C") { callOI += oi; callVol += vol; }
      contractsFound++;
    }
    if (contractsFound === 0) return null;

    const oiPCR  = callOI  > 0 ? parseFloat((putOI  / callOI ).toFixed(3)) : null;
    const volPCR = callVol > 0 ? parseFloat((putVol / callVol).toFixed(3)) : null;
    // Blend OI and volume PCR - OI is more stable, vol is more current
    const pcr = oiPCR && volPCR
      ? parseFloat(((oiPCR * 0.6 + volPCR * 0.4)).toFixed(3))
      : (oiPCR || volPCR);

    const signal = !pcr ? "neutral"
      : pcr > 1.3  ? "extreme_fear"    // very strong contrarian call signal
      : pcr > 1.1  ? "fear"            // contrarian call signal
      : pcr < 0.45 ? "extreme_greed"   // very strong contrarian put signal
      : pcr < 0.6  ? "greed"           // contrarian put signal
      : "neutral";

    const result = { pcr, oiPCR, volPCR, signal };
    setCache("pcr:spy", result);
    return result;
  } catch(e) {
    return null;
  }
}

// - Volatility Term Structure -
// Natenberg principle: steep term structure = acute fear = put premium expensive
// Near month IV vs far month IV ratio determines credit spread attractiveness
// Backwardation (near > far): fear is acute = ideal time to sell credit spreads
// Contango (far > near): fear is moderate = normal vol environment
async function getVolTermStructure() {
  try {
    const cached = getCached("vol:termstruct");
    if (cached) return cached;

    const today     = new Date();
    const nearExp   = new Date(today.getTime() + 20 * MS_PER_DAY).toISOString().split("T")[0];
    const farExp    = new Date(today.getTime() + 50 * MS_PER_DAY).toISOString().split("T")[0];

    // Fetch ATM options for near and far expiry to get IV
    // Use live SPY quote if state.spyPrice not yet populated
    let spyPrice = state.spyPrice || 0;
    if (!spyPrice || spyPrice < 100) {
      const liveQ = await getStockQuote("SPY").catch(() => null);
      spyPrice = liveQ || 500; // hard fallback if quote fails
    }
    const nearStrike = Math.round(spyPrice / 5) * 5; // nearest $5 strike

    const [nearData, farData] = await Promise.all([
      alpacaGet(`/options/snapshots/SPY?feed=indicative&limit=50&expiration_date_gte=${nearExp}&strike_price_gte=${nearStrike - 10}&strike_price_lte=${nearStrike + 10}&type=put`, ALPACA_OPT_SNAP),
      alpacaGet(`/options/snapshots/SPY?feed=indicative&limit=50&expiration_date_gte=${farExp}&strike_price_gte=${nearStrike - 10}&strike_price_lte=${nearStrike + 10}&type=put`, ALPACA_OPT_SNAP),
    ]);

    const getAvgIV = (data) => {
      if (!data?.snapshots) return null;
      const ivs = Object.values(data.snapshots)
        .map(s => parseFloat(s.greeks?.iv || s.impliedVolatility || 0))
        .filter(iv => iv > 0.05 && iv < 2.0);
      return ivs.length ? ivs.reduce((a,b)=>a+b,0)/ivs.length : null;
    };

    const nearIV = getAvgIV(nearData);
    const farIV  = getAvgIV(farData);
    if (!nearIV || !farIV) return null;

    const ratio  = parseFloat((nearIV / farIV).toFixed(3));
    // Ratio > 1.0 = backwardation (near > far = acute fear)
    // Ratio < 1.0 = contango (far > near = normal)
    const structure = ratio > 1.15 ? "steep_backwardation"  // extreme fear, sell puts
                    : ratio > 1.05 ? "mild_backwardation"    // elevated fear
                    : ratio < 0.90 ? "steep_contango"        // very calm, calls cheap
                    : ratio < 0.97 ? "mild_contango"         // normal
                    : "flat";

    const creditFavorable = ratio > 1.05; // backwardation = near-term IV elevated = good for credit
    const callFavorable   = ratio < 0.95; // contango = calls relatively cheap

    const result = { nearIV: parseFloat(nearIV.toFixed(4)), farIV: parseFloat(farIV.toFixed(4)), ratio, structure, creditFavorable, callFavorable };
    setCache("vol:termstruct", result);
    return result;
  } catch(e) { return null; }
}

// - CBOE SKEW Index -
// SKEW measures tail risk premium in S&P 500 options
// SKEW > 130: market paying heavily for downside protection = puts overpriced
//             Ideal for SELLING put credit spreads (collect the fear premium)
// SKEW < 115: tail risk low = normal environment
// Source: CBOE public API - no auth required
async function getCBOESKEW() {
  // Synthetic SKEW — computed from SPY options chain IV smirk
  // Replaces cdn.cboe.com dependency (blocked on Railway)
  // Methodology: compare avg IV of OTM puts (delta 0.15-0.25) vs ATM puts (delta 0.45-0.55)
  // smirkRatio > 1.30 = steep smirk = market pricing heavy tail risk = "extreme"
  // smirkRatio > 1.15 = elevated smirk = good credit put environment = "elevated"
  // smirkRatio < 1.05 = flat smirk = tail risk not priced = "low"
  try {
    const cached = getCached("synth:skew");
    if (cached) return cached;

    const today  = getETTime().toISOString().split("T")[0];
    const expMax = new Date(getETTime().getTime() + 35 * 86400000).toISOString().split("T")[0];
    // Fetch SPY puts in 14-35 DTE window — liquid strikes, IV well-defined
    const data = await alpacaGet(
      `/options/snapshots/SPY?feed=indicative&limit=200&type=put&expiration_date_gte=${today}&expiration_date_lte=${expMax}`,
      ALPACA_OPT_SNAP
    );
    if (!data?.snapshots) return null;

    const otmIVs = [], atmIVs = [];
    for (const snap of Object.values(data.snapshots)) {
      const delta = Math.abs(parseFloat(snap.greeks?.delta || 0));
      const iv    = parseFloat(snap.impliedVolatility || snap.greeks?.iv || 0);
      if (!delta || !iv || iv < 0.05 || iv > 3.0) continue;
      if (delta >= 0.15 && delta <= 0.25) otmIVs.push(iv);  // OTM puts
      if (delta >= 0.45 && delta <= 0.55) atmIVs.push(iv);  // ATM puts
    }

    if (otmIVs.length < 3 || atmIVs.length < 3) return null;

    const avgOTM = otmIVs.reduce((a,b)=>a+b,0) / otmIVs.length;
    const avgATM = atmIVs.reduce((a,b)=>a+b,0) / atmIVs.length;
    const smirkRatio = parseFloat((avgOTM / avgATM).toFixed(3));

    // Map smirk ratio to SKEW-equivalent signal
    // Historical calibration: CBOE SKEW 130 ~ smirkRatio 1.20, SKEW 140 ~ smirkRatio 1.30
    const signal = smirkRatio >= 1.30 ? "extreme"
                 : smirkRatio >= 1.15 ? "elevated"
                 : smirkRatio >= 1.05 ? "moderate"
                 : smirkRatio <  1.02 ? "low"
                 : "neutral";

    const creditPutIdeal = smirkRatio >= 1.15 && (state.vix || 20) >= 25;
    // Express as pseudo-SKEW index for logging (rough equivalence)
    const skewEquiv = Math.round(100 + (smirkRatio - 1.0) * 200);

    const result = { skew: skewEquiv, smirkRatio, avgOTM: parseFloat(avgOTM.toFixed(4)),
                     avgATM: parseFloat(avgATM.toFixed(4)), signal, creditPutIdeal,
                     source: "synthetic" };
    setCache("synth:skew", result);
    return result;
  } catch(e) {
    logEvent("warn", `[SKEW] Synthetic computation failed: ${e.message}`);
    return null;
  }
}

// getCBOEPCR - retired, cdn.cboe.com blocked on Railway
// PCR now sourced from getSyntheticPCR() (Alpaca options chain)
async function getCBOEPCR() { return null; }

// - AAII Sentiment Survey -
// Weekly retail investor sentiment - published every Thursday
// Extreme bearishness (bulls < 20%) = historically strong contrarian call signal
// Extreme bullishness (bulls > 55%) = historically strong contrarian put signal
// Source: surveys.aaii.com/sentiment/

// -- getSentimentSignal --
// Replaces AAII (external scrape, unreliable) with an Alpaca-native sentiment signal.
// Uses VIX momentum, SPY drawdown from peak, and breadth to classify market sentiment.
// Maps to same signal names as AAII so scoreIndexSetup works unchanged:
//   extreme_bearish -> contrarian call signal (+12)
//   bearish         -> mild contrarian call (+6)
//   extreme_bullish -> contrarian put signal (+10)
//   bullish         -> mild contrarian put (+5)
async function getSentimentSignal() {
  try {
    const cached = getCached("sentiment:signal");
    if (cached) return cached;

    // VIX momentum: how fast is VIX moving? Spiking = fear, falling = complacency
    const vixNow  = state.vix || 20;
    const vixHist = state._vixHistory || [];
    const vix5dAgo = vixHist.length >= 5 ? vixHist[vixHist.length - 5] : vixNow;
    const vixMomentum = vixNow - vix5dAgo; // positive = rising fear, negative = falling

    // SPY drawdown from recent peak (last 20 bars)
    const spyBarsRecent = state._spyBars20 || [];
    const spyPeak = spyBarsRecent.length > 0 ? Math.max(...spyBarsRecent.map(b => b.h || b.c)) : 0;
    const spyNow  = state.spyPrice || 0;
    const spyDrawdown = spyPeak > 0 && spyNow > 0
      ? parseFloat(((spyNow - spyPeak) / spyPeak * 100).toFixed(2))
      : 0;

    // Breadth context
    const breadth = marketContext?.breadth?.breadthPct || 50;

    // Classify sentiment
    // extreme_bearish: VIX spiking hard AND big drawdown AND breadth collapsed
    // extreme_bullish: VIX falling fast AND breadth strong AND near highs
    let signal, bullish, bearish;

    if (vixMomentum >= 8 && spyDrawdown <= -5 && breadth <= 30) {
      signal = "extreme_bearish"; bullish = 20; bearish = 60;
    } else if (vixMomentum >= 4 && spyDrawdown <= -3) {
      signal = "bearish"; bullish = 30; bearish = 50;
    } else if (vixMomentum <= -5 && spyDrawdown >= -1 && breadth >= 65) {
      signal = "extreme_bullish"; bullish = 65; bearish = 15;
    } else if (vixMomentum <= -3 && breadth >= 55) {
      signal = "bullish"; bullish = 55; bearish = 25;
    } else {
      signal = "neutral"; bullish = 40; bearish = 40;
    }

    const result = {
      signal, bullish, bearish, spread: bullish - bearish,
      vixMomentum: parseFloat(vixMomentum.toFixed(1)),
      spyDrawdown,
      source: "synthetic",
    };
    setCache("sentiment:signal", result);
    return result;
  } catch(e) {
    return null;
  }
}

async function getAAIISentiment() {
  try {
    const cached = getCached("aaii:sentiment");
    if (cached) return cached;

    // AAII publishes weekly sentiment - try multiple endpoints
    // Primary: AAII investor sentiment page (may need HTML parsing)
    // Fallback: Use manually set value via /api/set-aaii endpoint
    if (state._aaiiManual) {
      // Manual override set by user - use it (lasts until next Thursday)
      return state._aaiiManual;
    }

    // Try fetching AAII data - endpoint may vary
    let bullish = 0, bearish = 0, neutral = 0, date = "unknown";
    const urls = [
      "https://www.aaii.com/sentimentsurvey/sent_results.js",
      "https://surveys.aaii.com/sentiment/sentiment_data.json",
    ];

    let parsed = false;
    for (const url of urls) {
      try {
        const res = await withTimeout(fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" }
        }), 4000);
        if (!res.ok) continue;
        const text = await res.text();
        // Try JSON parse first
        try {
          const data = JSON.parse(text);
          const latest = Array.isArray(data) ? data[data.length-1] : data;
          bullish = parseFloat(latest?.bullish || latest?.Bullish || latest?.bull || 0);
          bearish = parseFloat(latest?.bearish || latest?.Bearish || latest?.bear || 0);
          neutral = parseFloat(latest?.neutral || latest?.Neutral || 0);
          date    = latest?.date || latest?.Date || "unknown";
          if (bullish > 0) { parsed = true; break; }
        } catch(e) {
          // Try regex extraction from JS/HTML
          const bullMatch = text.match(/[Bb]ullish["\s:]+(\d+\.?\d*)/);
          const bearMatch = text.match(/[Bb]earish["\s:]+(\d+\.?\d*)/);
          if (bullMatch && bearMatch) {
            bullish = parseFloat(bullMatch[1]);
            bearish = parseFloat(bearMatch[1]);
            neutral = Math.max(0, 100 - bullish - bearish);
            parsed = true; break;
          }
        }
      } catch(e) { continue; }
    }
    if (!bullish) return null;

    // Historical thresholds (Ned Davis Research validation):
    // Bulls < 20% = extreme pessimism = contrarian buy (call signal)
    // Bulls > 55% = extreme optimism = contrarian sell (put signal)
    // Spread (bull-bear) < -20 = strong contrarian buy signal
    const spread  = bullish - bearish;
    const signal  = bullish < 20 ? "extreme_bearish"   // strong contrarian call
                  : bullish < 30 ? "bearish"            // mild contrarian call
                  : bullish > 55 ? "extreme_bullish"    // strong contrarian put
                  : bullish > 45 ? "bullish"            // mild contrarian put
                  : "neutral";

    const result = { bullish, bearish, neutral, spread: parseFloat(spread.toFixed(1)), signal, date };
    // Cache for 24 hours - weekly data published every Thursday
    _slowCache.set("aaii:sentiment", { data: result, ts: Date.now() - (SLOW_CACHE_TTL - 24*60*60*1000) });
    return result;
  } catch(e) {
    logEvent("warn", `[AAII] Sentiment fetch failed: ${e.message}`);
    return null;
  }
}

async function getDXY() {
  try {
    const bars = await getStockBars("UUP", 5);
    if (bars.length < 2) return { trend: "neutral", change: 0 };
    const change = (bars[bars.length-1].c - bars[0].c) / bars[0].c * 100;
    return {
      trend:  change > 0.3 ? "strengthening" : change < -0.3 ? "weakening" : "neutral",
      change: parseFloat(change.toFixed(2))
    };
  } catch(e) { return { trend: "neutral", change: 0 }; }
}

// - Yield Curve via TLT/SHY -
async function getYieldCurve() {
  try {
    const tlt = await getStockBars("TLT", 5);
    const shy = await getStockBars("SHY", 5);
    if (!tlt.length || !shy.length) return { signal: "normal" };
    const tltChange = (tlt[tlt.length-1].c - tlt[0].c) / tlt[0].c;
    const shyChange = (shy[shy.length-1].c - shy[0].c) / shy[0].c;
    if (tltChange < shyChange - 0.005) return { signal: "steepening" };
    if (tltChange > shyChange + 0.005) return { signal: "flattening" };
    return { signal: "normal" };
  } catch(e) { return { signal: "normal" }; }
}

// - GLD Entry Gate - panel-validated (DXY + SPY momentum + VIX) -
// GLD calls: only when dollar not strengthening + equities stressed + VIX elevated
// GLD puts:  only when GLD overbought (RSI>68) + DXY not rising (rare/high conviction)
// Panel removed seasonal filter - DXY gate is causally grounded vs 3yr sample artifact
function isGLDEntryAllowed(optionType, dxy, spyReturn5d, vix, gldRSI, gldPrice, gldMA20) {
  if (optionType === "call") {
    // Panel decision (8/8): remove SPY 5d momentum gate - too restrictive
    // Gold rallies on dollar weakness + uncertainty, not only equity stress
    // Replacement: GLD above its own 20MA (Quant + Technical Analyst, 3/8)
    const dxyStrengthening = dxy && dxy.change > 0.8;  // dollar up >0.8% in 5d
    // VIX gate restored to 20 - backtest data showed lowering to 16 admitted losing trades
    // GLD 2023: 8-13 trades but WR dropped 37%-23% with extra entries - gate was right at 20
    const vixTooLow        = vix < 20;                 // restored to 20
    const gldDowntrend     = gldMA20 > 0 && gldPrice > 0 && gldPrice < gldMA20; // gold below 20MA = downtrend
    if (dxyStrengthening) return { allowed: false, reason: `GLD call blocked - DXY strengthening (+${dxy.change.toFixed(2)}% 5d, dollar headwind for gold)` };
    if (vixTooLow)        return { allowed: false, reason: `GLD call blocked - VIX ${vix.toFixed(1)} below 20, insufficient uncertainty for gold catalyst` };
    if (gldDowntrend)     return { allowed: false, reason: `GLD call blocked - GLD $${gldPrice.toFixed(2)} below 20MA $${gldMA20.toFixed(2)}, don't buy calls in downtrend` };
    return { allowed: true };
  } else {
    // GLD puts  -- two paths by trade type:
    // Debit puts: RSI >= 68 required (directional bet  -- gold must fall to profit)
    // Credit puts: RSI irrelevant  -- selling premium above current price, not predicting direction
    // [Regime A] RSI gate applies fully
    // [Regime B credit] bypass RSI overbought  -- IV level is what matters for premium collection
    const gldOverbought  = gldRSI >= 68;
    const dxyRising      = dxy && dxy.change > 0;
    const isGLDCreditPut = arguments[7] === "credit_put";
    if (!gldOverbought && !isGLDCreditPut) return { allowed: false, reason: `GLD put blocked - RSI ${gldRSI?.toFixed(0)||'?'} not overbought (need >68 for debit put thesis)` };
    if (dxyRising) return { allowed: false, reason: `GLD put blocked - DXY rising (+${dxy?.change||0}%), dollar strength supports gold` };
    return { allowed: true };
  }
}


// - XLE Entry Gate - energy sector, oil-price driven -
// XLE puts: oil rising (energy names pulling back on valuation, not oil) = harder
//           best put entries: XLE RSI overbought + oil not in confirmed uptrend
// XLE calls: oil falling = energy sector under pressure = harder
//            best call entries: XLE RSI oversold + oil stabilizing/recovering
// Oil trend approximated from XLE's own 20MA slope (oil ETFs track closely)
// Panel: gate is intentionally lighter than GLD/TLT - XLE uses standard scoring
function isXLEEntryAllowed(optionType, xleRSI, xleMomentum, vix, xlePrice, xleMA20) {
  // XLE puts: need RSI elevated (not deeply oversold - that's a call, not put, setup)
  if (optionType === "put") {
    if (xleRSI && xleRSI <= 35) return { allowed: false, reason: `XLE put blocked - RSI ${xleRSI?.toFixed(0)} deeply oversold (energy capitulation - wrong for puts)` };
    // Oil confirmed uptrend (XLE above 20MA by >3%) - puts into strong uptrend discouraged
    const xleAbove20MA = xleMA20 > 0 && xlePrice > xleMA20 * 1.03;
    if (xleAbove20MA) return { allowed: false, reason: `XLE put blocked - price $${xlePrice?.toFixed(2)} >3% above 20MA $${xleMA20?.toFixed(2)} (oil uptrend - don't fade)` };
    return { allowed: true };
  } else {
    // XLE calls: need RSI not deeply overbought (chasing energy run)
    if (xleRSI && xleRSI >= 78) return { allowed: false, reason: `XLE call blocked - RSI ${xleRSI?.toFixed(0)} deeply overbought (energy extended - wrong for calls)` };
    // Oil confirmed downtrend (XLE >3% below 20MA) - calls into strong downtrend discouraged
    const xleBelow20MA = xleMA20 > 0 && xlePrice < xleMA20 * 0.97;
    if (xleBelow20MA) return { allowed: false, reason: `XLE call blocked - price $${xlePrice?.toFixed(2)} >3% below 20MA $${xleMA20?.toFixed(2)} (oil downtrend - don't catch falling knife)` };
    return { allowed: true };
  }
}

// - TLT Entry Gate - bonds rally when equities fall -
// TLT calls: when SPY is below its 50MA (equity weakness thesis)
// TLT puts:  when SPY recovering strongly above 50MA (rates rising = bonds fall)
function isTLTEntryAllowed(optionType, spyPrice, spyMA50, spyReturn5d, spyMA200, tltRSI, tltMomentum) {
  if (!spyMA50 || spyMA50 === 0) return { allowed: true }; // no data, don't block
  // Panel decision (5/8): SPY below 50MA OR below 200MA allows TLT calls
  // In 2022, bonds fell while SPY was still above 50MA (both fell on rate hikes)
  // Adding 200MA catch handles sustained bear market where SPY/bonds decorrelate differently
  const spyBelow50MA  = spyPrice < spyMA50;
  const spyBelow200MA = spyMA200 && spyMA200 > 0 && spyPrice < spyMA200;
  const spyWeak       = spyBelow50MA || spyBelow200MA;
  if (optionType === "call") {
    if (!spyWeak) return { allowed: false, reason: `TLT call blocked - SPY $${spyPrice.toFixed(2)} above both 50MA $${spyMA50.toFixed(2)} and 200MA, no equity weakness for bond rally` };
    const maLabel = spyBelow200MA ? "200MA" : "50MA";
    return { allowed: true, reason: `TLT call allowed - SPY below ${maLabel}` };
  } else {
    // TLT puts: bonds falling = rates rising
    // Panel fix: pure SPY-MA gate blocks ALL Regime B - bonds can fall on rate/inflation
    // fears even while equities are weak. Refine to check TLT's own signals:
    // Allow TLT put when TLT itself is overbought (RSI > 65) OR SPY is recovering
    const tltOverbought = tltRSI && tltRSI >= 65;
    const tltMomentumWeak = tltMomentum && ["recovering", "steady"].includes(tltMomentum);
    const spyRecovering = !spyWeak || spyReturn5d >= 0.01;

    // Block if: SPY still weak AND TLT not overbought on its own signals
    // Allow if: TLT RSI is elevated (bond overvaluation) regardless of SPY, OR SPY recovering
    if (spyWeak && !tltOverbought) {
      return { allowed: false, reason: `TLT put blocked - SPY below MA and TLT RSI ${tltRSI || "?"}  not overbought (need RSI >65 for bond-specific put thesis)` };
    }
    if (spyReturn5d < 0.01 && !tltOverbought) {
      return { allowed: false, reason: `TLT put blocked - SPY not recovering (${(spyReturn5d*100).toFixed(1)}% 5d) and TLT not overbought` };
    }
    return { allowed: true, reason: `TLT put allowed - ${tltOverbought ? `TLT RSI ${tltRSI} overbought` : "SPY recovering"}` };
  }
}

// - VWAP -
function calcVWAP(bars) {
  if (!bars || !bars.length) return 0;
  let cumTPV = 0, cumVol = 0;
  for (const bar of bars) {
    const tp = (bar.h + bar.l + bar.c) / 3;
    cumTPV += tp * bar.v;
    cumVol += bar.v;
  }
  return cumVol > 0 ? parseFloat((cumTPV / cumVol).toFixed(2)) : 0;
}

// - Sharpe Ratio -
function calcSharpeRatio() {
  const trades = state.closedTrades || [];
  if (trades.length < 5) return 0;
  const returns  = trades.map(t => t.pct || 0);
  const avg      = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / returns.length;
  const stdDev   = Math.sqrt(variance);
  const riskFree = 0.05 / 252;
  return stdDev > 0 ? parseFloat(((avg - riskFree) / stdDev).toFixed(2)) : 0;
}

// - Value at Risk (95%) -
function calcVaR() {
  const trades = state.closedTrades || [];
  if (trades.length < 10) return 0;
  const losses = trades.map(t => t.pnl).sort((a, b) => a - b);
  return Math.abs(losses[Math.floor(losses.length * 0.05)] || 0);
}

// - Max Adverse Excursion -
function calcMAE() {
  const losses = (state.closedTrades || []).filter(t => t.pnl < 0).map(t => Math.abs(t.pnl));
  return losses.length ? Math.max(...losses) : 0;
}


async function getOptionsPrice(symbol) {
  try {
    const data = await alpacaGet(`/options/snapshots?symbols=${symbol}&feed=indicative`, ALPACA_OPT_SNAP);
    if (!data || !data.snapshots || !data.snapshots[symbol]) return null;
    const snap  = data.snapshots[symbol];
    const quote = snap.latestQuote || snap.latest_quote || snap.quote || {};
    const bid   = parseFloat(quote.bp || quote.bid_price || quote.b || 0);
    const ask   = parseFloat(quote.ap || quote.ask_price || quote.a || 0);
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  } catch(e) { return null; }
}


async function checkAllFilters(stock, price) {
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
  // Index instruments: allow up to 3 positions (staggered entries on same thesis)
  // Individual stocks: max 2 (less liquid, more company-specific risk)
  const maxPerTicker = stock.isIndex ? 3 : 2;
  if (existingPositions.length >= maxPerTicker) return { pass:false, reason:`Already have ${maxPerTicker} positions in ${stock.ticker}` };

  // 7. Portfolio heat
  if (heatPct() >= effectiveHeatCap()) return { pass:false, reason:`Portfolio heat at ${(heatPct()*100).toFixed(0)}% max` };

  // 8. Sector exposure
  const sectorExp = state.positions.filter(p=>p.sector===stock.sector).reduce((s,p)=>s+p.cost,0);
  if (sectorExp / totalCap() >= MAX_SECTOR_PCT) return { pass:false, reason:`${stock.sector} sector at ${MAX_SECTOR_PCT*100}% limit` };

  // 9. Sector concentration — rely on MAX_SECTOR_PCT and correlation blocks
  // Hard per-sector count removed — heat % and correlation blocks handle this
  // (opposite sector bet detection handled by same-ticker opposite direction check in scan loop)

  // 10. Dynamic vol filter — realized vs implied gap (replaces static IVR_MAX)
  // If implied vol >> realized vol, options are overpriced — skip
  // If implied vol ≈ realized vol or implied < realized, options are fairly priced or cheap — enter
  try {
    const volBars = await getStockBars(stock.ticker, 21);
    if (volBars.length >= 10) {
      const closes   = volBars.map(b => b.c);
      const returns  = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
      const realized = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) * Math.sqrt(252) * 100;
      const implied  = stock.ivr * 0.4 + 15; // approximate IV from IVR (IVR=50 → ~35% IV)
      const volGap   = implied - realized;
      // Skip if implied vol is more than 20 points above realized (options too expensive)
      if (volGap > 20) return { pass: false, reason: `Vol gap ${volGap.toFixed(1)}pts — implied ${implied.toFixed(0)}% vs realized ${realized.toFixed(0)}% — options expensive` };
      // Bonus signal: if realized > implied, options are cheap (underpriced) — log as positive
      if (realized > implied + 5) logEvent("filter", `${stock.ticker} vol gap FAVORABLE — realized ${realized.toFixed(0)}% > implied ${implied.toFixed(0)}%`);
    } else {
      // Fallback to static IVR check if not enough bars
      if (stock.ivr > IVR_MAX) return { pass: false, reason: `IVR ${stock.ivr} > ${IVR_MAX} (fallback)` };
    }
  } catch(e) {
    if (stock.ivr > IVR_MAX) return { pass: false, reason: `IVR ${stock.ivr} > ${IVR_MAX}` };
  }

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
      const bars = await getStockBars(stock.ticker, 20);
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
    const priceYest = (await getStockBars(stock.ticker, 2))[0]?.c;
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



// - Sector ETF Confirmation -
async function checkSectorETF(stock) {
  const etfMap = { "Technology":"XLK", "Financial":"XLF", "Consumer":"XLY" };
  const etfs   = [];

  if (etfMap[stock.sector]) etfs.push(etfMap[stock.sector]);
  if (SEMIS.includes(stock.ticker)) etfs.push("SMH");
  if (!etfs.length) return { pass: true, reason: null, putBoost: 0 };

  // Fetch all sector ETFs in parallel
  const allEtfBars = await Promise.all(etfs.map(etf => getStockBars(etf, 5)));
  for (let i = 0; i < etfs.length; i++) {
    const etf  = etfs[i];
    const bars = allEtfBars[i];
    if (bars.length < 2) continue;
    const etfReturn = (bars[bars.length-1].c - bars[0].o) / bars[0].o;
    if (etfReturn < -0.015) {
      return { pass: false, reason: `${etf} sector ETF down ${(etfReturn*100).toFixed(1)}% - sector headwind`, putBoost: 20, etfReturn };
    } else if (etfReturn < -0.01) {
      return { pass: false, reason: `${etf} sector ETF down ${(etfReturn*100).toFixed(1)}% - sector headwind`, putBoost: 12, etfReturn };
    }
  }
  return { pass: true, reason: null, putBoost: 0 };
}





function getDeployableCash() {
  // Everything above the floor is deployable - floor itself is managed separately
  return Math.max(0, state.cash - CAPITAL_FLOOR);
}



async function getWeeklyTrend(ticker) {
  try {
    const cached = getCached('weekly:' + ticker);
    if (cached) return cached;
    const bars = await getStockBars(ticker, 70); // 70 days = ~14 weeks
    if (bars.length < 50) return setCache('weekly:' + ticker, { trend: 'neutral', above10wk: null });
    const ma10w = bars.slice(-50).reduce((s, b) => s + b.c, 0) / 50;
    const price = bars[bars.length-1].c;
    const pctFromMA = (price - ma10w) / ma10w;
    const trend = pctFromMA > 0.02 ? 'above' : pctFromMA < -0.02 ? 'below' : 'at';
    // TA-W3: MA slope matters more than price position
    // Rising MA with price below = bullish context; falling MA with price above = bearish
    const ma10w_prev  = bars.length >= 55 ? bars.slice(-55,-5).reduce((s,b)=>s+b.c,0)/50 : ma10w;
    const maSlope     = (ma10w - ma10w_prev) / ma10w_prev; // positive = rising, negative = falling
    const maSlopeDir  = maSlope > 0.005 ? 'rising' : maSlope < -0.005 ? 'falling' : 'flat';
    // Bullish when: above MA or (below MA but MA rising = pullback in uptrend)
    // Bearish when: below MA and MA falling (confirmed downtrend)
    const trendContext = (price > ma10w && maSlopeDir !== 'falling') ? 'aligned_bull'
                       : (price < ma10w && maSlopeDir === 'rising')  ? 'pullback_bull'
                       : (price < ma10w && maSlopeDir === 'falling') ? 'confirmed_bear'
                       : 'neutral';
    return setCache('weekly:' + ticker, { trend, ma10w: parseFloat(ma10w.toFixed(2)), pctFromMA: parseFloat((pctFromMA*100).toFixed(1)), above10wk: price > ma10w, maSlope: parseFloat((maSlope*100).toFixed(2)), maSlopeDir, trendContext });
  } catch(e) { return { trend: 'neutral', above10wk: null }; }
}



function getDTEExitParams(dte, daysOpen = 0) {
  // Phase-aware exit tightening — preservation mode locks profits faster
  const acctPhase = getAccountPhase();
  // PDT-aware target adjustment
  const pdtRemaining = Math.max(0, PDT_LIMIT - countRecentDayTrades());
  const pdtTight     = pdtRemaining <= 1;
  const pdtLocked    = pdtRemaining === 0;

  // ── Overnight tier adjustment ─────────────────────────────────────────
  // Monthly options: softer overnight penalty — theta decays slowly, thesis needs time
  // Weekly options: tighter — theta is racing, exit fast
  // Partials: sell half at partialPct, close remainder at takeProfitPct
  let overnightMult = 1.0;
  let overnightLabel = "";
  if (dte <= 21) {
    // Weekly: overnight hurts more — tighten target
    if (daysOpen >= 2) { overnightMult = 0.65; overnightLabel = "(2D+)"; }
    else if (daysOpen >= 1) { overnightMult = 0.80; overnightLabel = "(OVERNIGHT)"; }
  } else {
    // Monthly 30-45 DTE: much gentler overnight adjustment — holding is the plan
    if (daysOpen >= 7)  { overnightMult = 0.75; overnightLabel = "(7D+)"; }
    else if (daysOpen >= 3) { overnightMult = 0.85; overnightLabel = "(3D+)"; }
    else if (daysOpen >= 1) { overnightMult = 0.92; overnightLabel = "(OVERNIGHT)"; }
  }

  if (dte <= 21) {
    // Weekly / short-DTE — tighter targets, faster exits
    // These should be rare in PDT accounts — mean reversion calls mainly
    const base = pdtLocked ? 0.12 : pdtTight ? 0.15 : 0.20;
    const tp   = parseFloat((base * overnightMult).toFixed(3));
    const part = parseFloat((tp * 0.60).toFixed(3));
    const ride = parseFloat((tp * 1.30).toFixed(3));
    return {
      takeProfitPct:  tp,
      partialPct:     part,
      ridePct:        ride,
      stopLossPct:    0.30, // tighter stop on weeklies — theta risk is real
      fastStopPct:    0.15,
      trailActivate:  pdtLocked ? 0.08 : pdtTight ? 0.10 : 0.12,
      trailStop:      pdtLocked ? 0.05 : 0.07,
      label:          (pdtLocked ? "SHORT-DTE(PDT-LOCKED)" : pdtTight ? "SHORT-DTE(PDT-TIGHT)" : "SHORT-DTE") + overnightLabel,
    };
  } else if (dte <= 45) {
    // Monthly 30-45 DTE — primary strategy for PDT-constrained accounts
    // Target 30-50% — give the thesis room to play out over 5-10 days
    const base = pdtLocked ? 0.25 : pdtTight ? 0.30 : 0.40;
    const tp   = parseFloat((base * overnightMult).toFixed(3));
    const part = parseFloat((tp * 0.55).toFixed(3));
    const ride = parseFloat((tp * 1.40).toFixed(3)); // ride winners longer on monthlies
    return {
      takeProfitPct:  tp,
      partialPct:     part,
      ridePct:        ride,
      stopLossPct:    0.35,
      fastStopPct:    0.20,
      trailActivate:  pdtLocked ? 0.15 : pdtTight ? 0.18 : 0.22,
      trailStop:      pdtLocked ? 0.08 : pdtTight ? 0.10 : 0.12,
      label:          (pdtLocked ? "MONTHLY(PDT-LOCKED)" : pdtTight ? "MONTHLY(PDT-TIGHT)" : "MONTHLY") + overnightLabel,
    };
  } else {
        const base = pdtLocked ? 0.35 : pdtTight ? 0.45 : 0.55;
    const tp   = parseFloat((base * overnightMult).toFixed(3));
    const part = parseFloat((tp * 0.55).toFixed(3));
    const ride = parseFloat((tp * 1.50).toFixed(3));
    return {
      takeProfitPct:  tp,
      partialPct:     part,
      ridePct:        ride,
      stopLossPct:    0.35,
      fastStopPct:    0.20,
      trailActivate:  pdtLocked ? 0.20 : pdtTight ? 0.25 : 0.30,
      trailStop:      pdtLocked ? 0.10 : pdtTight ? 0.12 : 0.15,
      label:          (pdtLocked ? "LEAPS(PDT-LOCKED)" : pdtTight ? "LEAPS(PDT-TIGHT)" : "LEAPS") + overnightLabel,
    };
  }
}



function getBusinessDaysAgo(n) {
  // Returns the date n business days ago (skips weekends)
  let date = new Date();
  let count = 0;
  while (count < n) {
    date.setDate(date.getDate() - 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) count++; // skip Sat/Sun
  }
  return date;
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
  // A position is a day trade if it was opened today (same ET calendar date)
  // Use ET timezone to match market conventions — not server UTC
  if (!pos || !pos.openDate) return false;
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



function calcPositionSize(premium, score, vix) {
  // Step 1: Kelly base from actual trade history (dynamic)
  const recentTrades = (state.closedTrades || []).slice(0, 30);
  let kellyBase;

  if (recentTrades.length >= 10) {
    // Use real historical Kelly when we have enough data
    const wins    = recentTrades.filter(t => t.pnl > 0);
    const losses  = recentTrades.filter(t => t.pnl <= 0);
    const winRate = wins.length / recentTrades.length;
    const avgWin  = wins.length   ? wins.reduce((s,t) => s+t.pnl,0) / wins.length   : TAKE_PROFIT_PCT * premium * 100;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s,t) => s+t.pnl,0) / losses.length) : STOP_LOSS_PCT * premium * 100;
    const payoff  = avgLoss > 0 ? avgWin / avgLoss : 1;
    const kelly   = winRate - (1 - winRate) / payoff;
    kellyBase     = Math.max(0.05, Math.min(0.25, kelly * 0.5)); // half-Kelly, capped 5-25% of capital
  } else {
    // Bootstrap: hard cap at 1 contract until 30 live trades give real edge data
    // Paper trade Kelly is inflated — don't let it size up until live fills calibrate it
    kellyBase = 0.05; // conservative 5% of capital = typically 1 contract
  }

  // Live trading protection — never exceed 1 contract until 30 real trades recorded
  const liveTrades = (state.dataQuality || {}).realTrades || 0;
  if (liveTrades < 30) {
    // Force single contract sizing until system is calibrated on live fills
    return 1;
  }

  // Step 2: Score conviction multiplier
  // Higher score = more conviction = size up within Kelly bounds
  const convictionMult = score >= 85 ? 1.25 : score >= 75 ? 1.0 : score >= 70 ? 0.80 : 0.60;

  // Time of day sizing — reduce in first 30 mins (wide spreads, price discovery)
  // Pros size down at open — market makers widen spreads until order flow stabilizes
  const etNow  = getETTime();
  const minsSinceOpen = (etNow.getHours() - 9) * 60 + etNow.getMinutes() - 30;
  const openingMult   = minsSinceOpen < 30 ? 0.75 : 1.0; // 25% smaller in first 30 mins

  // Step 3: VIX adjustment — Guo & Whitelaw (2006): DEBIT put returns asymmetric to VIX
  // G&W finding applies to BUYING puts (debit) — premium too high at VIX > 40
  // SELLING puts (credit) is OPPOSITE — VIX > 40 = maximum premium collection
  // isCreditEntry is set from useCreditSpread flag passed through
  const isCreditEntry = (state._lastEntryType === "credit");
  const vixMult = isCreditEntry
    ? (vix >= 40 ? 1.25 : vix >= 35 ? 1.10 : 1.0)  // credit: INCREASE size at high VIX
    : (vix >= 40  ? 0.35                              // debit: G&W — VIX>40 puts overpriced
    : vix >= VIX_REDUCE50 ? 0.50                      // VIX 35-40: moderate reduction
    : vix >= VIX_REDUCE25 ? 0.75                      // VIX 25-35: slight reduction
    : 1.0);

  // Step 4: Drawdown protocol from marketContext
  const ddMult = (marketContext?.drawdownProtocol?.sizeMultiplier) || 1.0;

  // Step 5: Combine into single sizing decision
  const effectiveFraction = kellyBase * convictionMult * vixMult * ddMult * openingMult;
  const maxCost           = Math.min(
    state.cash * effectiveFraction,
    state.cash * 0.20,                     // hard cap: never more than 20% per trade
    MAX_LOSS_PER_TRADE / STOP_LOSS_PCT     // risk-based cap
  );

  const contracts = Math.max(1, Math.min(5, Math.floor(maxCost / (premium * 100))));

  // If even 1 contract exceeds the risk-based cap, return 0 to signal skip
  // Caller checks contracts < 1 and skips the trade
  if (premium * 100 > MAX_LOSS_PER_TRADE / STOP_LOSS_PCT) return 0;

  return contracts;
}



async function syncPositionPnLFromAlpaca() {
  if (!ALPACA_KEY) return;
  try {
    const alpacaPositions = await alpacaGet("/positions");
    if (!alpacaPositions || !Array.isArray(alpacaPositions)) return;

    // Alpaca is the single source of truth for all financial data
    // Build lookup by symbol
    const alpacaBySymbol = {};
    for (const ap of alpacaPositions) {
      alpacaBySymbol[ap.symbol] = ap;
    }

    let updated = 0;
    for (const pos of state.positions) {
      if (!pos.isSpread || !pos.buySymbol || !pos.sellSymbol) continue;

      const buyLeg  = alpacaBySymbol[pos.buySymbol];
      const sellLeg = alpacaBySymbol[pos.sellSymbol];

      if (!buyLeg || !sellLeg) continue;

      // ── Contracts: Alpaca is authoritative ─────────────────────────────
      // Use abs(qty) from the buy leg (long leg always positive qty)
      const alpacaContracts = Math.abs(parseInt(buyLeg.qty || 1));
      if (alpacaContracts !== pos.contracts) {
        logEvent("scan", `[ALPACA SYNC] ${pos.ticker} contracts: ${pos.contracts} → ${alpacaContracts} (Alpaca authoritative)`);
        pos.contracts = alpacaContracts;
      }

      // ── Current prices ──────────────────────────────────────────────────
      const buyPrice  = parseFloat(buyLeg.current_price  || 0);
      const sellPrice = parseFloat(sellLeg.current_price || 0);

      if (buyPrice > 0 && sellPrice > 0) {
        const netPrice = pos.isCreditSpread
          ? parseFloat((sellPrice - buyPrice).toFixed(2))   // cost to close
          : parseFloat((buyPrice  - sellPrice).toFixed(2)); // current value
        pos.currentPrice = netPrice;
        pos.realData     = true;
      }

      // ── P&L: sum both legs (Alpaca handles sign correctly) ──────────────
      const netPnL = parseFloat(buyLeg.unrealized_pl || 0) + parseFloat(sellLeg.unrealized_pl || 0);
      pos.unrealizedPnL = parseFloat(netPnL.toFixed(2));

      // ── Entry price / premium ───────────────────────────────────────────
      // Do NOT overwrite pos.premium from avg_entry_price — individual leg
      // avg_entry_price doesn't reflect the net credit/debit received at entry.
      // pos.premium is set correctly at fill confirmation and must be preserved.

      // ── Cost basis ──────────────────────────────────────────────────────
      // Credit spread cost = margin reserved = maxLoss (max risk)
      // Debit spread cost  = net debit paid  = premium × 100 × contracts
      if (pos.maxLoss > 0) {
        pos.cost = pos.isCreditSpread ? pos.maxLoss : pos.maxLoss;
      }

      // ── Max profit / max loss (always recalculate from Alpaca data) ─────
      const width = Math.abs((pos.buyStrike || 0) - (pos.sellStrike || 0));
      if (width > 0 && pos.premium > 0) {
        if (pos.isCreditSpread) {
          pos.maxProfit = parseFloat((pos.premium          * 100 * pos.contracts).toFixed(2));
          pos.maxLoss   = parseFloat(((width - pos.premium)* 100 * pos.contracts).toFixed(2));
        } else {
          pos.maxProfit = parseFloat(((width - pos.premium)* 100 * pos.contracts).toFixed(2));
          pos.maxLoss   = parseFloat((pos.premium          * 100 * pos.contracts).toFixed(2));
        }
      }

      // ── Breakeven ───────────────────────────────────────────────────────
      if (!pos.breakeven && pos.premium > 0) {
        if (pos.isCreditSpread) {
          pos.breakeven = pos.optionType === "put"
            ? parseFloat((pos.sellStrike - pos.premium).toFixed(2))
            : parseFloat((pos.sellStrike + pos.premium).toFixed(2));
        } else {
          pos.breakeven = pos.optionType === "put"
            ? parseFloat((pos.buyStrike  - pos.premium).toFixed(2))
            : parseFloat((pos.buyStrike  + pos.premium).toFixed(2));
        }
      }

      // ── dteLabel cleanup ────────────────────────────────────────────────
      if (pos.dteLabel === "RECONCILED-SPREAD") pos.dteLabel = "SPREAD-MONTHLY";

      updated++;
    }
    if (updated > 0) markDirty();
  } catch(e) { logEvent("warn", `[ALPACA SYNC] syncPositionPnLFromAlpaca error: ${e.message}`); }
}



// =======================================================================
// ARGO CONTRACT SELECTION - v3.0
// One shared primitive: findContract()
// Replaces: getRealOptionsContract, getSpreadSellLeg, selectExpiry
// Used by: executeDebitSpread, executeIronCondor (executeCreditSpread has its own)
// =======================================================================

// -- B-S delta inversion -----------------------------------------------
// Returns the strike where a put (or call) has the given delta.
// Uses Abramowitz & Stegun rational approximation for invPhi.
function bsStrikeForDelta(price, targetDelta, T, sigma, optionType = "put", r = 0.05) {
  // Put:  |delta| = N(-d1) = targetDelta  =>  d1 = -normInv(targetDelta)
  // Call: |delta| = N(d1)  = targetDelta  =>  d1 = +normInv(targetDelta)
  // normInv via Beasley-Springer-Moro rational approximation
  const d = Math.max(0.01, Math.min(0.99, targetDelta));
  const q = Math.min(d, 1 - d);
  const t = Math.sqrt(-2 * Math.log(q));
  const normInvD = (d < 0.5 ? -1 : 1) * (t - (2.515517 + 0.802853*t + 0.010328*t*t) /
                   (1 + 1.432788*t + 0.189269*t*t + 0.001308*t*t*t));
  // d1: negative for puts (strike below spot), positive for calls (strike above spot)
  const d1 = optionType === "put" ? -normInvD : normInvD;
  const lnSK = d1 * sigma * Math.sqrt(T) - (r + sigma*sigma/2) * T;
  const strikeRaw = price * Math.exp(-lnSK);
  const inc = price < 200 ? 0.5 : 1;
  return Math.round(strikeRaw / inc) * inc;
}

// -- findContract ------------------------------------------------------
// The one shared primitive. Fetches a tight DTE window, sorts by strike
// proximity, batch-fetches snapshots, returns the best match.
//
// params:
//   ticker       - "SPY", "QQQ", etc.
//   optionType   - "put" | "call"
//   targetDelta  - 0.35 debit put/call, 0.20 credit short leg, 0.40 MR call
//   targetDTE    - calendar days to target expiry (21, 28, etc.)
//   vix          - current VIX (for IV fallback)
//   stock        - stock object (for _realIV)
//   fixedExpiry  - (optional) ISO date string - forces same-expiry lookup for protection legs
//
async function findContract(ticker, optionType, targetDelta, targetDTE, vix, stock, fixedExpiry = null) {
  try {
    const today = getETTime();
    const sigma = (stock && stock._realIV && stock._realIV > 0.05) ? stock._realIV : vix / 100;
    const T     = Math.max(0.01, targetDTE / 365);

    // Step 1: compute target strike via B-S inversion
    const targetStrike = bsStrikeForDelta(stock ? stock.price || 0 : 0, targetDelta, T, sigma, optionType);
    if (!targetStrike || targetStrike <= 0) return null;

    // Step 2: fetch contract list
    // If fixedExpiry: fetch only that single expiry (for protection legs)
    // Otherwise: fetch [targetDTE-7, targetDTE+14] window
    let fetchMin, fetchMax;
    if (fixedExpiry) {
      fetchMin = fixedExpiry;
      fetchMax = fixedExpiry;
    } else {
      const minDays = Math.max(7, targetDTE - 7);
      const maxDays = Math.min(60, targetDTE + 14);
      fetchMin = new Date(today.getTime() + minDays * 86400000).toISOString().split("T")[0];
      fetchMax = new Date(today.getTime() + maxDays * 86400000).toISOString().split("T")[0];
    }

    const baseUrl = `/options/contracts?underlying_symbol=${ticker}&expiration_date_gte=${fetchMin}&expiration_date_lte=${fetchMax}&type=${optionType}&limit=200`;
    let allC = [], tok = null, pages = 0;
    do {
      const pg = await alpacaGet(tok ? `${baseUrl}&page_token=${tok}` : baseUrl, ALPACA_OPTIONS);
      if (!pg || !pg.option_contracts) break;
      allC = allC.concat(pg.option_contracts);
      tok = pg.next_page_token || null;
      pages++;
    } while (tok && pages < 5);

    if (!allC.length) {
      logEvent("filter", `${ticker} findContract: no contracts ${fetchMin}->${fetchMax}`);
      return null;
    }

    // Step 3: sort by strike proximity (tiebreak: DTE proximity to targetDTE)
    allC.sort((a, b) => {
      const da = Math.abs(parseFloat(a.strike_price) - targetStrike);
      const db = Math.abs(parseFloat(b.strike_price) - targetStrike);
      if (Math.abs(da - db) > 0.01) return da - db;
      const aDTE = Math.round((new Date(a.expiration_date) - today) / 86400000);
      const bDTE = Math.round((new Date(b.expiration_date) - today) / 86400000);
      return Math.abs(aDTE - targetDTE) - Math.abs(bDTE - targetDTE);
    });

    // Step 4: batch-fetch snapshots for top 50 candidates
    const symbols = allC.slice(0, 50).map(c => c.symbol);
    const batches = [];
    for (let i = 0; i < symbols.length; i += 25) batches.push(symbols.slice(i, i+25).join(","));
    const snapResults = await Promise.all(
      batches.map(b => alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP).catch(() => null))
    );
    const snaps = snapResults.reduce((acc, r) => ({ ...acc, ...(r?.snapshots || {}) }), {});

    // Step 5: pick first contract with price and delta in acceptable range
    const deltaMin = Math.max(0.05, targetDelta - 0.12);
    const deltaMax = Math.min(0.65, targetDelta + 0.12);

    for (const c of allC.slice(0, 50)) {
      const snap = snaps[c.symbol];
      if (!snap) continue;
      const q   = snap.latestQuote || {};
      const g   = snap.greeks || {};
      const bid = parseFloat(q.bp || 0);
      const ask = parseFloat(q.ap || 0);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid <= 0) continue;
      const delta = Math.abs(parseFloat(g.delta || 0));
      if (delta < deltaMin || delta > deltaMax) continue;
      const strike = parseFloat(c.strike_price);
      const expDTE = Math.round((new Date(c.expiration_date) - today) / 86400000);
      const otm    = Math.abs((targetStrike - strike) / targetStrike * 100);
      logEvent("filter", `${ticker} findContract: ${optionType} $${strike} | ${expDTE}DTE | delta${delta.toFixed(3)} | $${mid.toFixed(2)} | target delta${targetDelta} strike $${targetStrike}`);
      return {
        symbol:  c.symbol,
        strike,
        expDate: c.expiration_date,
        expDays: expDTE,
        premium: parseFloat(mid.toFixed(2)),
        bid, ask,
        spread:  ask > 0 ? (ask - bid) / ask : 1,
        greeks:  { delta: parseFloat(g.delta || 0).toFixed(3),
                   theta: parseFloat(g.theta || 0).toFixed(3),
                   gamma: parseFloat(g.gamma || 0).toFixed(4),
                   vega:  parseFloat(g.vega  || 0).toFixed(3) },
        oi:      parseInt(snap.openInterest || 0),
        iv:      parseFloat(snap.impliedVolatility || sigma),
      };
    }

    logEvent("filter", `${ticker} findContract: no valid ${optionType} found (target delta${targetDelta} strike $${targetStrike} window ${fetchMin}->${fetchMax})`);
    return null;
  } catch(e) {
    logEvent("error", `findContract(${ticker}): ${e.message}`);
    return null;
  }
}

// -- executeDebitSpread ------------------------------------------------
// Handles directional debit spreads (paths 3 + 4 in execution loop).
// Replaces all the inline contract-fetching in the execution loop.
//
async function executeDebitSpread(stock, price, optionType, vix, score, scoreReasons, sizeMod, isMR = false) {
  try {
    const targetDelta = optionType === "call" ? (isMR ? 0.40 : 0.35) : 0.35;
    const targetDTE   = isMR ? 21 : 28;
    // Spread width: price-relative (SPY->$15, QQQ->$13, TLT->$5)
    const spreadWidth = Math.max(5, Math.round(price * 0.022));

    // Find buy (primary direction) leg
    const buyLeg = await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
    if (!buyLeg) {
      logEvent("filter", `${stock.ticker} debit spread: no buy leg found (delta${targetDelta} DTE~${targetDTE})`);
      return null;
    }

    // Find sell (protection) leg on same expiry, spreadWidth away
    const sellStrike = optionType === "put" ? buyLeg.strike - spreadWidth : buyLeg.strike + spreadWidth;
    const sellDelta  = Math.max(0.05, parseFloat(buyLeg.greeks.delta) - 0.15);  // approx further OTM
    const sellLeg    = await findContract(stock.ticker, optionType, sellDelta, targetDTE, vix, stock, buyLeg.expDate);
    if (!sellLeg) {
      logEvent("filter", `${stock.ticker} debit spread: no sell leg found on ${buyLeg.expDate}`);
      return null;
    }

    const actualWidth = Math.abs(buyLeg.strike - sellLeg.strike);
    if (actualWidth < spreadWidth * 0.5) {
      logEvent("filter", `${stock.ticker} debit spread: width $${actualWidth} too narrow`);
      return null;
    }

    const netDebit = parseFloat((buyLeg.premium - sellLeg.premium).toFixed(2));
    if (netDebit <= 0) {
      logEvent("filter", `${stock.ticker} debit spread: no debit (${netDebit}) - legs mispriced`);
      return null;
    }

    const rrRatio = actualWidth > 0 ? netDebit / actualWidth : 1;
    if (rrRatio > 0.40) {
      logEvent("filter", `${stock.ticker} debit spread R/R ${(rrRatio*100).toFixed(0)}% (debit $${netDebit} / width $${actualWidth}) - above 40% max`);
      return null;
    }

    logEvent("filter", `${stock.ticker} debit spread: buy $${buyLeg.strike} / sell $${sellLeg.strike} | width $${actualWidth} | net $${netDebit} | R/R ${(rrRatio*100).toFixed(0)}%`);
    return await executeSpreadTrade(stock, price, score, scoreReasons, vix, optionType, buyLeg, sellLeg, false);
  } catch(e) {
    logEvent("error", `executeDebitSpread(${stock.ticker}): ${e.message}`);
    return null;
  }
}

// -- executeIronCondor (rebuilt) ---------------------------------------
// Calls findContractx4: put short/long + call short/long, same expiry.
//
async function executeIronCondor(stock, price, score, scoreReasons, vix) {
  try {
    const ivRankNow = state._ivRank || 50;
    if (ivRankNow < 60) { logEvent("filter", `${stock.ticker} iron condor: IVR ${ivRankNow} < 60`); return null; }
    if (vix > 35)        { logEvent("filter", `${stock.ticker} iron condor: VIX ${vix} too high`); return null; }

    const targetDTE   = 21;
    const spreadWidth = Math.max(5, Math.round(price * 0.022));

    logEvent("filter", `${stock.ticker} iron condor: VIX ${vix.toFixed(1)} | IVR ${ivRankNow} | width $${spreadWidth}`);

    // Put side short leg
    const putShort = await findContract(stock.ticker, "put", 0.20, targetDTE, vix, stock);
    if (!putShort) { logEvent("filter", `${stock.ticker} iron condor: no put short leg`); return null; }
    // Put side long leg (same expiry, spreadWidth below)
    const putLong = await findContract(stock.ticker, "put", 0.08, targetDTE, vix, stock, putShort.expDate);
    if (!putLong)  { logEvent("filter", `${stock.ticker} iron condor: no put long leg`); return null; }
    // Call side short leg
    const callShort = await findContract(stock.ticker, "call", 0.20, targetDTE, vix, stock);
    if (!callShort) { logEvent("filter", `${stock.ticker} iron condor: no call short leg`); return null; }
    // Call side long leg (same expiry, spreadWidth above)
    const callLong = await findContract(stock.ticker, "call", 0.08, targetDTE, vix, stock, callShort.expDate);
    if (!callLong)  { logEvent("filter", `${stock.ticker} iron condor: no call long leg`); return null; }

    const putCredit   = parseFloat((putShort.premium  - putLong.premium).toFixed(2));
    const callCredit  = parseFloat((callShort.premium - callLong.premium).toFixed(2));
    const totalCredit = parseFloat((putCredit + callCredit).toFixed(2));
    if (totalCredit <= 0.50) { logEvent("filter", `${stock.ticker} iron condor: total credit $${totalCredit} too low`); return null; }

    const putWidth  = Math.abs(putShort.strike  - putLong.strike);
    const callWidth = Math.abs(callShort.strike - callLong.strike);
    const maxLoss   = Math.max(putWidth, callWidth) - totalCredit;
    if (maxLoss <= 0) { logEvent("filter", `${stock.ticker} iron condor: invalid max loss`); return null; }
    const rrRatio   = totalCredit / maxLoss;
    if (rrRatio < 0.20) { logEvent("filter", `${stock.ticker} iron condor: R/R ${(rrRatio*100).toFixed(0)}% below 20%`); return null; }

    const marginRequired = parseFloat((maxLoss * 100).toFixed(2));
    const creditCapPct   = (state.closedTrades||[]).filter(t=>t.pnl>0).length >= 20 ? 0.25 : 0.15;
    if (marginRequired > state.cash * creditCapPct) { logEvent("filter", `${stock.ticker} iron condor: margin $${marginRequired} exceeds limit`); return null; }
    if (dryRunMode) {
      logEvent("dryrun", `WOULD IRON CONDOR ${stock.ticker} put $${putShort.strike}/$${putLong.strike} call $${callShort.strike}/$${callLong.strike} | credit $${totalCredit} | R/R ${(rrRatio*100).toFixed(0)}%`);
      return null;
    }

    logEvent("trade", `[IRON CONDOR] ${stock.ticker} put $${putShort.strike}/$${putLong.strike} | call $${callShort.strike}/$${callLong.strike} | credit $${totalCredit}`);
    const _clientOrderId = `argo-ic-${stock.ticker}-${Math.floor(Date.now()/10000)}`;
    const mlegBody = {
      order_class: "mleg", type: "limit", time_in_force: "day", qty: "1",
      limit_price: String(-totalCredit),
      client_order_id: _clientOrderId,
      legs: [
        { symbol: putShort.symbol,  side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
        { symbol: putLong.symbol,   side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"  },
        { symbol: callShort.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
        { symbol: callLong.symbol,  side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"  },
      ],
    };
    const resp = await alpacaPost("/orders", mlegBody);
    if (!resp || resp.code || !resp.id) { logEvent("warn", `${stock.ticker} iron condor order failed: ${JSON.stringify(resp)?.slice(0,200)}`); return null; }
    logEvent("trade", `[IRON CONDOR] submitted: ${resp.id}`);
    return { pending: true };
  } catch(e) {
    logEvent("error", `executeIronCondor(${stock.ticker}): ${e.message}`);
    return null;
  }
}

async function executeCreditSpread(stock, price, score, scoreReasons, vix, optionType, sizeMod = 1.0, spreadParamsOverride = null) {
  try {
    // -- CREDIT SPREAD CONTRACT SELECTION -------------------------------------
    // Rebuilt from scratch. Simple, direct, no layered abstraction.
    //
    // Step 1: Compute target short strike from delta (not OTM%)
    // Step 2: Fetch the options chain for the target expiry window only
    // Step 3: Find the contract closest to the target strike with valid price
    // Step 4: Find the long leg protection contract on the same expiry
    // Step 5: Validate width, credit, and R/R
    // -------------------------------------------------------------------------

    // Parameters from entryEngine or sensible defaults
    const targetDelta  = (spreadParamsOverride && spreadParamsOverride.shortDeltaTarget) || 0.20;
    const targetDTE    = (spreadParamsOverride && spreadParamsOverride.targetDTE)        || 21;
    const minDTE       = (spreadParamsOverride && spreadParamsOverride.minDTE)           || 14;
    const minCreditRR  = (spreadParamsOverride && spreadParamsOverride.minCreditRatio)   || 0.20;
    // Spread width: price-relative so TLT($86)->$5, SPY($675)->$15
    const baseWidth    = (spreadParamsOverride && spreadParamsOverride.creditWidth)      || 15;
    const spreadWidth  = Math.max(5, Math.min(baseWidth, Math.round(price * 0.025)));

    // -- STEP 1: Target strike via B-S delta inversion ----------------------
    // Use live IV from prefetch, fallback to VIX/100
    const sigma = (stock._realIV && stock._realIV > 0.05) ? stock._realIV : vix / 100;
    const T     = Math.max(0.01, targetDTE / 365);
    const r     = 0.05;
    // invPhi(1 - targetDelta) via A&S rational approximation
    const _p = 1 - targetDelta;
    const _q = Math.min(_p, 1 - _p);
    const _t = Math.sqrt(-2 * Math.log(_q));
    const _num = 2.515517 + 0.802853*_t + 0.010328*_t*_t;
    const _den = 1 + 1.432788*_t + 0.189269*_t*_t + 0.001308*_t*_t*_t;
    const _z   = (_p < 0.5 ? -1 : 1) * (_t - _num/_den);  // invPhi(1-delta)
    const shortStrikeRaw = price * Math.exp(-(_z * sigma * Math.sqrt(T) - (r + sigma*sigma/2) * T));
    const inc = price < 200 ? 0.5 : 1;  // $0.50 increments for TLT/GLD, $1 for SPY/QQQ
    const shortStrike = Math.round(shortStrikeRaw / inc) * inc;
    const longStrike  = optionType === "put" ? shortStrike - spreadWidth : shortStrike + spreadWidth;
    const actualOTM   = Math.abs((price - shortStrike) / price * 100);
    logEvent("filter", `${stock.ticker} credit spread: $${spreadWidth} wide | target delta ${targetDelta} -> short $${shortStrike} (${actualOTM.toFixed(1)}% OTM) / long $${longStrike} | ?=${(sigma*100).toFixed(0)}% DTE~${targetDTE}`);

    // -- STEP 2: Fetch options chain for target expiry window only -----------
    // Fetch minDTE->(targetDTE+14) window so short-dated weeklies don't fill the 1000-cap.
    // This is the fix that stopped May contracts being crowded out by Apr weeklies.
    const today      = getETTime();
    const fetchMin   = new Date(today.getTime() + minDTE * 86400000).toISOString().split("T")[0];
    const fetchMax   = new Date(today.getTime() + Math.min(45, targetDTE + 14) * 86400000).toISOString().split("T")[0];
    const chainUrl   = `/options/contracts?underlying_symbol=${stock.ticker}&expiration_date_gte=${fetchMin}&expiration_date_lte=${fetchMax}&type=${optionType}&limit=200`;

    let chainContracts = [];
    let pageToken  = null;
    let pages = 0;
    do {
      const url  = pageToken ? `${chainUrl}&page_token=${pageToken}` : chainUrl;
      const page = await alpacaGet(url, ALPACA_OPTIONS);
      if (!page || !page.option_contracts) break;
      chainContracts = chainContracts.concat(page.option_contracts);
      pageToken = page.next_page_token || null;
      pages++;
    } while (pageToken && pages < 5);

    if (!chainContracts.length) {
      logEvent("filter", `${stock.ticker} credit spread: no contracts in window ${fetchMin}->${fetchMax}`);
      return null;
    }
    logEvent("filter", `${stock.ticker} credit spread: ${chainContracts.length} contracts in window (${fetchMin}->${fetchMax})`);

    // -- STEP 3: Find short leg - closest contract to shortStrike, on best expiry -
    // Sort by closeness to shortStrike, then by closeness to targetDTE
    chainContracts.sort((a, b) => {
      const aDist  = Math.abs(parseFloat(a.strike_price) - shortStrike);
      const bDist  = Math.abs(parseFloat(b.strike_price) - shortStrike);
      if (Math.abs(aDist - bDist) > 0.01) return aDist - bDist; // prefer closer strike
      // Tiebreak: prefer expiry closer to targetDTE
      const aExpDTE = Math.round((new Date(a.expiration_date) - today) / 86400000);
      const bExpDTE = Math.round((new Date(b.expiration_date) - today) / 86400000);
      return Math.abs(aExpDTE - targetDTE) - Math.abs(bExpDTE - targetDTE);
    });

    // Fetch snapshots for top candidates (sorted by strike proximity)
    const candidateSymbols = chainContracts.slice(0, 50).map(c => c.symbol);
    const snapBatches = [];
    for (let i = 0; i < candidateSymbols.length; i += 25)
      snapBatches.push(candidateSymbols.slice(i, i+25).join(","));

    const snapResults = await Promise.all(snapBatches.map(b =>
      alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP)
    ));
    const snapshots = snapResults.reduce((acc, r) => ({ ...acc, ...(r?.snapshots || {}) }), {});

    // Find best short leg contract: has price, delta in range, closest to target strike
    let shortContract = null;
    for (const c of chainContracts.slice(0, 50)) {
      const snap   = snapshots[c.symbol];
      if (!snap) continue;
      const quote  = snap.latestQuote || {};
      const greeks = snap.greeks || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid <= 0) continue;
      const delta  = Math.abs(parseFloat(greeks.delta || 0));
      if (delta < 0.10 || delta > 0.35) continue;  // loose range - let R/R gate be the enforcer
      const strike = parseFloat(c.strike_price);
      const expDTE = Math.round((new Date(c.expiration_date) - today) / 86400000);
      shortContract = {
        symbol:  c.symbol,
        strike,
        expDate: c.expiration_date,
        expDays: expDTE,
        premium: parseFloat(mid.toFixed(2)),
        bid, ask,
        spread:  ask > 0 ? (ask - bid) / ask : 1,
        greeks:  { delta: parseFloat(greeks.delta || 0).toFixed(3) },
        oi:      parseInt(snap.openInterest || 0),
        iv:      parseFloat(snap.impliedVolatility || sigma),
      };
      logEvent("filter", `${stock.ticker} short leg: $${strike} | ${expDTE}DTE | delta${delta.toFixed(3)} | $${mid.toFixed(2)}`);
      break;
    }

    if (!shortContract) {
      logEvent("filter", `${stock.ticker} credit spread: no valid short leg found in window`);
      return null;
    }

    // -- STEP 4: Find long leg - same expiry, spreadWidth away --------------
    const longStrikeActual = optionType === "put"
      ? shortContract.strike - spreadWidth
      : shortContract.strike + spreadWidth;

    // Filter chain to same expiry, find closest to longStrikeActual
    const sameExpiry = chainContracts.filter(c => c.expiration_date === shortContract.expDate);
    sameExpiry.sort((a, b) =>
      Math.abs(parseFloat(a.strike_price) - longStrikeActual) -
      Math.abs(parseFloat(b.strike_price) - longStrikeActual)
    );

    // Pre-fetch snapshots for long leg candidates in one batch (avoids serial Alpaca calls)
    const longCandidates = sameExpiry.slice(0, 20);
    const longSymbolsNeeded = longCandidates.map(c => c.symbol).filter(s => !snapshots[s]);
    if (longSymbolsNeeded.length > 0) {
      const longBatches = [];
      for (let i = 0; i < longSymbolsNeeded.length; i += 25)
        longBatches.push(longSymbolsNeeded.slice(i, i+25).join(","));
      const longSnaps = await Promise.all(longBatches.map(b =>
        alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP).catch(() => null)
      ));
      longSnaps.forEach(r => { if (r?.snapshots) Object.assign(snapshots, r.snapshots); });
    }

    let longContract = null;
    for (const c of longCandidates) {
      const snap   = snapshots[c.symbol];
      if (!snap) continue;
      const quote  = snap.latestQuote || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid <= 0) continue;
      const strike = parseFloat(c.strike_price);
      longContract = {
        symbol:  c.symbol,
        strike,
        expDate: c.expiration_date,
        expDays: shortContract.expDays,
        premium: parseFloat(mid.toFixed(2)),
        bid, ask,
      };
      break;
    }

    if (!longContract) {
      logEvent("filter", `${stock.ticker} credit spread: no long leg found at $${longStrikeActual} on ${shortContract.expDate}`);
      return null;
    }

    const actualWidth = Math.abs(shortContract.strike - longContract.strike);
    if (actualWidth < spreadWidth * 0.5) {
      logEvent("filter", `${stock.ticker} credit spread: width $${actualWidth} too narrow (need ? $${(spreadWidth * 0.5).toFixed(0)})`);
      return null;
    }
    logEvent("filter", `${stock.ticker} long leg: $${longContract.strike} | width $${actualWidth} | $${longContract.premium.toFixed(2)}`);

    const netCredit  = parseFloat((shortContract.premium - longContract.premium).toFixed(2));
    if (netCredit <= 0) { logEvent("filter", `${stock.ticker} credit spread: no credit available (${netCredit})`); return null; }

    const maxProfit  = netCredit;                              // keep all credit if expires worthless
    const maxLoss    = parseFloat((actualWidth - netCredit).toFixed(2)); // width - credit = max risk

    // V2.84: Risk/reward validation for credit spreads
    // Maximum acceptable risk/reward ratio: 4:1 (risk $400 to make $100)
    // This requires ~80% win rate to break even -- achievable with proper strike selection
    // Worse than 4:1 (e.g. TLT $97 profit / $903 loss = 9.3:1) is not a viable strategy
    const rrRatioCred = maxLoss > 0 ? maxProfit / maxLoss : 0;
    const MIN_CREDIT_RR = (spreadParamsOverride && spreadParamsOverride.minCreditRatio) || 0.20; // corrected: 0.20 floor matches entryEngine (was 0.30 - too high for delta 0.17 spreads)
    if (rrRatioCred < MIN_CREDIT_RR) {
      logEvent("filter", `${stock.ticker} credit spread R/R ${(rrRatioCred*100).toFixed(0)}% (credit $${netCredit} / risk $${maxLoss}) - below ${(MIN_CREDIT_RR*100).toFixed(0)}% minimum - skip`);
      return null;
    }
    logEvent("filter", `${stock.ticker} credit spread R/R: collect $${(netCredit*100).toFixed(0)} / risk $${(maxLoss*100).toFixed(0)} per contract (${(rrRatioCred*100).toFixed(0)}% ratio)`);
    // C10: Sizing from entryEngine sizeMod parameter (replaces inline scoreBaseMult + ivSizeMultCredit)
    // entryEngine.scoreCandidate already computed: base * ivBoostCredit * crisisAdj * oversoldMod
    // Using internal computation here was overriding that work silently
    // sizeMod arrives as 1.0 base (no boost) to 1.5x (IVR>=70 credit boost)
    const scoreBaseMult      = score >= 90 ? 2.0 : score >= 85 ? 1.5 : score >= 80 ? 1.25 : 1.0;
    const rawCreditContracts = Math.max(1, Math.floor(scoreBaseMult * sizeMod));
    const preFillCapCredit   = (state.closedTrades||[]).length < 30 ? 3 : 99;
    const contracts          = Math.min(preFillCapCredit, rawCreditContracts);
    if (contracts > 1) logEvent("scan", `[SIZING] ${stock.ticker} credit spread: ${contracts}x (score ${score} sizeMod ${sizeMod.toFixed(2)})`);


    // Credit received reduces capital requirement - margin = max loss
    const profitableCount = (state.closedTrades || []).filter(t => t.pnl > 0).length;
    const creditCapPct    = profitableCount >= 20 ? 0.25 : 0.15;
    const marginRequired  = parseFloat((maxLoss * 100 * contracts).toFixed(2));
    if (marginRequired > state.cash * creditCapPct) {
      logEvent("filter", `${stock.ticker} credit spread margin $${marginRequired} exceeds ${(creditCapPct*100).toFixed(0)}% limit`);
      return null;
    }
    if (state.cash - marginRequired < CAPITAL_FLOOR) {
      logEvent("filter", `${stock.ticker} credit spread would breach capital floor`);
      return null;
    }
    const optBPCredit = state.alpacaOptBP || state.alpacaBuyPower || state.cash;
    if (marginRequired > optBPCredit) {
      logEvent("filter", `${stock.ticker} credit spread margin $${marginRequired} exceeds Alpaca options buying power $${optBPCredit.toFixed(2)} - skip`);
      return null;
    }

    if (dryRunMode) {
      logEvent("dryrun", `WOULD SELL CREDIT SPREAD ${stock.ticker} $${shortContract.strike}/$${longContract.strike} ${optionType.toUpperCase()} | credit $${netCredit} | max profit $${maxProfit} | max loss $${maxLoss} | margin $${marginRequired} | score ${score}`);
      return null;
    }

    // BUG-3: Duplicate order guard - verify no existing position in same ticker+direction
    // Prevents double-short scenario where two spread orders create asymmetric leg counts
    const existingSameDir = state.positions.filter(p =>
      p.ticker === stock.ticker && p.optionType === optionType
    );
    if (existingSameDir.length > 0) {
      logEvent("filter", `[CREDIT SPREAD] Duplicate guard: ${stock.ticker} already has ${existingSameDir.length} ${optionType} position(s) - skipping to prevent asymmetric legs`);
      return null;
    }

    let shortOrderId = null, longOrderId = null;
    try {
      // - MULTI-LEG ORDER for credit spread -
      // limit_price is NEGATIVE for credit (we receive money)
      const shortMid = shortContract.bid > 0 && shortContract.ask > 0
        ? parseFloat(((shortContract.bid + shortContract.ask) / 2).toFixed(2))
        : parseFloat(shortContract.bid.toFixed(2));
      const longMid = longContract.bid > 0 && longContract.ask > 0
        ? parseFloat(((longContract.bid + longContract.ask) / 2).toFixed(2))
        : parseFloat(longContract.ask.toFixed(2));
      const netCreditLimit = parseFloat((longMid - shortMid).toFixed(2)); // negative = credit

      // C2: Idempotency key -- prevents duplicate orders on network timeout/retry
      // Deterministic: same ticker+direction+timestamp bucket will not double-submit
      const _clientOrderId = `argo-cs-${stock.ticker}-${optionType}-${Math.floor(Date.now()/10000)}`;
      const mlegBody = {
        order_class:    "mleg",
        type:           "limit",
        time_in_force:  "day",
        qty:            String(contracts),
        limit_price:    String(netCreditLimit), // negative = credit received
        client_order_id: _clientOrderId,
        legs: [
          { symbol: shortContract.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
          { symbol: longContract.symbol,  side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"  },
        ],
      };

      // C1: Record pending order BEFORE submission so crash-recovery catches it
      // If process dies between record and submit, reconciliation sees the pending order
      // If submit fails, catch block clears _pendingOrder
      state._pendingOrder = {
        orderId:        _clientOrderId, // will be replaced with real ID on success
        ticker:         stock.ticker,
        optionType,
        isCreditSpread: true,
        buySymbol:      longContract.symbol,
        sellSymbol:     shortContract.symbol,
        buyStrike:      longContract.strike,
        sellStrike:     shortContract.strike,
        netCredit,
        netDebitLimit:  netCredit,
        finalCost:      marginRequired,
        contracts,
        score,
        scoreReasons,
        expDate:        shortContract.expDate,
        expDays:        shortContract.expDays,
        submittedAt:    Date.now(),
        isSpread:       true,
        isChoppyEntry:  false,
        mlegBody,
        _preSubmit:     true, // flag: not yet confirmed submitted to Alpaca
      };
      markDirty();

      logEvent("trade", `[CREDIT SPREAD] Submitting mleg: sell $${shortContract.strike} / buy $${longContract.strike} | ${contracts}x | net credit $${Math.abs(netCreditLimit)} | id: ${_clientOrderId}`);
      const mlegResp = await alpacaPost("/orders", mlegBody);

      if (!mlegResp || mlegResp.code || !mlegResp.id) {
        logEvent("warn", `[CREDIT SPREAD] mleg order failed: ${JSON.stringify(mlegResp)?.slice(0,200)}`);
        return null;
      }

      shortOrderId = mlegResp.id;
      longOrderId  = mlegResp.id;
      // Update pending order with real Alpaca ID (replace the pre-submit client_order_id)
      state._pendingOrder.orderId  = mlegResp.id;
      state._pendingOrder._preSubmit = false;
      markDirty();
      logEvent("trade", `[CREDIT SPREAD] mleg submitted: ${mlegResp.id} | status: ${mlegResp.status}`);
      logEvent("trade", `[CREDIT SPREAD] Order pending - will confirm fill on next scan`);
      return { pending: true };
    } catch(e) {
      logEvent("error", `[CREDIT SPREAD] mleg error: ${e.message}`);
      state._pendingOrder = null;
      return null;
    }
    // Position recording now handled by confirmPendingOrder() on fill confirmation
  } catch(e) {
    logEvent("error", `executeCreditSpread(${stock.ticker}): ${e.message}`);
    state._pendingOrder = null;
    return null;
  }
}


async function executeSpreadTrade(stock, price, score, scoreReasons, vix, optionType, buyContract, sellContract, isChoppyEntry = false) {
  if (!buyContract || !sellContract) return null;
  // BUG-3: Duplicate order guard - same protection as credit spreads
  // If Alpaca already has a short leg in this ticker+direction, don't add another long+short pair
  if (!dryRunMode) {
    const existingSameDir = state.positions.filter(p =>
      p.ticker === stock.ticker && p.optionType === optionType
    );
    if (existingSameDir.length > 0) {
      logEvent("filter", `[SPREAD] Duplicate guard: ${stock.ticker} already has ${existingSameDir.length} ${optionType} position(s) - skipping`);
      return null;
    }
  }

  // - Score-based contract sizing -
  // Before 30 fills (Kelly pre-activation): scale by conviction
  // Hard cap: never more than 15% of cash per position
  const netDebit  = parseFloat((buyContract.premium - sellContract.premium).toFixed(2));
  const costPer1  = parseFloat((netDebit * 100).toFixed(2));
  // Scale position cap based on validated win count
  // Under 20 profitable trades: conservative 15% - system unvalidated
  // 20+ profitable trades: unlock 25% - system has demonstrated edge
  const profitableTradeCount = (state.closedTrades || []).filter(t => t.pnl > 0).length;
  // SIZING HIERARCHY (explicit priority order):
  // 1. Score-based starting point: score>=90=3, score>=80=2, else=1
  // 2. Kelly adjustment: multiplies base by Kelly fraction (win-rate informed)
  // 3. posCapPct hard dollar cap: overrides everything - max 15%/25% of cash
  // This order is intentional: score sets intent, Kelly adjusts for edge, cap enforces risk limit
  const posCapPct = profitableTradeCount >= 20 ? 0.25 : 0.15;
  if (profitableTradeCount < 20) logEvent("filter", `Position cap at 15% (${profitableTradeCount}/20 profitable trades - unlocks at 20)`);
  const cashCap   = Math.floor((state.cash * posCapPct) / costPer1);
  let baseContracts;
  if (score >= 90)      baseContracts = 3;
  else if (score >= 80) baseContracts = 2;
  else                  baseContracts = 1;
  // High risk day: halve sizing
  // If _dayPlan is null (e.g. after mid-day reset), default to high risk (conservative)
  // A missing day plan should never unlock full sizing - fail safe, not fail open
  // 200MA bear regime: additional 50% size reduction (stacks with other multipliers)
  // Derived from state directly -- spyBelow200MA is a runScan-scoped var, not available here
  const spyBelow200MALocal = !!(state._spyMA200 && state._liveSPY && state._liveSPY < state._spyMA200);
  const below200MAMult = spyBelow200MALocal ? 0.5 : 1.0;
  const riskMult = ((!state._dayPlan || state._dayPlan.riskLevel === "high") ? 0.5 : 1.0) * below200MAMult;
  // 3B: Score-proportional sizing - higher conviction = larger position (pre-30 fills cap still applies)
  // Applied downstream as a multiplier on contract count
  const scoreSizeMult = (score) => score >= 90 ? 2.0 : score >= 85 ? 1.5 : score >= 80 ? 1.25 : 1.0;
  // AG-7: positionSizeMult from agent - continuous sizing vs binary riskLevel
  // Cap at 1.0 before 30 fills - agent amplification only unlocks on validated system
  const rawAgentSizeMult = (state._agentMacro || {}).positionSizeMult || 1.0;
  const agentSizeMult = (state.closedTrades||[]).length < 30
    ? Math.min(1.0, Math.max(0.25, rawAgentSizeMult))  // capped at 1.0 pre-validation
    : Math.min(1.5, Math.max(0.25, rawAgentSizeMult)); // full range post-validation
  // Hard cap: before 30 fills, never exceed 3 contracts regardless of multipliers
  // After 30 fills, trust the Kelly/sizing system - it's been validated
  const preFillCap  = (state.closedTrades||[]).length < 30 ? 3 : 99;
  // 3B: Apply score-proportional multiplier to debit spread sizing
  const scoreMultiplier = scoreSizeMult(score);
  const ivDebitMult = 1.0; // debit spreads don't benefit from high IV (they pay it)
  const contracts   = Math.max(1, Math.min(cashCap, preFillCap, Math.floor(baseContracts * riskMult * agentSizeMult * scoreMultiplier)));
  if (scoreMultiplier > 1.0) logEvent("scan", `[SIZING] ${stock?.ticker||''} debit spread: ${scoreMultiplier}x score mult (score ${score})`);

  const actualSpreadWidth = Math.abs(buyContract.strike - sellContract.strike);
  const maxProfit = parseFloat((actualSpreadWidth - netDebit).toFixed(2));
  const maxLoss   = netDebit;
  const finalCost = parseFloat((netDebit * 100 * contracts).toFixed(2));

  if (finalCost > state.cash * posCapPct) {
    logEvent("filter", `${stock.ticker} spread cost $${finalCost} exceeds ${(posCapPct*100).toFixed(0)}% position limit`);
    return null;
  }
  if (state.cash - finalCost < CAPITAL_FLOOR) {
    logEvent("filter", `${stock.ticker} spread would breach capital floor`);
    return null;
  }
  // Gate on Alpaca's actual options buying power - prevents rejected orders
  // options_buying_power is separate from cash - naked puts reserve margin
  const optBP = state.alpacaOptBP || state.alpacaBuyPower || state.cash;
  if (finalCost > optBP) {
    logEvent("filter", `${stock.ticker} spread cost $${finalCost} exceeds Alpaca options buying power $${optBP.toFixed(2)} - skip`);
    return null;
  }

  let buyOrderId  = null;
  let sellOrderId = null;

  // - DRY RUN - log what would happen, don't submit orders -
  if (dryRunMode) {
    logEvent("dryrun", `WOULD BUY SPREAD ${stock.ticker} $${buyContract.strike}/${sellContract.strike} ${optionType.toUpperCase()} exp ${buyContract.expDate} | net debit $${netDebit} | max profit $${maxProfit} | max loss $${maxLoss} | cost $${finalCost} | score ${score}`);
    return null;
  }

  if (buyContract.symbol && sellContract.symbol && !dryRunMode) {
    try {
      // - MULTI-LEG ORDER - both legs submit and fill atomically -
      // Uses Alpaca mleg order class - no partial fill risk, no sequential timing
      // limit_price = net debit (positive = we pay, negative = we receive)
      // Use mid price for better fills than ask/bid separately
      const buyMid  = buyContract.bid > 0 && buyContract.ask > 0
        ? parseFloat(((buyContract.bid + buyContract.ask) / 2).toFixed(2))
        : parseFloat(buyContract.ask.toFixed(2));
      const sellMid = sellContract.bid > 0 && sellContract.ask > 0
        ? parseFloat(((sellContract.bid + sellContract.ask) / 2).toFixed(2))
        : parseFloat(sellContract.bid.toFixed(2));
      const netDebitLimit = parseFloat((buyMid - sellMid).toFixed(2));

      // C2: Idempotency key -- prevents duplicate fills on network timeout
      const _clientOrderId = `argo-ds-${stock.ticker}-${optionType}-${Math.floor(Date.now()/10000)}`;
      const mlegBody = {
        order_class:    "mleg",
        type:           "limit",
        time_in_force:  "day",
        qty:            String(contracts),
        limit_price:    String(netDebitLimit), // positive = debit
        client_order_id: _clientOrderId,
        legs: [
          { symbol: buyContract.symbol,  side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"  },
          { symbol: sellContract.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
        ],
      };

      // C1: Record pending order BEFORE Alpaca submission (crash safety)
      state._pendingOrder = {
        orderId:      _clientOrderId,
        ticker:       stock.ticker,
        optionType,
        buySymbol:    buyContract.symbol,
        sellSymbol:   sellContract.symbol,
        buyStrike:    buyContract.strike,
        sellStrike:   sellContract.strike,
        netDebit,
        netDebitLimit,
        finalCost,
        contracts,
        score,
        scoreReasons,
        expDate:      buyContract.expDate,
        expDays:      buyContract.expDays,
        submittedAt:  Date.now(),
        isSpread:     true,
        isChoppyEntry,
        mlegBody,
        _preSubmit:   true,
      };
      markDirty();

      logEvent("trade", `[SPREAD] Submitting mleg order: buy $${buyContract.strike} / sell $${sellContract.strike} | ${contracts}x | net debit $${netDebitLimit} | id: ${_clientOrderId}`);
      const mlegResp = await alpacaPost("/orders", mlegBody);

      if (!mlegResp || mlegResp.code || !mlegResp.id) {
        logEvent("warn", `[SPREAD] mleg order failed: ${JSON.stringify(mlegResp)?.slice(0,200)}`);
        return null;
      }

      buyOrderId  = mlegResp.id;
      sellOrderId = mlegResp.id;
      // Replace pre-submit client_order_id with real Alpaca order ID
      state._pendingOrder.orderId    = mlegResp.id;
      state._pendingOrder._preSubmit = false;
      markDirty();
      logEvent("trade", `[SPREAD] mleg order submitted: ${mlegResp.id} | status: ${mlegResp.status}`);
      logEvent("trade", `[SPREAD] Order pending - will confirm fill on next scan`);
      return { pending: true };
    } catch(e) {
      logEvent("error", `[SPREAD] mleg order error: ${e.message}`);
      state._pendingOrder = null;
      return null;
    }
  }
  return null;
}

// - Confirm pending mleg order - runs at start of every scan -
// Checks if a previously submitted mleg order has filled, cancelled, or expired
// Handles retry with wider limit if unfilled after 30s
// This decouples fill confirmation from order submission - no scan blocking
async function confirmPendingOrder() {
  const pending = state._pendingOrder;
  if (!pending || !pending.orderId) return;

  const age = (Date.now() - pending.submittedAt) / 1000;
  try {
    const fillResp = await alpacaGet(`/orders/${pending.orderId}`);
    if (!fillResp) return;

    if (fillResp.status === "filled") {
      // Order filled - verify legs before recording to catch double-fill anomalies
      const typeLabel = pending.isCreditSpread ? "CREDIT SPREAD" : "SPREAD";
      // Sanity check: if mleg, verify filled legs don't show unexpected qty
      if (fillResp.legs && fillResp.legs.length > 0) {
        for (const leg of fillResp.legs) {
          const legQty = Math.abs(parseFloat(leg.filled_qty || leg.qty || pending.contracts));
          if (legQty > pending.contracts * 2) {
            logEvent("warn", `[${typeLabel}] ANOMALY: leg ${leg.symbol} filled qty ${legQty} > expected ${pending.contracts} - possible double-fill, recording position but flagging`);
            logEvent("warn", `[SPREAD ANOMALY] Check Alpaca manually - ${pending.ticker} may have duplicate legs`);
          }
        }
      }
      logEvent("trade", `[${typeLabel}] Fill confirmed: ${pending.orderId} | age: ${age.toFixed(0)}s`);

      if (pending.isCreditSpread) {
        // Credit spread: cash increases by net credit received
        const netCredit = pending.netCredit || pending.netDebit;
        const marginRequired = pending.finalCost;
        state.cash += parseFloat((netCredit * 100 * pending.contracts).toFixed(2));
        const maxProfit = parseFloat((netCredit * 100 * pending.contracts).toFixed(2));
        const maxLoss   = parseFloat(((Math.abs(pending.buyStrike - pending.sellStrike) - netCredit) * 100 * pending.contracts).toFixed(2));
        const position = {
          ticker: pending.ticker, optionType: pending.optionType,
          sector: (WATCHLIST.find(w => w.ticker === pending.ticker) || {}).sector || "Unknown",
          isSpread: true, isCreditSpread: true,
          shortStrike: pending.sellStrike, longStrike: pending.buyStrike,
          buyStrike: pending.buyStrike, sellStrike: pending.sellStrike,
          spreadWidth: Math.abs(pending.buyStrike - pending.sellStrike),
          buySymbol: pending.buySymbol, sellSymbol: pending.sellSymbol,
          contractSymbol: pending.sellSymbol,
          premium: netCredit, maxProfit, maxLoss, contracts: pending.contracts,
          expDate: pending.expDate, expDays: pending.expDays,
          cost: marginRequired, score: pending.score,
          reasons: pending.scoreReasons,
          openDate: new Date().toISOString(),
          currentPrice: netCredit, peakPremium: netCredit,
          // Credit put spread breakeven: short strike - net credit received
          breakeven: pending.optionType === "put"
            ? parseFloat((pending.sellStrike - netCredit).toFixed(2))
            : parseFloat((pending.sellStrike + netCredit).toFixed(2)),
          entryRSI: 50, entryMACD: "neutral", entryMomentum: "steady",
          entryMacro: (state._agentMacro || {}).signal || "neutral",
          entryThesisScore: pending.score || 100, thesisHistory: [], agentHistory: [],
          realData: true, vix: state.vix, entryVIX: state.vix,
          expiryType: "monthly", dteLabel: "CREDIT-SPREAD-MONTHLY",
          partialClosed: false, isMeanReversion: false, trailStop: null,
          breakevenLocked: false, halfPosition: false,
          // Panel unanimous (8/8): credit spread stop at 50% of max loss OR 2x credit
          // Use MIN to take whichever is stricter
          // Stop expressed as fraction of credit received for consistency with chg calculation
          // chg = -(currentValue - credit) / credit, stop when chg <= -stopFraction
          // 50% max loss: stopFraction = 0.50 * maxLoss / netCredit
          // 2x credit:    stopFraction = 1.0 (spread value = 2x credit)
          // Take minimum (stricter)
          takeProfitPct: 0.50, fastStopPct: Math.min(1.0, parseFloat((0.50 * maxLoss / netCredit).toFixed(3))),
          _originalEntryScore: pending.score || 100, // baseline for dynamic TP scaling
          _creditHarvestExpiry: new Date(Date.now() + 7 * MS_PER_DAY).toISOString(),
        };
        state.positions.push(position);
        state._pendingOrder = null;
        logEvent("trade", `[CREDIT SPREAD] ENTERED ${pending.ticker} $${pending.sellStrike}/$${pending.buyStrike} exp ${pending.expDate} | credit $${netCredit} | margin $${marginRequired}`);
        await syncCashFromAlpaca();
        await saveStateNow();
        return;
      }

      let netDebit   = pending.netDebit;
      let finalCost  = pending.finalCost;
      if (fillResp.filled_avg_price) {
        const actual = parseFloat(fillResp.filled_avg_price);
        if (actual > 0 && actual !== netDebit) {
          const slippage = parseFloat((actual - netDebit).toFixed(2));
          logEvent("trade", `[SPREAD] Fill: limit $${netDebit} - actual $${actual} | slippage ${slippage >= 0 ? '+' : ''}$${slippage}`);
          // Track fill quality for live deployment validation
          if (!state._fillQuality) state._fillQuality = { count: 0, totalSlippage: 0, misses: 0 };
          state._fillQuality.count++;
          state._fillQuality.totalSlippage = parseFloat((state._fillQuality.totalSlippage + slippage).toFixed(2));
          if (slippage > 0.05) state._fillQuality.misses++;
          state._fillQuality.avgSlippage = parseFloat((state._fillQuality.totalSlippage / state._fillQuality.count).toFixed(3));
          netDebit  = actual;
          finalCost = parseFloat((netDebit * 100 * pending.contracts).toFixed(2));
        } else {
          // Perfect fill at limit price - track this too
          if (!state._fillQuality) state._fillQuality = { count: 0, totalSlippage: 0, misses: 0 };
          state._fillQuality.count++;
          state._fillQuality.avgSlippage = parseFloat((state._fillQuality.totalSlippage / state._fillQuality.count).toFixed(3));
        }
      }

      const { contracts, score, scoreReasons, expDate, expDays,
              buyStrike, sellStrike, buySymbol, sellSymbol, optionType,
              isChoppyEntry, isSpread } = pending;
      const maxProfit = parseFloat(((Math.abs(buyStrike - sellStrike) - netDebit) * 100 * contracts).toFixed(2));
      const maxLoss   = parseFloat((netDebit * 100 * contracts).toFixed(2));

      state.cash -= finalCost;
      const position = {
        ticker:        pending.ticker, optionType, isSpread: true,
        sector:        (WATCHLIST.find(w => w.ticker === pending.ticker) || {}).sector || "Unknown",
        buyStrike, sellStrike,
        spreadWidth:   Math.abs(buyStrike - sellStrike),
        buySymbol, sellSymbol,
        contractSymbol: buySymbol,
        premium:       netDebit, maxProfit, maxLoss, contracts,
        expDate, expDays, cost: finalCost, score,
        reasons:       scoreReasons,
        openDate:      new Date().toISOString(),
        currentPrice:  netDebit, peakPremium: netDebit,
        entryRSI:      50, entryMACD: "neutral", entryMomentum: "steady",
        entryMacro:    (state._agentMacro || {}).signal || "neutral",
        entryThesisScore: score || 100, thesisHistory: [], agentHistory: [],
        realData:      true, vix: state.vix, entryVIX: state.vix,
        expiryType:    "monthly", dteLabel: "SPREAD-MONTHLY",
        partialClosed: false, isMeanReversion: false, trailStop: null,
        breakevenLocked: false, halfPosition: false,
        target:        parseFloat((netDebit * 1.50).toFixed(2)),
        stop:          parseFloat((netDebit * (isChoppyEntry ? 0.20 : 0.50)).toFixed(2)),
        takeProfitPct: 0.50, fastStopPct: isChoppyEntry ? 0.20 : 0.50,
        _originalEntryScore: score || 100, // baseline for dynamic TP scaling
        breakeven:     optionType === "put"
          ? parseFloat((buyStrike - netDebit).toFixed(2))
          : parseFloat((buyStrike + netDebit).toFixed(2)),
      };

      state.positions.push(position);
      state._pendingOrder = null;

      // - Paper slippage estimate (panel fix #10) -
      // In paper trading, fills execute at mid-price. In live trading, 2-leg
      // spreads typically fill $0.05-0.15/leg above mid on buy, below on sell.
      // Accumulate an estimate so live deployment can calibrate expectations.
      // Estimate: $0.08/leg - 2 legs = $0.16/contract - contracts
      const _paperSlipEst = parseFloat((0.16 * (pending.contracts || 1)).toFixed(2));
      if (!state._paperSlippage) state._paperSlippage = { trades: 0, totalEst: 0 };
      state._paperSlippage.trades++;
      state._paperSlippage.totalEst = parseFloat((state._paperSlippage.totalEst + _paperSlipEst).toFixed(2));
      state._paperSlippage.avgEst   = parseFloat((state._paperSlippage.totalEst / state._paperSlippage.trades).toFixed(2));
      logEvent("trade", `[SLIPPAGE EST] $${_paperSlipEst} this trade | $${state._paperSlippage.totalEst} cumulative across ${state._paperSlippage.trades} trades (paper mid-fill assumption)`);
      logEvent("trade", `Live fill count: ${(state.closedTrades||[]).length + state.positions.length}/30`);

      state.tradeJournal.unshift({
        time: new Date().toISOString(), ticker: pending.ticker,
        action: "OPEN", optionType, isSpread: true, isCreditSpread: true,
        strike: pending.sellStrike, expDate,
        buyStrike: pending.buyStrike, sellStrike: pending.sellStrike,
        spreadLabel: `$${pending.buyStrike}/$${pending.sellStrike}`,
        premium: netCredit, cost: marginRequired, score,
        contracts: pending.contracts,
        scoreReasons: pending.scoreReasons || [],
        delta: null, iv: null, vix: state.vix,
        reasoning: `[CREDIT SPREAD] Score ${score}/100. Net credit $${netCredit}. Max profit $${maxProfit}. Max loss $${maxLoss}.`,
      });
      if (state.tradeJournal.length > 100) state.tradeJournal = state.tradeJournal.slice(0, 100);

      await syncCashFromAlpaca();
      await saveStateNow();

    } else if (["canceled","expired","rejected","done_for_day"].includes(fillResp.status)) {
      logEvent("warn", `[SPREAD] Order ${fillResp.status} after ${age.toFixed(0)}s - clearing pending`);
      state._pendingOrder = null;
      markDirty();

    } else if (age > 30 && !pending._retried) {
      // Unfilled after 30s - retry with spread-aware concession
      // Scale concession to bid-ask spread: narrow spread = small concession, wide = larger
      // Market maker fix: $0.05 static is too small in VIX 35+ wide markets
      await alpacaPost(`/orders/${pending.orderId}/cancel`, {}).catch(() => {});
      const spreadPct     = pending.spreadPct || 0.05; // bid-ask spread % at entry time
      const rawConcession = Math.max(0.05, Math.min(0.20, parseFloat((pending.netDebitLimit * spreadPct * 0.5).toFixed(2))));
      const retryLimit    = parseFloat((pending.netDebitLimit + rawConcession).toFixed(2));
      logEvent("warn", `[SPREAD] Unfilled after ${age.toFixed(0)}s - retrying with $${rawConcession.toFixed(2)} concession (spread ${(spreadPct*100).toFixed(0)}%) @ $${retryLimit}`);
      const retryBody  = { ...pending.mlegBody, limit_price: String(retryLimit) };
      const retryResp  = await alpacaPost("/orders", retryBody).catch(() => null);
      if (retryResp && retryResp.id) {
        state._pendingOrder = { ...pending, orderId: retryResp.id, submittedAt: Date.now(), _retried: true, netDebitLimit: retryLimit };
        logEvent("trade", `[SPREAD] Retry submitted: ${retryResp.id} @ $${retryLimit}`);
        markDirty();
      } else {
        logEvent("warn", `[SPREAD] Retry failed - clearing pending`);
        state._pendingOrder = null;
        markDirty();
      }

    } else if (pending._retried && age > 60) {
      // Retry also unfilled after 60s total - cancel and give up
      await alpacaPost(`/orders/${pending.orderId}/cancel`, {}).catch(() => {});
      logEvent("warn", `[SPREAD] Retry also unfilled - spread cancelled`);
      state._pendingOrder = null;
      markDirty();
    }
    // else: still pending within timeout - check again next scan
  } catch(e) {
    logEvent("error", `[SPREAD] confirmPendingOrder error: ${e.message}`);
  }
}

async function executeTrade(stock, price, score, scoreReasons, vix, optionType = "call", isMeanReversion = false, sizeMod = 1.0) {
  // Quick cash pre-check before expensive API calls
  // Use conservative estimate: assume at least $200 premium * 1 contract = $200 min cost
  const estimatedMinCost = price * 0.03 * 100; // ~3% OTM premium estimate * 100
  if (state.cash - estimatedMinCost < CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash pre-check (est. min cost ${fmt(estimatedMinCost)})`);
    return false;
  }

  // Use cached contract from parallel prefetch if available, else fetch now
  let contract = stock._cachedContract || await findContract(stock.ticker, optionType, isMeanReversion ? 0.40 : 0.35, isMeanReversion ? 21 : 28, vix, stock);
  delete stock._cachedContract; // clean up cache after use

  // Fallback to estimated contract if real data unavailable
  // NOTE: If the chain exists but no liquid contracts found, estimation is unreliable
  // Only estimate if we got no chain data at all (API failure)
  if (!contract) {
    logEvent("warn", `- ${stock.ticker} - NO REAL OPTIONS DATA - using Black-Scholes estimate. Check Alpaca Pro subscription.`);
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.estimatedTrades++;
    state.dataQuality.totalTrades++;
    const iv       = 0.25 + stock.ivr * 0.003;
    // Simple fallback DTE: 28 days for directional, 21 for MR
    const expDays = isMeanReversion ? 21 : 28;
    const _expDate = new Date(Date.now() + expDays * 86400000);
    const expDate = _expDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
    const expiryType = 'weekly';
    const otmPct   = stock.momentum === "strong" ? 0.035 : 0.045;
    const strike   = optionType === "put"
      ? Math.round(price * (1 - otmPct) / 5) * 5
      : Math.round(price * (1 + otmPct) / 5) * 5;
    const t        = expDays / 365;
    const premium  = parseFloat((price * iv * Math.sqrt(t) * 0.4 + 0.3).toFixed(2));
    const greeks   = calcGreeks(price, strike, expDays, iv, optionType);
    contract = { symbol: null, strike, expDate, expDays, expiryType,
      premium, bid: premium * 0.95, ask: premium * 1.05,
      greeks, iv, oi: 0, vol: 0, optionType };
  } else {
    // Real data - track totalTrades for stats only
    // realTrades is incremented AFTER a confirmed live fill (see below)
    // Never increment in dry run - would bypass the 1-contract cap
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.totalTrades++;
  }

  // Position sizing based on real premium
  // Unified Kelly-primary sizing - single call, all adjustments inside
  let contracts = calcPositionSize(contract.premium, score, vix);
  // V2.84: apply Regime B oversold sizing modifier (0.75x when RSI <=40 in bear trend)
  if (sizeMod < 1.0) {
    contracts = Math.max(1, Math.floor(contracts * sizeMod));
    logEvent("scan", `[SIZING] ${stock.ticker} sizeMod ${sizeMod}x applied - ${contracts} contracts (oversold bear trend)`);
  }
  if (contracts < 1) {
    logEvent("skip", `${stock.ticker} - position size too small`);
    return false;
  }

  const cost      = parseFloat((contract.premium * 100 * contracts).toFixed(2));
  const target    = parseFloat((contract.premium * (1 + TAKE_PROFIT_PCT)).toFixed(2));
  const stop      = parseFloat((contract.premium * (1 - STOP_LOSS_PCT)).toFixed(2));
  const breakeven = optionType === "put"
    ? parseFloat((contract.strike - contract.premium).toFixed(2))
    : parseFloat((contract.strike + contract.premium).toFixed(2));

  // Ensure liquid cash

  if (cost > state.cash - CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash after floor (need ${fmt(cost)})`);
    return false;
  }

  // Delta check - already filtered in getRealOptionsContract but double check estimate fallback
  const delta = parseFloat(contract.greeks.delta || 0);
  if (Math.abs(delta) < TARGET_DELTA_MIN || Math.abs(delta) > TARGET_DELTA_MAX) {
    logEvent("filter", `${stock.ticker} - delta ${delta} outside target range`);
    return false;
  }

  // Submit order to Alpaca - fill confirmation happens inside
  // Only submit if we have a real contract symbol (not an estimate)
  let alpacaOrderId = null;
  if (contract.symbol && contract.ask > 0 && !dryRunMode) {
    try {
      const limitPrice = parseFloat(contract.ask.toFixed(2)); // number not string
      const orderBody = {
        symbol:        contract.symbol,
        qty:           contracts,              // number not string
        side:          "buy",
        type:          "limit",
        time_in_force: "day",
        limit_price:   limitPrice,
      };
      const orderResp = await alpacaPost("/orders", orderBody);
      if (orderResp && orderResp.id) {
        alpacaOrderId = orderResp.id;
        logEvent("trade", `Alpaca order submitted: ${orderResp.id} | ${contract.symbol} | ${contracts}x @ $${limitPrice}`);

        // - FILL CONFIRMATION - poll for up to 10 seconds -
        // Limit orders are not guaranteed to fill immediately
        // If unfilled after 10s, cancel and skip - don't update state on unfilled orders
        let fillConfirmed  = false;
        let fillPrice      = null;
        const pollStart    = Date.now();
        const FILL_TIMEOUT = 10000; // 10 seconds
        const POLL_INTERVAL= 1000;  // check every 1 second

        // Check if immediately filled
        if (orderResp.status === "filled" && orderResp.filled_avg_price) {
          fillConfirmed = true;
          fillPrice = parseFloat(parseFloat(orderResp.filled_avg_price).toFixed(2));
          logEvent("trade", `Order ${alpacaOrderId} filled immediately @ $${fillPrice}`);
        } else {
          // Poll for fill
          while (!fillConfirmed && Date.now() - pollStart < FILL_TIMEOUT) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            try {
              const pollResp = await alpacaGet(`/orders/${alpacaOrderId}`);
              if (pollResp && pollResp.status === "filled" && pollResp.filled_avg_price) {
                fillConfirmed = true;
                fillPrice = parseFloat(parseFloat(pollResp.filled_avg_price).toFixed(2));
                logEvent("trade", `Order ${alpacaOrderId} fill confirmed @ $${fillPrice} (${((Date.now()-pollStart)/1000).toFixed(1)}s)`);
              } else if (pollResp && ["canceled","expired","rejected"].includes(pollResp.status)) {
                logEvent("warn", `Order ${alpacaOrderId} ${pollResp.status} - not filled`);
                break;
              }
            } catch(e) { logEvent("warn", `Fill poll error: ${e.message}`); break; }
          }
        }

        if (!fillConfirmed) {
          // Cancel unfilled order and abort trade
          try { await alpacaDelete(`/orders/${alpacaOrderId}`); } catch(e) {}
          logEvent("warn", `Order ${alpacaOrderId} not filled in ${FILL_TIMEOUT/1000}s - cancelled, skipping trade`);
          alpacaOrderId = null; // signal to caller to abort
        } else if (fillPrice) {
          contract.premium = fillPrice; // use actual fill price not limit price
          // Confirmed live fill - now count as a real trade for Kelly calibration
          if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
          state.dataQuality.realTrades++;
          logEvent("trade", `Live fill confirmed - real trade count: ${state.dataQuality.realTrades}/30 before Kelly activates`);
        }
      } else {
        logEvent("warn", `Alpaca order failed for ${contract.symbol}: ${JSON.stringify(orderResp)?.slice(0, 150)}`);
      }
    } catch(e) {
      logEvent("error", `Alpaca order submission error: ${e.message}`);
    }
  }

  // Abort if order was not confirmed filled - don't update state on unfilled orders
  if (contract.symbol && !dryRunMode && alpacaOrderId === null && contract.symbol) {
    logEvent("skip", `${stock.ticker} - trade aborted, order not filled`);
    return false;
  }

  // Recalculate cost/target/stop using final premium (may have been updated by fill)
  const finalCost     = parseFloat((contract.premium * 100 * contracts).toFixed(2));
  // Use DTE-tiered exit params - short-dated options need faster exits
  const exitParams    = getDTEExitParams(contract.expDays || 30, 0); // 0 days open - fresh entry
  const finalTarget   = parseFloat((contract.premium * (1 + exitParams.takeProfitPct)).toFixed(2));
  const finalStop     = parseFloat((contract.premium * (1 - exitParams.stopLossPct)).toFixed(2));
  const finalBreakeven = optionType === "put"
    ? parseFloat((contract.strike - contract.premium).toFixed(2))
    : parseFloat((contract.strike + contract.premium).toFixed(2));

  // Re-check cash with final cost (fill might be slightly different from ask)
  if (finalCost > state.cash - CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash after fill price adjustment`);
    // Cancel the Alpaca order if we submitted one
    if (alpacaOrderId) {
      try {
        await alpacaDelete(`/orders/${alpacaOrderId}`);
        logEvent("trade", `Alpaca order ${alpacaOrderId} cancelled - insufficient cash`);
      } catch(e) { logEvent("error", `Failed to cancel order ${alpacaOrderId}: ${e.message}`); }
    }
    return false;
  }

  // In dry run - log what would happen but don't mutate state
  if (dryRunMode) {
    logEvent("dryrun", `WOULD BUY ${stock.ticker} ${optionType.toUpperCase()} $${contract.strike} | ${contracts}x @ $${contract.premium} | cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta}`);
    return true;
  }

  // Final heat check - projected heat AFTER this position is added
  // This catches the scan-level blindness where multiple positions queue before any are entered
  const projectedHeat = (openRisk() + finalCost) / totalCap();
  if (projectedHeat > effectiveHeatCap()) {
    logEvent("filter", `${stock.ticker} - projected heat ${(projectedHeat*100).toFixed(0)}% would exceed ${MAX_HEAT*100}% max - skipping`);
    if (alpacaOrderId) {
      try { await alpacaDelete(`/orders/${alpacaOrderId}`); } catch(e) {}
    }
    return false;
  }

  state.cash = parseFloat((state.cash - finalCost).toFixed(2));
  state.todayTrades++;

  const position = {
    ticker:         stock.ticker,
    sector:         stock.sector,
    assetClass:     ["GLD","SLV","USO","TLT","GDX"].includes(stock.ticker) ? "commodity" : "equity",
    strike:         contract.strike,
    premium:        contract.premium,
    contracts,
    expDate:        contract.expDate,
    expiryDays:     contract.expDays,
    target:         finalTarget,
    stop:           finalStop,
    breakeven:      finalBreakeven,
    cost:           finalCost,
    takeProfitPct:  exitParams.takeProfitPct,
    trailActivate:  exitParams.trailActivate,
    trailStop:      exitParams.trailStop,
    fastStopPct:    exitParams.fastStopPct,
    dteLabel:       exitParams.label,
    isMeanReversion: isMeanReversion,
    entryVIX:       vix,
    partialClosed:  false,
    openDate:       new Date().toISOString(),
    ivr:            stock.ivr,
    iv:             contract.iv,
    greeks:         contract.greeks,
    beta:           stock.beta || 1,
    peakPremium:    contract.premium,
    trailStop:      null,
    breakevenLocked: false,
    score,
    halfPosition:   false,
    price,
    optionType,
    expiryType:      contract.expiryType,
    currentPrice:    contract.premium,
    contractSymbol:  contract.symbol,
    alpacaOrderId:   alpacaOrderId,
    bid:             contract.bid,
    ask:             contract.ask,
    realData:        !!contract.symbol,
    entryRSI:        stock.rsi || 52,        // capture entry signal for decay detection
    entryMomentum:   stock.momentum || "steady",
    entryMACD:       stock.macd || "neutral",
    entryMacro:      (state._agentMacro || {}).signal || "neutral",
    entryRelStr:     stock._relStrength || 1.0,
    entryADX:        stock._adx || 0,
    entryThesisScore: 100, // starts at 100, degrades over time
    thesisHistory:   [], // [{time, score, notes}] - tracks degradation
    agentHistory:    [], // last 5 rescore results
  };

  state.positions.push(position);

  // - Paper slippage estimate -
  const _singleSlipEst = parseFloat((0.08 * (contract.contracts || 1)).toFixed(2));
  if (!state._paperSlippage) state._paperSlippage = { trades: 0, totalEst: 0 };
  state._paperSlippage.trades++;
  state._paperSlippage.totalEst = parseFloat((state._paperSlippage.totalEst + _singleSlipEst).toFixed(2));
  state._paperSlippage.avgEst   = parseFloat((state._paperSlippage.totalEst / state._paperSlippage.trades).toFixed(2));
  logEvent("trade", `[SLIPPAGE EST] $${_singleSlipEst} this trade | $${state._paperSlippage.totalEst} cumulative across ${state._paperSlippage.trades} trades (paper mid-fill assumption)`);
  const isEarningsPlay = scoreReasons.some(r => r.includes("Earnings play"));
  if (isEarningsPlay) position.earningsPlay = true;

  state.tradeJournal.unshift({
    time:          new Date().toISOString(),
    ticker:        stock.ticker,
    action:        "OPEN",
    optionType,
    strike:        contract.strike,
    expDate:       contract.expDate,
    premium:       contract.premium,
    contracts,
    cost:          finalCost,
    score,
    scoreReasons:  scoreReasons, // F13: full list for dashboard transparency
    delta:         contract.greeks.delta,
    iv:            parseFloat(((contract.iv||0.3)*100).toFixed(1)),
    vix,
    washSaleFlag:  stock._washSaleWarning || false,
    scoreReasons,  // F13: full signal breakdown
    reasoning:     `Score ${score}/100. ${scoreReasons.slice(0,3).join(". ")}.${stock._washSaleWarning ? " - WASH SALE WARNING." : ""}`,
  });
  if (state.tradeJournal.length > 100) state.tradeJournal = state.tradeJournal.slice(0,100);

  const typeLabel = optionType === "put" ? "P" : "C";
  const dataLabel = contract.symbol ? "REAL" : "EST";

  // - LIQUIDITY HARD GATES -
  // OI < MIN_OI (5) = essentially no market - unfillable in live trading
  if (!dryRunMode && contract.oi > 0 && contract.oi < MIN_OI) {
    logEvent("filter", `${stock.ticker} BLOCKED - OI:${contract.oi} below minimum ${MIN_OI} - unfillable in live trading`);
    return false;
  }
  // Spread > MAX_SPREAD_PCT (30%) = slippage destroys the trade
  if (!dryRunMode && contract.spread > MAX_SPREAD_PCT) {
    const slippageEst = parseFloat((contract.premium * contract.spread * 0.5 * 100 * contracts).toFixed(2));
    logEvent("filter", `${stock.ticker} BLOCKED - spread ${(contract.spread*100).toFixed(0)}% exceeds ${(MAX_SPREAD_PCT*100).toFixed(0)}% max - est. slippage $${slippageEst}`);
    return false;
  }
  // Warn on borderline OI (5-50) and spread (15-30%) - don't block but flag
  if (contract.oi > 0 && contract.oi < 50) {
    logEvent("warn", `- ${stock.ticker} LOW OI: ${contract.oi} - fill may be slow`);
  } else if (contract.oi === 0) {
    logEvent("warn", `- ${stock.ticker} OI UNKNOWN - treat as potentially illiquid`);
  }
  if (contract.spread > 0.15) {
    const slippageEst = parseFloat((contract.premium * contract.spread * 0.5 * 100 * contracts).toFixed(2));
    logEvent("warn", `- ${stock.ticker} WIDE SPREAD: ${(contract.spread*100).toFixed(0)}% - est. slippage $${slippageEst}`);
  }

  await saveStateNow(); // critical - persist trade immediately
  logEvent("trade",
    `BUY ${stock.ticker} $${contract.strike}${typeLabel} exp ${contract.expDate} | ${contracts}x @ $${contract.premium} | ` +
    `cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta} | ${isMeanReversion ? "MEAN-REV" : exitParams.label} | [${dataLabel}] | ` +
    `OI:${contract.oi} spread:${(contract.spread*100).toFixed(1)}% | cash ${fmt(state.cash)} | heat ${(heatPct()*100).toFixed(0)}%`
  );
  return true;
}

// - Thesis Integrity Calculator -
// Compares current stock conditions to entry conditions
// Returns { score: 0-100, reasons: [], recommendation: "HOLD"|"WATCH"|"EXIT" }
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

// - Time-decay adjusted stop loss -
// As a position ages, the loss tolerance tightens
// Flat positions especially - theta is working against you
function getTimeAdjustedStop(pos) {
  const daysOpen   = (Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY;
  const chgPct     = pos.currentPrice && pos.premium
    ? (pos.currentPrice - pos.premium) / pos.premium : 0;
  const isFlat     = Math.abs(chgPct) < 0.05; // within 5% of entry

  // Base stop loss
  let stopPct = STOP_LOSS_PCT; // -35%

  // Tighten progressively for aging positions
  if (daysOpen >= 8)      stopPct = 0.15; // -15% - very old, exit faster
  else if (daysOpen >= 6) stopPct = 0.20; // -20%
  else if (daysOpen >= 4) stopPct = 0.25; // -25%
  else if (daysOpen >= 2) stopPct = 0.30; // -30%

  // Extra tightening for flat old positions - theta is killing them
  if (isFlat && daysOpen >= 4) stopPct = Math.min(stopPct, 0.20);
  if (isFlat && daysOpen >= 6) stopPct = Math.min(stopPct, 0.12);

  return stopPct;
}

// - Close Position -
async function closePosition(ticker, reason, exitPremium = null, contractSym = null) {
  try {
    // If contractSym provided, find exact position - handles multiple same-ticker positions
    const idx = contractSym
      ? state.positions.findIndex(p => p.contractSymbol === contractSym || p.buySymbol === contractSym)
      : state.positions.findIndex(p => p.ticker === ticker);
    if (idx === -1) return;
    const pos  = state.positions[idx];

    // - Spread close - close both legs atomically via mleg -
    // CRITICAL: Must close both legs together - separate orders leave naked positions
    // if one fills and the other doesn't (or if code crashes between them)
    if (pos.isSpread && !dryRunMode) {
      try {
        if (pos.buySymbol && pos.sellSymbol) {
          // Use mleg to close both legs atomically
          const closeResp = await alpacaPost("/orders", {
            order_class:   "mleg",
            type:          "market",
            time_in_force: "day",
            qty:           String(pos.contracts || 1),
            legs: [
              { symbol: pos.buySymbol,  side: "sell", ratio_qty: "1", position_intent: "sell_to_close" },
              { symbol: pos.sellSymbol, side: "buy",  ratio_qty: "1", position_intent: "buy_to_close"  },
            ],
          });
          if (closeResp && closeResp.id) {
            logEvent("trade", `[SPREAD CLOSE] mleg close submitted: ${closeResp.id} | ${pos.buySymbol} + ${pos.sellSymbol}`);
            // Wait for fill confirmation (up to 10s - market orders fill fast)
            let filled = false;
            const closeStart = Date.now();
            while (!filled && Date.now() - closeStart < 10000) {
              await new Promise(r => setTimeout(r, 1000));
              const poll = await alpacaGet(`/orders/${closeResp.id}`);
              if (poll?.status === "filled") { filled = true; }
              else if (poll && ["canceled","expired","rejected"].includes(poll.status)) break;
            }
            if (filled) {
              logEvent("trade", `[SPREAD CLOSE] Both legs closed: ${pos.buySymbol} + ${pos.sellSymbol}`);
            } else {
              logEvent("warn", `[SPREAD CLOSE] mleg close unconfirmed - legs may still be open, check Alpaca`);
            }
          } else {
            // mleg failed - fall back to individual market orders
            logEvent("warn", `[SPREAD CLOSE] mleg failed, falling back to individual close orders`);
            if (pos.buySymbol) {
              await alpacaPost("/orders", { symbol: pos.buySymbol, qty: pos.contracts, side: "sell", type: "market", time_in_force: "day", position_intent: "sell_to_close" });
              logEvent("trade", `[SPREAD CLOSE] Buy leg closed: ${pos.buySymbol}`);
            }
            if (pos.sellSymbol) {
              await alpacaPost("/orders", { symbol: pos.sellSymbol, qty: pos.contracts, side: "buy", type: "market", time_in_force: "day", position_intent: "buy_to_close" });
              logEvent("trade", `[SPREAD CLOSE] Sell leg closed: ${pos.sellSymbol}`);
            }
          }
        } else {
          // Only one leg symbol - close whichever we have
          if (pos.buySymbol) {
            await alpacaPost("/orders", { symbol: pos.buySymbol, qty: pos.contracts, side: "sell", type: "market", time_in_force: "day", position_intent: "sell_to_close" });
            logEvent("trade", `[SPREAD CLOSE] Buy leg closed: ${pos.buySymbol}`);
          }
          if (pos.sellSymbol) {
            await alpacaPost("/orders", { symbol: pos.sellSymbol, qty: pos.contracts, side: "buy", type: "market", time_in_force: "day", position_intent: "buy_to_close" });
            logEvent("trade", `[SPREAD CLOSE] Sell leg closed: ${pos.sellSymbol}`);
          }
        }
      } catch(e) {
        logEvent("error", `[SPREAD CLOSE] Error closing legs: ${e.message}`);
      }
    }
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
    if (!pos.isSpread && pos.contractSymbol) {
      const realP = await getOptionsPrice(pos.contractSymbol);
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
  if (dryRunMode) {
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
  if (!pos.isSpread && pos.contractSymbol && closeQty > 0 && !dryRunMode && alpacaCloseAllowed) {
    // Safety: if this naked position still has a sell leg open (short position),
    // buy it back first to avoid leaving a naked short
    if (pos.sellSymbol && pos.sellSymbol !== pos.contractSymbol) {
      logEvent("warn", `${ticker} has sell leg ${pos.sellSymbol} - buying back to prevent naked short`);
      await alpacaPost("/orders", { symbol: pos.sellSymbol, qty: closeQty, side: "buy", type: "market", time_in_force: "day", position_intent: "buy_to_close" }).catch(e => logEvent("error", `${ticker} sell leg close: ${e.message}`));
    }
    try {
      // Use real bid if available, else use ep (mid) as limit
      // Real bid from position tracking is more reliable than derived estimate
      const bidPrice = parseFloat((pos.bid > 0 ? pos.bid : ep * 0.98).toFixed(2));
      const closeBody = {
        symbol:           pos.contractSymbol,
        qty:              closeQty,
        side:             "sell",
        type:             "limit",
        time_in_force:    "day",
        limit_price:      bidPrice,
        position_intent:  "sell_to_close",
      };
      const closeResp = await alpacaPost("/orders", closeBody);
      if (closeResp && closeResp.id) {
        logEvent("trade", `Alpaca close order: ${closeResp.id} | ${pos.contractSymbol} | ${closeQty}x | reason:${reason}`);
        // Use actual fill price if immediately available
        if (closeResp.filled_avg_price && parseFloat(closeResp.filled_avg_price) > 0) {
          ep = parseFloat(parseFloat(closeResp.filled_avg_price).toFixed(2));
        }
      } else {
        logEvent("warn", `Alpaca close order failed for ${pos.contractSymbol}: ${JSON.stringify(closeResp)?.slice(0,150)}`);
      }
    } catch(e) {
      logEvent("error", `Alpaca close order error: ${e.message}`);
    }
  }

  state.cash          = parseFloat((state.cash + ev + (bonus?BONUS_AMOUNT:0)).toFixed(2));
  state.extraBudget  += bonus ? BONUS_AMOUNT : 0;
  state.totalRevenue  = nr;
  state.monthlyProfit = parseFloat((state.monthlyProfit + pnl).toFixed(2));
  state.positions.splice(idx, 1);
  // PDT tracking - record if this is a day trade (opened and closed same day)
  if (isDayTrade(pos)) {
    recordDayTrade(pos, reason);
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
    if (consecLosses >= 5) {
      logEvent("warn", `[SPIRAL] ${consecLosses} consecutive ${posType} losses - consider pausing ${posType} entries to review thesis`);
      state._spiralActive = posType; // flag visible in /api/state
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
    state._recentLosses[ticker] = {
      closedAt:    Date.now(),
      reason,
      agentSignal: (state._agentMacro || {}).signal || "neutral",
      price:       ep,
      pnlPct:      parseFloat(pct),
    };
    logEvent("warn", `[THESIS] ${ticker} loss recorded - re-entry requires agent confirmation for 24h`);
  }

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
    logEvent("circuit", `DAILY MAX LOSS circuit - lost ${fmt(Math.abs(dailyPnL))} (${(dailyPnL/totalCap()*100).toFixed(1)}% of total capital)`);
  }
  // Weekly circuit - 25% of total capital using weeklyPnL
  if (weeklyPnL / totalCap() <= -WEEKLY_DD_LIMIT && state.weeklyCircuitOpen) {
    state.weeklyCircuitOpen = false;
    logEvent("circuit", `WEEKLY circuit breaker - loss ${fmt(Math.abs(weeklyPnL))} (${(WEEKLY_DD_LIMIT*100)}% limit)`);
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
    reasoning: `Closed ${reason}. Exit premium $${ep} vs entry $${pos.premium}. P&L: ${pnl>=0?"+":""}${fmt(pnl)} (${pct}%).`,
  });

  logEvent("close",
    `${reason.toUpperCase()} ${ticker} | exit $${ep} | P&L ${pnl>=0?"+":""}${fmt(pnl)} (${pct}%) | ` +
    `cash ${fmt(state.cash)}`
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

// - Partial Close -
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
    if (!dryRunMode && pos.buySymbol && pos.sellSymbol) {
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
    const realP = await getOptionsPrice(pos.contractSymbol);
    if (realP) ep = realP;
  }
  ep = parseFloat(ep.toFixed(2));
  const half = Math.max(1, Math.floor(pos.contracts / 2));

  // Submit partial close order to Alpaca
  if (pos.contractSymbol && half > 0 && !dryRunMode) {
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

  if (dryRunMode) {
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
  logEvent("partial", `PARTIAL ${ticker} - ${half}/${pos.contracts} @ $${ep} | +${fmt(pnl)} | cash ${fmt(state.cash)}`);
  await saveStateNow();
}

// - Stock Portfolio Management -
async function triggerRescore(pos, triggerReason) {
  if (!ANTHROPIC_API_KEY) return;
  const now = Date.now();
  if (!pos._triggerRescoreCooldown) pos._triggerRescoreCooldown = {};
  const lastFired = pos._triggerRescoreCooldown[triggerReason] || 0;
  if (now - lastFired < TRIGGER_COOLDOWN_MS) return; // cooldown active
  pos._triggerRescoreCooldown[triggerReason] = now;

  logEvent("warn", `[AGENT] Trigger rescore: ${pos.ticker} - ${triggerReason}`);
  try {
    const rescore = await getAgentRescore(pos);
    if (!rescore) return;
    pos._liveRescore = { ...rescore, updatedAt: new Date().toISOString(), trigger: triggerReason };
    logEvent("scan", `[AGENT] ${pos.ticker} trigger result: ${rescore.label} (${rescore.score}/95) - ${rescore.recommendation} | ${rescore.reasoning||''}`);

    // Auto-exit if enabled + EXIT + high confidence + position losing + not PDT protected
    const curP = pos.currentPrice || pos.premium;
    const chg  = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
    const posIsPDT = isDayTrade(pos);
    const posAlpacaBal = state.alpacaCash || state.cash || 0;
    const posPDTProtected = posAlpacaBal < 25000 && posIsPDT;
    if (state.agentAutoExitEnabled &&
        rescore.recommendation === "EXIT" &&
        rescore.confidence === "high" &&
        chg < 0 &&
        !posPDTProtected) {
      logEvent("warn", `[AGENT] TRIGGER AUTO-EXIT ${pos.ticker} - trigger: ${triggerReason} | ${rescore.reasoning}`);
      await closePosition(pos.ticker, "agent-exit");
    }
    markDirty();
  } catch(e) {
    console.log("[AGENT] Trigger rescore error:", e.message);
  }
}

// - Macro shift detector -
// Tracks previous macro signal - fires rescore on all positions when signal changes tier
let _prevMacroSignal = "neutral";
const MACRO_TIERS = {
  "strongly bearish": 0, "bearish": 1, "mild bearish": 2,
  "neutral": 3,
  "mild bullish": 4, "bullish": 5, "strongly bullish": 6,
};
// - Intraday Macro Regime Override -
// When intraday macro analysis shifts significantly, update operative regime
// This prevents the 6-hour lag where morning plan overrides intraday signals
function applyIntradayRegimeOverride(newMacro) {
  const dayPlanRegime  = (state._dayPlan || {}).regime    || "neutral";
  const intradaySignal = (newMacro || {}).signal           || "neutral";
  const intradayRegime = (newMacro || {}).regime           || "neutral";
  const confidence     = (newMacro || {}).confidence       || "low";

  // Only override if intraday signal is HIGH confidence AND meaningfully different
  const dayPlanBias = (state._dayPlan || {}).entryBias || "neutral";
  // Require BOTH regime AND bias to change for non-extreme shifts
  // Prevents spurious overrides when only confidence level changes
  const regimeChanged = dayPlanRegime !== intradayRegime;
  const biasChanged   = dayPlanBias   !== newMacro.entryBias;
  const strongShift   = confidence === "high" && (regimeChanged && biasChanged);
  const extremeShift = ["strongly bearish","strongly bullish"].includes(intradaySignal);

  // Check if previous override should expire (2-hour cooldown)
  const prevOverrideAt = state._dayPlan?._overrideAt;
  const overrideAge = prevOverrideAt ? (Date.now() - new Date(prevOverrideAt).getTime()) / 3600000 : 99;
  const overrideExpired = overrideAge >= 2.0; // expire override after 2 hours

  if ((strongShift || extremeShift) && overrideExpired) {
    state._dayPlan = {
      ...(state._dayPlan || {}),
      regime:    intradayRegime,
      entryBias: newMacro.entryBias || state._dayPlan?.entryBias || "neutral",
      tradeType: newMacro.tradeType || state._dayPlan?.tradeType || "spread",
      _intradayOverride: true,
      _overrideAt: new Date().toISOString(),
    };
    logEvent("macro", `[REGIME OVERRIDE] ${dayPlanRegime}-${intradayRegime} / ${dayPlanBias}-${newMacro.entryBias} (${confidence} confidence)`);
  } else if ((strongShift || extremeShift) && !overrideExpired) {
    logEvent("macro", `[REGIME OVERRIDE] Skipped - previous override still active (${overrideAge.toFixed(1)}h ago)`);
  }
}

function checkMacroShift(newSignal) {
  if (!newSignal || !ANTHROPIC_API_KEY) return;
  const prevTier = MACRO_TIERS[_prevMacroSignal] ?? 3;
  const newTier  = MACRO_TIERS[newSignal] ?? 3;
  const shift    = Math.abs(newTier - prevTier);
  if (shift >= 2) {
    // Significant macro shift - rescore all positions
    const direction = newTier < prevTier ? "bearish shift" : "bullish shift";
    logEvent("warn", `[MACRO] Signal shift: ${_prevMacroSignal} - ${newSignal} (${direction}) - triggering position rescores`);
    const positions = state.positions || [];
    // Fire in parallel - non-blocking
    Promise.allSettled(
      positions.map(pos => triggerRescore(pos, `macro-shift: ${_prevMacroSignal}-${newSignal}`))
    );
  }
  _prevMacroSignal = newSignal;
}

// - Parallel agent rescore - runs once per hour for overnight positions -
// Batches all overnight positions into parallel Claude calls
// Much faster than sequential (7 positions = ~5s parallel vs ~35s sequential)
async function runAgentRescore() {
  if (!ANTHROPIC_API_KEY || !isMarketHours()) return;
  const now         = Date.now();
  const currentHour = new Date().getHours();
  if (!state._agentRescoreHour)    state._agentRescoreHour    = {};
  if (!state._agentRescoreMinute)  state._agentRescoreMinute  = {};

  // Rescore ALL open positions - different cadence by age:
  // Same-day positions: every 30 minutes (more volatile, need more attention)
  // Overnight positions: every hour
  const SAME_DAY_INTERVAL   = 30 * 60 * 1000; // 30 minutes - reduces API cost significantly
  const OVERNIGHT_INTERVAL  = 60 * 60 * 1000; // 60 minutes - overnight positions change slowly

  const toRescore = (state.positions || []).filter(p => {
    const daysOpen  = (now - new Date(p.openDate).getTime()) / MS_PER_DAY;
    const isOvernight = daysOpen >= 1;
    const interval  = isOvernight ? OVERNIGHT_INTERVAL : SAME_DAY_INTERVAL;
    const lastRescore = isOvernight
      ? (state._agentRescoreHour[p.ticker] !== currentHour ? 0 : now) // hour-based for overnight
      : (state._agentRescoreMinute[p.ticker] || 0); // time-based for same-day
    if (isOvernight) return state._agentRescoreHour[p.ticker] !== currentHour;
    return (now - lastRescore) >= interval;
  });

  if (!toRescore.length) return;

  // Skip positions where P&L hasn't moved enough to warrant a rescore - saves tokens
  const needRescore = toRescore.filter(pos => {
    const lastChg = pos._lastRescoreChg ?? null;
    const curChg  = pos.premium > 0 ? (pos.currentPrice - pos.premium) / pos.premium : 0;
    if (lastChg !== null && Math.abs(curChg - lastChg) < 0.08 && pos._liveRescore) {
      logEvent("scan", `[AGENT] ${pos.ticker} rescore skipped - P&L stable at ${(curChg*100).toFixed(0)}%`);
      return false;
    }
    pos._lastRescoreChg = curChg;
    return true;
  });

  if (!needRescore.length) return;
  logEvent("scan", `[AGENT] Auto-rescore: ${needRescore.length} position(s)`);

  // Carr & Wu: reset credit spread target after 5-day IV harvest window
  // Simon & Campasano: flag momentum decay for trending positions 5d+
  for (const pos of state.positions) {
    if (pos.isCreditSpread && pos._creditHarvestExpiry) {
      if (Date.now() > new Date(pos._creditHarvestExpiry).getTime() && pos.takeProfitPct === 0.50) {
        pos.takeProfitPct = 0.50;
        logEvent("scan", `${pos.ticker} credit harvest window expired - target expanded to 50%`);
      }
    }
    const dOpen = (Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY;
    if (dOpen >= 5 && !pos.isMeanReversion && !pos.isCreditSpread && !pos._momentumDecayFlagged) {
      pos._momentumDecayFlagged = true;
      // Simon & Campasano: actually force rescore by resetting the rescore timer
      if (state._agentRescoreMinute) state._agentRescoreMinute[pos.ticker] = 0;
      if (state._agentRescoreHour)   state._agentRescoreHour[pos.ticker]   = -1;
      logEvent("scan", `${pos.ticker} momentum 5d+ - rescore forced (Simon & Campasano)`);
    }
  }

  // Mark as rescored - stagger same-day positions by 3 minutes each
  // Prevents all positions hitting 30-min mark simultaneously next cycle
  needRescore.forEach((p, i) => {
    const daysOpen = (now - new Date(p.openDate).getTime()) / MS_PER_DAY;
    if (daysOpen >= 1) {
      state._agentRescoreHour[p.ticker]   = currentHour;
    } else {
      const stagger = i * 30 * 1000;
      state._agentRescoreMinute[p.ticker] = now - stagger;
    }
  });

  // Fire rescores in parallel - only positions that actually need it
  const results = await Promise.allSettled(needRescore.map(p => getAgentRescore(p)));

  const toClose = [];
  results.forEach((result, i) => {
    const pos = needRescore[i];
    if (result.status !== 'fulfilled' || !result.value) return;
    const rescore = result.value;
    pos._liveRescore = { ...rescore, updatedAt: new Date().toISOString() };
    logEvent("scan", `[AGENT] ${pos.ticker}: ${rescore.label} (${rescore.score}/95) - ${rescore.recommendation} | ${rescore.reasoning||''}`);

    const curP = pos.currentPrice || pos.premium;
    const chg  = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
    const posIsPDTp = isDayTrade(pos);
    const posAlpacaBalp = state.alpacaCash || state.cash || 0;
    const posPDTProtectedp = posAlpacaBalp < 25000 && posIsPDTp;
    if (state.agentAutoExitEnabled &&
        rescore.recommendation === "EXIT" &&
        rescore.confidence === "high" &&
        chg < 0 &&
        !posPDTProtectedp) {
      toClose.push(pos.ticker);
    }
  });

  for (const ticker of toClose) {
    const pos = (state.positions||[]).find(p => p.ticker === ticker);
    if (!pos) continue;
    logEvent("warn", `[AGENT] AUTO-EXIT ${ticker} - ${pos._liveRescore?.label} | ${pos._liveRescore?.reasoning}`);
    await closePosition(ticker, "agent-exit");
  }

  if (results.some(r => r.status === 'fulfilled') || toClose.length > 0) markDirty();
}

// - Main Scan Engine -
let scanRunning  = false;
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

// Gate audit logger - records which gate blocked each instrument each scan
// Rolling 100-entry window in state._gateAudit for visibility in score debug
// Regime Classification Specialist: measure gates before removing them
function recordGateBlock(ticker, gate, regime, score) {
  if (!state._gateAudit) state._gateAudit = [];
  state._gateAudit.push({ ts: Date.now(), ticker, gate, regime, score });
  if (state._gateAudit.length > 100) state._gateAudit = state._gateAudit.slice(-100);
}

async function runScan() {
  if (scanRunning) { logEvent("scan", "Scan skipped - previous scan still running"); return; }
  scanRunning = true;
  _lastScanStart = Date.now(); // watchdog timestamp
  const thisScanGen = ++_scanGen; // stamp this scan's generation
  try {
  if (!ALPACA_KEY) { logEvent("warn", "No ALPACA_API_KEY set - check Railway variables"); scanRunning = false; return; }
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
  const _heatPct   = openCostBasis() / _totalCap;
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
    logEvent("scan", `[IVR] Window has no low-VIX baseline (min:${vixMin.toFixed(1)}) - using formula fallback: VIX ${newVIX} = IVR ${formulaIVR}`);
    state._ivRank = formulaIVR;
    state._ivEnv  = formulaIVR >= 70 ? "high" : formulaIVR >= 50 ? "elevated" : formulaIVR >= 30 ? "normal" : "low";
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
        for (const sector of ["XLE","KRE","XOP"]) {
          const snap = await alpacaGet(`/stocks/${sector}/snapshot`, ALPACA_DATA);
          if (!snap?.dailyBar?.c || !snap?.prevDailyBar?.c) continue;
          const sectorChange = (snap.dailyBar.c - snap.prevDailyBar.c) / snap.prevDailyBar.c * 100;
          const relStr = parseFloat((sectorChange - spyChange).toFixed(2));
          state._sectorRelStr[sector] = { relStr, sectorPct: parseFloat(sectorChange.toFixed(2)), spyPct: parseFloat(spyChange.toFixed(2)) };
          if (Math.abs(relStr) > 2.0) {
            logEvent("scan", `[SECTOR] ${sector} ${relStr > 0 ? "outperforming" : "underperforming"} SPY by ${relStr.toFixed(1)}% today - rotation signal`);
          }
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
    for (const pos of [...state.positions]) await closePosition(pos.ticker, "vix-spike");
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
    state._breadthHistory.push({ t: now, v: bPct });
    if (state._breadthHistory.length > 10) state._breadthHistory = state._breadthHistory.slice(-10);

    // 5-day breadth direction
    const bHist = state._breadthHistory;
    if (bHist.length >= 3) {
      const bRecent = bHist.slice(-3).map(b=>b.v);
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
    }
    if (sentiment) {
      marketContext.aaii = sentiment; // scoring reads state._aaii — wire sentiment here
      state._aaii = { ...sentiment, updatedAt: Date.now() };
      logEvent("scan", `[SENTIMENT] ${sentiment.signal} | vixMom:${sentiment.vixMomentum} spyDd:${sentiment.spyDrawdown}%`);
    }
    marketContext.fearGreed   = fg;
    marketContext.dxy         = dxy;
    marketContext.yieldCurve  = yc;
    // Real put/call ratio from CBOE via Alpaca - fetch PCCE (equity P/C) and PCCR (total P/C)
    // PCCE tracks equity-only put/call ratio - most relevant for individual stock options
    try {
      const pcceData = await alpacaGet(`/stocks/PCCE/bars?timeframe=1Day&limit=5`, ALPACA_DATA);
      if (pcceData && pcceData.bars && pcceData.bars.length > 0) {
        const pcRatio  = parseFloat(pcceData.bars[pcceData.bars.length-1].c);
        const signal   = pcRatio > 0.9 ? "fear" : pcRatio > 0.7 ? "elevated" : pcRatio < 0.5 ? "greed" : "neutral";
        marketContext.putCallRatio = { ratio: parseFloat(pcRatio.toFixed(2)), signal, source: "CBOE-PCCE" };
      } else {
        // Fallback if PCCE unavailable
        marketContext.putCallRatio = state.vix > 30 ? { ratio: 1.3, signal: "fear" } : state.vix > 20 ? { ratio: 1.0, signal: "neutral" } : { ratio: 0.7, signal: "greed" };
      }
    } catch(e) {
      marketContext.putCallRatio = state.vix > 30 ? { ratio: 1.3, signal: "fear" } : state.vix > 20 ? { ratio: 1.0, signal: "neutral" } : { ratio: 0.7, signal: "greed" };
    }
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

  // 1. Manage existing options positions
  // Prefetch news for all open positions in parallel - avoids per-position fetches inside loop
  const posNewsCache = {};
  if (state.positions.length > 0) {
    const posNewsFetches = await Promise.all(state.positions.map(p => getNewsForTicker(p.ticker)));
    state.positions.forEach((p, i) => { posNewsCache[p.ticker] = posNewsFetches[i] || []; });
  }

  // Fetch all position data in parallel - stock quotes + options snapshots simultaneously
  // Include spread leg symbols for P&L tracking
  const posSymbols = [...new Set(state.positions.flatMap(p => {
    if (p.isSpread) return [p.buySymbol, p.sellSymbol].filter(Boolean);
    return p.contractSymbol ? [p.contractSymbol] : [];
  }))].join(",");

  const [posSnapData, ...posQuotes] = await Promise.all([
    posSymbols ? alpacaGet(`/options/snapshots?symbols=${posSymbols}&feed=indicative`, ALPACA_OPT_SNAP) : Promise.resolve(null),
    ...state.positions.map(p => getStockQuote(p.ticker)),
  ]);
  const posSnapshots = posSnapData?.snapshots || {};

  for (let pi = 0; pi < state.positions.length; pi++) {
    const pos   = state.positions[pi];
    const price = posQuotes[pi];
    if (!price) continue;
    if (pos._dryRunWouldClose) continue; // already flagged for close this scan - skip
    try { // wrap each position in try/catch - one bad position can't crash the whole scan

    const dte      = Math.max(1, Math.round((new Date(pos.expDate)-new Date())/MS_PER_DAY));
    const t        = dte / 365;
    let curP;
    if (pos.isSpread && pos.buySymbol && pos.sellSymbol) {
      // Spread P&L: net value = buy leg mid - sell leg mid
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
            // Credit spread: we SOLD the sell leg and BOUGHT the buy leg (protection)
            // Current cost to close = buy back sell leg - sell long leg
            // = sellMid - buyMid (positive when spread has narrowed = profit)
            curP = parseFloat((sellMid - buyMid).toFixed(2));
          } else {
            // Debit spread: we BOUGHT the buy leg and SOLD the sell leg
            // Current value = buy leg value - sell leg value
            curP = parseFloat((buyMid - sellMid).toFixed(2));
          }
          pos.currentPrice = curP;
          pos.realData = true;
          // Update greeks from buy leg
          const buyGreeks = buySnap?.greeks || {};
          if (buyGreeks.delta) pos.greeks = {
            delta: parseFloat(buyGreeks.delta || 0).toFixed(3),
            theta: parseFloat(buyGreeks.theta || 0).toFixed(3),
            gamma: parseFloat(buyGreeks.gamma || 0).toFixed(4),
            vega:  parseFloat(buyGreeks.vega  || 0).toFixed(3),
          };
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
      curP = realPrice || (pos.iv ? parseFloat((price * pos.iv * Math.sqrt(t) * 0.4 + 0.1).toFixed(2)) : null) || pos.currentPrice || pos.premium;
      if (realPrice) pos.realData = true;
      // - LIVE GREEKS REFRESH -
      // Update Greeks from live snapshot - entry Greeks become stale quickly
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
      curP = pos.iv ? parseFloat((price * pos.iv * Math.sqrt(t) * 0.4 + 0.1).toFixed(2)) : pos.currentPrice || pos.premium;
    }
    // Credit spreads: curP = sellMid - buyMid (profit when spread narrows)
    // premium = net credit received at entry (positive)
    // chg = (curP - premium) / premium is NEGATIVE when profitable (spread narrowed)
    // Invert so exit logic (positive chg = good) works consistently for all spread types
    const rawChg = (curP > 0 && pos.premium > 0 && !isNaN(curP)) ? (curP - pos.premium) / pos.premium : 0;
    const chg    = pos.isCreditSpread ? -rawChg : rawChg;
    const hoursOpen= (new Date() - new Date(pos.openDate)) / 3600000;
    const daysOpen = hoursOpen / 24;

    // Update peak premium for trailing stop
    if (curP > pos.peakPremium) pos.peakPremium = curP;

    // Update peak cash for drawdown tracking
    const curCash = state.cash + openRisk() + realizedPnL();
    if (curCash > (state.peakCash || MONTHLY_BUDGET)) state.peakCash = curCash;

    // - TRIGGER 1: Rapid loss - 5%+ drop since last scan -
    // Most important trigger - catches fast-moving adverse positions
    if (ANTHROPIC_API_KEY && isMarketHours()) {
      const prevChg  = pos._prevScanChg || chg;
      const scanDrop = chg - prevChg; // how much moved this scan
      if (scanDrop <= -0.05 && chg < 0) {
        // Non-blocking fire
        triggerRescore(pos, `rapid-loss: ${(scanDrop*100).toFixed(1)}% this scan`);
      }
      pos._prevScanChg = chg; // store for next scan

      // - TRIGGER 2: RSI reversal - put thesis degrading -
      // Only check once per 5 minutes to avoid RSI noise
      const lastRSICheck = pos._lastRSITriggerCheck || 0;
      if (Date.now() - lastRSICheck > 5 * 60 * 1000) {
        pos._lastRSITriggerCheck = Date.now();
        try {
          const rsiB = await getStockBars(pos.ticker, 20);
          if (rsiB.length >= 14) {
            const liveRSI   = calcRSI(rsiB);
            const entryRSI  = pos.entryRSI || 70;
            const prevRSI   = pos._prevRSI || liveRSI;
            pos._prevRSI    = liveRSI;
            // Put thesis: entered when RSI was high (overbought)
            // Trigger if RSI has recovered significantly from entry level
            const putThesisDegrading = pos.optionType === "put" &&
              entryRSI >= 65 && liveRSI < 45 && prevRSI >= 50;
            // Call thesis degradation checks:
            // 1. RSI reversal: entered oversold, now overbought (mean reversion played out)
            const callRSIDegrading = pos.optionType === "call" &&
              entryRSI <= 40 && liveRSI > 55 && prevRSI <= 50;
            // 2. MACD turned bearish on a call position - momentum reversing
            // liveStock not in scope here -- use pos._lastMACD if available (set during scan scoring)
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

    // - PDT-AWARE HOLD LOGIC -
    // If position opened today - be reluctant to close it same-day (day trade)
    // Only force-close if hitting hard stop or deeply losing
    // Let minor moves ride overnight to avoid consuming a day trade
    const openedToday    = isDayTrade(pos); // opened same calendar day
    const etHourForPDT   = scanET.getHours() + scanET.getMinutes() / 60;
    const inFinalHour    = etHourForPDT >= 15.0;

    // - PDT PROTECTION - sub-$25k accounts -
    // Below $25k: never day-trade unless position hits +65% gain or -30% loss
    // This preserves all 3 day trades for positions that genuinely need them
    // Above $25k (Alpaca cash): normal operation resumes automatically
    const alpacaBalance  = state.alpacaCash || state.cash || 0;
    const belowPDTLimit  = alpacaBalance < 25000;
    const PDT_PROFIT_EXIT = 0.65;  // +65% - take the money, worth the day trade
    const PDT_LOSS_EXIT   = 0.30;  // -30% - deep enough loss to warrant cutting

    if (openedToday && belowPDTLimit && !dryRunMode) {
      // Profit emergency - +65% is exceptional, take it
      if (chg >= PDT_PROFIT_EXIT) {
        logEvent("scan", `${pos.ticker} PDT EMERGENCY PROFIT +${(chg*100).toFixed(0)}% - exiting same-day (above 65% threshold)`);
        await closePosition(pos.ticker, "target"); continue;
      }
      // Panel fix (V2.82): PDT overnight risk budget
      // If position is down >20% AND it is after 2:30pm ET - close it even if it burns a day trade
      // Research: compounding overnight loss on a -20% position in Regime B exceeds value of saved day trade
      // Behavioral finance: PDT conservation is loss aversion - P&L must take priority at this loss level
      const pdtRiskBudgetTriggered = chg <= -0.20 && etHourForPDT >= 14.5;
      if (pdtRiskBudgetTriggered) {
        logEvent("scan", `${pos.ticker} PDT OVERNIGHT RISK BUDGET - ${(chg*100).toFixed(0)}% after 2:30pm - closing to prevent compounding overnight loss (burning day trade)`);
        await closePosition(pos.ticker, "overnight-risk"); continue;
      }
      // Panel fix (V2.82): Agent high-confidence EXIT overrides PDT hold when losing >15%
      // The agent has live macro context - its EXIT signal carries real information
      // PDT block should not be an absolute wall against a significant losing position
      const agentSaysExit = pos._liveRescore?.recommendation === "EXIT" && pos._liveRescore?.confidence === "high";
      const agentExitOverride = agentSaysExit && chg <= -0.15;
      if (agentExitOverride) {
        logEvent("scan", `${pos.ticker} PDT AGENT OVERRIDE - high confidence EXIT + ${(chg*100).toFixed(0)}% loss - closing despite PDT protection | ${pos._liveRescore?.reasoning || ""}`);
        await closePosition(pos.ticker, "agent-exit"); continue;
      }
      // Loss emergency - -30% is severe, worth burning a day trade
      if (chg <= -PDT_LOSS_EXIT) {
        logEvent("scan", `${pos.ticker} PDT EMERGENCY LOSS ${(chg*100).toFixed(0)}% - exiting same-day (below -30% threshold)`);
        await closePosition(pos.ticker, "fast-stop"); continue;
      }
      // Hard stop always fires - -35% is catastrophic
      if (chg <= -STOP_LOSS_PCT) {
        logEvent("scan", `${pos.ticker} hard stop ${(chg*100).toFixed(0)}% - exiting same-day`);
        await closePosition(pos.ticker, "stop"); continue;
      }
      // Everything else - hold overnight, don't burn a day trade
      const reason = chg >= 0
        ? `+${(chg*100).toFixed(0)}% (need 65% for same-day exit)`
        : `${(chg*100).toFixed(0)}% (need -30% for same-day stop)`;
      logEvent("scan", `${pos.ticker} holding overnight - PDT protection | ${reason}`);
      pos.price = price; pos.currentPrice = curP;
      markDirty();
      continue;
    }

    // After-3pm hold mode (above $25k accounts still respect this)
    // Panel fix (V2.82): threshold tightened from -25% to -15%
    // Holding a -24% position overnight to save a day trade is loss aversion not risk management
    // At -16% to -24% the thesis is in distress - overnight hold in Regime B compounds the loss
    const pdtHoldMode = openedToday && inFinalHour && !dryRunMode && !belowPDTLimit;
    if (pdtHoldMode && chg > -0.15) {
      logEvent("scan", `${pos.ticker} holding overnight (after 3pm, avoid day trade) | ${(chg*100).toFixed(0)}%`);
      pos.price = price; pos.currentPrice = curP;
      markDirty();
      continue;
    }

    // - DELTA-BASED EXIT for spreads -
    // Buy leg delta > 0.70 = deep ITM = near max profit - take it
    // Buy leg delta < 0.05 = far OTM = thesis failed - cut early
    if (pos.isSpread && pos.greeks && pos.greeks.delta) {
      const buyLegDelta = Math.abs(pos.greeks.delta);
      if (buyLegDelta >= 0.70 && chg >= 0.30) {
        logEvent("scan", `${pos.ticker} delta ${buyLegDelta.toFixed(2)} - spread deep ITM, near max profit - closing`);
        await closePosition(pos.ticker, "target", null, pos.contractSymbol || pos.buySymbol);
        continue;
      }
      if (buyLegDelta <= 0.05 && chg <= -0.25) {
        logEvent("scan", `${pos.ticker} delta ${buyLegDelta.toFixed(2)} - spread far OTM, thesis failed - stopping out`);
        await closePosition(pos.ticker, "stop", null, pos.contractSymbol || pos.buySymbol);
        continue;
      }
    }

    // - PIN RISK CHECK (McMillan) - close if price near short strike at 5 DTE -
    // "Pin risk" = spread expires exactly at short strike = max risk scenario
    // Professional rule: close or roll when within $2 of short strike inside 5 DTE
    if (pos.isSpread && pos.sellStrike && !isDayTrade(pos)) {
      const dteLeft   = Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
      const shortStrike = pos.sellStrike || pos.shortStrike || 0;
      const distToShort  = Math.abs(price - shortStrike);
      const pinThreshold = price * 0.005; // 0.5% of underlying - scales with instrument price
      if (dteLeft <= 5 && distToShort <= pinThreshold && shortStrike > 0) {
        logEvent("warn", `[PIN RISK] ${pos.ticker} price $${price} within ${(distToShort/price*100).toFixed(2)}% of short strike $${shortStrike} (threshold 0.5%) with ${dteLeft}d DTE - closing`);
        await closePosition(pos.ticker, "pin-risk", null, pos.contractSymbol || pos.buySymbol);
        continue;
      }
    }

    // - EARLY ASSIGNMENT RISK (McMillan) - credit spread short leg ITM near expiry -
    // Short ITM options risk early assignment, especially near ex-dividend dates
    // For PDT accounts: early assignment creates a naked long/short = catastrophic
    if (pos.isCreditSpread && pos.sellStrike && !isDayTrade(pos)) {
      const dteLeft    = Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
      const shortStr   = pos.sellStrike || pos.shortStrike || 0;
      const shortITM   = pos.optionType === "put"  ? price < shortStr  // put short ITM if price below
                       : pos.optionType === "call" ? price > shortStr  // call short ITM if price above
                       : false;
      if (dteLeft <= 3 && shortITM) {
        logEvent("warn", `[ASSIGNMENT RISK] ${pos.ticker} short leg $${shortStr} is ITM with ${dteLeft}d DTE - closing to prevent early assignment`);
        await closePosition(pos.ticker, "assignment-risk", null, pos.contractSymbol || pos.buySymbol);
        continue;
      }
    }

    // - EXIT HIERARCHY -
    // Order matters - earlier checks take priority over later ones
    // Applies to: overnight positions (opened previous day or earlier)
    // OR: same-day positions on accounts above $25k

    // Refresh exit params based on current daysOpen - targets tighten overnight
    const currentExitParams = getDTEExitParams(pos.expDays || 30, daysOpen);
    // DTE-aware exits - as expiry approaches, lower the profit target
    // Carr & Wu: respect pos.takeProfitPct if it was explicitly set (harvest window)
    // pos.takeProfitPct = 0.30 during 5-day harvest window (tighter initial target)
    if (pos.takeProfitPct && pos.takeProfitPct < currentExitParams.takeProfitPct) {
      currentExitParams.takeProfitPct = pos.takeProfitPct; // harvest window overrides DTE params
    }
    // Theta accelerates dramatically inside 10 DTE - take profit sooner
    const dteLeft = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
    // Natenberg: theta decay is exponential not linear
    // DEBIT spreads: tighten targets as DTE drops - theta eating premium fast
    // CREDIT spreads: theta works FOR you - EXPAND targets at low DTE (let it expire worthless)
    const originalDTE = pos.expDays || 30;
    let dteMult;
    if (pos.isCreditSpread) {
      // Credit: theta erosion = profit - relax targets inside 10 DTE
      dteMult = dteLeft <= 3  ? 1.30  // <3 DTE: theta almost fully decayed, hold for max
              : dteLeft <= 7  ? 1.15  // <7 DTE: theta working hard, expand target
              : dteLeft <= 14 ? 1.05  // <14 DTE: mild expansion
              : 1.0;
    } else {
      // Debit: theta is the enemy - tighten targets as expiry approaches
      dteMult = dteLeft <= 3  ? 0.45  // <3 DTE: take what's there
              : dteLeft <= 5  ? 0.55  // <5 DTE: theta burning fast
              : dteLeft <= 10 ? 0.70  // <10 DTE: acceleration zone
              : dteLeft <= 14 ? 0.82  // <14 DTE: entering acceleration
              : dteLeft <= 21 ? 0.92  // <21 DTE: slight acceleration
              : 1.0;
    }
    // - Dynamic Take Profit for credit spreads (V2.3) -
    // Base TP = 50%. Scale DOWN when thesis is degrading AND position has aged.
    // Formula: TP = max(0.25, 0.50 - (liveScore / entryScore))
    // Conditions: credit spread + used >10% of position life + score available
    // Hard floor at 40%+ profit: always exit regardless of score (don't hold a near-winner)
    // Score < 40: thesis collapsed - handled by hard exit above, so TP is moot
    let activeTakeProfitPct;
    if (pos.isCreditSpread && pos.expDays > 0) {
      const lifePctUsed = daysOpen / pos.expDays;
      // Use freshest score: _liveRescore if <30min old, otherwise integrity score
      // Take the lower (more conservative) if both are available
      const liveRescoreAge = (pos._liveRescore && pos._liveRescore.updatedAt)
        ? (Date.now() - new Date(pos._liveRescore.updatedAt).getTime()) / 60000 : 999;
      const liveScore = (liveRescoreAge < 30 && pos._liveRescore && pos._liveRescore.score)
        ? Math.min(pos._liveRescore.score, pos.entryThesisScore || 100)
        : (pos.entryThesisScore || 100);
      const entryScore = pos._originalEntryScore || 100; // stamped at confirm - never changes
      if (lifePctUsed > 0.10 && liveScore < entryScore) {
        // Thesis has degraded and position has used >10% of its life
        const scaledTP = Math.max(0.25, 0.50 * (liveScore / entryScore));
        activeTakeProfitPct = parseFloat((scaledTP * dteMult).toFixed(3));
        if (liveScore < 60) logEvent("scan", `${pos.ticker} dynamic TP: ${(activeTakeProfitPct*100).toFixed(0)}% (score ${liveScore}/${entryScore}, life ${(lifePctUsed*100).toFixed(0)}% used)`);
      } else {
        activeTakeProfitPct = parseFloat((currentExitParams.takeProfitPct * dteMult).toFixed(3));
      }
      // Hard floor: always exit at 40%+ regardless of score - don't hold a near-winner
      if (chg >= 0.40 && activeTakeProfitPct > 0.40) {
        activeTakeProfitPct = 0.40;
      }
    } else {
      activeTakeProfitPct = parseFloat((currentExitParams.takeProfitPct * dteMult).toFixed(3));
    }
    // partialPct already derived from tp (which has overnightMult) - don't apply dteMult again
    // Partial should fire at 60% of the DTE-adjusted take profit target
    const activePartialPct    = parseFloat((activeTakeProfitPct * 0.60).toFixed(3));
    const activeRidePct       = currentExitParams.ridePct || (activeTakeProfitPct * 1.30);
    if (dteMult < 1.0 && pos.isSpread) logEvent("scan", `${pos.ticker} DTE-adjusted target: ${(activeTakeProfitPct*100).toFixed(0)}% (${dteLeft}d remaining)`);

    // - THESIS INTEGRITY CHECK - proactive exit on thesis degradation -
    // Runs on every scan for positions open 2+ days
    // Compares current conditions to entry conditions
    if (daysOpen >= 2 && pos.optionType) {
      const stockSnap   = WATCHLIST.find(s => s.ticker === pos.ticker) || {};
      const curRSI      = stockSnap.rsi      || pos.entryRSI    || 52;
      const curMACD     = stockSnap.macd     || pos.entryMACD   || "neutral";
      const curMomentum = stockSnap.momentum || pos.entryMomentum || "steady";
      const curMacro    = (state._agentMacro || {}).signal || "neutral";
      const integrity   = calcThesisIntegrity(pos, curRSI, curMACD, curMomentum, curMacro);

      // Update thesis score on position for dashboard display
      pos.entryThesisScore = integrity.score;
      if (!pos.thesisHistory) pos.thesisHistory = [];
      if (pos.thesisHistory.length === 0 || pos.thesisHistory[pos.thesisHistory.length-1]?.score !== integrity.score) {
        pos.thesisHistory.push({ time: new Date().toISOString(), score: integrity.score, notes: integrity.reasons.join("; ") });
        if (pos.thesisHistory.length > 10) pos.thesisHistory = pos.thesisHistory.slice(-10);
      }

      // Hard exit: thesis completely collapsed and not PDT protected
      if (integrity.score < 20 && !pdtProtected) {
        logEvent("warn", `[THESIS] ${pos.ticker} integrity collapsed ${integrity.score}/100 - ${integrity.reasons.slice(0,2).join(", ")} - closing`);
        await closePosition(pos.ticker, "thesis-collapsed");
        continue;
      } else if (integrity.score < 40) {
        logEvent("warn", `[THESIS] ${pos.ticker} integrity degraded ${integrity.score}/100 - ${integrity.reasons.slice(0,2).join(", ")}`);
        // INVALID score - tighten stop to 25% so a losing position exits sooner
        // Thesis is broken; holding at 50% stop means taking max loss on a bad trade
        if ((pos.fastStopPct || FAST_STOP_PCT) > 0.25) {
          pos.fastStopPct = 0.25;
          logEvent("warn", `[THESIS] ${pos.ticker} stop tightened to 25% (thesis INVALID)`);
        }
      }

      // Time-adjusted stop - tightens as position ages
      const adjStop = getTimeAdjustedStop(pos);
      if (adjStop < STOP_LOSS_PCT && chg < -adjStop && !pdtProtected) {
        logEvent("warn", `[THESIS] ${pos.ticker} time-adjusted stop ${(adjStop*100).toFixed(0)}% hit after ${daysOpen.toFixed(1)} days`);
        await closePosition(pos.ticker, "time-stop");
        continue;
      }
    }

    // 0b. DTE EXPIRY URGENCY - close positions in danger near expiry
    // OT-W4: Calendar time stop misses options-specific expiry risk
    const dteDaysLeft = pos.expDate ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY)) : 30;
    if (pos.isSpread && dteDaysLeft <= 1) {
      logEvent("warn", `${pos.ticker} DTE=1 - closing spread to avoid pin/assignment risk`);
      await closePosition(pos.ticker, "expiry-close"); continue;
    }
    if (dteDaysLeft <= 5 && dteDaysLeft > 0 && chg < -0.15 && !pdtProtected) {
      logEvent("warn", `${pos.ticker} DTE urgency: ${dteDaysLeft}d remaining, ${(chg*100).toFixed(0)}% - closing`);
      await closePosition(pos.ticker, "dte-urgency"); continue;
    }

    // 1. FAST STOP - tighter window for weeklies, wider for monthlies
    // Weeklies: 2-48hrs (theta racing, exit fast on loss)
    // Monthlies: 2-120hrs (5 days - thesis needs time to play out)
    const isWeeklyPos    = (pos.expiryType === "weekly" || (pos.expDays || 30) <= 21);
    const fastStopWindow = isWeeklyPos ? FAST_STOP_HOURS : 120;
    const fastStopEligible = hoursOpen >= 2 && hoursOpen <= fastStopWindow;
    if (fastStopEligible && chg <= -(pos.fastStopPct || FAST_STOP_PCT)) {
      logEvent("scan", `${pos.ticker} fast-stop ${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(1)}hrs (${isWeeklyPos ? 'weekly' : 'monthly'})`);
      await closePosition(pos.ticker, "fast-stop"); continue;
    }

    // 1b. CREDIT SPREAD MAX LOSS STOP - panel unanimous: 50% of max loss OR 2x credit
    // Checks actual dollar loss against max loss rather than relying on fastStopPct alone
    // This is the primary stop for credit spreads - more precise than percentage-based
    if (pos.isCreditSpread && pos.maxLoss > 0 && curP > 0) {
      const creditLossDollar = (curP - pos.premium) * 100 * (pos.contracts || 1); // $ lost so far
      const halfMaxLoss      = pos.maxLoss * 0.50;  // 50% of defined max loss in dollars
      const twiceCredit      = pos.premium * 2 * 100 * (pos.contracts || 1); // lose 2x what you could gain
      const creditStopDollar = Math.min(halfMaxLoss, twiceCredit); // stricter of the two
      if (creditLossDollar >= creditStopDollar && !pdtProtected) {
        logEvent("warn", `[CREDIT STOP] ${pos.ticker} credit spread stop triggered - loss $${creditLossDollar.toFixed(0)} exceeds ${(creditStopDollar===halfMaxLoss?'50% max loss':'2x credit')} ($${creditStopDollar.toFixed(0)}) - closing`);
        await closePosition(pos.ticker, "credit-stop"); continue;
      } else if (creditLossDollar >= creditStopDollar && pdtProtected) {
        logEvent("warn", `[CREDIT STOP] ${pos.ticker} credit spread stop triggered but PDT protected - loss $${creditLossDollar.toFixed(0)} vs limit $${creditStopDollar.toFixed(0)} - will close when PDT allows`);
      }
    }

    // 2. HARD STOP - -35% at any time
    if (chg <= -STOP_LOSS_PCT) {
      logEvent("scan", `${pos.ticker} stop-loss ${(chg*100).toFixed(0)}%`);
      await closePosition(pos.ticker, "stop"); continue;
    }

    // 3. TRAILING STOP - activates at tier threshold, tightens on signal decay
    if (chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT)) {
      // pos.trailPct stores the % width (0.15 = 15%), pos.trailStop stores the $ floor
      // These are separate fields - reading pos.trailStop as % was the bug
      let trailPct = pos.trailPct || TRAIL_STOP_PCT; // always a percentage
      // Signal decay: tighten trail if entry thesis has reversed
      let liveRSI = pos.entryRSI || 55;
      try {
        const posBars = await getStockBars(pos.ticker, 20);
        if (posBars.length >= 15) liveRSI = calcRSI(posBars);
      } catch(e) {}
      if (pos.optionType === "call" && liveRSI < 45 && (pos.entryRSI || 55) >= 50) {
        trailPct = TRAIL_STOP_PCT * 0.6;
        pos.trailPct = trailPct; // persist tightened % for next scan
        logEvent("scan", `${pos.ticker} signal decay - RSI ${liveRSI} - tightening trail to ${(trailPct*100).toFixed(0)}%`);
      }
      if (pos.optionType === "put" && liveRSI > 55 && (pos.entryRSI || 55) <= 50) {
        trailPct = TRAIL_STOP_PCT * 0.6;
        pos.trailPct = trailPct;
        logEvent("scan", `${pos.ticker} signal decay (put) - RSI ${liveRSI} - tightening trail to ${(trailPct*100).toFixed(0)}%`);
      }
      const trailFloor = pos.peakPremium * (1 - trailPct); // $ floor value
      pos.trailStop    = trailFloor;                        // store $ floor separately
      if (curP <= trailFloor) {
        logEvent("scan", `${pos.ticker} trail hit - peak $${pos.peakPremium.toFixed(2)} floor $${trailFloor.toFixed(2)} (${(trailPct*100).toFixed(0)}% trail)`);
        await closePosition(pos.ticker, "trail"); continue;
      }
    }

    // 4. PARTIAL CLOSE - at 60% of active take profit target
    // Uses live overnight-adjusted params - tighter targets on older positions
    // Guard: don't fire partial if trail is already active (trail takes over above trailActivate)
    const trailAlreadyActive = chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT);
    if (!pos.partialClosed && !trailAlreadyActive && chg >= activePartialPct && chg < activeTakeProfitPct) {
      logEvent("scan", `${pos.ticker} partial close at +${(chg*100).toFixed(0)}% [${currentExitParams.label}] (partial threshold: +${(activePartialPct*100).toFixed(0)}%)`);
      await partialClose(pos.ticker);
      continue; // don't evaluate take profit in same scan as partial - wait for next cycle
    }

    // 4b. NEAR-MAX-PROFIT EXIT - close when spread reaches 88%+ of theoretical max
    // OT-W3: At near-max, remaining upside is tiny vs gamma/pin risk of holding
    if (pos.isSpread && !pos.partialClosed) {
      const nearMaxProfit = pos.isCreditSpread
        ? chg >= 0.88  // collected 88%+ of max credit - close to lock in
        : (pos.maxProfit > 0 && pos.currentPrice > 0 && pos.premium > 0 &&
           (pos.currentPrice - pos.premium) >= 0.88 * (pos.maxProfit / 100 / Math.max(pos.contracts || 1, 1)));
      if (nearMaxProfit) {
        logEvent("scan", `${pos.ticker} near max profit (chg:${(chg*100).toFixed(0)}%) - closing to lock in gains before gamma risk`);
        await closePosition(pos.ticker, "near-max-profit"); continue;
      }
    }

    // 5. FULL TARGET - take profit
    // After partial: remainder rides to 130% of target then closes
    if (pos.partialClosed && chg >= activeRidePct) {
      logEvent("scan", `${pos.ticker} remainder target +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      await closePosition(pos.ticker, "target"); continue;
    }
    if (!pos.partialClosed && chg >= activeTakeProfitPct) {
      logEvent("scan", `${pos.ticker} take profit +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      await closePosition(pos.ticker, "target"); continue;
    }

    // - F10: THESIS DEGRADATION - re-score entry conditions every hour -
    // If the original entry thesis has weakened significantly, partial close
    // regardless of price movement - the edge is gone even if position is flat
    if (hoursOpen >= 1 && Math.floor(hoursOpen) > (pos._lastThesisCheck || 0)) {
      pos._lastThesisCheck = Math.floor(hoursOpen);
      try {
        const tBars  = await getStockBars(pos.ticker, 20);
        if (tBars.length >= 15) {
          const curRSI = calcRSI(tBars);
          const entryRSI = pos.entryRSI || (pos.optionType === "put" ? 75 : 30);
          // For puts: if RSI has dropped from overbought to neutral, thesis weakening
          const rsiReversed = pos.optionType === "put" && entryRSI >= 65 && curRSI < 50;
          // For calls: if RSI has risen from oversold to neutral, thesis weakening
          const callRsiReversed = pos.optionType === "call" && entryRSI <= 40 && curRSI > 55;
          if ((rsiReversed || callRsiReversed) && !pos.partialClosed && chg < 0.10) {
            logEvent("scan", `${pos.ticker} thesis degradation - RSI moved from ${entryRSI} to ${curRSI.toFixed(0)} - partial close`);
            await partialClose(pos.ticker);
          }
        }
      } catch(e) {}
    }

    // 6. TIME STOP - 7 days with no meaningful move
    if (daysOpen >= TIME_STOP_DAYS && Math.abs(chg) < TIME_STOP_MOVE) {
      logEvent("scan", `${pos.ticker} time-stop - ${daysOpen.toFixed(0)}d, only ${(chg*100).toFixed(1)}% move`);
      await closePosition(pos.ticker, "time-stop"); continue;
    }

    // Agent rescore handled in parallel batch after scan loop (see runAgentRescore below)

    // 7. EXPIRY ROLL - DTE <= 7, close winners (losers hit stop first)
    if (dte <= 7 && chg > 0) {
      logEvent("scan", `${pos.ticker} expiry-roll - ${dte}DTE with profit`);
      await closePosition(pos.ticker, "expiry-roll"); continue;
    }

    // 8. 50MA BREAK - thesis invalidated (real 50-day MA)
    // Minimum 2 hour hold - open volatility can briefly cross 50MA and recover
    // Firing instantly on a bounce after open loses money on noise, not signal
    if (hoursOpen >= 2) {
      try {
        const maBars = await getStockBars(pos.ticker, 55);
        if (maBars.length >= 50) {
          const ma50 = maBars.slice(-50).reduce((s, b) => s + b.c, 0) / 50;
          const ma50Break = pos.optionType === "put"
            ? price > ma50 * (1 + MA50_BUFFER)  // put: stock recovered above 50MA
            : price < ma50 * (1 - MA50_BUFFER); // call: stock broke below 50MA
          if (ma50Break) {
            logEvent("scan", `${pos.ticker} 50ma-break | price $${price.toFixed(2)} | 50MA $${ma50.toFixed(2)} | held ${hoursOpen.toFixed(1)}h`);
            await closePosition(pos.ticker, "50ma-break"); continue;
          }
        }
      } catch(e) {}
    }

    // 9. EARNINGS CLOSE - approaching earnings = IV crush risk
    if (pos.earningsDate) {
      const daysToE = Math.round((new Date(pos.earningsDate) - new Date()) / MS_PER_DAY);
      if (daysToE >= 0 && daysToE <= EARNINGS_SKIP_DAYS) {
        logEvent("scan", `${pos.ticker} earnings in ${daysToE}d - closing`);
        await closePosition(pos.ticker, "earnings-close"); continue;
      }
    }

    // 10. NEWS EXIT - strongly opposite news + position losing (thesis broken)
    // newsCache prefetched before loop - no per-position API calls
    const newsArts = posNewsCache[pos.ticker] || [];
    const newsSent = analyzeNews(newsArts);
    if (pos.optionType === "put" && newsSent.signal === "strongly bullish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit - strongly bullish news vs losing put`);
      await closePosition(pos.ticker, "news-exit"); continue;
    }
    if (pos.optionType === "call" && newsSent.signal === "strongly bearish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit - strongly bearish news vs losing call`);
      await closePosition(pos.ticker, "news-exit"); continue;
    }

    // 11. OVERNIGHT RISK - high VIX, losing position into close
    // Panel fix (V2.82): two-tier system - close worse positions earlier for better liquidity
    // Tier 1 (3:00pm): severely losing positions (-20%+) - close while liquidity is healthy
    // Tier 2 (3:30pm): moderately losing (-8%+) or short DTE (3 or less) - close before final spread widening
    // Moved from 3:45pm to 3:30pm - execution algo: last 15min has 3-5x wider bid-ask on options
    const etHourNow = scanET.getHours() + scanET.getMinutes() / 60;
    // Tier 1: severe losses at 3pm - best liquidity window
    if (etHourNow >= 15.0 && state.vix >= 25 && chg <= -0.20) {
      logEvent("scan", `${pos.ticker} overnight-risk TIER1 - severely losing ${(chg*100).toFixed(0)}% at 3pm - closing at healthy liquidity | VIX ${state.vix}`);
      await closePosition(pos.ticker, "overnight-risk"); continue;
    }
    // Tier 2: moderate losses or short DTE at 3:30pm
    if (etHourNow >= 15.5 && state.vix >= 30) {
      if (chg <= -0.08) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 - losing ${(chg*100).toFixed(0)}% into close VIX ${state.vix}`);
        await closePosition(pos.ticker, "overnight-risk"); continue;
      }
      if (dte <= 3) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 - ${dte}DTE too short for overnight hold`);
        await closePosition(pos.ticker, "overnight-risk"); continue;
      }
      if (dte <= 7) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 - ${dte}DTE elevated overnight theta risk - monitoring`);
      }
    }

    // Update current price on position so dashboard shows live data
    pos.price        = price;
    pos.currentPrice = curP;

    // V2.82: Close-of-day range position check for hold decisions (Technical Analyst recommendation)
    // After 3:30pm, log where the underlying closed relative to its daily range
    // Weak close (bottom 25% of range) = sellers in control at close = overnight continuation lower more likely
    // Strong close (top 25% of range) = buyers stepped in = overnight recovery more likely
    if (etHourNow >= 15.5 && bars && bars.length >= 1) {
      const todayBar = bars[bars.length - 1];
      const dayHigh = todayBar.h || price;
      const dayLow  = todayBar.l || price;
      const dayRange = dayHigh - dayLow;
      if (dayRange > 0) {
        const closePosition = (price - dayLow) / dayRange;
        const closeLabel = closePosition <= 0.25 ? "WEAK CLOSE - sellers in control" : closePosition >= 0.75 ? "STRONG CLOSE - buyers in control" : "neutral close";
        if (closePosition <= 0.25 && chg < 0) {
          logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD | ${closeLabel} (${(closePosition*100).toFixed(0)}th pctile of range) - elevated overnight risk`);
        } else {
          logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD | ${closeLabel}`);
        }
      } else {
        logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
      }
    } else {
      logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
    }
    markDirty(); // will be flushed at end of scan, not every tick
    } catch(posErr) {
      logEvent("error", `Position scan error for ${pos?.ticker || "unknown"}: ${posErr.message}`);
    } // end per-position try/catch
  }

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
  const pdtCount      = countRecentDayTrades();
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
  const putsAllowed       = (entryWindowOpen && !rb.gates.vixFallingPause && !rb.gates.spyGapUpBlockPuts
                             && !rb.gates.postReversalBlock && !rb.gates.macroBullishBlock
                             && !rb.gates.choppyDebitBlock && !rb.gates.avoidHoldActive
                             && !rb.gates.crisisDebitBlock) || dryRunMode;
  const callsAllowed      = (callWindowOpen && !rb.gates.below200MACallBlock
                             && (!rb.gates.choppyDebitBlock || isMRCondition)
                             && !rb.gates.avoidHoldActive) || dryRunMode;
  const creditAllowed     = creditModeActive  && entryWindowOpen && !rb.gates.avoidHoldActive && !rb.gates.vixFallingPause;
  const callCreditAllowed = creditCallModeActive && callWindowOpen && !rb.gates.avoidHoldActive;
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
            await closePosition(pos.ticker, "vix-spike", null, pos.contractSymbol || pos.buySymbol);
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
    if (spyDayMove > 0.025) { // SPY up 2.5%+ = genuine macro reversal
      let reversalCount = 0;
      for (const pos of [...state.positions]) {
        if (pos.optionType !== "put") continue;
        const snap = posSnapshots[pos.contractSymbol];
        if (!snap) continue;
        const quote  = snap.latestQuote || {};
        const bid    = parseFloat(quote.bp || 0);
        const ask    = parseFloat(quote.ap || 0);
        const curP   = bid > 0 && ask > 0 ? (bid + ask) / 2 : pos.premium;
        const chg    = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
        if (chg < -0.05) {
          logEvent("scan", `${pos.ticker} SPY macro reversal +${(spyDayMove*100).toFixed(1)}% - closing losing put (${(chg*100).toFixed(0)}%)`);
          await closePosition(pos.ticker, "macro-reversal");
          reversalCount++;
        }
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
    // Allow stagger entries (up to maxPerTicker) - don't skip entirely if one position open
    const maxPerTicker = stock.isIndex ? 3 : 2;
    const existingForTicker = state.positions.filter(p => p.ticker === stock.ticker);
    // Combined cap: credit + debit spreads on same ticker count together
    // Prevents GLD credit spread + 2 debit spreads = 3 positions on one name
    const maxCombined = stock.isIndex ? 2 : 1;
    if (existingForTicker.length >= maxCombined) continue;

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
    const filterResult = await checkAllFilters(stock, price);

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
      if (creditCallModeActive && price > vwap * 1.01) {
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
      const breadthVal  = typeof marketContext?.breadth === "number"
        ? marketContext.breadth * 100
        : parseFloat((marketContext?.breadth || "50").toString()) || 50;
      // Pass credit mode to scoreIndexSetup so RSI block and scoring adjust correctly
      // Scoring uses authRegimeName (price-based, computed once at scan top)
      // Agent signal/confidence/entryBias used for magnitude -- regime overridden by price classifier
      const scoringMacroBase  = { ...(agentMacro || {}), regime: authRegimeName };
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
        const _gldIntentType = (creditModeActive && putSetup.score >= MIN_SCORE) ? "credit_put" : "debit_put";
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
        const xleCallGate = isXLEEntryAllowed("call", liveStock.rsi, liveStock.momentum, state.vix, liveStock.price || 0, xleMA20Live);
        const xlePutGate  = isXLEEntryAllowed("put",  liveStock.rsi, liveStock.momentum, state.vix, liveStock.price || 0, xleMA20Live);
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
      // Very low volume selloff - weak conviction, slight penalty
      putSetup.score = Math.max(0, putSetup.score - 3);
      putSetup.reasons.push(`Low volume selloff (-3)`);
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
    if (_alpacaCircuitOpen) {
      logEvent("filter", `[CIRCUIT] Entries paused - Alpaca API degraded (${_alpacaConsecFails} consecutive failures)`);
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
    const agentMacroForScoring = (state._agentMacro || {}).signal || "neutral";
    const isBearishMacro = ["bearish", "strongly bearish", "mild bearish"].includes(agentMacroForScoring);
    let macroPutMod = isBearishMacro ? Math.abs(macro.scoreModifier || 0) : -(macro.scoreModifier || 0);

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
      logEvent("filter", `Agent macro stale (${agentStaleMins.toFixed(0)}min) - raising min score. Last signal: ${agentSig || "none"}`);
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
    // macdMinScore removed -- evaluateEntry handles MACD contradiction gate
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
    const prevRSI = bars.length >= 2 ? calcRSI(bars.slice(0, -1)) : signals.rsi;
    const rsiMove = Math.abs(signals.rsi - prevRSI);
    const fastRSIMove = rsiMove >= 15 && !creditModeActive;
    if (fastRSIMove) {
      const fastRSIMin = 85;
      if (bestScore < fastRSIMin) {
        logEvent("filter", `${stock.ticker} fast RSI move ${prevRSI.toFixed(0)}-${signals.rsi.toFixed(0)} (+${rsiMove.toFixed(0)}pts) - need score ${fastRSIMin}, have ${bestScore} - skip`);
        continue;
      }
      logEvent("filter", `${stock.ticker} fast RSI move ${rsiMove.toFixed(0)}pts - requiring high conviction (score ${bestScore} - 85 -)`);
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
    const topN       = Math.max(1, Math.ceil(scored.length * 0.20));
    const cutoffScore = scored[topN - 1]?.score || 0;
    const aboveCutoff = scored.filter(s => s.score >= cutoffScore);
    // Only keep top 20% - but always keep at least 1 candidate
    scored.length = 0;
    aboveCutoff.forEach(s => scored.push(s));
    logEvent("filter", `Score ranking: keeping top ${aboveCutoff.length} of candidates (cutoff: ${cutoffScore})`);
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
  for (const { stock, price, score, reasons, optionType, isMeanReversion, tradeIntent, constraintPass, constraintReason, heatMultiplier, sizeMod } of scored) {
    // Fix 8 (TR/Kelly panel): correlated instruments (SPY+QQQ) count as 1.5x heat
    // Prevents holding both as two independent bets at 0.95 correlation
    const _heatMult = heatMultiplier || 1.0;
    if (heatPct() * _heatMult >= effectiveHeatCap()) {
      if (_heatMult > 1.0) logEvent("filter", `${stock.ticker} correlated heat check: ${(heatPct()*_heatMult*100).toFixed(0)}% effective (${(heatPct()*100).toFixed(0)}% raw x ${_heatMult}x mult) - at cap`);
      break;
    }
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

    // - F8: Block high-beta entry if correlation limit reached -
    const stockBeta = stock.beta || stock._liveBeta || 1.0;
    if (stockBeta > 1.5 && highBetaPositions >= 2 && !dryRunMode) {
      logEvent("filter", `${stock.ticker} beta:${stockBeta.toFixed(1)} - high-beta limit reached (${highBetaPositions}/2)`);
      continue;
    }

    // Liquidity pre-check - block before executeTrade if contract is clearly unfillable
    // executeTrade also checks, but this avoids unnecessary order submission attempts
    if (stock._cachedContract) {
      const execOI     = stock._cachedContract.oi || 0;
      const execSpread = stock._cachedContract.spread || 1;
      // Hard block: OI known and below floor
      if (execOI > 0 && execOI < MIN_OI) {
        logEvent("filter", `${stock.ticker} pre-blocked - OI:${execOI} below minimum ${MIN_OI}`);
        continue;
      }
      // Hard block: spread too wide
      if (execSpread > MAX_SPREAD_PCT) {
        logEvent("filter", `${stock.ticker} pre-blocked - spread ${(execSpread*100).toFixed(0)}% exceeds ${(MAX_SPREAD_PCT*100).toFixed(0)}% max`);
        continue;
      }
      // MR-specific tighter gate: MR trades need better liquidity
      if (isMeanReversion && execOI > 0 && execOI < 50 && execSpread > 0.20) {
        logEvent("filter", `${stock.ticker} MEAN REVERSION blocked - OI:${execOI} spread:${(execSpread*100).toFixed(0)}% too illiquid for MR`);
        continue;
      }
    }
    // - AGENT PRE-ENTRY CHECK - only for genuinely borderline scores -
    // Panel fix: firing below 85 means paying for a call on nearly every trade.
    // Only medium-confidence rejections were silently ignored (wasted API cost).
    // New logic: fire only on 70-79 (true borderline). Scores 80+ have enough
    // signal consensus to proceed without validation.
    // Block on both high AND medium confidence rejections (low = too uncertain to block).
    if (!dryRunMode && score >= MIN_SCORE && score < 80 && !creditModeActive) {
      const preCheck = await getAgentPreEntryCheck(stock, score, reasons, optionType, false);
      if (!preCheck.approved && ["high","medium"].includes(preCheck.confidence)) {
        logEvent("filter", `${stock.ticker} blocked by pre-entry agent check (${preCheck.confidence} conf) - ${preCheck.reason}`);
        continue;
      }
    }

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
        recentSameDir:       recentSameDirMins,
        existingProfitPct,
        drawdownMinScore:    ddProtocol.minScore || MIN_SCORE }
    );
    if (!eeResult.pass && !dryRunMode) {
      logEvent("filter", `${stock.ticker} entry blocked - ${eeResult.reason}`);
      recordGateBlock(stock.ticker, eeResult.reason, rb.regimeName, score);
      continue;
    }

    // Derive execution path from locked intentType
    const agentTradeType      = (state._agentMacro || {}).tradeType || "spread";
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
    if (useIronCondor) {
      state._lastEntryType = "iron_condor";
      logEvent("scan", `[IRON CONDOR] ${stock.ticker} choppy + IVR ${ivRankNow} - attempting iron condor`);
      const icPos = await executeIronCondor(stock, price, score, reasons, state.vix);
      entered = !!icPos;
    } else if (useCreditSpread || useCreditCallSpread) {
      state._lastEntryType = "credit";
      // Sizing from entryEngine sizeMod (passed through scored.push from scoring loop)
      const _sizeMod = sizeMod || 1.0;
      const creditPos = await executeCreditSpread(stock, price, score, reasons, state.vix, optionType, _sizeMod, rb.spreadParams);
      entered = !!creditPos;
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
async function sendMorningBriefing() {
  if (!RESEND_API_KEY || !GMAIL_USER) return;
  try {
    const positions = state.positions || [];
    const pdtUsed   = countRecentDayTrades();
    const pdtLeft   = Math.max(0, 3 - pdtUsed);
    // Fetch fresh macro + news at send time - don't rely on cached context
    const freshMacro = await getMacroNews();
    marketContext.macro = freshMacro;
    const macro = freshMacro;

    // Also fetch Marketaux directly for guaranteed fresh headlines
    const mxDirect = await getMarketauxNews();
    const today     = new Date();
    const dateStr   = today.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    const macroSignal = (macro.signal || 'neutral').toUpperCase();

    // - Agent narrative briefing -
    let agentNarrative = null;
    if (ANTHROPIC_API_KEY) {
      try {
        agentNarrative = await getAgentMorningBriefing(positions, macro, macro.headlines || []);
        logEvent("scan", "[AGENT] Morning briefing written by Claude");
      } catch(e) {
        console.log("[AGENT] Morning briefing failed:", e.message);
      }
    }

    // - Divider helper -
    const divider = '<div style="border-top:1px solid #333;margin:14px 0"></div>';
    const sectionHead = (title) =>
      `<div style="font-family:Georgia,serif;font-size:10px;font-weight:bold;letter-spacing:2px;color:#555;text-transform:uppercase;margin-bottom:6px">${title}</div>`;

    // - Header -
    const header = `
      <div style="text-align:center;border-bottom:3px double #333;padding-bottom:12px;margin-bottom:12px">
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#111;letter-spacing:1px">ARGO-V2.5 TRADING DESK</div>
        <div style="font-size:10px;color:#555;margin-top:4px;letter-spacing:1px">${dateStr.toUpperCase()}</div>
      </div>
      <div style="display:flex;gap:0;border:1px solid #ccc;margin-bottom:4px">
        <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
          <div style="font-size:9px;color:#555;letter-spacing:1px">VIX</div>
          <div style="font-size:20px;font-weight:bold;color:${state.vix>30?'#cc0000':state.vix>20?'#cc6600':'#006600'}">${state.vix}</div>
        </div>
        <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
          <div style="font-size:9px;color:#555;letter-spacing:1px">CASH</div>
          <div style="font-size:16px;font-weight:bold;color:#111">$${(state.cash||0).toFixed(0)}</div>
        </div>
        <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
          <div style="font-size:9px;color:#555;letter-spacing:1px">DAY TRADES</div>
          <div style="font-size:16px;font-weight:bold;color:${pdtLeft===0?'#cc0000':pdtLeft===1?'#cc6600':'#111'}">${pdtLeft}/3</div>
        </div>
        <div style="flex:1;text-align:center;padding:8px">
          <div style="font-size:9px;color:#555;letter-spacing:1px">MACRO</div>
          <div style="font-size:12px;font-weight:bold;color:${macro.mode==='aggressive'?'#006600':macro.mode==='defensive'?'#cc0000':'#333'}">${macroSignal}</div>
        </div>
      </div>`;

    // - Positions table -
    const posRows = positions.length ? positions.map(p => {
      const dteDays   = p.expDate ? Math.max(0, Math.round((new Date(p.expDate) - today) / MS_PER_DAY)) : '?';
      // Use live price if available, fall back to after-hours estimate, then show entry
      const useAH     = !p.currentPrice && p.estimatedAH;
      const curPrice  = p.currentPrice || (useAH ? p.estimatedAH.price : null);
      const chgNum    = curPrice && p.premium ? ((curPrice - p.premium) / p.premium * 100) : null;
      const chgStr    = chgNum !== null ? chgNum.toFixed(1) : '-';
      const pnlDollar = chgNum !== null ? ((curPrice - p.premium) * 100 * (p.contracts||1)).toFixed(0) : '-';
      const warn      = chgNum !== null && chgNum <= -12 ? ' -' : '';
      const pnlColor  = chgNum === null ? '#555' : chgNum >= 0 ? '#006600' : '#cc0000';
      const estLabel  = useAH ? '<span style="font-size:8px;color:#999"> est</span>' : '';
      const stockPx   = p.price ? ` <span style="font-size:9px;color:#999">- ${p.ticker} $${p.price.toFixed(2)}</span>` : '';
      return `<tr style="border-bottom:1px solid #eee">
        <td style="padding:5px 4px;font-weight:bold">${p.ticker}${warn}</td>
        <td style="padding:5px 4px;color:#555">${p.optionType.toUpperCase()} $${p.strike}</td>
        <td style="padding:5px 4px;color:#555">${dteDays}d</td>
        <td style="padding:5px 4px">
          <span style="font-size:9px;color:#555">entry $${p.premium}</span>
          ${curPrice ? ` - <span style="color:${pnlColor};font-weight:bold">$${curPrice.toFixed(2)}${estLabel}</span>` : ''}
        </td>
        <td style="padding:5px 4px;font-weight:bold;color:${pnlColor}">${chgNum!==null?(chgNum>=0?'+':'')+chgStr+'%':'-'}${stockPx}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" style="padding:8px;color:#999;font-style:italic">No open positions</td></tr>';

    const posTable = `
      <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:monospace">
        <tr style="border-bottom:2px solid #333">
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">TICKER</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">CONTRACT</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">DTE</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">PRICE</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">P&amp;L - STOCK</th>
        </tr>
        ${posRows}
      </table>`;

    // - Position news (latest headline per ticker) -
    let posNewsHTML = '';
    if (positions.length > 0) {
      const posNewsItems = [];
      for (const pos of positions) {
        try {
          const news = await getNewsForTicker(pos.ticker);
          if (news && news.length > 0) {
            const article = news[0];
            const ageHrs  = ((Date.now() - new Date(article.created_at||0).getTime()) / 3600000).toFixed(0);
            posNewsItems.push(
              `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
                <span style="font-weight:bold;font-size:11px">${pos.ticker}</span>
                <span style="font-size:10px;color:#555"> - ${article.headline}</span>
                <div style="font-size:9px;color:#999;margin-top:2px">${ageHrs}h ago</div>
              </div>`
            );
          }
        } catch(e) {}
      }
      if (posNewsItems.length > 0) {
        posNewsHTML = divider + sectionHead('Position News') + posNewsItems.join('');
      }
    }

    // - Top headlines (regardless of keyword match) -
    const allHeadlines = macro.headlines || [];
    const topStories   = macro.topStories || [];
    // Combine: credible keyword stories first, then fill with general headlines
    const storySet = new Set();
    const storyItems = [];
    for (const s of topStories.slice(0,3)) {
      if (!storySet.has(s.headline)) {
        storySet.add(s.headline);
        const tag = s.recencyMult >= 2 ? 'BREAKING' : s.recencyMult >= 1.5 ? 'RECENT' : '';
        storyItems.push(
          `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
            ${tag ? `<span style="font-size:9px;font-weight:bold;color:${s.direction==='bullish'?'#006600':'#cc0000'};letter-spacing:1px">${tag} - ${(s.source||'').toUpperCase()} - ${s.direction.toUpperCase()}</span><br>` : ''}
            <span style="font-size:11px;color:#111">${s.headline}</span>
          </div>`
        );
      }
    }
    for (const h of allHeadlines) {
      if (storyItems.length >= 5) break;
      if (!storySet.has(h)) {
        storySet.add(h);
        storyItems.push(
          `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
            <span style="font-size:11px;color:#111">${h}</span>
          </div>`
        );
      }
    }
    // Always show at least 3 recent headlines - even on quiet nights
    if (storyItems.length === 0 && allHeadlines.length > 0) {
      allHeadlines.slice(0, 3).forEach(h => {
        storyItems.push(
          `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
            <span style="font-size:11px;color:#111">${h}</span>
          </div>`
        );
      });
    }
    // Last resort: use pre-fetched Marketaux headlines directly
    if (storyItems.length === 0 && mxDirect && mxDirect.length > 0) {
      mxDirect.slice(0, 5).forEach(a => {
        if (a.headline && !storySet.has(a.headline)) {
          storySet.add(a.headline);
          storyItems.push(
            `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
              <span style="font-size:9px;color:#555;letter-spacing:1px">${(a.source||'MARKETAUX').toUpperCase()}</span><br>
              <span style="font-size:11px;color:#111">${a.headline}</span>
            </div>`
          );
        }
      });
    }
    const headlinesHTML = storyItems.length > 0
      ? divider + sectionHead(`Top Stories (${macro.sourceCount || 'Alpaca + Marketaux'})`) + storyItems.join('')
      : ''; // omit section entirely if truly nothing available

    // - Economic calendar -
    const todayStr   = today.toISOString().split('T')[0];
    const calEvents  = getUpcomingMacroEvents(1).filter(e => e.date === todayStr);
    const tomorrowEvents = getUpcomingMacroEvents(2).filter(e => e.date !== todayStr);
    let calHTML = '';
    if (calEvents.length > 0 || tomorrowEvents.length > 0) {
      const calItems = [];
      calEvents.forEach(e => calItems.push(
        `<div style="margin-bottom:4px">
          <span style="font-weight:bold;color:${e.impact==='high'?'#cc0000':'#333'}">TODAY</span>
          <span style="font-size:11px;margin-left:8px">${e.event}</span>
          <span style="font-size:9px;color:#999;margin-left:4px">${e.impact.toUpperCase()} IMPACT</span>
        </div>`
      ));
      tomorrowEvents.forEach(e => calItems.push(
        `<div style="margin-bottom:4px">
          <span style="color:#555">TOMORROW</span>
          <span style="font-size:11px;margin-left:8px">${e.event}</span>
          <span style="font-size:9px;color:#999;margin-left:4px">${e.impact.toUpperCase()} IMPACT</span>
        </div>`
      ));
      calHTML = divider + sectionHead("Economic Calendar") + calItems.join('');
    }

    // - Macro triggers -
    const triggersHTML = macro.triggers && macro.triggers.length
      ? divider + `<div style="font-size:10px;color:#555"><strong style="letter-spacing:1px">MACRO SIGNALS:</strong> ${macro.triggers.join(' - ')}</div>`
      : '';

    // - Footer -
    const footer = `
      <div style="border-top:3px double #333;margin-top:16px;padding-top:8px;text-align:center;font-size:9px;color:#999;letter-spacing:1px">
        ARGO V2.80 - Entry window 9:30am-3:45pm ET - SPY/QQQ primary - Monthly options
      </div>`;

    // - Assemble -
    const html = `
      <div style="font-family:Georgia,serif;background:#ffffff;color:#111;padding:24px;max-width:620px;border:1px solid #ccc">
        ${header}
        ${divider}
        ${agentNarrative ? sectionHead('ANALYST BRIEFING - ARGO-V2.5 INTELLIGENCE') + '<div style="font-family:Georgia,serif;font-size:13px;color:#111;line-height:1.7;white-space:pre-wrap;padding:8px 0">' + agentNarrative + '</div>' + divider : ''}
        ${sectionHead('Open Positions - ' + positions.length + ' active')}
        ${posTable}
        ${triggersHTML}
        ${headlinesHTML}
        ${posNewsHTML}
        ${calHTML}
        ${footer}
      </div>`;

    await sendResendEmail(
      `ARGO-V2.5 Desk - ${dateStr} | VIX ${state.vix} | ${positions.length} positions`,
      html
    );
    logEvent("scan", "Morning briefing email sent");
  } catch(e) { console.error("[EMAIL] Morning briefing error:", e.message); }
}

// nodemailer removed - email now via Resend API (sendResendEmail)

// - Resend email helper -
async function sendResendEmail(subject, html) {
  if (!RESEND_API_KEY || !GMAIL_USER) {
    console.log("[EMAIL] Resend not configured - set RESEND_API_KEY and GMAIL_USER in Railway");
    return false;
  }
  try {
    const res  = await withTimeout(fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    "ARGO-V2.5 <onboarding@resend.dev>",
        to:      [GMAIL_USER],
        subject,
        html,
      }),
    }), 10000);
    const data = await res.json();
    if (data.id) {
      console.log(`[EMAIL] Sent via Resend: ${data.id}`);
      return true;
    } else {
      console.log("[EMAIL] Resend error:", JSON.stringify(data));
      return false;
    }
  } catch(e) {
    console.log("[EMAIL] Resend failed:", e.message);
    return false;
  }
}

function buildEmailHTML(type) {
  const pnl    = realizedPnL();
  const trades = state.closedTrades;
  const wins   = trades.filter(t=>t.pnl>0);
  const heat   = (heatPct()*100).toFixed(0);
  const curPortfolio = state.cash + openRisk() ;
  const daily  = (curPortfolio - state.dayStartCash).toFixed(2);
  const weekly = (curPortfolio - state.weekStartCash).toFixed(2);

  const posRows = state.positions.map(p => {
    const strikeLabel = p.isSpread ? `$${p.buyStrike}/$${p.sellStrike} ${p.optionType.toUpperCase()} SPRD` : `$${p.strike}${p.optionType === 'put' ? 'P' : 'C'}`;
    return `<tr><td>${p.ticker}</td><td>${strikeLabel}</td><td>${p.expDate}</td><td>${p.contracts}x</td><td>$${p.premium}</td><td>${p.score||"?"}/100</td></tr>`;
  }).join("") || "<tr><td colspan='6' style='color:#666'>No open positions</td></tr>";

  const recentTrades = trades.slice(-5).reverse().map(t =>
    `<tr><td>${t.ticker}</td><td style='color:${t.pnl>=0?"#00aa44":"#cc2222"}'>${t.pnl>=0?"+":""}$${t.pnl.toFixed(2)}</td><td>${t.reason}</td><td>${t.date}</td></tr>`
  ).join("") || "<tr><td colspan='4' style='color:#666'>No trades yet</td></tr>";

  const isGood = parseFloat(daily) >= 0;

  return `
<!DOCTYPE html><html><body style="font-family:monospace;background:#07101f;color:#cce8ff;padding:20px;max-width:600px">
<div style="background:#0a1628;border:1px solid #0d3050;border-radius:12px;padding:20px;margin-bottom:16px">
  <h2 style="color:#00ff88;margin:0 0 4px">- ARGO-V2.5 ${type === "morning" ? "Morning Briefing" : "End of Day Report"}</h2>
  <p style="color:#336688;margin:0;font-size:12px">${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</p>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
  <div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px">
    <div style="font-size:10px;color:#336688">CASH</div>
    <div style="font-size:18px;font-weight:700;color:#00ff88">${fmt(state.cash)}</div>
  </div>
  <div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px">
    <div style="font-size:10px;color:#336688">DAILY P&L</div>
    <div style="font-size:18px;font-weight:700;color:${isGood?"#00ff88":"#ff5555"}">${daily>=0?"+":""}$${daily}</div>
  </div>
  <div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px">
    <div style="font-size:10px;color:#336688">POSITIONS</div>
    <div style="font-size:18px;font-weight:700;color:#00c4ff">${state.positions.length}</div>
  </div>
  <div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px">
    <div style="font-size:10px;color:#336688">PORTFOLIO HEAT</div>
    <div style="font-size:18px;font-weight:700;color:${parseFloat(heat)>50?"#ff5555":parseFloat(heat)>35?"#ff9944":"#00ff88"}">${heat}%</div>
  </div>
</div>

<div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px;margin-bottom:12px">
  <h3 style="color:#336688;font-size:11px;margin:0 0 10px;text-transform:uppercase">Performance</h3>
  <table style="width:100%;font-size:12px;border-collapse:collapse">
    <tr><td style="color:#336688;padding:3px 0">Total Realized P&L</td><td style="text-align:right;color:${pnl>=0?"#00ff88":"#ff5555"};font-weight:700">${pnl>=0?"+":""}${fmt(pnl)}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">Weekly P&L</td><td style="text-align:right;color:${parseFloat(weekly)>=0?"#00ff88":"#ff5555"};font-weight:700">${parseFloat(weekly)>=0?"+":""}$${weekly}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">Monthly Revenue</td><td style="text-align:right;font-weight:700">${fmt(state.totalRevenue)}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">Win Rate</td><td style="text-align:right;font-weight:700">${trades.length?Math.round(wins.length/trades.length*100)+"% ("+wins.length+"/"+trades.length+")":"N/A"}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">VIX</td><td style="text-align:right;font-weight:700;color:${state.vix>25?"#ff9944":"#00ff88"}">${state.vix}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">Circuit Breaker</td><td style="text-align:right;font-weight:700;color:${state.circuitOpen?"#00ff88":"#ff5555"}">${state.circuitOpen?"OPEN":"TRIPPED"}</td></tr>
  </table>
</div>

<div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px;margin-bottom:12px">
  <h3 style="color:#336688;font-size:11px;margin:0 0 10px;text-transform:uppercase">Open Positions</h3>
  <table style="width:100%;font-size:11px;border-collapse:collapse">
    <tr style="color:#336688"><th style="text-align:left">Ticker</th><th>Strike</th><th>Expiry</th><th>Qty</th><th>Entry</th><th>Score</th></tr>
    ${posRows}
  </table>
</div>

<div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px;margin-bottom:12px">
  <h3 style="color:#336688;font-size:11px;margin:0 0 10px;text-transform:uppercase">Recent Trades</h3>
  <table style="width:100%;font-size:11px;border-collapse:collapse">
    <tr style="color:#336688"><th style="text-align:left">Ticker</th><th>P&L</th><th>Reason</th><th>Date</th></tr>
    ${recentTrades}
  </table>
</div>

${type === "morning" ? `
<div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.15);border-radius:8px;padding:14px">
  <h3 style="color:#00ff88;font-size:11px;margin:0 0 6px">TODAY'S OUTLOOK</h3>
  <p style="font-size:12px;color:#cce8ff;margin:0">ARGO-V2.82 will scan every 10 seconds. New entries: 9:30AM-3:00PM ET (mean reversion to 3:30PM). Position management runs until 3:50PM. VIX is currently ${state.vix} - ${state.vix<20?"normal conditions, full sizing":"reduced sizing active"}. ${state.positions.length} position${state.positions.length!==1?"s":""} currently open.</p>
</div>` : `
<div style="background:rgba(0,196,255,0.05);border:1px solid rgba(0,196,255,0.15);border-radius:8px;padding:14px">
  <h3 style="color:#00c4ff;font-size:11px;margin:0 0 6px">END OF DAY SUMMARY</h3>
  <p style="font-size:12px;color:#cce8ff;margin:0">Market closed. ${state.todayTrades} trade${state.todayTrades!==1?"s":""} executed today. Daily P&L: ${parseFloat(daily)>=0?"+":""}$${daily}. ARGO-V2.5 resumes scanning tomorrow at 10:00 AM ET.</p>
</div>`}

<p style="font-size:10px;color:#336688;text-align:center;margin-top:16px">ARGO-V2.5 SPY Spread Trader - Paper Trading - Not financial advice</p>
</body></html>`;
}

async function sendEmail(type) {
  if (!RESEND_API_KEY || !GMAIL_USER) { logEvent("warn", "Email not configured"); return; }
  const subject = type === "morning"
    ? `ARGO-V2.5 Morning Briefing - ${new Date().toLocaleDateString()}`
    : `ARGO-V2.5 EOD Report - P&L ${(state.cash-state.dayStartCash)>=0?"+":""}$${(state.cash-state.dayStartCash).toFixed(2)}`;
  try {
    await sendResendEmail(subject, buildEmailHTML(type));
    logEvent("email", `${type} email sent to ${GMAIL_USER}`);
  } catch(e) { logEvent("error", `Email failed: ${e.message}`); }
}

// - Monthly Performance Report -
function buildMonthlyReport() {
  const trades   = state.closedTrades;
  const pnl      = realizedPnL();
  const wins     = trades.filter(t=>t.pnl>0);
  const losses   = trades.filter(t=>t.pnl<=0);
  const avgWin   = wins.length   ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((s,t)=>s+t.pnl,0)/losses.length : 0;
  const grossW   = wins.reduce((s,t)=>s+t.pnl,0);
  const grossL   = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const pf       = grossL>0 ? (grossW/grossL).toFixed(2) : "-";
  const maxDD    = Math.min(0, state.cash - state.peakCash);
  const returns  = trades.map(t=>t.pnl/MONTHLY_BUDGET);
  const avgRet   = returns.length ? returns.reduce((s,r)=>s+r,0)/returns.length : 0;
  const stdDev   = returns.length > 1 ? Math.sqrt(returns.reduce((s,r)=>s+Math.pow(r-avgRet,2),0)/(returns.length-1)) : 0;
  const sharpe   = stdDev > 0 ? (avgRet / stdDev * Math.sqrt(252)).toFixed(2) : "N/A";
  const bestTrade  = trades.length ? trades.reduce((b,t)=>t.pnl>b.pnl?t:b) : null;
  const worstTrade = trades.length ? trades.reduce((w,t)=>t.pnl<w.pnl?t:w) : null;

  return `ARGO-V2.5 MONTHLY PERFORMANCE REPORT
${"-".repeat(48)}
Period:           ${state.monthStart} - ${new Date().toLocaleDateString()}

RETURNS
  Starting Budget: ${fmt(MONTHLY_BUDGET)}
  Current Cash:    ${fmt(state.cash)}
  Total P&L:       ${pnl>=0?"+":""}${fmt(pnl)}
  Monthly Revenue: ${fmt(state.totalRevenue)}
  Bonus Earned:    ${fmt(state.extraBudget)}

TRADE STATISTICS
  Total Trades:    ${trades.length}
  Win Rate:        ${trades.length?Math.round(wins.length/trades.length*100)+"%":"N/A"} (${wins.length}W / ${losses.length}L)
  Avg Win:         ${avgWin?"+"+fmt(avgWin):"N/A"}
  Avg Loss:        ${avgLoss?fmt(avgLoss):"N/A"}
  Profit Factor:   ${pf}
  Best Trade:      ${bestTrade?bestTrade.ticker+" +"+fmt(bestTrade.pnl):"N/A"}
  Worst Trade:     ${worstTrade?worstTrade.ticker+" "+fmt(worstTrade.pnl):"N/A"}

RISK METRICS
  Sharpe Ratio:    ${sharpe}
  Max Drawdown:    ${fmt(maxDD)}
  Peak Cash:       ${fmt(state.peakCash)}
  VIX Avg:         ${state.vix}

STOCK PORTFOLIO
  Positions:       ${state.stockPositions.length}
  Total Value:     ${fmt(stockValue())}`;
}

// - Cron Schedules -
// Every 10 seconds Mon-Fri - 2 stocks with 0.3s prefetch, no reason to wait 30s
setInterval(() => {
  const day = getETTime().getDay();
  if (day >= 1 && day <= 5) runScan();
}, 10000);

// - F3: After-hours context update - every 15 min Mon-Fri outside market hours -
// Updates macro news, VIX proxy, Fear&Greed overnight
// Ensures APEX walks into market open with fresh context, not stale data
async function updateAfterHoursContext() {
  const et  = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return; // skip weekends
  if (isMarketHours()) return; // market scan handles this during hours
  try {
    // - Macro / sentiment context -
    const macro = await getMacroNews();
    marketContext.macro = macro;
    if (macro.mode !== "normal") {
      logEvent("macro", `[AH] Overnight macro: ${macro.signal} - ${macro.triggers.slice(0,3).join(", ")}`);
    }
    const fg = await getFearAndGreed();
    marketContext.fearGreed = fg;
    const newVIX = await getVIX();
    if (newVIX) state.vix = newVIX;
    if (state.positions.length > 0 && macro.mode === "aggressive") {
      logEvent("warn", `[AH] Bullish macro overnight - ${state.positions.filter(p=>p.optionType==="put").length} puts may be at risk at open`);
    }

    // - Overnight position pricing -
    // Options don't trade after hours - fetch underlying stock price instead
    // Use Black-Scholes to estimate what the option is worth at the new stock price
    // Stored separately as estimatedAH - never overwrites real currentPrice
    if (state.positions.length > 0) {
      const etHour = et.getHours() + et.getMinutes() / 60;
      // Use extended hours quotes if available (4am-9:30am ET pre-market, 4pm-8pm post-market)
      const isPreMarket  = etHour >= 4   && etHour < 9.5;
      const isPostMarket = etHour >= 16  && etHour < 20;
      const hasExtended  = isPreMarket || isPostMarket;

      // Fetch all underlying prices in parallel
      const underlyingPrices = await Promise.all(
        state.positions.map(async pos => {
          try {
            // Try extended hours snapshot first (pre/post market)
            if (hasExtended) {
              const snap = await alpacaGet(`/stocks/${pos.ticker}/snapshot`, ALPACA_DATA);
              if (snap) {
                // Pre-market: use minuteBar (most recent extended hours)
                // Post-market: use minuteBar (after-hours activity)
                const extPrice = snap.minuteBar?.c || snap.latestTrade?.p || null;
                if (extPrice && extPrice > 0) return { ticker: pos.ticker, price: extPrice, source: isPreMarket ? "pre-market" : "post-market" };
              }
            }
            // Fallback: last daily close
            const bars = await getStockBars(pos.ticker, 2);
            if (bars.length > 0) return { ticker: pos.ticker, price: bars[bars.length-1].c, source: "last-close" };
            return null;
          } catch(e) { return null; }
        })
      );

      // Estimate option value at new underlying price using Black-Scholes
      let updatedCount = 0;
      for (const pos of state.positions) {
        const underlying = underlyingPrices.find(u => u && u.ticker === pos.ticker);
        if (!underlying) continue;
        try {
          const newStockPrice = underlying.price;
          const dte           = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
          const iv            = pos.iv ? pos.iv / 100 : 0.30;

          let estPrice, estPnl, estPct;

          if (pos.isSpread && pos.buyStrike && pos.sellStrike) {
            // Spread: compute delta of both legs and use net spread delta
            // This is more accurate than single-leg delta for spread AH estimates
            const buyGreeks  = calcGreeks(newStockPrice, pos.buyStrike,  dte, iv, pos.optionType);
            const sellGreeks = calcGreeks(newStockPrice, pos.sellStrike, dte, iv, pos.optionType);
            const netDelta   = (parseFloat(buyGreeks.delta) || 0) - (parseFloat(sellGreeks.delta) || 0);
            const prevStockPrice = pos.price || newStockPrice;
            const stockMove  = newStockPrice - prevStockPrice;
            const curVal     = pos.currentPrice || pos.premium;
            estPrice  = parseFloat(Math.max(0.01, curVal + (stockMove * netDelta)).toFixed(2));
            if (pos.isCreditSpread) {
              // Credit spread: profitable when value decreases (we sold premium)
              estPnl = parseFloat(((pos.premium - estPrice) * 100 * (pos.contracts || 1)).toFixed(2));
              estPct = parseFloat((((pos.premium - estPrice) / pos.premium) * 100).toFixed(1));
            } else {
              estPnl = parseFloat(((estPrice - pos.premium) * 100 * (pos.contracts || 1)).toFixed(2));
              estPct = parseFloat((((estPrice - pos.premium) / pos.premium) * 100).toFixed(1));
            }
          } else {
            // Single leg option
            const strikeForCalc = pos.strike;
            if (!strikeForCalc) continue;
            const greeks       = calcGreeks(newStockPrice, strikeForCalc, dte, iv, pos.optionType);
            const priceDelta   = newStockPrice - (pos.price || newStockPrice);
            const optionDelta  = parseFloat(pos.greeks?.delta || greeks.delta);
            estPrice = parseFloat(Math.max(0.01, (pos.currentPrice || pos.premium) + (priceDelta * optionDelta)).toFixed(2));
            estPnl   = parseFloat(((estPrice - pos.premium) * 100 * (pos.contracts || 1)).toFixed(2));
            estPct   = parseFloat((((estPrice - pos.premium) / pos.premium) * 100).toFixed(1));
          }

          // Store as estimatedAH - separate from real currentPrice
          pos.estimatedAH = {
            price:       estPrice,
            pnl:         estPnl,
            pct:         estPct,
            stockPrice:  newStockPrice,
            source:      underlying.source,
            updatedAt:   new Date().toISOString(),
          };
          pos.price = newStockPrice; // update underlying price for display
          updatedCount++;
        } catch(e) {}
      }
      if (updatedCount > 0) {
        logEvent("scan", `[AH] Updated ${updatedCount}/${state.positions.length} position estimates | ${isPreMarket ? "pre-market" : isPostMarket ? "post-market" : "last-close"} prices`);
        markDirty();
      }
    }

    logEvent("scan", `[AH] Context updated | VIX:${state.vix} | F&G:${fg.score} | Macro:${macro.signal}`);
    markDirty();
  } catch(e) { console.error("[AH] Context update error:", e.message); }
}
setInterval(() => {
  const day = getETTime().getDay();
  if (day >= 1 && day <= 5) updateAfterHoursContext();
}, 15 * 60 * 1000); // every 15 minutes

// Dedicated state flush every 30 seconds - decoupled from scan timing
// Ensures dirty state is persisted even if scan is slow or skipped
setInterval(() => {
  flushStateIfDirty().catch(e => console.error("Flush interval error:", e.message));
}, 30000);

// C3: Scan watchdog -- prevents permanent scanRunning=true lockout
// If a scan hangs (Redis timeout, API freeze), scanRunning stays true and
// subsequent scans are skipped silently. Watchdog force-resets after 90 seconds.
let _lastScanStart = 0;
const SCAN_WATCHDOG_MS = 90 * 1000;
setInterval(() => {
  if (scanRunning && _lastScanStart > 0 && (Date.now() - _lastScanStart) > SCAN_WATCHDOG_MS) {
    logEvent("warn", `[WATCHDOG] Scan running ${((Date.now()-_lastScanStart)/1000).toFixed(0)}s -- force-resetting scanRunning`);
    scanRunning = false;
    _lastScanStart = 0;
  }
}, 15 * 1000);

// - F4: Alpaca account balance sync every 60 seconds -
// syncCashFromAlpaca() syncs state.cash from Alpaca account after every trade
// and every 30 seconds. This eliminates cash drift between ARGO and Alpaca.
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
    if (!hasCustomBudget) {
      const drift = Math.abs(alpacaCash - state.cash);
      if (drift > 1.00) {
        if (drift > 500) {
          // Large drift = account reset — update all baselines
          logEvent("scan", `[CASH SYNC] Large drift $${drift.toFixed(2)} — resetting baselines to $${alpacaCash.toFixed(2)}`);
          state.dayStartCash  = alpacaCash;
          state.weekStartCash = alpacaCash;
          state.peakCash      = Math.max(state.peakCash || 0, alpacaCash);
        } else {
          logEvent("scan", `[CASH SYNC] Alpaca: $${alpacaCash.toFixed(2)} | ARGO: $${state.cash.toFixed(2)} | drift: $${drift.toFixed(2)} — syncing`);
        }
        state.cash = alpacaCash;
        markDirty();
      }
    }
  } catch(e) {} // silent
}

// - Alpaca cash sync interval - calls syncCashFromAlpaca every 30s -
setInterval(syncCashFromAlpaca, 30 * 1000); // every 30 seconds

// - Independent agent macro interval - runs every 3 minutes regardless of scan state -
// Decoupled from scan so long mleg poll loops don't starve the agent
let _lastAgentInterval = 0;

// Run immediately on startup during market hours - don't wait 3 min for first signal
setTimeout(async () => {
  const et = getETTime();
  const etH = et.getHours() + et.getMinutes() / 60;
  const day = et.getDay();
  if (day >= 1 && day <= 5 && etH >= 8.5 && etH <= 17.0) {
    logEvent("macro", "[AGENT] Running initial macro analysis on startup...");
    try {
      const macro = await getMacroNews();
      if (macro) { marketContext.macro = macro; markDirty(); }
    } catch(e) { logEvent("warn", `[AGENT] Startup macro failed: ${e.message}`); }
    _lastAgentInterval = Date.now();
  }
}, 5000); // 5s after startup - let Redis rehydrate first

setInterval(async () => {
  const et  = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return;
  const etH = et.getHours() + et.getMinutes() / 60;
  if (etH < 8.5 || etH > 17.0) return; // 8:30am-5pm ET only
  if (Date.now() - _lastAgentInterval < 2.5 * 60 * 1000) return; // 2.5 min debounce
  _lastAgentInterval = Date.now();
  try {
    const macro = await getMacroNews();
    if (macro) {
      marketContext.macro = macro;
      markDirty();
    }
  } catch(e) { logEvent("warn", `[AGENT] Interval macro failed: ${e.message}`); }
}, 3 * 60 * 1000); // every 3 minutes

// - F2: Pre-market carry-over assessment (9:00 AM ET) -
// Checks overnight positions against pre-market conditions
// Flags positions likely to need immediate action at open
async function premarketAssessment() {
  // Always run - even with no positions, show macro outlook and day plan
  try {
    const macro = await getMacroNews();
    marketContext.macro = macro;
    const fg   = await getFearAndGreed();
    const vix  = await getVIX();
    if (vix) state.vix = vix;
    marketContext.fearGreed = fg;

    logEvent("scan", `[PREMARKET] Assessing ${state.positions.length} positions | VIX:${state.vix} | Macro:${macro.signal}`);

    // Assess each position - build recommendation
    const assessments = [];
    for (const pos of state.positions) {
      const reasons   = [];
      const riskFlags = [];
      let recommendation = "HOLD"; // default

      // - P&L check -
      const curP  = pos.currentPrice || (pos.estimatedAH ? pos.estimatedAH.price : null) || pos.premium;
      const chg   = pos.premium > 0 ? ((curP - pos.premium) / pos.premium) * 100 : 0;
      const pnlEst= ((curP - pos.premium) * 100 * (pos.contracts||1)).toFixed(0);
      const isAH  = !pos.currentPrice && pos.estimatedAH;

      if (chg <= -20) {
        riskFlags.push(`Down ${chg.toFixed(1)}% - near stop loss`);
        recommendation = "CLOSE";
      } else if (chg <= -10) {
        riskFlags.push(`Down ${chg.toFixed(1)}% - monitor closely`);
        recommendation = "WATCH";
      } else if (chg >= 20) {
        riskFlags.push(`Up ${chg.toFixed(1)}% - consider taking profit`);
        recommendation = "WATCH";
      }

      // - Thesis check -
      try {
        const bars = await getStockBars(pos.ticker, 20);
        if (bars.length >= 14) {
          const curRSI   = calcRSI(bars);
          const entryRSI = pos.entryRSI || 70;
          if (pos.optionType === "put" && entryRSI >= 65 && curRSI < 50) {
            riskFlags.push(`RSI recovered from ${entryRSI} - ${curRSI.toFixed(0)} - put thesis degraded`);
            if (recommendation === "HOLD") recommendation = "WATCH";
          }
        }
      } catch(e) {}

      // - Macro alignment -
      if (pos.optionType === "put" && macro.mode === "aggressive") {
        riskFlags.push("Bullish macro overnight - put thesis at risk");
        recommendation = "WATCH";
      }
      if (pos.optionType === "call" && macro.mode === "defensive") {
        riskFlags.push("Bearish macro overnight - call thesis at risk");
        recommendation = "WATCH";
      }

      // - DTE checks -
      const dte = pos.expDate
        ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY))
        : (pos.expDays || 30);
      if (dte <= 3) {
        riskFlags.push(`${dte}DTE - expiring imminently, theta accelerating`);
        recommendation = "CLOSE";
      } else if (dte <= 7 && state.vix > 35) {
        riskFlags.push(`${dte}DTE + VIX ${state.vix} - short-dated in high vol`);
        if (recommendation === "HOLD") recommendation = "WATCH";
      }

      // - VIX extreme -
      if (state.vix > 45) {
        riskFlags.push(`VIX ${state.vix} - extreme volatility, wide spreads at open`);
      }

      assessments.push({
        ticker:         pos.ticker,
        optionType:     pos.optionType,
        strike:         pos.isSpread ? `$${pos.buyStrike}/$${pos.sellStrike}` : pos.strike,
        dte,
        chg:            parseFloat(chg.toFixed(1)),
        pnlEst:         parseFloat(pnlEst),
        curP:           parseFloat(curP.toFixed(2)),
        isAH,
        recommendation,
        riskFlags,
      });

      const emoji = recommendation === "CLOSE" ? "-" : recommendation === "WATCH" ? "-" : "-";
      logEvent(recommendation === "HOLD" ? "scan" : "warn",
        `[PREMARKET] ${emoji} ${pos.ticker} - ${recommendation} | ${chg.toFixed(1)}% | ${riskFlags.join(" | ") || "OK"}`
      );
    }

    // Always send email - show macro outlook even with no positions
    if (RESEND_API_KEY && GMAIL_USER) {
      const closes = assessments.filter(a => a.recommendation === "CLOSE");
      const watches = assessments.filter(a => a.recommendation === "WATCH");
      const holds  = assessments.filter(a => a.recommendation === "HOLD");
      const subject = assessments.length === 0
        ? `ARGO-V2.5 Pre-Market - No Positions | ${macro.signal.toUpperCase()} | ${new Date().toLocaleDateString()}`
        : closes.length
        ? `ARGO-V2.5 Pre-Market - ${closes.length} CLOSE, ${watches.length} WATCH | ${new Date().toLocaleDateString()}`
        : `ARGO-V2.5 Pre-Market - All Clear | ${new Date().toLocaleDateString()}`;

      const rowColor = (rec) => rec === "CLOSE" ? "#cc0000" : rec === "WATCH" ? "#cc6600" : "#006600";
      const rows = assessments.map(a => `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:6px 4px;font-weight:bold">${a.ticker}</td>
          <td style="padding:6px 4px;color:#555">${a.optionType.toUpperCase()} $${a.strike}</td>
          <td style="padding:6px 4px;color:#555">${a.dte}d</td>
          <td style="padding:6px 4px;color:${a.chg>=0?'#006600':'#cc0000'};font-weight:bold">${a.chg>=0?'+':''}${a.chg}%${a.isAH?' <small style="color:#999">(est)</small>':''}</td>
          <td style="padding:6px 4px;font-weight:bold;color:${rowColor(a.recommendation)}">${a.recommendation}</td>
          <td style="padding:6px 4px;font-size:10px;color:#555">${a.riskFlags.join(" - ") || "-"}</td>
        </tr>`
      ).join("");

      await sendResendEmail(subject, `
        <div style="font-family:Georgia,serif;background:#fff;color:#111;padding:24px;max-width:700px;border:1px solid #ccc">
          <div style="text-align:center;border-bottom:3px double #333;padding-bottom:12px;margin-bottom:16px">
            <div style="font-size:20px;font-weight:bold;letter-spacing:1px">ARGO-V2.5 PRE-MARKET ASSESSMENT</div>
            <div style="font-size:10px;color:#555;margin-top:4px;letter-spacing:1px">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase()} - 8:45AM ET</div>
          </div>
          <div style="display:flex;gap:0;border:1px solid #ccc;margin-bottom:16px">
            <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
              <div style="font-size:9px;color:#555;letter-spacing:1px">VIX</div>
              <div style="font-size:18px;font-weight:bold;color:${state.vix>30?'#cc0000':'#333'}">${state.vix}</div>
            </div>
            <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
              <div style="font-size:9px;color:#555;letter-spacing:1px">MACRO</div>
              <div style="font-size:14px;font-weight:bold;color:${macro.mode==='aggressive'?'#006600':macro.mode==='defensive'?'#cc0000':'#333'}">${macro.signal.toUpperCase()}</div>
            </div>
            <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
              <div style="font-size:9px;color:#555;letter-spacing:1px">CLOSE</div>
              <div style="font-size:18px;font-weight:bold;color:${closes.length?'#cc0000':'#333'}">${closes.length}</div>
            </div>
            <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
              <div style="font-size:9px;color:#555;letter-spacing:1px">WATCH</div>
              <div style="font-size:18px;font-weight:bold;color:${watches.length?'#cc6600':'#333'}">${watches.length}</div>
            </div>
            <div style="flex:1;text-align:center;padding:8px">
              <div style="font-size:9px;color:#555;letter-spacing:1px">HOLD</div>
              <div style="font-size:18px;font-weight:bold;color:#006600">${holds.length}</div>
            </div>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:monospace">
            <tr style="border-bottom:2px solid #333">
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">TICKER</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">CONTRACT</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">DTE</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">P&amp;L</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">ACTION</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">FLAGS</th>
            </tr>
            ${rows}
          </table>
          <div style="border-top:1px solid #ccc;margin-top:12px;padding-top:8px;font-size:10px;color:#555">
            ${macro.triggers && macro.triggers.length ? '<strong>Macro signals:</strong> ' + macro.triggers.join(' - ') + '<br>' : ''}
            <em>These are recommendations only. ARGO-V2.5 will manage exits automatically at open.</em>
          </div>
          <div style="border-top:3px double #333;margin-top:12px;padding-top:8px;text-align:center;font-size:9px;color:#999;letter-spacing:1px">
            ARGO V2.80 - Market opens in ~45 minutes - Entry window 9:30am ET
          </div>
        </div>`
      );
    }
    markDirty();
  } catch(e) { console.error("[PREMARKET] Assessment error:", e.message); }
}

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

// 8:30am ET final assessment (fires at :30 past the hour, checks ET hour = 8)
cron.schedule("30 12,13 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 8 && et.getMinutes() === 30) {
    logEvent("macro", "[DAY PLAN] 8:30am ET final assessment starting...");
    await getAgentDayPlan("8:30am-final");
  }
});

// 8:45am ET pre-market assessment email (fires at :45, checks ET hour = 8)
cron.schedule("45 12,13 * * 1-5", async () => {
  const et = getETTime();
  if (et.getHours() === 8 && et.getMinutes() === 45) {
    await premarketAssessment();
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
    await saveDailyLogToRedis();
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
      "ARGO-V2.5 ALERT - Scanner may be down",
      `<p>ARGO-V2.5 has not scanned in ${minsSinceLastScan.toFixed(0)} minutes during market hours.</p>
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
      `ARGO-V2.5 Monthly Report - ${et.toLocaleDateString("en-US",{month:"long",year:"numeric"})}`,
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
  res.json({
    ...state,
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
    alpacaCircuit: { open: _alpacaCircuitOpen, consecFails: _alpacaConsecFails },
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
    pdtSource:          state._alpacaDayTradeCount !== undefined ? "alpaca" : "internal",
    patternDayTrader:   state._patternDayTrader || false,

    tickerBlacklist:    state.tickerBlacklist || [],
    pdtLimit:           PDT_LIMIT,
    pdtBlocked:         countRecentDayTrades() >= PDT_LIMIT,
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
    macroCalendar:      marketContext.macroCalendar,
    upcomingEvents:     getUpcomingMacroEvents(7),
    regime:             marketContext.regime,
    concentration:      marketContext.concentration,
    stressTest:         marketContext.stressTest,
    drawdownProtocol:   marketContext.drawdownProtocol,
    benchmark:          marketContext.benchmark,
    timeOfDay:          getTimeOfDayAnalysis(),
    monteCarlo:         marketContext.monteCarlo,
    kelly:              marketContext.kelly,
    relativeValue:      marketContext.relativeValue,
    globalMarket:       marketContext.globalMarket,
    streaks:            marketContext.streaks,
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
      spyPrice:            state._liveSPY,
      spy50MA:             state._spyMA50,
      spy200MA:            state._spyMA200,
      regimeDuration:      state._regimeDuration || 0,
      shortDeltaTarget:    _dbRb.spreadParams.shortDeltaTarget,
      targetDTE:           _dbRb.spreadParams.targetDTE,
      minCreditRatio:      _dbRb.spreadParams.minCreditRatio,
      creditOTMpct:        _dbRb.spreadParams.creditOTMpct,
    };

    // Build per-instrument results from scan snapshots
    const snapshots = state._scoreDebug || {};
    const results = WATCHLIST.map(stock => {
      const snap = snapshots[stock.ticker];
      if (!snap) return { ticker: stock.ticker, noData: true };

      const ageSec = Math.round((Date.now() - snap.ts) / 1000);
      const bestScore = Math.max(snap.putScore, snap.callScore);
      const bestType  = snap.putScore >= snap.callScore ? "put" : "call";

      // Reconstruct gate blocks for display
      const blocks = [...(snap.blocked || [])];
      if (isChoppyRegime && !creditModeActive)  blocks.push("choppy regime - debit blocked");
      if (creditModeActive)                      blocks.push("credit put mode active");
      if (creditCallModeActive)                  blocks.push("credit call mode active");
      if (gates.below200MACallBlock)             blocks.push("SPY below 200MA - calls blocked");
      if (gates.macroBullish)                    blocks.push("macro aggressive - puts blocked");
      if (gates.vixFallingPause)                 blocks.push("VIX falling - puts paused");
      if (avoidHoldActive)                       blocks.push(`avoid hold until ${avoidUntilStr}`);

      const instrConstraint = INSTRUMENT_CONSTRAINTS[stock.ticker] || null;
      return {
        ticker:      stock.ticker,
        price:       snap.price,
        ageSec,
        putScore:    snap.putScore,
        callScore:   snap.callScore,
        bestScore,
        bestType,
        effectiveMin: snap.effectiveMin,
        wouldEnter:  blocks.length === 0 || (blocks.length === 1 && (blocks[0].includes("credit") && bestScore >= snap.effectiveMin)),
        blocks,
        constraint:  instrConstraint ? `${instrConstraint.allowedTypes.join("/")} only${instrConstraint.reason ? " - " + instrConstraint.reason : ""}` : null,
        putReasons:  snap.putReasons  || [],
        callReasons: snap.callReasons || [],
        signals:     snap.signals     || {},
      };
    });

    res.json({
      timestamp:   new Date().toISOString(),
      lastScan:    state.lastScan,
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
  const limit  = Math.min(parseInt(req.query.limit || 100), 200);
  const filter = req.query.filter || null; // e.g. ?filter=trade,warn,circuit
  const since  = req.query.since  || null; // ISO timestamp - only return newer
  const types  = filter ? filter.split(",").map(t => t.trim().toLowerCase()) : null;
  let logs = state.tradeLog || [];
  if (since) {
    const sinceMs = new Date(since).getTime();
    logs = logs.filter(e => new Date(e.time).getTime() > sinceMs);
  }
  if (types) logs = logs.filter(e => types.includes(e.type));
  res.json({
    logs:      logs.slice(0, limit),
    total:     (state.tradeLog || []).length,
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
      if (!data.result) return res.status(404).json({ error: `No log found for ${date}` });
      const parsed = JSON.parse(data.result);
      const filter = req.query.filter;
      const limit  = Math.min(parseInt(req.query.limit || 500), 2000);
      const types  = filter ? filter.split(",").map(t => t.trim().toLowerCase()) : null;
      let entries  = parsed.entries || [];
      if (types) entries = entries.filter(e => types.includes(e.type));
      res.json({ date, entries: entries.slice(0, limit), summary: parsed.summary });
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

app.post("/api/scan",        async (req,res) => { res.json({ok:true}); runScan(); });

// - Test scan - forces a dry run scan regardless of market hours or day -
// Use this after-hours to verify scoring, filter logic, and exit checks
// Automatically re-disables dry run after the scan completes
app.post("/api/test-scan", async (req, res) => {
  if (scanRunning) return res.json({ error: "Scan already running" });
  const wasDryRun = dryRunMode;
  dryRunMode = true;
  res.json({ ok: true, message: "Test scan started - dry run forced for this cycle. Check /api/logs for results." });
  try {
    await runScan();
  } finally {
    if (!wasDryRun) dryRunMode = false; // restore previous state
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
      `ARGO-V2.5 Email Test - ${new Date().toLocaleTimeString()}`,
      `<div style="font-family:monospace;background:#07101f;color:#00ff88;padding:20px;border-radius:8px">
        <h2>- ARGO-V2.5 Email Working</h2>
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
  while (scanRunning && waited < 35000) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }
  if (scanRunning) return res.json({ error: "Scan still running after 35s - try again" });
  dryRunMode = true;
  logEvent("scan", "- DRY RUN SCAN STARTED -");
  try {
    await runScan();
  } finally {
    dryRunMode = false;
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
  logEvent("circuit", "Circuit breaker manually reset - resuming normal operations");
  res.json({ ok: true, cash: state.cash, positions: state.positions.length });
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
  state = defaultState();
  await saveStateNow();
  logEvent("reset", "FULL RESET - state wiped, starting fresh with $10,000");
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
    marketContext,
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
app.get("/api/journal",      (req,res) => res.json(state.tradeJournal.slice(0,50)));
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
function calcDrawdownDuration() {
  const trades = state.closedTrades || [];
  if (!trades.length) return { avgDuration: 0, maxDuration: 0, currentDuration: 0 };
  let maxDuration = 0, currentDuration = 0, totalDuration = 0, ddCount = 0;
  let peak = 0, running = 0, inDD = false;
  trades.forEach(t => {
    running += (t.pnl||0);
    if (running > peak) {
      if (inDD && currentDuration > 0) { totalDuration += currentDuration; ddCount++; }
      peak = running; inDD = false; currentDuration = 0;
    } else {
      inDD = true; currentDuration++;
      maxDuration = Math.max(maxDuration, currentDuration);
    }
  });
  if (inDD && currentDuration > 0) { totalDuration += currentDuration; ddCount++; }
  const avgDuration = ddCount > 0 ? parseFloat((totalDuration / ddCount).toFixed(1)) : 0;
  return { avgDuration, maxDuration, currentDuration: inDD ? currentDuration : 0 };
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
function calcRiskOfRuin() {
  const trades = state.closedTrades || [];
  if (trades.length < 5) return { probability: 0, message: `Need ${5 - trades.length} more trades for estimate` };
  const wins  = trades.filter(t => (t.pnl||0) > 0).length;
  const losses = trades.length - wins;
  const wr    = wins / trades.length;
  if (wr === 0) return { probability: 99.9, message: "No winning trades yet" };
  if (wr === 1) return { probability: 0.0,  message: "100% win rate (small sample)" };
  const avgW = trades.filter(t=>(t.pnl||0)>0).reduce((s,t)=>s+(t.pnl||0),0) / Math.max(wins,1);
  const avgL = Math.abs(trades.filter(t=>(t.pnl||0)<=0).reduce((s,t)=>s+(t.pnl||0),0)) / Math.max(losses,1);
  const edge = wr * avgW - (1-wr) * avgL;
  if (edge <= 0) return { probability: 99.9, message: "Negative edge - review strategy" };
  // Risk of ruin formula: ((1-wr)/wr)^(capital/avgL)
  // Simplified: use 10 unit approximation
  const ratio = (1 - wr) / wr;
  const ror   = Math.min(99.9, parseFloat((Math.pow(ratio, 10) * 100).toFixed(1)));
  const msg   = ror < 1   ? "Excellent - very low ruin risk"
              : ror < 5   ? "Good - manageable risk profile"
              : ror < 20  ? "Moderate - watch position sizing"
              : ror < 50  ? "High - reduce size or improve edge"
              : "Critical - strategy needs review";
  return { probability: isNaN(ror) ? 0 : ror, message: msg };
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


async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} received - saving state before exit`);

  // Stop accepting new scans
  scanRunning = true; // prevents new scan from starting

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
  app.listen(PORT, () => {
    console.log(`ARGO V2.80 running on port ${PORT}`);
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
});

// -
// ARGO V2.80 - BACKTESTING ENGINE
// Walk-forward simulation using Alpaca historical daily bars
// Replays ARGO's scoring logic against historical data without real orders
// QS-W2/GL-1: Addresses the out-of-sample validation gap identified by panel
// -

async function fetchHistoricalBars(ticker, startDate, endDate) {
  // Fetch a large window of daily bars between two dates
  try {
    const feeds = ["sip", "iex"];
    for (const feed of feeds) {
      const url  = `/stocks/${ticker}/bars?timeframe=1Day&start=${startDate}&end=${endDate}&limit=1000&feed=${feed}`;
      const data = await alpacaGet(url, ALPACA_DATA);
      if (data && data.bars && data.bars.length > 5) return data.bars;
    }
    const last = await alpacaGet(`/stocks/${ticker}/bars?timeframe=1Day&start=${startDate}&end=${endDate}&limit=1000`, ALPACA_DATA);
    return last && last.bars ? last.bars : [];
  } catch(e) {
    logEvent("warn", `[BACKTEST] fetchHistoricalBars failed for ${ticker}: ${e.message}`);
    return [];
  }
}

function backtestScoreSignal(bars, idx, optionType) {
  // Replay ARGO's scoring signals from a slice of historical bars
  // Returns score + reasons using the same calcRSI/calcMACD/calcATR functions
  if (idx < 26) return { score: 0, reasons: ["insufficient history"] };
  const slice = bars.slice(0, idx + 1); // bars up to and including today
  const rsi   = calcRSI(slice);
  const macd  = calcMACD(slice);
  const atrRaw = calcATR(slice, 14);
  const price  = slice[slice.length - 1].c;
  const atrPct = atrRaw ? atrRaw / price : 0.01;

  let score   = 50; // base
  const reasons = [];

  // RSI signal
  if (optionType === "put") {
    if (rsi >= 70)       { score += 20; reasons.push(`RSI ${rsi.toFixed(0)} overbought (+20)`); }
    else if (rsi >= 60)  { score += 10; reasons.push(`RSI ${rsi.toFixed(0)} elevated (+10)`); }
    else if (rsi <= 35)  { return { score: 0, reasons: [`RSI ${rsi.toFixed(0)} oversold - HARD BLOCK`] }; }
    else if (rsi <= 39)  { score -= 15; reasons.push(`RSI ${rsi.toFixed(0)} deeply oversold for puts (-15)`); }
    else if (rsi <= 45)  { score -= 8;  reasons.push(`RSI ${rsi.toFixed(0)} recovering from oversold (-8)`); }
    else                 { reasons.push(`RSI ${rsi.toFixed(0)} neutral`); }
  } else {
    if (rsi <= 35)       { score += 25; reasons.push(`RSI ${rsi.toFixed(0)} extreme oversold - MR call (+25)`); }
    else if (rsi <= 45)  { score += 12; reasons.push(`RSI ${rsi.toFixed(0)} oversold dip (+12)`); }
    else if (rsi >= 70)  { score -= 15; reasons.push(`RSI ${rsi.toFixed(0)} overbought for calls (-15)`); }
    else                 { reasons.push(`RSI ${rsi.toFixed(0)} neutral`); }
  }

  // MACD signal
  if (optionType === "put") {
    if (macd.signal.includes("bearish crossover"))  { score += 15; reasons.push("MACD bearish crossover (+15)"); }
    else if (macd.signal.includes("bearish"))       { score += 8;  reasons.push("MACD bearish (+8)"); }
    else if (macd.signal.includes("bullish crossover")) { score -= 12; reasons.push("MACD bullish crossover (-12)"); }
    else if (macd.signal.includes("bullish"))       { score -= 6;  reasons.push("MACD bullish (-6)"); }
  } else {
    if (macd.signal.includes("bullish crossover"))  { score += 15; reasons.push("MACD bullish crossover (+15)"); }
    else if (macd.signal.includes("bullish"))       { score += 8;  reasons.push("MACD bullish (+8)"); }
    else if (macd.signal.includes("bearish crossover")) { score -= 12; reasons.push("MACD bearish crossover (-12)"); }
    else if (macd.signal.includes("bearish"))       { score -= 6;  reasons.push("MACD bearish (-6)"); }
  }

  // Momentum
  const recent5  = (slice[slice.length-1].c - slice[slice.length-6].c) / slice[slice.length-6].c;
  const recent20 = slice.length >= 21 ? (slice[slice.length-1].c - slice[slice.length-21].c) / slice[slice.length-21].c : 0;
  if (optionType === "put") {
    if (recent5 < -0.01 && recent20 < -0.02) { score += 15; reasons.push(`Weak momentum (${(recent5*100).toFixed(1)}% 5d) (+15)`); }
    else if (recent5 > 0.01)                 { score -= 10; reasons.push(`Strong momentum - wrong for puts (-10)`); }
  } else {
    if (recent5 > 0.01 && recent20 > 0.02)   { score += 15; reasons.push(`Strong momentum (${(recent5*100).toFixed(1)}% 5d) (+15)`); }
    else if (recent5 < -0.01)                { score -= 10; reasons.push(`Weak momentum - wrong for calls (-10)`); }
  }

  // ATR normalization - penalize chasing extended moves
  const todayMove = Math.abs(slice[slice.length-1].c - slice[slice.length-2].c) / slice[slice.length-2].c;
  if (atrPct > 0 && todayMove > atrPct * 2) {
    score -= 10; reasons.push(`Move ${(todayMove*100).toFixed(1)}% > 2x ATR ${(atrPct*100).toFixed(1)}% - extended (-10)`);
  }

  // BT-3: Agent score simulation - closes the gap between backtest and live scores
  // Live ARGO gets +25-35 pts from Claude agent at high confidence. Backtest approximates
  // using technical regime signals the agent would be reading.
  const sma20 = slice.slice(-20).reduce((s,b) => s + b.c, 0) / 20;
  const sma50 = slice.length >= 50 ? slice.slice(-50).reduce((s,b) => s + b.c, 0) / 50 : sma20;
  const mom20 = slice.length >= 21 ? (price - slice[slice.length-21].c) / slice[slice.length-21].c * 100 : 0;
  const adxProxy = Math.abs(mom20) * 2 + (atrPct * 100);
  let agentBonus = 0;
  let agentRegime = "neutral";
  if (price < sma20 && sma20 < sma50 && mom20 < -2) {
    agentRegime = "trending_bear";
    // Raised from -20 to -25 - live agent reads news/VIX and gives high-confidence calls
    // worth +30-35; +25 is a more accurate approximation than +20
    agentBonus = optionType === "put" ? 25 : -25;
  } else if (price > sma20 && sma20 > sma50 && mom20 > 2) {
    agentRegime = "trending_bull";
    agentBonus  = optionType === "call" ? 25 : -25;
  } else if (Math.abs(mom20) < 1) {
    agentRegime = "choppy";
    // Neutral - no bonus or penalty. Let RSI/MACD/momentum signals carry the score.
    // Choppy markets (2023) still have valid high-signal entries; the agent is just
    // less directionally confident, not blocking. Only high-signal days (RSI extreme
    // + MACD crossover + weak/strong momentum) will clear 75+ unaided.
    agentBonus = 0;
  }
  if (agentBonus !== 0) {
    score += agentBonus;
    reasons.push(`~Agent ${agentRegime} simulation (${agentBonus > 0 ? '+' : ''}${agentBonus})`);
  }

  return { score: Math.max(0, Math.min(100, score)), reasons, agentRegime };
}

function simulateOptionPnL(entryPrice, optionType, holdDays, outcome, ticker = "SPY", vixEst = 20) {
  // Simulate option P&L based on underlying price change
  // Uses realistic delta-based approximation with theta decay
  // outcome: { priceDelta (%), vixShift, daysToExpiry }
  const { priceDelta, daysToExpiry = 21, vixShift = 0 } = outcome;

  // Delta approximation: ATM delta ~0.50, shifts with price
  const baseDelta  = optionType === "call" ? 0.45 : -0.45;
  const deltaValue = baseDelta * priceDelta * entryPrice; // $ move in option

  // Theta decay: daily theta - premium / (2 * DTE) for ATM options
  const dailyTheta = entryPrice / (2 * Math.max(daysToExpiry, 7));
  const thetaLoss  = dailyTheta * holdDays;

  // Vega shift: VIX up = calls hurt, puts benefit (simplified)
  const vegaImpact = vixShift * entryPrice * 0.05 * (optionType === "call" ? -1 : 1);

  // BT-1: Slippage model - VIX-scaled realistic fill cost
  // Based on observed live options spreads at different volatility regimes
  // Applied at both entry AND exit (round-trip cost)
  const slippagePct = vixEst >= 30 ? 0.07   // VIX 30+: wide spreads, chaotic markets
                    : vixEst >= 20 ? 0.04   // VIX 20-30: moderate spread widening
                    :                0.02;  // VIX < 20: tight spreads, liquid
  const slippageCost = entryPrice * slippagePct; // applied as $ reduction to entry premium

  // BT-2: Bid-ask spread cost - instrument-specific, applied at entry
  // Based on typical SPY/QQQ/IWM/GLD options market width
  const spreadCost = ticker === "GLD" ? 0.20
                   : ticker === "TLT" ? 0.18  // bond ETF - moderate liquidity
                   : ticker === "QQQ" ? 0.12
                   :                   0.08; // SPY - most liquid

  // Total transaction cost: slippage + half bid-ask spread (we pay on entry, receive on exit)
  // Round-trip: slippage - 2 (entry + exit), spread - 1 (net cost of crossing spread)
  const totalTxCost = (slippageCost * 2) + spreadCost;

  const pnlRaw = (deltaValue - thetaLoss + vegaImpact);
  const pnlNet = pnlRaw - totalTxCost; // deduct realistic transaction costs
  const pnlPct = pnlNet / entryPrice;

  return Math.max(-0.95, Math.min(2.0, pnlPct)); // cap at -95% to +200%
}

// - V2.80 Spread P&L Simulator -
// Debit spread: buy ATM, sell OTM - capped loss (net debit) and capped profit (width - debit)
// Credit spread: sell OTM, buy further OTM - capped profit (net credit) and capped loss (width - credit)
// This is fundamentally different from single-leg option P&L.
// Panel requirement: backtest must use spread structure, not naked option approximation.
function simulateSpreadPnL(netDebit, spreadWidth, optionType, tradeType, holdDays, priceDeltaPct, vixEst = 20, ticker = "SPY") {
  // Spread economics (dollar terms, per contract):
  // Debit spread: paid netDebit upfront. Max profit = spreadWidth - netDebit. Max loss = netDebit.
  // Credit spread: received netCredit. Max profit = netCredit. Max loss = spreadWidth - netCredit.
  // P&L is expressed as fraction of netDebit so it can be compared to takeProfitPct/stopLossPct.
  const isCredit  = tradeType === "credit";
  const maxProfit = isCredit ? netDebit : (spreadWidth - netDebit);
  const maxLoss   = isCredit ? (spreadWidth - netDebit) : netDebit;

  // Directed move: positive = favorable for the option type
  // Puts benefit from underlying falling, calls from rising
  const directedMove = optionType === "put" ? -priceDeltaPct : priceDeltaPct;

  // Spread value change: how much the spread moves in dollar terms
  // Net delta of ATM/OTM debit spread - 0.15
  // At full max move (15%+), spread reaches its maximum value
  const moveMagnitude = Math.min(Math.abs(directedMove), 0.15);
  const spreadValueChange = (moveMagnitude / 0.15) * spreadWidth; // $0 - $spreadWidth

  // Theta decay: daily cost of holding a debit spread (enemy) or benefit (credit)
  const dailyTheta  = netDebit / (2 * Math.max(21 - holdDays, 5));
  const thetaImpact = isCredit ? (dailyTheta * holdDays) : -(dailyTheta * holdDays);

  // Transaction costs: slippage (entry + exit round-trip) + bid-ask (two legs)
  const slippagePerLeg = vixEst >= 30 ? 0.06 : vixEst >= 20 ? 0.04 : 0.02;
  const legSpreadCost  = ticker === "SPY" ? 0.05 : ticker === "QQQ" ? 0.07 : 0.10;
  const totalTxCost    = (slippagePerLeg * 2) + legSpreadCost;

  // Gross P&L in dollar terms (before tx costs)
  // KEY FIX: spreadValueChange is the $ GAIN in spread value vs 0 baseline.
  // The cost basis (netDebit) is already captured in positionCost - do NOT subtract here.
  let grossPnL;
  if (isCredit) {
    // Credit spread: we keep credit as price moves away from short strike
    if (directedMove >= 0) {
      grossPnL = Math.min(maxProfit, maxProfit * (moveMagnitude / 0.08));
    } else {
      grossPnL = Math.max(-maxLoss, -maxLoss * (moveMagnitude / 0.08));
    }
    grossPnL += thetaImpact;
  } else {
    // Debit spread: spread gains value as underlying moves in our direction
    // Favorable: spread value increases from ~0 toward max profit
    // Unfavorable: spread value erodes from netDebit toward 0
    if (directedMove > 0) {
      // Favorable - spread gains value proportional to move, capped at maxProfit
      grossPnL = Math.min(maxProfit, spreadValueChange);
    } else {
      // Unfavorable - spread loses value proportional to move, max loss = netDebit
      grossPnL = Math.max(-maxLoss, -(maxLoss * (moveMagnitude / 0.15)));
    }
    grossPnL += thetaImpact;
  }

  const netPnL = grossPnL - totalTxCost;
  // Return as fraction of netDebit for comparison with takeProfitPct/stopLossPct
  // Capped at theoretical bounds: -1.0 (lose all) to maxProfit/netDebit (max profit multiple)
  return Math.max(-(maxLoss / netDebit), Math.min(maxProfit / netDebit, netPnL / netDebit));
}

// - V2.80 Regime B Scoring -
// Adds regime classification to backtest scoring - mirrors live ARGO's regime logic.
// Regime A (bull): SMA20 > SMA50, price > SMA20, positive momentum - calls favored
// Regime B (bear): price < SMA50, SMA20 < SMA50, negative momentum - puts on bounces
// Regime C (crisis): price < SMA200, sustained VIX > 35 - credit only
// Returns regime class + suggested trade type for backtest routing.
function backtestClassifyRegime(bars, idx, vixEst) {
  const slice  = bars.slice(0, idx + 1);
  const price  = slice[slice.length - 1].c;
  const sma20  = slice.length >= 20  ? slice.slice(-20).reduce((s,b)=>s+b.c,0)/20  : price;
  const sma50  = slice.length >= 50  ? slice.slice(-50).reduce((s,b)=>s+b.c,0)/50  : price;
  const sma200 = slice.length >= 200 ? slice.slice(-200).reduce((s,b)=>s+b.c,0)/200 : price;
  const mom5   = slice.length >= 5   ? (price - slice[slice.length-5].c)/slice[slice.length-5].c*100 : 0;
  const mom20  = slice.length >= 20  ? (price - slice[slice.length-20].c)/slice[slice.length-20].c*100 : 0;

  // RSI for bounce detection
  const rsi = calcRSI(slice);

  let regimeClass = "A";
  let entryBias   = "neutral";
  let tradeType   = "spread";

  if (vixEst >= 35 && price < sma200) {
    regimeClass = "C"; entryBias = "puts_on_bounces"; tradeType = "credit";
  } else if (price < sma50 && (sma20 < sma50 || mom20 < -1)) {
    // Fix 4: loosened from (sma20<sma50 AND mom20<-2) - captures developing downtrends
    // where SMA20 hasn't crossed below SMA50 yet but momentum is already negative
    regimeClass = "B"; entryBias = "puts_on_bounces"; tradeType = "spread";
  } else if (price > sma20 && sma20 > sma50 && mom20 > 2) {
    regimeClass = "A"; entryBias = "calls_on_dips"; tradeType = "spread";
  } else {
    regimeClass = "A"; entryBias = "neutral"; tradeType = "spread";
  }

  // Fix 1: Widened bounce detection window
  // Old: RSI 45-65 AND mom5 > 0
  // New: RSI 38-72 AND mom5 > -2.0%
  // RSI 38-44: recovering from oversold = valid entry (stock bouncing back up)
  // RSI 66-72: overbought relief bounce = valid put entry (chasing rally)
  // mom5 > -2%: allows slight downward pressure, not requiring a full positive day
  const isBounce = regimeClass !== "A" && rsi >= 38 && rsi <= 72 && mom5 > -2.0 && mom20 < 0;
  const isPutsOnBounces = (regimeClass === "B" || regimeClass === "C") && isBounce;

  return { regimeClass, entryBias, tradeType, sma20, sma50, sma200, mom5, mom20, rsi, isBounce, isPutsOnBounces };
}

async function runBacktest(config) {
  try {
  const {
    ticker     = "SPY",
    optionType = "put",
    startDate,
    endDate,
    minScore      = 70,
    holdDays      = 5,
    takeProfitPct = 0.50,
    stopLossPct   = 0.35,
    capital       = 10000,
    putOnly       = false,   // puts-only mode - blocks all call entries
    callSizeMult  = 1.0,     // asymmetric sizing: calls at reduced fraction (e.g. 0.5 = half size)
    useSpread     = true,    // V2.80: simulate spread P&L (capped r/r) not naked option
    useRegimeB    = true,    // V2.80: apply regime classification to scoring and trade routing
    spreadWidth   = null,    // null = VIX-scaled auto (10/15/20), or fixed dollar width
  } = config;

  const bothMode = optionType === "both";
  const modeLabel = putOnly ? "PUTS-ONLY" : bothMode ? "PUTS+CALLS" : optionType;
  const v275tag = useSpread ? "[SPREAD]" : "[NAKED]";
  logEvent("scan", `[BACKTEST] Starting: ${ticker} ${modeLabel} ${v275tag} ${startDate}-${endDate} minScore:${minScore} capital:$${capital}${callSizeMult < 1 ? ` callSize:${callSizeMult}x` : ""}`);

  // Fetch primary + auxiliary bars (SPY + UUP for gate simulation)
  // SPY bars needed for TLT gate (50MA) and GLD gate (5d return)
  // UUP bars needed for GLD DXY gate (dollar strength)
  // Fetch SPY/UUP with 300-day lookback so 200MA is valid from the start of the date range
  // Without this, the first ~175 bars of any single-year run have no 200MA data
  const extStartDate = new Date(startDate);
  extStartDate.setDate(extStartDate.getDate() - 300);
  const extStart = extStartDate.toISOString().split('T')[0];

  const [bars, spyAux, uupAux] = await Promise.all([
    fetchHistoricalBars(ticker, startDate, endDate),
    (ticker !== "SPY") ? fetchHistoricalBars("SPY", extStart, endDate) : Promise.resolve([]),
    (ticker === "GLD") ? fetchHistoricalBars("UUP", extStart, endDate) : Promise.resolve([]),
  ]);
  // For SPY runs, also fetch extended history for 200MA gate
  // spyAux already has extended history for non-SPY tickers
  const spyBarsExtended = ticker === "SPY" ? await fetchHistoricalBars("SPY", extStart, endDate) : spyAux;
  const spyBarsAux = spyBarsExtended;

  // Calculate how many extra pre-period bars are in spyBarsAux
  // These are used for 200MA lookback but NOT for aligning current-day SPY price
  // spyBarsAux covers extStart-endDate; bars covers startDate-endDate
  // The offset is how many SPY bars fall before startDate
  const spyExtendedOffset = spyBarsAux.length - (ticker === "SPY" ? bars.length : bars.length);
  // For non-SPY tickers: spyBarsAux has ~(bars.length + ~218 extended) bars
  // We need to align so that spySlice[i] corresponds to the same calendar date as bars[i]

  if (bars.length < 30) {
    return { error: `Insufficient data: only ${bars.length} bars fetched for ${ticker} ${startDate}-${endDate}` };
  }
  // Warn if SPY auxiliary bars are fewer than primary bars (alignment assumption breaks)
  if (spyBarsAux.length < bars.length) {
    logEvent("warn", `[BACKTEST] SPY aux bars (${spyBarsAux.length}) < ${ticker} bars (${bars.length}) - SPY data gap, alignment may be off`);
  }

  const { maxPositions = 3 } = config;

  const trades    = [];
  let cash        = capital;
  let peakCash    = capital;
  let maxDrawdown = 0;
  let maxDrawdownDuration = 0; // days in drawdown - behavioral context
  let drawdownStartDay = -1;
  const equityCurve = [{ date: bars[26]?.t?.split("T")[0] || startDate, value: capital }];
  const openBT = [];

  // BT-7: Spiral - independent per direction
  const btSpiral = { put: 0, call: 0 };
  const btSpiralBlocked = { put: false, call: false };
  const SPIRAL_THRESHOLD = 5;
  let spiralBlockCount = 0;

  // Phase 1: Gate skip tracking
  const gateSkips = { dxy: 0, spy5d: 0, vix: 0, tltSpy50: 0, gldRSI: 0, gldPutDxy: 0 };

  // Phase 2: Additional metrics
  let maxConsecLosses = { put: 0, call: 0 };
  let currentConsec   = { put: 0, call: 0 };
  const monthlyPnL    = {}; // "YYYY-MM" - pnl
  let totalHoldDays   = 0;
  let vixBuckets      = { low: {t:0,w:0}, medium: {t:0,w:0}, high: {t:0,w:0}, extreme: {t:0,w:0} };

  // Walk forward - skip first 26 bars (need for MACD)
  for (let i = 26; i < bars.length - holdDays; i++) {
    try {
    const bar      = bars[i];
    const barDate  = bar.t?.split("T")[0] || `day-${i}`;
    const price    = bar.c;

    // - Phase 1: Compute gate inputs from auxiliary bars at this index -
    // SPY 5-day return and 50MA for TLT gate and GLD gate
    // spyBarsAux has pre-period history prepended for 200MA computation
    // For current SPY price/momentum we want the bar aligned with bars[i] by date
    // Strategy: use the tail of spyBarsAux aligned to the end of the period
    // spyBarsAux.length >= bars.length always; the extra bars are at the start
      // Guard: spyBarsAux must be at least as long as bars. If not (data gap), skip offset.
    const spyTailOffset = Math.max(0, spyBarsAux.length - bars.length);
    const spySlice = spyBarsAux.slice(0, spyTailOffset + i + 1);
    const spy5d    = spySlice.length >= 5
      ? (spySlice[spySlice.length-1].c - spySlice[spySlice.length-5].c) / spySlice[spySlice.length-5].c
      : 0;
    const spy50MA  = spySlice.length >= 50
      ? spySlice.slice(-50).reduce((s,b) => s + b.c, 0) / 50
      : 0;
    const spyPrice = spySlice.length ? spySlice[spySlice.length-1].c : 0;

    // UUP (DXY proxy) 5-day return for GLD gate
    const uupSlice = uupAux.slice(0, Math.min(i + 1, uupAux.length));
    const uup5d    = uupSlice.length >= 5
      ? (uupSlice[uupSlice.length-1].c - uupSlice[uupSlice.length-5].c) / uupSlice[uupSlice.length-5].c * 100
      : 0;
    // UUP moves ~65% of DXY - adjust threshold proportionally (0.8% DXY - 0.5% UUP)
    const dxyProxy = { change: uup5d, trend: uup5d > 0.5 ? "strengthening" : uup5d < -0.5 ? "weakening" : "neutral" };

    // GLD RSI at this bar for put gate
    const btRSI = calcRSI(bars.slice(0, i + 1));

    // vixEst - needed for regime classification AND gate section below
    // Compute early so both can use it without duplication
    const atrEarlyPre = calcATR(bars.slice(Math.max(0, i-14), i+1), 14) || price * 0.01;
    const vixEst      = Math.min(50, Math.max(15, (atrEarlyPre / price) * 100 * 16));

    // "both" mode: score both directions, enter the better one
    let entryType = optionType;
    let entryScore, entryReasons;
    if (bothMode) {
      const putResult  = backtestScoreSignal(bars, i, "put");
      const callResult = !putOnly ? backtestScoreSignal(bars, i, "call") : { score: 0, reasons: [] };
      if (putResult.score >= callResult.score && putResult.score >= minScore) {
        entryType = "put"; entryScore = putResult.score; entryReasons = putResult.reasons;
      } else if (!putOnly && callResult.score > putResult.score && callResult.score >= minScore) {
        entryType = "call"; entryScore = callResult.score; entryReasons = callResult.reasons;
      } else {
        continue;
      }
    } else {
      const result = backtestScoreSignal(bars, i, optionType);
      entryScore = result.score; entryReasons = result.reasons;
      if (entryScore < minScore) continue;
    }

    let score   = entryScore;
    const reasons = entryReasons;

    // - V2.80: Regime classification - mirrors live ARGO regime B logic -
    const regime = useRegimeB ? backtestClassifyRegime(bars, i, vixEst) : null;
    if (regime && useRegimeB) {
      // - ENTRY BIAS GATE - enforced as hard filter, not just score modifier -
      // Live ARGO's entryBias field gates entries: puts_on_bounces means
      // ONLY enter puts when price has bounced (RSI 45-65, short-term recovery).
      // Entering puts into a fresh crash (RSI < 40) or after an exhausted bounce
      // (RSI > 68) is the wrong timing - these are the entries that stop out fast.
      // This is the single most important missing feature from the prior backtest.
      if (regime.regimeClass === "B" || regime.regimeClass === "C") {
        if (entryType === "put" && !regime.isPutsOnBounces) {
          // Not a valid bounce entry - skip
          // Allow exception: RSI >= 68 (genuinely overbought on bounce = valid put)
          const rsiOverbought = btRSI >= 68;
          if (!rsiOverbought) {
            if (!gateSkips["bounceGate"]) gateSkips["bounceGate"] = 0;
            gateSkips["bounceGate"]++;
            continue;
          }
        }
      }
      if (regime.regimeClass === "A") {
        if (entryType === "call") {
          // Fix 2: Widened dipGate - RSI 59-65 in bull market IS a valid dip
          // Old: RSI <= 42 OR RSI 43-58 (blocked RSI 59-67)
          // New: RSI <= 65 - only block clearly overbought (RSI > 65 = chasing)
          const isValidCallEntry = btRSI <= 65;
          if (!isValidCallEntry) {
            if (!gateSkips["dipGate"]) gateSkips["dipGate"] = 0;
            gateSkips["dipGate"]++;
            continue;
          }
        }
      }

      // Regime B bounce bonus - kept for scoring but no longer the only gate
      if (regime.regimeClass === "B" && entryType === "put" && regime.isPutsOnBounces) {
        score = Math.min(100, score + 8);
        reasons.push(`~Regime B bounce entry (+8)`);
      }
      // Regime B: calls only allowed as MR (RSI < 40)
      if (regime.regimeClass === "B" && entryType === "call" && btRSI > 55) {
        score = Math.max(0, score - 10);
        reasons.push(`~Regime B - calls need RSI <55 (-10)`);
      }
      if (score < minScore) continue;
    }
    if (btSpiralBlocked[entryType]) { spiralBlockCount++; continue; }

    // - Phase 1: Apply instrument-specific entry gates -
    // vixEst already computed above (before regime classification)

    if (ticker === "GLD") {
      // Compute GLD 20MA for backtest gate
      const gldMA20bt = bars.length >= 20
        ? bars.slice(Math.max(0,i-19), i+1).reduce((s,b) => s + b.c, 0) / Math.min(20, i+1)
        : 0;
      const gldGate = isGLDEntryAllowed(entryType, dxyProxy, spy5d, vixEst, btRSI, price, gldMA20bt);
      if (!gldGate.allowed) {
        if (dxyProxy.trend === "strengthening") gateSkips.dxy++;
        else if (spy5d > 0.015) gateSkips.spy5d++;
        else if (vixEst < 20) gateSkips.vix++;
        else if (btRSI < 68 && entryType === "put") gateSkips.gldRSI++;
        else gateSkips.gldPutDxy++;
        continue;
      }
      // GLD min score 75 (lowered from 80 - panel decision)
      if (score < 75) continue;
    }
    // Compute SPY 200MA once - used by both TLT gate and 200MA regime filter
    // Need full 200-bar history; if insufficient, use available bars (rolling)
    // For single-year runs (252 bars), we fetch auxiliary SPY bars back further
    const spy200MAbt = spySlice.length >= 200
      ? spySlice.slice(-200).reduce((s,b) => s + b.c, 0) / 200
      : (spySlice.length >= 50 ? spySlice.reduce((s,b) => s + b.c, 0) / spySlice.length : 0);

    if (ticker === "TLT") {
      const tltGate = isTLTEntryAllowed(entryType, spyPrice, spy50MA, spy5d, spy200MAbt, null, null);
      if (!tltGate.allowed) { gateSkips.tltSpy50++; continue; }
    }

    // XLE gate - oil trend via 20MA, RSI extremes
    if (ticker === "XLE") {
      const xleMA20bt = bars.length >= 20
        ? bars.slice(Math.max(0,i-19), i+1).reduce((s,b) => s + b.c, 0) / Math.min(20, i+1)
        : 0;
      const xleGate = isXLEEntryAllowed(entryType, btRSI, null, vixEst, price, xleMA20bt);
      if (!xleGate.allowed) {
        if (!gateSkips["xleOilTrend"]) gateSkips["xleOilTrend"] = 0;
        gateSkips["xleOilTrend"]++;
        continue;
      }
    }

    // - 200MA regime filter - mirrors live ARGO behavior -
    // When SPY is below its 200MA: block calls entirely, require 80+ for puts
    // Uses the same spy200MAbt computed above - no duplicate computation
    const btSpyBelow200MA = spy200MAbt > 0 && spyPrice < spy200MAbt;
    if (btSpyBelow200MA) {
      if (entryType === "call") {
        // Block calls entirely in bear regime - same as live system
        if (!gateSkips["200maCall"]) gateSkips["200maCall"] = 0;
        gateSkips["200maCall"]++;
        continue;
      }
      // Fix 3: Puts need 75+ when below 200MA (was 80+)
      // The live system uses agent macro as the primary gate, not 200MA score floor
      // 80+ was blocking the highest-conviction bear market entries at score 75-79
      if (score < 75) {
        if (!gateSkips["200maPutMin"]) gateSkips["200maPutMin"] = 0;
        gateSkips["200maPutMin"]++;
        continue;
      }
    }

    // Estimate option premium using already-computed vixEst from gate section above
    const premiumPct = (vixEst / 100) * Math.sqrt(holdDays / 252) * 0.8; // simplified BSM
    const entryPrem  = parseFloat((price * premiumPct).toFixed(2));
    const minPrem = Math.max(0.10, price * 0.003);
    if (entryPrem < minPrem) continue; // too cheap to trade

    // V2.80 spread parameters - net debit -35% of spread width (stays within 40% r/r rule)
    const btSpreadWidth  = spreadWidth || (vixEst >= 35 ? 20 : vixEst >= 25 ? 15 : 10);
    const btNetDebit     = useSpread ? parseFloat((btSpreadWidth * 0.33).toFixed(2)) : entryPrem;
    const isRegimeCCredit = regime && regime.regimeClass === "C";
    const btTradeType    = isRegimeCCredit ? "credit" : "debit";

    // Asymmetric sizing - spread uses net debit as cost basis
    const sizeMult     = entryType === "call" ? callSizeMult : 1.0;
    const positionCost = useSpread
      ? parseFloat((btNetDebit * 100 * sizeMult).toFixed(2))
      : parseFloat((entryPrem  * 100 * sizeMult).toFixed(2));
    if (positionCost > cash * 0.20) continue; // max 20% per position

    // Settle expired open positions before checking capacity
    for (let j = openBT.length - 1; j >= 0; j--) {
      const op = openBT[j];
      if (i >= op.expiryIdx) {
        const exitBar2 = bars[Math.min(op.expiryIdx, bars.length-1)];
        const pd2 = (exitBar2.c - bars[op.entryIdx].c) / bars[op.entryIdx].c;
        let pnl2;
        if (op.useSpread) {
          pnl2 = simulateSpreadPnL(op.btNetDebit, op.btSpreadWidth, op.entryType, op.btTradeType,
            op.expiryIdx - op.entryIdx, pd2, op.vixEst || 20, ticker);
        } else {
          const dd2 = op.entryType === "put" ? -pd2 : pd2;
          pnl2 = simulateOptionPnL(op.entryPrem, op.entryType, op.expiryIdx - op.entryIdx,
            { priceDelta: dd2 * bars[op.entryIdx].c, daysToExpiry: 21 }, ticker, op.vixEst || 20);
        }
        pnl2 = Math.max(-stopLossPct, Math.min(takeProfitPct, pnl2));
        const pnlDollar2 = parseFloat((pnl2 * op.positionCost).toFixed(2));
        cash = parseFloat((cash + pnlDollar2).toFixed(2));
        if (cash > peakCash) peakCash = cash;
        const dd = (cash - peakCash) / peakCash;
        if (dd < maxDrawdown) maxDrawdown = dd;
        trades.push({
          date: bars[op.expiryIdx]?.t?.split("T")[0] || `day-${op.expiryIdx}`,
          ticker, optionType: op.entryType, score: op.score,
          entryPrice: bars[op.entryIdx].c, entryPrem: op.useSpread ? op.btNetDebit : op.entryPrem,
          pnlPct: parseFloat((pnl2*100).toFixed(1)), pnlDollar: pnlDollar2,
          exitReason: "hold_expired", holdDays: op.expiryIdx - op.entryIdx,
          cashAfter: cash, reasons: op.reasons, tradeType: op.useSpread ? "spread" : "naked",
          vixEst: parseFloat((op.vixEst || 20).toFixed(1)),
          agentRegime: op.agentRegime || "neutral",
        });
        openBT.splice(j, 1);
      }
    }
    if (openBT.length >= maxPositions) continue; // at capacity

    // Simulate this position with intraday TP/stop checking
    let pnlPct    = 0;
    let exitReason = "hold_expired";
    let actualDays = holdDays;
    let settled   = false;

    for (let d = 1; d <= holdDays && (i + d) < bars.length; d++) {
      const dayBar   = bars[i + d];
      const dayDelta = (dayBar.c - price) / price;
      let estPnlPct;
      if (useSpread) {
        estPnlPct = simulateSpreadPnL(btNetDebit, btSpreadWidth, entryType, btTradeType, d, dayDelta, vixEst, ticker);
      } else {
        const dayDirected = entryType === "put" ? -dayDelta : dayDelta;
        estPnlPct = simulateOptionPnL(entryPrem, entryType, d, { priceDelta: dayDirected * price, daysToExpiry: 21 }, ticker, vixEst);
      }
      if (estPnlPct >= takeProfitPct) {
        pnlPct = takeProfitPct; exitReason = "take_profit"; actualDays = d; settled = true; break;
      }
      if (estPnlPct <= -stopLossPct) {
        pnlPct = -stopLossPct; exitReason = "stop_loss"; actualDays = d; settled = true; break;
      }
      pnlPct = estPnlPct;
    }

    if (settled) {
      // TP or stop hit - settle immediately
      const pnlDollar = parseFloat((pnlPct * positionCost).toFixed(2));
      cash = parseFloat((cash + pnlDollar).toFixed(2));
      if (cash > peakCash) peakCash = cash;
      const dd = (cash - peakCash) / peakCash;
      if (dd < maxDrawdown) maxDrawdown = dd;
      equityCurve.push({ date: bars[i + actualDays]?.t?.split("T")[0] || barDate, value: cash });

      // BT-7: Update spiral counters - independent per direction
      if (pnlDollar > 0) {
        btSpiral[entryType] = 0;          // win resets only this direction
        btSpiralBlocked[entryType] = false; // clears only this direction
      } else {
        btSpiral[entryType]++;
        if (btSpiral[entryType] >= SPIRAL_THRESHOLD) {
          btSpiralBlocked[entryType] = true; // blocks only this direction
        }
      }

      // Phase 2: additional metrics tracking
      totalHoldDays += actualDays;
      const month = barDate.slice(0,7);
      monthlyPnL[month] = parseFloat(((monthlyPnL[month] || 0) + pnlDollar).toFixed(2));
      const vixBucket = vixEst >= 35 ? "extreme" : vixEst >= 25 ? "high" : vixEst >= 18 ? "medium" : "low";
      vixBuckets[vixBucket].t++;
      if (pnlDollar > 0) { vixBuckets[vixBucket].w++; currentConsec[entryType] = 0; }
      else {
        currentConsec[entryType]++;
        if (currentConsec[entryType] > maxConsecLosses[entryType]) maxConsecLosses[entryType] = currentConsec[entryType];
      }
      // Drawdown duration tracking
      if (cash < peakCash) {
        if (drawdownStartDay < 0) drawdownStartDay = i;
        const durDays = i - drawdownStartDay;
        if (durDays > maxDrawdownDuration) maxDrawdownDuration = durDays;
      } else {
        drawdownStartDay = -1;
      }
      const agentRegimeFull = reasons.find(r => r.includes("Agent")) || "";
      const agentRegime = agentRegimeFull.includes("trending_bear") ? "trending_bear"
        : agentRegimeFull.includes("trending_bull") ? "trending_bull"
        : agentRegimeFull.includes("choppy") ? "choppy" : "neutral";
      trades.push({ date: barDate, ticker, optionType: entryType, score, entryPrice: price,
        entryPrem: useSpread ? btNetDebit : entryPrem,
        pnlPct: parseFloat((pnlPct*100).toFixed(1)), pnlDollar, exitReason, holdDays: actualDays,
        cashAfter: cash, reasons: reasons.slice(0,3), vixEst: parseFloat(vixEst.toFixed(1)),
        agentRegime, tradeType: useSpread ? `${btTradeType}_spread` : "naked",
        regimeClass: regime?.regimeClass || "A" });
    } else {
      // Not yet settled - track as open position
      openBT.push({ entryIdx: i, entryType, entryPrem, positionCost, score,
        expiryIdx: Math.min(i + holdDays, bars.length-1), reasons: reasons.slice(0,3), vixEst, agentRegime,
        useSpread, btNetDebit, btSpreadWidth, btTradeType });
    }
    } catch(loopErr) {
      logEvent("error", `[BACKTEST] Loop crash at bar ${i} (${ticker} ${bars[i]?.t?.split("T")[0]}): ${loopErr.message}`);
      // Continue - don't let one bad bar crash the entire backtest
    }
  }

  // Calculate statistics
  const wins       = trades.filter(t => t.pnlDollar > 0);
  const losses     = trades.filter(t => t.pnlDollar <= 0);
  const winRate    = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const avgWin     = wins.length   ? wins.reduce((s,t)  => s + t.pnlDollar, 0) / wins.length   : 0;
  const avgLoss    = losses.length ? losses.reduce((s,t) => s + t.pnlDollar, 0) / losses.length : 0;
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : (avgWin > 0 ? 999 : 0);
  const totalPnL   = trades.reduce((s,t) => s + t.pnlDollar, 0);
  const totalReturn = (cash - capital) / capital * 100;

  // Score bracket analysis - validates QS-W2
  const brackets = { "90-100":{trades:0,wins:0}, "80-89":{trades:0,wins:0}, "70-79":{trades:0,wins:0} };
  trades.forEach(t => {
    const b = t.score >= 90 ? "90-100" : t.score >= 80 ? "80-89" : "70-79";
    brackets[b].trades++;
    if (t.pnlDollar > 0) brackets[b].wins++;
  });
  Object.keys(brackets).forEach(b => {
    brackets[b].winRate = brackets[b].trades > 0 ? parseFloat((brackets[b].wins / brackets[b].trades * 100).toFixed(1)) : 0;
  });

  // Phase 2: compute additional metrics
  const expectancy      = parseFloat(((winRate/100 * avgWin) + ((1 - winRate/100) * avgLoss)).toFixed(2));
  const calmar          = maxDrawdown !== 0 ? parseFloat((totalReturn / Math.abs(maxDrawdown * 100)).toFixed(2)) : 0;
  const avgHoldDuration = trades.length > 0 ? parseFloat((totalHoldDays / trades.length).toFixed(1)) : 0;
  const vixWinRates     = {};
  Object.entries(vixBuckets).forEach(([k,v]) => {
    vixWinRates[k] = { trades: v.t, winRate: v.t > 0 ? parseFloat((v.w/v.t*100).toFixed(1)) : 0 };
  });
  // Ensure 200MA gate counters exist even if never triggered
  if (!gateSkips["200maCall"])   gateSkips["200maCall"]   = 0;
  if (!gateSkips["200maPutMin"]) gateSkips["200maPutMin"] = 0;
  if (!gateSkips["bounceGate"])  gateSkips["bounceGate"]  = 0;
  if (!gateSkips["dipGate"])     gateSkips["dipGate"]     = 0;
  const totalGateSkips  = Object.values(gateSkips).reduce((s,v) => s+v, 0);
  const minScore_used   = config.minScore || 70;

  logEvent("scan", `[BACKTEST] ${ticker} ${minScore}+: ${trades.length} trades, ${winRate.toFixed(0)}% WR, expectancy $${expectancy}/trade, Calmar ${calmar}, spiral:${spiralBlockCount}, gates:${totalGateSkips}`);

  // Direction split - put WR vs call WR independently
  const putTrades  = trades.filter(t => t.optionType === "put");
  const callTrades = trades.filter(t => t.optionType === "call");
  const putWins    = putTrades.filter(t => t.pnlDollar > 0);
  const callWins   = callTrades.filter(t => t.pnlDollar > 0);
  const directionSplit = {
    put:  { trades: putTrades.length,  wins: putWins.length,
            winRate: putTrades.length  ? parseFloat((putWins.length/putTrades.length*100).toFixed(1))  : 0,
            pnl: parseFloat(putTrades.reduce((s,t)=>s+t.pnlDollar,0).toFixed(2)) },
    call: { trades: callTrades.length, wins: callWins.length,
            winRate: callTrades.length ? parseFloat((callWins.length/callTrades.length*100).toFixed(1)) : 0,
            pnl: parseFloat(callTrades.reduce((s,t)=>s+t.pnlDollar,0).toFixed(2)) },
  };

  // Losing streak tracking with dates
  let streakInfo = { put: { max: 0, startDate: null, endDate: null }, call: { max: 0, startDate: null, endDate: null } };
  const streakCur = { put: 0, call: 0 };
  const streakStart = { put: null, call: null };
  trades.slice().sort((a,b) => a.date < b.date ? -1 : 1).forEach(t => {
    const type = t.optionType;
    if (t.pnlDollar <= 0) {
      if (streakCur[type] === 0) streakStart[type] = t.date;
      streakCur[type]++;
      if (streakCur[type] > streakInfo[type].max) {
        streakInfo[type] = { max: streakCur[type], startDate: streakStart[type], endDate: t.date };
      }
    } else {
      streakCur[type] = 0;
      streakStart[type] = null;
    }
  });

  // Exit reason breakdown
  const exitBreakdown = {};
  trades.forEach(t => {
    if (!exitBreakdown[t.exitReason]) exitBreakdown[t.exitReason] = { count: 0, wins: 0, pnl: 0 };
    exitBreakdown[t.exitReason].count++;
    if (t.pnlDollar > 0) exitBreakdown[t.exitReason].wins++;
    exitBreakdown[t.exitReason].pnl = parseFloat((exitBreakdown[t.exitReason].pnl + t.pnlDollar).toFixed(2));
  });

  return {
    config,
    summary: {
      ticker, optionType, startDate, endDate, maxPositions, minScore: minScore_used,
      note: maxPositions > 1 ? `Multi-position simulation (max ${maxPositions} concurrent)` : "Single-position simulation",
      modelVersion: "v2.75 - slippage, bid-ask, agent sim, spiral, 200MA, IV rank, regime A/B/C, bear call credit",
      putOnlyMode:  putOnly,
      callSizeMult: callSizeMult,
      gatesApplied: ticker === "GLD" ? ["GLD-DXY","GLD-SPY5d","GLD-VIX","GLD-RSI","GLD-min80"]
                  : ticker === "TLT" ? ["TLT-SPY50MA"] : [],
      spiralBlockCount, gateSkips, totalGateSkips,
      totalTrades:     trades.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         parseFloat(winRate.toFixed(1)),
      avgWin:          parseFloat(avgWin.toFixed(2)),
      avgLoss:         parseFloat(avgLoss.toFixed(2)),
      profitFactor:    parseFloat(profitFactor.toFixed(2)),
      expectancy,
      calmar,
      avgHoldDuration,
      maxConsecLosses,
      streakInfo,
      maxDrawdownDuration,
      totalPnL:        parseFloat(totalPnL.toFixed(2)),
      totalReturn:     parseFloat(totalReturn.toFixed(1)),
      maxDrawdown:     parseFloat((maxDrawdown * 100).toFixed(1)),
      finalCash:       parseFloat(cash.toFixed(2)),
      barsAnalyzed:    bars.length,
    },
    directionSplit,
    regimeSplit: (() => {
      const rs = {};
      trades.forEach(t => {
        const rc = t.regimeClass || "A";
        if (!rs[rc]) rs[rc] = { trades: 0, wins: 0, pnl: 0 };
        rs[rc].trades++;
        if (t.pnlDollar > 0) rs[rc].wins++;
        rs[rc].pnl = parseFloat((rs[rc].pnl + t.pnlDollar).toFixed(2));
      });
      Object.keys(rs).forEach(rc => {
        rs[rc].winRate = rs[rc].trades > 0 ? parseFloat((rs[rc].wins/rs[rc].trades*100).toFixed(1)) : 0;
      });
      return rs;
    })(),
    exitBreakdown,
    scoreBrackets:  brackets,
    monthlyPnL,
    vixWinRates,
    equityCurve,
    trades,
    v275: { useSpread, useRegimeB },
  };
  } catch(e) {
    const stackLine = (e.stack || "").split("\n")[1] || "";
    logEvent("error", `[BACKTEST] runBacktest crashed for ${config?.ticker} minScore:${config?.minScore}: ${e.message} | ${stackLine.trim()}`);
    return { error: e.message, ticker: config?.ticker, minScore: config?.minScore };
  }
}

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
