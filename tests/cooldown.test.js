// Trend-swing re-entry cooldown (10/12): an exit through ANY path is stamped, the stamp survives a restart,
// new trend-swings on that ticker are blocked through the 5th trading day after the exit and allowed on the 6th,
// and the other ticker is unaffected. Uses the real scanner code (extracted) and the real trading-day calendar.
"use strict";
const H = require("./helpers"); H.quiet();
const DAYCTX = require(H.R("dayContext.js"));
const sc = H.read("scanner.js");

const book = H.extractBetween(sc, "  // 10/12 (Harrison): TREND-SWING RE-ENTRY COOLDOWN", "cooldown bookkeeping failed — ${_tce && _tce.message}`); }");
const gate = H.extractBetween(sc, "            // 10/12: re-entry cooldown (see the bookkeeping at the top of runScan)", "            if (_tSide && !_haveTrend && !_cohBlock && _tCool) {");

const logs = [];
const runBook = new Function("state", "now", "DAYCTX", "TREND_COOLDOWN_DAYS", "logEvent", "markDirty", book);
const runGate0 = new Function("state", "liveStock", "_tSide", "_haveTrend", "DAYCTX", "TREND_COOLDOWN_DAYS", "TREND_MODE", "TSHADOW",
  gate.replace(/\s*if \(_tSide && !_haveTrend && !_cohBlock && _tCool\) \{$/, "") + "\nreturn _tCool;");
const runGate = (st, ls, side, have, dc, days) => runGate0(st, ls, side, have, dc, days, "live", null);   // 10/14: live-mode rules
// pin "today" for the gate: it calls DAYCTX.etDateStr(Date.now())
const at = (day) => ({ ...DAYCTX, etDateStr: () => day });
const ms = (day) => Date.parse(day + "T15:00:00Z");

const state = { positions: [{ ticker: "SPY", entryStrategy: "trend-swing", optionType: "call" }, { ticker: "QQQ", entryStrategy: "mr-fade-lit", optionType: "call" }] };
runBook(state, ms("2026-10-09"), DAYCTX, 5, (t, m) => logs.push(m), () => {});
H.ok(state._trendOpenSeen.SPY === true && !state._trendOpenSeen.QQQ, "tracks open trend-swing tickers only");
state.positions = state.positions.filter(p => p.ticker !== "SPY");   // closed by any path (close engine, reconciler, manual)
runBook(state, ms("2026-10-09"), DAYCTX, 5, (t, m) => logs.push(m), () => {});
H.ok(state._trendLastExit.SPY && state._trendLastExit.SPY.day === "2026-10-09", "exit stamped with its ET day", JSON.stringify(state._trendLastExit.SPY));
H.ok(logs.some(l => /SPY position closed 2026-10-09 .* before 2026-10-19/.test(l)), "logs the first eligible day", logs[0] || "");

const restored = JSON.parse(JSON.stringify(state));   // a restart: state comes back from Redis
const cool = (day, tk = "SPY", side = "call", have = false) => runGate(restored, { ticker: tk }, side, have, at(day), 5);
const blocked = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map(d => cool(d));
H.ok(blocked.every(Boolean), "blocked on trading days 1-5 after the exit (survives restart)", blocked[4] || "");
H.ok(cool("2026-10-19") === null, "allowed on the 6th trading day (Mon 10/19)");
H.ok(cool("2026-10-14", "QQQ") === null, "the other ticker is not affected");
H.ok(cool("2026-10-14", "SPY", "put") !== null, "applies to either direction on that ticker");
H.ok(runGate(restored, { ticker: "SPY" }, "call", false, at("2026-10-14"), 0) === null, "TREND_COOLDOWN_DAYS = 0 turns it off");

// holiday: exit Fri 11/20 -> Thanksgiving 11/26 doesn't count -> eligible Tue 12/1
restored._trendLastExit.SPY = { day: "2026-11-20", at: ms("2026-11-20") };
H.ok(cool("2026-11-30") !== null && cool("2026-12-01") === null, "holidays don't count as cooldown days (Thanksgiving)");
// a re-opened position on the ticker clears nothing and doesn't re-stamp until it closes again
state.positions.push({ ticker: "SPY", entryStrategy: "trend-swing", optionType: "call" });
runBook(state, ms("2026-10-20"), DAYCTX, 5, () => {}, () => {});
H.ok(state._trendLastExit.SPY.day === "2026-10-09" && state._trendOpenSeen.SPY === true, "re-entry after the cooldown: no new stamp until that position closes");
// 10/14: shadow mode takes its cooldown from the shadow book, not from live exits
H.ok(runGate0(restored, { ticker: "SPY" }, "call", false, at("2026-10-14"), 5, "shadow", { cooldown: (tk) => tk === "QQQ" ? "shadow cooldown" : null }) === null &&
     runGate0(restored, { ticker: "QQQ" }, "call", false, at("2026-10-14"), 5, "shadow", { cooldown: (tk) => tk === "QQQ" ? "shadow cooldown" : null }) === "shadow cooldown",
     "shadow mode: cooldown comes from the shadow book (live exit stamps ignored)");
H.done();
