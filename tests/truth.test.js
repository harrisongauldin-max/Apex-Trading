// Account-change baseline (10/12): the day's change must be measured against APEX's own prior after-close equity
// snapshot, not Alpaca's overnight-restated last_equity (10/9 showed -$548 on a ~+$604 day).
"use strict";
const H = require("./helpers"); H.quiet();
const src = H.read("server.js");
const fnSrc = H.extractBlock(src, "async function getAlpacaTruth()", { includeHead: true });

function make(acct, positions, etDate) {
  const state = { positions: [] }; let dirty = 0;
  const alpacaGet = async (u) => u === "/account" ? acct : u === "/positions" ? positions : [];
  const getETTime = () => etDate;
  const fn = new Function("alpacaGet", "state", "logEvent", "getETTime", "markDirty",
                          fnSrc + "\nreturn getAlpacaTruth;")(alpacaGet, state, () => {}, getETTime, () => { dirty++; });
  return { fn, state, dirty: () => dirty };
}
const todayET = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const ymdPlus = (d, k) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
const etAt = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };   // getETTime returns a Date whose LOCAL fields are ET
const isWeekday = [1, 2, 3, 4, 5].includes(new Date(todayET() + "T12:00:00Z").getUTCDay());

(async () => {
  const pos = [{ symbol: "SPY261130C00768000", qty: "2", market_value: "4800", avg_entry_price: "25.72", cost_basis: "5144", unrealized_pl: "-344", unrealized_plpc: "-0.07" }];
  const acct = { cash: "79090.21", equity: "87369", last_equity: "87917" };   // the 10/9 numbers

  // 1) prior-day snapshot present -> baseline = snapshot
  let t = make(acct, pos, etAt(11, 0));
  t.state._eodEquitySnap = { day: ymdPlus(todayET(), -1), equity: 86765, at: "16:03 ET" };
  let r = await t.fn();
  H.ok(r && Math.abs(r.totalPnL - 604) < 0.01 && /^apex-snapshot/.test(r.dayBaselineSource),
       "baseline = APEX's prior after-close snapshot", `day change ${r && r.totalPnL} (expect +604), source "${r && r.dayBaselineSource}"`);
  H.ok(r && Math.abs(r.alpacaDayChange - (-548)) < 0.01, "Alpaca's own figure still reported for reference", `alpacaDayChange ${r && r.alpacaDayChange}`);

  // 2) no snapshot -> fallback to Alpaca, labeled
  t = make(acct, pos, etAt(11, 0)); r = await t.fn();
  H.ok(r && Math.abs(r.totalPnL - (-548)) < 0.01 && r.dayBaselineSource === "alpaca-last-equity", "no snapshot: falls back to Alpaca last_equity (labeled)");

  // 3) a snapshot from TODAY must not be used as today's baseline
  t = make(acct, pos, etAt(11, 0)); t.state._eodEquitySnap = { day: todayET(), equity: 80000 }; r = await t.fn();
  H.ok(r && r.dayBaselineSource === "alpaca-last-equity", "today's own snapshot is never used as today's baseline");

  // 4) after the close on a weekday: records the snapshot (latest read wins)
  t = make(acct, pos, etAt(16, 3)); r = await t.fn();
  if (isWeekday) H.ok(t.state._eodEquitySnap && t.state._eodEquitySnap.day === todayET() && t.state._eodEquitySnap.equity === 87369 && t.dirty() > 0,
                      "after 16:00 ET on a weekday: records today's equity as tomorrow's baseline", JSON.stringify(t.state._eodEquitySnap));
  else console.log("  SKIP  after-close snapshot (today is a weekend)");

  // 5) during the session: does not record
  t = make(acct, pos, etAt(14, 0)); await t.fn();
  H.ok(!t.state._eodEquitySnap, "before 16:00 ET: no snapshot recorded");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + e.message); process.exit(1); });
