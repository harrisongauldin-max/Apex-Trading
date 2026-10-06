// vixContext.js — VIX ANCHORING + TERM STRUCTURE (10/6, Harrison).
//
// PROBLEM: getVIX() returned the VIXY share price, and every VIX risk gate (black-swan close-all, calls blocked
// at 30, pause at 35, ...) compared VIX-scale thresholds against it. VIXY is a VIX-FUTURES ETF: its price is
// not anchored to the VIX index, it drifts with futures roll, and a reverse split would make it jump overnight
// (which the black-swan velocity check would read as a volatility explosion).
//
// FIX (no new paid feed): anchor to the OFFICIAL prior-day VIX close from Cboe and scale it by VIXY's move
// since ITS prior close:   vixEst = VIX_prevClose(Cboe) x (VIXY_now / VIXY_prevClose)
//   - Only anchors when Cboe's latest close is for the SAME date as VIXY's prior daily bar (no date mismatch).
//   - Limitation, stated plainly: VIXY tracks futures, so it moves LESS than spot VIX intraday. The estimate is
//     level-correct at the open and direction-correct intraday, but it understates intraday spikes.
// SPLIT GUARD: a VIXY move that is almost exactly a split factor (2,3,4,5,8,10,20x or the inverse, within 3%)
// is treated as a corporate action, not volatility — the last good reading is held. Genuine spikes of any
// other size pass through, so crash protection is never disabled.
// TERM STRUCTURE (prior-day closes): VIX9D/VIX > 1 = near-term stress (inverted front); VIX/VIX3M > 1 = curve in
// backwardation (classic risk-off). Measurement only.

const CBOE = "https://cdn.cboe.com/api/global/us_indices/daily_prices/";
const FILES = { vix: CBOE + "VIX_History.csv", vix9d: CBOE + "VIX9D_History.csv", vix3m: CBOE + "VIX3M_History.csv" };

// Cboe history CSV -> { date: "YYYY-MM-DD", close } for the newest valid row. Columns are found by header name
// (CLOSE), falling back to the last column, so a sister file with a different layout can't silently break it.
function parseCboeCsv(text) {
  if (!text || text.length < 20) return null;
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) return null;              // header + at least one row
  const hdr = lines[0].split(",").map(s => s.trim().toUpperCase());
  let ci = hdr.indexOf("CLOSE");
  if (ci < 0) ci = hdr.length - 1;
  for (let i = lines.length - 1; i >= 1; i--) {
    const f = lines[i].split(",");
    const close = parseFloat(f[ci]);
    const raw = (f[0] || "").trim();
    let date = null;
    let m;
    if ((m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) date = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    else if (/^\d{4}-\d{2}-\d{2}/.test(raw)) date = raw.slice(0, 10);
    if (date && Number.isFinite(close) && close > 0 && close < 300) return { date, close: +close.toFixed(2) };
  }
  return null;
}

// Is r (VIXY now / VIXY prev close) suspiciously close to a split/reverse-split factor?
const SPLIT_FACTORS = [2, 3, 4, 5, 8, 10, 20];
function looksLikeSplit(r) { return splitFactor(r) != null; }
// Nearest split factor as a signed multiplier on price (4 = 1:4 reverse split, 0.25 = 4:1 forward), or null.
function splitFactor(r) {
  if (!(r > 0)) return null;
  const x = r >= 1 ? r : 1 / r;
  const f = SPLIT_FACTORS.find(f => Math.abs(x - f) / f <= 0.03);
  return f == null ? null : (r >= 1 ? f : 1 / f);
}

let _ref = null;          // { asOf, vix, vix9d, vix3m, term9d, term3m, fetchedAt }
let _last = null;         // last good estimate { value, ts }
let _lastFamily = null;   // 'vix' (anchored/carry) or 'vixy' (legacy) — a change means the units changed
function setRef(ref) { _ref = ref; return _ref; }
function getRef() { return _ref; }

// Core: returns { value, source, ... }. vixyNow/vixyPrev from VIXY's snapshot; vixyPrevDate = date of its prior bar.
function anchored(vixyNow, vixyPrev, vixyPrevDate, opts = {}) {
  const enabled = opts.enabled !== false;
  const out = { vixyNow, vixyPrev, ratio: (vixyNow > 0 && vixyPrev > 0) ? vixyNow / vixyPrev : null };
  const sf = (out.ratio != null && !opts.noSplitCheck) ? splitFactor(out.ratio) : null;
  if (sf != null) {
    out.splitSuspect = true;
    out.splitFactor = sf;
    const ck0 = opts.carryK;
    if (ck0 && ck0.k > 0 && vixyNow > 0) {
      // VIXY's price changed by the split factor, VIX did not: each $ of VIXY now represents 1/sf as much VIX.
      // If the carry factor was ALREADY adjusted for this same split (same factor, same prior-bar date), use it as
      // is — re-dividing every minute would compound. The caller persists kAdj only after the split is confirmed.
      const already = ck0.splitAdj && ck0.splitAdj.f === sf && ck0.splitAdj.d === vixyPrevDate;
      out.kAdj = already ? ck0.k : ck0.k / sf;
      out.value = +(out.kAdj * vixyNow).toFixed(2);
      out.source = already ? "carry(split-adj)" : "carry(split-pending)";
    } else {
      out.value = _last ? _last.value : (_ref ? _ref.vix : null);
      out.source = "held(split-suspect)";
    }
    out.family = _lastFamily || "vix";            // same units as before — not a unit change
    if (out.value > 0) _last = { value: out.value, ts: Date.now() };
    return out;
  }
  const ck = opts.carryK;    // { k, ts } — last anchoring factor (VIX per $ of VIXY), persisted in state
  if (enabled && _ref && _ref.vix > 0 && out.ratio != null && vixyPrevDate && _ref.asOf === vixyPrevDate) {
    out.value = +(_ref.vix * out.ratio).toFixed(2);
    out.source = "anchored";
    out.k = vixyNow > 0 ? out.value / vixyNow : null;
  } else if (enabled && ck && ck.k > 0 && vixyNow > 0 && Date.now() - (ck.ts || 0) < 4 * 86400000) {
    // Can't anchor right now (Cboe ref missing/late) — CARRY the last anchoring factor so the reading stays on
    // the VIX scale. Falling back to the raw VIXY price would change units mid-session, and the 8-point velocity
    // check would read that as a spike (false black-swan close-all).
    out.value = +(ck.k * vixyNow).toFixed(2);
    out.source = "carry";
  } else {
    out.value = vixyNow > 0 ? +vixyNow.toFixed(2) : (_last ? _last.value : null);   // legacy behaviour (VIXY price)
    out.source = !enabled ? "vixy(disabled)" : !_ref ? "vixy(no-cboe-ref)" : (_ref.asOf !== vixyPrevDate ? `vixy(date-mismatch ${_ref.asOf} vs ${vixyPrevDate})` : "vixy");
  }
  out.family = (out.source === "anchored" || out.source === "carry") ? "vix" : out.source.startsWith("held") ? (_lastFamily || "vix") : "vixy";
  _lastFamily = out.family;
  if (out.value > 0) _last = { value: out.value, ts: Date.now() };
  return out;
}

function buildRef(parsed) {   // parsed: { vix:{date,close}, vix9d:{..}|null, vix3m:{..}|null }
  if (!parsed || !parsed.vix) return null;
  const v = parsed.vix.close;
  const same = p => (p && p.date === parsed.vix.date) ? p.close : null;   // only pair closes from the same day
  const v9 = same(parsed.vix9d), v3 = same(parsed.vix3m);
  return {
    asOf: parsed.vix.date, vix: v, vix9d: v9, vix3m: v3,
    term9d: v9 ? +(v9 / v).toFixed(3) : null,          // > 1: front of the curve inverted (near-term stress)
    term3m: v3 ? +(v / v3).toFixed(3) : null,          // > 1: backwardation (classic risk-off)
    fetchedAt: Date.now(),
  };
}

function fields(lastReading) {
  const r = _ref || {};
  return {
    vixEst: lastReading ? lastReading.value ?? null : null,
    vixSrc: lastReading ? lastReading.source ?? null : null,
    vixyRaw: lastReading ? lastReading.vixyNow ?? null : null,
    vixPrev: r.vix ?? null, vix9dPrev: r.vix9d ?? null, vix3mPrev: r.vix3m ?? null,
    term9d: r.term9d ?? null, term3m: r.term3m ?? null,
  };
}

module.exports = { FILES, parseCboeCsv, looksLikeSplit, splitFactor, anchored, buildRef, setRef, getRef, fields };
