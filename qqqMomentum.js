// qqqMomentum.js — 11/25 (Harrison): QQQ intraday momentum on SHARES ("noise-area" breakout held to a trailing stop or the close).
//
// WHY: the only intraday rule that passed APEX's own 10-year test (flowBacktest.js T2, 2016-2026, QQQ): Sharpe 0.93 net of
// 1 bp a side, positive in both halves (0.76 / 1.07), about +3 bp a day on the underlying. The same trades as options failed
// (theta + spread), and on SPY the rule failed — so this sleeve trades QQQ shares only.
// Literature: Zarattini, Aziz & Barbon (2024), "Beat the Market: An Effective Intraday Momentum Strategy for S&P500 ETF";
// Gao, Han, Li & Zhou (2018) on intraday momentum.
//
// THE RULE — identical to the tested one (same bar handling: flowBacktest.groupDays / pxAt on 5-minute SIP bars, raw prices):
//   noise(m)   = average over the last 14 full sessions of |price at time m / that day's open - 1|        (needs >= 10)
//   upper band = max(today's open, prior close) x (1 + noise(m));  lower band = min(open, prior close) x (1 - noise(m))
//   checks at every half hour 10:00 ... 15:30 ET, on the 5-minute bar that just closed:
//     long  and close < max(upper band, session VWAP)  -> exit
//     short and close > min(lower band, session VWAP)  -> exit
//     flat (before 15:30): close > upper band -> long;  close < lower band -> short
//   anything still open is closed at the end of the session.
// Live differences from the test, all small and all logged: orders are market orders sent seconds after the bar closes (the test
// fills at the bar close), the final exit is 2 minutes before the close (the test uses the last bar), and the prior close is the
// previous session's even if that was a half day (the test dropped half days from its day list). Half days are not traded
// (the test skipped them). Each day the EOD report replays the exact tested rule at bar prices beside the live fills.
//
// One position, one ticker, flat every night. Size = QMOM_NOTIONAL_PCT of account equity. Orders carry client ids "qm-...".
// This sleeve sits OUTSIDE the options heat cap for now (its notional is reported, not counted) — see the 11/25 audit note.
//
// BOOK vs BROKER: the broker's record of this sleeve's own orders is the truth. Before any order the sleeve compares its book
// with the broker's QQQ shares; if they differ and the difference is exactly what today's filled "qm-" orders add up to, the book
// is rebuilt from them (a fill the book lost: restart, or an answer that never arrived). Shares it cannot account for are never
// touched and stop the sleeve for the day. While an order is between the broker and the book, the options book's cash sync and
// the profit-lock shadow skip that reading (inFlight / flightSeq) — a 50%-of-equity position must never read as a cash loss.
"use strict";
const C = (() => { try { return require("./constants"); } catch (_) { return {}; } })();
const FB = require("./flowBacktest");
const TT = require("./tradingTime");

const CFG = {
  ENABLED:      C.QMOM_ENABLED !== false,
  MODE:         (process.env.QMOM_MODE || C.QMOM_MODE || "live") === "shadow" ? "shadow" : "live",
  TICKER:       C.QMOM_TICKER || "QQQ",
  NOTIONAL_PCT: C.QMOM_NOTIONAL_PCT > 0 ? C.QMOM_NOTIONAL_PCT : 0.5,
  ALLOW_SHORT:  C.QMOM_ALLOW_SHORT !== false,
  LOOKBACK: 14, MIN_DAYS: 10,
  FIRST_CHECK: 600, LAST_CHECK: 930, STEP: 30,       // 10:00 ... 15:30 ET; no new entry at the 15:30 check
  GRACE_MIN: 0.2, WINDOW_MIN: 4,                      // act 12 s to 4 min after the bar closes; later = missed
  EXIT_BEFORE_CLOSE_MIN: 2,
  COST_BP: 1,                                         // per side, used only to net the paper-price replay (as in the test)
  KILL_COST_BP: 4, KILL_COST_TRADES: 40,              // lines set 11/25, before the first trade (reported, not automatic)
  KILL_DD_PCT: 10,
  HIST_DAYS: 400,
};
const CHECKS = []; for (let m = CFG.FIRST_CHECK; m <= CFG.LAST_CHECK; m += CFG.STEP) CHECKS.push(m);

// ───────────────────────── time ─────────────────────────
const _fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false });
function etParts(ms = Date.now()) {
  const p = {}; for (const x of _fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + (+p.minute) + (+p.second) / 60,
           dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
const hhmm = (min) => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, "0")}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const money = (v) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
const bp = (v) => (v == null || !isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)} bp`);

// ───────────────────────── broker IO (own fetch, like the stocks sleeve; replaceable in tests) ─────────────────────────
let _io = null;
function defaultIO() {
  const fetch = require("node-fetch"), https = require("https");
  const agent = new https.Agent({ keepAlive: false });
  const { alpacaHeaders } = require("./broker");
  async function req(url, opts = {}, timeoutMs = 20000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { agent, headers: alpacaHeaders(), signal: ctl.signal, ...opts });
      const txt = await r.text(); let body = null;
      try { body = txt ? JSON.parse(txt) : null; } catch (_) { body = { raw: txt }; }
      return { status: r.status, body };
    } finally { clearTimeout(t); }
  }
  return {
    data:  (p) => req(C.ALPACA_DATA + p),
    trade: (p) => req(C.ALPACA_BASE + p),
    post:  (p, b) => req(C.ALPACA_BASE + p, { method: "POST", body: JSON.stringify(b) }, 10000),
  };
}
const io = () => _io || (_io = defaultIO());
const ok2 = (r) => r && r.status >= 200 && r.status < 300;

async function fetchBars(startISO, endISO) {
  const out = []; let token = null, guard = 0;
  do {
    const q = `/stocks/${CFG.TICKER}/bars?timeframe=5Min&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`
            + `&adjustment=raw&feed=sip&limit=10000${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const r = await io().data(q);
    if (!ok2(r)) throw new Error(`bars HTTP ${r && r.status}`);
    out.push(...((r.body && r.body.bars) || []));
    token = r.body && r.body.next_page_token;
  } while (token && ++guard < 20);
  return out;
}
// signed shares at the broker (+ long, - short); 0 if none; null if the read failed
async function brokerQty() {
  try {
    const r = await io().trade(`/positions/${CFG.TICKER}`);
    if (r && r.status === 404) return 0;
    if (ok2(r) && r.body) { const q = Math.abs(+(r.body.qty || 0)); return r.body.side === "short" || +r.body.qty < 0 ? -q : q; }
  } catch (_) {}
  return null;
}
async function equityNow(state) {
  try { const r = await io().trade("/account"); if (ok2(r) && +r.body.equity > 0) return +r.body.equity; } catch (_) {}
  return +(state && (state.alpacaEquity || state.cash)) || 0;
}

// ───────────────────────── pure rule (unit-tested against flowBacktest.t2Day) ─────────────────────────
// one session's RTH 5-minute bars -> the same day object flowBacktest.groupDays builds, without its full-day filter
function buildDay(bars, day) {
  const bs = [];
  for (const b of bars || []) {
    const p = FB.etParts(b.t);
    if (p.day !== day || p.m < 570 || p.m >= 960) continue;
    bs.push({ m: p.m, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 });
  }
  bs.sort((a, b) => a.m - b.m);
  let pv = 0, vv = 0;
  for (const b of bs) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; b.vwap = vv > 0 ? pv / vv : b.c; }
  return bs.length ? { date: day, bars: bs, open: bs[0].o, close: bs[bs.length - 1].c, lastM: bs[bs.length - 1].m } : null;
}
// prior FULL sessions (as the test defines them) -> noise(m) for every check; null where fewer than MIN_DAYS have a bar
function noiseMap(priorDays) {
  const use = priorDays.slice(-CFG.LOOKBACK), sig = {};
  for (const m of CHECKS) {
    let s = 0, k = 0;
    for (const d of use) { const b = FB.pxAt(d, m); if (b) { s += Math.abs(b.c / d.open - 1); k++; } }
    sig[m] = use.length >= CFG.LOOKBACK && k >= CFG.MIN_DAYS ? s / k : null;
  }
  return sig;
}
// the tested decision at one check. pos: 1 long, -1 short, 0 flat. Returns { exit, enter } (enter: 1, -1 or 0).
function stepRule(pos, c, vwap, UB, LB, m) {
  let exit = false;
  if (pos > 0 && c < Math.max(UB, vwap)) exit = true;
  else if (pos < 0 && c > Math.min(LB, vwap)) exit = true;
  const flat = pos === 0 || exit;
  let enter = 0;
  if (flat && m < CFG.LAST_CHECK) { if (c > UB) enter = 1; else if (c < LB) enter = -1; }
  return { exit, enter };
}
// replay one full day at bar prices -> the tested trades (gross returns) and the day's net return, as flowBacktest.t2Day
function replayDay(d, sig, prevClose) {
  const up = Math.max(d.open, prevClose), dn = Math.min(d.open, prevClose);
  let pos = 0, entry = null, entryM = null; const trades = [];
  for (const m of CHECKS) {
    const b = FB.pxAt(d, m); if (!b || sig[m] == null) continue;
    const UB = up * (1 + sig[m]), LB = dn * (1 - sig[m]);
    const a = stepRule(pos, b.c, b.vwap, UB, LB, m);
    if (a.exit) { trades.push({ dir: pos, r: pos > 0 ? b.c / entry - 1 : 1 - b.c / entry, from: entryM, to: m, e0: entry, e1: b.c }); pos = 0; }
    if (a.enter) { pos = a.enter; entry = b.c; entryM = m; }
  }
  const z = d.bars[d.bars.length - 1];
  if (pos) trades.push({ dir: pos, r: pos > 0 ? z.c / entry - 1 : 1 - z.c / entry, from: entryM, to: z.m + 5, e0: entry, e1: z.c });
  const cost = 2 * CFG.COST_BP / 1e4;
  return { trades, ret: trades.reduce((s, t) => s + t.r - cost, 0), gross: trades.reduce((s, t) => s + t.r, 0) };
}

// ───────────────────────── day state ─────────────────────────
function freshDay(day) {
  return { day, mode: CFG.MODE, ticker: CFG.TICKER, ready: false, skip: null, halt: null, sig: null, open: null, prevClose: null,
           pos: 0, qty: 0, entryPx: null, entryRef: null, entryM: null, notional: 0, trades: [], checks: [], done: {},
           pending: null, closed: false, final: false, ideal: null, prepFailAt: 0 };
}
const cid = (day, m, tag) => `qm-${day.replace(/-/g, "")}-${m}-${tag}`;
const isQmomOrder = (o) => !!(o && typeof o.client_order_id === "string" && o.client_order_id.startsWith("qm-"));

// options-book cash correction, as the stocks sleeve does: Alpaca cash moves by share notional; the options book should not see it
function cashAdjustment(state) {
  const s = state && state._qmom;
  if (!s || s.mode !== "live" || !s.pos || !(s.entryPx > 0)) return 0;
  return +((s.pos > 0 ? 1 : -1) * s.qty * s.entryPx).toFixed(2);
}
function openNotional(state) {
  const s = state && state._qmom;
  return s && s.pos && s.entryPx > 0 ? { dir: s.pos, qty: s.qty, notional: +(s.qty * s.entryPx).toFixed(2), live: s.mode === "live" } : { dir: 0, qty: 0, notional: 0, live: false };
}

// today's P&L of this sleeve as the account sees it: closed trades + the broker's unrealized on the open shares
function dayPnL(state, openPositions, now = Date.now()) {
  const s = state && state._qmom, z = { real: 0, unreal: 0 };
  if (!s || s.mode !== "live" || s.day !== etParts(now).day) return z;
  const real = (s.trades || []).reduce((a, t) => a + (+t.pnl || 0), 0);
  let unreal = 0;
  if (s.pos) { const p = (openPositions || []).find(x => x && x.symbol === CFG.TICKER); if (p && Number.isFinite(+p.unrealizedPnL)) unreal = +p.unrealizedPnL; }
  return { real: +real.toFixed(2), unreal: +unreal.toFixed(2) };
}

// ───────────────────────── orders ─────────────────────────
// An order changes the broker's cash before the book knows. _seq moves when an order is sent and when the book changes;
// _flightAt is set while an order's outcome is not yet in the book. Readers of account cash / day P&L use both to skip a
// reading taken across that gap (closeEngine.syncCashFromAlpaca, the profit-lock shadow in server.js).
let _seq = 0, _flightAt = 0;
const flightSeq = () => _seq;
const landed = () => { _seq++; _flightAt = 0; };
function inFlight(state) {
  const s = state && state._qmom;
  return Date.now() - _flightAt < 30000 || !!(s && s.mode === "live" && (s.pending || s.verify));
}
const byClientId = (clientId) => io().trade(`/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientId)}`);
const TERMINAL = ["canceled", "expired", "rejected"];

// market order, safe to repeat: the client id is fixed per (day, check, leg); a duplicate is adopted, never re-sent.
// -> { ok, px, qty } filled | { pending, id } still working | { definite } the broker holds no fill for it | neither = unknown
async function sendMarket(side, qty, clientId) {
  _seq++; _flightAt = Date.now();
  const body = { symbol: CFG.TICKER, qty: String(qty), side, type: "market", time_in_force: "day", client_order_id: clientId };
  let r = null;
  try { r = await io().post("/orders", body); } catch (e) { r = null; }
  let order = ok2(r) && r.body && r.body.id ? r.body : null;
  if (!order) {   // rejected, or no answer: look it up by its id before deciding anything
    let g = null;
    try { g = await byClientId(clientId); } catch (_) { g = null; }
    if (ok2(g) && g.body && g.body.id) order = g.body;
    if (!order) {
      // definite only when the broker answered both calls: it refused the order AND holds none under this id
      const definite = !!(r && r.status >= 400 && r.status < 500 && g && g.status === 404);
      return { ok: false, definite, msg: (r && r.body && (r.body.message || r.body.raw)) || (r ? `HTTP ${r.status}` : "no response") };
    }
  }
  for (let i = 0; i < 8 && !(order.status === "filled"); i++) {
    if (TERMINAL.includes(order.status)) return { ok: false, definite: !(+order.filled_qty > 0), msg: `order ${order.status}`, id: order.id };
    await sleep(CFG._pollMs != null ? CFG._pollMs : 1000);
    try { const g = await io().trade(`/orders/${order.id}`); if (ok2(g) && g.body && g.body.id) order = g.body; } catch (_) {}
  }
  if (order.status === "filled" && +order.filled_avg_price > 0) return { ok: true, id: order.id, px: +order.filled_avg_price, qty: +order.filled_qty || qty };
  return { ok: false, pending: true, id: order.id, msg: `order ${order.id} not filled yet (${order.status})` };
}

function applyEntry(s, dir, qty, px, ref, m) {
  s.pos = dir; s.qty = qty; s.entryPx = px; s.entryRef = ref; s.entryM = m; s.notional = +(qty * px).toFixed(2);
  _seq++;
}
function applyExit(s, px, ref, m, reason) {
  const pnl = s.pos * (px - s.entryPx) * s.qty;
  const t = { dir: s.pos, qty: s.qty, entryM: s.entryM, exitM: m, entryPx: s.entryPx, exitPx: px, entryRef: s.entryRef, exitRef: ref,
              pnl: +pnl.toFixed(2), retBp: +((s.pos * (px / s.entryPx - 1)) * 1e4).toFixed(2),
              refBp: s.entryRef > 0 && ref > 0 ? +((s.pos * (ref / s.entryRef - 1)) * 1e4).toFixed(2) : null, reason };
  s.trades.push(t);
  s.pos = 0; s.qty = 0; s.entryPx = null; s.entryRef = null; s.entryM = null;
  _seq++;
  return t;
}

// open (dir != 0) or close (dir 0) at one check. Shadow mode books the reference price; live sends the order.
async function act(s, kind, dir, ref, m, state, log, reason) {
  const live = s.mode === "live";
  if (kind === "out") {
    if (!s.pos) return true;
    const wasDir = s.pos, qty = s.qty;
    if (!live) { const t = applyExit(s, ref, ref, m, reason); log("trade", `[QMOM] SHADOW exit ${wasDir > 0 ? "long" : "short"} ${qty} @ $${ref.toFixed(2)} (${reason}) ${bp(t.retBp)}`); return true; }
    const id = cid(s.day, m, "out" + (s.outTry ? s.outTry : ""));   // a refused exit is re-sent under a new id; an unknown one never is
    const r = await sendMarket(wasDir > 0 ? "sell" : "buy", qty, id);
    if (r.ok) { const t = applyExit(s, r.px, ref, m, reason); landed(); log("trade", `[QMOM] EXIT ${wasDir > 0 ? "long" : "short"} ${qty} ${CFG.TICKER} @ $${r.px.toFixed(2)} (bar $${ref.toFixed(2)}, ${reason}) ${money(t.pnl)} ${bp(t.retBp)}`); return true; }
    if (r.pending) { s.pending = { id: r.id, kind, ref, m, reason }; landed(); log("warn", `[QMOM] exit ${r.msg} — will keep checking`); return false; }
    if (r.definite) { s.outTry = (s.outTry || 0) + 1; landed(); log("error", `[QMOM] EXIT REFUSED (${r.msg}) — ${qty} ${CFG.TICKER} ${wasDir > 0 ? "long" : "short"} still open; the rule is applied again at the next half hour and at the close`); return false; }
    s.verify = { at: Date.now(), cid: id, kind, ref, m, reason }; landed();
    log("error", `[QMOM] exit order: no answer from the broker (${r.msg}) — checking what it holds before anything else`); return false;
  }
  // entry
  if (dir < 0 && !CFG.ALLOW_SHORT) return true;
  const eq = await equityNow(state);
  const qty = Math.floor(CFG.NOTIONAL_PCT * eq / ref);
  if (!(qty >= 1)) { log("warn", `[QMOM] entry skipped: size < 1 share (equity $${eq.toFixed(0)})`); return true; }
  if (!live) { applyEntry(s, dir, qty, ref, ref, m); log("trade", `[QMOM] SHADOW ${dir > 0 ? "LONG" : "SHORT"} ${qty} ${CFG.TICKER} @ $${ref.toFixed(2)} at ${hhmm(m)}`); return true; }
  const id = cid(s.day, m, "in");
  const r = await sendMarket(dir > 0 ? "buy" : "sell", qty, id);
  if (r.ok) { applyEntry(s, dir, r.qty || qty, r.px, ref, m); landed(); log("trade", `[QMOM] ${dir > 0 ? "LONG" : "SHORT"} ${s.qty} ${CFG.TICKER} @ $${r.px.toFixed(2)} (bar $${ref.toFixed(2)}) at ${hhmm(m)} — $${s.notional.toLocaleString()} (${Math.round(CFG.NOTIONAL_PCT * 100)}% of equity)`); return true; }
  if (r.pending) { s.pending = { id: r.id, kind: "in", dir, qty, ref, m }; landed(); log("warn", `[QMOM] entry ${r.msg} — will keep checking`); return false; }
  if (r.definite) { landed(); log("error", `[QMOM] ENTRY FAILED (${r.msg}) — no position`); return true; }
  s.verify = { at: Date.now(), cid: id, kind: "in", dir, qty, ref, m }; landed();
  log("error", `[QMOM] entry order: no answer from the broker (${r.msg}) — checking what it holds before anything else`); return false;
}

async function resolvePending(s, log) {
  const pd = s.pending; if (!pd) return;
  let o = null;
  try { const g = await io().trade(`/orders/${pd.id}`); if (ok2(g) && g.body && g.body.id) o = g.body; } catch (_) {}
  if (!o) return;
  if (o.status === "filled" && +o.filled_avg_price > 0) {
    if (pd.kind === "in") { applyEntry(s, pd.dir, +o.filled_qty || pd.qty, +o.filled_avg_price, pd.ref, pd.m); log("trade", `[QMOM] entry filled late: ${pd.dir > 0 ? "LONG" : "SHORT"} ${s.qty} @ $${s.entryPx.toFixed(2)}`); }
    else { const t = applyExit(s, +o.filled_avg_price, pd.ref, pd.m, pd.reason); log("trade", `[QMOM] exit filled late @ $${t.exitPx.toFixed(2)} ${money(t.pnl)}`); }
    s.pending = null;
  } else if (TERMINAL.includes(o.status)) {
    log("error", `[QMOM] ${pd.kind === "in" ? "entry" : "exit"} order ${o.status}${+o.filled_qty > 0 ? ` after ${o.filled_qty} filled — the book is rebuilt from the broker before the next order` : ""}`);
    if (pd.kind === "out") s.outTry = (s.outTry || 0) + 1;
    s.pending = null; _seq++;
  }
}

// an order whose answer never arrived: find it by its id. Found -> handled like any pending order. Not there -> nothing happened.
async function resolveVerify(s, now, log) {
  const v = s.verify; if (!v) return;
  let g = null;
  try { g = await byClientId(v.cid); } catch (_) { g = null; }
  if (ok2(g) && g.body && g.body.id) {
    s.pending = { id: g.body.id, kind: v.kind, dir: v.dir, qty: v.qty, ref: v.ref, m: v.m, reason: v.reason }; s.verify = null;
    await resolvePending(s, log); return;
  }
  if (g && g.status === 404) { s.verify = null; _seq++; log("warn", `[QMOM] the ${v.kind === "in" ? "entry" : "exit"} order never reached the broker — nothing to undo`); return; }
  if (now - v.at > 10 * 60000) {
    s.verify = null; _seq++; s.halt = "broker unreachable for 10 minutes after an order";
    log("error", `[QMOM] could not confirm the ${v.kind === "in" ? "entry" : "exit"} order for 10 minutes — no more checks today; the broker's position is compared with the book again at the close`);
  }
}

// what this sleeve's own orders did today, from the broker's order record (carried-position closes excluded)
async function ownFillsToday(day) {
  try {
    const r = await io().trade(`/orders?status=closed&symbols=${CFG.TICKER}&after=${day}T04:00:00Z&limit=500&direction=asc`);
    if (!ok2(r) || !Array.isArray(r.body)) return null;
    const pre = `qm-${day.replace(/-/g, "")}-`;
    const fills = r.body.filter(o => o && typeof o.client_order_id === "string" && o.client_order_id.startsWith(pre) && !/-carry\d*$/.test(o.client_order_id) && +o.filled_qty > 0 && +o.filled_avg_price > 0)
      .map((o, i) => ({ signed: (o.side === "buy" ? 1 : -1) * +o.filled_qty, px: +o.filled_avg_price, at: Date.parse(o.filled_at || o.updated_at || o.submitted_at || "") || 0, i }))
      .sort((a, b) => a.at - b.at || a.i - b.i);
    return { net: fills.reduce((a, f) => a + f.signed, 0), fills };
  } catch (_) { return null; }
}

// The sleeve's book must match the broker before it trades.
//   "ok"       they agree            "unread"   the position read failed (don't block on it)
//   "rebuilt"  they differed by exactly what today's own filled orders explain -> the book now follows the broker
//   "wait"     they differ and the order record could not be read -> send nothing now, look again
//   "mismatch" shares this sleeve cannot account for -> stopped for the day, nothing touched
async function bookState(s, log, m) {
  if (s.mode !== "live") return "ok";
  const q = await brokerQty();
  if (q == null) return "unread";
  const want = s.pos * s.qty;
  if (q === want) return "ok";
  const own = s.carry ? { net: NaN, fills: [] } : await ownFillsToday(s.day);
  if (!own) return "wait";
  if (own.net === q) {
    const last = own.fills[own.fills.length - 1];
    if (s.pos) {                                              // an exit the book never recorded
      const closing = [...own.fills].reverse().find(f => Math.sign(f.signed) === -s.pos) || last;
      applyExit(s, closing ? closing.px : s.entryPx, null, m, "recovered from the broker's record");
    }
    if (q !== 0 && last) applyEntry(s, Math.sign(q), Math.abs(q), last.px, null, m);
    log("warn", `[QMOM] book rebuilt from the broker's record of this sleeve's orders: now ${q === 0 ? "flat" : `${q > 0 ? "long" : "short"} ${Math.abs(q)} @ $${last.px.toFixed(2)}`} (was ${want === 0 ? "flat" : want})`);
    return "rebuilt";
  }
  s.halt = `position mismatch: broker ${q}, sleeve ${want}`;
  log("error", `[QMOM] ${CFG.TICKER} shares at the broker (${q}) do not match the sleeve's book (${want}) and are not explained by its own orders today — sleeve stopped for the day; nothing was sent. Check Alpaca.`);
  if (q === 0 && want !== 0) { s.pos = 0; s.qty = 0; s.entryPx = null; _seq++; }   // the position is gone; don't try to close what isn't there
  return "mismatch";
}

// ───────────────────────── the day ─────────────────────────
async function prepare(s, now, log) {
  const p = etParts(now);
  const bars = await fetchBars(new Date(now - 34 * 864e5).toISOString(), new Date(now).toISOString());
  const today = buildDay(bars, p.day);
  if (!today || today.bars[0].m > 575) { if (p.min > 590) { s.skip = "no opening bar by 9:50 (the test skipped gappy opens)"; log("warn", `[QMOM] ${s.skip}`); } return; }
  const prior = FB.groupDays(bars.filter(b => FB.etParts(b.t).day < p.day));
  const sig = noiseMap(prior);
  // prior close = the previous session's last regular-hours bar (a half day included)
  let prevDay = null, prevClose = null;
  for (const b of bars) { const q = FB.etParts(b.t); if (q.day < p.day && q.m >= 570 && q.m < 960 && (!prevDay || q.day >= prevDay)) { prevDay = q.day; prevClose = +b.c; } }
  const usable = CHECKS.filter(m => sig[m] != null).length;
  if (!(prevClose > 0) || !usable) { s.skip = `not enough history (${prior.length} full sessions; need ${CFG.LOOKBACK})`; log("warn", `[QMOM] ${s.skip} — not trading today`); return; }
  s.sig = sig; s.open = today.open; s.prevClose = prevClose; s.ready = true;
  log("scan", `[QMOM] ${p.day} ready (${s.mode.toUpperCase()}): open $${s.open.toFixed(2)}, prior close $${prevClose.toFixed(2)}; noise at 10:00 ${(sig[600] * 100).toFixed(2)}%, at 15:30 ${(sig[930] * 100).toFixed(2)}% (${prior.slice(-CFG.LOOKBACK).length} sessions)`);
}

async function runCheck(s, m, now, state, log) {
  const p = etParts(now);
  const bars = await fetchBars(`${s.day}T09:00:00Z`, new Date(now).toISOString());
  const today = buildDay(bars, s.day);
  const b = today && FB.pxAt(today, m);
  // wait for the bar that ends exactly at m; after 90 s take what the test would have taken (the last bar before m)
  if (!b || (b.m + 5 !== m && p.min < m + 1.5)) return false;
  const sg = s.sig[m];
  if (sg == null) { s.done[m] = "no band"; return true; }
  const up = Math.max(s.open, s.prevClose), dn = Math.min(s.open, s.prevClose);
  const UB = up * (1 + sg), LB = dn * (1 - sg);
  const a = stepRule(s.pos, b.c, b.vwap, UB, LB, m);
  const row = { m, c: b.c, vwap: +b.vwap.toFixed(3), UB: +UB.toFixed(3), LB: +LB.toFixed(3), pos: s.pos, act: "" };
  if (a.exit || a.enter) {
    const bs = await bookState(s, log, m);
    if (bs === "wait") return false;                            // look again next tick (the check lapses after WINDOW_MIN)
    if (bs === "mismatch") { row.act = "halted"; s.checks.push(row); s.done[m] = "halt"; return true; }
    if (bs === "rebuilt") { row.act = "recovered"; row.pos = s.pos; s.checks.push(row); s.done[m] = "recovered"; return true; }   // this check's orders were already at the broker
  }
  let fine = true;
  if (a.exit) { fine = await act(s, "out", 0, b.c, m, state, log, s.pos > 0 ? "below band/VWAP" : "above band/VWAP"); row.act = "exit"; }
  if (fine && a.enter && !s.halt) { fine = await act(s, "in", a.enter, b.c, m, state, log); row.act += (row.act ? "+" : "") + (a.enter > 0 ? "long" : "short"); }
  if (!row.act) log("scan", `[QMOM] ${hhmm(m)} check: $${b.c.toFixed(2)} vs band $${LB.toFixed(2)}–$${UB.toFixed(2)}, VWAP $${b.vwap.toFixed(2)} — ${s.pos ? "hold " + (s.pos > 0 ? "long" : "short") : "inside, flat"}`);
  s.checks.push(row); s.done[m] = true;
  return true;
}

async function closeOut(s, now, state, log) {
  const mClose = 960 - CFG.EXIT_BEFORE_CLOSE_MIN;
  if (s.mode === "live") {                                       // also when the book is flat: shares its own orders bought but the book lost
    const bs = await bookState(s, log, mClose);
    if (bs === "wait") return;
    if (bs === "mismatch") { s.closed = true; return; }
  }
  if (s.pos) {
    if ((s.outTry || 0) >= 4) { log("error", `[QMOM] the closing order was refused ${s.outTry} times — ${s.qty} ${CFG.TICKER} ${s.pos > 0 ? "long" : "short"} is still open. Close it in Alpaca.`); s.closed = true; return; }
    let ref = s.entryPx;
    try { const bars = await fetchBars(`${s.day}T09:00:00Z`, new Date(now).toISOString()); const d = buildDay(bars, s.day); if (d) ref = d.close; } catch (_) {}
    s.halt = null;                                              // a failed earlier exit is retried here
    await act(s, "out", 0, ref, mClose, state, log, "close");
    if (s.pos) return;                                          // still open (pending / failed): try again next tick
  }
  s.closed = true;
}

function summarize(s) {
  const pnl = s.trades.reduce((a, t) => a + t.pnl, 0);
  const liveBp = s.trades.reduce((a, t) => a + t.retBp, 0);
  const both = s.trades.filter(t => t.refBp != null);          // a trade rebuilt from the broker's record has no bar price
  const costSum = both.reduce((a, t) => a + (t.refBp - t.retBp), 0);
  return { n: s.trades.length, pnl: +pnl.toFixed(2), liveBp: +liveBp.toFixed(2), refBp: +both.reduce((a, t) => a + t.refBp, 0).toFixed(2),
           costN: both.length, costSum: +costSum.toFixed(2), costBp: both.length ? +(costSum / both.length).toFixed(2) : null };
}
async function finalize(s, now, state, log) {
  try {
    const bars = await fetchBars(`${s.day}T09:00:00Z`, new Date(now).toISOString());
    const d = buildDay(bars, s.day);
    if (d && s.sig && s.prevClose > 0) {
      const r = replayDay(d, s.sig, s.prevClose);
      s.ideal = { n: r.trades.length, grossBp: +(r.gross * 1e4).toFixed(2), netBp: +(r.ret * 1e4).toFixed(2),
                  trades: r.trades.map(t => ({ dir: t.dir, from: t.from, to: t.to, e0: t.e0, e1: t.e1, bp: +(t.r * 1e4).toFixed(2) })) };
    }
  } catch (e) { log("warn", `[QMOM] replay failed: ${e.message}`); }
  s.final = true;
  const sm = summarize(s);
  recordHistory(state, s, sm);
  log("scan", `[QMOM] ${s.day} done (${s.mode}): ${sm.n} trade(s) ${money(sm.pnl)} (${bp(sm.liveBp)} on the position)${s.ideal ? `; tested rule at bar prices ${bp(s.ideal.grossBp)} gross, ${bp(s.ideal.netBp)} net` : ""}`);
}
function recordHistory(state, s, sm) {
  const h = state._qmomHist || (state._qmomHist = { days: [] });
  h.days = h.days.filter(d => d.day !== s.day);
  h.days.push({ day: s.day, mode: s.mode, n: sm.n, pnl: sm.pnl, liveBp: sm.liveBp, refBp: sm.refBp, costN: sm.costN, costSum: sm.costSum,
                idealNetBp: s.ideal ? s.ideal.netBp : null, idealN: s.ideal ? s.ideal.n : null, skip: s.skip || null,
                notional: Math.max(0, ...s.trades.map(t => t.qty * t.entryPx)) || 0 });
  while (h.days.length > CFG.HIST_DAYS) h.days.shift();
}
function totals(hist) {
  const days = ((hist && hist.days) || []).filter(d => !d.skip);
  let pnl = 0, n = 0, liveBp = 0, costN = 0, costSum = 0, idealNet = 0, peak = 0, dd = 0, maxNotional = 0;
  for (const d of days) { pnl += d.pnl; n += d.n; liveBp += d.liveBp; costN += d.costN || 0; costSum += d.costSum || 0; idealNet += d.idealNetBp || 0; maxNotional = Math.max(maxNotional, d.notional || 0); peak = Math.max(peak, pnl); dd = Math.min(dd, pnl - peak); }
  return { days: days.length, trades: n, pnl: +pnl.toFixed(2), liveBp: +liveBp.toFixed(1), idealNetBp: +idealNet.toFixed(1),
           costBp: costN ? +(costSum / costN).toFixed(2) : null, costTrades: costN, drawdown: +dd.toFixed(2), ddPct: maxNotional > 0 ? +(dd / maxNotional * 100).toFixed(2) : 0 };
}

let _busy = false;
async function tick(deps) {
  if (!CFG.ENABLED || _busy) return;
  const { state, logEvent: log } = deps;
  const markDirty = deps.markDirty || (() => {});
  const save = async () => { markDirty(); if (deps.saveNow) { try { await deps.saveNow(); } catch (_) {} } };
  const now = deps.now ? deps.now() : Date.now();
  const p = etParts(now);
  if (p.dow === 0 || p.dow === 6) return;
  _busy = true;
  try {
    let s = state._qmom;
    if (!s || s.day !== p.day) {
      if (p.min < 9 * 60) return;                              // roll at 9:00 ET
      const carry = s && s.mode === "live" && s.pos ? { dir: s.pos, qty: s.qty, from: s.day } : null;
      s = state._qmom = freshDay(p.day);
      if (carry) { s.carry = carry; log("error", `[QMOM] ${carry.qty} ${CFG.TICKER} ${carry.dir > 0 ? "long" : "short"} still open from ${carry.from} — closing at the open`); }
      const sm = TT.sessionMinutes(p.day);
      if (sm !== 390) { s.skip = sm === 0 ? "market closed" : "early close — not traded (the 10-year test skipped half days)"; log("scan", `[QMOM] ${p.day}: ${s.skip}`); }
      await save();
    }
    if (s.carry && p.min >= 570.5 && TT.sessionMinutes(p.day) > 0) {
      const q = await brokerQty();
      if (q != null && q !== 0 && Math.sign(q) === s.carry.dir && (s.carry.tries || 0) < 5 && now - (s.carry.lastAt || 0) > 30000) {
        s.carry.tries = (s.carry.tries || 0) + 1; s.carry.lastAt = now;
        const r = await sendMarket(q > 0 ? "sell" : "buy", Math.abs(q), cid(p.day, 570, "carry" + (s.carry.tries > 1 ? s.carry.tries : "")));
        landed();
        log(r.ok ? "trade" : "error", `[QMOM] carried position ${r.ok ? `closed @ $${r.px.toFixed(2)}` : `close failed (try ${s.carry.tries} of 5): ${r.msg}${s.carry.tries >= 5 ? " — giving up; close it in Alpaca. The sleeve does not trade while it is open." : ""}`}`);
        if (r.ok) s.carry = null;
        await save();
      } else if (q === 0) { s.carry = null; await save(); }
    }
    if (s.skip || s.final) return;
    if (s.verify) { await resolveVerify(s, now, log); await save(); if (s.verify) return; }
    if (s.pending) { await resolvePending(s, log); await save(); if (s.pending) return; }

    if (!s.ready) {
      if (p.min >= 576 && p.min < CFG.LAST_CHECK && now - (s.prepFailAt || 0) > 60000) {
        try { await prepare(s, now, log); } catch (e) { s.prepFailAt = now; log("warn", `[QMOM] could not load bars (${e.message}) — retrying in 60 s`); }
        await save();
      }
      if (!s.ready) { if (p.min >= 961 && !s.skip) { s.skip = "never became ready"; await save(); } return; }
    }

    if (!s.halt && !s.closed) {
      const due = CHECKS.filter(m => !s.done[m] && p.min >= m + CFG.GRACE_MIN && p.min < m + CFG.WINDOW_MIN).pop();
      for (const m of CHECKS) if (!s.done[m] && p.min >= m + CFG.WINDOW_MIN) { s.done[m] = "missed"; log("warn", `[QMOM] ${hhmm(m)} check missed (bot busy or down)`); }
      if (due != null) { try { if (await runCheck(s, due, now, state, log)) await save(); } catch (e) { log("warn", `[QMOM] ${hhmm(due)} check failed: ${e.message}`); } }
    }

    if (!s.closed && p.min >= 960 - CFG.EXIT_BEFORE_CLOSE_MIN && p.min < 960) { await closeOut(s, now, state, log); await save(); }
    if (!s.final && p.min >= 961) {
      if (s.pos && s.mode === "live") log("error", `[QMOM] ${s.qty} ${CFG.TICKER} ${s.pos > 0 ? "long" : "short"} still open after the close — will be closed at the next open`);
      await finalize(s, now, state, log); await save();
    }
  } finally { _busy = false; }
}

// emergency: close the sleeve's shares now
async function flattenAll(state, log, why = "emergency") {
  const s = state && state._qmom;
  if (!s || s.mode !== "live" || !s.pos) return 0;
  const m = Math.round(etParts().min), id = cid(s.day, m, "flat");
  const r = await sendMarket(s.pos > 0 ? "sell" : "buy", s.qty, id);
  s.halt = why;                                                // no more checks today either way
  if (r.ok) { applyExit(s, r.px, r.px, m, why); landed(); log("circuit", `[QMOM] ${why}: closed @ $${r.px.toFixed(2)}`); return 1; }
  if (r.pending) s.pending = { id: r.id, kind: "out", ref: s.entryPx, m, reason: why };
  else if (!r.definite) s.verify = { at: Date.now(), cid: id, kind: "out", ref: s.entryPx, m, reason: why };
  landed();
  log("error", `[QMOM] ${why}: close ${r.pending ? "not filled yet — still checking" : `failed (${r.msg})`}`); return 0;
}

// ───────────────────────── reporting ─────────────────────────
const CSV_HEAD = "day,mode,ticker,dir,qty,entryET,exitET,entryPx,exitPx,barEntry,barExit,pnl,liveBp,barBp,costBp,reason";
function eodCSV(s) {
  if (!s) return "";
  const L = [CSV_HEAD];
  for (const t of s.trades || []) L.push([s.day, s.mode, s.ticker, t.dir > 0 ? "long" : "short", t.qty, hhmm(t.entryM), hhmm(t.exitM), t.entryPx, t.exitPx, t.entryRef, t.exitRef,
    t.pnl, t.retBp, t.refBp, t.refBp != null ? +(t.refBp - t.retBp).toFixed(2) : "", `"${t.reason}"`].join(","));
  return L.join("\n");
}
function eodSection(s, hist) {
  if (!s) return "";
  const f = "font-family:system-ui,sans-serif", td = "padding:2px 10px;text-align:right";
  let h = `<h3 style="${f};margin:18px 0 6px">QQQ intraday momentum — shares (${s.mode === "live" ? "live on paper" : "shadow"})</h3>`;
  if (s.skip) h += `<div style="${f};font-size:12px">Not traded today: ${s.skip}.</div>`;
  else {
    const sm = summarize(s);
    h += `<div style="${f};font-size:12px;margin-bottom:4px">Today: ${sm.n} trade(s), <b>${money(sm.pnl)}</b> (${bp(sm.liveBp)} on the position).`
       + (s.ideal ? ` The tested rule at bar prices: ${s.ideal.n} trade(s), ${bp(s.ideal.grossBp)} before costs, ${bp(s.ideal.netBp)} after 1 bp a side.` : "")
       + (s.halt ? ` <b style="color:#c62828">Stopped: ${s.halt}.</b>` : "") + `</div>`;
    if (sm.n) {
      h += `<table style="${f};font-size:12px;border-collapse:collapse"><tr style="color:#888"><td>side</td><td style="${td}">shares</td><td style="${td}">in</td><td style="${td}">out</td><td style="${td}">fill in / out</td><td style="${td}">bar in / out</td><td style="${td}">P&amp;L</td><td style="${td}">cost vs bar</td><td style="${td}">exit</td></tr>`;
      for (const t of s.trades) h += `<tr><td>${t.dir > 0 ? "long" : "short"}</td><td style="${td}">${t.qty}</td><td style="${td}">${hhmm(t.entryM)}</td><td style="${td}">${hhmm(t.exitM)}</td><td style="${td}">$${t.entryPx.toFixed(2)} / $${t.exitPx.toFixed(2)}</td><td style="${td}">${t.entryRef > 0 ? "$" + (+t.entryRef).toFixed(2) : "—"} / ${t.exitRef > 0 ? "$" + (+t.exitRef).toFixed(2) : "—"}</td><td style="${td}">${money(t.pnl)}</td><td style="${td}">${t.refBp != null ? bp(t.refBp - t.retBp) : "—"}</td><td style="${td}">${t.reason}</td></tr>`;
      h += `</table>`;
    }
  }
  const T = totals(hist);
  if (T.days) {
    h += `<div style="${f};font-size:12px;margin-top:8px">Running (${T.days} traded day(s), ${T.trades} trades): <b>${money(T.pnl)}</b>; live ${bp(T.liveBp)} vs the tested rule ${bp(T.idealNetBp)} net; `
       + `cost per trade vs bar price ${T.costBp != null ? bp(T.costBp) : "—"}; deepest drawdown ${money(T.drawdown)} (${T.ddPct}% of the position size).</div>`;
    h += `<div style="${f};font-size:11px;color:#888;margin-top:3px">Lines set 11/25 before the first trade: stop and fix if cost per trade is above ${CFG.KILL_COST_BP} bp after ${CFG.KILL_COST_TRADES} trades (the test assumed 2 bp); `
       + `to shadow if the drawdown passes ${CFG.KILL_DD_PCT}% of the position size. The 10-year test averaged about +3 bp a day with a daily swing near 50 bp, so a year of live days is needed to judge the return itself.</div>`;
  }
  return h;
}

module.exports = { CFG, CHECKS, tick, flattenAll, cashAdjustment, openNotional, isQmomOrder, eodCSV, eodSection, totals, inFlight, flightSeq, dayPnL,
  _t: { setIO: (x) => { _io = x; }, buildDay, noiseMap, stepRule, replayDay, freshDay, etParts, summarize, recordHistory, sendMarket, runCheck, prepare, closeOut, bookState, ownFillsToday,
        setFlight: (ms) => { _flightAt = ms; },
        setBusy: (v) => { _busy = v; } } };
