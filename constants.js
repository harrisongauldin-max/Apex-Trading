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
const OPTION_FEED       = process.env.OPTION_FEED || 'opra';   // D3 (6/25) real-time OPRA (Algo Trader Plus). Set OPTION_FEED=indicative to revert to the free 15-min-delayed feed without a redeploy.
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
const MARKETAUX_KEY     = process.env.MARKETAUX_API_KEY || process.env.MARKETAUX_KEY || '';  // 7/1 fix: accept either name (market.js read MARKETAUX_KEY; constants read MARKETAUX_API_KEY — a keyless path failed silently)

// ─── Capital / risk ──────────────────────────────────────────────
const MONTHLY_BUDGET      = 10000; // Reset 6/8/2026: $10K to match planned live capital (post-FINRA PDT alignment)
const DEFAULT_VIX         = 20;    // 7/7 (Harrison): single source of truth for "VIX when state.vix is null". Was diverging across files (risk 15, scoring 25, agent 28) → subsystems disagreed on volatility on a null-VIX scan.
const CAPITAL_FLOOR       = 2500;  // 25% of $10K — halt entries if cash drops below $2,500
const REVENUE_THRESHOLD   = 2000;
const BONUS_AMOUNT        = 1000;
const MAX_HEAT            = 0.60;
const MAX_SECTOR_PCT      = 0.50;

// ─── Data-gather mode ────────────────────────────────────────────
// 6/30 (Harrison): master switch for the paper data-gathering phase. When true, the loss-based
// TRADING HALTS are disabled so a bad day doesn't stop APEX from taking setups — we want continuous
// data across all tapes. This ONLY removes the "stop trading because we lost too much" circuit
// breakers. It does NOT touch: per-setup entry gates (score floors, D2 veto, cooldowns, re-entry
// penalty), exit logic (stops, trail-floor, 3:15 flatten), or position sizing caps (MAX_CONTRACTS,
// MAX_LOSS_PER_TRADE). Those all stay live so each trade still resolves cleanly and the win/loss
// data stays interpretable. Flip to false to restore normal circuit-breaker behavior.
const DATA_GATHER_MODE    = false;

// ─── Exit parameters ─────────────────────────────────────────────
const STOP_LOSS_PCT       = 0.125;  // 6/30: tightened 0.15→0.125 (Harrison). Down 12.5% → sell. Paired with same-week DTE switch — expect frequent stop-outs on gamma noise; that is the data being gathered.
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
const MIN_SCORE = 70;   // 8/17: back to 70. It was moved to 50 to compensate a 20-point constant
                        // strip in scoring.js that is now reverted — and it was the wrong lever
                        // anyway: scanner.js:2475 uses `_debitCallActive ? 75 : MIN_SCORE`, so on
                        // the live path the operative floor is a hardcoded 75 and MIN_SCORE never
                        // applies. Verified against the 8/17 log: "scanner-floor 75".

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
// Intraday flush discount (6/25, LIVE paper). Fills the hole where the daily 20-day-drawdown
// tier returns +0 on intraday flushes. Credit scales with intraday drawdown off the SESSION HIGH
// (the newly-bridged intraday series), gated on _mrEarlyTurn so only a confirmed oversold turn
// earns it (RSI gate = quality, price drawdown = magnitude), taken as MAX vs the daily discount
// (never summed). Starting thresholds — tune from the logged [MR-FLUSH] data.
const MR_FLUSH_DD1 = 0.004;         // 6/29 re-tier: >= 0.4% off session high → +8  (shallow flush)
const MR_FLUSH_DD2 = 0.007;         // 6/29 re-tier: >= 0.7% off session high → +12 (solid flush)
const MR_FLUSH_DD3 = 0.010;         // 6/29 re-tier: >= 1.0% off session high → +16 (deep flush). Old 0.015 never fired on SPY/QQQ intraday in calm VIX.
// Session-low recency (6/25 fix). The _mrEarlyTurn gate keyed off the all-session sticky
// MIN RSI, so once 1-min RSI printed any deep value early (6/25: a stuck 2.2 on a 1.28%
// range day), the gate stayed permanently open and the flush credit fired on every MR call.
// Require the session low to have occurred within this many minutes — a stale low no longer
// counts as an "early turn." Tunable: shorter = stricter (only very recent flushes qualify).
const MR_SESSLOW_RECENCY_MIN = 60;
const IVR_MAX             = 70;
const EARNINGS_SKIP_DAYS  = 5;
const MIN_OPEN_INTEREST   = 100;
const MIN_STOCK_PRICE     = 20;
const MIN_OPTION_PREMIUM  = 0.50;
const MIN_OI              = 5;
const MAX_SPREAD_PCT      = 0.05; // 6/8: 0.30->0.10; 7/29: ->0.05. A 10% round-trip spread dwarfed the +$39/trade trail-floor average. If [WIDE-SPREAD] BLOCKED becomes frequent, 0.07 is the next stop.

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
const EARLY_SPREAD_PCT    = 0.10; // NOTE (7/29): DEAD CONSTANT - exported and imported by execution.js but never consumed. MAX_SPREAD_PCT is the live gate.
// 7/29: LIVE spread monitor for OPEN positions. The entry cap only sees the spread at ENTRY;
// the QQQ 680C entered legally and then blew out to ~42% mid-hold, so APEX marked it +9.5% on
// the MID and logged HOLD one scan before selling at the BID for -13.8%. Above this level a
// position's mid is not a realisable price and must not be trusted to arm a profit floor.
const LIVE_WIDE_SPREAD_PCT = 0.15;
const MAX_GAP_PCT         = 0.03;
// Gap classifier (6/26, logged-only). gapType boundary: |gapPct| >= this → up/down, else flat.
// Distinct from MAX_GAP_PCT (a 3% extreme-gap SAFETY cutoff). This is a label threshold only.
const GAP_MIN_PCT         = 0.004;   // 0.4% — starting boundary, tune per ticker overnight behavior
// ── #3 D2 carve-out (6/26, LIVE). Lets a confirmed present-tense reversal past the regime veto.
//    Call side: stand D2 down on gap-up-holding + breadth expanding (leans WITH bull regime).
//    Put side: STRICTER (fights bull regime) — needs deeper VWAP break + stronger breadth drop.
//    Neither hands out points; score must still clear its floor.
const CARVEOUT_BREADTH_MOM_MIN   = 5;      // call side: _breadthMomentum >= +5 (the "rising" bar)
const CARVEOUT_CALL_VWAP_MAX     = 0.01;   // call side: price within +1% above VWAP — early reclaim, not extended (6/26 rising-tape)
const CARVEOUT_PUT_BREADTH_MOM   = -10;    // put side STRICTER: _breadthMomentum <= -10 (vs -5)
const CARVEOUT_PUT_VWAP_BREAK    = 0.005;  // put side STRICTER: price <= vwap*(1-0.005), real break not a touch
const CARVEOUT_MIN_SESSION_MIN   = 30;     // both sides: VWAP unreliable before 30 session-min
// ── #2 drawdown bear trigger (6/26, SHADOW-LOG ONLY — does NOT write _regimeClass).
const BEAR_DD_PCT          = -0.04;  // SPY <= -4% off recent swing high
const BEAR_DD_LOOKBACK     = 5;      // ...measured over a 5-day swing high
const BEAR_VIX_SUSTAINED   = 24;     // ...AND VIX 5d-sustained >= 24
const BEAR_EXIT_DD_PCT     = -0.015; // hysteresis: un-latch when back within -1.5% of swing high
const BEAR_EXIT_VIX        = 22;     // ...OR after BEAR_EXIT_SESSIONS with VIX sustained < 22
const BEAR_EXIT_SESSIONS   = 3;
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
const DAILY_LOSS_LOCK_THRESHOLD = -500;  // 8/03: -300 -> -500. This is now the PRIMARY daily
                                         // guard: C1-B no longer gates entries at all, so the
                                         // dollar-based lock carries the job on its own.
const DAILY_LOSS_LOCK_MIN_SCORE =  85;   // minScore when daily lock is active

// C1-B thresholds
const INSTRUMENT_LOSS_LIMIT     =   2;   // losses on same ticker before per-instrument lock
const INSTRUMENT_LOSS_MIN_SCORE =  90;   // minScore when per-instrument lock is active
const LOSS_THRESHOLD_FOR_COUNTER = -10;  // pnl must be < -$10 to count toward C1-B

// 8/03: EXITS THAT DO NOT COUNT AS "LOSSES" FOR ANY COUNT-BASED BREAKER.
// These fire on a CLOCK, not on price. They close a position that never performed, and the loss
// is bounded by construction — anything that fell to the stop would have exited on the stop
// first, so a timed-exit loss can never exceed a stop loss. On 8/03 two time-cuts worth -$61
// combined pushed QQQ's counter from 1 to 3 and locked it out of the entire afternoon while the
// dollar-based daily lock, the thing that measures real damage, never came close to firing.
// Price-based exits (stop, tiered-stop, dte) and give-backs (trail-floor) still count.
const NON_COUNTING_EXIT_REASONS = ["time-cut", "progress-check"];

// 8/05 (Harrison): PER-LEG HARD STOP. Short DTE is nearly all gamma and theta and cannot wait
// out a drawdown; long DTE can. One stop across bands spanning 2 to 44 DTE was a compromise.
// A band absent from this table falls back to STOP_LOSS_PCT, so "standard" is unchanged.
// NOTE the trail floor arms at breakeven once the confirmed peak reaches +5%, so these stops
// can essentially only fire on positions that never confirmed +5% — see apply_legstop.js.
// ★ biweekly 0.10 is UNMEASURED: only 5 biweekly trades exist and all are from 8/05.
const LEG_STOP_PCT = { sameweek: 0.075, biweekly: 0.10 };

// 8/05: CALL MOMENTUM GATE. The put side requires a conjunction of measured movement before it
// may enter; the call side never has. Over 7/06-8/05 puts went 0% never-green on 25 trades while
// calls went 12% never-green on 193, and no scoring input predicts a call reaching the +12.5%
// rung. This requires at least CALL_MOMENTUM_MIN pieces of directional evidence for a CALL.
// ENFORCE=false means SHADOW ONLY — it logs what it would block and blocks nothing. Set true
// after reading a session of [CALL-MOMO] lines.
// 8/05: STRICT = a true mirror of the put conjunction — opening-range break MANDATORY plus at
// least one confirmation (vwap up / volume pace / breadth up). false falls back to the plain
// CALL_MOMENTUM_MIN count, which is a disjunction and materially weaker. The put side also
// requires episode freshness (<=30min); there is no call-side episode tracker, so that leg is
// deliberately omitted rather than faked — strict mode is still slightly looser than the put gate.
// 8/05: with the gate ENFORCING, a blocked call never opens and its outcome is unrecorded.
// The shadow book restores the counterfactual by tracking the UNDERLYING after each block.
// 8/05 (Harrison): THE MACRO AGENT IS OFF. It has been dead 11 days on API credit, contributes
// "Agent neutral (+0)" to every score, and generated 747 calls with 35 timeouts for nothing.
// This gates callClaudeAgent — the ONE function that makes the request — so all 9 call sites
// short-circuit before any network I/O. agent.js is NOT deleted: four modules import from it and
// updateRegimeState lives there and runs every scan. Set true to bring the agent back.
const AGENT_ENABLED         = false;

const MOMO_SHADOW_MINS      = 30;    // how long to wait before reporting the forward move
const MOMO_SHADOW_MAX       = 200;   // hard cap on tracked entries

const CALL_MOMO_STRICT      = false;   // 8/14: FLIPPED. Strict mode requires OR-high AND >=1 confirm.
                                       // Measured over 1,214 blocks / 3 sessions, those two conditions
                                       // co-occurred ZERO times — they are structurally near-exclusive
                                       // (OR-high = extended above VWAP; breadth-up = broadening off a
                                       // low). 8/12-8/13 fired OR-high 549x with no confirm; 8/14 fired
                                       // breadth-up 93x with almost no OR-high. The conjunction is not a
                                       // high bar, it is an unreachable one, and an unreachable gate is
                                       // not risk control — it is a system that cannot generate evidence.
                                       // Any 1 of 4 (CALL_MOMENTUM_MIN=1) restores the 8/05 behaviour that
                                       // actually traded, and the block ledger now measures whether that
                                       // was right instead of assuming it.
const CALL_MOMENTUM_MIN     = 1;
const CALL_MOMENTUM_ENFORCE = true;    // 8/05 (Harrison): LIVE. Paper money — he chose enforcement
                                       // over one session of shadow counterfactual. Set false to
                                       // return to observe-only without touching any other logic.
// 8/14 RECALIBRATION. Measured over 3 sessions: 552 OR-high blocks, ZERO with any confirmation.
// That is not a filter, it is an off switch — the thresholds were mirrored off the put side without
// checking whether this tape ever reaches them. Observed: breadth momentum logged 0/+2.7/+5.3/+8
// against a +10 bar; VWAP slope flat on a grind. Loosened to values the tape actually produces.
// NOTE: the session-cumulative volPace distribution is NOT known — telemetry does not carry it, so
// 1.2 is a judgement, not a measurement. The ledger now records the RAW values on every block so
// the next tune is empirical rather than another guess.
const CALL_MOMO_SLOPE_MIN   = 0.0002;   // was 0.0005
const CALL_MOMO_VOLPACE_MIN = 1.2;      // was 1.8 — provisional, pending the logged distribution
const CALL_MOMO_BREADTH_MIN = 5;        // was 10 — observed max across 3 sessions was +8

// 8/05: CALL BREAKOUT MODE — the call-side mirror of PUT_BREAKDOWN_MODE (scoring.js). The put path
// wins because every layer expresses one thesis: ride a FRESH, still-progressing intraday breakdown.
// The call path historically did the opposite — it SCORED dips (mean reversion: below-VWAP +9, low-
// breadth +13, oversold bounces) and then, since 8/05, GATED on breakouts, so score and gate fought
// and calls felt like a coin flip. When true, the call side becomes momentum-continuation to match
// the puts: a breakout scoring channel (structural break above the opening-range HIGH + VWAP/breadth
// confirmation, gated on a fresh/progressing _buEpisode) REPLACES the loose dip bonuses, and the
// standalone call-momentum gate in scanner.js stands down because scoring now enforces the same
// requirement. The disciplined capitulation-bounce path is preserved as the call analog of the put's
// overbought fade. Set false to revert instantly: dip bonuses return, the channel goes silent, the
// standalone gate re-arms. The _buEpisode tracker in scanner.js runs regardless (observation is free).
const CALL_BREAKOUT_MODE = false;   // 8/11: REVERTED TO FALSE. Set true on 8/09; the Aug-5 diff shows this one flag
                                    // inverted the entire call thesis at once: it (a) killed the RSI<=25/35/42 oversold
                                    // rewards behind _mrBounceAllowed, (b) switched on the _buDeep/_buEarly/_buConfirmed
                                    // breakout tiers (+21/+18/+12), (c) WAIVED the -15 overbought penalty whenever
                                    // breakout structure was present, (d) zeroed the below-VWAP dip reward, (e) deleted
                                    // the "extended above VWAP" chasing penalty, and (f) stood down the call momentum
                                    // gate at scanner.js:2857. Live result on 8/11: calls bought SPY at RSI 80.2 and QQQ
                                    // at RSI 77.8 — the +18 breakout reward and the waived -15 swung that SPY entry ~33
                                    // points to a score of 86; under Aug-5 scoring it lands ~53, well under MIN_SCORE 70,
                                    // and never fires. Buying extension is the wrong trade for a naked-long intraday book
                                    // with a 3:15 flatten: index up-moves grind, down-moves are fast.

// 8/05: OUTCOME-JOINED TABLE. Observation-only feedback-loop closure — on every FULL close, join
// the entry decision-context (X) to the realized outcome (y: peak%/MAE%/rung-hits/minutes-held/
// P&L) as one flat CSV row → argo:outcomes:<date>. Changes NO trading behavior; it only records.
// This is the (X,y) table that makes signals/gates/thresholds measurable instead of hand-sampled.
// Set false to stop recording (the close path then skips recordOutcome entirely).
const OUTCOME_TABLE_ENABLED = true;

// 8/09: RANGE GOVERNOR (call-only). Five days of telemetry showed the -$1000 loss days (8/05, 8/07)
// had SPY intraday ranges of ~0.5% — no move for a call to reach the +12.5% rung that is the only
// thing that pays — while the green days (8/03, 8/04) had 1.6-3.6%. And trade COUNT was inversely
// coupled to range: APEX fired MOST on the deadest tapes, because calm maxes its call score. This
// throttles CALL entries when the underlying's intraday realized range SO FAR is below a floor,
// evaluated only after enough session has elapsed to judge (range is naturally small at the open).
// SHADOW-FIRST by design (mirrors the momentum gate): ENFORCE=false logs what it would block and
// blocks nothing; the range is recorded on every outcome row (eRangePct) so the floor is set from
// data, not guessed. Flip ENFORCE=true once a few sessions of [RANGE-GOVERNOR] lines confirm it.
const RANGE_GOVERNOR_ENABLED          = true;   // compute + record + shadow-log
const RANGE_GOVERNOR_ENFORCE          = false;  // 8/17: OFF. Of everything added since the Aug 5
                                       // backup, this is the ONLY gate that blocks entries — CALL-MOMO,
                                       // MIN_SCORE 70, the 12.5% stop, STAGGER and the score floors are
                                       // all byte-identical to that build. The fast-cut, u-stop, flat
                                       // sizing and MR-scalp are exits, sizing, or extra channels; none
                                       // of them can stop a trade. So turning this one flag off restores
                                       // Aug-5 ENTRY behaviour exactly, while every measurement file
                                       // (vol, outcomes, efficacy, chain retention, slippage, momo
                                       // ledger) keeps running. That was the trade Harrison wanted: the
                                       // data gathering is the part worth keeping.
                                       // It stays ENABLED (shadow) below — it will still log what it
                                       // WOULD have blocked, so the question "was the governor right?"
                                       // becomes answerable from the outcome table instead of a guess.

                                                // APEX kept firing into it (8/10: 0.25% range, 6 calls, -$66;
                                                // enforcing would have made it $0). Now BLOCKS calls on dead
                                                // tape. Set false to return to shadow.
const RANGE_GOVERNOR_FLOOR_PCT        = 1.0;    // intraday range-so-far (% of session open) below which a call is "dead tape"
const RANGE_GOVERNOR_MIN_SESSION_MIN  = 60;     // only judge after this many session minutes (range builds through the day)

// ── 8/11: DESK-STRUCTURE ITEMS 1/2/3/5 ───────────────────────────────────
// ITEM 3 — SLIPPAGE. contract.premium is overwritten with the Alpaca fill at execution.js:556,
// so the cost basis is correct — but the pre-fill MID is destroyed by that overwrite and
// implementation shortfall becomes unmeasurable. Capturing it is not recoverable after the fact:
// every trade that fills without this is permanently unmeasurable.
const SLIPPAGE_LOG_ENABLED  = true;

// ITEM 1 — UNDERLYING-REFERENCED STOPS. The live leg stops are expressed in OPTION percent
// (sameweek -7.5% / biweekly -10% / standard -12.5%), which map to wildly different market
// events: a 1DTE leg at -7.5% fires on SPY -0.052%, a 40DTE leg at -12.5% needs SPY -0.610%.
// That is a 12x difference in the risk actually being taken while the dashboard shows two
// similar-looking numbers. Expressing the stop as an UNDERLYING move puts every leg on one
// currency. SHADOW until USTOP_ENFORCE — this changes when every position exits.
const USTOP_ENABLED         = true;
const USTOP_ENFORCE         = true;    // 8/14: PROMOTED. Ships WITH the DTE change, deliberately
                                       // breaking the one-flag-per-deploy rule — see
                                       // APEX_PROMOTION_CRITERIA.md. Short DTE on option-percent
                                       // stops is the configuration already known to produce noise
                                       // stop-outs (1DTE at -7.5% fires on SPY -0.052%), so shipping
                                       // them apart means spending a session in a known-bad state.
const USTOP_MOVE_PCT        = 0.0035;  // 0.35% adverse underlying move = stop. Sits between the
                                       // current 1DTE (0.052%) and 40DTE (0.610%) equivalents.
const USTOP_MIN_OPT_PCT     = 0.05;    // floor: never tighter than -5% option move
const USTOP_MAX_OPT_PCT     = 0.30;    // ceiling: never looser than -30% (a runaway delta collapse
                                       // must not translate into an unbounded stop)

// ITEM 2 — GREEK LIMITS. MAX_PORTFOLIO_DELTA was one-sided (a -500 floor, no positive ceiling),
// so an all-call book could run unbounded long delta. MAX_PORTFOLIO_VEGA was computed at
// scanner.js:1178 and never read by anything — a dead limit, same class as EARLY_SPREAD_PCT.
// Limits are in DELTA-DOLLARS (delta x underlying x 100 x contracts) — MARKET EXPOSURE, i.e. how
// much the book moves per unit move in the underlying. Note this deliberately does NOT depend on
// premium: a 1DTE and a 40DTE leg at the same delta have the SAME directional exposure and should
// count equally here. Capital-at-risk is a different budget and is already governed by the heat
// cap; conflating the two is what made raw-delta limits hard to reason about.
const GREEK_LIMITS_ENABLED  = true;
const GREEK_LIMITS_ENFORCE  = false;   // shadow — log breaches before blocking on them
// CALIBRATION WARNING: these are PROVISIONAL. One 0.42-delta SPY contract at 600 is already
// 25,200 delta-$, so a limit of 15,000 would breach on every single position and flood the log.
// With MAX_CONTRACTS=1 and 2-3 concurrent positions, realistic exposure is ~25k-100k. These are
// set wide enough to be non-binding in normal operation and MUST be re-derived from the observed
// distribution (see APEX_PROMOTION_CRITERIA.md, Instrument 4) before GREEK_LIMITS_ENFORCE.
const MAX_DELTA_DOLLARS_POS = 150000;   // long-delta ceiling (provisional)
const MAX_DELTA_DOLLARS_NEG = -150000;  // short-delta floor (provisional)

// ITEM 5 — ALPHA / INSTRUMENT / SIZE SEPARATION. The score currently gates entry, picks side,
// grants slot permission and (until flat sizing) scaled the bet. Four jobs, one number, so any
// bad day produces an identical symptom regardless of which layer failed. Emitting the three
// decisions separately gives attribution. LOG-ONLY — the score still gates exactly as before.
const DECISION_SPLIT_LOG    = true;

// 8/17: NEAR-MISS LEDGER. Records candidates REJECTED at the entry floor, with their features and
// where the underlying went next. APEX has only ever learned from trades it took, which makes the
// floor itself untestable — you cannot ask whether the rejects would have won without keeping them.
// Zero capital at risk; roughly doubles the usable dataset.
const NEARMISS_LEDGER_ENABLED = true;
const VOLPACE_ARM_ENABLED    = true;   // 8/24: split-book. "vf" arm enters only on elevated volume pace.
const MR_FADE_ENABLED        = true;   // 8/24: LITERATURE MR FADE live entry path (mrStrategy.js). KILL SWITCH — set false to instantly stop APEX taking literature MR fades.
const MR_FADE_TP             = 0.30;   // MR-fade take-profit (premium gain) — the reversion to the mean
const MR_FADE_MAX_HOLD_MIN   = 60;     // 8/31 (Harrison): 60-min max hold (was 45)
// 8/28: trailing PROFIT-LOCK. Path data showed fades spiking (+19%, +7.9%, +7.5%) then round-tripping to
// a stop — the fixed +30% TP never triggered and nothing captured the peak. This locks a partial reversion.
// Defaults are principled, NOT curve-fit to the tiny sample; tune the arm down if small peaks keep round-tripping.
const MR_FADE_STOP_PCT           = 0.18;   // 8/28: fade-appropriate hard stop. The shared -12.5% stop was firing
                                           // INSIDE the fades' -13 to -15% underwater zone (mae data) — cutting reversions
                                           // at max adverse before they could bounce. -18% clears the observed dip zone
                                           // (deepest mae -15.4%) so the underwater-first reversion has room. Tunable.
const MR_FADE_TRAIL_ARM_PCT      = 0.10;   // arm the trail once the fade is +10% (below the +30% full TP)
const MR_FADE_TRAIL_GIVEBACK_PCT = 0.05;   // once armed, exit if it gives back 5% from its peak
const VOLPACE_ARM_MIN        = 0;      // absolute floor (0 = off); the percentile below does the gating.
const VOLPACE_ARM_PCTILE     = 50;     // 8/24: vf arm takes signals with volPace >= this ROLLING percentile (50=median). Self-calibrating: adapts to whatever scale volPace runs on (day-1 median was ~0.64, not the old 1.5 guess). Raise toward 75 for a sharper top-quartile test once volume builds.
const VOLPACE_ARM_WINDOW     = 300;    // rolling volPace observations the percentile spans (carries across days)
const VOLPACE_ARM_WARMUP     = 20;     // min observations before the percentile gate activates; before that, vf takes all (collect data)

// 8/17: gzipped session log on the EOD email. Ceiling is deliberately well under the ~25MB most
// providers allow, because base64 inflates by 33% and the other four attachments share the budget.
// Oversized means SKIP the log, never bounce the email.
const LOG_ATTACH_MAX_BYTES  = 8 * 1024 * 1024;

// 8/12: MACRO STALENESS KILL. AGENT_ENABLED=false already stops the Claude call in agent.js:78,
// but getMacroNews() in market.js is a SEPARATE keyword scorer (Alpaca + Marketaux headlines,
// trigger words) and is not gated by it. It kept running and swinging wildly — 8/12 logged
// "strongly bullish +15 (truce, accord, war)" at 11:03 and "bearish -10 (earnings miss,
// downgrade, easing)" at 12:23 — while NONE of those results were ever stamped into
// state._agentMacro. What scoring actually consumed all session was a 22-DAY-OLD
// "mild bearish (-5)". scanner.js labelled it "(32916min stale)" and then passed the modifier
// through anyway. A signal that old is not information, it is a ghost. Beyond this age the
// macro block resolves to neutral instead of carrying a stale tilt into every score.
const MACRO_MAX_AGE_MIN     = 240;   // 4h — longer than a session; anything older is neutralised

// ── 8/11: VOL / SURFACE INFRASTRUCTURE ──────────────────────────────────────
// Turns chain data findContract ALREADY fetches (and used to discard) into the measurements a
// vol desk trades on: realized vol, IV-RV, required-vs-available move. All SHADOW by default.
const VOL_INFRA_ENABLED     = true;    // compute RV / surface / feasibility
const CHAIN_RETAIN_ENABLED  = true;    // keep all evaluated contracts, not just the chosen one
const CHAIN_RETAIN_MAX      = 60;      // cap on retained rows per selection (memory guard)
// NOTE: a spread gate ALREADY EXISTS and is LIVE — execution.js:711 blocks on
// contract.spread > MAX_SPREAD_PCT (0.05). Do NOT add a second one. What is missing is the
// FRAMING: a flat 5% ceiling ignores that the same spend is a very different share of the prize
// by tenor — on a +12.5% target, 5% is ~43% of the edge on a $1.86 1DTE contract and ~10% on an
// $8.26 40DTE one. This logs that share so the flat ceiling can later become a real cost budget.
const SPREAD_COST_LOG       = true;    // log spread as a share of target return (no gating)
const FEASIBILITY_ENABLED   = true;    // required-move vs available-move ratio...
const FEASIBILITY_ENFORCE   = false;   // ...logged only for now
const FEASIBILITY_MAX_RATIO = 1.0;     // >1 = needs a bigger move than the tape delivers
const FEASIBILITY_HOLD_MIN  = 20;      // holding window judged over (median hold ~20min)
// 8/17: EXIT-PATH CHECKPOINTS. Records the position return at fixed elapsed marks so every exit
// rule becomes evaluable after the fact instead of only by live experiment. Pure measurement —
// written in the exit loop, read by nothing that decides anything.
const CHECKPOINTS_ENABLED   = true;
// FROZEN: exitEngine iterates this every scan for every open position and outcomes.js derives its
// column names from it. A module-level array export is a SHARED MUTABLE reference — one stray
// push() anywhere would change the capture marks and the CSV schema simultaneously, mid-session.
const CHECKPOINT_MINS       = Object.freeze([1, 3, 6, 10, 15, 20, 30]);   // minutes held; fast-cut fires at 6
const CHECKPOINT_TOL_MIN    = 1;     // a mark observed later than this is left BLANK, not back-filled

const FLAT_SIZING_ENABLED   = true;    // ITEM 5: kill convictionMult (score-scaled sizing)

// ── 8/11: GENERALIZED FAST-CUT ──────────────────────────────────────────────────────
// The 5-min/+3% fast-cut was built for MR-scalp and gated to it, so every other position fell
// through to the 90-min progress check. Measured: winners reveal fast (peak ~+12% by ~15min),
// losers stall under +3% within ~3min. On 8/11, 12 of 22 trades peaked at EXACTLY +0% and were
// held ~20min to a time-cut. This is the one selector that sits on the right side of the
// information boundary — it discriminates AFTER entry, where the 40-point win-rate spread lives.
const CP1_CRASH_ENABLED      = true;   // 8/24: instant-collapse rail — cut on the 1-min checkpoint
const CP1_CRASH_PCT          = -5;     // cp1 <= -5% => cut. Validated: killed 0/34 eventual +5% recoverers.
const FASTCUT_ENABLED        = false;   // 8/27 (Harrison): KILLED. On 439 ground-truth trades the generalized 6-min fast-cut had 9% WR / capped peaks at +0.5% — it guillotined flat-but-alive trades before they could arm the trail-floor (the one profitable exit, +10.9% avg peak). Clenow: cut on invalidation, not a clock. Downside still bounded by CP1 crash rail (-5% @1min), leg/u-stop, and time-cut. mr-scalp keeps its OWN fast-cut. Set true to restore.
const FASTCUT_MIN            = 6;      // minutes held before judging (scalp uses 5; slightly looser for the slow book)
const FASTCUT_PEAK_SHORT     = 0.03;   // <=8 DTE: needs +3% peak, same bar as the scalp
const FASTCUT_PEAK_MID       = 0.02;   // 9-21 DTE
const FASTCUT_PEAK_LONG      = 0.012;  // >21 DTE: a 40-DTE leg CANNOT print +3% on a typical intraday move —
                                       // a flat threshold would guillotine every standard leg at minute 6, so the
                                       // bar is scaled to what that leg can physically reach.

// ── 8/11: STRUCTURAL BREAK TRIGGER (entry mechanics v2) ──────────────────────────────
// The entry score correlates -0.07..-0.19 with winning and 100+ pts of its range is frozen
// daily weather, so it cannot separate trade from trade. The trigger replaces the "which side"
// and "is there a trade" decisions with an OBSERVED EVENT rather than a prediction.
const BREAK_TRIGGER_ENABLED       = true;    // compute + log the signal every scan
const BREAK_TRIGGER_ENFORCE       = true ;   // when true the trigger SETS the side and GATES entry  // 8/25 TEARDOWN: AUTHORITATIVE — score demoted to carrier
const BREAK_TRIGGER_ALLOW_MRSCALP = true;    // MR-scalp is its own scoreless channel — let it arm under enforce
// ── 8/25: NEGATIVE-GAMMA TREND SLEEVE — literature-aligned instrument for a confirmed break ──
// Sinclair/Natenberg: for a DIRECTIONAL/trend bet, BUY DELTA NOT GAMMA. Deep-ITM (high delta) tracks
// the underlying, minimizes theta as a fraction of premium, and doesn't pay for convexity a trend
// doesn't need. Longer DTE flattens theta further. Moskowitz/Clenow: let the trend RUN (trail, don't
// fast-cut). So a break entry = deep-ITM, longer-DTE, held with a trailing stop — the opposite of the
// 0.35-delta / short-DTE / 6-min-fast-cut naked long that lost.
const BREAK_DELTA                 = 0.70;    // deep ITM: buy delta, not gamma (directional exposure, low theta drag)
const BREAK_DELTA_MIN             = 0.55;    // accept window for the break contract (carves past TARGET_DELTA_MAX 0.42)
const BREAK_DELTA_MAX             = 0.85;
const BREAK_TARGET_DTE            = 7;       // longer DTE flattens daily theta vs the 0-3 DTE default
const BREAK_MAX_HOLD_MIN          = 120;     // let the trend develop (vs 6-min fast-cut); 3:15 cron still flattens
const BREAK_TRAIL_ARM_PCT         = 0.25;    // once up 25%, arm the trailing stop
const BREAK_TRAIL_GIVEBACK_PCT    = 0.15;    // cut if it gives back 15% from the peak (Clenow: lock the trend, let it run)
// ============================================================================
// 8/27: STRATEGY CLASS MAP — the label is the control surface. Every entryStrategy
// declares its lifecycle here; the flatten cron, exit engine, and execution read
// from this instead of hardcoding. Adding a strategy = one row. hold:"swing" +
// flattenExempt:true = holds overnight (exit engine resumes at next open).
// ============================================================================
// 8/31 (Harrison): ratcheting tiered profit-lock, shared by intraday-trend + mr-fade. Each rung's floor
// = the previous rung's trigger, so the lock steps UP as the trade climbs and never backs down (peak only
// rises). Above the top rung it trails the peak. Replaces the single arm/giveback — captures the +7-10%
// peaks that were round-tripping. Ladder: +5%->breakeven, +7.5%->+5%, +8.5%->+7.5%, +10%->+8.5%, ...
const LOCK_LADDER = [
  [0.050, 0.000],
  [0.075, 0.050],
  [0.085, 0.075],
  [0.100, 0.085],
  [0.125, 0.100],
  [0.150, 0.125],
];
const LOCK_LADDER_TRAIL = 0.025;   // above the top rung, floor trails the peak by this
function ladderFloor(peak) {
  if (!(peak >= LOCK_LADDER[0][0])) return null;   // not yet armed
  let floor = LOCK_LADDER[0][1];
  for (const [arm, f] of LOCK_LADDER) { if (peak >= arm) floor = f; }
  const top = LOCK_LADDER[LOCK_LADDER.length - 1];
  if (peak >= top[0]) floor = Math.max(floor, peak - LOCK_LADDER_TRAIL);
  return floor;
}

const STRATEGY_CLASS = {
  "struct-break":         { hold: "intraday", flattenExempt: false },
  "mr-fade-lit":          { hold: "intraday", flattenExempt: false },
  "mr-scalp":             { hold: "intraday", flattenExempt: false },
  "mr":                   { hold: "intraday", flattenExempt: false },
  "breakout-or-context":  { hold: "intraday", flattenExempt: false },
  "trend-swing":          { hold: "swing",    flattenExempt: true  },
  "intraday-trend":       { hold: "intraday", flattenExempt: false },
};
function strategyClass(entryStrategy) { return STRATEGY_CLASS[entryStrategy] || STRATEGY_CLASS["breakout-or-context"]; }
function isFlattenExempt(entryStrategy) { return !!(STRATEGY_CLASS[entryStrategy] && STRATEGY_CLASS[entryStrategy].flattenExempt); }

// ---- TREND-SWING sleeve (daily-momentum, multi-day hold) ----
// Literature: Moskowitz-Ooi-Pedersen time-series momentum (daily trend), Clenow trailing exit,
// Daniel-Moskowitz "momentum crash" overextension filter, Moskowitz-Pedersen vol-scaled sizing.
const TREND_ENABLED       = true;
const TREND_DELTA         = 0.65;   // deep-ITM: buy delta not gamma (Sinclair/Natenberg)
const TREND_DELTA_MIN     = 0.55;
const TREND_DELTA_MAX     = 0.75;
const TREND_TARGET_DTE    = 60;     // ~60 DTE: slow linear theta, respects the monthly-signal timeframe
const TREND_DTE_MIN       = 45;
const TREND_DTE_MAX       = 75;
const TREND_ROLL_DTE      = 21;     // exit/roll before the theta cliff
const TREND_MA_FAST       = 50;     // daily trend: price > 50d, 50d > 100d
const TREND_MA_SLOW       = 100;
const TREND_RSI_MIN       = 50;     // daily RSI: trending, not exhausted
const TREND_RSI_MAX       = 72;
const TREND_OVEREXT_ATR   = 4.0;    // max daily-ATRs above the 50d before it's overextended (momentum-crash zone)
const TREND_BREADTH_MIN   = 52;     // trend needs participation
const TREND_CUTOFF_ET     = 15.0;   // no NEW swing entries after 3pm ET
const TREND_RISK_BUDGET   = 0.01;   // 1% of equity risked per swing trade -> vol-scaled contract count
const TREND_TRAIL_ARM_PCT = 0.10;   // arm the trail once +10%
const TREND_STOP_UNDL_PCT = 0.025;  // (alt) hard floor as an UNDERLYING move — available if the option-% floor proves too tight
const TREND_STOP_PCT      = 0.125;  // -12.5% option hard floor (Harrison)
const TREND_TRAIL_GIVEBACK_PCT = 0.05;   // incremental profit-lock: give back 5% from peak once armed
// ---- INTRADAY-TREND sleeve (same-day directional; ORB + VWAP + ADX confluence, no score) ----
// NOTE: the underlying-tape test (8/24-27) showed intraday trend-continuation does NOT continue
// (de-meaned edge negative, ~44% continuation). This sleeve is a DELIBERATE paper experiment,
// gated hard on ADX>=25 (the subpopulation most likely to trend) + a real opening-range break,
// fully instrumented so forward fills settle whether the edge exists. Kill: ITREND_ENABLED=false.
const ITREND_ENABLED      = true;
const ITREND_DELTA        = 0.50;   // ATM-ish: responsiveness for a same-day move (not deep-ITM)
const ITREND_DELTA_MIN    = 0.42;
const ITREND_DELTA_MAX    = 0.60;
const ITREND_TARGET_DTE   = 14;
const ITREND_DTE_MIN      = 10;
const ITREND_DTE_MAX      = 21;
const ITREND_ADX_MIN      = 25;     // trend-strength floor — telemetry p50=22, so this keeps the top ~42% (out of the chop)
const ITREND_VWAP_MIN     = 0.05;   // |vwap%| floor — clearly on one side of VWAP (p50 dist = 0.09%)
const ITREND_BREADTH_STRONG = 55;   // soft breadth: block only when breadth is actively AGAINST (fail-open at neutral)
const ITREND_START_ET     = 10.0;   // after OR locks (9:45) + let the trend establish
const ITREND_END_ET       = 13.5;   // no new entries after 1:30pm ET (Gao et al. morning-window; reversals cluster late)
const ITREND_TRAIL_ARM_PCT      = 0.15;
const ITREND_TRAIL_GIVEBACK_PCT = 0.07;
const ITREND_STOP_PCT     = 0.30;   // hard floor (0.50-delta 14-DTE is more volatile than deep-ITM)
const ITREND_MAX_HOLD_MIN = 60;     // 8/31 (Harrison): 60-min max hold — peaks come fast then decay all day
const ITREND_COOLDOWN_MIN = 30;     // 8/28 (panel): the OR condition is a STATE not an event, so a sustained trend
                                    // could re-fire right after an exit. Cooldown bounds re-entry churn per ticker.
const GEX_FETCH_ENABLED           = true;    // 8/26: dedicated both-sides near-expiry GEX chain fetch (feeds the regime switch)
const GEX_FETCH_THROTTLE_MS       = 120000;  // per-ticker: refetch the gamma chain at most every 2 min
const BREAK_ENTRY_SCORE           = 80;      // fixed stamp a break entry carries; clears MIN_SCORE(70)+slot2(75), NOT slot3(85). NOT a quality measure.
const BREAK_CONFIRM_BARS          = 1;       // bars after the break bar that must not reclaim the level
const BREAK_MAX_AGE_MIN           = 10;      // signal is stale after this many minutes
const BREAK_VOL_LOOKBACK          = 10;      // bars in the trailing volume average
const BREAK_VOL_MULT_PUT          = 1.8;     // break-bar volume vs trailing average
const BREAK_VOL_MULT_CALL         = 2.2;     // calls stricter — up-moves grind, they need more force
const BREAK_ADX_MIN_PUT           = 18;
const BREAK_ADX_MIN_CALL          = 22;
const BREAK_VWAP_SLOPE_MIN        = 0.0002;  // |VWAP slope| required in the break direction
const BREAK_MAX_EXT_PCT           = 0.006;   // do not chase: max distance past the level at signal time
const BREAK_CALL_CUTOFF_ET        = 12.0;    // breakout calls are morning-only
const BREAK_MIN_SESSION_MIN       = 16;      // _openRange locks at 15 session minutes

// 8/17: the 1.0% floor was calibrated when APEX bought 40-DTE legs, where it was correct — a
// 40DTE contract needs ~0.50% of underlying movement to reach the +12.5% rung, so a sub-1% day
// genuinely cannot pay. At 3 DTE the required move drops to ~0.11% and the SAME tape becomes
// tradeable. Observed 8/17: QQQ range 0.35% projecting to a 0.72% day — blocked by the governor,
// yet feasRatio 0.70 at 3DTE (feasible) vs 3.08 at 44DTE (hopeless). The floor is a property of
// the INSTRUMENT, not of the tape, so it is now derived from DTE rather than fixed. Required move
// scales ~with premium, which scales ~sqrt(DTE): floor = FLOOR_PCT * sqrt(targetDTE / REF_DTE).
// At 40 DTE that reproduces 1.00% exactly; at 3 DTE it gives 0.27%.
const RANGE_GOVERNOR_REF_DTE          = 40;    // the tenor the 1.0% floor was calibrated against
const RANGE_GOVERNOR_FULL_SESSION_MIN = 390;    // 8/11: full RTH session length in minutes (9:30-4:00 ET) — denominator for the sqrt(elapsed) pro-rating of the floor

// 8/09: MR-SCALP CALL — a disciplined mean-reversion CALL scalp that runs LIVE alongside breakout
// calls, tagged entryStrategy="mr-scalp". Thesis (options-MR expert spec): the ONLY fast up-move on
// an index is the SNAP after a genuine capitulation flush, so require deep capitulation + a confirmed
// turn, buy the LOWEST-vega structure (0-1 DTE, 0.42Δ) to dodge the IV-collapse-on-bounce trap, and
// exit FAST (5-min fast-cut is the core edge) rather than riding the slow-book trail. Every number is
// tunable and A/B-measured vs breakout via the outcome table's entryStrategy column.
// DEFERRED from v1 (documented): the 50% scale-out at +10% (needs partialClose) and the VIX-downtick
// entry gate (needs prev-scan VIX; flagged low-confidence, may over-suppress) — add once v1 proves out.
const MR_SCALP_ENABLED          = true;
// ── entry (all AND-ed; index only, Regime A/neutral) ──
const MR_SCALP_SESSLOW_RSI_MAX  = 32;     // session must have printed intraday RSI <= this (genuine capitulation). tune 30-35
const MR_SCALP_FLUSH_DD_MIN     = 0.007;  // >= 0.7% drawdown off the session HIGH (a real flush, not noise)
const MR_SCALP_VWAP_EXT_MIN     = 0.005;  // price <= VWAP*(1-0.005): >=0.5% below own VWAP (extension, not a grind)
const MR_SCALP_LIFTOFF_PTS      = 4;      // intraday RSI lifted >= this off session low (the turn has STARTED)
const MR_SCALP_LOW_AGE_MIN_MIN  = 3;      // session low >= this many min old (not a NEW low right now — anti falling-knife)
const MR_SCALP_LOW_AGE_MAX_MIN  = 25;     // and <= this (fresh flush; a stale low is a dead cat)
const MR_SCALP_RANGE_MIN_PCT    = 0.6;    // intraday range-so-far >= this % (dead-day veto)
const MR_SCALP_VIX_MIN                = 17;    // 8/11: 20 -> 17. The scalp never armed: on 8/11 VIX ran 19.37-19.49 all
                                               // session, so a 22-constant subsystem with its own fast-exit regime sat
                                               // inert while the breakout path fired 22 trades. The scalp's edge lives in
                                               // its ELEVEN other conditions (capitulation RSI, flush depth, VWAP
                                               // extension, liftoff, low-age window, corroboration, no-knife, range,
                                               // session-age, time cutoff, Regime A); the VIX floor was a coarse proxy for
                                               // "enough vol to snap" that those conditions already establish directly.
                                               // 17 keeps it out of genuinely dead-vol tape without blacking out the
                                               // 17-20 band where this regime actually trades.
const MR_SCALP_SESSION_MIN_MIN  = 30;     // VWAP unreliable before this many session minutes
const MR_SCALP_CUTOFF_ET        = 14.5;   // no NEW mr-scalp entry after 2:30pm ET (needs ~14min to work + exit before 3:15 flatten)
const MR_SCALP_MIN_SCORE        = 78;     // floor the setup clears (also clears slot-2's 75); the CONDITIONS are the edge, not the score
// ── instrument / size ──
const MR_SCALP_TARGET_DTE       = 1;      // 0-1 DTE = lowest vega (dodges IV collapse) + highest gamma (captures the fast pop)
const MR_SCALP_DELTA            = 0.42;   // high delta = more intrinsic, less vega share; avoid the 0.30 ATM max-crush strike
const MR_SCALP_SIZE_MOD         = 0.5;    // half size until it proves out (base hit-rate ~19%, unproven)
// ── exit (override the slow-book trail/time-cut for these positions) ──
const MR_SCALP_FASTCUT_MIN      = 5;      // at this many min held...
const MR_SCALP_FASTCUT_PEAK     = 0.03;   // ...if peak gain < +3%, exit — the highest-leverage rule (kills grinders early)
const MR_SCALP_GIVEBACK_PEAK    = 0.08;   // if the position peaked >= +8%...
const MR_SCALP_GIVEBACK_FRAC    = 0.5;    // ...and has given back below 50% of that peak gain, exit (protect the spike)
const MR_SCALP_TRAIL_ARM        = 0.10;   // once confirmed peak >= +10%...
const MR_SCALP_TRAIL_GIVE       = 0.04;   // ...trail at peak - 4pts (tighter than Schedule A)
const MR_SCALP_TP               = 0.20;   // hard take-profit — bank a big pop outright

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
  ALPACA_OPT_SNAP, ALPACA_NEWS, OPTION_FEED, GMAIL_USER, RESEND_API_KEY,
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL, REDIS_URL, REDIS_TOKEN, REDIS_KEY,
  REDIS_SAVE_INTERVAL, MARKETAUX_KEY, MONTHLY_BUDGET, DEFAULT_VIX, CAPITAL_FLOOR,
  REVENUE_THRESHOLD, BONUS_AMOUNT, MAX_HEAT, MAX_SECTOR_PCT, DATA_GATHER_MODE,
  STOP_LOSS_PCT, FAST_STOP_PCT, FAST_STOP_HOURS, TAKE_PROFIT_PCT,
  PARTIAL_CLOSE_PCT, TRAIL_ACTIVATE_PCT, TRAIL_STOP_PCT, BREAKEVEN_LOCK_PCT,
  RIDE_TARGET_PCT, TIME_STOP_DAYS, TIME_STOP_MOVE, IV_COLLAPSE_PCT,
  MA50_BUFFER, MACRO_REVERSAL_PCT, MIN_SCORE, MIN_SCORE_CREDIT, MIN_SCORE_MR, IVR_MAX,
  MACD_HIST_STRONG_ATR, MR_BOUNCE_RSI_OFFLOW, MR_BOUNCE_VWAP_TOL,
  MR_INTRA_LIFTOFF_PTS, MR_INTRA_SESSLOW_MAX,
  MR_FLUSH_DD1, MR_FLUSH_DD2, MR_FLUSH_DD3,
  MR_SESSLOW_RECENCY_MIN,
  EARNINGS_SKIP_DAYS, MIN_OPEN_INTEREST, MIN_STOCK_PRICE, MIN_OPTION_PREMIUM,
  MIN_OI, MAX_SPREAD_PCT, EARLY_SPREAD_PCT, LIVE_WIDE_SPREAD_PCT, MAX_GAP_PCT, GAP_MIN_PCT,
  CARVEOUT_BREADTH_MOM_MIN, CARVEOUT_CALL_VWAP_MAX, CARVEOUT_PUT_BREADTH_MOM, CARVEOUT_PUT_VWAP_BREAK, CARVEOUT_MIN_SESSION_MIN,
  BEAR_DD_PCT, BEAR_DD_LOOKBACK, BEAR_VIX_SUSTAINED, BEAR_EXIT_DD_PCT, BEAR_EXIT_VIX, BEAR_EXIT_SESSIONS,
  TARGET_DELTA_MIN,
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
  NON_COUNTING_EXIT_REASONS,
  LEG_STOP_PCT,
  CALL_MOMENTUM_MIN, CALL_MOMENTUM_ENFORCE, CALL_MOMO_STRICT,
  MOMO_SHADOW_MINS, MOMO_SHADOW_MAX, AGENT_ENABLED,
  CALL_MOMO_SLOPE_MIN, CALL_MOMO_VOLPACE_MIN, CALL_MOMO_BREADTH_MIN,
  CALL_BREAKOUT_MODE, OUTCOME_TABLE_ENABLED,
  RANGE_GOVERNOR_ENABLED, RANGE_GOVERNOR_ENFORCE, RANGE_GOVERNOR_FLOOR_PCT, RANGE_GOVERNOR_MIN_SESSION_MIN,
  RANGE_GOVERNOR_FULL_SESSION_MIN, RANGE_GOVERNOR_REF_DTE,
  CP1_CRASH_ENABLED, CP1_CRASH_PCT,
  FASTCUT_ENABLED, FASTCUT_MIN, FASTCUT_PEAK_SHORT, FASTCUT_PEAK_MID, FASTCUT_PEAK_LONG,
  VOL_INFRA_ENABLED, CHAIN_RETAIN_ENABLED, CHAIN_RETAIN_MAX, SPREAD_COST_LOG,
  FEASIBILITY_ENABLED, FEASIBILITY_ENFORCE, FEASIBILITY_MAX_RATIO, FEASIBILITY_HOLD_MIN,
  FLAT_SIZING_ENABLED, SLIPPAGE_LOG_ENABLED, CHECKPOINTS_ENABLED, CHECKPOINT_MINS, CHECKPOINT_TOL_MIN,
  USTOP_ENABLED, USTOP_ENFORCE, USTOP_MOVE_PCT, USTOP_MIN_OPT_PCT, USTOP_MAX_OPT_PCT,
  GREEK_LIMITS_ENABLED, GREEK_LIMITS_ENFORCE, MAX_DELTA_DOLLARS_POS, MAX_DELTA_DOLLARS_NEG,
  DECISION_SPLIT_LOG, MACRO_MAX_AGE_MIN, NEARMISS_LEDGER_ENABLED, LOG_ATTACH_MAX_BYTES,
  VOLPACE_ARM_ENABLED, VOLPACE_ARM_MIN, VOLPACE_ARM_PCTILE, VOLPACE_ARM_WINDOW, VOLPACE_ARM_WARMUP, MR_FADE_ENABLED, MR_FADE_TP, MR_FADE_MAX_HOLD_MIN, MR_FADE_STOP_PCT, MR_FADE_TRAIL_ARM_PCT, MR_FADE_TRAIL_GIVEBACK_PCT,
  BREAK_TRIGGER_ENABLED, BREAK_TRIGGER_ENFORCE, BREAK_TRIGGER_ALLOW_MRSCALP, BREAK_ENTRY_SCORE,
  BREAK_CONFIRM_BARS, BREAK_MAX_AGE_MIN, BREAK_VOL_LOOKBACK, BREAK_VOL_MULT_PUT, BREAK_VOL_MULT_CALL,
  BREAK_ADX_MIN_PUT, BREAK_ADX_MIN_CALL, BREAK_VWAP_SLOPE_MIN, BREAK_MAX_EXT_PCT,
  BREAK_CALL_CUTOFF_ET, BREAK_MIN_SESSION_MIN,
  MR_SCALP_ENABLED, MR_SCALP_SESSLOW_RSI_MAX, MR_SCALP_FLUSH_DD_MIN, MR_SCALP_VWAP_EXT_MIN,
  MR_SCALP_LIFTOFF_PTS, MR_SCALP_LOW_AGE_MIN_MIN, MR_SCALP_LOW_AGE_MAX_MIN, MR_SCALP_RANGE_MIN_PCT,
  MR_SCALP_VIX_MIN, MR_SCALP_SESSION_MIN_MIN, MR_SCALP_CUTOFF_ET, MR_SCALP_MIN_SCORE,
  MR_SCALP_TARGET_DTE, MR_SCALP_DELTA, MR_SCALP_SIZE_MOD,
  BREAK_DELTA, BREAK_DELTA_MIN, BREAK_DELTA_MAX, BREAK_TARGET_DTE, BREAK_MAX_HOLD_MIN, BREAK_TRAIL_ARM_PCT, BREAK_TRAIL_GIVEBACK_PCT,
  GEX_FETCH_ENABLED, GEX_FETCH_THROTTLE_MS,
  STRATEGY_CLASS, strategyClass, isFlattenExempt, LOCK_LADDER, LOCK_LADDER_TRAIL, ladderFloor,
  TREND_ENABLED, TREND_DELTA, TREND_DELTA_MIN, TREND_DELTA_MAX, TREND_TARGET_DTE, TREND_DTE_MIN, TREND_DTE_MAX,
  TREND_ROLL_DTE, TREND_MA_FAST, TREND_MA_SLOW, TREND_RSI_MIN, TREND_RSI_MAX, TREND_OVEREXT_ATR, TREND_BREADTH_MIN,
  TREND_CUTOFF_ET, TREND_RISK_BUDGET, TREND_TRAIL_ARM_PCT, TREND_STOP_UNDL_PCT, TREND_STOP_PCT, TREND_TRAIL_GIVEBACK_PCT,
  ITREND_ENABLED, ITREND_DELTA, ITREND_DELTA_MIN, ITREND_DELTA_MAX, ITREND_TARGET_DTE, ITREND_DTE_MIN, ITREND_DTE_MAX,
  ITREND_ADX_MIN, ITREND_VWAP_MIN, ITREND_BREADTH_STRONG, ITREND_START_ET, ITREND_END_ET,
  ITREND_TRAIL_ARM_PCT, ITREND_TRAIL_GIVEBACK_PCT, ITREND_STOP_PCT, ITREND_COOLDOWN_MIN, ITREND_MAX_HOLD_MIN,
  MR_SCALP_FASTCUT_MIN, MR_SCALP_FASTCUT_PEAK, MR_SCALP_GIVEBACK_PEAK, MR_SCALP_GIVEBACK_FRAC,
  MR_SCALP_TRAIL_ARM, MR_SCALP_TRAIL_GIVE, MR_SCALP_TP,
  HIGH_RISK_MIN_SCORE,
  WEEKLY_LOSS_LIMIT, MONTHLY_LOSS_LIMIT,
};
