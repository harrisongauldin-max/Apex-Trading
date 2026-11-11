// MR-fade wall must be INTACT (10/14). Real mrStrategy.evaluateMRFade: a put wall still below price qualifies a call
// fade; price already through it is "wall already broken" (no wall fade, no band fallback). Mirror for put fades.
// Negative-gamma path: an intact wall still also needs CVD exhaustion. WALL_REQUIRE_INTACT=false restores the old abs().
"use strict";
const H = require("./helpers"); H.quiet();
const { evaluateMRFade, MR } = require(H.R("mrStrategy.js"));
const call = { rsi: 22, vwapPct: -0.6, cvdSlope: 5 }, put = { rsi: 70, vwapPct: 0.6, cvdSlope: -5 };
const g = (reg, dPW, dCW) => ({ regime: reg, putWall: 730, callWall: 740, distPutWallPct: dPW, distCallWallPct: dCW });

H.ok(MR.WALL_REQUIRE_INTACT === true, "WALL_REQUIRE_INTACT is on");
H.ok(evaluateMRFade(call, g("pos", -0.20, 2), 731.5).fire, "call fade, put wall 0.20% BELOW price: fires (intact)");
H.ok(evaluateMRFade(call, g("pos", 0, 2), 730).fire, "call fade, price exactly at the wall: fires");
const b = evaluateMRFade(call, g("pos", 0.15, 2), 728.9);
H.ok(!b.fire && /wall already broken/.test(b.reason), "call fade, price 0.15% THROUGH the put wall: no fade", b.reason);
const b2 = evaluateMRFade({ ...call, vwapPct: -0.8 }, g("pos", 0.15, 2), 728.9);
H.ok(!b2.fire, "broken wall does not fall back to a VWAP-band fade either");
H.ok(MR.ALLOW_VWAP_BAND === false && !evaluateMRFade({ ...call, vwapPct: -0.6 }, g("pos", 0.5, 2), 726.4).fire, "10/15: VWAP-band fallback OFF (harness Sharpe ≈ −1) — no wall nearby, no fade");
MR.ALLOW_VWAP_BAND = true;
H.ok(evaluateMRFade({ ...call, vwapPct: -0.6 }, g("pos", 0.5, 2), 726.4).fire, "ALLOW_VWAP_BAND=true restores the band fade");
MR.ALLOW_VWAP_BAND = false;
H.ok(evaluateMRFade(put, g("pos", -3, 0.20), 738.5).fire, "put fade, call wall 0.20% ABOVE price: fires");
H.ok(!evaluateMRFade(put, g("pos", -3, -0.10), 740.7).fire, "put fade, price 0.10% through the call wall: no fade");
// 10/15: negative-gamma fades are OFF by default (contradict the literature); the strict path is still tested with the flag on
H.ok(MR.NEG_GAMMA_FADE === true && /regime not fade-friendly/.test(evaluateMRFade(call, g("neg", -0.10, 2), 730.7, { ...MR, NEG_GAMMA_FADE: false }).reason), "flag off: negative gamma, no fade at all (10/28: default is ON as a paper experiment)");
const NEG = { ...MR, NEG_GAMMA_FADE: true };
H.ok(evaluateMRFade(call, g("neg", -0.10, 2), 730.7, NEG).fire, "flag on: negative gamma, intact wall + CVD exhaustion fires");
H.ok(!evaluateMRFade({ ...call, cvdSlope: -5 }, g("neg", -0.10, 2), 730.7, NEG).fire, "flag on: intact wall but CVD still pushing: no fade");
H.ok(!evaluateMRFade(call, g("neg", 0.10, 2), 729.3, NEG).fire, "flag on: broken wall: no fade");
H.ok(evaluateMRFade(call, g("pos", 0.15, 2), 728.9, { ...MR, WALL_REQUIRE_INTACT: false }).fire, "WALL_REQUIRE_INTACT=false restores the old behaviour");
H.done();
