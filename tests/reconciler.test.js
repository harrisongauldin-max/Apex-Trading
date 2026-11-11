// Alpaca quantity sync (10/6): contracts, premium AND cost move together; more contracts than recorded raises an alarm.
"use strict";
const H = require("./helpers"); H.quiet();
let positions = [];
H.mockBroker({ get: (u) => (u === "/positions" ? positions : undefined) });
const REC = require(H.R("reconciler.js"));
const LOG = [];
const S = { positions: [{ ticker: "SPY", contractSymbol: "SPY261019C00781000", contracts: 1, premium: 6.11, cost: 611, optionType: "call" }] };
REC.initReconciler({ state: S, logFn: (t, m) => LOG.push(t + ": " + m) });
(async () => {
  positions = [{ symbol: "SPY261019C00781000", qty: "2", market_value: "1321", avg_entry_price: "6.13" }];
  await REC.syncPositionPnLFromAlpaca();
  const p = S.positions[0];
  H.ok(p.contracts === 2 && p.premium === 6.13 && p.cost === 1226, "1 -> 2 contracts: premium and cost follow", `contracts ${p.contracts}, premium ${p.premium}, cost ${p.cost}`);
  H.ok(LOG.some(l => /warn: .*POSSIBLE DUPLICATE FILL/.test(l)), "extra contracts raise the duplicate-fill alarm");
  LOG.length = 0; positions = [{ symbol: "SPY261019C00781000", qty: "1", market_value: "660", avg_entry_price: "6.13" }];
  await REC.syncPositionPnLFromAlpaca();
  H.ok(p.contracts === 1 && p.cost === 613 && !LOG.some(l => /DUPLICATE/.test(l)), "2 -> 1 (partial close): cost follows, no alarm", `cost ${p.cost}`);
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + e.message); process.exit(1); });
