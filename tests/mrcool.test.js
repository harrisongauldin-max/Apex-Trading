// MR-fade cooldown after a stop (10/12). Real code, extracted: the exit engine stamps the stop; the scanner stands
// down any new fade on that ticker for MR_FADE_STOP_COOLDOWN_MIN, then fires again. Replays the 10/8 12:50 chain.
"use strict";
const H = require("./helpers"); H.quiet();
const ex = H.read("exitEngine.js"), sc = H.read("scanner.js");
const state = { positions: [] }, logs = [], sd = [];
const logEvent = (t, m) => logs.push(m), markDirty = () => {};
// exit engine mr-fade block, one position
const blk = H.extractBlock(ex, "if (pos._isMrFade) {", { includeHead: true });
const runExit = new Function("state", "logEvent", "markDirty", "ladderFloor", "MR_FADE_STOP_PCT", "MR_FADE_TP", "MR_FADE_MAX_HOLD_MIN", "MR_FADE_STOP_COOLDOWN_MIN", "STOP_LOSS_PCT",
  "pos", "chg", "curP", "pi", "decisions", "_closedThisCycle", `for (const _once of [1]) { ${blk} } return decisions;`);
const exitCheck = (pos, chg) => runExit(state, logEvent, markDirty, () => null, 0.18, 0.30, 60, 15, 0.18, pos, chg, 1, 0, [], new Set());
// scanner gate: position-open check, cooldown check, else FIRE
const gate = H.extractBetween(sc, "          const _hasPos = (state.positions || []).some(p => p.ticker === liveStock.ticker && p.optionType === _mrDec.side && !p.closed && (p._isMrFade",
  `            recordStandDown("mrf", "FIRED");`);
const shadows = [];
const runGate = new Function("state", "liveStock", "_mrDec", "recordStandDown", "logEvent", "MR_FADE_STOP_COOLDOWN_MIN", "recordGateShadow", "price",
  `let fired = false; ${gate.replace(/recordStandDown\("mrf", "FIRED"\);$/, "")} fired = true; } return fired;`);
const tryFire = (tk, side = "call") => runGate(state, { ticker: tk }, { side }, (k, r) => sd.push(r), logEvent, 15, (...a) => shadows.push(a), 770);

const p1 = { ticker: "QQQ", optionType: "call", _isMrFade: true, openDate: new Date(Date.now() - 2 * 60000).toISOString() };
let d = exitCheck(p1, -0.198);
H.ok(d.length === 1 && d[0].reason === "mr-fade-stop" && state._mrStopAt && state._mrStopAt.QQQ, "a stop stamps the ticker");
H.ok(tryFire("QQQ") === false && sd.some(r => /cooldown after a stop/.test(r)), "4 s later (the 10/8 re-entry): stands down", sd[sd.length - 1]);
H.ok(shadows.some(x => x[0] === "mr-fade-stop-cooldown" && x[2] === "QQQ"), "the cooldown block is recorded in the gate-shadow ledger");
H.ok(tryFire("QQQ", "put") === false, "either direction on that ticker is blocked");
H.ok(tryFire("SPY") === true, "the other ticker is unaffected");
state._mrStopAt.QQQ = Date.now() - 14.5 * 60000;
H.ok(tryFire("QQQ") === false, "still blocked at 14.5 min");
state._mrStopAt.QQQ = Date.now() - 15.1 * 60000;
H.ok(tryFire("QQQ") === true, "fires again after 15 min");
// a non-stop exit (lock / maxhold) doesn't start a cooldown
state._mrStopAt = {};
const p2 = { ticker: "QQQ", optionType: "call", _isMrFade: true, openDate: new Date(Date.now() - 61 * 60000).toISOString() };
d = exitCheck(p2, -0.05);
H.ok(d.length === 1 && d[0].reason === "mr-fade-maxhold" && !state._mrStopAt.QQQ && tryFire("QQQ") === true, "max-hold exit: no cooldown");
// 10/14: only an open MR-FADE position blocks a fade; a trend-swing call on the same ticker no longer does
state.positions = [{ ticker: "QQQ", optionType: "call", entryStrategy: "trend-swing", _isTrend: true }];
H.ok(tryFire("QQQ") === true, "an open trend-swing call does NOT block an MR-fade call (the SPY 768C bug)");
state.positions = [{ ticker: "QQQ", optionType: "call", entryStrategy: "mr-fade-lit", _isMrFade: true }];
H.ok(tryFire("QQQ") === false && /position already open/.test(sd[sd.length - 1]), "an open MR-fade position still blocks a second fade");
H.done();
