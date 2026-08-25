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
function stampForward(rows, H = 30) {
  const byDay = {};
  for (const r of rows) (byDay[r.date + r.ticker] ||= []).push(r);
  for (const key of Object.keys(byDay)) {
    const g = byDay[key].sort((a, b) => a.tMin - b.tMin);
    for (let i = 0; i < g.length; i++) {
      let j = i; while (j < g.length && g[j].tMin < g[i].tMin + H) j++;
      g[i].fwd = (j < g.length && g[j].tMin - g[i].tMin <= H + 3) ? ((g[j].px - g[i].px) / g[i].px) * 100 : null;
    }
  }
}

// ---- the decisive test: de-meaned fade edge, overall and split by regime ----
function runFadeTest(rows, label = "ALL") {
  const v = rows.filter(r => r.fwd != null && r.iRSI != null && r.adx != null && r.vwapPct != null);
  if (!v.length) return `  ${label}: no data`;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  // DAY BASELINE = mean forward return over ALL valid rows that day (the day's drift, from a random
  // moment). The correct control: do EXTREMES forward-return more than baseline, in the reversion
  // direction? (Subtracting the extremes' OWN day-mean, as before, wrongly removes a constant edge.)
  // baseline keyed per TICKER-DAY (SPY and QQQ drift differently — each extreme vs its own instrument's day)
  const _bk = (r) => r.date + "|" + r.ticker;
  const dayBase = {}; { const acc = {}, cnt = {};
    for (const r of v) { const k = _bk(r); acc[k] = (acc[k] || 0) + r.fwd; cnt[k] = (cnt[k] || 0) + 1; }
    for (const k of Object.keys(acc)) dayBase[k] = acc[k] / cnt[k]; }
  const dn = v.filter(r => r.adx <= 20 && r.iRSI <= 30 && r.vwapPct <= -0.19);   // oversold+below VWAP in range -> fade UP
  const up = v.filter(r => r.adx <= 20 && r.iRSI >= 70 && r.vwapPct >= 0.19);    // overbought+above VWAP in range -> fade DOWN
  if (!dn.length && !up.length) return `  ${label}: no extreme events`;
  const rawArr    = [...dn.map(r => r.fwd),                     ...up.map(r => -r.fwd)];
  const excessArr = [...dn.map(r => r.fwd - dayBase[_bk(r)]),   ...up.map(r => -(r.fwd - dayBase[_bk(r)]))];  // excess over this instrument's day baseline
  const raw = mean(rawArr), excess = mean(excessArr), n = excessArr.length;
  const verdict = n < 40 ? "underpowered" : (excess > 0.03 ? "EDGE over baseline" : "no edge over baseline");
  return `  ${label}: n=${n}  raw ${raw >= 0 ? "+" : ""}${raw.toFixed(3)}%  excess-over-baseline ${excess >= 0 ? "+" : ""}${excess.toFixed(3)}%  -> ${verdict}`;
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
  log(runFadeTest(all, "ALL (adx<=20 range)"));
  log(runFadeTest(all.filter(r => r.adx != null && r.adx <= 15), "LOW-ADX <=15 (MR-friendly)"));
  log(runFadeTest(all.filter(r => r.adx != null && r.adx >= 25), "HIGH-ADX >=25 (trend)"));
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
