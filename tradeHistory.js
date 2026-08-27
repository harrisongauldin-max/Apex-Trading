// tradeHistory.js — 8/27
// Pulls EVERY fill this Alpaca account has ever made (the ground truth, independent of the journal),
// decodes the OCC option symbols, and FIFO-matches buys->sells into round-trip trades with REAL
// realized P&L. This is the reconciliation the context log requires before any journal-derived
// analysis is trusted. Runs IN APEX (uses broker's authenticated alpacaGet on the trading API).
//
// NOTE: Alpaca fills carry the OUTCOME (price, time, qty) but NOT the entry-time signal state
// (RSI, VIX, score, regime). To validate signals you still join this against the journal on
// symbol+entryTime — this tool supplies the trustworthy P&L half of that join.

const { alpacaGet } = require('./broker');
let logEvent = () => {}; try { ({ logEvent } = require('./state')); } catch (_) {}

// OCC symbol, e.g. "QQQ260904C00720000" -> { underlying, expiry, type, strike }
function decodeOCC(sym) {
  const m = String(sym || "").match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return { underlying: sym, expiry: null, type: "stock", strike: null };
  const [, und, ymd, cp, strike8] = m;
  return {
    underlying: und,
    expiry: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    type: cp === "C" ? "call" : "put",
    strike: parseInt(strike8, 10) / 1000,
  };
}

// Paginate /account/activities?activity_types=FILL. Alpaca pages by passing the LAST activity id as
// page_token; a short page (or empty) ends it. Defensive against both a raw array and a wrapped body.
async function fetchAllFills({ after = null, until = null, maxPages = 300 } = {}) {
  const fills = [];
  let pageToken = null;
  for (let p = 0; p < maxPages; p++) {
    let ep = `/account/activities?activity_types=FILL&page_size=100&direction=asc`;
    if (after)     ep += `&after=${encodeURIComponent(after)}`;
    if (until)     ep += `&until=${encodeURIComponent(until)}`;
    if (pageToken) ep += `&page_token=${encodeURIComponent(pageToken)}`;
    let page;
    try { page = await alpacaGet(ep); } catch (e) { logEvent("scan", `[TRADE-HISTORY] fetch page ${p} failed — ${e && e.message}`); break; }
    const arr = Array.isArray(page) ? page : (page && Array.isArray(page.activities) ? page.activities : null);
    if (!arr || arr.length === 0) break;
    fills.push(...arr);
    pageToken = arr[arr.length - 1].id;
    if (arr.length < 100 || !pageToken) break;
  }
  return fills;
}

// FIFO-match per symbol: each buy opens a lot; each sell closes lot(s) oldest-first.
function reconstructTrades(fills) {
  const bySym = {};
  for (const f of fills) { if (f && f.symbol) (bySym[f.symbol] = bySym[f.symbol] || []).push(f); }
  const trades = [];
  for (const [sym, arr] of Object.entries(bySym)) {
    arr.sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time));
    const opens = [];
    for (const f of arr) {
      const qty = Math.abs(parseFloat(f.qty || 0));
      const px  = parseFloat(f.price || 0);
      const t   = f.transaction_time;
      if (!(qty > 0) || !(px > 0)) continue;
      const isOpt = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(sym);
      const mult  = isOpt ? 100 : 1;
      if (f.side === "buy") {
        opens.push({ qty, px, t });
      } else if (f.side === "sell") {
        let rem = qty;
        while (rem > 0 && opens.length) {
          const lot = opens[0];
          const m   = Math.min(rem, lot.qty);
          const info = decodeOCC(sym);
          trades.push({
            symbol: sym, ...info, qty: m,
            entryTime: lot.t, entryPx: lot.px, exitTime: t, exitPx: px,
            holdMin: Math.round((new Date(t) - new Date(lot.t)) / 60000),
            pnl: parseFloat(((px - lot.px) * m * mult).toFixed(2)),
            pnlPct: lot.px > 0 ? parseFloat((((px - lot.px) / lot.px) * 100).toFixed(2)) : 0,
          });
          lot.qty -= m; rem -= m;
          if (lot.qty <= 1e-9) opens.shift();
        }
        // a sell with no matching open lot = short/orphan; recorded as unmatched so nothing is silently dropped
        if (rem > 0) trades.push({ symbol: sym, ...decodeOCC(sym), qty: rem, entryTime: null, entryPx: null, exitTime: t, exitPx: px, holdMin: null, pnl: null, pnlPct: null, note: "unmatched-sell" });
      }
    }
    // leftover open lots = still-open positions (no exit)
    for (const lot of opens) trades.push({ symbol: sym, ...decodeOCC(sym), qty: lot.qty, entryTime: lot.t, entryPx: lot.px, exitTime: null, exitPx: null, holdMin: null, pnl: null, pnlPct: null, note: "still-open" });
  }
  trades.sort((a, b) => new Date(a.entryTime || a.exitTime || 0) - new Date(b.entryTime || b.exitTime || 0));
  return trades;
}

async function buildTradeHistoryCSV(opts = {}) {
  const fills  = await fetchAllFills(opts);
  const trades = reconstructTrades(fills);
  const header = "entryTime,exitTime,underlying,type,strike,expiry,qty,entryPx,exitPx,holdMin,pnl,pnlPct,note,symbol";
  const esc = v => (v === null || v === undefined) ? "" : String(v);
  const lines = [header];
  for (const t of trades) lines.push([t.entryTime, t.exitTime, t.underlying, t.type, t.strike, t.expiry, t.qty, t.entryPx, t.exitPx, t.holdMin, t.pnl, t.pnlPct, t.note || "", t.symbol].map(esc).join(","));
  const closed = trades.filter(t => t.pnl !== null);
  const net = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0).length;
  logEvent("scan", `[TRADE-HISTORY] ${fills.length} fills -> ${closed.length} closed round-trips | net $${net.toFixed(0)} | WR ${closed.length ? (100 * wins / closed.length).toFixed(0) : 0}%`);
  return { csv: lines.join("\n"), fills: fills.length, closed: closed.length, net: parseFloat(net.toFixed(2)), wins };
}

module.exports = { fetchAllFills, reconstructTrades, buildTradeHistoryCSV, decodeOCC };
