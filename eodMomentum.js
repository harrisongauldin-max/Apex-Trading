// eodMomentum.js — 10/29 (Harrison): END-OF-DAY MOMENTUM, NEGATIVE GAMMA ONLY.
//
// Literature:
//   Baltussen, Da, Lammers & Martens (2021, JFE, "Hedging demand and market intraday momentum"): the return from the
//     prior close to ~3:30pm predicts the LAST 30 MINUTES, and the effect is concentrated when option dealers are
//     net SHORT gamma — their hedging (buy rallies / sell drops) clusters into the close.
//   Gao, Han, Li & Zhou (2018, JFE, "Market intraday momentum"): intraday returns predict the last half hour in SPY.
//   Ni, Pearson, Poteshman & White (2021, RFS): short-gamma liquidity providers -> higher underlying volatility.
// Rule (as in the papers, nothing fitted): at 3:30pm ET, if SPY/QQQ gamma is NEGATIVE, take the sign of the move
// from the prior close to now and buy that direction; hold to the close (exit 3:58pm ET). One trade per ticker/day.
// Instrument: the cost selector's cheapest option for a ~28-minute hold. No stop, no ladder — the papers hold to the
// close; max loss is the premium (1 contract).
// APEX data: harness T2 (noise-area intraday momentum, QQQ, 10 yrs) PASSED; this exact rule has no APEX history yet —
// it is live on PAPER as the test (Harrison 10/29). Kill switch: EODM_ENABLED in constants.js.
"use strict";

const C = (() => { try { return require("./constants"); } catch (_) { return {}; } })();
const CFG = {
  ENABLED:           C.EODM_ENABLED !== false,
  TICKERS:           Array.isArray(C.EODM_TICKERS) ? C.EODM_TICKERS : ["SPY", "QQQ"],
  ENTRY_START_ET:    typeof C.EODM_ENTRY_START_ET === "number" ? C.EODM_ENTRY_START_ET : 15.5,
  ENTRY_END_ET:      typeof C.EODM_ENTRY_END_ET === "number" ? C.EODM_ENTRY_END_ET : 15.5833,
  REQUIRE_NEG_GAMMA: C.EODM_REQUIRE_NEG_GAMMA !== false,
};

const etDay = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const isEodPos = (p) => !!(p && (p._eodMom || p.entryStrategy === "eod-momentum"));
// 10/29: every 3:30 decision goes into the daily stand-down tally (EOD report CSV, strategy "eod-momentum")
function tally(state, reason) {
  try {
    if (!state._standDownTally) state._standDownTally = { brk: {}, mrf: {}, trend: {}, itrend: {} };
    if (!state._standDownTally.eodm) state._standDownTally.eodm = {};
    state._standDownTally.eodm[reason] = (state._standDownTally.eodm[reason] || 0) + 1;
  } catch (_) {}
}

// deps: { state, executeTrade, getStockQuote, getStockBars, logEvent, etHour }
async function runEntry(deps) {
  const { state, executeTrade, getStockQuote, getStockBars, logEvent } = deps;
  const out = [];
  if (!CFG.ENABLED) return out;
  const h = deps.etHour;
  if (!(h >= CFG.ENTRY_START_ET && h < CFG.ENTRY_END_ET)) return out;
  const today = etDay();
  if (!state._eodm || state._eodm.day !== today) state._eodm = { day: today, done: {}, tries: {} };
  // the scanner's account-level entry halts apply here too (this runs from a timer, not the scan loop)
  const _blk = typeof deps.entryBlock === "function" ? deps.entryBlock() : null;
  if (_blk) { tally(state, `blocked — ${_blk}`); logEvent("filter", `[EOD-MOM] no entries — ${_blk}`); return out; }
  for (const tk of CFG.TICKERS) {
    if (state._eodm.done[tk]) continue;
    const tries = (state._eodm.tries[tk] = (state._eodm.tries[tk] || 0) + 1);
    try {
      const regime = (state._gexRegime || {})[tk] || null;
      if (CFG.REQUIRE_NEG_GAMMA && regime !== "neg") {
        state._eodm.done[tk] = `stand-aside (gamma ${regime || "unknown"})`;
        logEvent("filter", `[EOD-MOM] ${tk} stand aside — gamma ${regime || "unknown"} (the end-of-day momentum trade is for NEGATIVE gamma only)`);
        tally(state, `${tk}: stand aside — gamma ${regime || "unknown"}`);
        out.push({ tk, action: "stand-aside", regime }); continue;
      }
      if ((state.positions || []).some(p => p.ticker === tk && isEodPos(p))) { state._eodm.done[tk] = "already open"; continue; }
      const px = await getStockQuote(tk);
      let prevC = null;
      const dc = (state._dayCtx || {})[tk];
      if (dc && dc.day === today && dc.prevClose > 0) prevC = dc.prevClose;
      if (!(prevC > 0) && getStockBars) {
        const bars = await getStockBars(tk, 5);
        const last = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
        const lastDay = last && last.t ? etDay(Date.parse(last.t)) : null;
        // the newest daily bar may be TODAY's partial bar — the prior close is the bar before it
        const pb = lastDay === today ? bars[bars.length - 2] : last;
        prevC = pb && pb.c > 0 ? +pb.c : null;
      }
      if (!(px > 0) || !(prevC > 0)) {
        logEvent("warn", `[EOD-MOM] ${tk} no ${!(px > 0) ? "price" : "prior close"} — retry next minute (attempt ${tries})`);
        out.push({ tk, action: "no-data" }); continue;
      }
      const ret = (px / prevC - 1) * 100;
      if (ret === 0) { state._eodm.done[tk] = "flat day"; logEvent("filter", `[EOD-MOM] ${tk} flat vs prior close — no direction`); continue; }
      const side = ret > 0 ? "call" : "put";
      const reason = `end-of-day momentum: ${tk} ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% from prior close $${prevC.toFixed(2)} at 3:30 in NEGATIVE gamma -> ${side.toUpperCase()} to the close (Baltussen et al. 2021)`;
      logEvent("filter", `[EOD-MOM] ${tk} ${side.toUpperCase()} — ${reason}`);
      const stock = { ticker: tk, isIndex: true, price: px, _eodMom: side, _eodmRet: +ret.toFixed(3), _eodmPrevClose: prevC };
      const ok = await executeTrade(stock, px, 0, [reason], state.vix, side, false, 1.0, null, null, `${tk}-${side}-eodmom-${Date.now()}`);
      tally(state, `${tk}: ${ok ? "ENTERED" : "entry did not complete"} ${side}`);
      if (ok) { state._eodm.done[tk] = "entered"; logEvent("trade", `[EOD-MOM] ${tk} ${side.toUpperCase()} ENTERED — holding to 3:58pm ET`); }
      else logEvent("warn", `[EOD-MOM] ${tk} ${side.toUpperCase()} entry did not complete (attempt ${tries}) — retrying next minute until 3:35`);
      out.push({ tk, action: ok ? "entered" : "failed", side, ret });
    } catch (e) {
      logEvent("warn", `[EOD-MOM] ${tk} entry error: ${e && e.message}`);
      out.push({ tk, action: "error" });
    }
  }
  return out;
}

// pass 1 = 3:58 (sell at the live bid), pass 2 = 3:59 (crossing price); deps: { state, closePosition, logEvent }
async function runExit(deps, pass = 1) {
  const { state, closePosition, logEvent } = deps;
  const open = (state.positions || []).filter(isEodPos);
  for (const pos of open) {
    try {
      logEvent("scan", `[EOD-MOM] ${pos.ticker} closing at the ${pass === 1 ? "3:58" : "3:59 (crossing)"} exit`);
      await closePosition(pos.ticker, "eodm-close", null, pos.contractSymbol || pos.buySymbol, pass >= 2 ? { aggressive: true } : {});
    } catch (e) { logEvent("error", `[EOD-MOM] ${pos.ticker} close failed: ${e && e.message}`); }
  }
  const left = (state.positions || []).filter(isEodPos);
  if (left.length) logEvent(pass >= 2 ? "error" : "warn", `[EOD-MOM] ${left.length} end-of-day position(s) STILL OPEN after the ${pass === 1 ? "3:58" : "3:59"} exit: ${left.map(p => p.contractSymbol || p.ticker).join(", ")}${pass >= 2 ? " — CHECK ALPACA" : " — retrying at 3:59"}`);
  return { closed: open.length - left.length, left: left.length };
}

module.exports = { runEntry, runExit, isEodPos, CFG };
