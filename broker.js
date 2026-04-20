// broker.js — ARGO V3.2
// All Alpaca API communication: HTTP, circuit breaker, retry.
'use strict';

// Local cache (mirrors market.js getCached/setCache — avoids circular dependency)
const _localCache = new Map();
function getCached(key, ttl=60000) { const e=_localCache.get(key); return (e&&Date.now()-e.ts<ttl)?e.data:null; }
function setCache(key, data) { _localCache.set(key,{data,ts:Date.now()}); return data; }

function getETTime() {
  return new Date(new Date().toLocaleString('en-US', {timeZone:'America/New_York'}));
}
function isMarketHours() {
  const et = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours() + et.getMinutes()/60;
  return h >= 9.5 && h < 16;
}

const fetch = require('node-fetch');
const {
  ALPACA_KEY, ALPACA_SECRET, ALPACA_BASE, ALPACA_DATA,
  ALPACA_OPTIONS, ALPACA_OPT_SNAP, ALPACA_NEWS,
} = require('./constants');

// ─── Auth header builder ─────────────────────────────────────────
const alpacaHeaders = () => ({
  'APCA-API-KEY-ID':     ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type':        'application/json',
});

// ─── API call tracking ───────────────────────────────────────────
let apiWindowStart     = Date.now();
let apiCallsThisMinute = 0;

// ─── Circuit breaker ─────────────────────────────────────────────
let _alpacaConsecFails       = 0;
let _alpacaCircuitOpen       = false;
const ALPACA_CIRCUIT_THRESHOLD = 5;

function getCircuitState() {
  return { open: _alpacaCircuitOpen, consecFails: _alpacaConsecFails };
}

// ─── Logger/alert injection (avoids circular dep) ────────────────
let _log       = (type, msg) => console.log(`[broker][${type}] ${msg}`);
let _alertFn   = null;
function setBrokerLogger(logFn, alertFn) { _log = logFn; if (alertFn) _alertFn = alertFn; }

function trackAPICall() {
  const now = Date.now();
  if (now - apiWindowStart > 60000) {
    apiCallsThisMinute = 0;
    apiWindowStart     = now;
  }
  apiCallsThisMinute++;
  return true;
}

// Timeout wrapper - kills hung API calls after 5 seconds

function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("API timeout")), ms))
  ]);
}

// - SE-W1: Alpaca circuit breaker -
// Consecutive Alpaca failures pause trading to prevent state corruption
// Resets on first successful call

async function alpacaGet(endpoint, base = ALPACA_BASE) {
  try {
    trackAPICall();
    const res  = await withTimeout(fetch(`${base}${endpoint}`, { headers: alpacaHeaders() }));
    const text = await res.text();
    if (text.startsWith("<")) {
      _alpacaConsecFails++;
      if (res.status === 429) { _log("warn", `Rate limit hit: ${endpoint} - slowing down`); await new Promise(r => setTimeout(r, 2000)); }
      else if (res.status === 401 || res.status === 403) { _log("error", `Auth error ${res.status} on ${endpoint} - check API keys`); }
      else { _log("warn", `API returned HTML on ${endpoint} (status ${res.status}) - skipping`); }
      if (_alpacaConsecFails >= ALPACA_CIRCUIT_THRESHOLD && !_alpacaCircuitOpen) {
        _alpacaCircuitOpen = true;
        _log("warn", `[CIRCUIT] Alpaca API degraded (${_alpacaConsecFails} consecutive failures) - new entries paused`);
        if (_alertFn) _alertFn("ARGO-V3.0 ALERT - Alpaca API degraded",
          `<p>${_alpacaConsecFails} consecutive Alpaca failures. New entries paused. Check Railway logs.</p>`).catch(()=>{});
      }
      return null;
    }
    // Successful call - reset circuit
    if (_alpacaConsecFails > 0) {
      _log("scan", `[CIRCUIT] Alpaca API recovered after ${_alpacaConsecFails} failures`);
      _alpacaConsecFails = 0;
      _alpacaCircuitOpen = false;
    }
    return JSON.parse(text);
  } catch(e) {
    _alpacaConsecFails++;
    if (_alpacaConsecFails >= ALPACA_CIRCUIT_THRESHOLD && !_alpacaCircuitOpen) {
      _alpacaCircuitOpen = true;
      _log("warn", `[CIRCUIT] Alpaca API circuit open after network failures`);
    }
    _log("error", `alpacaGet(${endpoint}): ${e.message}`);
    return null;
  }
}

async function alpacaPost(endpoint, body, method = "POST") {
  try {
    const opts = { method, headers: alpacaHeaders() };
    if (body && Object.keys(body).length > 0) opts.body = JSON.stringify(body);
    const res = await withTimeout(fetch(`${ALPACA_BASE}${endpoint}`, opts), 8000);
    const text = await res.text();
    if (!text || text.trim() === "") return { ok: true }; // DELETE returns empty
    // Alpaca cancel endpoint returns plain text "Not Found" when order already gone
    if (res.status === 404 || text.trim() === "Not Found") return { status: "not_found" };
    try { return JSON.parse(text); }
    catch(e) { return { status: res.status, raw: text }; } // non-JSON fallback
  } catch(e) { _log("error", `alpacaPost(${endpoint}): ${e.message}`); return null; }
}

async function alpacaDelete(endpoint) {
  return alpacaPost(endpoint, {}, "DELETE");
}

// Get latest stock quote

async function getStockQuote(ticker) {
  const data = await alpacaGet(`/stocks/${ticker}/quotes/latest`, ALPACA_DATA);
  if (data && data.quote) {
    // Stale data check - reject quotes older than 5 minutes during market hours
    const quoteTime = data.quote.t ? new Date(data.quote.t).getTime() : Date.now();
    const ageMs     = Date.now() - quoteTime;
    const STALE_MS  = 5 * 60 * 1000; // 5 minutes
    if (ageMs > STALE_MS && isMarketHours()) {
      _log("warn", `${ticker} quote is ${(ageMs/60000).toFixed(1)}min old - stale data, skipping`);
      return null; // return null so calling code skips this stock
    }
    return parseFloat(data.quote.ap || data.quote.bp || 0);
  }
  // Fallback to snapshot
  const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
  if (snap && snap.latestTrade) return parseFloat(snap.latestTrade.p || 0);
  return null;
}

// Get stock bars for volume and MA calculation

async function getStockBars(ticker, limit = 60) {
  // Daily bars only update once per day - cache for 60 minutes
  const cacheKey = 'bars:' + ticker + ':' + limit;
  const cached = getCached(cacheKey, BARS_CACHE_TTL);
  if (cached) return cached;
  try {
    // Always use date range - more reliable than limit param across all Alpaca tiers
    const end   = new Date().toISOString().split("T")[0];
    const start = new Date(Date.now() - Math.ceil(limit * 1.6) * MS_PER_DAY).toISOString().split("T")[0];
    // Try SIP feed first (Pro tier), fall back to IEX (free tier)
    const feeds = ["sip", "iex"];
    for (const feed of feeds) {
      const url  = `/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}&feed=${feed}`;
      const data = await alpacaGet(url, ALPACA_DATA);
      if (data && data.bars && data.bars.length > 1) {
        // Daily bars don't change intraday - cache for 60 minutes
        return setCache('bars:' + ticker + ':' + limit, data.bars);
      }
    }
    // Last resort - no feed param
    const last = await alpacaGet(`/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=${limit}`, ALPACA_DATA);
    return last && last.bars ? last.bars : [];
  } catch(e) { return []; }

}

// Get intraday bars - 1-minute candles for today's session
// Used for real-time RSI, MACD, VWAP, momentum signals
// 1-minute gives maximum real-time accuracy - updated every scan cycle

async function getIntradayBars(ticker, minutes = 390) {
  // OPT1: Cache intraday bars for 30s — updates every minute, 30s loses nothing
  // OPT8: For sub-390 requests, try to slice from the cached 390-min bars first
  const _intradayCacheKey = `intraday:${ticker}:${minutes}`;
  const _intradayCached   = getCached(_intradayCacheKey, 30 * 1000);
  if (_intradayCached) return _intradayCached;
  if (minutes < 390) {
    const _fullCached = getCached(`intraday:${ticker}:390`, 30 * 1000);
    if (_fullCached && _fullCached.length >= minutes) {
      const _sliced = _fullCached.slice(-minutes);
      setCache(_intradayCacheKey, _sliced);
      return _sliced; // OPT8: serve sub-window from full cached bars
    }
  }
  try {
    // Calculate market open in ET (Railway runs UTC - must use ET explicitly)
    const nowET       = getETTime();
    const marketOpen  = new Date(nowET);
    marketOpen.setHours(9, 30, 0, 0);

    // Convert ET market open back to UTC ISO for Alpaca API
    // getETTime returns a Date object representing ET - get its UTC equivalent
    const etOffsetMs  = nowET.getTime() - new Date().getTime(); // ET offset from UTC
    const openUTC     = new Date(marketOpen.getTime() - etOffsetMs);
    const startISO    = openUTC.toISOString();
    const endISO      = new Date().toISOString();

    const feeds = ["sip", "iex"];
    for (const feed of feeds) {
      const url  = `/stocks/${ticker}/bars?timeframe=1Min&start=${startISO}&end=${endISO}&limit=390&feed=${feed}`;
      const data = await alpacaGet(url, ALPACA_DATA);
      if (data && data.bars && data.bars.length >= 5)
        return setCache(_intradayCacheKey, data.bars);
    }
    return [];
  } catch(e) { return []; }
}

// Get VIX - cached for 60 seconds to avoid redundant API calls
let _vixCache = { value: 15, ts: 0 };


module.exports = {
  alpacaGet, alpacaPost, alpacaDelete,
  getStockQuote, getStockBars, getIntradayBars,
  getCircuitState, setBrokerLogger,
  alpacaHeaders, withTimeout,
};;;
