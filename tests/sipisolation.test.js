// 11/02: the share sleeve must not leak into the options book — cash sync, reconciler, startup order cancel.
"use strict";
const H = require("./helpers"); H.quiet();
let positions = [], acct = { cash: "80000", equity: "82000", buying_power: "300000", options_buying_power: "60000" };
H.mockBroker({ get: (u) => (u === "/positions" ? positions : u.startsWith("/account") ? acct : undefined) });
const S = require(H.R("state.js")); const st = S.state; const LOG = []; S.logEvent = (t, m) => LOG.push(t + ": " + m);
const CE = require(H.R("closeEngine.js"));
const REC = require(H.R("reconciler.js"));
const fs = require("fs");

(async () => {
  // a long 100 sh @ $50 spent $5,000 of Alpaca cash; a short 50 sh @ $20 received $1,000
  st.cash = 84000; st.positions = [];
  st._sip = { day: "2026-11-03", cands: [
    { sym: "AAA", side: "long", filledQty: 100, fillPx: 50, exitQty: 0 },
    { sym: "BBB", side: "short", filledQty: 50, fillPx: 20, exitQty: 0 },
    { sym: "CCC", side: "long", filledQty: 10, fillPx: 30, exitQty: 10 },   // closed: no adjustment
  ], carry: [] };
  await CE.syncCashFromAlpaca();
  H.ok(Math.abs(st.cash - 84000) < 0.01 && Math.abs(st._sipCashAdj - 4000) < 0.01, "options cash = Alpaca cash + long cost - short proceeds ($80,000 + $4,000)", `cash ${st.cash}, adj ${st._sipCashAdj}`);
  st._sip = null; await CE.syncCashFromAlpaca();
  H.ok(st.cash === 80000, "no sleeve state: cash sync exactly as before");

  // reconciler: share positions are never adopted as options orphans, and never remove an option position
  REC.initReconciler({ state: st, logFn: (t, m) => LOG.push(t + ": " + m) });
  st.positions = [{ ticker: "SPY", contractSymbol: "SPY261106C00690000", optionType: "call", contracts: 1, premium: 5, cost: 500, openDate: new Date().toISOString() }];
  positions = [{ symbol: "SPY261106C00690000", qty: "1", market_value: "510", avg_entry_price: "5.00" }, { symbol: "AAA", qty: "100", market_value: "5100", avg_entry_price: "50.00", side: "long" }];
  await REC.runReconciliation();
  H.ok(st.positions.length === 1 && st.positions[0].contractSymbol === "SPY261106C00690000" && !LOG.some(l => /AAA.*(orphan|reconstruct)/i.test(l)), "reconciler ignores the AAA share position");

  // startup + manual cancel-all skip the sleeve's orders (source check: both filters present)
  const src = fs.readFileSync(H.R("server.js"), "utf8");
  H.ok((src.match(/isSipOrder\(o\)/g) || []).length >= 2, "server.js: startup cancel and /api/cancel-pending-orders both skip sip- orders");
  H.ok(/flattenAll\(state, logEvent, "emergency-close"\)/.test(src), "server.js: emergency close-all also flattens the share sleeve");
  H.ok(/SIP\.tick\(\{ state, logEvent, markDirty, saveNow: saveStateNow \}\)/.test(src) && src.indexOf("SIP.tick(") < src.indexOf("app.listen(PORT, () => {"), "server.js: the sleeve clock starts after state has loaded");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
