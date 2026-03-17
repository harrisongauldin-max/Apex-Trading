// -
// APEX v3.5 - Professional Options Trading Agent
// Alpaca Paper Trading Edition
// -
const express    = require("express");
const cron       = require("node-cron");
const fetch      = require("node-fetch");
const fs         = require("fs");
const path       = require("path");
const nodemailer = require("nodemailer");

const app  = express();
const PORT = process.env.PORT || 3000;

// - Environment Variables (set in Railway) -
const ALPACA_KEY        = process.env.ALPACA_API_KEY    || "";
const ALPACA_SECRET     = process.env.ALPACA_SECRET_KEY || "";
const ALPACA_BASE       = "https://paper-api.alpaca.markets/v2";
const ALPACA_DATA       = "https://data.alpaca.markets/v2";
const ALPACA_OPTIONS    = "https://paper-api.alpaca.markets/v2";    // confirmed: options contracts
const ALPACA_OPT_SNAP   = "https://data.alpaca.markets/v1beta1";    // confirmed: options snapshots/greeks
const GMAIL_USER        = process.env.GMAIL_USER        || "";
const GMAIL_PASS        = process.env.GMAIL_APP_PASSWORD|| "";
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
const TAKE_PROFIT_PCT     = 0.65;
const PARTIAL_CLOSE_PCT   = 0.50;
const TRAIL_ACTIVATE_PCT  = 0.30;   // start trailing at +30%
const TRAIL_STOP_PCT      = 0.15;   // trail 15% below peak
const BREAKEVEN_LOCK_PCT  = 0.40;   // lock to breakeven at +40%
const RIDE_TARGET_PCT     = 1.00;   // let remainder ride to +100%
const TIME_STOP_DAYS      = 7;
const TIME_STOP_MOVE      = 0.05;
const IV_COLLAPSE_PCT     = 0.30;
const MA50_BUFFER         = 0.01;
const IVR_MAX             = 70;
const EARNINGS_SKIP_DAYS  = 5;
const MIN_OPTIONS_VOLUME  = 10000;
const MIN_OPEN_INTEREST   = 500;
const MIN_STOCK_PRICE     = 20;
const MAX_SPREAD_PCT      = 0.10;
const MAX_GAP_PCT         = 0.03;
const TARGET_DELTA_MIN    = 0.28;
const TARGET_DELTA_MAX    = 0.42;
// MAX_TRADES_PER_DAY removed - portfolio heat (60%) controls position limits
const CONSEC_LOSS_LIMIT   = 3;
const WEEKLY_DD_LIMIT     = 0.25;
const MAX_LOSS_PER_TRADE  = 400;
const MIN_SCORE           = 70;
const FULL_KELLY_SCORE    = 85;
const ENTRY_START_HOUR    = 10;     // 10:00 AM ET
const ENTRY_END_HOUR      = 15;     // 3:30 PM ET
const ENTRY_END_MIN       = 30;
const STOCK_PROFIT_THRESH = 1000;   // monthly profit threshold for stock buys
const STOCK_ALLOC_PCT     = 0.20;   // 20% of profits above threshold
const MAX_STOCK_PCT       = 0.30;   // max 30% of account in stocks
const STOCK_STOP_PCT      = 0.15;   // -15% stop on stock positions

// Cash ETF parking - floor is split 50/50 between liquid and BIL
const CASH_ETF             = "BIL";     // 1-3 Month T-Bill ETF
const CASH_ETF_FLOOR_PCT   = 0.50;      // 50% of capital floor parked in BIL
const CASH_ETF_TARGET      = CAPITAL_FLOOR * 0.50;  // $1,500 in BIL at all times
const CASH_ETF_MIN         = 100;       // minimum rebalance threshold

// VIX tiers
const VIX_NORMAL    = 20;
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

// Correlation groups - max 1 position per group
const CORRELATION_GROUPS = [
  ["NVDA", "AMD", "SMCI", "ARM"],   // Semiconductors
  ["AAPL", "MSFT", "GOOGL", "CRM"], // Mega-cap tech
  ["AMZN", "META"],                  // Ad/cloud
  ["JPM", "GS", "COIN"],             // Financials
  ["TSLA", "UBER"],                  // Consumer mobility
];

// Sector ETF confirmation map
const SECTOR_ETF_MAP = {
  "Technology": "XLK",
  "Financial":  "XLF",
  "Consumer":   "XLY",
  "Index":      null,  // no confirmation needed for indexes
};
// Always check SMH for semiconductor stocks
const SEMIS = ["NVDA", "AMD", "SMCI", "ARM"];

// - Watchlist (18 high-liquidity stocks) -
const WATCHLIST = [
  { ticker:"NVDA",  sector:"Technology",  momentum:"strong",     rsi:58, macd:"bullish crossover", trend:"above 50MA",         catalyst:"AI infrastructure demand",      expiryDays:14,  ivr:52, beta:1.8, earningsDate:null },
  { ticker:"AAPL",  sector:"Technology",  momentum:"steady",     rsi:52, macd:"mild bullish",      trend:"above all MAs",      catalyst:"Services revenue growth",        expiryDays:42,  ivr:28, beta:1.1, earningsDate:null },
  { ticker:"MSFT",  sector:"Technology",  momentum:"strong",     rsi:56, macd:"bullish",           trend:"above all MAs",      catalyst:"Copilot enterprise adoption",    expiryDays:35,  ivr:30, beta:1.2, earningsDate:null },
  { ticker:"AMZN",  sector:"Technology",  momentum:"strong",     rsi:61, macd:"bullish",           trend:"above 50MA",         catalyst:"AWS acceleration",               expiryDays:28,  ivr:35, beta:1.3, earningsDate:null },
  { ticker:"META",  sector:"Technology",  momentum:"strong",     rsi:63, macd:"bullish",           trend:"trending up",        catalyst:"AI ad revenue momentum",         expiryDays:28,  ivr:40, beta:1.4, earningsDate:null },
  { ticker:"GOOGL", sector:"Technology",  momentum:"steady",     rsi:54, macd:"mild bullish",      trend:"above 50MA",         catalyst:"Search + cloud strength",        expiryDays:35,  ivr:32, beta:1.2, earningsDate:null },
  { ticker:"TSLA",  sector:"Consumer",    momentum:"recovering", rsi:44, macd:"neutral",           trend:"testing 200MA",      catalyst:"Q1 delivery data",               expiryDays:56,  ivr:61, beta:2.0, earningsDate:null },
  { ticker:"AMD",   sector:"Technology",  momentum:"recovering", rsi:47, macd:"forming base",      trend:"near 50MA",          catalyst:"MI300X server demand",           expiryDays:56,  ivr:55, beta:1.7, earningsDate:null },
  { ticker:"SPY",   sector:"Index",       momentum:"steady",     rsi:53, macd:"neutral",           trend:"near all-time high", catalyst:"Fed policy direction",           expiryDays:14,  ivr:22, beta:1.0, earningsDate:null },
  { ticker:"QQQ",   sector:"Index",       momentum:"steady",     rsi:55, macd:"mild bullish",      trend:"above 50MA",         catalyst:"Tech sector leadership",         expiryDays:14,  ivr:24, beta:1.1, earningsDate:null },
  { ticker:"JPM",   sector:"Financial",   momentum:"strong",     rsi:57, macd:"bullish",           trend:"above all MAs",      catalyst:"Net interest income strength",   expiryDays:28,  ivr:28, beta:1.1, earningsDate:null },
  { ticker:"GS",    sector:"Financial",   momentum:"strong",     rsi:59, macd:"bullish",           trend:"above 50MA",         catalyst:"Investment banking recovery",    expiryDays:28,  ivr:30, beta:1.3, earningsDate:null },
  { ticker:"NFLX",  sector:"Consumer",    momentum:"strong",     rsi:60, macd:"bullish",           trend:"trending up",        catalyst:"Ad-supported tier growth",       expiryDays:28,  ivr:38, beta:1.4, earningsDate:null },
  { ticker:"CRM",   sector:"Technology",  momentum:"steady",     rsi:51, macd:"mild bullish",      trend:"above 50MA",         catalyst:"AI CRM integration",             expiryDays:42,  ivr:33, beta:1.3, earningsDate:null },
  { ticker:"UBER",  sector:"Consumer",    momentum:"strong",     rsi:58, macd:"bullish",           trend:"above all MAs",      catalyst:"Profitability milestone",        expiryDays:28,  ivr:35, beta:1.5, earningsDate:null },
  { ticker:"ARM",   sector:"Technology",  momentum:"strong",     rsi:62, macd:"bullish crossover", trend:"trending up",        catalyst:"AI chip architecture demand",    expiryDays:21,  ivr:58, beta:1.9, earningsDate:null },
  { ticker:"COIN",  sector:"Financial",   momentum:"recovering", rsi:48, macd:"forming base",      trend:"near 50MA",          catalyst:"Crypto market recovery",         expiryDays:42,  ivr:65, beta:2.2, earningsDate:null },
  { ticker:"SMCI",  sector:"Technology",  momentum:"recovering", rsi:45, macd:"neutral",           trend:"testing 50MA",       catalyst:"AI server infrastructure",       expiryDays:42,  ivr:60, beta:2.1, earningsDate:null },
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
  };
}

// - Redis Helpers -
async function redisSave(data) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    // Fallback to file if Redis not configured
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
    return;
  }
  try {
    await fetch(`${REDIS_URL}/set/${REDIS_KEY}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(data) })
    });
  } catch(e) { console.error("Redis save error:", e.message); }
}

async function redisLoad() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    // Fallback to file
    try {
      if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch(e) {}
    return null;
  }
  try {
    const res  = await fetch(`${REDIS_URL}/get/${REDIS_KEY}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    if (data && data.result) return JSON.parse(data.result);
  } catch(e) { console.error("Redis load error:", e.message); }
  return null;
}

// saveState is now async - writes to Redis
async function saveState() {
  await redisSave(state);
}

// State initialized async on startup
let state = defaultState();
async function initState() {
  const saved = await redisLoad();
  if (saved) {
    state = { ...defaultState(), ...saved };
    console.log("State loaded from Redis | cash:", state.cash, "| positions:", state.positions.length);
  } else {
    console.log("No saved state found - starting fresh");
  }
  // Apply custom budget if set
  if (state.customBudget && state.customBudget > 0) {
    state.cash = state.customBudget;
  }
}

function logEvent(type, message) {
  const entry = { time: new Date().toISOString(), type, message };
  state.tradeLog.unshift(entry);
  if (state.tradeLog.length > 500) state.tradeLog = state.tradeLog.slice(0, 500);
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
async function getDynamicSignals(ticker, bars) {
  const rsi      = calcRSI(bars);
  const macd     = calcMACD(bars);
  const momentum = calcMomentum(bars);
  const adx      = calcADX(bars);
  // Approximate current IV from recent price action
  const recentBars = bars.slice(-20);
  const returns    = recentBars.slice(1).map((b, i) => Math.log(b.c / recentBars[i].c));
  const stdDev     = Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length);
  const currentIV  = stdDev * Math.sqrt(252);
  const ivr        = calcIVRank(currentIV, bars);
  return { rsi, macd: macd.signal, momentum, adx, ivr };
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
      type:        "Call Option",
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

function isEntryWindow() {
  const et = getETTime();
  const h = et.getHours(), m = et.getMinutes();
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false; // no weekends
  return (h > ENTRY_START_HOUR || (h === ENTRY_START_HOUR && m >= 0)) &&
         (h < ENTRY_END_HOUR   || (h === ENTRY_END_HOUR && m <= ENTRY_END_MIN));
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

function calcGreeks(price, strike, daysToExpiry, iv) {
  const t   = Math.max(daysToExpiry, 1) / 365;
  const d1  = (Math.log(price/strike) + (0.05 + iv*iv/2)*t) / (iv*Math.sqrt(t));
  const nd1 = Math.exp(-d1*d1/2) / Math.sqrt(2*Math.PI);
  const Nd1 = 0.5*(1+erf(d1/Math.sqrt(2)));
  return {
    delta: parseFloat(Math.max(0.01, Math.min(0.99, Nd1)).toFixed(3)),
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

  // RSI sweet spot 50-65 (15pts)
  if (stock.rsi >= 50 && stock.rsi <= 65)   { score += 15; reasons.push(`RSI ${stock.rsi} in sweet spot (+15)`); }
  else if (stock.rsi >= 45 && stock.rsi < 50){ score += 8; reasons.push(`RSI ${stock.rsi} near zone (+8)`); }
  else                                       { reasons.push(`RSI ${stock.rsi} outside zone (+0)`); }

  // MACD (15pts)
  if (stock.macd.includes("bullish crossover")) { score += 15; reasons.push("MACD bullish crossover (+15)"); }
  else if (stock.macd.includes("bullish"))      { score += 10; reasons.push("MACD bullish (+10)"); }
  else if (stock.macd.includes("forming"))      { score += 5;  reasons.push("MACD forming base (+5)"); }
  else                                          { reasons.push("MACD neutral (+0)"); }

  // IVR (15pts) - lower is better for buying calls
  if (stock.ivr < 30)       { score += 15; reasons.push(`IVR ${stock.ivr} - cheap options (+15)`); }
  else if (stock.ivr < 50)  { score += 10; reasons.push(`IVR ${stock.ivr} - moderate (+10)`); }
  else if (stock.ivr < 65)  { score += 5;  reasons.push(`IVR ${stock.ivr} - elevated (+5)`); }
  else                      { reasons.push(`IVR ${stock.ivr} - expensive (+0)`); }

  // Catalyst (15pts)
  if (stock.catalyst)       { score += 15; reasons.push(`Catalyst: ${stock.catalyst} (+15)`); }

  // Volume confirmation (10pts)
  if (volume && avgVolume && volume > avgVolume * 1.2) { score += 10; reasons.push("Above-avg volume (+10)"); }
  else if (volume && avgVolume && volume > avgVolume)  { score += 5;  reasons.push("Average volume (+5)"); }
  else                                                 { reasons.push("Low volume (+0)"); }

  // Relative strength vs SPY (10pts)
  if (relStrength > 1.05)      { score += 10; reasons.push(`RS vs SPY: +${((relStrength-1)*100).toFixed(1)}% (+10)`); }
  else if (relStrength > 1.0)  { score += 5;  reasons.push(`RS vs SPY: +${((relStrength-1)*100).toFixed(1)}% (+5)`); }
  else                         { reasons.push(`RS vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+0)`); }

  // ADX bonus (not in original 100 but adds quality signal)
  if (adx && adx > 25)  { score += 5; reasons.push(`ADX ${adx} - strong trend (+5)`); }

  return { score: Math.min(score, 100), reasons };
}

// - Put Setup Scoring -
// Mirror of scoreSetup but for bearish setups - looks for opposite signals
function scorePutSetup(stock, relStrength, adx, volume, avgVolume) {
  let score = 0;
  const reasons = [];

  // Momentum - weak is good for puts (20pts)
  if (stock.momentum === "recovering")       { score += 20; reasons.push("Weak momentum - bearish (+20)"); }
  else if (stock.momentum === "steady")      { score += 10; reasons.push("Neutral momentum (+10)"); }
  else                                       { score += 0;  reasons.push("Strong momentum - bad for put (+0)"); }

  // RSI overbought 70+ or falling from high (15pts)
  if (stock.rsi >= 72)                       { score += 15; reasons.push(`RSI ${stock.rsi} - overbought (+15)`); }
  else if (stock.rsi >= 65 && stock.rsi < 72){ score += 8;  reasons.push(`RSI ${stock.rsi} - elevated (+8)`); }
  else if (stock.rsi <= 45)                  { score += 5;  reasons.push(`RSI ${stock.rsi} - oversold caution (+5)`); }
  else                                       { reasons.push(`RSI ${stock.rsi} neutral for put (+0)`); }

  // MACD bearish (15pts)
  if (stock.macd.includes("bearish crossover")) { score += 15; reasons.push("MACD bearish crossover (+15)"); }
  else if (stock.macd.includes("bearish"))      { score += 10; reasons.push("MACD bearish (+10)"); }
  else if (stock.macd.includes("neutral"))      { score += 5;  reasons.push("MACD neutral (+5)"); }
  else                                          { reasons.push("MACD bullish - bad for put (+0)"); }

  // IVR - lower is still better for buying puts (15pts)
  if (stock.ivr < 30)       { score += 15; reasons.push(`IVR ${stock.ivr} - cheap options (+15)`); }
  else if (stock.ivr < 50)  { score += 10; reasons.push(`IVR ${stock.ivr} - moderate (+10)`); }
  else if (stock.ivr < 65)  { score += 5;  reasons.push(`IVR ${stock.ivr} - elevated (+5)`); }
  else                      { reasons.push(`IVR ${stock.ivr} - expensive (+0)`); }

  // Bearish catalyst (15pts)
  if (stock.bearishCatalyst) { score += 15; reasons.push(`Bearish catalyst: ${stock.bearishCatalyst} (+15)`); }

  // Volume confirmation (10pts)
  if (volume && avgVolume && volume > avgVolume * 1.2) { score += 10; reasons.push("Above-avg volume (+10)"); }
  else if (volume && avgVolume && volume > avgVolume)  { score += 5;  reasons.push("Average volume (+5)"); }
  else                                                 { reasons.push("Low volume (+0)"); }

  // Relative weakness vs SPY - negative is good for puts (10pts)
  if (relStrength < 0.95)      { score += 10; reasons.push(`Weak vs SPY: ${((relStrength-1)*100).toFixed(1)}% (+10)`); }
  else if (relStrength < 1.0)  { score += 5;  reasons.push(`Slightly weak vs SPY (+5)`); }
  else                         { reasons.push(`Outperforming SPY - bad for put (+0)`); }

  // ADX bonus - strong downtrend
  if (adx && adx > 25) { score += 5; reasons.push(`ADX ${adx} - strong trend (+5)`); }

  return { score: Math.min(score, 100), reasons };
}

// - Alpaca API -
const alpacaHeaders = () => ({
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type":        "application/json",
});

// Rate limit tracker
let apiCallsThisMinute = 0;
let apiWindowStart     = Date.now();

function trackAPICall() {
  const now = Date.now();
  if (now - apiWindowStart > 60000) {
    apiCallsThisMinute = 0;
    apiWindowStart     = now;
  }
  apiCallsThisMinute++;
  // Warn at 150, pause briefly at 180
  if (apiCallsThisMinute === 150) logEvent("warn", "Approaching API rate limit (150/min)");
  if (apiCallsThisMinute >= 180) return false; // signal to slow down
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

async function alpacaPost(endpoint, body) {
  try {
    const res = await fetch(`${ALPACA_BASE}${endpoint}`, {
      method: "POST", headers: alpacaHeaders(), body: JSON.stringify(body),
    });
    return await res.json();
  } catch(e) { logEvent("error", `alpacaPost(${endpoint}): ${e.message}`); return null; }
}

// Get latest stock quote
async function getStockQuote(ticker) {
  const data = await alpacaGet(`/stocks/${ticker}/quotes/latest`, ALPACA_DATA);
  if (data && data.quote) return parseFloat(data.quote.ap || data.quote.bp || 0);
  // Fallback to snapshot
  const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
  if (snap && snap.latestTrade) return parseFloat(snap.latestTrade.p || 0);
  return null;
}

// Get stock bars for volume and MA calculation
async function getStockBars(ticker, limit = 60) {
  try {
    // Always use date range — more reliable than limit param across all Alpaca tiers
    const end   = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - Math.ceil(limit * 1.6) * 86400000).toISOString().split("T")[0];
    // Try SIP feed first (Pro tier), fall back to IEX (free tier)
    const feeds = ["sip", "iex"];
    for (const feed of feeds) {
      const url  = `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&feed=${feed}`;
      const data = await alpacaGet(url, ALPACA_DATA);
      if (data && data.bars && data.bars.length > 1) return data.bars;
    }
    // Last resort — no feed param
    const last = await alpacaGet(`/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}`, ALPACA_DATA);
    return last && last.bars ? last.bars : [];
  } catch(e) { return []; }
}

// Get VIX
async function getVIX() {
  const data = await alpacaGet(`/stocks/VIXY/quotes/latest`, ALPACA_DATA);
  if (data && data.quote) return parseFloat(data.quote.ap || 15);
  return 15; // default to low VIX if unavailable
}

// Get real options chain from Alpaca OPRA feed
// Returns best contract matching our delta target and expiry window
// - Earnings Calendar -
async function getEarningsDate(ticker) {
  try {
    const today = getETTime().toISOString().split("T")[0];
    const end   = new Date(Date.now() + 60 * 86400000).toISOString().split("T")[0];
    const data  = await alpacaGet(`/corporate_actions/announcements?ca_types=Earnings&symbols=${ticker}&since=${today}&until=${end}`, ALPACA_DATA);
    if (data && data.announcements && data.announcements.length > 0) {
      return data.announcements[0].ex_date || null;
    }
    return null;
  } catch(e) { return null; }
}

// - News Feed -
async function getNewsForTicker(ticker) {
  try {
    const data = await alpacaGet(`/news?symbols=${ticker}&limit=5`, ALPACA_DATA);
    return data && data.news ? data.news : [];
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
let lastVIXReading = 15;
function checkVIXVelocity(currentVIX) {
  const delta    = currentVIX - lastVIXReading;
  lastVIXReading = currentVIX;
  if (delta >= 8) {
    logEvent("circuit", `VIX VELOCITY ALERT - jumped ${delta.toFixed(1)} points to ${currentVIX} - closing all positions`);
    return true;
  }
  return false;
}

// - Pre-Market Gap Scanner -
async function getPreMarketData(ticker) {
  try {
    // Get latest quote - pre-market activity shows in extended hours
    const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
    if (!snap) return null;
    const prevClose   = snap.prevDailyBar  ? snap.prevDailyBar.c  : null;
    const preMarket   = snap.minuteBar     ? snap.minuteBar.c     : null;
    const dailyOpen   = snap.dailyBar      ? snap.dailyBar.o      : null;
    if (!prevClose || !preMarket) return null;
    const gapPct      = (preMarket - prevClose) / prevClose * 100;
    return { prevClose, preMarket, gapPct: parseFloat(gapPct.toFixed(2)) };
  } catch(e) { return null; }
}

// - Beta-Weighted Portfolio Delta -
function calcBetaWeightedDelta() {
  if (!state.positions || !state.positions.length) return 0;
  const spyPrice = 500; // approximate - updated dynamically when available
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
  try {
    const data = await alpacaGet(`/news?symbols=${ticker}&limit=10`, ALPACA_DATA);
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
    return { upgrades, downgrades,
      signal: upgrades.length > downgrades.length ? "bullish" : downgrades.length > upgrades.length ? "bearish" : "neutral",
      modifier: (upgrades.length - downgrades.length) * 5
    };
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
  const today  = getETTime();
  const events = [];
  for (const ev of MACRO_EVENTS_2025) {
    const evDate = new Date(ev.date);
    const daysTo = Math.round((evDate - today) / 86400000);
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
      const delta  = parseFloat(pos.greeks?.delta || 0.35);
      const gamma  = parseFloat(pos.greeks?.gamma || 0.01);
      const vega   = parseFloat(pos.greeks?.vega  || 0.10);
      const price  = pos.price || 100;
      const contracts = pos.contracts || 1;
      const mult   = pos.optionType === "put" ? -1 : 1;

      let impact = 0;
      if (scenario.move !== undefined) {
        const priceMove  = price * scenario.move;
        // Delta + gamma approximation
        impact = (delta * mult * priceMove + 0.5 * gamma * priceMove * priceMove) * 100 * contracts;
      } else if (scenario.vixSpike !== undefined) {
        // Vega impact from IV spike
        impact = vega * scenario.vixSpike * 100 * contracts * mult;
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
  if (vix < 18 && callValue > 2000 && !hasPutHedge && isEntryWindow()) {
    logEvent("risk", `Tail risk hedge triggered - VIX:${vix} call exposure:${fmt(callValue)} - adding SPY put hedge`);
    const spyPrice = await getStockQuote("SPY");
    if (spyPrice) {
      const spyStock = { ticker:"SPY", sector:"Index", momentum:"steady", rsi:50, macd:"neutral", ivr:22, beta:1.0, earningsDate:null, expiryDays:30 };
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
    const curPrice = await getStockQuote(pos.ticker);
    if (!curPrice) continue;
    const dte   = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / 86400000));
    const curP  = parseFloat((curPrice * pos.iv * Math.sqrt(dte/365) * 0.4 + 0.1).toFixed(2));
    const chg   = (curP - pos.premium) / pos.premium;
    // If up 5%+ in first 24hrs, add second half
    if (chg >= 0.05 && state.cash > CAPITAL_FLOOR + pos.cost) {
      state.cash     -= pos.cost;
      pos.contracts  += pos.contracts;
      pos.halfPosition = false;
      logEvent("trade", `SCALE IN ${pos.ticker} - up ${(chg*100).toFixed(1)}% - doubled to ${pos.contracts}x contracts`);
      await saveState();
    }
  }
}

// ── Macro News Scanner -
const MACRO_BEARISH_KEYWORDS = [
  "fed rate hike", "rate hike", "hawkish", "tightening", "quantitative tightening",
  "inflation surge", "cpi beat", "inflation hot", "tariff", "trade war", "sanctions",
  "war", "military strike", "invasion", "conflict escalation", "strait", "blockade",
  "recession", "gdp miss", "gdp contraction", "unemployment rise", "jobless claims surge",
  "bank failure", "credit crunch", "debt ceiling", "default", "downgrade",
  "oil spike", "energy crisis", "supply shock", "shortage"
];

const MACRO_BULLISH_KEYWORDS = [
  "fed rate cut", "rate cut", "dovish", "easing", "quantitative easing", "stimulus",
  "soft landing", "inflation cooling", "cpi miss", "inflation slows",
  "strong jobs", "unemployment falls", "gdp beat", "gdp growth",
  "trade deal", "ceasefire", "peace talks", "sanctions lifted",
  "oil falls", "energy prices drop", "supply chain recovery"
];

// Sector-specific impact from macro events
const SECTOR_MACRO_IMPACT = {
  "rate hike":     { bearish: ["Technology", "Financial"], bullish: [] },
  "rate cut":      { bearish: [], bullish: ["Technology", "Financial"] },
  "oil spike":     { bearish: ["Consumer", "Technology"], bullish: ["Energy"] },
  "oil falls":     { bearish: [], bullish: ["Consumer", "Technology"] },
  "tariff":        { bearish: ["Technology", "Consumer"], bullish: [] },
  "trade deal":    { bearish: [], bullish: ["Technology", "Consumer"] },
  "recession":     { bearish: ["Financial", "Consumer", "Technology"], bullish: [] },
  "stimulus":      { bearish: [], bullish: ["Technology", "Financial", "Consumer"] },
};

async function getMacroNews() {
  try {
    // Pull general market news from Alpaca - no ticker filter = macro headlines
    const data = await alpacaGet(`/news?limit=20`, ALPACA_DATA);
    const articles = data && data.news ? data.news : [];

    let bearishScore = 0;
    let bullishScore = 0;
    const triggers   = [];
    const headlines  = [];
    const sectorImpact = { bearish: new Set(), bullish: new Set() };

    for (const article of articles) {
      const text = (article.headline + " " + (article.summary || "")).toLowerCase();
      headlines.push(article.headline);

      // Check bearish keywords
      for (const kw of MACRO_BEARISH_KEYWORDS) {
        if (text.includes(kw)) {
          bearishScore++;
          triggers.push(kw);
          // Check sector impact
          for (const [key, impact] of Object.entries(SECTOR_MACRO_IMPACT)) {
            if (kw.includes(key)) {
              impact.bearish.forEach(s => sectorImpact.bearish.add(s));
              impact.bullish.forEach(s => sectorImpact.bullish.add(s));
            }
          }
        }
      }

      // Check bullish keywords
      for (const kw of MACRO_BULLISH_KEYWORDS) {
        if (text.includes(kw)) {
          bullishScore++;
          triggers.push(kw);
          for (const [key, impact] of Object.entries(SECTOR_MACRO_IMPACT)) {
            if (kw.includes(key)) {
              impact.bullish.forEach(s => sectorImpact.bullish.add(s));
              impact.bearish.forEach(s => sectorImpact.bearish.add(s));
            }
          }
        }
      }
    }

    const net = bullishScore - bearishScore;
    let signal = "neutral";
    let scoreModifier = 0;
    let mode = "normal";

    if (net <= -4)      { signal = "strongly bearish"; scoreModifier = -20; mode = "defensive"; }
    else if (net <= -2) { signal = "bearish";          scoreModifier = -10; mode = "cautious";  }
    else if (net <= -1) { signal = "mild bearish";     scoreModifier = -5;  mode = "cautious";  }
    else if (net >= 4)  { signal = "strongly bullish"; scoreModifier = 15;  mode = "aggressive";}
    else if (net >= 2)  { signal = "bullish";          scoreModifier = 8;   mode = "normal";    }
    else if (net >= 1)  { signal = "mild bullish";     scoreModifier = 4;   mode = "normal";    }

    const uniqueTriggers = [...new Set(triggers)].slice(0, 5);
    if (uniqueTriggers.length > 0) {
      logEvent("macro", `Macro signal: ${signal} | triggers: ${uniqueTriggers.join(", ")} | modifier: ${scoreModifier > 0 ? "+" : ""}${scoreModifier}`);
    }

    return {
      signal, scoreModifier, mode,
      bearishScore, bullishScore,
      triggers: uniqueTriggers,
      sectorBearish: [...sectorImpact.bearish],
      sectorBullish: [...sectorImpact.bullish],
      headlines: headlines.slice(0, 5),
      updatedAt: new Date().toISOString(),
    };
  } catch(e) {
    logEvent("error", `getMacroNews: ${e.message}`);
    return { signal: "neutral", scoreModifier: 0, mode: "normal", triggers: [], sectorBearish: [], sectorBullish: [] };
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
    let advancing = 0, declining = 0;
    for (const etf of sectors) {
      const bars = await getStockBars(etf, 2);
      if (bars.length >= 2) {
        if (bars[bars.length-1].c > bars[bars.length-2].c) advancing++;
        else declining++;
      }
    }
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
    for (const [sector, etf] of Object.entries(sectorETFs)) {
      const bars = await getStockBars(etf, 5);
      if (bars.length >= 2) perf[sector] = (bars[bars.length-1].c - bars[0].c) / bars[0].c * 100;
    }
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
    const { expDate: targetExpDate, expDays: targetExpDays, expiryType } = selectExpiry(score, vix, optionType, earningsDate);

    // Format date for API: YYYY-MM-DD
    const today     = getETTime();
    const minExpiry = new Date(today.getTime() + 7  * 86400000).toISOString().split("T")[0];
    const maxExpiry = new Date(today.getTime() + 90 * 86400000).toISOString().split("T")[0];

    // Strike range - look 10% around current price
    const strikeLow  = (price * 0.90).toFixed(0);
    const strikeHigh = (price * 1.10).toFixed(0);

    const url = `/options/contracts?underlying_symbol=${ticker}` +
      `&expiration_date_gte=${minExpiry}&expiration_date_lte=${maxExpiry}` +
      `&strike_price_gte=${strikeLow}&strike_price_lte=${strikeHigh}` +
      `&type=${optionType}&limit=50`;

    const data = await alpacaGet(url, ALPACA_OPTIONS);
    if (!data || !data.option_contracts || !data.option_contracts.length) return null;

    // Get snapshots for the contracts to get real greeks + IV + quotes
    const symbols   = data.option_contracts.slice(0, 20).map(c => c.symbol).join(",");
    // Use confirmed working snapshot endpoint
    const snapData  = await alpacaGet(`/options/snapshots?symbols=${symbols}&feed=indicative`, ALPACA_OPT_SNAP);
    const snapshots = snapData && snapData.snapshots ? snapData.snapshots : {};

    logEvent("scan", `${ticker} options chain: ${data.option_contracts.length} contracts | ${Object.keys(snapshots).length} snapshots with greeks`);

    // Score each contract — find best delta match in 0.28-0.42 range
    let best       = null;
    let bestScore  = -1;
    let skipped    = 0;

    for (const contract of data.option_contracts) {
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

      // Skip illiquid
      if (mid <= 0) continue;
      if (spread > MAX_SPREAD_PCT) continue;
      if (oi < MIN_OPEN_INTEREST) continue;
      if (delta < TARGET_DELTA_MIN || delta > TARGET_DELTA_MAX) continue;

      const deltaScore    = 1 - Math.abs(delta - 0.35) / 0.35;
      const liquidScore   = Math.min(oi / 5000, 1);
      const contractScore = deltaScore * 0.6 + liquidScore * 0.4;

      if (contractScore > bestScore) {
        bestScore = contractScore;
        best = {
          symbol:  contract.symbol,
          strike:  parseFloat(contract.strike_price),
          expDate: new Date(contract.expiration_date).toLocaleDateString("en-US", {month:"short",day:"2-digit",year:"numeric"}),
          expDays: Math.round((new Date(contract.expiration_date) - today) / 86400000),
          expiryType,
          premium: parseFloat(mid.toFixed(2)),
          bid, ask, spread,
          greeks: {
            delta: parseFloat(greeks.delta || 0).toFixed(3),
            theta: parseFloat(greeks.theta || 0).toFixed(3),
            gamma: parseFloat(greeks.gamma || 0).toFixed(4),
            vega:  parseFloat(greeks.vega  || 0).toFixed(3),
          },
          iv, oi, vol, optionType,
        };
      }
    }

    if (best) {
      logEvent("scan", `${ticker} best contract: ${best.symbol} | $${best.premium} bid/ask $${best.bid}/$${best.ask} | delta:${best.greeks.delta} | OI:${best.oi} [REAL DATA]`);
    } else {
      logEvent("warn", `${ticker} no valid contract found (${data.option_contracts.length} contracts, ${skipped} missing snapshots)`);
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
  // Goal: always keep CASH_ETF_TARGET ($1,500) parked in BIL as the ETF half of the floor
  // The other $1,500 stays liquid as the cash half of the floor
  const currentETF    = state.cashETFValue || 0;
  const currentShares = state.cashETFShares || 0;
  const diff          = CASH_ETF_TARGET - currentETF;

  if (Math.abs(diff) < CASH_ETF_MIN) return; // already balanced

  // Get BIL price
  let bilPrice = 91;
  try {
    const p = await getStockQuote(CASH_ETF);
    if (p && p > 50) bilPrice = p;
  } catch(e) {}

  if (diff > 0 && state.cash > CAPITAL_FLOOR + diff) {
    // Buy BIL to top up to $1,500 target
    const sharesToBuy = Math.floor(diff / bilPrice);
    if (sharesToBuy < 1) return;
    const cost = sharesToBuy * bilPrice;
    state.cash          -= cost;
    state.cashETFShares  = currentShares + sharesToBuy;
    state.cashETFValue   = parseFloat((state.cashETFShares * bilPrice).toFixed(2));
    state.cashETFPrice   = bilPrice;
    logEvent("etf", `BIL rebalance - bought ${sharesToBuy} shares @ $${bilPrice.toFixed(2)} | ETF floor: ${fmt(state.cashETFValue)} | liquid: ${fmt(state.cash)}`);
    await saveState();

  } else if (diff < 0 && currentShares > 0) {
    // Sell excess BIL back to cash
    const sharesToSell = Math.min(currentShares, Math.ceil(Math.abs(diff) / bilPrice));
    if (sharesToSell < 1) return;
    const proceeds = parseFloat((sharesToSell * bilPrice).toFixed(2));
    state.cash          += proceeds;
    state.cashETFShares  = currentShares - sharesToSell;
    state.cashETFValue   = parseFloat((state.cashETFShares * bilPrice).toFixed(2));
    logEvent("etf", `BIL rebalance - sold ${sharesToSell} shares | ETF floor: ${fmt(state.cashETFValue)} | liquid: ${fmt(state.cash)}`);
    await saveState();
  }
}

// Liquidate BIL if needed to fund a trade - only touches ETF above the floor target
async function ensureLiquidCash(needed) {
  if (state.cash >= needed) return;
  const shortfall    = needed - state.cash;
  const bilPrice     = state.cashETFPrice || 91;
  const sharesToSell = Math.min(state.cashETFShares || 0, Math.ceil(shortfall / bilPrice));
  if (sharesToSell < 1) return;
  const proceeds = parseFloat((sharesToSell * bilPrice).toFixed(2));
  state.cash          += proceeds;
  state.cashETFShares  = (state.cashETFShares || 0) - sharesToSell;
  state.cashETFValue   = parseFloat((state.cashETFShares * bilPrice).toFixed(2));
  logEvent("etf", `BIL liquidated ${fmt(proceeds)} to fund trade | liquid: ${fmt(state.cash)}`);
  await saveState();
}

// - Pre-market Analysis -
async function getPremarketData(ticker) {
  try {
    const data = await alpacaGet(`/stocks/${ticker}/quotes/latest`, ALPACA_DATA);
    if (!data || !data.quote) return null;
    const prePrice = parseFloat(data.quote.ap || data.quote.bp || 0);
    return prePrice;
  } catch(e) { return null; }
}

// - Sector ETF Confirmation -
async function checkSectorETF(stock) {
  const etfMap = { "Technology":"XLK", "Financial":"XLF", "Consumer":"XLY" };
  const etfs   = [];

  // Sector ETF
  if (etfMap[stock.sector]) etfs.push(etfMap[stock.sector]);

  // SMH for semiconductors
  if (SEMIS.includes(stock.ticker)) etfs.push("SMH");

  if (!etfs.length) return { pass: true, reason: null };

  for (const etf of etfs) {
    const bars = await getStockBars(etf, 5);
    if (bars.length < 2) continue;
    const etfReturn = (bars[bars.length-1].c - bars[0].o) / bars[0].o;
    if (etfReturn < -0.01) {
      return { pass: false, reason: `${etf} sector ETF down ${(etfReturn*100).toFixed(1)}% - sector headwind` };
    }
  }
  return { pass: true, reason: null };
}

// - Pre-trade Filters -
async function checkAllFilters(stock, price) {
  const fails = [];

  // 1. Entry window
  if (!isEntryWindow()) return { pass:false, reason:"Outside entry window (10AM-3:30PM ET)" };

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

  // 9. Correlated positions (max 2 per sector)
  const sectorCount = state.positions.filter(p=>p.sector===stock.sector).length;
  if (sectorCount >= 2) return { pass:false, reason:`Already have 2 positions in ${stock.sector}` };

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
    const dte = Math.round((new Date(stock.earningsDate) - new Date()) / 86400000);
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
    // Bootstrap: use conservative fixed fraction until we have real data
    // Blend toward real Kelly as trades accumulate (70% bootstrap, 30% real when <10 trades)
    const bootstrapKelly = 0.08; // conservative 8% of capital
    kellyBase = bootstrapKelly;
  }

  // Step 2: Score conviction multiplier
  // Higher score = more conviction = size up within Kelly bounds
  const convictionMult = score >= 85 ? 1.25 : score >= 75 ? 1.0 : score >= 70 ? 0.80 : 0.60;

  // Step 3: VIX adjustment — options are more expensive in high vol, size down
  const vixMult = vix >= VIX_REDUCE50 ? 0.50 : vix >= VIX_REDUCE25 ? 0.75 : 1.0;

  // Step 4: Drawdown protocol from marketContext
  const ddMult = (marketContext?.drawdownProtocol?.sizeMultiplier) || 1.0;

  // Step 5: Combine into single sizing decision
  const effectiveFraction = kellyBase * convictionMult * vixMult * ddMult;
  const maxCost           = Math.min(
    state.cash * effectiveFraction,
    state.cash * 0.20,                     // hard cap: never more than 20% per trade
    MAX_LOSS_PER_TRADE / STOP_LOSS_PCT     // risk-based cap
  );

  const contracts = Math.max(1, Math.min(5, Math.floor(maxCost / (premium * 100))));
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
// Returns { expDate: string, expDays: number, expiryType: "weekly"|"monthly" }
function selectExpiry(score, vix, optionType, earningsDate) {
  const today  = getETTime();
  const now    = today.getTime();

  // Determine target DTE window based on conditions
  let targetDays;
  let expiryType;

  if (score >= 85 && vix < 25 && optionType === "call") {
    // High score, low VIX, call = weekly for max leverage
    targetDays = 14;
    expiryType = "weekly";
  } else if (vix >= VIX_REDUCE50 || optionType === "put") {
    // High VIX or put = monthly, need more time
    targetDays = 45;
    expiryType = "monthly";
  } else if (score >= 70 && vix < 30) {
    // Normal setup = standard monthly
    targetDays = 30;
    expiryType = "monthly";
  } else {
    // Default to monthly with extra buffer
    targetDays = 45;
    expiryType = "monthly";
  }

  // Calculate target date
  const targetDate = new Date(now + targetDays * 86400000);

  let expiry;
  if (expiryType === "weekly") {
    // Find next Friday at or after targetDate
    expiry = getNextExpiryFriday(targetDate);
    // Make sure it's at least 7 days out (avoid gamma risk)
    const minDate = new Date(now + 7 * 86400000);
    if (expiry < minDate) expiry = getNextExpiryFriday(new Date(expiry.getTime() + 7 * 86400000));
  } else {
    // Find third Friday of target month
    expiry = getThirdFriday(targetDate.getFullYear(), targetDate.getMonth());
    // If that Friday has already passed or too close, go to next month
    const minDate = new Date(now + 21 * 86400000);
    if (expiry < minDate) {
      const nextMonth = targetDate.getMonth() === 11 ? 0 : targetDate.getMonth() + 1;
      const nextYear  = targetDate.getMonth() === 11 ? targetDate.getFullYear() + 1 : targetDate.getFullYear();
      expiry = getThirdFriday(nextYear, nextMonth);
    }
  }

  // If earnings date is within our expiry window, extend past earnings
  if (earningsDate) {
    const eDays = Math.round((new Date(earningsDate) - new Date(now)) / 86400000);
    if (eDays > 0 && eDays < Math.round((expiry - new Date(now)) / 86400000)) {
      // Earnings before expiry - extend to next monthly after earnings
      const postEarnings = new Date(new Date(earningsDate).getTime() + 7 * 86400000);
      expiry = getThirdFriday(postEarnings.getFullYear(), postEarnings.getMonth());
    }
  }

  const expDays = Math.round((expiry - new Date(now)) / 86400000);
  const expDate = expiry.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });

  return { expDate, expDays: Math.max(expDays, 7), expiryType };
}

function buildCard(stock, price, contracts, iv, optionType = "call", score = 75, vix = 15) {
  // Smart expiry - real Friday dates, weekly vs monthly based on conditions
  const { expDate, expDays, expiryType } = selectExpiry(score, vix, optionType, stock.earningsDate);

  const otmPct    = stock.momentum === "strong" ? 0.035 : 0.045;
  // Calls: strike ABOVE price. Puts: strike BELOW price
  const strike    = optionType === "put"
    ? Math.round(price * (1 - otmPct) / 5) * 5
    : Math.round(price * (1 + otmPct) / 5) * 5;
  const ivVal     = iv || (0.25 + stock.ivr * 0.003);
  const t         = expDays / 365;
  const premium   = parseFloat((price * ivVal * Math.sqrt(t) * 0.4 + 0.3).toFixed(2));
  const cost      = parseFloat((premium * 100 * contracts).toFixed(2));
  const greeks    = calcGreeks(price, strike, expDays, ivVal);
  const target    = parseFloat((premium*(1+TAKE_PROFIT_PCT)).toFixed(2));
  const stop      = parseFloat((premium*(1-STOP_LOSS_PCT)).toFixed(2));
  const breakeven = optionType === "put"
    ? parseFloat((strike - premium).toFixed(2))
    : parseFloat((strike + premium).toFixed(2));
  return { ...stock, price, strike, premium, contracts, cost, expDate, expDays, expiryType, target, stop, breakeven, greeks, iv:ivVal, optionType };
}

// - Execute Trade -
async function executeTrade(stock, price, score, scoreReasons, vix, optionType = "call") {
  // Try to get real options contract from Alpaca OPRA feed
  let contract = await getRealOptionsContract(stock.ticker, price, optionType, score, vix, stock.earningsDate);

  // Fallback to estimated contract if real data unavailable
  if (!contract) {
    logEvent("warn", `${stock.ticker} - no real options contract found, using estimate`);
    const iv       = 0.25 + stock.ivr * 0.003;
    const { expDate, expDays, expiryType } = selectExpiry(score, vix, optionType, stock.earningsDate);
    const otmPct   = stock.momentum === "strong" ? 0.035 : 0.045;
    const strike   = optionType === "put"
      ? Math.round(price * (1 - otmPct) / 5) * 5
      : Math.round(price * (1 + otmPct) / 5) * 5;
    const t        = expDays / 365;
    const premium  = parseFloat((price * iv * Math.sqrt(t) * 0.4 + 0.3).toFixed(2));
    const greeks   = calcGreeks(price, strike, expDays, iv);
    contract = { symbol: null, strike, expDate, expDays, expiryType,
      premium, bid: premium * 0.95, ask: premium * 1.05,
      greeks, iv, oi: 0, vol: 0, optionType };
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

  state.cash = parseFloat((state.cash - cost).toFixed(2));
  state.todayTrades++;

  const position = {
    ticker:         stock.ticker,
    sector:         stock.sector,
    strike:         contract.strike,
    premium:        contract.premium,
    contracts,
    cost,
    expDate:        contract.expDate,
    expiryDays:     contract.expDays,
    target, stop, breakeven,
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
    bid:             contract.bid,
    ask:             contract.ask,
    realData:        !!contract.symbol,
    entryRSI:        stock.rsi || 52,        // capture entry signal for decay detection
    entryMomentum:   stock.momentum || "steady",
  };

  state.positions.push(position);

  // Trade journal entry
  state.tradeJournal.unshift({
    time:      new Date().toISOString(),
    ticker:    stock.ticker,
    action:    "OPEN",
    strike:    contract.strike,
    expDate:   contract.expDate,
    premium:   contract.premium,
    contracts,
    cost,
    score,
    scoreReasons,
    delta:     contract.greeks.delta,
    iv:        parseFloat((t.iv*100).toFixed(1)),
    vix,
    catalyst:  stock.catalyst,
    reasoning: `Score ${score}/100. ${scoreReasons.slice(0,3).join(". ")}. Catalyst: ${stock.catalyst}. Delta ${t.greeks.delta} within 0.30-0.40 target.`,
  });
  if (state.tradeJournal.length > 200) state.tradeJournal = state.tradeJournal.slice(0,200);

  const typeLabel = optionType === "put" ? "P" : "C";
  const dataLabel = contract.symbol ? "REAL" : "EST";
  logEvent("trade",
    `BUY ${stock.ticker} $${contract.strike}${typeLabel} exp ${contract.expDate} | ${contracts}x @ $${contract.premium} | ` +
    `cost ${fmt(cost)} | score ${score} | delta ${contract.greeks.delta} | [${dataLabel}] | cash ${fmt(state.cash)} | heat ${(heatPct()*100).toFixed(0)}%`
  );
  await saveState();
  return true;
}

// - Close Position -
async function closePosition(ticker, reason, exitPremium = null) {
  const idx = state.positions.findIndex(p => p.ticker === ticker);
  if (idx === -1) return;
  const pos  = state.positions[idx];
  const mult = pos.partialClosed ? 0.5 : 1.0;

  const g    = exitPremium !== null ? (exitPremium - pos.premium) / pos.premium
             : reason === "stop"        ? -(0.30 + Math.random()*0.08)
             : reason === "fast-stop"   ? -(0.18 + Math.random()*0.05)
             : reason === "target"      ? (0.62  + Math.random()*0.06)
             : reason === "trail"       ? (0.28  + Math.random()*0.08)
             : reason === "expiry-roll" ? (0.15  + Math.random()*0.10)
             : (Math.random()*0.4-0.08);

  const ep   = parseFloat((pos.premium*(1+g)).toFixed(2));
  const ev   = parseFloat((ep*100*pos.contracts*mult).toFixed(2));
  const pnl  = parseFloat((ev - pos.cost*mult).toFixed(2));
  const pct  = ((pnl/(pos.cost*mult))*100).toFixed(1);
  const nr   = state.totalRevenue + (pnl > 0 ? pnl : 0);
  const bonus= state.totalRevenue < REVENUE_THRESHOLD && nr >= REVENUE_THRESHOLD;

  state.cash          = parseFloat((state.cash + ev + (bonus?BONUS_AMOUNT:0)).toFixed(2));
  state.extraBudget  += bonus ? BONUS_AMOUNT : 0;
  state.totalRevenue  = nr;
  state.monthlyProfit = parseFloat((state.monthlyProfit + pnl).toFixed(2));
  state.positions.splice(idx, 1);
  state.closedTrades.push({ ticker, pnl, pct, date:new Date().toLocaleDateString(), reason, score:pos.score||0 });

  // Update consecutive losses
  if (pnl < 0) state.consecutiveLosses++;
  else state.consecutiveLosses = 0;

  // Peak cash tracking for drawdown
  if (state.cash > state.peakCash) state.peakCash = state.cash;

  // Circuit breaker checks -- use total portfolio value (cash + open positions)
  // so deploying capital into trades does not falsely trigger the breaker
  const portfolioValue = state.cash + openRisk();
  const dailyPnL  = portfolioValue - state.dayStartCash;
  const weeklyPnL = portfolioValue - state.weekStartCash;
  if (dailyPnL / totalCap() <= -0.15 && state.circuitOpen) {
    state.circuitOpen = false;
    logEvent("circuit", `DAILY circuit breaker - loss ${fmt(Math.abs(dailyPnL))}`);
  }
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
  await saveState();
}

// - Partial Close -
async function partialClose(ticker) {
  const pos = state.positions.find(p => p.ticker === ticker);
  if (!pos || pos.partialClosed) return;
  pos.partialClosed = true;
  const ep   = parseFloat((pos.premium * 1.5).toFixed(2));
  const half = Math.max(1, Math.floor(pos.contracts / 2));
  const ev   = parseFloat((ep * 100 * half).toFixed(2));
  const pnl  = parseFloat(((ep - pos.premium) * 100 * half).toFixed(2));
  state.cash = parseFloat((state.cash + ev).toFixed(2));
  state.monthlyProfit = parseFloat((state.monthlyProfit + pnl).toFixed(2));
  state.closedTrades.push({ ticker, pnl, pct:((pnl/(pos.cost*0.5))*100).toFixed(1), date:new Date().toLocaleDateString(), reason:"partial" });
  logEvent("partial", `PARTIAL ${ticker} - ${half}/${pos.contracts} @ +50% | +${fmt(pnl)} | cash ${fmt(state.cash)}`);
  await saveState();
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
    await saveState();
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
      await saveState();
    }
  }
}

// - Main Scan Engine -
let scanRunning  = false;
let lastMedScan  = 0;  // 5 minute tier
let lastSlowScan = 0;  // 15 minute tier
let lastHourScan = 0;  // 60 minute tier

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
  if (!ALPACA_KEY) { logEvent("warn", "No ALPACA_API_KEY set - check Railway variables"); return; }
  if (!isMarketHours()) { logEvent("scan", "Outside market hours - skipping trade logic"); return; }

  const now = Date.now();

  // Update VIX and check velocity
  const newVIX  = await getVIX() || state.vix;
  const isBlackSwan = checkVIXVelocity(newVIX);
  state.vix     = newVIX;

  // Emergency close all on VIX velocity spike
  if (isBlackSwan) {
    for (const pos of [...state.positions]) await closePosition(pos.ticker, "vix-spike");
    await saveState();
    scanRunning = false;
    return;
  }

  logEvent("scan", `Scan | VIX:${state.vix} | cash:${fmt(state.cash)} | positions:${state.positions.length} | breadth:${marketContext.breadth.breadthPct}% | F&G:${marketContext.fearGreed.score}`);

  // -- MEDIUM TIER (every 5 minutes) --
  if (now - lastMedScan > 5 * 60 * 1000) {
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
    // Regime detection
    const regime = await detectMarketRegime();
    marketContext.regime = regime;

    // Concentration risk check
    marketContext.concentration = checkConcentrationRisk();
    if (marketContext.concentration.alerts.length > 0) {
      marketContext.concentration.alerts.forEach(a => logEvent("risk", a));
    }

    // Drawdown protocol
    marketContext.drawdownProtocol = getDrawdownProtocol();
    if (marketContext.drawdownProtocol.level !== "normal") {
      logEvent("risk", `Drawdown protocol: ${marketContext.drawdownProtocol.message}`);
    }

    // Stress test
    marketContext.stressTest = runStressTest();

    // Benchmark comparison
    marketContext.benchmark = await getBenchmarkComparison();

    // Check tail risk hedge
    await checkTailRiskHedge();

    // Check scale-ins on half positions
    await checkScaleIns();

    // Monte Carlo + Kelly + Relative Value
    marketContext.monteCarlo    = runMonteCarlo(500);
    marketContext.kelly         = calcKellySize(20);
    marketContext.relativeValue = getRelativeValueScreening();
    marketContext.globalMarket  = await getGlobalMarketSignal();
    marketContext.streaks       = getStreakAnalysis();

    logEvent("scan", `[5min] Regime:${regime.regime}(${regime.confidence}%) | Kelly:${marketContext.kelly.contracts}x | Global:${marketContext.globalMarket.signal} | Streak:${marketContext.streaks.currentStreak}x${marketContext.streaks.currentType}`);
  }

  // -- SLOW TIER (every 15 minutes) --
  if (now - lastSlowScan > 15 * 60 * 1000) {
    lastSlowScan = now;
    const [fg, dxy, yc, macro] = await Promise.all([getFearAndGreed(), getDXY(), getYieldCurve(), getMacroNews()]);
    marketContext.fearGreed   = fg;
    marketContext.dxy         = dxy;
    marketContext.yieldCurve  = yc;
    marketContext.macro       = macro;
    marketContext.putCallRatio = state.vix > 30 ? { ratio: 1.3, signal: "fear" } : state.vix > 20 ? { ratio: 1.0, signal: "neutral" } : { ratio: 0.7, signal: "greed" };
    logEvent("scan", `[15min] Macro:${macro.signal}(${macro.scoreModifier > 0 ? "+" : ""}${macro.scoreModifier}) | F&G:${fg.score} | DXY:${dxy.trend} | Yield:${yc.signal}`);

    // If macro is strongly bearish - close all calls immediately
    if (macro.mode === "defensive" && state.circuitOpen) {
      logEvent("macro", `DEFENSIVE MODE - macro strongly bearish: ${macro.triggers.join(", ")} - closing call positions`);
      for (const pos of [...state.positions]) {
        if (pos.optionType === "call") await closePosition(pos.ticker, "macro-defensive");
      }
    }
  }

  // -- HOUR TIER (every 60 minutes) --
  if (now - lastHourScan > 60 * 60 * 1000) {
    lastHourScan = now;
    // Update earnings dates for all watchlist stocks
    for (const stock of WATCHLIST) {
      const ed = await getEarningsDate(stock.ticker);
      if (ed) stock.earningsDate = ed;
    }
    logEvent("scan", `[1hr] Earnings calendar updated for ${WATCHLIST.length} stocks`);
  }

  // Manage stock positions
  await manageStockPositions();

  // 1. Manage existing options positions
  for (const pos of [...state.positions]) {
    const price = await getStockQuote(pos.ticker);
    if (!price) continue;

    const dte      = Math.max(1, Math.round((new Date(pos.expDate)-new Date())/86400000));
    const t        = dte / 365;
    // Use real options price if we have a contract symbol, else estimate
    let curP;
    if (pos.contractSymbol) {
      const realPrice = await getOptionsPrice(pos.contractSymbol);
      curP = realPrice ? parseFloat(realPrice.toFixed(2)) : parseFloat((price * pos.iv * Math.sqrt(t) * 0.4 + 0.1).toFixed(2));
      if (realPrice) pos.realData = true;
    } else {
      curP = parseFloat((price * pos.iv * Math.sqrt(t) * 0.4 + 0.1).toFixed(2));
    }
    const chg      = (curP - pos.premium) / pos.premium;
    const hoursOpen= (new Date() - new Date(pos.openDate)) / 3600000;
    const daysOpen = hoursOpen / 24;

    // Update peak premium for trailing stop
    if (curP > pos.peakPremium) pos.peakPremium = curP;

    // Fast stop - -20% in first 48 hours
    if (hoursOpen <= FAST_STOP_HOURS && chg <= -FAST_STOP_PCT) {
      logEvent("scan", `${pos.ticker} fast stop - down ${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(0)}hrs`);
      closePosition(pos.ticker, "fast-stop"); continue;
    }

    // Profit target acceleration - if +40% in first 48hrs, take it now
    if (hoursOpen <= FAST_PROFIT_HOURS && chg >= FAST_PROFIT_PCT && !pos.partialClosed) {
      logEvent("scan", `${pos.ticker} ACCELERATED PROFIT - +${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(0)}hrs - taking gains early`);
      closePosition(pos.ticker, "fast-target"); continue;
    }

    // Update peak cash for drawdown tracking
    const curCash = state.cash + openRisk() + realizedPnL();
    if (curCash > (state.peakCash || MONTHLY_BUDGET)) state.peakCash = curCash;

    // Hard stop loss
    if (chg <= -STOP_LOSS_PCT) {
      logEvent("scan", `${pos.ticker} stop loss - down ${(chg*100).toFixed(0)}%`);
      closePosition(pos.ticker, "stop"); continue;
    }

    // Trailing stop with signal decay tightening
    if (chg >= TRAIL_ACTIVATE_PCT) {
      // Base trail percentage
      let trailPct = TRAIL_STOP_PCT;

      // Signal decay check — if entry conditions have deteriorated, tighten the trail
      // Re-score current conditions vs entry conditions
      const currentRSI      = pos.entryRSI || 55;
      const entryMomentum   = pos.entryMomentum || "steady";
      const liveRSI         = signals ? signals.rsi : currentRSI;

      // If RSI has crossed from bullish zone to bearish zone since entry, tighten trail
      if (pos.optionType === "call" && liveRSI < 45 && currentRSI >= 50) {
        trailPct = TRAIL_STOP_PCT * 0.6; // tighten to 9% trail instead of 15%
        logEvent("scan", `${pos.ticker} signal decay detected — RSI dropped to ${liveRSI} — tightening trail to ${(trailPct*100).toFixed(0)}%`);
      }
      // If put and RSI has recovered, tighten trail on the put
      if (pos.optionType === "put" && liveRSI > 55 && currentRSI <= 50) {
        trailPct = TRAIL_STOP_PCT * 0.6;
        logEvent("scan", `${pos.ticker} signal decay (put) — RSI recovered to ${liveRSI} — tightening trail`);
      }

      const trailStop = pos.peakPremium * (1 - trailPct);
      pos.trailStop   = trailStop;
      if (curP <= trailStop) {
        logEvent("scan", `${pos.ticker} trailing stop hit - peak $${pos.peakPremium.toFixed(2)} trail $${trailStop.toFixed(2)}`);
        await closePosition(pos.ticker, "trail"); continue;
      }
    }

    // Breakeven lock at +40%
    if (chg >= BREAKEVEN_LOCK_PCT && !pos.breakevenLocked) {
      pos.breakevenLocked = true;
      pos.stop = pos.premium; // move stop to breakeven
      logEvent("scan", `${pos.ticker} breakeven locked - stop moved to $${pos.premium}`);
    }

    // Partial close at +50%
    if (!pos.partialClosed && chg >= PARTIAL_CLOSE_PCT) {
      logEvent("scan", `${pos.ticker} partial close at +50%`);
      partialClose(pos.ticker);
    }

    // Let remainder ride to +100% after partial
    if (pos.partialClosed && chg >= RIDE_TARGET_PCT) {
      logEvent("scan", `${pos.ticker} remainder hit +100% target`);
      closePosition(pos.ticker, "target"); continue;
    }

    // Full target (if no partial close)
    if (!pos.partialClosed && chg >= TAKE_PROFIT_PCT) {
      logEvent("scan", `${pos.ticker} take profit +${(chg*100).toFixed(0)}%`);
      closePosition(pos.ticker, "target"); continue;
    }

    // Time stop
    if (daysOpen >= TIME_STOP_DAYS && Math.abs(chg) < TIME_STOP_MOVE) {
      logEvent("scan", `${pos.ticker} time stop - ${daysOpen.toFixed(0)} days, only ${(chg*100).toFixed(1)}% move`);
      closePosition(pos.ticker, "time-stop"); continue;
    }

    // 50MA break
    if (price < pos.strike / 1.035 * (1-MA50_BUFFER)) {
      logEvent("scan", `${pos.ticker} broke 50MA - price $${price}`);
      closePosition(pos.ticker, "50ma-break"); continue;
    }

    // IV collapse
    if (curP < pos.premium*(1-IV_COLLAPSE_PCT) && price >= pos.strike*0.97) {
      logEvent("scan", `${pos.ticker} IV collapse - option down ${(((pos.premium-curP)/pos.premium)*100).toFixed(0)}%`);
      closePosition(pos.ticker, "iv-collapse"); continue;
    }

    // Mid-trade earnings check
    if (pos.earningsDate) {
      const daysToE = Math.round((new Date(pos.earningsDate)-new Date())/86400000);
      if (daysToE >= 0 && daysToE <= EARNINGS_SKIP_DAYS) {
        logEvent("scan", `${pos.ticker} earnings in ${daysToE} days - closing to avoid IV crush`);
        closePosition(pos.ticker, "earnings-close"); continue;
      }
    }

    // Expiry roll
    if (dte <= 7 && chg > 0) {
      logEvent("scan", `${pos.ticker} near expiry (${dte}d) - closing to avoid gamma risk`);
      closePosition(pos.ticker, "expiry-roll"); continue;
    }

    // Update current price on position so dashboard shows live data
    pos.price        = price;
    pos.currentPrice = curP;
    logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
    await saveState();
  }

  // 2. New entries
  if (!isEntryWindow()) return;
  if (state.circuitOpen === false || state.weeklyCircuitOpen === false) return;
  if (state.consecutiveLosses >= CONSEC_LOSS_LIMIT) return;
  if (state.cash <= CAPITAL_FLOOR) return;

  // Get SPY price for relative strength
  const spyPrice  = await getStockQuote("SPY") || 500;
  const spyBars   = await getStockBars("SPY", 5);
  const spyReturn = spyBars.length >= 5 ? (spyBars[spyBars.length-1].c - spyBars[0].o) / spyBars[0].o : 0;

  // Gap detection - check SPY for market-wide gap
  if (spyBars.length >= 2) {
    const todayOpen = spyBars[spyBars.length-1].o;
    const prevClose = spyBars[spyBars.length-2].c;
    const gapPct    = Math.abs(todayOpen - prevClose) / prevClose;
    if (gapPct > MAX_GAP_PCT) {
      logEvent("filter", `Market gap detected (${(gapPct*100).toFixed(1)}%) - skipping new entries today`);
      return;
    }
  }

  // Score and rank candidates
  const scored = [];
  for (const stock of WATCHLIST) {
    if (state.positions.find(p=>p.ticker===stock.ticker)) continue;

    // Fetch price FIRST before running filters
    const price = await getStockQuote(stock.ticker);
    if (!price || price < MIN_STOCK_PRICE) {
      logEvent("filter", `${stock.ticker} price $${price||0} unavailable or below min - skip`);
      continue;
    }

    const { pass, reason } = await checkAllFilters(stock, price);
    if (!pass) { logEvent("filter", `${stock.ticker} filter fail: ${reason}`); continue; }

    const bars     = await getStockBars(stock.ticker, 60);
    const avgVol   = bars.length ? bars.slice(0,-1).reduce((s,b)=>s+b.v,0)/Math.max(bars.length-1,1) : 0;
    const todayVol = bars.length ? bars[bars.length-1].v : 0;

    // Relative strength vs SPY
    const stockReturn  = bars.length >= 5 ? (bars[bars.length-1].c - bars[0].o) / bars[0].o : 0;
    const relStrength  = spyReturn !== 0 ? (1 + stockReturn) / (1 + spyReturn) : 1;

    // Gap check on individual stock
    if (bars.length >= 2) {
      const gap = Math.abs(bars[bars.length-1].o - bars[bars.length-2].c) / bars[bars.length-2].c;
      if (gap > MAX_GAP_PCT) { logEvent("filter", `${stock.ticker} gap ${(gap*100).toFixed(1)}% - skip`); continue; }
    }

    // Anomaly detection — skip if unusual price movement detected
    const anomaly = detectPriceAnomaly(bars);
    if (anomaly.anomaly) { logEvent("filter", `${stock.ticker} price anomaly: ${anomaly.reason} - skip`); continue; }

    // Dynamic signals - calculated live from real price bars
    if (bars.length < 10) {
      logEvent("filter", `${stock.ticker} insufficient bars (${bars.length}) for dynamic signals - skip`);
      continue;
    }
    const signals = await getDynamicSignals(stock.ticker, bars);
    logEvent("filter", `${stock.ticker} signals | RSI:${signals.rsi} MACD:${signals.macd} MOM:${signals.momentum} IVR:${signals.ivr} bars:${bars.length}`);

    // Earnings quality score
    const eqScore = await getEarningsQualityScore(stock.ticker, bars);

    // VWAP - skip calls if price below VWAP (weak intraday)
    const vwap = calcVWAP(bars.slice(-5));
    if (vwap > 0 && price < vwap * 0.99) {
      logEvent("filter", `${stock.ticker} price $${price} below VWAP $${vwap} - weak intraday`);
    }

    // Pre-market gap check
    const preMarket = await getPreMarketData(stock.ticker);
    if (preMarket && Math.abs(preMarket.gapPct) > 3) {
      logEvent("filter", `${stock.ticker} pre-market gap ${preMarket.gapPct > 0 ? "+" : ""}${preMarket.gapPct}%`);
    }

    // Analyst activity
    const analystData = await getAnalystActivity(stock.ticker);

    // Short interest / squeeze signal
    const shortSignal = await getShortInterestSignal(stock.ticker, bars);

    // News sentiment
    const newsArticles  = await getNewsForTicker(stock.ticker);
    const newsSentiment = analyzeNews(newsArticles);

    // Merge live signals into stock object
    const liveStock = {
      ...stock,
      rsi:      signals.rsi,
      macd:     signals.macd,
      momentum: signals.momentum,
      ivr:      signals.ivr,
      newsSentiment: newsSentiment.signal,
    };

    // Score both call and put setups using live signals
    const callSetup = scoreSetup(liveStock, relStrength, signals.adx, todayVol, avgVol);
    const putSetup  = scorePutSetup(liveStock, relStrength, signals.adx, todayVol, avgVol);

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
      callSetup.score = Math.min(100, Math.max(0, callSetup.score + calMod));
      putSetup.score  = Math.min(100, Math.max(0, putSetup.score  + calMod));
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
    callSetup.score   = Math.min(100, Math.max(0, callSetup.score + regimeMod));
    putSetup.score    = Math.min(100, Math.max(0, putSetup.score  + regimePutMod));
    if (regimeMod !== 0) {
      callSetup.reasons.push(`Regime ${marketContext.regime?.regime}: ${regimeMod > 0 ? "+" : ""}${regimeMod}`);
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

    // In defensive mode - skip all call entries
    if (macro.mode === "defensive" && optionType === "call") {
      logEvent("filter", `${stock.ticker} - macro defensive mode - skipping calls`);
      continue;
    }

    const bestScore = Math.max(callSetup.score, putSetup.score);
    const optionType = putSetup.score > callSetup.score ? "put" : "call";
    const bestReasons = optionType === "put" ? putSetup.reasons : callSetup.reasons;

    const effectiveMinScore = ddProtocol.minScore || MIN_SCORE;
    if (bestScore < effectiveMinScore) {
      logEvent("filter", `${stock.ticker} call:${callSetup.score} put:${putSetup.score} - below ${effectiveMinScore} (${ddProtocol.level} protocol) - skip`);
      continue;
    }

    logEvent("filter", `${stock.ticker} best setup: ${optionType.toUpperCase()} score ${bestScore} | RSI:${signals.rsi} MACD:${signals.macd} MOM:${signals.momentum}`);
    scored.push({ stock: liveStock, price, score: bestScore, reasons: bestReasons, optionType });
    await new Promise(r=>setTimeout(r,400));
  }

  // Sort by score
  scored.sort((a,b) => b.score - a.score);

  // Enter trades
  for (const { stock, price, score, reasons, optionType } of scored) {
    if (heatPct() >= MAX_HEAT) break;
    if (state.cash <= CAPITAL_FLOOR) break;

    const { pass, reason } = await checkAllFilters(stock, price);
    if (!pass) { logEvent("filter", `${stock.ticker} - ${reason}`); continue; }

    const entered = await executeTrade(stock, price, score, reasons, state.vix, optionType);
    if (entered) await new Promise(r=>setTimeout(r,500));
  }

  // Check stock buys
  await checkStockBuys();

  state.lastScan = new Date().toISOString();
  await saveState();
  } catch(e) {
    logEvent("error", `runScan crashed: ${e.message}`);
  } finally {
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
const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

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
  if (!GMAIL_USER || !GMAIL_PASS) { logEvent("warn", "Email not configured"); return; }
  const subject = type === "morning"
    ? `APEX Morning Briefing - ${new Date().toLocaleDateString()}`
    : `APEX EOD Report - P&L ${(state.cash-state.dayStartCash)>=0?"+":""}$${(state.cash-state.dayStartCash).toFixed(2)}`;
  try {
    await mailer.sendMail({ from:GMAIL_USER, to:GMAIL_USER, subject, html:buildEmailHTML(type) });
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

// Morning reset + email 13:00 UTC = 9:00 AM EDT (UTC-4, DST in effect Mar-Nov)
// Note: becomes 14:00 UTC = 9:00 AM EST in winter (Nov-Mar)
cron.schedule("0 13 * * 1-5", async () => {
  state.dayStartCash      = state.cash;
  state.todayTrades       = 0;
  state.consecutiveLosses = 0;
  state.circuitOpen       = true;
  await saveState();
  sendEmail("morning");
});

// EOD email 20:05 UTC = 4:05 PM EDT (UTC-4)
cron.schedule("5 20 * * 1-5", () => { sendEmail("eod"); });

// Health check every 15 minutes during market hours
cron.schedule("*/15 13-20 * * 1-5", async () => {
  if (!isMarketHours()) return;
  const lastScan    = state.lastScan ? new Date(state.lastScan) : null;
  const minsSinceLastScan = lastScan ? (Date.now() - lastScan.getTime()) / 60000 : 999;
  if (minsSinceLastScan > 15 && GMAIL_USER && GMAIL_PASS) {
    logEvent("warn", `Health check: no scan in ${minsSinceLastScan.toFixed(0)} minutes - sending alert`);
    mailer.sendMail({
      from: GMAIL_USER,
      to:   GMAIL_USER,
      subject: "APEX ALERT - Scanner may be down",
      html: `<p>APEX has not scanned in ${minsSinceLastScan.toFixed(0)} minutes during market hours.</p>
             <p>Last scan: ${state.lastScan || "unknown"}</p>
             <p>Check Railway logs immediately.</p>`
    }).catch(e => console.error("Health alert email failed:", e.message));
  }
});

// Weekly reset Monday morning
cron.schedule("0 13 * * 1", async () => {
  state.weekStartCash     = state.cash;
  state.weeklyCircuitOpen = true;
  await saveState();
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
  await saveState();
  if (GMAIL_USER && GMAIL_PASS) {
    mailer.sendMail({
      from:GMAIL_USER, to:GMAIL_USER,
      subject:`APEX Monthly Report - ${et.toLocaleDateString("en-US",{month:"long",year:"numeric"})}`,
      text: report,
    }).catch(e => logEvent("error","Monthly email: "+e.message));
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
app.post("/api/close/:tkr",  (req,res) => {
  const t = req.params.tkr.toUpperCase();
  if (!state.positions.find(p=>p.ticker===t)) { res.status(404).json({error:"No position"}); return; }
  closePosition(t,"manual");
  res.json({ok:true});
});
// Emergency close all positions
app.post("/api/emergency-close", async (req, res) => {
  const count = state.positions.length;
  for (const pos of [...state.positions]) {
    await closePosition(pos.ticker, "emergency-manual");
  }
  logEvent("circuit", `EMERGENCY CLOSE ALL - ${count} positions closed manually`);
  await saveState();
  res.json({ ok: true, closed: count });
});

// Test options chain endpoint — verify Pro data access
app.get("/api/test-options/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const price  = await getStockQuote(ticker);
  if (!price) return res.json({ error: "Could not get stock price" });

  // Test raw options contracts endpoint
  const today      = getETTime();
  const minExpiry  = new Date(today.getTime() + 7  * 86400000).toISOString().split("T")[0];
  const maxExpiry  = new Date(today.getTime() + 60 * 86400000).toISOString().split("T")[0];
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

// Reset circuit breakers without wiping everything else
app.post("/api/reset-circuit", async (req, res) => {
  state.circuitOpen       = true;
  state.weeklyCircuitOpen = true;
  state.consecutiveLosses = 0;
  state.dayStartCash      = state.cash + openRisk();
  state.weekStartCash     = state.cash + openRisk();
  await saveState();
  logEvent("reset", "Circuit breakers manually reset");
  res.json({ ok: true });
});

app.post("/api/reset-month", async (req, res) => {
  state.cash=MONTHLY_BUDGET+state.extraBudget; state.todayTrades=0;
  state.monthStart=new Date().toLocaleDateString(); state.dayStartCash=state.cash;
  state.circuitOpen=true; state.weeklyCircuitOpen=true; state.monthlyProfit=0;
  logEvent("reset",`Month reset - cash: ${fmt(state.cash)}`); res.json({ok:true});
});
app.get("/api/journal",      (req,res) => res.json(state.tradeJournal.slice(0,50)));
app.get("/api/report",       (req,res) => res.json({report:buildMonthlyReport()}));

// - New Feature Endpoints -

// ── Safe Reporting Metrics ───────────────────────────────────────────────

// Calmar Ratio — annualized return / max drawdown
function calcCalmarRatio() {
  const trades    = state.closedTrades || [];
  if (trades.length < 5) return 0;
  const totalPnL  = trades.reduce((s, t) => s + t.pnl, 0);
  const startDate = new Date(trades[trades.length-1]?.date || Date.now());
  const years     = Math.max(0.1, (Date.now() - startDate.getTime()) / (365 * 86400000));
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
        durations.push(Math.round((new Date(trade.date) - new Date(ddStart)) / 86400000));
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
    ? Math.round((Date.now() - new Date(ddStart).getTime()) / 86400000) : 0;

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
    const dte      = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / 86400000));
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

    // Verbose logging every 5 ticks to debug pricing
    if (tick % 5 === 0) {
      simLogEvent("scan", `  ${pos.ticker} | stock:$${price.toFixed(0)} strike:$${pos.strike} ITM:$${intrinsic.toFixed(0)} | prem:$${curP} entry:$${pos.premium} chg:${(chg*100).toFixed(1)}%`);
    }

    let exitReason = null;

    // Update trailing stop — activates at +30%, trails 15% below peak
    if (chg >= TRAIL_ACTIVATE_PCT) {
      const simTrail = pos.peakPremium * (1 - TRAIL_STOP_PCT);
      pos.trailStop  = simTrail;
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
        expDate: new Date(Date.now() + 30 * 86400000).toLocaleDateString(),
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
    const allBars = {};
    for (const stock of WATCHLIST) {
      let bars = await getStockBars(stock.ticker, limit);
      // Retry once with longer delay and smaller limit if empty
      if (!bars.length) {
        await new Promise(r => setTimeout(r, 2000));
        bars = await getStockBars(stock.ticker, Math.min(limit, 60));
      }
      if (bars.length > 10) allBars[stock.ticker] = bars;
      await new Promise(r => setTimeout(r, 500)); // longer rate limit buffer
    }
    await new Promise(r => setTimeout(r, 1000));
    let spyBars = await getStockBars("SPY", limit);
    if (!spyBars.length) {
      await new Promise(r => setTimeout(r, 2000));
      spyBars = await getStockBars("SPY", Math.min(limit, 60));
    }
    if (!spyBars.length) throw new Error("Could not fetch SPY bars — check Alpaca subscription is active");

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
        const curP     = parseFloat((curPrice * pos.iv * Math.sqrt(dte / 365) * 0.4 + 0.1).toFixed(2));
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
        const stockRet  = slice.length >= 5 ? (slice[slice.length-1].c - slice[0].c) / slice[0].c : 0;
        const relStr    = spyReturn !== 0 ? (1 + stockRet) / (1 + spyReturn) : 1;
        const rsi       = calcRSI(slice);
        const macdData  = calcMACD(slice);
        const momentum  = calcMomentum(slice);
        const adx       = calcADX(slice);
        const avgVol    = slice.slice(-20).reduce((s, b) => s + b.v, 0) / Math.min(20, slice.length);
        const todayVol  = slice[slice.length-1].v;
        const liveStock = { ...stock, rsi, macd: macdData.signal, momentum };
        const callSetup = scoreSetup(liveStock, relStr, adx, todayVol, avgVol);
        const putSetup  = scorePutSetup(liveStock, relStr, adx, todayVol, avgVol);
        const bestScore = Math.max(callSetup.score, putSetup.score);
        const optionType= putSetup.score > callSetup.score ? "put" : "call";
        if (bestScore < MIN_SCORE) continue;
        const price     = bars[dayIdx].c;
        const iv        = 0.25 + stock.ivr * 0.003;
        const expDays   = stock.expiryDays || 30;
        const premium   = parseFloat((price * iv * Math.sqrt(expDays / 365) * 0.4 + 0.3).toFixed(2));
        const contracts = Math.max(1, Math.floor((cash * 0.10) / (premium * 100)));
        const cost      = parseFloat((premium * 100 * contracts).toFixed(2));
        if (cost > cash - CAPITAL_FLOOR) continue;
        cash -= cost;
        openPositions.push({ ticker: stock.ticker, optionType, premium, contracts, cost, iv, expDays, entryDay: dayIdx, score: bestScore });
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

app.get("/api/attribution",  (req,res) => res.json({
  byTicker:     getPnLByTicker(),
  bySector:     getPnLBySector(),
  byScoreRange: getPnLByScoreRange(),
}));

app.get("/api/taxlog",       (req,res) => res.json(getTaxLog()));

app.get("/api/theta",        (req,res) => {
  const positions = state.positions.map(pos => {
    const dte      = Math.max(1, Math.round((new Date(pos.expDate)-new Date())/86400000));
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
  await saveState();
  res.json({ok:true, cash:state.cash});
});
app.get("/health",           (req,res) => res.json({status:"ok",uptime:process.uptime(),vix:state.vix,positions:state.positions.length}));

// Boot sequence - load state from Redis then start server
initState().then(() => {
  app.listen(PORT, () => {
    console.log(`APEX v3.5 running on port ${PORT}`);
    console.log(`Alpaca key:  ${ALPACA_KEY?"SET":"NOT SET"}`);
    console.log(`Gmail:       ${GMAIL_USER||"NOT SET"}`);
    console.log(`Redis:       ${REDIS_URL?"SET":"NOT SET - using file fallback"}`);
    console.log(`Budget:      $${state.cash} | Floor: $${CAPITAL_FLOOR}`);
    console.log(`Positions:   ${state.positions.length} open`);
    console.log(`Scan:        every 30 seconds, 9AM-4PM ET Mon-Fri`);
    console.log(`Entry window: 10AM-3:30PM ET`);
  });
});
