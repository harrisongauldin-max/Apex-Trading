// 11/16 (Harrison): efficacy report fixes found in the 4-week EOD review.
//  - rung5 / rung12.5 read 0% on every row of every report: they came from the confirmed peak, which only the
//    trail-floor path maintains; every current sleeve exits before it. Now: confirmed peak when it moved, else raw peak.
//  - the score is 0 on almost every trade (the current sleeves don't set one), so the score buckets / correlation
//    measured nothing — skipped until enough trades carry a score.
"use strict";
const H = require("./helpers"); H.quiet();
const E = require(H.R("efficacy.js"));
const O = require(H.R("outcomes.js"));

const rec = (o) => Object.assign({ side: "call", won: "0", pnl: "-30", peakPct: "2", confPeakPct: "0", maePct: "-5", minHeld: "20",
  rung5: "0", rung125: "0", score: "0", exitReason: "itrend-noarm", eBuActive: "0" }, o);
const recs = [];
for (let i = 0; i < 10; i++) recs.push(rec({ won: "1", pnl: "55", peakPct: "13.5", exitReason: "itrend-lock" }));   // raw peak +13.5%, confirmed 0 (the bug)
for (let i = 0; i < 10; i++) recs.push(rec({ peakPct: "6" }));                                                          // reached +5 only
for (let i = 0; i < 20; i++) recs.push(rec({}));                                                                        // never got to +5
const r = E.buildEfficacyReport(recs, { days: 20 });
const all = r.text.split("\n").find(l => /^ALL TRADES/.test(l));
H.ok(/rung5\s+50%\s+rung12\.5\s+25%/.test(all), "rungs come from the raw peak when the confirmed peak never moved (20/40 reached +5, 10/40 +12.5)", all);
H.ok(/skipped — only 0 of 40 trades carry a score/.test(r.text) && !/score\s+0-70/.test(r.text), "score buckets skipped when the strategies don't set a score");
H.ok(!/^\s+score\s+r=/m.test(r.text), "unset score dropped from the feature ranking");

// a confirmed peak that did move still wins over the raw peak (the trail-floor meaning is kept)
const r2 = E.buildEfficacyReport([...Array(10)].map(() => rec({ peakPct: "14", confPeakPct: "8" })), { days: 1 });
H.ok(/rung5\s+100%\s+rung12\.5\s+0%/.test(r2.text.split("\n").find(l => /^ALL TRADES/.test(l))), "confirmed peak used when it moved (8% → rung5 yes, rung12.5 no)");

// a scored book still gets its buckets
const scored = [...Array(12)].map((_, i) => rec({ score: String(60 + i * 3), won: i % 2 ? "1" : "0" }));
H.ok(/score↔win correlation/.test(E.buildEfficacyReport(scored, { days: 1 }).text), "score section still runs when trades carry a score");

// outcome rows written from now on carry the right rung flags
const H2 = O.OUTCOME_HEADER.split(",");
const row = (pos, o) => O.buildOutcomeRow(pos, o).split(",");
const base = { ticker: "QQQ", optionType: "call", premium: 6.0, contracts: 1, openDate: new Date(Date.now() - 600000).toISOString() };
const f1 = row(Object.assign({}, base, { peakPremium: 6.81 }), { exitPrice: 6.6, exitReason: "itrend-lock", pnl: 60 });   // +13.5% raw, no confirmed peak
H.ok(f1[H2.indexOf("rung5")] === "1" && f1[H2.indexOf("rung125")] === "1", "new rows: +13.5% raw peak → rung5 1, rung12.5 1", `${f1[H2.indexOf("rung5")]} ${f1[H2.indexOf("rung125")]}`);
const f2 = row(Object.assign({}, base, { peakPremium: 6.81, _confirmedPeak: 6.48 }), { exitPrice: 6.3, exitReason: "trail", pnl: 30 });   // confirmed +8%
H.ok(f2[H2.indexOf("rung5")] === "1" && f2[H2.indexOf("rung125")] === "0", "new rows: a moved confirmed peak (+8%) still decides → rung12.5 0");
const f3 = row(Object.assign({}, base, { peakPremium: 6.12 }), { exitPrice: 5.7, exitReason: "itrend-noarm", pnl: -30 });
H.ok(f3[H2.indexOf("rung5")] === "0" && f3[H2.indexOf("rung125")] === "0", "new rows: +2% peak → no rungs");
H.done();
