// tradingTime.js — 11/24 (Harrison): put an option's implied vol on the same clock as realized vol.
//
// WHY: the straddle gate divides ATM implied vol by a forecast of realized vol. The implied vol from the chain is annualized
// on CALENDAR time (days to expiry / 365); the realized-vol forecast is annualized on TRADING minutes (252 x 390, vol.js).
// The two only agree when the days to expiry hold the usual 5 sessions per 7 calendar days. An expiry that spans a weekend or
// a holiday carries the same price per trading hour at a LOWER calendar IV, so it read as cheap. 11/23: the 11/30 expiry was
// 7.2 calendar days but ~4.4 sessions (Thanksgiving + a half day); IV/forecast read 0.98 and 1.00, both pairs were bought and
// lost $313. On trading time the ratios were 1.04 and 1.06 — no trade.
//
// Literature: variance accrues while the market is open, very little while it is closed (French & Roll 1986, JFE);
// option time should be counted in trading days, not calendar days (French 1984, JFE).
// APEX data: 846 saved chain snapshots (10/08-11/23), ATM IV across the 1-8 DTE expiries of the same snapshot — spread of
// 11.6% of the mean on calendar IV, 2.2% after this conversion, and flattest with NO weight on closed hours (tested 0-30%).
// So closed hours carry zero weight here; nothing else is fitted.
//
//   IV(trading) = IV(calendar) x sqrt( calendar years to expiry / trading years to expiry )
//   calendar years = (days to the expiry date + rest of today to 16:00 ET) / 365
//   trading years  = regular-session minutes from now to the expiry close / (252 x 390)
"use strict";

// NYSE full closures and 1:00 pm closes (NYSE Group calendar for 2026-2028, announced 12/23/2025). Years not listed count
// weekdays only (covered:false is returned so the caller can say so).
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const HALF_DAYS = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
const COVERED_YEARS = new Set([2026, 2027]);
const OPEN_MIN = 570, FULL_MIN = 390, HALF_MIN = 210, CLOSE_MIN = 960;   // ET minutes of day
const MIN_PER_YEAR = 252 * 390;                                             // same year as vol.js BARS_PER_YEAR_1MIN

const ET = "America/New_York";
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: ET });
function etMin(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const g = (t) => +p.find(x => x.type === t).value;
  return (g("hour") % 24) * 60 + g("minute") + g("second") / 60;
}
const _next = (d) => new Date(Date.parse(d + "T12:00:00Z") + 864e5).toISOString().slice(0, 10);
const _dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);

// regular-session minutes on a date: 0 (weekend / holiday), 210 (1:00 pm close) or 390
function sessionMinutes(day) {
  const dow = new Date(day + "T12:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6 || HOLIDAYS.has(day)) return 0;
  return HALF_DAYS.has(day) ? HALF_MIN : FULL_MIN;
}

// regular-session minutes from `now` to the close of expDay (YYYY-MM-DD), today's remainder included
function tradingMinutesTo(nowMs, expDay) {
  const today = etDay(nowMs);
  if (!/^\d{4}-\d\d-\d\d$/.test(String(expDay)) || expDay < today) return 0;
  const m = etMin(nowMs), sToday = sessionMinutes(today);
  let total = sToday ? Math.max(0, (OPEN_MIN + sToday) - Math.max(m, OPEN_MIN)) : 0;
  let d = today, guard = 0;
  while (d < expDay && guard++ < 400) { d = _next(d); total += sessionMinutes(d); }
  return total;
}

// -> { factor, calDays, sessions, covered } or null when it can't be computed (the caller then keeps the calendar IV)
function factor(nowMs, expDay) {
  try {
    const today = etDay(nowMs);
    if (!/^\d{4}-\d\d-\d\d$/.test(String(expDay)) || expDay < today) return null;
    const calDays = _dayDiff(today, expDay) + (CLOSE_MIN - etMin(nowMs)) / 1440;
    const tMin = tradingMinutesTo(nowMs, expDay);
    if (!(calDays > 0) || !(tMin > 0)) return null;
    const f = Math.sqrt((calDays / 365) / (tMin / MIN_PER_YEAR));
    if (!Number.isFinite(f) || f <= 0) return null;
    return { factor: f, calDays: +calDays.toFixed(2), sessions: +(tMin / FULL_MIN).toFixed(2),
             covered: COVERED_YEARS.has(+today.slice(0, 4)) && COVERED_YEARS.has(+expDay.slice(0, 4)) };
  } catch (_) { return null; }
}

module.exports = { factor, tradingMinutesTo, sessionMinutes, HOLIDAYS, HALF_DAYS, MIN_PER_YEAR };
