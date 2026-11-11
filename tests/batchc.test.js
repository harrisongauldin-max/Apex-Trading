// Batch C (10/15 evening): harness-driven rule changes + log fixes. Source-level checks on scanner/execution (the scan
// loop is too large to run whole here); behaviour of mrStrategy / exitEngine / execution sizing / the harness is tested
// in mrwall, chandelier, orders and flowharness.
"use strict";
const H = require("./helpers"); H.quiet();
const C = require(H.R("constants.js"));
const sc = H.read("scanner.js"), ex = H.read("execution.js");

H.ok(C.BREAK_TRIGGER_ENABLED === false && C.BREAK_TRIGGER_ENFORCE === true, "break trigger retired (not computed); ENFORCE kept for the gamma-regime plumbing and zeroed legacy scores");
H.ok(C.LEGACY_SCORED_ENTRIES === false && C.ITREND_LATE_ADX_ENABLED === false && C.ITREND_ADX_SIZE_ENABLED === false, "legacy scored entries off, late-ADX rule off, ADX sizing off");
H.ok(/ITREND_LATE_ADX_ENABLED = true, ITREND_MODE = "live",/.test(sc) && /LEGACY_SCORED_ENTRIES = true,/.test(sc), "scanner imports both new flags (defaults = old behaviour if constants is stale)");

// legacy path: guard sits right before scored.push, AFTER telemetry, and lets MR-scalp through
const iGuard = sc.indexOf("if (!LEGACY_SCORED_ENTRIES && !liveStock._mrScalp)"), iPush = sc.indexOf("scored.push({"), iTel = sc.indexOf("recordTelemetry(state, {");
H.ok(iGuard > 0 && iPush > iGuard && iPush - iGuard < 600, "legacy guard immediately precedes scored.push");
H.ok(iTel > 0 && iTel < iGuard, "telemetry is still recorded for every ticker before the guard");
const iEnf = sc.indexOf("if (BREAK_TRIGGER_ENFORCE) {"), iReg = sc.indexOf("state._gexRegime[liveStock.ticker] = _g.regime", iEnf);
H.ok(iEnf > 0 && iReg > iEnf, "gamma regime for the sleeves is still computed inside the ENFORCE block");

// slot gates: no score
H.ok(!/SLOT2_MIN_SCORE|SLOT3_MIN_SCORE|requires score >=/.test(sc), "score removed from call-slot gates");
H.ok(/slot 3 group \$\{_group3\} occupied/.test(sc) && /MAX_SIMULTANEOUS_CALLS = 3/.test(sc), "3-call cap and slot-3 uncorrelated-group rule kept");

// late ADX
H.ok(/const _iAdxMin = \(ITREND_LATE_ADX_ENABLED && _iH >= ITREND_LATE_START_ET\)/.test(sc), "ADX >= 40 after 11:00 only when the flag is on");
H.ok(/_iAdx < ITREND_LATE_ADX_MIN\)\s+_skip\.push\("adx<40"\)/.test(sc), "adx<40 still recorded as a label (skipBy)");

// daily circuit wording + throttle
const dc = H.extractBetween(sc, "if (todayPnL < dailyLossLimit && !dryRunMode", "state._dailyCircuitOpen = false;");
H.ok(/paperDataActive\(state\)/.test(dc) && /NOT halting \(paper data mode\)/.test(dc) && /logOnChange\("dailycircuit"/.test(dc) && !/logEvent\("warn"/.test(dc), "[DAILY CIRCUIT] says NOT halting in paper mode, on change / every 30 min");
// does paper mode really not halt? (the wording must match the gate)
H.ok(/const _circuitEntryHalt = !paperDataActive\(state\)/.test(sc), "paper data mode genuinely does not halt (_circuitEntryHalt)");

// IV-COVERAGE throttle: simulate the guarded block
const _end = "logEvent(\"filter\", `${ticker} findContract:";
const ivb = H.extractBetween(ex, "if (!state._ivCovLog) state._ivCovLog = {};", _end).slice(0, -_end.length);
const run = new Function("state", "ticker", "_bestRawIV", "logEvent", "_ivWin", "_covPct", "Date", ivb);
let t = 1e12; const D = { now: () => t }; const st = { _ivCoverage: { withIV: 1, total: 1 } }; const L = [];
for (let i = 0; i < 60; i++) { run(st, "SPY", 0.12, (a, m) => L.push(m), { withIV: 1, total: 1 }, "100", D); t += 10000; }
const n1 = L.length; run(st, "SPY", 0, (a, m) => L.push(m), { withIV: 0, total: 1 }, "99", D);
t += 16 * 60000; run(st, "SPY", 0, (a, m) => L.push(m), { withIV: 0, total: 1 }, "99", D);
H.ok(n1 === 1 && L.length === 3, "[IV-COVERAGE]: 60 calls in 10 min -> 1 line; logs again on change (IV missing) and after 15 min", `${n1} then ${L.length}`);
// 10/19: intraday-trend shadow-only
H.ok(C.ITREND_MODE === "live", "10/20: intraday-trend back to live (non-literature blocks removed); shadow branch kept for ITREND_MODE=shadow");
const iSh = sc.indexOf('if (ITREND_MODE === "shadow") {'), iEx = sc.indexOf("const _iOK = await executeTrade(");
const shBlk = sc.slice(iSh, iEx);
H.ok(iSh > 0 && iEx > iSh && /recordGateShadow\("itrend-shadow"/.test(shBlk) && /continue;/.test(shBlk),
  "shadow branch records the signal in the blocked-signal ledger and skips executeTrade");
H.ok(/state\._iTrendLast\[_iCoolKey\] = Date\.now\(\);/.test(shBlk), "the 30-min cooldown still starts on a shadow signal (one ledger row per signal, not per scan) — stamped inside the shadow branch since 10/28");
// 10/20: non-literature intraday-trend blocks off
H.ok(C.ITREND_NEG_GAMMA_BLOCK === true && C.ITREND_ADX_GATE === false && C.ITREND_BREADTH_GATE === false && C.ITREND_NEG_GAMMA_DIR_GATE === false, "10/20: ADX floor, breadth block, neg-gamma direction gate off; 10/29: negative gamma hands over to end-of-day momentum (block ON)");
H.ok(C.ITREND_START_ET === 9.75 && C.ITREND_END_ET === 15.25, "10/20: window = opening-range lock (9:45) to the 3:15 entry cutoff");
H.ok(/\(!ITREND_ADX_GATE \|\| _iAdx >= _iAdxMin\)/.test(sc) && /ITREND_BREADTH_GATE && _iBr >/.test(sc) && /if \(ITREND_NEG_GAMMA_DIR_GATE && _iGamma === "neg"/.test(sc), "each gate is behind its flag (ADX, breadth, direction)");
const gapBlk = H.extractBetween(sc, "const _skipForGap", "if (overnightGap > MAX_GAP_PCT && _gapDir < 0)");
H.ok(gapBlk.includes("if (!SLEEVES_BYPASS_LEGACY_SKIPS) {") && gapBlk.includes("overnight - skip`); continue; }") && /_legacySkipReason = `gap UP/.test(gapBlk), "gap-up > 3% no longer skips the sleeves (flags the legacy path only)");
const knife = H.extractBetween(sc, "MR call path blocked", "below-VWAP call ALLOWED");
H.ok(/if \(!SLEEVES_BYPASS_LEGACY_SKIPS\) continue;/.test(knife) && /_legacySkipReason = "below-VWAP falling knife/.test(knife), "below-VWAP knife block no longer skips the sleeves");
H.ok(sc.indexOf("if (_legacySkipReason) continue;") > 0 && sc.indexOf("if (_legacySkipReason) continue;") < sc.indexOf("scored.push({"), "legacy skips still stop the legacy / MR-scalp queue");
// 10/20: intraday-trend breaks the STANDARD 9:30-9:44 range
H.ok(C.ITREND_OR_SOURCE === "textbook", "intraday-trend uses the standard opening range");
{
  const DC = require(H.R("dayContext.js")); const st = {};
  const day = DC.etDateStr();
  const iso = (m) => { for (const off of [4, 5]) { const [y, mo, d] = day.split("-").map(Number); const t = new Date(Date.UTC(y, mo - 1, d, Math.floor(m / 60) + off, m % 60)); const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(t); if ((+p.find(x => x.type === "hour").value % 24) * 60 + +p.find(x => x.type === "minute").value === m) return t.toISOString(); } };
  const bars = []; for (let m = 570; m <= 600; m++) bars.push({ t: iso(m), o: 100, h: m === 571 ? 101.5 : 100.2, l: m === 574 ? 98.9 : 99.8, c: 100, v: 1000 });
  DC.updateDay(st, "SPY", bars);
  const t = st._dayCtx.SPY.orT;
  H.ok(t && t.done && t.hi === 101.5 && t.lo === 98.9, "standard range = true 9:30-9:44 bar high/low (catches the 9:31 spike and 9:34 low the sampled range misses)", JSON.stringify(t));
}
const orBlk = H.extractBetween(sc, "const _iorApex", "const _ior   = _iorStd || _iorApex;");
H.ok(/ITREND_OR_SOURCE === "textbook"/.test(orBlk) && /_t\.done && _t\.hi > 0 && _t\.lo > 0/.test(orBlk) && /_c\.day === DAYCTX\.etDateStr\(\)/.test(orBlk), "entry uses today's completed standard range, falls back to APEX's range if not ready");
H.done();
