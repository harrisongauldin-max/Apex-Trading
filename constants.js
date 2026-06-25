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
// PAPER/LIVE detection — positive check. Alpaca paper URL contains 'paper'; the LIVE URL
// (api.alpaca.markets) contains neither 'paper' nor 'live', so a .includes('live') test would
// be dead. This is the hard interlock substrate for PAPER DATA MODE (see state.paperDataActive).
const IS_PAPER_ACCOUNT  = String(ALPACA_BASE).includes('paper');

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
// D2 (6/24) intraday-MR early-turn confirmation. The intraday-MR path (MR_INTRADAY_OVERSOLD)
// previously gated on a MACD bull_curl, which only sets AFTER the bounce begins — so deep
// intraday dips (RSI 14-30) never authorized an entry while the daily RSI was neutral, and the
// system entered late or not at all. These gate a turn signal that fires DURING the dip:
const MR_INTRA_LIFTOFF_PTS = 4;     // intraday RSI must lift >= this many pts off its session low (the early turn). Lower = earlier/more entries, more dead-cat risk.
const MR_INTRA_SESSLOW_MAX = 35;    // session must have reached <= this RSI (genuinely oversold) before the intraday path engages.
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
// V3.2 (6/22) PAPER-EXPERIMENT MODE — panel-decided "Aggressive" paper-validation experiment.
// When true: caps the CALL entry floor at EXPERIMENT_CALL_FLOOR and bypasses the gap-up CALL blocks
// (GAP-VWAP / GATE-C / GAP-REVERSAL / GAP-STRICT-RSI) so APEX takes marginal call setups on paper to
// gather fills. CALLS ONLY — puts stay disciplined. Entries tagged [EXPERIMENT-ENTRY] for P&L
// isolation. PAPER ONLY — set false to revert instantly (no code deploy). Review after ~15 fills.
const APEX_PAPER_EXPERIMENT = true;   // RETIRED as a live behavior flag (6/23). Now only the SEED
// value for state.paperDataMode (state.js defaultState). The runtime on/off is the UI toggle →
// state.paperDataMode, gated by IS_PAPER_ACCOUNT via state.paperDataActive(). Readers no longer
// consult this constant directly. Kept exported so first-boot seeding stays continuous.
const EXPERIMENT_CALL_FLOOR = 50;
const EXPERIMENT_PUT_FLOOR  = 60;   // Decision B (6/23): put experiment floor — well under Risk's 85
// against-trend put wall, above pure-noise 50. First dial to tune from paper PUT-entry data.

// --- Trade-robustness layer (panel D1/D5 + corroboration). Flags default OFF; toggle ON for paper validation. ---
const IVP_CALL_PENALTY_STEEP            = false; // D5 (reverted 6/23, panel A): back to IVP threshold 75, calm-VIX call penalty 8 (was 70/15 — over-taxed normal call IV)
const DIP_REQUIRES_MULTIDAY_ANCHOR      = true;  // D1: dip bonuses require underlying flat/red on the day
const DIP_MAX_DAYCHANGE                 = 0.003;  // D1: max SPY day-change (+0.3%) to still count as a "dip"
// F+G (6/23, panel): MR oversold tiers historically keyed off DAILY RSI (P0 anti-whipsaw) — which made
// QQQ (daily 51) ineligible despite intraday 26, and flattened the score (daily RSI barely moves
// intraday). When true, a bull_curl-CONFIRMED intraday dip is scored at its intraday depth, so depth
// finally scales and intraday-oversold index names qualify. The curl requirement IS the anti-whipsaw
// guard P0 wanted. Default OFF; paper-armed. Set false to revert (no code deploy).
const MR_INTRADAY_OVERSOLD              = true;   // ARMED (6/24, paper): bull_curl-confirmed intraday dips now score at intraday depth (+20 deeply-oversold reachable) AND set isMeanReversion:true, which is what makes the D2 carve-out reachable. Watch give-back losses — entries up, exit unfixed. Set false to revert (no code deploy).
const OVERSOLD_CALL_NEEDS_CORROBORATION = false;  // PARKED OFF (6/22): superseded by the RSI daily-contract fix — the +20 now keys off daily RSI, so it no longer fires on intraday whipsaws (corroboration's main purpose). The below-VWAP clause also fights bounce-confirmation (D2 curl). Re-evaluate as a breadth-ONLY variant before ever enabling.
const CORROBORATION_MAX_BREADTH         = 45;     // item4: breadth <= this corroborates an oversold-call dip
const GIVEBACK_EXIT_ENABLED   = false;  // D3 DISABLED (6/24): redundant with the trail-floor (exitEngine.js:479), and worse — armed at +1% RAW peak vs trail's +5% CONFIRMED, and a 10-min min-hold delayed the exit past breakeven into deep red (stopped MR dips out at the bottom). Trail-floor is the sole profit-lock, as its own design comment states.
const SPIRAL_COOLDOWN_MIN     = 45;     // D3 (6/24) spiral-block cooldown: after a 5-loss streak locks a side, auto-clear the block this many minutes later so entries resume for data-gathering. Fixes the deadlock where the block could only clear on a winning trade of a side that was itself blocked (→ permanent lock until daily reset). Tunable.
const GIVEBACK_PEAK_MIN       = 0.01;   // D3: required peak gain (+1%) before give-back can arm (panel value; tune in paper)
const GIVEBACK_FLOOR          = 0.0;    // D3: exit when current change falls back to <= this (breakeven)
const GIVEBACK_MIN_HOLD_MIN   = 10;     // D3: minimum hold minutes before give-back can fire (anti early-noise)

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
// ── Real CBOE ^VIX daily closes (source: cdn.cboe.com VIX_History.csv) ──────────
// Trailing 252 trading days 2025-06-30 → 2026-06-19. Used to SEED state._vixDaily so the
// IV-Rank subsystem ranks the current REAL VIX close against a REAL one-year VIX
// distribution. This is intentionally separate from getVIX() (which returns the
// VIXY share price used by the risk gates) — IVR must rank real-vs-real to be
// units-correct. state._vixDaily self-replaces this seed via the daily CBOE refresh.
const VIX_DAILY_SEED = [
  16.73, 16.83, 16.64, 16.38, 17.48, 17.79, 16.81, 15.94, 15.78, 16.40, 17.20, 17.38,
  17.16, 16.52, 16.41, 16.65, 16.50, 15.37, 15.39, 14.93, 15.03, 15.98, 15.48, 16.72,
  20.38, 17.52, 17.85, 16.77, 16.57, 15.15, 16.25, 14.73, 14.49, 14.83, 15.09, 14.99,
  15.57, 15.69, 16.60, 14.22, 14.79, 14.62, 14.85, 14.43, 15.36, 16.12, 17.17, 16.35,
  15.30, 15.18, 15.11, 15.04, 15.35, 14.71, 14.76, 15.69, 16.36, 15.72, 15.70, 15.45,
  16.10, 16.64, 16.18, 16.74, 15.29, 16.12, 16.28, 16.29, 16.63, 16.65, 16.37, 17.24,
  16.30, 16.43, 21.66, 19.03, 20.81, 20.64, 25.31, 20.78, 18.23, 17.87, 18.60, 17.30,
  16.37, 15.79, 16.42, 16.92, 16.91, 17.44, 17.17, 19.00, 18.01, 19.50, 19.08, 17.60,
  17.28, 17.51, 20.00, 19.83, 22.38, 24.69, 23.66, 26.42, 23.43, 20.52, 18.56, 17.19,
  17.21, 16.35, 17.24, 16.59, 16.08, 15.78, 15.41, 16.66, 16.93, 15.77, 14.85, 15.74,
  16.50, 16.48, 17.62, 16.87, 14.91, 14.08, 14.00, 13.47, 13.60, 14.20, 14.33, 14.95,
  14.51, 14.90, 14.75, 15.38, 15.45, 14.49, 15.12, 15.98, 16.75, 15.84, 15.86, 18.84,
  20.09, 16.90, 15.64, 16.09, 16.15, 16.35, 16.35, 16.88, 17.44, 16.34, 18.00, 18.64,
  21.77, 17.76, 17.36, 17.79, 17.65, 20.82, 20.60, 21.20, 20.29, 19.62, 20.23, 19.09,
  21.01, 19.55, 17.93, 18.63, 19.86, 21.44, 23.57, 21.15, 23.75, 29.49, 25.50, 24.93,
  24.23, 27.29, 27.19, 23.51, 22.37, 25.09, 24.06, 26.78, 26.15, 26.95, 25.33, 27.44,
  31.05, 30.61, 25.25, 24.54, 23.87, 24.17, 25.78, 21.04, 19.49, 19.23, 19.12, 18.36,
  18.17, 17.94, 17.48, 18.87, 19.50, 18.92, 19.31, 18.71, 18.02, 17.83, 18.81, 16.89,
  16.99, 18.29, 17.38, 17.39, 17.08, 17.19, 18.38, 17.99, 17.87, 17.26, 18.43, 17.82,
  18.06, 17.44, 16.76, 16.70, 16.59, 17.01, 16.29, 15.74, 15.32, 16.05, 15.77, 16.06,
  15.40, 21.51, 18.92, 19.87, 22.22, 19.44, 17.68, 16.20, 16.41, 18.44, 16.40, 16.78
];
const VIX_HISTORY_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv";

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
  MR_INTRA_LIFTOFF_PTS, MR_INTRA_SESSLOW_MAX,
  EARNINGS_SKIP_DAYS, MIN_OPEN_INTEREST, MIN_STOCK_PRICE, MIN_OPTION_PREMIUM,
  MIN_OI, MAX_SPREAD_PCT, EARLY_SPREAD_PCT, MAX_GAP_PCT, TARGET_DELTA_MIN,
  VIX_CREDIT_PRIMARY, VIX_CALLS_BLOCKED,
  VIX_HIGH_CALL_SCORE, VIX_HIGH_CALL_RSI,
  TARGET_DELTA_MAX, MAX_BETA_POSITIONS, MAX_HIGH_BETA, PDT_RULE_ACTIVE, PDT_LIMIT,
  PDT_PROFIT_EXIT, PDT_STOP_LOSS, MS_PER_DAY, TRIGGER_COOLDOWN_MS,
  SAME_DAY_INTERVAL, OVERNIGHT_INTERVAL, SLOW_CACHE_TTL, BARS_CACHE_TTL,
  INDIVIDUAL_STOCKS_ENABLED, INDIVIDUAL_STOCK_WATCHLIST, STATE_FILE, WATCHLIST,
  MR_LABEL_DECOUPLED, MR_INTRADAY_OVERSOLD, APEX_PAPER_EXPERIMENT, EXPERIMENT_CALL_FLOOR, EXPERIMENT_PUT_FLOOR, IS_PAPER_ACCOUNT,
  VIX_DAILY_SEED, VIX_HISTORY_URL,
  IVP_CALL_PENALTY_STEEP, DIP_REQUIRES_MULTIDAY_ANCHOR, DIP_MAX_DAYCHANGE,
  OVERSOLD_CALL_NEEDS_CORROBORATION, CORROBORATION_MAX_BREADTH,
  GIVEBACK_EXIT_ENABLED, GIVEBACK_PEAK_MIN, GIVEBACK_FLOOR, GIVEBACK_MIN_HOLD_MIN,
  SPIRAL_COOLDOWN_MIN,
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
