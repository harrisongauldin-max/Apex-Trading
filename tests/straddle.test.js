// 11/08: V2 LONG STRADDLE (negative gamma, implied < realized, 10:00-12:00 ET, hold to 3:58) + end-of-day momentum to shadow.
"use strict";
const H = require("./helpers"); H.quiet();
const fs = require("fs");
const C = require(H.R("constants.js"));
const ST = require(H.R("straddleStrategy.js"));

// ---- 1) settings ----
H.ok(C.STRADDLE_ENABLED === true && C.STRADDLE_MODE === "live" && ST.V2.TICKERS.join() === "SPY,QQQ" && ST.V2.START_ET === 10 && ST.V2.END_ET === 12
     && ST.V2.IVRV_MAX === 1 && ST.V2.DTE_MIN === 1 && ST.V2.DTE_MAX === 7 && ST.V2.CONTRACTS === 1, "straddle: live, SPY+QQQ, 10:00-12:00 ET, IV/RV < 1.0, 1-7 DTE, 1 contract a leg");
H.ok(ST.STRADDLE.ENABLED === false, "the 9/14 straddle rule (range trigger, +35% TP, 75-min stop) stays retired");
H.ok(C.EODM_MODE === "shadow", "end-of-day momentum is in shadow");

// ---- 2) pair picker ----
const row = (type, exp, dte, strike, iv, bid, ask, delta) => ({ symbol: `X${exp}${type[0]}${strike}`, type, exp, dte, strike, iv, bid, ask, delta: delta == null ? (type === "call" ? 0.5 : -0.5) : delta, theta: -0.5, gamma: 0.03, vega: 0.3, oi: 900 });
const rows = [
  row("call", "E1", 1, 740, 0.30, 3.0, 3.05), row("put", "E1", 1, 740, 0.30, 2.9, 2.95),
  row("call", "E3", 3, 740, 0.20, 5.0, 5.05), row("put", "E3", 3, 740, 0.21, 4.9, 4.95),
  row("call", "E3", 3, 741, 0.20, 4.6, 4.65), row("put", "E3", 3, 741, 0.21, 5.3, 5.35),
  row("call", "E5", 5, 740, 0.18, 6.0, 6.6),  row("put", "E5", 5, 740, 0.18, 6.0, 6.6),     // cheapest IV, but 9% spread -> excluded
  row("call", "E0", 0, 740, 0.10, 1.0, 1.01), row("put", "E0", 0, 740, 0.10, 1.0, 1.01),     // 0DTE -> excluded
  row("call", "E9", 9, 740, 0.12, 9.0, 9.05), row("put", "E9", 9, 740, 0.12, 9.0, 9.05),     // > 7 DTE -> excluded
  row("call", "E2", 2, 740, 0.19, 4.0, 4.05), row("put", "E2", 2, 740, 0.19, 4.0, 4.05, -0.62),   // put delta outside 0.40-0.60
];
const pk = ST.pickPair(rows, 740.3);
H.ok(pk.exp === "E3" && pk.strike === 740 && pk.call.type === "call" && pk.put.type === "put" && pk.call.strike === pk.put.strike && Math.abs(pk.iv - 0.205) < 1e-9,
     "picks the lowest-IV 1-7 DTE expiry with a tradeable same-strike pair, strike nearest spot (wide spread, 0DTE, >7 DTE, delta-out legs excluded)", JSON.stringify({ exp: pk.exp, k: pk.strike, iv: pk.iv }));
H.ok(Math.abs(pk.cost - ((5.025 + 4.925) * 100)) < 0.01 && pk.expiries.length === 2, "pair cost = both mids x 100; the other usable expiry is listed", String(pk.cost));
H.ok(ST.pickPair(rows.filter(r => r.type === "call"), 740).none, "no puts -> no pair");
const c0 = ST.asContract(pk.call);
H.ok(c0.symbol === pk.call.symbol && c0.premium === 5.03 && c0.expDays === 3 && c0.greeks.delta === "0.500" && c0.spread > 0 && c0.spread < 0.02, "contract object in findContract's shape", JSON.stringify(c0));

// ---- 3) decision ----
const d1 = ST.decide(pk, 0.25), d2 = ST.decide(pk, 0.20), d3 = ST.decide({ none: "no chain" }, 0.3);
H.ok(d1.fire && Math.abs(d1.ratio - 0.82) < 1e-9 && /hold both legs to 3:58/.test(d1.reason), "IV 20.5% vs realized 25% (0.82) -> buys", d1.reason);
H.ok(!d2.fire && Math.abs(d2.ratio - 1.025) < 1e-9 && /not below 1\.00/.test(d2.reason), "IV/RV 1.03 -> no trade (options not cheap vs the tape)", d2.reason);
H.ok(!d3.fire && d3.reason === "no chain", "no pair -> no trade");

// ---- 4) pre-gate ----
const st = { positions: [] };
const g = (o) => ST.preGate("SPY", st, { etHour: 10.5, regime: "neg", rv: 0.25, now: Date.now(), ...o });
H.ok(g({}).ok, "10:30 ET, negative gamma, realized vol known -> check the chain");
H.ok(!g({ etHour: 9.9 }).ok && !g({ etHour: 12 }).ok && g({ etHour: 12 }).quiet, "before 10:00 or from 12:00: nothing");
H.ok(!g({ regime: "pos" }).ok && /negative-gamma only/.test(g({ regime: "pos" }).reason) && !g({ regime: "pos" }).quiet, "positive gamma -> stands aside (tallied)");
H.ok(!g({ rv: null }).ok, "no realized vol yet -> waits");
H.ok(!ST.preGate("IWM", st, { etHour: 10.5, regime: "neg", rv: 0.2 }).ok, "only SPY and QQQ");
ST.dayState(st).lastEval.SPY = Date.now();
H.ok(!g({}).ok && g({}).quiet, "the chain is checked at most once a minute per ticker");
ST.dayState(st).lastEval.SPY = 0; ST.dayState(st).done.SPY = "entered";
H.ok(!g({}).ok && /done today/.test(g({}).reason), "one straddle per ticker per day");
st._strad = null; st.positions = [{ ticker: "SPY", _straddleHold: true }];
H.ok(!g({}).ok, "an open straddle on the ticker blocks another");

// ---- 5) runExit ----
(async () => {
  const closes = [], st2 = { positions: [{ ticker: "SPY", contractSymbol: "C1", optionType: "call", _straddleHold: true, _isStraddle: true },
                                         { ticker: "SPY", contractSymbol: "P1", optionType: "put", _straddleHold: true, _isStraddle: true },
                                         { ticker: "QQQ", contractSymbol: "Q1", _eodMom: true }] };
  await ST.runExit({ state: st2, logEvent: () => {}, closePosition: async (tk, reason, ep, sym, opts) => { closes.push({ sym, reason, opts }); } }, 1);
  H.ok(closes.map(c => c.sym).join() === "C1,P1" && closes.every(c => c.reason === "straddle-close" && !c.opts.aggressive), "3:58 exit closes both straddle legs at the live bid (and nothing else)");
  closes.length = 0;
  await ST.runExit({ state: st2, logEvent: () => {}, closePosition: async (tk, reason, ep, sym, opts) => { closes.push({ sym, opts }); } }, 2);
  H.ok(closes.length === 2 && closes.every(c => c.opts.aggressive), "3:59 retry crosses the spread");

  // ---- 6) wiring ----
  const srv = fs.readFileSync(H.R("server.js"), "utf8"), ex = fs.readFileSync(H.R("exitEngine.js"), "utf8"), sc = fs.readFileSync(H.R("scanner.js"), "utf8");
  H.ok(/p\._straddleHold\)\);/.test(srv) && /require\('\.\/straddleStrategy'\)\.runExit\(\{ state, closePosition, logEvent \}, pass\)/.test(srv), "server: 3:45 flatten skips the straddle; the 3:58/3:59 crons close it");
  const si = ex.indexOf("if (pos._isStraddle) {"), tp = ex.indexOf('if (_pairPct >= STRADDLE_TP_PCT)');
  const blk = ex.slice(si, tp);
  H.ok(si > 0 && tp > si && /if \(pos\._straddleHold\) \{ pos\.currentPrice = curP; try \{ require\('\.\/straddleStrategy'\)\.trackLeg\(state, pos, curP\); \} catch \(_\) \{\} markDirty\(\); continue; \}/.test(blk), "exit engine: no take-profit / time stop / regime exit for the hold straddle (orphan rules still run first)");
  H.ok(/reason: 'straddle-stale'/.test(blk) && /_sH >= 15\.95/.test(blk), "carried overnight -> closed at the next first scan; from 3:57 the exit engine leaves it to the 3:58 exit");
  H.ok(/_haveCall/.test(sc) && /STRADDLESTRAT\.asContract\(_pair\.put\)/.test(sc), "scanner: the put is bought only once the call is held");
  H.ok(/\["straddle", t\.straddle \|\| \{\}\]/.test(fs.readFileSync(H.R("reporting.js"), "utf8")), "EOD stand-down CSV includes the straddle decisions");
  H.ok(/if \(_st\.signalId\) reconPos\.signalId = _st\.signalId/.test(fs.readFileSync(H.R("reconciler.js"), "utf8")), "a rebuilt straddle leg keeps its pair id and hold flag");

  // flatten extraction: a straddle leg is NOT flattened at 3:45
  const fnSrc = H.extractBlock(srv, "async function runEodFlatten(pass)", { includeHead: true });
  const fst = { positions: [{ ticker: "SPY", contractSymbol: "C1", entryStrategy: "vol-straddle", _isStraddle: true, _straddleHold: true, premium: 5, currentPrice: 5 },
                            { ticker: "QQQ", contractSymbol: "Q1", entryStrategy: "mr-fade-lit", premium: 10, currentPrice: 10 }] };
  const fc = [], FL = [];
  const flat = new Function("state", "closePosition", "logEvent", "require", "setTimeout", `${fnSrc}; return runEodFlatten;`)(
    fst, async (tk, r, e, sym) => { fc.push(sym); fst.positions = fst.positions.filter(p => p.contractSymbol !== sym); }, (t, m) => FL.push(m), (m) => (m === "./constants" ? C : require(m)), (f) => f());
  await flat(1);
  H.ok(fc.join() === "Q1" && fst.positions.length === 1 && fst.positions[0]._straddleHold, "3:45 flatten closed the fade and left the straddle leg", fc.join());
  await flat(1);
  H.ok(FL.some(m => /1 held to their own 3:58 exit/.test(m)) && !FL.some(m => /swing position\(s\) HELD overnight/.test(m)), "log no longer calls 3:58-exit positions \"swing HELD overnight\"", FL.join(" | "));

  // ---- 7) end-of-day momentum in shadow: decides, no order, scored in the gate-shadow ledger ----
  const E = require(H.R("eodMomentum.js"));
  const et = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const es = { vix: 17, positions: [], _gexRegime: { SPY: "neg", QQQ: "pos" }, _dayCtx: { SPY: { day: et, prevClose: 770 } } };
  const trades = [], LG = [];
  const r = await E.runEntry({ state: es, logEvent: (t, m) => LG.push(m), getStockQuote: async () => 773.08, getStockBars: async () => [], etHour: 15.5,
                               executeTrade: async () => { trades.push(1); return true; } });
  const row0 = (es._gateShadow || [])[0];
  H.ok(E.CFG.MODE === "shadow" && trades.length === 0 && r.some(x => x.tk === "SPY" && x.action === "shadow" && x.side === "call"), "shadow: SPY +0.40% in negative gamma -> CALL decided, no order");
  H.ok(row0 && row0.gate === "eodm-shadow" && row0.sleeve === "eod-momentum" && row0.side === "call" && row0.px === 773.08 && row0.closeDone === false && row0.ctx.ret === 0.4,
       "the decision goes to the gate-shadow ledger (10/20-min marks + move to 3:55)", JSON.stringify(row0));
  H.ok(es._eodm.done.SPY === "shadow" && LG.some(m => /SHADOW only/.test(m)), "one shadow decision per ticker per day, logged");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
