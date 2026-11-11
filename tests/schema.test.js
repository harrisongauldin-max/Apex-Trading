// CSV schemas: telemetry and outcome rows must always match their headers, whatever fields a record carries.
"use strict";
const H = require("./helpers"); H.quiet();
const T = require(H.R("telemetry.js")), O = require(H.R("outcomes.js"));
const st = {};
T.recordTelemetry(st, { tkr: "SPY", px: 1 });
T.recordTelemetry(st, { tkr: "QQQ", px: 2, gexRaw: "neg", orHi: 770.6, orLo: 770.1, orTHi: 770.8, orTLo: 770, vixEst: 17.2, vixSrc: "anchored", intCumTick: -3, evt: "CPI" });
const th = T.TELEMETRY_HEADER.split(",").length;
const tr = (st._telemetryBuffer || []).map(r => r.split(",").length);
H.ok(tr.length === 2 && tr.every(n => n === th), "telemetry rows match the header", `header ${th}, rows ${tr.join("/")}`);
const oh = O.OUTCOME_HEADER.split(",").length;
const base = { premium: 1, openDate: new Date().toISOString(), contracts: 1 }, o = { closeTime: Date.now(), pnl: 1 };
const rows = [
  O.buildOutcomeRow(base, o),
  O.buildOutcomeRow({ ...base, _iMeta: { adxTier: "40+", gexReg: "pos", skipBy: ["adx<40"], winMin: 3 }, _iOrTag: { w: 0.07, brk: 0.01, opp: true, tw: 0.2, tbrk: -0.01, topp: false } }, o),
  O.buildOutcomeRow({ ...base, _isMrFade: true, _mrInvalidation: 775.004, _mrMeta: { stretchZ: 4, loc: "vwap-band", gexReg: "pos" }, _mrInvHit: { min: 12, optChg: -16 } }, o),
  O.buildOutcomeRow({ ...base, _mkt: { vixSrc: "anchored", term9d: 0.9 }, _ctx: { openType: "drive-up" } }, o),
].map(r => r.split(",").length);
H.ok(rows.every(n => n === oh), "outcome rows match the header (plain / itrend / mr-fade / context)", `header ${oh}, rows ${rows.join("/")}`);
const wi = O.OUTCOME_HEADER.split(",").indexOf("eWinMin");
const r2 = O.buildOutcomeRow({ ...base, _iMeta: { adxTier: "40+", skipBy: [], winMin: 108 } }, o).split(",");
H.ok(wi > 0 && r2[wi] === "108", "eWinMin column carries the intraday-trend window age", `col ${wi} = ${r2[wi]}`);
H.done();
