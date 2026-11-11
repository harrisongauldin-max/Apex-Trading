// Gate-shadow ledger (10/14): signals a rule blocked, stamped with where price went next in the trade's direction.
// Real code, extracted from scanner.js (recorder + stamping loop) and reporting.js (CSV + EOD section).
"use strict";
const H = require("./helpers"); H.quiet();
const sc = H.read("scanner.js");
const state = {}; const markDirty = () => {};
const rec = new Function("state", "markDirty", H.extractBlock(sc, "function recordGateShadow(gate, sleeve, ticker, side, px, ctx)", { includeHead: true }) + "\nreturn recordGateShadow;")(state, markDirty);
const stampSrc = H.extractBetween(sc, "    // 10/14: GATE-SHADOW forward stamps", "      } catch (_gsErr) { /* observational */ }\n    }");
const stamp = new Function("state", "stock", "price", stampSrc);
const realNow = Date.now; let now = realNow(); Date.now = () => now;

rec("itrend-neg-gamma", "intraday-trend", "SPY", "put", 773.31, { adx: 27, gexNetM: -3052 });
rec("itrend-neg-gamma", "intraday-trend", "SPY", "put", 773.04, { adx: 30 });          // 9 min later in real life — deduped (15 min)
H.ok(state._gateShadow.length === 1, "one row per rule/ticker/side per 15 min");
const path = [[5, 772.9], [10, 773.0], [20, 773.1], [25, 772.5], [30, 772.86]];
for (const [m, p] of path) { now = state._gateShadow[0].at + m * 60000; stamp(state, { ticker: "SPY" }, p); stamp(state, { ticker: "QQQ" }, 1); }
const r = state._gateShadow[0];
const pct = (p) => +(-(p - 773.31) / 773.31 * 100).toFixed(3);   // put: price DOWN = favourable
H.ok(r.f10 === pct(773.0) && r.f20 === pct(773.1) && r.f30 === pct(772.86) && r.done, "10/20/30-min marks, signed for a put", JSON.stringify({ f10: r.f10, f20: r.f20, f30: r.f30 }));
H.ok(r.mfe === pct(772.5) && r.mae === Math.min(0, pct(773.1)), "best and worst within 30 min", `best ${r.mfe} worst ${r.mae}`);
now += 20 * 60000; rec("itrend-neg-gamma", "intraday-trend", "SPY", "put", 772.0, {});
H.ok(state._gateShadow.length === 2, "a new row after 15 min");
rec("x", "y", "SPY", "flat", 770, {}); rec("x", "y", "SPY", "call", 0, {});
H.ok(state._gateShadow.length === 2, "ignores bad side / price");

Date.now = realNow;
const ng = H.extractBlock(sc, 'if (ITREND_NEG_GAMMA_BLOCK && _iGamma === "neg") {', { includeHead: true });
const calls = [];
new Function("ITREND_NEG_GAMMA_BLOCK", "_iGamma", "state", "liveStock", "_iSide", "_iAdx", "price", "recordGateShadow", "recordStandDown", "logEvent", "logOnChange", "let _iSuppressed = false;\n" + ng)(
  true, "neg", { _gexNow: { SPY: { netGexM: -3052.4 } } }, { ticker: "SPY" }, "put", 27.2, 773.31, (...a) => calls.push(a), () => {}, () => {}, () => {});
H.ok(calls.length === 1 && calls[0][0] === "itrend-neg-gamma" && calls[0][3] === "put" && calls[0][5].gexNetM === -3052, "the negative-gamma stand-aside records the blocked signal (side captured before it is cleared)", JSON.stringify(calls[0]));
const rep = require(H.R("reporting.js"));
const rows = [{ gate: "itrend-neg-gamma", sleeve: "intraday-trend", ticker: "SPY", side: "put", at: Date.now(), px: 773.31, ctx: { adx: 27 }, f10: 0.04, f20: 0.03, f30: 0.06, mfe: 0.07, mae: -0.05, done: true },
              { gate: "mr-fade-vs-daily-trend", sleeve: "mr-fade", ticker: "QQQ", side: "call", at: Date.now(), px: 736, ctx: null, f10: -0.1, f20: -0.2, f30: -0.15, mfe: 0.12, mae: -0.3, done: true },
              { gate: "itrend-neg-gamma", sleeve: "intraday-trend", ticker: "SPY", side: "put", at: Date.now() - 3 * 864e5, px: 770, f30: 1, mfe: 1, done: true }];   // an old day: excluded
const csv = rep.gateShadowCSV(rows), lines = csv.split("\n");
H.ok(lines.length === 3 && lines[0].split(",").length === lines[1].split(",").length && /adx=27/.test(lines[1]), "CSV: today's rows only, aligned columns, context kept", lines[1]);
const html = rep.buildGateShadowSection({ gateShadow: rows }).replace(/<[^>]+>/g, " ");
H.ok(/itrend-neg-gamma\s+1\s+\+0\.060%\s+0%/.test(html) && /mr-fade-vs-daily-trend\s+1\s+-0\.150%\s+100%/.test(html), "EOD section: per-rule count, avg 30-min move, share reaching +0.10%", html.replace(/\s+/g, " ").slice(0, 160));
H.done();
