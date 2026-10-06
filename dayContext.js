// dayContext.js — DAY-TYPE & CONTEXT MEASUREMENT (10/6, Harrison). MEASUREMENT ONLY — nothing here gates a trade.
//
// The "collect now" layer from the 10/6 literature-panel review of APEX. APEX already reads the DEALER regime
// (GEX) well; it is blind to the TYPE OF DAY, the CALENDAR, and where price sits versus the PRIOR SESSION. This
// module records those so they can be tested before anything is allowed to gate a trade.
//
//   1. Session reference — official open, prior close, gap (reuses the [GAP] classifier's numbers; telemetry's
//      first-minute px is stale, so gap studies must use these, not px).
//   2. Opening type (Dalton, *Mind Over Markets*, made measurable): first 15 min from the open.
//        drive-up / drive-down : |move| >= 0.15% AND the open stayed within 0.05% of the opposite extreme
//        rotational            : everything else. Raw o15Ret is logged so thresholds can be revisited.
//   3. Initial balance (IB) = 9:30-10:29 high/low; range extension after 10:30 (up/down/both/none);
//      session range as a multiple of IB (Dalton: trend days extend well beyond IB).
//   4. Prior-day levels: high, low, close, VWAP (from the prior daily bar) and the prior session's volume
//      profile — point of control (POC) and 70% value area (Steidlmayer/Dalton), from prior-day 1-min bars
//      fetched ONCE per ticker per day.
//   5. Event calendar: FOMC decision days (+ the session before — Lucca & Moench 2015 pre-FOMC drift), CPI,
//      jobs report (NFP), monthly options expiration (third Friday; Ni, Pearson & Poteshman 2005 pinning;
//      QOPEX = quarterly). Dates from the official BLS CPI and Employment Situation schedules and the Federal
//      Reserve FOMC calendar. Only 2026 is loaded — other years tag "nocal" (add the next year's dates in Dec).
//
// Every entry point is wrapped by its caller; nothing here can break a scan.

// ── Event calendar ─────────────────────────────────────────────────────────────────────────────────────────
const CAL = {
  2026: {
    FOMC: ["2026-01-28","2026-03-18","2026-04-29","2026-06-17","2026-07-29","2026-09-16","2026-10-28","2026-12-09"],
    CPI:  ["2026-01-13","2026-02-13","2026-03-11","2026-04-10","2026-05-12","2026-06-10","2026-07-14","2026-08-12",
           "2026-09-11","2026-10-14","2026-11-10","2026-12-10"],
    NFP:  ["2026-01-09","2026-02-11","2026-03-06","2026-04-03","2026-05-08","2026-06-05","2026-07-02","2026-08-07",
           "2026-09-04","2026-10-02","2026-11-06","2026-12-04"],
    // NYSE full-day closures — only used to shift a third-Friday expiration that falls on a holiday
    // (2026: Juneteenth is Fri 6/19, so June monthly expiration is Thu 6/18).
    HOLIDAYS: ["2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25","2026-06-19","2026-07-03",
               "2026-09-07","2026-11-26","2026-12-25"],
  },
};

const _pad = n => String(n).padStart(2, "0");
function _ymd(y, m, d) { return `${y}-${_pad(m)}-${_pad(d)}`; }

function monthlyOpex(y, m) {                 // m = 1..12
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();   // 0 Sun .. 5 Fri
  const thirdFri = 1 + ((5 - firstDow + 7) % 7) + 14;
  const s = _ymd(y, m, thirdFri);
  const hol = (CAL[y] && CAL[y].HOLIDAYS) || [];
  return hol.includes(s) ? _ymd(y, m, thirdFri - 1) : s;
}

function eventTags(dateStr) {
  const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  const c = CAL[y];
  if (!c) return "nocal";
  const t = [];
  if (c.FOMC.includes(dateStr)) t.push("FOMC");
  const next = new Date(Date.UTC(y, m - 1, d) + 86400000).toISOString().slice(0, 10);
  if (c.FOMC.includes(next)) t.push("preFOMC");
  if (c.CPI.includes(dateStr)) t.push("CPI");
  if (c.NFP.includes(dateStr)) t.push("NFP");
  if (monthlyOpex(y, m) === dateStr) t.push([3, 6, 9, 12].includes(m) ? "QOPEX" : "OPEX");
  return t.join("+");
}

// ── ET time helpers (Intl-based: correct regardless of server timezone, across DST) ───────────────────────
const _fmtHM = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false });
function _nyOffsetMin(ms) {
  const p = _fmtHM.formatToParts(new Date(ms));
  const h = (+p.find(x => x.type === "hour").value) % 24, mi = +p.find(x => x.type === "minute").value;
  const u = new Date(ms);
  let off = (h * 60 + mi) - (u.getUTCHours() * 60 + u.getUTCMinutes());
  if (off > 720) off -= 1440;
  if (off < -720) off += 1440;
  return off;                                 // -240 in EDT, -300 in EST
}
function etDateStr(ms = Date.now()) { return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }

const OPEN_MIN = 570, O15_END = 585, IB_END = 630, CLOSE_MIN = 960;

// ── 1. Session reference (called from the [GAP] classifier) ───────────────────────────────────────────────
function setSessionRef(state, tk, { open, prevC, gapPct, prevBar }) {
  if (!state._dayCtx) state._dayCtx = {};
  const day = etDateStr();
  let c = state._dayCtx[tk];
  if (!c || c.day !== day) c = state._dayCtx[tk] = { day };
  c.sessOpen = +open || null;
  c.prevClose = +prevC || null;
  c.gapPct = (gapPct != null) ? +(gapPct * 100).toFixed(3) : null;
  if (prevBar) {
    c.pd = {
      h: +prevBar.h || null, l: +prevBar.l || null, c: +prevBar.c || null,
      vw: (prevBar.vw != null) ? +prevBar.vw : null,
      date: String(prevBar.t || prevBar.timestamp || "").slice(0, 10) || null,
    };
  }
  return c;
}

// ── 2/3. Opening type, initial balance, range extension (called every scan from the CVD block) ────────────
function updateDay(state, tk, todayBars) {
  if (!Array.isArray(todayBars) || !todayBars.length) return null;
  if (!state._dayCtx) state._dayCtx = {};
  const day = etDateStr();
  let c = state._dayCtx[tk];
  if (!c || c.day !== day) c = state._dayCtx[tk] = { day };
  const off = _nyOffsetMin(Date.now());
  const etm = b => { const u = new Date(b.t || b.timestamp); return (((u.getUTCHours() * 60 + u.getUTCMinutes() + off) % 1440) + 1440) % 1440; };
  const bars = todayBars.filter(b => { const m = etm(b); return m >= OPEN_MIN && m < CLOSE_MIN; });
  if (!bars.length) return c;
  const open = +bars[0].o;
  if (!(open > 0)) return c;
  c.firstBarMin = etm(bars[0]);              // 570 = a true 9:30 bar; later = the open is approximate
  const lastMin = etm(bars[bars.length - 1]);

  if (lastMin >= O15_END - 1) {
    const o15 = bars.filter(b => etm(b) < O15_END);
    if (o15.length) {
      const hi = Math.max(...o15.map(b => +b.h)), lo = Math.min(...o15.map(b => +b.l)), cl = +o15[o15.length - 1].c;
      const ret = (cl - open) / open * 100;
      c.o15Ret = +ret.toFixed(3);
      const nearLo = (open - lo) / open * 100 <= 0.05, nearHi = (hi - open) / open * 100 <= 0.05;
      c.openType = (ret >= 0.15 && nearLo) ? "drive-up" : (ret <= -0.15 && nearHi) ? "drive-down" : "rotational";
    }
  } else { c.openType = "forming"; }

  const ib = bars.filter(b => etm(b) < IB_END);
  const _r2 = v => +v.toFixed(2);
  c.ibHi = _r2(Math.max(...ib.map(b => +b.h))); c.ibLo = _r2(Math.min(...ib.map(b => +b.l)));
  c.hi = _r2(Math.max(...bars.map(b => +b.h))); c.lo = _r2(Math.min(...bars.map(b => +b.l)));
  c.ibRngPct = +((c.ibHi - c.ibLo) / open * 100).toFixed(3);
  if (lastMin >= IB_END) {
    const after = bars.filter(b => etm(b) >= IB_END);
    const up = after.some(b => +b.h > c.ibHi), dn = after.some(b => +b.l < c.ibLo);
    c.ibExt = up && dn ? "both" : up ? "up" : dn ? "down" : "none";
    c.rngVsIB = (c.ibHi > c.ibLo) ? +((c.hi - c.lo) / (c.ibHi - c.ibLo)).toFixed(2) : null;
  } else { c.ibExt = "forming"; c.rngVsIB = null; }
  return c;
}

// ── 4. Prior-day volume profile (fetched once per ticker per day; fire-and-forget) ───────────────────────
function computeProfile(bars) {
  const px = bars.map(b => (+b.h + +b.l + +b.c) / 3).filter(v => v > 0);
  if (!px.length) return null;
  const bin = Math.max(0.05, Math.round(px[px.length - 1] * 0.0002 * 100) / 100);   // ~0.02% of price ($0.15 on SPY)
  const vol = new Map();
  for (const b of bars) {
    const tp = (+b.h + +b.l + +b.c) / 3, v = +b.v || 0;
    if (!(tp > 0) || !v) continue;
    const k = Math.round(tp / bin);
    vol.set(k, (vol.get(k) || 0) + v);
  }
  if (!vol.size) return null;
  const keys = [...vol.keys()].sort((a, b) => a - b);
  const total = keys.reduce((s, k) => s + vol.get(k), 0);
  let pocK = keys[0];
  for (const k of keys) if (vol.get(k) > vol.get(pocK)) pocK = k;
  let lo = keys.indexOf(pocK), hi = lo, acc = vol.get(pocK);
  while (acc < total * 0.70 && (lo > 0 || hi < keys.length - 1)) {      // standard 70% value area
    const dn = lo > 0 ? vol.get(keys[lo - 1]) : -1, up = hi < keys.length - 1 ? vol.get(keys[hi + 1]) : -1;
    if (up >= dn) { hi++; acc += vol.get(keys[hi]); } else { lo--; acc += vol.get(keys[lo]); }
  }
  const r = v => +(v * bin).toFixed(2);
  return { poc: r(pocK), vah: r(keys[hi]), val: r(keys[lo]), bin, bars: bars.length };
}

function ensurePriorProfile(state, tk) {
  const c = state._dayCtx && state._dayCtx[tk];
  const date = c && c.pd && c.pd.date;
  if (!date) return;
  if (!state._pdProfile) state._pdProfile = {};
  const p = state._pdProfile[tk];
  if (p && p.date === date && p.poc != null) return;                                        // already have it
  if (p && p.date === date && p.inflight && Date.now() - (p.lastTry || 0) < 2 * 60000) return; // fetch in progress
  if (p && p.date === date && !p.inflight && p.lastTry && Date.now() - p.lastTry < 5 * 60000) return;   // retry <= every 5 min
  // (an "inflight" marker older than 2 min is treated as dead — e.g. persisted across a restart — and retried)
  state._pdProfile[tk] = { date, inflight: true, lastTry: Date.now() };
  (async () => {
    try {
      const bars = await require("./broker").getDayBars(tk, date);
      const prof = bars.length ? computeProfile(bars) : null;
      state._pdProfile[tk] = prof ? { date, ...prof } : { date, lastTry: Date.now() };
    } catch (_e) { state._pdProfile[tk] = { date, lastTry: Date.now() }; }
  })();
}

// ── Outputs ───────────────────────────────────────────────────────────────────────────────────────────────
function telemetryFields(state, tk, price) {
  const c = (state._dayCtx && state._dayCtx[tk]) || {};
  const day = etDateStr();
  const cur = c.day === day ? c : {};
  const pd = cur.pd || {}, prof = (state._pdProfile && state._pdProfile[tk]) || {};
  const poc = (prof.date && prof.date === pd.date && prof.poc != null) ? prof.poc : null;
  const pos = (price > 0 && pd.h && pd.l) ? (price > pd.h ? "above-PDH" : price < pd.l ? "below-PDL" : "inside") : null;
  return {
    sessOpen: cur.sessOpen ?? null, prevClose: cur.prevClose ?? null, gapTrue: cur.gapPct ?? null,
    openType: cur.openType ?? null, o15Ret: cur.o15Ret ?? null,
    ibHi: cur.ibHi ?? null, ibLo: cur.ibLo ?? null, ibRngPct: cur.ibRngPct ?? null,
    ibExt: cur.ibExt ?? null, rngVsIB: cur.rngVsIB ?? null,
    pdH: pd.h ?? null, pdL: pd.l ?? null, pdVW: pd.vw ?? null, pdPOC: poc,
    dPOC: (poc && price > 0) ? +((price - poc) / poc * 100).toFixed(3) : null,
    posVsPd: pos, evt: eventTags(day),
  };
}

// Snapshot stamped onto each position at entry (execution.js) -> outcomes CSV.
function entryContext(state, tk, price) {
  const f = telemetryFields(state, tk, price);
  return { openType: f.openType, ibExt: f.ibExt, gapTrue: f.gapTrue, posVsPd: f.posVsPd, evt: f.evt, rngVsIB: f.rngVsIB };
}

module.exports = { eventTags, monthlyOpex, etDateStr, setSessionRef, updateDay, computeProfile, ensurePriorProfile,
                   telemetryFields, entryContext, CAL };
