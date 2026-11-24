// 11/24 (Harrison): the straddle gate compares implied vol ON TRADING TIME with the realized-vol forecast.
// The chain's IV is annualized on calendar days, the forecast on trading minutes (252 x 390); an expiry spanning a weekend or
// holiday read as cheap. 11/23: 11/30 expiry (7.2 calendar days, ~4.4 sessions) -> 0.98 / 1.00 quoted, both pairs lost $313.
// Also: "take profit at +10%" joins the replayed lock rules (replay only), scored on older pairs from their stored peak.
"use strict";
const H = require("./helpers"); H.quiet();
const TT = require(H.R("tradingTime.js"));
const ST = require(H.R("straddleStrategy.js"));
const C = require(H.R("constants.js"));

// November 2026 is EST: 10:21 ET = 15:21Z
const at = (day, hm) => { const [h, m] = hm.split(":").map(Number); return Date.parse(`${day}T00:00:00Z`) + (h + 5) * 3600000 + m * 60000; };
const near = (a, b, tol = 0.002) => Math.abs(a - b) < tol;

// calendar
H.ok(TT.sessionMinutes("2026-11-25") === 390 && TT.sessionMinutes("2026-11-26") === 0 && TT.sessionMinutes("2026-11-27") === 210 && TT.sessionMinutes("2026-11-28") === 0 && TT.sessionMinutes("2026-12-24") === 210 && TT.sessionMinutes("2027-01-01") === 0,
     "sessions: full day 390, Thanksgiving 0, the Friday after 210 (1:00 pm close), Saturday 0, 12/24/2026 210, 1/1/2027 0");
H.ok(TT.tradingMinutesTo(at("2026-11-23", "10:21"), "2026-11-30") === 339 + 390 + 390 + 0 + 210 + 390, "11/23 10:21 -> 11/30 close: 339 + 390 + 390 + 0 + 210 + 390 = 1,719 session minutes");
H.ok(TT.tradingMinutesTo(at("2026-11-23", "08:00"), "2026-11-23") === 390 && TT.tradingMinutesTo(at("2026-11-23", "16:30"), "2026-11-23") === 0 && TT.tradingMinutesTo(at("2026-11-21", "12:00"), "2026-11-23") === 390,
     "before the open counts the whole session, after the close none, a Saturday only what follows");

// the 11/23 pick: 7.2 calendar days, 4.41 sessions -> IV is 6.5% higher on trading time
const f23 = TT.factor(at("2026-11-23", "10:21"), "2026-11-30");
H.ok(f23 && near(f23.factor, 1.0646) && f23.sessions === 4.41 && f23.calDays === 7.24 && f23.covered === true, "11/23 -> 11/30: factor 1.065 (7.24 calendar days, 4.41 sessions)", JSON.stringify(f23));
// the 11/11 pick (Wed 10:50 -> Mon 11/16): 5.2 calendar days, 3.79 sessions -> slightly cheaper on trading time
const f11 = TT.factor(at("2026-11-11", "10:50"), "2026-11-16");
H.ok(f11 && near(f11.factor, 0.974) && f11.sessions === 3.79, "11/11 -> 11/16: factor 0.974", JSON.stringify(f11));
// a full week Monday -> Monday holds 5.9 sessions in 7.25 days: cheaper on trading time; Friday -> Monday dearer
const fMon = TT.factor(at("2026-11-09", "10:00"), "2026-11-16"), fFri = TT.factor(at("2026-11-20", "10:00"), "2026-11-23");
H.ok(near(fMon.factor, 0.919) && near(fFri.factor, 1.080), "Monday -> next Monday 0.919; Friday -> Monday 1.080", `${fMon.factor.toFixed(3)} ${fFri.factor.toFixed(3)}`);
H.ok(TT.factor(at("2026-11-23", "10:21"), "2026-11-20") === null && TT.factor(at("2026-11-23", "10:21"), "bad") === null && TT.factor(at("2026-11-23", "16:30"), "2026-11-23") === null,
     "an expired / unreadable expiry, or no session time left, gives no factor (the gate then keeps the quoted IV)");
H.ok(TT.factor(at("2026-12-30", "10:00") + 0, "2027-01-04").covered === true && TT.factor(Date.parse("2028-03-01T15:00:00Z"), "2028-03-06").covered === false, "2026-2027 holiday lists are in; a later year is flagged, weekdays only");

// the gate
H.ok(C.STRADDLE_IV_BASIS === "trading" && ST.V2.IV_BASIS === "trading", "ships on trading time (STRADDLE_IV_BASIS; \"calendar\" restores the old comparison)");
const spy = { exp: "2026-11-30", dte: 7, strike: 726, iv: 0.2423 }, qqq = { exp: "2026-11-30", dte: 7, strike: 655, iv: 0.3406 };
const now23 = at("2026-11-23", "10:21");
const oS = ST.decide(spy, 0.247, undefined, "forecast RV"), oQ = ST.decide(qqq, 0.342, undefined, "forecast RV");
H.ok(oS.fire && oQ.fire && near(oS.ratio, 0.981) && near(oQ.ratio, 0.996) && oS.basis === "calendar", "old comparison (no clock passed): 11/23 SPY 0.98 and QQQ 1.00 -> both bought", `${oS.ratio.toFixed(3)} ${oQ.ratio.toFixed(3)}`);
const nS = ST.decide(spy, 0.247, undefined, "forecast RV", now23), nQ = ST.decide(qqq, 0.342, undefined, "forecast RV", now23);
H.ok(!nS.fire && !nQ.fire && near(nS.ratio, 1.044) && near(nQ.ratio, 1.060) && nS.basis === "trading" && near(nS.ttFactor, 1.0646) && nS.ivQuoted === 0.2423,
     "on trading time: 1.04 and 1.06 -> neither pair is bought", `${nS.ratio.toFixed(3)} ${nQ.ratio.toFixed(3)}`);
H.ok(/ATM IV 25\.8% on trading time \(24\.2% quoted, 7DTE \$726, 4\.41 sessions\) \/ forecast RV 24\.7% = 1\.04 — not below 1\.00 \(options not cheap vs the tape\)$/.test(nS.reason), "the log line shows both IVs and the session count", nS.reason);
H.ok(nS.reason.split(" — ").pop() === "not below 1.00 (options not cheap vs the tape)", "the stand-down tally still reads the same reason text");
const p11 = { exp: "2026-11-16", dte: 5, strike: 758, iv: 0.1208 };
const n11 = ST.decide(p11, 0.121, undefined, "forecast RV", at("2026-11-11", "10:50"));
H.ok(n11.fire && near(n11.ratio, 0.972), "the 11/11 pair (0.998 quoted) still fires: 0.97 on trading time", n11.ratio.toFixed(3));
const cal = ST.decide(spy, 0.247, { ...ST.V2, IV_BASIS: "calendar" }, "forecast RV", now23);
H.ok(cal.fire && near(cal.ratio, 0.981) && cal.basis === "calendar", "STRADDLE_IV_BASIS \"calendar\" = the old comparison even with the clock");
H.ok(ST.decide({ ...spy, exp: null }, 0.247, undefined, "forecast RV", now23).basis === "calendar", "no expiry date on the pair -> quoted IV, never a crash");

// the pick is unchanged (lowest quoted IV)
const row = (type, exp, dte, iv) => ({ symbol: `S${exp}${type}`, type, strike: 726, exp, dte, bid: 9.0, ask: 9.1, iv, delta: type === "call" ? 0.5 : -0.5 });
const pk = ST.pickPair([row("call", "2026-11-24", 1, 0.33), row("put", "2026-11-24", 1, 0.33), row("call", "2026-11-30", 7, 0.24), row("put", "2026-11-30", 7, 0.24)], 726);
H.ok(pk.exp === "2026-11-30" && pk.iv === 0.24, "expiry pick unchanged: lowest quoted IV");

// wiring: the scanner hands the gate the clock; nothing in the order path changed
const sc = H.read("scanner.js");
H.ok(/STRADDLESTRAT\.decide\(_pair, _rvUse, undefined, _rvLbl, Date\.now\(\)\)/.test(sc), "scanner passes the clock to the gate");
H.ok(/liveStock\._stradIvRv = \+_dec\.ratio\.toFixed\(3\)/.test(sc), "the ratio stored on the pair is the one the gate used (trading time)");
H.ok(!/tradingTime/.test(H.read("execution.js")) && !/tradingTime/.test(H.read("exitEngine.js")), "order and exit paths don't read it");

// ── take profit +10%: replay only ──
H.ok(ST.LOCK_RULES.tp10 && ST.LOCK_RULES.tp10.tp === 10 && Object.keys(ST.LOCK_RULES).join(",") === "tp25,lock10at20,trail10,trail15at20,tp10", "tp10 added after the four existing replay rules");
const t0 = at("2026-11-23", "10:22");
const path = [[t0, -1], [t0 + 30000, 4.2], [t0 + 60000, 10.4], [t0 + 90000, 6], [t0 + 120000, -8.5]];
const R = ST.replayLocks(path, -8.5);
H.ok(R.tp10.fired && R.tp10.pct === 10.4 && !R.tp25.fired && R.tp25.pct === -8.5, "replay: +10% take profit sells at the first mark at/above +10% (+10.4%); +25% never fires = hold (-8.5%)", JSON.stringify(R.tp10));
H.ok(!ST.replayLocks([[t0, 1], [t0 + 30000, 6.4], [t0 + 60000, -8.5]], -8.5).tp10.fired, "a +6.4% peak (11/23 SPY) does not reach it");
// pairs closed before the rule existed: scored from the stored peak
const old = (sig, day, cost, pnl, peak) => ({ sig, day, rule: "har", ticker: "SPY", strike: 700, exp: day, dte: 5, ivrv: 0.99,
  legs: [{ type: "call", cost: cost / 2, pnl: pnl / 2, entry: 1, exit: 1, spread: 5 }, { type: "put", cost: cost / 2, pnl: pnl / 2, entry: 1, exit: 1, spread: 5 }],
  track: { peakPct: peak, lowPct: -1, peakAt: "13:50", lowAt: "11:07", samples: 600, locks: { tp25: { pct: +(pnl / cost * 100).toFixed(2), fired: false }, lock10at20: { pct: +(pnl / cost * 100).toFixed(2), fired: false }, trail10: { pct: +(pnl / cost * 100).toFixed(2), fired: false }, trail15at20: { pct: +(pnl / cost * 100).toFixed(2), fired: false } } } });
const pairs = [old("a", "2026-11-11", 856, 6, 11.57), old("b", "2026-11-23", 2486, -148, 4.22), old("c", "2026-11-23", 1947, -165, 6.37)];
const S = ST.pairStats(pairs, "2026-11-23"), tp = S.locks.find(l => l.key === "tp10"), t25 = S.locks.find(l => l.key === "tp25");
H.ok(tp.pairs === 3 && tp.fired === 1 && tp.est === 3 && Math.abs(tp.usd - (85.6 - 148 - 165)) < 1 && tp.holdUsd === -307, "older pairs: peak +11.6% -> booked at +10% ($85.60); peaks +4.2% / +6.4% -> hold (-$148, -$165)", JSON.stringify(tp));
H.ok(t25.pairs === 3 && Math.abs(t25.usd + 307) < 1 && t25.est === 0 && t25.fired === 0, "the existing rules are untouched");
const csv = ST.eodCSV(pairs).split("\n");
H.ok(/lock_trail15at20_pct,lock_tp10_pct,rvGate,ivBasis$/.test(csv[0]) && /,10,har,calendar$/.test(csv[1]) && /,-5\.95,har,calendar$/.test(csv[2]) && /,-8\.47,har,calendar$/.test(csv[3]), "CSV: lock_tp10_pct + ivBasis columns; older pairs read \"calendar\"", csv.slice(1).join(" | "));
H.ok(/Take profit at \+10% <span[^>]*>\(3 from the stored peak\)/.test(ST.eodSection(pairs, "2026-11-23")), "EOD table marks results taken from the stored peak");
const stt = {};   // a new pair records the basis it was opened under
ST.recordLeg(stt, { ticker: "SPY", optionType: "call", premium: 5, contracts: 1, strike: 700, signalId: "n1", _straddleHold: true, _stradRule: "har", contractSymbol: "n1c", openDate: new Date(t0).toISOString() }, { pnl: 1, qty: 1 });
H.ok(stt._stradPairs[0].ivBasis === "trading", "new pairs carry ivBasis \"trading\"");
H.ok(ST.lockOf({ track: null }, "tp10") === null && ST.lockOf({ track: { locks: {}, peakPct: 20 }, pct: 3 }, "trail10") === null, "no path / a non-target rule with no replay -> not scored (never a crash)");
H.done();
