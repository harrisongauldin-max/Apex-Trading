// stocksInPlay.js — 11/02 (Harrison): STOCKS-IN-PLAY OPENING-RANGE BREAKOUT, SHARES, ITS OWN SLEEVE.
//
// Literature: Zarattini, Barbon & Aziz (2024), "A Profitable Day Trading Strategy for the U.S. Equity Market"
// (Swiss Finance Institute RP 24-98). Rules taken as published, nothing fitted:
//   universe   US common stocks; open > $5, 14-day avg volume >= 1M shares, 14-day ATR > $0.50
//   in play    RVol = 9:30-9:35 volume / its 14-day average; keep RVol >= 100%; trade the TOP 20 by RVol
//   entry      first 5-minute candle sets direction (up = long, down = short, doji = no trade);
//              stop order at that candle's high (long) / low (short)
//   stop       10% of the 14-day ATR from the executed entry price
//   exit       the close (APEX: 2 minutes before the session close)
//   sizing     each position risks 1% of the capital allocated to it (sleeve / 20); leverage capped at 4x
// Paper's Table 2 (2016-2023): Sharpe 2.81 with the RVol filter, 0.48 without. Commission only — NO slippage modeled.
// APEX data: none yet. The panel (11/02) recommended a shadow test first; Harrison chose LIVE ON PAPER.
// This module measures what the paper does not: every trade is also simulated at the paper's ideal prices from
// 1-minute bars, so the EOD report shows actual R vs ideal R (= the slippage the paper left out), and shorts the
// account cannot borrow are simulated rather than silently dropped.
//
// Isolation from the options book:
//   - positions live in state._sip, never in state.positions (the reconciler, exit engine and 3:45 flatten never see them)
//   - every order carries client_order_id "sip-<day>-..." (startup open-order cancel skips them)
//   - syncCashFromAlpaca adds back cashAdjustment(): share purchases / short proceeds don't move the options sizing cash
//   - options loss locks don't include this sleeve (they run on options realized P&L); the broker circuit does pause it
// Kill switch: constants.SIP_ENABLED = false. Shadow (log-only): SIP_MODE = "shadow" (or env SIP_MODE=shadow).
"use strict";

const C = (() => { try { return require("./constants"); } catch (_) { return {}; } })();

const CFG = {
  ENABLED:        C.SIP_ENABLED !== false,
  MODE:           String(process.env.SIP_MODE || C.SIP_MODE || "live").toLowerCase() === "shadow" ? "shadow" : "live",
  SLEEVE_USD:     C.SIP_SLEEVE_USD > 0 ? C.SIP_SLEEVE_USD : 25000,   // the paper's starting capital
  TOP_N:          20,
  RISK_PCT:       0.01,
  LEVERAGE:       4,
  ATR_STOP:       0.10,
  RVOL_MIN:       1.0,
  MIN_PRICE:      5,
  MIN_AVG_VOL:    1e6,
  MIN_ATR:        0.5,
  LOOKBACK:       14,
  OPT_BP_RESERVE: C.SIP_OPT_BP_RESERVE > 0 ? C.SIP_OPT_BP_RESERVE : 15000,   // options buying power the sleeve must leave free
  BUILD_FROM_MIN: 9 * 60 + 0,     // 9:00 ET: universe build
  SCAN_FROM_MIN:  9 * 60 + 35.17, // 9:35:10 ET: first 5-minute bar is complete
  SCAN_LAST_MIN:  9 * 60 + 40,    // later than this the opening-range entry is not the paper's trade: skip the day
  EXIT_BEFORE_CLOSE_MIN: 2,
  PARTIAL_WAIT_MS: 30000,
  // 11/03 (Harrison, from the day-1 exit replay): profit lock + trail, safety net, stop sent WITH the entry
  EXIT_MODE:      C.SIP_EXIT_MODE === "hold" ? "hold" : "lock_trail",   // "hold" = the paper (stop, else the close)
  LOCK_AT_R:      Number.isFinite(C.SIP_LOCK_AT_R) ? C.SIP_LOCK_AT_R : 1,          // at +1R ...
  LOCK_FLOOR_R:   Number.isFinite(C.SIP_LOCK_FLOOR_R) ? C.SIP_LOCK_FLOOR_R : -0.5, // ... the stop moves to -0.5R
  TRAIL_FROM_R:   Number.isFinite(C.SIP_TRAIL_FROM_R) ? C.SIP_TRAIL_FROM_R : 2,    // from +2R ...
  TRAIL_R:        Number.isFinite(C.SIP_TRAIL_R) ? C.SIP_TRAIL_R : 1,              // ... it trails 1R behind the best price
  HARD_CAP_R:     Number.isFinite(C.SIP_HARD_CAP_R) ? C.SIP_HARD_CAP_R : 2,        // down 2R from the fill = stop failed: market out
  USE_OTO:        C.SIP_USE_OTO !== false,      // entry + stop as one order (the stop rests the instant the entry fills)
  // 11/04: R is measured from the ACTUAL FILL (day 2: level-based stops sat 2-3R below real fills — PCOR -3.3R, GXO -3.7R,
  // and YOU showed "+4.7R locked" while it was ~breakeven on the shares held). "level" keeps the old behaviour.
  STOP_BASE:      C.SIP_STOP_BASE === "level" ? "level" : "fill",
  // replay execution costs, as a fraction of the 14-day ATR, measured from day 2's live fills (11/04): entry stop-market
  // fills ~0.15 ATR past the level; stop exits ~0.10 ATR past the stop; the 2:58 market close ~0.02 ATR.
  COST_ENTRY_ATR: Number.isFinite(C.SIP_COST_ENTRY_ATR) ? C.SIP_COST_ENTRY_ATR : 0.15,
  COST_EXIT_ATR:  Number.isFinite(C.SIP_COST_EXIT_ATR) ? C.SIP_COST_EXIT_ATR : 0.10,
  COST_CLOSE_ATR: Number.isFinite(C.SIP_COST_CLOSE_ATR) ? C.SIP_COST_CLOSE_ATR : 0.02,
  MAX_LATE_R:     2,                            // already-through entries: market only if within 2R of the level
  BATCH:          100,
  CONCURRENCY:    6,
};
const EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "ARCA", "BATS"]);
// approximate "common stock" screen (Alpaca assets carry no security-type flag): drop funds, ETFs/ETNs, trusts, SPACs
const NON_COMMON_RE = /\b(ETF|ETN|Fund|Trust|iShares|SPDR|ProShares|Direxion|Invesco|Vanguard|WisdomTree|VanEck|GraniteShares|Leveraged|Inverse|2X|3X|-1X|Bull|Bear|Acquisition Corp|Units?|Warrants?|Rights?|Notes? due|Preferred|Depositary Shares)\b/i;

// ───────────────────────── time (America/New_York) ─────────────────────────
const _fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23" });
function etParts(ms = Date.now()) {
  const p = {}; for (const x of _fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, min: (+p.hour) * 60 + (+p.minute) + (+p.second) / 60,
           dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
function etToUtcMs(day, hh, mm) {
  const [y, m, d] = day.split("-").map(Number);
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, hh + off, mm);
    const p = etParts(ms);
    if (p.day === day && Math.abs(p.min - (hh * 60 + mm)) < 1e-6) return ms;
  }
  return Date.UTC(y, m - 1, d, hh + 5, mm);
}
const iso = (ms) => new Date(ms).toISOString();
const hhmm = (min) => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, "0")}`;
const cents = (x) => Math.round(x * 100) / 100;
const floorC = (x) => Math.floor(x * 100 + 1e-6) / 100;
const ceilC = (x) => Math.ceil(x * 100 - 1e-6) / 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── broker IO (own fetch: long timeouts, never trips the options circuit) ─────────────────────────
let _io = null;
function defaultIO() {
  const fetch = require("node-fetch");
  const https = require("https");
  const agent = new https.Agent({ keepAlive: false });
  const { alpacaHeaders } = require("./broker");
  async function req(url, opts = {}, timeoutMs = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { agent, headers: alpacaHeaders(), signal: ctl.signal, ...opts });
      const txt = await r.text();
      let body = null;
      try { body = txt ? JSON.parse(txt) : null; } catch (_) { body = { raw: txt }; }
      return { status: r.status, body };
    } finally { clearTimeout(t); }
  }
  const json = (method, body) => ({ method, body: JSON.stringify(body) });
  return {
    data:  (p) => req(C.ALPACA_DATA + p),
    trade: (p) => req(C.ALPACA_BASE + p),
    post:  (p, b) => req(C.ALPACA_BASE + p, json("POST", b), 10000),
    patch: (p, b) => req(C.ALPACA_BASE + p, json("PATCH", b), 10000),
    del:   (p) => req(C.ALPACA_BASE + p, { method: "DELETE" }, 10000),
  };
}
function io() { return _io || (_io = defaultIO()); }
function setIO(x) { _io = x; }

async function getJSON(fn, path, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fn(path);
      if (r && r.status >= 200 && r.status < 300) return r.body;
      last = `HTTP ${r && r.status}`;
      if (r && r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e && e.message; }
    await sleep(800 * (i + 1));
  }
  throw new Error(`${path.split("?")[0]} failed: ${last}`);
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// multi-symbol bars, all pages -> { SYM: [bars ascending] }
async function multiBars(symbols, timeframe, startISO, endISO) {
  const out = {};
  await pool(chunk(symbols, CFG.BATCH), CFG.CONCURRENCY, async (syms) => {
    let token = null, guard = 0;
    do {
      const q = `/stocks/bars?symbols=${syms.join(",")}&timeframe=${timeframe}&start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`
              + `&limit=10000&adjustment=split&feed=sip${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
      const body = await getJSON(io().data, q);
      for (const [s, arr] of Object.entries((body && body.bars) || {})) (out[s] = out[s] || []).push(...arr);
      token = body && body.next_page_token;
    } while (token && ++guard < 50);
  });
  for (const s of Object.keys(out)) out[s].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return out;
}

// ───────────────────────── pure rules (unit-tested) ─────────────────────────
// daily bars ascending (prior days only) -> { atr, avgVol, prevClose } over the last LOOKBACK days, or null
function dailyStats(bars, n = CFG.LOOKBACK) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const b = bars.slice(-(n + 1));
  let tr = 0, vol = 0;
  for (let i = 1; i < b.length; i++) {
    const h = +b[i].h, l = +b[i].l, pc = +b[i - 1].c;
    tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    vol += +b[i].v;
  }
  return { atr: tr / n, avgVol: vol / n, prevClose: +b[b.length - 1].c };
}
// size per the paper: risk 1% of the per-position allocation, notional capped at 4x that allocation
function sizePosition(entry, stopDist, cfg = CFG) {
  const alloc = cfg.SLEEVE_USD / cfg.TOP_N;
  if (!(entry > 0) || !(stopDist > 0)) return 0;
  return Math.max(0, Math.floor(Math.min((cfg.RISK_PCT * alloc) / stopDist, (cfg.LEVERAGE * alloc) / entry)));
}
// universe stats + today's first 5-minute bars -> ranked candidates (top N, dojis kept and marked, so they are counted)
function selectCandidates(universe, firstBars, cfg = CFG) {
  const rows = [];
  for (const [sym, u] of Object.entries(universe)) {
    const b = firstBars[sym];
    if (!b || !(u.ovAvg > 0)) continue;
    const o = +b.o, h = +b.h, l = +b.l, c = +b.c, v = +b.v;
    if (!(o > cfg.MIN_PRICE)) continue;
    const rvol = v / u.ovAvg;
    if (!(rvol >= cfg.RVOL_MIN)) continue;
    rows.push({ sym, rvol, o, h, l, c, v, atr: u.atr, avgVol: u.avgVol, etb: !!u.etb, shortable: !!u.shortable });
  }
  rows.sort((a, b) => b.rvol - a.rvol);
  return rows.slice(0, cfg.TOP_N).map((r, i) => {
    const side = r.c > r.o ? "long" : r.c < r.o ? "short" : "doji";
    const entry = side === "long" ? cents(r.h) : side === "short" ? cents(r.l) : null;
    const stopDist = cfg.ATR_STOP * r.atr;
    return { rank: i + 1, ...r, rvol: +r.rvol.toFixed(2), side, entry, stopDist: +stopDist.toFixed(4),
             qty: entry ? sizePosition(entry, stopDist, cfg) : 0, status: side === "doji" ? "doji" : "planned" };
  });
}
// the paper's trade replayed on 1-minute bars (ascending, from 9:35, ending before the exit minute)
// Entry bar: the path inside a bar is unknown, so use the standard OHLC convention — an up bar (c >= o) runs
// O-L-H-C, a down bar O-H-L-C. A long entered on an up bar has only H->C left (stopped iff c <= stop); on a down
// bar the low comes after the entry (stopped iff l <= stop). Mirror for shorts. After the entry bar, any touch stops.
function simulate(cand, bars) {
  if (!cand || !cand.entry || cand.side === "doji" || !Array.isArray(bars) || !bars.length) return null;
  const L = cand.side === "long", sd = cand.stopDist;
  let entryPx = null, stopPx = null;
  for (const b of bars) {
    const o = +b.o, h = +b.h, l = +b.l;
    if (entryPx == null) {
      if (L ? h >= cand.entry : l <= cand.entry) {
        entryPx = L ? Math.max(cand.entry, o) : Math.min(cand.entry, o);
        stopPx = L ? entryPx - sd : entryPx + sd;
        const c = +b.c, up = c >= o, gapIn = L ? o >= cand.entry : o <= cand.entry;
        // after the entry the bar still travels: long on an up bar H->C, long on a down bar H->L->C; short mirrored.
        // Entered AT THE OPEN (gapped through the level): the whole bar comes after the entry.
        const after = gapIn ? (L ? l : h) : L ? (up ? c : l) : (up ? h : c);
        if (L ? after <= stopPx : after >= stopPx) return { entered: true, entryPx, stopPx, exitPx: stopPx, reason: "stop (entry bar)", R: -1, at: b.t };
      }
      continue;
    }
    if (L ? l <= stopPx : h >= stopPx) {
      const exitPx = L ? Math.min(stopPx, o) : Math.max(stopPx, o);
      return { entered: true, entryPx, stopPx, exitPx, reason: "stop", R: +(((L ? exitPx - entryPx : entryPx - exitPx) / sd)).toFixed(3), at: b.t };
    }
  }
  if (entryPx == null) return { entered: false, reason: "not triggered", R: 0 };
  const exitPx = +bars[bars.length - 1].c;
  return { entered: true, entryPx, stopPx, exitPx, reason: "close", R: +(((L ? exitPx - entryPx : entryPx - exitPx) / sd)).toFixed(3) };
}

// ───────────────────────── exit variants (11/03, Harrison: "use today's trades as the basis") ─────────────────────────
// Same entry for every variant (the paper's: the first 5-min high/low, touched on 1-minute bars from 9:35).
// Only the EXIT changes. Each variant sizes its own shares so a full stop = 1R ($12.50 at the default sleeve) — a wider
// stop means fewer shares, never more dollar risk — capped at 4x the per-position allocation like the paper.
//   paper      stop 10% of the 14-day ATR, hold to the close            Zarattini, Barbon & Aziz (2024)
//   or         stop on the other side of the opening range, hold         Zarattini & Aziz (2023) opening-range rule
//   atr1       stop 1 x ATR, hold                                         wide-stop benchmark
//   or_be      OR stop; at +1R stop to breakeven; from +2R trail 1R behind the best price   Kaminski & Lo (2014): stops help in trends
//   or_apex    OR stop + APEX's options lock ladder translated to R (options stop 30% of premium = 1R)   APEX data: lock exits +$3,813 since 9/01
//   paper_be   paper stop + breakeven at 1R + 1R trail from 2R  (11/03: added after the first replay — tight stop, locked profits)
//   paper_be2  paper stop + breakeven at 2R + 2R trail from 4R  (looser version of the same, less noise-sensitive)
// Gross of slippage (ideal fills at stop/floor levels). Intrabar order: the exit check uses the peak from EARLIER bars,
// then the bar's own high/low extends the peak (an exit and a new high in one bar is scored as the exit — conservative).
const _apexLadderR = (() => {
  try { const C2 = require("./constants"); const k = 1 / (C2.ITREND_STOP_PCT || 0.30);
        return { rungs: (C2.LOCK_LADDER || []).map(([a, f]) => [a * k, f * k]), trail: (C2.LOCK_LADDER_TRAIL || 0.025) * k }; }
  catch (_) { return { rungs: [[0.167, 0], [0.25, 0.167], [0.283, 0.25], [0.333, 0.283], [0.417, 0.333], [0.5, 0.417]], trail: 0.083 }; }
})();
const EXIT_VARIANTS = {
  paper:   { label: "Paper: 10% ATR stop, hold to close",       stop: (c) => CFG.ATR_STOP * c.atr },
  or:      { label: "Opening-range stop, hold to close",         stop: (c) => Math.max(c.h - c.l, 0.1 * c.atr) },
  atr1:    { label: "1 x ATR stop, hold to close",               stop: (c) => c.atr },
  or_be:   { label: "OR stop + breakeven at 1R + 1R trail from 2R", stop: (c) => Math.max(c.h - c.l, 0.1 * c.atr),
             floorR: (pk) => pk >= 2 ? pk - 1 : pk >= 1 ? 0 : null },
  // 11/03: today's replay showed 9 paper-stop losers peaking at +5R to +13R before round-tripping to -1R
  paper_be: { label: "Paper stop + breakeven at 1R + 1R trail from 2R", stop: (c) => CFG.ATR_STOP * c.atr,
              floorR: (pk) => pk >= 2 ? pk - 1 : pk >= 1 ? 0 : null },
  paper_be2: { label: "Paper stop + breakeven at 2R + 2R trail from 4R", stop: (c) => CFG.ATR_STOP * c.atr,
              floorR: (pk) => pk >= 4 ? pk - 2 : pk >= 2 ? 0 : null },
  // 11/03 (Harrison): "-0.5R lock? exit at 2R?" — a fixed target is a LIMIT order: no exit slippage on winners
  paper_t2:   { label: "Paper stop + take profit at +2R", stop: (c) => CFG.ATR_STOP * c.atr, targetR: 2 },
  paper_t2be: { label: "Paper stop + breakeven at 1R + take profit at +2R", stop: (c) => CFG.ATR_STOP * c.atr, targetR: 2,
                floorR: (pk) => pk >= 1 ? 0 : null },
  paper_l05:  { label: "Paper stop + lock -0.5R at 1R + 1R trail from 2R", stop: (c) => CFG.ATR_STOP * c.atr,
                floorR: (pk) => pk >= 2 ? pk - 1 : pk >= 1 ? -0.5 : null },
  paper_l05t2: { label: "Paper stop + lock -0.5R at 1R + take profit at +2R", stop: (c) => CFG.ATR_STOP * c.atr, targetR: 2,
                 floorR: (pk) => pk >= 1 ? -0.5 : null },
  // 11/03 (Harrison): "if the position drops half an R from its high, sell" — trailing giveback of 0.5R once in profit
  paper_g05a: { label: "Paper stop + sell on a 0.5R drop from the high (armed at +0.5R)", stop: (c) => CFG.ATR_STOP * c.atr,
                floorR: (pk) => pk >= 0.5 ? pk - 0.5 : null },
  paper_g05b: { label: "Paper stop + sell on a 0.5R drop from the high (armed at +1R)", stop: (c) => CFG.ATR_STOP * c.atr,
                floorR: (pk) => pk >= 1 ? pk - 0.5 : null },
  // 11/04 (Harrison, from day 2's fills: ~2.4R of round-trip slippage on a 0.1-ATR R): same lock + trail on a BIGGER R
  atr25_l05: { label: "0.25 ATR stop + lock -0.5R at 1R + 1R trail from 2R", stop: (c) => 0.25 * c.atr, floorR: (pk) => pk >= 2 ? pk - 1 : pk >= 1 ? -0.5 : null },
  atr50_l05: { label: "0.5 ATR stop + lock -0.5R at 1R + 1R trail from 2R",  stop: (c) => 0.5 * c.atr,  floorR: (pk) => pk >= 2 ? pk - 1 : pk >= 1 ? -0.5 : null },
  atr100_l05: { label: "1 ATR stop + lock -0.5R at 1R + 1R trail from 2R",   stop: (c) => c.atr,        floorR: (pk) => pk >= 2 ? pk - 1 : pk >= 1 ? -0.5 : null },
  // stop-LIMIT entry: no fill if the trigger bar opens more than 0.05 ATR past the level; slippage capped at 0.05 ATR (approximate)
  paper_l05_cap: { label: "Paper stop + lock/trail, entry capped at 0.05 ATR past the level (stop-limit, approx.)", stop: (c) => CFG.ATR_STOP * c.atr,
                   entryCapAtr: 0.05, floorR: (pk) => pk >= 2 ? pk - 1 : pk >= 1 ? -0.5 : null },
  atr50_l05_cap: { label: "0.5 ATR stop + lock/trail, entry capped at 0.05 ATR past the level (approx.)", stop: (c) => 0.5 * c.atr,
                   entryCapAtr: 0.05, floorR: (pk) => pk >= 2 ? pk - 1 : pk >= 1 ? -0.5 : null },
  or_apex: { label: "OR stop + APEX lock ladder (in R)",         stop: (c) => Math.max(c.h - c.l, 0.1 * c.atr),
             floorR: (pk) => { const L = _apexLadderR.rungs; if (!L.length || pk < L[0][0]) return null; let f = L[0][1];
                               for (const [a, fl] of L) if (pk >= a) f = fl; const top = L[L.length - 1]; if (pk >= top[0]) f = Math.max(f, pk - _apexLadderR.trail); return f; } },
};
// costs (optional, in fractions of ATR): { entryAtr, exitAtr, closeAtr }. With costs the entry fills PAST the trigger, the stop
// and floors are measured from that fill (as live), stop/floor exits fill PAST the stop, the 2:58 close pays closeAtr; targets
// are limit orders (no slippage).
function simulateExit(cand, bars, v, closeOpen = true, costs = null) {
  if (!cand || !cand.entry || cand.side === "doji" || !Array.isArray(bars) || !bars.length) return null;
  const L = cand.side === "long", sg = L ? 1 : -1, sd = v.stop(cand);
  if (!(sd > 0)) return null;
  const atr = +cand.atr || 0;
  let ec = costs ? (costs.entryAtr || 0) * atr : 0;
  const xr = costs ? (costs.exitAtr || 0) * atr / sd : 0, cr = costs ? (costs.closeAtr || 0) * atr / sd : 0;
  let entryPx = null, peakR = 0, at = null;
  const rOf = (px) => sg * (px - entryPx) / sd;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], o = +b.o, h = +b.h, l = +b.l, c = +b.c;
    if (entryPx == null) {
      if (!(L ? h >= cand.entry : l <= cand.entry)) continue;
      const trig = L ? Math.max(cand.entry, o) : Math.min(cand.entry, o);
      if (v.entryCapAtr != null) {   // stop-limit: a bar that opens beyond the cap never fills; otherwise slippage is capped
        if (sg * (trig - cand.entry) > v.entryCapAtr * atr + 1e-9) return { entered: false, R: 0, reason: "limit not filled (gapped past)", sd };
        ec = Math.min(ec, Math.max(0, v.entryCapAtr * atr - sg * (trig - cand.entry)));
      }
      entryPx = L ? Math.min(trig + ec, h) : Math.max(trig - ec, l); at = b.t;   // slippage can't fill outside the bar's range
      const up = c >= o, gapIn = L ? o >= cand.entry : o <= cand.entry;
      const adverse = gapIn ? (L ? l : h) : L ? (up ? c : l) : (up ? h : c);   // same path convention as simulate()
      if (rOf(adverse) <= -1) return { entered: true, entryPx, R: +Math.max(-1 - xr, rOf(L ? l : h)).toFixed(3), reason: "stop (entry bar)", at, sd };
      peakR = Math.max(0, rOf(c));
      continue;
    }
    const floor = v.floorR ? v.floorR(peakR) : null;
    const stopR = floor != null ? Math.max(-1, floor) : -1;
    const lowR = rOf(L ? l : h), openR = rOf(o);
    if (lowR <= stopR) {
      const exitR = Math.max((openR <= stopR ? openR : stopR) - xr, lowR);   // gapped through: out at the open; slippage, but not past the bar
      return { entered: true, entryPx, R: +exitR.toFixed(3), reason: floor != null ? (stopR > -1 ? "ladder" : "stop") : "stop", peakR: +peakR.toFixed(2), at, sd };
    }
    if (v.targetR != null) {   // take-profit limit: filled at the target, or at the open if it gapped past it
      const hiR = rOf(L ? h : l);
      if (hiR >= v.targetR) return { entered: true, entryPx, R: +Math.max(v.targetR, openR).toFixed(3), reason: "target", peakR: +Math.max(peakR, hiR).toFixed(2), at, sd };
    }
    peakR = Math.max(peakR, rOf(L ? h : l));
  }
  if (entryPx == null) return { entered: false, R: 0, reason: "not triggered", sd };
  const last = +bars[bars.length - 1].c;
  return { entered: true, entryPx, R: +(rOf(last) - (closeOpen ? cr : 0)).toFixed(3), reason: closeOpen ? "close" : "still open (marked)", peakR: +peakR.toFixed(2), at, sd };
}
const replayCosts = () => ({ entryAtr: CFG.COST_ENTRY_ATR, exitAtr: CFG.COST_EXIT_ATR, closeAtr: CFG.COST_CLOSE_ATR });
// every variant on every candidate -> { perTrade: {SYM: {variant: result}}, totals: {variant: {...}} }
// 11/04: every rule twice — gross (ideal fills) and NET (with replayCosts()). Totals carry both; per-trade results carry Rnet.
function replayVariants(cands, barsBySym, closeOpen = true, costs = replayCosts()) {
  const perTrade = {}, totals = {};
  for (const k of Object.keys(EXIT_VARIANTS)) totals[k] = { label: EXIT_VARIANTS[k].label, trades: 0, wins: 0, R: 0, usd: 0, tradesNet: 0, winsNet: 0, Rnet: 0, usdNet: 0 };
  for (const c of cands) {
    if (!c || c.side === "doji" || !c.entry) continue;
    const bars = barsBySym[c.sym] || [];
    perTrade[c.sym] = {};
    for (const [k, v] of Object.entries(EXIT_VARIANTS)) {
      const r = simulateExit(c, bars, v, closeOpen);
      if (!r) continue;
      const t = totals[k];
      if (r.entered) { const sh = sizePosition(c.entry, r.sd); r.shares = sh; r.usd = +(r.R * r.sd * sh).toFixed(2);
                       t.trades++; if (r.R > 0) t.wins++; t.R += r.R; t.usd += r.usd; }
      const n = costs ? simulateExit(c, bars, v, closeOpen, costs) : null;
      if (n) { r.Rnet = n.entered ? n.R : null; r.reasonNet = n.reason;
               if (n.entered) { const shn = sizePosition(c.entry, n.sd); r.usdNet = +(n.R * n.sd * shn).toFixed(2);
                                t.tradesNet++; if (n.R > 0) t.winsNet++; t.Rnet += n.R; t.usdNet += r.usdNet; } }
      perTrade[c.sym][k] = r;
    }
  }
  for (const t of Object.values(totals)) {
    t.R = +t.R.toFixed(2); t.usd = +t.usd.toFixed(2); t.winPct = t.trades ? +(100 * t.wins / t.trades).toFixed(0) : null;
    t.Rnet = +t.Rnet.toFixed(2); t.usdNet = +t.usdNet.toFixed(2); t.winPctNet = t.tradesNet ? +(100 * t.winsNet / t.tradesNet).toFixed(0) : null;
  }
  return { perTrade, totals };
}
// on demand (dashboard button): today's candidates against today's 1-minute bars so far
let _replayCache = null;
async function replayToday(state) {
  const s = state && state._sip;
  if (!s || !Array.isArray(s.cands) || !s.cands.length) return { day: s ? s.day : null, note: "no stocks-in-play candidates today", totals: {}, perTrade: {} };
  if (_replayCache && _replayCache.day === s.day && Date.now() - _replayCache.at < 60000) return _replayCache.out;
  const p = etParts();
  const exitMin = (s.sessionCloseMin || 960) - CFG.EXIT_BEFORE_CLOSE_MIN;
  const endMin = p.day === s.day ? Math.min(p.min, exitMin) : exitMin;
  const closed = !(p.day === s.day && p.min < exitMin);
  const cs = s.cands.filter(c => c.side !== "doji" && c.entry);
  const raw = await multiBars(cs.map(c => c.sym), "1Min", iso(etToUtcMs(s.day, 9, 35)), iso(etToUtcMs(s.day, Math.floor(endMin / 60), Math.floor(endMin % 60)) - 1000));
  const bars = {};
  for (const c of cs) bars[c.sym] = (raw[c.sym] || []).filter(x => { const m = etParts(Date.parse(x.t)).min; return m >= 575 && m < exitMin; });
  const liveRule = CFG.EXIT_MODE === "hold" ? "paper"
    : (CFG.LOCK_AT_R === 1 && CFG.LOCK_FLOOR_R === -0.5 && CFG.TRAIL_FROM_R === 2 && CFG.TRAIL_R === 1 ? "paper_l05" : null);
  const out = { day: s.day, asOf: hhmm(endMin) + " ET", final: closed, liveRule, costs: replayCosts(), ...replayVariants(cs, bars, closed),
                live: cs.filter(c => c.status === "closed").reduce((a, c) => ({ trades: a.trades + 1, wins: a.wins + (c.pnl > 0 ? 1 : 0), usd: +(a.usd + (c.pnl || 0)).toFixed(2), R: +(a.R + (c.R || 0)).toFixed(2) }), { trades: 0, wins: 0, usd: 0, R: 0 }) };
  _replayCache = { day: s.day, at: Date.now(), out };
  return out;
}

// ───────────────────────── universe build (9:00 ET, in memory) ─────────────────────────
let _universe = null;   // { day, syms: { SYM: { atr, avgVol, prevClose, ovAvg, etb, shortable } }, built }
async function buildUniverse(day, log) {
  const t0 = Date.now();
  const assets = await getJSON(io().trade, "/assets?status=active&asset_class=us_equity", 2);
  const meta = {};
  for (const a of assets || []) {
    if (!a || !a.tradable || !EXCHANGES.has(a.exchange) || !/^[A-Z]{1,5}$/.test(a.symbol || "") || NON_COMMON_RE.test(a.name || "")) continue;
    meta[a.symbol] = { etb: !!a.easy_to_borrow, shortable: !!a.shortable };
  }
  const syms = Object.keys(meta);
  const dEnd = etToUtcMs(day, 0, 0), dStart = dEnd - 40 * 86400000;
  const daily = await multiBars(syms, "1Day", iso(dStart), iso(dEnd - 1000));
  const pre = {}; const dates = new Set();
  for (const s of syms) {
    const st = dailyStats(daily[s]);
    if (!st || st.avgVol < CFG.MIN_AVG_VOL || !(st.atr > CFG.MIN_ATR) || !(st.prevClose > CFG.MIN_PRICE * 0.8)) continue;
    pre[s] = { ...st, ...meta[s] };
    for (const b of daily[s].slice(-CFG.LOOKBACK)) dates.add(etParts(Date.parse(b.t)).day);
  }
  const days = [...dates].sort().slice(-CFG.LOOKBACK);
  const preSyms = Object.keys(pre);
  const sums = {}, seen = {};
  await pool(days, 2, async (d) => {
    const bars = await multiBars(preSyms, "5Min", iso(etToUtcMs(d, 9, 30)), iso(etToUtcMs(d, 9, 31)));
    for (const s of preSyms) {
      const b = (bars[s] || []).find(x => etParts(Date.parse(x.t)).min === 570);
      sums[s] = (sums[s] || 0) + (b ? +b.v : 0);   // no 9:30 print that day = zero opening volume
      if (b) seen[s] = (seen[s] || 0) + 1;
    }
  });
  const out = {};
  for (const s of preSyms) if ((seen[s] || 0) >= CFG.LOOKBACK - 4) out[s] = { ...pre[s], ovAvg: sums[s] / days.length };
  _universe = { day, syms: out, built: Date.now() };
  log("scan", `[SIP] universe ${day}: ${syms.length} listed common stocks -> ${preSyms.length} pass volume/ATR/price -> ${Object.keys(out).length} with a 14-day opening-volume history (${days[0]}..${days[days.length - 1]}) — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return _universe;
}

// ───────────────────────── state ─────────────────────────
function freshDay(day) {
  return { day, mode: CFG.MODE, built: false, scanned: false, skipped: null, exitPass: 0, simulated: false,
           sessionCloseMin: 16 * 60, cands: [], carry: [], summary: null, notes: [] };
}
function cid(day, sym, tag) { return `sip-${day.replace(/-/g, "")}-${sym}-${tag}`; }
const isSipOrder = (o) => !!(o && typeof o.client_order_id === "string" && o.client_order_id.startsWith("sip-"));
const openQty = (c) => Math.max(0, (c.filledQty || 0) - (c.exitQty || 0));
const sgnOf = (c) => (c.side === "long" ? 1 : -1);
const baseOf = (c) => (CFG.STOP_BASE === "fill" && c.fillPx > 0 ? c.fillPx : c.entry);
// stop price for a floor expressed in R from the base (floorR = -1 is the initial stop); rounded away from the market
function stopPxFor(c, floorR) { const raw = baseOf(c) + sgnOf(c) * floorR * c.stopDist; return c.side === "long" ? floorC(raw) : ceilC(raw); }
// the live exit rule: -1R until +LOCK_AT_R, then LOCK_FLOOR_R, from +TRAIL_FROM_R trail TRAIL_R behind the peak. Never lowers.
function lockFloorR(peakR) {
  if (CFG.EXIT_MODE !== "lock_trail" || !(peakR >= CFG.LOCK_AT_R)) return -1;
  return peakR >= CFG.TRAIL_FROM_R ? Math.max(CFG.LOCK_FLOOR_R, peakR - CFG.TRAIL_R) : CFG.LOCK_FLOOR_R;
}
let _otoUnsupported = false;   // set if Alpaca rejects the one-triggers-other form: fall back to entry, then stop

// options-book cash correction: Alpaca cash moves by share notional; the options book should not see that
function cashAdjustment(state) {
  const s = state && state._sip; if (!s) return 0;
  let adj = 0;
  for (const c of [...(s.cands || []), ...(s.carry || [])]) {
    const q = openQty(c); if (!q || !(c.fillPx > 0)) continue;
    adj += c.side === "long" ? q * c.fillPx : -q * c.fillPx;
  }
  return +adj.toFixed(2);
}

// ───────────────────────── live order handling ─────────────────────────
async function placeOrder(body) {
  const r = await io().post("/orders", body);
  if (r && r.status >= 200 && r.status < 300 && r.body && r.body.id) return { ok: true, order: r.body };
  const msg = (r && r.body && (r.body.message || r.body.raw)) || `HTTP ${r && r.status}`;
  if (/client_order_id/i.test(msg) && /unique|exist/i.test(msg)) {   // already placed (restart): adopt it
    const g = await io().trade(`/orders:by_client_order_id?client_order_id=${encodeURIComponent(body.client_order_id)}`);
    if (g && g.body && g.body.id) {
      let order = g.body;
      // an adopted one-triggers-other entry must bring its stop leg, or a second stop would be placed on the fill
      if (body.order_class && !Array.isArray(order.legs)) { const n = await io().trade(`/orders/${order.id}?nested=true`); if (n && n.body && n.body.id) order = n.body; }
      return { ok: true, order, adopted: true };
    }
  }
  return { ok: false, msg };
}
async function lastTrade(sym) {
  try { const b = await getJSON(io().data, `/stocks/${sym}/trades/latest?feed=sip`, 2); return b && b.trade ? +b.trade.p : null; } catch (_) { return null; }
}
async function account() { try { return await getJSON(io().trade, "/account", 2); } catch (_) { return null; } }
// signed share position at the broker (+ long, - short); 0 if none; null if the read failed
async function brokerQty(sym) {
  try {
    const r = await io().trade(`/positions/${sym}`);
    if (r && r.status === 404) return 0;
    if (r && r.status >= 200 && r.status < 300 && r.body) { const q = Math.abs(+(r.body.qty || 0)); return r.body.side === "short" || +r.body.qty < 0 ? -q : q; }
  } catch (_) {}
  return null;
}
// order ids -> wait until none is still open (cancel landed), up to ~8s
async function waitTerminal(ids) {
  const done = ["filled", "canceled", "expired", "rejected", "done_for_day"];
  for (let i = 0; i < 6 && ids.length; i++) {
    const left = [];
    for (const id of ids) { const r = await io().trade(`/orders/${id}`); if (!(r && r.body && done.includes(r.body.status))) left.push(id); }
    ids = left; if (ids.length) await sleep(1500);
  }
  return ids;   // still open after the wait
}

async function placeEntries(s, log) {
  const acct = await account();
  const shortOK = acct ? acct.shorting_enabled !== false : true;   // account read failed: try, Alpaca rejects if not allowed
  const dtbp = acct ? +(acct.daytrading_buying_power || acct.buying_power || 0) : 0;
  const maxGross = Math.min(CFG.LEVERAGE * CFG.SLEEVE_USD, dtbp > 0 ? dtbp - CFG.OPT_BP_RESERVE : Infinity);
  let gross = 0;
  for (const c of s.cands) {
    if (c.side === "doji") continue;
    if (c.qty < 1) { c.status = "size<1"; continue; }
    if (c.side === "short" && (!shortOK || !c.shortable || !c.etb)) { c.status = "no-borrow (simulated only)"; continue; }
    const notional = c.qty * c.entry;
    if (gross + notional > maxGross) { c.status = "buying-power cap (simulated only)"; continue; }
    const side = c.side === "long" ? "buy" : "sell";
    const leg = () => (CFG.USE_OTO && !_otoUnsupported ? { order_class: "oto", stop_loss: { stop_price: stopPxFor(c, -1).toFixed(2) } } : {});
    const send = async (b) => {
      let rr = await placeOrder({ ...b, ...leg() });
      if (!rr.ok && CFG.USE_OTO && !_otoUnsupported && /order.?class|oto|stop_loss|bracket|leg/i.test(rr.msg)) {
        _otoUnsupported = true;   // this account/endpoint won't take the combined form: plain entry, stop placed on the fill
        log("warn", `[SIP] one-triggers-other entry rejected (${rr.msg}) — falling back to entry, then stop on the fill`);
        rr = await placeOrder(b);
      }
      return rr;
    };
    let r = await send({ symbol: c.sym, qty: String(c.qty), side, type: "stop", stop_price: c.entry.toFixed(2), time_in_force: "day", client_order_id: cid(s.day, c.sym, "E") });
    // 11/03: Alpaca says the price is already past the level ("stop price must be greater/less than current price") —
    // the paper counts that as an entry, so go at market. (Day 1 lost LPX this way: the old check used the last trade.)
    if (!r.ok && /stop.?price/i.test(r.msg) && /current|market|greater|less|above|below/i.test(r.msg)) {
      const px = await lastTrade(c.sym);
      const pastR = px ? sgnOf(c) * (px - c.entry) / c.stopDist : 0;
      if (pastR > CFG.MAX_LATE_R) { r = { ok: false, msg: `already ${pastR.toFixed(1)}R past the level — not chased` }; }
      else {
        r = await send({ symbol: c.sym, qty: String(c.qty), side, type: "market", time_in_force: "day", client_order_id: cid(s.day, c.sym, "EM") });
        if (r.ok) c.late = true;
      }
    }
    if (r.ok) {
      c.status = "working"; c.entryOrderId = r.order.id; c.entryClientId = r.order.client_order_id; gross += notional;
      const lg = Array.isArray(r.order.legs) && r.order.legs[0];
      if (lg && lg.id) { c.oto = true; c.stopOrderId = lg.id; c.stopPx = +lg.stop_price || stopPxFor(c, -1); c.floorR = -1; }
    }
    else { c.status = `rejected: ${String(r.msg).slice(0, 80)}`; }
    log(r.ok ? "trade" : "warn", `[SIP] #${c.rank} ${c.sym} ${c.side.toUpperCase()} rvol ${c.rvol}x ${c.late ? "MARKET (already through)" : `${c.side === "long" ? "buy" : "sell"}-stop $${c.entry.toFixed(2)}`} qty ${c.qty} ($${(notional / 1000).toFixed(1)}k) stop dist $${c.stopDist.toFixed(2)} -> ${c.status}`);
  }
  s.grossWorking = +gross.toFixed(0);
  // options buying power check after the entries are resting (open orders hold buying power)
  const a2 = await account();
  const obp = a2 ? +(a2.options_buying_power || a2.buying_power || 0) : null;
  if (obp != null && obp < CFG.OPT_BP_RESERVE) {
    for (const c of [...s.cands].reverse()) {
      if (c.status !== "working" || (c.filledQty || 0) > 0) continue;
      await io().del(`/orders/${c.entryOrderId}`); c.status = "cancelled: options buying-power reserve (simulated only)"; c._weCancelledEntry = true;
      const a3 = await account(); const o3 = a3 ? +(a3.options_buying_power || 0) : 0;
      log("warn", `[SIP] ${c.sym} entry cancelled to keep options buying power >= $${CFG.OPT_BP_RESERVE} (now $${o3.toFixed(0)})`);
      if (o3 >= CFG.OPT_BP_RESERVE) break;
    }
  }
  log("scan", `[SIP] entries resting: ${s.cands.filter(c => c.status === "working").length} | gross $${(gross / 1000).toFixed(1)}k | options BP ${obp != null ? "$" + obp.toFixed(0) : "?"}`);
}

function recordExit(c, px, qty, reason, log) {
  c.exitQty = (c.exitQty || 0) + qty;
  const prevQ = c.exitQty - qty;
  c.exitPx = prevQ > 0 && c.exitPx ? (c.exitPx * prevQ + px * qty) / c.exitQty : px;
  c.exitReason = reason;
  if (openQty(c) === 0) {
    c.status = "closed";
    const sign = c.side === "long" ? 1 : -1;
    c.pnl = +(sign * (c.exitPx - c.fillPx) * c.filledQty).toFixed(2);
    c.R = c.stopDist > 0 ? +((sign * (c.exitPx - c.fillPx)) / c.stopDist).toFixed(3) : null;
    log("trade", `[SIP] ${c.sym} ${c.side.toUpperCase()} CLOSED ${reason} — ${c.filledQty} sh in $${c.fillPx.toFixed(2)} out $${c.exitPx.toFixed(2)} = ${c.pnl >= 0 ? "+" : "-"}$${Math.abs(c.pnl).toFixed(2)} (${c.R >= 0 ? "+" : ""}${c.R}R)`);
  }
}

async function protect(c, s, log, why = "stop-reject") {
  if (!(openQty(c) > 0) || c.status === "closed") return;   // 11/03 hotfix: nothing left to protect
  const L = c.side === "long";
  if (c.floorR == null) c.floorR = -1;
  if ((c.stopRejects || 0) >= 3) return;   // don't hammer Alpaca: three refusals and the safety net / exit pass take over
  c.stopPx = stopPxFor(c, c.floorR);
  c.stopSeq = (c.stopSeq || 0) + 1;
  const r = await placeOrder({ symbol: c.sym, qty: String(openQty(c)), side: L ? "sell" : "buy", type: "stop", stop_price: c.stopPx.toFixed(2),
                               time_in_force: "day", client_order_id: cid(s.day, c.sym, `S${c.stopSeq}`) });
  if (r.ok) { c.stopOrderId = r.order.id; c.status = "open"; log("trade", `[SIP] ${c.sym} ${c.filledQty} sh @ $${c.fillPx.toFixed(2)} — stop $${c.stopPx.toFixed(2)} placed (${(c.floorR != null ? c.floorR : -1).toFixed(2)}R)`); return; }
  c.stopRejects = (c.stopRejects || 0) + 1;
  if (!c.stopRejectMsg) c.stopRejectMsg = String(r.msg).slice(0, 120);   // keep the FIRST reason for the EOD CSV
  log(why === "lock" ? "trade" : "error", `[SIP] ${c.sym} ${why === "lock" ? "locked stop is already through the market" : "protective stop REJECTED"} (${r.msg}) — closing at market`);
  await closeMarket(c, s, why, log);
}
async function closeMarket(c, s, why, log) {
  let q = openQty(c); if (!q) return;
  // Never send a close the broker can't match: if the shares are already gone (closed by hand in Alpaca), a market
  // sell would OPEN a short (and a buy would open a long). Close only what is actually held, on the right side.
  const bq = await brokerQty(c.sym);
  if (bq === 0 || (bq != null && (c.side === "long" ? bq < 0 : bq > 0))) {
    const px = (await lastTrade(c.sym)) || c.fillPx;
    log("warn", `[SIP] ${c.sym}: no ${c.side} position at the broker (closed outside APEX) — booked at last trade $${(+px).toFixed(2)}, no order sent`);
    recordExit(c, +px, q, "closed outside APEX", log); return;
  }
  if (bq != null && Math.abs(bq) < q) q = Math.abs(bq);
  c.closeSeq = (c.closeSeq || 0) + 1;
  const r = await placeOrder({ symbol: c.sym, qty: String(q), side: c.side === "long" ? "sell" : "buy", type: "market", time_in_force: "day",
                               client_order_id: cid(s.day, c.sym, `X${c.closeSeq}`) });
  if (r.ok) { c.closeOrderId = r.order.id; c.closeWhy = why; c.status = "closing"; }
  else log("error", `[SIP] ${c.sym} market close (${why}) REJECTED: ${r.msg} — CHECK ALPACA`);
}

// 11/03: move a resting stop to a new (better) price. Replace in place; if Alpaca refuses, cancel and re-place.
async function moveStop(c, s, newPx, floorR, log) {
  const prevFloor = c.floorR;
  if (c.stopOrderId) {
    const r = await io().patch(`/orders/${c.stopOrderId}`, { stop_price: newPx.toFixed(2) });
    if (r && r.status >= 200 && r.status < 300 && r.body && r.body.id) {
      c.stopOrderId = r.body.id; c.stopPx = newPx; c.floorR = floorR;
      log("trade", floorR <= -1 ? `[SIP] ${c.sym} stop re-based to $${newPx.toFixed(2)} = -1R from the fill $${c.fillPx.toFixed(2)}`
                                : `[SIP] ${c.sym} stop raised to $${newPx.toFixed(2)} — ${floorR >= 0 ? "+" : ""}${floorR.toFixed(2)}R locked from the fill (peak +${c.peakR}R)`);
      return;
    }
    const old = c.stopOrderId; c._weCancelledStop = true;
    await io().del(`/orders/${old}`); await waitTerminal([old]);
    await poll(s, log);   // the old stop may have filled in the meantime
    c.stopOrderId = null; c._weCancelledStop = false;
    if (!(openQty(c) > 0)) return;
  }
  c.floorR = floorR;
  await protect(c, s, log, floorR <= -1 ? "stop-reject" : "lock");   // places at the new floor; if the price is already through it, closes at market
  if (c.stopOrderId && c.floorR !== prevFloor) log("trade", `[SIP] ${c.sym} stop moved to $${(+c.stopPx).toFixed(2)} — ${floorR >= 0 ? "+" : ""}${floorR.toFixed(2)}R locked (re-placed, peak +${c.peakR}R)`);
}
// safety net: the stop should have filled by now. Cancel it (so the shares aren't held twice) and go to market.
async function hardCap(c, s, px, lossR, log) {
  c._capped = true;
  log("error", `[SIP] ${c.sym} SAFETY NET — ${lossR.toFixed(1)}R against the fill ($${c.fillPx.toFixed(2)} -> $${px.toFixed(2)}), stop not filled: cancelling it and closing at market`);
  if (c.stopOrderId) { const id = c.stopOrderId; c._weCancelledStop = true; await io().del(`/orders/${id}`); await waitTerminal([id]); try { await poll(s, log); } catch (_) {} }
  if (openQty(c) > 0 && !c.closeOrderId) await closeMarket(c, s, "hard-cap", log);
}
// every tick while positions are open: live price -> safety net, then lock/trail (stops only ever move in our favor)
async function manageExits(s, log) {
  const open = [...s.cands, ...s.carry].filter(c => openQty(c) > 0 && c.fillPx > 0 && !c.closeOrderId && !c._capped);
  if (!open.length) return;
  const syms = [...new Set(open.map(c => c.sym))];
  const b = await getJSON(io().data, `/stocks/trades/latest?symbols=${syms.join(",")}&feed=sip`, 1);
  const last = s.last || (s.last = {});
  for (const [sym, t] of Object.entries((b && b.trades) || {})) if (t && +t.p > 0) last[sym] = { px: +t.p, at: t.t || iso(Date.now()) };
  for (const c of open) {
    const l = last[c.sym]; if (!l || !(l.px > 0) || !(c.stopDist > 0)) continue;
    const px = l.px, sg = sgnOf(c);
    // one stray print must not fire the net or lift the trail: both need two consecutive ticks (~5s apart) to agree
    const lossR = sg * (c.fillPx - px) / c.stopDist;
    c._capHits = lossR >= CFG.HARD_CAP_R ? (c._capHits || 0) + 1 : 0;
    if (c._capHits >= 2) { await hardCap(c, s, px, lossR, log); continue; }
    const prev = c._lastPx; c._lastPx = px;
    if (CFG.EXIT_MODE !== "lock_trail" || s.carry.includes(c)) continue;
    const conf = prev == null ? null : sg > 0 ? Math.min(prev, px) : Math.max(prev, px);   // confirmed peak: held across two prints
    if (conf == null && c.peakPx == null) { c.peakPx = c.fillPx; }
    if (conf != null) c.peakPx = sg > 0 ? Math.max(c.peakPx, conf) : Math.min(c.peakPx, conf);
    c.peakR = +(sg * (c.peakPx - baseOf(c)) / c.stopDist).toFixed(2);
    // target floor: the lock/trail, never below -1R from the base. With STOP_BASE "fill" this also re-bases the stop that went
    // out with the entry (placed at the LEVEL before the fill was known) onto the real fill — tighter whenever the fill slipped.
    const fr = Math.max(-1, lockFloorR(c.peakR));
    if (c.floorR != null && fr < c.floorR) continue;
    const newPx = stopPxFor(c, fr), step = Math.max(0.01, 0.1 * c.stopDist);
    if (c.stopPx != null && (sg > 0 ? newPx < c.stopPx + step - 1e-9 : newPx > c.stopPx - step + 1e-9)) continue;   // never lower, no replace spam
    await moveStop(c, s, newPx, fr, log);
  }
}

async function poll(s, log) {
  const syms = [...new Set([...s.cands, ...s.carry].filter(c => c.entryOrderId || c.stopOrderId || c.closeOrderId).map(c => c.sym))];
  if (!syms.length) return;
  // only the sleeve's symbols (an options-heavy day can't push these out of the 500-order page)
  const orders = await getJSON(io().trade, `/orders?status=all&symbols=${syms.join(",")}&after=${encodeURIComponent(iso(etToUtcMs(s.day, 4, 0)))}&limit=500&direction=desc&nested=true`, 2);
  const byId = {};
  for (const o of orders || []) { byId[o.id] = o; for (const lg of (o && o.legs) || []) if (lg && lg.id) byId[lg.id] = lg; }   // OTO stop legs
  const now = Date.now();
  for (const c of [...s.cands, ...s.carry]) {
    // entry
    const e = c.entryOrderId && byId[c.entryOrderId];
    if (e) {
      const fq = +(e.filled_qty || 0);
      if (fq > (c.filledQty || 0)) { c.filledQty = fq; c.fillPx = +e.filled_avg_price; c.filledAt = c.filledAt || e.filled_at || iso(now); c._partialSince = c._partialSince || now; }
      const terminal = ["filled", "canceled", "expired", "rejected", "done_for_day"].includes(e.status);
      if (terminal) c._entryDone = true;
      if (!terminal && c.filledQty > 0 && now - c._partialSince > CFG.PARTIAL_WAIT_MS && !c._cancelledRemainder) {
        await io().del(`/orders/${e.id}`); c._cancelledRemainder = true;
        log("warn", `[SIP] ${c.sym} partial entry ${c.filledQty}/${c.qty} for 30s — remainder cancelled, protecting the filled shares`);
      }
      if (terminal && c.status === "working") {
        if (c.filledQty > 0 && c.oto && c.stopOrderId) {
          c.status = "open";
          log("trade", `[SIP] ${c.sym} ${c.side.toUpperCase()} ${c.filledQty} sh @ $${c.fillPx.toFixed(2)} (level $${c.entry.toFixed(2)}) — stop $${(+c.stopPx).toFixed(2)} already resting (sent with the entry)`);
          if (c.filledQty < c.qty) {   // partial entry: the stop leg is for the full size — shrink it to the shares held
            const pr = await io().patch(`/orders/${c.stopOrderId}`, { qty: String(c.filledQty) });
            if (pr && pr.status >= 200 && pr.status < 300 && pr.body && pr.body.id) c.stopOrderId = pr.body.id;
            else { const old = c.stopOrderId; c._weCancelledStop = true; await io().del(`/orders/${old}`); await waitTerminal([old]); c.stopOrderId = null; c._weCancelledStop = false; }
          }
        } else if (c.filledQty > 0) c.status = "filled";
        else c.status = e.status === "rejected" ? `rejected: ${e.status}` : c._weCancelledEntry || s.exitPass ? "not triggered" : `entry ${e.status} (not by APEX)`;
      }
      // protect only once the entry order is done: a sell stop beside a still-working buy can be rejected as a wash trade
      // 11/03 hotfix: and only while shares are still open — a position already closed (stop-reject -> market close, or
      // closed outside APEX) has no stop and no close order left, and used to loop here every tick with qty 0
      if (c.filledQty > 0 && openQty(c) > 0 && c.status !== "closed" && !c.stopOrderId && !c.closeOrderId && terminal && !s.exitPass) await protect(c, s, log);
    }
    // protective stop
    const st = c.stopOrderId && byId[c.stopOrderId];
    if (st && openQty(c) > 0) {
      const fq = +(st.filled_qty || 0);
      if (st.status === "filled" || (fq > 0 && ["canceled", "expired"].includes(st.status))) {
        recordExit(c, +st.filled_avg_price, Math.min(fq, openQty(c)), "stop", log);
        if (openQty(c) > 0) { c.stopOrderId = null; if (!s.exitPass) await protect(c, s, log); }
      } else if (["canceled", "expired", "rejected"].includes(st.status) && !c._weCancelledStop && !s.exitPass) {
        c.stopOrderId = null;
        const bq = await brokerQty(c.sym);
        if (bq === 0 || (bq != null && (c.side === "long" ? bq < 0 : bq > 0))) {   // stop cancelled because the position was closed by hand
          const px = (await lastTrade(c.sym)) || c.fillPx;
          log("warn", `[SIP] ${c.sym} protective stop ${st.status} and no position at the broker — closed outside APEX, booked at $${(+px).toFixed(2)}`);
          recordExit(c, +px, openQty(c), "closed outside APEX", log);
        } else {
          log("warn", `[SIP] ${c.sym} protective stop was ${st.status} by someone else — re-placing`);
          await protect(c, s, log);
        }
      }
    }
    // market close
    const x = c.closeOrderId && byId[c.closeOrderId];
    if (x && openQty(c) > 0 && +(x.filled_qty || 0) > 0 && ["filled", "canceled", "expired"].includes(x.status)) {
      recordExit(c, +x.filled_avg_price, Math.min(+x.filled_qty, openQty(c)), c.closeWhy || "close", log);
      c.closeOrderId = null;
    } else if (x && ["canceled", "expired", "rejected"].includes(x.status) && +(x.filled_qty || 0) === 0) {
      c.closeOrderId = null;   // the next exit pass retries
    }
  }
}

async function exitPass(s, pass, log) {
  s.exitPass = pass;
  const live = [...s.cands, ...s.carry];
  // every pass re-sends the cancels (idempotent): a sell stop still resting would hold the shares and the market sell is rejected
  const sent = [];
  for (const c of live) {
    if ((c.status === "working" || c.status === "filled") && c.entryOrderId && !c._entryDone) { c._weCancelledEntry = true; await io().del(`/orders/${c.entryOrderId}`); sent.push(c.entryOrderId); }
    if (c.stopOrderId && openQty(c) > 0) { c._weCancelledStop = true; await io().del(`/orders/${c.stopOrderId}`); sent.push(c.stopOrderId); }
  }
  // Alpaca rejects a sell for shares still held by a resting stop ("insufficient quantity available"): wait for the cancels
  const stuck = sent.length ? await waitTerminal(sent) : [];
  if (stuck.length) log("warn", `[SIP] exit pass ${pass}: ${stuck.length} cancel(s) not confirmed yet — closing the rest, the next pass retries`);
  await poll(s, log);   // a stop that filled before its cancel landed is booked as a stop, not closed twice
  const stuckSet = new Set(stuck);
  const toClose = live.filter(c => openQty(c) > 0 && !c.closeOrderId && !stuckSet.has(c.stopOrderId));
  for (const c of toClose) await closeMarket(c, s, "close", log);
  log(pass > 1 && toClose.length ? "warn" : "scan", `[SIP] exit pass ${pass} (${hhmm(s.sessionCloseMin - CFG.EXIT_BEFORE_CLOSE_MIN + pass - 1)} ET): ${toClose.length} position(s) sent to market${pass > 1 && toClose.length ? " — RETRY" : ""}`);
}

// ───────────────────────── end-of-day: ideal replay + summary ─────────────────────────
async function simulateDay(s, log) {
  const cs = s.cands.filter(c => c.side !== "doji" && c.entry);
  if (!cs.length) { s.summary = summarize(s); return; }
  const exitMin = s.sessionCloseMin - CFG.EXIT_BEFORE_CLOSE_MIN;
  const bars = await multiBars(cs.map(c => c.sym), "1Min", iso(etToUtcMs(s.day, 9, 35)), iso(etToUtcMs(s.day, Math.floor(exitMin / 60), exitMin % 60) - 1000));
  for (const c of cs) {
    const b = (bars[c.sym] || []).filter(x => { const m = etParts(Date.parse(x.t)).min; return m >= 575 && m < exitMin; });
    c.ideal = simulate(c, b);
    if (c.ideal && c.ideal.entered) c.idealPnl = +((c.ideal.R * c.stopDist) * (c.qty || 0)).toFixed(2);
    if (c.status === "closed" && c.ideal && c.ideal.entered) {
      const sign = c.side === "long" ? 1 : -1;
      c.entrySlipR = +((sign * (c.fillPx - c.ideal.entryPx)) / c.stopDist).toFixed(3);   // + = paid worse than the paper's price
      c.slipR = +(c.ideal.R - c.R).toFixed(3);                                              // total R the paper's prices left out
    }
  }
  s.summary = summarize(s);
  try { s.variants = replayVariants(cs, Object.fromEntries(cs.map(c => [c.sym, (bars[c.sym] || []).filter(x => { const m2 = etParts(Date.parse(x.t)).min; return m2 >= 575 && m2 < exitMin; })])), true).totals; s.variantCosts = replayCosts(); } catch (_) {}
  const m = s.summary;
  log("trade", `[SIP] DAY ${s.day} (${s.mode}): ${m.candidates} in play, ${m.triggered} triggered live, actual ${m.actualPnl >= 0 ? "+" : ""}$${m.actualPnl} (${m.actualR >= 0 ? "+" : ""}${m.actualR}R) | paper's ideal on all ${m.idealTrades} triggers ${m.idealR >= 0 ? "+" : ""}${m.idealR}R | slippage on traded ${m.slipRPerTrade != null ? m.slipRPerTrade + "R/trade" : "n/a"}`);
}
function summarize(s) {
  const cl = s.cands.filter(c => c.status === "closed");
  const id = s.cands.filter(c => c.ideal && c.ideal.entered);
  const sl = cl.filter(c => c.slipR != null);
  const sum = (a, f) => +a.reduce((x, c) => x + (f(c) || 0), 0).toFixed(3);
  return {
    candidates: s.cands.length, dojis: s.cands.filter(c => c.side === "doji").length,
    noBorrow: s.cands.filter(c => /no-borrow/.test(c.status)).length,
    triggered: cl.length, wins: cl.filter(c => c.pnl > 0).length,
    actualPnl: +sum(cl, c => c.pnl).toFixed(2), actualR: sum(cl, c => c.R),
    idealTrades: id.length, idealR: sum(id, c => c.ideal.R), idealRTraded: sum(cl.filter(c => c.ideal && c.ideal.entered), c => c.ideal.R),
    slipRPerTrade: sl.length ? +(sum(sl, c => c.slipR) / sl.length).toFixed(3) : null,
    carryClosed: s.carry.filter(c => c.status === "closed").length,
  };
}

// ───────────────────────── tick (every 5s from server.js) ─────────────────────────
let _busy = false, _buildFailAt = 0, _lastPxAt = 0;
// latest SIP trade for each candidate -> s.last = { SYM: { px, at } } (display only)
async function refreshLast(s) {
  const syms = [...new Set([...s.cands, ...s.carry].map(c => c.sym))];
  if (!syms.length) return;
  const last = s.last || {};
  for (const grp of chunk(syms, CFG.BATCH)) {
    const b = await getJSON(io().data, `/stocks/trades/latest?symbols=${grp.join(",")}&feed=sip`, 1);
    for (const [sym, t] of Object.entries((b && b.trades) || {})) if (t && +t.p > 0) last[sym] = { px: +t.p, at: t.t || iso(Date.now()) };
  }
  s.last = last;
}
async function tick(deps) {
  if (!CFG.ENABLED || _busy) return;
  const { state, logEvent: log } = deps;
  const markDirty = deps.markDirty || (() => {});
  const saveNow = async () => { markDirty(); if (deps.saveNow) { try { await deps.saveNow(); } catch (_) {} } };
  const p = etParts(deps.now ? deps.now() : Date.now());
  if (p.dow === 0 || p.dow === 6) return;
  _busy = true;
  try {
    let s = state._sip;
    if (!s || s.day !== p.day) {
      if (p.min < CFG.BUILD_FROM_MIN - 30) return;   // roll at 8:30 ET
      const carry = s ? [...(s.cands || []), ...(s.carry || [])].filter(c => openQty(c) > 0) : [];
      state._sip = s = freshDay(p.day);
      for (const c of carry) { c.status = "carried overnight"; c.closeOrderId = null; c.stopOrderId = null; c.closeSeq = 0; s.carry.push(c); }
      if (carry.length) log("error", `[SIP] ${carry.length} share position(s) still open from a previous day: ${carry.map(c => c.sym).join(", ")} — closing at the open`);
      markDirty();
    }
    // market calendar (holiday / early close)
    if (s.sessionKnown !== true) {
      try {
        const cal = await getJSON(io().trade, `/calendar?start=${p.day}&end=${p.day}`, 2);
        const today = Array.isArray(cal) && cal.find(x => x.date === p.day);
        if (!today) { s.skipped = "market closed"; s.scanned = true; s.simulated = true; s.sessionKnown = true; log("scan", `[SIP] ${p.day}: market closed — no trading`); return; }
        const [ch, cm] = String(today.close || "16:00").split(":").map(Number);
        s.sessionCloseMin = ch * 60 + cm; s.sessionKnown = true;
      } catch (e) { log("warn", `[SIP] calendar check failed (${e.message}) — assuming a 4:00pm close`); s.sessionKnown = true; }
    }
    if (s.skipped === "market closed") return;
    const exitMin = s.sessionCloseMin - CFG.EXIT_BEFORE_CLOSE_MIN;
    const live = s.mode === "live";

    // overnight carry: close at the open
    if (s.carry.length && p.min >= 9 * 60 + 30.5 && p.min < exitMin) {   // any mode: a carried position is real shares
      for (const c of s.carry) if (openQty(c) > 0 && !c.closeOrderId) await closeMarket(c, s, "stale-overnight", log);
    }
    // universe
    if (!s.scanned && p.min >= CFG.BUILD_FROM_MIN && p.min < CFG.SCAN_LAST_MIN && (!_universe || _universe.day !== p.day)) {
      if (_buildFailAt && Date.now() - _buildFailAt < 60000) return;
      try { await buildUniverse(p.day, log); _buildFailAt = 0; s.built = true; s.universeSize = Object.keys(_universe.syms).length; markDirty(); }
      catch (e) { _buildFailAt = Date.now(); log("warn", `[SIP] universe build failed: ${e.message} — retrying in 60s`); return; }
    }
    // scan + entries
    if (!s.scanned && p.min >= CFG.SCAN_FROM_MIN) {
      if (p.min >= CFG.SCAN_LAST_MIN || !_universe || _universe.day !== p.day) {
        s.scanned = true; s.skipped = s.skipped || (p.min >= CFG.SCAN_LAST_MIN ? "missed the 9:35 window (process restarted / data late)" : "no universe");
        log("warn", `[SIP] ${p.day}: no stocks-in-play trades today — ${s.skipped}`); markDirty();
        // a restart can lose the record of orders placed seconds before it: cancel any of today's sleeve orders still resting
        try {
          const open = await getJSON(io().trade, "/orders?status=open&limit=500", 2);
          const mine = (open || []).filter(o => isSipOrder(o) && o.client_order_id.startsWith(`sip-${p.day.replace(/-/g, "")}-`));
          for (const o of mine) await io().del(`/orders/${o.id}`);
          if (mine.length) log("error", `[SIP] cancelled ${mine.length} untracked sleeve order(s) from today — CHECK ALPACA for share positions: ${[...new Set(mine.map(o => o.symbol))].join(", ")}`);
        } catch (_) {}
      } else {
        const syms = Object.keys(_universe.syms);
        const fb = await multiBars(syms, "5Min", iso(etToUtcMs(p.day, 9, 30)), iso(etToUtcMs(p.day, 9, 31)));
        const first = {};
        for (const sym of syms) { const b = (fb[sym] || []).find(x => etParts(Date.parse(x.t)).min === 570); if (b) first[sym] = b; }
        if (Object.keys(first).length < syms.length * 0.5) { log("scan", `[SIP] 9:30 bars not complete yet (${Object.keys(first).length}/${syms.length}) — retrying`); return; }
        s.cands = selectCandidates(_universe.syms, first);
        s.scanned = true; s.scannedAt = iso(Date.now());
        log("scan", `[SIP] ${p.day} stocks in play: ${s.cands.length} (RVol >= ${CFG.RVOL_MIN * 100}%) — ${s.cands.map(c => `${c.sym} ${c.rvol}x ${c.side}`).join(", ")} | mode ${s.mode.toUpperCase()}`);
        if (live) await placeEntries(s, log);
        else for (const c of s.cands) if (c.side !== "doji") c.status = "shadow";
        await saveNow();   // order ids must survive a restart in the next seconds
      }
    }
    // 11/03 (Harrison): live price for every candidate, once a minute, for the dashboard ("how are they doing now")
    if (s.scanned && s.cands.length && p.min >= 9 * 60 + 30 && p.min < s.sessionCloseMin + 1 && Date.now() - _lastPxAt >= 60000) {
      _lastPxAt = Date.now();
      try { await refreshLast(s); } catch (_) { /* display only — never blocks trading */ }
    }
    // intraday order management
    if ((live || s.carry.length) && p.min >= 9 * 60 + 30 && p.min < s.sessionCloseMin + 5 && [...s.cands, ...s.carry].some(c => c.entryOrderId || c.stopOrderId || c.closeOrderId)) {
      try { await poll(s, log); markDirty(); } catch (e) { log("warn", `[SIP] order poll failed: ${e.message}`); }
    }
    // 11/03: profit lock / trail / safety net on open positions (live), every tick until the exit passes
    if ((live || s.carry.length) && s.exitPass < 1 && p.min >= 9 * 60 + 30 && p.min < exitMin) {
      try { await manageExits(s, log); markDirty(); } catch (e) { log("warn", `[SIP] exit management failed: ${e.message}`); }
    }
    // exit passes
    if (live && s.scanned && s.exitPass < 1 && p.min >= exitMin) { await exitPass(s, 1, log); await saveNow(); }
    else if (live && s.exitPass === 1 && p.min >= exitMin + 1) {
      await exitPass(s, 2, log); await saveNow();
      const left = [...s.cands, ...s.carry].filter(c => openQty(c) > 0);
      if (left.length) log("error", `[SIP] ${left.length} share position(s) still open after the final exit pass: ${left.map(c => c.sym).join(", ")} — CHECK ALPACA`);
    }
    // ideal replay + summary
    if (s.scanned && !s.simulated && !s.skipped && p.min >= s.sessionCloseMin + 1) {
      s.simulated = true;
      try { await simulateDay(s, log); } catch (e) { s.summary = summarize(s); log("warn", `[SIP] ideal replay failed: ${e.message}`); }
      markDirty();
    }
  } catch (e) {
    log("error", `[SIP] tick error: ${e && e.message}`);
  } finally { _busy = false; }
}

// emergency: cancel every sip order and market-close every sleeve position now
async function flattenAll(state, log, why = "emergency") {
  const s = state && state._sip; if (!s) return 0;
  s.exitPass = Math.max(s.exitPass || 0, 1);
  let n = 0;
  const sent = [];
  for (const c of [...s.cands, ...s.carry]) {
    if (c.status === "working" && c.entryOrderId) { c._weCancelledEntry = true; await io().del(`/orders/${c.entryOrderId}`); sent.push(c.entryOrderId); }
    if (c.stopOrderId) { c._weCancelledStop = true; await io().del(`/orders/${c.stopOrderId}`); sent.push(c.stopOrderId); }
  }
  if (sent.length) await waitTerminal(sent);
  try { await poll(s, log); } catch (_) {}
  for (const c of [...s.cands, ...s.carry]) if (openQty(c) > 0 && !c.closeOrderId) { await closeMarket(c, s, why, log); n++; }
  log("circuit", `[SIP] ${why}: ${n} share position(s) sent to market`);
  return n;
}

// ───────────────────────── reporting ─────────────────────────
const CSV_HEAD = "day,mode,rank,symbol,side,rvol,atr,entryLevel,stopDist,qty,status,fillPx,exitPx,exitReason,pnl,R,idealEntered,idealEntry,idealExit,idealReason,idealR,entrySlipR,slipR,peakR,lockR,late,stopRejectMsg";
function eodCSV(s) {
  if (!s || !Array.isArray(s.cands)) return "";
  const f = (x, d = 2) => (x == null || Number.isNaN(x) ? "" : typeof x === "number" ? x.toFixed(d) : `"${String(x).replace(/"/g, "'")}"`);
  const lines = [CSV_HEAD];
  for (const c of [...s.cands, ...s.carry]) {
    const i = c.ideal || {};
    lines.push([s.day, s.mode, c.rank || "", c.sym, c.side, f(c.rvol), f(c.atr), f(c.entry), f(c.stopDist, 4), c.qty || 0, f(c.status),
                f(c.fillPx), f(c.exitPx), f(c.exitReason), f(c.pnl), f(c.R, 3), i.entered == null ? "" : i.entered, f(i.entryPx), f(i.exitPx),
                f(i.reason), f(i.R, 3), f(c.entrySlipR, 3), f(c.slipR, 3), f(c.peakR), f(c.floorR), c.late ? "Y" : "", f(c.stopRejectMsg)].join(","));
  }
  return lines.join("\n");
}
function eodSection(s) {
  if (!s || !CFG.ENABLED) return "";
  const m = s.summary || summarize(s);
  const td = (x) => `<td style="padding:2px 6px;border-bottom:1px solid #223">${x == null ? "—" : x}</td>`;
  const rows = s.cands.filter(c => c.side !== "doji").map(c => `<tr>${[c.rank, c.sym, c.side, c.rvol + "x", c.status,
    c.pnl != null ? `${c.pnl >= 0 ? "+" : ""}$${c.pnl.toFixed(2)}` : "", c.R != null ? c.R + "R" : "", c.ideal ? (c.ideal.entered ? c.ideal.R + "R" : "no trigger") : "",
    c.slipR != null ? c.slipR + "R" : ""].map(td).join("")}</tr>`).join("");
  return `<div style="margin:14px 0;font-family:monospace;font-size:11px;color:#cde">
<div style="font-weight:bold;color:#9cf">STOCKS IN PLAY — opening-range breakout, shares (Zarattini, Barbon &amp; Aziz 2024) · ${s.mode.toUpperCase()} · sleeve $${CFG.SLEEVE_USD.toLocaleString()} · exit ${CFG.EXIT_MODE === "hold" ? "paper (stop, else the close)" : `stop -1R; at +${CFG.LOCK_AT_R}R lock ${CFG.LOCK_FLOOR_R}R; from +${CFG.TRAIL_FROM_R}R trail ${CFG.TRAIL_R}R; safety net -${CFG.HARD_CAP_R}R`}</div>
${s.skipped ? `<div>No trades: ${s.skipped}</div>` : `<div>${m.candidates} in play (${m.dojis} doji, ${m.noBorrow} not borrowable) · ${m.triggered} traded, ${m.wins} won · actual ${m.actualPnl >= 0 ? "+" : ""}$${m.actualPnl} (${m.actualR}R) · paper's ideal ${m.idealR}R on ${m.idealTrades} triggers (${m.idealRTraded}R on the ones traded) · slippage ${m.slipRPerTrade != null ? m.slipRPerTrade + "R/trade" : "n/a"}</div>
<table style="border-collapse:collapse;margin-top:4px"><tr>${["#", "sym", "side", "RVol", "status", "P&amp;L", "R", "ideal R", "slip R"].map(td).join("")}</tr>${rows}</table>
${s.variants ? `<div style="margin-top:8px;font-weight:bold;color:#9cf">Exit variants on the same entries ($12.50 = 1R each) — gross = ideal fills; NET = entry ${CFG.COST_ENTRY_ATR} ATR + stop exit ${CFG.COST_EXIT_ATR} ATR + close ${CFG.COST_CLOSE_ATR} ATR slippage</div><table style="border-collapse:collapse"><tr>${["rule", "trades", "won", "gross R", "gross $", "NET R", "NET $"].map(td).join("")}</tr>${Object.values(s.variants).map(v => `<tr>${[v.label, v.trades, (v.winPct != null ? v.winPct + "%" : ""), (v.R >= 0 ? "+" : "") + v.R + "R", (v.usd >= 0 ? "+" : "-") + "$" + Math.abs(v.usd).toFixed(2), v.Rnet != null ? (v.Rnet >= 0 ? "+" : "") + v.Rnet + "R" : "", v.usdNet != null ? (v.usdNet >= 0 ? "+" : "-") + "$" + Math.abs(v.usdNet).toFixed(2) : ""].map(td).join("")}</tr>`).join("")}</table>` : ""}`}
</div>`;
}

module.exports = { CFG, tick, cashAdjustment, flattenAll, isSipOrder, eodCSV, eodSection, replayToday, EXIT_VARIANTS,
                   _t: { etParts, etToUtcMs, dailyStats, sizePosition, selectCandidates, simulate, summarize, setIO, freshDay, poll, exitPass, placeEntries, recordExit, closeMarket, brokerQty, refreshLast, simulateExit, replayVariants, manageExits, moveStop, hardCap, lockFloorR, stopPxFor,
                         resetOto: () => { _otoUnsupported = false; },
                         setUniverse: (u) => { _universe = u; }, NON_COMMON_RE } };
