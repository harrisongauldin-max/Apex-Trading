// ============================================================
// APEX OUTCOME-JOINED TABLE  (8/05)
// One flat CSV row per FULLY-CLOSED trade, joining the decision context (X —
// the features present at entry) to the realized outcome (y — how the trade
// actually resolved). This is the (X, y) table that makes every signal, gate,
// and threshold measurable: "did breakout-structure calls reach +12.5% more
// often than context-only calls", "win rate by score bucket", etc.
//
// WHY THIS EXISTS separate from state.closedTrades: closedTrades has entry
// features and final P&L, but (a) only daysHeld — which rounds every intraday
// trade to 0 — and (b) NO hold trajectory (peak%, MAE%, rung hits), which is
// exactly what separates "bad entry" from "good entry we exited badly". It is
// also buried in the state blob, not a flat analyzable table.
//
// Pure projection: reads fields the position + close record ALREADY carry
// (plus pos._entryX stamped at entry in execution.js). NO new data fetch, NO
// trading behavior. Buffered in state._outcomeBuffer and flushed to
// argo:outcomes:<date> by saveOutcomesToRedis (state.js), riding the daily-log
// save cadence — no new timers.
// ============================================================
'use strict';

const MAX_ROWS = 4000;   // safety cap on the daily buffer (a busy day is ~dozens of closes)

// Column order is the schema. Keep it stable — downstream analysis keys off it.
const OUTCOME_HEADER = [
  // ── identity / timing ──
  "date","openET","closeET","minHeld","ticker","side","dteBand","dteEntry","strike","contractSym",
  // ── decision context (X): what was true at ENTRY ──
  "score","isMR","eVIX","eRegime","eRSI","eDRSI","eADX","eMACD","eMomentum","eMacro","eRelStr",
  "ivr","eIV","delta","eBreadth","eBreadthMom","eIVP","eVwapDist","eBuActive","eGap","ePrem","contracts","cost",
  // ── hold trajectory (the labels closedTrades lacks) ──
  "peakPct","confPeakPct","maePct","minToPeak","rung5","rung125","trailFloor",
  // ── outcome (y) ──
  "exitReason","exitPrem","pnl","pnlPct","won","uEntry","uExit",
  // ── appended 8/09 (schema grows at the TAIL so older rows stay column-aligned) ──
  "eRangePct","entryStrategy",
  // ── appended 8/11: vol infrastructure. Schema grows at the TAIL so every older row stays
  // column-aligned and prior CSVs remain readable by the same parser.
  "rv","rvMethod","rvSparse","vrp","ivrvRatio","volRegime",
  "atmIV","skew","termSlope","chainN","medSpread","spreadPct","spreadCostShare",
  "reqMovePct","availMovePct","feasRatio",
  // appended 8/11 (items 1/3): paperSlipPct is PAPER-SIMULATED — Alpaca paper fills do not
  // model real queue position, so treat it as a FLOOR on live slippage, never a prediction.
  "midAtDecision","paperSlipPct",
].join(",");

function _csv(s) {
  s = String(s == null ? "" : s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function _etTime(ms) {
  return new Date(ms == null ? Date.now() : ms).toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
}
function _etDate(ms) {
  return new Date(ms == null ? Date.now() : ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
const _n = (v, d = 2) => (typeof v === "number" && isFinite(v)) ? parseFloat(v.toFixed(d)) : "";

// Build one flat row (CSV string) from a closing position + its trade-outcome record.
// `pos` still carries every entry field + hold extreme at the close site; `o` is the
// tradeOutcome object (pnl/pct/reason/won). Nothing here can throw into the close path —
// recordOutcome wraps the call — but each field is defensively defaulted regardless.
function buildOutcomeRow(pos, o) {
  const prem   = pos.premium || 0;
  const openMs = pos.openDate ? new Date(pos.openDate).getTime() : (pos.entryTime ? new Date(pos.entryTime).getTime() : null);
  const closeMs = (o && o.closeTime) || Date.now();

  const peakPct     = prem > 0 ? ((pos.peakPremium   || prem) - prem) / prem * 100 : 0;
  const confPeakPct = prem > 0 ? ((pos._confirmedPeak || prem) - prem) / prem * 100 : 0;
  const maePct      = (prem > 0 && pos.troughPremium != null) ? (pos.troughPremium - prem) / prem * 100 : 0;
  const minHeld     = openMs ? (closeMs - openMs) / 60000 : "";
  const minToPeak   = (openMs && pos._peakTime) ? (pos._peakTime - openMs) / 60000 : "";
  // Rungs measured off the CONFIRMED peak — that is what the trail-floor exit model actually uses.
  const rung5   = confPeakPct >= 5    ? 1 : 0;
  const rung125 = confPeakPct >= 12.5 ? 1 : 0;

  const x = pos._entryX || {};
  const delta = pos.greeks && pos.greeks.delta != null ? parseFloat(pos.greeks.delta) : "";

  const row = [
    _etDate(closeMs), _etTime(openMs), _etTime(closeMs), _n(minHeld, 1),
    pos.ticker || "", pos.optionType || "", pos.dteBand || "", pos.expDays ?? pos.expiryDays ?? "",
    pos.strike ?? "", pos.contractSymbol || "",
    // X
    pos.score ?? "", pos.isMeanReversion ? 1 : 0, _n(pos.entryVIX, 1), pos.entryRegime || "",
    _n(pos.entryRSI, 0), _n(pos.entryDailyRSI, 0), _n(pos.entryADX, 0), pos.entryMACD || "",
    pos.entryMomentum || "", pos.entryMacro || "", _n(pos.entryRelStr, 2),
    pos.ivr ?? "", _n(pos.iv, 3), _n(delta, 3),
    _n(x.breadth, 0), _n(x.breadthMom, 1), _n(x.ivp, 0), _n(x.vwapDist, 3),
    (x.buActive ? 1 : 0), x.gapState || "", _n(prem, 2), pos.contracts ?? "", _n(pos.cost, 0),
    // hold
    _n(peakPct, 1), _n(confPeakPct, 1), _n(maePct, 1), _n(minToPeak, 1),
    rung5, rung125, (pos.trailFloorPct != null ? _n(pos.trailFloorPct * 100, 1) : ""),
    // y
    (o && o.reason) || "", _n(o && o.exitPremium, 2), _n(o && o.pnl, 2),
    _n(o && (o.pct != null ? parseFloat(o.pct) : (o && o.pnlPct)), 1),
    (o && o.won) ? 1 : 0, _n(x.underlying, 2), _n(pos.price, 2),
    _n(x.rangePct, 3), pos.entryStrategy || "",   // appended 8/09
    // appended 8/11 — keep last, matching OUTCOME_HEADER's tail
    _n(x.rv, 4), x.rvMethod || "", (x.rvSparse != null ? x.rvSparse : ""),
    _n(x.vrp, 4), _n(x.ivrvRatio, 3), x.volRegime || "",
    _n(x.atmIV, 4), _n(x.skew, 4), (x.termSlope != null ? x.termSlope : ""),
    (x.chainN != null ? x.chainN : ""), _n(x.medSpread, 4), _n(x.spreadPct, 4), _n(x.spreadCostShare, 1),
    _n(x.reqMovePct, 4), _n(x.availMovePct, 4), _n(x.feasRatio, 3),
    _n(x.midAtDecision, 2), _n(x.slipPct, 3),
  ].map(_csv).join(",");

  return row;
}

// Append a closed-trade outcome row to the daily buffer. Safe to call from the close
// path: any error is swallowed so an observation can never disturb a real close.
function recordOutcome(state, pos, o) {
  try {
    if (!state) return;
    if (!Array.isArray(state._outcomeBuffer)) state._outcomeBuffer = [];
    state._outcomeBuffer.push(buildOutcomeRow(pos, o));
    if (state._outcomeBuffer.length > MAX_ROWS) state._outcomeBuffer = state._outcomeBuffer.slice(-MAX_ROWS);
  } catch (_e) { /* observation only — never disturb a close */ }
}

// header + rows, for the download endpoint / EOD export.
function outcomesCSV(rows) {
  return [OUTCOME_HEADER].concat(Array.isArray(rows) ? rows : []).join("\n");
}

module.exports = { recordOutcome, buildOutcomeRow, outcomesCSV, OUTCOME_HEADER };
