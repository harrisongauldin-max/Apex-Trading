// holdShadow.js — 10/15 (Harrison): HOLD-TO-CLOSE SHADOW EXIT for intraday-trend. MEASUREMENT ONLY — no orders.
//
// The literature's intraday momentum edge comes from holding: Zarattini & Aziz (2024, "Beat the Market", SPY 2007-2024)
// exit on a VWAP-based trailing stop or at the close; Gao et al. (2018) and Baltussen et al. (2021) measure the move into
// the close. APEX's intraday-trend exits after 20 min if it hasn't moved and at 60 min regardless (APEX-data rules).
// For every LIVE intraday-trend entry this records what the literature's exit would have done with the SAME contract:
//   vTrail  exit at the first scan where price is on the wrong side of VWAP (call: below, put: above), else 15:55 ET
//   close   the move held to 15:55 ET regardless
// Option prices come from real Alpaca quotes for the same contract at those moments. The live result is joined from
// the outcomes rows by signalId in the EOD report. Rows reset with the day.
'use strict';

const { state, logEvent, markDirty } = require('./state');
const TS = require('./trendShadow');   // quote()

const CLOSE_ET = 15.917;   // 15:55
const _busy = new Set();

function _rows() { if (!Array.isArray(state._holdShadow)) state._holdShadow = []; return state._holdShadow; }

// called right after a live intraday-trend fill
function open(pos, uEntry) {
  try {
    if (!pos || !pos.contractSymbol || !(uEntry > 0)) return;
    const rows = _rows();
    if (rows.some(r => r.sym === pos.contractSymbol && Date.now() - r.at < 60000)) return;
    rows.push({ sig: pos.signalId || null, ticker: pos.ticker, side: pos.optionType, sym: pos.contractSymbol, at: Date.now(),
                uEntry: +(+uEntry).toFixed(2), prem: +pos.premium || null, contracts: pos.contracts || 1,
                vTrail: null, vTrailMin: null, vTrailOpt: null, fClose: null, closeOpt: null, done: false });
    while (rows.length > 100) rows.shift();
    markDirty();
  } catch (_) {}
}

async function _mark(r) { const q = await TS.quote(r.sym); return q ? q.mid : null; }

// every scan, per ticker: price + VWAP (0 = unknown), etH = ET hour as a decimal
async function step(ticker, price, vwap, etH) {
  if (!(price > 0)) return;
  for (const r of _rows()) {
    if (r.done || r.ticker !== ticker || _busy.has(r.sym + r.at)) continue;
    _busy.add(r.sym + r.at);
    try {
      const age = (Date.now() - r.at) / 60000;
      const fav = (r.side === 'put' ? -1 : 1) * (price - r.uEntry) / r.uEntry * 100;
      if (r.vTrail == null && vwap > 0 && vwap !== price && age >= 1 && (r.side === 'call' ? price < vwap : price > vwap)) {
        r.vTrail = +fav.toFixed(3); r.vTrailMin = Math.round(age); r.vTrailOpt = await _mark(r); markDirty();
        logEvent('scan', `[HOLD-SHADOW] ${ticker} ${r.side} ${r.sym} — VWAP-trail exit after ${r.vTrailMin} min: ${r.vTrail >= 0 ? '+' : ''}${r.vTrail}% underlying` +
          `${r.vTrailOpt != null && r.prem ? `, option $${r.prem} -> $${r.vTrailOpt}` : ''} [measure-only]`);
      }
      if (etH >= CLOSE_ET) {
        r.fClose = +fav.toFixed(3); r.closeOpt = await _mark(r);
        if (r.vTrail == null) { r.vTrail = r.fClose; r.vTrailMin = Math.round(age); r.vTrailOpt = r.closeOpt; }
        r.done = true; markDirty();
        logEvent('scan', `[HOLD-SHADOW] ${ticker} ${r.side} ${r.sym} — held to 3:55: ${r.fClose >= 0 ? '+' : ''}${r.fClose}% underlying` +
          `${r.closeOpt != null && r.prem ? `, option $${r.prem} -> $${r.closeOpt}` : ''} [measure-only]`);
      }
    } catch (_) {} finally { _busy.delete(r.sym + r.at); }
  }
}

const _pnl = (r, mid) => (mid != null && r.prem) ? Math.round((mid - r.prem) * 100 * (r.contracts || 1)) : null;

function _splitCsv(line) {   // RFC-4180-ish: quoted fields may contain commas and doubled quotes
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}

// live P&L by signalId from today's outcome rows (CSV strings)
function _livePnl(outcomeRows, header) {
  const out = {};
  try {
    const cols = header.split(','), iSig = cols.indexOf('signalId'), iPnl = cols.indexOf('pnl'), iWhy = cols.indexOf('exitReason');
    for (const line of outcomeRows || []) {
      const c = _splitCsv(String(line));
      if (c[iSig]) out[c[iSig]] = { pnl: +c[iPnl], why: c[iWhy] };
    }
  } catch (_) {}
  return out;
}

function csv(rows, outcomeRows, header) {
  const rs = (rows || []).filter(r => r.done);
  if (!rs.length) return null;
  const live = _livePnl(outcomeRows, header);
  const L = [['entryET', 'ticker', 'side', 'contract', 'signalId', 'uEntry', 'prem', 'contracts', 'livePnl', 'liveExit', 'vwapTrailFav', 'vwapTrailMin', 'vwapTrailOpt', 'vwapTrailPnl', 'closeFav', 'closeOpt', 'closePnl'].join(',')];
  for (const r of rs) {
    const lv = live[r.sig] || {};
    L.push([new Date(r.at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }), r.ticker, r.side, r.sym, r.sig || '', r.uEntry, r.prem ?? '', r.contracts,
            lv.pnl ?? '', lv.why ?? '', r.vTrail ?? '', r.vTrailMin ?? '', r.vTrailOpt ?? '', _pnl(r, r.vTrailOpt) ?? '', r.fClose ?? '', r.closeOpt ?? '', _pnl(r, r.closeOpt) ?? ''].join(','));
  }
  return L.join('\n');
}

function section(rows, outcomeRows, header) {
  const rs = (rows || []).filter(r => r.done);
  if (!rs.length) return '';
  const live = _livePnl(outcomeRows, header);
  const sum = (f) => { const v = rs.map(f).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const L = sum(r => (live[r.sig] || {}).pnl), V = sum(r => _pnl(r, r.vTrailOpt)), C = sum(r => _pnl(r, r.closeOpt));
  const f = (x) => x == null ? '—' : `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(0)}`;
  return `<h3 style="font-family:system-ui,sans-serif;margin:18px 0 6px">Intraday-trend: live exits vs holding (shadow)</h3>` +
    `<div style="font-family:system-ui,sans-serif;font-size:12px">${rs.length} trade(s) · live exits ${f(L)} · VWAP-trail exit ${f(V)} · held to 3:55 ${f(C)}</div>` +
    `<div style="font-family:system-ui,sans-serif;font-size:11px;color:#888;margin-top:4px">Same contracts, real quotes. VWAP-trail = out on the first cross of VWAP against the trade (Zarattini & Aziz 2024). Measurement only — nothing was traded.</div>`;
}

module.exports = { open, step, csv, section };
