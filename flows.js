// flows.js — 10/15 (Harrison): FLOW STATE. MEASUREMENT ONLY — nothing here gates or sizes a trade.
//
// The literature's intraday direction edges are mostly FORCED, PREDICTABLE FLOWS rather than indicators. This module
// records, every scan and per ticker, the inputs those papers use, so each one can be tested on APEX's own data
// before anything is allowed to trade on it (§0: published theory AND APEX's validated data).
//
//   rROD       return from the prior close to now (%). Baltussen, Da, Lammers & Martens (JFE 2021) use the return up to
//              30 min before the close to predict the last 30 min; Gao, Han, Li & Zhou (JFE 2018) the first half-hour.
//   hedgeFlow  which way dealer delta-hedging pushes: "with-move" when dealers are short gamma (negative net GEX — they
//              buy rallies and sell drops), "against-move" when long gamma. Baltussen et al.: intraday momentum is
//              concentrated on negative-gamma days and insignificant on positive-gamma days.
//   rebalDir   direction of end-of-day rebalancing demand from leveraged ETFs (and short-gamma hedgers): the same
//              direction as the day's move (Cheng & Madhavan 2009; Barbon et al., "Liquidity provision to leveraged
//              ETFs and equity options rebalancing flows"). Direction only — APEX has no LETF assets data for size.
//   pin*       the strike with the most open interest (calls + puts) in the nearest expiry, within ±2% of price, and
//              price's distance to it. Ni, Pearson & Poteshman (JFE 2005): prices cluster at heavy-OI strikes at expiry.
//   toME/fromMS/tom  trading days to the month's last trading day / since its first; tom = last trading day or first
//              three (McConnell & Xu 2008, turn-of-the-month; Etula, Rinne, Suominen & Vaittinen, RFS 2020, month-end
//              institutional cash needs). evt = the dayContext event tags (CPI / NFP / FOMC / OPEX / QOPEX).
'use strict';

const DAYCTX = require('./dayContext');

const _r = (x, d = 3) => (x == null || !isFinite(x)) ? null : +(+x).toFixed(d);
const _prevDay = (d) => new Date(Date.parse(d + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const _nextDay = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);

const _edgeCache = new Map();
function monthEdge(day) {
  if (_edgeCache.has(day)) return _edgeCache.get(day);
  const y = +day.slice(0, 4), m = +day.slice(5, 7);
  let first = `${y}-${String(m).padStart(2, '0')}-01`;
  let g = 0; while (!DAYCTX.isTradingDay(first) && g++ < 10) first = _nextDay(first);
  let last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  g = 0; while (!DAYCTX.isTradingDay(last) && g++ < 10) last = _prevDay(last);
  const toME = day >= last ? 0 : DAYCTX.tradingDaysBetween(day, last);
  const fromMS = day <= first ? 1 : DAYCTX.tradingDaysBetween(first, day) + 1;
  const out = { toME, fromMS, tom: toME === 0 || fromMS <= 3 };
  _edgeCache.set(day, out);
  return out;
}

// nearest-expiry max-OI strike within ±2% of price, from the gamma chain APEX already fetches (no extra API calls)
function pinFromChain(chain, price) {
  if (!chain || !(price > 0)) return null;
  const rows = [...((chain.call && chain.call.rows) || []), ...((chain.put && chain.put.rows) || [])];
  if (!rows.length) return null;
  const exps = [...new Set(rows.map(r => r.exp).filter(Boolean))].sort();
  const near = exps[0] || null;
  const byStrike = new Map();
  for (const r of rows) {
    if (near && r.exp !== near) continue;
    const k = +r.strike;
    if (!(k > 0) || Math.abs(k - price) / price > 0.02) continue;
    byStrike.set(k, (byStrike.get(k) || 0) + (+r.oi || 0));
  }
  let best = null, bestOI = 0;
  for (const [k, oi] of byStrike) if (oi > bestOI || (oi === bestOI && best != null && Math.abs(k - price) < Math.abs(best - price))) { best = k; bestOI = oi; }
  if (!(best > 0) || !(bestOI > 0)) return null;
  return { pinStrike: best, pinOI: bestOI, pinExp: near, distPinPct: _r((best - price) / price * 100) };
}

function compute(state, ticker, price, now = Date.now(), gex = null) {
  const day = DAYCTX.etDateStr(now);
  const ctx = (state._dayCtx || {})[ticker];
  const prevC = ctx && ctx.day === day ? ctx.prevClose : null;
  const rROD = (prevC > 0 && price > 0) ? (price - prevC) / prevC * 100 : null;
  const g = gex || (state._gexFresh || {})[ticker] || null;
  const regime = g && g.regime ? g.regime : null;
  const pin = pinFromChain((state._gexChain || {})[ticker], price);
  const me = monthEdge(day);
  let evt = ''; try { evt = DAYCTX.eventTags(day) || ''; } catch (_) {}
  const f = {
    at: now, day, rROD: _r(rROD),
    gexRegime: regime, netGexM: g ? g.netGexM : null,
    hedgeFlow: regime && rROD != null ? (regime === 'neg' ? 'with-move' : 'against-move') : null,
    rebalDir: rROD == null ? null : rROD > 0.02 ? 'buy' : rROD < -0.02 ? 'sell' : 'flat',
    pinStrike: pin ? pin.pinStrike : null, pinOI: pin ? pin.pinOI : null, pinExp: pin ? pin.pinExp : null, distPinPct: pin ? pin.distPinPct : null,
    toME: me.toME, fromMS: me.fromMS, tom: me.tom, evt,
  };
  if (!state._flowNow) state._flowNow = {};
  state._flowNow[ticker] = f;
  return f;
}

// compact copy stamped onto a position at entry (outcomes) and onto blocked-signal rows
function snapshot(state, ticker) {
  const f = (state._flowNow || {})[ticker];
  if (!f) return null;
  return { rROD: f.rROD, hedgeFlow: f.hedgeFlow, rebalDir: f.rebalDir, distPinPct: f.distPinPct, pinStrike: f.pinStrike, toME: f.toME, tom: f.tom };
}

module.exports = { compute, snapshot, monthEdge, pinFromChain };
