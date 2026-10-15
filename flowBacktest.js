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
};
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
  const pass = full.mean > 0 && full.t >= 2 && recent.filter(y => yrs[y].mean > 0).length >= 2;
  const gao = summ(rows.filter(r => r.rFH != null).map(r => Math.sign(r.rFH) * r.rLH * 1e4 - 2 * COST_BP));
  const o0 = summ(rows.map(r => r.opt0)), o2 = summ(rows.map(r => r.opt2));
  return { n: rows.length, full, byYear: yrs, recentYears: recent, halves: halves(rows, r => r.sharesBp), gao,
           opt0DTE: o0, opt2DTE: o2, pass, optPass: { dte0: o0.mean > 0 && o0.t >= 2, dte2: o2.mean > 0 && o2.t >= 2 } };
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
    if (pos > 0 && b.c < Math.max(UB, b.vwap)) { trades.push({ dir: 1, r: b.c / entry - 1, from: entryM, to: m }); pos = 0; }
    else if (pos < 0 && b.c > Math.min(LB, b.vwap)) { trades.push({ dir: -1, r: 1 - b.c / entry, from: entryM, to: m }); pos = 0; }
    if (pos === 0 && m < 930) {
      if (b.c > UB) { pos = 1; entry = b.c; entryM = m; }
      else if (b.c < LB) { pos = -1; entry = b.c; entryM = m; }
    }
  }
  const z = d.bars[d.bars.length - 1];
  if (pos) trades.push({ dir: pos, r: pos > 0 ? z.c / entry - 1 : 1 - z.c / entry, from: entryM, to: z.m + 5 });
  // same entries, APEX-style cap: out 60 minutes after entry (or at the trail/close if sooner)
  for (const tr of trades) {
    const capM = Math.min(tr.to, tr.from + 60), b = pxAt(d, capM) || z, e = pxAt(d, tr.from);
    capTrades.push(tr.dir * (b.c / e.c - 1));
  }
  const cost = 2 * COST_BP / 1e4;
  return { date: d.date, ret: trades.reduce((s, t) => s + t.r - cost, 0), capRet: capTrades.reduce((s, r) => s + r - cost, 0), n: trades.length,
           holds: trades.map(t => t.to - t.from) };
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
           pass: sh >= 0.5 && h.h1.mean > 0 && h.h2.mean > 0, holdBeatsCap, rows };
}

// ── T3: turn of the month ───────────────────────────────────────────────────────────────────────────────────────
function t3(days) {
  const byMonth = {}; for (const d of days) (byMonth[d.date.slice(0, 7)] = byMonth[d.date.slice(0, 7)] || []).push(d.date);
  const tom = new Set(); for (const ds of Object.values(byMonth)) { ds.sort(); tom.add(ds[ds.length - 1]); ds.slice(0, 3).forEach(x => tom.add(x)); }
  const rows = days.filter(d => d.prevClose > 0).map(d => ({ date: d.date, cc: (d.close / d.prevClose - 1) * 1e4, oc: (d.close / d.open - 1) * 1e4, tom: tom.has(d.date) }));
  const diff = (rs, k) => { const a = summ(rs.filter(r => r.tom).map(r => r[k])), b = summ(rs.filter(r => !r.tom).map(r => r[k]));
    const se = Math.sqrt((a.sd ** 2) / (a.n || 1) + (b.sd ** 2) / (b.n || 1)); return { tom: a, other: b, diff: a.mean - b.mean, t: se > 0 ? (a.mean - b.mean) / se : null }; };
  const full = diff(rows, 'cc'), h1 = diff(rows.filter(r => r.date < SPLIT), 'cc'), h2 = diff(rows.filter(r => r.date >= SPLIT), 'cc');
  return { closeToClose: full, h1, h2, openToClose: diff(rows, 'oc'), pass: full.diff > 0 && full.t >= 2 && h1.diff > 0 && h2.diff > 0 };
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
  const cell = (rows, half) => {
    const rs = rows.filter(r => half === 'h1' ? r.date < SPLIT : half === 'h2' ? r.date >= SPLIT : true);
    const o = {}; for (const t of ['low', 'mid', 'high']) o[t] = sharpe(rs.filter(r => terc(r.date) === t).map(r => r.ret)); return o;
  };
  const trend = { all: cell(t2res.rows, 'all'), h1: cell(t2res.rows, 'h1'), h2: cell(t2res.rows, 'h2') };
  const fade = { all: cell(fades, 'all'), h1: cell(fades, 'h1'), h2: cell(fades, 'h2') };
  const pass = trend.h1.high > trend.h1.low && trend.h2.high > trend.h2.low && fade.h1.low > fade.h1.high && fade.h2.low > fade.h2.high;
  return { vixTerciles: [q1, q2], trend, fade, fadeSharpeAll: sharpe(fades.map(r => r.ret)), pass };
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
    res[k] = { full, h1: h.h1, h2: h.h2, pass: full.mean > 0 && full.t >= 2 && h.h1.mean > 0 && h.h2.mean > 0 }; }
  return res;
}

// ── run + report ────────────────────────────────────────────────────────────────────────────────────────────────
function run(barsByTicker, ivByTicker = {}, vixFn = null) {
  const out = { pass: PASS, tickers: {} };
  for (const tk of Object.keys(barsByTicker)) {
    const days = groupDays(barsByTicker[tk]);
    const r2 = t2(days);
    out.tickers[tk] = { days: days.length, from: days[0] && days[0].date, to: days[days.length - 1] && days[days.length - 1].date,
      T1: t1(days, ivByTicker[tk] || null), T2: { ...r2, rows: undefined }, T3: t3(days), T5: t5(days, r2, vixFn), T6: t6(days) };
  }
  out.trials = Object.keys(out.tickers).length * 9;   // T1 shares + 2 option variants, T2 + hold-vs-cap, T3, T5, T6 x2
  return out;
}

const f2 = (x, d = 2) => x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d);
const fs = (s, unit = 'bp') => s && s.n ? `${f2(s.mean)} ${unit} (t ${f2(s.t)}, hit ${(s.hit * 100).toFixed(0)}%, n ${s.n})` : 'n/a';
const pf = (b) => b ? 'PASS' : 'fail';

function textReport(res, sources = {}) {
  const L = [];
  L.push('APEX FLOW HARNESS — pre-registered tests on SPY/QQQ 5-minute bars (read-only; places no trades)');
  L.push(`Sources: ${Object.entries(sources).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Alpaca 5-min bars (raw), Cboe VIX/VXN'}`);
  L.push(`Trials reported: ${res.trials} (every one, pass or fail). Costs: ${COST_BP} bp per side on shares; $${OPT_SPREAD} round-trip spread on options.`);
  L.push('');
  for (const [tk, r] of Object.entries(res.tickers)) {
    L.push(`════════ ${tk}  (${r.days} days, ${r.from} → ${r.to}) ════════`);
    L.push(`T1 End-of-day momentum (Baltussen et al.): ${pf(r.T1.pass)}`);
    L.push(`   follow the day's sign, 15:30→close, shares net: ${fs(r.T1.full)}`);
    L.push(`   halves: 2016-20 ${fs(r.T1.halves.h1)} | 2021-on ${fs(r.T1.halves.h2)}`);
    L.push(`   by year: ${Object.entries(r.T1.byYear).map(([y, s]) => `${y} ${f2(s.mean, 1)}`).join('  ')}`);
    L.push(`   first-half-hour predictor (Gao et al.): ${fs(r.T1.gao)}`);
    L.push(`   as options (return on premium): 0DTE ${fs(r.T1.opt0DTE, '')} ${pf(r.T1.optPass.dte0)} | 2DTE ${fs(r.T1.opt2DTE, '')} ${pf(r.T1.optPass.dte2)}`);
    L.push(`T2 Noise-area momentum held to trail/close (Zarattini & Aziz approx.): ${pf(r.T2.pass)}`);
    L.push(`   Sharpe ${f2(r.T2.sharpe)} (2016-20 ${f2(r.T2.sharpeH1)}, 2021-on ${f2(r.T2.sharpeH2)}) · ${r.T2.trades} trades on ${r.T2.days} days · median hold ${r.T2.medianHoldMin} min`);
    L.push(`   daily ${fs(r.T2.daily)}`);
    L.push(`   SAME entries with a 60-min cap (APEX-style): Sharpe ${f2(r.T2.capSharpe)} · daily ${fs(r.T2.capDaily)} → holding beats the cap in both halves: ${r.T2.holdBeatsCap ? 'YES' : 'no'}`);
    L.push(`   by year (bp/day): ${Object.entries(r.T2.byYear).map(([y, s]) => `${y} ${f2(s.mean, 1)}`).join('  ')}`);
    L.push(`T3 Turn of the month (McConnell & Xu): ${pf(r.T3.pass)}`);
    L.push(`   close-to-close: TOM ${f2(r.T3.closeToClose.tom.mean, 1)} bp vs other ${f2(r.T3.closeToClose.other.mean, 1)} bp, diff ${f2(r.T3.closeToClose.diff, 1)} (t ${f2(r.T3.closeToClose.t)}) · halves ${f2(r.T3.h1.diff, 1)} / ${f2(r.T3.h2.diff, 1)}`);
    L.push(`   open-to-close (intraday only): diff ${f2(r.T3.openToClose.diff, 1)} bp (t ${f2(r.T3.openToClose.t)})`);
    if (r.T5.note) L.push(`T5 Volatility picks the sleeve: not run — ${r.T5.note}`);
    else {
      L.push(`T5 Volatility picks the sleeve: ${pf(r.T5.pass)}   (VIX terciles ≤${f2(r.T5.vixTerciles[0], 1)} / ≤${f2(r.T5.vixTerciles[1], 1)} / above)`);
      L.push(`   trend Sharpe low/mid/high VIX: ${['low', 'mid', 'high'].map(t => f2(r.T5.trend.all[t])).join(' / ')}  (halves: ${['low', 'high'].map(t => f2(r.T5.trend.h1[t])).join('→')} | ${['low', 'high'].map(t => f2(r.T5.trend.h2[t])).join('→')})`);
      L.push(`   fade  Sharpe low/mid/high VIX: ${['low', 'mid', 'high'].map(t => f2(r.T5.fade.all[t])).join(' / ')}  (halves: ${['low', 'high'].map(t => f2(r.T5.fade.h1[t])).join('→')} | ${['low', 'high'].map(t => f2(r.T5.fade.h2[t])).join('→')}) · fade overall Sharpe ${f2(r.T5.fadeSharpeAll)}`);
    }
    L.push(`T6 Continuation after a level breaks (Osler): prior-day high/low ${pf(r.T6.pd.pass)} ${fs(r.T6.pd.full)} | $5 round numbers ${pf(r.T6.round.pass)} ${fs(r.T6.round.full)}`);
    L.push(`   halves: pd ${f2(r.T6.pd.h1.mean, 1)} / ${f2(r.T6.pd.h2.mean, 1)} bp · round ${f2(r.T6.round.h1.mean, 1)} / ${f2(r.T6.round.h2.mean, 1)} bp`);
    L.push('');
  }
  L.push('PRE-REGISTERED PASS LINES');
  for (const [k, v] of Object.entries(PASS)) L.push(`  ${k}: ${v}`);
  L.push('');
  L.push('Limits: T2 approximates the published rules; options are Black-Scholes on the daily VIX/VXN (no intraday skew or term');
  L.push('structure); bars are 5-minute (a stop can only trigger on the half-hour check, as in the paper). Not testable here:');
  L.push('dealer gamma, expiration pinning, macro days — no history in Alpaca; gamma is being collected live (flows.js).');
  return L.join('\n');
}

module.exports = { PASS, groupDays, pxAt, summ, sharpe, t1, t2, t2Day, t3, t5, t6, fadeDay, run, textReport, etParts };
