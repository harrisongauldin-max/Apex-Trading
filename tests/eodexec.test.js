// 10/29: end-of-day momentum through the REAL executeTrade at 3:31pm ET (observe-only window), mocked broker.
"use strict";
const H = require("./helpers"); H.quiet();
const chain = H.chainHandlers(780, "SPY", [1, 2, 3, 7, 14, 21, 30], 1);
const calls = H.mockBroker({
  get: (u) => { if (/^\/orders\/\w+/.test(u)) return { status: "filled", filled_qty: "1", filled_avg_price: "3.10" }; return chain.get(u); },
  post: (u) => (u === "/orders" ? { id: "o1", status: "new" } : null),
});
const S = require(H.R("state.js")); const st = S.state; const LOG = []; S.logEvent = (t, m) => LOG.push(t + ": " + m);
{ const sig = require(H.R("signals.js")); const real = sig.getETTime;
  sig.getETTime = (d) => { const t = real(d); t.setHours(15, 31, 0, 0); return t; }; }
const ex = require(H.R("execution.js"));
ex.initExecution({ dryRunMode: false, syncCash: async () => {} });
const reset = () => { st.cash = 82000; st.equity = 82000; st.positions = []; st._pendingOrder = null; st._entryFwd = []; st._observeOnly = true; LOG.length = 0; calls.post.length = 0; };
(async () => {
  reset();
  let ok = await ex.executeTrade({ ticker: "SPY", isIndex: true, price: 780, _eodMom: "call", _eodmRet: 0.4 }, 780, 0, ["eod"], 17, "call", false, 1.0, null, null, "SPY-call-eodmom-T");
  const p = st.positions[0];
  H.ok(ok && p && p.entryStrategy === "eod-momentum" && p._eodMom === true && !p._iTrend, "3:31pm in the observe window: end-of-day entry goes through, labelled eod-momentum (not intraday-trend)",
       p ? `${p.entryStrategy} ${p.contractSymbol}` : LOG.filter(l => /skip|refused|filter/.test(l)).slice(0, 3).join(" | "));
  H.ok(LOG.some(l => /\[ITREND-SELECT\].* for 28min/.test(l)), "contract chosen by the cost selector with the 28-minute hold", (LOG.find(l => /ITREND-SELECT/.test(l)) || "").slice(0, 160));
  reset();
  ok = await ex.executeTrade({ ticker: "SPY", isIndex: true, price: 780, _iTrend: "call" }, 780, 0, ["it"], 17, "call", false, 1.0, null, null, "SPY-call-itrend-T");
  H.ok(!ok && st.positions.length === 0 && LOG.some(l => /observe-only after 3:15/.test(l)), "any other entry at 3:31pm is still refused");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
