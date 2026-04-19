// state.js — ARGO V3.2
// State schema, Redis persistence, and logging.
'use strict';
const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { REDIS_URL, REDIS_TOKEN, REDIS_KEY, REDIS_SAVE_INTERVAL, STATE_FILE, MONTHLY_BUDGET } = require('./constants');

let lastRedisSave = 0;
let stateDirty    = false;
function markDirty() { stateDirty = true; }

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
    // V3.2 regime additions (panel approved)
    _postCrisisLock:     false, // true for 10 trading days after Regime C → B transition
    _postCrisisLockExpiry: null,// timestamp when post-crisis lock expires
    _vixSpikeAt:         null,  // timestamp of last VIX spike > 8pt (flash crash gate)
    _regimeSubClass:     null,  // B1 (early/mild bear) or B2 (confirmed bear) within Regime B
    _lastLoggedSubClass: null,  // tracks last logged sub-regime to prevent log flooding
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

async function saveStateNow() {
  try {
    await redisSave(state);
    lastRedisSave = Date.now();
    stateDirty    = false;
  } catch(e) { console.error("saveStateNow error:", e.message); }
}

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

function logEvent(type, message) {
  const entry = { time: new Date().toISOString(), type, message };
  state.tradeLog.unshift(entry);
  if (state.tradeLog.length > 500) state.tradeLog = state.tradeLog.slice(0, 500);
  // V2.83: also append to daily log buffer for EOD archival to Redis
  // Separate from tradeLog so the live 500-entry rolling buffer is not affected
  if (!state._dailyLogBuffer) state._dailyLogBuffer = [];
  state._dailyLogBuffer.push(entry);
  if (state._dailyLogBuffer.length > 5000) // B9: cap to prevent unbounded RAM growth
    state._dailyLogBuffer = state._dailyLogBuffer.slice(-5000);
  console.log(`[${type.toUpperCase()}] ${message}`);
}

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


const state = defaultState();
module.exports = { state, markDirty, saveStateNow, flushStateIfDirty, logEvent,
                   redisSave, redisLoad, defaultState, saveDailyLogToRedis };
