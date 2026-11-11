// 11/05: NOISE-BAND stops — R = the stock's own opening swing N (first 5-min range, clamped 0.1-1 ATR).
"use strict";
const H = require("./helpers"); H.quiet();
const SIP = require(H.R("stocksInPlay.js"));
const T = SIP._t, V = SIP.EXIT_VARIANTS;
H.ok(SIP.CFG.STOP_MODE === "noise", "live default: noise-band stops");
H.ok(T.noiseBand(20.5, 20.0, 2) === 0.5, "N = first 5-min range ($0.50 on a $2 ATR)");
H.ok(T.noiseBand(20.05, 20.0, 2) === 0.2, "floored at 0.1 ATR (never tighter than the paper)");
H.ok(T.noiseBand(25, 20, 2) === 2, "capped at 1 ATR (a huge gap candle can't shrink the size to nothing)");
H.ok(Math.abs(T.noiseBand(20.5, 20.0, 2, 1.5) - 0.75) < 1e-12, "version B: 1.5N");

// selectCandidates sizes on N, keeps the paper distance for the paper's ideal
const cs = T.selectCandidates({ XYZ: { ovAvg: 1e5, atr: 2, avgVol: 3e6, etb: true, shortable: true } }, { XYZ: { o: 20.1, h: 20.5, l: 20.0, c: 20.45, v: 5e5 } });
H.ok(cs[0] && cs[0].stopDist === 0.5 && cs[0].paperStopDist === 0.2 && cs[0].noiseN === 0.5 && cs[0].qty === 25, "candidate: stop 1N = $0.50, paper $0.20 kept, 25 sh ($12.50 / $0.50)", JSON.stringify(cs[0]));
const cp = T.selectCandidates({ XYZ: { ovAvg: 1e5, atr: 2, avgVol: 3e6 } }, { XYZ: { o: 20.1, h: 20.5, l: 20.0, c: 20.45, v: 5e5 } }, { ...SIP.CFG, STOP_MODE: "paper" });
H.ok(cp[0] && cp[0].stopDist === 0.2 && cp[0].qty === 62, "STOP_MODE paper: the old 0.1-ATR stop, 62 sh");

// the 11/04 failure mode: a dip that takes out the paper stop but stays inside the noise band
const m = (k, o, h, l, c) => ({ t: new Date(Date.parse("2026-11-05T14:35:00Z") + k * 60000).toISOString(), o, h, l, c });
const cand = { sym: "XYZ", side: "long", entry: 20.5, h: 20.5, l: 20.0, atr: 2 };
const shake = [m(0, 20.40, 20.60, 20.45, 20.55), m(1, 20.55, 20.60, 20.25, 20.40), m(2, 20.40, 21.20, 20.35, 21.10), m(3, 21.10, 21.60, 21.00, 21.50), m(4, 21.50, 21.55, 21.30, 21.45)];
const p = T.simulateExit(cand, shake, V.paper_l05), a = T.simulateExit(cand, shake, V.noiseA), b = T.simulateExit(cand, shake, V.noiseB);
H.ok(p.R === -1 && a.reason !== "stop" && a.R > 1, "shakeout dip: paper stopped -1R; noise A survives and keeps the run", `paper ${p.R} / A ${a.R} ${a.reason}`);
H.ok(b.entered && b.R > 0, "noise B (1.5N) also survives", JSON.stringify(b));
// rises +1.2N then fails: A locks -0.5R, D breakeven
const fail = [m(0, 20.40, 20.60, 20.45, 20.55), m(1, 20.55, 21.10, 20.52, 21.05), m(2, 21.05, 21.06, 19.50, 19.60)];
const fa = T.simulateExit(cand, fail, V.noiseA), fd = T.simulateExit(cand, fail, V.noiseD);
H.ok(fa.R === -0.5 && fd.R === 0, "peak +1.2R then fails: A -0.5R lock, D breakeven", `${fa.R} ${fd.R}`);
// noise C uses the 9:30-9:35 one-minute ATR from splitOpening
const raw = { XYZ: [m(-5, 20, 20.2, 19.95, 20.1), m(-4, 20.1, 20.3, 20.05, 20.2), m(-3, 20.2, 20.35, 20.1, 20.3), m(-2, 20.3, 20.5, 20.25, 20.45), m(-1, 20.45, 20.5, 20.3, 20.4), ...shake] };
const c2 = { ...cand }; const sim = T.splitOpening([c2], raw, 958);
H.ok(sim.XYZ.length === 5 && c2._atr1m > 0.15 && c2._atr1m < 0.3, "splitOpening: 9:30-9:35 bars give the 1-min ATR; simulation bars start 9:35", `${sim.XYZ.length} bars, atr1m ${c2._atr1m}`);
const cc = T.simulateExit(c2, sim.XYZ, V.noiseC);
H.ok(cc.entered && Math.abs(cc.sd - 2 * c2._atr1m) < 1e-9, "noise C: stop = 2 x 1-min ATR ($0.48)", JSON.stringify(cc));
H.ok(T.liveRuleKey() === "noiseA", "live rule marker = noiseA");

// running totals across nights
const st = {}; T.setHistState(st);
const day = (d, a, b) => ({ day: d, liveRule: "noiseA", cands: [{ status: "closed", pnl: 5, R: 0.4 }], variants: { noiseA: { trades: 4, wins: 2, R: a, usd: a * 12.5, tradesNet: 4, winsNet: 2, Rnet: a - 1, usdNet: (a - 1) * 12.5 }, paper_l05: { trades: 4, wins: 1, R: b, usd: b * 12.5, tradesNet: 4, winsNet: 0, Rnet: b - 4, usdNet: (b - 4) * 12.5 } } });
T.recordHistory(day("2026-11-05", 3, 1)); T.recordHistory(day("2026-11-06", -1, 2)); T.recordHistory(day("2026-11-05", 4, 1));   // re-run of 11/05 replaces it
const ht = SIP.historyTable(st);
const ra = ht.rules.find(r => r.key === "noiseA"), rp = ht.rules.find(r => r.key === "paper_l05");
H.ok(ht.days === 2 && ra.days === 2 && ra.Rnet === 1 && Math.abs(ra.usdNet - 12.5) < 1e-9 && ra.posDaysNet === 1, "history: two nights summed (a re-run night replaces itself)", JSON.stringify(ra));
H.ok(ht.rules[0].key === "noiseA" && rp.Rnet === -5 && ht.live.n === 2 && ht.liveRule === "noiseA", "sorted by net $; actual live summed too", JSON.stringify(ht.live));
for (let i = 0; i < 45; i++) T.recordHistory(day(`2027-01-${String(i + 1).padStart(2, "0")}`, 1, 1));
H.ok(st._sipHist.days.length === 40, "history keeps the last 40 nights");
H.done();
