// 11/02: STOCKS-IN-PLAY share sleeve (stocksInPlay.js) — paper rules, ideal replay, and a full mocked live day.
"use strict";
const H = require("./helpers"); H.quiet();
const SIP = require(H.R("stocksInPlay.js"));
const T = SIP._t;
// this file covers the plain path (entry, then stop on the fill; the paper's hold-to-close). sipexec.test.js covers OTO + lock/trail.
Object.assign(SIP.CFG, { USE_OTO: false, EXIT_MODE: "hold", STOP_BASE: "fill", HARD_CAP_R: 99, STOP_MODE: "paper" });

// ---- clock / time ----
H.ok(new Date(T.etToUtcMs("2026-11-02", 9, 30)).toISOString() === "2026-11-02T14:30:00.000Z", "9:30 ET after the DST change = 14:30Z");
H.ok(new Date(T.etToUtcMs("2026-10-30", 9, 30)).toISOString() === "2026-10-30T13:30:00.000Z", "9:30 ET before the DST change = 13:30Z");
H.ok(T.etParts(Date.parse("2026-11-02T14:35:10Z")).min.toFixed(2) === "575.17" && T.etParts(Date.parse("2026-11-02T14:35:10Z")).dow === 1, "etParts minutes + weekday");

// ---- paper rules ----
const day = (i, o, h, l, c, v) => ({ t: new Date(Date.UTC(2026, 9, 1 + i, 4)).toISOString(), o, h, l, c, v });
const bars15 = Array.from({ length: 15 }, (_, i) => day(i, 50, 51, 49, 50, 2e6));
let st = T.dailyStats(bars15);
H.ok(Math.abs(st.atr - 2) < 1e-9 && st.avgVol === 2e6 && st.prevClose === 50, "14-day ATR (true range) and average volume", JSON.stringify(st));
H.ok(T.dailyStats(bars15.slice(1)) === null, "fewer than 15 daily bars: no stats");
H.ok(T.sizePosition(40, 0.2) === 62, "size: $25k/20 = $1,250 allocation, 1% = $12.50 risk / $0.20 stop = 62 sh", String(T.sizePosition(40, 0.2)));
H.ok(T.sizePosition(40, 0.05) === 125, "size: 4x leverage cap binds ($5,000 / $40 = 125 sh, not 250)");
H.ok(T.sizePosition(40, 0) === 0 && T.sizePosition(0, 1) === 0, "size: bad inputs -> 0");

const uni = {}, first = {};
for (let i = 0; i < 30; i++) { uni["S" + String.fromCharCode(65 + i % 26) + i] = { atr: 1 + i / 10, avgVol: 2e6, ovAvg: 100000, etb: i % 2 === 0, shortable: true }; }
const syms = Object.keys(uni);
syms.forEach((s, i) => { first[s] = { o: 20, h: 20.5, l: 19.6, c: i % 5 === 0 ? 20 : i % 2 ? 20.3 : 19.8, v: 100000 * (0.5 + i * 0.2) }; });
first[syms[29]].o = 4.9;   // fails the $5 open filter
let cands = T.selectCandidates(uni, first);
H.ok(cands.length === 20 && cands[0].rvol >= cands[19].rvol && !cands.some(c => c.sym === syms[29]), "top 20 by RVol, ranked, open <= $5 excluded");
H.ok(!cands.some(c => c.rvol < 1), "RVol < 100% never selected", cands.map(c => c.rvol).join(","));
const dj = cands.find(c => c.side === "doji"), lg = cands.find(c => c.side === "long"), sh = cands.find(c => c.side === "short");
H.ok(dj && dj.entry === null && dj.status === "doji" && lg.entry === 20.5 && sh.entry === 19.6, "direction from the first candle; long at its high, short at its low, doji = no trade");
H.ok(Math.abs(lg.stopDist - 0.1 * lg.atr) < 1e-6, "stop distance = 10% of ATR");

// ---- ideal replay ----
const m = (k, o, h, l, c) => ({ t: new Date(Date.parse("2026-11-02T14:35:00Z") + k * 60000).toISOString(), o, h, l, c });
const L = { side: "long", entry: 20.5, stopDist: 0.2 };
let r = T.simulate(L, [m(0, 20.3, 20.4, 20.2, 20.35), m(1, 20.4, 20.6, 20.38, 20.55), m(2, 20.6, 21.0, 20.5, 20.9)]);
H.ok(r.entered && r.entryPx === 20.5 && r.reason === "close" && Math.abs(r.R - 2) < 1e-9, "long: triggers at 20.50, held to the close at 20.90 = +2R", JSON.stringify(r));
r = T.simulate(L, [m(0, 20.4, 20.6, 20.45, 20.55), m(1, 20.5, 20.52, 20.2, 20.25)]);
H.ok(r.reason === "stop" && Math.abs(r.exitPx - 20.3) < 1e-9 && r.R === -1, "long: stopped next bar at entry - 0.1 ATR = -1R");
r = T.simulate(L, [m(0, 20.4, 20.6, 20.45, 20.55), m(1, 20.1, 20.2, 20.0, 20.1)]);
H.ok(r.reason === "stop" && r.exitPx === 20.1 && r.R === -2, "long: gap through the stop fills at the bar open (-2R)");
r = T.simulate(L, [m(0, 20.7, 20.9, 20.6, 20.8)]);
H.ok(r.entryPx === 20.7, "long: gap above the level enters at the open, not the level");
r = T.simulate(L, [m(0, 20.7, 20.95, 20.45, 20.9)]);
H.ok(r.reason === "stop (entry bar)" && r.R === -1, "long gapped in at the open: the whole bar is after the entry, so its low (20.45 < 20.50 stop) stops it");
r = T.simulate(L, [m(0, 20.3, 20.4, 20.1, 20.2)]);
H.ok(!r.entered && r.R === 0, "never reaches the level: no trade");
r = T.simulate(L, [m(0, 20.4, 20.6, 20.25, 20.55)]);
H.ok(r.entered && r.reason === "close", "entry bar UP (O-L-H-C): the low came before the entry, not a stop", JSON.stringify(r));
r = T.simulate(L, [m(0, 20.45, 20.6, 20.25, 20.35)]);
H.ok(r.reason === "stop (entry bar)" && r.R === -1, "entry bar DOWN (O-H-L-C): the low came after the entry = stop");
r = T.simulate({ side: "short", entry: 19.6, stopDist: 0.2 }, [m(0, 19.7, 19.75, 19.5, 19.55), m(1, 19.5, 19.55, 19.2, 19.2)]);
H.ok(r.entered && r.entryPx === 19.6 && Math.abs(r.R - 2) < 1e-9, "short mirrored: 19.60 -> 19.20 = +2R");

// ---- full mocked LIVE day ----
const D = "2026-11-03";
const at = (hh, mm, ss = 0) => T.etToUtcMs(D, hh, mm) + ss * 1000;
let now = at(8, 31);
const orders = []; const posts = []; const dels = [];
let fillMarketAt = (sym) => 0;
let rejectStopFor = null;
const names = ["AAA", "BBB", "CCC", "DDD", "SPYX"];
const assets = [
  { symbol: "AAA", name: "Alpha Inc", exchange: "NASDAQ", tradable: true, shortable: true, easy_to_borrow: true },
  { symbol: "BBB", name: "Beta Corp", exchange: "NYSE", tradable: true, shortable: true, easy_to_borrow: true },
  { symbol: "CCC", name: "Gamma Holdings", exchange: "NYSE", tradable: true, shortable: true, easy_to_borrow: false },
  { symbol: "DDD", name: "Delta Ltd", exchange: "NASDAQ", tradable: true, shortable: true, easy_to_borrow: true },
  { symbol: "SPYX", name: "SPDR Something ETF", exchange: "ARCA", tradable: true, shortable: true, easy_to_borrow: true },
  { symbol: "BRK.B", name: "Berkshire", exchange: "NYSE", tradable: true },
];
const prior = []; for (let i = 0; i < 28; i++) { const d = new Date(Date.UTC(2026, 9, 6 + i)); if (d.getUTCDay() % 6) prior.push(d.toISOString().slice(0, 10)); }
const priorDays = prior.slice(-16);
const ok = (body) => ({ status: 200, body });
const dataIO = (p) => {
  const q = new URL("http://x" + p); const sy = (q.searchParams.get("symbols") || "").split(",").filter(Boolean);
  const tf = q.searchParams.get("timeframe"), start = q.searchParams.get("start");
  const bars = {};
  if (tf === "1Day") for (const s of sy) bars[s] = priorDays.map(d => ({ t: `${d}T04:00:00Z`, o: 30, h: 31, l: 29, c: 30, v: 3e6 }));
  if (tf === "5Min") {
    const dd = T.etParts(Date.parse(start)).day;
    for (const s of sy) {
      if (dd !== D) { bars[s] = [{ t: start, o: 30, h: 30.2, l: 29.8, c: 30, v: 100000 }]; continue; }
      const today = { AAA: [30, 30.6, 29.9, 30.5, 500000], BBB: [30, 30.1, 29.4, 29.5, 300000], CCC: [30, 30.1, 29.5, 29.6, 400000], DDD: [30, 30.2, 29.9, 30.1, 50000] }[s];
      if (today) bars[s] = [{ t: start, o: today[0], h: today[1], l: today[2], c: today[3], v: today[4] }];
    }
  }
  if (tf === "1Min") {
    const base = Math.max(Date.parse(start), Date.parse(String(start).slice(0, 10) + "T14:35:00Z"));   // paths start at 9:35 ET (11/05: fetch now starts 9:30)
    for (const s of sy) {
      const path = { AAA: [[30.5, 30.7, 30.45, 30.65], [30.65, 31.2, 30.6, 31.1]], BBB: [[29.5, 29.6, 29.3, 29.35], [29.35, 29.8, 29.3, 29.75]], CCC: [[29.6, 29.7, 29.3, 29.35], [29.35, 29.4, 28.9, 29.0]] }[s] || [];
      bars[s] = path.map((b, k) => ({ t: new Date(base + k * 60000).toISOString(), o: b[0], h: b[1], l: b[2], c: b[3] }));
    }
  }
  if (/\/stocks\/trades\/latest/.test(p)) { const tr = {}; for (const s of sy) tr[s] = { p: 31.25, t: "2026-11-03T16:15:00Z" }; return ok({ trades: tr }); }
  if (/\/trades\/latest/.test(p)) return ok({ trade: { p: 30 } });
  return ok({ bars, next_page_token: null });
};
let nextId = 1;
const handTrades = [];   // fills done "by hand" in the Alpaca UI (not APEX orders)
const netQty = (sym) => [...orders, ...handTrades].filter(o => o.symbol === sym && +o.filled_qty > 0).reduce((q, o) => q + (o.side === "buy" ? 1 : -1) * +o.filled_qty, 0);
const tradeIO = (p) => {
  if (p.startsWith("/assets")) return ok(assets);
  if (p.startsWith("/calendar")) { const d0 = /start=([\d-]+)/.exec(p)[1]; return ok([{ date: d0, open: "09:30", close: "16:00" }]); }
  if (p.startsWith("/account")) return ok({ shorting_enabled: true, daytrading_buying_power: "300000", options_buying_power: "60000" });
  if (p.startsWith("/orders:by_client_order_id")) { const c = decodeURIComponent(p.split("=")[1]); return ok(orders.find(o => o.client_order_id === c) || null); }
  const om = /^\/orders\/(o\d+)$/.exec(p);
  if (om) { const o = orders.find(x => x.id === om[1]); if (o && o.status === "pending_cancel") o.status = "canceled"; return o ? ok({ ...o }) : { status: 404, body: null }; }
  if (p.startsWith("/orders")) return ok(orders.map(o => ({ ...o })));
  const pm = /^\/positions\/([A-Z]+)$/.exec(p);
  if (pm) { const q = netQty(pm[1]); return q ? ok({ symbol: pm[1], qty: String(q), side: q > 0 ? "long" : "short" }) : { status: 404, body: { message: "position does not exist" } }; }
  return { status: 404, body: null };
};
T.setIO({
  data: async (p) => dataIO(p), trade: async (p) => tradeIO(p),
  post: async (p, b) => {
    posts.push(b);
    if (+b.qty <= 0) return { status: 422, body: { message: "qty must be > 0" } };
    if (rejectStopFor && b.symbol === rejectStopFor && b.type === "stop") return { status: 422, body: { message: "stop price must not be greater than current price" } };
    if (orders.some(o => o.client_order_id === b.client_order_id)) return { status: 422, body: { message: "client_order_id must be unique" } };
    const o = { id: "o" + nextId++, ...b, status: "new", filled_qty: "0", filled_avg_price: null };
    if (b.type === "market") { o.status = "filled"; o.filled_qty = b.qty; o.filled_avg_price = String(fillMarketAt(b.symbol, b.side)); }
    orders.push(o); return ok(o);
  },
  patch: async () => ok({}),
  del: async (p) => { dels.push(p); const o = orders.find(x => `/orders/${x.id}` === p); if (o && o.status === "new") o.status = "pending_cancel"; return { status: 204, body: null }; },
});
const state = { positions: [] }; const LOG = [];
const deps = { state, logEvent: (t, msg) => LOG.push(`${t}: ${msg}`), markDirty: () => {}, now: () => now };
const byCid = (tag) => orders.find(o => o.client_order_id.endsWith(tag));

(async () => {
  await SIP.tick(deps);
  H.ok(state._sip && state._sip.day === D && !state._sip.built, "8:31 ET: new day rolled, nothing built yet");
  now = at(9, 0, 5); await SIP.tick(deps);
  H.ok(state._sip.built && state._sip.universeSize === 4 && LOG.some(l => /\[SIP\] universe .*4 listed common stocks/.test(l)), "9:00 universe: ETF and dotted symbols dropped, 4 common stocks with history", String(state._sip.universeSize));
  now = at(9, 35, 12); await SIP.tick(deps);
  const s = state._sip;
  H.ok(s.scanned && s.cands.map(c => c.sym).join() === "AAA,CCC,BBB", "9:35 scan: RVol 5x/4x/3x selected in order, DDD (0.5x) not in play", s.cands.map(c => `${c.sym}:${c.rvol}`).join(" "));
  const eA = byCid("AAA-E"), eB = byCid("BBB-E");
  H.ok(eA && eA.side === "buy" && eA.type === "stop" && eA.stop_price === "30.60" && eA.qty === "62" && eA.time_in_force === "day", "AAA long: buy-stop at the 5-min high $30.60, 62 sh ($12.50 / $0.20)", JSON.stringify(eA));
  H.ok(eB && eB.side === "sell" && eB.stop_price === "29.40", "BBB short (ETB): sell-stop at the 5-min low");
  H.ok(!byCid("CCC-E") && /no-borrow/.test(s.cands.find(c => c.sym === "CCC").status), "CCC short but NOT easy to borrow: no order, simulated only");

  H.ok(s.last && s.last.AAA && s.last.AAA.px === 31.25 && s.last.CCC, "live price pulled for every candidate after the scan (dashboard Now column)", JSON.stringify(s.last && s.last.AAA));
  // restart mid-day: the same client ids are adopted, not duplicated
  const n0 = orders.length; await T.placeEntries({ ...s, cands: s.cands.map(c => ({ ...c, status: "planned" })) }, () => {});
  H.ok(orders.length === n0, "re-placing after a restart adopts the existing orders (client_order_id unique)");

  // AAA entry fills at 30.62 -> protective stop at 30.62 - 0.20 = 30.42
  Object.assign(eA, { status: "filled", filled_qty: "62", filled_avg_price: "30.62", filled_at: new Date(at(9, 36)).toISOString() });
  now = at(9, 36, 5); await SIP.tick(deps);
  const sA = byCid("AAA-S1"); const cA = s.cands.find(c => c.sym === "AAA");
  H.ok(sA && sA.side === "sell" && sA.type === "stop" && sA.stop_price === "30.42" && sA.qty === "62" && cA.status === "open", "fill -> protective sell-stop at fill - 10% ATR ($30.42)", JSON.stringify(sA));
  H.ok(Math.abs(SIP.cashAdjustment(state) - 62 * 30.62) < 1e-6, "cash adjustment while long = +shares x fill (options cash unchanged)", String(SIP.cashAdjustment(state)));

  // someone cancels the protective stop (e.g. a manual cancel-all): it comes back
  sA.status = "canceled"; now = at(9, 40); await SIP.tick(deps);
  H.ok(byCid("AAA-S2") && byCid("AAA-S2").stop_price === "30.42", "protective stop cancelled by someone else -> re-placed");

  // BBB short fills at 29.38, then its stop fills at 29.62 (stopDist 0.2 -> stop 29.58; fill 4c worse)
  Object.assign(eB, { status: "filled", filled_qty: "62", filled_avg_price: "29.38" });
  now = at(9, 41); await SIP.tick(deps);
  const sB = byCid("BBB-S1");
  H.ok(sB && sB.side === "buy" && sB.stop_price === "29.58", "short fill -> buy-stop above at fill + 10% ATR ($29.58)");
  H.ok(Math.abs(SIP.cashAdjustment(state) - (62 * 30.62 - 62 * 29.38)) < 1e-6, "cash adjustment nets long cost against short proceeds");
  Object.assign(sB, { status: "filled", filled_qty: "62", filled_avg_price: "29.62" });
  now = at(10, 0); await SIP.tick(deps);
  const cB = s.cands.find(c => c.sym === "BBB");
  H.ok(cB.status === "closed" && cB.exitReason === "stop" && Math.abs(cB.pnl - (-0.24 * 62)) < 1e-6 && Math.abs(cB.R + 1.2) < 1e-6, "short stopped: -$14.88, -1.2R (fill slippage counted)", `${cB.pnl} ${cB.R}`);

  // 3:58 exit: AAA's stop is cancelled first, then a market sell at 31.05
  fillMarketAt = () => 31.05;
  now = at(15, 58, 2); await SIP.tick(deps);
  H.ok(dels.includes(`/orders/${byCid("AAA-S2").id}`) && byCid("AAA-X1") && byCid("AAA-X1").side === "sell" && byCid("AAA-X1").qty === "62", "3:58: protective stop cancelled, then market sell of all 62 sh");
  now = at(15, 58, 10); await SIP.tick(deps);
  H.ok(cA.status === "closed" && cA.exitReason === "close" && Math.abs(cA.pnl - 0.43 * 62) < 1e-6, "AAA closed at the close: +$26.66", String(cA.pnl));
  H.ok(SIP.cashAdjustment(state) === 0, "flat after the close: no cash adjustment left");
  now = at(15, 59, 5); await SIP.tick(deps);
  H.ok(!byCid("AAA-X2") && !LOG.some(l => /still open after the final exit/.test(l)), "3:59 pass: nothing left, no duplicate sell");

  now = at(16, 1, 5); await SIP.tick(deps);
  const sm = s.summary;
  H.ok(s.simulated && sm && sm.triggered === 2 && sm.wins === 1 && Math.abs(sm.actualPnl - (26.66 - 14.88)) < 0.01, "after the close: summary of the live day", JSON.stringify(sm));
  const iC = s.cands.find(c => c.sym === "CCC").ideal;
  H.ok(iC && iC.entered && iC.R > 0 && sm.idealTrades === 3, "the un-borrowable CCC short is still replayed at ideal prices (counted in the paper's R)", JSON.stringify(iC));
  H.ok(cA.slipR != null && cA.entrySlipR > 0, "slippage vs the paper's ideal entry is measured per trade", `${cA.entrySlipR} / ${cA.slipR}`);
  H.ok(s.variants && s.variants.or && s.variants.paper && s.variants.or_be && typeof s.variants.or.R === "number", "nightly replay also scores every exit variant", JSON.stringify(s.variants && s.variants.or));
  const rpl = await SIP.replayToday(state);
  H.ok(rpl.day === D && typeof rpl.final === "boolean" && Object.keys(rpl.totals).length === Object.keys(SIP.EXIT_VARIANTS).length && Object.keys(rpl.totals).length >= 18 && rpl.perTrade.AAA && rpl.live.trades === 2, "/api/sip/replay: every exit rule (18), per-trade grid, live row", JSON.stringify(rpl.totals.or));
  const csv = SIP.eodCSV(s);
  H.ok(csv.split("\n").length === 4 && /^day,mode,rank,symbol/.test(csv) && /AAA,long/.test(csv), "EOD CSV: one row per candidate");
  H.ok(/STOCKS IN PLAY/.test(SIP.eodSection(s)) && /slippage/.test(SIP.eodSection(s)), "EOD email section renders");

  H.ok(dels.length >= 1 && LOG.every(l => !/insufficient/i.test(l)), "3:58 waits for the stop cancel to land (pending_cancel -> canceled) before selling");

  // a position closed BY HAND in Alpaca: the cancelled stop is not re-placed and no opposite order is ever sent
  const D3 = "2026-11-05"; now = T.etToUtcMs(D3, 8, 45); state._sip = null; await SIP.tick(deps);
  const s3 = state._sip; s3.scanned = true;
  s3.cands = [{ rank: 1, sym: "DDD", side: "long", entry: 30.2, stopDist: 0.2, qty: 62, status: "working", rvol: 2 }];
  const eD = { id: "o" + nextId++, symbol: "DDD", side: "buy", qty: "62", type: "stop", client_order_id: "sip-20261105-DDD-E", status: "filled", filled_qty: "62", filled_avg_price: "30.25" };
  orders.push(eD); s3.cands[0].entryOrderId = eD.id;
  now = T.etToUtcMs(D3, 10, 0); await SIP.tick(deps);
  const sD = orders.find(o => o.client_order_id === "sip-20261105-DDD-S1");
  H.ok(sD && sD.stop_price === "30.05", "DDD filled -> protective stop placed");
  sD.status = "canceled"; handTrades.push({ symbol: "DDD", side: "sell", filled_qty: "62" });   // Harrison closes it in the Alpaca app
  const nPosts = posts.length; now = T.etToUtcMs(D3, 10, 1); await SIP.tick(deps);
  const cD = s3.cands[0];
  H.ok(cD.status === "closed" && cD.exitReason === "closed outside APEX" && posts.length === nPosts, "closed by hand: booked as closed outside APEX, stop NOT re-placed (it would have been a short)", `${cD.status} ${cD.exitReason} posts +${posts.length - nPosts}`);
  now = T.etToUtcMs(D3, 15, 58, 2); await SIP.tick(deps);
  H.ok(!orders.some(o => o.client_order_id === "sip-20261105-DDD-X1"), "3:58 sends nothing for it either");
  const cD2 = { sym: "DDD", side: "long", filledQty: 62, fillPx: 30.25, exitQty: 0, stopDist: 0.2 };
  await T.closeMarket(cD2, s3, "test", () => {});
  H.ok(cD2.status === "closed" && !orders.some(o => o.client_order_id === "sip-20261105-DDD-X1"), "closeMarket checks the broker first: no shares held -> no sell order (no accidental short)");

  // 11/03 live bug: protective stop rejected (price already through it) -> market close fills -> must NOT loop protect(qty 0)
  const D4 = "2026-11-06"; now = T.etToUtcMs(D4, 8, 45); state._sip = null; await SIP.tick(deps);
  const s4 = state._sip; s4.scanned = true;
  s4.cands = [{ rank: 1, sym: "EEE", side: "long", entry: 30.2, stopDist: 0.2, qty: 62, status: "working", rvol: 2 }];
  const eE = { id: "o" + nextId++, symbol: "EEE", side: "buy", qty: "62", type: "stop", client_order_id: "sip-20261106-EEE-E", status: "filled", filled_qty: "62", filled_avg_price: "30.25" };
  orders.push(eE); s4.cands[0].entryOrderId = eE.id;
  handTrades.push({ symbol: "EEE", side: "buy", filled_qty: "0" });
  rejectStopFor = "EEE"; fillMarketAt = () => 29.95;
  now = T.etToUtcMs(D4, 10, 0); await SIP.tick(deps);
  const cE = s4.cands[0];
  H.ok(orders.some(o => o.client_order_id === "sip-20261106-EEE-X1" && o.type === "market"), "stop rejected (already through) -> market close sent");
  now = T.etToUtcMs(D4, 10, 0, 5); await SIP.tick(deps);
  H.ok(cE.status === "closed" && cE.exitReason === "stop-reject" && Math.abs(cE.R + 1.5) < 1e-6 && /stop price/.test(cE.stopRejectMsg || ""), "market close filled: booked as stop-reject, -1.5R, first rejection reason kept", `${cE.status} ${cE.exitReason} ${cE.R} ${cE.stopRejectMsg}`);
  const nP4 = posts.length, nL4 = LOG.filter(l => /EEE protective stop REJECTED/.test(l)).length;
  for (let k = 1; k <= 6; k++) { now = T.etToUtcMs(D4, 10, 0, 5 + 5 * k); await SIP.tick(deps); }
  H.ok(posts.length === nP4 && LOG.filter(l => /EEE protective stop REJECTED/.test(l)).length === nL4, "the next 6 ticks send NOTHING and log nothing (the 11/03 qty-0 loop is gone)", `posts +${posts.length - nP4}`);
  rejectStopFor = null;

  // overnight carry: a position left open is closed at the next open, in any mode
  const s2 = JSON.parse(JSON.stringify(s)); s2.cands[0].status = "open"; s2.cands[0].exitQty = 0; s2.cands[0].stopOrderId = "gone";
  handTrades.push({ symbol: "AAA", side: "buy", filled_qty: "62" });   // the broker really still holds the 62 sh overnight
  state._sip = s2; const D2 = "2026-11-04"; now = T.etToUtcMs(D2, 8, 45);
  await SIP.tick(deps);
  H.ok(state._sip.day === D2 && state._sip.carry.length === 1 && LOG.some(l => /still open from a previous day/.test(l)), "next morning: yesterday's open position carried and flagged");
  fillMarketAt = () => 30.9; now = T.etToUtcMs(D2, 9, 31); await SIP.tick(deps);
  H.ok(orders.some(o => /20261104-AAA-X1/.test(o.client_order_id) && o.type === "market"), "carried position market-closed at the open");

  H.ok(SIP.isSipOrder({ client_order_id: "sip-20261103-AAA-E" }) && !SIP.isSipOrder({ client_order_id: "SPY-call-123" }) && !SIP.isSipOrder({}), "isSipOrder: startup cancel skips only the sleeve's orders");
  H.ok(T.NON_COMMON_RE.test("iShares Russell 2000 ETF") && T.NON_COMMON_RE.test("Direxion Daily Semiconductor Bull 3X Shares") && !T.NON_COMMON_RE.test("NVIDIA Corporation") && !T.NON_COMMON_RE.test("Apple Inc."), "common-stock screen: funds out, operating companies in");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 4).join(" | ")); process.exit(1); });
