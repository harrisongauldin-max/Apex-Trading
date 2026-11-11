// Close path through the REAL closePosition (10/6): a close that fills during its cancel must be recorded, not re-sold.
// Note: each unfilled case waits out CLOSE_FILL_TIMEOUT_MS (~20 s) — this file takes ~45 s.
"use strict";
const H = require("./helpers"); H.quiet();
let script = () => ({ status: "filled", filled_qty: "1", filled_avg_price: "6.48" });
const calls = H.mockBroker({
  get: (u) => { const m = /^\/orders\/(\w+)/.exec(u); if (m) return script(m[1]); if (u === "/positions") return []; if (u.startsWith("/account")) return { cash: "82000", equity: "82000", last_equity: "82000" }; return undefined; },
  post: (u) => u === "/orders" ? { id: "c" + (calls.post.length), status: "new" } : null,
});
const S = require(H.R("state.js")); const st = S.state; const LOG = []; S.logEvent = (t, m) => LOG.push(t + ": " + m);
const CE = require(H.R("closeEngine.js"));
const run = async () => {
  calls.post.length = 0; calls.del.length = 0; LOG.length = 0;
  st.positions = [{ ticker: "SPY", contractSymbol: "SPY261019C00781000", optionType: "call", strike: 781, expDate: "2026-10-19", contracts: 1, premium: 6.11, cost: 611,
                    currentPrice: 6.5, bid: 6.5, ask: 6.55, openDate: new Date(Date.now() - 1200e3).toISOString(), entryStrategy: "intraday-trend" }];
  st.closedTrades = []; st.cash = 81000;
  try { await CE.closePosition("SPY", "itrend-lock", 6.5, "SPY261019C00781000"); } catch (e) { LOG.push("THREW " + e.message); }
  return { sells: calls.post.filter(c => c.u === "/orders").length, open: st.positions.length, closed: st.closedTrades.slice(-1)[0] };
};
(async () => {
  script = () => (calls.del.length > 0 ? { status: "filled", filled_qty: "1", filled_avg_price: "6.50" } : { status: "new", filled_qty: "0" });
  let r = await run();
  H.ok(r.sells === 1 && r.open === 0 && r.closed && LOG.some(l => /FILLED during cancel/.test(l)), "close filling during its cancel: recorded, no second sell", `sells ${r.sells}, P&L ${r.closed && r.closed.pnl}`);
  script = () => (calls.del.length > 0 ? { status: "canceled", filled_qty: "0" } : { status: "new", filled_qty: "0" });
  r = await run();
  H.ok(r.sells === 1 && r.open === 1 && !r.closed, "genuinely unfilled close: position kept for retry");
  script = () => ({ status: "filled", filled_qty: "1", filled_avg_price: "6.48" });
  r = await run();
  H.ok(r.sells === 1 && r.open === 0 && calls.del.length === 0, "normal fill: unchanged behavior");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + e.message); process.exit(1); });
