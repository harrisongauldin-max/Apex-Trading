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
const ANTHROPIC_MODEL   = 'claude-sonnet-4-6';  // FIX (6/16): was retired snapshot claude-sonnet-4-20250514 (404). claude-sonnet-4-6 is current GA.
const REDIS_URL         = process.env.UPSTASH_REDIS_REST_URL  || '';
const REDIS_TOKEN       = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY         = 'spt1:state';
const REDIS_SAVE_INTERVAL = 30 * 1000;
const MARKETAUX_KEY     = process.env.MARKETAUX_API_KEY || '';

// ─── Capital / risk ──────────────────────────────────────────────
const MONTHLY_BUDGET      = 10000; // Reset 6/8/2026: $10K to match planned live capital (post-FINRA PDT alignment)
const CAPITAL_FLOOR       = 2500;  // 25% of $10K — halt entries if cash drops below $2,500
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
const TRAIL_ACTIVATE_PCT  = 0.08; // V2.95: lowered from 0.15 to match tier-1 profit lock
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

// ─── MACD classification band (6/17) ─────────────────────────────
// Histogram is normalized by daily ATR in signals.calcMACD, so the "crossover" (strong)
// vs plain bearish/bullish (mild) split is volatility-relative, not an absolute $ band.
// PROVISIONAL 0.5 (panel verdict 6/17); replace with the 75th-pct of real |hist/ATR|
// measured on SPY/QQQ daily bars. Lower = strong label fires more (tighter on MR calls).
const MACD_HIST_STRONG_ATR = 0.5;

// ─── MR relative-bounce entry tier (6/17) ────────────────────────
// scoring.scoreIndexSetup credits a price-confirmed bounce when intraday RSI has lifted
// this many points off its OWN session low AND price has reclaimed VWAP. Replaces reliance
// on the absolute RSI>=38 gate, which missed V-bottoms from deep lows. PROVISIONAL 6 (panel
// verdict 6/17) — tune off paper trades. Lower = bounce credit fires earlier (more entries).
const MR_BOUNCE_RSI_OFFLOW = 6;
// Bounce also requires price to reclaim to within this fraction of VWAP (blocks rewarding RSI
// noise on a still-falling tape). PROVISIONAL 0.004 (0.4%); tune off paper trades. Read by scoring.js.
const MR_BOUNCE_VWAP_TOL   = 0.004;
const IVR_MAX             = 70;
const EARNINGS_SKIP_DAYS  = 5;
const MIN_OPEN_INTEREST   = 100;
const MIN_STOCK_PRICE     = 20;
const MIN_OPTION_PREMIUM  = 0.50;
const MIN_OI              = 5;
const MAX_SPREAD_PCT      = 0.10; // C1-E Sunday 6/8: tightened from 0.30 → 0.10

// ── VIX CALL QUALITY GATE (V2.96) ────────────────────────────────────────
// At VIX >= 25, naked call entries require RSI < 38 (deeply oversold).
// Blocks shallow-oversold entries (RSI 40-50) that lose on gap/digestion days.
// Preserves deep-oversold entries (RSI < 38) that produce thesis-complete wins.
// Evidence: May 12 — AM losses RSI 46-50 (blocked), PM wins RSI 33-36 (pass).
const VIX_CREDIT_PRIMARY  = 25;    // VIX >= 25: tighter RSI required for calls
const VIX_CALLS_BLOCKED   = 30;    // VIX >= 30: calls fully blocked
const VIX_HIGH_CALL_SCORE = 90;    // score floor when VIX >= 25
const VIX_HIGH_CALL_RSI   = 38;    // RSI must be < 38 when VIX >= 25
// ── END VIX CALL QUALITY GATE ────────────────────────────────────────────
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
// V3.2 (6/21) MR-LABEL DECOUPLING — panel-decided. When true, the mean-reversion LABEL
// (entryEngine floor + 85-MACD-contradiction carve-out eligibility) is granted on the SETUP
// rather than on the MR scorer out-scoring the general call path. Two-tier: the aggressive
// contract profile (0.42Δ/14DTE) + defensive-mode survival stay gated on the strict score-beat
// (_mrStrong) inside scanner.js. ENABLED for paper validation; set false to revert (no code deploy).
const MR_LABEL_DECOUPLED = true;

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
  // ───────────────────────────────────────────────────────────────────────
  // DISABLED 6/10/2026 — APEX trades SPY/QQQ only. GLD/TLT/XLE/HYG removed
  // from the tradeable watchlist (definitions preserved in the v3.2 archive).
  // NOTE: XLE & HYG are STILL fetched for market-context data (sector relative
  // strength + credit-stress signal) via the separate dataSectors fetch in
  // scanner.js — that path is independent of this list and is unaffected.
  // Re-enable by restoring the instrument objects here.
  // ───────────────────────────────────────────────────────────────────────
];;

// V2.94: SMH REMOVED from WATCHLIST (trading panel unanimous, 5/6/2026)
// SPRINT-12: SMH wash sale monitoring note.
// SMH was sold on 5/6/2026 at slight gain (+$5). No wash sale concern from that trade.
// If SMH is ever re-added to WATCHLIST, ensure _recentLosses tracking covers
// the 30-day wash sale window. The scanner wash sale warning fires on losses only —
// a gain followed by a loss within 30 days is technically not a wash sale, but
// monitor any re-entry within 30 days of a loss on SMH.
// SMH re-entry earliest: 6/5/2026 (30 days from last trade).
// Failure modes: beta 1.6 (too volatile), premium $21+ (8% account per contract),
// dailyRSI 99.6 (zero MR room), narrative-driven (chip cycle/geopolitics not RSI-predictable),
// 0 wins observed across all sessions. Kept in dataSectors for breadth/rotation data only.
// IYR REMOVED — 5/8/2026. 0 winning trades across all sessions.
// -$150 (May 7), -$405 (May 8 bad fill), -$147 (May 8 manual). Total: -$702.
// REIT options are illiquid with wide spreads. Rate sensitivity makes thesis
// unreliable (hawkish Fed = headwind, even pre-market +2% gaps don't translate).
// HYG: high yield bonds, credit stress leading indicator, already used as data signal — now tradeable
/* DISABLED 6/10/2026 — HYG removed from tradeable watchlist (SPY/QQQ only).
   HYG remains a DATA signal via dataSectors in scanner.js (credit stress).
   WATCHLIST.push(
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
*/

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

// ─── SUNDAY C1 FEATURE FLAGS (6/8/2026) ──────────────────────────────────────
// All 8 changes flag-controlled. Set false to revert without code deploy.
const SUNDAY_C1_FEATURE_FLAGS = {
  C1_A_DAILY_LOSS_LOCK:       true,  // Daily -$300 soft lock → minScore 85
  C1_B_INSTRUMENT_LOSS_LOCK:  true,  // Per-instrument 2 losses → minScore 90
  C1_C_HIGH_RISK_MIN_SCORE:   true,  // Day plan HIGH RISK raises minScore 70→85
  C1_D_STAGGER_BYPASS_GATE:   true,  // Stagger bypass disabled on HIGH RISK days
  C1_E_WIDE_SPREAD_TIGHTENED: true,  // Wide-spread block 30%→10% (MAX_SPREAD_PCT)
  C1_G_WEEKLY_MONTHLY_HALTS:  true,  // Weekly -$700 / Monthly -$1500 hard halts
  C1_J_JOURNAL_ENRICHMENT:    true,  // Trade journal completeness enhancement
  C1_N_MORNING_RESET_CLEANUP: true,  // Morning reset clears all daily blockers
};

// C1-A thresholds
const DAILY_LOSS_LOCK_THRESHOLD = -300;  // todayRealizedPnL floor before soft lock
const DAILY_LOSS_LOCK_MIN_SCORE =  85;   // minScore when daily lock is active

// C1-B thresholds
const INSTRUMENT_LOSS_LIMIT     =   2;   // losses on same ticker before per-instrument lock
const INSTRUMENT_LOSS_MIN_SCORE =  90;   // minScore when per-instrument lock is active
const LOSS_THRESHOLD_FOR_COUNTER = -10;  // pnl must be < -$10 to count toward C1-B

// C1-C threshold
const HIGH_RISK_MIN_SCORE       =  85;   // minScore on HIGH RISK day plan days

// C1-G thresholds
const WEEKLY_LOSS_LIMIT         = -700;  // weeklyRealizedPnL floor → hard halt
const MONTHLY_LOSS_LIMIT        = -1500; // monthlyRealizedPnL floor → hard halt

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
  MACD_HIST_STRONG_ATR, MR_BOUNCE_RSI_OFFLOW, MR_BOUNCE_VWAP_TOL,
  EARNINGS_SKIP_DAYS, MIN_OPEN_INTEREST, MIN_STOCK_PRICE, MIN_OPTION_PREMIUM,
  MIN_OI, MAX_SPREAD_PCT, EARLY_SPREAD_PCT, MAX_GAP_PCT, TARGET_DELTA_MIN,
  VIX_CREDIT_PRIMARY, VIX_CALLS_BLOCKED,
  VIX_HIGH_CALL_SCORE, VIX_HIGH_CALL_RSI,
  TARGET_DELTA_MAX, MAX_BETA_POSITIONS, MAX_HIGH_BETA, PDT_RULE_ACTIVE, PDT_LIMIT,
  PDT_PROFIT_EXIT, PDT_STOP_LOSS, MS_PER_DAY, TRIGGER_COOLDOWN_MS,
  SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL, SLOW_CACHE_TTL, BARS_CACHE_TTL,
  INDIVIDUAL_STOCKS_ENABLED, INDIVIDUAL_STOCK_WATCHLIST, STATE_FILE, WATCHLIST,
  MR_LABEL_DECOUPLED,
  AGENT_MACRO_CACHE_MS, VIX_PAUSE, VIX_REDUCE25, VIX_REDUCE50, MAX_LOSS_PER_TRADE,
  WEEKLY_DD_LIMIT, PDT_DAYS, PREMARKET_NEGATIVE, PREMARKET_STRONG_MOVE,
  SUPPORT_BUFFER, RESISTANCE_BUFFER, FAST_PROFIT_PCT,
  // C1 Sunday 6/8
  SUNDAY_C1_FEATURE_FLAGS,
  DAILY_LOSS_LOCK_THRESHOLD, DAILY_LOSS_LOCK_MIN_SCORE,
  INSTRUMENT_LOSS_LIMIT, INSTRUMENT_LOSS_MIN_SCORE, LOSS_THRESHOLD_FOR_COUNTER,
  HIGH_RISK_MIN_SCORE,
  WEEKLY_LOSS_LIMIT, MONTHLY_LOSS_LIMIT,
};
