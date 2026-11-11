// 11/03: stocks-in-play LIVE execution upgrade — stop sent WITH the entry (OTO), already-through entries go to market,
// profit lock (-0.5R at +1R) + 1R trail from +2R via stop replace, -2R safety net, partial fills, fallbacks.
"use strict";
const H = require("./helpers"); H.quiet();
const SIP = require(H.R("stocksInPlay.js"));
const T = SIP._t;
Object.assign(SIP.CFG, { CHASE_LATE: true, USE_OTO: true, EXIT_MODE: "lock_trail", STOP_MODE: "paper", STOP_BASE: "level", HARD_CAP_R: 2, LOCK_AT_R: 1, LOCK_FLOOR_R: -0.5, TRAIL_FROM_R: 2, TRAIL_R: 1 });

// ---- rule math ----
H.ok(T.lockFloorR(0.9) === -1 && T.lockFloorR(1) === -0.5 && T.lockFloorR(1.9) === -0.5 && T.lockFloorR(2) === 1 && T.lockFloorR(3.4) === 2.4, "floor: -1R, then -0.5R from +1R, then peak-1R from +2R");
const cL = { side: "long", entry: 30.60, stopDist: 0.2, fillPx: 30.62 }, cS = { side: "short", entry: 29.40, stopDist: 0.2, fillPx: 29.38 };
H.ok(T.stopPxFor(cL, -1) === 30.4 && T.stopPxFor(cL, -0.5) === 30.5 && T.stopPxFor(cS, -1) === 29.6 && T.stopPxFor(cS, 1) === 29.2, "stop prices from the entry LEVEL (matches the replay), rounded away from the market");

// ---- mock broker with OTO legs, replace (PATCH), positions, prices ----
const D = "2026-11-04", at = (hh, mm, ss = 0) => T.etToUtcMs(D, hh, mm) + ss * 1000;
const orders = [], posts = [], patches = [], dels = [], hand = [];
let nextId = 1, price = {}, rejectEntry = {}, rejectOto = false, rejectPatch = {};
const ok = (b) => ({ status: 200, body: b });
const all = () => { const o = []; for (const x of orders) { o.push(x); for (const l of x.legs || []) o.push(l); } return o; };
const find = (id) => all().find(o => o.id === id);
const netQty = (sym) => [...all(), ...hand].filter(o => o.symbol === sym && +o.filled_qty > 0).reduce((q, o) => q + (o.side === "buy" ? 1 : -1) * +o.filled_qty, 0);
T.setIO({
  data: async (p) => {
    if (/\/stocks\/trades\/latest/.test(p)) { const sy = /symbols=([^&]+)/.exec(p)[1].split(","); const tr = {}; for (const s of sy) if (price[s]) tr[s] = { p: price[s], t: new Date().toISOString() }; return ok({ trades: tr }); }
    if (/\/trades\/latest/.test(p)) { const s = /stocks\/([A-Z]+)\//.exec(p)[1]; return ok({ trade: { p: price[s] || 0 } }); }
    return ok({ bars: {}, next_page_token: null });
  },
  trade: async (p) => {
    let m = /^\/orders\/(o\d+)(\?nested=true)?$/.exec(p);
    if (m) { const o = find(m[1]); if (o && o.status === "pending_cancel") o.status = "canceled"; return o ? ok({ ...o }) : { status: 404, body: null }; }
    if (p.startsWith("/orders:by_client_order_id")) { const c = decodeURIComponent(p.split("=")[1]); const o = orders.find(x => x.client_order_id === c); return ok(o ? { ...o, legs: undefined } : null); }   // like Alpaca without nested
    if (p.startsWith("/orders")) return ok(orders.map(o => ({ ...o, legs: (o.legs || []).map(l => ({ ...l })) })));
    m = /^\/positions\/([A-Z]+)$/.exec(p);
    if (m) { const q = netQty(m[1]); return q ? ok({ symbol: m[1], qty: String(q), side: q > 0 ? "long" : "short" }) : { status: 404, body: { message: "position does not exist" } }; }
    if (p.startsWith("/account")) return ok({ shorting_enabled: true, daytrading_buying_power: "300000", options_buying_power: "60000" });
    return { status: 404, body: null };
  },
  post: async (p, b) => {
    posts.push(b);
    if (+b.qty <= 0) return { status: 422, body: { message: "qty must be > 0" } };
    if (b.order_class === "oto" && rejectOto) return { status: 422, body: { message: "order_class oto is not supported for this order type" } };
    if (b.type === "stop" && rejectEntry[b.symbol] && /-E$/.test(b.client_order_id)) return { status: 422, body: { message: rejectEntry[b.symbol] } };
    if (orders.some(o => o.client_order_id === b.client_order_id)) return { status: 422, body: { message: "client_order_id must be unique" } };
    // Alpaca's rule for exits: a sell stop must sit below the market, a buy stop above it
    if (b.type === "stop" && !/-E$/.test(b.client_order_id) && price[b.symbol] && (b.side === "sell" ? +b.stop_price >= price[b.symbol] : +b.stop_price <= price[b.symbol]))
      return { status: 422, body: { message: `stop price must be ${b.side === "sell" ? "less" : "greater"} than current price` } };
    const o = { id: "o" + nextId++, symbol: b.symbol, side: b.side, qty: b.qty, type: b.type, stop_price: b.stop_price, client_order_id: b.client_order_id, status: "new", filled_qty: "0", filled_avg_price: null };
    if (b.type === "market") { o.status = "filled"; o.filled_qty = b.qty; o.filled_avg_price = String(price[b.symbol]); }
    if (b.order_class === "oto") o.legs = [{ id: "o" + nextId++, symbol: b.symbol, side: b.side === "buy" ? "sell" : "buy", qty: b.qty, type: "stop", stop_price: b.stop_loss.stop_price, status: o.status === "filled" ? "new" : "held", filled_qty: "0" }];
    orders.push(o); return ok(o);
  },
  patch: async (p, b) => {
    patches.push({ p, b });
    const id = p.split("/").pop(), o = find(id);
    if (!o || rejectPatch[o.symbol] || ["filled", "canceled", "replaced"].includes(o.status)) return { status: 422, body: { message: "order is not replaceable" } };
    const n = { ...o, id: "o" + nextId++, ...(b.stop_price ? { stop_price: b.stop_price } : {}), ...(b.qty ? { qty: b.qty } : {}) };
    o.status = "replaced";
    const parent = orders.find(x => (x.legs || []).includes(o));
    if (parent) parent.legs = parent.legs.map(l => (l === o ? n : l)); else orders.push(n);
    return ok(n);
  },
  del: async (p) => { dels.push(p); const o = find(p.split("/").pop()); if (o && ["new", "held", "accepted"].includes(o.status)) { o.status = "pending_cancel"; for (const l of o.legs || []) if (["new", "held"].includes(l.status)) l.status = "canceled"; } return { status: 204, body: null }; },
});
const LOG = [];
const log = (t, m) => LOG.push(`${t}: ${m}`);
const fill = (o, px, q) => { o.status = "filled"; o.filled_qty = String(q || o.qty); o.filled_avg_price = String(px); for (const l of o.legs || []) if (l.status === "held") l.status = "new"; };
const legOf = (c) => find(c.stopOrderId);
const mk = (sym, side, entry, sd, qty, extra) => ({ rank: 1, sym, side, entry, stopDist: sd, qty, rvol: 5, status: "planned", atr: sd * 10, etb: true, shortable: true, ...extra });

(async () => {
  const s = T.freshDay(D); s.scanned = true; s.sessionKnown = true;
  s.cands = [mk("AAA", "long", 30.60, 0.2, 62), mk("BBB", "short", 29.40, 0.2, 62), mk("LPX", "short", 76.64, 0.5, 25), mk("FAR", "long", 50, 0.1, 100)];
  price = { AAA: 30.55, BBB: 29.45, LPX: 76.50, FAR: 50.40 };
  rejectEntry = { LPX: "stop price must be less than current price", FAR: "stop price must be greater than current price" };
  await T.placeEntries(s, log);
  const eA = orders.find(o => o.client_order_id.endsWith("AAA-E")), cA = s.cands[0];
  H.ok(eA && eA.type === "stop" && eA.stop_price === "30.60" && posts.find(b => b.client_order_id.endsWith("AAA-E")).order_class === "oto"
       && posts.find(b => b.client_order_id.endsWith("AAA-E")).stop_loss.stop_price === "30.40" && cA.oto && cA.stopOrderId === eA.legs[0].id,
       "entry goes out WITH its stop (one-triggers-other): buy-stop 30.60 + stop leg 30.40, leg id tracked", JSON.stringify(posts[0]));
  const cL5 = s.cands[2], eL = orders.find(o => o.client_order_id.endsWith("LPX-EM"));
  H.ok(eL && eL.type === "market" && eL.side === "sell" && cL5.late && cL5.oto && eL.legs && eL.legs[0].stop_price === "77.14",
       "already through (Alpaca: 'stop price must be less than current price'): goes at MARKET with its stop leg — the LPX miss is fixed", JSON.stringify(eL));
  const cF = s.cands[3];
  H.ok(/not chased/.test(cF.status) && !orders.some(o => /FAR-EM/.test(o.client_order_id)), "already 4R past the level: not chased (max 2R)", cF.status);

  // 11/11: CHASE_LATE false (the live default) — an already-through entry is NOT sent at market; it stays in the replay
  H.ok(require(H.R("constants.js")).SIP_CHASE_LATE === false, "live default: SIP_CHASE_LATE = false (don't chase already-through entries)");
  SIP.CFG.CHASE_LATE = false;
  const sN = T.freshDay(D); sN.scanned = true; sN.sessionKnown = true;
  sN.cands = [mk("NCH", "short", 40.00, 0.4, 30), mk("NOK", "long", 20.00, 0.2, 60)];
  price.NCH = 39.80; price.NOK = 19.95; rejectEntry.NCH = "stop price must be less than current price";
  const nPost = posts.length;
  await T.placeEntries(sN, log);
  const cN = sN.cands[0], cOK = sN.cands[1];
  H.ok(cN.lateSkipped && !cN.late && /not chased \(simulated only\)/.test(cN.status) && !orders.some(o => /NCH-EM/.test(o.client_order_id))
       && posts.slice(nPost).filter(b => b.symbol === "NCH").length === 1,
       "no chase: Alpaca rejects the resting stop (already through) -> no market order, status 'not chased (simulated only)'", cN.status);
  H.ok(/0\.5R past/.test(cN.status) && LOG.some(l => /NCH SHORT .*not chased \(simulated only\)/.test(l)), "the skip says how far past the level it was (last $39.80 = 0.5R)", cN.status);
  H.ok(cOK.status === "working" && orders.some(o => o.client_order_id.endsWith("NOK-E") && o.type === "stop"), "an on-time entry still rests its stop as before");
  const csv = T.eodCSV ? T.eodCSV(sN) : SIP.eodCSV(sN);
  H.ok(/NCH.*,skipped,/.test(csv), "end-of-day CSV marks it late = 'skipped' (chased entries stay 'Y')");
  SIP.CFG.CHASE_LATE = true;

  // AAA fills at 30.62 — stop already resting, nothing new posted
  fill(eA, 30.62); const n0 = posts.length;
  await T.poll(s, log);
  H.ok(cA.status === "open" && legOf(cA).status === "new" && posts.length === n0 && LOG.some(l => /already resting \(sent with the entry\)/.test(l)), "fill: stop leg live instantly, no separate stop order");

  // +0.9R: nothing moves. +1.25R: stop to -0.5R (30.50). +3.5R: trail to +2.5R (31.10). Pullback: never lowered.
  const tick2 = async (st) => { await T.manageExits(st, log); await T.manageExits(st, log); };   // peaks/net need 2 agreeing ticks
  price.AAA = 30.78; await tick2(s);
  H.ok(patches.length === 0 && cA.floorR === -1, "+0.9R: stop stays at -1R");
  price.AAA = 30.85; await tick2(s);
  H.ok(cA.floorR === -0.5 && cA.stopPx === 30.5 && legOf(cA).stop_price === "30.50" && patches.length === 1, "+1.25R: stop replaced to -0.5R = $30.50", JSON.stringify(patches[0]));
  price.AAA = 31.30; await tick2(s);
  H.ok(cA.peakR === 3.5 && cA.floorR === 2.5 && cA.stopPx === 31.1 && legOf(cA).stop_price === "31.10", "+3.5R: trailing 1R behind = +2.5R locked ($31.10)", `${cA.peakR} ${cA.floorR} ${cA.stopPx}`);
  price.AAA = 31.15; const np = patches.length; await tick2(s);
  H.ok(patches.length === np && cA.stopPx === 31.1, "pullback: the stop is never lowered");
  price.AAA = 33.00; await T.manageExits(s, log); price.AAA = 31.31;
  H.ok(cA.peakR === 3.5 && patches.length === np, "a single stray print at $33.00 does NOT lift the trail (needs two agreeing ticks)", String(cA.peakR));
  price.AAA = 31.31; await tick2(s);
  H.ok(patches.length === np, "new high by less than 0.1R: no replace spam");
  fill(legOf(cA), 31.08); await T.poll(s, log);
  H.ok(cA.status === "closed" && cA.exitReason === "stop" && Math.abs(cA.pnl - (31.08 - 30.62) * 62) < 1e-6, "trail stop fills: +$28.52 kept instead of round-tripping", String(cA.pnl));

  // BBB short: fills, stop leg FAILS to fill while price runs 2.3R against -> safety net: cancel leg, market out
  const eB = orders.find(o => o.client_order_id.endsWith("BBB-E")), cB = s.cands[1];
  fill(eB, 29.38); await T.poll(s, log);
  price.BBB = 29.85;   // (29.85-29.38)/0.2 = 2.35R against the fill; the leg (29.60) "didn't fill"
  await T.manageExits(s, log);
  H.ok(!cB._capped, "one print 2.35R against: the safety net waits for a second tick (a stray print can't fire it)");
  await T.manageExits(s, log); await T.poll(s, log);   // the next tick's poll books the market fill
  const xB = orders.find(o => /BBB-X1/.test(o.client_order_id));
  H.ok(cB._capped && dels.some(d => d.endsWith(eB.legs[0].id)) && xB && xB.side === "buy" && xB.type === "market" && cB.status === "closed" && cB.exitReason === "hard-cap",
       "safety net at -2R: cancels the stuck stop first, then buys to cover at market", `${cB.status} ${cB.exitReason}`);
  H.ok(cB.R <= -2 && cB.R > -2.5, "safety-net loss lands about -2.35R (not -3.8R like APTV on day 1)", String(cB.R));

  // replace refused -> cancel + re-place at the new floor
  const s2 = T.freshDay(D); s2.scanned = true; s2.cands = [mk("CCC", "long", 20.00, 0.1, 100)];
  price = { CCC: 19.95 }; rejectEntry = {}; await T.placeEntries(s2, log);
  const cC = s2.cands[0], eC = orders.find(o => o.client_order_id.endsWith("CCC-E"));
  fill(eC, 20.01); await T.poll(s2, log);
  rejectPatch.CCC = true; price.CCC = 20.12;   // +1.2R
  await tick2(s2);
  const reC = orders.find(o => /CCC-S1/.test(o.client_order_id));
  H.ok(reC && reC.stop_price === "19.95" && cC.floorR === -0.5 && find(eC.legs[0].id).status === "canceled", "replace refused: old stop cancelled, new stop placed at -0.5R ($19.95)", JSON.stringify(reC));

  // locked stop already through the market (the price fell past the new floor before it landed) -> market out, booked as the lock
  rejectPatch.CCC = true; price.CCC = 20.30;   // floor +3R would be 20.30: a sell stop AT the market is refused
  await T.moveStop(cC, s2, 20.30, 3, log); await T.poll(s2, log);
  const xC = orders.find(o => /CCC-X1/.test(o.client_order_id));
  H.ok(xC && xC.type === "market" && cC.status === "closed" && cC.exitReason === "lock" && cC.pnl > 0, "lock already through the market: sold at market, booked as 'lock' (a profit)", `${cC.exitReason} ${cC.pnl}`);
  rejectPatch = {};

  // OTO unsupported -> plain entry, then the stop is placed on the fill (level-based)
  T.resetOto(); rejectOto = true;
  const s4 = T.freshDay(D); s4.scanned = true; s4.cands = [mk("EEE", "long", 40.00, 0.25, 50)];
  price = { EEE: 39.9 }; await T.placeEntries(s4, log);
  const cE = s4.cands[0], eE = orders.find(o => o.client_order_id.endsWith("EEE-E"));
  H.ok(eE && !eE.legs && !cE.oto && LOG.some(l => /one-triggers-other entry rejected/.test(l)), "OTO refused: falls back to a plain entry (and remembers for the day)");
  fill(eE, 40.03); await T.poll(s4, log);
  const sE = orders.find(o => /EEE-S1/.test(o.client_order_id));
  H.ok(sE && sE.stop_price === "39.75" && cE.status === "open", "then the stop goes in on the fill, at the level-based -1R ($39.75)", JSON.stringify(sE));
  rejectOto = false; T.resetOto();

  // partial entry with an OTO leg: the leg is shrunk to the shares held
  const s5 = T.freshDay(D); s5.scanned = true; s5.cands = [mk("PPP", "long", 10.00, 0.05, 200)];
  price = { PPP: 9.98 }; await T.placeEntries(s5, log);
  const cP = s5.cands[0], eP = orders.find(o => o.client_order_id.endsWith("PPP-E"));
  eP.status = "canceled"; eP.filled_qty = "120"; eP.filled_avg_price = "10.01"; eP.legs[0].status = "new";
  await T.poll(s5, log);
  H.ok(cP.filledQty === 120 && legOf(cP) && legOf(cP).qty === "120" && patches.some(x => x.b.qty === "120"), "partial fill 120/200: stop leg resized to 120 sh", JSON.stringify(legOf(cP)));

  // restart: re-placing an OTO entry adopts it WITH its stop leg (no second stop on the fill)
  const s6 = T.freshDay(D); s6.scanned = true; s6.cands = [mk("AAA", "long", 30.60, 0.2, 62)];
  await T.placeEntries(s6, log);
  H.ok(s6.cands[0].oto === true && s6.cands[0].stopOrderId === eA.legs[0].id, "adopted OTO entry keeps its stop leg id", JSON.stringify([s6.cands[0].stopOrderId, s6.cands[0].status]));
  // 11/04: STOP_BASE "fill" — the stop that went out with the entry (at the level) is re-based onto the real fill, and the
  // lock/trail are measured from the fill. YOU on day 2: level 56.78, fill 57.41 (4.3R slippage).
  SIP.CFG.STOP_BASE = "fill";
  const s7 = T.freshDay(D); s7.scanned = true; s7.cands = [mk("YOU", "long", 56.78, 0.1458, 85)];
  price = { YOU: 56.70 }; await T.placeEntries(s7, log);
  const cY = s7.cands[0], eY = orders.find(o => o.client_order_id.endsWith("YOU-E"));
  H.ok(eY.legs[0].stop_price === "56.63", "entry goes out with its stop at the level (fill unknown yet): 56.78 - 0.15 = 56.63");
  fill(eY, 57.41); await T.poll(s7, log);
  price.YOU = 57.40; await T.manageExits(s7, log);
  H.ok(cY.stopPx === 57.26 && legOf(cY).stop_price === "57.26" && LOG.some(l => /YOU stop re-based to \$57\.26 = -1R from the fill \$57\.41/.test(l)),
       "after the fill: stop re-based to -1R from the FILL ($57.26), not 2.8R below it", String(cY.stopPx));
  price.YOU = 57.60; await tick2(s7);
  H.ok(cY.floorR === -0.5 && cY.stopPx === 57.33, "+1.3R from the fill: lock -0.5R from the fill ($57.33)", `${cY.peakR} ${cY.floorR} ${cY.stopPx}`);
  price.YOU = 58.00; await tick2(s7);
  H.ok(cY.peakR === 4.05 && cY.floorR === 3.05 && cY.stopPx === 57.85, "+4.05R from the fill: trail locks +3.05R of REAL profit ($57.85 vs the $57.41 fill)", `${cY.peakR} ${cY.floorR} ${cY.stopPx}`);
  SIP.CFG.STOP_BASE = "level";
  H.ok(!LOG.some(l => /qty must be > 0/.test(l)), "no qty-0 orders anywhere");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 4).join(" | ")); process.exit(1); });
