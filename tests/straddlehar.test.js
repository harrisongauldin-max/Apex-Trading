// 11/10: the straddle's IV/RV gate uses a FORECAST of the hold window's realized vol (fixed-weight HAR, Corsi 2009), not
// the 9:30-10:00 reading (the open is the most volatile half hour: the intraday U-shape).
"use strict";
const H = require("./helpers"); H.quiet();
const ST = require(H.R("straddleStrategy.js"));
const VOL = require(H.R("vol.js"));
const C = require(H.R("constants.js"));
H.ok(C.STRADDLE_RV_MODE === "har" && ST.V2.RV_MODE === "har" && ST.V2.RV_MIN_DAYS === 10 && ST.V2.RV_LOOKBACK === 20, "gate uses the HAR forecast; needs 10 usable past days; 20-day ratio");

// synthetic 1-min bars: each bar's high/low range sets its Parkinson vol. ET 9:30 = 14:30Z (EST).
const day0 = Date.parse("2026-11-16T14:30:00Z");   // a Monday after the DST change (9:30 ET = 14:30Z)
const mk = (dayIdx, openRange, holdRange) => {
  const out = [], base = day0 + dayIdx * 864e5;
  for (let m = 0; m < 388; m++) {   // 9:30 .. 15:58
    const r = m < 30 ? openRange : holdRange, px = 700;
    out.push({ t: new Date(base + m * 60000).toISOString(), o: px, h: px * (1 + r / 2), l: px * (1 - r / 2), c: px });
  }
  return out;
};
let bars = [];
for (let d = 0; d < 21; d++) if ((d % 7) < 5) bars = bars.concat(mk(d, 0.002, 0.001));   // weekdays only; open bars 2x the hold bars
const rows = ST.dayWindows(bars);
const exp1 = VOL.parkinsonVol([{ h: 700 * 1.001, l: 700 * 0.999 }].concat(Array(29).fill({ h: 700 * 1.001, l: 700 * 0.999 })));
H.ok(rows.length === 15 && rows.every(r => r.nOpen === 30 && r.nHold === 358) && Math.abs(rows[0].rvOpen / rows[0].rvHold - 2) < 1e-5, "dayWindows: 9:30-10:00 and 10:00-15:58 split per ET day; open RV = 2x hold RV here", JSON.stringify(rows[0]));
H.ok(Math.abs(rows[0].rvOpen - VOL.parkinsonVol(bars.slice(0, 30))) < 1e-12, "same Parkinson estimator (and annualization) as vol.js / the IV comparison");

const f = ST.harForecast(rows, rows[0].rvOpen * 1.5);
const hold = rows[0].rvHold;
H.ok(f.ok && Math.abs(f.ratio - 0.5) < 1e-5 && Math.abs(f.d1 - hold) < 1e-12 && Math.abs(f.w5 - hold) < 1e-12 && Math.abs(f.todayAdj / (0.75 * rows[0].rvOpen) - 1) < 1e-5,
     "HAR parts: yesterday, 5-day average, today's open x the median hold/open ratio (0.5)", JSON.stringify(f));
H.ok(Math.abs(f.forecast / ((hold + hold + 1.5 * hold) / 3) - 1) < 1e-5, "forecast = the equal-weight average of the three (no fitted weights)");
H.ok(!ST.harForecast(rows.slice(0, 9), 0.2).ok && /only 9 usable past days/.test(ST.harForecast(rows.slice(0, 9), 0.2).reason), "fewer than 10 usable past days: no forecast, no trade");
H.ok(!ST.harForecast(rows, null).ok, "no 9:30-10:00 reading today: no forecast");
// the 11/10 case: a hot open no longer passes. Open 45.9% realized, rest-of-day history ~0.45x the open, IV 25.9%
const hist = Array.from({ length: 20 }, (_, i) => ({ day: `D${String(i).padStart(2, "0")}`, rvOpen: 0.40, rvHold: 0.18 }));
const q = ST.harForecast(hist, 0.459);
const pair = { iv: 0.259, dte: 6, strike: 679 };
const oldDec = ST.decide(pair, 0.36), newDec = ST.decide(pair, q.forecast, undefined, "forecast RV");
H.ok(oldDec.fire && !newDec.fire && /forecast RV/.test(newDec.reason), "11/10 QQQ: the old gate (IV 25.9% / 36.0%) bought; the forecast gate (~19%) doesn't", `${(q.forecast * 100).toFixed(1)}% -> ${newDec.reason}`);

// rvForecast: one fetch per ticker per day, cached; a failure is retried after 10 minutes
(async () => {
  const st = {}, now = Date.parse("2026-12-07T15:05:00Z");   // Mon 10:05 ET
  let calls = 0;
  const todayBars = mk(21, 0.003, 0.001).slice(0, 35);   // 12/07 open
  const fb = async () => { calls++; return bars.concat(todayBars.map((b, i) => ({ ...b, t: new Date(Date.parse("2026-12-07T14:30:00Z") + i * 60000).toISOString() }))); };
  const r1 = await ST.rvForecast(st, "QQQ", now, fb), r2 = await ST.rvForecast(st, "QQQ", now + 60000, fb);
  H.ok(r1.ok && r2 === r1 && calls === 1 && r1.nDays === 15 && Math.abs(r1.rvOpenToday / rows[0].rvOpen - 1.5) < 1e-4, "fetched once, cached for the day; today's open read from today's bars", JSON.stringify({ ok: r1.ok, n: r1.nDays, calls }));
  const st2 = {}; let c2 = 0;
  const bad = async () => { c2++; throw new Error("HTTP 500"); };
  const b1 = await ST.rvForecast(st2, "SPY", now, bad), b2 = await ST.rvForecast(st2, "SPY", now + 5 * 60000, bad), b3 = await ST.rvForecast(st2, "SPY", now + 11 * 60000, bad);
  H.ok(!b1.ok && /bar fetch failed: HTTP 500/.test(b1.reason) && c2 === 2 && b2 === b1 && !b3.ok, "fetch failure: no trade, retried after 10 minutes (not every scan)");
  // pass line counts only HAR-gate pairs
  const P = (rule, pnl) => ({ sig: rule + pnl, day: "2026-11-10", rule, ticker: "SPY", legs: [{ type: "call", cost: 600, pnl }, { type: "put", cost: 600, pnl: 0 }] });
  const S = ST.pairStats([P("session", -54), P("session", -153), P("har", 40)], "2026-11-10");
  H.ok(S.n === 1 && S.total === 40 && S.preFix === 2 && S.preFixTotal === -207, "pass line restarts with the HAR gate: earlier-gate pairs reported, not counted", JSON.stringify({ n: S.n, pre: S.preFix }));
  H.ok(/count restarted 11\/10 with the HAR forecast gate — 2 earlier pairs/.test(ST.eodSection([P("session", -54), P("session", -153), P("har", 40)], "2026-11-10")), "EOD line says so");
  // wiring
  const sc = H.read("scanner.js"), ex = H.read("execution.js");
  H.ok(/if \(_sv\.RV_MODE === "har"\) \{ _rvF = await STRADDLESTRAT\.rvForecast\(state, _tk\);/.test(sc) && /STRADDLESTRAT\.decide\(_pair, _rvUse, undefined, _rvLbl\)/.test(sc) && /liveStock\._stradRule = _sv\.RV_MODE;/.test(sc), "scanner: IV compared with the HAR forecast; the leg records which gate opened it");
  H.ok(/_sp\._stradRule = stock\._stradRule \|\| null;/.test(ex), "execution stamps the gate on each leg");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
