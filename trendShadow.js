// trendShadow.js — 10/14 (Harrison): TREND-SWING AS A SHADOW BOOK.
// Trend-swing no longer places orders (TREND_MODE = "shadow"). The same QQQ signal still fires in scanner.js, and
// each hypothetical trade runs here under the same rules as the live sleeve had: entry contract picked by the live
// findContract (real Alpaca quote, ~0.65 delta, ~60 DTE), the fixed underlying stop (3.5 x ATR, clamped exactly as
// the live exit engine did), the 3-ATR chandelier checked once a day at 15:50 ET, the 21-DTE roll that carries the
// stop and high-water mark, and the 5-trading-day re-entry cooldown. Option prices at entry, roll, exit and the daily
// mark come from real Alpaca option snapshots. Nothing here can place, change or close an order.
// P&L is per 1 contract at the mid; `sizeCt` records what the live sizing would have bought, and the conservative
// figure (buy at the ask, sell at the bid) is kept alongside.
'use strict';

const { state, logEvent, markDirty } = require('./state');
const { alpacaGet } = require('./broker');
const { getETTime } = require('./signals');
const DAYCTX = require('./dayContext');
const {
  TREND_DELTA = 0.65, TREND_TARGET_DTE = 60, TREND_ROLL_DTE = 21, TREND_COOLDOWN_DAYS = 5,
  TREND_ATR_STOP_MULT = 3.5, TREND_USTOP_FLOOR = 0.20, TREND_USTOP_CEIL = 0.55,
  TREND_CHANDELIER_ATR = 3.0, TREND_CHANDELIER_CHECK_ET = 15.83,
  TREND_RISK_BUDGET = 0.01, TREND_MAX_RISK_PCT = 0.03,
  ALPACA_OPT_SNAP, OPTION_FEED,
} = require('./constants');

const CLOSED_KEEP = 300;
const _busy = new Set();

function book() {
  if (!state._trendShadow || typeof state._trendShadow !== 'object') state._trendShadow = { open: [], closed: [] };
  const b = state._trendShadow;
  if (!Array.isArray(b.open)) b.open = [];
  if (!Array.isArray(b.closed)) b.closed = [];
  return b;
}
const _etNow = () => { const et = getETTime(); return { h: et.getHours() + et.getMinutes() / 60, day: et.toLocaleDateString('en-CA') }; };
const _r2 = (x) => Math.round(x * 100) / 100;
const _dte = (expDate) => Math.round((Date.parse(String(expDate) + 'T20:00:00Z') - Date.now()) / 86400000);

function hasOpen(ticker, side) {
  return book().open.some(t => t.ticker === ticker && (!side || t.side === side));
}

// Same rule as the live cooldown: no new entry until the 6th trading day after the last exit (rolls don't count).
function cooldown(ticker) {
  const last = book().closed.filter(t => t.ticker === ticker).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))[0];
  if (!last || !last.exitDay || !(TREND_COOLDOWN_DAYS > 0)) return null;
  const since = DAYCTX.tradingDaysBetween(last.exitDay, DAYCTX.etDateStr(Date.now()));
  return since <= TREND_COOLDOWN_DAYS ? `shadow re-entry cooldown — ${since} of ${TREND_COOLDOWN_DAYS} trading days since the ${last.exitDay} exit` : null;
}

async function quote(symbol) {
  try {
    const d = await alpacaGet(`/options/snapshots?symbols=${symbol}&feed=${OPTION_FEED}`, ALPACA_OPT_SNAP);
    const q = d && d.snapshots && d.snapshots[symbol] && d.snapshots[symbol].latestQuote;
    const bid = parseFloat(q && q.bp) || 0, ask = parseFloat(q && q.ap) || 0;
    if (!(bid > 0 && ask > 0)) return null;
    return { bid, ask, mid: _r2((bid + ask) / 2), at: Date.now() };
  } catch (_) { return null; }
}

// Live stop distance, as exitEngine computed it: option-% stop = clamp(delta x 3.5 ATR / premium), converted back to
// an underlying distance. So the clamp can make it tighter or looser than exactly 3.5 ATR, same as live.
function _stopPlan(prem, delta, atr) {
  const stopPct = Math.min(TREND_USTOP_CEIL, Math.max(TREND_USTOP_FLOOR, (delta * TREND_ATR_STOP_MULT * atr) / prem));
  const dist = (delta > 0 && prem > 0) ? stopPct * prem / delta : 0;
  const riskPerCt = Math.max(1, stopPct * prem * 100);
  const equity = state.equity || state.cash || 90000;
  const sizeCt = Math.max(1, Math.min(5, Math.floor((TREND_RISK_BUDGET * equity) / riskPerCt)));
  return { stopPct, dist, riskPerCt, sizeCt, riskPct: (sizeCt * riskPerCt) / equity };
}

async function _pick(ticker, side, ctx) {
  const stock = Object.assign({}, ctx.stock || { ticker }, { ticker, _isTrend: side, _trendCarry: null });
  const c = await ctx.findContract(ticker, side, TREND_DELTA, TREND_TARGET_DTE, ctx.vix, stock);
  if (!c || !(c.premium > 0)) return null;
  return { symbol: c.symbol, strike: c.strike, expDate: c.expDate, delta: Math.abs(parseFloat(c.greeks && c.greeks.delta)) || TREND_DELTA,
           entryMid: _r2(c.premium), entryBid: c.bid || null, entryAsk: c.ask || null, openedAt: Date.now() };
}

// ctx: { findContract, vix, stock, atr, reason }
async function open(ticker, side, u, ctx) {
  if (!(u > 0) || !(ctx && ctx.atr > 0) || hasOpen(ticker)) return { opened: false, why: 'precondition' };
  const leg = await _pick(ticker, side, ctx);
  if (!leg) { logEvent('scan', `[TREND-SHADOW] ${ticker} ${side} signal — no contract found (no shadow entry)`); return { opened: false, why: 'no contract' }; }
  const plan = _stopPlan(leg.entryMid, leg.delta, ctx.atr);
  if (plan.riskPct > TREND_MAX_RISK_PCT) {
    logEvent('scan', `[TREND-SHADOW] ${ticker} ${side} — live sizing would have skipped it (1 contract risks ${(plan.riskPct * 100).toFixed(1)}% > ${(TREND_MAX_RISK_PCT * 100).toFixed(0)}%)`);
    return { opened: false, why: 'risk cap' };
  }
  const isCall = side === 'call';
  const { day } = _etNow();
  const t = {
    id: `${ticker}-${side}-shadow-${Date.now()}`, ticker, side, reason: ctx.reason || null,
    openedAt: Date.now(), openDay: day, uEntry: _r2(u), atrEntry: _r2(ctx.atr), sizeCt: plan.sizeCt,
    legs: [leg],
    ch: { entryU: _r2(u), stopPx: _r2(isCall ? u - plan.dist : u + plan.dist), hi: _r2(u), lo: _r2(u), lastDay: null, rolls: 0 },
    lastMark: { mid: leg.entryMid, u: _r2(u), at: Date.now() },
  };
  book().open.push(t); markDirty();
  logEvent('scan', `[TREND-SHADOW] ${ticker} OPEN ${side.toUpperCase()} (no order) — ${leg.symbol} $${leg.strike} exp ${leg.expDate} d${leg.delta.toFixed(2)} @ $${leg.entryMid} mid` +
    ` | ${ticker} $${t.uEntry}, stop $${t.ch.stopPx}, chandelier ${TREND_CHANDELIER_ATR}x ATR $${t.atrEntry} | live size would be ${plan.sizeCt}x | ${ctx.reason || ''}`);
  return { opened: true, trade: t };
}

function _legPnl(leg) {
  const mid = (leg.exitMid - leg.entryMid) * 100;
  const cons = (leg.exitBid != null && leg.entryAsk != null) ? (leg.exitBid - leg.entryAsk) * 100 : null;
  return { mid: _r2(mid), cons: cons == null ? null : _r2(cons) };
}

async function _closeLeg(t, leg) {
  const q = await quote(leg.symbol);
  if (q) { leg.exitMid = q.mid; leg.exitBid = q.bid; leg.exitAsk = q.ask; leg.priceSrc = 'quote'; }
  else { leg.exitMid = (t.lastMark && t.lastMark.mid) || leg.entryMid; leg.exitBid = null; leg.priceSrc = 'last-mark'; }
  leg.closedAt = Date.now();
  return _legPnl(leg);
}

async function _close(t, reason, u) {
  const leg = t.legs[t.legs.length - 1];
  await _closeLeg(t, leg);
  const legs = t.legs.map(_legPnl);
  t.pnl = _r2(legs.reduce((s, x) => s + x.mid, 0));
  t.pnlCons = legs.every(x => x.cons != null) ? _r2(legs.reduce((s, x) => s + x.cons, 0)) : null;
  t.pnlAtSize = _r2(t.pnl * (t.sizeCt || 1));
  t.exitReason = reason; t.uExit = _r2(u); t.closedAt = Date.now(); t.exitDay = _etNow().day;
  const b = book();
  b.open = b.open.filter(x => x.id !== t.id);
  b.closed.push(t); if (b.closed.length > CLOSED_KEEP) b.closed.splice(0, b.closed.length - CLOSED_KEEP);
  markDirty();
  logEvent('scan', `[TREND-SHADOW] ${t.ticker} CLOSE ${t.side.toUpperCase()} — ${reason} | ${t.ticker} $${t.uEntry} -> $${t.uExit}` +
    ` | P&L $${t.pnl} per contract at mid${t.pnlCons != null ? ` ($${t.pnlCons} ask-to-bid)` : ''}, $${t.pnlAtSize} at live size ${t.sizeCt}x` +
    `${t.legs.length > 1 ? ` over ${t.legs.length} legs` : ''}${leg.priceSrc !== 'quote' ? ' [no live quote — priced at last mark]' : ''}`);
}

// Called every scan for each trend ticker with a fresh underlying price. ctx: { findContract, vix, stock, atr }
async function step(ticker, u, ctx = {}) {
  if (!(u > 0)) return;
  for (const t of book().open.filter(x => x.ticker === ticker)) {
    if (_busy.has(t.id)) continue;
    _busy.add(t.id);
    try {
      const isCall = t.side === 'call', ch = t.ch;
      if (isCall ? u <= ch.stopPx : u >= ch.stopPx) { await _close(t, 'trend-stop', u); continue; }
      const { h, day } = _etNow();
      const atr = ctx.atr;
      if (h >= TREND_CHANDELIER_CHECK_ET && ch.lastDay !== day && atr > 0) {
        const level = isCall ? ch.hi - TREND_CHANDELIER_ATR * atr : ch.lo + TREND_CHANDELIER_ATR * atr;
        if (isCall ? u <= level : u >= level) { await _close(t, 'trend-chandelier', u); continue; }
        if (isCall) ch.hi = _r2(Math.max(ch.hi, u)); else ch.lo = _r2(Math.min(ch.lo, u));
        ch.lastDay = day;
        const leg = t.legs[t.legs.length - 1];
        const q = await quote(leg.symbol);
        if (q) t.lastMark = { mid: q.mid, u: _r2(u), at: Date.now() };
        markDirty();
        const next = isCall ? ch.hi - TREND_CHANDELIER_ATR * atr : ch.lo + TREND_CHANDELIER_ATR * atr;
        const openPnl = q ? _r2((q.mid - leg.entryMid) * 100 + t.legs.slice(0, -1).reduce((s, l) => s + _legPnl(l).mid, 0)) : null;
        logEvent('scan', `[TREND-SHADOW] ${ticker} close-check $${u.toFixed(2)} — holding. ${isCall ? 'High' : 'Low'} close $${isCall ? ch.hi : ch.lo}; exit level $${next.toFixed(2)} (stop $${ch.stopPx})` +
          `${openPnl != null ? ` | open P&L $${openPnl} per contract` : ''}`);
      }
      const leg = t.legs[t.legs.length - 1];
      if (_dte(leg.expDate) <= TREND_ROLL_DTE && typeof ctx.findContract === 'function') {
        const nl = await _pick(ticker, t.side, ctx);
        if (!nl) { logEvent('scan', `[TREND-SHADOW] ${ticker} roll due (${_dte(leg.expDate)} DTE) — no new contract found, retrying next scan`); continue; }
        const p = await _closeLeg(t, leg);
        t.legs.push(nl); ch.rolls = (ch.rolls || 0) + 1; t.lastMark = { mid: nl.entryMid, u: _r2(u), at: Date.now() }; markDirty();
        logEvent('scan', `[TREND-SHADOW] ${ticker} ROLL — closed ${leg.symbol} ($${p.mid} per contract), now ${nl.symbol} exp ${nl.expDate} @ $${nl.entryMid}; stop $${ch.stopPx} carries over`);
      }
    } catch (e) {
      logEvent('warn', `[TREND-SHADOW] ${ticker} step failed — ${e && e.message}`);
    } finally { _busy.delete(t.id); }
  }
}

function summary() {
  const b = book();
  const closed = b.closed.slice();
  const pnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  return {
    open: b.open.map(t => {
      const leg = t.legs[t.legs.length - 1];
      const done = t.legs.slice(0, -1).reduce((s, l) => s + _legPnl(l).mid, 0);
      return { ticker: t.ticker, side: t.side, openDay: t.openDay, uEntry: t.uEntry, symbol: leg.symbol, entryMid: leg.entryMid,
               markMid: t.lastMark && t.lastMark.mid, markU: t.lastMark && t.lastMark.u, stopPx: t.ch.stopPx,
               exitLevelHint: t.side === 'call' ? t.ch.hi : t.ch.lo, rolls: t.ch.rolls || 0, sizeCt: t.sizeCt,
               openPnl: t.lastMark ? _r2((t.lastMark.mid - leg.entryMid) * 100 + done) : null };
    }),
    closed: closed.map(t => ({ ticker: t.ticker, side: t.side, openDay: t.openDay, exitDay: t.exitDay, exitReason: t.exitReason,
                               uEntry: t.uEntry, uExit: t.uExit, legs: t.legs.length, pnl: t.pnl, pnlCons: t.pnlCons, pnlAtSize: t.pnlAtSize, sizeCt: t.sizeCt })),
    totals: { n: closed.length, wins: closed.filter(t => (t.pnl || 0) > 0).length, pnl: _r2(pnl) },
  };
}

module.exports = { book, hasOpen, cooldown, open, step, summary, quote, _stopPlan };
