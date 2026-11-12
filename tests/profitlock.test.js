// 11/11 (Harrison): daily profit lock — shadow only. Records when the day first reaches +$100/+$150/+$200 (and a 50%
// giveback after +$100) and scores "flatten there" / "no new entries after" against the actual close. Places nothing.
"use strict";
const H = require("./helpers"); H.quiet();
const PL = require(H.R("profitLock.js"));
const C = require(H.R("constants.js"));
const OUTCOME_HEADER = require(H.R("outcomes.js")).OUTCOME_HEADER.split(",");

H.ok(C.PROFIT_LOCK_MODE === "shadow" && PL.CFG.MODE === "shadow", "profit lock ships as shadow only");
H.ok(JSON.stringify(PL.ruleKeys()) === JSON.stringify(["+100", "+150", "+200", "giveback 50% after +100"]), "rules: +100, +150, +200, and a 50% giveback once up +100", PL.ruleKeys().join(" | "));

// 11/12/2026 is EST: 9:30 ET = 14:30Z.
const at = (hm) => { const [h, m] = hm.split(":").map(Number); return Date.parse("2026-11-12T14:30:00Z") + ((h * 60 + m) - 570) * 60000; };
const T = (total, real = 0) => ({ totalPnL: total, realizedPnL: real, unrealizedPnL: total - real });
const state = {}, LOG = [];
const log = (lvl, msg) => LOG.push(msg);

// a day that runs to +$230 by 12:00, then bleeds to -$175 by the close
const path = [["09:35", -20], ["10:30", 60], ["11:00", 120], ["11:30", 160], ["12:00", 230], ["13:00", 140], ["13:30", 110], ["14:00", 90], ["15:00", -60], ["15:55", -175]];
H.ok(PL.observe(state, T(500), at("09:00"), log) === null && !state._plock, "ignored before 9:30 ET");
H.ok(PL.observe(state, Object.assign(T(81000), { currentEquity: 81000 }), at("09:40"), log) === null && !state._plock, "a broken baseline (total = whole account) is ignored, not read as a target hit");
for (const [hm, v] of path) PL.observe(state, T(v), at(hm), log);
const s = state._plock;
H.ok(s.day === "2026-11-12" && s.peak === 230 && s.peakAt === "12:00:00", "tracks the day's peak", JSON.stringify([s.day, s.peak, s.peakAt]));
H.ok(s.hits["+100"].et === "11:00:00" && s.hits["+150"].et === "11:30:00" && s.hits["+200"].et === "12:00:00", "first crossing of each target is kept", [s.hits["+100"].et, s.hits["+150"].et, s.hits["+200"].et].join(" "));
H.ok(s.hits["giveback 50% after +100"].et === "13:30:00" && s.hits["giveback 50% after +100"].tot === 110, "giveback fires the first time the day is at or below half its peak (230 -> 110 <= 115)");
H.ok(LOG.filter(l => /\[PROFIT-LOCK\] SHADOW/.test(l)).length === 4 && LOG.every(l => /Nothing changed/.test(l)), "one log line per trigger, each says nothing was changed");
PL.observe(state, T(240), at("16:30"), log);
H.ok(s.peak === 230, "ignored after 16:00 ET");

// trades: options rows (outcome CSV strings) and stocks-sleeve fills
const row = (openET, pnl, date = "2026-11-12") => { const f = OUTCOME_HEADER.map(() => ""); f[OUTCOME_HEADER.indexOf("date")] = date; f[OUTCOME_HEADER.indexOf("openET")] = openET; f[OUTCOME_HEADER.indexOf("pnl")] = String(pnl); f[OUTCOME_HEADER.indexOf("ticker")] = "QQQ"; f[OUTCOME_HEADER.indexOf("eSkipBy")] = "\"adx<40,gex-neg\""; return f.join(","); };
state._outcomeBuffer = [row("10:49:53", 58), row("11:20:01", 60), row("12:20:13", 38), row("13:50:41", -160), row("14:59:17", -35), row("15:14:52", 0), row("13:50:00", 999, "2026-11-11")];
state._sip = { day: "2026-11-12", cands: [{ filledAt: new Date(at("09:36")).toISOString(), pnl: -40 }, { filledAt: new Date(at("13:00")).toISOString(), pnl: -20 }, { status: "not triggered" }] };
state._alpacaTruth = T(-175);
const tr = PL.dayTrades("2026-11-12", state._outcomeBuffer, state._sip);
H.ok(tr.length === 8 && !tr.some(t => t.pnl === 999), "day trades = today's option rows + filled stock trades (other days and unfilled ignored)", tr.length);
H.ok(PL.splitCSV('a,"b,c",d').length === 3, "CSV split respects quoted commas");

const out = PL.finalize(state, at("16:05"));
const r150 = out.today.rules["+150"];
// after 11:30: 12:20 +38, 13:00 stock -20, 13:50 -160, 14:59 -35, 15:14 0 = -177
H.ok(r150.hit && r150.at === "11:30:00" && r150.flatten === 160 && r150.afterN === 5 && r150.afterPnl === -177 && r150.noNew === 2, "+150: flatten = +$160; no new entries = close -175 minus the -177 opened after = +$2", JSON.stringify(r150));
const rg = out.today.rules["giveback 50% after +100"];
H.ok(rg.hit && rg.flatten === 110 && rg.afterN === 3 && rg.afterPnl === -195 && rg.noNew === 20, "giveback: flatten +$110; no new entries +$20", JSON.stringify(rg));
H.ok(out.totals.find(x => x.rule === "+150").hit === 1 && out.totals.find(x => x.rule === "+150").actual === -175, "running totals start with today");

// a second day that never gets going: rules not hit count the actual close
state._plock = null;
PL.observe(state, T(30), at("10:00") + 864e5, log); PL.observe(state, T(-80), at("15:55") + 864e5, log);
state._alpacaTruth = T(-80);
const out2 = PL.finalize(state, at("16:05") + 864e5);
const t150 = out2.totals.find(x => x.rule === "+150");
H.ok(out2.today.rules["+150"].hit === false && t150.days === 2 && t150.hit === 1 && t150.actual === -255 && t150.flatten === 80 && t150.noNew === -78, "day 2 not hit: running actual -255, flatten +80, no-new -78", JSON.stringify(t150));
PL.finalize(state, at("16:06") + 864e5);
H.ok(state._plockHist.days.length === 2, "finalizing twice the same day does not double count");

const html = PL.eodSection(out2);
H.ok(/Profit lock — shadow \(nothing was stopped\)/.test(html) && /not reached/.test(html) && /1\/2/.test(html), "EOD section renders today + running");
H.ok(PL.eodSection(null) === "", "no section without data");

// wiring
const srv = H.read("server.js"), rep = H.read("reporting.js");
H.ok(/state\._alpacaTruth = truth;\n\s+try \{ require\("\.\/profitLock"\)\.observe\(state, truth, Date\.now\(\), logEvent\)/.test(srv), "server.js: every 5-min Alpaca truth refresh feeds the shadow");
H.ok(/plock:\s+\(\(\) => \{ try \{ return require\('\.\/profitLock'\)\.finalize\(state\)/.test(rep) && /require\('\.\/profitLock'\)\.eodSection\(_eodSnap\.plock\)/.test(rep), "reporting.js: scored in the EOD snapshot (before the buffers clear) and shown in the email");
H.ok(!/profitLock/.test(H.read("scanner.js")) && !/profitLock/.test(H.read("execution.js")), "nothing in the entry/order path reads it (shadow)");

H.done();
