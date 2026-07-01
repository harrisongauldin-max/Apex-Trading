// state.js — ARGO V3.2
// State schema, Redis persistence, and logging.
'use strict';

function getETTime() {
  return new Date(new Date().toLocaleString('en-US', {timeZone:'America/New_York'}));
}
const BACKUP_FILE = require('path').join(__dirname, 'state-backup.json');
const fs   = require('fs');
const path = require('path');
const _nodeFetch = require('node-fetch');
const http  = require('http');
const https = require('https');
// 7/1 fix (Premature-close storm): Node 19+ made the global http/https agent keepAlive:true by default.
// node-fetch v2 reuses those pooled sockets; when Alpaca/Railway's edge closes an idle keep-alive socket,
// the next reuse fails mid-response with "Premature close" — the storm hitting every endpoint AND every host
// (data.alpaca, paper-api, anthropic, marketaux) at once. Forcing a fresh connection per request kills reuse.
const _noKeepAliveHttp  = new http.Agent({ keepAlive: false });
const _noKeepAliveHttps = new https.Agent({ keepAlive: false });
const _agentFor = (parsedURL) => parsedURL.protocol === 'http:' ? _noKeepAliveHttp : _noKeepAliveHttps;
const fetch = (url, opts = {}) => _nodeFetch(url, { agent: _agentFor, ...opts });
const { TELEMETRY_HEADER } = require('./telemetry');
const { REDIS_URL, REDIS_TOKEN, REDIS_KEY, REDIS_SAVE_INTERVAL, STATE_FILE, MONTHLY_BUDGET,
  IS_PAPER_ACCOUNT, APEX_PAPER_EXPERIMENT,
} = require('./constants');

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
    dayTrades:        [],
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
    tickerBlacklist:  [],
    exitStats:        {},
    agentAutoExitEnabled: false,
    // PAPER DATA MODE — runtime UI flag. Seeded from APEX_PAPER_EXPERIMENT so behavior is continuous
    // at cutover; once the user toggles, the persisted value overrides this on load (Object.assign
    // order in server boot). Only ACTIVE on a paper account — see paperDataActive().
    paperDataMode:        APEX_PAPER_EXPERIMENT,
    _lastEntryAt:       null,
    _yesterdayGapPct:   null,
    _gapReversalDay:    false,
    _todayMaxGap:       0,
    _todayGapDirection: null,
    _dailyThesisComplete: {},
    _gldMacdCrossoverAt: null,
    _agentRescoreHour:   {},
    _agentRescoreMinute: {},
    _avoidUntil:         null,
    _agentHealth:        { calls: 0, successes: 0, timeouts: 0, parseErrors: 0, lastSuccess: null },
    _macroReversalAt:    null,
    _macroReversalCount: 0,
    _macroReversalSPY:   null,
    _postCrisisLock:     false,
    _postCrisisLockExpiry: null,
    _vixSpikeAt:         null,
    _regimeSubClass:     null,
    _lastLoggedSubClass: null,
    _dayPlan:            null,
    _dayPlanDate:        null,
    _recentLosses:       {},
    _agentHistory:       {},
    portfolioSnapshots: [],
    _pendingOrder:       null,
    _oversoldCount:      {},
    _oversoldDate:       {},
    _rsiHistory:         {},
    _intradayOversoldScans: {},
    // C1 Sunday 6/8 — daily loss lock (C1-A)
    _dailyLossLockActive:     false,
    _dailyLossLockTriggeredAt: null,
    // C1 Sunday 6/8 — per-instrument loss count (C1-B)
    _instrumentLossCount:     {},
    // C1 Sunday 6/8 — weekly/monthly hard halts (C1-G)
    _weeklyLossLockActive:    false,
    _monthlyLossLockActive:   false,
    _weeklyRealizedPnL:       0,
    _weekStartTimestamp:      null,
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
  } catch(e) {}
}

async function redisSave(data) {
  await writeLocalBackup(data);
  const slim = {
    ...data,
    tradeJournal: (data.tradeJournal || []).slice(0, 100).map(function(t) {
      return {
        time: t.time, ticker: t.ticker, action: t.action, strike: t.strike,
        expDate: t.expDate, premium: t.premium, contracts: t.contracts,
        cost: t.cost, score: t.score, delta: t.delta, iv: t.iv, vix: t.vix,
        optionType: t.optionType, pnl: t.pnl, pct: t.pct, reason: t.reason,
        washSaleFlag: t.washSaleFlag || false,
        scoreReasons: (t.scoreReasons || []).slice(0, 8),
      };
    }),
    tradeLog: (data.tradeLog || []).slice(0, 1000),
    closedTrades: (data.closedTrades || []).slice(0, 200),
  };
  delete slim._marketContextCache;
  delete slim._dailyLogBuffer;   // saved separately via saveDailyLogToRedis — keep it out of the state payload
  delete slim._telemetryBuffer;  // saved separately via saveTelemetryToRedis
  delete slim._telemetryLast;    // transient material-change tracker

  try { fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2)); } catch(e) {}

  if (!REDIS_URL || !REDIS_TOKEN) return;

  try {
    const serialized = JSON.stringify(slim);
    const sizeKB = Math.round(serialized.length / 1024);
    if (sizeKB > 8000) {
      console.error(`[REDIS] WARNING: Payload ${sizeKB}KB approaching 10MB limit`);
    }
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
    if (result[0] && result[0].error) {
      console.error("[REDIS] Save error:", result[0].error);
    } else {
      console.log(`[REDIS] Saved OK (${sizeKB}KB)`);
    }
  } catch(e) { console.error("[REDIS] Save error:", e.message); }
}

async function redisLoad() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    try {
      if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch(e) {}
    return null;
  }
  const MAX_RETRIES  = 3;
  const RETRY_DELAY  = 2000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
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
      const raw = data && data[0] && data[0].result;
      if (raw) {
        if (attempt > 1) console.log(`[REDIS] Loaded on attempt ${attempt}`);
        let parsed = JSON.parse(raw);
        if (typeof parsed === 'string') {
          console.log("[REDIS] Detected double-encoded string - parsing again");
          parsed = JSON.parse(parsed);
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string' && !parsed.cash) {
          console.log("[REDIS] Detected old wrapped format - unwrapping");
          parsed = JSON.parse(parsed.value);
        }
        return parsed;
      }
      return null;
    } catch(e) {
      console.error(`[REDIS] Load attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`[REDIS] Retrying in ${RETRY_DELAY/1000}s...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  console.error("[REDIS] CRITICAL: All load attempts failed - starting with saved file or defaults");
  console.error("[REDIS] If live trading, check Upstash connection immediately");
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

const _logDedup = {};
const LOG_DEDUP_MS = 5 * 60 * 1000;  // collapse byte-identical non-event lines within 5 min
function logEvent(type, message) {
  const now = Date.now();
  // Collapse identical, rapidly-repeating boilerplate. Never touches trade/error/warn,
  // and the per-scan heartbeat survives because it carries live VIX/breadth (never identical).
  if (type !== 'trade' && type !== 'error' && type !== 'warn') {
    const last = _logDedup[message];
    if (last && (now - last) < LOG_DEDUP_MS) { _logDedup[message] = now; return; }
    _logDedup[message] = now;
    if (Object.keys(_logDedup).length > 3000) {
      for (const k in _logDedup) if (now - _logDedup[k] > LOG_DEDUP_MS) delete _logDedup[k];
    }
  }
  const entry = { time: new Date().toISOString(), type, message };
  state.tradeLog.unshift(entry);
  if (state.tradeLog.length > 1000) state.tradeLog = state.tradeLog.slice(0, 1000);
  if (!state._dailyLogBuffer) state._dailyLogBuffer = [];
  state._dailyLogBuffer.push(entry);
  if (state._dailyLogBuffer.length > 30000)
    state._dailyLogBuffer = state._dailyLogBuffer.slice(-30000);
  console.log(`[${type.toUpperCase()}] ${message}`);
}

function getETDateStr() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' });
  const [m, d, y] = etStr.split('/');
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

// Tolerant parse for day-log / telemetry / analytics blobs stored in Redis.
// Correct format stores the payload object's JSON directly. A prior bug wrote the
// /set body as {"value":"<json>","ex":N}, which Upstash stored literally — so reads
// found no .entries/.rows. Detect that exact wrapper shape and unwrap the real payload
// so keys written during the buggy window remain readable.
function parseRedisBlob(rawResult) {
  if (!rawResult) return null;
  let p;
  try { p = JSON.parse(rawResult); } catch (_) { return null; }
  if (p && typeof p.value === 'string' && p.ex !== undefined && Object.keys(p).length <= 2) {
    try { const inner = JSON.parse(p.value); if (inner && typeof inner === 'object') return inner; } catch (_) {}
  }
  return p;
}

async function saveDailyLogToRedis(isEOD = false) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    const dateStr  = getETDateStr();
    const logKey   = `argo:logs:${dateStr}`;
    const buffer   = state._dailyLogBuffer || [];

    // Merge-on-save: never overwrite a populated Redis day-log with a thinner buffer.
    // The in-memory buffer is wiped on every restart/redeploy and cleared at EOD, so a
    // blind SET (esp. from save-now after the buffer empties) would clobber the real day.
    // Read the existing key, union with the buffer, dedup by time|type|message, write the superset.
    let existing = [];
    try {
      const gr = await fetch(`${REDIS_URL}/get/${logKey}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const gd = await gr.json();
      if (gd && gd.result) { const p = parseRedisBlob(gd.result); if (p && Array.isArray(p.entries)) existing = p.entries; }
    } catch(_) { /* if the read fails, fall through and write the buffer rather than lose this save */ }

    const seen = new Set();
    let merged = [];
    for (const e of existing.concat(buffer)) {
      const k = `${e.time}|${e.type}|${e.message}`;
      if (seen.has(k)) continue;
      seen.add(k); merged.push(e);
    }
    merged.sort((a, b) => new Date(a.time) - new Date(b.time));
    if (merged.length > 30000) merged = merged.slice(-30000);

    const logData  = JSON.stringify({
      date:     dateStr,
      entries:  merged,
      summary: {
        totalEntries: merged.length,
        trades:       merged.filter(e => e.type === "trade").length,
        errors:       merged.filter(e => e.type === "error").length,
        warns:        merged.filter(e => e.type === "warn").length,
        closedToday:  (state.closedTrades || []).filter(t => t.closeTime && new Date(t.closeTime).toISOString().slice(0,10) === dateStr).length,
        cashEOD:      state.cash,
        positionsEOD: state.positions.length,
      }
    });
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify([["set", logKey, logData, "EX", 7776000]]),
    });
    if (res.ok) {
      logEvent("scan", `[EOD LOG] Daily log saved to Redis: ${logKey} | ${merged.length} entries (buffer ${buffer.length} + existing ${existing.length})`);
      if (isEOD) {
        state._dailyLogBuffer = [];
        markDirty();
      }
    } else {
      console.error("[EOD LOG] Redis save failed:", res.status);
    }
  } catch(e) {
    console.error("[EOD LOG] Daily log save error:", e.message);
  }

  try {
    const dateStr   = getETDateStr();
    const analyticsKey = `argo:analytics:${dateStr}`;
    const trades    = state.closedTrades || [];
    const todayTrades = trades.filter(t => {
      const d = t.closeTime || t.date;
      return d && new Date(d).toISOString().slice(0,10) === dateStr;
    });
    const wins      = trades.filter(t => (t.pnl||0) > 0);
    const losses    = trades.filter(t => (t.pnl||0) <= 0);
    const grossW    = wins.reduce((s,t) => s+(t.pnl||0), 0);
    const grossL    = Math.abs(losses.reduce((s,t) => s+(t.pnl||0), 0));
    const todayWins = todayTrades.filter(t => (t.pnl||0) > 0);

    const brackets  = {};
    trades.forEach(t => {
      const s = t.score || 0;
      const b = s >= 95 ? '95-100' : s >= 90 ? '90-94' : s >= 85 ? '85-89' :
                s >= 80 ? '80-84' : s >= 75 ? '75-79' : s >= 70 ? '70-74' : '<70';
      if (!brackets[b]) brackets[b] = { trades: 0, wins: 0, pnl: 0 };
      brackets[b].trades++;
      if ((t.pnl||0) > 0) brackets[b].wins++;
      brackets[b].pnl += (t.pnl||0);
    });

    const byExit = {};
    trades.forEach(t => {
      const r = t.reason || 'unknown';
      if (!byExit[r]) byExit[r] = { count: 0, wins: 0, pnl: 0 };
      byExit[r].count++;
      if ((t.pnl||0) > 0) byExit[r].wins++;
      byExit[r].pnl += (t.pnl||0);
    });

    const analyticsData = JSON.stringify({
      date:       dateStr,
      savedAt:    new Date().toISOString(),
      isEOD,
      account: {
        cash:           state.cash,
        budget:         state.customBudget || 30000,
        openPositions:  (state.positions || []).length,
        realizedPnL:    state._alpacaTruth ? state._alpacaTruth.realizedPnL  : (state.realizedPnL || 0),
        unrealizedPnL:  state._alpacaTruth ? state._alpacaTruth.unrealizedPnL : 0,
        totalPnL:       state._alpacaTruth ? state._alpacaTruth.totalPnL      : 0,
        currentEquity:  state._alpacaTruth ? state._alpacaTruth.currentEquity : state.cash,
        dayOpenEquity:  state._alpacaTruth ? state._alpacaTruth.dayOpenEquity : state.cash,
        alpacaTruthAt:  state._alpacaTruth ? new Date().toISOString() : null,
        monthlyPnL:     state.monthlyProfit || 0,
        peakCash:       state.peakCash || state.cash,
        drawdownPct:    state.peakCash > 0 ? parseFloat(((state.cash - state.peakCash) / state.peakCash * 100).toFixed(2)) : 0,
      },
      performance: {
        totalTrades:  trades.length,
        wins:         wins.length,
        losses:       losses.length,
        winRate:      trades.length > 0 ? parseFloat((wins.length / trades.length * 100).toFixed(1)) : 0,
        avgWin:       wins.length > 0 ? parseFloat((grossW / wins.length).toFixed(2)) : 0,
        avgLoss:      losses.length > 0 ? parseFloat((-grossL / losses.length).toFixed(2)) : 0,
        profitFactor: grossL > 0 ? parseFloat((grossW / grossL).toFixed(2)) : null,
        totalPnL:     parseFloat((grossW - grossL).toFixed(2)),
        expectancy:   trades.length > 0 ? parseFloat(((grossW - grossL) / trades.length).toFixed(2)) : 0,
      },
      today: {
        trades:   todayTrades.length,
        wins:     todayWins.length,
        winRate:  todayTrades.length > 0 ? parseFloat((todayWins.length / todayTrades.length * 100).toFixed(1)) : 0,
        pnl:      state._alpacaTruth ? state._alpacaTruth.totalPnL
                : parseFloat(todayTrades.reduce((s,t) => s+(t.pnl||0), 0).toFixed(2)),
      },
      scoreBrackets: brackets,
      exitBreakdown: byExit,
      vix:       state.vix || null,
      regime:    state._regimeClass || 'A',
      agentSignal: (state._agentMacro || {}).signal || 'unknown',
      journal:   (state.tradeJournal || []).slice(0, 50).map(t => ({
        time: t.time, ticker: t.ticker, action: t.action,
        optionType: t.optionType, score: t.score,
        pnl: t.pnl, pct: t.pct, reason: t.reason,
        strike: t.strike, expDate: t.expDate,
        tradeType: t.tradeType,
      })),
    });

    const aRes = await fetch(`${REDIS_URL}/pipeline`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify([["set", analyticsKey, analyticsData, "EX", 15552000]]),
    });
    if (aRes.ok) {
      const _logPnL = state._alpacaTruth ? state._alpacaTruth.totalPnL : (grossW - grossL);
      logEvent("scan", `[ANALYTICS] Snapshot saved: ${analyticsKey} | ${trades.length} trades | WR:${trades.length > 0 ? (wins.length/trades.length*100).toFixed(0) : 0}% | PnL:$${_logPnL.toFixed(0)} (${state._alpacaTruth ? 'Alpaca truth' : 'journal estimate'})`);
    } else {
      console.error("[ANALYTICS] Save failed:", aRes.status);
    }
  } catch(e) {
    console.error("[ANALYTICS] Snapshot error:", e.message);
  }

  await saveTelemetryToRedis(isEOD);
}

// Compact score-telemetry persistence — mirrors saveDailyLogToRedis. Rides its cadence
// (hourly checkpoint + EOD), so no new timers. Buffer flushed only at EOD.
async function saveTelemetryToRedis(isEOD = false) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  const rows = state._telemetryBuffer || [];
  if (rows.length === 0) return;
  try {
    const dateStr = getETDateStr();
    const key     = `argo:telemetry:${dateStr}`;
    // Merge-on-save: union existing Redis rows with the buffer, dedup exact rows.
    // A restart wipes the buffer; without merging, the next checkpoint would overwrite
    // the key with only post-restart rows and lose the morning. existing+buffer preserves
    // chronological order (existing = earlier saves, buffer = since).
    let existing = [];
    try {
      const gr = await fetch(`${REDIS_URL}/get/${key}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const gd = await gr.json();
      if (gd && gd.result) { const p = parseRedisBlob(gd.result); if (p && Array.isArray(p.rows)) existing = p.rows; }
    } catch(_) { /* read failure: fall through and write the buffer rather than lose this save */ }
    const seen = new Set();
    let merged = [];
    for (const r of existing.concat(rows)) { if (seen.has(r)) continue; seen.add(r); merged.push(r); }
    if (merged.length > 6000) merged = merged.slice(-6000);
    const payload = JSON.stringify({ date: dateStr, header: TELEMETRY_HEADER, rows: merged });
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify([["set", key, payload, "EX", 7776000]]),
    });
    if (res.ok) {
      logEvent("scan", `[TELEMETRY] Saved ${merged.length} rows → ${key} (buffer ${rows.length} + existing ${existing.length})`);
      if (isEOD) { state._telemetryBuffer = []; state._telemetryLast = {}; markDirty(); }
    } else {
      console.error("[TELEMETRY] Redis save failed:", res.status);
    }
  } catch(e) {
    console.error("[TELEMETRY] save error:", e.message);
  }
}


const state = defaultState();

async function loadJournalDay(dateStr) {
  if (!REDIS_URL || !REDIS_TOKEN) return [];
  try {
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['get', `argo:journal:${dateStr}`]]),
    });
    const data = await res.json();
    const raw = data[0]?.result;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed.value === 'string') {
        const inner = JSON.parse(parsed.value);
        return Array.isArray(inner) ? inner : [];
      }
      return [];
    } catch(e) { return []; }
  } catch(e) { return []; }
}

async function saveJournalDay(dateStr, entries) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    const serialized = JSON.stringify(entries);
    const TTL = 90 * 24 * 3600;
    const res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['set', `argo:journal:${dateStr}`, serialized, 'EX', TTL]]),
    });
    const data = await res.json();
    if (data[0]?.error) console.error('[JOURNAL] Save error:', data[0].error);
  } catch(e) { console.error('[JOURNAL] Save failed:', e.message); }
}

async function writeJournalEntry(entry) {
  const dateStr = entry.openDate
    ? entry.openDate.split('T')[0]
    : new Date().toISOString().split('T')[0];
  const entries = await loadJournalDay(dateStr);
  const idx = entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...entry };
  } else {
    entries.unshift(entry);
  }
  await saveJournalDay(dateStr, entries);
}

async function updateJournalExit(contractSymbol, exitFields, descriptor) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const d = descriptor || {};
  const hasDesc = d.ticker || d.strike != null;
  const matchesDesc = (e) =>
    e.status === 'OPEN' &&
    (!d.ticker     || e.ticker === d.ticker) &&
    (!d.optionType || e.optionType === d.optionType) &&
    (d.strike == null || Number(e.strike) === Number(d.strike)) &&
    (!d.expDate    || e.expDate === d.expDate);
  for (const dateStr of [today, yesterday]) {
    const entries = await loadJournalDay(dateStr);
    // 1) exact contract-symbol match (the normal path)
    let idx = contractSymbol
      ? entries.findIndex(e => e.contractSymbol === contractSymbol && e.status === 'OPEN')
      : -1;
    // 2) structural fallback when the symbol is missing/null/mismatched (prevents orphaned OPEN + duplicate)
    if (idx < 0 && hasDesc) idx = entries.findIndex(matchesDesc);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], ...exitFields, status: 'CLOSED' };
      await saveJournalDay(dateStr, entries);
      return true;
    }
  }
  return false;
}

// Backstop: close any journal entry still marked OPEN whose contract is not in the live
// Alpaca position set. Enforces the invariant "no live position ⇒ no OPEN journal row".
// liveSymbolSet must come from a SUCCESSFUL Alpaca positions fetch (empty = genuinely flat).
async function closeOrphanJournalOpens(liveSymbolSet) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  let closed = 0;
  for (const dateStr of [today, yesterday]) {
    const entries = await loadJournalDay(dateStr);
    let changed = false;
    for (const e of entries) {
      // Only sweep entries that carry a real contractSymbol and are absent from Alpaca.
      // (Entries without a stored symbol are left alone — the structural fallback above
      //  is what keeps them from orphaning in the first place.)
      if (e.status === 'OPEN' && e.contractSymbol && !liveSymbolSet.has(e.contractSymbol)) {
        e.status      = 'CLOSED';
        e.exitReason  = e.exitReason || 'reconcile-orphan-closed';
        e.closeDate   = new Date().toISOString();
        e.closeDateET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        e._orphanClosed = true;
        if (e.pnl_alpaca == null && e.pnl_apex == null && e.pnl == null) e.pnl = 0;
        closed++; changed = true;
      }
    }
    if (changed) await saveJournalDay(dateStr, entries);
  }
  return closed;
}

async function getJournalRange(fromDate, toDate) {
  const results = [];
  const start = new Date(fromDate), end = new Date(toDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const entries = await loadJournalDay(dateStr);
    results.push(...entries);
  }
  return results.sort((a, b) => new Date(b.openDate) - new Date(a.openDate));
}

// PAPER DATA MODE gate — the single runtime check for the data-gathering posture.
// HARD INTERLOCK: returns true ONLY on a paper account (IS_PAPER_ACCOUNT), regardless of the
// toggle. So even if state.paperDataMode were somehow true on a live account, every read site
// (loss-lock lifts, entry-floor loosening) still no-ops. Defense in depth with the endpoint's 403.
function paperDataActive(st = state) {
  return IS_PAPER_ACCOUNT === true && !!(st && st.paperDataMode === true);
}

// Boot-restore: repopulate today's in-memory buffers from Redis so a redeploy/restart
// doesn't leave "Download full day" / telemetry empty (and so merge-on-save has the
// morning to merge against). Only fills a buffer that's currently empty.
async function restoreBuffersFromRedis() {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  const dateStr = getETDateStr();
  try {
    if (!state._dailyLogBuffer || state._dailyLogBuffer.length === 0) {
      const gr = await fetch(`${REDIS_URL}/get/argo:logs:${dateStr}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const gd = await gr.json();
      if (gd && gd.result) {
        const p = parseRedisBlob(gd.result);
        if (p && Array.isArray(p.entries) && p.entries.length) {
          state._dailyLogBuffer = p.entries.slice(-30000);
          console.log(`[BOOT] Restored ${state._dailyLogBuffer.length} daily-log entries from Redis (${dateStr})`);
        }
      }
    }
  } catch(e) { console.error("[BOOT] daily-log restore failed:", e.message); }
  try {
    if (!state._telemetryBuffer || state._telemetryBuffer.length === 0) {
      const gr = await fetch(`${REDIS_URL}/get/argo:telemetry:${dateStr}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
      const gd = await gr.json();
      if (gd && gd.result) {
        const p = parseRedisBlob(gd.result);
        if (p && Array.isArray(p.rows) && p.rows.length) {
          state._telemetryBuffer = p.rows.slice(-6000);
          console.log(`[BOOT] Restored ${state._telemetryBuffer.length} telemetry rows from Redis (${dateStr})`);
        }
      }
    }
  } catch(e) { console.error("[BOOT] telemetry restore failed:", e.message); }
}

// 6/30 (Harrison): runtime resolver for the data-gather A/B switch. Returns the live state override
// if it has been set via /api/data-gather, otherwise the DATA_GATHER_MODE constant default. Persists
// in state (Redis-backed) so a toggle survives restarts/redeploys. Every read-site calls this instead
// of the raw constant so the switch is flippable without a code change.
function dataGatherActive(defaultVal) {
  return (state._dataGatherMode === true || state._dataGatherMode === false)
    ? state._dataGatherMode
    : !!defaultVal;
}

module.exports = { state, markDirty, saveStateNow, flushStateIfDirty, logEvent, dataGatherActive,
                   redisSave, redisLoad, defaultState, saveDailyLogToRedis, saveTelemetryToRedis, getETDateStr,
                   restoreBuffersFromRedis, parseRedisBlob,
                   writeJournalEntry, updateJournalExit, loadJournalDay, saveJournalDay, getJournalRange,
                   closeOrphanJournalOpens, paperDataActive };
