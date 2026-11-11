// 10/28: cost-based contract selection for intraday-trend (findContract, mocked broker).
"use strict";
const H = require("./helpers"); H.quiet();
const etToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const day = (k) => new Date(Date.parse(etToday + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
// per-DTE quote economics: [spread $, theta $/day]. 0DTE is the cheapest of all — and must never be chosen.
const ECON = { 0: [0.01, -0.30], 1: [0.02, -1.20], 3: [0.03, -0.50], 7: [0.05, -0.33], 14: [0.09, -0.25], 21: [0.12, -0.20] };
const URLS = [];
const sym = (k, K) => `SPY${day(k).replace(/-/g, "").slice(2)}C${String(K * 1000).padStart(8, "0")}`;
H.mockBroker({
  get: (u) => {
    URLS.push(u);
    if (u.startsWith("/options/contracts")) {
      const out = [];
      for (const k of Object.keys(ECON).map(Number)) for (let K = 776; K <= 784; K++) out.push({ symbol: sym(k, K), expiration_date: day(k), strike_price: String(K), type: "call" });
      return { option_contracts: out };
    }
    if (u.startsWith("/options/snapshots")) {
      const s = {}; const want = decodeURIComponent(u.split("symbols=")[1].split("&")[0]).split(",");
      for (const x of want) {
        const k = Object.keys(ECON).map(Number).find(k => x.includes(day(k).replace(/-/g, "").slice(2)));
        const K = parseInt(x.slice(-8)) / 1000; const [spr, th] = ECON[k];
        const delta = Math.max(0.05, Math.min(0.95, 0.5 - (K - 780) * (k <= 1 ? 0.12 : 0.04)));
        const mid = 2 + k * 0.4;
        s[x] = { latestQuote: { bp: +(mid - spr / 2).toFixed(3), ap: +(mid + spr / 2).toFixed(3) }, greeks: { delta, theta: th, gamma: 0.02, vega: 0.3 }, impliedVolatility: 0.15, openInterest: 0 };
      }
      return { snapshots: s };
    }
    return undefined;
  },
});
const S = require(H.R("state.js")); const LOG = []; S.logEvent = (t, m) => LOG.push(t + ": " + m);
const ex = require(H.R("execution.js"));
const C = require(H.R("constants.js"));
(async () => {
  H.ok(C.ITREND_COST_SELECT === true && C.ITREND_SELECT_DTE_MIN === 1 && C.ITREND_SELECT_DTE_MAX === 21, "selector live: 1-21 DTE");
  const stock = { ticker: "SPY", price: 780, _iTrend: "call" };
  const c = await ex.findContract("SPY", "call", 0.50, 14, 18, stock);
  const cu = URLS.find(u => u.startsWith("/options/contracts")) || "";
  H.ok(c && c.expDate === day(3) && Math.abs(parseFloat(c.greeks.delta)) >= 0.42 && Math.abs(parseFloat(c.greeks.delta)) <= 0.60,
       "picks the cheapest exposure (the 3-day expiry here), inside the accepted delta window", c ? `${c.expDate} $${c.strike} Δ${c.greeks.delta}` : "none");
  H.ok(c && c.expDate !== etToday, "never 0DTE, even though 0DTE quotes were cheapest");
  H.ok(cu.includes(`expiration_date_gte=${day(1)}`) && cu.includes(`expiration_date_lte=${day(21)}`) && /strike_price_gte=764\.40&strike_price_lte=795\.60/.test(cu),
       "chain request: tomorrow..21 days out, strikes within ±2% of spot", cu.slice(0, 160));
  const sel = LOG.find(l => /\[ITREND-SELECT\]/.test(l)) || "";
  H.ok(/→ \dDTE/.test(sel) && /vs old rule 1\dDTE/.test(sel) && /saves ~\$\d/.test(sel), "logs the choice, its cost per share, and the saving vs the old 14-DTE pick", sel.slice(0, 200));
  // cost arithmetic on the chosen contract: (spread + |theta| x 20/390) / delta
  const _exp = c ? ((c.ask - c.bid) + 0.50 * 20 / 390) / Math.abs(parseFloat(c.greeks.delta)) : NaN;
  H.ok(c && Math.abs(c._costPerShare - _exp) < 0.002, "score = (spread + |theta| x hold/390) / delta", c && `${c._costPerShare.toFixed(4)} vs ${_exp.toFixed(4)}`);
  H.ok(c && Math.abs(parseFloat(c.greeks.delta)) > 0.5, "per-unit-of-exposure scoring leans to the higher-delta end of the window (less decay per delta)", c && c.greeks.delta);
  // non-intraday-trend entries keep the old window
  URLS.length = 0; LOG.length = 0;
  await ex.findContract("SPY", "call", 0.50, 14, 18, { ticker: "SPY", price: 780 });
  const cu2 = URLS.find(u => u.startsWith("/options/contracts")) || "";
  H.ok(!/strike_price_gte/.test(cu2) && !LOG.some(l => /ITREND-SELECT/.test(l)), "other strategies: selection unchanged");
  // theta missing everywhere -> falls back to closest-delta pick, says so
  for (const k of Object.keys(ECON)) ECON[k][1] = 0;
  LOG.length = 0;
  const c3 = await ex.findContract("SPY", "call", 0.50, 14, 18, { ticker: "SPY", price: 780, _iTrend: "call" });
  H.ok(c3 && LOG.some(l => /no priced candidate with theta/.test(l)), "no greeks: falls back to the closest-delta contract and logs it", c3 ? `${c3.expDays}DTE` : "none");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
