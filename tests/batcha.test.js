// Batch A (10/15): data-quality fixes + flow measurement + hold-to-close shadows. Real code throughout — modules
// required directly, scanner/server snippets extracted. No network (mock broker for option quotes).
"use strict";
const H = require("./helpers"); H.quiet();

const QUOTES = {};
H.mockBroker({ get: (u) => {
  const m = /symbols=([^&]+)/.exec(u); if (!m) return null;
  const q = QUOTES[m[1]]; return q ? { snapshots: { [m[1]]: { latestQuote: { bp: q[0], ap: q[1] } } } } : { snapshots: {} };
} });
const S = require(H.R("state.js")); const state = S.state;
const sc = H.read("scanner.js"), sv = H.read("server.js");
const DAYCTX = require(H.R("dayContext.js"));
const today = DAYCTX.etDateStr(Date.now());

(async () => {
  try {
    // ---- 9. gap-day open price check: no TODAY bar -> the quote is trusted ----
    const ps = H.extractBetween(sc, "    const _todayET = DAYCTX.etDateStr(Date.now());", "        _r.price = parseFloat(_ref.toFixed(2));\n      }\n    }");
    const runPS = new Function("results", "DAYCTX", "logEvent", ps);
    const yBar = { t: "2026-01-02T05:00:00Z", c: 743.57 }, tBar = { t: today + "T13:30:00Z", c: 743.57 };
    let r1 = [{ stock: { ticker: "QQQ" }, price: 737.75, intradayBars: [], bars: [yBar] }]; runPS(r1, DAYCTX, () => {});
    let r2 = [{ stock: { ticker: "QQQ" }, price: 737.75, intradayBars: [], bars: [tBar] }]; runPS(r2, DAYCTX, () => {});
    let r3 = [{ stock: { ticker: "QQQ" }, price: 737.75, intradayBars: [{ c: 743.57 }], bars: [yBar] }]; runPS(r3, DAYCTX, () => {});
    H.ok(r1[0].price === 737.75 && r2[0].price === 743.57 && r3[0].price === 743.57,
      "price check: yesterday's daily bar is no longer a reference (gap-day quote kept); today's bars still are", JSON.stringify([r1[0].price, r2[0].price, r3[0].price]));
    H.ok(/const vwap = signals\.intradayVWAP > 0 \? signals\.intradayVWAP : price;/.test(sc), "no intraday VWAP yet -> VWAP = price (was a 5-DAILY-bar average)");

    // ---- 11. status lines only on change ----
    const loc = new Function("logEvent", H.extractBetween(sc, "const _logSig = new Map();", "if (!p || p.sig !== sig || now - p.at >= everyMs) { _logSig.set(key, { sig, at: now }); logEvent(type, msg); }\n}") + "\nreturn logOnChange;");
    const got = []; const logOnChange = loc((t, m) => got.push(m));
    const realNow = Date.now; let now = realNow(); Date.now = () => now;
    for (let i = 0; i < 30; i++) { logOnChange("gap:QQQ", "gap-down-holding", "scan", "line " + i); now += 10000; }
    logOnChange("gap:QQQ", "gap-down-reclaimed", "scan", "changed");
    now += 15 * 60000; logOnChange("gap:QQQ", "gap-down-reclaimed", "scan", "heartbeat");
    Date.now = realNow;
    H.ok(got.length === 3 && got[1] === "changed" && got[2] === "heartbeat", "30 identical [GAP] scans -> 1 line; a change logs; a 15-min heartbeat logs", JSON.stringify(got));
    H.ok(/logOnChange\(`gap:\$\{stock\.ticker\}`/.test(sc) && /logOnChange\(`vwap:\$\{stock\.ticker\}`/.test(sc) && /_gxSig/.test(sc) && /_gexFetchLog\(ticker/.test(H.read("execution.js")),
      "[GAP], [VWAP], [GEX] and [GEX-FETCH] all go through on-change logging");

    // disabled agent: no freshness warning for _agentMacro, no health counter
    state._agentMacro = { signal: "neutral" }; state._freshness = { _agentMacro: Date.now() - 10 * 864e5 };
    const before = (state._dailyLogBuffer || []).length; S.auditFreshness();
    H.ok(!(state._dailyLogBuffer || []).slice(before).some(e => /FRESHNESS/.test(e.message || "")), "disabled agent: no [FRESHNESS] warning for its output");
    H.ok(/if \(!AGENT_ENABLED\) return null;   \/\/ 10\/15/.test(H.read("agent.js")) && /agentAuthAge > 30 && !dryRunMode && AGENT_ENABLED/.test(sc) && /agentStale && !dryRunMode && AGENT_ENABLED/.test(sc),
      "disabled agent: no timeout count, no [MACRO]/[AGENT] staleness warnings");

    // ---- 12/13. EOD label + telemetry order ----
    H.ok(/Realized today: \$\{/.test(H.read("reporting.js")) && !/Daily P&L: \$\{parseFloat\(daily\)/.test(H.read("reporting.js")), "EOD summary: realized and account change labelled separately");
    const { telemetryCSV, TELEMETRY_HEADER, recordTelemetry } = require(H.R("telemetry.js"));
    H.ok(telemetryCSV(["11:14:24,QQQ", "09:30:12,SPY", "10:00:00,QQQ"]).split("\n").slice(1).map(l => l.slice(0, 5)).join(" ") === "09:30 10:00 11:14", "telemetry attachment is time-sorted");
    const tst = { _telemetryLast: {} };
    recordTelemetry(tst, { tkr: "QQQ", px: 730, rROD: -1.7, hedgeFlow: "with-move", rebalDir: "sell", pinStrike: 730, distPin: -0.07, toME: 11, fromMS: 11, tom: "N", cwRaw: 740, pwRaw: 730 });
    const row = (tst._telemetryBuffer || [])[0] || "";
    H.ok(row.split(",").length === TELEMETRY_HEADER.split(",").length && /,with-move,sell,730,-0.07,11,11,N,740,730$/.test(row), "telemetry: 10 new flow columns, row width = header width", `${row.split(",").length}/${TELEMETRY_HEADER.split(",").length}`);

    // ---- 14. wall hysteresis ----
    const GEX = require(H.R("gex.js"));
    const hs = {}; let t0 = Date.now(); const realNow2 = Date.now; let tn = t0; Date.now = () => tn;
    const step = (c, p, px = 772) => GEX.applyWallHysteresis(hs, "SPY", { callWall: c, putWall: p }, px, 6);
    let g = step(775, 770);
    tn += 2 * 60000; g = step(780, 770); const held1 = g.callWall;
    tn += 2 * 60000; g = step(775, 770); const back = g.callWall;
    tn += 1 * 60000; g = step(780, 770);
    tn += 4 * 60000; g = step(780, 770); const held2 = g.callWall;
    tn += 3 * 60000; g = step(780, 770); const switched = g.callWall;
    Date.now = realNow2;
    H.ok(held1 === 775 && back === 775 && held2 === 775 && switched === 780 && g.callWallRaw === 780 && Math.abs(g.distCallWallPct - (780 - 772) / 772 * 100) < 0.001,
      "wall hysteresis: a new strike needs 6 straight minutes; a flip back resets; distances follow the held wall", JSON.stringify([held1, back, held2, switched]));
    H.ok((sc.match(/GEX\.applyWallHysteresis\(/g) || []).length === 2, "both GEX call sites use the wall hysteresis");

    // ---- 10. restart visibility ----
    H.ok(/\[BOOT\] APEX started — deploy/.test(sv) && sv.indexOf("[BOOT] APEX started") > sv.indexOf("await restoreBuffersFromRedis();"), "[BOOT] line written after the day's log buffer is restored");
    H.ok(/process\.on\("uncaughtException"/.test(sv) && /\[CRASH\] Uncaught exception/.test(sv) && /process\.exit\(1\)/.test(sv), "uncaught exceptions are logged, saved (capped) and exit non-zero");
    H.ok(/logEvent\("scan", `\[SHUTDOWN\] \$\{signal\} — clean shutdown/.test(sv), "clean shutdowns are in the session log");

    // ---- flows.js ----
    const F = require(H.R("flows.js"));
    const fst = { _dayCtx: { QQQ: { day: today, prevClose: 743.57 } },
      _gexChain: { QQQ: { call: { rows: [{ strike: 730, oi: 5000, exp: "2026-10-15" }, { strike: 735, oi: 9000, exp: "2026-10-15" }, { strike: 735, oi: 99999, exp: "2026-10-16" }] },
                          put: { rows: [{ strike: 730, oi: 8000, exp: "2026-10-15" }, { strike: 700, oi: 99999, exp: "2026-10-15" }] } } } };
    const f = F.compute(fst, "QQQ", 730.5, Date.now(), { regime: "neg", netGexM: -3000 });
    H.ok(f.rROD === +((730.5 - 743.57) / 743.57 * 100).toFixed(3) && f.hedgeFlow === "with-move" && f.rebalDir === "sell" && f.pinStrike === 730 && f.pinOI === 13000,
      "flows: day's move, dealer hedging with the move in negative gamma, sell-side rebalancing, pin = nearest-expiry max-OI strike within 2%", JSON.stringify(f));
    H.ok(F.compute(fst, "QQQ", 750, Date.now(), { regime: "pos" }).hedgeFlow === "against-move", "flows: positive gamma -> hedging against the move");
    const me = ["2026-10-30", "2026-11-02", "2026-11-04", "2026-11-05", "2026-10-29"].map(d => F.monthEdge(d).tom);
    H.ok(JSON.stringify(me) === "[true,true,true,false,false]" && F.monthEdge("2026-11-30").toME === 0 && F.monthEdge("2026-11-27").toME === 1,
      "flows: turn of month = last trading day + first three (holidays skipped)", JSON.stringify(me));
    const o = require(H.R("outcomes.js"));
    H.ok(o.OUTCOME_HEADER.includes("eRROD,eHedgeFlow,eRebalDir,eDistPin,eToME,eTOM") && /_flow: +\(\(\) => \{ try \{ return require\('\.\/flows'\)\.snapshot/.test(H.read("execution.js")),
      "outcomes: flow state stamped at entry (6 new columns)");

    // ---- 4. blocked signals: hold-to-close marks ----
    const gst = {};
    const rec = new Function("state", "markDirty", "FLOWS", H.extractBlock(sc, "function recordGateShadow(gate, sleeve, ticker, side, px, ctx)", { includeHead: true }) + "\nreturn recordGateShadow;")(gst, () => {}, { snapshot: () => ({ rROD: -0.4, hedgeFlow: "with-move", tom: false }) });
    const stampSrc = H.extractBetween(sc, "    // 10/14: GATE-SHADOW forward stamps", "      } catch (_gsErr) { /* observational */ }\n    }");
    const stamp = new Function("state", "stock", "price", "vwap", "etHourNow", stampSrc);
    const rn = Date.now; let tt = rn(); Date.now = () => tt;
    rec("itrend-neg-gamma", "intraday-trend", "SPY", "put", 773.39, { adx: 27 });
    const gr = gst._gateShadow[0];
    H.ok(gr.ctx.adx === 27 && gr.ctx.hedge === "with-move" && gr.ctx.rROD === -0.4 && gr.closeDone === false, "blocked signal carries the flow state");
    const path = [[10, 773.0, 773.6, 10.17], [30, 772.5, 773.4, 10.5], [120, 771.5, 772.9, 12], [300, 770.2, 771.0, 15.0], [355, 769.5, 770.5, 15.92]];
    for (const [m, p, v, h] of path) { tt = gr.at + m * 60000; stamp(gst, { ticker: "SPY" }, p, v, h); }
    const fav = (p) => +(-(p - 773.39) / 773.39 * 100).toFixed(3);
    H.ok(gr.done && gr.f30 === fav(772.5) && gr.fClose === fav(769.5) && gr.vTrail === fav(769.5) && gr.closeDone,
      "blocked put held to 3:55 (+0.50%); never crossed VWAP against it, so the VWAP trail also ran to the close", JSON.stringify({ f30: gr.f30, fClose: gr.fClose, vTrail: gr.vTrail }));
    rec("itrend-neg-gamma", "intraday-trend", "QQQ", "put", 732.7, {});
    const q = gst._gateShadow[1];
    for (const [m, p, v, h] of [[10, 732.0, 732.8, 12], [40, 733.2, 733.0, 12.5], [200, 728, 730, 15.92]]) { tt = q.at + m * 60000; stamp(gst, { ticker: "QQQ" }, p, v, h); }
    Date.now = rn;
    H.ok(q.vTrail === +(-(733.2 - 732.7) / 732.7 * 100).toFixed(3) && q.vTrailMin === 40 && q.fClose === +(-(728 - 732.7) / 732.7 * 100).toFixed(3),
      "VWAP trail exits on the first cross against the trade; the to-close mark still records the full move", JSON.stringify({ vTrail: q.vTrail, min: q.vTrailMin, fClose: q.fClose }));
    const rep = require(H.R("reporting.js"));
    const csv = rep.gateShadowCSV(gst._gateShadow).split("\n");
    H.ok(csv[0].split(",").includes("favClose") && csv[1].split(",").length === csv[0].split(",").length && /hedge=with-move/.test(csv[1]), "gate-shadow CSV: hold-to-close columns, aligned", csv[1]);
    const html = rep.buildGateShadowSection({ gateShadow: gst._gateShadow }).replace(/<[^>]+>/g, " ");
    H.ok(/held to 3:55/.test(html) && /VWAP-trail exit/.test(html), "EOD section shows hold-to-close columns");

    // ---- 5. intraday-trend hold-to-close shadow on the live contract ----
    const HOLD = require(H.R("holdShadow.js"));
    state._holdShadow = [];
    const pos = { ticker: "QQQ", optionType: "call", contractSymbol: "QQQ261023C00735000", signalId: "QQQ-call-itrend-1", premium: 6.0, contracts: 2, _iTrend: true };
    HOLD.open(pos, 735.0); HOLD.open(pos, 735.0);
    H.ok(state._holdShadow.length === 1, "one shadow per live entry");
    const hr = state._holdShadow[0]; const rn2 = Date.now; let th = rn2(); Date.now = () => th;
    th = hr.at + 10 * 60000; await HOLD.step("QQQ", 736, 734.5, 10.5);
    QUOTES[pos.contractSymbol] = [6.9, 7.1];
    th = hr.at + 50 * 60000; await HOLD.step("QQQ", 734.2, 734.6, 11.2);   // below VWAP -> trail exit
    QUOTES[pos.contractSymbol] = [7.9, 8.1];
    th = hr.at + 300 * 60000; await HOLD.step("QQQ", 738, 735, 15.92);
    Date.now = rn2;
    H.ok(hr.vTrailMin === 50 && hr.vTrailOpt === 7 && hr.closeOpt === 8 && hr.done, "trail exit priced at the real quote ($7.00); close mark at $8.00", JSON.stringify({ min: hr.vTrailMin, v: hr.vTrailOpt, c: hr.closeOpt }));
    const hdr = o.OUTCOME_HEADER, cols = hdr.split(",");
    const orow = cols.map(c => c === "signalId" ? "QQQ-call-itrend-1" : c === "pnl" ? "-62" : c === "exitReason" ? "itrend-noarm" : c === "eSkipBy" ? '"a,b"' : "");
    const hcsv = HOLD.csv(state._holdShadow, [orow.join(",")], hdr).split("\n");
    const hc = hcsv[1].split(",");
    H.ok(hc[8] === "-62" && hc[9] === "itrend-noarm" && hc[13] === "200" && hc[16] === "400", "CSV joins the live result by signalId (quoted commas handled): live -$62 vs trail +$200 vs held +$400", hcsv[1]);
    const hsec = HOLD.section(state._holdShadow, [orow.join(",")], hdr).replace(/<[^>]+>/g, " ");
    H.ok(/live exits -\$62 · VWAP-trail exit \+\$200 · held to 3:55 \+\$400/.test(hsec), "EOD section totals", hsec.trim().slice(0, 120));
    H.ok(/HOLD\.open\(_ip, price\)/.test(sc) && /await HOLD\.step\(stock\.ticker, price, vwap, etHourNow\)/.test(sc) && /state\._holdShadow = \[\];   \/\/ 10\/15/.test(H.read("state.js")),
      "wired: opened on every intraday-trend fill, stepped every scan, reset daily");

    // ---- 3. negative-gamma fades off ----
    H.ok(require(H.R("mrStrategy.js")).MR.NEG_GAMMA_FADE === true, "10/28: negative-gamma MR fades ON (paper experiment, strict wall + CVD path)");
  } catch (e) { H.ok(false, "batch A test crashed", e.stack.split("\n").slice(0, 4).join(" | ")); }
  H.done();
})();
