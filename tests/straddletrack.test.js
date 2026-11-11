// 11/10: straddle pair PATH TRACKER + replayed profit locks (measurement only; live still holds to 3:58).
"use strict";
const H = require("./helpers"); H.quiet();
const ST = require(H.R("straddleStrategy.js"));
const st = {}, t0 = Date.parse("2026-11-10T15:00:00Z");   // 10:00 ET
const leg = (type, prem) => ({ ticker: "QQQ", optionType: type, premium: prem, contracts: 1, strike: 673, signalId: "Q1", _straddleHold: true, _stradRule: "har", contractSymbol: "Q1" + type, openDate: new Date(t0).toISOString() });
const C = leg("call", 10), P = leg("put", 10);   // pair cost $2,000
// path of the PAIR at the bid (call + put), sampled every 30 s: 0% -> +30% -> +12% -> close +5%
const marks = [[10, 10], [11, 10.4], [12.5, 10.5], [13.2, 12.8], [11.5, 10.9], [10.6, 10.6], [10.5, 10.5]];   // call bid, put bid
H.ok(ST.trackLeg(st, { ...C, bid: 10 }, 10, t0) && ST.trackLeg(st, { ...C, _straddleHold: false }, 10, t0) === null, "only hold-straddle legs are tracked");
marks.forEach(([cb, pb], i) => { const now = t0 + i * 30000; ST.trackLeg(st, { ...C, bid: cb, _bidAt: now }, cb, now); ST.trackLeg(st, { ...P, bid: pb, _bidAt: now }, pb, now); });
const tr = st._stradTrack.Q1;
H.ok(tr.path.length === 7 && tr.peak === 30 && tr.low === 0 && Math.abs(tr.path[6][1] - 5) < 1e-9, "pair value at the BID vs cost: peak +30%, low 0%, last +5%", JSON.stringify({ peak: tr.peak, low: tr.low, last: tr.path[6] }));
{ const n2 = t0 + 6 * 30000 + 3000; ST.trackLeg(st, { ...C, bid: 20, _bidAt: n2 }, 20, n2); ST.trackLeg(st, { ...P, bid: 10.5, _bidAt: n2 }, 10.5, n2); }
H.ok(tr.path.length === 7 && tr.peak > 30, "between samples the peak/low still update; the path keeps one point per 30 s");
ST.trackLeg(st, { ...C, bid: 30 }, 30, t0 + 6 * 30000 + 60000);   // only one leg fresh -> ignored (no mixed fresh/stale pair value)
H.ok(tr.path.length === 7, "a leg marked without its sibling in the same scan doesn't move the pair");
st._stradTrack.Q1.peak = 30; st._stradTrack.Q1.legs = {};   // restore for the replay checks below
// pair path at the bid: 0, +7, +15, +30, +12, +6, +5 (hold = +5%)
const L = ST.replayLocks(tr.path, 5);
H.ok(L.tp25.fired && L.tp25.pct === 30, "take profit +25%: sells at the first mark >= +25% (+30%)", JSON.stringify(L.tp25));
H.ok(L.lock10at20.fired && L.lock10at20.pct === 6, "lock +10% once up +20%: sells at the first mark <= +10% after the peak (+6%)", JSON.stringify(L.lock10at20));
H.ok(L.trail10.fired && L.trail10.pct === 12, "trail 10 pts once up +10%: +30% peak -> sells at +12% (first mark <= +20%)", JSON.stringify(L.trail10));
H.ok(L.trail15at20.fired && L.trail15at20.pct === 12, "trail 15 pts once up +20%: sells at +12% (first mark <= +15%)", JSON.stringify(L.trail15at20));
const flat = ST.replayLocks([[t0, 1], [t0 + 30000, 3], [t0 + 60000, -4]], -6);
H.ok(Object.values(flat).every(x => !x.fired && x.pct === -6), "a pair that never runs: no lock fires, every rule = hold (-6%)");
// closing both legs attaches the summary, removes the path
ST.recordLeg(st, { ...C, bid: 10.5 }, { pnl: 50, qty: 1, reason: "straddle-close" });
H.ok(st._stradTrack.Q1 && !st._stradPairs[0].track, "one leg closed: path kept, no summary yet");
ST.recordLeg(st, { ...P, bid: 10.5 }, { pnl: 50, qty: 1, reason: "straddle-close" });
const p = st._stradPairs[0];
H.ok(p.track && p.track.peakPct === 30 && p.track.lowPct === 0 && p.track.peakAt && p.track.samples === 7 && !st._stradTrack.Q1, "pair complete: peak/low/time + replayed locks attached; path deleted", JSON.stringify(p.track).slice(0, 160));
H.ok(p.track.locks.tp25.pct === 30 && p.track.locks.trail10.pct === 12, "locks replayed against the hold result (+5%)");
const S = ST.pairStats(st._stradPairs, "2026-11-10");
const tp = S.locks.find(l => l.key === "tp25");
H.ok(S.holdTracked.pairs === 1 && S.holdTracked.usd === 100 && tp.usd === 600 && tp.fired === 1, "stats: hold +$100 vs take-profit +$600 on the same $2,000 pair", JSON.stringify({ hold: S.holdTracked, tp }));
const html = ST.eodSection(st._stradPairs, "2026-11-10");
H.ok(/Profit locks, replayed/.test(html) && /Hold to 3:58 \(live\)/.test(html) && /Take profit at \+25%/.test(html) && /\+30\.0%/.test(html), "EOD section: peak/low column + the replayed-lock table");
const csv = ST.eodCSV(st._stradPairs).split("\n");
H.ok(/peakPct,peakAt,lowPct,lowAt,lock_tp25_pct,lock_lock10at20_pct,lock_trail10_pct,lock_trail15at20_pct,rvGate$/.test(csv[0]) && /,30,\d\d:\d\d,0,\d\d:\d\d,30,6,12,12,har$/.test(csv[1]), "CSV: peak/low and each lock rule's result", csv[1]);
const ex = H.read("exitEngine.js");
H.ok((ex.match(/require\('\.\/straddleStrategy'\)\.trackLeg\(state, pos, curP\)/g) || []).length === 2, "exit engine feeds the tracker every scan (incl. 3:57-3:58)");
H.done();
