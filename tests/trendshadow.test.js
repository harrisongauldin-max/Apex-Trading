// Trend-swing shadow book (10/14). The real trendShadow.js against a mocked option-quote feed and a pinned clock:
// entry priced from the contract findContract picks, the live stop distance (3.5 ATR, clamped), the 15:50 chandelier
// (once a day), the underlying stop, the 21-DTE roll that carries the stop, P&L per contract at the mid and ask-to-bid,
// a missing quote, the cooldown from the shadow book's own exits, and the summary the EOD email uses. No orders.
"use strict";
const H = require("./helpers"); H.quiet();

// ---- quotes + clock, installed before the module loads ----
const QUOTES = {};
const calls = H.mockBroker({ get: (u) => {
  const m = /symbols=([^&]+)/.exec(u); if (!m) return null;
  const q = QUOTES[m[1]]; return q ? { snapshots: { [m[1]]: { latestQuote: { bp: q[0], ap: q[1] } } } } : { snapshots: {} };
} });
let NOW = { day: "2026-10-15", h: 11 };
const sigP = require.resolve(H.R("signals.js"));
const sig = require(sigP);
require.cache[sigP].exports = { ...sig, getETTime: () => { const [y, m, d] = NOW.day.split("-").map(Number); return new Date(y, m - 1, d, Math.floor(NOW.h), Math.round((NOW.h % 1) * 60), 0); } };

const { state } = require(H.R("state.js"));
const TS = require(H.R("trendShadow.js"));
const DAYCTX = require(H.R("dayContext.js"));

const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
let picks = 0;
const findContract = async (tk, side, d, dte, vix, stock) => {
  picks++;
  if (!stock || stock._isTrend !== side) throw new Error("stock not flagged as trend (delta band would be wrong)");
  return picks === 1 ? { symbol: "QQQ261211C00720000", strike: 720, expDate: isoIn(60), premium: 40, bid: 39.8, ask: 40.2, greeks: { delta: 0.65 } }
                     : { symbol: "QQQ270115C00730000", strike: 730, expDate: isoIn(62), premium: 38, bid: 37.8, ask: 38.2, greeks: { delta: 0.64 } };
};
const ctx = { findContract, vix: 16, stock: { ticker: "QQQ" }, atr: 10, reason: "daily uptrend" };

(async () => {
  try {
    state._trendShadow = null; state.equity = 86000;
    const nOrdersBefore = calls.post.length;

    // 1. open: priced from the picked contract; stop = live clamp (0.65*35/40 = 57% -> 55% -> 0.55*40/0.65 = $33.85 below)
    const r = await TS.open("QQQ", "call", 730, ctx);
    const t = r.trade;
    H.ok(r.opened && t.legs[0].entryMid === 40 && Math.abs(t.ch.stopPx - (730 - 0.55 * 40 / 0.65)) < 0.02 && t.sizeCt === 1,
      "open: real contract at the mid, stop = live clamped 3.5-ATR distance, live size recorded", JSON.stringify({ stop: t.ch.stopPx, size: t.sizeCt }));
    H.ok(TS.hasOpen("QQQ") && !(await TS.open("QQQ", "call", 731, ctx)).opened, "one shadow trade per ticker at a time");
    H.ok(calls.post.length === nOrdersBefore, "no order of any kind is sent");

    // 2. intraday dip above the stop: holds; no chandelier before 15:50
    NOW = { day: "2026-10-15", h: 11 }; await TS.step("QQQ", 712, ctx);
    H.ok(TS.hasOpen("QQQ"), "intraday dip above the underlying stop: holds");

    // 3. 15:50 check: holds, ratchets the high, marks the option
    QUOTES["QQQ261211C00720000"] = [44.8, 45.2];
    NOW = { day: "2026-10-15", h: 15.85 }; await TS.step("QQQ", 740, ctx);
    const o = TS.book().open[0];
    H.ok(o && o.ch.hi === 740 && o.ch.lastDay === "2026-10-15" && o.lastMark.mid === 45, "15:50 check: holds, high close 740, marked at $45", JSON.stringify(o && o.ch));
    await TS.step("QQQ", 709, ctx);
    H.ok(TS.hasOpen("QQQ"), "same day, later scan below the level: not re-judged today (once a day, like live)");

    // 4. next day 15:50, close 3 ATR below the high (740 - 30 = 710) -> chandelier exit, priced from the quote
    QUOTES["QQQ261211C00720000"] = [33.8, 34.2];
    NOW = { day: "2026-10-16", h: 15.85 }; await TS.step("QQQ", 709, ctx);
    const c = TS.book().closed[0];
    H.ok(!TS.hasOpen("QQQ") && c && c.exitReason === "trend-chandelier" && c.pnl === -600 && c.pnlCons === -640 && c.pnlAtSize === -600,
      "chandelier exit at the close-check: P&L -$600 per contract at the mid, -$640 ask-to-bid", JSON.stringify({ pnl: c && c.pnl, cons: c && c.pnlCons }));

    // 5. cooldown from the shadow book: an exit today blocks; a long-past exit doesn't
    c.exitDay = DAYCTX.etDateStr(Date.now());
    H.ok(/shadow re-entry cooldown/.test(TS.cooldown("QQQ") || ""), "cooldown: blocked right after a shadow exit");
    c.exitDay = "2026-01-02";
    H.ok(TS.cooldown("QQQ") === null && TS.cooldown("SPY") === null, "cooldown: clear 5+ trading days later, other ticker unaffected");

    // 6. underlying stop, any time of day; no quote -> priced at the last mark and flagged
    picks = 0; const r2 = await TS.open("QQQ", "call", 730, ctx);
    delete QUOTES["QQQ261211C00720000"];
    NOW = { day: "2026-10-19", h: 10.5 }; await TS.step("QQQ", r2.trade.ch.stopPx - 0.5, ctx);
    const c2 = TS.book().closed[1];
    H.ok(c2 && c2.exitReason === "trend-stop" && c2.legs[0].priceSrc === "last-mark" && c2.pnl === 0,
      "underlying through the stop -> trend-stop; no quote -> priced at the last mark (flagged)", JSON.stringify({ r: c2 && c2.exitReason, src: c2 && c2.legs[0].priceSrc }));

    // 7. roll at 21 DTE: closes the leg, opens a fresh ~60 DTE contract, the stop and high carry over
    picks = 0; const r3 = await TS.open("QQQ", "call", 730, ctx);
    const t3 = TS.book().open[0]; t3.legs[0].expDate = isoIn(20); t3.ch.hi = 760;
    QUOTES["QQQ261211C00720000"] = [49.8, 50.2];
    NOW = { day: "2026-10-20", h: 11 }; await TS.step("QQQ", 755, ctx);
    H.ok(t3.legs.length === 2 && t3.legs[0].exitMid === 50 && t3.legs[1].symbol === "QQQ270115C00730000" && t3.ch.stopPx === r3.trade.ch.stopPx && t3.ch.hi === 760 && t3.ch.rolls === 1 && TS.hasOpen("QQQ"),
      "21 DTE: roll — old leg closed at $50, new contract opened, stop + high carried, still one trade");
    QUOTES["QQQ270115C00730000"] = [41.8, 42.2];
    NOW = { day: "2026-10-20", h: 15.85 }; await TS.step("QQQ", 729, ctx);   // 760 - 30 = 730 -> exit
    const c3 = TS.book().closed[2];
    H.ok(c3 && c3.exitReason === "trend-chandelier" && c3.legs.length === 2 && c3.pnl === 1000 + 400,
      "P&L sums both legs (+$1,000 first leg, +$400 second)", JSON.stringify({ pnl: c3 && c3.pnl }));

    // 8. summary (EOD email) and persistence in state
    const s = TS.summary();
    H.ok(s.totals.n === 3 && s.totals.wins === 1 && s.totals.pnl === 800 && s.open.length === 0, "summary totals for the EOD section", JSON.stringify(s.totals));
    const round = JSON.parse(JSON.stringify(state._trendShadow));
    H.ok(round.closed.length === 3 && round.closed[2].legs.length === 2, "the book lives in state (saved with it, survives a restart)");

    const html = require(H.R("reporting.js")).buildTrendShadowSection({ trendShadow: s });
    H.ok(/Trend-swing shadow \(no orders\)/.test(html) && /3 closed · 1 won · \+\$800/.test(html) && /trend-chandelier/.test(html), "EOD email section renders the shadow book");
    H.ok(require(H.R("reporting.js")).buildTrendShadowSection({ trendShadow: { open: [], closed: [], totals: { n: 0 } } }) === "", "EOD section is omitted while the book is empty");

    // 9. live sizing would have skipped it -> no shadow entry either
    state.equity = 40000; picks = 0;
    const r4 = await TS.open("QQQ", "call", 730, ctx);   // 1 contract risks $2,200 = 5.5% > 3%
    H.ok(!r4.opened && r4.why === "risk cap" && !TS.hasOpen("QQQ"), "if live sizing would have skipped the trade, the shadow skips it too");
    state.equity = 86000;

    // 10. scanner + exit-engine wiring (source): shadow entry never calls executeTrade; management runs outside the heat gate
    const sc = H.read("scanner.js"), ex = H.read("exitEngine.js");
    const shadowBranch = H.extractBetween(sc, '} else if (_tSide && !_haveTrend && !_cohBlock && TREND_MODE === "shadow") {', '} else if (_tSide && !_haveTrend && !_cohBlock) {');
    H.ok(/TSHADOW\.open\(/.test(shadowBranch) && !/executeTrade/.test(shadowBranch), "scanner: shadow entry branch opens a shadow trade and places no order");
    const iStep = sc.indexOf("await TSHADOW.step("), iHeat = sc.indexOf("if (heatPct() < effectiveHeatCap() && state.cash > CAPITAL_FLOOR) {\n    // 8/27: TREND-SWING sleeve");
    H.ok(iStep > 0 && iHeat > iStep, "scanner: shadow trades are managed every scan, before (outside) the heat/cash gate");
    H.ok(/const TREND_MODE\s*=\s*"shadow"/.test(H.read("constants.js")) && /trend-retired/.test(ex), "constants: TREND_MODE is shadow; exit engine retires live trend positions");
  } catch (e) { H.ok(false, "trend shadow test crashed", e.stack.split("\n").slice(0, 3).join(" | ")); }
  H.done();
})();
