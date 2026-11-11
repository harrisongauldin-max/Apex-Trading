// 10/27: EXECUTION AT THE MID (midExec.js) — ladder math + the REAL closePosition with a mocked broker.
"use strict";
const H = require("./helpers"); H.quiet();
const C = require(H.R("constants.js"));
const MX = require(H.R("midExec.js"));
MX.cfg.exitTimeoutsMs = [1200, 1200]; MX.cfg.pollMs = 200; MX.cfg.cancelSettleMs = 50;

// ---- ladder math ----
H.ok(C.EXEC_MID_ENABLED === true && MX.enabled === true, "EXEC_MID_ENABLED on");
H.ok(C.EXEC_MID_ENTRIES === false && MX.entrySteps(4.10, 4.20).map(x => x.price).join() === "4.2,4.28", "10/27 correction: entries cross (ask -> pay-up) by default");
let s = MX.entrySteps(4.10, 4.20, true);
H.ok(s.map(x => x.price).join() === "4.15,4.17,4.2,4.28" && s[0].label === "mid" && s[3].label === "payup", "entry ladder mid -> half -> ask -> pay-up", s.map(x => x.price).join(" / "));
s = MX.entrySteps(4.10, 4.11, true);
H.ok(s.map(x => x.price).join() === "4.1,4.11,4.19", "penny-wide: mid rounds DOWN (joins bid), dupes removed", s.map(x => x.price).join(" / "));
s = MX.entrySteps(4.10, 4.20, false);
H.ok(s.map(x => x.price).join() === "4.2,4.28" && s[0].timeoutMs === 6000 && s[1].timeoutMs === 8000, "flag off = old [ask, pay-up] 6s/8s exactly");
s = MX.entrySteps(0, 4.20);
H.ok(s.map(x => x.price).join() === "4.2,4.28", "no bid -> old ladder");
const now = Date.now();
s = MX.exitSteps("itrend-lock", 6.40, 6.50, now - 5000, now);
H.ok(s.map(x => x.price).join() === "6.45,6.43", "lock exit: mid -> half (rounded UP), then old bid order", s.map(x => x.price).join(" / "));
H.ok(MX.exitSteps("itrend-stop", 6.40, 6.50, now, now).length === 0, "STOP exits: no passive rungs (bid immediately)");
H.ok(["mr-fade-stop", "trend-stop", "straddle-orphan", "manual", "emergency-manual", "stop", "time-stop"].every(r => MX.exitSteps(r, 6.4, 6.5, now, now).length === 0), "every non-listed reason keeps sell-at-bid");
H.ok(MX.exitSteps("itrend-noarm", 6.40, 6.50, now - 120000, now).length === 0, "stale quote (>60s): no passive rungs");
H.ok(MX.exitSteps("itrend-lock", 6.40, 6.50, now, now, false).length === 0, "flag off: no passive rungs");
H.ok(/\[EXEC\] SPY BUY X bid 4\.10 ask 4\.20 mid 4\.15 -> fill 4\.15 on rung 1\/4 \(mid\) \| saved \$0\.05\/contract vs ask/.test(MX.execLine("BUY", "SPY", "X", 4.1, 4.2, 4.15, 0, 4, "mid")), "EXEC line format");

// ---- real closePosition, mocked broker ----
let fillRule = () => null;
let quoteSeq = [null];   // 10/28: live quotes returned by the snapshot endpoint, in order (null = endpoint down)   // (body, deleted) -> order state
const calls = H.mockBroker({
  get: (u) => {
    const m = /^\/orders\/c(\d+)/.exec(u);
    if (m) { const b = calls.post[+m[1]].b, del = calls.del.some(d => d === `/orders/c${m[1]}`); return fillRule(b, del); }
    if (u.startsWith("/options/snapshots")) { const q = quoteSeq.length > 1 ? quoteSeq.shift() : quoteSeq[0]; return q ? { snapshots: { SPY261030C00690000: { latestQuote: { bp: q[0], ap: q[1] } } } } : undefined; }
    if (u === "/positions") return [];
    if (u.startsWith("/account")) return { cash: "82000", equity: "82000", last_equity: "82000" };
    return undefined;
  },
  post: (u) => u === "/orders" ? { id: "c" + (calls.post.length - 1), status: "new" } : null,
});
const S = require(H.R("state.js")); const st = S.state; const LOG = []; S.logEvent = (t, m) => LOG.push(t + ": " + m);
const CE = require(H.R("closeEngine.js"));
const run = async (reason, bidAt = Date.now()) => {
  calls.post.length = 0; calls.del.length = 0; LOG.length = 0;
  st.positions = [{ ticker: "SPY", contractSymbol: "SPY261030C00690000", optionType: "call", strike: 690, expDate: "2026-10-30", contracts: 1, premium: 6.11, cost: 611,
                    currentPrice: 6.45, bid: 6.40, ask: 6.50, _bidAt: bidAt, openDate: new Date(Date.now() - 1200e3).toISOString(), entryStrategy: "intraday-trend", _iTrend: "call" }];
  st.closedTrades = []; st.cash = 81000;
  try { await CE.closePosition("SPY", reason, 6.45, "SPY261030C00690000"); } catch (e) { LOG.push("THREW " + e.message); }
  return { sells: calls.post.filter(c => c.u === "/orders").map(c => +c.b.limit_price), open: st.positions.length, closed: st.closedTrades.slice(-1)[0] };
};
const restingUntil = (px) => (b, del) => (+b.limit_price <= px ? { status: "filled", filled_qty: "1", filled_avg_price: String(b.limit_price) } : del ? { status: "canceled", filled_qty: "0" } : { status: "new", filled_qty: "0" });

(async () => {
  fillRule = restingUntil(6.45);   // market takes the mid
  let r = await run("itrend-lock");
  H.ok(r.sells.join() === "6.45" && r.open === 0 && r.closed && Math.abs(r.closed.exitPremium - 6.45) < 1e-9 && LOG.some(l => /\[EXEC\] SPY SELL .* fill 6\.45 on rung 1\/3 \(mid\)/.test(l)),
       "lock exit fills at the MID: one order, booked at 6.45", `sells ${r.sells.join(" / ")}, exit ${r.closed && r.closed.exitPremium}`);

  fillRule = restingUntil(6.40);   // nobody takes the mid or half — only the bid fills
  r = await run("itrend-noarm");
  H.ok(r.sells.join() === "6.45,6.43,6.4" && r.open === 0 && r.closed && Math.abs(r.closed.exitPremium - 6.40) < 1e-9 && calls.del.length === 2,
       "no passive fill: mid, half cancelled, then the OLD bid order fills", `sells ${r.sells.join(" / ")}, cancels ${calls.del.length}`);

  r = await run("itrend-stop");
  H.ok(r.sells.join() === "6.4" && r.open === 0, "STOP: straight to the bid, one order", `sells ${r.sells.join(" / ")}`);

  r = await run("itrend-lock", Date.now() - 300000);
  H.ok(r.sells.join() === "6.4", "stale quote: straight to the bid");

  fillRule = (b, del) => (del ? { status: "filled", filled_qty: "1", filled_avg_price: "6.45" } : { status: "new", filled_qty: "0" });
  r = await run("itrend-lock");
  H.ok(r.sells.join() === "6.45" && r.open === 0 && LOG.some(l => /FILLED during cancel/.test(l)), "mid rung fills during its cancel: recorded, NO second sell", `sells ${r.sells.join(" / ")}`);

  fillRule = (b, del) => (del ? { status: "canceled", filled_qty: "1", filled_avg_price: "6.45" } : { status: "new", filled_qty: "0" });
  st.positions = [];
  calls.post.length = 0; calls.del.length = 0; LOG.length = 0;
  st.positions = [{ ticker: "SPY", contractSymbol: "SPY261030C00690000", optionType: "call", strike: 690, expDate: "2026-10-30", contracts: 2, premium: 6.11, cost: 1222,
                    currentPrice: 6.45, bid: 6.40, ask: 6.50, _bidAt: Date.now(), openDate: new Date(Date.now() - 1200e3).toISOString(), entryStrategy: "intraday-trend", _iTrend: "call" }];
  st.closedTrades = [];
  await CE.closePosition("SPY", "itrend-lock", 6.45, "SPY261030C00690000");
  const sells = calls.post.filter(c => c.u === "/orders");
  H.ok(sells.length === 1 && st.positions.length === 1 && LOG.some(l => /\[EXEC-PARTIAL\]/.test(l)), "partial passive fill: stops, no full-size bid sell on top, position kept for reconciler", `sells ${sells.length}`);
  // 10/28: fresh quote before every sell
  fillRule = restingUntil(6.30); quoteSeq = [[6.30, 6.36]];
  r = await run("itrend-stop");
  H.ok(r.sells.join() === "6.3" && r.open === 0 && LOG.some(l => /fresh quote bid \$6\.30 \(cached \$6\.40\)/.test(l)),
       "10/28 stop sells at the LIVE bid (6.30), not the cached 6.40 that would sit unfilled", `sells ${r.sells.join(" / ")}`);
  fillRule = restingUntil(6.20); quoteSeq = [[6.40, 6.50], [6.20, 6.30]];
  r = await run("itrend-noarm");
  H.ok(r.sells.join() === "6.45,6.43,6.2" && r.open === 0 && LOG.some(l => /selling at bid \$6\.20 \(fresh; was \$6\.40\)/.test(l)),
       "10/28 passive rungs miss while the market drops: fallback re-priced to the live bid 6.20 and fills (10/27 10:39 case)", `sells ${r.sells.join(" / ")}`);
  fillRule = restingUntil(6.40); quoteSeq = [null];
  r = await run("itrend-stop");
  H.ok(r.sells.join() === "6.4" && r.open === 0, "quote endpoint down: cached bid used exactly as before");
  // 10/28: final flatten pass crosses: limit a few cents under the live bid, no passive rungs
  fillRule = restingUntil(6.40); quoteSeq = [[6.40, 6.50]];
  calls.post.length = 0; calls.del.length = 0; LOG.length = 0;
  st.positions = [{ ticker: "SPY", contractSymbol: "SPY261030C00690000", optionType: "call", strike: 690, expDate: "2026-10-30", contracts: 1, premium: 6.11, cost: 611,
                    currentPrice: 6.45, bid: 6.40, ask: 6.50, _bidAt: Date.now(), openDate: new Date(Date.now() - 1200e3).toISOString(), entryStrategy: "intraday-trend", _iTrend: "call" }];
  st.closedTrades = [];
  await CE.closePosition("SPY", "itrend-lock", null, "SPY261030C00690000", { aggressive: true });
  const _ag = calls.post.filter(c => c.u === "/orders").map(c => +c.b.limit_price);
  H.ok(_ag.length === 1 && Math.abs(_ag[0] - 6.21) < 1e-9 && st.positions.length === 0, "10/28 aggressive (3:55 flatten) sell: one order at bid − max(5¢, 3%) = 6.21, no mid rungs, closed", `orders ${_ag.join(" / ")}`);
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
