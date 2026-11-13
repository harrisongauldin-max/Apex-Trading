// 11/13 (Harrison): each intraday-trend entry records how long ago the day's high (call) / low (put) was set and how far
// price is off it — a label only (skipBy "ext-stale90" at 90+ min, plus outcome columns eExtMin/eExtPull).
"use strict";
const H = require("./helpers"); H.quiet();
const SE = require(H.R("sessionExt.js"));

// 11/16/2026 is EST: 9:30 ET = 14:30Z
const at = (hm, d = "2026-11-16") => { const [h, m] = hm.split(":").map(Number); return Date.parse(`${d}T14:30:00Z`) + ((h * 60 + m) - 570) * 60000; };
const st = {};
H.ok(SE.update(st, "SPY", 760, at("09:20")) === null && !st._sessExt, "ignored before 9:30 ET");
[["09:31", 755], ["10:00", 758], ["11:22", 762.77], ["11:40", 761], ["12:30", 759], ["13:10", 757.5]].forEach(([t, p]) => SE.update(st, "SPY", p, at(t)));
const e = st._sessExt.SPY;
H.ok(e.hi === 762.77 && e.lo === 755 && e.day === "2026-11-16", "running high/low kept per ticker per ET day");
const c = SE.at(st, "SPY", "call", 757.5, at("13:10"));
H.ok(c.min === 108 && Math.abs(c.pullPct - 0.6909) < 0.001, "call: 108 min since the 11:22 high, 0.69% off it", JSON.stringify(c));
const p = SE.at(st, "SPY", "put", 757.5, at("13:10"));
H.ok(p.min === 219 && Math.abs(p.pullPct - 0.3311) < 0.001, "put: measured from the session low (9:31), 0.33% above it", JSON.stringify(p));
H.ok(SE.at(st, "SPY", "call", 762.9, at("13:11")).pullPct < 0, "a price above the recorded high reads as a negative pullback (new high this scan)");
SE.update(st, "SPY", 763, at("13:12"));
H.ok(SE.at(st, "SPY", "call", 763, at("13:12")).min === 0, "a new high resets the clock");
H.ok(SE.at(st, "QQQ", "call", 690, at("13:12")) === null, "no record for a ticker -> null (entry still proceeds, label blank)");
SE.update(st, "SPY", 740, at("09:35", "2026-11-17"));
H.ok(st._sessExt.SPY.hi === 740 && st._sessExt.SPY.day === "2026-11-17", "a new ET day starts fresh");
H.ok(SE.at(st, "SPY", "call", 740, at("15:00", "2026-11-18")) === null, "yesterday's record is never used");
H.ok(SE.STALE_MIN === 90, "stale tag at 90+ min");

// wiring: scanner updates every scan (not only when intraday trend evaluates), tags the entry, never blocks it
const sc = H.read("scanner.js");
H.ok(/if \(liveStock && price > 0\) \{ try \{ SESSEXT\.update\(state, liveStock\.ticker, price\); \} catch \(_seErr\) \{\} \}[^\n]*\n\s+if \(ITREND_ENABLED && liveStock && price > 0\)/.test(sc), "scanner: session high/low updated on every scan, before (and outside) the intraday-trend gate");
H.ok(/if \(_ext && _ext\.min >= SESSEXT\.STALE_MIN\)\s+_skip\.push\("ext-stale90"\);/.test(sc), "entry is tagged ext-stale90 at 90+ min (a would-skip label)");
H.ok(/extMin: _ext \? _ext\.min : null, extPullPct: _ext \? _ext\.pullPct : null/.test(sc), "minutes + % off stored on the entry meta");
const skipUse = sc.split("\n").filter(l => /_skip\b/.test(l) && /return|continue|block/.test(l) && !/\/\//.test(l.split("_skip")[0]));
H.ok(skipUse.length === 0, "skip labels never block an entry", skipUse.join(" | "));

// outcome columns line up
const O = require(H.R("outcomes.js"));
const hdr = O.OUTCOME_HEADER.split(",");
H.ok(hdr.slice(-2).join(",") === "eExtMin,eExtPull", "outcome CSV ends with eExtMin,eExtPull");
const row = O.buildOutcomeRow({ ticker: "SPY", optionType: "call", _iMeta: { extMin: 96, extPullPct: 0.43, skipBy: ["ext-stale90"] }, openDate: new Date(at("13:01")).toISOString(), contracts: 1, premium: 3.23 },
                              { exitPrice: 3.06, exitReason: "itrend-noarm", pnl: -17 });
const f = row.split(",");
H.ok(f.length === hdr.length && f[f.length - 2] === "96" && f[f.length - 1] === "0.43", "row has the same column count; last two = 96, 0.43", `${f.length} vs ${hdr.length}: ${f.slice(-2)}`);
H.done();
