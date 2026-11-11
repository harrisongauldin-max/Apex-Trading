// Dashboard (public/index.html) in a headless DOM: loads, every tab opens, Market State and Trend Backtest render,
// no JavaScript errors. Needs jsdom (dev-only, not an APEX dependency): `npm install --no-save jsdom@24`.
// Without it this file SKIPS rather than failing.
"use strict";
const H = require("./helpers"); H.quiet();
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); }
catch (_) { console.log("  SKIP  dashboard test — jsdom not installed (npm install --no-save jsdom@24)"); process.exit(0); }
const html = H.read("public/index.html");
const now = Date.now();
const routes = {
  "/api/state": { cash: 82000, vix: 15.3, positions: [{ ticker: "SPY", optionType: "call", strike: 768, premium: 25.72, currentPrice: 24, contracts: 2, expDate: "2026-11-30", openDate: new Date(now - 864e5 * 6).toISOString(), entryStrategy: "trend-swing", displayPnL: -344 }],
                  closedTrades: [{ ticker: "QQQ", optionType: "call", pnl: 29, reason: "mr-fade-lock", closeTime: now - 3600e3, entryStrategy: "mr-fade-lit" }], heatPct: 6, heatCap: 30, sipHeat: { risk: 120, notional: 61000, long: 40000, short: 21000, n: 9, pct: 0.15 } },
  "/api/market-state": { etTime: "11:20", marketOpen: true, event: "", vix: { value: 15.3, source: "anchored", term9d: 0.78, term3m: 0.85 },
                         internals: { intAdvPct: 62, intVwapPct: 55, intUpMinPct: 48, intCumTick: 120 },
                         tickers: { SPY: { gex: { regime: "pos", netGexM: 1800, flip: 766, distFlipPct: 0.2 } }, QQQ: { gex: null } },
                         gates: { itrend: { window: "10:00-12:00 ET", open: true, adxMinNow: 40, negGammaBlocked: [] }, mrFade: { open: true, cutoff: "15:15 ET" }, trendSwing: { open: true, cutoff: "15:00 ET", cooldown: { SPY: "2026-10-19" }, tickers: ["QQQ"], exitMode: "chandelier", rollPending: [] } },
                         sleeves: { "mr-fade-lit": { closed: 1, wins: 1, pnl: 29, open: 0, openPnl: 0 } } },
  "/api/journal": { trades: [], summary: {} }, "/api/logs": { logs: [] },
  "/api/sip": { cfg: { ENABLED: true, MODE: "live", SLEEVE_USD: 25000 }, cashAdj: 0, day: { day: "2026-11-03", mode: "live", built: true, scanned: true, universeSize: 1412, carry: [],
    cands: [{ rank: 1, sym: "NBIX", side: "long", rvol: 6.2, entry: 120.5, qty: 41, status: "closed", filledQty: 41, exitQty: 41, fillPx: 120.62, exitPx: 119.9, exitReason: "stop-reject", pnl: -29.52, R: -2.4, stopRejectMsg: "stop price must not be greater than current price" },
            { rank: 2, sym: "AAA<b>", side: "short", rvol: 4.1, entry: 30.1, qty: 62, status: "open", filledQty: 62, exitQty: 0, fillPx: 30.08, stopPx: 30.28 },
            { rank: 3, sym: "CCC", side: "short", rvol: 3.3, entry: 29.6, qty: 62, status: "no-borrow (simulated only)" }],
    last: { NBIX: { px: 122.0, at: "2026-11-03T16:15:00Z" }, "AAA<b>": { px: 29.9, at: "2026-11-03T16:15:00Z" }, CCC: { px: 29.0, at: "2026-11-03T16:15:00Z" } } } },
};
const T = require(H.R("trendBacktest.js"));
const mkBars = (px) => { const b = []; let d = new Date("2018-01-02T05:00:00Z"), s = 3; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 900; i++) { const o = px, c = px * (1 + (r() - 0.48) * 0.02); b.push({ t: d.toISOString(), o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c }); px = c; d = new Date(d.getTime() + 864e5); } return b; };
routes["/api/sip/replay"] = { day: "2026-11-03", asOf: "12:20 ET", final: false, live: { trades: 13, wins: 0, usd: -266.49, R: -21.6 },
  totals: { paper: { label: "Paper: 10% ATR stop, hold to close", trades: 13, wins: 1, R: -10.2, usd: -127.5, winPct: 8 },
            or: { label: "Opening-range stop, hold to close", trades: 13, wins: 6, R: 3.4, usd: 42.5, winPct: 46, Rnet: 1.2, usdNet: 15.0 } },
  costs: { entryAtr: 0.15, exitAtr: 0.1, closeAtr: 0.02 },
  history: { days: 2, first: "2026-11-05", last: "2026-11-06", liveRule: "noiseA", live: { n: 20, w: 9, R: 1.5, u: 18.75 },
             nights: { neg: 1, pos: 1 },
             rules: [{ key: "noiseA", label: "Noise A: stop 1N", days: 2, trades: 20, wins: 9, R: 6, usd: 75, tradesNet: 20, winsNet: 9, Rnet: 2.4, usdNet: 30, posDaysNet: 1, netRPerTrade: 0.12,
                       gamma: { neg: { days: 1, n: 10, Rnet: 3.1 }, pos: { days: 1, n: 10, Rnet: -0.7 } } }] },
  perTrade: { BLZE: { paper: { entered: true, R: -1, reason: "stop" }, or: { entered: true, R: 2.1, reason: "still open (marked)", peakR: 2.6 } } } };
routes["/api/trend-backtest"] = { start: "2018-01-01", end: "2026-10-09", ...T.runStudy({ SPY: mkBars(200), QQQ: mkBars(100) }) };

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(String(e.message || e).split("\n")[0]));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, url: "http://localhost/",
  beforeParse(w) {
    w.fetch = async (u) => { const p = String(u).split("?")[0]; const body = routes[p] || {}; return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), blob: async () => ({}) }; };
    w.onerror = (m) => errors.push("onerror " + m);
    w.Chart = function () { return { destroy() {}, update() {} }; };
    w.HTMLCanvasElement.prototype.getContext = function () { return new Proxy({ canvas: this }, { get: (t, k) => k in t ? t[k] : (k === "measureText" ? () => ({ width: 10 }) : () => ({ addColorStop() {} })), set: () => true }); };
    w.alert = () => {}; w.confirm = () => true; w.prompt = () => "k";
  } });
const w = dom.window;
(async () => {
  await H.sleep(1500);
  const tabs = [...w.document.querySelectorAll('[onclick^="switchTab"]')].map(b => b.getAttribute("onclick").match(/'([a-z]+)'/)[1]);
  for (const t of tabs) { try { w.switchTab(t); } catch (e) { errors.push(`switchTab(${t}): ${e.message}`); } await H.sleep(200); }
  H.ok(tabs.length >= 7, "tabs present", tabs.join(", "));
  w.switchTab("trading"); await H.sleep(200);
  const ms = w.document.getElementById("ms-card");
  H.ok(ms && /POS γ/.test(ms.textContent) && /Intraday-trend/.test(ms.textContent), "Market State panel renders");
  H.ok(ms && /SPY cooling down until 10\/19/.test(ms.textContent) && /QQQ only · 3-ATR chandelier exit/.test(ms.textContent), "Market State shows trend-swing mode (QQQ only, chandelier) and cooldown");
  if (tabs.includes("trendbt")) {
    w.switchTab("trendbt"); await w.runTrendBacktestTab(); await H.sleep(100);
    const box = w.document.getElementById("tbt-results"), n = box.querySelectorAll("table").length;
    H.ok(n === 12 && /OPTION-PRICED/.test(box.textContent) && /VALIDATION/.test(box.textContent) && /opencool/.test(box.textContent) && box.querySelector("details"),
      "Trend Backtest tab: option-priced tables, validation card, old tables folded below", `${n} tables`);
  }
  w.switchTab("trading"); await w.fetchSip(); await H.sleep(100);   // 11/03: stocks-in-play panel
  const sp = w.document.getElementById("sip-wrap"), st = w.document.getElementById("sip-title");
  H.ok(sp && /NBIX/.test(sp.textContent) && /stop-reject/.test(sp.textContent) && /realized -\$29\.52/.test(sp.textContent) && /OPEN 62 sh/.test(sp.textContent) && /no-borrow/.test(sp.textContent),
       "Stocks-in-play panel: closed, open and simulated-only rows, realized P&L", sp && sp.textContent.slice(0, 160));
  H.ok(st && /1 open/.test(st.textContent) && !sp.querySelector("b b") && /AAA&lt;b&gt;/.test(sp.innerHTML), "panel title counts open shares; symbols are HTML-escaped");
  H.ok(/\$122\.00/.test(sp.textContent) && /\+1\.14%/.test(sp.textContent) && /\+0\.60%/.test(sp.textContent) && /\+2\.03% vs entry/.test(sp.textContent),
       "Now + If held: NBIX long fill 120.62 -> now 122.00 = +1.14% if held; open short 30.08 -> 29.90 = +0.60%; unfilled CCC short 2.03% past its level", (sp.textContent.match(/[-+]\d+\.\d+%( vs entry)?/g) || []).join(" "));
  H.ok(/-0\.60%/.test(sp.textContent) && /-0\.12% of sleeve/.test(sp.textContent), "% column: NBIX long 120.62 -> 119.90 = -0.60%; day = -0.12% of the $25K sleeve", sp.textContent.match(/[-+]\d+\.\d+%[^R]{0,20}/g));
  await w.runSipReplay(); await H.sleep(50);
  const rp = w.document.getElementById("sip-replay");
  H.ok(rp && /Net P&L/.test(rp.textContent) && /\+\$15\.00/.test(rp.textContent), "replay shows gross AND net columns", rp && rp.textContent.slice(0, 80));
  H.ok(rp && /★ Opening-range stop/.test(rp.textContent) && /Actual live today/.test(rp.textContent) && /-\$266\.49/.test(rp.textContent) && /BLZE/.test(rp.textContent) && /still open \(marked\)/.test(rp.textContent),
       "Replay exits: rules table (best starred), live row, per-trade grid", rp && rp.textContent.slice(0, 140));
  // 11/04: Copy for Claude + Save CSV (stocks table and replay)
  let copied = "", saved = [];
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
  w._saveFile = (name, text) => saved.push({ name, text });
  await w.fetchSip(); w.copySip(); await H.sleep(20);
  H.ok(/^APEX stocks-in-play 2026-11-03/.test(copied) && /\tNBIX\t/.test(copied) && /stop-reject/.test(copied) && /^day\tmode\trank\tsymbol/m.test(copied) && /stop price must not be greater/.test(copied),
       "Copy for Claude: header + tab-separated table incl. exit reason and rejection text", copied.split("\n").slice(0, 2).join(" | "));
  w.downloadSipCsv();
  H.ok(saved[0] && saved[0].name === "apex-stocksinplay-2026-11-03.csv" && /^day,mode,rank,symbol/.test(saved[0].text) && saved[0].text.split("\n").filter(Boolean).length === 4 && /"AAA<b>"|AAA<b>/.test(saved[0].text),
       "Save CSV: stocks table, one row per candidate", saved[0] && saved[0].name);
  await w.runSipReplay(); copied = ""; w.copySipReplay(); await H.sleep(20); w.downloadSipReplayCsv();
  H.ok(/exit replay 2026-11-03/.test(copied) && /Opening-range stop, hold to close\tor\t/.test(copied) && /^symbol\tpaper_R/m.test(copied) && /BLZE\t-1\t\tstop/.test(copied),
       "Replay Copy for Claude: rules table + per-trade grid", copied.split("\n").slice(0, 1).join(""));
  H.ok(saved[1] && saved[1].name === "apex-sip-replay-2026-11-03.csv" && /^rule,key,live,trades,won,winPct,grossR,grossPnl,netR,netPnl/.test(saved[1].text) && /symbol,paper_R,paper_netR,paper_exit/.test(saved[1].text), "Replay Save CSV: rules + grid", saved[1] && saved[1].name);
  H.ok(w.document.getElementById("sip-replay-tools").style.display === "inline", "replay buttons appear once a replay has run");
  H.ok(/Running totals/.test(rp.textContent) && /Noise A: stop 1N ← LIVE RULE/.test(rp.textContent) && /1\/2/.test(rp.textContent), "replay shows the multi-night running totals, live rule marked", rp.textContent.slice(-200));
  H.ok(/gamma: 1 negative, 1 positive/.test(rp.textContent) && /Net R, neg γ/.test(rp.textContent) && /\+3\.1/.test(rp.textContent) && /-0\.7/.test(rp.textContent), "running totals split by gamma regime (11/08)", rp.textContent.slice(-260));
  H.ok(/netR_negGamma\tnetR_posGamma/.test(copied) && /\t3\.1\t-0\.7/.test(copied), "gamma split in Copy for Claude");
  H.ok(/RUNNING TOTALS 2026-11-05 to 2026-11-06 \(2 nights/.test(copied) && /Noise A: stop 1N\tnoiseA\tLIVE\t2\t20\t9/.test(copied) && /daysNetPositive/.test(saved[1].text), "running totals in Copy for Claude and the CSV");
  const shEl = w.document.getElementById("stock-heat");
  H.ok(shEl && shEl.textContent === "S:0.1%" && /9 share positions · \$120 at risk/.test(shEl.title) && /\$61,000 notional/.test(shEl.title), "heat card shows the share sleeve (S:%), risk + notional on hover", shEl && shEl.textContent + " | " + shEl.title);
  H.ok(errors.length === 0, "no JavaScript errors", errors.slice(0, 3).join(" | "));
  H.done();
})();
