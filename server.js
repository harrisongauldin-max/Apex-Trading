// -
// APEX v2.0 - Professional Options Trading Agent
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

// Timeout wrapper — kills hung API calls after 5 seconds
function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("API timeout")), ms))
  ]);
}

async function alpacaGet(endpoint, base = ALPACA_BASE) {
  try {
    const res = await withTimeout(fetch(`${base}${endpoint}`, { headers: alpacaHeaders() }));
    return await res.json();
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
  const data = await alpacaGet(`/stocks/${ticker}/bars?timeframe=1Day&limit=${limit}`, ALPACA_DATA);
  return data && data.bars ? data.bars : [];
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

// - Macro News Scanner -
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

    const data = await alpacaGet(url, ALPACA_DATA);
    if (!data || !data.option_contracts || !data.option_contracts.length) return null;

    // Get snapshots for the contracts to get real greeks + IV + quotes
    const symbols   = data.option_contracts.slice(0, 20).map(c => c.symbol).join(",");
    const snapData  = await alpacaGet(`/options/snapshots?symbols=${symbols}`, ALPACA_DATA);
    const snapshots = snapData && snapData.snapshots ? snapData.snapshots : {};

    // Score each contract — find best delta match in 0.28-0.42 range
    // and best liquidity (open interest + volume)
    let best = null;
    let bestScore = -1;

    for (const contract of data.option_contracts) {
      const snap    = snapshots[contract.symbol];
      if (!snap) continue;

      const greeks  = snap.greeks || {};
      const quote   = snap.latestQuote || {};
      const delta   = Math.abs(parseFloat(greeks.delta || 0));
      const iv      = parseFloat(greeks.implied_volatility || greeks.iv || 0.3);
      const bid     = parseFloat(quote.bp || 0);
      const ask     = parseFloat(quote.ap || 0);
      const mid     = (bid + ask) / 2;
      const spread  = ask > 0 ? (ask - bid) / ask : 1;
      const oi      = parseInt(snap.openInterest || snap.open_interest || 0);
      const vol     = parseInt(snap.day?.volume || 0);

      // Skip illiquid contracts
      if (bid <= 0 || ask <= 0) continue;
      if (spread > MAX_SPREAD_PCT) continue;
      if (oi < MIN_OPEN_INTEREST) continue;

      // Skip if delta outside target range
      if (delta < TARGET_DELTA_MIN || delta > TARGET_DELTA_MAX) continue;

      // Score this contract - closer to 0.35 delta is better
      const deltaScore  = 1 - Math.abs(delta - 0.35) / 0.35;
      const liquidScore = Math.min(oi / 5000, 1);
      const contractScore = deltaScore * 0.6 + liquidScore * 0.4;

      if (contractScore > bestScore) {
        bestScore = contractScore;
        best = {
          symbol:     contract.symbol,
          strike:     parseFloat(contract.strike_price),
          expDate:    new Date(contract.expiration_date).toLocaleDateString("en-US", {month:"short",day:"2-digit",year:"numeric"}),
          expDays:    Math.round((new Date(contract.expiration_date) - today) / 86400000),
          expiryType,
          premium:    parseFloat(mid.toFixed(2)),
          bid, ask, spread,
          greeks: {
            delta:  parseFloat(greeks.delta || 0).toFixed(3),
            theta:  parseFloat(greeks.theta || 0).toFixed(3),
            gamma:  parseFloat(greeks.gamma || 0).toFixed(4),
            vega:   parseFloat(greeks.vega  || 0).toFixed(3),
          },
          iv, oi, vol, optionType,
        };
      }
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
    const data = await alpacaGet(`/options/snapshots?symbols=${symbol}`, ALPACA_DATA);
    if (!data || !data.snapshots || !data.snapshots[symbol]) return null;
    const snap  = data.snapshots[symbol];
    const quote = snap.latestQuote || {};
    const bid   = parseFloat(quote.bp || 0);
    const ask   = parseFloat(quote.ap || 0);
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

  // 10. IVR
  if (stock.ivr > IVR_MAX) return { pass:false, reason:`IVR ${stock.ivr} > ${IVR_MAX}` };

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
function calcPositionSize(premium, score, vix) {
  // Kelly Criterion base
  const winRate  = 0.55; // assumed 55% win rate for moderate strategy
  const avgWin   = TAKE_PROFIT_PCT;
  const avgLoss  = STOP_LOSS_PCT;
  const kelly    = (winRate * avgWin - (1-winRate) * avgLoss) / avgWin;
  const halfKelly= kelly * 0.5;

  // Score-based sizing
  const scoreMult = score >= FULL_KELLY_SCORE ? halfKelly : halfKelly * 0.6;

  // VIX-based sizing reduction
  const vixMult = vix >= VIX_REDUCE50 ? 0.5 : vix >= VIX_REDUCE25 ? 0.75 : 1.0;

  // Drawdown recovery mode - reduce sizing 25%
  const recoveryMult = isDrawdownRecovery() ? (1 - DRAWDOWN_SIZING_REDUCE) : 1.0;
  if (isDrawdownRecovery()) logEvent("warn", "Drawdown recovery mode active - sizing reduced 25%");

  // Max per position
  const maxCost    = Math.min(state.cash * scoreMult * vixMult * recoveryMult, state.cash * 0.25, MAX_LOSS_PER_TRADE / STOP_LOSS_PCT);
  const contracts  = Math.max(1, Math.min(5, Math.floor(maxCost / (premium * 100))));
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
    expiryType:     contract.expiryType,
    currentPrice:   contract.premium,
    contractSymbol: contract.symbol,
    bid:            contract.bid,
    ask:            contract.ask,
    realData:       !!contract.symbol,
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
  macro:          { signal: "neutral", scoreModifier: 0, mode: "normal", triggers: [], sectorBearish: [], sectorBullish: [], headlines: [] },
  macroCalendar:  { modifier: 0, events: [], message: "" },
  betaWeightedDelta: 0,
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
    logEvent("scan", `[5min] Breadth:${breadth.breadthPct}% | Leading:${rotation.leading} | BWD:${marketContext.betaWeightedDelta}`);
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

    // Trailing stop - activate at +30%
    if (chg >= TRAIL_ACTIVATE_PCT) {
      const trailStop = pos.peakPremium * (1 - TRAIL_STOP_PCT);
      pos.trailStop   = trailStop;
      if (curP <= trailStop) {
        logEvent("scan", `${pos.ticker} trailing stop hit - peak $${pos.peakPremium.toFixed(2)} trail $${trailStop.toFixed(2)}`);
        closePosition(pos.ticker, "trail"); continue;
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

    // Dynamic signals - calculated live from real price bars
    const signals = await getDynamicSignals(stock.ticker, bars);

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

    if (bestScore < MIN_SCORE) {
      logEvent("filter", `${stock.ticker} call:${callSetup.score} put:${putSetup.score} - both below ${MIN_SCORE} - skip`);
      continue;
    }

    logEvent("filter", `${stock.ticker} best setup: ${optionType.toUpperCase()} score ${bestScore} | RSI:${signals.rsi} MACD:${signals.macd} MOM:${signals.momentum}`);
    scored.push({ stock: liveStock, price, score: bestScore, reasons: bestReasons, optionType });
    await new Promise(r=>setTimeout(r,200));
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
    console.log(`APEX v2.0 running on port ${PORT}`);
    console.log(`Alpaca key:  ${ALPACA_KEY?"SET":"NOT SET"}`);
    console.log(`Gmail:       ${GMAIL_USER||"NOT SET"}`);
    console.log(`Redis:       ${REDIS_URL?"SET":"NOT SET - using file fallback"}`);
    console.log(`Budget:      $${state.cash} | Floor: $${CAPITAL_FLOOR}`);
    console.log(`Positions:   ${state.positions.length} open`);
    console.log(`Scan:        every 30 seconds, 9AM-4PM ET Mon-Fri`);
    console.log(`Entry window: 10AM-3:30PM ET`);
  });
});
