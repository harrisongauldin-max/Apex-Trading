// constants.js — ARGO V3.2
// All shared constants. No functions. No imports. No state reads.
// Require this file first in every module that needs trading parameters.
'use strict';

// ─── Alpaca API ───────────────────────────────────────────────────
const ALPACA_KEY        = process.env.ALPACA_API_KEY    || '';
const ALPACA_SECRET     = process.env.ALPACA_SECRET_KEY || '';
const ALPACA_BASE       = 'https://paper-api.alpaca.markets/v2';
const ALPACA_DATA       = 'https://data.alpaca.markets/v2';
const ALPACA_OPTIONS    = 'https://paper-api.alpaca.markets/v2';
const ALPACA_OPT_SNAP   = 'https://data.alpaca.markets/v1beta1';
const ALPACA_NEWS       = 'https://data.alpaca.markets/v1beta1';

// ─── External services ───────────────────────────────────────────
const GMAIL_USER        = process.env.GMAIL_USER        || '';
const RESEND_API_KEY    = process.env.RESEND_API_KEY    || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = 'claude-sonnet-4-20250514';
const REDIS_URL         = process.env.UPSTASH_REDIS_REST_URL  || '';
const REDIS_TOKEN       = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY         = 'spt1:state';
const REDIS_SAVE_INTERVAL = 30 * 1000;
const MARKETAUX_KEY     = process.env.MARKETAUX_API_KEY || '';

// ─── Capital / risk ──────────────────────────────────────────────
const MONTHLY_BUDGET      = 30000; // Updated: new Alpaca paper account starting balance
const CAPITAL_FLOOR       = 7500;
const REVENUE_THRESHOLD   = 2000;
const BONUS_AMOUNT        = 1000;
const MAX_HEAT            = 0.60;
const MAX_SECTOR_PCT      = 0.50;

// ─── Exit parameters ─────────────────────────────────────────────
const STOP_LOSS_PCT       = 0.35;
const FAST_STOP_PCT       = 0.20;
const FAST_STOP_HOURS     = 48;
const TAKE_PROFIT_PCT     = 0.50;
const PARTIAL_CLOSE_PCT   = 0.18;
const TRAIL_ACTIVATE_PCT  = 0.15;
const TRAIL_STOP_PCT      = 0.15;
const BREAKEVEN_LOCK_PCT  = 0.40;
const RIDE_TARGET_PCT     = 1.00;
const TIME_STOP_DAYS      = 7;
const TIME_STOP_MOVE      = 0.05;
const IV_COLLAPSE_PCT     = 0.30;
const MA50_BUFFER         = 0.01;
const MACRO_REVERSAL_PCT  = 0.025;

// ─── Entry filters ───────────────────────────────────────────────
const MIN_SCORE           = 70;
const MIN_SCORE_CREDIT    = 65;  // credit/directional minimum
const MIN_SCORE_MR        = 65;  // FIX 11: MR call minimum raised from 60→65 (theta drag requires higher conviction)
const IVR_MAX             = 70;
const EARNINGS_SKIP_DAYS  = 5;
const MIN_OPEN_INTEREST   = 100;
const MIN_STOCK_PRICE     = 20;
const MIN_OPTION_PREMIUM  = 0.50;
const MIN_OI              = 5;
const MAX_SPREAD_PCT      = 0.30;
const EARLY_SPREAD_PCT    = 0.10;
const MAX_GAP_PCT         = 0.03;
const TARGET_DELTA_MIN    = 0.22; // Lowered from 0.28 — expanded DTE window finds 48d contracts at delta 0.23-0.26
const TARGET_DELTA_MAX    = 0.42;
const MAX_BETA_POSITIONS  = 2;
const MAX_HIGH_BETA       = 2;

// ─── PDT protection ──────────────────────────────────────────────
const PDT_RULE_ACTIVE     = false; // FINRA PDT rule sunset — published April 21 2026, Alpaca implementing ~June 5 2026. Set true to re-enable if Alpaca delays.
const PDT_LIMIT           = 3;
const PDT_PROFIT_EXIT     = 0.65;
const PDT_STOP_LOSS       = 0.30;

// ─── Timing ──────────────────────────────────────────────────────
const MS_PER_DAY          = 86400000;
const TRIGGER_COOLDOWN_MS = 15 * 60 * 1000;
const SAME_DAY_INTERVAL   = 30 * 60 * 1000;
const OVERNIGHT_INTERVAL  = 60 * 60 * 1000;
const SLOW_CACHE_TTL      = 10 * 60 * 1000;
const BARS_CACHE_TTL      = 60 * 60 * 1000;

// ─── Feature flags ───────────────────────────────────────────────
const INDIVIDUAL_STOCKS_ENABLED = false;

// ─── Infrastructure ──────────────────────────────────────────────
const STATE_FILE = require('path').join(__dirname, 'state.json');

// ─── Watchlist ──────────────────────────────────────────────────
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
    isIndex:   true,  // B4: required for credit_put/credit_call tradeType
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

// FIX 12: Expanded watchlist — SMH (semiconductors), IYR (real estate), HYG (high yield credit)
// All ETF-based: no earnings risk, liquid options markets, genuinely uncorrelated theses
// SMH: pure-play semiconductors, high beta to AI narrative, independent of broad QQQ
// IYR: rate-driven real estate, negative correlation with yields, independent macro driver
// HYG: high yield bonds, credit stress leading indicator, already used as data signal — now tradeable
WATCHLIST.push(
  {
    ticker:    "SMH",
    sector:    "Technology",
    momentum:  "steady",
    rsi:       50,
    macd:      "neutral",
    catalyst:  "Semiconductor cycle — AI chip demand + geopolitics",
    ivr:       45,
    beta:      1.6,
    earningsDate: null,
    isIndex:   true,
    isPrimary: false,
    minScore:  75, // FIX 11: higher bar for thinner liquidity instruments
  },
  {
    ticker:    "IYR",
    sector:    "Real Estate",
    momentum:  "steady",
    rsi:       50,
    macd:      "neutral",
    catalyst:  "Rate cycle — REITs rally on rate cuts, sell on hikes",
    ivr:       22,
    beta:      0.7,
    earningsDate: null,
    isIndex:   true,
    isPrimary: false,
    minScore:  75,
  },
  {
    ticker:    "HYG",
    sector:    "Bonds",
    momentum:  "steady",
    rsi:       50,
    macd:      "neutral",
    catalyst:  "Credit stress leading indicator — HYG leads equity by 2-3 days",
    ivr:       18,
    beta:      0.5,
    earningsDate: null,
    isIndex:   true,
    isPrimary: false,
    minScore:  75,
  }
);

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
  // TODO #10: New additions — panel approved April 14, 2026 (data-only, not tradeable)
  { ticker:"UNH",   sector:"Healthcare",  momentum:"steady",     rsi:50, macd:"neutral",             catalyst:"ACA policy + Medicare/Medicaid cycle", ivr:30, beta:0.6, earningsDate:null, dataOnly:true },
  { ticker:"CAT",   sector:"Industrial",  momentum:"steady",     rsi:50, macd:"neutral",             catalyst:"Global capex + infrastructure spend",   ivr:28, beta:1.1, earningsDate:null, dataOnly:true },
  { ticker:"COIN",  sector:"Crypto",      momentum:"recovering", rsi:45, macd:"neutral",             catalyst:"Crypto risk appetite proxy",            ivr:85, beta:2.5, earningsDate:null, dataOnly:true },
];



// ─── Agent ────────────────────────────────────────────────────────────────────
const AGENT_MACRO_CACHE_MS     = 3 * 60 * 1000;       // 3 min cache for macro analysis

// ─── Instrument constraints ───────────────────────────────────────────────────
// INSTRUMENT_CONSTRAINTS defined in entryEngine.js (authoritative)

// ─── VIX tiers ────────────────────────────────────────────────────────────────
const VIX_PAUSE                = 35;    // halt new entries above this
const VIX_REDUCE25             = 25;    // reduce sizing 25% above this
const VIX_REDUCE50             = 30;    // reduce sizing 50% above this

// ─── Risk limits ─────────────────────────────────────────────────────────────
const MAX_LOSS_PER_TRADE       = 900;   // max $ loss per trade
const WEEKLY_DD_LIMIT          = 0.25;  // 25% weekly drawdown limit
const PDT_DAYS                 = 5;     // rolling business day window for PDT count

// ─── Pre-market thresholds ───────────────────────────────────────────────────
const PREMARKET_NEGATIVE       = -0.01; // -1% gap = negative open signal
const PREMARKET_STRONG_MOVE    = 0.015; // 1.5% gap = strong directional signal

// ─── Support/resistance buffers ──────────────────────────────────────────────
const SUPPORT_BUFFER           = 0.03;  // 3% above support = safe put entry
const RESISTANCE_BUFFER        = 0.02;  // 2% below resistance = safe call entry

// ─── Fast profit ─────────────────────────────────────────────────────────────
const FAST_PROFIT_PCT          = 0.40;  // 40% gain in <4hrs triggers fast exit

// ─── State ───────────────────────────────────────────────────────────────────
const BACKUP_FILE              = 'state_backup.json';
module.exports = {
  ALPACA_KEY, ALPACA_SECRET, ALPACA_BASE, ALPACA_DATA, ALPACA_OPTIONS,
  ALPACA_OPT_SNAP, ALPACA_NEWS, GMAIL_USER, RESEND_API_KEY,
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL, REDIS_URL, REDIS_TOKEN, REDIS_KEY,
  REDIS_SAVE_INTERVAL, MARKETAUX_KEY, MONTHLY_BUDGET, CAPITAL_FLOOR,
  REVENUE_THRESHOLD, BONUS_AMOUNT, MAX_HEAT, MAX_SECTOR_PCT,
  STOP_LOSS_PCT, FAST_STOP_PCT, FAST_STOP_HOURS, TAKE_PROFIT_PCT,
  PARTIAL_CLOSE_PCT, TRAIL_ACTIVATE_PCT, TRAIL_STOP_PCT, BREAKEVEN_LOCK_PCT,
  RIDE_TARGET_PCT, TIME_STOP_DAYS, TIME_STOP_MOVE, IV_COLLAPSE_PCT,
  MA50_BUFFER, MACRO_REVERSAL_PCT, MIN_SCORE, MIN_SCORE_CREDIT, MIN_SCORE_MR, IVR_MAX,
  EARNINGS_SKIP_DAYS, MIN_OPEN_INTEREST, MIN_STOCK_PRICE, MIN_OPTION_PREMIUM,
  MIN_OI, MAX_SPREAD_PCT, EARLY_SPREAD_PCT, MAX_GAP_PCT, TARGET_DELTA_MIN,
  TARGET_DELTA_MAX, MAX_BETA_POSITIONS, MAX_HIGH_BETA, PDT_RULE_ACTIVE, PDT_LIMIT,
  PDT_PROFIT_EXIT, PDT_STOP_LOSS, MS_PER_DAY, TRIGGER_COOLDOWN_MS,
  SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL, SLOW_CACHE_TTL, BARS_CACHE_TTL,
  INDIVIDUAL_STOCKS_ENABLED, INDIVIDUAL_STOCK_WATCHLIST, STATE_FILE, WATCHLIST,
  AGENT_MACRO_CACHE_MS, VIX_PAUSE, VIX_REDUCE25, VIX_REDUCE50, MAX_LOSS_PER_TRADE, WEEKLY_DD_LIMIT, PDT_DAYS, PREMARKET_NEGATIVE, PREMARKET_STRONG_MOVE, SUPPORT_BUFFER, RESISTANCE_BUFFER, FAST_PROFIT_PCT,
};
