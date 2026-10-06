// marketInternals.js — MARKET-INTERNALS PROXY (10/6, Harrison). MEASUREMENT ONLY — nothing here gates a trade.
//
// Alpaca carries no NYSE internals ($TICK / $ADD / $TRIN — APEX's _probeInternals already confirmed). The old
// breadth read is 13 sector ETFs up vs down since the open, too coarse to separate trend days from chop. This
// builds a proxy from the 50 largest US stocks — the names that actually move SPY/QQQ — with ONE multi-symbol
// snapshot request per minute:
//   advPct    share of names above their PRIOR CLOSE                 (advance/decline proxy)
//   vwapPct   share of names above their own SESSION VWAP            (who controls the session)
//   upMinPct  share whose latest 1-min bar closed UP                 (TICK-style snapshot)
//   cumTick   running sum over the session of (up-minute names - down-minute names), once per new minute
//             (cumulative TICK proxy — a steadily rising/falling line is the classic trend-day signature)
// The basket is a static list of large caps; equal-weighted counts, so exact index weights don't matter.
// Review it once or twice a year.

const BASKET = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","AVGO","TSLA","BRK.B","JPM",
  "LLY","V","XOM","UNH","MA","COST","HD","PG","WMT","NFLX",
  "JNJ","ABBV","BAC","CRM","ORCL","KO","CVX","MRK","AMD","PEP",
  "TMO","ADBE","LIN","ACN","CSCO","MCD","WFC","ABT","IBM","PM",
  "GE","QCOM","TXN","CAT","INTU","VZ","DIS","AMGN","NOW","GS",
];
const REFRESH_MS = 60000;
let _inflight = null;

function _etDay(ms = Date.now()) { return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }

// Pure: snapshots map -> counts.  snaps = { SYM: { latestTrade:{p}, latestQuote:{ap,bp}, minuteBar:{o,c,t}, dailyBar:{vw}, prevDailyBar:{c} } }
function summarize(snaps) {
  let n = 0, adv = 0, vw = 0, nVw = 0, up = 0, dn = 0, nMin = 0, minuteT = null;
  for (const sym of Object.keys(snaps || {})) {
    const s = snaps[sym] || {};
    const q = s.latestQuote || {}, tr = s.latestTrade || {};
    const px = (tr.p > 0) ? tr.p : ((q.ap > 0 && q.bp > 0) ? (q.ap + q.bp) / 2 : null);
    const pc = s.prevDailyBar && s.prevDailyBar.c;
    if (!(px > 0) || !(pc > 0)) continue;
    n++;
    if (px > pc) adv++;
    const svw = s.dailyBar && s.dailyBar.vw;
    if (svw > 0) { nVw++; if (px > svw) vw++; }
    const mb = s.minuteBar;
    if (mb && mb.o > 0 && mb.c > 0) {
      nMin++;
      if (mb.c > mb.o) up++; else if (mb.c < mb.o) dn++;
      if (mb.t && (!minuteT || mb.t > minuteT)) minuteT = mb.t;
    }
  }
  if (!n) return null;
  return {
    n, advPct: Math.round(adv / n * 100), vwapPct: nVw ? Math.round(vw / nVw * 100) : null,
    upMinPct: nMin ? Math.round(up / nMin * 100) : null, netMin: up - dn, minuteT,
  };
}

async function refresh(state, alpacaGet, ALPACA_DATA, ALPACA_CONN_DROP) {
  if (_inflight) return _inflight;
  const cur = state._internals;
  if (cur && Date.now() - (cur.ts || 0) < REFRESH_MS) return cur;
  _inflight = (async () => {
    try {
      let raw = null;
      for (const feed of ["sip", "iex"]) {
        const d = await alpacaGet(`/stocks/snapshots?symbols=${BASKET.join(",")}&feed=${feed}`, ALPACA_DATA);
        if (d === ALPACA_CONN_DROP) break;
        const m = d && (d.snapshots || d);                       // tolerate both response shapes
        if (m && typeof m === "object" && Object.keys(m).length >= 10) { raw = m; break; }
      }
      const s = raw ? summarize(raw) : null;
      if (!s) return state._internals || null;
      const day = _etDay();
      const prev = state._internals && state._internals.day === day ? state._internals : null;
      let cumTick = prev ? prev.cumTick : 0;
      const newMinute = s.minuteT && (!prev || s.minuteT !== prev.minuteT);
      if (newMinute) cumTick += s.netMin;                         // count each completed minute once
      state._internals = { ...s, cumTick, day, ts: Date.now() };
      return state._internals;
    } catch (_e) { return state._internals || null; }
  })().finally(() => { _inflight = null; });
  return _inflight;
}

function fields(state) {
  const x = state && state._internals;
  const fresh = x && x.day === _etDay() && Date.now() - (x.ts || 0) < 3 * 60000;   // stale/old-day -> blanks
  return {
    intN: fresh ? x.n : null, intAdvPct: fresh ? x.advPct : null, intVwapPct: fresh ? x.vwapPct : null,
    intUpMinPct: fresh ? x.upMinPct : null, intCumTick: fresh ? x.cumTick : null,
  };
}

module.exports = { BASKET, summarize, refresh, fields };
