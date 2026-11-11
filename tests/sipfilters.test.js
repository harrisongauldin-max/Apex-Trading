// 11/08: stocks-in-play replay-only tests of the live rule — 0.5-ATR cap, skip already-through entries, trade with SPY —
// plus each night tagged with the gamma regime in the running totals.
"use strict";
const H = require("./helpers"); H.quiet();
const SIP = require(H.R("stocksInPlay.js"));
const T = SIP._t, V = SIP.EXIT_VARIANTS;
const m = (k, o, h, l, c) => ({ t: new Date(Date.parse("2026-11-09T14:35:00Z") + k * 60000).toISOString(), o, h, l, c });

H.ok(V.noiseA_c50 && V.noiseA_ontime && V.noiseA_spy && T.liveRuleKey() === "noiseA", "three replay-only variants added; the live rule is still noise A");
// cap: a 5-min range of $1.60 on a $2 ATR -> A uses $1.60 (0.8 ATR), the 0.5-ATR test uses $1.00
const big = { sym: "BIG", side: "long", entry: 21.6, h: 21.6, l: 20.0, atr: 2 };
H.ok(Math.abs(V.noiseA.stop(big) - 1.6) < 1e-9 && Math.abs(V.noiseA_c50.stop(big) - 1.0) < 1e-9, "0.5-ATR cap: $1.00 stop where noise A uses $1.60");
H.ok(Math.abs(V.noiseA_c50.stop({ h: 20.1, l: 20.0, atr: 2 }) - 0.2) < 1e-9, "the 0.1-ATR floor still applies");
// late: first 9:35 bar opens through the level
const c = { sym: "XYZ", side: "long", entry: 20.5, h: 20.5, l: 20.0, atr: 2 };
const onTime = [m(0, 20.40, 20.70, 20.35, 20.65), m(1, 20.65, 21.40, 20.6, 21.3)];
const late = [m(0, 20.60, 20.90, 20.55, 20.85), m(1, 20.85, 21.40, 20.8, 21.3)];
const a1 = T.simulateExit(c, onTime, V.noiseA_ontime), a2 = T.simulateExit(c, late, V.noiseA_ontime), a3 = T.simulateExit(c, late, V.noiseA);
H.ok(a1.entered && !a2.entered && /skipped: already through at 9:35/.test(a2.reason) && a3.entered, "skip-late: trades the on-time breakout, skips the one already through at 9:35 (noise A takes both)", `${a2.reason}`);
const s1 = { ...c, side: "short", entry: 20.0 }, sLate = [m(0, 19.9, 19.95, 19.6, 19.7)];
H.ok(!T.simulateExit(s1, sLate, V.noiseA_ontime).entered, "skip-late works for shorts (opens at/below the low)");
// with SPY
const L = { ...c, _spyDir: -1 }, S = { ...c, side: "short", entry: 20.0, _spyDir: -1 }, U = { ...c, _spyDir: null };
H.ok(!T.simulateExit(L, onTime, V.noiseA_spy).entered && /against SPY's first 5 min \(down\)/.test(T.simulateExit(L, onTime, V.noiseA_spy).reason), "SPY's first candle down: the long is skipped");
H.ok(T.simulateExit(S, [m(0, 20.1, 20.1, 19.8, 19.85)], V.noiseA_spy).entered, "SPY down: the short is taken");
H.ok(T.simulateExit(U, onTime, V.noiseA_spy).entered, "SPY direction unknown: no filter");
// splitOpening reads SPY's 9:30-9:35 direction
const raw = { SPY: [m(-5, 735.05, 735.4, 734.9, 735.2), m(-1, 735.2, 735.5, 735.1, 735.36)], XYZ: [m(-5, 20, 20.5, 20, 20.4), ...onTime] };
const cc = [{ ...c }]; const sim = T.splitOpening(cc, raw, 958);
H.ok(cc[0]._spyDir === 1 && sim.XYZ.length === 2, "splitOpening: SPY 735.05 -> 735.36 in the first 5 min = up", String(cc[0]._spyDir));
// skipped trades are not counted as trades
const rv = T.replayVariants([L], { XYZ: onTime });
H.ok(rv.totals.noiseA_spy.trades === 0 && rv.totals.noiseA.trades === 1, "a skipped trade is not a trade in that rule's totals");

// gamma tag in the running totals
const st = {}; T.setHistState(st);
const day = (d, g, a) => ({ day: d, gamma: g, liveRule: "noiseA", cands: [], variants: { noiseA: { trades: 4, wins: 2, R: a, usd: a * 12.5, tradesNet: 4, winsNet: 2, Rnet: a, usdNet: a * 12.5 } } });
T.recordHistory(day("2026-11-09", "neg", 2)); T.recordHistory(day("2026-11-10", "pos", -3)); T.recordHistory(day("2026-11-11", "neg", 1));
const ht = SIP.historyTable(st), ra = ht.rules.find(r => r.key === "noiseA");
H.ok(ht.nights.neg === 2 && ht.nights.pos === 1 && ra.gamma.neg.Rnet === 3 && ra.gamma.neg.days === 2 && ra.gamma.pos.Rnet === -3 && ra.gamma.pos.n === 4,
     "each night carries its gamma regime; totals split negative vs positive", JSON.stringify(ra.gamma));
st._gexRegime = { SPY: "neg" };
T.recordHistory({ day: "2026-11-12", liveRule: "noiseA", cands: [], variants: { noiseA: { trades: 1, wins: 1, R: 1, usd: 12.5, tradesNet: 1, winsNet: 1, Rnet: 1, usdNet: 12.5 } } });
H.ok(st._sipHist.days.find(d => d.day === "2026-11-12").gamma === "neg", "a night without a scan-time tag falls back to the current regime");
H.done();
