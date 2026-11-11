// Entry path through the REAL executeTrade (live mode, mocked broker): cancel/fill race (10/6), client_order_id,
// delta-window selection (10/7), ADX-tiered and stop-based sizing (10/6), labels and the mr-fade ledger row (10/12).
"use strict";
const H = require("./helpers"); H.quiet();
const chain = H.chainHandlers(780, "SPY", [1, 3, 7, 14, 21, 30, 45, 60, 70], 1);
let orderScript = () => ({ status: "filled", filled_qty: "1", filled_avg_price: "6.10" });
const calls = H.mockBroker({
  get: (u) => { const m = /^\/orders\/(\w+)/.exec(u); if (m) return orderScript(m[1]); return chain.get(u); },
  post: (u, b) => u === "/orders" ? { id: "o" + (calls.post.filter(c => c.u === "/orders").length), status: "new" } : null,
});
const S = require(H.R("state.js")); const st = S.state; const LOG = []; S.logEvent = (t, m) => LOG.push(t + ": " + m);
// pin the ET clock to 11:00 so the test doesn't depend on when it runs (entries are refused after 3:15 ET by design)
{ const sig = require(H.R("signals.js")); const real = sig.getETTime;
  sig.getETTime = (d) => { const t = real(d); t.setHours(11, 0, 0, 0); return t; }; }
const ex = require(H.R("execution.js"));
const MX = require(H.R("midExec.js")); MX.cfg.entryTimeoutsMs = [1500, 1200, 1200, 1500];   // 10/27: shrink the mid ladder for test speed
ex.initExecution({ dryRunMode: false, syncCash: async () => {} });

const reset = () => { st.cash = 82000; st.equity = 82000; st.positions = []; st._pendingOrder = null; st._entryFwd = []; st._dailyMA = { SPY: { atr: 7.5 } }; LOG.length = 0; calls.post.length = 0; calls.del.length = 0; };
const enter = async (stock, side, isMR = false, sig = null) => {
  reset();
  try { await ex.executeTrade({ ticker: "SPY", isIndex: true, price: 780, ...stock }, 780, 0, ["t"], 16, side, isMR, 1.0, null, null, sig); }
  catch (e) { LOG.push("THREW " + e.message); }
  return { pos: st.positions[0], orders: calls.post.filter(c => c.u === "/orders").map(c => c.b), cancels: calls.del.length };
};

(async () => {
  // 1) cancel/fill race
  orderScript = () => (calls.del.length > 0 ? { status: "filled", filled_qty: "1", filled_avg_price: "6.11" } : { status: "new", filled_qty: "0" });
  let r = await enter({ _iTrend: "call", adx: 30 }, "call");
  H.ok(r.orders.length === 1 && r.pos && r.pos.contracts === 1 && LOG.some(l => /FILLED during cancel/.test(l)), "fill landing during the cancel: ONE order, recorded", `orders ${r.orders.length}, contracts ${r.pos && r.pos.contracts}`);
  H.ok(r.orders.every(b => /^apex-SPY\d+C\d+-\d+-a1$/.test(b.client_order_id || "")), "client_order_id on every order", r.orders[0] && r.orders[0].client_order_id);
  orderScript = (id) => (calls.del.length >= Number(id.slice(1)) ? { status: "canceled", filled_qty: "0" } : { status: "new", filled_qty: "0" });
  r = await enter({ _iTrend: "call", adx: 30 }, "call");
  H.ok(r.orders.length === 2 && !r.pos && +r.orders[0].limit_price < +r.orders[1].limit_price && LOG.some(l => /\[EXEC-MISS\]/.test(l)),
       "genuinely unfilled: ask then pay-up (entries cross, 10/27), no position, EXEC-MISS logged", `orders ${r.orders.length}: ${r.orders.map(o => o.limit_price).join(" / ")}`);
  orderScript = () => ({ status: "filled", filled_qty: "1", filled_avg_price: "6.12" });

  // 2) sizing
  r = await enter({ _iTrend: "call", adx: 45 }, "call");
  H.ok(require(H.R("constants.js")).ITREND_ADX_SIZE_ENABLED === false && r.orders[0] && +r.orders[0].qty === 1 && !LOG.some(l => /\[ITREND-SIZE\]/.test(l)), "10/15: ADX sizing OFF — intraday-trend ADX 45 -> 1 contract", `qty ${r.orders[0] && r.orders[0].qty}`);
  r = await enter({ _iTrend: "call", adx: 30 }, "call");
  H.ok(r.orders[0] && +r.orders[0].qty === 1, "intraday-trend ADX 30 -> 1 contract");
  r = await enter({ _isTrend: true }, "call");
  H.ok(r.orders[0] && +r.orders[0].qty === 1 && LOG.some(l => /\[TREND-SIZE\]/.test(l)), "trend-swing sized to its stop", (LOG.find(l => /\[TREND-SIZE\]/.test(l)) || "").slice(0, 90));

  // 3) mr-fade: in-window delta, labels, and the post-exit shadow ledger row (10/12)
  r = await enter({ _mrFade: { side: "put", invalidationPx: 781.95, locationSource: "vwap-band" }, _mrMeta: { stretchZ: 3.1 }, intradayVWAP: 776.5 }, "put", true, "SPY-put-mrfade-T");
  const d = r.pos && Math.abs(+r.pos.delta || +(r.pos.greeks && r.pos.greeks.delta) || 0);
  H.ok(r.pos && r.pos._isMrFade && !LOG.some(l => /outside (target|break) range/.test(l)), "mr-fade picks a contract inside its accepted delta window", `delta ${d && d.toFixed(3)}`);
  H.ok(r.pos && r.pos._mrInvalidation === 781.95 && r.pos._mrMeta && r.pos._mrMeta.stretchZ === 3.1, "fade position carries invalidation + stamps");
  const ef = (st._entryFwd || []).find(e => e.signalId === "SPY-put-mrfade-T");
  H.ok(ef && ef.mrInv === 781.95 && ef.mrTgt0 === 776.5 && ef.mrDone === false && ef.mrInvMin === null, "fade entry opens a post-exit shadow row (invalidation + VWAP target)", ef ? `inv ${ef.mrInv}, tgt ${ef.mrTgt0}` : "no row");
  r = await enter({ _iTrend: "call", adx: 30 }, "call", false, "SPY-call-itrend-T");
  const ef2 = (st._entryFwd || []).find(e => e.signalId === "SPY-call-itrend-T");
  H.ok(ef2 && ef2.mrInv === undefined, "non-fade entries get no mr shadow fields");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
