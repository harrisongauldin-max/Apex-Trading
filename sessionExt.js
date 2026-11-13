// sessionExt.js — 11/13 (Harrison): running session high/low per ticker, from scan prices, 9:30–16:00 ET.
//
// Lets each intraday-trend entry record how long ago the day's high (for a call) or low (for a put) was set, and how far
// price has come off it. MEASUREMENT ONLY: it tags the entry (skipBy "ext-stale90" + two outcome columns) and changes nothing.
// Why: 150 past intraday-trend trades (10/08–11/12, telemetry prices) — entries 90+ min after the session extreme went
// 8-of-32 (−$655, t −2.4) — but that bucket was one of ~10 tested after the fact, so it has to prove itself on new trades.
"use strict";

const ET = "America/New_York";
const STALE_MIN = 90;
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: ET });
const etMin = (ms) => { const [h, m] = new Date(ms).toLocaleTimeString("en-GB", { timeZone: ET, hour12: false }).split(":").map(Number); return h * 60 + m; };

function update(state, ticker, px, now = Date.now()) {
  if (!ticker || !(px > 0)) return null;
  const m = etMin(now);
  if (m < 570 || m > 960) return null;
  const day = etDay(now);
  const all = state._sessExt || (state._sessExt = {});
  let e = all[ticker];
  if (!e || e.day !== day) e = all[ticker] = { day, hi: px, hiAt: now, lo: px, loAt: now };
  if (px > e.hi) { e.hi = px; e.hiAt = now; }
  if (px < e.lo) { e.lo = px; e.loAt = now; }
  return e;
}

// side "call" → measured from the session high; "put" → from the session low.
function at(state, ticker, side, px, now = Date.now()) {
  const e = (state._sessExt || {})[ticker];
  if (!e || e.day !== etDay(now) || !(px > 0)) return null;
  const call = side === "call", ext = call ? e.hi : e.lo, t = call ? e.hiAt : e.loAt;
  return { min: Math.max(0, Math.round((now - t) / 60000)), pullPct: +((call ? (ext - px) / ext : (px - ext) / ext) * 100).toFixed(3), ext };
}

module.exports = { update, at, STALE_MIN };
