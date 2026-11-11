// Scanner measurement blocks (10/7, 10/12), run as the REAL code extracted from scanner.js:
// mr-fade post-exit shadow, in-position shadow invalidation, intraday-trend meta-labels, mr-fade stamps, z accumulator.
"use strict";
const H = require("./helpers"); H.quiet();
const src = H.read("scanner.js");
const block = (startComment, head) => H.extractBlock(src, head, { includeHead: true, fromIndex: src.indexOf(startComment) });
const tryRun = (name, f) => { try { f(); } catch (e) { H.ok(false, name, e.message); } };

// ---- 1) mr-fade POST-EXIT shadow (10/12) ----
tryRun("post-exit shadow block", () => {
  const i0 = src.indexOf("// 10/12 (Harrison): mr-fade POST-EXIT SHADOW");
  if (i0 < 0) throw new Error("anchor not found");
  const code = H.extractBlock(src, "if (price > 0 && Array.isArray(state._entryFwd))", { includeHead: true, fromIndex: i0 });
  const run = new Function("state", "stock", "price", "vwap", code);
  const t0 = Date.now();
  const row = { ticker: "QQQ", side: "call", at: t0 - 2 * 60000, px: 751.89, mrInv: 750.01, mrTgt0: 754.1, mrInvMin: null, mrTgtMin: null, mrMfe: 0, mrMae: 0, mr60: null, mrTrack: 0, mrDone: false };
  const plain = { ticker: "QQQ", side: "call", at: t0 - 2 * 60000, px: 751.89 };
  const other = { ...row, ticker: "SPY" };
  const st = { _entryFwd: [row, plain, other] };
  run(st, { ticker: "QQQ" }, 752.30, 754.0);
  H.ok(row.mrMfe > 0 && row.mrInvMin === null && row.mrTgtMin === null, "favorable move tracked, nothing hit yet", `mfe ${row.mrMfe}%`);
  run(st, { ticker: "QQQ" }, 749.90, 754.0);
  H.ok(row.mrInvMin != null && row.mrInvMin >= 1.9 && row.mrMae < -0.25, "invalidation crossing recorded (minutes after ENTRY)", `invMin ${row.mrInvMin}, mae ${row.mrMae}%`);
  const firstInv = row.mrInvMin;
  run(st, { ticker: "QQQ" }, 748.0, 754.0);
  H.ok(row.mrInvMin === firstInv, "only the FIRST invalidation crossing is kept");
  run(st, { ticker: "QQQ" }, 754.2, 754.0);
  H.ok(row.mrTgtMin != null, "reaching session VWAP records the target hit", `tgtMin ${row.mrTgtMin}`);
  row.at = t0 - 61 * 60000; run(st, { ticker: "QQQ" }, 753.0, 754.0);
  H.ok(row.mrDone === true && row.mr60 != null && row.mrTrack === 60, "stops after 60 min with the 60-min move", `mr60 ${row.mr60}%`);
  const snap = JSON.stringify(row); run(st, { ticker: "QQQ" }, 700, 754.0);
  H.ok(JSON.stringify(row) === snap, "finished rows are never updated again");
  H.ok(plain.mrMfe === undefined && other.mrMfe === 0, "non-fade rows and other tickers untouched");
  const put = { ticker: "QQQ", side: "put", at: Date.now() - 60000, px: 750, mrInv: 751.88, mrInvMin: null, mrTgtMin: null, mrMfe: 0, mrMae: 0, mrDone: false };
  run({ _entryFwd: [put] }, { ticker: "QQQ" }, 752.0, 748.0);
  H.ok(put.mrInvMin != null && put.mrMae < 0, "put fade: invalidation is ABOVE entry");
});

// ---- 2) in-position shadow invalidation (10/7) ----
tryRun("in-position shadow block", () => {
  const code = H.extractBetween(src, "    try {\n      for (const _p of (state.positions || [])) {\n        if (!_p._isMrFade", "} catch (_sivErr) { /* measurement only */ }");
  const S = new Function("state", "liveStock", "price", "markDirty", "logEvent", code); const L = [];
  const st = { positions: [{ ticker: "SPY", optionType: "call", _isMrFade: true, _mrInvalidation: 775, premium: 5, currentPrice: 4.2, openDate: new Date(Date.now() - 12 * 60000).toISOString() }] };
  S(st, { ticker: "SPY" }, 776, () => {}, (t, m) => L.push(m));
  S(st, { ticker: "SPY" }, 774.9, () => {}, (t, m) => L.push(m));
  S(st, { ticker: "SPY" }, 770, () => {}, (t, m) => L.push(m));
  const h = st.positions[0]._mrInvHit;
  H.ok(h && h.optChg === -16 && L.length === 1, "in-position shadow records the first crossing only", h ? `${h.min} min, ${h.optChg}%` : "none");
});

// ---- 3) intraday-trend meta-labels (10/7) ----
tryRun("meta-label block", () => {
  const code = H.extractBetween(src, "try {   // 10/7 (Harrison): META-LABEL", "} catch (_mErr) { liveStock._iMeta = null; }");
  const B = new Function("state", "liveStock", "_iAdx", "_iSide", "ITREND_LATE_ADX_MIN", "logEvent", "_iH", "ITREND_START_ET", "_iDT", "price", code);
  const lab = (adx, gex, orTag, h = 10.05, side = "call", dt = null, px = 780) => { const ls = { ticker: "SPY", _iOrTag: orTag }; B({ _gexNow: gex ? { SPY: gex } : {} }, ls, adx, side, 40, () => {}, h, 10.0, dt, px); return ls._iMeta; };
  let m = lab(26, { regime: "pos", netGexM: 2248, distFlipPct: 0.21 }, { opp: true, tbrk: -0.018, topp: false });
  H.ok(m.adxTier === "25-40" && m.skipBy.join() === "adx<40,or-opp-broken,or-textbook-no-break", "labels a weak entry", m.skipBy.join(", "));
  m = lab(45, { regime: "pos", netGexM: 4396, distFlipPct: 0.6 }, { opp: false, tbrk: 0.12, topp: false });
  H.ok(m.adxTier === "40+" && m.skipBy.length === 0, "clean strong entry: no flags");
  m = lab(30, null, null);
  H.ok(m && m.gexReg === null && m.skipBy.join() === "adx<40", "missing GEX / opening range: labels without crashing");
  H.ok(lab(30, null, null, 10.05).winMin === 3 && lab(30, null, null, 11 + 48 / 60).winMin === 108, "minutes since the 10:00 window opened (10:03 -> 3, 11:48 -> 108)");
  const up = { ma50: 765, ma100: 755 }, dn = { ma50: 765, ma100: 775 };
  const pa = lab(30, null, null, 10.5, "put", up, 778), cw = lab(30, null, null, 10.5, "call", up, 778), pw = lab(30, null, null, 10.5, "put", dn, 760);
  const mixed = lab(30, null, null, 10.5, "put", up, 760), none = lab(30, null, null, 10.5, "put", null, 778);
  H.ok(pa.dTrend === "against" && pa.skipBy.includes("vs-daily-trend") && cw.dTrend === "with" && !cw.skipBy.includes("vs-daily-trend") && pw.dTrend === "with",
    "daily-trend alignment: put in a daily uptrend = against (flagged), call = with, put in a downtrend = with");
  H.ok(mixed.dTrend === "none" && none.dTrend === null, "price between the MAs = none; no daily data = blank, not a guess");
});

// ---- 4) mr-fade entry stamps + z accumulator (10/7) ----
tryRun("mr-fade stamp block", () => {
  const code = H.extractBetween(src, "try {   // 10/7 (Harrison): mr-fade MEASUREMENT stamps", "} catch (_mmErr) { liveStock._mrMeta = null; }");
  const E = new Function("state", "liveStock", "_mrDec", "_mrVwap", "price", "logEvent", code); const ls = { ticker: "QQQ", intradayVWAP: 750 };
  E({ _driftAcc: { QQQ: { zN: 40, zSS: 40 * 0.01 } }, _dailyMA: { QQQ: { atr: 9 } }, _gexNow: { QQQ: { regime: "pos", netGexM: 2985.4, distFlipPct: 1.1, callWall: 755, putWall: 740 } } },
    ls, { side: "put", locationSource: "vwap-band" }, 0.40, 753.0, () => {});
  const m = ls._mrMeta;
  H.ok(m && m.stretchZ === 4 && m.stretchAtr === 0.333 && m.wallDistPct === -0.266, "z-score, ATR stretch and wall distance", m ? `z ${m.stretchZ}, ${m.stretchAtr} ATR` : "none");
  const acc = H.extractBetween(src, "// 10/7: session RMS of the VWAP deviation", "_da.zSS = (_da.zSS || 0) + _dv * _dv; }");
  const A = new Function("_todayBars", "_last", "_vw", "_da", acc); const da = {};
  [0.1, -0.2, 0.3].forEach((d, i) => { A([{ t: "T" + i }], 780 * (1 + d / 100), 780, da); A([{ t: "T" + i }], 780 * (1 + d / 100), 780, da); });
  H.ok(da.zN === 3, "z accumulator: one sample per 1-min bar", `n=${da.zN} from 6 calls`);
});
H.done();
