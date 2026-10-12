// trendOptions.js — 10/12 (Harrison): price trend-swing backtest trades as the OPTION APEX would actually hold.
// Pure functions; no I/O. Used by trendBacktest.js. The server route supplies the data (see /api/trend-backtest).
//
// Replaces the old "underlying % minus a flat decay charge" with a real contract, marked every step:
//   * Entry: the 0.65-delta, ~60-DTE call (long) or put (short) — APEX's TREND_DELTA / TREND_TARGET_DTE — strike
//     rounded to a listed $1 strike, expiry the Friday nearest 60 days out.
//   * Pricing: Black-Scholes on the RAW (unadjusted) underlying price, with that day's implied vol:
//       SPY: Cboe VIX (30d) and VIX3M (93d), interpolated in total variance to the contract's days left.
//       QQQ: Cboe VXN, with the same term shape (VIX3M/VIX) applied.
//       Skew: IV(K) = ATM x (1 - SKEW x ln(K/S)) — in-the-money calls (K below spot) carry more vol than puts.
//       No index history -> realized 20-day vol x 1.15 (labeled in the report).
//   * Rolls: at 21 DTE, close and re-open a fresh 0.65-delta 60-DTE contract (APEX's TREND_ROLL_DTE), paying costs.
//   * Exit: valued at the time it happens — open (stale), intraday (stop/trail), or close (chandelier/end).
//   * Cost: COST_RT_PCT % of premium per round trip (spread + fees), charged on every leg.
// Results are % of the INITIAL premium per trade (what one contract's capital did) — the trades themselves are
// identical to the underlying-level study, because exits are decided on the underlying.
//
// Validation: for contracts that traded on or after VALIDATE_FROM (Alpaca has real option bars from early 2024),
// the model's prices are compared with the real daily bars, and every trade whose legs all have real prices is
// re-scored with the real prices. The real-implied vol / model vol ratio (per ticker x call/put) is the calibration.

"use strict";

const OPT = {
  DELTA: 0.65, DTE: 60, ROLL_DTE: 21,
  IV_SCALE: 1.0,             // multiplies the index level before calibration
  SKEW: 4.0,                 // IV(K) = ATM x (1 - SKEW x ln(K/S)), clamped to [IV_MULT_MIN, IV_MULT_MAX]
  IV_MULT_MIN: 0.6, IV_MULT_MAX: 2.5,
  COST_RT_PCT: 2.0,          // % of premium per round trip (spread + fees) — same as the old 0.10%-of-underlying assumption
  DIV: { SPY: 0.013, QQQ: 0.006 },   // approx dividend yields (only used with raw prices)
  RATE_DEFAULT: 0.02,        // used when no T-bill history is supplied
  STRIKE_STEP: 1,
  RV_PROXY_MULT: 1.15, RV_N: 20,
  VALIDATE_FROM: "2024-02-01",
  CALIB_MIN_N: 20, CALIB_MIN: 0.6, CALIB_MAX: 1.6,
};

// ---------- math ----------
function normCdf(x) {   // Abramowitz-Stegun 7.1.26 via erf; |error| < 1.5e-7
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
function invNorm(p) {   // Acklam
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function bs(S, K, T, r, q, sig, type) {
  if (!(S > 0 && K > 0)) return NaN;
  if (T <= 0 || sig <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const v = sig * Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + sig * sig / 2) * T) / v, d2 = d1 - v;
  return type === "call" ? S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
                         : K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}
function bsDelta(S, K, T, r, q, sig, type) {
  const v = sig * Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + sig * sig / 2) * T) / v;
  return type === "call" ? Math.exp(-q * T) * normCdf(d1) : -Math.exp(-q * T) * normCdf(-d1);
}
function impliedVol(price, S, K, T, r, q, type) {
  if (!(price > 0) || !(T > 0)) return null;
  let lo = 0.01, hi = 3;
  if (price <= bs(S, K, T, r, q, lo, type) || price >= bs(S, K, T, r, q, hi, type)) return null;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (bs(S, K, T, r, q, m, type) > price) hi = m; else lo = m; }
  return (lo + hi) / 2;
}

// ---------- dates ----------
const DAY = 86400000;
const dms = (s) => Date.parse(s + "T12:00:00Z");
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const calDays = (a, b) => Math.round((dms(b) - dms(a)) / DAY);
// NYSE holidays that can land on a Friday (expirations then move to Thursday). Computed, not looked up:
// Good Friday (Easter - 2), and New Year / Juneteenth (2022+) / July 4 / Christmas on a Friday or observed on the
// Friday before a Saturday holiday (NYSE does not observe a Saturday New Year's Day on the Friday).
function easter(y) {   // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
        g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
        l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31);
  return `${y}-${String(mo).padStart(2, "0")}-${String(((h + l - 7 * m + 114) % 31) + 1).padStart(2, "0")}`;
}
function isHolidayFriday(date) {
  const y = +date.slice(0, 4), md = date.slice(5);
  if (ymd(dms(easter(y)) - 2 * DAY) === date) return true;
  const fixed = ["01-01", "07-04", "12-25"].concat(y >= 2022 ? ["06-19"] : []);
  if (fixed.includes(md)) return true;                                                  // the holiday itself is the Friday
  const observedFri = ["07-03", "12-24"].concat(y >= 2022 ? ["06-18"] : []);           // Saturday holiday observed Friday
  return observedFri.includes(md);
}
function expiryNear(date, dte) {             // the Friday nearest date + dte (Thursday if that Friday is a holiday)
  const t = dms(date) + dte * DAY, dow = new Date(t).getUTCDay();
  let off = 5 - dow; if (off > 3) off -= 7; if (off < -3) off += 7;
  const fri = ymd(t + off * DAY);
  return isHolidayFriday(fri) ? ymd(dms(fri) - DAY) : fri;
}
const WHEN_H = { open: 6.5, intraday: 3, close: 0 };   // hours to the 4pm close still to elapse that day
const yearsLeft = (date, exp, when) => Math.max(0, (calDays(date, exp) + (WHEN_H[when] || 0) / 24) / 365);
function occ(tk, exp, type, K) {
  return `${tk}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${type === "call" ? "C" : "P"}${String(Math.round(K * 1000)).padStart(8, "0")}`;
}

// ---------- inputs ----------
// Cboe history CSV (DATE,OPEN,HIGH,LOW,CLOSE; MM/DD/YYYY) or FRED CSV (date,value) -> { "YYYY-MM-DD": number }
function parseSeriesCsv(text) {
  const out = {}; if (!text) return out;
  const lines = String(text).trim().split(/\r?\n/); if (!lines.length) return out;
  const hdr = lines[0].split(",").map(h => h.trim().toUpperCase());
  let vi = hdr.indexOf("CLOSE"); if (vi < 0) vi = hdr.length - 1;
  for (const ln of lines.slice(1)) {
    const c = ln.split(","); const ds = (c[0] || "").trim(); const v = parseFloat(c[vi]);
    if (!isFinite(v)) continue;
    let d = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) d = ds;
    else { const m = ds.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) d = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
    if (d) out[d] = v;
  }
  return out;
}
// last value on or before date (carry forward up to maxGap calendar days)
function lookup(series, maxGap = 10) {
  const keys = Object.keys(series || {}).sort();
  return (date) => {
    let lo = 0, hi = keys.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m] <= date) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0 || calDays(keys[k], date) > maxGap) return null;
    return series[keys[k]];
  };
}

// Build the per-ticker pricing context.
//   barsAdj: { SPY: bars[] } (what the signals use)   barsRaw: { SPY: bars[] } (unadjusted, for strikes/prices)
//   series:  { VIX, VIX3M, VXN, DTB3 } maps of date -> value (any may be missing)
function buildContext(barsAdj, barsRaw, series = {}) {
  const ctx = { tickers: {}, sources: {} };
  const vix = lookup(series.VIX || {}), vix3m = lookup(series.VIX3M || {}), vxn = lookup(series.VXN || {}), dtb3 = lookup(series.DTB3 || {}, 15);
  ctx.rate = (d) => { const v = dtb3(d); return v != null ? v / 100 : OPT.RATE_DEFAULT; };
  ctx.sources.rate = Object.keys(series.DTB3 || {}).length ? "3-month T-bill (FRED DTB3)" : `flat ${OPT.RATE_DEFAULT * 100}%`;
  for (const tk of Object.keys(barsAdj)) {
    const adj = barsAdj[tk], raw = (barsRaw && barsRaw[tk]) || null;
    const rawBy = {}; if (raw) for (const b of raw) rawBy[b.t.slice(0, 10)] = b;
    const useRaw = !!raw && adj.every(b => rawBy[b.t.slice(0, 10)]);
    const dates = adj.map(b => b.t.slice(0, 10));
    const factor = adj.map((b, i) => useRaw ? (+rawBy[dates[i]].c) / (+b.c) : 1);   // adjusted -> raw on that day
    // realized-vol proxy (no lookahead: vol at i uses returns through i)
    const rv = new Array(adj.length).fill(null);
    for (let i = OPT.RV_N; i < adj.length; i++) {
      let s = 0, s2 = 0; for (let j = i - OPT.RV_N + 1; j <= i; j++) { const x = Math.log(+adj[j].c / +adj[j - 1].c); s += x; s2 += x * x; }
      const m = s / OPT.RV_N; rv[i] = Math.sqrt(Math.max(0, s2 / OPT.RV_N - m * m) * 252) * OPT.RV_PROXY_MULT;
    }
    const idx30 = tk === "QQQ" ? vxn : vix;
    const haveIdx = Object.keys((tk === "QQQ" ? series.VXN : series.VIX) || {}).length > 0;
    ctx.sources[tk] = haveIdx ? (tk === "QQQ" ? "Cboe VXN" : "Cboe VIX") + (Object.keys(series.VIX3M || {}).length ? " + VIX3M term shape" : "") : "realized 20-day vol x " + OPT.RV_PROXY_MULT + " (no index history)";
    ctx.sources[tk + "_prices"] = useRaw ? "raw (unadjusted) prices" : "dividend-adjusted prices (no raw history; dividends ignored)";
    const dateIdx = {}; dates.forEach((d, i) => dateIdx[d] = i);
    // ATM vol for a given date and days-to-expiry
    const atm = (date, days) => {
      const v30 = idx30(date);
      if (v30 == null) { const i = dateIdx[date]; const p = i != null ? rv[i] : null; return p > 0.03 ? p : 0.18; }
      let s30 = v30 / 100, s93 = null;
      const a = vix(date), b = vix3m(date);
      if (a && b) s93 = s30 * (b / a);   // term shape from VIX3M/VIX, applied to the ticker's own 30-day index
      if (s93 == null || days <= 30) return s30;
      if (days >= 93) return s93;
      const tv = s30 * s30 * 30 + (s93 * s93 * 93 - s30 * s30 * 30) * (days - 30) / 63;
      return Math.sqrt(Math.max(1e-6, tv / days));
    };
    ctx.tickers[tk] = { adj, dates, factor, dateIdx, atm, q: useRaw ? (OPT.DIV[tk] || 0) : 0 };
  }
  return ctx;
}

// vol for a contract: ATM (term-interpolated) x scale x calibration x skew
function volFor(ctx, tk, date, exp, when, S, K, type, M) {
  const days = Math.max(1, calDays(date, exp) + (WHEN_H[when] || 0) / 24);
  const base = ctx.tickers[tk].atm(date, days) * M.ivScale * ((M.calib && M.calib[tk] && M.calib[tk][type]) || 1);
  const mult = Math.min(OPT.IV_MULT_MAX, Math.max(OPT.IV_MULT_MIN, 1 - M.skew * Math.log(K / S)));
  return base * mult;
}

// pick the 0.65-delta contract ~60 DTE out
function pickContract(ctx, tk, date, when, S, type, M) {
  const exp = expiryNear(date, OPT.DTE), T = yearsLeft(date, exp, when), r = ctx.rate(date), q = ctx.tickers[tk].q;
  const z = invNorm(Math.min(0.999, OPT.DELTA * Math.exp(q * T)));
  const d1 = type === "call" ? z : -z;
  let sig = ctx.tickers[tk].atm(date, OPT.DTE) * M.ivScale, K = S;
  for (let it = 0; it < 6; it++) {
    K = S * Math.exp(-d1 * sig * Math.sqrt(T) + (r - q + sig * sig / 2) * T);
    sig = volFor(ctx, tk, date, exp, when, S, K, type, M);
  }
  K = Math.max(OPT.STRIKE_STEP, Math.round(K / OPT.STRIKE_STEP) * OPT.STRIKE_STEP);
  return { tk, type, K, exp, symbol: occ(tk, exp, type, K) };
}

// value a contract at (date, when, raw S)
function mark(ctx, tk, c, date, when, S, M) {
  // vol known at that moment: an OPEN valuation uses the prior close's index level
  const C = ctx.tickers[tk], i = C.dateIdx[date];
  const volDate = when === "open" && i > 0 ? C.dates[i - 1] : date;
  const T = yearsLeft(date, c.exp, when), r = ctx.rate(date), q = C.q;
  const sig = volFor(ctx, tk, volDate, c.exp, when, S, c.K, c.type, M);
  return { px: bs(S, c.K, T, r, q, sig, c.type), sig, S, T, r, q, date, when };
}

const EXIT_WHEN = { stale: "open", stop: "intraday", trail: "intraday", chandelier: "close", "open-at-end": "close" };

// Price one trade. trade: { side, ei, xi, at, entry, exit, why } (indices into the adjusted bars).
function priceTrade(ctx, tk, t, M) {
  const C = ctx.tickers[tk], type = t.side === "long" ? "call" : "put";
  const rawAt = (i, px) => px * C.factor[i];
  const legs = [];
  let when0 = t.at || "close", d0 = C.dates[t.ei], S0 = rawAt(t.ei, t.entry);
  let c = pickContract(ctx, tk, d0, when0, S0, type, M), e = mark(ctx, tk, c, d0, when0, S0, M);
  // roll checks at each close strictly before the exit bar (an open entry's own close counts)
  const firstRollBar = when0 === "open" ? t.ei : t.ei + 1;
  for (let j = firstRollBar; j < t.xi; j++) {
    const dj = C.dates[j];
    if (calDays(dj, c.exp) <= OPT.ROLL_DTE) {
      const Sj = +C.adj[j].c * C.factor[j];
      const x = mark(ctx, tk, c, dj, "close", Sj, M);
      legs.push({ c, entry: e, exit: x });
      c = pickContract(ctx, tk, dj, "close", Sj, type, M); e = mark(ctx, tk, c, dj, "close", Sj, M);
    }
  }
  const xw = EXIT_WHEN[t.why] || "close", dx = C.dates[t.xi];
  const x = mark(ctx, tk, c, dx, xw, rawAt(t.xi, t.exit), M);
  if (xw === "intraday") x.closeRef = mark(ctx, tk, c, dx, "close", +C.adj[t.xi].c * C.factor[t.xi], M);   // for validation
  legs.push({ c, entry: e, exit: x });
  const prem0 = legs[0].entry.px;
  let pnl = 0, pnlMid = 0;
  for (const L of legs) { const g = L.exit.px - L.entry.px; pnlMid += g; pnl += g - M.costPct / 100 * (L.entry.px + L.exit.px) / 2; }
  return { prem0, optPct: pnl / prem0 * 100, optMid: pnlMid / prem0 * 100, optUsd: pnl * 100, legs };
}

const BASE_MODEL = () => ({ ivScale: OPT.IV_SCALE, skew: OPT.SKEW, costPct: OPT.COST_RT_PCT, calib: null });

// ---------- validation ----------
// Contracts (and the dates they need real bars for) among trades with any leg on/after VALIDATE_FROM.
function plan(pricedByTicker) {
  const need = {};
  for (const arr of Object.values(pricedByTicker)) for (const p of arr) for (const L of p.legs) {
    if (L.entry.date < OPT.VALIDATE_FROM) continue;
    (need[L.c.symbol] = need[L.c.symbol] || new Set()).add(L.entry.date).add(L.exit.date);
  }
  const out = {}; for (const [s, set] of Object.entries(need)) out[s] = [...set].sort();
  return out;
}
// real price at a valuation point from a daily bar; intraday exits are scaled from the real close by the model's own ratio
function realAt(bars, L, end) {
  const pt = L[end], b = bars && bars[L.c.symbol] && bars[L.c.symbol][pt.date];
  if (!b) return null;
  if (pt.when === "open") return +b.o > 0 ? +b.o : null;
  if (pt.when === "close") return +b.c > 0 ? +b.c : null;
  if (pt.when === "intraday" && pt.closeRef && pt.closeRef.px > 0 && +b.c > 0) return +b.c * pt.px / pt.closeRef.px;
  return null;
}
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// optionBars: { SYMBOL: { "YYYY-MM-DD": {o,c,...} } }
function validate(pricedRows, optionBars, costPct) {
  const pts = [], seen = new Set();
  for (const pr of pricedRows) for (const p of pr.trades) for (const L of p.legs) for (const end of ["entry", "exit"]) {
    const pt = L[end]; if (pt.when === "intraday" || pt.date < OPT.VALIDATE_FROM) continue;
    const key = `${L.c.symbol}|${pt.date}|${pt.when}`; if (seen.has(key)) continue; seen.add(key);
    const real = realAt(optionBars, L, end); if (!(real > 0) || !(pt.px > 0)) continue;
    const ivReal = impliedVol(real, pt.S, L.c.K, pt.T, pt.r, pt.q, L.c.type);
    pts.push({ tk: L.c.tk, type: L.c.type, model: pt.px, real, err: (pt.px - real) / real * 100, ivModel: pt.sig, ivReal, inp: [pt.S, L.c.K, pt.T, pt.r, pt.q, pt.sig, L.c.type] });
  }
  // calibration: median real/model IV per ticker x type (fallback: per ticker, then 1)
  const calib = {}, calibN = {};
  for (const tk of [...new Set(pts.map(p => p.tk))]) {
    calib[tk] = {}; calibN[tk] = {};
    const tkPts = pts.filter(p => p.tk === tk && p.ivReal);
    const pooled = tkPts.length >= OPT.CALIB_MIN_N ? med(tkPts.map(p => p.ivReal / p.ivModel)) : null;
    for (const type of ["call", "put"]) {
      const sel = tkPts.filter(p => p.type === type);
      const f = sel.length >= OPT.CALIB_MIN_N ? med(sel.map(p => p.ivReal / p.ivModel)) : pooled;
      calib[tk][type] = f == null ? 1 : Math.min(OPT.CALIB_MAX, Math.max(OPT.CALIB_MIN, +f.toFixed(3)));
      calibN[tk][type] = sel.length;
    }
  }
  for (const p of pts) { const [S, K, T, r, q, sig, type] = p.inp; const f = (calib[p.tk] || {})[type] || 1;
    p.errCal = (bs(S, K, T, r, q, sig * f, type) - p.real) / p.real * 100; delete p.inp; }
  const grp = (sel) => ({ n: sel.length, medAbsErrCal: sel.length ? +med(sel.map(p => Math.abs(p.errCal))).toFixed(1) : null, medAbsErr: sel.length ? +med(sel.map(p => Math.abs(p.err))).toFixed(1) : null,
    medErr: sel.length ? +med(sel.map(p => p.err)).toFixed(1) : null,
    ivRatio: sel.filter(p => p.ivReal).length ? +med(sel.filter(p => p.ivReal).map(p => p.ivReal / p.ivModel)).toFixed(3) : null });
  const prices = { all: grp(pts) };
  for (const tk of ["SPY", "QQQ"]) for (const type of ["call", "put"]) prices[`${tk} ${type}`] = grp(pts.filter(p => p.tk === tk && p.type === type));
  // trades re-scored on real prices (every leg endpoint must have a real price)
  const trades = [];
  for (const pr of pricedRows) {
    const both = [];
    for (const p of pr.trades) {
      if (p.legs[0].entry.date < OPT.VALIDATE_FROM) continue;
      let pnl = 0, ok = true;
      for (const L of p.legs) {
        const a = realAt(optionBars, L, "entry"), b = realAt(optionBars, L, "exit");
        if (!(a > 0 && b > 0)) { ok = false; break; }
        pnl += (b - a) - costPct / 100 * (a + b) / 2;
      }
      if (!ok) continue;
      const realPrem0 = realAt(optionBars, p.legs[0], "entry");
      both.push({ model: p.optPct, real: pnl / realPrem0 * 100 });
    }
    if (!both.length) { trades.push({ exitSet: pr.exitSet, variant: pr.variant, n: 0 }); continue; }
    const avg = (k) => +(both.reduce((s, x) => s + x[k], 0) / both.length).toFixed(2);
    const agree = both.filter(x => Math.sign(x.model) === Math.sign(x.real)).length;
    trades.push({ exitSet: pr.exitSet, variant: pr.variant, n: both.length, modelAvg: avg("model"), realAvg: avg("real"),
      signAgreePct: Math.round(agree / both.length * 100),
      modelWR: Math.round(both.filter(x => x.model > 0).length / both.length * 100), realWR: Math.round(both.filter(x => x.real > 0).length / both.length * 100) });
  }
  return { points: pts.length, prices, calib, calibN, trades };
}

module.exports = { OPT, easter, isHolidayFriday, normCdf, invNorm, bs, bsDelta, impliedVol, expiryNear, yearsLeft, occ, parseSeriesCsv, lookup,
  buildContext, volFor, pickContract, mark, priceTrade, BASE_MODEL, plan, validate, EXIT_WHEN };
