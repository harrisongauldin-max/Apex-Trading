// 11/08: the straddle through the REAL chain fetch, pair picker and executeTrade at 10:30 ET, mocked broker.
"use strict";
const H = require("./helpers"); H.quiet();
const chain = H.chainHandlers(740, "SPY", [1, 3, 7, 14], 1);
const ivByDte = { 1: 0.30, 3: 0.18, 7: 0.22, 14: 0.15 };   // 14 DTE is cheapest but outside 1-7
const today = new Date();
const calls = H.mockBroker({
  get: (u) => {
    if (/^\/orders\/\w+/.test(u)) return { status: "filled", filled_qty: "1", filled_avg_price: "4.00" };
    const r = chain.get(u);
    if (r && r.snapshots) for (const [sym, sn] of Object.entries(r.snapshots)) {
      const m = /SPY(\d{6})/.exec(sym), exp = new Date(`20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`);
      sn.impliedVolatility = ivByDte[Math.max(1, Math.ceil((exp - today) / 864e5))] || 0.2;
    }
    return r;
  },
  post: (u) => (u === "/orders" ? { id: "o" + Math.random().toString(36).slice(2, 7), status: "new" } : null),
});
const S = require(H.R("state.js")); const st = S.state; const LOG = []; S.logEvent = (t, m) => LOG.push(t + ": " + m);
{ const sig = require(H.R("signals.js")); const real = sig.getETTime;
  sig.getETTime = (d) => { const t = real(d); t.setHours(10, 30, 0, 0); return t; }; }
const ex = require(H.R("execution.js"));
const ST = require(H.R("straddleStrategy.js"));
ex.initExecution({ dryRunMode: false, syncCash: async () => {} });
(async () => {
  st.cash = 82000; st.equity = 82000; st.positions = []; st._pendingOrder = null; st._entryFwd = []; st._observeOnly = false;
  const rows = await ex.fetchStraddleRows("SPY", 740.2);
  H.ok(rows.length > 0 && rows.some(r => r.type === "call") && rows.some(r => r.type === "put") && rows.every(r => r.dte >= 1), "chain fetch: both types, no 0DTE", String(rows.length));
  const pair = ST.pickPair(rows, 740.2);
  // the mock lists expiries from the UTC date; DTE is counted on the ET calendar (they differ after 7pm ET) — so check the IV and the ET-day count
  const etToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const etDte = Math.round((Date.parse(pair.exp + "T12:00:00Z") - Date.parse(etToday + "T12:00:00Z")) / 864e5);
  H.ok(Math.abs(pair.iv - 0.18) < 1e-9 && pair.strike === 740 && pair.dte === etDte && pair.dte >= 3 && pair.dte <= 4, "picks the 3-day expiry (lowest IV inside 1-7, not the cheaper 14-day) at the $740 strike", JSON.stringify({ dte: pair.dte, exp: pair.exp, k: pair.strike, iv: pair.iv }));
  const dec = ST.decide(pair, 0.24);
  const stock = { ticker: "SPY", isIndex: true, price: 740.2, _straddle: "hold", _stradIvRv: +dec.ratio.toFixed(3) }, sig = "SPY-straddle-T";
  stock._cachedContract = ST.asContract(pair.call);
  const okC = await ex.executeTrade(stock, 740.2, 0, [dec.reason], 17, "call", false, 1.0, "sameweek", null, sig);
  stock._cachedContract = ST.asContract(pair.put);
  const okP = await ex.executeTrade(stock, 740.2, 0, [dec.reason], 17, "put", false, 1.0, "sameweek", null, sig);
  const legs = st.positions.filter(p => p.signalId === sig);
  H.ok(okC && okP && legs.length === 2, "both legs fill through the real executeTrade", LOG.filter(l => /skip|filter|BLOCK|refused/.test(l)).slice(0, 4).join(" | "));
  const [a, b] = legs;
  H.ok(a && b && a.optionType !== b.optionType && a.strike === b.strike && a.expDate === b.expDate && a.contractSymbol === pair.call.symbol && b.contractSymbol === pair.put.symbol,
       "same strike, same expiry — exactly the pre-selected contracts (not re-selected)", legs.map(p => `${p.optionType} ${p.contractSymbol}`).join(", "));
  H.ok(legs.every(p => p.contracts === 1 && p.entryStrategy === "vol-straddle" && p._isStraddle && p._straddleHold && p._stradIvRv === 0.75), "1 contract each, labelled vol-straddle, held to the close, IV/RV recorded", JSON.stringify(legs.map(p => [p.contracts, p.entryStrategy, p._stradIvRv])));
  H.ok(st._entryInFlight && st._entryInFlight[pair.put.symbol] && st._entryInFlight[pair.put.symbol].straddleHold === true && st._entryInFlight[pair.put.symbol].signalId === sig,
       "in-flight stamp carries the hold flag and pair id (for a reconciler rebuild)");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
