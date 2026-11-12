// profitLock.js — 11/11 (Harrison): daily profit lock, SHADOW ONLY.
//
// The question: if APEX stopped for the day once it was up +$X, would it keep more money? This module only measures it.
// It places no orders and blocks nothing. Every 5-min Alpaca-truth refresh (server.js) it records the first time the day's
// total P&L (realized + unrealized vs the day-open equity) reaches each target, plus a giveback rule (armed once the day has
// been up PROFIT_LOCK_GIVEBACK_ARM, triggers when the total falls back to PROFIT_LOCK_GIVEBACK_FRAC of the day's peak).
//
// At the EOD email each rule is scored two ways against what actually happened:
//   flatten       = the day's total at the trigger (close everything then)
//   no new entries = the actual close minus the P&L of trades OPENED after the trigger (open positions run their own exits)
// A stopping rule cannot change the expectancy of the trades themselves; it only helps if the trades taken after a good
// start are worse than the rest. That is what the running totals here are for.
"use strict";
const C = require("./constants");

const CFG = {
  MODE:          C.PROFIT_LOCK_MODE || "shadow",
  TARGETS:       Array.isArray(C.PROFIT_LOCK_TARGETS) ? C.PROFIT_LOCK_TARGETS : [100, 150, 200],
  GIVEBACK_ARM:  C.PROFIT_LOCK_GIVEBACK_ARM != null ? C.PROFIT_LOCK_GIVEBACK_ARM : 100,
  GIVEBACK_FRAC: C.PROFIT_LOCK_GIVEBACK_FRAC != null ? C.PROFIT_LOCK_GIVEBACK_FRAC : 0.5,
  HIST_DAYS:     60,
};

const ET = "America/New_York";
const etDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: ET });
const etHMS = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: ET, hour12: false });
const etMin = (ms) => { const [h, m] = etHMS(ms).split(":").map(Number); return h * 60 + m; };
const money = (v) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(0)}`;

function ruleKeys() {
  return [...CFG.TARGETS.map(t => `+${t}`), `giveback ${Math.round(CFG.GIVEBACK_FRAC * 100)}% after +${CFG.GIVEBACK_ARM}`];
}

// Called with each Alpaca truth refresh. Returns the day's record.
function observe(state, truth, now = Date.now(), log) {
  if (!truth || !Number.isFinite(truth.totalPnL)) return null;
  // a missing/bad day-open baseline makes "total" the whole account; never let that read as a target hit
  if (Number.isFinite(truth.currentEquity) && truth.currentEquity > 0 && Math.abs(truth.totalPnL) > 0.25 * truth.currentEquity) return null;
  const m = etMin(now);
  if (m < 570 || m > 960) return null;                       // 9:30–16:00 ET only
  const day = etDay(now);
  let s = state._plock;
  if (!s || s.day !== day) s = state._plock = { day, peak: null, peakAt: null, last: null, hits: {} };
  const tot = truth.totalPnL, snap = { at: now, et: etHMS(now), tot: +tot.toFixed(2),
    real: Number.isFinite(truth.realizedPnL) ? +truth.realizedPnL.toFixed(2) : null,
    unreal: Number.isFinite(truth.unrealizedPnL) ? +truth.unrealizedPnL.toFixed(2) : null };
  if (s.peak == null || tot > s.peak) { s.peak = snap.tot; s.peakAt = snap.et; }
  s.last = snap;
  const keys = ruleKeys();
  CFG.TARGETS.forEach((t, i) => {
    if (!s.hits[keys[i]] && tot >= t) {
      s.hits[keys[i]] = snap;
      if (log) log("filter", `[PROFIT-LOCK] SHADOW: day reached ${money(tot)} (${keys[i]}) at ${snap.et} ET — a live lock would stop here. Nothing changed.`);
    }
  });
  const gk = keys[keys.length - 1];
  if (!s.hits[gk] && s.peak >= CFG.GIVEBACK_ARM && tot <= s.peak * CFG.GIVEBACK_FRAC) {
    s.hits[gk] = Object.assign({ peak: s.peak }, snap);
    if (log) log("filter", `[PROFIT-LOCK] SHADOW: day fell to ${money(tot)} from a ${money(s.peak)} peak (${gk}) at ${snap.et} ET — a live lock would stop here. Nothing changed.`);
  }
  return s;
}

// Minimal CSV line split (outcome rows quote fields that contain commas).
function splitCSV(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Every trade the day closed: options/straddle rows from the outcome buffer, shares from the stocks sleeve.
function dayTrades(day, outcomeRows, sip) {
  const trades = [];
  let H = null;
  try { H = require("./outcomes").OUTCOME_HEADER; if (typeof H === "string") H = H.split(","); } catch (_) { H = null; }
  if (H && Array.isArray(outcomeRows)) {
    const iD = H.indexOf("date"), iO = H.indexOf("openET"), iP = H.indexOf("pnl");
    for (const r of outcomeRows) {
      const f = typeof r === "string" ? splitCSV(r) : null;
      if (!f || f[iD] !== day) continue;
      const pnl = parseFloat(f[iP]);
      if (Number.isFinite(pnl) && /^\d\d:\d\d/.test(f[iO] || "")) trades.push({ openET: f[iO].slice(0, 8), pnl });
    }
  }
  if (sip && Array.isArray(sip.cands) && (!sip.day || sip.day === day)) {
    for (const c of sip.cands) {
      if (c.filledAt && Number.isFinite(c.pnl)) trades.push({ openET: etHMS(new Date(c.filledAt).getTime()), pnl: c.pnl, sip: true });
    }
  }
  return trades;
}

// Score today's rules against the close and add the day to the running history. Safe to call more than once a day.
function finalize(state, now = Date.now()) {
  const s = state._plock, day = etDay(now);
  if (!s || s.day !== day || !s.last) return null;
  const close = (state._alpacaTruth && Number.isFinite(state._alpacaTruth.totalPnL)) ? +state._alpacaTruth.totalPnL.toFixed(2) : s.last.tot;
  const trades = dayTrades(day, state._outcomeBuffer, state._sip);
  const rules = {};
  for (const k of ruleKeys()) {
    const h = s.hits[k];
    if (!h) { rules[k] = { hit: false }; continue; }
    const after = trades.filter(t => t.openET > h.et);
    const afterPnl = +after.reduce((a, t) => a + t.pnl, 0).toFixed(2);
    rules[k] = { hit: true, at: h.et, atTot: h.tot, afterN: after.length, afterPnl,
      flatten: h.tot, noNew: +(close - afterPnl).toFixed(2) };
  }
  const rec = { day, close, peak: s.peak, peakAt: s.peakAt, rules };
  const hist = state._plockHist || (state._plockHist = { days: [] });
  hist.days = hist.days.filter(d => d.day !== day);
  hist.days.push(rec);
  while (hist.days.length > CFG.HIST_DAYS) hist.days.shift();
  return { today: rec, totals: totals(hist) };
}

function totals(hist) {
  const days = (hist && hist.days) || [];
  return ruleKeys().map(k => {
    let hit = 0, actual = 0, flat = 0, noNew = 0;
    for (const d of days) {
      const r = d.rules && d.rules[k];
      actual += d.close;
      if (r && r.hit) { hit++; flat += r.flatten; noNew += r.noNew; } else { flat += d.close; noNew += d.close; }
    }
    return { rule: k, days: days.length, hit, actual: +actual.toFixed(2), flatten: +flat.toFixed(2), noNew: +noNew.toFixed(2) };
  });
}

function eodSection(pl) {
  if (!pl || !pl.today) return "";
  const t = pl.today, td = "padding:2px 10px;text-align:right";
  const rows = ruleKeys().map(k => {
    const r = t.rules[k] || {};
    if (!r.hit) return `<tr><td style="padding:2px 10px 2px 0">${k}</td><td style="${td}">not reached</td><td style="${td}">—</td><td style="${td}">—</td><td style="${td}">—</td></tr>`;
    return `<tr><td style="padding:2px 10px 2px 0">${k}</td><td style="${td}">${r.at} (${money(r.atTot)})</td><td style="${td}">${money(r.flatten)}</td><td style="${td}">${money(r.noNew)}</td><td style="${td}">${r.afterN} trades, ${money(r.afterPnl)}</td></tr>`;
  }).join("");
  const tot = (pl.totals || []).map(x => `<tr><td style="padding:2px 10px 2px 0">${x.rule}</td><td style="${td}">${x.hit}/${x.days}</td><td style="${td}">${money(x.actual)}</td><td style="${td}">${money(x.flatten)} (${money(x.flatten - x.actual)})</td><td style="${td}">${money(x.noNew)} (${money(x.noNew - x.actual)})</td></tr>`).join("");
  const f = "font-family:system-ui,sans-serif";
  return `<h3 style="${f};margin:18px 0 6px">Profit lock — shadow (nothing was stopped)</h3>` +
    `<div style="${f};font-size:12px;margin-bottom:4px">Today: close ${money(t.close)}, peak ${money(t.peak)} at ${t.peakAt} ET (5-min Alpaca truth).</div>` +
    `<table style="${f};font-size:12px;border-collapse:collapse"><tr style="color:#888"><td>rule</td><td style="${td}">triggered</td><td style="${td}">flatten there</td><td style="${td}">no new entries</td><td style="${td}">trades opened after</td></tr>${rows}</table>` +
    `<div style="${f};font-size:12px;margin:10px 0 4px">Running (days recorded):</div>` +
    `<table style="${f};font-size:12px;border-collapse:collapse"><tr style="color:#888"><td>rule</td><td style="${td}">days hit</td><td style="${td}">actual</td><td style="${td}">flatten (vs actual)</td><td style="${td}">no new entries (vs actual)</td></tr>${tot}</table>` +
    `<div style="${f};font-size:11px;color:#888;margin-top:4px">A stop rule only helps if the trades taken after a good start do worse than the rest; if the whole book loses, any rule that trades less looks better, so compare against the trades-opened-after column. Measurement only.</div>`;
}

module.exports = { CFG, observe, finalize, totals, eodSection, dayTrades, splitCSV, ruleKeys };
