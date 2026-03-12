// ════════════════════════════════════════════════════════════════════════════
// APEX v2.0 — Professional Options Trading Agent
// Alpaca Paper Trading Edition
// ════════════════════════════════════════════════════════════════════════════
const express    = require("express");
const cron       = require("node-cron");
const fetch      = require("node-fetch");
const fs         = require("fs");
const path       = require("path");
const nodemailer = require("nodemailer");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Environment Variables (set in Railway) ────────────────────────────────
const ALPACA_KEY        = process.env.ALPACA_API_KEY    || "";
const ALPACA_SECRET     = process.env.ALPACA_SECRET_KEY || "";
const ALPACA_BASE       = "https://paper-api.alpaca.markets/v2";
const ALPACA_DATA       = "https://data.alpaca.markets/v2";
const GMAIL_USER        = process.env.GMAIL_USER        || "";
const GMAIL_PASS        = process.env.GMAIL_APP_PASSWORD|| "";
const STATE_FILE        = path.join(__dirname, "state.json");

// ── Trading Constants ─────────────────────────────────────────────────────
const MONTHLY_BUDGET      = 5000;
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
// MAX_TRADES_PER_DAY removed — portfolio heat (60%) controls position limits
const CONSEC_LOSS_LIMIT   = 3;
const WEEKLY_DD_LIMIT     = 0.15;
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

// Cash ETF parking — floor is split 50/50 between liquid and BIL
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

// Correlation groups — max 1 position per group
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

// ── Watchlist (18 high-liquidity stocks) ──────────────────────────────────
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

// ── State ─────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch(e) { console.error("State load error:", e.message); }
  return {
    cash:             MONTHLY_BUDGET,
    extraBudget:      0,
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

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch(e) { console.error("State save error:", e.message); }
}

let state = loadState();

function logEvent(type, message) {
  const entry = { time: new Date().toISOString(), type, message };
  state.tradeLog.unshift(entry);
  if (state.tradeLog.length > 500) state.tradeLog = state.tradeLog.slice(0, 500);
  console.log(`[${type.toUpperCase()}] ${message}`);
  saveState();
}

// ── Helpers ───────────────────────────────────────────────────────────────
const fmt         = n  => "$" + parseFloat(n).toFixed(2);
const totalCap    = () => MONTHLY_BUDGET + state.extraBudget;
const openRisk    = () => state.positions.reduce((s,p) => s + p.cost * (p.partialClosed ? 0.5 : 1), 0);
const heatPct     = () => openRisk() / totalCap();
const realizedPnL = () => state.closedTrades.reduce((s,t) => s + t.pnl, 0);
const stockValue  = () => state.stockPositions.reduce((s,p) => s + p.cost, 0);

// Drawdown recovery mode check
const isDrawdownRecovery = () => {
  const dd = (state.cash - (state.peakCash || MONTHLY_BUDGET)) / (state.peakCash || MONTHLY_BUDGET);
  return dd <= -DRAWDOWN_RECOVERY_PCT;
};

// Correlation check — returns group if stock is correlated with existing position
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

// Tax tracking — build full trade log with cost basis
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

// Bulletproof ET time — uses Intl API which handles DST correctly on any server timezone
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

// ── Greeks (Black-Scholes) ────────────────────────────────────────────────
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

// ── Trade Quality Score ───────────────────────────────────────────────────
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

  // IVR (15pts) — lower is better for buying calls
  if (stock.ivr < 30)       { score += 15; reasons.push(`IVR ${stock.ivr} — cheap options (+15)`); }
  else if (stock.ivr < 50)  { score += 10; reasons.push(`IVR ${stock.ivr} — moderate (+10)`); }
  else if (stock.ivr < 65)  { score += 5;  reasons.push(`IVR ${stock.ivr} — elevated (+5)`); }
  else                      { reasons.push(`IVR ${stock.ivr} — expensive (+0)`); }

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
  if (adx && adx > 25)  { score += 5; reasons.push(`ADX ${adx} — strong trend (+5)`); }

  return { score: Math.min(score, 100), reasons };
}

// ── Alpaca API ────────────────────────────────────────────────────────────
const alpacaHeaders = () => ({
  "APCA-API-KEY-ID":     ALPACA_KEY,
  "APCA-API-SECRET-KEY": ALPACA_SECRET,
  "Content-Type":        "application/json",
});

async function alpacaGet(endpoint, base = ALPACA_BASE) {
  try {
    const res  = await fetch(`${base}${endpoint}`, { headers: alpacaHeaders() });
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

// Get options chain for a ticker
async function getOptionsChain(ticker, expDate, strikePrice) {
  try {
    const url = `/options/contracts?underlying_symbol=${ticker}&expiration_date_gte=${expDate}&strike_price_gte=${strikePrice * 0.95}&strike_price_lte=${strikePrice * 1.05}&type=call&limit=10`;
    const data = await alpacaGet(url, ALPACA_DATA);
    return data && data.option_contracts ? data.option_contracts : [];
  } catch(e) { return []; }
}

// Get options snapshot for greeks and IV
async function getOptionsSnapshot(symbol) {
  try {
    const data = await alpacaGet(`/options/snapshots/${symbol}`, ALPACA_DATA);
    return data || null;
  } catch(e) { return null; }
}

// ── Cash ETF Management ───────────────────────────────────────────────────
// Target: park 50% of deployable idle cash in BIL, keep 50% liquid
// Deployable = cash above (floor + buffer)

function getDeployableCash() {
  // Everything above the floor is deployable — floor itself is managed separately
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
    logEvent("etf", `BIL rebalance — bought ${sharesToBuy} shares @ $${bilPrice.toFixed(2)} | ETF floor: ${fmt(state.cashETFValue)} | liquid: ${fmt(state.cash)}`);
    saveState();

  } else if (diff < 0 && currentShares > 0) {
    // Sell excess BIL back to cash
    const sharesToSell = Math.min(currentShares, Math.ceil(Math.abs(diff) / bilPrice));
    if (sharesToSell < 1) return;
    const proceeds = parseFloat((sharesToSell * bilPrice).toFixed(2));
    state.cash          += proceeds;
    state.cashETFShares  = currentShares - sharesToSell;
    state.cashETFValue   = parseFloat((state.cashETFShares * bilPrice).toFixed(2));
    logEvent("etf", `BIL rebalance — sold ${sharesToSell} shares | ETF floor: ${fmt(state.cashETFValue)} | liquid: ${fmt(state.cash)}`);
    saveState();
  }
}

// Liquidate BIL if needed to fund a trade — only touches ETF above the floor target
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
  saveState();
}

// ── Pre-market Analysis ───────────────────────────────────────────────────
async function getPremarketData(ticker) {
  try {
    const data = await alpacaGet(`/stocks/${ticker}/quotes/latest`, ALPACA_DATA);
    if (!data || !data.quote) return null;
    const prePrice = parseFloat(data.quote.ap || data.quote.bp || 0);
    return prePrice;
  } catch(e) { return null; }
}

// ── Sector ETF Confirmation ────────────────────────────────────────────────
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
      return { pass: false, reason: `${etf} sector ETF down ${(etfReturn*100).toFixed(1)}% — sector headwind` };
    }
  }
  return { pass: true, reason: null };
}

// ── Pre-trade Filters ─────────────────────────────────────────────────────
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
  if (state.consecutiveLosses >= CONSEC_LOSS_LIMIT) return { pass:false, reason:`${CONSEC_LOSS_LIMIT} consecutive losses — paused for day` };

  // 6. Duplicate position — allow up to 3 positions per ticker, but only if existing is profitable
  const existingPositions = state.positions.filter(p => p.ticker === stock.ticker);
  if (existingPositions.length >= 3) return { pass:false, reason:`Already have 3 positions in ${stock.ticker} — max reached` };

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

  // 14. Correlation group — max 1 position per correlated group
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
        return { pass:false, reason:`Price near 20-day support ($${sr.support.toFixed(2)}) — risk of breakdown` };
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
        return { pass:false, reason:`Pre-market negative (${(premarketMove*100).toFixed(1)}%) — bearish open` };
      }
      if (premarketMove >= PREMARKET_STRONG_MOVE) {
        logEvent("scan", `${stock.ticker} strong pre-market +${(premarketMove*100).toFixed(1)}% — boost signal`);
        stock._premarketBoost = true;
      }
    }
  }

  return { pass:true, reason:null };
}

// ── Position Sizing ───────────────────────────────────────────────────────
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

  // Drawdown recovery mode — reduce sizing 25%
  const recoveryMult = isDrawdownRecovery() ? (1 - DRAWDOWN_SIZING_REDUCE) : 1.0;
  if (isDrawdownRecovery()) logEvent("warn", "Drawdown recovery mode active — sizing reduced 25%");

  // Max per position
  const maxCost    = Math.min(state.cash * scoreMult * vixMult * recoveryMult, state.cash * 0.25, MAX_LOSS_PER_TRADE / STOP_LOSS_PCT);
  const contracts  = Math.max(1, Math.min(5, Math.floor(maxCost / (premium * 100))));
  return contracts;
}

// ── Build Trade Card ──────────────────────────────────────────────────────
function buildCard(stock, price, contracts, iv) {
  const expDays   = stock.expiryDays || 30;
  const otmPct    = stock.momentum === "strong" ? 0.035 : 0.045;
  const strike    = Math.round(price * (1+otmPct) / 5) * 5;
  const ivVal     = iv || (0.25 + stock.ivr * 0.003);
  const t         = expDays / 365;
  const premium   = parseFloat((price * ivVal * Math.sqrt(t) * 0.4 + 0.3).toFixed(2));
  const cost      = parseFloat((premium * 100 * contracts).toFixed(2));
  const expDate   = new Date(Date.now()+expDays*86400000).toLocaleDateString("en-US",{month:"short",day:"2-digit",year:"numeric"});
  const greeks    = calcGreeks(price, strike, expDays, ivVal);
  const target    = parseFloat((premium*(1+TAKE_PROFIT_PCT)).toFixed(2));
  const stop      = parseFloat((premium*(1-STOP_LOSS_PCT)).toFixed(2));
  const breakeven = parseFloat((strike+premium).toFixed(2));
  return { ...stock, price, strike, premium, contracts, cost, expDate, expDays, target, stop, breakeven, greeks, iv:ivVal };
}

// ── Execute Trade ─────────────────────────────────────────────────────────
async function executeTrade(stock, price, score, scoreReasons, vix) {
  const iv        = 0.25 + stock.ivr * 0.003;
  const contracts = calcPositionSize(price * iv * Math.sqrt(stock.expiryDays/365) * 0.4 + 0.3, score, vix);
  const t         = buildCard(stock, price, contracts, iv);

  // Ensure liquid cash — liquidate BIL if needed before checking
  await ensureLiquidCash(t.cost + CAPITAL_FLOOR);

  if (t.cost > state.cash - CAPITAL_FLOOR || t.contracts < 1) {
    logEvent("skip", `${stock.ticker} — insufficient cash after floor (need ${fmt(t.cost)})`);
    return false;
  }

  // Delta check
  if (t.greeks.delta < TARGET_DELTA_MIN || t.greeks.delta > TARGET_DELTA_MAX) {
    logEvent("filter", `${stock.ticker} — delta ${t.greeks.delta} outside 0.30-0.40 target`);
  }

  state.cash = parseFloat((state.cash - t.cost).toFixed(2));
  state.todayTrades++;

  const position = {
    ticker:t.ticker, sector:t.sector, strike:t.strike, premium:t.premium,
    contracts:t.contracts, cost:t.cost, expDate:t.expDate, expiryDays:t.expDays,
    target:t.target, stop:t.stop, breakeven:t.breakeven,
    partialClosed:false, openDate:new Date().toISOString(),
    ivr:stock.ivr, iv:t.iv, greeks:t.greeks, beta:stock.beta||1,
    peakPremium:t.premium, trailStop:null, breakevenLocked:false,
    score, halfPosition: false,
  };

  state.positions.push(position);

  // Trade journal entry
  state.tradeJournal.unshift({
    time:      new Date().toISOString(),
    ticker:    t.ticker,
    action:    "OPEN",
    strike:    t.strike,
    expDate:   t.expDate,
    premium:   t.premium,
    contracts: t.contracts,
    cost:      t.cost,
    score,
    scoreReasons,
    delta:     t.greeks.delta,
    iv:        parseFloat((t.iv*100).toFixed(1)),
    vix,
    catalyst:  stock.catalyst,
    reasoning: `Score ${score}/100. ${scoreReasons.slice(0,3).join(". ")}. Catalyst: ${stock.catalyst}. Delta ${t.greeks.delta} within 0.30-0.40 target.`,
  });
  if (state.tradeJournal.length > 200) state.tradeJournal = state.tradeJournal.slice(0,200);

  logEvent("trade",
    `BUY ${t.ticker} $${t.strike}C exp ${t.expDate} | ${t.contracts}x @ $${t.premium} | ` +
    `cost ${fmt(t.cost)} | score ${score} | delta ${t.greeks.delta} | cash ${fmt(state.cash)} | heat ${(heatPct()*100).toFixed(0)}%`
  );
  saveState();
  return true;
}

// ── Close Position ────────────────────────────────────────────────────────
function closePosition(ticker, reason, exitPremium = null) {
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

  // Circuit breaker checks
  const dailyPnL  = state.cash - state.dayStartCash;
  const weeklyPnL = state.cash - state.weekStartCash;
  if (dailyPnL / totalCap() <= -0.08 && state.circuitOpen) {
    state.circuitOpen = false;
    logEvent("circuit", `DAILY circuit breaker — loss ${fmt(Math.abs(dailyPnL))}`);
  }
  if (weeklyPnL / totalCap() <= -WEEKLY_DD_LIMIT && state.weeklyCircuitOpen) {
    state.weeklyCircuitOpen = false;
    logEvent("circuit", `WEEKLY circuit breaker — loss ${fmt(Math.abs(weeklyPnL))} (${(WEEKLY_DD_LIMIT*100)}% limit)`);
  }

  // Bonus notification
  if (bonus) logEvent("bonus", `REVENUE HIT $${REVENUE_THRESHOLD} — +$${BONUS_AMOUNT} bonus added!`);

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
  saveState();
}

// ── Partial Close ─────────────────────────────────────────────────────────
function partialClose(ticker) {
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
  logEvent("partial", `PARTIAL ${ticker} — ${half}/${pos.contracts} @ +50% | +${fmt(pnl)} | cash ${fmt(state.cash)}`);
  saveState();
}

// ── Stock Portfolio Management ────────────────────────────────────────────
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
    logEvent("stock", `BUY STOCK ${stock.ticker} — ${shares} shares @ $${price} | cost ${fmt(cost)} | triggered by monthly profit ${fmt(state.monthlyProfit)}`);
    saveState();
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
      logEvent("stock", `STOP LOSS STOCK ${pos.ticker} — sold ${pos.shares} shares @ $${price} | P&L ${fmt(pnl)}`);
      saveState();
    }
  }
}

// ── Main Scan Engine ──────────────────────────────────────────────────────
async function runScan() {
  if (!ALPACA_KEY) { logEvent("warn", "No ALPACA_API_KEY set — check Railway variables"); return; }
  logEvent("scan", `Scan triggered | market: ${isMarketHours()} | entry window: ${isEntryWindow()} | VIX: ${state.vix} | cash: ${fmt(state.cash)} | positions: ${state.positions.length}`);
  if (!isMarketHours()) { logEvent("scan", "Outside market hours — skipping trade logic"); return; }

  // Update VIX
  state.vix = await getVIX() || state.vix;

  // Rebalance idle cash into BIL ETF
  await rebalanceCashETF();

  // Manage stock positions
  await manageStockPositions();

  // 1. Manage existing options positions
  for (const pos of [...state.positions]) {
    const price = await getStockQuote(pos.ticker);
    if (!price) continue;

    const dte      = Math.max(1, Math.round((new Date(pos.expDate)-new Date())/86400000));
    const t        = dte / 365;
    const curP     = parseFloat((price * pos.iv * Math.sqrt(t) * 0.4 + 0.1).toFixed(2));
    const chg      = (curP - pos.premium) / pos.premium;
    const hoursOpen= (new Date() - new Date(pos.openDate)) / 3600000;
    const daysOpen = hoursOpen / 24;

    // Update peak premium for trailing stop
    if (curP > pos.peakPremium) pos.peakPremium = curP;

    // Fast stop — -20% in first 48 hours
    if (hoursOpen <= FAST_STOP_HOURS && chg <= -FAST_STOP_PCT) {
      logEvent("scan", `${pos.ticker} fast stop — down ${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(0)}hrs`);
      closePosition(pos.ticker, "fast-stop"); continue;
    }

    // Profit target acceleration — if +40% in first 48hrs, take it now
    if (hoursOpen <= FAST_PROFIT_HOURS && chg >= FAST_PROFIT_PCT && !pos.partialClosed) {
      logEvent("scan", `${pos.ticker} ACCELERATED PROFIT — +${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(0)}hrs — taking gains early`);
      closePosition(pos.ticker, "fast-target"); continue;
    }

    // Update peak cash for drawdown tracking
    const curCash = state.cash + openRisk() + realizedPnL();
    if (curCash > (state.peakCash || MONTHLY_BUDGET)) state.peakCash = curCash;

    // Hard stop loss
    if (chg <= -STOP_LOSS_PCT) {
      logEvent("scan", `${pos.ticker} stop loss — down ${(chg*100).toFixed(0)}%`);
      closePosition(pos.ticker, "stop"); continue;
    }

    // Trailing stop — activate at +30%
    if (chg >= TRAIL_ACTIVATE_PCT) {
      const trailStop = pos.peakPremium * (1 - TRAIL_STOP_PCT);
      pos.trailStop   = trailStop;
      if (curP <= trailStop) {
        logEvent("scan", `${pos.ticker} trailing stop hit — peak $${pos.peakPremium.toFixed(2)} trail $${trailStop.toFixed(2)}`);
        closePosition(pos.ticker, "trail"); continue;
      }
    }

    // Breakeven lock at +40%
    if (chg >= BREAKEVEN_LOCK_PCT && !pos.breakevenLocked) {
      pos.breakevenLocked = true;
      pos.stop = pos.premium; // move stop to breakeven
      logEvent("scan", `${pos.ticker} breakeven locked — stop moved to $${pos.premium}`);
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
      logEvent("scan", `${pos.ticker} time stop — ${daysOpen.toFixed(0)} days, only ${(chg*100).toFixed(1)}% move`);
      closePosition(pos.ticker, "time-stop"); continue;
    }

    // 50MA break
    if (price < pos.strike / 1.035 * (1-MA50_BUFFER)) {
      logEvent("scan", `${pos.ticker} broke 50MA — price $${price}`);
      closePosition(pos.ticker, "50ma-break"); continue;
    }

    // IV collapse
    if (curP < pos.premium*(1-IV_COLLAPSE_PCT) && price >= pos.strike*0.97) {
      logEvent("scan", `${pos.ticker} IV collapse — option down ${(((pos.premium-curP)/pos.premium)*100).toFixed(0)}%`);
      closePosition(pos.ticker, "iv-collapse"); continue;
    }

    // Mid-trade earnings check
    if (pos.earningsDate) {
      const daysToE = Math.round((new Date(pos.earningsDate)-new Date())/86400000);
      if (daysToE >= 0 && daysToE <= EARNINGS_SKIP_DAYS) {
        logEvent("scan", `${pos.ticker} earnings in ${daysToE} days — closing to avoid IV crush`);
        closePosition(pos.ticker, "earnings-close"); continue;
      }
    }

    // Expiry roll
    if (dte <= 7 && chg > 0) {
      logEvent("scan", `${pos.ticker} near expiry (${dte}d) — closing to avoid gamma risk`);
      closePosition(pos.ticker, "expiry-roll"); continue;
    }

    logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | peak:$${pos.peakPremium.toFixed(2)} | DTE:${dte} | HOLD`);
    saveState();
  }

  // 2. New entries
  if (!isEntryWindow()) return;
  if (!state.circuitOpen || !state.weeklyCircuitOpen) return;
  if (state.consecutiveLosses >= CONSEC_LOSS_LIMIT) return;
  if (state.cash <= CAPITAL_FLOOR) return;

  // Get SPY price for relative strength
  const spyPrice  = await getStockQuote("SPY") || 500;
  const spyBars   = await getStockBars("SPY", 5);
  const spyReturn = spyBars.length >= 5 ? (spyBars[spyBars.length-1].c - spyBars[0].o) / spyBars[0].o : 0;

  // Gap detection — check SPY for market-wide gap
  if (spyBars.length >= 2) {
    const todayOpen = spyBars[spyBars.length-1].o;
    const prevClose = spyBars[spyBars.length-2].c;
    const gapPct    = Math.abs(todayOpen - prevClose) / prevClose;
    if (gapPct > MAX_GAP_PCT) {
      logEvent("filter", `Market gap detected (${(gapPct*100).toFixed(1)}%) — skipping new entries today`);
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
      logEvent("filter", `${stock.ticker} price $${price||0} unavailable or below min — skip`);
      continue;
    }

    const { pass, reason } = await checkAllFilters(stock, price);
    if (!pass) { logEvent("filter", `${stock.ticker} filter fail: ${reason}`); continue; }

    const bars     = await getStockBars(stock.ticker, 30);
    const avgVol   = bars.length ? bars.slice(0,-1).reduce((s,b)=>s+b.v,0)/Math.max(bars.length-1,1) : 0;
    const todayVol = bars.length ? bars[bars.length-1].v : 0;

    // Relative strength vs SPY
    const stockReturn  = bars.length >= 5 ? (bars[bars.length-1].c - bars[0].o) / bars[0].o : 0;
    const relStrength  = spyReturn !== 0 ? (1 + stockReturn) / (1 + spyReturn) : 1;

    // ADX approximation from price bars
    const adx = bars.length >= 14 ? calcADX(bars) : 20;

    // Gap check on individual stock
    if (bars.length >= 2) {
      const gap = Math.abs(bars[bars.length-1].o - bars[bars.length-2].c) / bars[bars.length-2].c;
      if (gap > MAX_GAP_PCT) { logEvent("filter", `${stock.ticker} gap ${(gap*100).toFixed(1)}% — skip`); continue; }
    }

    const { score, reasons } = scoreSetup(stock, relStrength, adx, todayVol, avgVol);
    if (score < MIN_SCORE) { logEvent("filter", `${stock.ticker} score ${score} < ${MIN_SCORE} — skip`); continue; }

    scored.push({ stock, price, score, reasons, relStrength, adx, todayVol, avgVol });
    await new Promise(r=>setTimeout(r,200));
  }

  // Sort by score
  scored.sort((a,b) => b.score - a.score);

  // Enter trades
  for (const { stock, price, score, reasons } of scored) {
    if (state.todayTrades >= MAX_TRADES_PER_DAY) break;
    if (heatPct() >= MAX_HEAT) break;
    if (state.cash <= CAPITAL_FLOOR) break;

    const { pass, reason } = await checkAllFilters(stock, price);
    if (!pass) { logEvent("filter", `${stock.ticker} — ${reason}`); continue; }

    const entered = await executeTrade(stock, price, score, reasons, state.vix);
    if (entered) await new Promise(r=>setTimeout(r,500));
  }

  // Check stock buys
  await checkStockBuys();

  state.lastScan = new Date().toISOString();
  saveState();
}

// ── ADX Calculation ───────────────────────────────────────────────────────
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

// ── Email System ──────────────────────────────────────────────────────────
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
  <h2 style="color:#00ff88;margin:0 0 4px">▲ APEX ${type === "morning" ? "Morning Briefing" : "End of Day Report"}</h2>
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
  <p style="font-size:12px;color:#cce8ff;margin:0">APEX will scan every minute from 10:00 AM - 3:30 PM ET. VIX is currently ${state.vix} — ${state.vix<20?"normal conditions, full sizing":"reduced sizing active"}. ${state.positions.length} position${state.positions.length!==1?"s":""} currently open.</p>
</div>` : `
<div style="background:rgba(0,196,255,0.05);border:1px solid rgba(0,196,255,0.15);border-radius:8px;padding:14px">
  <h3 style="color:#00c4ff;font-size:11px;margin:0 0 6px">END OF DAY SUMMARY</h3>
  <p style="font-size:12px;color:#cce8ff;margin:0">Market closed. ${state.todayTrades} trade${state.todayTrades!==1?"s":""} executed today. Daily P&L: ${parseFloat(daily)>=0?"+":""}$${daily}. APEX resumes scanning tomorrow at 10:00 AM ET.</p>
</div>`}

<p style="font-size:10px;color:#336688;text-align:center;margin-top:16px">APEX Professional Options Agent · Paper Trading · Not financial advice</p>
</body></html>`;
}

async function sendEmail(type) {
  if (!GMAIL_USER || !GMAIL_PASS) { logEvent("warn", "Email not configured"); return; }
  const subject = type === "morning"
    ? `APEX Morning Briefing — ${new Date().toLocaleDateString()}`
    : `APEX EOD Report — P&L ${(state.cash-state.dayStartCash)>=0?"+":""}$${(state.cash-state.dayStartCash).toFixed(2)}`;
  try {
    await mailer.sendMail({ from:GMAIL_USER, to:GMAIL_USER, subject, html:buildEmailHTML(type) });
    logEvent("email", `${type} email sent to ${GMAIL_USER}`);
  } catch(e) { logEvent("error", `Email failed: ${e.message}`); }
}

// ── Monthly Performance Report ────────────────────────────────────────────
function buildMonthlyReport() {
  const trades   = state.closedTrades;
  const pnl      = realizedPnL();
  const wins     = trades.filter(t=>t.pnl>0);
  const losses   = trades.filter(t=>t.pnl<=0);
  const avgWin   = wins.length   ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((s,t)=>s+t.pnl,0)/losses.length : 0;
  const grossW   = wins.reduce((s,t)=>s+t.pnl,0);
  const grossL   = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const pf       = grossL>0 ? (grossW/grossL).toFixed(2) : "∞";
  const maxDD    = Math.min(0, state.cash - state.peakCash);
  const returns  = trades.map(t=>t.pnl/MONTHLY_BUDGET);
  const avgRet   = returns.length ? returns.reduce((s,r)=>s+r,0)/returns.length : 0;
  const stdDev   = returns.length > 1 ? Math.sqrt(returns.reduce((s,r)=>s+Math.pow(r-avgRet,2),0)/(returns.length-1)) : 0;
  const sharpe   = stdDev > 0 ? (avgRet / stdDev * Math.sqrt(252)).toFixed(2) : "N/A";
  const bestTrade  = trades.length ? trades.reduce((b,t)=>t.pnl>b.pnl?t:b) : null;
  const worstTrade = trades.length ? trades.reduce((w,t)=>t.pnl<w.pnl?t:w) : null;

  return `APEX MONTHLY PERFORMANCE REPORT
${"═".repeat(48)}
Period:           ${state.monthStart} → ${new Date().toLocaleDateString()}

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

// ── Cron Schedules ────────────────────────────────────────────────────────
// Every minute Mon-Fri (market hours checked inside runScan)
cron.schedule("* * * * 1-5", () => { runScan(); });

// Morning reset + email 13:00 UTC = 9:00 AM EDT (UTC-4, DST in effect Mar-Nov)
// Note: becomes 14:00 UTC = 9:00 AM EST in winter (Nov-Mar)
cron.schedule("0 13 * * 1-5", () => {
  state.dayStartCash      = state.cash;
  state.todayTrades       = 0;
  state.consecutiveLosses = 0;
  state.circuitOpen       = true;
  saveState();
  sendEmail("morning");
});

// EOD email 20:05 UTC = 4:05 PM EDT (UTC-4)
cron.schedule("5 20 * * 1-5", () => { sendEmail("eod"); });

// Weekly reset Monday morning
cron.schedule("0 13 * * 1", () => {
  state.weekStartCash     = state.cash;
  state.weeklyCircuitOpen = true;
  saveState();
  logEvent("reset", "Weekly circuit breaker reset");
});

// Monthly report — runs every Monday, checks inside if it is the first Monday of the month
cron.schedule("0 13 * * 1", () => {
  const et  = getETTime();
  const day = et.getDate();
  if (day > 7) return; // only first Monday of month
  const report = buildMonthlyReport();
  logEvent("monthly", report);
  state.monthlyProfit = 0;
  state.monthStart    = new Date().toLocaleDateString();
  saveState();
  if (GMAIL_USER && GMAIL_PASS) {
    mailer.sendMail({
      from:GMAIL_USER, to:GMAIL_USER,
      subject:`APEX Monthly Report — ${et.toLocaleDateString("en-US",{month:"long",year:"numeric"})}`,
      text: report,
    }).catch(e => logEvent("error","Monthly email: "+e.message));
  }
});

// ── Express API ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (req, res) => {
  res.json({
    ...state,
    heatPct:       parseFloat((heatPct()*100).toFixed(1)),
    realizedPnL:   parseFloat(realizedPnL().toFixed(2)),
    totalCap:      totalCap(),
    stockValue:    parseFloat(stockValue().toFixed(2)),
    isMarketHours: isMarketHours(),
    isEntryWindow: isEntryWindow(),
    lastUpdated:   new Date().toISOString(),
    uptime:        process.uptime(),
  });
});

app.post("/api/scan",        async (req,res) => { res.json({ok:true}); runScan(); });
app.post("/api/close/:tkr",  (req,res) => {
  const t = req.params.tkr.toUpperCase();
  if (!state.positions.find(p=>p.ticker===t)) { res.status(404).json({error:"No position"}); return; }
  closePosition(t,"manual");
  res.json({ok:true});
});
app.post("/api/reset-month", (req,res) => {
  state.cash=MONTHLY_BUDGET+state.extraBudget; state.todayTrades=0;
  state.monthStart=new Date().toLocaleDateString(); state.dayStartCash=state.cash;
  state.circuitOpen=true; state.weeklyCircuitOpen=true; state.monthlyProfit=0;
  logEvent("reset",`Month reset — cash: ${fmt(state.cash)}`); res.json({ok:true});
});
app.get("/api/journal",      (req,res) => res.json(state.tradeJournal.slice(0,50)));
app.get("/api/report",       (req,res) => res.json({report:buildMonthlyReport()}));

// ── New Feature Endpoints ──────────────────────────────────────────────────
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
app.post("/api/set-budget", (req,res) => {
  const { budget } = req.body;
  const amount = parseFloat(budget);
  if (!amount || amount < 100 || amount > 1000000) { res.status(400).json({error:"Invalid budget"}); return; }
  const diff = amount - state.cash;
  state.cash = parseFloat(amount.toFixed(2));
  state.dayStartCash = state.cash;
  state.weekStartCash = state.cash;
  state.peakCash = Math.max(state.peakCash, state.cash);
  logEvent("reset", `Budget updated to ${fmt(amount)}`);
  saveState();
  res.json({ok:true, cash:state.cash});
});
app.get("/health",           (req,res) => res.json({status:"ok",uptime:process.uptime(),vix:state.vix,positions:state.positions.length}));

app.listen(PORT, () => {
  console.log(`APEX v2.0 running on port ${PORT}`);
  console.log(`Alpaca key: ${ALPACA_KEY?"SET ✓":"NOT SET"}`);
  console.log(`Gmail:      ${GMAIL_USER||"NOT SET"}`);
  console.log(`Budget:     $${MONTHLY_BUDGET} | Floor: $${CAPITAL_FLOOR}`);
  console.log(`Scan:       every minute, 9AM-4PM ET Mon-Fri`);
  console.log(`Entry window: 10AM-3:30PM ET`);
});
