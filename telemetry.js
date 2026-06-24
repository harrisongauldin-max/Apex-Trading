// ============================================================
// ARGO SCORE TELEMETRY  (V3.2 — 6/23)
// Compact, decision-relevant trace of the scan. One CSV row per ticker on
// MATERIAL CHANGE (score moves >= SCORE_DELTA, isMR flip, blocker change, or
// intraday-RSI tier crossing) plus a forced heartbeat row every HEARTBEAT_MS so
// flat stretches still show continuity. Projects fields the scanner already
// computed — NO new computation, NO extra data fetch. Buffered in
// state._telemetryBuffer and flushed to argo:telemetry:<date> by
// saveTelemetryToRedis (state.js), which rides the daily-log save cadence.
//
// Goal: turn a ~6,000-line raw day into a few hundred signal rows that show the
// score trend AND what drove it, light enough to digest whole.
// ============================================================

const HEARTBEAT_MS = 5 * 60 * 1000;   // force a row at least every 5 min/ticker
const SCORE_DELTA  = 3;               // |score| move that counts as material
const MAX_ROWS     = 6000;            // safety cap on a runaway day
const BLOCKER_MAX  = 60;              // truncate the headline blocker text

const TELEMETRY_HEADER = "time,tkr,px,iRSI,dRSI,call,put,isMR,curl,vwap%,blocker,drivers";

// intraday-RSI tier — a crossing is "material" so dips/spikes always log a row
function _rsiTier(r) {
  if (r == null) return "na";
  if (r <= 30) return "deep";   // deeply oversold
  if (r <= 42) return "os";     // oversold
  if (r <= 48) return "near";   // near oversold
  if (r < 65)  return "mid";    // neutral
  if (r < 72)  return "elev";   // elevated
  return "ob";                  // overbought
}

// top-3 score components by |magnitude| → "Regime+20;dip+12;IVP-8" (the "why")
function topDrivers(reasons) {
  if (!Array.isArray(reasons)) return "";
  const scored = [];
  for (const r of reasons) {
    const m = /\(([+-]\d+)\)/.exec(String(r));   // the (+N)/(-N) score tag
    if (!m) continue;
    const v = parseInt(m[1], 10);
    if (!v) continue;
    let label = String(r).split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "x";
    scored.push({ v, label, mag: Math.abs(v) });
  }
  scored.sort((a, b) => b.mag - a.mag);
  return scored.slice(0, 3).map(d => `${d.label}${d.v > 0 ? "+" : ""}${d.v}`).join(";");
}

function _etTime() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
}

function _csv(s) {
  s = String(s == null ? "" : s);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// rec: { tkr, px, iRSI, dRSI, call, put, isMR, curl, vwapPct, blocker, callReasons, putReasons, direction }
// Returns true if a row was written. Never throws — instrumentation must not halt a scan.
function recordTelemetry(state, rec) {
  try {
    if (!state._telemetryBuffer) state._telemetryBuffer = [];
    if (!state._telemetryLast)   state._telemetryLast   = {};
    const now  = Date.now();
    const prev = state._telemetryLast[rec.tkr];
    const tier = _rsiTier(rec.iRSI);

    const material =
      !prev ||
      Math.abs((rec.call || 0) - (prev.call || 0)) >= SCORE_DELTA ||
      Math.abs((rec.put  || 0) - (prev.put  || 0)) >= SCORE_DELTA ||
      (!!rec.isMR !== !!prev.isMR) ||
      ((rec.blocker || "") !== (prev.blocker || "")) ||
      (tier !== prev.tier) ||
      (now - (prev.ts || 0)) >= HEARTBEAT_MS;
    if (!material) return false;

    const drivers = topDrivers(rec.direction === "put" ? rec.putReasons : rec.callReasons);
    const blocker = String(rec.blocker || "").replace(/\s+/g, " ").trim().slice(0, BLOCKER_MAX);

    const row = [
      _etTime(),
      rec.tkr,
      Number(rec.px || 0).toFixed(2),
      rec.iRSI == null ? "" : Number(rec.iRSI).toFixed(0),
      rec.dRSI == null ? "" : Number(rec.dRSI).toFixed(0),
      rec.call == null ? "" : rec.call,
      rec.put  == null ? "" : rec.put,
      rec.isMR ? "Y" : "N",
      rec.curl || "none",
      rec.vwapPct == null ? "" : (rec.vwapPct >= 0 ? "+" : "") + Number(rec.vwapPct).toFixed(1),
      blocker,
      drivers,
    ].map(_csv).join(",");

    state._telemetryBuffer.push(row);
    if (state._telemetryBuffer.length > MAX_ROWS)
      state._telemetryBuffer = state._telemetryBuffer.slice(-MAX_ROWS);

    state._telemetryLast[rec.tkr] = {
      call: rec.call, put: rec.put, isMR: !!rec.isMR, blocker: rec.blocker || "", tier, ts: now,
    };
    return true;
  } catch (_) {
    return false;   // never halt a scan over telemetry
  }
}

function telemetryCSV(rows) {
  return TELEMETRY_HEADER + "\n" + (Array.isArray(rows) ? rows.join("\n") : "");
}

module.exports = { recordTelemetry, telemetryCSV, topDrivers, TELEMETRY_HEADER };
