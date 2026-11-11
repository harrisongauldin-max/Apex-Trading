// Journal P&L basis at close (10/6) and the repair endpoint (dry run / apply / idempotent).
"use strict";
const H = require("./helpers"); H.quiet();
const ce = H.read("closeEngine.js");
try {
  const expr = H.extractBlock(ce, "pnl_alpaca:         (() => {", { includeHead: false });
  const f = new Function("pos", "contractsToSell", "ep", "_pnlApex", "return (() => " + expr + ")()");
  H.ok(f({ contracts: 2, premium: 6.13, cost: 611 }, 2, 6.605, 95) === 95, "stale one-contract cost on two contracts -> real P&L (was +$710)");
  H.ok(f({ contracts: 2, premium: 6.13, cost: 1226 }, 2, 6.605, 95) === 95, "consistent cost -> same answer");
  H.ok(f({ contracts: 1, premium: 6.11, cost: 611 }, 1, 6.5, 39) === 39, "ordinary one-contract trade unchanged");
} catch (e) { H.ok(false, "journal P&L expression", e.message); }

(async () => {
  try {
    const sv = H.read("server.js");
    const a = sv.indexOf('app.post("/api/journal/repair-pnl"');
    const h = H.extractBlock(sv, "async (req, res) =>", { fromIndex: a, includeHead: true });
    const day = new Date().toISOString().slice(0, 10);
    const J = { [day]: [
      { id: "a", status: "CLOSED", ticker: "SPY", contractSymbol: "SPY261019C00781000", entryContracts: 1, contractsAtClose: 2, exitPrice: 6.605, pnl_apex: 95, pnl_alpaca: 710, entryCost: 611 },
      { id: "b", status: "CLOSED", ticker: "QQQ", entryContracts: 1, contractsAtClose: 1, exitPrice: 9.35, pnl_apex: 28, pnl_alpaca: 28, entryCost: 907 },
      { id: "c", status: "OPEN", ticker: "SPY", entryContracts: 2 }] };
    let saves = 0;
    const fn = new Function("loadJournalDay", "saveJournalDay", "logEvent", "return " + h)(async d => J[d] || [], async (d, e) => { saves++; J[d] = e; }, () => {});
    const call = async q => { let out; await fn({ query: q }, { json: o => (out = o), status: () => ({ json: o => (out = o) }) }); return out; };
    let o = await call({});
    H.ok(o.fixes.length === 1 && saves === 0 && J[day][0].pnl_alpaca === 710, "dry run lists the bad row and writes nothing");
    o = await call({ apply: "1" });
    const r = J[day][0];
    H.ok(r.pnl_alpaca === 95 && r.entryContracts === 2 && r.entryCost === 1226 && r._pnlRepaired.pnl_alpaca_was === 710, "apply corrects the row and keeps the original");
    o = await call({ apply: "1" });
    H.ok(o.fixes.length === 0 && !J[day][1]._pnlRepaired, "idempotent; ordinary rows untouched");
  } catch (e) { H.ok(false, "repair endpoint", e.message); }
  H.done();
})();
