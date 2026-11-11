// 11/08: long-straddle PAIR results — each closed leg recorded against its pair; EOD section, CSV and the pass-line stats.
"use strict";
const H = require("./helpers"); H.quiet();
const ST = require(H.R("straddleStrategy.js"));
const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const st = {};
const leg = (sig, type, prem, bid, ask, xb, xa, extra = {}) => ({ ticker: "SPY", optionType: type, premium: prem, contracts: 1, strike: 740, expDate: "2026-11-12", expiryDays: 3,
  signalId: sig, _straddleHold: true, _stradIvRv: 0.82, _stradRule: "har", _stradBid: bid, _stradAsk: ask, bid: xb, ask: xa, openDate: new Date().toISOString(), contractSymbol: sig + type, ...extra });
// pair 1: call +$180, put -$120 -> +$60 on $1,000
ST.recordLeg(st, leg("P1", "call", 5.0, 4.98, 5.02, 6.78, 6.82), { pnl: 180, exitPremium: 6.8, qty: 1, reason: "straddle-close" });
ST.recordLeg(st, leg("P1", "put", 5.0, 4.97, 5.03, 3.78, 3.82), { pnl: -120, exitPremium: 3.8, qty: 1, reason: "straddle-close" });
H.ok(st._stradPairs.length === 1 && st._stradPairs[0].legs.length === 2 && st._stradPairs[0].ivrv === 0.82, "both legs land on one pair (by signalId), IV/RV kept");
const l0 = st._stradPairs[0].legs[0];
H.ok(Math.abs(l0.spread - 4) < 1e-9 && l0.cost === 500, "spread paid estimate per leg = (entry half-spread + exit half-spread) x 100 ($0.02 + $0.02 -> $4)", JSON.stringify(l0));
H.ok(ST.recordLeg(st, { ticker: "SPY", premium: 3 }, { pnl: 5 }) === null && st._stradPairs.length === 1, "non-straddle positions are ignored");
// pair 2 loses 400; pair 3 one leg only (orphan)
ST.recordLeg(st, leg("P2", "call", 6, 5.98, 6.02, 4.0, 4.04), { pnl: -200, qty: 1, reason: "straddle-close" });
ST.recordLeg(st, leg("P2", "put", 6, 5.98, 6.02, 4.0, 4.04), { pnl: -200, qty: 1, reason: "straddle-close" });
ST.recordLeg(st, leg("P3", "call", 4, 3.98, 4.02, 3.9, 3.94), { pnl: -10, qty: 1, reason: "straddle-orphan" });
const S = ST.pairStats(st._stradPairs, day);
H.ok(S.n === 2 && S.wins === 1 && S.total === -340 && S.mean === -170 && S.incomplete === 1 && S.today.length === 3, "stats over COMPLETE pairs only; the one-leg pair is counted separately", JSON.stringify(S).slice(0, 200));
H.ok(Math.abs(S.sd - 325.27) < 0.01 && Math.abs(S.t - (-0.74)) < 0.01 && /collecting \(2 of ~30 pairs\)/.test(S.verdict), "t-stat = mean / (sd / sqrt n); verdict waits for ~30 pairs", `${S.sd} ${S.t}`);
const many = []; for (let i = 0; i < 30; i++) many.push({ sig: "S" + i, day, rule: "har", ticker: "SPY", legs: [{ type: "call", cost: 500, pnl: 40 + (i % 3) * 10 }, { type: "put", cost: 500, pnl: -10 }] });
const S2 = ST.pairStats(many, day);
H.ok(S2.n === 30 && S2.mean > 0 && S2.t >= 2 && /^PASS/.test(S2.verdict), "30 pairs, mean > 0, t >= 2 -> PASS", `${S2.mean} t ${S2.t}`);
const bad = many.map((p, i) => ({ ...p, legs: [{ type: "call", cost: 500, pnl: i % 2 ? 60 : -70 }, { type: "put", cost: 500, pnl: 0 }] }));
H.ok(/^FAIL/.test(ST.pairStats(bad, day).verdict), "30 pairs that don't clear the line -> FAIL (to shadow)");
const html = ST.eodSection(st._stradPairs, day);
H.ok(/Long straddle/.test(html) && /\+\$60\.00/.test(html) && /−\$400\.00/.test(html) && /ONE LEG ONLY/.test(html) && /Running: <b>2<\/b> pairs, 1 won/.test(html) && /t = -0\.74/.test(html), "EOD section: today's pairs + running line with t and the verdict");
H.ok(ST.eodSection([], day) === "", "no pairs ever: no section");
const csv = ST.eodCSV(st._stradPairs).split("\n");
H.ok(csv[0].startsWith("day,ticker,strike,exp,dte,ivrv,complete,cost,pnl") && csv.length === 4 && /,true,1000,60,6,/.test(csv[1]) && /,har$/.test(csv[1]), "CSV: one row per pair (running)", csv[1]);
// wiring
const ce = H.read("closeEngine.js"), rp = H.read("reporting.js"), ex = H.read("execution.js");
H.ok(/if \(pos\._straddleHold\) require\('\.\/straddleStrategy'\)\.recordLeg\(state, pos, \{ pnl, exitPremium: ep, qty: contractsToSell, reason \}\)/.test(ce), "closeEngine records every closed straddle leg");
H.ok(/stradPairs:\s+JSON\.parse\(JSON\.stringify\(state\._stradPairs/.test(rp) && /argo-straddle-\$\{dateStr\}\.csv/.test(rp) && /straddleStrategy'\)\.eodSection\(_eodSnap\.stradPairs/.test(rp), "EOD report: section + argo-straddle CSV");
H.ok(/_sp\._stradBid = contract && contract\.bid != null/.test(ex), "entry quote stored on the leg (for the spread estimate)");
H.done();
