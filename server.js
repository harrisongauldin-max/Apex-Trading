const express  = require("express");
const cron     = require("node-cron");
const fetch    = require("node-fetch");
const fs       = require("fs");
const path     = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config (set these as environment variables in Railway/Render) ──────────
const FINNHUB_KEY       = process.env.FINNHUB_KEY       || "";
const PROXY             = process.env.PROXY_URL          || "https://rough-wildflower-ea6b.harrisongauldin.workers.dev";
const MONTHLY_BUDGET    = 1000;
const REVENUE_THRESHOLD = 2000;
const BONUS_AMOUNT      = 1000;
const MAX_HEAT          = 0.60;
const MAX_POSITION_PCT  = 0.25;
const STOP_LOSS_PCT     = 0.35;
const TAKE_PROFIT_PCT   = 0.65;
const PARTIAL_CLOSE_PCT = 0.50;
const CIRCUIT_BREAKER   = 0.08;
const TIME_STOP_DAYS    = 7;
const TIME_STOP_MOVE    = 0.05;
const IV_COLLAPSE_PCT   = 0.30;
const MA50_BUFFER       = 0.01;
const MAX_SECTOR_PCT    = 0.50;
const IVR_MAX           = 70;
const EARNINGS_SKIP_DAYS= 5;
const STATE_FILE        = path.join(__dirname, "state.json");

// ── Watchlist ──────────────────────────────────────────────────────────────
const WATCHLIST = [
  { ticker:"NVDA", sector:"Technology", momentum:"strong",     rsi:58, macd:"bullish crossover", trend:"above 50MA",         catalyst:"GTC Conference",   expiryDays:14, ivr:52, earningsDate:null },
  { ticker:"TSLA", sector:"Consumer",   momentum:"recovering", rsi:44, macd:"neutral",           trend:"testing 200MA",      catalyst:"Q1 delivery data", expiryDays:56, ivr:61, earningsDate:null },
  { ticker:"AAPL", sector:"Technology", momentum:"steady",     rsi:52, macd:"mild bullish",      trend:"above all MAs",      catalyst:"Services update",  expiryDays:42, ivr:28, earningsDate:null },
  { ticker:"AMZN", sector:"Technology", momentum:"strong",     rsi:61, macd:"bullish",           trend:"above 50MA",         catalyst:"AWS growth",       expiryDays:28, ivr:35, earningsDate:null },
  { ticker:"META", sector:"Technology", momentum:"strong",     rsi:63, macd:"bullish",           trend:"trending up",        catalyst:"AI ad revenue",    expiryDays:28, ivr:40, earningsDate:null },
  { ticker:"SPY",  sector:"Index",      momentum:"steady",     rsi:53, macd:"neutral",           trend:"near all-time high", catalyst:"Fed meeting",      expiryDays:14, ivr:22, earningsDate:null },
  { ticker:"AMD",  sector:"Technology", momentum:"recovering", rsi:47, macd:"forming base",      trend:"near 50MA",          catalyst:"MI300X demand",    expiryDays:56, ivr:55, earningsDate:null },
  { ticker:"MSFT", sector:"Technology", momentum:"strong",     rsi:56, macd:"bullish",           trend:"above all MAs",      catalyst:"Copilot adoption", expiryDays:35, ivr:30, earningsDate:null },
];

// ── State persistence ──────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch(e) { console.error("State load error:", e.message); }
  return {
    cash:          MONTHLY_BUDGET,
    extraBudget:   0,
    totalRevenue:  0,
    positions:     [],
    closedTrades:  [],
    tradeLog:      [],
    todayTrades:   0,
    monthStart:    new Date().toLocaleDateString(),
    dayStartCash:  MONTHLY_BUDGET,
    circuitOpen:   true,
    lastScan:      null,
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
  if (state.tradeLog.length > 200) state.tradeLog = state.tradeLog.slice(0, 200);
  console.log(`[${type.toUpperCase()}] ${message}`);
  saveState();
}

// ── Price fetching ─────────────────────────────────────────────────────────
async function fetchPrice(ticker) {
  const key = FINNHUB_KEY;
  if (!key) { logEvent("warn", `No FINNHUB_KEY set — cannot fetch ${ticker}`); return null; }
  try {
    const url  = `${PROXY}?symbol=${ticker}&token=${key}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.c && data.c > 0) return parseFloat(data.c.toFixed(2));
    logEvent("warn", `No price data for ${ticker}: ${JSON.stringify(data)}`);
    return null;
  } catch(e) {
    logEvent("error", `fetchPrice(${ticker}) failed: ${e.message}`);
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
const fmt         = n => "$" + n.toFixed(2);
const totalCap    = () => MONTHLY_BUDGET + state.extraBudget;
const openRisk    = () => state.positions.reduce((s,p) => s + p.cost * (p.partialClosed ? 0.5 : 1), 0);
const heatPct     = () => openRisk() / totalCap();
const realizedPnL = () => state.closedTrades.reduce((s,t) => s + t.pnl, 0);

function buildCard(stock, price) {
  const expDays   = stock.expiryDays || 30;
  const otmPct    = stock.momentum === "strong" ? 0.035 : 0.045;
  const strike    = Math.round(price * (1 + otmPct) / 5) * 5;
  const t         = expDays / 365;
  const iv        = 0.25 + stock.ivr * 0.003;
  const premium   = parseFloat((price * iv * Math.sqrt(t) * 0.4 + 0.3).toFixed(2));
  const maxCost   = state.cash * MAX_POSITION_PCT;
  const contracts = Math.max(1, Math.min(4, Math.floor(maxCost / (premium * 100))));
  const cost      = parseFloat((premium * 100 * contracts).toFixed(2));
  const expDate   = new Date(Date.now() + expDays * 86400000)
                      .toLocaleDateString("en-US", { month:"short", day:"2-digit", year:"numeric" });
  const target    = parseFloat((premium * (1 + TAKE_PROFIT_PCT)).toFixed(2));
  const stop      = parseFloat((premium * (1 - STOP_LOSS_PCT)).toFixed(2));
  return { ...stock, price, strike, premium, contracts, cost, expDate, expDays, target, stop };
}

function checkFilters(stock) {
  if (stock.ivr > IVR_MAX)
    return { pass:false, reason:`IVR ${stock.ivr} > ${IVR_MAX} — options overpriced` };
  if (stock.earningsDate) {
    const dte = Math.round((new Date(stock.earningsDate) - new Date()) / 86400000);
    if (dte >= 0 && dte <= EARNINGS_SKIP_DAYS)
      return { pass:false, reason:`Earnings in ${dte} day(s) — IV crush risk` };
  }
  if (heatPct() >= MAX_HEAT)
    return { pass:false, reason:`Portfolio heat ${(heatPct()*100).toFixed(0)}% at max ${MAX_HEAT*100}%` };
  const sectorExp = state.positions.filter(p=>p.sector===stock.sector).reduce((s,p)=>s+p.cost,0);
  if (sectorExp / totalCap() >= MAX_SECTOR_PCT)
    return { pass:false, reason:`${stock.sector} sector at ${MAX_SECTOR_PCT*100}% limit` };
  if (state.positions.find(p=>p.ticker===stock.ticker))
    return { pass:false, reason:`Already have open ${stock.ticker} position` };
  if (!state.circuitOpen)
    return { pass:false, reason:"Circuit breaker tripped — daily loss limit hit" };
  return { pass:true, reason:null };
}

// ── Trade execution ────────────────────────────────────────────────────────
function executeTrade(stock, price) {
  const t = buildCard(stock, price);
  if (t.cost > state.cash || t.contracts < 1) {
    logEvent("skip", `${stock.ticker} — insufficient cash (need ${fmt(t.cost)}, have ${fmt(state.cash)})`);
    return false;
  }
  state.cash = parseFloat((state.cash - t.cost).toFixed(2));
  state.todayTrades++;
  state.positions.push({
    ticker:t.ticker, sector:t.sector, strike:t.strike, premium:t.premium,
    contracts:t.contracts, cost:t.cost, expDate:t.expDate, expiryDays:t.expDays,
    target:t.target, stop:t.stop, partialClosed:false,
    openDate:new Date().toLocaleDateString(), ivr:t.ivr,
  });
  logEvent("trade", `BUY ${t.ticker} $${t.strike}C exp ${t.expDate} | ${t.contracts}x @ $${t.premium} | cost ${fmt(t.cost)} | cash ${fmt(state.cash)} | heat ${(heatPct()*100).toFixed(0)}%`);
  saveState();
  return true;
}

function closePosition(ticker, reason, pricePct = null) {
  const idx = state.positions.findIndex(p => p.ticker === ticker);
  if (idx === -1) return;
  const pos  = state.positions[idx];
  const mult = pos.partialClosed ? 0.5 : 1.0;
  const g    = pricePct !== null ? pricePct
             : reason === "stop"   ? -(0.50 + Math.random() * 0.08)
             : reason === "target" ? (0.72  + Math.random() * 0.08)
             : (Math.random() * 0.5 - 0.05);
  const ep   = parseFloat((pos.premium * (1 + g)).toFixed(2));
  const ev   = parseFloat((ep * 100 * pos.contracts * mult).toFixed(2));
  const pnl  = parseFloat((ev - pos.cost * mult).toFixed(2));
  const pct  = ((pnl / (pos.cost * mult)) * 100).toFixed(1);
  const nr   = state.totalRevenue + (pnl > 0 ? pnl : 0);
  const bonus= state.totalRevenue < REVENUE_THRESHOLD && nr >= REVENUE_THRESHOLD;
  state.cash          = parseFloat((state.cash + ev + (bonus ? BONUS_AMOUNT : 0)).toFixed(2));
  state.extraBudget  += bonus ? BONUS_AMOUNT : 0;
  state.totalRevenue  = nr;
  state.positions.splice(idx, 1);
  state.closedTrades.push({ ticker, pnl, pct, date:new Date().toLocaleDateString(), reason });
  const dailyPnL = state.cash - state.dayStartCash;
  if (dailyPnL / totalCap() <= -CIRCUIT_BREAKER && state.circuitOpen) {
    state.circuitOpen = false;
    logEvent("circuit", `CIRCUIT BREAKER TRIPPED — daily loss ${fmt(Math.abs(dailyPnL))} exceeds ${CIRCUIT_BREAKER*100}% limit`);
  }
  if (bonus) logEvent("bonus", `REVENUE HIT $${REVENUE_THRESHOLD} — +$${BONUS_AMOUNT} budget bonus added!`);
  logEvent("close", `${reason.toUpperCase()} ${ticker} | exit $${ep} | P&L ${pnl>=0?"+":""}${fmt(pnl)} (${pct}%) | cash ${fmt(state.cash)}`);
  saveState();
}

function partialClose(ticker) {
  const pos = state.positions.find(p => p.ticker === ticker);
  if (!pos || pos.partialClosed) return;
  pos.partialClosed = true;
  const ep   = pos.partialTarget || pos.premium * 1.5;
  const gain = ep - pos.premium;
  const half = Math.floor(pos.contracts / 2);
  const ev   = parseFloat((ep * 100 * half).toFixed(2));
  const pnl  = parseFloat((gain * 100 * half).toFixed(2));
  state.cash = parseFloat((state.cash + ev).toFixed(2));
  state.closedTrades.push({ ticker, pnl, pct:((pnl/(pos.cost*0.5))*100).toFixed(1), date:new Date().toLocaleDateString(), reason:"partial" });
  logEvent("partial", `PARTIAL CLOSE ${ticker} — ${half}/${pos.contracts} contracts at +50% | P&L +${fmt(pnl)} | cash ${fmt(state.cash)}`);
  saveState();
}

// ── Daily scan engine ──────────────────────────────────────────────────────
async function runDailyScan() {
  logEvent("scan", "═══ DAILY AUTO-SCAN STARTED ═══");
  state.lastScan = new Date().toISOString();
  state.todayTrades = 0;
  state.dayStartCash = state.cash;
  state.circuitOpen  = true; // reset circuit breaker daily
  saveState();

  // 1. Manage existing positions
  for (const pos of [...state.positions]) {
    const price = await fetchPrice(pos.ticker);
    if (!price) { logEvent("warn", `Could not fetch ${pos.ticker} — skipping management`); continue; }
    const dte   = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / 86400000));
    const t     = dte / 365;
    const iv    = 0.25 + (pos.ivr || 35) * 0.003;
    const curP  = parseFloat((price * iv * Math.sqrt(t) * 0.4 + 0.1).toFixed(2));
    const chg   = (curP - pos.premium) / pos.premium;

    if (!pos.partialClosed && chg >= PARTIAL_CLOSE_PCT) {
      logEvent("scan", `${pos.ticker} up ${(chg*100).toFixed(0)}% — partial close at +50%`);
      partialClose(pos.ticker);
    } else if (chg >= TAKE_PROFIT_PCT) {
      logEvent("scan", `${pos.ticker} hit +75% target`);
      closePosition(pos.ticker, "target");
    } else if (chg <= -STOP_LOSS_PCT) {
      logEvent("scan", `${pos.ticker} hit -55% stop`);
      closePosition(pos.ticker, "stop");
    } else if (dte <= 7 && chg > 0) {
      logEvent("scan", `${pos.ticker} near expiry (${dte}d) and profitable — closing to avoid gamma risk`);
      closePosition(pos.ticker, "expiry-roll");
    } else {
      logEvent("scan", `${pos.ticker} | change: ${(chg*100).toFixed(1)}% | DTE: ${dte} | HOLD`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 2. Find new entries
  if (!state.circuitOpen) {
    logEvent("circuit", "Circuit breaker active — no new entries today");
    return;
  }

  const candidates = [...WATCHLIST]
    .filter(s => !state.positions.find(p => p.ticker === s.ticker))
    .sort((a,b) => {
      const score = s => (s.momentum==="strong"?3:s.momentum==="recovering"?1:2)
                       + (s.rsi>50&&s.rsi<65?2:0)
                       + (s.macd.includes("bullish")?2:0)
                       + (s.ivr<40?1:0);
      return score(b) - score(a);
    });

  let entered = 0;
  for (const stock of candidates) {
    if (state.cash < 100 || heatPct() >= MAX_HEAT) break;
    const { pass, reason } = checkFilters(stock);
    if (!pass) { logEvent("filter", `SKIP ${stock.ticker} — ${reason}`); continue; }
    const price = await fetchPrice(stock.ticker);
    if (!price) continue;
    const ok = executeTrade(stock, price);
    if (ok) { entered++; await new Promise(r => setTimeout(r, 600)); }
  }

  logEvent("scan", `═══ SCAN COMPLETE — ${entered} new trade(s) | open: ${state.positions.length} | cash: ${fmt(state.cash)} | heat: ${(heatPct()*100).toFixed(0)}% ═══`);
}

// ── Cron: run every day at 9:35 AM ET (market open + 5 min) ───────────────
cron.schedule("35 9-15 * * 1-5", () => {
  console.log("Cron triggered: running daily scan");
  runDailyScan();
}, { timezone: "America/New_York" });

// ── Express API ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// State endpoint
app.get("/api/state", (req, res) => {
  res.json({
    ...state,
    heatPct:     parseFloat((heatPct() * 100).toFixed(1)),
    realizedPnL: parseFloat(realizedPnL().toFixed(2)),
    totalCap:    totalCap(),
    lastUpdated: new Date().toISOString(),
  });
});

// Manual scan trigger
app.post("/api/scan", async (req, res) => {
  res.json({ ok:true, message:"Scan started" });
  runDailyScan();
});

// Manual close
app.post("/api/close/:ticker", (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const pos    = state.positions.find(p => p.ticker === ticker);
  if (!pos) { res.status(404).json({ error:`No open position in ${ticker}` }); return; }
  closePosition(ticker, "manual");
  res.json({ ok:true, message:`Closed ${ticker}` });
});

// Reset month
app.post("/api/reset-month", (req, res) => {
  state.cash        = MONTHLY_BUDGET + state.extraBudget;
  state.todayTrades = 0;
  state.monthStart  = new Date().toLocaleDateString();
  state.dayStartCash= state.cash;
  state.circuitOpen = true;
  logEvent("reset", `Monthly reset — cash: ${fmt(state.cash)}`);
  res.json({ ok:true });
});

// Update Finnhub key at runtime
app.post("/api/key", (req, res) => {
  const { key } = req.body;
  if (!key) { res.status(400).json({ error:"No key provided" }); return; }
  process.env.FINNHUB_KEY = key;
  logEvent("config", "Finnhub API key updated");
  res.json({ ok:true });
});

// Health check
app.get("/health", (req, res) => res.json({ status:"ok", uptime: process.uptime() }));

app.listen(PORT, () => {
  console.log(`APEX server running on port ${PORT}`);
  console.log(`Finnhub key: ${FINNHUB_KEY ? "SET ✓" : "NOT SET — set FINNHUB_KEY env var"}`);
  console.log(`State file: ${STATE_FILE}`);
  console.log(`Daily scan scheduled: 9:35 AM ET, Mon-Fri`);
});
