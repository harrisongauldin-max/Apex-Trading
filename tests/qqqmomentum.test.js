// 11/25 (Harrison): QQQ intraday momentum on shares — the live sleeve must make the SAME decisions as the rule that passed the
// 10-year test (flowBacktest T2), send safe market orders, stay out on holidays / half days, and keep its shares out of the
// options book. Also in this batch: no option entries on a holiday or early-close day, and the 40310000 close no longer jams.
"use strict";
const H = require("./helpers"); H.quiet();
const Q = require(H.R("qqqMomentum.js"));
const FB = require(H.R("flowBacktest.js"));
const TT = require(H.R("tradingTime.js"));
const C = require(H.R("constants.js"));
const T = Q._t;
Q.CFG._pollMs = 0;

// ── synthetic 5-minute bars ──
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / Math.sqrt(0.5); };
const iso = (day, m, off) => new Date(Date.parse(`${day}T00:00:00Z`) + (m + off * 60) * 60000).toISOString();
function walkDay(day, off, open, sd, endAt) {   // 78 bars 9:30..15:55
  const out = []; let px = open;
  for (let i = 0; i < 78; i++) {
    const o = px; px = px * (1 + gauss() * sd); if (endAt != null && i === 77) px = endAt;
    out.push({ t: iso(day, 570 + i * 5, off), o, h: Math.max(o, px) * 1.0002, l: Math.min(o, px) * 0.9998, c: px, v: 1000 + Math.floor(rnd() * 500) });
  }
  return out;
}
const weekdays = (from, n) => { const out = []; let d = Date.parse(from + "T12:00:00Z"); while (out.length < n) { const dt = new Date(d); if (dt.getUTCDay() % 6 !== 0) out.push(dt.toISOString().slice(0, 10)); d += 864e5; } return out; };

// 1. the live rule == the tested rule, trade for trade, on 40 random days (June-July, EDT)
{
  let bars = [], px = 500;
  for (const day of weekdays("2026-06-01", 40)) { const b = walkDay(day, 4, px * (1 + gauss() * 0.004), 0.0012); bars.push(...b); px = b[b.length - 1].c; }
  const days = FB.groupDays(bars);
  let nT = 0, same = true, checked = 0, detail = "";
  for (let i = 14; i < days.length; i++) {
    const ref = FB.t2Day(days, i); if (!ref) continue;
    const mine = T.replayDay(days[i], T.noiseMap(days.slice(0, i)), days[i].prevClose);
    checked++; nT += ref.trades.length;
    if (mine.trades.length !== ref.trades.length || Math.abs(mine.ret - ref.ret) > 1e-12) { same = false; detail = `${days[i].date}: ${mine.trades.length} vs ${ref.trades.length}`; }
    ref.trades.forEach((t, k) => { const u = mine.trades[k]; if (!u || u.dir !== t.dir || u.from !== t.from || u.to !== t.to || u.e0 !== t.e0 || u.e1 !== t.e1) { same = false; detail = `${days[i].date} trade ${k}`; } });
  }
  H.ok(checked === 26 && nT >= 15 && same, `the sleeve's rule reproduces flowBacktest.t2Day exactly (${checked} days, ${nT} trades: direction, times, prices, net return)`, detail);
  // buildDay == groupDays' day object for a full session
  const d0 = days[20], mineDay = T.buildDay(bars, d0.date);
  H.ok(mineDay.open === d0.open && mineDay.close === d0.close && mineDay.bars.length === d0.bars.length && mineDay.bars.every((b, k) => b.vwap === d0.bars[k].vwap), "today's bars are built the way the test built them (open, close, running VWAP)");
  H.ok(T.noiseMap(days.slice(0, 13))[600] === null && T.noiseMap(days.slice(0, 14))[600] > 0, "noise needs 14 full prior sessions (as the test: day 15 on)");
}
// 2. the decision at one check
H.ok(JSON.stringify(T.stepRule(0, 101, 100.5, 100.3, 99.7, 600)) === '{"exit":false,"enter":1}' && T.stepRule(0, 99.5, 100, 100.3, 99.7, 600).enter === -1 && T.stepRule(0, 100, 100, 100.3, 99.7, 600).enter === 0, "flat: above the band -> long, below -> short, inside -> nothing");
H.ok(T.stepRule(1, 100.4, 100.6, 100.3, 99.7, 780).exit === true && T.stepRule(1, 100.7, 100.6, 100.3, 99.7, 780).exit === false && T.stepRule(-1, 99.8, 99.5, 100.3, 99.7, 780).exit === true, "long exits on a close below max(band, VWAP); short on a close above min(band, VWAP)");
H.ok(T.stepRule(0, 101, 100, 100.3, 99.7, 930).enter === 0 && T.stepRule(1, 99, 100, 100.3, 99.7, 720).enter === -1, "no new entry at 15:30; an exit can flip straight to the other side (as tested)");
H.ok(Q.CHECKS.length === 12 && Q.CHECKS[0] === 600 && Q.CHECKS[11] === 930, "12 checks, 10:00 ... 15:30 ET");
H.ok(C.QMOM_MODE === "live" && C.QMOM_TICKER === "QQQ" && C.QMOM_NOTIONAL_PCT === 0.5 && Q.CFG.NOTIONAL_PCT === 0.5, "ships live on paper, QQQ, 50% of equity per position");

// ── a full live day against a fake broker (Mon 11/23/2026, EST) ──
const DAY = "2026-11-23", OFF = 5;
function scenario() {
  seed = 777; const hist = [];
  for (const d of weekdays("2026-11-02", 15)) hist.push(...walkDay(d, OFF, 100, 0.0005, 100));   // 15 full sessions, each closing at 100
  const path = (m) => m < 600 ? 100 + 0.8 * (m - 565) / 30 : m < 775 ? 100.8 + 0.4 * (m - 600) / 175 : m < 810 ? 100.05 : m < 835 ? 99.95 : m < 900 ? 99.0 : 98.8;
  const today = []; for (let i = 0; i < 78; i++) { const m = 570 + i * 5, o = i ? path(m - 5 + 5 * 0) : 100, c = path(m + 5); today.push({ t: iso(DAY, m, OFF), o: i ? today[i - 1].c : 100, h: Math.max(i ? today[i - 1].c : 100, c) + 0.01, l: Math.min(i ? today[i - 1].c : 100, c) - 0.01, c, v: 1000 }); }
  return { hist, today };
}
function fakeBroker(sc, opt = {}) {
  const B = { pos: opt.pos || 0, orders: {}, posts: [], now: 0, equity: 80000, lists: 0, down: false };
  const barsUpTo = (endMs, startMs) => [...sc.hist, ...sc.today].filter(b => { const t = Date.parse(b.t); return t >= startMs && t + 300000 <= endMs + (opt.partial ? 300000 : 0); });
  const lastPx = () => { const done = sc.today.filter(b => Date.parse(b.t) + 300000 <= B.now); return done.length ? done[done.length - 1].c : 100; };
  B.io = {
    data: async (p) => { const q = new URL("http://x" + p).searchParams; return { status: 200, body: { bars: barsUpTo(Date.parse(q.get("end")), Date.parse(q.get("start"))) } }; },
    trade: async (p) => {
      if (B.down) throw new Error("ETIMEDOUT");
      if (p === "/account") return { status: 200, body: { equity: String(B.equity) } };
      if (p.startsWith("/positions/")) return B.pos ? { status: 200, body: { qty: String(B.pos), side: B.pos > 0 ? "long" : "short" } } : { status: 404, body: {} };
      if (p.startsWith("/orders:by_client_order_id")) { const id = new URL("http://x" + p).searchParams.get("client_order_id"); const o = Object.values(B.orders).find(x => x.client_order_id === id); return o ? { status: 200, body: o } : { status: 404, body: {} }; }
      if (p.startsWith("/orders?")) { B.lists++; return opt.noList ? { status: 500, body: {} } : { status: 200, body: Object.values(B.orders) }; }
      if (p.startsWith("/orders/")) { const o = B.orders[p.split("/")[2]]; return o ? { status: 200, body: o } : { status: 404, body: {} }; }
      return { status: 404, body: {} };
    },
    post: async (p, b) => {
      B.posts.push(b);
      if (Object.values(B.orders).some(x => x.client_order_id === b.client_order_id)) return { status: 422, body: { message: "client_order_id must be unique" } };
      if (opt.rejectAll) return { status: 403, body: { message: "insufficient buying power" } };
      const px = +(lastPx() + (b.side === "buy" ? 0.01 : -0.01)).toFixed(2), id = "o" + (Object.keys(B.orders).length + 1);
      const o = { id, client_order_id: b.client_order_id, status: "filled", filled_avg_price: String(px), filled_qty: b.qty, side: b.side };
      B.orders[id] = o; B.pos += (b.side === "buy" ? 1 : -1) * +b.qty;
      if (opt.dropResponse && B.posts.length === 1) throw new Error("socket hang up");
      if (opt.darkAfterPost && B.posts.length === opt.darkAfterPost) { B.down = true; throw new Error("socket hang up"); }
      return { status: 200, body: o };
    },
  };
  return B;
}
const at = (m, day = DAY) => Date.parse(`${day}T00:00:00Z`) + (m + OFF * 60) * 60000;
async function runDay(B, state, mode = "live", times = null) {
  Q.CFG.MODE = mode; T.setIO(B.io); const LOG = [];
  const deps = { state, logEvent: (lvl, msg) => LOG.push(`${lvl}|${msg}`), markDirty: () => {}, now: () => B.now };
  for (const m of times || [540, 576.5, ...Q.CHECKS.map(x => x + 0.5), 958.2, 961.5]) { B.now = at(m); await Q.tick(deps); }
  return LOG;
}

(async () => {
  // 3. the day: long at 10:00, out at 13:00, short at 14:00, covered at 15:58
  {
    const sc = scenario(), B = fakeBroker(sc), state = {};
    const LOG = await runDay(B, state);
    const s = state._qmom, tr = s.trades;
    H.ok(s.ready && !s.skip && !s.halt && s.final && s.closed && s.pos === 0 && B.pos === 0, "day runs to the end flat, at the broker too", JSON.stringify([s.ready, s.skip, s.halt, s.final, s.closed, s.pos, B.pos]));
    H.ok(B.posts.length === 4 && B.posts.map(p => p.side).join(",") === "buy,sell,sell,buy" && B.posts.every(p => p.type === "market" && p.time_in_force === "day" && p.symbol === "QQQ"), "four market orders: buy, sell, sell short, buy to cover", B.posts.map(p => p.side + ":" + p.client_order_id).join(" "));
    H.ok(B.posts[0].client_order_id === "qm-20261123-600-in" && B.posts[1].client_order_id === "qm-20261123-780-out" && B.posts[2].client_order_id === "qm-20261123-840-in" && B.posts[3].client_order_id === "qm-20261123-958-out", "fixed client id per day / check / leg");
    const qty = Math.floor(0.5 * 80000 / 100.8);
    H.ok(+B.posts[0].qty === qty && tr.length === 2 && tr[0].dir === 1 && tr[0].entryM === 600 && tr[0].exitM === 780 && tr[1].dir === -1 && tr[1].entryM === 840 && tr[1].exitM === 958, `size = 50% of equity / price (${qty} shares); long 10:00-13:00, short 14:00-15:58`, JSON.stringify(tr.map(t => [t.dir, t.entryM, t.exitM, t.qty])));
    H.ok(tr[0].entryPx === 100.81 && tr[0].exitPx === 100.04 && Math.abs(tr[0].pnl - qty * (100.04 - 100.81)) < 0.01 && tr[1].pnl > 0 && tr[0].entryRef === 100.8 && tr[0].exitRef === 100.05, "P&L from the actual fills; the bar price is kept beside each fill");
    H.ok(s.ideal && s.ideal.n === 2 && s.ideal.trades[0].from === 600 && s.ideal.trades[0].to === 780 && s.ideal.trades[1].from === 840 && s.ideal.trades[1].to === 960 && Math.abs(s.ideal.netBp - (s.ideal.grossBp - 4)) < 0.01, "after the close the tested rule is replayed at bar prices (net of 1 bp a side)", JSON.stringify(s.ideal));
    H.ok(state._qmomHist.days.length === 1 && state._qmomHist.days[0].n === 2 && Q.totals(state._qmomHist).trades === 2 && Q.totals(state._qmomHist).costBp > 0, "running history: day recorded, cost per trade vs bar price is positive (we pay the spread)");
    H.ok(LOG.some(l => /\[QMOM\] 2026-11-23 ready \(LIVE\)/.test(l)) && LOG.some(l => /\[QMOM\] LONG \d+ QQQ @ \$100\.81 \(bar \$100\.80\) at 10:00/.test(l)) && LOG.some(l => /10:30 check: .* hold long/.test(l)), "log: ready line, the entry with fill and bar price, and a line per quiet check");
    const html = Q.eodSection(s, state._qmomHist), csv = Q.eodCSV(s).split("\n");
    H.ok(/QQQ intraday momentum — shares \(live on paper\)/.test(html) && /Running \(1 traded day/.test(html) && /Lines set 11\/25/.test(html) && csv.length === 3 && /^2026-11-23,live,QQQ,long,/.test(csv[1]) && /,short,/.test(csv[2]), "EOD section + CSV (one row per trade)");
  }
  // 4. while long, the shares are backed out of the options book's cash
  {
    const sc = scenario(), B = fakeBroker(sc), state = {};
    await runDay(B, state, "live", [540, 576.5, 600.5, 630.5]);
    const q = state._qmom.qty;
    H.ok(state._qmom.pos === 1 && Q.cashAdjustment(state) === +(q * 100.81).toFixed(2) && Q.openNotional(state).notional === +(q * 100.81).toFixed(2), "long: cash adjustment = shares x fill (so option sizing sees the cash it would without the sleeve)");
    // crash between the fill and the save: the book is flat, the broker holds the shares. Same check runs again after the restart.
    const n = B.posts.length, L4 = []; state._qmom.done[600] = undefined; state._qmom.pos = 0; state._qmom.qty = 0; state._qmom.entryPx = null;
    B.now = at(601); await Q.tick({ state, logEvent: (l, m) => L4.push(m), markDirty: () => {}, now: () => B.now });
    H.ok(B.posts.length === n && Object.keys(B.orders).length === 1 && state._qmom.pos === 1 && state._qmom.qty === q && state._qmom.entryPx === 100.81 && !state._qmom.halt && state._qmom.done[600] === "recovered" && L4.some(m => /book rebuilt from the broker's record/.test(m)),
      "fill the book lost (restart): rebuilt from the broker's record of the sleeve's own orders — no second order, not halted", JSON.stringify([B.posts.length - n, state._qmom.pos, state._qmom.halt, state._qmom.done[600]]));
    // and a re-sent id is adopted, never doubled (the order layer's own guard)
    state._qmom.pos = 0; state._qmom.qty = 0; const r2 = await T.sendMarket("buy", q, "qm-20261123-600-in");
    H.ok(r2.ok && r2.px === 100.81 && Object.keys(B.orders).length === 1 && B.pos === q, "a repeated order (same client id) is rejected by the broker as a duplicate and ADOPTED — one fill, not two");
  }
  // 5. the answer to an order is lost: look it up by its id before doing anything else
  {
    const sc = scenario(), B = fakeBroker(sc, { dropResponse: true }), state = {};
    await runDay(B, state, "live", [540, 576.5, 600.5]);
    H.ok(B.posts.length === 1 && state._qmom.pos === 1 && state._qmom.entryPx === 100.81 && B.pos === state._qmom.qty, "lost response: the order is found by its client id and booked once");
  }
  // 6. a rejected entry leaves no position and the day goes on; shares the sleeve does not know about stop it
  {
    const sc = scenario(), B = fakeBroker(sc, { rejectAll: true }), state = {};
    const LOG = await runDay(B, state, "live", [540, 576.5, 600.5, 630.5]);
    H.ok(state._qmom.pos === 0 && !state._qmom.halt && LOG.some(l => /ENTRY FAILED \(insufficient buying power\)/.test(l)), "rejected entry: logged, flat, not halted");
    const B2 = fakeBroker(scenario(), { pos: 50 }), st2 = {};
    const LOG2 = await runDay(B2, st2, "live", [540, 576.5, 600.5, 630.5]);
    H.ok(B2.posts.length === 0 && /position mismatch: broker 50, sleeve 0/.test(st2._qmom.halt) && LOG2.some(l => /do not match the sleeve's book/.test(l)), "50 QQQ shares the sleeve did not buy: nothing is sent, the sleeve stops for the day");
  }
  // 6b. the order is sent and the broker goes dark (no answer, lookup fails too): the outcome is unknown — nothing is re-sent
  {
    const sc = scenario(), B = fakeBroker(sc, { darkAfterPost: 1 }), state = {};
    const L = await runDay(B, state, "live", [540, 576.5, 600.5]);
    const s = state._qmom;
    H.ok(B.posts.length === 1 && s.pos === 0 && s.verify && s.verify.cid === "qm-20261123-600-in" && Q.inFlight(state) && L.some(l => /entry order: no answer from the broker/.test(l)), "unknown outcome: flagged for verification, cash readings paused (inFlight), book untouched");
    B.now = at(601); await Q.tick({ state, logEvent: () => {}, markDirty: () => {}, now: () => B.now });
    H.ok(s.verify && B.posts.length === 1, "broker still dark: still waiting, still nothing re-sent");
    B.down = false; B.now = at(601.2); await Q.tick({ state, logEvent: () => {}, markDirty: () => {}, now: () => B.now });
    H.ok(!s.verify && !s.pending && s.pos === 1 && s.entryPx === 100.81 && s.entryRef === 100.8 && s.qty === B.pos && B.posts.length === 1 && !Q.inFlight(state), "broker back: the order is found by its id and booked once, with its bar price");
    // an order that never reached the broker: nothing to undo, day goes on
    const B3 = fakeBroker(scenario()), st3 = {}; await runDay(B3, st3, "live", [540, 576.5]);
    st3._qmom.verify = { at: at(600.3), cid: "qm-20261123-600-in", kind: "in", dir: 1, qty: 10, ref: 100.8, m: 600 };
    B3.now = at(615); await Q.tick({ state: st3, logEvent: () => {}, markDirty: () => {}, now: () => B3.now });
    H.ok(!st3._qmom.verify && st3._qmom.pos === 0 && !st3._qmom.halt, "order never reached the broker (404 on its id): cleared, flat, not halted");
  }
  // 6c. a refused exit is not the end of the day: the rule is applied again at the next check, and the close re-sends under a new id
  {
    const sc = scenario(), B = fakeBroker(sc), state = {};
    await runDay(B, state, "live", [540, 576.5, 600.5]);
    const s = state._qmom, q = s.qty, post0 = B.io.post;
    let refuse = true; B.io.post = async (p, b) => { if (refuse && b.side === "sell") { B.posts.push(b); return { status: 403, body: { message: "account restricted" } }; } return post0(p, b); };
    const L = await runDay(B, state, "live", [780.5]);
    H.ok(s.pos === 1 && !s.halt && s.outTry === 1 && L.some(l => /EXIT REFUSED \(account restricted\)/.test(l)), "refused exit at 13:00: still long, not halted, counted");
    refuse = false; await runDay(B, state, "live", [810.5]);
    H.ok(s.pos === 0 && B.pos === 0 && s.trades.length === 1 && s.trades[0].exitM === 810 && B.posts[B.posts.length - 1].client_order_id === "qm-20261123-810-out1", "13:30: the rule still says out — exit sent under a new id and filled");
    void q;
  }
  // 6d. at the close a flat book is still compared with the broker: shares the sleeve's own order bought are closed, others are left
  {
    const sc = scenario(), B = fakeBroker(sc), state = {};
    await runDay(B, state, "live", [540, 576.5, 600.5]);
    const s = state._qmom, q = s.qty; s.pos = 0; s.qty = 0; s.entryPx = null; s.halt = "broker unreachable for 10 minutes after an order";
    const L = await runDay(B, state, "live", [958.2, 961.5]);
    H.ok(B.pos === 0 && s.closed && s.trades.length === 1 && s.trades[0].qty === q && s.trades[0].exitM === 958 && s.trades[0].entryRef == null && L.some(l => /book rebuilt/.test(l)), "15:58, book flat but the broker holds the sleeve's own fill: rebuilt and closed — nothing held overnight", JSON.stringify([B.pos, s.closed, s.trades.length]));
    H.ok(Q.totals(state._qmomHist).costBp === null && /—/.test(Q.eodSection(s, state._qmomHist)), "a rebuilt trade has no bar price: left out of the cost-per-trade figure, shown as —");
    const B2 = fakeBroker(scenario(), { pos: 50, noList: true }), st2 = {};
    const L2 = await runDay(B2, st2, "live", [540, 576.5, 600.5, 600.6]);
    H.ok(B2.posts.length === 0 && !st2._qmom.halt && !st2._qmom.done[600], "broker differs and the order record can't be read: nothing sent, looked at again (no halt yet)");
    void L2;
  }
  // 6e. cash-reading guard
  {
    const sc = scenario(), B = fakeBroker(sc), state = {};
    const seq0 = Q.flightSeq(); await runDay(B, state, "live", [540, 576.5, 600.5]);
    H.ok(Q.flightSeq() > seq0 && !Q.inFlight(state), "an order moves the sequence number; nothing in flight once it is booked");
    T.setFlight(Date.now()); H.ok(Q.inFlight(state), "in flight while an order's outcome is not in the book"); T.setFlight(0);
    state._qmom.pending = { id: "x" }; H.ok(Q.inFlight(state), "in flight while an order is pending"); state._qmom.pending = null;
    const pnl = Q.dayPnL(state, [{ symbol: "QQQ", unrealizedPnL: 12.34 }, { symbol: "SPY261127C00600000", unrealizedPnL: 99 }], B.now);
    H.ok(pnl.real === 0 && pnl.unreal === 12.34 && Q.dayPnL(state, [], at(600, "2026-11-24")).unreal === 0, "dayPnL: closed trades + the broker's unrealized on the QQQ shares only, today only");
  }
  // 7. shadow mode: same ledger, no orders
  {
    const sc = scenario(), B = fakeBroker(sc), state = {};
    await runDay(B, state, "shadow");
    const s = state._qmom;
    H.ok(B.posts.length === 0 && s.trades.length === 2 && s.trades[0].entryPx === 100.8 && s.trades[0].exitPx === 100.05 && Q.cashAdjustment(state) === 0 && s.mode === "shadow", "shadow: two trades booked at bar prices, zero orders, no cash adjustment");
    Q.CFG.MODE = "live";
  }
  // 8. calendar: closed Thursday 11/26, 1:00 pm close Friday 11/27 -> not traded, nothing fetched
  {
    for (const [day, re] of [["2026-11-26", /market closed/], ["2026-11-27", /early close/]]) {
      let calls = 0; T.setIO({ data: async () => { calls++; return { status: 200, body: { bars: [] } }; }, trade: async () => { calls++; return { status: 404, body: {} }; }, post: async () => { calls++; return { status: 500 }; } });
      const state = {}; const deps = { state, logEvent: () => {}, markDirty: () => {}, now: () => at(601, day) };
      await Q.tick(deps); await Q.tick(deps);
      H.ok(re.test(state._qmom.skip) && calls === 0 && /Not traded today/.test(Q.eodSection(state._qmom, null)), `${day}: ${state._qmom.skip.split(" —")[0]} — no data or order calls`);
    }
    H.ok(TT.sessionMinutes("2026-11-26") === 0 && TT.sessionMinutes("2026-11-27") === 210 && TT.sessionMinutes("2026-11-25") === 390, "calendar: 11/26 closed, 11/27 half day, 11/25 full");
  }

  // 9. wiring
  const srv = H.read("server.js"), rep = H.read("reporting.js"), ce = H.read("closeEngine.js"), ex = H.read("execution.js");
  H.ok(/if \(QMOM\.CFG\.ENABLED\) \{\s*\n\s*setInterval\(\(\) => \{ if \(isShuttingDown \|\| HANDOFF\.isHeld\(\)\) return; QMOM\.tick\(\{ state, logEvent, markDirty, saveNow: saveStateNow \}\)/.test(srv), "server.js: sleeve ticks every 5 s, paused during a deploy hand-off");
  H.ok(/require\('\.\/qqqMomentum'\)\.flattenAll\(state, logEvent, "emergency-close"\)/.test(srv), "server.js: emergency close also flattens the sleeve");
  H.ok(/_sipAdj \+= require\('\.\/qqqMomentum'\)\.cashAdjustment\(state\) \|\| 0;/.test(ce), "closeEngine.js: cash sync backs the sleeve's shares out of the options book");
  H.ok(/_qmSeq = _qm\.flightSeq\(\);[\s\S]{0,120}const acct = await alpacaGet\("\/account"\);[\s\S]{0,80}if \(_qm && \(_qm\.inFlight\(state\) \|\| _qm\.flightSeq\(\) !== _qmSeq\)\) return;/.test(ce), "closeEngine.js: a cash reading taken across a sleeve fill is skipped (sequence read before the account call, checked after)");
  H.ok(/_qmSeq0 = _qmPL\.flightSeq\(\);[\s\S]{0,200}const truth = await getAlpacaTruth\(\);[\s\S]{0,900}_qmPL\.dayPnL\(state, truth\.openPositions\)[\s\S]{0,400}observe\(state, _plTruth,/.test(srv) && /require\("\.\/qqqMomentum"\)\.dayPnL\(state, state\._alpacaTruth\.openPositions, now\)/.test(H.read("profitLock.js")), "profit-lock shadow keeps its basis: the sleeve's P&L is taken out of every reading and of the close");
  H.ok(/qmom:\s+JSON\.parse\(JSON\.stringify\(state\._qmom \|\| null\)\)/.test(rep) && /require\('\.\/qqqMomentum'\)\.eodSection\(_eodSnap\.qmom, _eodSnap\.qmomHist\)/.test(rep) && /argo-qqqmomentum-/.test(rep), "reporting.js: snapshot, EOD section and CSV attachment");
  H.ok(!/qqqMomentum/.test(H.read("scanner.js")) && !/qqqMomentum/.test(ex) && !/qqqMomentum/.test(H.read("exitEngine.js")), "the options entry / exit paths do not touch the sleeve");

  // 10. options side: no entries on a holiday or early-close day (exits untouched)
  H.ok(/const _sessMin = require\('\.\/tradingTime'\)\.sessionMinutes\(`\$\{_dX\.getFullYear\(\)\}-/.test(ex) && /if \(_sessMin !== 390 && !_dryRunMode\) \{[\s\S]{0,420}return false;/.test(ex), "execution.js: executeTrade refuses entries unless today is a full session");
  H.ok(ex.indexOf("_sessMin !== 390") < ex.indexOf("observe-only after 3:15 ET") && ex.indexOf("_sessMin !== 390") > ex.indexOf("async function executeTrade("), "the calendar check is the first thing executeTrade does");
  H.ok(!/sessionMinutes/.test(ce) && !/sessionMinutes/.test(H.read("exitEngine.js")), "close and exit code have no calendar gate (a position can always be closed)");

  // 11. the 40310000 reject no longer leaves the position un-closable
  const blk = ce.slice(ce.indexOf("if (closeResp && closeResp.code === 40310000)"), ce.indexOf("if (closeResp && closeResp.code === 40310000)") + 1100);
  H.ok(/pos\._permissionBlocked = true;[\s\S]*delete pos\._closingSubmitted;\s*\n\s*return;/.test(blk), "closeEngine.js: the 40310000 branch clears _closingSubmitted before returning");
  H.done();
})().catch(e => { console.error(e); process.exit(1); });
