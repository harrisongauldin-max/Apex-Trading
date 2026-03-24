// -
// APEX v3.95 - Professional Options Trading Agent
// Alpaca Paper Trading Edition
// -
const express    = require("express");
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

// ── Data Cache — declared early so all functions can use it ──────────────
// Slow-changing data cached to reduce API calls and Railway connection pressure
const _slowCache     = new Map(); // key: "type:ticker", value: { data, ts }
const SLOW_CACHE_TTL = 5  * 60 * 1000; // 5 min — news, analyst, premarket
const BARS_CACHE_TTL = 60 * 60 * 1000; // 60 min — daily bars don't change intraday

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
const REDIS_KEY         = "apex:state";

// - Trading Constants -
const MONTHLY_BUDGET      = 10000;
const CAPITAL_FLOOR       = 3000;
const REVENUE_THRESHOLD   = 2000;
const BONUS_AMOUNT        = 1000;
const MAX_HEAT            = 0.60;
const MAX_SECTOR_PCT      = 0.50;
const STOP_LOSS_PCT       = 0.35;
const FAST_STOP_PCT       = 0.20;   // -20% in first 48hrs
const FAST_STOP_HOURS     = 48;
const TAKE_PROFIT_PCT     = 0.30;  // tightened — faster exits, less overnight risk
const PARTIAL_CLOSE_PCT   = 0.18;  // partial at 18% — lock in gains early
const TRAIL_ACTIVATE_PCT  = 0.15;   // start trailing at +15% — tightened with new targets
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
const MIN_OPTION_PREMIUM  = 0.50;  // minimum $50 per contract — filters out lottery tickets
const MIN_OI              = 5;     // hard block — OI < 5 means essentially no market
const MAX_SPREAD_PCT      = 0.30;  // hard block — spread > 30% makes fills unprofitable (was 0.15)
const EARLY_SPREAD_PCT    = 0.10;  // tighter spread required for early 9:45AM put entries
const MAX_GAP_PCT         = 0.03;
const TARGET_DELTA_MIN    = 0.28;
const TARGET_DELTA_MAX    = 0.42;
// MAX_TRADES_PER_DAY removed - portfolio heat (60%) controls position limits
const CONSEC_LOSS_LIMIT   = 3;
const WEEKLY_DD_LIMIT     = 0.25;
const MAX_LOSS_PER_TRADE  = 900;
const MIN_SCORE           = 70;
// Entry windows handled by isEntryWindow() — see function below
const STOCK_PROFIT_THRESH = 1000;   // monthly profit threshold for stock buys
const STOCK_ALLOC_PCT     = 0.20;   // 20% of profits above threshold
const MAX_STOCK_PCT       = 0.30;   // max 30% of account in stocks
const STOCK_STOP_PCT      = 0.15;   // -15% stop on stock positions

// Cash ETF parking - floor is split 50/50 between liquid and BIL
const CASH_ETF             = "BIL";     // 1-3 Month T-Bill ETF
const CASH_ETF_TARGET      = CAPITAL_FLOOR * 0.50;  // $1,500 in BIL at all times
const CASH_ETF_MIN         = 100;       // minimum rebalance threshold

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
const WATCHLIST = [
  // -- Mega Cap Tech --
  { ticker:"NVDA",  sector:"Technology",  momentum:"strong",     rsi:58, macd:"bullish crossover",         catalyst:"AI infrastructure demand",  ivr:52, beta:1.8, earningsDate:null },
  { ticker:"AAPL",  sector:"Technology",  momentum:"steady",     rsi:52, macd:"mild bullish",      catalyst:"Services revenue growth",  ivr:28, beta:1.1, earningsDate:null },
  { ticker:"MSFT",  sector:"Technology",  momentum:"strong",     rsi:56, macd:"bullish",      catalyst:"Copilot enterprise adoption",  ivr:30, beta:1.2, earningsDate:null },
  { ticker:"AMZN",  sector:"Technology",  momentum:"strong",     rsi:61, macd:"bullish",         catalyst:"AWS acceleration",  ivr:35, beta:1.3, earningsDate:null },
  { ticker:"META",  sector:"Technology",  momentum:"strong",     rsi:63, macd:"bullish",        catalyst:"AI ad revenue momentum",  ivr:40, beta:1.4, earningsDate:null },
  { ticker:"GOOGL", sector:"Technology",  momentum:"steady",     rsi:54, macd:"mild bullish",         catalyst:"Search + cloud strength",  ivr:32, beta:1.2, earningsDate:null },
  // -- Semiconductors --
  { ticker:"AMD",   sector:"Technology",  momentum:"recovering", rsi:47, macd:"forming base",          catalyst:"MI300X server demand",  ivr:55, beta:1.7, earningsDate:null },
  { ticker:"ARM",   sector:"Technology",  momentum:"strong",     rsi:62, macd:"bullish crossover",        catalyst:"AI chip architecture demand",  ivr:58, beta:1.9, earningsDate:null },
  { ticker:"AVGO",  sector:"Technology",  momentum:"strong",     rsi:57, macd:"bullish",         catalyst:"AI networking chips",  ivr:38, beta:1.4, earningsDate:null },
  { ticker:"MU",    sector:"Technology",  momentum:"recovering", rsi:48, macd:"neutral",          catalyst:"HBM memory for AI",  ivr:52, beta:1.6, earningsDate:null },
  { ticker:"SMCI",  sector:"Technology",  momentum:"recovering", rsi:45, macd:"neutral",       catalyst:"AI server infrastructure",  ivr:60, beta:2.1, earningsDate:null },
  // -- Cloud & Enterprise Software --
  { ticker:"CRM",   sector:"Technology",  momentum:"steady",     rsi:51, macd:"mild bullish",         catalyst:"AI CRM integration",  ivr:33, beta:1.3, earningsDate:null },
  { ticker:"NOW",   sector:"Technology",  momentum:"strong",     rsi:58, macd:"bullish",      catalyst:"AI workflow automation",  ivr:35, beta:1.3, earningsDate:null },
  { ticker:"SNOW",  sector:"Technology",  momentum:"steady",     rsi:50, macd:"neutral",          catalyst:"Data cloud growth",  ivr:55, beta:1.5, earningsDate:null },
  // -- Cybersecurity --
  { ticker:"CRWD",  sector:"Technology",  momentum:"strong",     rsi:60, macd:"bullish",        catalyst:"Cybersecurity spending surge",  ivr:48, beta:1.6, earningsDate:null },
  { ticker:"PANW",  sector:"Technology",  momentum:"strong",     rsi:57, macd:"bullish",         catalyst:"Platform consolidation wins",  ivr:40, beta:1.4, earningsDate:null },
  { ticker:"NET",   sector:"Technology",  momentum:"steady",     rsi:52, macd:"mild bullish",         catalyst:"Zero trust adoption",  ivr:50, beta:1.5, earningsDate:null },
  // -- Financials --
  { ticker:"JPM",   sector:"Financial",   momentum:"strong",     rsi:57, macd:"bullish",      catalyst:"Net interest income strength",  ivr:28, beta:1.1, earningsDate:null },
  { ticker:"BAC",   sector:"Financial",   momentum:"recovering", rsi:48, macd:"neutral",          catalyst:"Net interest income + rate play",  ivr:30, beta:1.3, earningsDate:null },
  { ticker:"C",     sector:"Financial",   momentum:"recovering", rsi:47, macd:"neutral",          catalyst:"Restructuring + rate sensitivity",  ivr:32, beta:1.5, earningsDate:null },
  { ticker:"MS",    sector:"Financial",   momentum:"steady",     rsi:52, macd:"mild bullish",         catalyst:"Investment banking cycle",  ivr:28, beta:1.4, earningsDate:null },
  { ticker:"COIN",  sector:"Financial",   momentum:"recovering", rsi:48, macd:"forming base",          catalyst:"Crypto market recovery",  ivr:65, beta:2.2, earningsDate:null },
  { ticker:"HOOD",  sector:"Financial",   momentum:"recovering", rsi:46, macd:"neutral",          catalyst:"Retail trading volume recovery",  ivr:68, beta:2.0, earningsDate:null },
  { ticker:"MSTR",  sector:"Financial",   momentum:"recovering", rsi:48, macd:"forming base",          catalyst:"Bitcoin treasury strategy",  ivr:80, beta:3.0, earningsDate:null },
  { ticker:"SQ",    sector:"Financial",   momentum:"recovering", rsi:45, macd:"neutral",          catalyst:"Bitcoin + fintech recovery",  ivr:60, beta:2.0, earningsDate:null },
  // -- Consumer & E-commerce --
  { ticker:"TSLA",  sector:"Consumer",    momentum:"recovering", rsi:44, macd:"neutral",      catalyst:"Q1 delivery data",  ivr:61, beta:2.0, earningsDate:null },
  { ticker:"NFLX",  sector:"Consumer",    momentum:"strong",     rsi:60, macd:"bullish",        catalyst:"Ad-supported tier growth",  ivr:38, beta:1.4, earningsDate:null },
  { ticker:"UBER",  sector:"Consumer",    momentum:"strong",     rsi:58, macd:"bullish",      catalyst:"Profitability milestone",  ivr:35, beta:1.5, earningsDate:null },
  { ticker:"SHOP",  sector:"Consumer",    momentum:"steady",     rsi:52, macd:"mild bullish",         catalyst:"E-commerce market share gains",  ivr:52, beta:1.6, earningsDate:null },
  { ticker:"DKNG",  sector:"Consumer",    momentum:"steady",     rsi:50, macd:"neutral",          catalyst:"Sports betting expansion",  ivr:58, beta:1.7, earningsDate:null },
  { ticker:"NKE",   sector:"Consumer",    momentum:"recovering", rsi:46, macd:"neutral",          catalyst:"China recovery + DTC growth",  ivr:32, beta:1.2, earningsDate:null },
  { ticker:"ROKU",  sector:"Consumer",    momentum:"recovering", rsi:47, macd:"neutral",          catalyst:"Streaming ad platform growth",  ivr:58, beta:1.8, earningsDate:null },
  // -- High Momentum / Speculative --
  { ticker:"PLTR",  sector:"Technology",  momentum:"strong",     rsi:65, macd:"bullish crossover",        catalyst:"Government AI contracts",  ivr:62, beta:2.0, earningsDate:null },
  { ticker:"WFC",   sector:"Financial",   momentum:"steady",     rsi:51, macd:"neutral",          catalyst:"Net interest income + expense cuts", ivr:28, beta:1.2, earningsDate:null },
  { ticker:"BABA",  sector:"Global",      momentum:"recovering", rsi:49, macd:"neutral",          catalyst:"China stimulus + AI investment",  ivr:45, beta:1.6, earningsDate:null },
  // -- Ad Tech --
  { ticker:"TTD",   sector:"Technology",  momentum:"steady",     rsi:53, macd:"mild bullish",         catalyst:"Programmatic ad recovery",  ivr:55, beta:1.7, earningsDate:null },
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
    stockTrades:      [],
    tradeLog:         [],
    tradeJournal:     [],
    todayTrades:      0,
    consecutiveLosses:0,
    dayTrades:        [],   // rolling log of day trades [{date, ticker, openTime, closeTime}]
    pdtWarned:        false,
    monthStart:       new Date().toLocaleDateString(),
    weekStartCash:    MONTHLY_BUDGET,
    dayStartCash:     MONTHLY_BUDGET,
    circuitOpen:      true,
    weeklyCircuitOpen:true,
    monthlyProfit:    0,
    stockBudget:      0,
    peakCash:         MONTHLY_BUDGET,
    cashETFShares:    0,
    cashETFValue:     0,
    cashETFPrice:     91,
    lastScan:         null,
    vix:              15,
    dataQuality:      { realTrades: 0, estimatedTrades: 0, totalTrades: 0 },
    tickerBlacklist:  [], // tickers blocked for today — clears on morning reset
    exitStats:        {}, // running tally per exit reason: { count, wins, totalPnl, avgPnl, winRate }
    agentAutoExitEnabled: false, // controlled by dashboard toggle
    _agentRescoreHour: {}, // tracks last rescore hour per ticker
    portfolioSnapshots: [], // time-series portfolio value: [{t, v}] sampled every 5 min
  };
}

// - Redis Helpers -
async function redisSave(data) {
  // Strip large recalculable fields before saving — reduces payload from ~10MB to <500KB
  // marketContext is rebuilt every 5 minutes — no need to persist to Redis
  // scoreReasons in tradeJournal are display-only — trim to save space
  const slim = {
    ...data,
    // Trim tradeJournal entries — keep essentials, drop verbose scoreReasons
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
    // tradeLog is display-only — keep last 100
    tradeLog: (data.tradeLog || []).slice(0, 100),
    // closedTrades — keep last 200 (was 500)
    closedTrades: (data.closedTrades || []).slice(0, 200),
    // stockTrades — keep last 50
    stockTrades: (data.stockTrades || []).slice(0, 50),
  };
  // Never persist marketContext — it's recalculated every 5 min
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
    // Use Upstash pipeline endpoint — most reliable format, no double-encoding ambiguity
    // Pipeline body: array of commands, each command is [cmd, key, value]
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([["set", REDIS_KEY, serialized]])
    });
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
  // Retry up to 3 times — Redis may not be reachable on cold container start
  // Silent failure here causes state to reset to $10k default — catastrophic in live trading
  const MAX_RETRIES  = 3;
  const RETRY_DELAY  = 2000; // 2 seconds between retries
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Use pipeline GET — consistent with how we save
      const res  = await fetch(`${REDIS_URL}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify([["get", REDIS_KEY]])
      });
      const data = await res.json();
      // Pipeline returns [{result: "value_string"}]
      const raw = data && data[0] && data[0].result;
      if (raw) {
        if (attempt > 1) console.log(`[REDIS] Loaded on attempt ${attempt}`);
        // raw is the JSON string we saved — parse it directly
        let parsed = JSON.parse(raw);
        // Safety: handle any legacy double-encoded formats
        if (typeof parsed === 'string') {
          console.log("[REDIS] Detected double-encoded string — parsing again");
          parsed = JSON.parse(parsed);
        }
        // Handle old {value:"..."} wrapped format from very early versions
        if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string' && !parsed.cash) {
          console.log("[REDIS] Detected old wrapped format — unwrapping");
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
  // All retries failed — this is dangerous in live trading
  console.error("[REDIS] CRITICAL: All load attempts failed — starting with saved file or defaults");
  console.error("[REDIS] If live trading, check Upstash connection immediately");
  // Try file fallback as last resort
  try {
    if (fs.existsSync(STATE_FILE)) {
      console.log("[REDIS] Using local file fallback");
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch(e) {}
  return null;
}

// Throttled saveState — only writes to Redis when state changes
// Prevents burning through Upstash free tier (10k commands/day)
let stateDirty    = false;
let lastRedisSave = 0;
const REDIS_SAVE_INTERVAL = 30000; // minimum 30 seconds between Redis writes (~960/day, under 10k limit)

function markDirty() {
  stateDirty = true;
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

// Force save — used for critical state changes (trade open/close, circuit breaker)
async function saveStateNow() {
  try {
    await redisSave(state);
    lastRedisSave = Date.now();
    stateDirty    = false;
  } catch(e) { console.error("saveStateNow error:", e.message); }
}

// Periodic flush — saves if dirty but not recently saved
async function flushStateIfDirty() {
  if (stateDirty && Date.now() - lastRedisSave >= REDIS_SAVE_INTERVAL) {
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
    // ── STATE VALIDATION ─────────────────────────────────────────────────
    // Validate loaded state before using it — corrupt or empty state
    // is more dangerous than starting fresh, especially in live trading
    const isValid = (
      typeof saved.cash === 'number' && saved.cash >= 0 &&
      Array.isArray(saved.positions) &&
      Array.isArray(saved.closedTrades)
    );

    if (!isValid) {
      console.error("[STATE] CRITICAL: Loaded state failed validation — fields missing or corrupt");
      console.error("[STATE] Raw loaded cash:", saved.cash, "| positions type:", typeof saved.positions);
      console.error("[STATE] Starting fresh — check Redis data integrity");
      // Don't use corrupt state — fall through to defaultState
    } else {
      // Suspicious state check — $10k cash with no trades is normal on first run
      // but $10k cash after weeks of trading means something reset unexpectedly
      const hasTradeHistory = saved.closedTrades && saved.closedTrades.length > 0;
      const cashMatchesDefault = Math.abs(saved.cash - MONTHLY_BUDGET) < 1;
      const noPositions = !saved.positions || saved.positions.length === 0;
      if (hasTradeHistory && cashMatchesDefault && noPositions) {
        console.warn("[STATE] WARNING: State has trade history but cash reset to default — possible accidental reset");
        console.warn("[STATE] Cash: $" + saved.cash + " | Trades: " + saved.closedTrades.length + " | Positions: 0");
        console.warn("[STATE] Loading anyway — verify dashboard looks correct");
      }

      state = { ...defaultState(), ...saved };
      console.log("[STATE] Loaded | cash: $" + state.cash + " | positions: " + state.positions.length + " | trades: " + (state.closedTrades||[]).length);
    }
  } else {
    console.log("[STATE] No saved state found — starting fresh with $" + MONTHLY_BUDGET);
  }

  // customBudget = the budget ceiling set by user (starting amount)
  // state.cash   = actual current cash (changes with every trade — DO NOT override)
  // Only restore customBudget on a genuinely fresh state (no trade history)
  // If we have trade history, cash is already correct from Redis — don't touch it
  if (state.customBudget && state.customBudget > 0 && state.customBudget !== MONTHLY_BUDGET) {
    const isFreshState = (state.closedTrades || []).length === 0 && (state.positions || []).length === 0;
    if (isFreshState) {
      // Fresh account — set cash to customBudget as the starting balance
      state.cash = state.customBudget;
      console.log("[STATE] Fresh account — setting cash to custom budget: $" + state.customBudget);
    } else {
      // Has trade history — cash is already accurate from Redis, don't override
      console.log("[STATE] Custom budget: $" + state.customBudget + " | Current cash: $" + state.cash + " (preserved from Redis)");
    }
  }

  // ── POSITION RECONCILIATION ─────────────────────────────────────────────
  // Cross-reference APEX state with actual Alpaca positions on every startup
  // Prevents ghost positions (APEX thinks open, Alpaca closed) and missed positions
  if (ALPACA_KEY) {
    try {
      const alpacaPositions = await alpacaGet("/positions");
      if (alpacaPositions && Array.isArray(alpacaPositions)) {
        const alpacaSymbols = new Set(alpacaPositions.map(p => p.symbol));
        let ghosts = 0, orphans = 0;

        // Check for ghost positions — APEX has them, Alpaca doesn't
        for (const pos of [...state.positions]) {
          if (pos.contractSymbol && !alpacaSymbols.has(pos.contractSymbol)) {
            // Position exists in APEX but not in Alpaca — was closed externally
            console.log(`[RECONCILE] Ghost position detected: ${pos.ticker} ${pos.contractSymbol} — removing from state`);
            const idx = state.positions.indexOf(pos);
            state.positions.splice(idx, 1);
            // Record as closed at unknown price (external close)
            state.closedTrades.push({
              ticker: pos.ticker, pnl: 0, pct: "0", reason: "reconcile-removed",
              date: new Date().toLocaleDateString(), score: pos.score || 0, closeTime: Date.now()
            });
            ghosts++;
          }
        }

        // Check for orphan positions — Alpaca has them, APEX doesn't know about them
        for (const alpPos of alpacaPositions) {
          // Only check options (contract symbols have format like AAPL260117C00150000)
          if (!/^[A-Z]+\d{6}[CP]\d{8}$/.test(alpPos.symbol)) continue;
          const known = state.positions.find(p => p.contractSymbol === alpPos.symbol);
          if (!known) {
            console.log(`[RECONCILE] Orphan position detected: ${alpPos.symbol} — exists in Alpaca but not in APEX state`);
            orphans++;
            // Log but don't auto-add — would need full position metadata
            // Dashboard will show this as a warning
          }
        }

        if (ghosts > 0 || orphans > 0) {
          console.log(`[RECONCILE] Complete: ${ghosts} ghost(s) removed, ${orphans} orphan(s) detected`);
          if (orphans > 0) console.log("[RECONCILE] WARNING: Orphan positions exist in Alpaca — check dashboard");
          await redisSave(state); // save reconciled state immediately
        } else {
          console.log("[RECONCILE] OK — APEX state matches Alpaca positions");
        }

        state.lastReconcile = new Date().toISOString();
        state.reconcileStatus = ghosts === 0 && orphans === 0 ? "ok" : "warning";
        state.orphanCount = orphans;

        // Sync BIL position from Alpaca — ensures cashETFShares matches real position
        const bilPos = alpacaPositions.find(p => p.symbol === CASH_ETF);
        if (bilPos) {
          const realShares = parseInt(bilPos.qty);
          const realValue  = parseFloat(bilPos.market_value);
          if (realShares !== state.cashETFShares) {
            console.log(`[RECONCILE] BIL sync: APEX had ${state.cashETFShares} shares, Alpaca has ${realShares} — updating`);
            state.cashETFShares = realShares;
            state.cashETFValue  = realValue;
            state.cashETFPrice  = parseFloat(bilPos.current_price || 91);
          } else {
            console.log(`[RECONCILE] BIL OK — ${realShares} shares @ $${parseFloat(bilPos.current_price||91).toFixed(2)}`);
          }
        } else if (state.cashETFShares > 0) {
          // APEX thinks we have BIL but Alpaca doesn't — clear it
          console.log(`[RECONCILE] BIL ghost — APEX had ${state.cashETFShares} shares, Alpaca has none — clearing`);
          state.cashETFShares = 0;
          state.cashETFValue  = 0;
        }
      }
    } catch(e) {
      console.log("[RECONCILE] Failed:", e.message, "— proceeding with saved state");
    }

    // ── CASH SYNC from Alpaca account ─────────────────────────────────────
    // state.cash is APEX's internal ledger — can drift from real Alpaca balance
    // due to fills at different prices, fees, or manual activity outside APEX
    //
    // IMPORTANT: If customBudget is set, the user is intentionally trading a
    // subset of their Alpaca balance (e.g. $10k out of $100k paper account).
    // In that case, DON'T sync from Alpaca — it would override their budget.
    // Only sync when no customBudget is set (user wants to trade full balance).
    try {
      const acct = await alpacaGet("/account");
      if (acct && acct.cash) {
        const alpacaCash = parseFloat(acct.cash);
        state.alpacaCash = alpacaCash; // always store for dashboard display

        const hasCustomBudget = state.customBudget && state.customBudget > 0 && state.customBudget !== MONTHLY_BUDGET;
        if (hasCustomBudget) {
          // User set a custom budget — respect it, don't sync from Alpaca
          console.log(`[CASH SYNC] Custom budget active ($${state.customBudget}) — skipping Alpaca sync (Alpaca has $${alpacaCash.toFixed(2)})`);
        } else {
          // No custom budget — sync APEX cash to actual Alpaca balance
          const apexCash = state.cash;
          const drift    = Math.abs(alpacaCash - apexCash);
          if (drift > 1.00) {
            console.log(`[CASH SYNC] Alpaca: $${alpacaCash.toFixed(2)} | APEX: $${apexCash.toFixed(2)} | drift: $${drift.toFixed(2)} — syncing`);
            state.cash = alpacaCash;
            await redisSave(state);
          } else {
            console.log(`[CASH SYNC] OK — $${alpacaCash.toFixed(2)}`);
          }
        }
      }
    } catch(e) {
      console.log("[CASH SYNC] Failed:", e.message, "— using saved cash balance");
    }
  }
}

function logEvent(type, message) {
  const entry = { time: new Date().toISOString(), type, message };
  state.tradeLog.unshift(entry);
  if (state.tradeLog.length > 200) state.tradeLog = state.tradeLog.slice(0, 200);
  console.log(`[${type.toUpperCase()}] ${message}`);
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
// ── F15: OI clustering / max pain ────────────────────────────────────────
function calcMaxPain(contracts) {
  if (!contracts || contracts.length < 5) return null;
  const strikeOI = {};
  for (const c of contracts) {
    const strike = parseFloat(c.strike_price || c.strike || 0);
    const oi     = parseInt(c.open_interest || 0);
    if (strike > 0) strikeOI[strike] = (strikeOI[strike] || 0) + oi;
  }
  let maxOI = 0, maxPainStrike = 0, totalOI = 0;
  for (const [strike, oi] of Object.entries(strikeOI)) {
    totalOI += oi;
    if (oi > maxOI) { maxOI = oi; maxPainStrike = parseFloat(strike); }
  }
  const sorted = Object.entries(strikeOI).sort((a,b) => b[1]-a[1]).slice(0,3);
  return { maxPainStrike, maxOIAtStrike: maxOI, totalOI, topStrikes: sorted.map(([s,o]) => ({ strike: parseFloat(s), oi: o })) };
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
  // Use prefetched intraday bars if provided, otherwise fetch now
  if (!intradayBars) intradayBars = await getIntradayBars(ticker);
  const signalBars   = intradayBars.length >= 10 ? intradayBars : bars;

  // RSI and MACD from intraday if available — captures today's move
  const rsi      = calcRSI(signalBars);
  const macd     = calcMACD(signalBars);

  // Momentum from intraday — is it moving up or down TODAY?
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

  // IV rank + IV Percentile — both use daily bars for historical context
  // IVR: where is IV in its 52-week range
  // IV Percentile: what % of days had lower IV (more accurate measure)
  const recentBars = bars.slice(-20);
  const returns    = recentBars.slice(1).map((b, i) => Math.log(b.c / recentBars[i].c));
  const stdDev     = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
  const currentIV  = stdDev * Math.sqrt(252);
  const ivr        = calcIVRank(currentIV, bars);

  // IV Percentile — % of days where IV was lower than today
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

  // Volume ratio — today's intraday volume vs expected (based on time of day)
  const intradayVol  = intradayBars.reduce((s, b) => s + b.v, 0);
  const avgDailyVol  = bars.length ? bars.slice(-20).reduce((s,b)=>s+b.v,0)/20 : 0;
  // Adjust for time of day — if 2 hours into session, expect ~40% of daily vol
  const etH = getETTime().getHours() + getETTime().getMinutes() / 60;
  const sessionPct = Math.min(1, Math.max(0.1, (etH - 9.5) / 6.5)); // 0-100% through session
  const expectedVol = avgDailyVol * sessionPct;
  const volPaceRatio = expectedVol > 0 ? intradayVol / expectedVol : 1;

  return {
    rsi,
    macd:          macd.signal,
    momentum,
    adx,
    ivr,
    ivPercentile,  // % of days with lower IV — high = options expensive
    intradayVWAP,
    intradayVol,
    volPaceRatio,
    hasIntraday:   intradayBars.length >= 10,
  };
}

// - Helpers -
const fmt         = n  => "$" + parseFloat(n).toFixed(2);
const totalCap    = () => (state.customBudget || MONTHLY_BUDGET) + (state.extraBudget || 0);
const openRisk    = () => state.positions.reduce((s,p) => s + p.cost * (p.partialClosed ? 0.5 : 1), 0);
const heatPct     = () => openRisk() / totalCap();
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

function isEntryWindow(optionType = null) {
  const et  = getETTime();
  const h   = et.getHours(), m = et.getMinutes();
  const day = et.getDay();
  if (day === 0 || day === 6) return false;

  const minsSinceMidnight = h * 60 + m;
  const marketClose       = 15 * 60 + 30; // 3:30 PM

  // Puts can enter from 9:45 AM when conditions warrant (gap down, high VIX, sector weakness)
  const putEarlyStart     = 9 * 60 + 45;  // 9:45 AM
  const callStart         = 10 * 60;       // 10:00 AM

  if (minsSinceMidnight > marketClose) return false; // after 3:30 PM always false

  if (optionType === "put") {
    // Allow puts from 9:45 AM but only when market shows weakness
    const isEarlyWindow  = minsSinceMidnight >= putEarlyStart && minsSinceMidnight < callStart;
    if (isEarlyWindow) {
      const vix        = state.vix || 15;
      const macro      = marketContext?.macroCalendar?.modifier || 0;
      // Only allow early puts when VIX elevated OR macro event day
      // Spread check happens at contract selection — MAX_SPREAD_PCT tightened to 8% for early window
      return vix >= 25 || macro < 0;
    }
    return minsSinceMidnight >= callStart;
  }

  // Calls always wait for 10 AM
  return minsSinceMidnight >= callStart;
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
function scoreSetup(stock, relStrength, adx, volume, avgVolume) {
  let score = 0;
  const reasons = [];

  // Momentum (20pts)
  if (stock.momentum === "strong")          { score += 20; reasons.push("Strong momentum (+20)"); }
  else if (stock.momentum === "steady")     { score += 12; reasons.push("Steady momentum (+12)"); }
  else                                      { score += 5;  reasons.push("Recovering momentum (+5)"); }

  // RSI sweet spot 50-65 — RAISED to 20pts (more reliable than MACD on 1-min bars)
  if (stock.rsi >= 50 && stock.rsi <= 65)   { score += 20; reasons.push(`RSI ${stock.rsi} in sweet spot (+20)`); }
  else if (stock.rsi >= 45 && stock.rsi < 50){ score += 10; reasons.push(`RSI ${stock.rsi} near zone (+10)`); }
  else                                       { reasons.push(`RSI ${stock.rsi} outside zone (+0)`); }

  // MACD — REDUCED to 10pts max (noisy on 1-min bars, confirms not leads)
  if (stock.macd.includes("bullish crossover")) { score += 10; reasons.push("MACD bullish crossover (+10)"); }
  else if (stock.macd.includes("bullish"))      { score += 7;  reasons.push("MACD bullish (+7)"); }
  else if (stock.macd.includes("forming"))      { score += 3;  reasons.push("MACD forming base (+3)"); }
  else                                          { reasons.push("MACD neutral (+0)"); }

  // IV Percentile (15pts) — lower = cheaper options = better for buying calls
  const ivp = stock.ivPercentile || 50;
  if (ivp < 30)       { score += 15; reasons.push(`IVP ${ivp}% - cheap options (+15)`); }
  else if (ivp < 50)  { score += 10; reasons.push(`IVP ${ivp}% - moderate (+10)`); }
  else if (ivp < 70)  { score += 5;  reasons.push(`IVP ${ivp}% - elevated (+5)`); }
  else                { reasons.push(`IVP ${ivp}% - expensive (+0)`); }

  // News sentiment (15pts) — replaces static catalyst which was always +15
  // Live news is more meaningful than a hardcoded string
  const newsMod = stock.newsSentiment === "bullish" ? 15
                : stock.newsSentiment === "mild bullish" ? 8
                : stock.newsSentiment === "mild bearish" ? 0
                : stock.newsSentiment === "bearish" ? 0 : 5; // neutral = small boost
  if (newsMod > 0) reasons.push(`News ${stock.newsSentiment} (+${newsMod})`);
  score += newsMod;

  // Volume confirmation — DIRECTIONAL: above VWAP + high vol = stronger call signal (10pts)
  const aboveVWAP = stock.intradayVWAP > 0 && (stock.price || 0) > stock.intradayVWAP;
  if (volume && avgVolume && volume > avgVolume * 1.2) {
    const volPts = aboveVWAP ? 12 : 8; // directional bonus
    score += volPts; reasons.push(`Above-avg volume ${aboveVWAP ? "+ above VWAP" : ""} (+${volPts})`);
  } else if (volume && avgVolume && volume > avgVolume) {
    score += 5; reasons.push("Average volume (+5)");
  } else { reasons.push("Low volume (+0)"); }

  // Relative strength vs SPY — RAISED to 15pts max
  if (relStrength > 1.05)      { score += 15; reasons.push(`RS vs SPY: +${((relStrength-1)*100).toFixed(1)}% (+15)`); }
  else if (relStrength > 1.02) { score += 8;  reasons.push(`RS vs SPY: +${((relStrength-1)*100).toFixed(1)}% (+8)`); }
  else if (relStrength > 1.0)  { score += 3;  reasons.push(`RS vs SPY: +${((relStrength-1)*100).toFixed(1)}% (+3)`); }
  else                         { reasons.push(`RS vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+0)`); }

  // ADX — RAISED to 15pts max (strong confirmed trend is a top-tier signal)
  if (adx && adx > 35)      { score += 15; reasons.push(`ADX ${adx} - very strong trend (+15)`); }
  else if (adx && adx > 25) { score += 10; reasons.push(`ADX ${adx} - strong trend (+10)`); }
  else if (adx && adx > 18) { score += 5;  reasons.push(`ADX ${adx} - emerging trend (+5)`); }

  return { score: Math.min(score, 100), reasons };
}

// - Mean Reversion Call Scoring -
// Fires when quality stocks are oversold in a high-VIX environment
// These are discounted calls on beaten-down names — not trend-following
// ── Oversold RSI tracker — stored in state per ticker ────────────────────
// Tracks how many consecutive scans a ticker has had RSI ≤ 35
// Used to detect genuine capitulation vs single-scan noise
function updateOversoldTracker(ticker, rsi) {
  if (!state._oversoldCount) state._oversoldCount = {};
  if (rsi <= 35) {
    state._oversoldCount[ticker] = (state._oversoldCount[ticker] || 0) + 1;
  } else {
    state._oversoldCount[ticker] = 0;
  }
  return state._oversoldCount[ticker] || 0;
}

function scoreMeanReversionCall(stock, relStrength, adx, bars, vix) {
  let score = 0;
  const reasons = [];

  // Only applies when VIX is elevated (high fear = cheap relative calls)
  if (vix < 25) return { score: 0, reasons: ["VIX too low for mean reversion (+0)"] };

  // Stock must be a quality name — use beta as proxy for quality/liquidity
  if ((stock.beta || 1) < 1.0) return { score: 0, reasons: ["Low beta — not a mean reversion candidate (+0)"] };

  // RSI oversold — stock is beaten down (20pts)
  if (stock.rsi <= 35)                        { score += 20; reasons.push(`RSI ${stock.rsi} - deeply oversold (+20)`); }
  else if (stock.rsi <= 42)                   { score += 12; reasons.push(`RSI ${stock.rsi} - oversold (+12)`); }
  else if (stock.rsi <= 48)                   { score += 5;  reasons.push(`RSI ${stock.rsi} - near oversold (+5)`); }
  else return { score: 0, reasons: [`RSI ${stock.rsi} not oversold — skip mean reversion`] };

  // Multi-scan oversold bonus — RSI ≤ 35 for 2+ consecutive scans = genuine capitulation
  const oversoldScans = state._oversoldCount ? (state._oversoldCount[stock.ticker] || 0) : 0;
  if (oversoldScans >= 3)      { score += 15; reasons.push(`Oversold ${oversoldScans} consecutive scans — capitulation (+15)`); }
  else if (oversoldScans >= 2) { score += 8;  reasons.push(`Oversold ${oversoldScans} consecutive scans (+8)`); }

  // Drawdown from recent high — how cheap is the stock? (25pts)
  if (bars && bars.length >= 20) {
    const recentHigh = Math.max(...bars.slice(-20).map(b => b.h));
    const currentPrice = bars[bars.length - 1].c;
    const drawdown = (recentHigh - currentPrice) / recentHigh;
    if (drawdown >= 0.20)      { score += 25; reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high — deep discount (+25)`); }
    else if (drawdown >= 0.12) { score += 15; reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high — discount (+15)`); }
    else if (drawdown >= 0.07) { score += 8;  reasons.push(`Down ${(drawdown*100).toFixed(0)}% from 20d high (+8)`); }
    else                       { score += 0;  reasons.push(`Only down ${(drawdown*100).toFixed(0)}% — not enough discount (+0)`); }
  }

  // MACD forming base or bullish crossover = possible reversal (15pts)
  if (stock.macd.includes("bullish crossover")) { score += 15; reasons.push("MACD bullish crossover — reversal signal (+15)"); }
  else if (stock.macd.includes("forming"))      { score += 10; reasons.push("MACD forming base — bottom building (+10)"); }
  else if (stock.macd.includes("bullish"))      { score += 5;  reasons.push("MACD bullish (+5)"); }
  else                                          { reasons.push("MACD bearish — wait for base (+0)"); }

  // VIX level bonus — higher VIX = cheaper calls relative to intrinsic move potential (15pts)
  if (vix >= 35)      { score += 15; reasons.push(`VIX ${vix} — extreme fear, calls historically cheap (+15)`); }
  else if (vix >= 30) { score += 10; reasons.push(`VIX ${vix} — elevated fear (+10)`); }
  else if (vix >= 25) { score += 5;  reasons.push(`VIX ${vix} — moderate fear (+5)`); }

  // Quality / catalyst (15pts)
  if (stock.catalyst)  { score += 10; reasons.push(`Recovery catalyst: ${stock.catalyst} (+10)`); }

  // ADX — low ADX means trend is weakening (good for reversal) (10pts)
  if (adx && adx < 20) { score += 10; reasons.push(`ADX ${adx} - weak trend, reversal likely (+10)`); }
  else if (adx && adx < 30) { score += 5; reasons.push(`ADX ${adx} - trend weakening (+5)`); }

  return { score: Math.min(score, 100), reasons, isMeanReversion: true };
}

// - Put Setup Scoring -
function scorePutSetup(stock, relStrength, adx, volume, avgVolume, vix = 20) {
  let score = 0;
  const reasons = [];

  // Momentum - weak is good for puts (20pts)
  if (stock.momentum === "recovering")       { score += 20; reasons.push("Weak momentum - bearish (+20)"); }
  else if (stock.momentum === "steady")      { score += 10; reasons.push("Neutral momentum (+10)"); }
  else                                       { score += 0;  reasons.push("Strong momentum - bad for put (+0)"); }

  // RSI — RAISED to 20pts (more reliable signal, especially in trending markets)
  if (stock.rsi >= 72)                       { score += 20; reasons.push(`RSI ${stock.rsi} - overbought (+20)`); }
  else if (stock.rsi >= 65 && stock.rsi < 72){ score += 12; reasons.push(`RSI ${stock.rsi} - elevated (+12)`); }
  else if (stock.rsi <= 45)                  { score += 5;  reasons.push(`RSI ${stock.rsi} - oversold caution (+5)`); }
  else                                       { reasons.push(`RSI ${stock.rsi} neutral for put (+0)`); }

  // MACD — confirms direction. Bullish MACD on a put = contradicting signal = PENALTY
  if (stock.macd.includes("bearish crossover")) { score += 10; reasons.push("MACD bearish crossover (+10)"); }
  else if (stock.macd.includes("bearish"))      { score += 7;  reasons.push("MACD bearish (+7)"); }
  else if (stock.macd.includes("neutral"))      { score += 3;  reasons.push("MACD neutral (+3)"); }
  else if (stock.macd.includes("bullish crossover")) { score -= 12; reasons.push("MACD bullish crossover — contradicts put (-12)"); }
  else                                          { score -= 8;  reasons.push("MACD bullish — contradicts put (-8)"); }

  // IV Percentile — ADJUSTED for VIX environment
  // High VIX: high IVP is expected and acceptable — options are expensive but moves are big
  // Low VIX: penalize high IVP more — no reason to buy expensive puts in calm market
  const ivpP = stock.ivPercentile || 50;
  const highVIX = vix > 30;
  if (ivpP < 30)       { score += 15; reasons.push(`IVP ${ivpP}% - cheap options (+15)`); }
  else if (ivpP < 50)  { score += 10; reasons.push(`IVP ${ivpP}% - moderate (+10)`); }
  else if (ivpP < 70)  { score += highVIX ? 8 : 5; reasons.push(`IVP ${ivpP}% - elevated (${highVIX ? "+8 high VIX" : "+5"})`); }
  else                 { score += highVIX ? 5 : 0; reasons.push(`IVP ${ivpP}% - expensive (${highVIX ? "+5 high VIX justified" : "+0"})`); }

  // News sentiment (15pts) — replaces static bearishCatalyst
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

  // Volume confirmation — DIRECTIONAL: below VWAP + high vol = stronger put signal
  const belowVWAP = stock.intradayVWAP > 0 && (stock.price || 0) < stock.intradayVWAP;
  if (volume && avgVolume && volume > avgVolume * 1.2) {
    const volPts = belowVWAP ? 12 : 8; // directional bonus when below VWAP
    score += volPts; reasons.push(`Above-avg volume ${belowVWAP ? "+ below VWAP" : ""} (+${volPts})`);
  } else if (volume && avgVolume && volume > avgVolume) {
    score += 5; reasons.push("Average volume (+5)");
  } else { reasons.push("Low volume (+0)"); }

  // Relative weakness vs SPY — capped at 15pts, tracked for group cap
  let spyWeakPts = 0;
  if (relStrength < 0.93)      { spyWeakPts = 15; reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+15)`); }
  else if (relStrength < 0.97) { spyWeakPts = 8;  reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+8)`); }
  else if (relStrength < 1.0)  { spyWeakPts = 3;  reasons.push(`Slightly weak vs SPY (+3)`); }
  else                         { reasons.push(`Outperforming SPY - bad for put (+0)`); }
  score += spyWeakPts;

  // ADX — RAISED to 15pts max (strong downtrend is a top-tier confirmation)
  if (adx && adx > 35)      { score += 15; reasons.push(`ADX ${adx} - very strong downtrend (+15)`); }
  else if (adx && adx > 25) { score += 10; reasons.push(`ADX ${adx} - strong trend (+10)`); }
  else if (adx && adx > 18) { score += 5;  reasons.push(`ADX ${adx} - emerging trend (+5)`); }

  // ── F6: Signal consensus gate ──────────────────────────────────────────
  // 90+ score requires at least 3 independent bullish signals
  // Prevents weak setups from hitting 100 on environmental factors alone
  const bullishSignals = [
    stock.rsi >= 65,
    stock.macd.includes("bearish"),
    stock.momentum === "recovering",
    (relStrength < 0.97),
    (adx && adx > 25),
    (volume > avgVolume * 1.2),
  ].filter(Boolean).length;
  if (score >= 90 && bullishSignals < 3) {
    score = 80; // cap at 80 — not enough independent signals
    reasons.push(`Score capped at 80 — only ${bullishSignals}/3 required signals agree`);
  }

  // ── F11: Entry quality gate — RSI and MACD must agree ───────────────────
  // If RSI says overbought (bearish for stock) but MACD says bullish,
  // the two primary signals conflict. Flag it.
  const rsiPutSignal  = stock.rsi >= 65;
  const macdPutSignal = stock.macd.includes("bearish");
  if (!rsiPutSignal && !macdPutSignal) {
    score = Math.max(0, score - 15);
    reasons.push("Neither RSI nor MACD confirm put direction (-15)");
  }

  // Hard cap at 95 — a 100/100 is now mathematically impossible
  // Forces discrimination between setups even in broad selloffs
  return { score: Math.min(Math.max(score, 0), 95), reasons };
}

// - Alpaca API -
const alpacaHeaders = () => ({
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type":        "application/json",
});

// API call tracking — informational only, Pro tier has no rate limit
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

// Timeout wrapper — kills hung API calls after 5 seconds
function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("API timeout")), ms))
  ]);
}

async function alpacaGet(endpoint, base = ALPACA_BASE) {
  try {
    trackAPICall();
    const res  = await withTimeout(fetch(`${base}${endpoint}`, { headers: alpacaHeaders() }));
    const text = await res.text();
    if (text.startsWith("<")) {
      // HTML response = rate limit or auth error
      if (res.status === 429) { logEvent("warn", `Rate limit hit: ${endpoint} — slowing down`); await new Promise(r => setTimeout(r, 2000)); }
      else if (res.status === 401 || res.status === 403) { logEvent("error", `Auth error ${res.status} on ${endpoint} — check API keys`); }
      else { logEvent("warn", `API returned HTML on ${endpoint} (status ${res.status}) — skipping`); }
      return null;
    }
    return JSON.parse(text);
  } catch(e) { logEvent("error", `alpacaGet(${endpoint}): ${e.message}`); return null; }
}

async function alpacaPost(endpoint, body, method = "POST") {
  try {
    const opts = { method, headers: alpacaHeaders() };
    if (body && Object.keys(body).length > 0) opts.body = JSON.stringify(body);
    const res = await withTimeout(fetch(`${ALPACA_BASE}${endpoint}`, opts), 8000);
    const text = await res.text();
    if (!text || text.trim() === "") return { ok: true }; // DELETE returns empty
    return JSON.parse(text);
  } catch(e) { logEvent("error", `alpacaPost(${endpoint}): ${e.message}`); return null; }
}

async function alpacaDelete(endpoint) {
  return alpacaPost(endpoint, {}, "DELETE");
}

// Get latest stock quote
async function getStockQuote(ticker) {
  const data = await alpacaGet(`/stocks/${ticker}/quotes/latest`, ALPACA_DATA);
  if (data && data.quote) {
    // Stale data check — reject quotes older than 5 minutes during market hours
    const quoteTime = data.quote.t ? new Date(data.quote.t).getTime() : Date.now();
    const ageMs     = Date.now() - quoteTime;
    const STALE_MS  = 5 * 60 * 1000; // 5 minutes
    if (ageMs > STALE_MS && isMarketHours()) {
      logEvent("warn", `${ticker} quote is ${(ageMs/60000).toFixed(1)}min old — stale data, skipping`);
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
  // Daily bars only update once per day — cache for 60 minutes
  const cacheKey = 'bars:' + ticker + ':' + limit;
  const cached = getCached(cacheKey, BARS_CACHE_TTL);
  if (cached) return cached;
  try {
    // Always use date range — more reliable than limit param across all Alpaca tiers
    const end   = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - Math.ceil(limit * 1.6) * MS_PER_DAY).toISOString().split("T")[0];
    // Try SIP feed first (Pro tier), fall back to IEX (free tier)
    const feeds = ["sip", "iex"];
    for (const feed of feeds) {
      const url  = `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&feed=${feed}`;
      const data = await alpacaGet(url, ALPACA_DATA);
      if (data && data.bars && data.bars.length > 1) {
        // Daily bars don't change intraday — cache for 60 minutes
        return setCache('bars:' + ticker + ':' + limit, data.bars);
      }
    }
    // Last resort — no feed param
    const last = await alpacaGet(`/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}`, ALPACA_DATA);
    return last && last.bars ? last.bars : [];
  } catch(e) { return []; }

}

// Get intraday bars — 1-minute candles for today's session
// Used for real-time RSI, MACD, VWAP, momentum signals
// 1-minute gives maximum real-time accuracy — updated every scan cycle
async function getIntradayBars(ticker, minutes = 390) {
  try {
    // Calculate market open in ET (Railway runs UTC — must use ET explicitly)
    const nowET       = getETTime();
    const marketOpen  = new Date(nowET);
    marketOpen.setHours(9, 30, 0, 0);

    // Convert ET market open back to UTC ISO for Alpaca API
    // getETTime returns a Date object representing ET — get its UTC equivalent
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

// Get VIX — cached for 60 seconds to avoid redundant API calls
let _vixCache = { value: 15, ts: 0 };
async function getVIX() {
  if (Date.now() - _vixCache.ts < 60000) return _vixCache.value; // use cache
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

    // Alpaca returned nothing — try Marketaux with company name
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
let vixFallingPause = false; // true when VIX is falling — suppresses new put entries
function checkVIXVelocity(currentVIX) {
  if (lastVIXReading === 0) { lastVIXReading = currentVIX; return false; }
  const delta   = currentVIX - lastVIXReading;
  const prevVIX = lastVIXReading; // save before updating
  lastVIXReading = currentVIX;
  const fallPct = prevVIX > 0 ? (delta / prevVIX) : 0;

  // Black swan: VIX spiked 8+ points — close all positions
  if (delta >= 8) {
    logEvent("circuit", `VIX VELOCITY ALERT - jumped ${delta.toFixed(1)} points to ${currentVIX} - closing all positions`);
    return true;
  }

  // VIX falling >3% = market recovering = pause new put entries
  // Falling VIX means options premiums deflating — puts entered now lose value fast
  if (delta <= -1.0 && fallPct <= -0.03) {
    if (!vixFallingPause) logEvent("filter", `VIX falling (${delta.toFixed(1)} pts) — pausing new PUT entries until VIX stabilizes`);
    vixFallingPause = true;
  } else if (delta >= 0) {
    // VIX stable or rising — resume put entries
    if (vixFallingPause) logEvent("filter", `VIX stabilized — resuming PUT entries`);
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
// ── F16: Aggregate vega + gamma ──────────────────────────────────────────
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
  // Use cached SPY price from scan context, or fetch fresh — never use hardcoded value
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
    if (soonest.daysTo === 0) return { modifier: -25, events, message: `${soonest.event} TODAY — minimal new entries` };
    if (soonest.daysTo <= 1) return { modifier: -15, events, message: `${soonest.event} tomorrow — reduced sizing` };
    if (soonest.daysTo <= 3) return { modifier: -8,  events, message: `${soonest.event} in ${soonest.daysTo} days — caution` };
  }
  return { modifier: 0, events };
}

// ── Relative Value Screening ─────────────────────────────────────────────
function getRelativeValueScreening() {
  const bySector = {};
  for (const stock of WATCHLIST) {
    if (!bySector[stock.sector]) bySector[stock.sector] = [];
    bySector[stock.sector].push({ ticker: stock.ticker, ivr: stock.ivr, beta: stock.beta });
  }
  const results = {};
  for (const [sector, stocks] of Object.entries(bySector)) {
    const sorted = [...stocks].sort((a, b) => a.ivr - b.ivr);
    results[sector] = {
      cheapest:      sorted[0],
      mostExpensive: sorted[sorted.length - 1],
      avgIVR:        parseFloat((stocks.reduce((s, st) => s + st.ivr, 0) / stocks.length).toFixed(1)),
      stocks:        sorted,
    };
  }
  return results;
}

// ── Earnings Quality Scoring ──────────────────────────────────────────────
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

// ── Factor Model ──────────────────────────────────────────────────────────
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

// ── Monte Carlo Simulation ────────────────────────────────────────────────
function runMonteCarlo(iterations = 1000) {
  const trades = state.closedTrades || [];
  if (trades.length < 10) return { median: 0, percentile5: 0, percentile95: 0, probProfit: 0, message: "Need 10+ closed trades" };
  const returns   = trades.map(t => t.pnl || 0);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stdDev    = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length);
  const simResults = [];
  const tradesPerSim = Math.max(5, Math.round(returns.length / 2)) * 3;
  for (let i = 0; i < iterations; i++) {
    let cash = state.cash;
    for (let t = 0; t < tradesPerSim; t++) {
      const u1 = Math.random(), u2 = Math.random();
      const pnl = avgReturn + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      cash += pnl;
      if (cash < CAPITAL_FLOOR) { cash = CAPITAL_FLOOR; break; }
    }
    simResults.push(parseFloat((cash - state.cash).toFixed(2)));
  }
  simResults.sort((a, b) => a - b);
  return {
    iterations,
    median:       simResults[Math.floor(iterations * 0.50)],
    percentile5:  simResults[Math.floor(iterations * 0.05)],
    percentile25: simResults[Math.floor(iterations * 0.25)],
    percentile75: simResults[Math.floor(iterations * 0.75)],
    percentile95: simResults[Math.floor(iterations * 0.95)],
    probProfit:   Math.round(simResults.filter(r => r > 0).length / iterations * 100),
    message:      `Based on ${trades.length} historical trades`,
  };
}

// ── Kelly Criterion ───────────────────────────────────────────────────────
function calcKellySize(recentTrades = 20) {
  const trades  = (state.closedTrades || []).slice(0, recentTrades);
  if (trades.length < 5) return { contracts: 1, kelly: 0, halfKelly: 0, winRate: 0, payoffRatio: 0 };
  const wins      = trades.filter(t => t.pnl > 0);
  const losses    = trades.filter(t => t.pnl <= 0);
  const winRate   = wins.length / trades.length;
  const avgWin    = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss   = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  const payoff    = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kelly     = winRate - (1 - winRate) / payoff;
  const halfKelly = Math.max(0, kelly * 0.5);
  const contracts = Math.min(3, Math.max(1, Math.round(halfKelly * 10)));
  return { contracts, kelly: parseFloat(kelly.toFixed(3)), halfKelly: parseFloat(halfKelly.toFixed(3)), winRate: parseFloat((winRate*100).toFixed(1)), payoffRatio: parseFloat(payoff.toFixed(2)) };
}

// ── Regime Detection ─────────────────────────────────────────────────────
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
// ── F9: Regime strategy profiles ────────────────────────────────────────
// Each regime has different min score, max positions, and exit tightness
function getRegimeProfile(regime) {
  switch(regime) {
    case "trending_bear":
      return { minScore: 75, maxPositions: 6, trailMult: 1.0, label: "Trending Bear — puts on bounces" };
    case "trending_bull":
      return { minScore: 85, maxPositions: 4, trailMult: 0.8, label: "Trending Bull — puts need high conviction" };
    case "choppy":
      return { minScore: 90, maxPositions: 3, trailMult: 0.7, label: "Choppy — tight exits, high threshold" };
    case "breakdown":
      return { minScore: 70, maxPositions: 8, trailMult: 1.2, label: "Breakdown — aggressive puts" };
    case "crash":
      return { minScore: 65, maxPositions: 9, trailMult: 1.3, label: "Crash — maximum puts" };
    default:
      return { minScore: 70, maxPositions: 6, trailMult: 1.0, label: "Neutral" };
  }
}

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

// ── Stress Test ───────────────────────────────────────────────────────────
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
      // Use abs(delta) — direction is handled by mult separately
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

// ── Time of Day Analysis ──────────────────────────────────────────────────
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

// ── Concentration Risk ────────────────────────────────────────────────────
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
    sectorTotals[pos.sector] = (sectorTotals[pos.sector] || 0) + pos.cost;
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

// ── Drawdown Recovery Protocol ────────────────────────────────────────────
function getDrawdownProtocol() {
  const trades    = state.closedTrades || [];
  const peak      = state.peakCash || MONTHLY_BUDGET;
  const current   = state.cash + (state.positions || []).reduce((s, p) => s + p.cost, 0);
  const drawdown  = (current - peak) / peak * 100;
  const losses    = state.consecutiveLosses || 0;

  // Only trigger drawdown protocol if we have actual trade history
  // Prevents false triggers on fresh accounts or after restarts
  if (trades.length < 3 && losses === 0) {
    return { level: "normal", sizeMultiplier: 1.0, message: "Normal operations.", minScore: MIN_SCORE };
  }

  if (drawdown <= -20 || losses >= 5) {
    return { level: "critical", sizeMultiplier: 0.25, message: "CRITICAL - 25% position sizing. Calls only on A+ setups (85+).", minScore: 85 };
  } else if (drawdown <= -15 || losses >= 4) {
    return { level: "severe",   sizeMultiplier: 0.50, message: "SEVERE - 50% position sizing. Score threshold raised to 80.", minScore: 80 };
  } else if (drawdown <= -10 || losses >= 3) {
    return { level: "caution",  sizeMultiplier: 0.75, message: "CAUTION - 75% position sizing. Score threshold raised to 75.", minScore: 75 };
  }
  return { level: "normal", sizeMultiplier: 1.0, message: "Normal operations.", minScore: MIN_SCORE };
}

// ── Benchmark Comparison ──────────────────────────────────────────────────
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

// ── Tail Risk Hedge ───────────────────────────────────────────────────────
async function checkTailRiskHedge() {
  // Auto-buy cheap OTM SPY puts when VIX is low and we have large call exposure
  const vix       = state.vix || 15;
  const positions = state.positions || [];
  const callValue = positions.filter(p => p.optionType === "call").reduce((s, p) => s + p.cost, 0);
  const hasPutHedge = positions.some(p => p.ticker === "SPY" && p.optionType === "put");

  // Only hedge when VIX is low (cheap puts) and we have significant call exposure
  if (vix < 18 && callValue > 2000 && !hasPutHedge && isEntryWindow("put")) {
    logEvent("risk", `Tail risk hedge triggered - VIX:${vix} call exposure:${fmt(callValue)} - adding SPY put hedge`);
    const spyPrice = await getStockQuote("SPY");
    if (spyPrice) {
      const spyStock = { ticker:"SPY", sector:"Index", momentum:"steady", rsi:50, macd:"neutral", ivr:22, beta:1.0, earningsDate:null };
      await executeTrade(spyStock, spyPrice, 70, ["Tail risk hedge"], vix, "put");
    }
  }
}

// ── Position Scaling ──────────────────────────────────────────────────────
// Enter half position first, add second half if trade confirms (+5% in 24hrs)
async function checkScaleIns() {
  for (const pos of state.positions) {
    if (!pos.halfPosition || pos.partialClosed) continue;
    const hoursOpen = (Date.now() - new Date(pos.openDate).getTime()) / 3600000;
    if (hoursOpen < 24) continue;

    // Use real options price for scale-in decision
    let curP = pos.currentPrice || pos.premium;
    if (pos.contractSymbol) {
      const realP = await getOptionsPrice(pos.contractSymbol);
      if (realP) curP = realP;
    }
    const chg = (curP - pos.premium) / pos.premium;

    // If up 5%+ after 24hrs, add second half at current market price
    const addContracts = pos.contracts;
    const addCost      = parseFloat((curP * 100 * addContracts).toFixed(2));

    if (chg >= 0.05 && state.cash > CAPITAL_FLOOR + addCost) {
      // Submit scale-in order to Alpaca
      if (pos.contractSymbol && pos.ask > 0 && !dryRunMode) {
        try {
          const scaleBody = {
            symbol:        pos.contractSymbol,
            qty:           addContracts,
            side:          "buy",
            type:          "limit",
            time_in_force: "day",
            limit_price:   parseFloat(pos.ask.toFixed(2)),
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

// ── Macro News Scanner -
// ── Macro keyword scoring with weights ────────────────────────────────────
// Each keyword has a weight (1-3) — high-impact events score more than minor ones
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

// Credible source list — articles from these sources get a 1.5x weight multiplier
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

// ── Marketaux news fetch ──────────────────────────────────────────────────
// Returns top financial headlines from credible sources
// Requires MARKETAUX_KEY env var — gracefully skips if not set
// ── Claude Agent Helper ──────────────────────────────────────────────────
// Single reusable function for all Claude API calls in APEX
// Falls back gracefully if key not set or call fails
// Agent tools definition — passed to Claude API for tool use
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
  }
];

async function callClaudeAgent(systemPrompt, userPrompt, maxTokens = 800, useTools = false) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const messages = [{ role: "user", content: userPrompt }];
    const body = {
      model:      ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system:     systemPrompt,
      messages,
    };
    if (useTools) body.tools = AGENT_TOOLS;

    const res = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify(body),
    }), 20000);

    if (!res.ok) {
      const err = await res.text();
      console.log("[AGENT] API error:", err.slice(0, 150));
      return null;
    }

    const data = await res.json();

    // Handle tool use — agent wants to fetch live data
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

      const followRes = await withTimeout(fetch("https://api.anthropic.com/v1/messages", {
        method:  "POST",
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemPrompt, messages: followMessages }),
      }), 20000);

      if (!followRes.ok) return null;
      const followData = await followRes.json();
      const text = followData.content?.find(b => b.type === "text")?.text || "";
      return text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    }

    // Normal text response
    const text = data.content?.find(b => b.type === "text")?.text || "";
    return text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  } catch(e) {
    console.log("[AGENT] Call failed:", e.message);
    return null;
  }
}

// Marketaux cache — only fetch every 30 minutes to stay within free tier (100/day)
let _marketauxCache = { data: [], fetchedAt: 0 };
const MARKETAUX_CACHE_MS = 60 * 60 * 1000; // 60 minutes — stays well under free tier 100/day limit

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

// ── Agent-powered macro analysis ─────────────────────────────────────────
// Replaces keyword matching with genuine language understanding
// Falls back to keyword system if agent unavailable
let _agentMacroCache = { result: null, fetchedAt: 0 };
const AGENT_MACRO_CACHE_MS = 5 * 60 * 1000; // 5 minutes — matches scan tier

async function getAgentMacroAnalysis(headlines) {
  if (!ANTHROPIC_API_KEY || !headlines || headlines.length === 0) return null;
  // Return cached result if fresh
  if (_agentMacroCache.result && Date.now() - _agentMacroCache.fetchedAt < AGENT_MACRO_CACHE_MS) {
    return _agentMacroCache.result;
  }
  const systemPrompt = `You are a professional options trader's macro analyst. You read financial news headlines and assess their impact on US equity markets and options positioning.

Your job: analyze the provided headlines and return a JSON object with your assessment.

Respond ONLY with valid JSON, no other text. Format:
{
  "signal": "strongly bearish" | "bearish" | "mild bearish" | "neutral" | "mild bullish" | "bullish" | "strongly bullish",
  "confidence": "high" | "medium" | "low",
  "modifier": number between -20 and +15,
  "mode": "defensive" | "cautious" | "normal" | "aggressive",
  "reasoning": "1-2 sentence plain English explanation",
  "affectedTickers": ["array of ticker symbols directly mentioned or clearly affected"],
  "bearishTickers": ["tickers where puts are favored right now"],
  "bullishTickers": ["tickers where calls are favored right now"],
  "keyThemes": ["array of 2-4 key macro themes e.g. tariffs, Fed, earnings"],
  "topStories": [
    {"headline": "...", "source": "...", "direction": "bearish"|"bullish"|"neutral", "importance": "high"|"medium"|"low"}
  ]
}

Guidelines:
- modifier -20 = strongly bearish (major crash risk), +15 = strongly bullish (major rally catalyst)
- "defensive" mode = only put entries, no calls; "aggressive" = both, prefer calls
- Focus on what MATTERS for options traders in the next 4 hours, not long-term
- Distinguish between stock-specific news and broad macro news
- If headlines are stale (>6 hours old) or irrelevant, return neutral with low confidence`;

  const userPrompt = `Current market context:
- VIX: ${state.vix || 20}
- Time: ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York'})} ET
- Open positions: ${(state.positions||[]).map(p => p.ticker).join(', ') || 'none'}

Headlines to analyze (newest first):
${headlines.slice(0, 15).map((h, i) => (i+1) + '. ' + h).join('\n')}

Analyze these headlines and return your JSON assessment.`;

  const raw = await callClaudeAgent(systemPrompt, userPrompt, 1200, true); // useTools=true
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Validate required fields
    if (!parsed.signal || parsed.modifier === undefined) return null;
    _agentMacroCache = { result: parsed, fetchedAt: Date.now() };
    logEvent("macro", `[AGENT] Macro: ${parsed.signal} (${parsed.confidence}) | ${parsed.reasoning?.slice(0,80)}`);
    return parsed;
  } catch(e) {
    console.log("[AGENT] Failed to parse macro response:", raw.slice(0,100));
    return null;
  }
}

// ── Live rescore agent ────────────────────────────────────────────────────
// Rescores an open position against current conditions
// Returns { score, label, reasoning, recommendation }
async function getAgentRescore(pos) {
  if (!ANTHROPIC_API_KEY) return null;
  const systemPrompt = `You are a professional options trader reviewing an open position. Assess whether the original entry thesis still holds given current conditions.

Respond ONLY with valid JSON:
{
  "score": number 0-95,
  "label": "STRONG" | "VALID" | "WEAK" | "DEGRADED" | "INVALID",
  "reasoning": "1 sentence explanation",
  "recommendation": "HOLD" | "WATCH" | "EXIT"
}

Score meaning: 85+ = thesis fully intact, 70-84 = mostly valid, 50-69 = weakening, <50 = thesis broken`;

  const daysOpen   = ((Date.now() - new Date(pos.openDate).getTime()) / 86400000).toFixed(1);
  const chgPct     = pos.currentPrice && pos.premium
    ? ((pos.currentPrice - pos.premium) / pos.premium * 100).toFixed(1) : '0';
  const userPrompt = `Position to rescore:
- ${pos.ticker} ${pos.optionType.toUpperCase()} $${pos.strike} exp ${pos.expDate}
- Entry: $${pos.premium} | Current: $${pos.currentPrice || pos.premium} | P&L: ${chgPct}%
- Opened: ${daysOpen} days ago | DTE remaining: ${Math.max(0, Math.round((new Date(pos.expDate)-new Date())/86400000))}d
- Entry score: ${pos.score}/100 | Entry reasons: ${(pos.reasons||[]).slice(0,4).join('; ')}
- Stock price: $${pos.price || '--'} | RSI at entry: ${pos.entryRSI || '--'}
- Current VIX: ${state.vix} | Macro signal: ${(state._agentMacro || {}).signal || 'neutral'}

Does the put thesis still hold? Score and recommend.`;

  const raw = await callClaudeAgent(systemPrompt, userPrompt, 600, true); // useTools=true
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch(e) { return null; }
}

// ── Agent Tool Functions ─────────────────────────────────────────────────
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
    ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / 86400000)) : null;
  const daysOpen = ((Date.now() - new Date(pos.openDate).getTime()) / 86400000).toFixed(1);
  return {
    ticker, optionType: pos.optionType, strike: pos.strike, expDate: pos.expDate,
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
      pdtRemaining: Math.max(0, 3 - countRecentDayTrades()),
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
    } catch(e) { results[call.name] = { error: e.message }; }
  }
  return results;
}

// ── Agent morning briefing writer ────────────────────────────────────────
// Called at 8:45am ET — writes the analyst narrative for the morning email
async function getAgentMorningBriefing(positions, macro, headlines) {
  if (!ANTHROPIC_API_KEY) return null;

  const systemPrompt = `You are the head of a proprietary options trading desk writing a morning briefing for a solo trader.
Write in the style of a senior analyst — direct, confident, actionable.
No fluff, no disclaimers, no "please note". Just what matters.

You have tools to fetch live market data — use them to get current prices and signals before writing.

Your briefing has three parts:
1. MARKET OPEN (2-3 sentences): What is the macro setup going into today's open? VIX, SPY direction, key themes.
2. POSITION REVIEW (1 sentence per position): For each open position, check its current status and say whether to hold, watch, or exit and why.
3. OPPORTUNITIES (1-2 sentences): Any mean reversion call opportunities forming? Any positions approaching targets?

Keep the entire briefing under 200 words. Be specific with numbers.`;

  const positionList = positions.map(p =>
    p.ticker + ' ' + p.optionType.toUpperCase() + ' $' + p.strike +
    ' | Entry $' + p.premium + ' | DTE ' + (p.expDate ? Math.max(0,Math.round((new Date(p.expDate)-new Date())/86400000)) : '?') + 'd'
  ).join('\n');

  const userPrompt = `Today is ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}.

Current macro signal: ${macro.signal || 'neutral'} ${macro.agentReasoning ? '— ' + macro.agentReasoning : ''}
VIX: ${state.vix} | Cash: $${(state.cash||0).toFixed(0)} | PDT remaining: ${Math.max(0,3-countRecentDayTrades())}/3

Open positions:
${positionList || 'None'}

Key headlines overnight:
${headlines.slice(0,5).join('\n')}

Use your tools to check current prices and signals for each position, then write the morning briefing.`;

  try {
    const raw = await callClaudeAgent(systemPrompt, userPrompt, 1500, true);
    if (!raw) return null;
    // Return as plain text — not JSON
    return raw;
  } catch(e) {
    console.log("[AGENT] Morning briefing error:", e.message);
    return null;
  }
}

// ── Score a single article against keyword lists ──────────────────────────
// Returns { bearishScore, bullishScore, triggers, sectorImpact }
// Applies: keyword weight × source credibility × recency multiplier
function scoreArticle(article) {
  const text       = (article.headline + " " + (article.summary || "")).toLowerCase();
  const source     = (article.source || "").toLowerCase();
  const ageMinutes = (Date.now() - new Date(article.publishedAt || 0).getTime()) / 60000;

  // Source credibility multiplier
  const isCredible    = CREDIBLE_SOURCES.some(s => source.includes(s) || text.includes(s));
  const sourceMult    = isCredible ? 1.5 : 1.0;

  // Recency multiplier — news within 2 hours is most relevant
  const recencyMult   = ageMinutes < 120  ? 2.0   // last 2 hours — breaking news
                      : ageMinutes < 360  ? 1.5   // last 6 hours
                      : ageMinutes < 720  ? 1.2   // last 12 hours
                      : ageMinutes < 1440 ? 1.0   // last 24 hours
                      : 0.5;                      // older — deprioritize

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
  try {
    // Fetch from both sources in parallel — Alpaca + Marketaux
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

    // Deduplicate by headline similarity — avoid double-counting same story
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

      // Track top stories for email — credible sources with meaningful scores
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
    if (net <= -6)      { signal = "strongly bearish"; scoreModifier = -20; mode = "defensive"; }
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
    const uniqueTriggers = Object.entries(triggerMap)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 5)
      .map(([kw]) => kw);

    const sourceCount = marketauxArticles.length > 0
      ? `Alpaca(${alpacaArticles.length}) + Marketaux(${marketauxArticles.length})`
      : `Alpaca(${alpacaArticles.length})`;

    if (uniqueTriggers.length > 0) {
      logEvent("macro", `Macro: ${signal} | ${sourceCount} | triggers: ${uniqueTriggers.join(", ")} | modifier: ${scoreModifier > 0 ? "+" : ""}${scoreModifier}`);
    }

    // ── Agent enhancement — replace keyword scoring with Claude analysis ───
    // If agent available, use it. Keep keyword results as fallback data.
    if (ANTHROPIC_API_KEY && headlines.length > 0) {
      try {
        const agentResult = await getAgentMacroAnalysis(headlines);
        if (agentResult) {
          // Store for rescore use
          state._agentMacro = agentResult;
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
          return {
            signal:       agentResult.signal,
            scoreModifier:mapped.modifier,
            mode:         agentResult.mode || mapped.mode,
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
        }
      } catch(agentErr) {
        logEvent("warn", `[AGENT] Macro analysis failed, using keywords: ${agentErr.message}`);
      }
    }

    // Keyword fallback
    return {
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
  } catch(e) {
    logEvent("error", `getMacroNews: ${e.message}`);
    return { signal: "neutral", scoreModifier: 0, mode: "normal", triggers: [], topStories: [], sectorBearish: [], sectorBullish: [] };
  }
}

// - Fear & Greed -
async function getFearAndGreed() {
  try {
    const res  = await withTimeout(fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata"), 5000);
    const data = await res.json();
    const score  = data?.fear_and_greed?.score || 50;
    const rating = data?.fear_and_greed?.rating || "neutral";
    return { score: parseFloat(parseFloat(score).toFixed(0)), rating };
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

// - Sector Rotation -
async function getSectorRotation() {
  try {
    const sectorETFs = { Technology:"XLK", Financial:"XLF", Consumer:"XLY", Energy:"XLE", Health:"XLV" };
    const perf = {};
    // Fetch all sector ETF bars in parallel instead of sequentially
    const entries = Object.entries(sectorETFs);
    const allBars = await Promise.all(entries.map(([, etf]) => getStockBars(etf, 5)));
    entries.forEach(([sector], i) => {
      const bars = allBars[i];
      if (bars.length >= 2) perf[sector] = (bars[bars.length-1].c - bars[0].c) / bars[0].c * 100;
    });
    const sorted  = Object.entries(perf).sort((a, b) => b[1] - a[1]);
    return {
      leading:     sorted[0]?.[0] || "Technology",
      lagging:     sorted[sorted.length-1]?.[0] || "Energy",
      performance: perf
    };
  } catch(e) { return { leading: "Technology", lagging: "Energy", performance: {} }; }
}

async function getRealOptionsContract(ticker, price, optionType, score, vix, earningsDate) {
  try {
    // Determine target expiry window
    const { expDate: targetExpDate, expDays: targetExpDays, expiryType } = selectExpiry(score, vix, optionType, earningsDate, ticker);
  // LEAPS use deeper ITM delta (0.70-0.80) for better intrinsic value retention
  const isLeaps      = expiryType === "leaps";
  const isPut        = optionType === "put";
  const isExpensive  = price > 400;  // high-priced stocks need wider delta range
  const isCheap      = price < 100;  // low-priced stocks have fewer strikes, need wider range

  // Delta range by stock price tier:
  // Cheap (<$100): 0.28-0.50 — fewer strikes, liquid ones are closer to ATM
  // Normal: 0.28-0.42 — standard target
  // Expensive (>$400): 0.20-0.55 — wide range needed to find liquid OTM puts
  // LEAPS: 0.65-0.85 — deep ITM for intrinsic value retention
  const deltaMin = isLeaps ? 0.65 : (isPut && isExpensive ? 0.20 : TARGET_DELTA_MIN);
  const deltaMax = isLeaps ? 0.85 : (isPut && isCheap ? 0.50 : isPut && isExpensive ? 0.55 : TARGET_DELTA_MAX);
  const strikeRange = 0; // unused — delta now selects contracts, not strike range

    // Format date for API: YYYY-MM-DD
    const today      = getETTime();
    const minExpiry  = new Date(today.getTime() + 3   * MS_PER_DAY).toISOString().split("T")[0]; // 3 day floor — scoring handles DTE preference
    // LEAPS need up to 270 days — use 300 day window to cover all expiry types
    const maxDays    = expiryType === "leaps" ? 300 : 90;
    const maxExpiry  = new Date(today.getTime() + maxDays * MS_PER_DAY).toISOString().split("T")[0];

    // Fetch ALL contracts with no filters — paginate until we have everything
    // No strike filters, no sort tricks — get the full chain and let delta scoring decide
    // This is the only approach that never breaks regardless of market conditions
    const baseUrl = `/options/contracts?underlying_symbol=${ticker}` +
      `&expiration_date_gte=${minExpiry}&expiration_date_lte=${maxExpiry}` +
      `&type=${optionType}&limit=200`;

    // Paginate through all contracts using next_page_token
    let allContracts = [];
    let pageToken = null;
    let pageCount = 0;
    const MAX_PAGES = 5; // cap at 1000 contracts total — enough for any chain

    do {
      const pageUrl = pageToken ? `${baseUrl}&page_token=${pageToken}` : baseUrl;
      const pageData = await alpacaGet(pageUrl, ALPACA_OPTIONS);
      if (!pageData || !pageData.option_contracts) break;
      allContracts = allContracts.concat(pageData.option_contracts);
      pageToken = pageData.next_page_token || null;
      pageCount++;
    } while (pageToken && pageCount < MAX_PAGES);

    if (!allContracts.length) return null;
    logEvent("scan", `${ticker} options chain: ${allContracts.length} contracts across ${pageCount} page(s)`);

    // For expensive stocks, weekly options have near-zero OI — prioritize monthly expiries
    // Sort contracts: monthly expiries (3rd Friday) first, then weeklies
    // This ensures the 200-snapshot limit hits the liquid contracts first
    const getMonthlyExpiries = () => {
      const months = new Set();
      const todayMs = today.getTime();
      for (let m = 0; m <= 4; m++) {
        const d = new Date(todayMs);
        d.setMonth(d.getMonth() + m);
        // Find 3rd Friday of this month
        const first = new Date(d.getFullYear(), d.getMonth(), 1);
        const firstFri = (5 - first.getDay() + 7) % 7;
        const thirdFri = new Date(d.getFullYear(), d.getMonth(), firstFri + 15);
        months.add(thirdFri.toISOString().split('T')[0]);
      }
      return months;
    };
    const monthlyDates = getMonthlyExpiries();
    const sortedContracts = [...allContracts].sort((a, b) => {
      const aMonthly = monthlyDates.has(a.expiration_date) ? 0 : 1;
      const bMonthly = monthlyDates.has(b.expiration_date) ? 0 : 1;
      return aMonthly - bMonthly; // monthly expiries first
    });

    // Get snapshots for ALL contracts — batch into groups of 25 to avoid URL length limits
    const allSymbols = sortedContracts.map(c => c.symbol);
    const batches    = [];
    for (let i = 0; i < allSymbols.length; i += 25) {
      batches.push(allSymbols.slice(i, i + 25).join(","));
    }
    // Try indicative feed first (faster), fall back to opra if greeks are missing
    const snapResults = await Promise.all(
      batches.map(async b => {
        const res = await alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP);
        // Check if greeks are populated — if not, try opra feed
        const snaps = res?.snapshots || {};
        const hasGreeks = Object.values(snaps).some(s => s?.greeks?.delta);
        if (!hasGreeks && Object.keys(snaps).length > 0) {
          const opra = await alpacaGet(`/options/snapshots?symbols=${b}&feed=opra`, ALPACA_OPT_SNAP);
          return opra || res;
        }
        return res;
      })
    );
    const snapshots = snapResults.reduce((acc, r) => ({ ...acc, ...(r?.snapshots || {}) }), {});

    logEvent("scan", `${ticker} options chain: ${allContracts.length} contracts | ${Object.keys(snapshots).length} snapshots with greeks`);

    // Score each contract — find best delta match in 0.28-0.42 range
    let best       = null;
    let bestScore  = -1;
    let skipped    = 0;

    for (const contract of sortedContracts) {
      const snap = snapshots[contract.symbol];
      if (!snap) { skipped++; continue; }

      // Handle both v1 and v2 Alpaca options snapshot field names
      // Confirmed field structure from Alpaca v1beta1 snapshots
      const greeks = snap.greeks || {};
      const quote  = snap.latestQuote || {};
      const day    = snap.dailyBar || snap.day || {};

      const delta  = Math.abs(parseFloat(greeks.delta || 0));
      const iv     = parseFloat(snap.impliedVolatility || greeks.impliedVolatility || 0.3);
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      const spread = ask > 0 ? (ask - bid) / ask : 1;
      const oi     = parseInt(snap.openInterest || quote.as || 0); // use ask size as OI proxy if needed
      const vol    = parseInt(day.v || day.volume || 0);

      // Contract DTE — needed for expiry scoring
      const contractDTE = Math.round((new Date(contract.expiration_date) - today) / MS_PER_DAY);

      // Only hard filter: contract must have a tradeable price
      if (mid <= 0) { skipped++; continue; }
      // Only hard filter on delta — everything else is a scoring factor not a gate
      if (delta < deltaMin || delta > deltaMax) { skipped++; continue; }

      // ── CONTRACT SCORING — higher = better ──────────────────────────────
      // Delta match (50%) — how close to target delta midpoint
      const deltaTarget  = (deltaMin + deltaMax) / 2;
      const deltaRange   = (deltaMax - deltaMin) / 2;
      const deltaScore   = Math.max(0, 1 - Math.abs(delta - deltaTarget) / deltaRange);

      // Expiry proximity (20%) — prefer contracts closest to target DTE
      const dteDistance  = Math.abs(contractDTE - targetExpDays);
      const expiryScore  = Math.max(0, 1 - dteDistance / 30);

      // Liquidity (15%) — OI as proxy, unknown OI gets neutral score
      // OI < 50 gets heavy penalty — essentially no market in live trading
      const liquidScore  = oi === 0 ? 0.5                    // unknown = neutral
                         : oi < 10  ? 0.02                   // essentially no market
                         : oi < 50  ? 0.10                   // very thin
                         : oi < 200 ? Math.min(oi / 1000, 0.4)  // thin but tradeable
                         : Math.min(oi / 5000, 1.0);         // normal

      // Spread quality (15%) — tighter spread = better fill = higher score
      // Wide spread on high-VIX days is expected — penalize but don't exclude
      const spreadScore  = Math.max(0, 1 - spread / 0.30); // 0% spread = 1.0, 30%+ = 0

      // Vol/OI ratio — unusual activity signal
      const volOIRatio   = oi > 0 && vol > 0 ? vol / oi : 0;

      // Theta — stored for position tracking, not used as filter
      const theta        = Math.abs(parseFloat(greeks.theta || 0));
      const thetaPct     = mid > 0 ? theta / mid : 0;

      // Combined score
      const contractScore = deltaScore * 0.50 + expiryScore * 0.20 + liquidScore * 0.15 + spreadScore * 0.15;

      if (contractScore > bestScore) {
        bestScore = contractScore;
        best = {
          symbol:  contract.symbol,
          strike:  parseFloat(contract.strike_price),
          expDate: new Date(contract.expiration_date).toLocaleDateString("en-US", {month:"short",day:"2-digit",year:"numeric"}),
          expDays: Math.round((new Date(contract.expiration_date) - today) / MS_PER_DAY),
          expiryType,
          premium: parseFloat(mid.toFixed(2)),
          bid, ask, spread,
          greeks: {
            delta: parseFloat(greeks.delta || 0).toFixed(3),
            theta: parseFloat(greeks.theta || 0).toFixed(3),
            gamma: parseFloat(greeks.gamma || 0).toFixed(4),
            vega:  parseFloat(greeks.vega  || 0).toFixed(3),
          },
          iv, oi, vol, volOIRatio, theta: thetaPct, optionType,
        };
      }
    }

    if (best) {
      const etH2 = today.getHours() + today.getMinutes() / 60;
      const earlyTag = optionType === "put" && etH2 >= 9.75 && etH2 < 10.0 ? " [EARLY WINDOW]" : "";
      // Low OI warning — OI < 50 means very thin market, fills will be difficult in live trading
      const oiTag = best.oi > 0 && best.oi < 50 ? ` ⚠LOW-OI:${best.oi}` : '';
      if (best.oi > 0 && best.oi < 50) {
        logEvent("warn", `${ticker} LOW OI WARNING: best contract OI=${best.oi} — fills may be difficult in live trading`);
      }
      logEvent("scan", `${ticker} best contract: ${best.symbol} | $${best.premium} bid/ask $${best.bid}/$${best.ask} | delta:${best.greeks.delta} | spread:${(best.spread*100).toFixed(1)}% | OI:${best.oi}${oiTag} [REAL DATA]${earlyTag}`);
    } else {
      // Debug: only two hard filters now — mid>0 and delta range
      // Everything else is scoring. Show what delta range we found.
      let noPrice = 0, deltaOutOfRange = 0, closestDelta = -1;
      for (const c of sortedContracts) {
        const s = snapshots[c.symbol];
        if (!s) continue;
        const greeks2 = s.greeks || {};
        const quote2  = s.latestQuote || {};
        const d  = Math.abs(parseFloat(greeks2.delta || 0));
        const b  = parseFloat(quote2.bp || 0);
        const a  = parseFloat(quote2.ap || 0);
        const m2 = b > 0 && a > 0 ? (b + a) / 2 : 0;
        if (m2 <= 0) { noPrice++; continue; }
        // Track closest delta to our range among priced contracts
        if (closestDelta < 0 || Math.abs(d - (deltaMin+deltaMax)/2) < Math.abs(closestDelta - (deltaMin+deltaMax)/2)) {
          closestDelta = d;
        }
        if (d < deltaMin || d > deltaMax) deltaOutOfRange++;
      }
      const cdStr = closestDelta >= 0 ? closestDelta.toFixed(3) : "none";
      logEvent("warn", `${ticker} no valid contract | closest delta:${cdStr} (need ${deltaMin}-${deltaMax}) | no-price:${noPrice} | delta-out:${deltaOutOfRange} | total:${sortedContracts.length}`);
      if      (closestDelta > deltaMax)  logEvent("warn", `${ticker} all priced contracts are ITM — stock crashed below put liquidity zone`);
      else if (closestDelta >= 0 && closestDelta < deltaMin) logEvent("warn", `${ticker} all priced contracts are far OTM — stock already moved too far`);
      else if (closestDelta < 0)         logEvent("warn", `${ticker} no priced contracts found — complete liquidity failure on this chain`);
    }

    return best;
  } catch(e) {
    logEvent("error", `getRealOptionsContract(${ticker}): ${e.message}`);
    return null;
  }
}

// Get current market price of an options contract
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

// - Cash ETF Management -
// Target: park 50% of deployable idle cash in BIL, keep 50% liquid
// Deployable = cash above (floor + buffer)

function getDeployableCash() {
  // Everything above the floor is deployable - floor itself is managed separately
  return Math.max(0, state.cash - CAPITAL_FLOOR);
}

async function rebalanceCashETF() {
  // Never execute during dry run or outside market hours — BIL is a real Alpaca order
  if (dryRunMode || !isMarketHours()) return;

  const currentETF    = state.cashETFValue || 0;
  const currentShares = state.cashETFShares || 0;
  const diff          = CASH_ETF_TARGET - currentETF;

  if (Math.abs(diff) < CASH_ETF_MIN) return; // already balanced

  // Get live BIL price
  let bilPrice = 91;
  try {
    const p = await getStockQuote(CASH_ETF);
    if (p && p > 50) bilPrice = p;
  } catch(e) {}

  if (diff > 0 && state.cash > CAPITAL_FLOOR + diff) {
    // ── BUY BIL — submit real Alpaca order ─────────────────────────────
    const sharesToBuy = Math.floor(diff / bilPrice);
    if (sharesToBuy < 1) return;
    try {
      const orderResp = await alpacaPost("/orders", {
        symbol:        CASH_ETF,
        qty:           sharesToBuy,
        side:          "buy",
        type:          "market",      // BIL is highly liquid — market order is fine
        time_in_force: "day",
      });
      if (orderResp && orderResp.id) {
        const cost = sharesToBuy * bilPrice;
        state.cash          = parseFloat((state.cash - cost).toFixed(2));
        state.cashETFShares  = currentShares + sharesToBuy;
        state.cashETFValue   = parseFloat((state.cashETFShares * bilPrice).toFixed(2));
        state.cashETFPrice   = bilPrice;
        logEvent("etf", `BIL bought ${sharesToBuy} shares @ $${bilPrice.toFixed(2)} | order:${orderResp.id} | ETF floor: ${fmt(state.cashETFValue)} | liquid: ${fmt(state.cash)}`);
        await saveStateNow();
      } else {
        logEvent("warn", `BIL buy order failed — response: ${JSON.stringify(orderResp)?.slice(0,120)}`);
      }
    } catch(e) {
      logEvent("error", `BIL buy order error: ${e.message}`);
    }

  } else if (diff < 0 && currentShares > 0) {
    // ── SELL BIL — submit real Alpaca order ────────────────────────────
    const sharesToSell = Math.min(currentShares, Math.ceil(Math.abs(diff) / bilPrice));
    if (sharesToSell < 1) return;
    try {
      const orderResp = await alpacaPost("/orders", {
        symbol:        CASH_ETF,
        qty:           sharesToSell,
        side:          "sell",
        type:          "market",
        time_in_force: "day",
      });
      if (orderResp && orderResp.id) {
        const proceeds = parseFloat((sharesToSell * bilPrice).toFixed(2));
        state.cash          = parseFloat((state.cash + proceeds).toFixed(2));
        state.cashETFShares  = currentShares - sharesToSell;
        state.cashETFValue   = parseFloat((state.cashETFShares * bilPrice).toFixed(2));
        logEvent("etf", `BIL sold ${sharesToSell} shares @ $${bilPrice.toFixed(2)} | order:${orderResp.id} | ETF floor: ${fmt(state.cashETFValue)} | liquid: ${fmt(state.cash)}`);
        await saveStateNow();
      } else {
        logEvent("warn", `BIL sell order failed — response: ${JSON.stringify(orderResp)?.slice(0,120)}`);
      }
    } catch(e) {
      logEvent("error", `BIL sell order error: ${e.message}`);
    }
  }
}

// Liquidate BIL if needed to fund a trade - only touches ETF above the floor target
async function ensureLiquidCash(needed) {
  if (dryRunMode || !isMarketHours()) return; // never liquidate BIL in dry run or outside hours
  if (state.cash >= needed) return;
  const shortfall    = needed - state.cash;
  const bilPrice     = state.cashETFPrice || 91;
  const sharesToSell = Math.min(state.cashETFShares || 0, Math.ceil(shortfall / bilPrice));
  if (sharesToSell < 1) return;
  // Submit real Alpaca sell order
  try {
    const orderResp = await alpacaPost("/orders", {
      symbol:        CASH_ETF,
      qty:           sharesToSell,
      side:          "sell",
      type:          "market",
      time_in_force: "day",
    });
    if (orderResp && orderResp.id) {
      const proceeds = parseFloat((sharesToSell * bilPrice).toFixed(2));
      state.cash          = parseFloat((state.cash + proceeds).toFixed(2));
      state.cashETFShares  = (state.cashETFShares || 0) - sharesToSell;
      state.cashETFValue   = parseFloat((state.cashETFShares * bilPrice).toFixed(2));
      logEvent("etf", `BIL liquidated ${sharesToSell} shares — ${fmt(proceeds)} freed | order:${orderResp.id} | liquid: ${fmt(state.cash)}`);
      await saveStateNow();
    } else {
      logEvent("warn", `BIL liquidation order failed — ${JSON.stringify(orderResp)?.slice(0,120)}`);
    }
  } catch(e) {
    logEvent("error", `BIL liquidation error: ${e.message}`);
  }
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

// Weekly trend check — is stock above or below its 10-week MA?
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
    return setCache('weekly:' + ticker, { trend, ma10w: parseFloat(ma10w.toFixed(2)), pctFromMA: parseFloat((pctFromMA*100).toFixed(1)), above10wk: price > ma10w });
  } catch(e) { return { trend: 'neutral', above10wk: null }; }
}

// - Pre-trade Filters -
async function checkAllFilters(stock, price) {
  const fails = [];

  // 1. Entry window — allow if EITHER call or put window is open
  // Puts open at 9:45AM when VIX>=25, calls at 10:00AM
  // Since optionType is not known yet at filter time, pass if either window is open
  const eitherWindowOpen = isEntryWindow("call") || isEntryWindow("put");
  if (!eitherWindowOpen && !dryRunMode) return { pass:false, reason:"Outside entry window" };

  // 2. Circuit breakers
  if (!state.circuitOpen)       return { pass:false, reason:"Daily circuit breaker tripped" };
  if (!state.weeklyCircuitOpen) return { pass:false, reason:"Weekly circuit breaker tripped" };

  // 3. Capital floor
  if (state.cash <= CAPITAL_FLOOR) return { pass:false, reason:`Cash at capital floor (${fmt(CAPITAL_FLOOR)})` };


  // 5. Consecutive losses
  if (state.consecutiveLosses >= CONSEC_LOSS_LIMIT) return { pass:false, reason:`${CONSEC_LOSS_LIMIT} consecutive losses - paused for day` };

  // 6. Position limits per ticker - max 3 total, max 2 of same type (call/put)
  const existingPositions = state.positions.filter(p => p.ticker === stock.ticker);
  if (existingPositions.length >= 3) return { pass:false, reason:`Already have 3 positions in ${stock.ticker} - max reached` };

  // 7. Portfolio heat
  if (heatPct() >= MAX_HEAT) return { pass:false, reason:`Portfolio heat at ${(heatPct()*100).toFixed(0)}% max` };

  // 8. Sector exposure
  const sectorExp = state.positions.filter(p=>p.sector===stock.sector).reduce((s,p)=>s+p.cost,0);
  if (sectorExp / totalCap() >= MAX_SECTOR_PCT) return { pass:false, reason:`${stock.sector} sector at ${MAX_SECTOR_PCT*100}% limit` };

  // 9. Correlated positions (max 2 per sector) + no opposite bets
  const sectorPositions = state.positions.filter(p => p.sector === stock.sector);
  if (sectorPositions.length >= 3) return { pass:false, reason:`Already have 3 positions in ${stock.sector}` };
  // Detect opposite sector bets — don't have both calls and puts in same sector
  // (passed in via optionType from scan loop context)

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

  // 13. VIX check
  const vix = state.vix || 15;
  if (vix >= VIX_PAUSE) return { pass:false, reason:`VIX ${vix} above pause threshold (${VIX_PAUSE})` };

  // 14. Correlation group - max 1 position per correlated group
  const corrGroup = getCorrelatedGroup(stock.ticker);
  if (corrGroup) return { pass:false, reason:`Correlated position already open (group: ${corrGroup.join(", ")})` };

  // 15. Sector ETF confirmation
  const etfCheck = await checkSectorETF(stock);
  if (!etfCheck.pass) return { pass:false, reason:etfCheck.reason };

  // 16. Support/resistance check
  try {
    const bars = await getStockBars(stock.ticker, 20);
    if (bars.length >= 10) {
      const sr = getSupportResistance(bars);
      if (price >= sr.resistance * (1 - RESISTANCE_BUFFER)) {
        return { pass:false, reason:`Price within ${(RESISTANCE_BUFFER*100).toFixed(0)}% of 20-day resistance ($${sr.resistance.toFixed(2)})` };
      }
      if (price <= sr.support * (1 + SUPPORT_BUFFER)) {
        return { pass:false, reason:`Price near 20-day support ($${sr.support.toFixed(2)}) - risk of breakdown` };
      }
    }
  } catch(e) { /* skip if data unavailable */ }

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

// - DTE-Tiered Exit Parameters -
// Returns appropriate exit levels based on days to expiry
// Short DTE = take profits fast, trail tight (theta kills you)
// Monthly   = moderate targets, standard trail
// LEAPS     = let winners run, wide trail
function getDTEExitParams(dte, daysOpen = 0) {
  // PDT-aware target adjustment
  const pdtRemaining = Math.max(0, PDT_LIMIT - countRecentDayTrades());
  const pdtTight     = pdtRemaining <= 1;
  const pdtLocked    = pdtRemaining === 0;

  // ── Overnight tier adjustment ─────────────────────────────────────────
  // Theta burns overnight — take profits sooner on held positions
  // Partials: sell half at partialPct, close remainder at takeProfitPct
  // 1-contract positions: partialPct escalates to full close (handled in partialClose)
  let overnightMult = 1.0;
  let overnightLabel = "";
  if (daysOpen >= 2) {
    overnightMult  = 0.60; // 2+ days old — 15% target on monthly (was 25%)
    overnightLabel = "(2D+)";
  } else if (daysOpen >= 1) {
    overnightMult  = 0.75; // opened yesterday — 20% target on monthly (was 26.7%)
    overnightLabel = "(OVERNIGHT)";
  }

  if (dte <= 21) {
    const base = pdtLocked ? 0.12 : pdtTight ? 0.15 : 0.20;
    const tp   = parseFloat((base * overnightMult).toFixed(3));
    const part = parseFloat((tp * 0.60).toFixed(3)); // partial at 60% of target
    const ride = parseFloat((tp * 1.30).toFixed(3)); // remainder rides to 130% of target
    return {
      takeProfitPct:  tp,
      partialPct:     part,
      ridePct:        ride,
      stopLossPct:    0.35,
      fastStopPct:    0.15,
      trailActivate:  pdtLocked ? 0.08 : pdtTight ? 0.10 : 0.12,
      trailStop:      pdtLocked ? 0.05 : 0.07,
      label:          (pdtLocked ? "SHORT-DTE(PDT-LOCKED)" : pdtTight ? "SHORT-DTE(PDT-TIGHT)" : "SHORT-DTE") + overnightLabel,
    };
  } else if (dte <= 45) {
    const base = pdtLocked ? 0.18 : pdtTight ? 0.22 : 0.30;
    const tp   = parseFloat((base * overnightMult).toFixed(3));
    const part = parseFloat((tp * 0.60).toFixed(3));
    const ride = parseFloat((tp * 1.30).toFixed(3));
    return {
      takeProfitPct:  tp,
      partialPct:     part,
      ridePct:        ride,
      stopLossPct:    0.35,
      fastStopPct:    0.20,
      trailActivate:  pdtLocked ? 0.12 : pdtTight ? 0.15 : 0.18,
      trailStop:      pdtLocked ? 0.07 : pdtTight ? 0.08 : 0.10,
      label:          (pdtLocked ? "MONTHLY(PDT-LOCKED)" : pdtTight ? "MONTHLY(PDT-TIGHT)" : "MONTHLY") + overnightLabel,
    };
  } else {
    const base = pdtLocked ? 0.30 : pdtTight ? 0.40 : 0.50;
    const tp   = parseFloat((base * overnightMult).toFixed(3));
    const part = parseFloat((tp * 0.60).toFixed(3));
    const ride = parseFloat((tp * 1.30).toFixed(3));
    return {
      takeProfitPct:  tp,
      partialPct:     part,
      ridePct:        ride,
      stopLossPct:    0.35,
      fastStopPct:    0.20,
      trailActivate:  pdtLocked ? 0.18 : pdtTight ? 0.20 : 0.25,
      trailStop:      pdtLocked ? 0.09 : pdtTight ? 0.10 : 0.12,
      label:          (pdtLocked ? "LEAPS(PDT-LOCKED)" : pdtTight ? "LEAPS(PDT-TIGHT)" : "LEAPS") + overnightLabel,
    };
  }
}

// - PDT (Pattern Day Trader) Tracking -
// SEC rule: 4+ day trades in 5 rolling business days = PDT flag on margin accounts <$25k
// A day trade = opening AND closing the same security on the same calendar day
// APEX tracks this and blocks new entries when at 3/3 to preserve the last day trade

const PDT_LIMIT     = 3;   // max day trades before block (limit is 3, 4th triggers PDT flag)
const PDT_DAYS      = 5;   // rolling business day window

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
  // Count day trades in the rolling 5 business day window
  const cutoff    = getBusinessDaysAgo(PDT_DAYS);
  const cutoffStr = cutoff.toLocaleDateString();
  const recent    = (state.dayTrades || []).filter(dt => {
    // Compare date strings to avoid timezone issues
    return new Date(dt.closeTime) >= cutoff;
  });
  return recent.length;
}

function isDayTrade(pos) {
  // A position is a day trade if it was opened today (same calendar date)
  if (!pos || !pos.openDate) return false;
  const openDay  = new Date(pos.openDate).toLocaleDateString();
  const today    = new Date().toLocaleDateString();
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
    logEvent("warn", `PDT LIMIT REACHED (${count}/${PDT_LIMIT}) — no new entries until window resets`);
    state.pdtWarned = true;
  }
}

// - Position Sizing -
// ── Unified Kelly-Primary Sizing ─────────────────────────────────────────
// Single source of truth for position sizing. Kelly is primary.
// Standard sizing is removed — Kelly adapts to actual edge automatically.
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

  // Step 3: VIX adjustment — options are more expensive in high vol, size down
  const vixMult = vix >= VIX_REDUCE50 ? 0.50 : vix >= VIX_REDUCE25 ? 0.75 : 1.0;

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

// - Build Trade Card -
// - Expiration Date Calculator -
// Returns the next real options expiry Friday on or after targetDate
function getNextExpiryFriday(targetDate) {
  const d = new Date(targetDate);
  // Find the next Friday on or after targetDate
  const day = d.getDay(); // 0=Sun, 6=Sat
  const daysUntilFriday = day <= 5 ? (5 - day) : 6; // days until next Friday
  d.setDate(d.getDate() + daysUntilFriday);
  return d;
}

// Returns the third Friday of a given month/year (standard monthly expiry)
function getThirdFriday(year, month) {
  const d = new Date(year, month, 1);
  // Find first Friday
  const firstFriday = (5 - d.getDay() + 7) % 7;
  // Third Friday = first Friday + 14 days
  d.setDate(firstFriday + 15);
  return d;
}

// Smart expiry selection based on score, VIX, and option type
// LEAPS eligible tickers — most liquid with active LEAPS markets
const LEAPS_ELIGIBLE = ["NVDA","AAPL","MSFT","AMZN","META","GOOGL","SPY","QQQ","TSLA","AMD","PLTR","CRWD","AVGO"];

// Returns { expDate: string, expDays: number, expiryType: "weekly"|"monthly"|"leaps" }
function selectExpiry(score, vix, optionType, earningsDate, ticker = null) {
  const today  = getETTime();
  const now    = today.getTime();

  // Determine target DTE window based on conditions
  let targetDays;
  let expiryType;

  // ── PUT tiers — directional selloff captures ──────────────────────────
  if (optionType === "put") {
    if (score >= 92 && vix >= 28 && vix <= 45) {
      // Extreme conviction + active selloff window — capture fast before VIX reverts
      targetDays = 14;
      expiryType = "weekly";
    } else if (score >= 85 && vix >= 25 && vix <= 40) {
      // High conviction + elevated VIX — short window, confirmed breakdown
      targetDays = 21;
      expiryType = "weekly";
    } else if (score >= 75 && vix >= 20 && vix <= 30) {
      // Moderate conviction — give it room but don't overpay for time
      targetDays = 30;
      expiryType = "monthly";
    } else {
      // Default — high VIX extremes (>40) or low conviction = need more time
      targetDays = 45;
      expiryType = "monthly";
    }

  // ── CALL tiers ─────────────────────────────────────────────────────────
  } else if (score >= 90 && vix < 20 && ticker && LEAPS_ELIGIBLE.includes(ticker)) {
    // LEAPS — high conviction + calm market + liquid ticker
    targetDays = 210;
    expiryType = "leaps";
  } else if (score >= 85 && vix < 25) {
    // High score, low VIX, call = weekly for max leverage
    targetDays = 14;
    expiryType = "weekly";
  } else if (score >= 70 && vix < 30) {
    // Normal call setup
    targetDays = 30;
    expiryType = "monthly";
  } else if (vix >= 25) {
    // Mean reversion call — high VIX = buy discounted calls on beaten-down quality names
    // 90 days gives time for VIX reversion + stock recovery
    targetDays = 90;
    expiryType = "monthly";
  } else {
    // Default — elevated VIX calls need more time
    targetDays = 45;
    expiryType = "monthly";
  }

  // Calculate target date
  const targetDate = new Date(now + targetDays * MS_PER_DAY);

  let expiry;
  if (expiryType === "weekly") {
    expiry = getNextExpiryFriday(targetDate);
    const minDate = new Date(now + 7 * MS_PER_DAY);
    if (expiry < minDate) expiry = getNextExpiryFriday(new Date(expiry.getTime() + 7 * MS_PER_DAY));
  } else if (expiryType === "leaps") {
    // LEAPS use Jan expiry of next year (most liquid LEAPS expiration)
    const targetYear = targetDate.getFullYear();
    expiry = getThirdFriday(targetYear, 0); // January expiry
    // If Jan is too close use next year's Jan
    if (expiry < new Date(now + 180 * MS_PER_DAY)) {
      expiry = getThirdFriday(targetYear + 1, 0);
    }
  } else {
    // Monthly — find third Friday of target month
    expiry = getThirdFriday(targetDate.getFullYear(), targetDate.getMonth());
    const minDate = new Date(now + 21 * MS_PER_DAY);
    if (expiry < minDate) {
      const nextMonth = targetDate.getMonth() === 11 ? 0 : targetDate.getMonth() + 1;
      const nextYear  = targetDate.getMonth() === 11 ? targetDate.getFullYear() + 1 : targetDate.getFullYear();
      expiry = getThirdFriday(nextYear, nextMonth);
    }
  }

  // If earnings date is within our expiry window, extend past earnings
  if (earningsDate) {
    const eDays = Math.round((new Date(earningsDate) - new Date(now)) / MS_PER_DAY);
    if (eDays > 0 && eDays < Math.round((expiry - new Date(now)) / MS_PER_DAY)) {
      // Earnings before expiry - extend to next monthly after earnings
      const postEarnings = new Date(new Date(earningsDate).getTime() + 7 * MS_PER_DAY);
      expiry = getThirdFriday(postEarnings.getFullYear(), postEarnings.getMonth());
    }
  }

  const expDays = Math.round((expiry - new Date(now)) / MS_PER_DAY);
  const expDate = expiry.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });

  return { expDate, expDays: Math.max(expDays, 7), expiryType };
}

function buildCard(stock, price, contracts, iv, optionType = "call", score = 75, vix = 15) {
  // Smart expiry - real Friday dates, weekly vs monthly based on conditions
  const { expDate, expDays, expiryType } = selectExpiry(score, vix, optionType, stock.earningsDate, stock.ticker);

  const otmPct    = stock.momentum === "strong" ? 0.035 : 0.045;
  // Calls: strike ABOVE price. Puts: strike BELOW price
  const strike    = optionType === "put"
    ? Math.round(price * (1 - otmPct) / 5) * 5
    : Math.round(price * (1 + otmPct) / 5) * 5;
  const ivVal     = iv || (0.25 + stock.ivr * 0.003);
  const t         = expDays / 365;
  const premium   = parseFloat((price * ivVal * Math.sqrt(t) * 0.4 + 0.3).toFixed(2));
  const cost      = parseFloat((premium * 100 * contracts).toFixed(2));
  const greeks    = calcGreeks(price, strike, expDays, ivVal, optionType);
  const target    = parseFloat((premium*(1+TAKE_PROFIT_PCT)).toFixed(2));
  const stop      = parseFloat((premium*(1-STOP_LOSS_PCT)).toFixed(2));
  const breakeven = optionType === "put"
    ? parseFloat((strike - premium).toFixed(2))
    : parseFloat((strike + premium).toFixed(2));
  return { ...stock, price, strike, premium, contracts, cost, expDate, expDays, expiryType, target, stop, breakeven, greeks, iv:ivVal, optionType };
}

// - Execute Trade -
async function executeTrade(stock, price, score, scoreReasons, vix, optionType = "call", isMeanReversion = false) {
  // Quick cash pre-check before expensive API calls
  // Use conservative estimate: assume at least $200 premium * 1 contract = $200 min cost
  const estimatedMinCost = price * 0.03 * 100; // ~3% OTM premium estimate * 100
  if (state.cash - estimatedMinCost < CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash pre-check (est. min cost ${fmt(estimatedMinCost)})`);
    return false;
  }

  // Use cached contract from parallel prefetch if available, else fetch now
  let contract = stock._cachedContract || await getRealOptionsContract(stock.ticker, price, optionType, score, vix, stock.earningsDate);
  delete stock._cachedContract; // clean up cache after use

  // Fallback to estimated contract if real data unavailable
  // NOTE: If the chain exists but no liquid contracts found, estimation is unreliable
  // Only estimate if we got no chain data at all (API failure)
  if (!contract) {
    logEvent("warn", `⚠ ${stock.ticker} - NO REAL OPTIONS DATA - using Black-Scholes estimate. Check Alpaca Pro subscription.`);
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.estimatedTrades++;
    state.dataQuality.totalTrades++;
    const iv       = 0.25 + stock.ivr * 0.003;
    const { expDate, expDays, expiryType } = selectExpiry(score, vix, optionType, stock.earningsDate, stock.ticker);
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
    // Real data — track totalTrades for stats only
    // realTrades is incremented AFTER a confirmed live fill (see below)
    // Never increment in dry run — would bypass the 1-contract cap
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.totalTrades++;
  }

  // Position sizing based on real premium
  // Unified Kelly-primary sizing — single call, all adjustments inside
  const contracts = calcPositionSize(contract.premium, score, vix);
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
  await ensureLiquidCash(cost + CAPITAL_FLOOR);

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

  // Submit order to Alpaca — fill confirmation happens inside
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

        // ── FILL CONFIRMATION — poll for up to 10 seconds ──────────────
        // Limit orders are not guaranteed to fill immediately
        // If unfilled after 10s, cancel and skip — don't update state on unfilled orders
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
                logEvent("warn", `Order ${alpacaOrderId} ${pollResp.status} — not filled`);
                break;
              }
            } catch(e) { logEvent("warn", `Fill poll error: ${e.message}`); break; }
          }
        }

        if (!fillConfirmed) {
          // Cancel unfilled order and abort trade
          try { await alpacaDelete(`/orders/${alpacaOrderId}`); } catch(e) {}
          logEvent("warn", `Order ${alpacaOrderId} not filled in ${FILL_TIMEOUT/1000}s — cancelled, skipping trade`);
          alpacaOrderId = null; // signal to caller to abort
        } else if (fillPrice) {
          contract.premium = fillPrice; // use actual fill price not limit price
          // Confirmed live fill — now count as a real trade for Kelly calibration
          if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
          state.dataQuality.realTrades++;
          logEvent("trade", `Live fill confirmed — real trade count: ${state.dataQuality.realTrades}/30 before Kelly activates`);
        }
      } else {
        logEvent("warn", `Alpaca order failed for ${contract.symbol}: ${JSON.stringify(orderResp)?.slice(0, 150)}`);
      }
    } catch(e) {
      logEvent("error", `Alpaca order submission error: ${e.message}`);
    }
  }

  // Abort if order was not confirmed filled — don't update state on unfilled orders
  if (contract.symbol && !dryRunMode && alpacaOrderId === null && contract.symbol) {
    logEvent("skip", `${stock.ticker} — trade aborted, order not filled`);
    return false;
  }

  // Recalculate cost/target/stop using final premium (may have been updated by fill)
  const finalCost     = parseFloat((contract.premium * 100 * contracts).toFixed(2));
  // Use DTE-tiered exit params — short-dated options need faster exits
  const exitParams    = getDTEExitParams(contract.expDays || 30, 0); // 0 days open — fresh entry
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

  // In dry run — log what would happen but don't mutate state
  if (dryRunMode) {
    logEvent("dryrun", `WOULD BUY ${stock.ticker} ${optionType.toUpperCase()} $${contract.strike} | ${contracts}x @ $${contract.premium} | cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta}`);
    return true;
  }

  // Final heat check — projected heat AFTER this position is added
  // This catches the scan-level blindness where multiple positions queue before any are entered
  const projectedHeat = (openRisk() + finalCost) / totalCap();
  if (projectedHeat > MAX_HEAT) {
    logEvent("filter", `${stock.ticker} - projected heat ${(projectedHeat*100).toFixed(0)}% would exceed ${MAX_HEAT*100}% max — skipping`);
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
  };

  state.positions.push(position);

  // Trade journal entry
  // Tag if this is an earnings play
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
    reasoning:     `Score ${score}/100. ${scoreReasons.slice(0,3).join(". ")}.${stock._washSaleWarning ? " ⚠ WASH SALE WARNING." : ""}`,
  });
  if (state.tradeJournal.length > 100) state.tradeJournal = state.tradeJournal.slice(0,100);

  const typeLabel = optionType === "put" ? "P" : "C";
  const dataLabel = contract.symbol ? "REAL" : "EST";

  // ── LIQUIDITY HARD GATES ──────────────────────────────────────────────
  // OI < MIN_OI (5) = essentially no market — unfillable in live trading
  if (!dryRunMode && contract.oi > 0 && contract.oi < MIN_OI) {
    logEvent("filter", `${stock.ticker} BLOCKED — OI:${contract.oi} below minimum ${MIN_OI} — unfillable in live trading`);
    return false;
  }
  // Spread > MAX_SPREAD_PCT (30%) = slippage destroys the trade
  if (!dryRunMode && contract.spread > MAX_SPREAD_PCT) {
    const slippageEst = parseFloat((contract.premium * contract.spread * 0.5 * 100 * contracts).toFixed(2));
    logEvent("filter", `${stock.ticker} BLOCKED — spread ${(contract.spread*100).toFixed(0)}% exceeds ${(MAX_SPREAD_PCT*100).toFixed(0)}% max — est. slippage $${slippageEst}`);
    return false;
  }
  // Warn on borderline OI (5-50) and spread (15-30%) — don't block but flag
  if (contract.oi > 0 && contract.oi < 50) {
    logEvent("warn", `⚠ ${stock.ticker} LOW OI: ${contract.oi} — fill may be slow`);
  } else if (contract.oi === 0) {
    logEvent("warn", `⚠ ${stock.ticker} OI UNKNOWN — treat as potentially illiquid`);
  }
  if (contract.spread > 0.15) {
    const slippageEst = parseFloat((contract.premium * contract.spread * 0.5 * 100 * contracts).toFixed(2));
    logEvent("warn", `⚠ ${stock.ticker} WIDE SPREAD: ${(contract.spread*100).toFixed(0)}% — est. slippage $${slippageEst}`);
  }

  await saveStateNow(); // critical — persist trade immediately
  logEvent("trade",
    `BUY ${stock.ticker} $${contract.strike}${typeLabel} exp ${contract.expDate} | ${contracts}x @ $${contract.premium} | ` +
    `cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta} | ${isMeanReversion ? "MEAN-REV" : exitParams.label} | [${dataLabel}] | ` +
    `OI:${contract.oi} spread:${(contract.spread*100).toFixed(1)}% | cash ${fmt(state.cash)} | heat ${(heatPct()*100).toFixed(0)}%`
  );
  return true;
}

// - Close Position -
async function closePosition(ticker, reason, exitPremium = null) {
  try {
    const idx = state.positions.findIndex(p => p.ticker === ticker);
    if (idx === -1) return;
    const pos  = state.positions[idx];
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
    if (pos.contractSymbol) {
      const realP = await getOptionsPrice(pos.contractSymbol);
      if (realP) ep = realP;
    }
    // Fall back to last tracked price
    if (!ep && pos.currentPrice && pos.currentPrice > 0) {
      ep = pos.currentPrice;
    }
    // Last resort — use fixed estimates based on reason (no random — deterministic P&L)
    if (!ep) {
      const g = reason === "stop"        ? -STOP_LOSS_PCT
              : reason === "fast-stop"   ? -FAST_STOP_PCT
              : reason === "target"      ? TAKE_PROFIT_PCT
              : reason === "trail"       ? TRAIL_ACTIVATE_PCT
              : reason === "expiry-roll" ? 0.15
              : reason === "fast-profit" ? FAST_PROFIT_PCT
              : 0; // all other exits — use entry premium (breakeven)
      ep = parseFloat((pos.premium * (1 + g)).toFixed(2));
      logEvent("warn", `${pos.ticker} using estimated exit price (no real data available) | reason:${reason} | ep:$${ep}`);
    }
  }
  ep = parseFloat(ep.toFixed(2));
  const ev   = parseFloat((ep*100*pos.contracts*mult).toFixed(2));
  const pnl  = parseFloat((ev - pos.cost*mult).toFixed(2));
  const pct  = ((pnl/(pos.cost*mult))*100).toFixed(1);
  const nr   = state.totalRevenue + (pnl > 0 ? pnl : 0);
  const bonus= state.totalRevenue < REVENUE_THRESHOLD && nr >= REVENUE_THRESHOLD;

  // In dry run — log what would happen but don't mutate state or submit orders
  if (dryRunMode) {
    logEvent("dryrun", `WOULD CLOSE ${ticker} | reason:${reason} | exit:$${ep} | P&L:${pnl>=0?"+":""}$${pnl.toFixed(2)} (${pct}%)`);
    return;
  }

  // Submit close order to Alpaca if we have a contract symbol
  // For partial closes (mult=0.5), sell half; for full closes (mult=1.0), sell all
  // But minimum 1 contract — if only 1 contract, full close regardless
  const contractsToSell = pos.contracts === 1 ? 1 : Math.max(1, Math.floor(pos.contracts * mult));
  const closeQty = contractsToSell;
  // Minimum 60 seconds hold before Alpaca close — prevents wash trade rejections
  const heldSeconds = (Date.now() - new Date(pos.openDate).getTime()) / 1000;
  const alpacaCloseAllowed = heldSeconds >= 60;
  if (!alpacaCloseAllowed) logEvent("warn", `${ticker} held only ${heldSeconds.toFixed(0)}s — skipping Alpaca close order to avoid wash trade`);
  if (pos.contractSymbol && closeQty > 0 && !dryRunMode && alpacaCloseAllowed) {
    try {
      // Use real bid if available, else use ep (mid) as limit
      // Real bid from position tracking is more reliable than derived estimate
      const bidPrice = parseFloat((pos.bid > 0 ? pos.bid : ep * 0.98).toFixed(2));
      const closeBody = {
        symbol:        pos.contractSymbol,
        qty:           closeQty,           // number not string
        side:          "sell",
        type:          "limit",
        time_in_force: "day",
        limit_price:   bidPrice,
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
  // PDT tracking — record if this is a day trade (opened and closed same day)
  if (isDayTrade(pos)) {
    recordDayTrade(pos, reason);
  }
  state.closedTrades.push({ ticker, pnl, pct, date:new Date().toLocaleDateString(), reason, score:pos.score||0, closeTime: Date.now() });
  // Cap closedTrades at 200
  if (state.closedTrades.length > 200) state.closedTrades = state.closedTrades.slice(0, 200);

  // ── Exit performance tracking ─────────────────────────────────────────
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

  // Peak cash tracking for drawdown
  if (state.cash > state.peakCash) state.peakCash = state.cash;

  // Circuit breaker checks -- use total portfolio value (cash + open positions)
  const portfolioValue = state.cash + openRisk();
  const dailyPnL  = portfolioValue - state.dayStartCash;
  const weeklyPnL = portfolioValue - state.weekStartCash;

  // Daily max loss — 25% of TOTAL capital (not just deployed)
  // Using deployed capital caused false triggers when few positions were open
  if (dailyPnL / totalCap() <= -0.25 && state.circuitOpen) {
    state.circuitOpen = false;
    logEvent("circuit", `DAILY MAX LOSS circuit - lost ${fmt(Math.abs(dailyPnL))} (${(dailyPnL/totalCap()*100).toFixed(1)}% of total capital)`);
  }
  // Weekly circuit — 25% of total capital using weeklyPnL
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
    exitPremium: ep,
    pnl,
    pct,
    reasoning: `Closed ${reason}. Exit premium $${ep} vs entry $${pos.premium}. P&L: ${pnl>=0?"+":""}${fmt(pnl)} (${pct}%).`,
  });

  logEvent("close",
    `${reason.toUpperCase()} ${ticker} | exit $${ep} | P&L ${pnl>=0?"+":""}${fmt(pnl)} (${pct}%) | ` +
    `cash ${fmt(state.cash)} | consec losses: ${state.consecutiveLosses}`
  );
  await saveStateNow();
  return true;
  } catch(e) {
    logEvent("error", `closePosition crashed for ${ticker} (${reason}): ${e.message}`);
    // Force remove from positions on error — don't leave stuck positions
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

  // 1-contract positions can't be split — treat partial close as full close
  // Math.floor(1/2) = 0 which would skip the Alpaca order silently
  if ((pos.contracts || 1) === 1) {
    logEvent("partial", `${ticker} 1-contract position — escalating partial to full close`);
    await closePosition(ticker, "target");
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
        symbol:        pos.contractSymbol,
        qty:           half,
        side:          "sell",
        type:          "limit",
        time_in_force: "day",
        limit_price:   bidPrice,
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
  state.closedTrades.push({ ticker, pnl, pct:((pnl/(pos.cost*0.5))*100).toFixed(1), date:new Date().toLocaleDateString(), reason:"partial" });
  logEvent("partial", `PARTIAL ${ticker} - ${half}/${pos.contracts} @ $${ep} | +${fmt(pnl)} | cash ${fmt(state.cash)}`);
  await saveStateNow();
}

// - Stock Portfolio Management -
async function checkStockBuys() {
  if (state.monthlyProfit <= STOCK_PROFIT_THRESH) return;
  if (stockValue() / totalCap() >= MAX_STOCK_PCT) return;

  const profitAboveThresh = state.monthlyProfit - STOCK_PROFIT_THRESH;
  const allocAmount = profitAboveThresh * STOCK_ALLOC_PCT;
  if (allocAmount < 100) return;

  // Find best scoring stock not already held
  const candidates = WATCHLIST
    .filter(s => s.momentum === "strong" && !state.stockPositions.find(p=>p.ticker===s.ticker))
    .sort((a,b) => {
      const sc = s => (s.momentum==="strong"?3:1) + (s.rsi>50&&s.rsi<65?2:0) + (s.ivr<40?1:0);
      return sc(b)-sc(a);
    });

  for (const stock of candidates) {
    const price = await getStockQuote(stock.ticker);
    if (!price) continue;
    const shares = Math.floor(allocAmount / price);
    if (shares < 1) continue;
    const cost = parseFloat((shares * price).toFixed(2));
    if (cost > state.cash - CAPITAL_FLOOR) continue;

    state.cash = parseFloat((state.cash - cost).toFixed(2));
    state.stockBudget += cost;
    state.stockPositions.push({
      ticker:stock.ticker, shares, entryPrice:price, cost,
      stopPrice:parseFloat((price*(1-STOCK_STOP_PCT)).toFixed(2)),
      buyDate:new Date().toLocaleDateString(),
    });
    logEvent("stock", `BUY STOCK ${stock.ticker} - ${shares} shares @ $${price} | cost ${fmt(cost)} | triggered by monthly profit ${fmt(state.monthlyProfit)}`);
    await saveStateNow();
    break; // one stock buy per check
  }
}

async function manageStockPositions() {
  for (const pos of [...state.stockPositions]) {
    const price = await getStockQuote(pos.ticker);
    if (!price) continue;
    if (price <= pos.stopPrice) {
      const proceeds = parseFloat((price * pos.shares).toFixed(2));
      const pnl      = parseFloat((proceeds - pos.cost).toFixed(2));
      state.cash     = parseFloat((state.cash + proceeds).toFixed(2));
      state.stockPositions.splice(state.stockPositions.indexOf(pos), 1);
      state.stockTrades.push({ ticker:pos.ticker, pnl, date:new Date().toLocaleDateString(), reason:"stop" });
      logEvent("stock", `STOP LOSS STOCK ${pos.ticker} - sold ${pos.shares} shares @ $${price} | P&L ${fmt(pnl)}`);
      await saveStateNow();
    }
  }
}

// ── Portfolio value snapshot ─────────────────────────────────────────────
// Samples total portfolio value (cash + open positions at cost) every 5 minutes
// Stored as [{t: ISO timestamp, v: dollar value}]
// Keeps last 30 days — older snapshots pruned automatically
function snapshotPortfolioValue() {
  if (!isMarketHours()) return; // only during market hours
  // Total value = cash + open options positions + BIL ETF holdings
  const posValue = (state.positions || []).reduce((s, p) => {
    const curPrice = p.currentPrice || p.premium;
    return s + (curPrice * 100 * (p.contracts || 1) * (p.partialClosed ? 0.5 : 1));
  }, 0);
  const etfValue   = stockValue(); // BIL shares at cost
  const totalValue = parseFloat((state.cash + posValue + etfValue).toFixed(2));
  if (!state.portfolioSnapshots) state.portfolioSnapshots = [];
  state.portfolioSnapshots.push({ t: new Date().toISOString(), v: totalValue });
  // Prune to last 30 days (30 days × 78 snapshots/day at 5-min intervals = ~2340)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  state.portfolioSnapshots = state.portfolioSnapshots.filter(s => new Date(s.t).getTime() > cutoff);
  markDirty();
}

// - Main Scan Engine -
let scanRunning  = false;
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
  monteCarlo:        { median: 0, percentile5: 0, percentile95: 0, probProfit: 0, message: "Insufficient data" },
  kelly:             { contracts: 1, kelly: 0, halfKelly: 0, winRate: 0, payoffRatio: 0 },
  relativeValue:     {},
  globalMarket:      { signal: "neutral", modifier: 0, qqqChg: 0, iwmChg: 0, eemChg: 0 },
  streaks:           { currentStreak: 0, currentType: null, maxWinStreak: 0, maxLossStreak: 0 },
};

async function runScan() {
  if (scanRunning) { logEvent("scan", "Scan skipped — previous scan still running"); return; }
  scanRunning = true;
  try {
  if (!ALPACA_KEY) { logEvent("warn", "No ALPACA_API_KEY set - check Railway variables"); scanRunning = false; return; }
  if (!isMarketHours() && !dryRunMode) { logEvent("scan", "Outside market hours - skipping trade logic"); scanRunning = false; return; }
  if (dryRunMode) logEvent("scan", "⚡ DRY RUN MODE — no orders submitted, no state changes");

  const now    = Date.now();
  const scanET = getETTime(); // single ET time reference for entire scan — avoids 6+ repeated calls

  // Update VIX and check velocity
  const newVIX  = await getVIX() || state.vix;
  const isBlackSwan = checkVIXVelocity(newVIX);
  state.vix     = newVIX;

  // Emergency close all on VIX velocity spike
  if (isBlackSwan) {
    for (const pos of [...state.positions]) await closePosition(pos.ticker, "vix-spike");
    await saveStateNow();
    scanRunning = false;
    return;
  }

  logEvent("scan", `Scan | VIX:${state.vix} | cash:${fmt(state.cash)} | positions:${state.positions.length} | breadth:${marketContext.breadth.breadthPct}% | F&G:${marketContext.fearGreed.score}`);

  // -- MEDIUM TIER (every 5 minutes) --
  if (now - lastMedScan > 5 * 60 * 1000) { // 5-minute tier
    lastMedScan = now;
    const [breadth, rotation] = await Promise.all([getMarketBreadth(), getSectorRotation()]);
    marketContext.breadth        = breadth;
    marketContext.sectorRotation = rotation;
    // Rebalance BIL ETF
    await rebalanceCashETF();
    state.lastRebalance = now;
    // Update macro calendar and beta-weighted delta
    const calMod = getMacroCalendarModifier();
    marketContext.macroCalendar      = calMod;
    marketContext.betaWeightedDelta  = calcBetaWeightedDelta();
    if (calMod.events.length > 0) {
      logEvent("macro", `Calendar: ${calMod.message || calMod.events.map(e => e.event + " in " + e.daysTo + "d").join(", ")}`);
    }
    // Run async market context calls in parallel
    const [regime, benchmark, globalMarket] = await Promise.all([
      detectMarketRegime(),
      getBenchmarkComparison(),
      getGlobalMarketSignal(),
    ]);
    marketContext.regime      = regime;
    marketContext.benchmark   = benchmark;
    marketContext.globalMarket= globalMarket;

    // Synchronous calculations (no API calls)
    // Portfolio Greeks — track total delta/theta/vega/gamma across all positions
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
      logEvent("scan", `[Greeks] Δ:${portfolioGreeks.delta} Θ:${portfolioGreeks.theta}/day Γ:${portfolioGreeks.gamma} V:${portfolioGreeks.vega}`);
    }

    marketContext.concentration    = checkConcentrationRisk();
    marketContext.drawdownProtocol = getDrawdownProtocol();
    marketContext.stressTest       = runStressTest();
    marketContext.monteCarlo       = runMonteCarlo(500);
    marketContext.kelly            = calcKellySize(20);
    marketContext.relativeValue    = getRelativeValueScreening();
    marketContext.streaks          = getStreakAnalysis();

    if (marketContext.concentration.alerts.length > 0) {
      marketContext.concentration.alerts.forEach(a => logEvent("risk", a));
    }
    if (marketContext.drawdownProtocol.level !== "normal") {
      logEvent("risk", `Drawdown protocol: ${marketContext.drawdownProtocol.message}`);
    }

    // These need to run after context is updated
    await Promise.all([checkTailRiskHedge(), checkScaleIns()]);

    // Check earnings plays
    await checkEarningsPlays();
    await manageEarningsPlayExits();

    // Macro news on 5-min tier — catches breaking news within 5 minutes not 15
    const macro = await getMacroNews();
    marketContext.macro = macro;
    if (macro.mode !== "normal") {
      logEvent("macro", `[5min] Macro: ${macro.signal} (${macro.scoreModifier > 0 ? "+" : ""}${macro.scoreModifier}) | ${macro.triggers.slice(0,3).join(", ")}`);
    }

    // Strongly bearish macro — close all calls immediately
    if (macro.mode === "defensive" && state.circuitOpen) {
      logEvent("macro", `DEFENSIVE MODE — macro strongly bearish: ${macro.triggers.join(", ")} — closing calls`);
      for (const pos of [...state.positions]) {
        if (pos.optionType === "call") await closePosition(pos.ticker, "macro-defensive");
      }
    }

    // Strongly bullish macro — close losing puts (thesis broken by macro tailwind)
    if (macro.mode === "aggressive" && !dryRunMode) {
      logEvent("macro", `BULLISH MACRO — ${macro.signal}: ${macro.triggers.slice(0,3).join(", ")} — closing losing puts`);
      for (const pos of [...state.positions]) {
        if (pos.optionType !== "put") continue;
        const curP = pos.currentPrice || pos.premium;
        const chg  = (curP - pos.premium) / pos.premium;
        if (chg < -0.05) await closePosition(pos.ticker, "macro-bullish");
      }
    }
    logEvent("scan", `[5min] Regime:${regime.regime}(${regime.confidence}%) | Kelly:${marketContext.kelly.contracts}x | Global:${marketContext.globalMarket.signal} | Streak:${marketContext.streaks.currentStreak}x${marketContext.streaks.currentType}`);
    snapshotPortfolioValue(); // record portfolio value every 5 min
  }



  // -- SLOW TIER (every 15 minutes) --
  if (now - lastSlowScan > 15 * 60 * 1000) {
    lastSlowScan = now;
    const [fg, dxy, yc] = await Promise.all([getFearAndGreed(), getDXY(), getYieldCurve()]);
    marketContext.fearGreed   = fg;
    marketContext.dxy         = dxy;
    marketContext.yieldCurve  = yc;
    // Real put/call ratio from CBOE via Alpaca — fetch PCCE (equity P/C) and PCCR (total P/C)
    // PCCE tracks equity-only put/call ratio — most relevant for individual stock options
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

  // Manage stock positions
  await manageStockPositions();

  // 1. Manage existing options positions
  // Prefetch news for all open positions in parallel — avoids per-position fetches inside loop
  const posNewsCache = {};
  if (state.positions.length > 0) {
    const posNewsFetches = await Promise.all(state.positions.map(p => getNewsForTicker(p.ticker)));
    state.positions.forEach((p, i) => { posNewsCache[p.ticker] = posNewsFetches[i] || []; });
  }

  // Fetch all position data in parallel — stock quotes + options snapshots simultaneously
  const posSymbols = state.positions
    .filter(p => p.contractSymbol)
    .map(p => p.contractSymbol)
    .join(",");

  const [posSnapData, ...posQuotes] = await Promise.all([
    posSymbols ? alpacaGet(`/options/snapshots?symbols=${posSymbols}&feed=indicative`, ALPACA_OPT_SNAP) : Promise.resolve(null),
    ...state.positions.map(p => getStockQuote(p.ticker)),
  ]);
  const posSnapshots = posSnapData?.snapshots || {};

  for (let pi = 0; pi < state.positions.length; pi++) {
    const pos   = state.positions[pi];
    const price = posQuotes[pi];
    if (!price) continue;
    try { // wrap each position in try/catch — one bad position can't crash the whole scan

    const dte      = Math.max(1, Math.round((new Date(pos.expDate)-new Date())/MS_PER_DAY));
    const t        = dte / 365;
    let curP;
    if (pos.contractSymbol && posSnapshots[pos.contractSymbol]) {
      const snap   = posSnapshots[pos.contractSymbol];
      const quote  = snap?.latestQuote || {};
      const greeks = snap?.greeks || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const realPrice = bid > 0 && ask > 0 ? parseFloat(((bid + ask) / 2).toFixed(2)) : null;
      if (bid > 0) pos.bid = bid;
      if (ask > 0) pos.ask = ask;
      curP = realPrice ? realPrice : parseFloat((price * pos.iv * Math.sqrt(t) * 0.4 + 0.1).toFixed(2));
      if (realPrice) pos.realData = true;
      // ── LIVE GREEKS REFRESH ─────────────────────────────────────────
      // Update Greeks from live snapshot — entry Greeks become stale quickly
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
      curP = parseFloat((price * pos.iv * Math.sqrt(t) * 0.4 + 0.1).toFixed(2));
    }
    const chg      = (curP - pos.premium) / pos.premium;
    const hoursOpen= (new Date() - new Date(pos.openDate)) / 3600000;
    const daysOpen = hoursOpen / 24;

    // Update peak premium for trailing stop
    if (curP > pos.peakPremium) pos.peakPremium = curP;

    // Update peak cash for drawdown tracking
    const curCash = state.cash + openRisk() + realizedPnL();
    if (curCash > (state.peakCash || MONTHLY_BUDGET)) state.peakCash = curCash;

    // ── PDT-AWARE HOLD LOGIC ──────────────────────────────────────────────
    // If position opened today — be reluctant to close it same-day (day trade)
    // Only force-close if hitting hard stop or deeply losing
    // Let minor moves ride overnight to avoid consuming a day trade
    const openedToday    = isDayTrade(pos); // opened same calendar day
    const etHourForPDT   = scanET.getHours() + scanET.getMinutes() / 60;
    const inFinalHour    = etHourForPDT >= 15.0;

    // ── PDT PROTECTION — sub-$25k accounts ───────────────────────────────
    // Below $25k: never day-trade unless position hits +65% gain or -30% loss
    // This preserves all 3 day trades for positions that genuinely need them
    // Above $25k (Alpaca cash): normal operation resumes automatically
    const alpacaBalance  = state.alpacaCash || state.cash || 0;
    const belowPDTLimit  = alpacaBalance < 25000;
    const PDT_PROFIT_EXIT = 0.65;  // +65% — take the money, worth the day trade
    const PDT_LOSS_EXIT   = 0.30;  // -30% — deep enough loss to warrant cutting

    if (openedToday && belowPDTLimit && !dryRunMode) {
      // Profit emergency — +65% is exceptional, take it
      if (chg >= PDT_PROFIT_EXIT) {
        logEvent("scan", `${pos.ticker} PDT EMERGENCY PROFIT +${(chg*100).toFixed(0)}% — exiting same-day (above 65% threshold)`);
        await closePosition(pos.ticker, "target"); continue;
      }
      // Loss emergency — -30% to -35% is severe, worth burning a day trade
      if (chg <= -PDT_LOSS_EXIT) {
        logEvent("scan", `${pos.ticker} PDT EMERGENCY LOSS ${(chg*100).toFixed(0)}% — exiting same-day (below -30% threshold)`);
        await closePosition(pos.ticker, "fast-stop"); continue;
      }
      // Hard stop always fires — -35% is catastrophic
      if (chg <= -STOP_LOSS_PCT) {
        logEvent("scan", `${pos.ticker} hard stop ${(chg*100).toFixed(0)}% — exiting same-day`);
        await closePosition(pos.ticker, "stop"); continue;
      }
      // Everything else — hold overnight, don't burn a day trade
      const reason = chg >= 0
        ? `+${(chg*100).toFixed(0)}% (need 65% for same-day exit)`
        : `${(chg*100).toFixed(0)}% (need -30% for same-day stop)`;
      logEvent("scan", `${pos.ticker} holding overnight — PDT protection | ${reason}`);
      pos.price = price; pos.currentPrice = curP;
      markDirty();
      continue;
    }

    // After-3pm hold mode (above $25k accounts still respect this)
    const pdtHoldMode = openedToday && inFinalHour && !dryRunMode && !belowPDTLimit;
    if (pdtHoldMode && chg > -0.25) {
      logEvent("scan", `${pos.ticker} holding overnight (after 3pm, avoid day trade)`);
      pos.price = price; pos.currentPrice = curP;
      markDirty();
      continue;
    }

    // ── EXIT HIERARCHY ────────────────────────────────────────────────────
    // Order matters — earlier checks take priority over later ones
    // Applies to: overnight positions (opened previous day or earlier)
    // OR: same-day positions on accounts above $25k

    // Refresh exit params based on current daysOpen — targets tighten overnight
    const currentExitParams = getDTEExitParams(pos.expDays || 30, daysOpen);
    const activeTakeProfitPct = currentExitParams.takeProfitPct;
    const activePartialPct    = currentExitParams.partialPct || (activeTakeProfitPct * 0.60);
    const activeRidePct       = currentExitParams.ridePct    || (activeTakeProfitPct * 1.30);

    // 1. FAST STOP — -20% in first 48 hours but NOT in first 2 hours
    const fastStopEligible = hoursOpen >= 2 && hoursOpen <= FAST_STOP_HOURS;
    if (fastStopEligible && chg <= -(pos.fastStopPct || FAST_STOP_PCT)) {
      logEvent("scan", `${pos.ticker} fast-stop ${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(1)}hrs`);
      await closePosition(pos.ticker, "fast-stop"); continue;
    }

    // 2. HARD STOP — -35% at any time
    if (chg <= -STOP_LOSS_PCT) {
      logEvent("scan", `${pos.ticker} stop-loss ${(chg*100).toFixed(0)}%`);
      await closePosition(pos.ticker, "stop"); continue;
    }

    // 3. TRAILING STOP — activates at tier threshold, tightens on signal decay
    if (chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT)) {
      // pos.trailPct stores the % width (0.15 = 15%), pos.trailStop stores the $ floor
      // These are separate fields — reading pos.trailStop as % was the bug
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
        logEvent("scan", `${pos.ticker} signal decay — RSI ${liveRSI} — tightening trail to ${(trailPct*100).toFixed(0)}%`);
      }
      if (pos.optionType === "put" && liveRSI > 55 && (pos.entryRSI || 55) <= 50) {
        trailPct = TRAIL_STOP_PCT * 0.6;
        pos.trailPct = trailPct;
        logEvent("scan", `${pos.ticker} signal decay (put) — RSI ${liveRSI} — tightening trail to ${(trailPct*100).toFixed(0)}%`);
      }
      const trailFloor = pos.peakPremium * (1 - trailPct); // $ floor value
      pos.trailStop    = trailFloor;                        // store $ floor separately
      if (curP <= trailFloor) {
        logEvent("scan", `${pos.ticker} trail hit — peak $${pos.peakPremium.toFixed(2)} floor $${trailFloor.toFixed(2)} (${(trailPct*100).toFixed(0)}% trail)`);
        await closePosition(pos.ticker, "trail"); continue;
      }
    }

    // 4. PARTIAL CLOSE — at 60% of active take profit target
    // Uses live overnight-adjusted params — tighter targets on older positions
    if (!pos.partialClosed && chg >= activePartialPct) {
      logEvent("scan", `${pos.ticker} partial close at +${(chg*100).toFixed(0)}% [${currentExitParams.label}] (partial threshold: +${(activePartialPct*100).toFixed(0)}%)`);
      await partialClose(pos.ticker);
    }

    // 5. FULL TARGET — take profit
    // After partial: remainder rides to 130% of target then closes
    if (pos.partialClosed && chg >= activeRidePct) {
      logEvent("scan", `${pos.ticker} remainder target +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      await closePosition(pos.ticker, "target"); continue;
    }
    if (!pos.partialClosed && chg >= activeTakeProfitPct) {
      logEvent("scan", `${pos.ticker} take profit +${(chg*100).toFixed(0)}% [${currentExitParams.label}]`);
      await closePosition(pos.ticker, "target"); continue;
    }

    // ── F10: THESIS DEGRADATION — re-score entry conditions every hour ──────
    // If the original entry thesis has weakened significantly, partial close
    // regardless of price movement — the edge is gone even if position is flat
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
            logEvent("scan", `${pos.ticker} thesis degradation — RSI moved from ${entryRSI} to ${curRSI.toFixed(0)} — partial close`);
            await partialClose(pos.ticker);
          }
        }
      } catch(e) {}
    }

    // 6. TIME STOP — 7 days with no meaningful move
    if (daysOpen >= TIME_STOP_DAYS && Math.abs(chg) < TIME_STOP_MOVE) {
      logEvent("scan", `${pos.ticker} time-stop — ${daysOpen.toFixed(0)}d, only ${(chg*100).toFixed(1)}% move`);
      await closePosition(pos.ticker, "time-stop"); continue;
    }

    // ── AGENT RESCORE — once per hour on overnight positions ──────────────
    // Only fires on positions opened previous day or earlier
    // AUTO-EXIT: closes losing positions if agent returns EXIT + high confidence
    if (daysOpen >= 1 && ANTHROPIC_API_KEY && isMarketHours()) {
      const currentHour = new Date().getHours();
      if (!state._agentRescoreHour) state._agentRescoreHour = {};
      const lastRescoreHour = state._agentRescoreHour[pos.ticker] || -1;
      if (currentHour !== lastRescoreHour) {
        state._agentRescoreHour[pos.ticker] = currentHour;
        try {
          const rescore = await getAgentRescore(pos);
          if (rescore) {
            pos._liveRescore = { ...rescore, updatedAt: new Date().toISOString() };
            logEvent("scan", `[AGENT] ${pos.ticker} rescore: ${rescore.label} (${rescore.score}/95) — ${rescore.recommendation} | ${rescore.reasoning || ''}`);
            // Auto-exit: only if enabled + EXIT + high confidence + position is losing
            if (state.agentAutoExitEnabled &&
                rescore.recommendation === "EXIT" &&
                rescore.confidence === "high" &&
                chg < 0) {
              logEvent("warn", `[AGENT] AUTO-EXIT ${pos.ticker} — ${rescore.label} score ${rescore.score}/95 | ${rescore.reasoning}`);
              await closePosition(pos.ticker, "agent-exit");
              continue;
            }
          }
        } catch(agentErr) {
          console.log("[AGENT] Rescore error:", agentErr.message);
        }
      }
    }

    // 7. EXPIRY ROLL — DTE <= 7, close winners (losers hit stop first)
    if (dte <= 7 && chg > 0) {
      logEvent("scan", `${pos.ticker} expiry-roll — ${dte}DTE with profit`);
      await closePosition(pos.ticker, "expiry-roll"); continue;
    }

    // 8. 50MA BREAK — thesis invalidated (real 50-day MA)
    // Minimum 2 hour hold — open volatility can briefly cross 50MA and recover
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

    // 9. EARNINGS CLOSE — approaching earnings = IV crush risk
    if (pos.earningsDate) {
      const daysToE = Math.round((new Date(pos.earningsDate) - new Date()) / MS_PER_DAY);
      if (daysToE >= 0 && daysToE <= EARNINGS_SKIP_DAYS) {
        logEvent("scan", `${pos.ticker} earnings in ${daysToE}d — closing`);
        await closePosition(pos.ticker, "earnings-close"); continue;
      }
    }

    // 10. NEWS EXIT — strongly opposite news + position losing (thesis broken)
    // newsCache prefetched before loop — no per-position API calls
    const newsArts = posNewsCache[pos.ticker] || [];
    const newsSent = analyzeNews(newsArts);
    if (pos.optionType === "put" && newsSent.signal === "strongly bullish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit — strongly bullish news vs losing put`);
      await closePosition(pos.ticker, "news-exit"); continue;
    }
    if (pos.optionType === "call" && newsSent.signal === "strongly bearish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit — strongly bearish news vs losing call`);
      await closePosition(pos.ticker, "news-exit"); continue;
    }

    // 11. OVERNIGHT RISK — high VIX, losing position into close
    const etHourNow = scanET.getHours() + scanET.getMinutes() / 60;
    if (etHourNow >= 15.75 && state.vix >= 30) {
      if (chg <= -0.10) {
        logEvent("scan", `${pos.ticker} overnight-risk — losing ${(chg*100).toFixed(0)}% into close VIX ${state.vix}`);
        await closePosition(pos.ticker, "overnight-risk"); continue;
      }
      if (dte <= 7) {
        logEvent("scan", `${pos.ticker} overnight-risk — ${dte}DTE too short for overnight hold`);
        await closePosition(pos.ticker, "overnight-risk"); continue;
      }
    }

    // Update current price on position so dashboard shows live data
    pos.price        = price;
    pos.currentPrice = curP;
    logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
    markDirty(); // will be flushed at end of scan, not every tick
    } catch(posErr) {
      logEvent("error", `Position scan error for ${pos?.ticker || "unknown"}: ${posErr.message}`);
    } // end per-position try/catch
  }

  // 2. New entries — check if any entry type is valid
  // Fetch SPY data first — needed for spyRecovering which gates putsAllowed
  const spyPrice     = await getStockQuote("SPY") || 500;
  if (spyPrice) state._liveSPY = spyPrice;
  const spyBars      = await getStockBars("SPY", 5);
  const spyReturn    = spyBars.length >= 5 ? (spyBars[spyBars.length-1].c - spyBars[0].o) / spyBars[0].o : 0;
  const spyIntraday  = await getIntradayBars("SPY");
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
  if (spyRecovering) logEvent("filter", `SPY recovery detected — puts blocked`);

  // ── F17: Benchmark-adjusted entry threshold ────────────────────────────
  // If SPY already down 1.5%+ today, the easy money on puts may be gone
  // Require higher conviction (score 85+) to enter puts when market already sold off
  const spyAlreadyDown = spyBars.length >= 2 &&
    (spyBars[spyBars.length-1].c - spyBars[spyBars.length-2].c) / spyBars[spyBars.length-2].c < -0.015;
  if (spyAlreadyDown && !dryRunMode) {
    logEvent("filter", `SPY already down 1.5%+ today — raising put threshold to 85 (move may be priced in)`);
  }

  // ── OPENING VOLATILITY BLOCK — no new entries in first 15 min ──────────
  const etMinSinceOpen = (scanET.getHours() - 9) * 60 + scanET.getMinutes() - 30;
  const openingBlock   = etMinSinceOpen >= 0 && etMinSinceOpen < 15 && !dryRunMode;
  if (openingBlock) logEvent("filter", `Opening volatility block (${etMinSinceOpen}min since open) — entries paused until 9:45am`);

  // ── FINAL HOUR BLOCK — no new entries after 3pm (PDT protection) ─────
  const etHourEntry    = scanET.getHours() + scanET.getMinutes() / 60;
  const finalHourBlock = etHourEntry >= 15.0 && !dryRunMode;
  if (finalHourBlock) logEvent("filter", `Final hour block — no new entries after 3pm (PDT protection)`);

  const macroBullish  = (marketContext.macro?.mode === "aggressive");
  const pdtCount      = countRecentDayTrades();
  const pdtBlocked    = !dryRunMode && pdtCount >= PDT_LIMIT;
  if (pdtBlocked) logEvent("filter", `PDT limit reached (${pdtCount}/${PDT_LIMIT} day trades in 5 days) — no new entries`);

  const callsAllowed = (isEntryWindow("call") && !openingBlock && !finalHourBlock && !pdtBlocked) || dryRunMode;
  const putsAllowed  = (isEntryWindow("put") && !vixFallingPause && !spyRecovering && !openingBlock && !finalHourBlock && !macroBullish && !pdtBlocked) || dryRunMode;
  if (macroBullish && !dryRunMode) logEvent("filter", `Macro bullish (${marketContext.macro?.signal}) — puts blocked`);
  if (vixFallingPause && !dryRunMode) logEvent("filter", "VIX falling — put entries paused this scan");

  // ── SPY STRONG RECOVERY — exit losing puts ────────────────────────────
  // If SPY is up 1%+ from prior close, the macro environment has reversed
  // This catches gap-up opens driven by news (ceasefire, Fed pivot, etc)
  // Close puts that are underwater — thesis is broken by the macro move
  if (!dryRunMode && spyBars.length >= 2) {
    const prevClose  = spyBars[spyBars.length-2].c;
    const curSPY     = spyBars[spyBars.length-1].c;
    const spyDayMove = (curSPY - prevClose) / prevClose;
    if (spyDayMove > 0.01) { // SPY up 1%+ = strong macro reversal
      for (const pos of [...state.positions]) {
        if (pos.optionType !== "put") continue;
        const snap = posSnapshots[pos.contractSymbol];
        if (!snap) continue;
        const quote  = snap.latestQuote || {};
        const bid    = parseFloat(quote.bp || 0);
        const ask    = parseFloat(quote.ap || 0);
        const curP   = bid > 0 && ask > 0 ? (bid + ask) / 2 : pos.premium;
        const chg    = (curP - pos.premium) / pos.premium;
        if (chg < -0.05) { // only close puts that are already losing (5%+)
          logEvent("scan", `${pos.ticker} SPY macro reversal +${(spyDayMove*100).toFixed(1)}% — closing losing put (${(chg*100).toFixed(0)}%)`);
          await closePosition(pos.ticker, "macro-reversal");
        }
      }
    }
  }
  if (!callsAllowed && !putsAllowed) return;

  // [opening/final hour blocks moved above callsAllowed]
  if (state.circuitOpen === false || state.weeklyCircuitOpen === false) return;
  if (state.consecutiveLosses >= CONSEC_LOSS_LIMIT) return;
  if (state.cash <= CAPITAL_FLOOR) return;

  // ── PORTFOLIO GREEKS LIMITS ────────────────────────────────────────────
  // Prevent extreme one-sided exposure
  const pgr = marketContext.portfolioGreeks || { delta: 0, vega: 0 };
  const MAX_PORTFOLIO_DELTA = -500; // max short delta (puts) = -$500 per 1% SPY move
  const MAX_PORTFOLIO_VEGA  = 2000; // max vega = $2000 per 1% IV move
  if (pgr.delta < MAX_PORTFOLIO_DELTA) {
    logEvent("filter", `Portfolio delta ${pgr.delta} too short — blocking new put entries`);
    // Only block puts, calls can still balance the book
    if (!callsAllowed) return;
  }
  if (Math.abs(pgr.vega) > MAX_PORTFOLIO_VEGA) {
    logEvent("filter", `Portfolio vega ${pgr.vega} at limit — blocking new entries`);
    return;
  }

  // ── F8: High-beta correlation block ─────────────────────────────────────
  // Max 2 simultaneous positions with beta > 1.5 — prevents HOOD+ROKU+DKNG all open
  // These are effectively the same bet — all crash together in a market reversal
  const highBetaPositions = state.positions.filter(p => (p.beta || 1) > 1.5).length;
  if (highBetaPositions >= 2) {
    logEvent("filter", `High-beta correlation block — ${highBetaPositions} positions with beta>1.5 already open`);
    // Only block high-beta new entries — let lower beta through
  }

  // Burst entry cooldown — max 3 new positions per 10 minutes
  // Prevents over-concentration at a single market moment (e.g. after reset)
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const recentEntries = state.positions.filter(p => new Date(p.openDate).getTime() > tenMinAgo).length;
  if (recentEntries >= 3) {
    logEvent("filter", `Burst entry cooldown — ${recentEntries} positions opened in last 10min — waiting`);
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
      logEvent("filter", `Market gap ${marketGapDirection} ${(Math.abs(gapPct)*100).toFixed(1)}% — blocking calls, allowing puts only`);
      // Don't return — allow puts to be evaluated on gap down days
    }
  }

  // Score and rank candidates
  // ── PARALLEL PREFETCH — fetch all data for all stocks simultaneously ──────
  // This is the key performance optimization: instead of sequential API calls
  // per stock (~70s total), we fetch everything in parallel (~4s total)
  logEvent("scan", `Prefetching data for ${WATCHLIST.length} stocks in parallel...`);
  const prefetchStart = Date.now();

  // Batch stock prefetch in groups of 10 — prevents 288 simultaneous connections
  const STOCK_BATCH = 10;
  const stockData = [];
  for (let i = 0; i < WATCHLIST.length; i += STOCK_BATCH) {
    const batch = WATCHLIST.slice(i, i + STOCK_BATCH);
    const results = await Promise.all(
      batch.map(async stock => {
        try {
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
          // Store live beta on stock object for liveStock construction
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

  logEvent("scan", `Prefetch complete in ${((Date.now()-prefetchStart)/1000).toFixed(1)}s for ${WATCHLIST.length} stocks`);

  const scored = [];
  for (const { stock, price, bars, intradayBars, sectorResult, preMarket, newsArticles, analystData, eqScore } of stockData) {
    if (state.positions.find(p=>p.ticker===stock.ticker)) continue;

    // ── F14: Check ticker blacklist ───────────────────────────────────────
    if ((state.tickerBlacklist || []).includes(stock.ticker)) {
      logEvent("filter", `${stock.ticker} blacklisted — skipping`);
      continue;
    }

    // Ticker cooldown — differentiated by exit reason
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
      logEvent("filter", `${stock.ticker} cooldown — closed ${minsAgo}min ago (${recentClose.reason}) — wait ${waitMins}min`);
      continue;
    }

    // Wash sale detection — IRS disallows loss if same security re-entered within 30 days
    // Options on same underlying = "substantially identical" security under wash sale rules
    const WASH_SALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const washSaleClose = (state.closedTrades || []).find(t =>
      t.ticker === stock.ticker &&
      t.pnl < 0 &&               // was a loss
      t.closeTime &&
      (Date.now() - t.closeTime) < WASH_SALE_MS
    );
    if (washSaleClose) {
      const daysAgo = ((Date.now() - washSaleClose.closeTime) / MS_PER_DAY).toFixed(0);
      const daysRemaining = Math.ceil((WASH_SALE_MS - (Date.now() - washSaleClose.closeTime)) / MS_PER_DAY);
      logEvent("filter", `${stock.ticker} wash sale warning — loss of $${Math.abs(washSaleClose.pnl).toFixed(0)} closed ${daysAgo}d ago — ${daysRemaining}d remaining — entering anyway but flagging`);
      // Flag on the trade journal but don't block — trader may want to re-enter
      // The wash sale only matters for tax purposes, not trading logic
      stock._washSaleWarning = true;
    }

    if (!price || price < MIN_STOCK_PRICE) {
      logEvent("filter", `${stock.ticker} price $${price||0} unavailable or below min - skip`);
      continue;
    }

    // Check for opposite sector bets before filtering
    const sectorPositions = state.positions.filter(p => p.sector === stock.sector);
    const hasSectorCall   = sectorPositions.some(p => p.optionType === "call");
    const hasSectorPut    = sectorPositions.some(p => p.optionType === "put");

    // Get filter result — even on fail, collect weakness signals for put scoring
    const filterResult = await checkAllFilters(stock, price);

    // Collect weakness signals that boost put scores
    // CAP: max +20 total weakness boost — prevents whole-sector selloffs
    // from pushing every stock to 100 with no differentiation
    let weaknessBoost = 0;
    const weaknessReasons = [];
    const MAX_WEAKNESS_BOOST = 20;

    const avgVol      = bars.length ? bars.slice(0,-1).reduce((s,b)=>s+b.v,0)/Math.max(bars.length-1,1) : 0;
    const todayVol    = bars.length ? bars[bars.length-1].v : 0;

    // Relative strength vs SPY — declared early so weakness boost can use it
    const stockReturn = bars.length >= 5 ? (bars[bars.length-1].c - bars[0].o) / bars[0].o : 0;
    const relStrength = spyReturn !== 0 ? (1 + stockReturn) / (1 + spyReturn) : 1;

    if (!filterResult.pass) {
      const putRelevantFails = ["sector ETF", "support", "VWAP", "breakdown"];
      const isPutRelevant = putRelevantFails.some(f => filterResult.reason?.includes(f));
      if (!isPutRelevant) {
        logEvent("filter", `${stock.ticker} filter fail: ${filterResult.reason}`);
        continue;
      }
      // Sector ETF boost — scaled by how much this stock lags its ETF
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

    // Relative weakness vs sector peers — only meaningful edge if stock is lagging ITS sector
    // If everything scores 100 because the whole market is down, that's not signal
    // Calculate average return of same-sector stocks and compare this stock against it
    const sectorPeers  = stockData.filter(d => d.stock.sector === stock.sector && d.stock.ticker !== stock.ticker && d.bars && d.bars.length >= 5);
    const sectorAvgRet = sectorPeers.length
      ? sectorPeers.reduce((s, d) => s + (d.bars[d.bars.length-1].c - d.bars[0].o) / d.bars[0].o, 0) / sectorPeers.length
      : stockReturn;
    const relToSector  = sectorAvgRet !== 0 ? (1 + stockReturn) / (1 + sectorAvgRet) : 1;
    // Store on liveStock for use in scoring
    // relToSector < 1.0 = underperforming peers = genuine relative weakness

    // Gap check — catches both overnight gaps and intraday crashes
    if (bars.length >= 2) {
      // Overnight gap: today open vs yesterday close
      const overnightGap = Math.abs(bars[bars.length-1].o - bars[bars.length-2].c) / bars[bars.length-2].c;
      if (overnightGap > MAX_GAP_PCT) {
        logEvent("filter", `${stock.ticker} gap ${(overnightGap*100).toFixed(1)}% overnight - skip`);
        continue;
      }
      // Intraday crash: current price vs today's open — catches SMCI-style -30% intraday events
      // These stocks have broken options markets, extreme spreads, unreliable data
      const intradayCrash = (bars[bars.length-1].o - price) / bars[bars.length-1].o;
      if (intradayCrash > 0.15) {
        logEvent("filter", `${stock.ticker} intraday crash ${(intradayCrash*100).toFixed(1)}% below open — skip (broken options market)`);
        continue;
      }
    }

    // Anomaly detection — skip if unusual price movement detected
    const anomaly = detectPriceAnomaly(bars);
    if (anomaly.anomaly) { logEvent("filter", `${stock.ticker} price anomaly: ${anomaly.reason} - skip`); continue; }

    // Dynamic signals - calculated live from real price bars
    if (bars.length < 10) {
      logEvent("filter", `${stock.ticker} insufficient bars (${bars.length}) - skip`);
      continue;
    }
    const signals = await getDynamicSignals(stock.ticker, bars, intradayBars, stock._realIV || null);

    // Earnings quality score
    // eqScore already prefetched in parallel above

    // VWAP — use intraday VWAP from signals (available before liveStock is built)
    const vwap = signals.intradayVWAP > 0 ? signals.intradayVWAP : calcVWAP(bars.slice(-5));
    if (vwap > 0 && price < vwap * 0.99) {
      // Scale VWAP boost by how far below — more below = stronger signal
      const vwapGap   = (vwap - price) / vwap;
      const vwapPts   = vwapGap > 0.03 ? 10 : vwapGap > 0.01 ? 6 : 3;
      logEvent("filter", `${stock.ticker} price $${price} below ${signals.intradayVWAP > 0 ? 'intraday' : 'daily'} VWAP $${vwap} (${(vwapGap*100).toFixed(1)}% gap) - put boost +${vwapPts}`);
      weaknessBoost += vwapPts;
      weaknessReasons.push(`Below VWAP ${(vwapGap*100).toFixed(1)}% (+${vwapPts})`);
    }

    // Pre-market gap check — already prefetched
    if (preMarket && Math.abs(preMarket.gapPct) > 3) {
      logEvent("filter", `${stock.ticker} pre-market gap ${preMarket.gapPct > 0 ? "+" : ""}${preMarket.gapPct}%`);
    }

    // Short interest — computed from prefetched bars
    const shortSignal = await getShortInterestSignal(stock.ticker, bars);

    // News sentiment — already prefetched
    const newsSentiment = analyzeNews(newsArticles);

    // Merge live signals into stock object — intraday signals override static seed values
    // Attempt live beta fetch — use watchlist beta as fallback
    const liveBeta  = stock._liveBeta || stock.beta || 1.0;

    const liveStock = {
      ...stock,
      price:         price,
      rsi:           signals.rsi,
      macd:          signals.macd,
      momentum:      signals.momentum,  // now intraday momentum when available
      ivr:           signals.ivr,
      beta:          liveBeta,          // live beta overrides static watchlist value
      newsSentiment: newsSentiment.signal,
      intradayVWAP:  signals.intradayVWAP || 0,
      volPaceRatio:  signals.volPaceRatio || 1,
      hasIntraday:   signals.hasIntraday || false,
      ivPercentile:  signals.ivPercentile || 50,
    };
    // Log intraday data quality
    if (signals.hasIntraday) {
      logEvent("filter", `${stock.ticker} intraday RSI:${signals.rsi} MACD:${signals.macd} MOM:${signals.momentum} VWAP:$${signals.intradayVWAP?.toFixed(2)} VolPace:${signals.volPaceRatio?.toFixed(1)}x`);
      // Update oversold tracker — feeds capitulation call detection in MR scoring
      updateOversoldTracker(stock.ticker, signals.rsi);
    }

    // Time of day adjustment — only penalize late entries when VIX elevated OR volume declining
    // A strong high-volume breakout at 2:30PM is still worth trading
    const etHour      = scanET.getHours() + scanET.getMinutes() / 60;
    const isLastHour  = etHour >= 15.0;
    const isLateDay   = etHour >= 14.5;
    const volDecline  = todayVol < avgVol * 0.7;

    let timeOfDayMult = 1.0;
    if (isLastHour && (state.vix >= 25 || volDecline)) timeOfDayMult = 0.80;
    else if (isLateDay && state.vix >= 30)              timeOfDayMult = 0.90;

    // ── F7: Weekly trend filter ──────────────────────────────────────────────
    // Fetch cached weekly trend (60-min cache, no extra API call)
    const weeklyTrend = stock._weeklyTrend || { trend: 'neutral', above10wk: null };

    // Score both call and put setups using live signals
    const callSetup = scoreSetup(liveStock, relStrength, signals.adx, todayVol, avgVol);
    const putSetup  = scorePutSetup(liveStock, relStrength, signals.adx, todayVol, avgVol, state.vix);

    // Weekly trend adjustment — fighting a bullish weekly trend on puts needs higher conviction
    if (weeklyTrend.above10wk === true) {
      putSetup.score = Math.max(0, putSetup.score - 10);
      putSetup.reasons.push(`Above 10-wk MA $${weeklyTrend.ma10w} — puts fighting trend (-10)`);
    } else if (weeklyTrend.above10wk === false) {
      putSetup.score = Math.min(95, putSetup.score + 8);
      putSetup.reasons.push(`Below 10-wk MA $${weeklyTrend.ma10w} — aligned with downtrend (+8)`);
    }

    // Track relative weakness points to enforce group cap below
    let relWeaknessPoints = 0;

    // Volume context for puts — high volume confirms distribution, but capitulation
    // (extreme high volume) can signal reversal. Use nuanced scoring.
    const volRatio = avgVol > 0 ? todayVol / avgVol : 1;
    if (volRatio > 2.0) {
      // Extreme volume — could be capitulation (reversal) or panic (continuation)
      // Slight put boost but less than moderate high volume
      putSetup.score = Math.min(100, putSetup.score + 5);
      putSetup.reasons.push(`Extreme volume - possible capitulation (+5)`);
    } else if (volRatio > 1.3) {
      // Above average volume — confirms selling pressure
      putSetup.score = Math.min(100, putSetup.score + 8);
      putSetup.reasons.push(`High volume confirms selling pressure (+8)`);
    } else if (volRatio < 0.6) {
      // Very low volume selloff — weak conviction, slight penalty
      putSetup.score = Math.max(0, putSetup.score - 3);
      putSetup.reasons.push(`Low volume selloff (-3)`);
    }

    // Apply time of day multiplier
    callSetup.score = Math.round(callSetup.score * timeOfDayMult);
    putSetup.score  = Math.round(putSetup.score  * timeOfDayMult);
    if (timeOfDayMult < 1.0) {
      callSetup.reasons.push(`Time of day adj x${timeOfDayMult}`);
      putSetup.reasons.push(`Time of day adj x${timeOfDayMult}`);
    }

    // Unusual options activity boost — high vol/OI ratio means big money is moving
    // This uses today's options volume vs open interest on the selected contract
    // Applied after contract selection since volOIRatio comes from executeTrade context
    // Note: logged in executeTrade when volOIRatio > 3

    // SPY recovery suppresses puts — market bouncing = puts fighting the tape
    if (spyRecovering) {
      putSetup.score = Math.max(0, putSetup.score - 20);
      putSetup.reasons.push("SPY recovering — tape fighting puts (-20)");
    }

    // Relative sector weakness — real edge vs just broad market selloff
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
        putSetup.reasons.push(`Weak vs sector peers: ${((relToSector-1)*100).toFixed(1)}% (+0 — group cap reached)`);
      }
    } else if (relToSector > 1.03) {
      putSetup.score = Math.max(0, putSetup.score - 10);
      putSetup.reasons.push(`Outperforming sector peers (+${((relToSector-1)*100).toFixed(1)}%) — sector-wide move (-10)`);
    }

    // Volume pace boost — if running 2x+ expected volume, strong signal either direction
    if (signals.volPaceRatio > 2.0 && signals.hasIntraday) {
      putSetup.score  = Math.min(100, putSetup.score + 8);
      putSetup.reasons.push(`Volume running ${signals.volPaceRatio.toFixed(1)}x pace (+8)`);
      callSetup.score = Math.min(100, callSetup.score + 8);
      callSetup.reasons.push(`Volume running ${signals.volPaceRatio.toFixed(1)}x pace (+8)`);
    } else if (signals.volPaceRatio < 0.4 && signals.hasIntraday) {
      // Quiet tape — reduce conviction on both sides
      putSetup.score  = Math.max(0, putSetup.score - 5);
      callSetup.score = Math.max(0, callSetup.score - 5);
    }

    // Apply weakness boost to puts — filters that block calls become put signals
    if (weaknessBoost > 0) {
      // Hard cap at MAX_WEAKNESS_BOOST (20pts) — prevents market-wide selloffs
      // from pushing every stock to 100 with no differentiation
      // Raw boost can be 5-35 (sector ETF + VWAP + support) — always capped to 20
      const cappedBoost = Math.min(weaknessBoost, MAX_WEAKNESS_BOOST);
      putSetup.score  = Math.min(100, putSetup.score + cappedBoost);
      putSetup.reasons.push(...weaknessReasons);
      callSetup.score = Math.max(0, callSetup.score - cappedBoost);
      logEvent("filter", `${stock.ticker} weakness signals → put boost +${cappedBoost}${cappedBoost < weaknessBoost ? " (capped from +" + weaknessBoost + ")" : ""}`);
    }

    // VIX boost for puts — scaled, not flat
    // Flat +10 for all stocks when VIX>30 is undifferentiated — every stock gets same boost
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
      // FOMC/macro calendar reduces calls only — puts are unaffected
      // FOMC day weakness = valid put opportunity, don't suppress it
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + calMod));
      // puts: no penalty on macro event days — market weakness is the signal
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
    // Apply regime to regular calls first — MR calls bypass this (applied after MR check below)
    putSetup.score    = Math.min(100, Math.max(0, putSetup.score  + regimePutMod));
    if (regimeMod !== 0) {
      callSetup.reasons.push(`Regime ${marketContext.regime?.regime}: ${regimeMod > 0 ? "+" : ""}${regimeMod}`);
    }

    // Mean reversion call scoring — runs AFTER regime so bypass works correctly
    // MR fires here so isMeanReversion flag is set before regime penalty check below
    const mrSetup = scoreMeanReversionCall(liveStock, relStrength, signals.adx, bars, state.vix);
    if (mrSetup.score > callSetup.score) {
      // MR liquidity check — contract not yet fetched at this stage
      // Use stock-level proxy: beta > 1.2 and sector with active options = liquid enough
      // Real OI/spread check happens at execution time via _cachedContract after prefetch
      const mrBeta    = stock.beta || 1.0;
      const mrSector  = stock.sector || "";
      // Financial stocks typically have lower options liquidity for MR plays
      // Low beta stocks don't move enough for MR to be profitable after spread
      const mrLiquid  = mrBeta >= 1.2 && mrSector !== "Financial";
      if (mrLiquid) {
        callSetup.score   = mrSetup.score;
        callSetup.reasons = mrSetup.reasons;
        callSetup.isMeanReversion = true;
        logEvent("filter", `${stock.ticker} MEAN REVERSION: score ${mrSetup.score} | beta:${mrBeta} | liquidity check deferred to execution`);
      } else {
        logEvent("filter", `${stock.ticker} MEAN REVERSION skipped — beta:${mrBeta} sector:${mrSector} (low liquidity proxy)`);
      }
    }

    // Now apply regime to calls — MR calls bypass this penalty (they're designed for bear markets)
    if (!callSetup.isMeanReversion) {
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + regimeMod));
    }

    // Apply drawdown protocol min score
    const ddProtocol  = marketContext.drawdownProtocol || { minScore: MIN_SCORE, sizeMultiplier: 1.0 };

    // Apply macro modifier - boosts or suppresses all entries based on current events
    const macro       = marketContext.macro || { scoreModifier: 0, sectorBearish: [], sectorBullish: [] };
    let macroCallMod  = macro.scoreModifier || 0;
    let macroPutMod   = -(macro.scoreModifier || 0); // puts benefit from bearish macro

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
    if (marketGapDirection === "down") callScore = 0; // gap down = puts only
    if (marketGapDirection === "up")   putScore  = 0; // gap up = calls only
    // Apply entry window constraint
    if (!callsAllowed) callScore = 0;
    if (!putsAllowed)  putScore  = 0;
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

    // After 1PM ET, afternoon session is noisier — require higher conviction
    const etHourNow = scanET.getHours() + scanET.getMinutes() / 60;
    const afternoonMinScore = etHourNow >= 13 ? 85 : 0;
    const benchmarkMinScore = spyAlreadyDown && optionType === "put" ? 85 : 0;
    // F9: Use regime profile min score
    const regimeProfile    = getRegimeProfile(marketContext.regime?.regime || "neutral");
    const regimeMinScore   = regimeProfile.minScore;
    const effectiveMinScore = Math.max(ddProtocol.minScore || MIN_SCORE, afternoonMinScore, benchmarkMinScore, regimeMinScore);

    // Position limit removed — rely on heat % and correlation blocks
    if (bestScore < effectiveMinScore) {
      logEvent("filter", `${stock.ticker} call:${callSetup.score} put:${putSetup.score} - below ${effectiveMinScore} (${etHourNow >= 13 ? "afternoon" : ddProtocol.level} protocol) - skip`);
      continue;
    }

    // Block same ticker opposite direction only (not same sector — relative value trades are valid)
    const sameTickerOpposite = state.positions.find(p =>
      p.ticker === stock.ticker &&
      p.optionType !== optionType
    );
    if (sameTickerOpposite) {
      logEvent("filter", `${stock.ticker} same ticker opposite direction blocked - already have ${sameTickerOpposite.optionType}`);
      continue;
    }

    logEvent("filter", `${stock.ticker} best setup: ${optionType.toUpperCase()} score ${bestScore} | RSI:${signals.rsi} MACD:${signals.macd} MOM:${signals.momentum}`);
    // Queue for execution — heat is rechecked live in the execution loop below
    const isMR = optionType === "call" && callSetup.isMeanReversion;
    scored.push({ stock: liveStock, price, score: bestScore, reasons: bestReasons, optionType, isMeanReversion: isMR });
  }

  // Sort by score descending
  scored.sort((a,b) => b.score - a.score);

  // ── Relative score ranking — only enter top 20% of today's candidates ────
  // Prevents entering 8 positions simultaneously on a broad selloff day
  // where every stock scores 90+ just because the market is down
  if (scored.length >= 5) {
    const topN       = Math.max(1, Math.ceil(scored.length * 0.20));
    const cutoffScore = scored[topN - 1]?.score || 0;
    const aboveCutoff = scored.filter(s => s.score >= cutoffScore);
    // Only keep top 20% — but always keep at least 1 candidate
    scored.length = 0;
    aboveCutoff.forEach(s => scored.push(s));
    logEvent("filter", `Score ranking: keeping top ${aboveCutoff.length} of candidates (cutoff: ${cutoffScore})`);
  }

  // ── PARALLEL OPTIONS PREFETCH ─────────────────────────────────────────────
  // Fetch options chains for all scored stocks simultaneously before executing
  // This eliminates sequential chain fetching when multiple trades fire at once
  if (scored.length > 0) {
    logEvent("scan", `Prefetching options chains for ${scored.length} candidates in parallel...`);
    const optPrefetchStart = Date.now();
    // Process in batches of 5 to avoid exhausting Railway connection pool
    // 5 concurrent options fetches × up to 40 snapshot batches each = 200 max connections
    const BATCH_SIZE = 5;
    for (let i = 0; i < scored.length; i += BATCH_SIZE) {
      const batch = scored.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async ({ stock, price, optionType, score }) => {
        try {
          const contract = await getRealOptionsContract(stock.ticker, price, optionType, score, state.vix, stock.earningsDate);
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

  // Enter trades — sorted by score, best first
  // heatPct() is live and updates after every executeTrade call
  for (const { stock, price, score, reasons, optionType, isMeanReversion } of scored) {
    if (heatPct() >= MAX_HEAT) break;
    if (state.cash <= CAPITAL_FLOOR) break;

    const { pass, reason } = await checkAllFilters(stock, price);
    if (!pass) {
      const putBypassReasons = ["sector ETF", "support", "VWAP", "breakdown"];
      const canBypassForPut  = optionType === "put" && putBypassReasons.some(r => reason?.includes(r));
      if (!canBypassForPut) {
        logEvent("filter", `${stock.ticker} - ${reason}`);
        continue;
      }
      logEvent("filter", `${stock.ticker} - bypassing filter for PUT: ${reason}`);
    }

    // ── F8: Block high-beta entry if correlation limit reached ──────────────
    const stockBeta = stock.beta || stock._liveBeta || 1.0;
    if (stockBeta > 1.5 && highBetaPositions >= 2 && !dryRunMode) {
      logEvent("filter", `${stock.ticker} beta:${stockBeta.toFixed(1)} — high-beta limit reached (${highBetaPositions}/2)`);
      continue;
    }

    // Liquidity pre-check — block before executeTrade if contract is clearly unfillable
    // executeTrade also checks, but this avoids unnecessary order submission attempts
    if (stock._cachedContract) {
      const execOI     = stock._cachedContract.oi || 0;
      const execSpread = stock._cachedContract.spread || 1;
      // Hard block: OI known and below floor
      if (execOI > 0 && execOI < MIN_OI) {
        logEvent("filter", `${stock.ticker} pre-blocked — OI:${execOI} below minimum ${MIN_OI}`);
        continue;
      }
      // Hard block: spread too wide
      if (execSpread > MAX_SPREAD_PCT) {
        logEvent("filter", `${stock.ticker} pre-blocked — spread ${(execSpread*100).toFixed(0)}% exceeds ${(MAX_SPREAD_PCT*100).toFixed(0)}% max`);
        continue;
      }
      // MR-specific tighter gate: MR trades need better liquidity
      if (isMeanReversion && execOI > 0 && execOI < 50 && execSpread > 0.20) {
        logEvent("filter", `${stock.ticker} MEAN REVERSION blocked — OI:${execOI} spread:${(execSpread*100).toFixed(0)}% too illiquid for MR`);
        continue;
      }
    }
    const entered = await executeTrade(stock, price, score, reasons, state.vix, optionType, isMeanReversion);
    if (entered) await new Promise(r=>setTimeout(r,500));
  }

  // Check stock buys
  await checkStockBuys();

  state.lastScan    = new Date().toISOString();
  state._scanFailures = 0; // reset consecutive failure counter on success
  markDirty(); // flush handled by dedicated interval below
  } catch(e) {
    logEvent("error", `runScan crashed: ${e.message} | stack: ${e.stack?.split("\n")[1]?.trim() || "unknown"}`);
    // Track consecutive scan failures — alert after 3 in a row
    state._scanFailures = (state._scanFailures || 0) + 1;
    if (state._scanFailures >= 3 && RESEND_API_KEY && GMAIL_USER && isMarketHours()) {
      await sendResendEmail(
        `APEX ALERT — Scanner failing (${state._scanFailures} errors)`,
        `<div style="font-family:monospace;background:#07101f;color:#ff5555;padding:20px">
          <h2>⚠ APEX Scanner Error</h2>
          <p>Consecutive scan failures: <strong>${state._scanFailures}</strong></p>
          <p>Last error: ${e.message}</p>
          <p>Time: ${new Date().toISOString()}</p>
          <p>Open positions: ${state.positions.length}</p>
          <p>Cash: $${state.cash}</p>
          <p><strong>Check Railway logs immediately.</strong></p>
        </div>`
      );
      logEvent("warn", `Scan failure alert sent — ${state._scanFailures} consecutive errors`);
    }
  } finally {
    // Reset failure counter on successful scan completion
    if (!state._scanFailures) state._scanFailures = 0;
    scanRunning = false;
  }
}

// - ADX Calculation -
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

// - Email System -
// ── F12: Enhanced morning briefing ───────────────────────────────────────
async function sendMorningBriefing() {
  if (!RESEND_API_KEY || !GMAIL_USER) return;
  try {
    const positions = state.positions || [];
    const pdtUsed   = countRecentDayTrades();
    const pdtLeft   = Math.max(0, 3 - pdtUsed);
    // Fetch fresh macro + news at send time — don't rely on cached context
    const freshMacro = await getMacroNews();
    marketContext.macro = freshMacro;
    const macro = freshMacro;

    // Also fetch Marketaux directly for guaranteed fresh headlines
    const mxDirect = await getMarketauxNews();
    const today     = new Date();
    const dateStr   = today.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    const macroSignal = (macro.signal || 'neutral').toUpperCase();

    // ── Agent narrative briefing ─────────────────────────────────────────
    let agentNarrative = null;
    if (ANTHROPIC_API_KEY) {
      try {
        agentNarrative = await getAgentMorningBriefing(positions, macro, macro.headlines || []);
        logEvent("scan", "[AGENT] Morning briefing written by Claude");
      } catch(e) {
        console.log("[AGENT] Morning briefing failed:", e.message);
      }
    }

    // ── Divider helper ───────────────────────────────────────────────────
    const divider = '<div style="border-top:1px solid #333;margin:14px 0"></div>';
    const sectionHead = (title) =>
      `<div style="font-family:Georgia,serif;font-size:10px;font-weight:bold;letter-spacing:2px;color:#555;text-transform:uppercase;margin-bottom:6px">${title}</div>`;

    // ── Header ───────────────────────────────────────────────────────────
    const header = `
      <div style="text-align:center;border-bottom:3px double #333;padding-bottom:12px;margin-bottom:12px">
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#111;letter-spacing:1px">APEX TRADING DESK</div>
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

    // ── Positions table ───────────────────────────────────────────────────
    const posRows = positions.length ? positions.map(p => {
      const dteDays   = p.expDate ? Math.max(0, Math.round((new Date(p.expDate) - today) / 86400000)) : '?';
      // Use live price if available, fall back to after-hours estimate, then show entry
      const useAH     = !p.currentPrice && p.estimatedAH;
      const curPrice  = p.currentPrice || (useAH ? p.estimatedAH.price : null);
      const chgNum    = curPrice && p.premium ? ((curPrice - p.premium) / p.premium * 100) : null;
      const chgStr    = chgNum !== null ? chgNum.toFixed(1) : '—';
      const pnlDollar = chgNum !== null ? ((curPrice - p.premium) * 100 * (p.contracts||1)).toFixed(0) : '—';
      const warn      = chgNum !== null && chgNum <= -12 ? ' ⚠' : '';
      const pnlColor  = chgNum === null ? '#555' : chgNum >= 0 ? '#006600' : '#cc0000';
      const estLabel  = useAH ? '<span style="font-size:8px;color:#999"> est</span>' : '';
      const stockPx   = p.price ? ` <span style="font-size:9px;color:#999">· ${p.ticker} $${p.price.toFixed(2)}</span>` : '';
      return `<tr style="border-bottom:1px solid #eee">
        <td style="padding:5px 4px;font-weight:bold">${p.ticker}${warn}</td>
        <td style="padding:5px 4px;color:#555">${p.optionType.toUpperCase()} $${p.strike}</td>
        <td style="padding:5px 4px;color:#555">${dteDays}d</td>
        <td style="padding:5px 4px">
          <span style="font-size:9px;color:#555">entry $${p.premium}</span>
          ${curPrice ? ` → <span style="color:${pnlColor};font-weight:bold">$${curPrice.toFixed(2)}${estLabel}</span>` : ''}
        </td>
        <td style="padding:5px 4px;font-weight:bold;color:${pnlColor}">${chgNum!==null?(chgNum>=0?'+':'')+chgStr+'%':'—'}${stockPx}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" style="padding:8px;color:#999;font-style:italic">No open positions</td></tr>';

    const posTable = `
      <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:monospace">
        <tr style="border-bottom:2px solid #333">
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">TICKER</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">CONTRACT</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">DTE</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">PRICE</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">P&amp;L · STOCK</th>
        </tr>
        ${posRows}
      </table>`;

    // ── Position news (latest headline per ticker) ─────────────────────
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
                <span style="font-size:10px;color:#555"> — ${article.headline}</span>
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

    // ── Top headlines (regardless of keyword match) ────────────────────
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
            ${tag ? `<span style="font-size:9px;font-weight:bold;color:${s.direction==='bullish'?'#006600':'#cc0000'};letter-spacing:1px">${tag} · ${(s.source||'').toUpperCase()} · ${s.direction.toUpperCase()}</span><br>` : ''}
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
    // Always show at least 3 recent headlines — even on quiet nights
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

    // ── Economic calendar ─────────────────────────────────────────────
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

    // ── Macro triggers ────────────────────────────────────────────────
    const triggersHTML = macro.triggers && macro.triggers.length
      ? divider + `<div style="font-size:10px;color:#555"><strong style="letter-spacing:1px">MACRO SIGNALS:</strong> ${macro.triggers.join(' · ')}</div>`
      : '';

    // ── Footer ────────────────────────────────────────────────────────
    const footer = `
      <div style="border-top:3px double #333;margin-top:16px;padding-top:8px;text-align:center;font-size:9px;color:#999;letter-spacing:1px">
        APEX v3.95 · Entry window 9:45am–3pm ET · No entries first 15min or last hour
      </div>`;

    // ── Assemble ──────────────────────────────────────────────────────
    const html = `
      <div style="font-family:Georgia,serif;background:#ffffff;color:#111;padding:24px;max-width:620px;border:1px solid #ccc">
        ${header}
        ${divider}
        ${agentNarrative ? sectionHead('ANALYST BRIEFING — APEX INTELLIGENCE') + '<div style="font-family:Georgia,serif;font-size:13px;color:#111;line-height:1.7;white-space:pre-wrap;padding:8px 0">' + agentNarrative + '</div>' + divider : ''}
        ${sectionHead('Open Positions — ' + positions.length + ' active')}
        ${posTable}
        ${triggersHTML}
        ${headlinesHTML}
        ${posNewsHTML}
        ${calHTML}
        ${footer}
      </div>`;

    await sendResendEmail(
      `APEX Trading Desk — ${dateStr} | VIX ${state.vix} | ${positions.length} positions`,
      html
    );
    logEvent("scan", "Morning briefing email sent");
  } catch(e) { console.error("[EMAIL] Morning briefing error:", e.message); }
}

// nodemailer removed — email now via Resend API (sendResendEmail)

// ── Resend email helper ───────────────────────────────────────────────────
async function sendResendEmail(subject, html) {
  if (!RESEND_API_KEY || !GMAIL_USER) {
    console.log("[EMAIL] Resend not configured — set RESEND_API_KEY and GMAIL_USER in Railway");
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
        from:    "APEX Trading <onboarding@resend.dev>",
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
  const daily  = (state.cash - state.dayStartCash).toFixed(2);
  const weekly = (state.cash - state.weekStartCash).toFixed(2);

  const posRows = state.positions.map(p =>
    `<tr><td>${p.ticker}</td><td>$${p.strike}C</td><td>${p.expDate}</td><td>${p.contracts}x</td><td>$${p.premium}</td><td>${p.score||"?"}/100</td></tr>`
  ).join("") || "<tr><td colspan='6' style='color:#666'>No open positions</td></tr>";

  const recentTrades = trades.slice(-5).reverse().map(t =>
    `<tr><td>${t.ticker}</td><td style='color:${t.pnl>=0?"#00aa44":"#cc2222"}'>${t.pnl>=0?"+":""}$${t.pnl.toFixed(2)}</td><td>${t.reason}</td><td>${t.date}</td></tr>`
  ).join("") || "<tr><td colspan='4' style='color:#666'>No trades yet</td></tr>";

  const isGood = parseFloat(daily) >= 0;

  return `
<!DOCTYPE html><html><body style="font-family:monospace;background:#07101f;color:#cce8ff;padding:20px;max-width:600px">
<div style="background:#0a1628;border:1px solid #0d3050;border-radius:12px;padding:20px;margin-bottom:16px">
  <h2 style="color:#00ff88;margin:0 0 4px">- APEX ${type === "morning" ? "Morning Briefing" : "End of Day Report"}</h2>
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
  <p style="font-size:12px;color:#cce8ff;margin:0">APEX will scan every minute from 10:00 AM - 3:30 PM ET. VIX is currently ${state.vix} - ${state.vix<20?"normal conditions, full sizing":"reduced sizing active"}. ${state.positions.length} position${state.positions.length!==1?"s":""} currently open.</p>
</div>` : `
<div style="background:rgba(0,196,255,0.05);border:1px solid rgba(0,196,255,0.15);border-radius:8px;padding:14px">
  <h3 style="color:#00c4ff;font-size:11px;margin:0 0 6px">END OF DAY SUMMARY</h3>
  <p style="font-size:12px;color:#cce8ff;margin:0">Market closed. ${state.todayTrades} trade${state.todayTrades!==1?"s":""} executed today. Daily P&L: ${parseFloat(daily)>=0?"+":""}$${daily}. APEX resumes scanning tomorrow at 10:00 AM ET.</p>
</div>`}

<p style="font-size:10px;color:#336688;text-align:center;margin-top:16px">APEX Professional Options Agent - Paper Trading - Not financial advice</p>
</body></html>`;
}

async function sendEmail(type) {
  if (!RESEND_API_KEY || !GMAIL_USER) { logEvent("warn", "Email not configured"); return; }
  const subject = type === "morning"
    ? `APEX Morning Briefing - ${new Date().toLocaleDateString()}`
    : `APEX EOD Report - P&L ${(state.cash-state.dayStartCash)>=0?"+":""}$${(state.cash-state.dayStartCash).toFixed(2)}`;
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

  return `APEX MONTHLY PERFORMANCE REPORT
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
// Every 30 seconds Mon-Fri (market hours checked inside runScan)
setInterval(() => {
  const day = getETTime().getDay();
  if (day >= 1 && day <= 5) runScan();
}, 30000);

// ── F3: After-hours context update — every 15 min Mon-Fri outside market hours ──
// Updates macro news, VIX proxy, Fear&Greed overnight
// Ensures APEX walks into market open with fresh context, not stale data
async function updateAfterHoursContext() {
  const et  = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return; // skip weekends
  if (isMarketHours()) return; // market scan handles this during hours
  try {
    // ── Macro / sentiment context ─────────────────────────────────────────
    const macro = await getMacroNews();
    marketContext.macro = macro;
    if (macro.mode !== "normal") {
      logEvent("macro", `[AH] Overnight macro: ${macro.signal} — ${macro.triggers.slice(0,3).join(", ")}`);
    }
    const fg = await getFearAndGreed();
    marketContext.fearGreed = fg;
    const newVIX = await getVIX();
    if (newVIX) state.vix = newVIX;
    if (state.positions.length > 0 && macro.mode === "aggressive") {
      logEvent("warn", `[AH] Bullish macro overnight — ${state.positions.filter(p=>p.optionType==="put").length} puts may be at risk at open`);
    }

    // ── Overnight position pricing ────────────────────────────────────────
    // Options don't trade after hours — fetch underlying stock price instead
    // Use Black-Scholes to estimate what the option is worth at the new stock price
    // Stored separately as estimatedAH — never overwrites real currentPrice
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
          const greeks        = calcGreeks(newStockPrice, pos.strike, dte, iv, pos.optionType);
          // Delta-based estimate — most reliable approach without live options data
          // How much the stock moved × option delta = estimated option price change
          const priceDelta   = newStockPrice - (pos.price || newStockPrice);
          const optionDelta  = parseFloat(pos.greeks?.delta || greeks.delta);
          const estPrice     = parseFloat(Math.max(0.01, (pos.currentPrice || pos.premium) + (priceDelta * optionDelta)).toFixed(2));
          const estPnl       = parseFloat(((estPrice - pos.premium) * 100 * (pos.contracts || 1)).toFixed(2));
          const estPct       = parseFloat((((estPrice - pos.premium) / pos.premium) * 100).toFixed(1));

          // Store as estimatedAH — separate from real currentPrice
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

// Dedicated state flush every 30 seconds — decoupled from scan timing
// Ensures dirty state is persisted even if scan is slow or skipped
setInterval(() => {
  flushStateIfDirty().catch(e => console.error("Flush interval error:", e.message));
}, 30000);

// ── F4: Alpaca account balance sync every 60 seconds ─────────────────────
// Syncs both display (alpacaCash) and internal cash ledger (state.cash)
// Keeps APEX aligned with actual Alpaca fills — prevents P&L drift
setInterval(async () => {
  if (!ALPACA_KEY) return;
  try {
    const acct = await alpacaGet("/account");
    if (acct && acct.cash) {
      const alpacaCash = parseFloat(acct.cash);
      state.alpacaCash = alpacaCash; // always update display

      // Also sync state.cash if no custom budget and drift > $5
      const hasCustomBudget = state.customBudget && state.customBudget > 0 && state.customBudget !== MONTHLY_BUDGET;
      if (!hasCustomBudget) {
        const drift = Math.abs(alpacaCash - state.cash);
        if (drift > 5.00) {
          logEvent("scan", `[CASH SYNC] Alpaca: $${alpacaCash.toFixed(2)} | APEX: $${state.cash.toFixed(2)} | drift: $${drift.toFixed(2)} — syncing`);
          state.cash = alpacaCash;
        }
      }
      markDirty();
    }
  } catch(e) {} // silent — non-critical
}, 60 * 1000); // every 60 seconds

// ── F2: Pre-market carry-over assessment (9:00 AM ET) ────────────────────
// Checks overnight positions against pre-market conditions
// Flags positions likely to need immediate action at open
async function premarketAssessment() {
  if (!state.positions.length) return;
  try {
    const macro = await getMacroNews();
    marketContext.macro = macro;
    const fg   = await getFearAndGreed();
    const vix  = await getVIX();
    if (vix) state.vix = vix;
    marketContext.fearGreed = fg;

    logEvent("scan", `[PREMARKET] Assessing ${state.positions.length} positions | VIX:${state.vix} | Macro:${macro.signal}`);

    // Assess each position — build recommendation
    const assessments = [];
    for (const pos of state.positions) {
      const reasons   = [];
      const riskFlags = [];
      let recommendation = "HOLD"; // default

      // ── P&L check ────────────────────────────────────────────────────
      const curP  = pos.currentPrice || (pos.estimatedAH ? pos.estimatedAH.price : null) || pos.premium;
      const chg   = ((curP - pos.premium) / pos.premium) * 100;
      const pnlEst= ((curP - pos.premium) * 100 * (pos.contracts||1)).toFixed(0);
      const isAH  = !pos.currentPrice && pos.estimatedAH;

      if (chg <= -20) {
        riskFlags.push(`Down ${chg.toFixed(1)}% — near stop loss`);
        recommendation = "CLOSE";
      } else if (chg <= -10) {
        riskFlags.push(`Down ${chg.toFixed(1)}% — monitor closely`);
        recommendation = "WATCH";
      } else if (chg >= 20) {
        riskFlags.push(`Up ${chg.toFixed(1)}% — consider taking profit`);
        recommendation = "WATCH";
      }

      // ── Thesis check ─────────────────────────────────────────────────
      try {
        const bars = await getStockBars(pos.ticker, 20);
        if (bars.length >= 14) {
          const curRSI   = calcRSI(bars);
          const entryRSI = pos.entryRSI || 70;
          if (pos.optionType === "put" && entryRSI >= 65 && curRSI < 50) {
            riskFlags.push(`RSI recovered from ${entryRSI} → ${curRSI.toFixed(0)} — put thesis degraded`);
            if (recommendation === "HOLD") recommendation = "WATCH";
          }
        }
      } catch(e) {}

      // ── Macro alignment ───────────────────────────────────────────────
      if (pos.optionType === "put" && macro.mode === "aggressive") {
        riskFlags.push("Bullish macro overnight — put thesis at risk");
        recommendation = "WATCH";
      }
      if (pos.optionType === "call" && macro.mode === "defensive") {
        riskFlags.push("Bearish macro overnight — call thesis at risk");
        recommendation = "WATCH";
      }

      // ── DTE checks ───────────────────────────────────────────────────
      const dte = pos.expDate
        ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY))
        : (pos.expDays || 30);
      if (dte <= 3) {
        riskFlags.push(`${dte}DTE — expiring imminently, theta accelerating`);
        recommendation = "CLOSE";
      } else if (dte <= 7 && state.vix > 35) {
        riskFlags.push(`${dte}DTE + VIX ${state.vix} — short-dated in high vol`);
        if (recommendation === "HOLD") recommendation = "WATCH";
      }

      // ── VIX extreme ──────────────────────────────────────────────────
      if (state.vix > 45) {
        riskFlags.push(`VIX ${state.vix} — extreme volatility, wide spreads at open`);
      }

      assessments.push({
        ticker:         pos.ticker,
        optionType:     pos.optionType,
        strike:         pos.strike,
        dte,
        chg:            parseFloat(chg.toFixed(1)),
        pnlEst:         parseFloat(pnlEst),
        curP:           parseFloat(curP.toFixed(2)),
        isAH,
        recommendation,
        riskFlags,
      });

      const emoji = recommendation === "CLOSE" ? "🔴" : recommendation === "WATCH" ? "🟡" : "🟢";
      logEvent(recommendation === "HOLD" ? "scan" : "warn",
        `[PREMARKET] ${emoji} ${pos.ticker} — ${recommendation} | ${chg.toFixed(1)}% | ${riskFlags.join(" | ") || "OK"}`
      );
    }

    // Always send email — show full picture even on quiet mornings
    if (RESEND_API_KEY && GMAIL_USER) {
      const closes = assessments.filter(a => a.recommendation === "CLOSE");
      const watches = assessments.filter(a => a.recommendation === "WATCH");
      const holds  = assessments.filter(a => a.recommendation === "HOLD");
      const subject = closes.length
        ? `APEX Pre-Market — ${closes.length} CLOSE, ${watches.length} WATCH | ${new Date().toLocaleDateString()}`
        : `APEX Pre-Market — All Clear | ${new Date().toLocaleDateString()}`;

      const rowColor = (rec) => rec === "CLOSE" ? "#cc0000" : rec === "WATCH" ? "#cc6600" : "#006600";
      const rows = assessments.map(a => `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:6px 4px;font-weight:bold">${a.ticker}</td>
          <td style="padding:6px 4px;color:#555">${a.optionType.toUpperCase()} $${a.strike}</td>
          <td style="padding:6px 4px;color:#555">${a.dte}d</td>
          <td style="padding:6px 4px;color:${a.chg>=0?'#006600':'#cc0000'};font-weight:bold">${a.chg>=0?'+':''}${a.chg}%${a.isAH?' <small style="color:#999">(est)</small>':''}</td>
          <td style="padding:6px 4px;font-weight:bold;color:${rowColor(a.recommendation)}">${a.recommendation}</td>
          <td style="padding:6px 4px;font-size:10px;color:#555">${a.riskFlags.join(" · ") || "—"}</td>
        </tr>`
      ).join("");

      await sendResendEmail(subject, `
        <div style="font-family:Georgia,serif;background:#fff;color:#111;padding:24px;max-width:700px;border:1px solid #ccc">
          <div style="text-align:center;border-bottom:3px double #333;padding-bottom:12px;margin-bottom:16px">
            <div style="font-size:20px;font-weight:bold;letter-spacing:1px">APEX PRE-MARKET ASSESSMENT</div>
            <div style="font-size:10px;color:#555;margin-top:4px;letter-spacing:1px">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase()} · 8:45AM ET</div>
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
            ${macro.triggers && macro.triggers.length ? '<strong>Macro signals:</strong> ' + macro.triggers.join(' · ') + '<br>' : ''}
            <em>These are recommendations only. APEX will manage exits automatically at open.</em>
          </div>
          <div style="border-top:3px double #333;margin-top:12px;padding-top:8px;text-align:center;font-size:9px;color:#999;letter-spacing:1px">
            APEX v3.95 · Market opens in ~45 minutes · Entry window 9:45am ET
          </div>
        </div>`
      );
    }
    markDirty();
  } catch(e) { console.error("[PREMARKET] Assessment error:", e.message); }
}

// Morning reset + email 13:00 UTC = 9:00 AM EDT (UTC-4, DST in effect Mar-Nov)
// Note: becomes 14:00 UTC = 9:00 AM EST in winter (Nov-Mar)
// Pre-market assessment 8:45 AM ET (12:45 UTC EDT / 13:45 UTC EST)
cron.schedule("45 12 * * 1-5", async () => {
  await premarketAssessment();
});
cron.schedule("45 13 * * 1-5", async () => {
  await premarketAssessment(); // winter fallback
});

cron.schedule("0 13 * * 1-5", async () => {
  state.dayStartCash      = state.cash;
  state.todayTrades       = 0;
  state.consecutiveLosses = 0;
  state.circuitOpen       = true;
  state.tickerBlacklist   = []; // clear daily blacklist at market open
  await saveStateNow();
  await sendMorningBriefing();
  sendEmail("morning");
});

// EOD email 20:05 UTC = 4:05 PM EDT (UTC-4)
cron.schedule("5 20 * * 1-5", () => { sendEmail("eod"); });

// Health check every 15 minutes during market hours
cron.schedule("*/15 13-20 * * 1-5", async () => {
  if (!isMarketHours()) return;
  const lastScan    = state.lastScan ? new Date(state.lastScan) : null;
  const minsSinceLastScan = lastScan ? (Date.now() - lastScan.getTime()) / 60000 : 999;
  if (minsSinceLastScan > 15 && minsSinceLastScan < 999 && RESEND_API_KEY && GMAIL_USER) {
    logEvent("warn", `Health check: no scan in ${minsSinceLastScan.toFixed(0)} minutes - sending alert`);
    sendResendEmail(
      "APEX ALERT - Scanner may be down",
      `<p>APEX has not scanned in ${minsSinceLastScan.toFixed(0)} minutes during market hours.</p>
             <p>Last scan: ${state.lastScan || "unknown"}</p>
             <p>Check Railway logs immediately.</p>`
    );
  }
});

// Weekly reset Monday morning
cron.schedule("0 13 * * 1", async () => {
  state.weekStartCash     = state.cash;
  state.weeklyCircuitOpen = true;
  await saveStateNow();
  logEvent("reset", "Weekly circuit breaker reset");
});

// Monthly report - runs every Monday, checks inside if it is the first Monday of the month
cron.schedule("0 13 * * 1", async () => {
  const et  = getETTime();
  const day = et.getDate();
  if (day > 7) return; // only first Monday of month
  const report = buildMonthlyReport();
  logEvent("monthly", report);
  state.monthlyProfit = 0;
  state.monthStart    = new Date().toLocaleDateString();
  await saveStateNow();
  if (RESEND_API_KEY && GMAIL_USER) {
    sendResendEmail(
      `APEX Monthly Report - ${et.toLocaleDateString("en-US",{month:"long",year:"numeric"})}`,
      `<pre style="font-family:monospace;background:#07101f;color:#cce8ff;padding:20px">${report}</pre>`
    );
  }
});

// - Express API -
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", async (req, res) => {
  res.json({
    ...state,
    heatPct:       parseFloat((heatPct()*100).toFixed(1)),
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
    pdtCount:           countRecentDayTrades(),

    tickerBlacklist:    state.tickerBlacklist || [],
    pdtLimit:           PDT_LIMIT,
    pdtBlocked:         countRecentDayTrades() >= PDT_LIMIT,
    exitStats:          state.exitStats || {},
    agentMacro:         state._agentMacro || null,
    agentAutoExitEnabled: state.agentAutoExitEnabled || false,
    portfolioSnapshots: state.portfolioSnapshots || [],
    reconcileStatus:    state.reconcileStatus || "unknown",
    orphanCount:        state.orphanCount || 0,
    lastReconcile:      state.lastReconcile || null,
    scanFailures:       state._scanFailures || 0,
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
    riskOfRuin:         calcRiskOfRuin(),
  });
});

app.post("/api/scan",        async (req,res) => { res.json({ok:true}); runScan(); });
app.post("/api/close/:tkr",  async (req,res) => {
  const t = req.params.tkr.toUpperCase();
  if (!state.positions.find(p=>p.ticker===t)) { res.status(404).json({error:"No position"}); return; }
  await closePosition(t,"manual");
  res.json({ok:true});
});
// Test email endpoint — sends a test email immediately
app.post("/api/test-email", async (req, res) => {
  if (!RESEND_API_KEY || !GMAIL_USER) {
    return res.json({ error: "Email not configured — set RESEND_API_KEY and GMAIL_USER in Railway env vars" });
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
      `APEX Email Test - ${new Date().toLocaleTimeString()}`,
      `<div style="font-family:monospace;background:#07101f;color:#00ff88;padding:20px;border-radius:8px">
        <h2>✅ APEX Email Working</h2>
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

// Dry run scan — full scan logic, no orders, no state changes
app.post("/api/dry-run-scan", async (req, res) => {
  // Wait up to 35 seconds for any running scan to complete
  let waited = 0;
  while (scanRunning && waited < 35000) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }
  if (scanRunning) return res.json({ error: "Scan still running after 35s — try again" });
  dryRunMode = true;
  logEvent("scan", "═══ DRY RUN SCAN STARTED ═══");
  try {
    await runScan();
  } finally {
    dryRunMode = false;
    logEvent("scan", "═══ DRY RUN SCAN COMPLETE ═══");
  }
  // Return all dryrun log entries from this scan
  const dryLogs = state.tradeLog
    .filter(e => e.type === "dryrun" || (e.type === "filter" && new Date(e.time) > new Date(Date.now() - 120000)))
    .slice(0, 50);
  res.json({ ok: true, message: "Dry run complete — check server log for details", entries: dryLogs });
});

// Reset circuit breaker only — keeps positions and cash
app.post("/api/reset-circuit", async (req, res) => {
  state.circuitOpen       = true;
  state.weeklyCircuitOpen = true;
  state.consecutiveLosses = 0;
  state.dayStartCash      = state.cash; // reset daily baseline to current cash
  await saveStateNow();
  logEvent("circuit", "Circuit breaker manually reset — resuming normal operations");
  res.json({ ok: true, cash: state.cash, positions: state.positions.length });
});

// Full reset — wipes everything back to fresh $10,000 state
app.post("/api/full-reset", async (req, res) => {
  // Cancel all open Alpaca positions first
  for (const pos of [...state.positions]) {
    if (pos.contractSymbol) {
      try {
        const qty = Math.max(1, pos.contracts);
        const bidPrice = parseFloat((pos.bid > 0 ? pos.bid : pos.premium * 0.98).toFixed(2));
        await alpacaPost("/orders", {
          symbol: pos.contractSymbol, qty, side:"sell",
          type:"limit", time_in_force:"day", limit_price: bidPrice
        });
      } catch(e) { /* best effort */ }
    }
  }
  // Reset state completely
  state = defaultState();
  await saveStateNow();
  logEvent("reset", "FULL RESET — state wiped, starting fresh with $10,000");
  res.json({ ok: true, message: "Full reset complete" });
});

// Emergency close all positions
app.post("/api/emergency-close", async (req, res) => {
  const snapshot = [...state.positions]; // snapshot before any mutations
  const count    = snapshot.length;
  let closed = 0, failed = 0;

  logEvent("circuit", `EMERGENCY CLOSE ALL initiated — ${count} positions`);

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

  logEvent("circuit", `EMERGENCY CLOSE ALL complete — ${closed} closed, ${failed} failed`);

  // Force save regardless of errors
  try { await saveStateNow(); } catch(e) { logEvent("error", `Post-emergency save failed: ${e.message}`); }

  res.json({ ok: true, closed, failed, total: count });
});

// ── Agent auto-exit toggle endpoint ──────────────────────────────────────
app.post("/api/agent-auto-exit", (req, res) => {
  const { enabled } = req.body;
  state.agentAutoExitEnabled = !!enabled;
  markDirty();
  logEvent("scan", `[AGENT] Auto-exit ${enabled ? "ENABLED" : "DISABLED"}`);
  res.json({ ok: true, enabled: state.agentAutoExitEnabled });
});

// ── Live position rescore endpoint ───────────────────────────────────────
// Called by dashboard to get agent-powered live rescore for each position
app.get("/api/rescore/:ticker", async (req, res) => {
  const pos = (state.positions || []).find(p => p.ticker === req.params.ticker);
  if (!pos) return res.json({ error: "Position not found" });
  if (!ANTHROPIC_API_KEY) return res.json({ error: "Agent not configured" });
  try {
    const result = await getAgentRescore(pos);
    if (!result) return res.json({ error: "Agent unavailable" });
    // Cache on position object so dashboard can show without re-fetching
    pos._liveRescore = { ...result, updatedAt: new Date().toISOString() };
    res.json(pos._liveRescore);
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ── SPY live data endpoint ────────────────────────────────────────────────
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

// Test options chain endpoint — verify Pro data access
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

app.post("/api/reset-month", async (req, res) => {
  state.cash=MONTHLY_BUDGET+state.extraBudget; state.todayTrades=0;
  state.monthStart=new Date().toLocaleDateString(); state.dayStartCash=state.cash;
  state.circuitOpen=true; state.weeklyCircuitOpen=true; state.monthlyProfit=0;
  logEvent("reset",`Month reset - cash: ${fmt(state.cash)}`); res.json({ok:true});
});
app.get("/api/journal",      (req,res) => res.json(state.tradeJournal.slice(0,50)));
app.get("/api/report",       (req,res) => res.json({report:buildMonthlyReport()}));

// - New Feature Endpoints -

// ── Earnings Play Engine ─────────────────────────────────────────────────
// Buy ATM straddle (call + put) 14-21 days before earnings when IV is still cheap
// Exit before earnings announcement to capture IV expansion (avoid IV crush)

const EARNINGS_PLAY_MIN_DTE  = 14;  // enter at least 14 days before earnings
const EARNINGS_PLAY_MAX_DTE  = 21;  // enter no more than 21 days before earnings
const EARNINGS_PLAY_MAX_IVR  = 45;  // only when options are still cheap
const EARNINGS_PLAY_EXIT_DTE = 2;   // exit 2 days before earnings

async function checkEarningsPlays() {
  // Straddle needs both legs — require full entry window (10AM+)
  if (!isEntryWindow("call")) return;
  if (heatPct() >= MAX_HEAT * 0.8) return; // need room for straddle (2 positions)
  if (!state.circuitOpen) return;

  for (const stock of WATCHLIST) {
    if (!stock.earningsDate) continue;

    const daysToEarnings = Math.round((new Date(stock.earningsDate) - new Date()) / MS_PER_DAY);

    // Only enter in the 14-21 day window
    if (daysToEarnings < EARNINGS_PLAY_MIN_DTE || daysToEarnings > EARNINGS_PLAY_MAX_DTE) continue;

    // Skip if IVR already elevated (options too expensive)
    if (stock.ivr > EARNINGS_PLAY_MAX_IVR) {
      logEvent("filter", `${stock.ticker} earnings play skip - IVR ${stock.ivr} too high (>${EARNINGS_PLAY_MAX_IVR})`);
      continue;
    }

    // Skip if already have any position in this ticker
    if (state.positions.find(p => p.ticker === stock.ticker)) continue;

    // Ensure enough cash for both legs
    if (state.cash <= CAPITAL_FLOOR * 1.5) continue;

    const price = await getStockQuote(stock.ticker);
    if (!price) continue;

    logEvent("scan", `${stock.ticker} EARNINGS PLAY detected - ${daysToEarnings} days to earnings | IVR:${stock.ivr}`);

    // Enter call leg — executeTrade handles contract selection internally
    const callStock = { ...stock, earningsDate: null };
    await executeTrade(callStock, price, 75, [`Earnings play call - ${daysToEarnings}d to earnings`], state.vix, "call");

    // Enter put leg
    const putStock = { ...stock, earningsDate: null };
    await executeTrade(putStock, price, 75, [`Earnings play put - ${daysToEarnings}d to earnings`], state.vix, "put");

    await new Promise(r => setTimeout(r, 500));
  }
}

// Check if any open earnings play positions need to exit (2 days before earnings)
async function manageEarningsPlayExits() {
  for (const pos of [...state.positions]) {
    if (!pos.earningsPlay) continue;

    const stock = WATCHLIST.find(s => s.ticker === pos.ticker);
    if (!stock || !stock.earningsDate) continue;

    const daysToEarnings = Math.round((new Date(stock.earningsDate) - new Date()) / MS_PER_DAY);

    if (daysToEarnings <= EARNINGS_PLAY_EXIT_DTE) {
      logEvent("scan", `${pos.ticker} earnings play exit - ${daysToEarnings} days to earnings - capturing IV expansion`);
      await closePosition(pos.ticker, "earnings-play-exit");
    }
  }
}

// ── Safe Reporting Metrics ───────────────────────────────────────────────

// Calmar Ratio — annualized return / max drawdown
function calcCalmarRatio() {
  const trades    = state.closedTrades || [];
  if (trades.length < 5) return 0;
  const totalPnL  = trades.reduce((s, t) => s + t.pnl, 0);
  const startDate = new Date(trades[trades.length-1]?.date || Date.now());
  const years     = Math.max(0.1, (Date.now() - startDate.getTime()) / (365 * MS_PER_DAY));
  const annReturn = (totalPnL / MONTHLY_BUDGET) / years * 100;
  const peak      = state.peakCash || MONTHLY_BUDGET;
  const maxDD     = Math.abs(Math.min(0, (state.cash - peak) / peak * 100));
  return maxDD > 0 ? parseFloat((annReturn / maxDD).toFixed(2)) : 0;
}

// Information Ratio — alpha / tracking error vs SPY
function calcInformationRatio() {
  const trades = state.closedTrades || [];
  if (trades.length < 5) return 0;
  const returns    = trades.map(t => (t.pct || 0) / 100);
  const spyDaily   = 0.0004; // approximate SPY daily return
  const alphas     = returns.map(r => r - spyDaily);
  const avgAlpha   = alphas.reduce((s, a) => s + a, 0) / alphas.length;
  const trackErr   = Math.sqrt(alphas.reduce((s, a) => s + Math.pow(a - avgAlpha, 2), 0) / alphas.length);
  return trackErr > 0 ? parseFloat((avgAlpha / trackErr).toFixed(2)) : 0;
}

// Drawdown Duration Analysis
function calcDrawdownDuration() {
  const trades = state.closedTrades || [];
  if (trades.length < 3) return { avgDuration: 0, maxDuration: 0, currentDuration: 0 };
  let inDrawdown    = false;
  let ddStart       = null;
  let durations     = [];
  let runningPnL    = 0;
  let peak          = 0;

  for (const trade of [...trades].reverse()) {
    runningPnL += trade.pnl || 0;
    if (runningPnL > peak) {
      if (inDrawdown && ddStart) {
        durations.push(Math.round((new Date(trade.date) - new Date(ddStart)) / MS_PER_DAY));
      }
      peak      = runningPnL;
      inDrawdown = false;
      ddStart    = null;
    } else if (runningPnL < peak && !inDrawdown) {
      inDrawdown = true;
      ddStart    = trade.date;
    }
  }

  const currentDuration = inDrawdown && ddStart
    ? Math.round((Date.now() - new Date(ddStart).getTime()) / MS_PER_DAY) : 0;

  return {
    avgDuration:     durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0,
    maxDuration:     durations.length ? Math.max(...durations) : 0,
    currentDuration,
    inDrawdown,
    count:           durations.length,
  };
}

// Autocorrelation of Returns — are wins/losses clustered?
function calcAutocorrelation() {
  const trades = state.closedTrades || [];
  if (trades.length < 10) return { value: 0, signal: "insufficient data" };
  const returns = trades.slice(0, 30).map(t => t.pnl || 0);
  const mean    = returns.reduce((s, r) => s + r, 0) / returns.length;
  let num = 0, den = 0;
  for (let i = 1; i < returns.length; i++) {
    num += (returns[i] - mean) * (returns[i-1] - mean);
    den += Math.pow(returns[i] - mean, 2);
  }
  const ac = den > 0 ? parseFloat((num / den).toFixed(3)) : 0;
  return {
    value:  ac,
    signal: ac > 0.2 ? "clustered (streaky)" : ac < -0.2 ? "mean-reverting" : "random",
  };
}

// Win/Loss Streak Tracking
function getStreakAnalysis() {
  const trades = state.closedTrades || [];
  if (!trades.length) return { currentStreak: 0, currentType: null, maxWinStreak: 0, maxLossStreak: 0 };
  let currentStreak = 1;
  let currentType   = trades[0].pnl > 0 ? "win" : "loss";
  let maxWin = 0, maxLoss = 0, tempStreak = 1;
  let tempType = currentType;

  for (let i = 1; i < trades.length; i++) {
    const type = trades[i].pnl > 0 ? "win" : "loss";
    if (type === tempType) {
      tempStreak++;
    } else {
      if (tempType === "win")  maxWin  = Math.max(maxWin,  tempStreak);
      if (tempType === "loss") maxLoss = Math.max(maxLoss, tempStreak);
      tempStreak = 1;
      tempType   = type;
    }
  }
  if (tempType === "win")  maxWin  = Math.max(maxWin,  tempStreak);
  if (tempType === "loss") maxLoss = Math.max(maxLoss, tempStreak);

  // Current streak from most recent trades
  let curr = 1;
  const currType = trades[0].pnl > 0 ? "win" : "loss";
  for (let i = 1; i < trades.length; i++) {
    if ((trades[i].pnl > 0 ? "win" : "loss") === currType) curr++;
    else break;
  }

  return { currentStreak: curr, currentType: currType, maxWinStreak: maxWin, maxLossStreak: maxLoss };
}

// Greeks Ladder — greeks at different price levels
function calcGreeksLadder(pos) {
  if (!pos) return [];
  const levels = [-0.15, -0.10, -0.05, 0, 0.05, 0.10, 0.15];
  return levels.map(pct => {
    const simPrice = pos.price * (1 + pct);
    const dte      = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
    const greeks   = calcGreeks(simPrice, pos.strike, dte, pos.iv || 0.3);
    const simPrem  = parseFloat((simPrice * (pos.iv||0.3) * Math.sqrt(dte/365) * 0.4 + 0.1).toFixed(2));
    return {
      priceMove: (pct * 100).toFixed(0) + "%",
      price:     simPrice.toFixed(2),
      premium:   simPrem,
      pnl:       parseFloat(((simPrem - pos.premium) * 100 * pos.contracts).toFixed(2)),
      delta:     greeks.delta,
      gamma:     greeks.gamma,
    };
  });
}

// Risk of Ruin
function calcRiskOfRuin() {
  const trades  = state.closedTrades || [];
  if (trades.length < 10) return { probability: 0, message: "Insufficient data" };
  const wins    = trades.filter(t => t.pnl > 0);
  const losses  = trades.filter(t => t.pnl <= 0);
  const winRate = wins.length / trades.length;
  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  const edge    = winRate * avgWin - (1 - winRate) * avgLoss;
  const riskPct = avgLoss / (state.cash || MONTHLY_BUDGET);
  // Simplified risk of ruin formula
  if (edge <= 0) return { probability: 99, message: "Negative edge — high ruin risk" };
  const ror = Math.pow((1 - winRate) / winRate, (state.cash || MONTHLY_BUDGET) / avgLoss);
  return {
    probability: parseFloat(Math.min(99, ror * 100).toFixed(1)),
    edge:        parseFloat(edge.toFixed(2)),
    message:     ror < 0.01 ? "Very low ruin risk" : ror < 0.05 ? "Low ruin risk" : ror < 0.15 ? "Moderate ruin risk" : "High ruin risk",
  };
}

// Expected Move Calculation
// The options market's implied expected move = stock price * IV * sqrt(DTE/365)
function calcExpectedMove(ticker, price, iv, dte) {
  const expectedMove = price * iv * Math.sqrt(dte / 365);
  return {
    ticker,
    price:        parseFloat(price.toFixed(2)),
    oneSigmaUp:   parseFloat((price + expectedMove).toFixed(2)),
    oneSigmaDown: parseFloat((price - expectedMove).toFixed(2)),
    expectedMovePct: parseFloat((expectedMove / price * 100).toFixed(1)),
    dte,
  };
}

// Global Market Correlation — overnight futures as pre-market signal
async function getGlobalMarketSignal() {
  try {
    // Use overnight price change in broad ETFs as proxy
    // QQQ and SPY pre-market signal via their overnight moves
    const [qqqBars, iwmBars, eemBars] = await Promise.all([
      getStockBars("QQQ", 3),
      getStockBars("IWM", 3), // Russell 2000 - risk appetite
      getStockBars("EEM", 3), // Emerging markets - global risk
    ]);

    const signals = [];
    const getChg = bars => bars.length >= 2 ? (bars[bars.length-1].c - bars[bars.length-2].c) / bars[bars.length-2].c * 100 : 0;

    const qqqChg = getChg(qqqBars);
    const iwmChg = getChg(iwmBars);
    const eemChg = getChg(eemBars);

    // If small caps (IWM) and emerging markets (EEM) moving together with QQQ = broad risk-on
    const avgChg = (qqqChg + iwmChg + eemChg) / 3;
    const signal = avgChg > 0.5 ? "risk-on" : avgChg < -0.5 ? "risk-off" : "neutral";
    const modifier = avgChg > 1 ? 8 : avgChg > 0.5 ? 4 : avgChg < -1 ? -8 : avgChg < -0.5 ? -4 : 0;

    return { signal, modifier, qqqChg: parseFloat(qqqChg.toFixed(2)), iwmChg: parseFloat(iwmChg.toFixed(2)), eemChg: parseFloat(eemChg.toFixed(2)), avgChg: parseFloat(avgChg.toFixed(2)) };
  } catch(e) { return { signal: "neutral", modifier: 0, qqqChg: 0, iwmChg: 0, eemChg: 0, avgChg: 0 }; }
}

// Anomaly Detection — flag unusual price movements before acting
function detectPriceAnomaly(bars) {
  if (!bars || bars.length < 20) return { anomaly: false, reason: null };
  const closes  = bars.map(b => b.c);
  const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const mean    = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stdDev  = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length);
  const latest  = returns[returns.length - 1];
  const zScore  = stdDev > 0 ? (latest - mean) / stdDev : 0;

  if (Math.abs(zScore) > 3) {
    return { anomaly: true, reason: `${zScore > 0 ? "Unusual spike" : "Unusual drop"} — ${Math.abs(zScore).toFixed(1)} std devs from mean`, zScore };
  }
  return { anomaly: false, zScore: parseFloat(zScore.toFixed(2)) };
}

// ── Simulation Engine ─────────────────────────────────────────────────────
let simRunning  = false;
let simLog      = [];
let simState    = null;
let simInterval = null;

function simLogEvent(type, message) {
  const entry = { time: new Date().toISOString(), type, message };
  simLog.unshift(entry);
  if (simLog.length > 200) simLog = simLog.slice(0, 200);
  console.log(`[SIM:${type.toUpperCase()}] ${message}`);
}

function simNextPrice(currentPrice, scenario) {
  const params = {
    bull_run:   { drift:  0.004,  vol: 0.022 },  // strong uptrend, moderate vol
    bear_crash: { drift: -0.006,  vol: 0.038 },  // sustained selling, high vol
    choppy:     { drift:  0.000,  vol: 0.018 },  // no direction, enough noise to trigger stops
    recovery:   { drift:  0.003,  vol: 0.028 },  // bounce with whipsaw vol
    black_swan: { drift: -0.025,  vol: 0.065 },  // violent crash
    normal:     { drift:  0.001,  vol: 0.022 },  // realistic intraday movement
  }[scenario] || { drift: 0.001, vol: 0.022 };
  const u1 = Math.random(), u2 = Math.random();
  const z  = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return parseFloat((currentPrice * (1 + params.drift + params.vol * z)).toFixed(2));
}

function simNextVIX(scenario, currentVIX) {
  const targets = { bull_run: 12, bear_crash: 45, choppy: 22, recovery: 28, black_swan: 65, normal: 18 };
  const target  = targets[scenario] || 18;
  const move    = (target - currentVIX) * 0.1 + (Math.random() - 0.5) * 2;
  return Math.max(8, Math.min(80, parseFloat((currentVIX + move).toFixed(1))));
}

async function runSimTick(scenario, simPrices, tick) {
  for (const ticker of Object.keys(simPrices)) {
    simPrices[ticker] = simNextPrice(simPrices[ticker], scenario);
  }
  simState.vix = simNextVIX(scenario, simState.vix);

  // Manage positions
  for (const pos of [...simState.positions]) {
    const price = simPrices[pos.ticker];
    if (!price) continue;
    // Each tick = ~half trading day for meaningful option aging
    const daysElapsed = Math.floor(tick / 4);
    const dte        = Math.max(1, pos.expiryDays - daysElapsed);
    const timeValue  = parseFloat((price * pos.iv * Math.sqrt(dte / 365) * 0.4 + 0.1).toFixed(2));
    // Add intrinsic value — the real driver of option profit in directional moves
    const intrinsic  = pos.optionType === "put"
      ? Math.max(0, pos.strike - price)   // put intrinsic: strike - stock price
      : Math.max(0, price - pos.strike);  // call intrinsic: stock price - strike
    const curP       = parseFloat((timeValue + intrinsic).toFixed(2));
    const chg  = (curP - pos.premium) / pos.premium;
    const hrs  = tick * 4; // each tick ~ 4 hours
    pos.currentPrice = curP;
    pos.price        = price;
    if (curP > pos.peakPremium) pos.peakPremium = curP;

    let exitReason = null;

    // Update trailing stop — activates at +30%, trails 15% below peak
    if (chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT)) {
      const simTrail = pos.peakPremium * (1 - TRAIL_STOP_PCT);
      pos.trailStop  = simTrail; // $ floor value — sim uses separate calculation
      if (curP <= simTrail) exitReason = "trail";
    }

    if (!exitReason) {
      if (chg <= -STOP_LOSS_PCT)                                                exitReason = "stop";
      else if (hrs <= 48 && chg <= -FAST_STOP_PCT)                             exitReason = "fast-stop";
      else if (hrs <= 48 && chg >= 0.40)                                       exitReason = "fast-profit";
      else if (chg >= TAKE_PROFIT_PCT)                                          exitReason = "target";
      else if (hrs >= TIME_STOP_DAYS * 24 && Math.abs(chg) < TIME_STOP_MOVE)  exitReason = "time-stop";
    }

    if (exitReason) {
      const pnl = parseFloat(((curP - pos.premium) * 100 * pos.contracts).toFixed(2));
      simState.cash += pos.cost + pnl;
      simState.positions.splice(simState.positions.indexOf(pos), 1);
      simState.closedTrades.push({ ticker: pos.ticker, pnl, pct: chg * 100, reason: exitReason, date: new Date().toISOString() });
      // Record cooldown on stops to prevent immediate re-entry
      if (exitReason === "stop" || exitReason === "fast-stop") {
        simState.recentStops[pos.ticker] = tick;
      }
      simLogEvent("trade", `CLOSE ${pos.ticker} ${pos.optionType?.toUpperCase()} | ${exitReason} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(chg*100).toFixed(1)}%)`);
    }
  }

  // Circuit breaker
  const portfolio = simState.cash + simState.positions.reduce((s, p) => s + p.cost, 0);
  const dailyPnL  = portfolio - (simState.dayStartCash || MONTHLY_BUDGET);
  if (dailyPnL / MONTHLY_BUDGET <= -0.15 && simState.circuitOpen) {
    simState.circuitOpen = false;
    simLogEvent("circuit", `CIRCUIT BREAKER TRIPPED - loss ${fmt(Math.abs(dailyPnL))}`);
  }

  if (simState.vix > 35) { simLogEvent("warn", `VIX ${simState.vix} - pausing new entries`); }

  // New entries
  const heat = simState.positions.reduce((s, p) => s + p.cost, 0) / MONTHLY_BUDGET;
  if (heat < MAX_HEAT && simState.cash > CAPITAL_FLOOR && simState.circuitOpen && simState.vix <= 35 && simState.positions.length < 4) {
    const scenarioRSI  = scenario === "bull_run" ? 58 : scenario === "bear_crash" ? 38 : 52;
    const scenarioMACD = scenario === "bull_run" ? "bullish" : scenario === "bear_crash" ? "bearish crossover" : "neutral";

    for (const stock of WATCHLIST.slice(0, 8)) {
      if (simState.positions.find(p => p.ticker === stock.ticker)) continue;
      if (simState.positions.length >= 4) break;
      // 10 tick cooldown after a stop on this ticker
      const lastStop = (simState.recentStops || {})[stock.ticker];
      if (lastStop && tick - lastStop < 10) continue;
      const price    = simPrices[stock.ticker];
      if (!price) continue;
      const simStock = { ...stock, rsi: scenarioRSI + (Math.random() - 0.5) * 10, macd: scenarioMACD };
      const callS    = scoreSetup(simStock, 1.02, 22, 1200000, 900000);
      const putS     = scorePutSetup(simStock, 0.98, 22, 1200000, 900000);
      const best     = Math.max(callS.score, putS.score);
      const optType  = putS.score > callS.score ? "put" : "call";
      // Use lower threshold in sim so trades fire — real threshold applies in live trading
      if (best < 60) continue;
      const iv       = 0.25 + stock.ivr * 0.003;
      const premium  = parseFloat((price * iv * Math.sqrt(30 / 365) * 0.4 + 0.3).toFixed(2));
      const contr    = Math.max(1, Math.floor((simState.cash * 0.08) / (premium * 100)));
      const cost     = parseFloat((premium * 100 * contr).toFixed(2));
      if (cost > simState.cash - CAPITAL_FLOOR) continue;
      simState.cash -= cost;
      // Scenario-aware strike selection
      // Bull run = closer to money (1-2% OTM) so price movement helps faster
      // Bear crash = slightly deeper OTM puts for leverage
      // Normal/choppy = standard 3-4% OTM
      const simOTM = scenario === "bull_run" ? 0.015 : scenario === "bear_crash" ? 0.025 : scenario === "black_swan" ? 0.02 : 0.035;
      const strike = optType === "put"
        ? Math.round(price * (1 - simOTM) / 5) * 5
        : Math.round(price * (1 + simOTM) / 5) * 5;
      simState.positions.push({
        ticker: stock.ticker, sector: stock.sector, optionType: optType,
        premium, contracts: contr, cost, iv, expiryDays: 30,
        strike,
        expDate: new Date(Date.now() + 30 * MS_PER_DAY).toLocaleDateString(),
        peakPremium: premium, partialClosed: false,
        openDate: new Date().toISOString(), score: best,
        greeks: calcGreeks(price, strike, 30, iv),
        price, currentPrice: premium, beta: stock.beta || 1,
      });
      simLogEvent("trade", `BUY ${stock.ticker} $${strike}${optType === "put" ? "P" : "C"} | ${contr}x @ $${premium} | score ${best} | cash ${fmt(simState.cash)}`);
    }
  }

  // Log a sample stock price every 10 ticks so we can see market movement
  if (tick % 10 === 0) {
    const spyPrice  = simPrices["SPY"]  || 0;
    const nvdaPrice = simPrices["NVDA"] || 0;
    simLogEvent("scan", `Tick ${tick} | SPY:$${spyPrice.toFixed(0)} NVDA:$${nvdaPrice.toFixed(0)} | VIX:${simState.vix} | Cash:${fmt(simState.cash)} | Pos:${simState.positions.length} | Heat:${(heat*100).toFixed(0)}%`);
  } else {
    simLogEvent("scan", `Tick ${tick} | VIX:${simState.vix} | Cash:${fmt(simState.cash)} | Pos:${simState.positions.length} | Heat:${(heat*100).toFixed(0)}%`);
  }
}

const SIM_BASE_PRICES = { NVDA:875, AAPL:195, MSFT:415, AMZN:185, META:505, GOOGL:172, TSLA:175, AMD:165, SPY:505, QQQ:438, JPM:205, GS:465, NFLX:615, CRM:285, UBER:75, ARM:115, COIN:185, SMCI:45 };

function startSimulation(scenario = "normal", speed = "normal") {
  if (simRunning) return { error: "Simulation already running" };
  simRunning = true;
  simLog     = [];
  simState   = { cash: MONTHLY_BUDGET, positions: [], closedTrades: [], vix: 18, circuitOpen: true, weeklyCircuitOpen: true, consecutiveLosses: 0, dayStartCash: MONTHLY_BUDGET, recentStops: {} };

  const simPrices = {};
  for (const stock of WATCHLIST) simPrices[stock.ticker] = SIM_BASE_PRICES[stock.ticker] || 100;
  simPrices["SPY"] = SIM_BASE_PRICES["SPY"];

  const intervalMs = speed === "fast" ? 150 : speed === "slow" ? 1500 : 400;
  const maxTicks   = speed === "fast" ? 120 : speed === "slow" ? 80   : 100;
  let tick         = 0;

  simLogEvent("scan", `=== SIMULATION START === Scenario:${scenario} | Speed:${speed} | Ticks:${maxTicks}`);

  simInterval = setInterval(async () => {
    if (tick >= maxTicks || !simRunning) {
      clearInterval(simInterval);
      simRunning = false;
      const trades = simState.closedTrades || [];
      const wins   = trades.filter(t => t.pnl > 0);
      const pnl    = parseFloat((simState.cash - MONTHLY_BUDGET).toFixed(2));
      simLogEvent("scan", `=== SIMULATION COMPLETE ===`);
      simLogEvent("scan", `Trades:${trades.length} | Wins:${wins.length} | WR:${trades.length ? Math.round(wins.length/trades.length*100) : 0}% | P&L:${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
      simLogEvent("scan", `Open at close:${simState.positions.length} | Final cash:${fmt(simState.cash)}`);
      return;
    }
    await runSimTick(scenario, simPrices, tick);
    tick++;
  }, intervalMs);

  return { ok: true, scenario, speed, maxTicks };
}

function stopSimulation() {
  if (simInterval) clearInterval(simInterval);
  simRunning = false;
  simLogEvent("scan", "Simulation stopped manually");
  return { ok: true };
}

app.post("/api/sim/start", (req, res) => {
  const { scenario = "normal", speed = "normal" } = req.body || {};
  res.json(startSimulation(scenario, speed));
});

app.post("/api/sim/stop", (req, res) => res.json(stopSimulation()));

app.get("/api/sim/status", (req, res) => {
  const trades = simState?.closedTrades || [];
  const wins   = trades.filter(t => t.pnl > 0);
  res.json({
    running:     simRunning,
    log:         simLog.slice(0, 50),
    cash:        simState?.cash || MONTHLY_BUDGET,
    positions:   simState?.positions || [],
    closedTrades:trades,
    totalPnL:    simState ? parseFloat((simState.cash - MONTHLY_BUDGET).toFixed(2)) : 0,
    trades:      trades.length,
    wins:        wins.length,
    winRate:     trades.length ? Math.round(wins.length / trades.length * 100) : 0,
    vix:         simState?.vix || 0,
    circuitOpen: simState?.circuitOpen ?? true,
  });
});

// -- Backtesting Engine --
async function runBacktest(months = 6) {
  logEvent("scan", `Backtest started - ${months} months of historical data`);
  const results = {
    trades:      [],
    monthlyPnL:  {},
    byTicker:    {},
    startCash:   MONTHLY_BUDGET,
    endCash:     MONTHLY_BUDGET,
    peakCash:    MONTHLY_BUDGET,
    maxDrawdown: 0,
    startDate:   null,
    endDate:     null,
  };

  try {
    const limit   = months * 22;
    // Always use date range for backtest — confirmed working with Pro tier
    const end   = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - Math.ceil(limit * 1.6) * MS_PER_DAY).toISOString().split("T")[0];

    logEvent("scan", `Backtest fetching ${months} months (${limit} bars) from ${start} to ${end}`);

    async function fetchBarsForBacktest(ticker) {
      const data = await alpacaGet(
        `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&feed=sip`,
        ALPACA_DATA
      );
      if (data && data.bars && data.bars.length > 1) return data.bars;
      // Fallback to iex
      const data2 = await alpacaGet(
        `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&feed=iex`,
        ALPACA_DATA
      );
      return data2 && data2.bars ? data2.bars : [];
    }

    const allBars = {};
    for (const stock of WATCHLIST) {
      const bars = await fetchBarsForBacktest(stock.ticker);
      if (bars.length > 10) allBars[stock.ticker] = bars;
      logEvent("scan", `Backtest bars: ${stock.ticker} → ${bars.length} bars`);
      await new Promise(r => setTimeout(r, 300));
    }

    const spyBars = await fetchBarsForBacktest("SPY");
    if (!spyBars.length) throw new Error("Could not fetch SPY bars");
    logEvent("scan", `Backtest SPY bars: ${spyBars.length}`);

    const minLen = Math.min(...Object.values(allBars).map(b => b.length), spyBars.length);
    if (minLen < 20) throw new Error("Not enough historical data");

    results.startDate = allBars[WATCHLIST[0].ticker]?.[0]?.t?.split("T")[0] || "unknown";
    results.endDate   = allBars[WATCHLIST[0].ticker]?.slice(-1)[0]?.t?.split("T")[0] || "unknown";

    let cash            = MONTHLY_BUDGET;
    let peakCash        = MONTHLY_BUDGET;
    const openPositions = [];

    for (let dayIdx = 20; dayIdx < minLen; dayIdx++) {
      const spySlice  = spyBars.slice(0, dayIdx);
      const spyReturn = spySlice.length >= 5
        ? (spySlice[spySlice.length-1].c - spySlice[0].c) / spySlice[0].c : 0;
      const currentDate = spyBars[dayIdx]?.t?.split("T")[0] || "";

      // Manage open positions
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos      = openPositions[i];
        const bars     = allBars[pos.ticker];
        if (!bars || dayIdx >= bars.length) continue;
        const curPrice = bars[dayIdx].c;
        const dte      = Math.max(1, pos.expDays - (dayIdx - pos.entryDay));
        const timeVal  = parseFloat((curPrice * pos.iv * Math.sqrt(dte / 365) * 0.4 + 0.1).toFixed(2));
        const intrinsic = pos.optionType === "put"
          ? Math.max(0, (pos.strike || curPrice * 0.97) - curPrice)
          : Math.max(0, curPrice - (pos.strike || curPrice * 1.035));
        const curP     = parseFloat((timeVal + intrinsic).toFixed(2));
        const chg      = (curP - pos.premium) / pos.premium;
        const daysOpen = dayIdx - pos.entryDay;
        let exitReason = null;

        if (chg <= -STOP_LOSS_PCT)                                         exitReason = "stop";
        else if (daysOpen <= 2 && chg <= -FAST_STOP_PCT)                  exitReason = "fast-stop";
        else if (daysOpen <= 2 && chg >= 0.40)                            exitReason = "fast-profit";
        else if (chg >= TAKE_PROFIT_PCT)                                   exitReason = "target";
        else if (daysOpen >= TIME_STOP_DAYS && Math.abs(chg) < TIME_STOP_MOVE) exitReason = "time-stop";
        else if (dte <= 5)                                                 exitReason = "expiry";

        if (exitReason) {
          const pnl    = parseFloat(((curP - pos.premium) * 100 * pos.contracts).toFixed(2));
          cash        += pos.cost + pnl;
          peakCash     = Math.max(peakCash, cash);
          const dd     = (cash - peakCash) / peakCash * 100;
          results.maxDrawdown = Math.min(results.maxDrawdown, dd);
          const month  = currentDate.slice(0, 7);
          results.monthlyPnL[month] = (results.monthlyPnL[month] || 0) + pnl;
          if (!results.byTicker[pos.ticker]) results.byTicker[pos.ticker] = { wins:0, losses:0, pnl:0, trades:0 };
          results.byTicker[pos.ticker].trades++;
          results.byTicker[pos.ticker].pnl += pnl;
          if (pnl > 0) results.byTicker[pos.ticker].wins++;
          else results.byTicker[pos.ticker].losses++;
          results.trades.push({
            ticker: pos.ticker, optionType: pos.optionType,
            entry: pos.premium, exit: curP, pnl,
            pct: parseFloat((chg * 100).toFixed(1)),
            daysHeld: daysOpen, reason: exitReason,
            date: currentDate, score: pos.score,
          });
          openPositions.splice(i, 1);
        }
      }

      // New entries
      const heat = openPositions.reduce((s, p) => s + p.cost, 0) / totalCap();
      if (heat >= MAX_HEAT || cash <= CAPITAL_FLOOR || openPositions.length >= 5) continue;

      for (const stock of WATCHLIST) {
        const bars = allBars[stock.ticker];
        if (!bars || dayIdx >= bars.length) continue;
        if (openPositions.find(p => p.ticker === stock.ticker)) continue;

        const slice     = bars.slice(0, dayIdx + 1);
        const price     = bars[dayIdx].c;
        const stockRet  = slice.length >= 5 ? (slice[slice.length-1].c - slice[0].c) / slice[0].c : 0;
        const relStr    = spyReturn !== 0 ? (1 + stockRet) / (1 + spyReturn) : 1;

        // Fully dynamic signals from historical bars
        const rsi       = calcRSI(slice);
        const macdData  = calcMACD(slice);
        const momentum  = calcMomentum(slice);
        const adx       = calcADX(slice);
        const avgVol    = slice.slice(-20).reduce((s, b) => s + b.v, 0) / Math.min(20, slice.length);
        const todayVol  = slice[slice.length-1].v;

        // Dynamic IV from historical price action (not hardcoded IVR)
        const recentSlice = slice.slice(-20);
        const returns     = recentSlice.slice(1).map((b, i) => Math.log(b.c / recentSlice[i].c));
        const stdDev      = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) : 0.01;
        const dynamicIV   = Math.max(0.15, Math.min(1.5, stdDev * Math.sqrt(252)));

        // Dynamic IVR from historical volatility rank
        const dynamicIVR  = calcIVRank(dynamicIV, slice);

        // Gap check
        if (slice.length >= 2) {
          const gap = Math.abs(slice[slice.length-1].o - slice[slice.length-2].c) / slice[slice.length-2].c;
          if (gap > MAX_GAP_PCT) continue;
        }

        // Weakness detection for puts — price below 20-day moving average
        const ma20 = slice.length >= 20 ? slice.slice(-20).reduce((s, b) => s + b.c, 0) / 20 : price;
        const belowMA20 = price < ma20 * 0.98;
        const weeklyReturn = slice.length >= 5 ? (price - slice[slice.length-5].c) / slice[slice.length-5].c : 0;
        const isWeakDay   = weeklyReturn < -0.02; // down 2%+ this week

        const liveStock = { ...stock, rsi, macd: macdData.signal, momentum, ivr: dynamicIVR };
        const callSetup = scoreSetup(liveStock, relStr, adx, todayVol, avgVol);
        const putSetup  = scorePutSetup(liveStock, relStr, adx, todayVol, avgVol);

        // Apply weakness boost to puts in backtest
        if (belowMA20)  { putSetup.score = Math.min(100, putSetup.score + 12); }
        if (isWeakDay)  { putSetup.score = Math.min(100, putSetup.score + 10); }
        if (spyReturn < -0.01) { putSetup.score = Math.min(100, putSetup.score + 10); } // broad market down

        // Apply trend penalty to calls when market is declining
        if (spyReturn < -0.02) { callSetup.score = Math.max(0, callSetup.score - 15); }
        if (belowMA20)  { callSetup.score = Math.max(0, callSetup.score - 10); }

        const bestScore  = Math.max(callSetup.score, putSetup.score);
        const optionType = putSetup.score > callSetup.score ? "put" : "call";
        if (bestScore < MIN_SCORE) continue;

        // Use dynamic IV for premium calculation
        const expDays   = optionType === "put" ? 35 : 30; // puts get slightly more time
        const otmPct    = optionType === "put" ? 0.03 : (momentum === "strong" ? 0.035 : 0.045);
        const strike    = optionType === "put"
          ? Math.round(price * (1 - otmPct) / 5) * 5
          : Math.round(price * (1 + otmPct) / 5) * 5;
        const premium   = parseFloat((price * dynamicIV * Math.sqrt(expDays / 365) * 0.4 + 0.3).toFixed(2));
        const contracts = Math.max(1, Math.floor((cash * 0.10) / (premium * 100)));
        const cost      = parseFloat((premium * 100 * contracts).toFixed(2));
        if (cost > cash - CAPITAL_FLOOR) continue;
        cash -= cost;
        openPositions.push({
          ticker: stock.ticker, optionType, premium, contracts, cost,
          iv: dynamicIV, expDays, entryDay: dayIdx, score: bestScore, strike,
        });
        if (openPositions.length >= 3) break;
      }
    }

    // Close remaining positions at breakeven
    for (const pos of openPositions) cash += pos.cost;
    results.endCash     = cash;
    results.peakCash    = peakCash;
    results.maxDrawdown = parseFloat(results.maxDrawdown.toFixed(2));

    const wins    = results.trades.filter(t => t.pnl > 0);
    const losses  = results.trades.filter(t => t.pnl <= 0);
    const grossW  = wins.reduce((s, t) => s + t.pnl, 0);
    const grossL  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    results.summary = {
      totalTrades:  results.trades.length,
      wins:         wins.length,
      losses:       losses.length,
      winRate:      results.trades.length ? parseFloat((wins.length / results.trades.length * 100).toFixed(1)) : 0,
      totalPnL:     parseFloat((results.endCash - results.startCash).toFixed(2)),
      totalReturn:  parseFloat(((results.endCash - results.startCash) / results.startCash * 100).toFixed(1)),
      profitFactor: grossL > 0 ? parseFloat((grossW / grossL).toFixed(2)) : 0,
      avgWin:       wins.length   ? parseFloat((grossW / wins.length).toFixed(2))   : 0,
      avgLoss:      losses.length ? parseFloat((grossL / losses.length).toFixed(2)) : 0,
      maxDrawdown:  results.maxDrawdown,
      callTrades:   results.trades.filter(t => t.optionType === "call").length,
      putTrades:    results.trades.filter(t => t.optionType === "put").length,
      startDate:    results.startDate,
      endDate:      results.endDate,
      months,
    };

    logEvent("scan", `Backtest complete: ${results.summary.totalTrades} trades | ${results.summary.winRate}% WR | ${results.summary.totalReturn}% return | PF:${results.summary.profitFactor}`);
    return results;

  } catch(e) {
    logEvent("error", `Backtest failed: ${e.message}`);
    return { error: e.message, trades: [], summary: null };
  }
}

app.get("/api/backtest", async (req, res) => {
  const months = Math.min(parseInt(req.query.months || "6"), 12);
  const results = await runBacktest(months);
  res.json(results);
});

// Test historical bars access
app.get("/api/test-bars/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const months = parseInt(req.query.months || "3");
  const limit  = months * 22;
  const end    = new Date().toISOString().split("T")[0];
  const start  = new Date(Date.now() - limit * 1.6 * MS_PER_DAY).toISOString().split("T")[0];

  const results = {};
  const tests = [
    { name: "sip_feed",    url: `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&feed=sip` },
    { name: "iex_feed",    url: `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&feed=iex` },
    { name: "no_feed",     url: `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}` },
    { name: "simple",      url: `/stocks/${ticker}/bars?timeframe=1Day&limit=10` },
  ];

  for (const test of tests) {
    const data = await alpacaGet(test.url, ALPACA_DATA);
    results[test.name] = {
      barsReturned: data?.bars?.length || 0,
      firstBar:     data?.bars?.[0] || null,
      lastBar:      data?.bars?.[data?.bars?.length-1] || null,
      error:        data?.message || null,
    };
  }

  res.json({ ticker, start, end, limit, results });
});

app.get("/api/attribution",  (req,res) => res.json({
  byTicker:     getPnLByTicker(),
  bySector:     getPnLBySector(),
  byScoreRange: getPnLByScoreRange(),
}));

app.get("/api/taxlog",       (req,res) => res.json(getTaxLog()));

app.get("/api/theta",        (req,res) => {
  const positions = state.positions.map(pos => {
    const dte      = Math.max(1, Math.round((new Date(pos.expDate)-new Date())/MS_PER_DAY));
    const theta    = pos.greeks ? pos.greeks.theta : -(pos.premium / (dte * 2));
    const dailyBurn= Math.abs(theta) * 100 * (pos.contracts || 1) * (pos.partialClosed ? 0.5 : 1);
    return { ticker: pos.ticker, theta: parseFloat(theta.toFixed(4)), dailyBurn: parseFloat(dailyBurn.toFixed(2)), dte };
  });
  const totalBurn = positions.reduce((s,p) => s + p.dailyBurn, 0);
  res.json({ positions, totalDailyBurn: parseFloat(totalBurn.toFixed(2)) });
});

app.get("/api/correlation",  (req,res) => {
  const held     = state.positions.map(p => p.ticker);
  const groups   = CORRELATION_GROUPS.map(g => ({
    group: g,
    held:  g.filter(t => held.includes(t)),
  })).filter(g => g.held.length > 0);
  res.json({ groups, heldTickers: held });
});

app.get("/api/etf", (req,res) => res.json({
  ticker:     CASH_ETF,
  shares:     state.cashETFShares || 0,
  value:      parseFloat((state.cashETFValue || 0).toFixed(2)),
  price:      state.cashETFPrice || 91,
  allocation: `${CASH_ETF_ALLOC*100}% of idle cash`,
  liquidCash: parseFloat(state.cash.toFixed(2)),
  deployable: parseFloat(getDeployableCash().toFixed(2)),
}));

app.get("/api/drawdown",     (req,res) => {
  const peak    = state.peakCash || MONTHLY_BUDGET;
  const current = state.cash + openRisk();
  const dd      = ((current - peak) / peak) * 100;
  res.json({
    peakCash:       parseFloat(peak.toFixed(2)),
    currentValue:   parseFloat(current.toFixed(2)),
    drawdownPct:    parseFloat(dd.toFixed(2)),
    recoveryMode:   isDrawdownRecovery(),
    sizingReduction: isDrawdownRecovery() ? `${DRAWDOWN_SIZING_REDUCE*100}%` : "None",
  });
});
app.post("/api/set-budget", async (req, res) => {
  const { budget } = req.body;
  const amount = parseFloat(budget);
  if (!amount || amount < 100 || amount > 1000000) { res.status(400).json({error:"Invalid budget"}); return; }
  // Save the custom budget to state so it survives restarts and resets
  state.customBudget   = amount;
  state.cash           = parseFloat(amount.toFixed(2));
  state.dayStartCash   = state.cash;
  state.weekStartCash  = state.cash;
  state.peakCash       = Math.max(state.peakCash || 0, state.cash);
  logEvent("reset", `Budget updated to ${fmt(amount)}`);
  await saveStateNow();
  res.json({ok:true, cash:state.cash});
});
app.get("/health",           (req,res) => res.json({status:"ok",uptime:process.uptime(),vix:state.vix,positions:state.positions.length}));

// ── F14: Ticker blacklist endpoints ─────────────────────────────────────
app.post("/api/blacklist/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  if (!state.tickerBlacklist) state.tickerBlacklist = [];
  if (!state.tickerBlacklist.includes(ticker)) {
    state.tickerBlacklist.push(ticker);
    logEvent("filter", `${ticker} manually blacklisted for today`);
    await saveStateNow();
  }
  res.json({ ok: true, blacklist: state.tickerBlacklist });
});
app.delete("/api/blacklist/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  state.tickerBlacklist = (state.tickerBlacklist || []).filter(t => t !== ticker);
  logEvent("filter", `${ticker} removed from blacklist`);
  await saveStateNow();
  res.json({ ok: true, blacklist: state.tickerBlacklist });
});
app.get("/api/blacklist", (req, res) => {
  res.json({ blacklist: state.tickerBlacklist || [] });
});

// Redis round-trip test — write a known value, read it back, confirm they match
// Hit this endpoint after deploy to verify persistence is working before live trading
app.get("/api/test-redis", async (req, res) => {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.json({ ok: false, error: "Redis not configured — check UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars" });
  }
  const testKey   = "apex:redis-test";
  const testValue = { ts: Date.now(), msg: "apex-redis-ok" };
  try {
    // Write test value
    const writeRes = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["set", testKey, JSON.stringify(testValue)]])
    });
    const writeData = await writeRes.json();
    if (!writeData[0] || writeData[0].error) {
      return res.json({ ok: false, stage: "write", error: writeData[0]?.error || "unknown write error" });
    }

    // Read it back
    const readRes = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["get", testKey]])
    });
    const readData = await readRes.json();
    if (!readData[0] || readData[0].error) {
      return res.json({ ok: false, stage: "read", error: readData[0]?.error || "unknown read error" });
    }

    // Confirm match
    const readBack = JSON.parse(readData[0].result);
    const match    = readBack && readBack.ts === testValue.ts && readBack.msg === testValue.msg;

    // Also check actual state key exists
    const stateRes  = await fetch(`${REDIS_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([["exists", REDIS_KEY]])
    });
    const stateData = await stateRes.json();
    const stateExists = stateData[0]?.result === 1;

    res.json({
      ok:          match,
      write:       writeData[0]?.result === "OK" ? "OK" : "FAIL",
      read:        match ? "OK" : "MISMATCH",
      stateKey:    stateExists ? "EXISTS" : "MISSING — state not yet saved",
      stateCash:   state.cash,
      statePos:    state.positions.length,
      lastSave:    lastRedisSave ? new Date(lastRedisSave).toISOString() : "never",
      message:     match && stateExists ? "Redis is working correctly" : match ? "Redis works but state key missing — trigger a save first" : "Redis round-trip FAILED",
    });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GRACEFUL SHUTDOWN — save state before Railway kills the container ──────
// Railway sends SIGTERM before terminating — we have ~10 seconds to clean up
// This ensures state is persisted even mid-deploy, preventing data loss
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} received — saving state before exit`);

  // Stop accepting new scans
  scanRunning = true; // prevents new scan from starting

  // Save state with retries — most critical operation on shutdown
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
    console.error("[SHUTDOWN] CRITICAL: Could not save state to Redis — positions may be lost on restart");
  }

  console.log("[SHUTDOWN] Complete — exiting");
  process.exit(0);
}

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM")); // Railway deploy
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));  // Ctrl+C / manual stop
process.on("SIGHUP",  () => gracefulShutdown("SIGHUP"));  // Terminal hangup

// Unhandled rejection safety net — log but don't crash
process.on("unhandledRejection", (reason, promise) => {
  console.error("[ERROR] Unhandled rejection:", reason?.message || reason);
  // Don't exit — log and continue
});

// Boot sequence - load state from Redis then start server
initState().then(() => {
  app.listen(PORT, () => {
    console.log(`APEX v3.95 running on port ${PORT}`);
    console.log(`Alpaca key:  ${ALPACA_KEY?"SET":"NOT SET"}`);
    console.log(`Gmail:       ${GMAIL_USER||"NOT SET"}`);
    console.log(`Resend:      ${RESEND_API_KEY?"SET ✅":"NOT SET — email disabled"}`);
    console.log(`Marketaux:   ${process.env.MARKETAUX_KEY?"SET ✅":"NOT SET — add key for credible source news"}`);
    console.log(`Claude Agent:${ANTHROPIC_API_KEY?"SET ✅ — AI macro analysis + rescore enabled":"NOT SET — using keyword fallback"}`);
    console.log(`Redis:       ${REDIS_URL?"SET":"NOT SET - using file fallback"}`);
    console.log(`Budget:      $${state.cash} | Floor: $${CAPITAL_FLOOR}`);
    console.log(`Positions:   ${state.positions.length} open`);
    console.log(`Trades:      ${(state.closedTrades||[]).length} closed trades in history`);
    console.log(`Scan:        every 30 seconds, 9AM-4PM ET Mon-Fri`);
    console.log(`Entry window: 9:45AM-3PM ET`);
  });
});
