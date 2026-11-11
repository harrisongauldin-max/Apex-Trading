// Flow harness (10/15): flowBacktest.js on a synthetic market with KNOWN planted effects, plus /api/flow-backtest end to
// end with Alpaca and Cboe mocked. A harness that can't find a planted effect — or finds one that isn't there — is broken.
"use strict";
const H = require("./helpers"); H.quiet();
const FB = require(H.R("flowBacktest.js"));

let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
// ET wall-clock -> ISO (finds the EST/EDT offset by round-tripping through the harness's own ET parser)
function iso(day, m) {
  const [y, mo, d] = day.split("-").map(Number);
  for (const off of [4, 5]) { const t = new Date(Date.UTC(y, mo - 1, d, Math.floor(m / 60) + off, m % 60)).toISOString(); const p = FB.etParts(t); if (p.day === day && p.m === m) return t; }
  throw new Error("tz");
}
function tradingDays(from, n) { const out = []; let t = Date.parse(from + "T12:00:00Z"); while (out.length < n) { const dw = new Date(t).getUTCDay(); if (dw && dw < 6) out.push(new Date(t).toISOString().slice(0, 10)); t += 864e5; } return out; }
const DAYS = tradingDays("2019-06-03", 760);
const tomSet = (() => { const s = new Set(), bm = {}; for (const d of DAYS) (bm[d.slice(0, 7)] = bm[d.slice(0, 7)] || []).push(d); for (const ds of Object.values(bm)) { s.add(ds[ds.length - 1]); ds.slice(0, 3).forEach(x => s.add(x)); } return s; })();
// planted: eod = last-30-min drift in the day's direction (per 5-min bar), trend = share of days with an all-day drift, tom = extra TOM return
function market(px0, { eod = 0, trend = 0, tom = 0 } = {}) {
  const bars = []; let px = px0;
  for (const day of DAYS) {
    const prevC = px; let p = px * (1 + gauss() * 0.002);
    const trendDir = rnd() < trend ? (rnd() < 0.5 ? 1 : -1) : 0, tomDrift = tomSet.has(day) ? tom / 78 : 0;
    bars.push({ t: iso(day, 540), o: p, h: p, l: p, c: p, v: 50 });   // 9:00 pre-market bar: must be dropped
    for (let m = 570; m < 960; m += 5) {
      const o = p;
      let r = gauss() * 0.0008 + tomDrift;
      if (trendDir && m >= 600) r += trendDir * 0.0004;
      if (eod && m >= 930) r += eod * Math.sign(o - prevC);
      p = o * (1 + r);
      bars.push({ t: iso(day, m), o, h: Math.max(o, p) * 1.0002, l: Math.min(o, p) * 0.9998, c: p, v: 1000 });
    }
    bars.push({ t: iso(day, 960), o: p, h: p, l: p, c: p, v: 50 });   // 16:00 after-hours bar: dropped
    px = p;
  }
  return bars;
}

(async () => {
  try {
    // ---- groupDays ----
    const ctrl = market(300);
    const days = FB.groupDays(ctrl);
    H.ok(days.length === DAYS.length && days.every(d => d.bars.length === 78 && d.bars[0].m === 570 && d.lastM === 955), "regular hours only: 78 five-minute bars a day, pre/after-market dropped", `${days.length} days`);
    H.ok(days[5].prevClose === days[4].close && Math.abs(days[5].bars[10].vwap - days[5].bars[10].c) / days[5].bars[10].c < 0.01, "prior close linked; running VWAP computed");

    // ---- T1: hand-computed day ----
    const hd = [{ date: "2020-01-02", bars: [], open: 100, close: 100, lastM: 955 }, { date: "2020-01-03", bars: [], open: 100, lastM: 955 }];
    for (let m = 570; m < 960; m += 5) { hd[0].bars.push({ m, c: 100, vwap: 100 }); hd[1].bars.push({ m, c: m < 925 ? 100.5 : m === 925 ? 101 : 101.5, vwap: 100.5 }); }
    hd[1].prevClose = 100; hd[1].close = 101.5;
    const h1 = FB.t1(hd, () => 0.15);
    H.ok(Math.abs(h1.full.mean - ((101.5 / 101 - 1) * 1e4 - 2)) < 1e-9 && h1.full.n === 1, "T1 hand check: +1% day, 15:30 101 -> close 101.5 = +49.5 bp - 2 bp costs", h1.full.mean.toFixed(2));

    // ---- T1 planted vs control ----
    const eodM = FB.groupDays(market(300, { eod: 0.00012 }));
    const p1 = FB.t1(eodM, () => 0.16), c1 = FB.t1(days, () => 0.16);
    H.ok(p1.pass && p1.full.mean > 4 && p1.full.t > 2, "T1 finds a planted end-of-day momentum effect (~+7 bp before costs)", `${p1.full.mean.toFixed(2)} bp, t ${p1.full.t.toFixed(1)}`);
    H.ok(!c1.pass && Math.abs(c1.full.mean + 2) < 3, "T1 finds nothing in the control market (mean ≈ the 2 bp cost)", `${c1.full.mean.toFixed(2)} bp, t ${c1.full.t.toFixed(1)}`);
    H.ok(p1.opt0DTE.n > 0 && p1.opt2DTE.n > 0 && p1.opt2DTE.mean > c1.opt2DTE.mean, "T1 option versions are priced (and better with the effect than without)", `2DTE ${p1.opt2DTE.mean.toFixed(3)} vs ${c1.opt2DTE.mean.toFixed(3)}`);

    // ---- T2 planted trend days vs control ----
    const trM = FB.groupDays(market(300, { trend: 0.35 }));
    const p2 = FB.t2(trM), c2 = FB.t2(days);
    H.ok(p2.sharpe > 1 && p2.sharpe > c2.sharpe + 1 && p2.trades > 100, "T2 makes money on planted trend days and not on the control", `Sharpe ${p2.sharpe.toFixed(2)} vs ${c2.sharpe.toFixed(2)}, ${p2.trades} trades`);
    H.ok(p2.holdBeatsCap && p2.daily.mean > p2.capDaily.mean, "on trend days, holding to the trail/close beats a 60-minute cap on the same entries", `${p2.daily.mean.toFixed(2)} vs ${p2.capDaily.mean.toFixed(2)} bp/day`);
    H.ok(p2.medianHoldMin >= 60, "trend trades are held well past an hour", `${p2.medianHoldMin} min`);

    // ---- T3 planted TOM vs control ----
    const tomM = FB.groupDays(market(300, { tom: 0.004 }));
    const p3 = FB.t3(tomM), c3 = FB.t3(days);
    H.ok(p3.pass && p3.closeToClose.diff > 15, "T3 finds a planted +40 bp turn-of-month effect (noise ±7 bp)", `diff ${p3.closeToClose.diff.toFixed(1)} bp, t ${p3.closeToClose.t.toFixed(1)}`);
    H.ok(!c3.pass, "T3 finds nothing in the control", `diff ${c3.closeToClose.diff.toFixed(1)} bp, t ${c3.closeToClose.t.toFixed(1)}`);

    // ---- T5 / T6 run ----
    const vix = (d) => 12 + (parseInt(d.slice(8, 10), 10) % 20);
    const p5 = FB.t5(trM, p2, vix);
    H.ok(p5.vixTerciles && p5.trend.all.low != null && p5.fade.all.high != null && typeof p5.pass === "boolean", "T5 splits trend and fade results by VIX tercile");
    const p6 = FB.t6(days);
    H.ok(p6.pd.full.n > 50 && p6.round.full.n > 50 && !p6.pd.pass && !p6.round.pass, "T6 finds level breaks, and no continuation edge in a random market", `pd n ${p6.pd.full.n} (${p6.pd.full.mean.toFixed(2)} bp), round n ${p6.round.full.n} (${p6.round.full.mean.toFixed(2)} bp)`);

    // ---- v1.1: INCOMPLETE grading, T2-opt, concentration ----
    const short = trM.filter(d => d.date < "2021-03-01");   // second half only ~40 days
    const s2 = FB.t2(short);
    H.ok(s2.grade === "INCOMPLETE" && !s2.pass && s2.holdGrade === "INCOMPLETE" && !s2.holdBeatsCap, "v1.1: a half with < 250 days grades INCOMPLETE (T2 and hold-vs-cap), never PASS", `h2 days ${short.filter(d => d.date >= "2021-01-01").length}`);
    const s5 = FB.t5(short, s2, vix);
    H.ok(s5.grade === "INCOMPLETE" && !s5.pass, "v1.1: T5 with thin/empty VIX cells grades INCOMPLETE (an empty cell is no longer compared as zero)");
    const noLow = FB.t5(trM, p2, (d) => d >= "2021-01-01" ? 30 : vix(d));   // no low-VIX days in the second half
    H.ok(noLow.trend.h2.low == null && noLow.grade === "INCOMPLETE" && !noLow.pass, "v1.1: the 10/15 QQQ bug — a missing low-VIX cell can't PASS T5");
    const o2 = FB.t2opt(p2, () => 0.16), oc = FB.t2opt(c2, () => 0.16);
    H.ok(o2.full.n > 100 && o2.cap.n > 100 && o2.full.mean > oc.full.mean && ["PASS", "fail", "INCOMPLETE"].includes(o2.grade), "T2-opt prices T2's trades as options; better with planted trends than without", `${o2.full.mean.toFixed(3)} vs ${oc.full.mean.toFixed(3)} per trade`);
    const cz = FB.concentration([{ date: "2018-01-02", v: 9 }, { date: "2019-01-02", v: 1 }, { date: "2020-01-02", v: 1 }], r => r.v);
    const cn = FB.concentration([{ date: "2018-01-02", v: -5 }, { date: "2019-01-02", v: 1 }], r => r.v);
    H.ok(cz.topYear === "2018" && Math.abs(cz.topShare - 9 / 11) < 1e-9 && cz.tooConcentrated && cn.topShare == null, "concentration: largest year's share of total; flags > 50%; n/a when the total isn't positive");
    H.ok(typeof p2.conc === "object" && "topShare" in p2.conc, "T2 reports its concentration");

    // ---- v1.2: T2-opt14 and T7 (APEX intraday-trend replay) ----
    const sig = require(H.R("signals.js"));
    const adxBars = trM[30].bars.slice(0, 40);
    H.ok(typeof sig.calcADX !== "function" || Math.abs(FB.adxOf(adxBars) - sig.calcADX(adxBars)) < 0.1, "T7 ADX is the same Wilder ADX as signals.js", `${FB.adxOf(adxBars).toFixed(1)} vs ${typeof sig.calcADX === "function" ? sig.calcADX(adxBars) : "n/a"}`);
    const o14 = FB.t2opt(p2, () => 0.16, { tradingDays: 10, spread: 0.03 }), o14c = FB.t2opt(c2, () => 0.16, { tradingDays: 10, spread: 0.03 });
    H.ok(o14.full.n === o2.full.n && o14.full.mean > o14c.full.mean && Math.abs(o14.full.mean) < Math.abs(o2.full.mean), "T2-opt14 prices the same trades at 14 DTE (less leverage than 2 DTE, still better with the effect)", `${o14.full.mean.toFixed(3)} vs control ${o14c.full.mean.toFixed(3)}`);
    const C7 = require(H.R("constants.js"));
    const r7 = FB.t7(trM, () => 0.16), r7c = FB.t7(days, () => 0.16);
    const rows7 = r7.rows;
    H.ok(r7.trades > 100 && rows7.every(t => t.e >= C7.ITREND_START_ET * 60 && t.e < C7.ITREND_END_ET * 60), "T7 fires only inside the live 10:00-12:00 window", `${r7.trades} trades, ${r7.perDay.toFixed(2)}/day`);
    const coolOk = rows7.every((t, i) => rows7.slice(0, i).filter(u => u.date === t.date && u.side === t.side).every(u => t.e - u.e >= C7.ITREND_COOLDOWN_MIN));
    H.ok(coolOk, "T7 respects the 30-minute same-side cooldown");
    H.ok(rows7.every(t => t.liveHold <= C7.ITREND_MAX_HOLD_MIN + 5 || t.reason === "flatten-15:15") && Object.keys(r7.reasons).every(k => ["stop", "lock", "noarm", "maxhold", "flatten-15:15"].includes(k)), "T7 live exits: stop / ladder lock / no-arm / 60-min cap only", JSON.stringify(r7.reasons));
    H.ok(r7.shHeld.mean > r7c.shHeld.mean && r7.optHeld.mean > r7.optLive.mean && r7.b.grade !== "fail", "planted trend days: holding beats the live exits; control market has less", `held ${r7.shHeld.mean.toFixed(1)} bp vs control ${r7c.shHeld.mean.toFixed(1)} bp; opt held ${r7.optHeld.mean.toFixed(3)} vs live ${r7.optLive.mean.toFixed(3)}`);
    H.ok(!r7c.a.pass && !r7c.c.pass, "T7 finds no edge in the random control market", `control a ${r7c.a.grade}, c ${r7c.c.grade}`);
    const r7n = FB.t7(trM, null);
    H.ok(r7n.a.grade === "INCOMPLETE" && r7n.trades > 0, "no implied vol: T7's option grades are INCOMPLETE, shares still computed");

    // ---- v1.3: T8 selling premium vs SPY buy-and-hold ----
    const tds = tradingDays("2013-06-03", 3500);
    const mk = (f) => { const o = {}; let v = 100; tds.forEach((d, i) => { v *= 1 + f(i, d); o[d] = v; }); return o; };
    let sd2 = 5; const rn = () => { sd2 = (sd2 * 16807) % 2147483647; return sd2 / 2147483647 - 0.5; };
    const spy = mk(() => 0.0004 + rn() * 0.024);                       // ~10%/yr, ~19% vol
    sd2 = 5; const put = mk(() => 0.00035 + rn() * 0.012);              // same shocks at half size: higher Sharpe, shallower drawdown
    const crash = mk((i) => (i === 2000 ? -0.45 : 0.0006 + rn() * 0.006));   // smooth then one -45% day
    const st = FB.seriesStats(["2020-01-02", "2020-01-03", "2020-01-06"], { "2020-01-02": 100, "2020-01-03": 80, "2020-01-06": 90 });
    H.ok(Math.abs(st.maxDD + 0.2) < 1e-9 && st.maxDDAt === "2020-01-03", "T8 stats: worst drawdown measured peak to trough", JSON.stringify({ dd: st.maxDD, at: st.maxDDAt }));
    const lastT = tds[tds.length - 1];
    const r8 = FB.t8({ SPYTR: spy, PUT: put, CNDR: crash, BXM: put, SPX: spy }, { asOf: lastT });
    H.ok(r8.graded.PUT.grade === "PASS" && r8.graded.CNDR.grade === "fail" && r8.graded.BXM.graded === false, "T8: lower-vol series with shallower drawdown PASSES; one -45% day FAILS on drawdown; BXM reported, not graded",
      `PUT ${r8.graded.PUT.idx.sharpe.toFixed(2)} vs SPY ${r8.graded.PUT.spy.sharpe.toFixed(2)}; CNDR DD ${(r8.graded.CNDR.idx.maxDD * 100).toFixed(0)}%`);
    H.ok(r8.graded.PUT.from >= "2016-01-04" && r8.info.PUT && r8.info.PUT.to < "2016-01-01", "T8 grades 2016 on only; 2007-2015 is reported separately (SPX without dividends)");
    const stalePut = Object.fromEntries(Object.entries(put).filter(([d]) => d < tds[tds.length - 40]));
    const r8s = FB.t8({ SPYTR: spy, PUT: stalePut, CNDR: put }, { asOf: lastT });
    H.ok(r8s.graded.PUT.grade === "INCOMPLETE" && r8s.graded.CNDR.grade === "PASS", "T8: a discontinued / stale index grades INCOMPLETE, never PASS", `${r8s.graded.PUT.staleDays} days old`);
    H.ok(FB.t8({ PUT: put }).note && FB.t8({ SPYTR: spy, PUT: {} }).missing.includes("PUT"), "T8: no SPY history -> not run; empty index -> listed as unavailable");
    H.ok(FB.t8Report(r8).some(l => /Covid 2020/.test(l)) && FB.t8Report(r8).some(l => /not graded/.test(l)), "T8 report: stress windows and the ungraded 2007-2015 line");

    // ---- full run + report ----
    const res = FB.run({ SPY: market(400, { eod: 0.00012 }), QQQ: market(300) }, { SPY: () => 0.15, QQQ: () => 0.2 }, vix);
    const rep = FB.textReport(res, { test: "synthetic" });
    H.ok(res.tickers.SPY.T1.pass && !res.tickers.QQQ.T1.pass && /PRE-REGISTERED PASS LINES/.test(rep) && /T1 End-of-day momentum/.test(rep) && /T6 Continuation/.test(rep) && /Trials reported: 30/.test(rep) && /T7 APEX intraday-trend replay/.test(rep) && /T2-opt14/.test(rep),
      "run(): per-ticker verdicts, every trial listed, pass lines printed", rep.split("\n").find(l => /T1 End/.test(l)));

    // ---- route ----
    const SPYb = market(400, { eod: 0.00012 }), QQQb = market(300);
    let saw429 = false, pages = 0, cboeDown = false, dailyHits = 0;
    const resp = (status, body) => ({ ok: status === 200, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body });
    const csvOf = (f) => "DATE,OPEN,HIGH,LOW,CLOSE\n" + DAYS.map(d => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)},1,1,1,${f(d)}`).join("\n");
    const nodeFetch = async (url) => {
      url = String(url);
      if (url.includes("cdn.cboe.com")) return cboeDown ? resp(403, "") : resp(200, csvOf(url.includes("VXN") ? (d) => vix(d) * 1.2 : vix));
      const m = url.match(/\/stocks\/(SPY|QQQ)\/bars\?/); if (!m) return resp(404, "");
      if (/timeframe=1Day/.test(url)) { dailyHits++; return resp(200, { bars: DAYS.map((d, i) => ({ t: d + "T04:00:00Z", c: 300 * (1 + 0.0004 * i) })), next_page_token: null }); }
      if (!saw429) { saw429 = true; return resp(429, {}); }
      const all = m[1] === "SPY" ? SPYb : QQQb, tok = +(new URL(url).searchParams.get("page_token") || 0), size = 30000;
      pages++;
      return resp(200, { bars: all.slice(tok, tok + size), next_page_token: tok + size < all.length ? String(tok + size) : null });
    };
    const broker = require(H.R("broker.js"));
    const fakeBroker = { ...broker, alpacaHeaders: () => ({}), alpacaGet: async () => { throw new Error("alpacaGet must not be used"); } };
    const sv = H.read("server.js"), from = sv.indexOf('app.get("/api/flow-backtest"');
    const src = H.extractBlock(sv, "async (req, res) =>", { includeHead: true, fromIndex: from });
    let ETH = 18;
    const getETTime = () => { const d = new Date(2026, 9, 15, Math.floor(ETH), Math.round((ETH % 1) * 60)); return d; };
    const logs = [];
    const req2 = (mm) => mm === "node-fetch" ? nodeFetch : mm === "./broker" ? fakeBroker : require(H.R(mm.replace("./", "") + (mm.endsWith(".js") ? "" : ".js")));
    const handler = new Function("require", "logEvent", "getETTime", "return (" + src + ");")(req2, (t, m) => logs.push(m), getETTime);
    const call = (query) => new Promise((resolve) => { const res = { _s: 200, status(s) { this._s = s; return this; }, type() { return this; }, send(b) { resolve({ status: this._s, body: b }); }, json(b) { resolve({ status: this._s, json: b }); } }; handler({ query }, res); });
    ETH = 11;
    const busy = await call({});
    H.ok(busy.status === 409 && /outside market hours/.test(busy.body), "refuses to run during market hours without force=1");
    saw429 = true; const p0 = pages;
    const q8 = await call({ format: "json", tests: "T8", end: DAYS[DAYS.length - 1] });
    H.ok(q8.status === 200 && pages === p0 && dailyHits > 0 && q8.json.result.T8 && Object.keys(q8.json.result.tickers).length === 0 && /T8 Selling premium/.test(q8.json.report) && /SPYTR \d+ days/.test(q8.json.sources.T8),
      "?tests=T8: runs during market hours, skips the 5-minute download, fetches SPY daily + Cboe indexes", q8.json && q8.json.sources && q8.json.sources.T8);
    saw429 = false;
    ETH = 18;
    const lastDay = DAYS[DAYS.length - 1];
    const stale = await call({ format: "json", start: "2019-06-01" });
    H.ok(stale.status === 200 && stale.json.result.tickers.SPY.T1.grade === "INCOMPLETE" && !stale.json.result.tickers.SPY.T1.pass && /every test on SPY is INCOMPLETE/.test(stale.json.report),
      "v1.1: data that ends long before the run date grades INCOMPLETE, never PASS", stale.json.result.tickers.SPY.staleDays + " days stale");
    const t0 = Date.now(); const a = await call({ format: "json", start: "2019-06-01", end: lastDay });
    const j = a.json || {};
    H.ok(a.status === 200 && j.result && j.result.tickers.SPY.T1.pass && !j.result.tickers.QQQ.T1.pass, "route: runs end to end and recovers the planted SPY effect", `status ${a.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    H.ok(saw429 && pages >= 4 && /five-minute bars/.test(j.sources.SPY) && /Cboe VIX/.test(j.sources.VIX), "route: retries a 429, follows paging, keeps regular hours only, reports sources", JSON.stringify(j.sources));
    H.ok(logs.some(l => /\[FLOW-HARNESS\] ran in/.test(l) && /SPY \([^)]*\): T1 PASS/.test(l) && /T2-opt14/.test(l) && /T7 /.test(l)), "route: logs the verdicts to the session log");
    cboeDown = true; saw429 = true;
    const b = await call({ format: "json", start: "2019-06-01", end: lastDay });
    H.ok(b.status === 200 && /unavailable/.test(b.json.sources.VIX) && /not run/.test(b.json.report), "Cboe down: still runs, says T5 couldn't run and options weren't priced");
  } catch (e) { H.ok(false, "flow harness test crashed", e.stack.split("\n").slice(0, 4).join(" | ")); }
  H.done();
})();
