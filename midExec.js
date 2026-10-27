// midExec.js — 10/27 (Harrison): EXECUTION AT THE MID.
//
// WHY: 10/20-10/23 live intraday-trend = 73 trades, -$555 realized, while the estimated bid/ask paid was ~$608.
// The signals are ~breakeven before costs; the spread is the loss. Entries crossed at the ask (then paid up),
// exits hit the bid. Muravyev & Pearson (2020, RFS "Options Trading Costs Are Lower than You Think") show
// effective option spreads are materially below quoted spreads for traders who work orders / time them.
// This module changes HOW orders are priced, never WHETHER or WHEN APEX trades.
//
// ENTRY (buy):  10/27 correction — OFF by default (EXEC_MID_ENTRIES=false): entries cross at ask -> pay-up as
//               before. Resting buys on a breakout are adversely selected (fill only when the ask falls to them).
//               If turned on: mid -> halfway -> ask -> pay-up.
// EXIT  (sell): ONLY for non-urgent sleeve exits (profit-lock, no-arm cut, max-hold, take-profit):
//               mid -> halfway to bid, then the existing limit-at-bid path runs exactly as before.
//               Stops, flatten, orphan/forced closes and everything else sell at the bid immediately.
//
// Kill switch: constants.EXEC_MID_ENABLED = false restores the old ladders byte-for-byte.
// NOTE: Alpaca PAPER fills are simulated off the NBBO; a resting mid order only fills there if the quote moves
// through it. So paper will UNDER-state mid fills relative to a real market. Read [EXEC] lines as a floor.
"use strict";

let ENABLED = true, ENTRIES = false;
try { const C = require("./constants"); if (C.EXEC_MID_ENABLED === false) ENABLED = false; ENTRIES = C.EXEC_MID_ENTRIES === true; } catch (_) {}

// timings are mutable so tests can shrink them
const cfg = {
  entryTimeoutsMs: [10000, 5000, 5000, 8000],   // mid, half, ask, pay-up
  exitTimeoutsMs:  [6000, 4000],                // mid, half (then the existing 20s bid order)
  maxQuoteAgeMs:   60000,                       // exit quote must be this fresh to work it passively
  pollMs:          1000,
  cancelSettleMs:  500,
};

// Exit reasons that are NOT urgent: the trade is being closed at a profit rung or by a clock, not because it is
// running against us. Anything not listed here keeps the original sell-at-bid behavior.
const PASSIVE_EXIT_REASONS = new Set([
  "itrend-lock", "itrend-noarm", "itrend-maxhold",
  "mr-fade-lock", "mr-fade-tp", "mr-fade-maxhold",
]);

const r2 = (x) => Math.round(x * 100) / 100;
// passive rungs round in OUR favor: a buy never rounds up toward the ask, a sell never rounds down toward the bid
const dn = (x) => Math.floor(x * 100 + 1e-6) / 100;
const up = (x) => Math.ceil(x * 100 - 1e-6) / 100;

function _dedupe(steps) {
  const out = [];
  for (const s of steps) if (!out.length || Math.abs(out[out.length - 1].price - s.price) >= 0.005) out.push(s);
  return out;
}

// Buy ladder. Returns [{price, timeoutMs, label}]. With the flag off (or no usable bid) it is the old [ask, payUp].
function entrySteps(bid, ask, enabled = ENABLED && ENTRIES) {   // 10/27: entries cross unless EXEC_MID_ENTRIES
  const a = r2(ask);
  const payUp = r2(Math.min(a * 1.02, a + 0.15));
  const T = cfg.entryTimeoutsMs;
  if (!enabled || !(bid > 0) || !(ask > bid)) {
    return [{ price: a, timeoutMs: 6000, label: "ask" }, { price: payUp, timeoutMs: 8000, label: "payup" }];
  }
  const m = dn((bid + ask) / 2);
  const half = dn(m + (a - m) / 2);
  return _dedupe([
    { price: m,     timeoutMs: T[0], label: "mid" },
    { price: half,  timeoutMs: T[1], label: "half" },
    { price: a,     timeoutMs: T[2], label: "ask" },
    { price: payUp, timeoutMs: T[3], label: "payup" },
  ]);
}

// Passive sell rungs that run BEFORE the existing sell-at-bid order. [] = skip straight to the old path.
function exitSteps(reason, bid, ask, bidAt, now = Date.now(), enabled = ENABLED) {
  if (!enabled || !PASSIVE_EXIT_REASONS.has(reason)) return [];
  if (!(bid > 0) || !(ask > bid)) return [];
  if (!(bidAt > 0) || now - bidAt > cfg.maxQuoteAgeMs) return [];   // stale quote: don't guess a mid
  const m = up((bid + ask) / 2);
  const half = up(m - (m - bid) / 2);
  const steps = _dedupe([
    { price: m,    timeoutMs: cfg.exitTimeoutsMs[0], label: "mid" },
    { price: half, timeoutMs: cfg.exitTimeoutsMs[1], label: "half" },
  ]);
  return steps.filter(s => s.price > r2(bid));   // a rung at the bid is just the old order
}

// One-line execution record, the same shape for entries and exits:
// [EXEC] SPY BUY SPY261030C00690000 bid 4.10 ask 4.16 mid 4.13 -> fill 4.13 on rung 1/4 (mid) | saved $0.03/contract vs ask
function execLine(side, ticker, sym, bid, ask, fill, rungIdx, rungs, label) {
  const m = bid > 0 && ask > 0 ? r2((bid + ask) / 2) : null;
  const far = side === "BUY" ? ask : bid;
  const saved = far > 0 && fill > 0 ? (side === "BUY" ? far - fill : fill - far) : null;
  return `[EXEC] ${ticker} ${side} ${sym} bid ${bid > 0 ? bid.toFixed(2) : "-"} ask ${ask > 0 ? ask.toFixed(2) : "-"} mid ${m != null ? m.toFixed(2) : "-"}`
       + ` -> fill ${fill > 0 ? fill.toFixed(2) : "-"} on rung ${rungIdx + 1}/${rungs} (${label})`
       + (saved != null ? ` | ${saved >= 0 ? "saved" : "paid"} $${Math.abs(saved).toFixed(2)}/contract vs ${side === "BUY" ? "ask" : "bid"}` : "");
}

module.exports = { cfg, entrySteps, exitSteps, execLine, PASSIVE_EXIT_REASONS, get enabled() { return ENABLED; }, get entries() { return ENTRIES; } };
