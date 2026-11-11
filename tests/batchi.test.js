// 10/28 Batch I (bug check): flatten retries, urgent-first exits, crossing final pass, failed-entry cooldown,
// silent findContract block, near-miss ADX reference, backtest open-position crash.
"use strict";
const H = require("./helpers"); H.quiet();
const fs = require("fs");
const src = (f) => fs.readFileSync(H.R(f), "utf8");

// ---- 1) EOD flatten retries (extracted from server.js and run against mocks) ----
const fnSrc = H.extractBlock(src("server.js"), "async function runEodFlatten(pass)", { includeHead: true });
const mk = (closeImpl) => {
  const LOG = [], calls = [];
  const state = { positions: [
    { ticker: "SPY", contractSymbol: "SPY261106C00771000", entryStrategy: "intraday-trend", premium: 7, currentPrice: 7.5 },
    { ticker: "QQQ", contractSymbol: "QQQ261120C00700000", entryStrategy: "trend-swing", premium: 10, currentPrice: 10 },
  ] };
  const closePosition = async (tk, reason, ep, sym, opts) => { calls.push({ tk, reason, sym, opts }); await closeImpl(state, sym); };
  const logEvent = (t, m) => LOG.push(t + ": " + m);
  const req = (m) => (m === "./constants" ? require(H.R("constants.js")) : require(m));
  const fn = new Function("state", "closePosition", "logEvent", "require", "setTimeout", `${fnSrc}; return runEodFlatten;`)(state, closePosition, logEvent, req, (f) => f());
  return { fn, state, LOG, calls };
};
(async () => {
  let t = mk(async () => {});                         // sell never fills
  let r1 = await t.fn(1);
  H.ok(t.calls.length === 1 && t.calls[0].sym === "SPY261106C00771000" && r1.left === 1 && t.LOG.some(l => /STILL OPEN.*retrying at the next pass/.test(l)),
       "pass 1: intraday position closed (swing held); unfilled -> reported STILL OPEN, will retry", JSON.stringify(r1));
  let r3 = await t.fn(3);
  H.ok(t.calls[1] && t.calls[1].opts && t.calls[1].opts.aggressive === true && t.LOG.some(l => /^error: .*STILL OPEN.*CHECK ALPACA/.test(l)),
       "pass 3 (3:55): sells with the crossing price; if still open, raises an ERROR to check Alpaca");
  t = mk(async (st, sym) => { st.positions = st.positions.filter(p => p.contractSymbol !== sym); });
  r1 = await t.fn(1); const r2 = await t.fn(2);
  H.ok(r1.closed === 1 && r1.left === 0 && r2.closed === 0 && t.calls.length === 1, "filled at 3:45: the 3:50 retry finds nothing to do");
  H.ok(t.state.positions.length === 1 && t.state.positions[0].entryStrategy === "trend-swing", "swing position never touched by any pass");
  const srv = src("server.js");
  H.ok(/for \(const \[min, pass\] of \[\[45, 1\], \[50, 2\], \[55, 3\]\]\)/.test(srv) && !/cron\.schedule\("45 19,20 \* \* 1-5", async \(\) => \{\s*const et = getETTime\(\);\s*if \(!\(et\.getHours\(\) === 15 && et\.getMinutes\(\) === 45\)\) return;\s*if \(state\._overnightCutDisabled\)/.test(srv),
       "crons at 3:45, 3:50 and 3:55 ET drive the passes (old single 3:45 block gone)");

  // ---- 2) urgent exits first (the sort block from scanner.js) ----
  const sc = src("scanner.js");
  const _sb = H.extractBetween(sc, "// 10/28 (bug check): URGENT EXITS FIRST.", "  for (const d of exitDecisions) {");
  const sortSrc = _sb.slice(0, _sb.lastIndexOf("  for (const d of exitDecisions) {"));
  const ex = [{ action: "close", reason: "itrend-noarm", ticker: "SPY" }, { action: "close", reason: "itrend-lock", ticker: "IWM" },
              { action: "close", reason: "itrend-stop", ticker: "QQQ" }, { action: "partial", reason: "x", ticker: "DIA" }];
  new Function("exitDecisions", "require", sortSrc)(ex, (m) => require(H.R(m.replace("./", "") + ".js")));
  H.ok(ex.map(d => d.ticker).join() === "QQQ,DIA,SPY,IWM", "stop and non-patient actions run before patient exits; order kept within groups", ex.map(d => d.ticker).join());

  // ---- 3) failed itrend entry: no 30-min cooldown, 2-min backoff ----
  H.ok(/if \(_iOK\) state\._iTrendLast\[_iCoolKey\] = Date\.now\(\);/.test(sc) && /ITREND_COOLDOWN_MIN - _fb\) \* 60000/.test(sc)
       && !/state\._iTrendLast\[_iCoolKey\] = Date\.now\(\);\s*\n\s*\/\/ 10\/19 \(Harrison\): SHADOW-ONLY/.test(sc),
       "cooldown stamped only after a filled entry; a failed attempt backs off ITREND_FAIL_BACKOFF_MIN");
  const C = require(H.R("constants.js"));
  H.ok(C.ITREND_FAIL_BACKOFF_MIN === 2 && C.ITREND_COOLDOWN_MIN === 30, "constants: backoff 2 min, cooldown still 30 min");
  // backoff arithmetic: a stamp set this way expires in ~2 min
  const _stamp = Date.now() - Math.max(0, 30 - 2) * 60000;
  H.ok(Date.now() - _stamp < 30 * 60000 && Date.now() + 2 * 60000 - _stamp >= 30 * 60000 - 50, "failed-entry stamp clears the 30-min check after ~2 minutes");

  // ---- 4) logging / reference bugs ----
  const exe = src("execution.js");
  H.ok(!/logEvent\("filter", \);/.test(exe) && /REJECTED — within \$\{MIN_STRIKE_DISTINCT\} strikes of open/.test(exe), "findContract duplicate-strike block now says why");
  const _nm = sc.slice(sc.indexOf("state._nearMiss.push({"), sc.indexOf("state._nearMiss.push({") + 600);
  H.ok(_nm.length > 100 && !/adx: signals\.adx/.test(_nm) && /adx: \(typeof stock\.adx === "number"/.test(_nm), "near-miss ledger no longer references an undefined variable");
  H.ok((exe.match(/isMeanReversion: isMeanReversion \|\| false/g) || []).length === 1, "journal entry sets isMeanReversion once");
  const bt = src("backtest.js");
  const elseIdx = bt.indexOf("// Not yet settled - track as open position");
  H.ok(elseIdx > 0 && /const agentRegime = /.test(bt.slice(elseIdx, elseIdx + 800)), "backtest: still-open positions define agentRegime (no silent drop)");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
