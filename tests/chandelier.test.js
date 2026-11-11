// Trend-swing chandelier exit + QQQ-only + 21-DTE roll (10/12). Runs the REAL code, extracted:
//   exitEngine: _chandelierStep and the whole trend-swing block   scanner: roll re-buy / QQQ-only branch + cooldown bookkeeping
//   execution:  the carry-over of the chandelier state onto the re-bought contract
"use strict";
const H = require("./helpers"); H.quiet();
const DAYCTX = require(H.R("dayContext.js"));
const ex = H.read("exitEngine.js"), sc = H.read("scanner.js"), xe = H.read("execution.js");

// ---- clock + shared state ----
let NOW = { day: "2026-10-12", h: 11 };
const getETTime = () => { const [y, m, d] = NOW.day.split("-").map(Number); return new Date(y, m - 1, d, Math.floor(NOW.h), Math.round((NOW.h % 1) * 60), 0); };
const logs = [], state = { _uNow: {}, _uNowTs: {}, positions: [] };
const logEvent = (t, m) => logs.push(m), markDirty = () => {};
const C = { TREND_TICKERS: ["QQQ"], TREND_EXIT_MODE: "chandelier", TREND_CHANDELIER_ATR: 3.0, TREND_CHANDELIER_CHECK_ET: 15.83,
  TREND_STOP_PCT: 0.125, TREND_ATR_STOP_MULT: 3.5, TREND_USTOP_FLOOR: 0.20, TREND_USTOP_CEIL: 0.55, TREND_STALE_DAYS: 14, TREND_STALE_PEAK: 0.05,
  TREND_TRAIL_ARM_PCT: 0.10, TREND_TRAIL_GIVEBACK_PCT: 0.05, TREND_ROLL_DTE: 21, MS_PER_DAY: 86400000,
  TREND_MODE: "live", TREND_RETIRE_LIVE: true, TREND_RETIRE_AFTER_ET: 9.583 };   // 10/14: these cases test the live-mode rules
const stepSrc = H.extractBlock(ex, "function _chandelierStep(pos, stopPct, delta, prem, atr)", { includeHead: true });
const _chandelierStep = new Function("state", "logEvent", "markDirty", "getETTime", "TREND_CHANDELIER_ATR", "TREND_CHANDELIER_CHECK_ET", stepSrc + "\nreturn _chandelierStep;")(
  state, logEvent, markDirty, getETTime, C.TREND_CHANDELIER_ATR, C.TREND_CHANDELIER_CHECK_ET);
// the exit engine's trend block, run for one position
const blk = H.extractBlock(ex, "if (pos._isTrend) {", { includeHead: true });
let MKT_OPEN = true; const isMarketHours = () => MKT_OPEN;
const runBlock = new Function(...Object.keys(C), "getETTime", "isMarketHours", "state", "logEvent", "markDirty", "_chandelierStep", "pos", "chg", "curP", "dte", "pi", "decisions", "_closedThisCycle",
  `for (const _once of [1]) { ${blk} } return decisions;`);
const exitCheck = (pos, chg, dte, mode = "live") => runBlock(...Object.values({ ...C, TREND_MODE: mode }), getETTime, isMarketHours, state, logEvent, markDirty, _chandelierStep, pos, chg, pos.premium * (1 + chg), dte, 0, [], new Set());
const px = (u) => { state._uNow.QQQ = u; state._uNowTs.QQQ = Date.now(); };
state._dailyMA = { QQQ: { atr: 10 } };

// ---- 1. a QQQ call: armed from the entry underlying, stop from the same 3.5-ATR distance the option stop used ----
const pos = { ticker: "QQQ", optionType: "call", _isTrend: true, entryStrategy: "trend-swing", premium: 33.2, greeks: { delta: 0.65 }, _entryX: { underlying: 749.13 }, contractSymbol: "QQQ261130C00734000", openDate: "2026-10-09T14:06:11Z" };
px(752);
let d = exitCheck(pos, 0.02, 45);
// 3.5 x ATR 10 = $35 underlying = 0.65*35/33.2 = 68.5% option -> clamped 55% -> back to underlying: 0.55*33.2/0.65 = $28.09
H.ok(d.length === 0 && pos._ch && Math.abs(pos._ch.stopPx - (749.13 - 0.55 * 33.2 / 0.65)) < 0.02 && pos._ch.hi === 752,
  "arms on entry: stop = entry - clamped 3.5-ATR distance; high-water starts at max(entry, now)", JSON.stringify(pos._ch));
// 2. intraday: a big option drawdown that is NOT through the underlying stop does not exit (old -55% option stop is gone)
px(728); d = exitCheck(pos, -0.40, 45);
H.ok(d.length === 0, "intraday dip above the underlying stop: holds (no trail, no option-% stop)");
// 3. trail would have fired under the old rules (peak +15%, now +8%) — chandelier mode ignores it
pos._trendPeakChg = 0.15; px(760); d = exitCheck(pos, 0.08, 45);
H.ok(d.length === 0, "old tight trail is off in chandelier mode");
// 4. 15:50 close-check: holds, ratchets the high to the close, once per day
NOW = { day: "2026-10-12", h: 15.85 }; px(770); d = exitCheck(pos, 0.2, 45);
H.ok(d.length === 0 && pos._ch.hi === 770 && pos._ch.lastDay === "2026-10-12", "close-check holds and ratchets the high close", `hi ${pos._ch.hi}`);
px(735); d = exitCheck(pos, -0.1, 45);   // same day, later scan, below hi-3ATR (740) -> not re-judged today; above stop
H.ok(d.length === 0, "judged once per day (a later scan the same day doesn't re-check)");
// 5. next day 15:50: close at 739.9 <= 770 - 30 -> chandelier exit
NOW = { day: "2026-10-13", h: 15.85 }; px(739.9); d = exitCheck(pos, -0.12, 44);
H.ok(d.length === 1 && d[0].reason === "trend-chandelier", "next close 3 ATR below the high close -> trend-chandelier exit", d[0] && d[0].reason);
// 6. stop: any scan through the underlying stop exits
const p2 = { ...pos, _ch: { ...pos._ch, lastDay: "2026-10-13" } }; NOW = { day: "2026-10-14", h: 10 }; px(720); d = exitCheck(p2, -0.5, 43);
H.ok(d.length === 1 && d[0].reason === "trend-stop", "underlying through the stop -> trend-stop, any time of day");
// 7. puts mirror it
const pp = { ticker: "QQQ", optionType: "put", _isTrend: true, premium: 30, greeks: { delta: -0.65 }, _entryX: { underlying: 700 } };
NOW = { day: "2026-10-12", h: 15.9 }; px(690); exitCheck(pp, 0.1, 50);
NOW = { day: "2026-10-13", h: 15.9 }; px(720.5); d = exitCheck(pp, -0.2, 49);
H.ok(pp._ch.lo === 690 && pp._ch.stopPx > 700 && d.length === 1 && d[0].reason === "trend-chandelier", "puts: low close ratchets down, exit 3 ATR above it", JSON.stringify(pp._ch));
// 8. stale QQQ price: falls back to the option-% stop only
const p3 = { ...pos, _ch: { ...pos._ch, lastDay: null, hi: 770 } }; state._uNowTs.QQQ = Date.now() - 20 * 60000; NOW = { day: "2026-10-15", h: 15.9 };
d = exitCheck(p3, -0.30, 42); const d1 = exitCheck(p3, -0.60, 42);   // 10/15: underlying JUST went missing -> hold
p3._chNoUSince = Date.now() - 11 * 60000; const d2 = exitCheck(p3, -0.60, 42);
H.ok(d.length === 0 && d1.length === 0 && d2.length === 1 && d2[0].reason === "trend-stop", "no fresh underlying: chandelier waits; option-% stop protects only after 10 min missing");
// 8b. 10/15 bug: at the open (9:30) a stale underlying + a wide −56% opening quote must NOT stop the trade
const p4 = { ...pos, _ch: { ...pos._ch, lastDay: null, hi: 770 } }; NOW = { day: "2026-10-15", h: 9.501 };
const o1 = exitCheck(p4, -0.569, 42); p4._chNoUSince = Date.now() - 11 * 60000; const o2 = exitCheck(p4, -0.569, 42);
NOW = { day: "2026-10-15", h: 9.76 }; const o3 = exitCheck(p4, -0.569, 42);
H.ok(o1.length === 0 && o2.length === 0 && o3.length === 1, "10/15 bug: no option-% stop at 9:30 on a stale underlying; fallback waits for 9:45 ET", `${o1.length}/${o2.length}/${o3.length}`);
state._uNowTs.QQQ = Date.now(); px(760); const p5 = { ...pos, _ch: { ...pos._ch, lastDay: null, hi: 770 }, _chNoUSince: Date.now() - 30 * 60000 }; NOW = { day: "2026-10-15", h: 10 };
exitCheck(p5, -0.6, 42);
H.ok(!p5._chNoUSince, "a fresh underlying clears the missing-since clock");
// 9. SPY (not in TREND_TICKERS) keeps the legacy rules: trail fires
const sp = { ticker: "SPY", optionType: "call", _isTrend: true, premium: 25.72, greeks: { delta: 0.65 }, _trendPeakChg: 0.15, openDate: "2026-10-06T13:31:30Z" };
d = exitCheck(sp, 0.08, 45);
H.ok(d.length === 1 && d[0].reason === "trend-trail" && !sp._ch, "SPY position keeps its legacy exits (trail)");

// ---- 10. roll: at 21 DTE the exit engine closes and leaves a carry with the trade's stop + high ----
const pr = { ticker: "QQQ", optionType: "call", _isTrend: true, entryStrategy: "trend-swing", premium: 33.2, greeks: { delta: 0.65 }, contractSymbol: "QQQ261130C00734000",
  _ch: { side: "call", entryU: 749.13, stopPx: 721.04, hi: 790, lo: 749.13, lastDay: "2026-11-06", rolls: 0 } };
NOW = { day: "2026-11-09", h: 9.6 }; px(785); d = exitCheck(pr, 0.4, 21);
const carry = (state._trendRollCarry || {}).QQQ;
H.ok(d.length === 1 && d[0].reason === "trend-roll" && carry && carry.ch.stopPx === 721.04 && carry.ch.hi === 790, "21 DTE: trend-roll close + carry (stop, high) saved", JSON.stringify(carry && carry.ch));

// ---- 11. 10/14: SHADOW MODE retires live trend-swing positions from 9:35 ET (market hours), with no roll carry ----
{
  const _savedCarry = state._trendRollCarry; state._trendRollCarry = {};
  const live1 = { ticker: "SPY", optionType: "call", _isTrend: true, entryStrategy: "trend-swing", premium: 25.72, greeks: { delta: 0.6 }, contractSymbol: "SPY261130C00768000", openDate: "2026-10-01T14:00:00Z" };
  const live2 = { ticker: "QQQ", optionType: "call", _isTrend: true, entryStrategy: "trend-swing", premium: 33.2, greeks: { delta: 0.65 }, contractSymbol: "QQQ261130C00734000",
    _ch: { side: "call", entryU: 749.13, stopPx: 720.33, hi: 749.13, lo: 749.13, lastDay: "2026-10-14", rolls: 0 } };
  NOW = { day: "2026-10-15", h: 9.55 }; px(729);
  d = exitCheck(live2, -0.2, 46, "shadow");
  H.ok(d.length === 0, "shadow mode, 9:33 ET: not yet (waits for 9:35)");
  NOW = { day: "2026-10-15", h: 9.6 }; MKT_OPEN = true;
  const dA = exitCheck(live1, -0.3, 46, "shadow"), dB = exitCheck(live2, -0.2, 46, "shadow");
  H.ok(dA.length === 1 && dA[0].reason === "trend-retired" && dB.length === 1 && dB[0].reason === "trend-retired", "shadow mode, 9:36 ET: both live trend positions close as trend-retired (SPY legacy and QQQ chandelier)");
  H.ok(!(state._trendRollCarry || {}).QQQ && !(state._trendRollCarry || {}).SPY, "retirement leaves no roll carry (nothing is re-bought)");
  const live3 = { ...live2, _ch: { ...live2._ch } };
  NOW = { day: "2026-10-15", h: 9.6 }; MKT_OPEN = false;
  H.ok(exitCheck(live3, -0.2, 46, "shadow").length === 0, "outside market hours: no retirement order");
  MKT_OPEN = true;
  H.ok(exitCheck({ ...live3, _ch: { ...live2._ch } }, -0.2, 46, "live").every(x => x.reason !== "trend-retired"), "live mode: no retirement");
  state._trendRollCarry = _savedCarry;
}

// ---- scanner: the roll is not an exit (no cooldown), and the re-buy fires ahead of every entry gate ----
const book = H.extractBetween(sc, "  // 10/12 (Harrison): TREND-SWING RE-ENTRY COOLDOWN", "cooldown bookkeeping failed — ${_tce && _tce.message}`); }");
const runBook = new Function("state", "now", "DAYCTX", "TREND_COOLDOWN_DAYS", "logEvent", "markDirty", book);
state.positions = [{ ticker: "QQQ", entryStrategy: "trend-swing" }]; runBook(state, Date.now(), DAYCTX, 5, logEvent, markDirty);
state.positions = []; runBook(state, Date.now(), DAYCTX, 5, logEvent, markDirty);   // the rolled leg closed
H.ok(!(state._trendLastExit || {}).QQQ, "the roll close does NOT start a re-entry cooldown");

const branch = H.extractBetween(sc, "    const _tCarry = (state._trendRollCarry || {})[liveStock && liveStock.ticker];", "    else if (TREND_ENABLED && liveStock && price > 0) {");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runBranch = new AsyncFunction("state", "liveStock", "price", "TREND_ENABLED", "TREND_TICKERS", "executeTrade", "recordStandDown", "logEvent", "markDirty", "TREND_MODE",
  `const out = { normal: false, cont: false }; for (const _once of [1]) { ${branch.replace(/\s*else if \(TREND_ENABLED && liveStock && price > 0\) \{$/, "")} else { out.normal = true; } } return out;`);
const fired = [], sd = [];
const exec = async (stock, p, sc0, why, vix, side) => {   // run execution's real carry-over snippet on a fake position
  const snip = H.extractBetween(xe, "  // 10/12: a 21-DTE roll continues the same trade", "rolledFrom: stock._trendCarry.from || null };\n  }");
  const position = {}; new Function("stock", "position", "_openSame", snip)(stock, position, null);
  fired.push({ side, carry: !!stock._trendCarry, position }); return true;
};
(async () => {
  const o = await runBranch(state, { ticker: "QQQ" }, 785, true, ["QQQ"], exec, (k, r) => sd.push(r), logEvent, markDirty, "live");
  H.ok(fired.length === 1 && fired[0].side === "call" && !state._trendRollCarry.QQQ, "re-buy fires at once (no entry gates), carry consumed", JSON.stringify(o));
  H.ok(fired[0].position._ch && fired[0].position._ch.stopPx === 721.04 && fired[0].position._ch.hi === 790 && fired[0].position._ch.rolls === 1, "new contract inherits the stop + high-water mark", JSON.stringify(fired[0].position._ch));
  const o2 = await runBranch(state, { ticker: "SPY" }, 780, true, ["QQQ"], exec, (k, r) => sd.push(r), logEvent, markDirty, "live");
  H.ok(fired.length === 1 && !o2.normal && sd.some(r => /SPY not traded — trend-swing is QQQ only/.test(r)), "SPY: no new trend-swing (QQQ only), stand-down says why");
  const o3 = await runBranch(state, { ticker: "QQQ" }, 785, true, ["QQQ"], exec, (k, r) => sd.push(r), logEvent, markDirty, "live");
  H.ok(o3.normal && fired.length === 1, "QQQ with no roll pending: normal entry logic runs");
  // 10/14: shadow mode never re-buys a live roll; a stray carry is dropped
  state._trendRollCarry = { QQQ: { side: "call", ch: { stopPx: 700, hi: 760 }, at: Date.now() } };
  const o4 = await runBranch(state, { ticker: "QQQ" }, 785, true, ["QQQ"], exec, (k, r) => sd.push(r), logEvent, markDirty, "shadow");
  H.ok(fired.length === 1 && !state._trendRollCarry.QQQ && o4.normal, "shadow mode: a pending roll carry is dropped, no live re-buy");
  // a roll that never re-buys for 2h ends the trade and starts the cooldown from the roll time
  state._trendRollCarry = { QQQ: { side: "call", ch: {}, at: Date.now() - 3 * 3600000 } }; state._trendOpenSeen = {};
  runBook(state, Date.now(), DAYCTX, 5, logEvent, markDirty);
  H.ok(!state._trendRollCarry.QQQ && state._trendLastExit.QQQ && logs.some(l => /re-buy never filled within 2h/.test(l)), "re-buy that never fills (2h): trade ended, cooldown starts");
  H.done();
})().catch(e => { H.ok(false, "chandelier test crashed", e.stack.split("\n").slice(0, 3).join(" | ")); H.done(); });
