// 11/03: stocks-in-play EXIT VARIANTS — same entry, different exits, sized so each stop = 1R.
"use strict";
const H = require("./helpers"); H.quiet();
const SIP = require(H.R("stocksInPlay.js"));
const T = SIP._t, V = SIP.EXIT_VARIANTS;

const m = (k, o, h, l, c) => ({ t: new Date(Date.parse("2026-11-03T14:35:00Z") + k * 60000).toISOString(), o, h, l, c });
// long breakout: opening range 20.00-20.50, ATR $2 -> paper stop $0.20, OR stop $0.50, 1-ATR stop $2.00
const cand = { sym: "XYZ", side: "long", entry: 20.5, h: 20.5, l: 20.0, atr: 2 };
const bars = [
  m(0, 20.40, 20.60, 20.45, 20.55),   // breaks out, enters at 20.50
  m(1, 20.55, 20.60, 20.25, 20.40),   // morning shakeout: takes out the 10%-ATR stop (20.30), not the OR stop (20.00)
  m(2, 20.40, 21.20, 20.35, 21.10),   // runs
  m(3, 21.10, 21.60, 21.00, 21.50),   // peak 21.60 = +2.2R on the OR stop
  m(4, 21.50, 21.55, 20.90, 21.00),   // pulls back
  m(5, 21.00, 21.10, 20.95, 21.05),   // close
];
const r = {}; for (const k of Object.keys(V)) r[k] = T.simulateExit(cand, bars, V[k]);
H.ok(r.paper.R === -1 && r.paper.reason === "stop", "paper (10% ATR): shaken out by the first dip = -1R", JSON.stringify(r.paper));
H.ok(Math.abs(r.or.R - 1.1) < 1e-9 && r.or.reason === "close", "opening-range stop survives the dip, held to close = +1.1R", JSON.stringify(r.or));
H.ok(Math.abs(r.or_be.R - 1.2) < 1e-9 && r.or_be.reason === "ladder" && r.or_be.peakR === 2.2, "OR + breakeven/trail: peak +2.2R, trails out at +1.2R on the pullback", JSON.stringify(r.or_be));
H.ok(r.or_apex.entered && r.or_apex.reason === "ladder" && r.or_apex.R < 0.2, "OR + APEX options ladder (in R) locks very early — small exit", JSON.stringify(r.or_apex));
H.ok(Math.abs(r.atr1.R - 0.275) < 1e-9, "1-ATR stop holds to close = +0.275R (wide stop, small R)", JSON.stringify(r.atr1));

// paper stop + trail: the tight stop is shaken out by the same dip, so it behaves like paper on this path
H.ok(r.paper_be.R === -1, "paper stop + trail: same shakeout as the paper rule on this path", JSON.stringify(r.paper_be));
// a tight-stop trade that runs +6R then round-trips: paper gives back everything, paper_be keeps +5R
const run = [m(0, 20.40, 20.60, 20.45, 20.55), m(1, 20.55, 21.70, 20.50, 21.65), m(2, 21.65, 21.70, 20.20, 20.25)];
const p0 = T.simulateExit(cand, run, V.paper), p1 = T.simulateExit(cand, run, V.paper_be), p2 = T.simulateExit(cand, run, V.paper_be2);
H.ok(p0.R === -1 && Math.abs(p1.R - 5) < 1e-6 && p1.reason === "ladder" && Math.abs(p2.R - 4) < 1e-6, "runs to +6R then collapses: paper -1R, 1R-trail keeps +5R, 2R-trail keeps +4R", `${p0.R} ${p1.R} ${p2.R}`);
const q0 = T.simulateExit(cand, run, V.paper_t2), q1 = T.simulateExit(cand, run, V.paper_t2be), q2 = T.simulateExit(cand, run, V.paper_l05);
H.ok(q0.R === 2 && q0.reason === "target" && q1.R === 2 && Math.abs(q2.R - 5) < 1e-6, "2R target banks +2R (limit fill); -0.5R lock + trail keeps +5R on the +6R run", `${q0.R} ${q1.R} ${q2.R}`);
// rises to +1.5R then fails: breakeven version exits flat, -0.5R lock exits -0.5R, plain 2R target rides back to the -1R stop
const fail = [m(0, 20.40, 20.60, 20.45, 20.55), m(1, 20.55, 20.80, 20.52, 20.78), m(2, 20.78, 20.79, 20.10, 20.15)];
const f0 = T.simulateExit(cand, fail, V.paper_t2), f1 = T.simulateExit(cand, fail, V.paper_t2be), f2 = T.simulateExit(cand, fail, V.paper_l05);
H.ok(f0.R === -1 && f1.R === 0 && f2.R === -0.5, "peak +1.5R then fails: 2R target -1R, breakeven 0R, -0.5R lock -0.5R", `${f0.R} ${f1.R} ${f2.R}`);
const g0 = T.simulateExit(cand, fail, V.paper_l05t2), g1 = T.simulateExit(cand, run, V.paper_l05t2);
H.ok(g0.R === -0.5 && g1.R === 2 && g1.reason === "target", "Harrison's rule (-0.5R lock at +1R, 2R target): fails after +1.5R = -0.5R; runs = +2R", `${g0.R} ${g1.R}`);
const h0 = T.simulateExit(cand, run, V.paper_g05a), h1 = T.simulateExit(cand, fail, V.paper_g05b), h2 = T.simulateExit(cand, fail, V.paper_g05a);
H.ok(Math.abs(h0.R - 5.5) < 1e-6 && h0.reason === "ladder" && Math.abs(h1.R - 1.0) < 1e-6 && Math.abs(h2.R - 1.0) < 1e-6,
     "0.5R giveback: +6R run sells at +5.5R; +1.5R peak that fails sells at +1.0R (not back to 0 or -1R)", `${h0.R} ${h1.R} ${h2.R}`);
// 11/04: NET replay — entry fills 0.15 ATR past the level, stop exits 0.10 ATR past the stop, close 0.02 ATR
const K = { entryAtr: 0.15, exitAtr: 0.10, closeAtr: 0.02 };
const runN = [m(0, 20.40, 21.00, 20.45, 20.95), m(1, 20.95, 21.90, 20.90, 21.85), m(2, 21.85, 21.90, 20.20, 20.25)];
const n0 = T.simulateExit(cand, runN, V.paper_l05), n1 = T.simulateExit(cand, runN, V.paper_l05, true, K);
H.ok(Math.abs(n1.entryPx - 20.8) < 1e-9, "net: a 0.1-ATR stop strategy pays 0.15 ATR = 1.5R just to get in (entry 20.80 vs the 20.50 level)", String(n1.entryPx));
H.ok(Math.abs(T.simulateExit(cand, run, V.paper_l05, true, K).entryPx - 20.6) < 1e-9, "slippage never fills outside the entry bar's range (bar high 20.60)");
H.ok(n1.R < n0.R - 2, "net R is far below gross for the paper-width stop", `${n0.R} -> ${n1.R}`);
const w0 = T.simulateExit(cand, runN, V.atr50_l05), w1 = T.simulateExit(cand, runN, V.atr50_l05, true, K);
H.ok((w0.R - w1.R) < (n0.R - n1.R) / 3, "the same slippage costs a 0.5-ATR stop under a third as much R", `paper loses ${(n0.R - n1.R).toFixed(2)}R, 0.5 ATR loses ${(w0.R - w1.R).toFixed(2)}R`);
const st1 = T.simulateExit(cand, bars, V.paper, true, K);
H.ok(st1.R < -1.5 && st1.R >= -2, "net stop-out on the paper stop costs -1.5R to -2R (1R + exit slippage, bounded by the bar low)", String(st1.R));
const cap = T.simulateExit(cand, [m(0, 20.70, 20.90, 20.60, 20.85)], V.paper_l05_cap, true, K);
H.ok(!cap.entered && /limit not filled/.test(cap.reason), "capped entry: a bar that opens 0.1 ATR past the level never fills the stop-limit", JSON.stringify(cap));
const cap2 = T.simulateExit(cand, runN, V.paper_l05_cap, true, K);
H.ok(Math.abs(cap2.entryPx - 20.6) < 1e-9, "capped entry: slippage limited to 0.05 ATR (20.60, not 20.80)", String(cap2.entryPx));
const tgt = T.simulateExit(cand, runN, V.paper_t2, true, K);
H.ok(tgt.reason === "target" && tgt.R === 2, "a take-profit is a limit order: no exit slippage", JSON.stringify(tgt));
const rv = T.replayVariants([cand], { XYZ: runN });
H.ok(rv.totals.paper_l05.Rnet != null && rv.totals.paper_l05.Rnet < rv.totals.paper_l05.R && rv.perTrade.XYZ.paper_l05.Rnet != null, "replay totals carry gross and NET side by side", JSON.stringify(rv.totals.paper_l05));
// sizing: every rule risks the same 1R; the wider stop buys fewer shares
const rep = T.replayVariants([cand], { XYZ: bars });
const pt = rep.perTrade.XYZ;
H.ok(pt.paper.shares === 62 && pt.or.shares === 25 && pt.atr1.shares === 6, "shares per rule: $12.50 / stop distance (62 / 25 / 6)", `${pt.paper.shares}/${pt.or.shares}/${pt.atr1.shares}`);
H.ok(Math.abs(pt.or.usd - 13.75) < 1e-9 && Math.abs(pt.paper.usd + 12.4) < 1e-9, "dollars: OR +$13.75, paper -$12.40", `${pt.or.usd} ${pt.paper.usd}`);
H.ok(rep.totals.or.trades === 1 && rep.totals.or.wins === 1 && rep.totals.paper.wins === 0 && rep.totals.or.winPct === 100, "totals per rule");

// short mirror + a stock that never triggers
const sh = { sym: "SHT", side: "short", entry: 19.6, h: 20.0, l: 19.6, atr: 2 };
const sb = [m(0, 19.7, 19.75, 19.5, 19.55), m(1, 19.55, 19.85, 19.5, 19.8), m(2, 19.8, 19.82, 19.1, 19.15)];
const rs = T.simulateExit(sh, sb, V.or);
H.ok(rs.entered && Math.abs(rs.R - 1.125) < 1e-9, "short: OR stop 20.00 (range $0.40) survives the bounce to 19.85, close 19.15 = +1.125R", JSON.stringify(rs));
const nt = T.simulateExit({ sym: "N", side: "long", entry: 50, h: 50, l: 49, atr: 2 }, [m(0, 49.5, 49.9, 49.4, 49.6)], V.or);
H.ok(nt && !nt.entered, "never reaches the level: no trade under any rule");
// mid-session: open trade marked at the latest bar
const mid = T.simulateExit(cand, bars.slice(0, 4), V.or, false);
H.ok(mid.reason === "still open (marked)" && Math.abs(mid.R - 2) < 1e-9, "before the close: open trades are marked at the latest bar", JSON.stringify(mid));
H.done();
