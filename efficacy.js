// ============================================================
// APEX EFFICACY REPORT  (8/05)
// The "measure -> recommend" half of the feedback loop. Reads the outcome-joined
// (X,y) rows from outcomes.js (trailing N sessions) and reports WHICH INPUTS
// ACTUALLY PREDICTED — turning "the score correlates -0.11 with outcomes" from a
// thing you hand-measured into a standing daily readout.
//
// DISCIPLINE (APEX's own): samples are tiny (25 puts, 5 biweekly). So every stat
// carries its N, and any bucket under MIN_N is flagged "insufficient" rather than
// reported as a rate. This MEASURES; it does not tune. The human still decides,
// and the reversible flag/constant architecture is still the actuator.
//
// Pure + dependency-free: parses CSV rows (respecting quotes) into records and
// renders a compact text/HTML report. No Redis, no fetch — the caller supplies
// rows (state.fetchRecentOutcomeRows) so this stays trivially testable.
// ============================================================
'use strict';

const MIN_N = 8;   // below this, a bucket is labelled insufficient, not rated

// ── CSV line parse (respects quoted fields, "" escaping) ─────────────────────
function _parseLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// header (comma string) + rows (array of comma strings) -> array of record objects
function parseRows(header, rows) {
  const cols = _parseLine(String(header || ""));
  const recs = [];
  for (const r of (rows || [])) {
    const v = _parseLine(String(r));
    if (v.length < 2) continue;
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = v[i];
    recs.push(o);
  }
  return recs;
}

// ── small stats ──────────────────────────────────────────────────────────────
const _num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const _mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const _median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function _pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = _mean(xs), my = _mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
const _pct = (num, den) => den > 0 ? (num / den * 100) : null;
const _fx = (v, d = 1) => (v == null || !isFinite(v)) ? "  -  " : v.toFixed(d);
const _pad = (s, w) => { s = String(s); return s.length >= w ? s : s + " ".repeat(w - s.length); };
const _padL = (s, w) => { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; };

// bucket-level outcome stats over a set of records
function _stats(recs) {
  const n = recs.length;
  const won = recs.filter(r => String(r.won) === "1").length;
  const r5  = recs.filter(r => String(r.rung5) === "1").length;
  const r125 = recs.filter(r => String(r.rung125) === "1").length;
  const pnls  = recs.map(r => _num(r.pnl)).filter(x => x != null);
  const peaks = recs.map(r => _num(r.peakPct)).filter(x => x != null);
  const maes  = recs.map(r => _num(r.maePct)).filter(x => x != null);
  const mins  = recs.map(r => _num(r.minHeld)).filter(x => x != null);
  return {
    n, winPct: _pct(won, n), r5Pct: _pct(r5, n), r125Pct: _pct(r125, n),
    avgPnl: _mean(pnls), sumPnl: pnls.reduce((s, x) => s + x, 0),
    avgPeak: _mean(peaks), avgMae: _mean(maes), medMin: _median(mins),
  };
}

function _statLine(label, s, labelW = 22) {
  const thin = s.n < MIN_N ? "  ⚠ insufficient" : "";
  return `${_pad(label, labelW)} n=${_padL(s.n, 3)}  win ${_padL(_fx(s.winPct, 0), 3)}%  ` +
         `rung5 ${_padL(_fx(s.r5Pct, 0), 3)}%  rung12.5 ${_padL(_fx(s.r125Pct, 0), 3)}%  ` +
         `avgP&L $${_padL(_fx(s.avgPnl, 0), 5)}  peak ${_padL(_fx(s.avgPeak, 1), 5)}%  MAE ${_padL(_fx(s.avgMae, 1), 6)}%${thin}`;
}

// ── the report ────────────────────────────────────────────────────────────────
// Numeric entry features (X) to rank by predictive correlation with `won`.
const FEATURES = [
  ["score", "score"], ["eRangePct", "intraday-range%"], ["eVwapDist", "vwap-dist%"], ["eADX", "ADX"], ["eBreadthMom", "breadth-mom"],
  ["eBreadth", "breadth"], ["eIVP", "IV-pct"], ["eRSI", "intraday-RSI"], ["eDRSI", "daily-RSI"],
  ["eVIX", "VIX"], ["eIV", "IV"], ["delta", "delta"], ["eRelStr", "rel-str"], ["ivr", "IVR"],
  ["eBuActive", "breakout-active"],
  // 8/24: the two signals that actually matter, finally in the ranking. feasRatio has been recorded
  // all along (full history immediately); eVolPace is new (N grows from deploy forward — small at first).
  ["eVolPace", "volPace"], ["feasRatio", "feasibility"],
];

function buildEfficacyReport(records, opts = {}) {
  const recs = Array.isArray(records) ? records : [];
  const days = opts.days != null ? opts.days : "?";
  const L = [];
  const push = (s) => L.push(s);

  push(`APEX EFFICACY REPORT — trailing ${days} session(s), ${recs.length} closed trade(s)`);
  push(`(measures which inputs predicted; N shown on every stat; buckets under ${MIN_N} flagged. This does not tune — you decide.)`);
  push("");

  if (recs.length === 0) {
    push("No closed-trade outcome rows yet. The table fills as positions close; check back after a session.");
    const text = L.join("\n");
    return { text, html: _html(text), json: { n: 0 } };
  }

  const overall = _stats(recs);

  // 1) OVERVIEW
  push("── OVERVIEW ──────────────────────────────────────────────");
  push(_statLine("ALL TRADES", overall));
  push(`  total P&L $${_fx(overall.sumPnl, 0)}   median hold ${_fx(overall.medMin, 0)} min`);
  push("");

  // 2) CALLS vs PUTS — is the call side catching the put side?
  push("── SIDE: calls vs puts (is the breakout-mirror working?) ──");
  const calls = recs.filter(r => r.side === "call");
  const puts  = recs.filter(r => r.side === "put");
  push(_statLine("calls", _stats(calls)));
  push(_statLine("puts",  _stats(puts)));
  push("");

  // 3) BREAKOUT STRUCTURE EFFICACY (calls) — the direct test of the new channel
  push("── CALL BREAKOUT STRUCTURE (eBuActive at entry) ──────────");
  const buYes = calls.filter(r => String(r.eBuActive) === "1");
  const buNo  = calls.filter(r => String(r.eBuActive) !== "1");
  push(_statLine("calls WITH breakout", _stats(buYes)));
  push(_statLine("calls WITHOUT",       _stats(buNo)));
  {
    const a = _stats(buYes), b = _stats(buNo);
    if (a.n >= MIN_N && b.n >= MIN_N && a.r125Pct != null && b.r125Pct != null) {
      const lift = a.r125Pct - b.r125Pct;
      push(`  → breakout-structure calls reach +12.5% ${lift >= 0 ? "+" : ""}${_fx(lift, 0)}pts ${lift >= 0 ? "MORE" : "LESS"} often (rung12.5). Watch this as the channel's verdict.`);
    } else {
      push(`  → not enough closed calls on each side yet to judge the channel (need ${MIN_N}+ each).`);
    }
  }
  push("");

  // 4) SCORE BUCKETS — does the score actually rank outcomes?
  push("── SCORE BUCKETS (does the score rank? the -0.11 question) ─");
  const edges = [[0, 70], [70, 75], [75, 80], [80, 85], [85, 101]];
  for (const [lo, hi] of edges) {
    const b = recs.filter(r => { const s = _num(r.score); return s != null && s >= lo && s < hi; });
    if (b.length) push(_statLine(`score ${lo}-${hi === 101 ? "100" : hi}`, _stats(b)));
  }
  {
    const xs = [], ys = [];
    for (const r of recs) { const s = _num(r.score); if (s != null) { xs.push(s); ys.push(String(r.won) === "1" ? 1 : 0); } }
    const rr = _pearson(xs, ys);
    push(`  score↔win correlation: ${rr == null ? "n/a" : _fx(rr, 2)} (n=${xs.length}). Near 0 ⇒ score does not rank; |r|>~0.2 on a real N ⇒ it carries signal.`);
  }
  push("");

  // 5) FEATURE SIGNAL RANKING — which inputs move the needle
  push("── FEATURE SIGNAL RANKING (correlation with win) ─────────");
  const ranked = [];
  for (const [key, label] of FEATURES) {
    const xs = [], ys = [];
    for (const r of recs) { const x = _num(r[key]); if (x != null) { xs.push(x); ys.push(String(r.won) === "1" ? 1 : 0); } }
    const rr = _pearson(xs, ys);
    if (rr != null) ranked.push({ label, r: rr, n: xs.length });
  }
  ranked.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  if (ranked.length === 0) push("  (no numeric feature had enough variation to correlate yet)");
  for (const f of ranked) {
    const dir = f.r >= 0 ? "higher→win" : "lower→win";
    const thin = f.n < MIN_N ? " ⚠" : "";
    push(`  ${_pad(f.label, 16)} r=${_padL(_fx(f.r, 2), 5)}  (${dir}, n=${f.n})${thin}`);
  }
  push("");

  // 6) EXIT REASONS — which exits bleed / cut winners
  push("── EXIT REASONS (which exits leave money on the table) ────");
  const byReason = new Map();
  for (const r of recs) { const k = r.exitReason || "?"; if (!byReason.has(k)) byReason.set(k, []); byReason.get(k).push(r); }
  const reasons = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [reason, rs] of reasons) {
    const s = _stats(rs);
    push(`  ${_pad(reason, 16)} n=${_padL(s.n, 3)}  avgP&L $${_padL(_fx(s.avgPnl, 0), 5)}  ` +
         `avgPeak ${_padL(_fx(s.avgPeak, 1), 5)}%  medHold ${_padL(_fx(s.medMin, 0), 4)}min`);
  }
  push("");
  push("Read: a reason with a healthy avgPeak but poor avgP&L is cutting winners; a large-N reason with deep MAE is a late stop.");

  const text = L.join("\n");
  return { text, html: _html(text), json: { n: recs.length, overall, features: ranked } };
}

function _esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function _html(text) {
  return `<div style="margin-top:16px"><h3 style="color:#00c4ff;font-size:12px;margin:0 0 6px">EFFICACY REPORT</h3>` +
         `<pre style="font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#cbd5e1;background:#0b0f17;` +
         `padding:10px;border-radius:6px;overflow-x:auto;white-space:pre">${_esc(text)}</pre></div>`;
}

module.exports = { buildEfficacyReport, parseRows, MIN_N };
