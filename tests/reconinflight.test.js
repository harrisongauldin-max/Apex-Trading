// 10/28: the reconciler must not "reconstruct" a contract whose entry APEX is placing right now (10/26 QQQ 715C race).
"use strict";
const H = require("./helpers"); H.quiet();
let positions = [];
H.mockBroker({ get: (u) => (u === "/positions" ? positions : u.startsWith("/account") ? { cash: "82000", equity: "82000", last_equity: "82000" } : u.startsWith("/orders") ? [] : undefined) });
const REC = require(H.R("reconciler.js"));
const LOG = [];
const S = { positions: [], closedTrades: [] };
REC.initReconciler({ state: S, logFn: (t, m) => LOG.push(t + ": " + m), redisSaveFn: async () => {}, markDirtyFn: () => {} });
const sym = "QQQ261104C00715000";
(async () => {
  positions = [{ symbol: sym, qty: "1", market_value: "1068", avg_entry_price: "10.68", side: "long", asset_class: "us_option" }];
  S._entryInFlight = { [sym]: Date.now() - 2000 };
  try { await REC.runReconciliation(); } catch (e) { LOG.push("THREW " + e.message); }
  H.ok(S.positions.length === 0 && LOG.some(l => /entry in flight/.test(l)), "entry in flight (2s): NOT reconstructed", LOG.filter(l => /RECONCILE/.test(l)).slice(0, 2).join(" | ").slice(0, 160));
  LOG.length = 0; S._entryInFlight = { [sym]: Date.now() - 200000 };
  try { await REC.runReconciliation(); } catch (e) { LOG.push("THREW " + e.message); }
  H.ok(S.positions.length === 1 && LOG.some(l => /Reconstructed/.test(l)), "stamp expired (200s): a genuinely unrecorded fill IS reconstructed", `positions ${S.positions.length}; ${LOG.filter(l => /RECONCILE|THREW/.test(l)).slice(0, 2).join(" | ").slice(0, 160)}`);
  // 10/28: label restore + honest orphan count
  S.positions = []; LOG.length = 0;
  S._entryInFlight = { [sym]: { at: Date.now() - 1000, strategy: "intraday-trend", iTrend: true } };
  try { await REC.runReconciliation(); } catch (e) { LOG.push("THREW " + e.message); }
  H.ok(S.positions.length === 0 && !LOG.some(l => /1 orphan\(s\) reconstructed/.test(l)), "10/28 skipped in-flight contract is not counted as reconstructed", LOG.filter(l => /orphan/.test(l)).join(" | ").slice(0, 120));
  LOG.length = 0;
  S._entryInFlight = { [sym]: { at: Date.now() - 300000, strategy: "intraday-trend", iTrend: true } };
  try { await REC.runReconciliation(); } catch (e) { LOG.push("THREW " + e.message); }
  const rp = S.positions[0];
  H.ok(rp && rp.entryStrategy === "intraday-trend" && rp._iTrend === true && LOG.some(l => /label restored: intraday-trend/.test(l)),
       "10/28 a rebuilt contract APEX entered today gets its strategy label back (managed by intraday-trend exits)", rp ? `${rp.entryStrategy} _iTrend=${rp._iTrend}` : "none");
  S.positions = []; LOG.length = 0; S._entryInFlight = {};
  try { await REC.runReconciliation(); } catch (e) { LOG.push("THREW " + e.message); }
  H.ok(S.positions[0] && !S.positions[0].entryStrategy, "a genuinely unknown fill is rebuilt unlabeled, as before");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + e.message); process.exit(1); });
