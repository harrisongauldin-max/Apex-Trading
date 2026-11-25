// Flow harness v1.4 (11/25): T9 overnight hold, T10 five-ETF trend (Faber), T11 put credit spread from two Cboe indexes.
// Synthetic series with KNOWN answers, plus /api/flow-backtest?tests=B2 end to end with Alpaca and Cboe mocked.
"use strict";
const H = require("./helpers"); H.quiet();
const FB = require(H.R("flowBacktest.js"));

let seed = 2025; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
function weekdays(from, n) { const out = []; let t = Date.parse(from + "T12:00:00Z"); while (out.length < n) { const dw = new Date(t).getUTCDay(); if (dw && dw < 6) out.push(new Date(t).toISOString().slice(0, 10)); t += 864e5; } return out; }
const DAYS = weekdays("2016-01-04", 2600), LAST = DAYS[DAYS.length - 1];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  try {
    // ───────── pass lines exist and say when they were written ─────────
    H.ok(/BEFORE T9, T10 or T11 were ever computed/.test(H.read("flowBacktest.js")) && FB.PASS.T9 && FB.PASS.T10 && FB.PASS.T11, "pass lines T9 / T10 / T11 are in the file, marked as written before any run");
    H.ok(/2 bp a night/.test(FB.PASS.T9) && /buy-and-hold/.test(FB.PASS.T9) && /both halves/.test(FB.PASS.T9), "T9 line: net of 2 bp a night, against buy-and-hold, both halves");
    H.ok(/SPY, EFA, IEF, VNQ, DBC/.test(FB.PASS.T10) && /NEXT session/.test(FB.PASS.T10) && />= 0\.5/.test(FB.PASS.T10) && /BIL/.test(FB.PASS.T10), "T10 line: the five ETFs, traded the session after the month-end, Sharpe >= 0.5, cash = BIL");
    H.ok(/PUT \+ PPUT − SPY total return/.test(FB.PASS.T11) && /T8 line/.test(FB.PASS.T11), "T11 line: PUT + PPUT − SPY, graded like T8");

    // ───────── T9 ─────────
    const bars = (onBp, idBp, idVol = 0.008, onVol = 0.002) => { let c = 100; return DAYS.map(d => { const o = c * (1 + onBp / 1e4 + gauss() * onVol); c = o * (1 + idBp / 1e4 + gauss() * idVol); return { date: d, o, c }; }); };
    const good = FB.t9(bars(8, -3), { asOf: LAST });
    H.ok(good.grade === "PASS" && near(good.perNightGross.mean, 8, 1.2) && near(good.perNight.mean, good.perNightGross.mean - 2, 1e-9) && good.night.sharpe > good.hold.sharpe && good.n === DAYS.length - 1,
      "T9: +8 bp a night planted, noisy flat days -> PASS; net = gross − 2 bp exactly", `net ${good.perNight.mean.toFixed(2)} bp, Sharpe ${good.night.sharpe.toFixed(2)} vs hold ${good.hold.sharpe.toFixed(2)}`);
    const thin = FB.t9(bars(1.5, 4, 0.004), { asOf: LAST });
    H.ok(thin.grade === "fail" && thin.perNight.mean < 0.8 && thin.perNightGross.mean > 0, "T9: +1.5 bp a night does not cover 2 bp of costs -> fail (gross is still reported)", `net ${thin.perNight.mean.toFixed(2)} bp`);
    // the return is all in the day session: overnight has nothing -> fail, and the open-to-close leg shows where it was
    const dayOnly = FB.t9(bars(0, 6, 0.006), { asOf: LAST });
    H.ok(dayOnly.grade === "fail" && dayOnly.perDay.mean > 3 && dayOnly.hold.cagr > 0.05, "T9: return earned in the day session -> fail; the open-to-close leg is reported");
    // drawdown leg of the line: a single −30% gap down overnight (hold has it too, but hold also has the day-session recovery)
    const gap = bars(8, 0, 0.0005, 0.0005); { const k = 1500; gap[k].o = gap[k - 1].c * 0.7; let c = gap[k].o * 1.43; gap[k].c = c; for (let i = k + 1; i < gap.length; i++) { const o = c * (1 + 8 / 1e4); c = o; gap[i] = { date: gap[i].date, o, c }; } }
    const g9 = FB.t9(gap, { asOf: LAST });
    H.ok(g9.night.maxDD < -0.29 && g9.hold.maxDD > -0.05 && g9.grade === "fail", "T9: a −30% overnight gap that the day session recovers -> overnight drawdown is deeper than buy-and-hold's -> fail", `${(g9.night.maxDD * 100).toFixed(1)}% vs ${(g9.hold.maxDD * 100).toFixed(1)}%`);
    H.ok(FB.t9(bars(8, -3), { asOf: "2027-06-01" }).grade === "INCOMPLETE" && FB.t9(bars(8, -3).slice(0, 300), { asOf: LAST }).note, "T9: stale data -> INCOMPLETE; too little history -> not run");

    // ───────── T10 ─────────
    const flat = (r) => { const o = {}; let c = 100; for (const d of DAYS) { c *= 1 + r; o[d] = c; } return o; };
    const noisy = (r, vol) => { const o = {}; let c = 100; for (const d of DAYS) { c *= 1 + r + gauss() * vol; o[d] = c; } return o; };
    const BIL = flat(0.02 / 252);
    // (a) every ETF rises every day -> always held -> trend and hold are the same book
    const up = { SPY: noisy(0.0005, 0.0006), EFA: noisy(0.0004, 0.0006), IEF: noisy(0.0003, 0.0004), VNQ: noisy(0.0004, 0.0006), DBC: noisy(0.0004, 0.0006), BIL };
    const a = FB.t10(up, { asOf: LAST });
    const mEnds = [...new Set(DAYS.map(d => d.slice(0, 7)))].length - 1;   // the last month has no month-end in the data
    H.ok(a.monthsTraded === mEnds - 9 && a.from > "2016-10-31" && a.from < "2016-11-05", "T10: first trade is the session after the 10th month-end (Nov 2016); one trade per month after", `${a.monthsTraded} trades from ${a.from}`);
    H.ok(Object.values(a.trend.inShare).every(x => x === 1) && near(a.trend.sharpeX, a.hold.sharpeX, 1e-9) && near(a.trend.stats.cagr, a.hold.stats.cagr, 1e-12) && a.trend.switches === 0 && a.grade === "PASS", "T10: steadily rising ETFs are always held -> the trend book IS the hold book, PASS", `Sharpe ${a.trend.sharpeX.toFixed(2)} vs ${a.hold.sharpeX.toFixed(2)}`);
    H.ok(a.hold.turnoverPerYear > 0 && a.hold.turnoverPerYear < 0.5 && a.spy && a.spy.sharpeX > 0, "T10: the benchmark pays for its monthly rebalancing; SPY alone is reported");
    // (b) one ETF halves over a year: the rule steps out, the benchmark does not
    const crash = { ...up, DBC: (() => { const o = {}; let c = 100; DAYS.forEach((d, i) => { const r = i < 1200 ? 0.0004 : i < 1452 ? Math.log(0.5) / 252 : 0.0004; c *= 1 + r; o[d] = c; }); return o; })() };
    const b = FB.t10(crash, { asOf: LAST });
    H.ok(b.trend.inShare.DBC < 0.85 && b.trend.switches >= 2 && b.trend.stats.maxDD > b.hold.stats.maxDD && b.trend.sharpeX > b.hold.sharpeX, "T10: a year-long −50% slide in one ETF -> the rule is out for most of it; shallower drawdown and higher Sharpe than holding", `DBC held ${(b.trend.inShare.DBC * 100).toFixed(0)}% of days; DD ${(b.trend.stats.maxDD * 100).toFixed(1)}% vs ${(b.hold.stats.maxDD * 100).toFixed(1)}%`);
    // (c) NO look-ahead: one ETF. Flat at 100; closes 90 on a month-end (signal: out); −50% the NEXT session (the day the exit trades,
    //     at its close — so the loss is taken); then +100% over the following weeks while out.
    const one = (() => { const o = {}; const meIdx = DAYS.findIndex((d, i) => i > 900 && DAYS[i + 1] && d.slice(0, 7) !== DAYS[i + 1].slice(0, 7)); let c = 100;
      DAYS.forEach((d, i) => { if (i === meIdx) c *= 0.9; else if (i === meIdx + 1) c *= 0.5; else if (i > meIdx + 1 && i <= meIdx + 11) c *= Math.pow(2, 1 / 10); else c *= 1.0003; o[d] = c; }); return { o, meIdx }; })();
    const c1 = FB.t10({ X: one.o, BIL }, { asOf: LAST, etfs: ["X"] });
    const dOf = (k) => DAYS[one.meIdx + k];
    H.ok(c1.trend.stats.maxDD < -0.54 && near(c1.trend.stats.maxDD, c1.hold.stats.maxDD, 0.01), "T10 no look-ahead: the month-end signal trades at the NEXT close, so the −50% session after the month-end is taken in full", `trend DD ${(c1.trend.stats.maxDD * 100).toFixed(1)}%, hold ${(c1.hold.stats.maxDD * 100).toFixed(1)}%`);
    H.ok(c1.trend.stats.cagr < c1.hold.stats.cagr - 0.03 && c1.trend.inShare.X < 1 && c1.trend.switches >= 2, "T10: and the rebound in the two weeks after it steps out is missed (the rule is not flattered)", `out from the close of ${dOf(1)}: CAGR ${(c1.trend.stats.cagr * 100).toFixed(1)}% vs ${(c1.hold.stats.cagr * 100).toFixed(1)}%`);
    // a single always-held ETF: nothing to rebalance -> the book's return is the ETF's return, to the last digit
    const solo = FB.t10({ X: up.SPY, BIL }, { asOf: LAST, etfs: ["X"] }), soloYrs = (solo.days) / 252;
    H.ok(near(solo.trend.stats.cagr, Math.pow(up.SPY[solo.to] / up.SPY[solo.from], 1 / soloYrs) - 1, 1e-12) && solo.hold.turnoverPerYear === 0, "T10: one always-held ETF -> the book returns exactly what the ETF returned; no turnover after the first purchase");
    // (d) costs: 2 bp on what is traded. One ETF that alternates above/below its average every month churns the book.
    const zig = (() => { const o = {}; let month = "", k = 0; for (const d of DAYS) { if (d.slice(0, 7) !== month) { month = d.slice(0, 7); k++; } o[d] = 100 + (k % 2 ? 3 : -3); } return o; })();
    const z = FB.t10({ X: zig, BIL }, { asOf: LAST, etfs: ["X"] }), z0 = FB.t10({ X: zig, BIL }, { asOf: LAST, etfs: ["X"], costBp: 0 });
    const fin = (o) => Math.pow(1 + o.trend.stats.cagr, o.days / 252);
    H.ok(z.trend.switches > 80 && z.trend.turnoverPerYear > 8 && near(fin(z) / fin(z0), Math.pow(1 - 0.0002, z.trend.switches), 1e-9), "T10: a zig-zag series is traded every month — every switch is counted and costs exactly 2 bp of what is traded", `${z.trend.switches} switches, ${(z.trend.turnoverPerYear * 100).toFixed(0)}% a year, cost drag ${((1 - fin(z) / fin(z0)) * 100).toFixed(2)}%`);
    H.ok(FB.t10({ ...up, BIL: {} }, { asOf: LAST }).note && /BIL/.test(FB.t10({ ...up, BIL: {} }, { asOf: LAST }).note) && FB.t10(up, { asOf: "2027-06-01" }).grade === "INCOMPLETE", "T10: no BIL history -> not run; stale data -> INCOMPLETE");

    // ───────── T11 ─────────
    const lv = (f) => { const o = {}; let c = 100; DAYS.forEach((d, i) => { c *= 1 + f(i); o[d] = c; }); return o; };
    const spyR = DAYS.map(() => 0.0005 + gauss() * 0.01), putR = spyR.map(r => 0.0003 + 0.5 * r), lpR = spyR.map(r => -0.0006 - 0.1 * Math.min(r, 0));   // long put: costs 6 bp a day, pays on down days (net drag about 2 bp a day)
    const SPYTR = lv(i => spyR[i]), PUT = lv(i => putR[i]), PPUT = lv(i => spyR[i] + lpR[i]);
    const r11 = FB.t11({ PUT, PPUT, SPYTR }, { asOf: LAST });
    let L = 1; for (let i = 1; i < DAYS.length; i++) L *= 1 + putR[i] + lpR[i];
    const yrs = (DAYS.length - 1) / 252;
    H.ok(near(r11.spread.cagr, Math.pow(L, 1 / yrs) - 1, 1e-9) && r11.n === DAYS.length - 1, "T11: daily return = PUT + PPUT − SPY exactly", `CAGR ${(r11.spread.cagr * 100).toFixed(2)}%`);
    H.ok(r11.grade === "PASS" && r11.spread.maxDD > r11.spy.maxDD && r11.longPutPerYear < 0 && r11.putOnly.cagr > r11.spread.cagr, "T11: half the market's swings with a put underneath -> PASS; the long put's cost and the PUT leg are reported", `long put ${(r11.longPutPerYear * 100).toFixed(1)}% a year`);
    const bad = FB.t11({ PUT: lv(i => -0.0001 + 0.5 * spyR[i]), PPUT, SPYTR }, { asOf: LAST });
    H.ok(bad.grade === "fail", "T11: a spread with a lower Sharpe than SPY -> fail");
    const cut = Object.fromEntries(Object.entries(PPUT).filter(([d]) => d < DAYS[DAYS.length - 40]));
    H.ok(FB.t11({ PUT, PPUT: cut, SPYTR }, { asOf: LAST }).grade === "INCOMPLETE" && FB.t11({ PUT, SPYTR }, { asOf: LAST }).note, "T11: an index that stopped 40 sessions ago -> INCOMPLETE; a missing index -> not run");

    // ───────── run + report ─────────
    const res = FB.runB2({ SPY: bars(8, -3), QQQ: bars(1.5, 4, 0.004) }, up, { PUT, PPUT, SPYTR }, { asOf: LAST });
    const rep = FB.b2Report(res, { test: "synthetic" });
    H.ok(res.trials === 4 && res.T9.SPY.grade === "PASS" && res.T9.QQQ.grade === "fail" && /Trials reported: 4/.test(rep) && /T9 Overnight hold — SPY/.test(rep) && /T9 Overnight hold — QQQ/.test(rep) && /T10 Trend on five ETFs/.test(rep) && /T11 Put credit spread/.test(rep) && /PRE-REGISTERED PASS LINES/.test(rep) && /held now:/.test(rep),
      "runB2 + report: four trials, each with its verdict, the pass lines printed", rep.split("\n").filter(l => /^(SPY|QQQ): |^PASS|^fail|^INCOMPLETE/.test(l)).join(" | "));
    H.ok(/not run — no history for PUT, PPUT/.test(FB.b2Report(FB.runB2({}, {}, { SPYTR }, { asOf: LAST }))) , "report: a test whose data is missing says so instead of failing the run");

    // ───────── route: ?tests=B2 ─────────
    const resp = (status, body) => ({ ok: status === 200, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body });
    let fiveMin = 0, dailyHits = 0, cboeHits = 0, cboeDown = false;
    const dailyOf = { SPY: DAYS.map((d, i) => ({ date: d, o: i ? SPYTR[DAYS[i - 1]] * 1.0003 : SPYTR[d], c: SPYTR[d] })), QQQ: bars(1.5, 4, 0.004) };
    const closesOf = (tk) => (dailyOf[tk] ? Object.fromEntries(dailyOf[tk].map(b => [b.date, b.c])) : up[tk]);
    const direct = FB.runB2(dailyOf, Object.fromEntries(["SPY", "QQQ", "EFA", "IEF", "VNQ", "DBC", "BIL"].map(tk => [tk, closesOf(tk)])), { PUT, PPUT, SPYTR }, { asOf: LAST });
    const nodeFetch = async (url) => {
      url = String(url);
      if (url.includes("cdn.cboe.com")) { cboeHits++; if (cboeDown) return resp(403, ""); const ser = url.includes("PPUT_History") ? PPUT : url.includes("PUT_History") ? PUT : null; return ser ? resp(200, "DATE,CLOSE\n" + DAYS.map(d => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)},${ser[d]}`).join("\n")) : resp(404, ""); }
      const m = url.match(/\/stocks\/([A-Z]+)\/bars\?/); if (!m) return resp(404, "");
      if (!/timeframe=1Day/.test(url)) { fiveMin++; return resp(500, ""); }
      if (!/adjustment=all/.test(url)) return resp(400, "");
      dailyHits++;
      const src = dailyOf[m[1]] || DAYS.map(d => ({ date: d, o: up[m[1]][d], c: up[m[1]][d] }));
      return resp(200, { bars: src.map(b => ({ t: b.date + "T05:00:00Z", o: b.o, c: b.c })), next_page_token: null });
    };
    const broker = require(H.R("broker.js"));
    const fakeBroker = { ...broker, alpacaHeaders: () => ({}), alpacaGet: async () => { throw new Error("alpacaGet must not be used"); } };
    const sv = H.read("server.js"), from = sv.indexOf('app.get("/api/flow-backtest"');
    const src = H.extractBlock(sv, "async (req, res) =>", { includeHead: true, fromIndex: from });
    const getETTime = () => new Date(2026, 10, 25, 11, 0);   // 11:00 on a weekday: mid-session
    const logs = [];
    const req2 = (mm) => mm === "node-fetch" ? nodeFetch : mm === "./broker" ? fakeBroker : mm === "./dayContext" ? { etDateStr: () => LAST } : require(H.R(mm.replace("./", "") + (mm.endsWith(".js") ? "" : ".js")));
    const handler = new Function("require", "logEvent", "getETTime", "return (" + src + ");")(req2, (t, m) => logs.push(m), getETTime);
    const call = (query) => new Promise((resolve) => { const r = { _s: 200, status(s) { this._s = s; return this; }, type() { return this; }, send(b) { resolve({ status: this._s, body: b }); }, json(b) { resolve({ status: this._s, json: b }); } }; handler({ query }, r); });
    const q = await call({ tests: "B2", format: "json" });
    H.ok(q.status === 200 && fiveMin === 0 && dailyHits === 7 && cboeHits === 2 && q.json.result.trials === 4, "?tests=B2 runs mid-session: 7 daily downloads + 2 Cboe files, no 5-minute bars, no alpacaGet", JSON.stringify({ status: q.status, fiveMin, dailyHits, cboeHits }));
    const key = (r) => JSON.stringify([r.T9.SPY.grade, r.T9.QQQ.grade, r.T10.grade, r.T11.grade, r.T9.SPY.perNight.mean, r.T10.trend.sharpeX, r.T10.hold.stats.maxDD, r.T11.spread.cagr, r.T11.spy.sharpe]);
    H.ok(key(q.json.result) === key(direct) && q.json.result.T11.grade === "PASS" && q.json.result.T9.QQQ.grade === "fail" && /BIL \d+ to /.test(q.json.sources["Alpaca daily (dividend-adjusted)"]) && /PPUT \d+ days to/.test(q.json.sources.Cboe),
      "route result matches the direct run; sources list every series and its last date", q.json.sources.Cboe);
    H.ok(logs.some(l => l === `[FLOW-HARNESS] B2 ran in 0s — T9 SPY ${direct.T9.SPY.grade}, QQQ ${direct.T9.QQQ.grade} · T10 ${direct.T10.grade} · T11 ${direct.T11.grade}` || /\[FLOW-HARNESS\] B2 ran in \d+s — T9 SPY \w+, QQQ fail · T10 \w+ · T11 PASS/.test(l)), "one log line with the four verdicts", logs[0]);
    const txt = await call({ tests: "b2" });
    H.ok(txt.status === 200 && typeof txt.body === "string" && /APEX FLOW HARNESS v1\.4/.test(txt.body), "plain-text report by default (tests=b2 in any case)");
    cboeDown = true; const nc = await call({ tests: "B2", format: "json" });
    H.ok(nc.status === 200 && nc.json.result.T11.note && nc.json.result.T9.SPY.grade === direct.T9.SPY.grade && !nc.json.result.T10.note && /T11 Put credit spread[\s\S]*not run/.test(nc.json.report), "Cboe unreachable: T9 and T10 still run; T11 says it could not");
    const busy = await call({});
    H.ok(busy.status === 409, "the full 5-minute harness still refuses to run mid-session");
  } catch (e) { H.ok(false, "flow B2 test crashed", e.stack.split("\n").slice(0, 5).join(" | ")); }
  H.done();
})();
