// backfill.js — pull deep history from Alpaca and reconstruct APEX's tape, then run the decisive
// direction test (fade-reversion, de-meaned by day, split by regime) on months of real data —
// instead of waiting for the live tape to accumulate.
//
// WHY THIS IS TRUSTWORTHY: it reuses APEX's OWN fetch (alpacaGet) and OWN signal functions
// (calcRSI/calcADX/calcVWAP from signals.js) — the same code the live scanner runs. So the
// reconstructed history matches the live tape by construction, not by a parallel reimplementation.
// (This is the mistake the old backtest.js made with backtestScoreSignal.)
//
// SCOPE: reconstructs the DIRECTION-TEST tape (px, iRSI, dRSI, adx, vwap%) — everything the fade
// test needs. It does NOT reconstruct volPace/breadth/GEX (those need volume-pace state, the breadth
// universe, and option OI — Alpaca history doesn't serve OI). GEX-conditioning still needs the live
// capture (now fixed) or AlphaVantage OI. Alpaca underlying history is enough for the direction verdict.
//
// RUN (in APEX's environment, which has the Alpaca credentials):
//   node backfill.js SPY,QQQ 2024-06-01 2024-12-31
//
// It prints the de-meaned fade edge over the whole window and split by ADX regime. Positive-and-
// surviving-de-meaning in the low-ADX (range) regime = the first real evidence mean-reversion has a
// forecastable edge, on deep real data. Flat = the direction problem is confirmed at scale.

const { alpacaGet } = require('./broker');
const { calcRSI, calcADX, calcVWAP } = require('./signals');
let ALPACA_DATA; try { ({ ALPACA_DATA } = require('./constants')); } catch (_) { ALPACA_DATA = undefined; }

const ET = { timeZone: "America/New_York" };
const etDate = (iso) => new Date(iso).toLocaleDateString("en-CA", ET);
const etMin  = (iso) => { const s = new Date(iso).toLocaleTimeString("en-US", { ...ET, hour12: false }); const [h, m] = s.split(":"); return (+h) * 60 + (+m); };
const isRTH  = (iso) => { const m = etMin(iso); return m >= 570 && m <= 960; };   // 9:30 (570) .. 16:00 (960)

// ---- fetch ----
async function fetchMinuteBars(ticker, startISO, endISO) {
  // 8/24 (panel fix): cascade sip -> iex like broker.js. Hardcoding sip returned EMPTY on IEX-only
  // (paper) accounts — the backfill would silently produce nothing.
  for (const feed of ["sip", "iex"]) {
    const out = []; let pageToken = null; let got = false;
    for (let guard = 0; guard < 400; guard++) {                     // hard page cap
      const pg = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
      const url = `/stocks/${ticker}/bars?timeframe=1Min&start=${startISO}&end=${endISO}&limit=10000&adjustment=raw&feed=${feed}${pg}`;
      let data;
      try { data = await alpacaGet(url, ALPACA_DATA); } catch (e) { break; }
      if (!data || !Array.isArray(data.bars)) break;
      for (const b of data.bars) out.push(b);
      if (data.bars.length) got = true;
      pageToken = data.next_page_token || null;
      if (!pageToken) break;
      await new Promise(r => setTimeout(r, 120));                    // gentle on the rate limit
    }
    if (got && out.length) return out;                              // this feed yielded data
  }
  return [];
}
async function fetchDailyBars(ticker, startISO, endISO) {
  for (const feed of ["sip", "iex"]) {                              // panel fix: cascade, not hardcoded sip
    try {
      const data = await alpacaGet(`/stocks/${ticker}/bars?timeframe=1Day&start=${startISO}&end=${endISO}&limit=1000&feed=${feed}`, ALPACA_DATA);
      if (data && data.bars && data.bars.length) return data.bars;
    } catch (_) {}
  }
  return [];
}

// ---- reconstruct the tape using APEX's own signal functions ----
// dailyBars: full daily series; minuteBarsByDay: {date: [bars]} (RTH only, chronological)
function reconstructTape(minuteBarsByDay, dailyBars) {
  const rows = [];
  const dailyDates = dailyBars.map(b => etDate(b.t));
  for (const date of Object.keys(minuteBarsByDay).sort()) {
    const day = minuteBarsByDay[date];
    // daily bars strictly BEFORE today (for dRSI — matches live: daily RSI excludes the forming bar)
    const di = dailyDates.indexOf(date);
    const dailySoFar = di > 0 ? dailyBars.slice(0, di) : dailyBars.filter(b => etDate(b.t) < date);
    const dRSI = dailySoFar.length >= 14 ? calcRSI(dailySoFar) : null;
    for (let t = 0; t < day.length; t++) {
      const sofar = day.slice(0, t + 1);                            // intraday bars up to and incl. now
      if (sofar.length < 5) continue;                               // need a little history
      const px = day[t].c;
      const vwap = calcVWAP(sofar);
      rows.push({
        date, ticker: day[t].__tkr, tMin: etMin(day[t].t), px,
        iRSI: calcRSI(sofar),
        dRSI,
        adx: sofar.length >= 14 ? calcADX(sofar) : null,
        vwapPct: (vwap > 0) ? ((px - vwap) / vwap) * 100 : null,
      });
    }
  }
  return rows;
}

// ---- forward returns (fixed horizon, same-day, no truncation) ----
function stampForward(rows, horizons = [5, 15, 30, 60], pathH = 30) {
  const byDay = {};
  for (const r of rows) (byDay[r.date + "|" + r.ticker] ||= []).push(r);
  for (const key of Object.keys(byDay)) {
    const g = byDay[key].sort((a, b) => a.tMin - b.tMin);
    for (let i = 0; i < g.length; i++) {
      const p0 = g[i].px;
      g[i].fwd = {};                                   // forward return at each horizon
      for (const H of horizons) {
        let j = i; while (j < g.length && g[j].tMin < g[i].tMin + H) j++;
        g[i].fwd[H] = (j < g.length && g[j].tMin - g[i].tMin <= H + 3) ? ((g[j].px - p0) / p0) * 100 : null;
      }
      let lo = p0, hi = p0, k = i;                     // MAE/MFE over the path window (exit design)
      while (k < g.length && g[k].tMin <= g[i].tMin + pathH) { if (g[k].px < lo) lo = g[k].px; if (g[k].px > hi) hi = g[k].px; k++; }
      g[i].loPct = ((lo - p0) / p0) * 100;
      g[i].hiPct = ((hi - p0) / p0) * 100;
    }
  }
}

// ---- DETAILED fade breakdown (per Lopez de Prado / Aronson / Pardo discipline) ----
function _stats(a) {
  const n = a.length; if (!n) return { n: 0, mean: 0, sd: 0, se: 0, t: 0 };
  const m = a.reduce((s, x) => s + x, 0) / n;
  const varr = n > 1 ? a.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1) : 0;
  const sd = Math.sqrt(varr), se = n > 0 ? sd / Math.sqrt(n) : 0;
  return { n, mean: m, sd, se, t: se > 0 ? m / se : 0 };
}
const _mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

// rows = the FULL tape; extremes are drawn from adx<=adxMax; baseline = each ticker-day's drift over ALL rows.
function runFadeTest(rows, label = "ALL", opts = {}) {
  const adxMax = opts.adxMax != null ? opts.adxMax : 20;
  const H0 = 30;                                                     // primary horizon
  const v = rows.filter(r => r.fwd && r.fwd[H0] != null && r.iRSI != null && r.adx != null && r.vwapPct != null);
  if (!v.length) return `  ${label}: no data`;
  const _bk = (r) => r.date + "|" + r.ticker;
  const baseAt = (H) => { const acc = {}, cnt = {};
    for (const r of v) { if (r.fwd[H] == null) continue; const k = _bk(r); acc[k] = (acc[k] || 0) + r.fwd[H]; cnt[k] = (cnt[k] || 0) + 1; }
    const b = {}; for (const k of Object.keys(acc)) b[k] = acc[k] / cnt[k]; return b; };
  const isDn = (r, irsi, vw) => r.adx <= adxMax && r.iRSI <= irsi && r.vwapPct <= -vw;
  const isUp = (r, irsi, vw) => r.adx <= adxMax && r.iRSI >= (100 - irsi) && r.vwapPct >= vw;
  const excessAt = (H, irsi = 30, vw = 0.19) => {
    const base = baseAt(H);
    const dn = v.filter(r => r.fwd[H] != null && isDn(r, irsi, vw));
    const up = v.filter(r => r.fwd[H] != null && isUp(r, irsi, vw));
    const arr = [...dn.map(r => r.fwd[H] - base[_bk(r)]), ...up.map(r => -(r.fwd[H] - base[_bk(r)]))];
    return { arr, dn, up };
  };

  const P = excessAt(H0); const st = _stats(P.arr);
  if (st.n < 20) return `  ${label} (n=${st.n}): underpowered — too few extreme events to test`;
  const base30 = baseAt(H0);

  // [1] SIGNIFICANCE — t-stat + Aronson Monte-Carlo permutation p (is the excess > random same-regime moments?)
  const pool = v.filter(r => r.fwd[H0] != null && r.adx <= adxMax).map(r => r.fwd[H0] - base30[_bk(r)]);
  let ge = 0; const NP = 2000;
  for (let p = 0; p < NP; p++) { let s = 0; for (let q = 0; q < st.n; q++) s += pool[(Math.random() * pool.length) | 0]; if (s / st.n >= st.mean) ge++; }
  const permP = ge / NP;

  // [2] DISTRIBUTION — don't trust the mean
  const hit = 100 * P.arr.filter(x => x > 0).length / P.arr.length;
  const sorted = [...P.arr].sort((a, b) => a - b); const med = sorted[sorted.length >> 1];
  const avgW = _mean(P.arr.filter(x => x > 0)), avgL = _mean(P.arr.filter(x => x <= 0));

  // [3] HORIZON SENSITIVITY — real reversion is stable across marks, not one cherry-picked horizon
  const horiz = [5, 15, 30, 60].map(H => { const m = _mean(excessAt(H).arr); return `+${H}m ${m >= 0 ? "+" : ""}${m.toFixed(3)}%`; }).join("  ");

  // [4] SUB-PERIOD STABILITY — Pardo walk-forward: same sign in both halves?
  const dates = [...new Set(v.map(r => r.date))].sort(); const mid = dates[dates.length >> 1];
  const half = (first) => { const dn = P.dn.filter(r => first ? r.date < mid : r.date >= mid), up = P.up.filter(r => first ? r.date < mid : r.date >= mid);
    const a = [...dn.map(r => r.fwd[H0] - base30[_bk(r)]), ...up.map(r => -(r.fwd[H0] - base30[_bk(r)]))]; return { m: _mean(a), n: a.length }; };
  const H1 = half(true), H2 = half(false);

  // [5] THRESHOLD ROBUSTNESS — Lopez de Prado: not overfit to one cutoff; edge should concentrate in true extremes
  const thGrid = [25, 30, 35].map(irsi => { const a = excessAt(H0, irsi, 0.19).arr; return `<=${irsi}:${_mean(a) >= 0 ? "+" : ""}${_mean(a).toFixed(3)}%(n${a.length})`; }).join("  ");

  // [6] PATH / EXIT DESIGN — MAE/MFE (the underwater-first problem for MR exits)
  const mae = [...P.dn.map(r => r.loPct), ...P.up.map(r => -r.hiPct)].filter(x => x != null);
  const mfe = [...P.dn.map(r => r.hiPct), ...P.up.map(r => -r.loPct)].filter(x => x != null);
  const avgMAE = _mean(mae), avgMFE = _mean(mfe);

  // [7] NET OF COST — Sinclair: is it tradeable after frictions? breakeven cost in bp
  const beBp = st.mean * 100, net1 = st.mean - 0.01;

  return [
    `  ${label} — n=${st.n} extremes over ${dates.length} days`,
    `   [1] significance : excess ${st.mean >= 0 ? "+" : ""}${st.mean.toFixed(3)}%/trade  SE ${st.se.toFixed(3)}%  t ${st.t.toFixed(2)}  perm-p ${permP.toFixed(3)} ${permP < 0.05 ? "(distinguishable from noise)" : "(NOT distinguishable from noise)"}`,
    `   [2] distribution : hit ${hit.toFixed(0)}% reverted  median ${med >= 0 ? "+" : ""}${med.toFixed(3)}%  avgWin ${avgW >= 0 ? "+" : ""}${avgW.toFixed(3)}% / avgLoss ${avgL.toFixed(3)}%`,
    `   [3] horizons     : ${horiz}`,
    `   [4] stability    : H1 ${H1.m >= 0 ? "+" : ""}${H1.m.toFixed(3)}%(n${H1.n})  H2 ${H2.m >= 0 ? "+" : ""}${H2.m.toFixed(3)}%(n${H2.n})  ${Math.sign(H1.m) === Math.sign(H2.m) ? "[same sign — survives split]" : "[SIGN FLIPS — unstable]"}`,
    `   [5] thresholds   : ${thGrid}  ${"(monotonic in extremity = real; noisy = overfit)"}`,
    `   [6] path/exit    : MAE ${avgMAE.toFixed(3)}% (adverse before revert)  MFE +${avgMFE.toFixed(3)}%  -> a stop tighter than ${Math.abs(avgMAE).toFixed(2)}% exits winners at max adverse`,
    `   [7] net of cost  : breakeven ${beBp.toFixed(1)}bp  @1bp ${net1 >= 0 ? "+" : ""}${net1.toFixed(3)}%  -> ${beBp > 3 ? "survives on the UNDERLYING at low cost" : "marginal even gross"}; short-DTE options (theta+spread) >> ${beBp.toFixed(1)}bp`,
  ].join("\n");
}

// ---- orchestrate ----  returns the verdict TEXT (so server/UI can display it), not just console
async function runBackfill({ tickers = ["SPY", "QQQ"], start = "2024-06-01", end = "2024-12-31" } = {}) {
  const L = []; const log = (s) => L.push(s);
  log(`[BACKFILL] ${tickers.join(",")} ${start}..${end} — tape reconstructed via APEX's own calcRSI/calcADX/calcVWAP`);
  let all = [];
  for (const ticker of tickers) {
    const daily = await fetchDailyBars(ticker, start, end);
    const minute = await fetchMinuteBars(ticker, `${start}T00:00:00Z`, `${end}T23:59:59Z`);
    const byDay = {};
    for (const b of minute) { if (!isRTH(b.t)) continue; b.__tkr = ticker; (byDay[etDate(b.t)] ||= []).push(b); }
    for (const d of Object.keys(byDay)) byDay[d].sort((a, b) => new Date(a.t) - new Date(b.t));
    const rows = reconstructTape(byDay, daily);
    log(`  ${ticker}: ${Object.keys(byDay).length} days, ${rows.length} tape rows`);
    all = all.concat(rows);
  }
  stampForward(all, 30);
  log(`\nFADE-REVERSION TEST (+30min, excess over day baseline) on ${all.length} reconstructed rows:`);
  log(runFadeTest(all, "ALL range (adx<=20)", { adxMax: 20 }));
  log("");
  log(runFadeTest(all, "LOW-ADX (adx<=15, MR-friendly)", { adxMax: 15 }));
  log(`\nNOTE: ADX is the regime proxy from bars alone. True gamma split needs OI (AlphaVantage) or the`);
  log(`live GEX capture. Low-ADX edge surviving here = first real signal MR works — confirm vs gamma regime.`);
  return L.join("\n");
}

async function main() {
  const tickers = (process.argv[2] || "SPY,QQQ").split(",");
  console.log(await runBackfill({ tickers, start: process.argv[3], end: process.argv[4] }));
}
if (require.main === module) main().catch(e => { console.error("[BACKFILL] fatal:", e.message); process.exit(1); });
module.exports = { runBackfill, fetchMinuteBars, fetchDailyBars, reconstructTape, stampForward, runFadeTest };
