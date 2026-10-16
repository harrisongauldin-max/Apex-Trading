// flowBacktest.js — 10/15 (Harrison): THE FLOW HARNESS. Pure functions over SPY/QQQ 5-minute bars (2016 on), read-only.
//
// Purpose: test, on ~10 years of history, the published intraday edges APEX is not using — BEFORE any of them trades.
// §0 needs theory AND APEX's own data; this is the APEX-data half for ideas whose theory is already published.
// The PASS lines below were written BEFORE the harness was ever run (pre-registration). Every trial is reported,
// including the ones that fail (López de Prado: report every trial behind a backtest). Do not edit a PASS line after
// seeing a result — add a new, separately-labelled trial instead.
//
// Tests
//   T1  End-of-day momentum — sign of the return from the prior close to 15:30 predicts 15:30 -> close
//       (Baltussen, Da, Lammers & Martens, JFE 2021); first-half-hour predictor variant (Gao, Han, Li & Zhou, JFE 2018).
//       Measured on the underlying, and as option P&L (0DTE and 2DTE ATM, Black-Scholes on that day's VIX/VXN).
//   T2  Noise-area intraday momentum held to a VWAP/boundary trailing stop or the close (Zarattini & Aziz 2024,
//       "Beat the Market", SPY) — approximation of their rules (bands from the 14-day average move-from-open at each
//       half-hour; entries checked on the half hour from 10:00). Compared, on the SAME entries, with APEX's current
//       intraday-trend style exit (out after 60 minutes).
//   T3  Turn of the month — last trading day + first three (McConnell & Xu, FAJ 2008; Etula et al., RFS 2020).
//   T5  Volatility picks the sleeve — T2 by VIX tercile (trend should be best when VIX is high), and a plain VWAP-band
//       fade baseline by VIX tercile (fading should be best when VIX is low). Gao et al.; Zarattini & Aziz.
//   T6  Continuation after a level breaks (Osler 2000/2003) — prior-day high/low and $5 round numbers.
//   T2-opt (v1.1, pre-registered 10/15 BEFORE its first run) — T2's entries and exits priced as ~0.50-delta options
//       with >= 2 days to expiry. Holding an option to the close pays theta the share version doesn't.
//   Concentration (v1.1, diagnostic, added AFTER seeing QQQ 2018 carry T2) — each year's share of total P&L.
// v1.1 grading: a test reports INCOMPLETE (never PASS) when either half has < 250 days, a VIX tercile cell has < 60 days,
// or the ticker's data ends more than 10 days before the run date (10/15: QQQ stopped at 2021 on a shared fetch budget).
//   v1.2 (pre-registered 10/16 BEFORE their first run):
//   T2-opt14 (trial #21, one shot) — T2's trades on APEX's real intraday-trend instrument: 0.50 delta, 14 calendar
//       (≈ 10 trading) days to expiry, $0.03 round-trip spread.
//   T7  APEX's own intraday-trend sleeve replayed on 5-minute bars, rules read from constants.js: break of the
//       9:30-9:45 range, >= ITREND_VWAP_MIN past VWAP with VWAP slope agreeing, ADX >= ITREND_ADX_MIN, 10:00-12:00,
//       30-min cooldown, one open per side; live exits on a 0.50-delta 14-DTE option (−30% stop, profit-lock ladder,
//       20-min no-arm cut, 60-min cap, 3:15 flatten). Compared with the SAME entries held to a VWAP trail or the close.
//       Not replayable: the negative-gamma block (no gamma history), breadth, the CVD tag. ADX is computed on trailing
//       5-minute bars including the prior session (live uses the session's 1-minute bars) — close, not identical.
// Not testable here (no history in Alpaca): dealer gamma (needs historical open interest), expiration pinning (same),
// macro-announcement days (dayContext only holds the 2026 calendar). Gamma conditioning is being collected live.
'use strict';

const TO = require('./trendOptions');

// ── PRE-REGISTERED PASS LINES (written 10/15 before any run) ──────────────────────────────────────────────────────
const PASS = {
  T1:  'Signed last-30-min return > 0 with t >= 2.0 over the full sample, AND positive in at least 2 of the last 3 calendar years — per ticker, on the underlying net of 1 bp per side. Option versions are reported; an option version passes only if its mean P&L per trade > 0 with t >= 2.0.',
  T2:  'Annualised Sharpe >= 0.5 net of 1 bp per side, AND positive in both halves (2016-2020, 2021-on) — per ticker. Hold-vs-cap: holding to the trail/close beats the 60-minute cap on the SAME entries in both halves.',
  T3:  'Turn-of-month minus other days, mean close-to-close return > 0 with t >= 2.0, AND positive in both halves — per ticker.',
  T5:  'T2 Sharpe in the high-VIX tercile > low-VIX tercile, AND fade-baseline Sharpe in the low-VIX tercile > high-VIX tercile — both halves, per ticker.',
  T6:  'Mean 30-minute continuation after a break > 0 with t >= 2.0 AND positive in both halves — per ticker, separately for prior-day high/low and for $5 round numbers.',
  // v1.1 — written 10/15 after the first run, BEFORE T2-opt was ever computed
  T2opt: 'T2 entries/exits priced as options (strike at the entry price ≈ 0.50 delta, 2 trading days + the rest of the session to expiry, Black-Scholes on the prior-day VIX/VXN, $0.02 round-trip spread): mean return on premium per trade > 0 with t >= 2.0, AND positive in both halves — per ticker.',
  CONC:  'Diagnostic, added AFTER seeing the first run: each calendar year\'s share of total T2 / T2-opt P&L. No sleeve is built if one year is more than half of the total.',
  GRADE: 'INCOMPLETE instead of PASS/fail when either half has < 250 days, a VIX tercile cell has < 60 days, or the data ends > 10 days before the run.',
  // v1.2 — written 10/16, BEFORE T2-opt14 or T7 were ever computed
  T2opt14: 'Trial #21, one shot: T2-opt with APEX\'s intraday-trend instrument — 14 calendar (≈10 trading) days to expiry, $0.03 round-trip spread, strike at the entry price. Same pass line as T2opt.',
  T7a:  'APEX intraday-trend as live (entries + live exits, as 0.50-delta 14-DTE options, $0.03 spread): mean return on premium per trade > 0 with t >= 2.0, AND positive in both halves — per ticker.',
  T7b:  'The SAME T7 entries held to a VWAP trail (exit on a 5-minute close back across VWAP) or the close, as the same options: mean return per trade beats the live exits in both halves — per ticker.',
  T7c:  'The held version on shares (net 1 bp per side): annualised daily Sharpe >= 0.5 AND positive in both halves — per ticker (the T2 line).',
  T7cOpt: 'The held version as the same options: mean return on premium per trade > 0 with t >= 2.0, AND positive in both halves — per ticker.',
};
const MIN_HALF_DAYS = 250, MIN_CELL_DAYS = 60, MAX_STALE_DAYS = 10;
const COST_BP = 1;           // per side, shares
const OPT_SPREAD = 0.02;     // $ per contract-share, round trip (0DTE/2DTE ATM SPY/QQQ are typically 1-2 cents wide)
const SPLIT = '2021-01-01';  // halves
const RTH_OPEN = 570, RTH_CLOSE = 960;   // minutes of day, ET

// ── ET helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const _fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function etParts(iso) {
  const p = {}; for (const x of _fmt.formatToParts(new Date(iso))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, m: (+p.hour % 24) * 60 + (+p.minute) };
}

// bars: Alpaca bars [{t,o,h,l,c,v}] -> [{ date, bars:[{m,o,h,l,c,v}] }] regular hours only, sorted
function groupDays(bars) {
  const map = new Map();
  for (const b of bars || []) {
    const { day, m } = etParts(b.t);
    if (m < RTH_OPEN || m >= RTH_CLOSE) continue;
    if (!map.has(day)) map.set(day, []);
    map.get(day).push({ m, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 });
  }
  const out = [];
  for (const [date, bs] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    bs.sort((a, b) => a.m - b.m);
    if (bs.length < 60 || bs[0].m > RTH_OPEN + 5) continue;   // skip half days / gappy days (need ~a full session)
    let pv = 0, vv = 0;
    for (const b of bs) { const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; b.vwap = vv > 0 ? pv / vv : b.c; }
    out.push({ date, bars: bs, open: bs[0].o, close: bs[bs.length - 1].c, lastM: bs[bs.length - 1].m });
  }
  for (let i = 1; i < out.length; i++) out[i].prevClose = out[i - 1].close;
  return out;
}
// close of the bar that ENDS at minute m (5-min bars start at m-5); falls back to the last bar before m
function pxAt(d, m) { let last = null; for (const b of d.bars) { if (b.m + 5 <= m) last = b; else break; } return last; }

// ── stats ────────────────────────────────────────────────────────────────────────────────────────────────────────
function summ(xs) {
  const v = xs.filter(x => x != null && isFinite(x)); const n = v.length;
  if (!n) return { n: 0, mean: null, t: null, hit: null, sd: null };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : null, hit: v.filter(x => x > 0).length / n };
}
const sharpe = (daily) => { const s = summ(daily); return s.sd > 0 ? s.mean / s.sd * Math.sqrt(252) : null; };
const byYear = (rows, f) => { const g = {}; for (const r of rows) (g[r.date.slice(0, 4)] = g[r.date.slice(0, 4)] || []).push(f(r)); return Object.fromEntries(Object.entries(g).map(([y, xs]) => [y, summ(xs)])); };
const halves = (rows, f) => ({ h1: summ(rows.filter(r => r.date < SPLIT).map(f)), h2: summ(rows.filter(r => r.date >= SPLIT).map(f)) });
// v1.1 grading: { pass, grade } — pass is only ever true on complete data
const grade = (ok, complete) => ({ pass: !!(complete && ok), grade: complete ? (ok ? 'PASS' : 'fail') : 'INCOMPLETE' });
const halvesOk = (h) => h.h1.n >= MIN_HALF_DAYS && h.h2.n >= MIN_HALF_DAYS;
const daysOk = (rows) => rows.filter(r => r.date < SPLIT).length >= MIN_HALF_DAYS && rows.filter(r => r.date >= SPLIT).length >= MIN_HALF_DAYS;
// v1.1 diagnostic: the largest calendar year's share of total P&L (null when the total isn't positive)
function concentration(rows, f) {
  const g = {}; let tot = 0;
  for (const r of rows) { const v = f(r); if (v == null || !isFinite(v)) continue; g[r.date.slice(0, 4)] = (g[r.date.slice(0, 4)] || 0) + v; tot += v; }
  if (!(tot > 0)) return { total: tot, topYear: null, topShare: null, tooConcentrated: null };
  const [y, v] = Object.entries(g).sort((a, b) => b[1] - a[1])[0];
  return { total: tot, topYear: y, topShare: v / tot, tooConcentrated: v / tot > 0.5 };
}

// ── T1: end-of-day momentum ─────────────────────────────────────────────────────────────────────────────────────
// iv(date) -> annualised implied vol (VIX/100 for SPY, VXN/100 for QQQ) or null
function t1(days, iv) {
  const rows = [];
  for (const d of days) {
    if (!(d.prevClose > 0) || d.lastM < 955) continue;
    const a = pxAt(d, 930), z = d.bars[d.bars.length - 1], f = pxAt(d, 600);
    if (!a || a.m + 5 !== 930) continue;
    const S0 = a.c, S1 = z.c, rROD = (S0 - d.prevClose) / d.prevClose, rLH = (S1 - S0) / S0;
    const dir = rROD > 0 ? 1 : rROD < 0 ? -1 : 0;
    const row = { date: d.date, rROD, rLH, rFH: f ? (f.c - d.prevClose) / d.prevClose : null, dir,
                  sharesBp: dir * rLH * 1e4 - 2 * COST_BP };
    const sig = iv ? iv(d.date) : null;
    if (sig > 0 && dir) {
      const type = dir > 0 ? 'call' : 'put', K = Math.round(S0);
      const T0 = (30 / 390) / 252, p0 = TO.bs(S0, K, T0, 0, 0, sig, type);           // 0DTE, 30 trading minutes left
      const p1 = Math.max(0, type === 'call' ? S1 - K : K - S1);
      row.opt0 = (p1 - p0 - OPT_SPREAD) / p0;                                            // return on premium
      const T2a = (2 + 30 / 390) / 252, T2b = 2 / 252;                                    // 2DTE, marked at the close
      const q0 = TO.bs(S0, K, T2a, 0, 0, sig, type), q1 = TO.bs(S1, K, T2b, 0, 0, sig, type);
      row.opt2 = (q1 - q0 - OPT_SPREAD) / q0;
    }
    rows.push(row);
  }
  const yrs = byYear(rows, r => r.sharesBp);
  const recent = Object.keys(yrs).sort().slice(-3);
  const full = summ(rows.map(r => r.sharesBp));
  const complete = daysOk(rows);
  const g1 = grade(full.mean > 0 && full.t >= 2 && recent.filter(y => yrs[y].mean > 0).length >= 2, complete);
  const gao = summ(rows.filter(r => r.rFH != null).map(r => Math.sign(r.rFH) * r.rLH * 1e4 - 2 * COST_BP));
  const o0 = summ(rows.map(r => r.opt0)), o2 = summ(rows.map(r => r.opt2));
  return { n: rows.length, full, byYear: yrs, recentYears: recent, halves: halves(rows, r => r.sharesBp), gao,
           opt0DTE: o0, opt2DTE: o2, ...g1, optPass: { dte0: complete && o0.mean > 0 && o0.t >= 2, dte2: complete && o2.mean > 0 && o2.t >= 2 },
           optGrade: { dte0: grade(o0.mean > 0 && o0.t >= 2, complete).grade, dte2: grade(o2.mean > 0 && o2.t >= 2, complete).grade } };
}

// ── T2: noise-area momentum (Zarattini & Aziz approximation) ────────────────────────────────────────────────────
const CHECKS = []; for (let m = 600; m <= 930; m += 30) CHECKS.push(m);   // 10:00 ... 15:30
function t2Day(days, i) {
  const d = days[i];
  if (i < 14 || !(d.prevClose > 0) || d.lastM < 955) return null;
  const sig = {};
  for (const m of CHECKS) {
    let s = 0, k = 0;
    for (let j = i - 14; j < i; j++) { const b = pxAt(days[j], m); if (b) { s += Math.abs(b.c / days[j].open - 1); k++; } }
    sig[m] = k >= 10 ? s / k : null;
  }
  const up = Math.max(d.open, d.prevClose), dn = Math.min(d.open, d.prevClose);
  let pos = 0, entry = null, entryM = null, trades = [], capTrades = [];
  for (const m of CHECKS) {
    const b = pxAt(d, m); if (!b || sig[m] == null) continue;
    const UB = up * (1 + sig[m]), LB = dn * (1 - sig[m]);
    if (pos > 0 && b.c < Math.max(UB, b.vwap)) { trades.push({ dir: 1, r: b.c / entry - 1, from: entryM, to: m, e0: entry, e1: b.c }); pos = 0; }
    else if (pos < 0 && b.c > Math.min(LB, b.vwap)) { trades.push({ dir: -1, r: 1 - b.c / entry, from: entryM, to: m, e0: entry, e1: b.c }); pos = 0; }
    if (pos === 0 && m < 930) {
      if (b.c > UB) { pos = 1; entry = b.c; entryM = m; }
      else if (b.c < LB) { pos = -1; entry = b.c; entryM = m; }
    }
  }
  const z = d.bars[d.bars.length - 1];
  if (pos) trades.push({ dir: pos, r: pos > 0 ? z.c / entry - 1 : 1 - z.c / entry, from: entryM, to: z.m + 5, e0: entry, e1: z.c });
  // same entries, APEX-style cap: out 60 minutes after entry (or at the trail/close if sooner)
  for (const tr of trades) {
    const capM = Math.min(tr.to, tr.from + 60), b = pxAt(d, capM) || z, e = pxAt(d, tr.from);
    capTrades.push(tr.dir * (b.c / e.c - 1));
    tr.capM = Math.min(capM, 960); tr.capPx = b.c;
  }
  const cost = 2 * COST_BP / 1e4;
  return { date: d.date, ret: trades.reduce((s, t) => s + t.r - cost, 0), capRet: capTrades.reduce((s, r) => s + r - cost, 0), n: trades.length,
           holds: trades.map(t => t.to - t.from), trades };
}
function t2(days) {
  const rows = []; for (let i = 0; i < days.length; i++) { const r = t2Day(days, i); if (r) rows.push(r); }
  const sh = sharpe(rows.map(r => r.ret)), sh1 = sharpe(rows.filter(r => r.date < SPLIT).map(r => r.ret)), sh2 = sharpe(rows.filter(r => r.date >= SPLIT).map(r => r.ret));
  const h = halves(rows, r => r.ret), hc = halves(rows, r => r.capRet);
  const holdBeatsCap = (h.h1.mean - hc.h1.mean) > 0 && (h.h2.mean - hc.h2.mean) > 0;
  const trades = rows.reduce((s, r) => s + r.n, 0), holds = rows.flatMap(r => r.holds);
  return { days: rows.length, trades, sharpe: sh, sharpeH1: sh1, sharpeH2: sh2, daily: summ(rows.map(r => r.ret * 1e4)),
           capDaily: summ(rows.map(r => r.capRet * 1e4)), capSharpe: sharpe(rows.map(r => r.capRet)), byYear: byYear(rows, r => r.ret * 1e4),
           medianHoldMin: holds.length ? holds.sort((a, b) => a - b)[holds.length >> 1] : null,
           ...grade(sh >= 0.5 && h.h1.mean > 0 && h.h2.mean > 0, halvesOk(h)), holdBeatsCap: halvesOk(h) && holdBeatsCap,
           holdGrade: halvesOk(h) ? (holdBeatsCap ? 'PASS' : 'fail') : 'INCOMPLETE',
           conc: concentration(rows, r => r.ret), rows };
}

// ── T3: turn of the month ───────────────────────────────────────────────────────────────────────────────────────
function t3(days) {
  const byMonth = {}; for (const d of days) (byMonth[d.date.slice(0, 7)] = byMonth[d.date.slice(0, 7)] || []).push(d.date);
  const tom = new Set(); for (const ds of Object.values(byMonth)) { ds.sort(); tom.add(ds[ds.length - 1]); ds.slice(0, 3).forEach(x => tom.add(x)); }
  const rows = days.filter(d => d.prevClose > 0).map(d => ({ date: d.date, cc: (d.close / d.prevClose - 1) * 1e4, oc: (d.close / d.open - 1) * 1e4, tom: tom.has(d.date) }));
  const diff = (rs, k) => { const a = summ(rs.filter(r => r.tom).map(r => r[k])), b = summ(rs.filter(r => !r.tom).map(r => r[k]));
    const se = Math.sqrt((a.sd ** 2) / (a.n || 1) + (b.sd ** 2) / (b.n || 1)); return { tom: a, other: b, diff: a.mean - b.mean, t: se > 0 ? (a.mean - b.mean) / se : null }; };
  const full = diff(rows, 'cc'), h1 = diff(rows.filter(r => r.date < SPLIT), 'cc'), h2 = diff(rows.filter(r => r.date >= SPLIT), 'cc');
  return { closeToClose: full, h1, h2, openToClose: diff(rows, 'oc'), ...grade(full.diff > 0 && full.t >= 2 && h1.diff > 0 && h2.diff > 0, daysOk(rows)) };
}

// ── T5: volatility picks the sleeve ─────────────────────────────────────────────────────────────────────────────
function fadeDay(d) {   // VWAP-band fade baseline: >= 0.40% from VWAP at a half-hour check -> fade toward VWAP; out at VWAP, +60 min, or close
  let pos = 0, entry = null, entryM = null, r = 0;
  const cost = 2 * COST_BP / 1e4;
  for (const m of CHECKS) {
    if (m > 900) break;
    const b = pxAt(d, m); if (!b) continue;
    const x = b.c / b.vwap - 1;
    if (pos && (m - entryM >= 60 || (pos > 0 ? b.c >= b.vwap : b.c <= b.vwap))) { r += pos * (b.c / entry - 1) - cost; pos = 0; }
    if (!pos && Math.abs(x) >= 0.004) { pos = x > 0 ? -1 : 1; entry = b.c; entryM = m; }
  }
  if (pos) { const b = pxAt(d, Math.min(entryM + 60, 955)) || d.bars[d.bars.length - 1]; r += pos * (b.c / entry - 1) - cost; }
  return r;
}
function t5(days, t2res, vix) {
  if (!vix) return { note: 'no VIX history', pass: false };
  const v = {}; for (const d of days) { const prev = vix(d.date); if (prev > 0) v[d.date] = prev; }
  const vals = Object.values(v).sort((a, b) => a - b); if (vals.length < 100) return { note: 'VIX history too short', pass: false };
  const q1 = vals[Math.floor(vals.length / 3)], q2 = vals[Math.floor(2 * vals.length / 3)];
  const terc = (dt) => v[dt] == null ? null : v[dt] <= q1 ? 'low' : v[dt] <= q2 ? 'mid' : 'high';
  const fades = days.map(d => ({ date: d.date, ret: fadeDay(d) }));
  const cellN = {};
  const cell = (rows, half, tag) => {
    const rs = rows.filter(r => half === 'h1' ? r.date < SPLIT : half === 'h2' ? r.date >= SPLIT : true);
    const o = {}; for (const t of ['low', 'mid', 'high']) { const xs = rs.filter(r => terc(r.date) === t); o[t] = sharpe(xs.map(r => r.ret)); cellN[`${tag}.${half}.${t}`] = xs.length; } return o;
  };
  const trend = { all: cell(t2res.rows, 'all', 'trend'), h1: cell(t2res.rows, 'h1', 'trend'), h2: cell(t2res.rows, 'h2', 'trend') };
  const fade = { all: cell(fades, 'all', 'fade'), h1: cell(fades, 'h1', 'fade'), h2: cell(fades, 'h2', 'fade') };
  // v1.1: every graded cell must exist with >= MIN_CELL_DAYS days — an empty cell is no longer compared as zero
  const used = ['h1', 'h2'].flatMap(h => ['low', 'high'].flatMap(t => [[trend, 'trend', h, t], [fade, 'fade', h, t]]));
  const complete = used.every(([o, tag, h, t]) => o[h][t] != null && cellN[`${tag}.${h}.${t}`] >= MIN_CELL_DAYS);
  const ok = trend.h1.high > trend.h1.low && trend.h2.high > trend.h2.low && fade.h1.low > fade.h1.high && fade.h2.low > fade.h2.high;
  return { vixTerciles: [q1, q2], trend, fade, cellN, fadeSharpeAll: sharpe(fades.map(r => r.ret)), ...grade(ok, complete) };
}

// ── T6: continuation after a level breaks ───────────────────────────────────────────────────────────────────────
function t6(days) {
  const ev = { pd: [], round: [] };
  for (let i = 1; i < days.length; i++) {
    const d = days[i], p = days[i - 1];
    const pdH = Math.max(...p.bars.map(b => b.h)), pdL = Math.min(...p.bars.map(b => b.l));
    const seen = new Set();
    for (let k = 1; k < d.bars.length; k++) {
      const b = d.bars[k], a = d.bars[k - 1];
      if (b.m < 600 || b.m > 900) continue;
      const levels = [['pd', pdH], ['pd', pdL]];
      const r5 = Math.floor(Math.min(a.c, b.c) / 5) * 5 + 5; if (r5 > Math.min(a.c, b.c) && r5 < Math.max(a.c, b.c)) levels.push(['round', r5]);
      for (const [kind, L] of levels) {
        const key = kind + L; if (seen.has(key)) continue;
        const upBreak = a.c <= L && b.c >= L * 1.0003, dnBreak = a.c >= L && b.c <= L * 0.9997;
        if (!upBreak && !dnBreak) continue;
        seen.add(key);
        const f = pxAt(d, b.m + 5 + 30); if (!f || f.m + 5 !== b.m + 5 + 30) continue;
        ev[kind].push({ date: d.date, r: (upBreak ? 1 : -1) * (f.c / b.c - 1) * 1e4 });
      }
    }
  }
  const res = {};
  for (const k of ['pd', 'round']) { const full = summ(ev[k].map(e => e.r)), h = halves(ev[k], e => e.r);
    res[k] = { full, h1: h.h1, h2: h.h2, ...grade(full.mean > 0 && full.t >= 2 && h.h1.mean > 0 && h.h2.mean > 0, daysOk(days)) }; }
  return res;
}

// ── T2-opt: the same T2 trades priced as options (v1.1, pre-registered before its first run) ─────────────────────
// Strike at the entry price (≈ 0.50 delta); 2 trading days + the rest of the session to expiry; Black-Scholes on the
// prior-day VIX/VXN; $0.02 round-trip spread. Return on premium per trade. The 60-min-cap version is reported, not graded.
function t2opt(t2res, iv, o = {}) {
  if (!iv) return { note: 'no implied-vol history', pass: false, grade: 'INCOMPLETE' };
  const tdays = o.tradingDays != null ? o.tradingDays : 2, spread = o.spread != null ? o.spread : OPT_SPREAD;
  const yr = 252, tleft = (m) => Math.max(0, 960 - m) / 390;
  const px = (S, K, m, sig, type) => TO.bs(S, K, (tdays + tleft(m)) / yr, 0, 0, sig, type);
  const tr = [], cap = [];
  for (const row of t2res.rows || []) {
    const sig = iv(row.date); if (!(sig > 0)) continue;
    for (const t of row.trades || []) {
      if (!(t.e0 > 0) || !(t.e1 > 0)) continue;
      const type = t.dir > 0 ? 'call' : 'put', K = t.e0, p0 = px(t.e0, K, t.from, sig, type);
      if (!(p0 > 0.05)) continue;
      tr.push({ date: row.date, r: (px(t.e1, K, t.to, sig, type) - p0 - spread) / p0 });
      if (t.capPx > 0) cap.push({ date: row.date, r: (px(t.capPx, K, t.capM, sig, type) - p0 - spread) / p0 });
    }
  }
  const full = summ(tr.map(x => x.r)), h = halves(tr, x => x.r), capFull = summ(cap.map(x => x.r));
  const complete = daysOk(t2res.rows || []);
  return { full, h1: h.h1, h2: h.h2, cap: capFull, byYear: byYear(tr, x => x.r), conc: concentration(tr, x => x.r),
           ...grade(full.mean > 0 && full.t >= 2 && h.h1.mean > 0 && h.h2.mean > 0, complete) };
}

// ── T7: APEX intraday-trend replay (v1.2) ──────────────────────────────────────────────────────────────────────
function adxOf(bars, period = 14) {   // same Wilder ADX as signals.js calcADX
  if (!bars || bars.length < period * 2) return 20;
  const pDM = [], mDM = [], tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], a = bars[i - 1], up = b.h - a.h, dn = a.l - b.l;
    pDM.push(up > dn && up > 0 ? up : 0); mDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - a.c), Math.abs(b.l - a.c)));
  }
  const wil = (arr) => { if (arr.length < period) return []; let sum = 0; for (let i = 0; i < period; i++) sum += arr[i]; const out = [sum]; for (let i = period; i < arr.length; i++) { sum = sum - sum / period + arr[i]; out.push(sum); } return out; };
  const sT = wil(tr), sP = wil(pDM), sM = wil(mDM); if (!sT.length) return 20;
  const dx = sT.map((t, i) => { if (!t) return 0; const p = 100 * sP[i] / t, m = 100 * sM[i] / t; return p + m ? 100 * Math.abs(p - m) / (p + m) : 0; });
  if (dx.length < period) return dx.reduce((x, y) => x + y, 0) / (dx.length || 1);
  let adx = 0; for (let i = 0; i < period; i++) adx += dx[i]; adx /= period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return adx;
}
function t7(days, iv, R = null) {
  const C = R || require('./constants');
  const START = Math.round((C.ITREND_START_ET ?? 10) * 60), END = Math.round((C.ITREND_END_ET ?? 12) * 60);
  const VW = C.ITREND_VWAP_MIN ?? 0.05, ADXMIN = C.ITREND_ADX_MIN ?? 25, COOL = C.ITREND_COOLDOWN_MIN ?? 30;
  const STOP = C.ITREND_STOP_PCT ?? 0.30, NOARM = C.ITREND_NOARM_MIN ?? 20, MAXH = C.ITREND_MAX_HOLD_MIN ?? 60;
  const ladder = C.ladderFloor, FLAT = 915, SPREAD = 0.03, TD = 10, yr = 252;
  const T = (m) => (TD + Math.max(0, 960 - m) / 390) / yr;
  const trades = [], dayRows = [];
  for (let i = 1; i < days.length; i++) {
    const d = days[i], prev = days[i - 1];
    if (d.lastM < 955) continue;
    const orB = d.bars.filter(b => b.m < 585); if (orB.length < 3) continue;
    const orH = Math.max(...orB.map(b => b.h)), orL = Math.min(...orB.map(b => b.l));
    const sig = iv ? iv(d.date) : null;
    const open = { call: null, put: null }, last = { call: -1e9, put: -1e9 }, dayTr = [];
    for (let k = 1; k < d.bars.length; k++) {
      const b = d.bars[k], e = b.m + 5;
      for (const side of ['call', 'put']) { const p = open[side]; if (p && e >= p.liveExitM) open[side] = null; }   // live book: free the side once its live exit has passed
      if (e < START || e >= END) continue;
      const vw = (b.c - b.vwap) / b.vwap * 100, slope = b.vwap - d.bars[k - 1].vwap;
      let side = null;
      if (vw >= VW && slope > 0 && b.c > orH) side = 'call'; else if (vw <= -VW && slope < 0 && b.c < orL) side = 'put';
      if (!side || open[side] || e - last[side] < COOL) continue;
      const win = prev.bars.slice(-30).concat(d.bars.slice(0, k + 1)).slice(-40);
      if (adxOf(win) < ADXMIN) continue;
      // ---- entry at this bar's close ----
      const dir = side === 'call' ? 1 : -1, S0 = b.c, K = S0;
      const p0 = sig > 0 ? TO.bs(S0, K, T(e), 0, 0, sig, side) : null;
      // live exits (option %, checked at each 5-min close)
      let peak = -Infinity, liveJ = null, reason = 'flatten-15:15';
      for (let j = k + 1; j < d.bars.length; j++) {
        const x = d.bars[j], xe = x.m + 5, held = xe - e;
        if (xe > FLAT) break;
        liveJ = j;
        if (!(p0 > 0)) { if (held >= MAXH) { reason = 'maxhold'; break; } continue; }
        const chg = TO.bs(x.c, K, T(xe), 0, 0, sig, side) / p0 - 1; peak = Math.max(peak, chg);
        const floor = ladder ? ladder(peak) : null;
        if (chg <= -STOP) { reason = 'stop'; break; }
        if (floor !== null && chg <= floor) { reason = 'lock'; break; }
        if (held >= NOARM && floor === null) { reason = 'noarm'; break; }
        if (held >= MAXH) { reason = 'maxhold'; break; }
      }
      if (liveJ == null) continue;   // entry too late to manage
      const lx = d.bars[liveJ], lxe = lx.m + 5;
      // held: VWAP trail (5-min close back across VWAP) or the close
      let hJ = d.bars.length - 1;
      for (let j = k + 1; j < d.bars.length; j++) { const x = d.bars[j]; if (dir > 0 ? x.c < x.vwap : x.c > x.vwap) { hJ = j; break; } }
      const hx = d.bars[hJ], hxe = hx.m + 5;
      const t = { date: d.date, side, e, reason, liveHold: lxe - e, heldHold: hxe - e,
        shLive: dir * (lx.c / S0 - 1) - 2 * COST_BP / 1e4, shHeld: dir * (hx.c / S0 - 1) - 2 * COST_BP / 1e4 };
      if (p0 > 0.05) {
        t.optLive = (TO.bs(lx.c, K, T(lxe), 0, 0, sig, side) - p0 - SPREAD) / p0;
        t.optHeld = (TO.bs(hx.c, K, T(hxe), 0, 0, sig, side) - p0 - SPREAD) / p0;
      }
      trades.push(t); dayTr.push(t);
      open[side] = { liveExitM: lxe }; last[side] = e;
    }
    dayRows.push({ date: d.date, held: dayTr.reduce((s, t) => s + t.shHeld, 0), live: dayTr.reduce((s, t) => s + t.shLive, 0), n: dayTr.length });
  }
  const complete = daysOk(dayRows);
  const opt = trades.filter(t => t.optLive != null);
  const oL = summ(opt.map(t => t.optLive)), oH = summ(opt.map(t => t.optHeld));
  const hL = halves(opt, t => t.optLive), hH = halves(opt, t => t.optHeld);
  const dH = halves(dayRows, r => r.held);
  const shSharpe = sharpe(dayRows.map(r => r.held));
  const reasons = {}; for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
  const med = (xs) => { const v = xs.slice().sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  const ivOk = !!iv && opt.length > 0;
  return {
    days: dayRows.length, trades: trades.length, perDay: dayRows.length ? trades.length / dayRows.length : 0, reasons,
    medLiveHold: med(trades.map(t => t.liveHold)), medHeldHold: med(trades.map(t => t.heldHold)),
    optLive: oL, optHeld: oH, optLiveHalves: hL, optHeldHalves: hH,
    shLive: summ(trades.map(t => t.shLive * 1e4)), shHeld: summ(trades.map(t => t.shHeld * 1e4)),
    shHeldSharpe: shSharpe, shHeldSharpeH1: sharpe(dayRows.filter(r => r.date < SPLIT).map(r => r.held)), shHeldSharpeH2: sharpe(dayRows.filter(r => r.date >= SPLIT).map(r => r.held)),
    byYearLive: byYear(opt, t => t.optLive), byYearHeld: byYear(opt, t => t.optHeld),
    bySide: { call: summ(opt.filter(t => t.side === 'call').map(t => t.optLive)), put: summ(opt.filter(t => t.side === 'put').map(t => t.optLive)) },
    concHeld: concentration(dayRows, r => r.held),
    rows: trades,
    a: grade(ivOk && oL.mean > 0 && oL.t >= 2 && hL.h1.mean > 0 && hL.h2.mean > 0, complete && ivOk),
    b: grade(ivOk && hH.h1.mean > hL.h1.mean && hH.h2.mean > hL.h2.mean, complete && ivOk),
    c: grade(shSharpe >= 0.5 && dH.h1.mean > 0 && dH.h2.mean > 0, complete),
    cOpt: grade(ivOk && oH.mean > 0 && oH.t >= 2 && hH.h1.mean > 0 && hH.h2.mean > 0, complete && ivOk),
  };
}

// ── run + report ────────────────────────────────────────────────────────────────────────────────────────────────
function run(barsByTicker, ivByTicker = {}, vixFn = null, opts = {}) {
  const out = { pass: PASS, tickers: {} };
  const grouped = {}; for (const tk of Object.keys(barsByTicker)) grouped[tk] = groupDays(barsByTicker[tk]);
  // v1.1: data must reach (close to) the run date, or every test on that ticker is INCOMPLETE
  const lasts = Object.values(grouped).map(d => d.length ? d[d.length - 1].date : '').filter(Boolean).sort();
  const asOf = opts.asOf || lasts[lasts.length - 1] || null;
  for (const tk of Object.keys(grouped)) {
    const days = grouped[tk], to = days[days.length - 1] && days[days.length - 1].date;
    const staleDays = asOf && to ? Math.round((Date.parse(asOf) - Date.parse(to)) / 864e5) : null;
    const current = staleDays != null && staleDays <= MAX_STALE_DAYS;
    const r2 = t2(days);
    const r = { days: days.length, from: days[0] && days[0].date, to, staleDays, current,
      T1: t1(days, ivByTicker[tk] || null), T2: { ...r2, rows: undefined }, T2opt: t2opt(r2, ivByTicker[tk] || null), T2opt14: t2opt(r2, ivByTicker[tk] || null, { tradingDays: 10, spread: 0.03 }),
      T7: { ...t7(days, ivByTicker[tk] || null, opts.constants || null), rows: undefined }, T3: t3(days), T5: t5(days, r2, vixFn), T6: t6(days) };
    if (!current) {   // stale data: nothing on this ticker can PASS
      const inc = (o) => { if (o && typeof o === 'object' && 'grade' in o) { o.pass = false; o.grade = 'INCOMPLETE'; } };
      [r.T1, r.T2, r.T2opt, r.T2opt14, r.T7.a, r.T7.b, r.T7.c, r.T7.cOpt, r.T3, r.T5, r.T6.pd, r.T6.round].forEach(inc);
      r.T1.optPass = { dte0: false, dte2: false }; r.T1.optGrade = { dte0: 'INCOMPLETE', dte2: 'INCOMPLETE' };
      r.T2.holdBeatsCap = false; r.T2.holdGrade = 'INCOMPLETE';
    }
    out.tickers[tk] = r;
  }
  out.asOf = asOf;
  out.trials = Object.keys(out.tickers).length * 15;   // T1 x3, T2 + hold-vs-cap, T2-opt, T2-opt14, T7 a/b/c/cOpt, T3, T5, T6 x2
  return out;
}

const f2 = (x, d = 2) => x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d);
const fs = (s, unit = 'bp') => s && s.n ? `${f2(s.mean)} ${unit} (t ${f2(s.t)}, hit ${(s.hit * 100).toFixed(0)}%, n ${s.n})` : 'n/a';
const pf = (b) => b ? 'PASS' : 'fail';
const gr = (o) => (o && o.grade) || pf(o && o.pass);
const fc = (c) => !c || c.topYear == null ? 'n/a (total not positive)' : `largest year ${c.topYear} = ${(c.topShare * 100).toFixed(0)}% of total${c.tooConcentrated ? ' → TOO CONCENTRATED (> 50%)' : ''}`;

function textReport(res, sources = {}) {
  const L = [];
  L.push('APEX FLOW HARNESS — pre-registered tests on SPY/QQQ 5-minute bars (read-only; places no trades)');
  L.push(`Sources: ${Object.entries(sources).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Alpaca 5-min bars (raw), Cboe VIX/VXN'}`);
  L.push(`Trials reported: ${res.trials} (every one, pass or fail). Costs: ${COST_BP} bp per side on shares; $${OPT_SPREAD} round-trip spread on options.`);
  L.push('');
  for (const [tk, r] of Object.entries(res.tickers)) {
    L.push(`════════ ${tk}  (${r.days} days, ${r.from} → ${r.to}) ════════`);
    if (r.current === false) L.push(`   ⚠ data ends ${r.staleDays} days before the run date (${res.asOf}) — every test on ${tk} is INCOMPLETE; rerun ${tk} on its own`);
    L.push(`T1 End-of-day momentum (Baltussen et al.): ${gr(r.T1)}`);
    L.push(`   follow the day's sign, 15:30→close, shares net: ${fs(r.T1.full)}`);
    L.push(`   halves: 2016-20 ${fs(r.T1.halves.h1)} | 2021-on ${fs(r.T1.halves.h2)}`);
    L.push(`   by year: ${Object.entries(r.T1.byYear).map(([y, s]) => `${y} ${f2(s.mean, 1)}`).join('  ')}`);
    L.push(`   first-half-hour predictor (Gao et al.): ${fs(r.T1.gao)}`);
    L.push(`   as options (return on premium): 0DTE ${fs(r.T1.opt0DTE, '')} ${(r.T1.optGrade || {}).dte0 || pf(r.T1.optPass.dte0)} | 2DTE ${fs(r.T1.opt2DTE, '')} ${(r.T1.optGrade || {}).dte2 || pf(r.T1.optPass.dte2)}`);
    L.push(`T2 Noise-area momentum held to trail/close (Zarattini & Aziz approx.): ${gr(r.T2)}`);
    L.push(`   Sharpe ${f2(r.T2.sharpe)} (2016-20 ${f2(r.T2.sharpeH1)}, 2021-on ${f2(r.T2.sharpeH2)}) · ${r.T2.trades} trades on ${r.T2.days} days · median hold ${r.T2.medianHoldMin} min`);
    L.push(`   daily ${fs(r.T2.daily)}`);
    L.push(`   SAME entries with a 60-min cap (APEX-style): Sharpe ${f2(r.T2.capSharpe)} · daily ${fs(r.T2.capDaily)} → holding beats the cap in both halves: ${r.T2.holdGrade === 'INCOMPLETE' ? 'INCOMPLETE' : r.T2.holdBeatsCap ? 'YES' : 'no'}`);
    L.push(`   by year (bp/day): ${Object.entries(r.T2.byYear).map(([y, s]) => `${y} ${f2(s.mean, 1)}`).join('  ')}`);
    L.push(`   concentration (diagnostic): ${fc(r.T2.conc)}`);
    if (r.T2opt) {
      if (r.T2opt.note) L.push(`T2-opt Same trades as ~0.50-delta options (≥ 2 DTE): not run — ${r.T2opt.note}`);
      else {
        L.push(`T2-opt Same trades as ~0.50-delta options (≥ 2 DTE): ${gr(r.T2opt)}`);
        L.push(`   return on premium per trade: ${fs(r.T2opt.full, '')}`);
        L.push(`   halves: 2016-20 ${fs(r.T2opt.h1, '')} | 2021-on ${fs(r.T2opt.h2, '')}`);
        L.push(`   same entries, 60-min cap, as options (reported, not graded): ${fs(r.T2opt.cap, '')}`);
        L.push(`   by year: ${Object.entries(r.T2opt.byYear).map(([y, s]) => `${y} ${f2(s.mean, 3)}`).join('  ')}`);
        L.push(`   concentration (diagnostic): ${fc(r.T2opt.conc)}`);
      }
    }
    if (r.T2opt14 && !r.T2opt14.note) {
      L.push(`T2-opt14 (trial #21) Same trades on APEX's instrument (0.50Δ, 14 DTE, $0.03): ${gr(r.T2opt14)}`);
      L.push(`   return on premium per trade: ${fs(r.T2opt14.full, '')}`);
      L.push(`   halves: 2016-20 ${fs(r.T2opt14.h1, '')} | 2021-on ${fs(r.T2opt14.h2, '')} · 60-min cap (not graded): ${fs(r.T2opt14.cap, '')}`);
      L.push(`   by year: ${Object.entries(r.T2opt14.byYear).map(([y, s]) => `${y} ${f2(s.mean, 3)}`).join('  ')}`);
    }
    if (r.T7) {
      const t = r.T7, pct = (s) => s && s.n ? `${f2(s.mean * 100, 1)}% (t ${f2(s.t)}, hit ${(s.hit * 100).toFixed(0)}%, n ${s.n})` : 'n/a';
      L.push(`T7 APEX intraday-trend replay (live rules, no gamma/breadth/CVD): ${t.trades} trades on ${t.days} days (${t.perDay.toFixed(2)}/day)`);
      L.push(`   exits: ${Object.entries(t.reasons).map(([k, v]) => `${k} ${v}`).join(' · ')} · median hold live ${t.medLiveHold} min, held ${t.medHeldHold} min`);
      L.push(`T7a as live, 0.50Δ 14-DTE options: ${gr(t.a)}   ${pct(t.optLive)}`);
      L.push(`   halves: 2016-20 ${pct(t.optLiveHalves.h1)} | 2021-on ${pct(t.optLiveHalves.h2)} · calls ${pct(t.bySide.call)} | puts ${pct(t.bySide.put)}`);
      L.push(`   by year: ${Object.entries(t.byYearLive).map(([y, s]) => `${y} ${f2(s.mean * 100, 1)}%`).join('  ')}`);
      L.push(`T7b same entries held to VWAP trail/close beat the live exits (options): ${gr(t.b)}   held ${pct(t.optHeld)}`);
      L.push(`   halves held: 2016-20 ${pct(t.optHeldHalves.h1)} | 2021-on ${pct(t.optHeldHalves.h2)}`);
      L.push(`T7c held version on shares: ${gr(t.c)}   Sharpe ${f2(t.shHeldSharpe)} (2016-20 ${f2(t.shHeldSharpeH1)}, 2021-on ${f2(t.shHeldSharpeH2)}) · per trade ${fs(t.shHeld)} vs live exits ${fs(t.shLive)}`);
      L.push(`   concentration (diagnostic): ${fc(t.concHeld)}`);
      L.push(`T7c-opt held version as options: ${gr(t.cOpt)}`);
    }
    L.push(`T3 Turn of the month (McConnell & Xu): ${gr(r.T3)}`);
    L.push(`   close-to-close: TOM ${f2(r.T3.closeToClose.tom.mean, 1)} bp vs other ${f2(r.T3.closeToClose.other.mean, 1)} bp, diff ${f2(r.T3.closeToClose.diff, 1)} (t ${f2(r.T3.closeToClose.t)}) · halves ${f2(r.T3.h1.diff, 1)} / ${f2(r.T3.h2.diff, 1)}`);
    L.push(`   open-to-close (intraday only): diff ${f2(r.T3.openToClose.diff, 1)} bp (t ${f2(r.T3.openToClose.t)})`);
    if (r.T5.note) L.push(`T5 Volatility picks the sleeve: not run — ${r.T5.note}`);
    else {
      L.push(`T5 Volatility picks the sleeve: ${gr(r.T5)}   (VIX terciles ≤${f2(r.T5.vixTerciles[0], 1)} / ≤${f2(r.T5.vixTerciles[1], 1)} / above)`);
      L.push(`   trend Sharpe low/mid/high VIX: ${['low', 'mid', 'high'].map(t => f2(r.T5.trend.all[t])).join(' / ')}  (halves: ${['low', 'high'].map(t => f2(r.T5.trend.h1[t])).join('→')} | ${['low', 'high'].map(t => f2(r.T5.trend.h2[t])).join('→')})`);
      L.push(`   fade  Sharpe low/mid/high VIX: ${['low', 'mid', 'high'].map(t => f2(r.T5.fade.all[t])).join(' / ')}  (halves: ${['low', 'high'].map(t => f2(r.T5.fade.h1[t])).join('→')} | ${['low', 'high'].map(t => f2(r.T5.fade.h2[t])).join('→')}) · fade overall Sharpe ${f2(r.T5.fadeSharpeAll)}`);
    }
    L.push(`T6 Continuation after a level breaks (Osler): prior-day high/low ${gr(r.T6.pd)} ${fs(r.T6.pd.full)} | $5 round numbers ${gr(r.T6.round)} ${fs(r.T6.round.full)}`);
    L.push(`   halves: pd ${f2(r.T6.pd.h1.mean, 1)} / ${f2(r.T6.pd.h2.mean, 1)} bp · round ${f2(r.T6.round.h1.mean, 1)} / ${f2(r.T6.round.h2.mean, 1)} bp`);
    L.push('');
  }
  L.push('PRE-REGISTERED PASS LINES (T1-T6 written before the first run; T2opt/CONC/GRADE added in v1.1 and T2opt14/T7 in v1.2, each before its first run)');
  for (const [k, v] of Object.entries(PASS)) L.push(`  ${k}: ${v}`);
  L.push('');
  L.push('Limits: T2 approximates the published rules; options are Black-Scholes on the daily VIX/VXN (no intraday skew or term');
  L.push('structure); bars are 5-minute (a stop can only trigger on the half-hour check, as in the paper). Not testable here:');
  L.push('dealer gamma, expiration pinning, macro days — no history in Alpaca; gamma is being collected live (flows.js).');
  return L.join('\n');
}

module.exports = { PASS, groupDays, pxAt, summ, sharpe, t1, t2, t2Day, t2opt, t3, t5, t6, t7, adxOf, fadeDay, concentration, run, textReport, etParts,
  MIN_HALF_DAYS, MIN_CELL_DAYS, MAX_STALE_DAYS };
