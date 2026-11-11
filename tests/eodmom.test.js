// 10/29: END-OF-DAY MOMENTUM (negative gamma) — entry/exit logic, the real executeTrade at 3:31pm ET, flatten exclusion.
"use strict";
const H = require("./helpers"); H.quiet();
const fs = require("fs");
const E = require(H.R("eodMomentum.js"));
E.CFG.MODE = "live";   // 11/08: the live path is tested here; the shadow default is tested in straddle.test.js
const etToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

(async () => {
  // ---- 1) runEntry decision logic with stubs ----
  const LOG = []; const trades = [];
  const state = { vix: 17, positions: [], _gexRegime: { SPY: "neg", QQQ: "pos" }, _dayCtx: { SPY: { day: etToday, prevClose: 770 } } };
  const deps = { state, logEvent: (t, m) => LOG.push(t + ": " + m),
    getStockQuote: async (tk) => (tk === "SPY" ? 773.08 : 720), getStockBars: async () => [],
    executeTrade: async (stock, px, sc, rs, vix, side, isMR, sz, band, tc, sid) => { trades.push({ stock, side, sid }); return { filled: true }; },
    etHour: 15.5 };
  let r = await E.runEntry(deps);
  H.ok(trades.length === 1 && trades[0].side === "call" && trades[0].stock._eodMom === "call" && Math.abs(trades[0].stock._eodmRet - 0.4) < 0.001 && /eodmom/.test(trades[0].sid),
       "SPY +0.40% from prior close in NEGATIVE gamma -> buys a CALL tagged end-of-day momentum", JSON.stringify(r));
  H.ok(r.some(x => x.tk === "QQQ" && x.action === "stand-aside") && LOG.some(l => /QQQ stand aside — gamma pos/.test(l)), "QQQ in POSITIVE gamma: stands aside");
  r = await E.runEntry({ ...deps, etHour: 15.52 });
  H.ok(trades.length === 1 && r.length === 0, "one trade per ticker per day (3:31 run does nothing more)");
  // down day -> put; bars fallback skips today's partial bar
  trades.length = 0; state._eodm = null; state._gexRegime = { SPY: "neg", QQQ: "neg" }; state._dayCtx = {};
  const todayBarT = new Date(Date.parse(etToday + "T13:30:00Z")).toISOString();
  r = await E.runEntry({ ...deps, getStockQuote: async () => 700, getStockBars: async () => [{ t: "2020-01-01T05:00:00Z", c: 702 }, { t: todayBarT, c: 699 }] });
  H.ok(trades.length === 2 && trades.every(t => t.side === "put") && trades.every(t => t.stock._eodmPrevClose === 702),
       "down vs prior close -> PUT; prior close from the bar BEFORE today's partial bar", trades.map(t => `${t.stock.ticker} ${t.side} prev ${t.stock._eodmPrevClose}`).join(", "));
  // outside the window, unknown gamma, failed entry retry
  trades.length = 0; state._eodm = null;
  r = await E.runEntry({ ...deps, etHour: 15.4 });
  H.ok(r.length === 0 && trades.length === 0, "before 3:30: nothing");
  r = await E.runEntry({ ...deps, etHour: 15.59 });
  H.ok(r.length === 0, "after 3:35: nothing");
  state._eodm = null; state._gexRegime = {};
  r = await E.runEntry(deps);
  H.ok(trades.length === 0 && r.every(x => x.action === "stand-aside"), "gamma unknown: stands aside (negative gamma required)");
  state._eodm = null; state._gexRegime = { SPY: "neg", QQQ: "neg" }; state._dayCtx = { SPY: { day: etToday, prevClose: 770 }, QQQ: { day: etToday, prevClose: 719 } };
  let n = 0;
  const failOnce = async () => (++n === 1 ? false : { filled: true });
  r = await E.runEntry({ ...deps, executeTrade: failOnce });
  const r2 = await E.runEntry({ ...deps, executeTrade: failOnce, etHour: 15.52 });
  H.ok(r[0].action === "failed" && r2.some(x => x.tk === "SPY" && x.action === "entered"), "a failed entry retries at the next minute (until 3:35)");

  state._eodm = null; trades.length = 0;
  r = await E.runEntry({ ...deps, entryBlock: () => "account loss lock active" });
  H.ok(r.length === 0 && trades.length === 0 && LOG.some(l => /no entries — account loss lock active/.test(l)), "account loss lock / broker circuit halts the 3:30 entry too");
  H.ok(state._standDownTally && state._standDownTally.eodm && Object.keys(state._standDownTally.eodm).some(k => /ENTERED|stand aside|blocked/.test(k)),
       "10/29 bug check: every 3:30 decision is tallied for the EOD stand-down CSV", JSON.stringify(state._standDownTally && state._standDownTally.eodm).slice(0, 160));
  // ---- 2) runExit ----
  const closes = []; const st2 = { positions: [{ ticker: "SPY", contractSymbol: "S1", _eodMom: true }, { ticker: "QQQ", contractSymbol: "Q1", entryStrategy: "intraday-trend" }] };
  await E.runExit({ state: st2, logEvent: () => {}, closePosition: async (tk, reason, ep, sym, opts) => { closes.push({ sym, reason, opts }); } }, 1);
  H.ok(closes.length === 1 && closes[0].sym === "S1" && closes[0].reason === "eodm-close" && !closes[0].opts.aggressive, "3:58 exit closes only end-of-day positions, at the live bid");
  closes.length = 0; const L2 = [];
  await E.runExit({ state: st2, logEvent: (t, m) => L2.push(t + ": " + m), closePosition: async (tk, reason, ep, sym, opts) => { closes.push({ sym, opts }); } }, 2);
  H.ok(closes[0].opts.aggressive === true && L2.some(l => /^error: .*STILL OPEN.*CHECK ALPACA/.test(l)), "3:59 retry crosses; still open -> ERROR to check Alpaca");

  // ---- 3) wiring checks ----
  const srv = fs.readFileSync(H.R("server.js"), "utf8"), ex = fs.readFileSync(H.R("exitEngine.js"), "utf8"), C = require(H.R("constants.js"));
  H.ok(/for \(const min of \[30, 31, 32, 33, 34\]\)/.test(srv) && /for \(const \[min, pass\] of \[\[58, 1\], \[59, 2\]\]\)/.test(srv), "crons: entry 3:30-3:34, exit 3:58/3:59 ET");
  H.ok(/!isFlattenExempt\(p\.entryStrategy\) && !_isEod\(p\)/.test(srv), "3:45 flatten skips end-of-day positions (they close at 3:58)");
  const ie = ex.indexOf("if (pos._eodMom) {"), it = ex.indexOf("if (pos._iTrend) {\n      pos._iTrendPeak");
  H.ok(ie > 0 && it > ie && /continue;/.test(ex.slice(ie, it)), "exit engine holds end-of-day positions (no stop/ladder/time cut) before the intraday-trend rules");
  H.ok(/reason: 'eodm-stale'/.test(ex.slice(ie, it)) && /_etD\(_opened\) < _etD\(Date\.now\(\)\)/.test(ex.slice(ie, it)), "carried overnight by a failed exit -> closed at the next session's first scan");
  const sc = fs.readFileSync(H.R("scanner.js"), "utf8");
  H.ok(/logOnChange\(`itrend-neg-\$\{liveStock\.ticker\}-\$\{_iSide\}`/.test(sc), "negative-gamma stand-aside line logs once per 15 min, not every scan");
  H.ok(/\["eod-momentum", t\.eodm \|\| \{\}\]/.test(fs.readFileSync(H.R("reporting.js"), "utf8")), "EOD report stand-down CSV includes eod-momentum");
  H.ok(C.ITREND_NEG_GAMMA_BLOCK === true && C.EODM_ENABLED === true && C.EODM_REQUIRE_NEG_GAMMA === true, "intraday-trend stands aside in negative gamma; end-of-day momentum on, negative gamma only");

  // flatten extraction: an eod position is NOT flattened at 3:45
  const fnSrc = H.extractBlock(srv, "async function runEodFlatten(pass)", { includeHead: true });
  const fst = { positions: [{ ticker: "SPY", contractSymbol: "S1", entryStrategy: "eod-momentum", _eodMom: true, premium: 4, currentPrice: 4 },
                            { ticker: "QQQ", contractSymbol: "Q1", entryStrategy: "intraday-trend", premium: 10, currentPrice: 10 }] };
  const fc = [];
  const flat = new Function("state", "closePosition", "logEvent", "require", "setTimeout", `${fnSrc}; return runEodFlatten;`)(
    fst, async (tk, r, e, sym) => { fc.push(sym); fst.positions = fst.positions.filter(p => p.contractSymbol !== sym); }, () => {}, (m) => (m === "./constants" ? C : require(m)), (f) => f());
  await flat(1);
  H.ok(fc.join() === "Q1" && fst.positions.length === 1 && fst.positions[0]._eodMom, "flatten closed the intraday-trend position and left the end-of-day one", fc.join());
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
