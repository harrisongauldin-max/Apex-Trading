// 11/04: 0DTE (same-day expiry) gamma in the dealer-gamma regime. Alpaca gives no greeks for 0DTE, so APEX prices them:
// implied vol from the mid quote, Black-Scholes gamma at that vol; open interest from the contracts endpoint.
"use strict";
const H = require("./helpers"); H.quiet();
const GEX = require(H.R("gex.js"));

// ---- pricing helpers ----
const T3h = 3 / (365 * 24);
const px = GEX.bsPrice(760, 760, T3h, 0.20, "call");
H.ok(px > 1.05 && px < 1.2, "Black-Scholes: a 3-hour ATM SPY call at 20% vol is ~$1.12 (0.4 x S x vol x sqrt T)", String(px));
H.ok(Math.abs(GEX.impliedVol(px, 760, 760, T3h, "call") - 0.20) < 1e-4, "implied vol round-trips (bisection)");
const pp = GEX.bsPrice(760, 765, T3h, 0.25, "put");
H.ok(Math.abs(GEX.impliedVol(pp, 760, 765, T3h, "put") - 0.25) < 1e-4, "put implied vol round-trips");
H.ok(GEX.impliedVol(0.0001, 760, 700, T3h, "call") === null || GEX.impliedVol(0.0001, 760, 700, T3h, "call") >= 0.01, "a price below intrinsic has no implied vol");
H.ok(GEX.bsGamma(760, 760, T3h, 0.2) > 8 * GEX.bsGamma(760, 760, 30 / 365, 0.2), "ATM 0DTE gamma is many times a 30-day option's — why leaving it out mattered");

// ---- computeGEX with 0DTE rows ----
const today = "2026-11-05", fut = "2026-11-12";
const callF = [{ strike: 760, gamma: 0.02, oi: 1000, exp: fut, iv: 0.18, T: 8 / 365 }];
const putF = [{ strike: 755, gamma: 0.02, oi: 600, exp: fut, iv: 0.19, T: 8 / 365 }];   // future book net POSITIVE (calls > puts)
const callZ = [{ strike: 762, gamma: 0.15, oi: 500, exp: today, iv: 0.2, T: T3h, z0: true }];
const putZ = [{ strike: 758, gamma: 0.15, oi: 2000, exp: today, iv: 0.22, T: T3h, z0: true }];   // 0DTE net NEGATIVE, and large
const g0 = GEX.computeGEX(callF, putF, 760), g1 = GEX.computeGEX([...callF, ...callZ], [...putF, ...putZ], 760);
H.ok(g0.regime === "pos" && g1.regime === "neg" && g1.regimeEx0 === "pos" && g1.net0dteM < 0 && g1.n0dte === 2,
     "0DTE can flip the regime: future book +, with 0DTE -; regimeEx0 reports what it was without", `${g0.regime} -> ${g1.regime} (ex0 ${g1.regimeEx0}, 0DTE ${g1.net0dteM}M)`);
H.ok(g1.callWall === 760 && g1.putWall === 755, "walls ignore 0DTE (the wall-based fades were built on future expiries)", `${g1.callWall}/${g1.putWall}`);
H.ok(g1.regimeNear === g0.regimeNear && g1.netGexNearM === g0.netGexNearM, "'near' keeps its meaning (nearest FUTURE expiry)");
H.ok(g0.n0dte === 0 && g0.regimeEx0 === g0.regime, "no 0DTE rows: regimeEx0 = regime");

// ---- the real fetch, mocked broker, clock set to 11:00 ET today ----
const realNow = Date.now;
const etDay = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const off = /GMT([+-]\d+)/.exec(new Date().toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }));
const elevenET = Date.parse(`${etDay}T11:00:00${off && +off[1] < 0 ? "-" : "+"}${String(Math.abs(off ? +off[1] : -5)).padStart(2, "0")}:00`);
const spot = 760, futD = new Date(elevenET + 7 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const occ = (d, t, k) => `SPY${d.replace(/-/g, "").slice(2)}${t === "call" ? "C" : "P"}${String(Math.round(k * 1000)).padStart(8, "0")}`;
H.mockBroker({
  get: (u) => {
    if (u.startsWith("/options/contracts")) {
      const type = /type=put/.test(u) ? "put" : "call", out = [];
      for (const d of [etDay, futD]) for (let k = 750; k <= 770; k += 5) out.push({ symbol: occ(d, type, k), expiration_date: d, strike_price: String(k), open_interest: d === etDay ? (type === "put" ? 9000 : 3000) : 4000, type });
      return { option_contracts: out };
    }
    if (u.startsWith("/options/snapshots")) {
      const s = {}, m0 = /symbols=([^&]+)/.exec(u);
      for (const x of m0[1].split(",")) {
        const m = /SPY(\d{6})([CP])(\d{8})/.exec(x), K = +m[3] / 1000, t = m[2] === "C" ? "call" : "put";
        const is0 = ("20" + m[1].slice(0, 2) + "-" + m[1].slice(2, 4) + "-" + m[1].slice(4)) === etDay;
        if (is0) { const T = (5 * 3600e3) / (365 * 864e5), p = GEX.bsPrice(spot, K, T, 0.2, t); s[x] = { latestQuote: { bp: +(p * 0.98).toFixed(2), ap: +(p * 1.02).toFixed(2) } }; }   // no greeks, like Alpaca
        else s[x] = { greeks: { gamma: GEX.bsGamma(spot, K, 7 / 365, 0.2) }, impliedVolatility: 0.2, latestQuote: { bp: 1, ap: 1.1 } };
      }
      return { snapshots: s };
    }
    return undefined;
  },
});
const S = require(H.R("state.js")); const st = S.state; const LOG = []; S.logEvent = (t, m) => LOG.push(t + ": " + m);
const EX = require(H.R("execution.js"));
(async () => {
  Date.now = () => elevenET;
  try { await EX.fetchGexChain("SPY", spot); } finally { Date.now = realNow; }
  const gc = st._gexChain && st._gexChain.SPY;
  const z = gc ? [...gc.call.rows, ...gc.put.rows].filter(r => r.z0) : [];
  H.ok(gc && gc.z0 && gc.z0.rows === 10 && z.length === 10 && z.every(r => r.gamma > 0 && Math.abs(r.iv - 0.2) < 0.01 && r.oi > 0),
       "fetch: all 10 same-day contracts priced; IV taken from the out-of-the-money side at each strike recovers the true 20% even for deep in-the-money ones", gc && JSON.stringify(gc.z0) + " " + (z[0] ? JSON.stringify(z[0]) : ""));
  H.ok(LOG.some(l => /\+ 0DTE \(10 priced, 0 skipped, live\)/.test(l)), "fetch log says how many 0DTE contracts were priced", LOG.find(l => /GEX-FETCH/.test(l)));
  const g = GEX.computeGEX(gc.call.rows, gc.put.rows, spot);
  H.ok(g && g.n0dte === 10 && g.net0dteM < 0 && g.regime === "neg", "put-heavy 0DTE open interest pulls the regime negative", g && `${g.regime} 0DTE ${g.net0dteM}M ex0 ${g.regimeEx0}`);
  H.done();
})().catch(e => { Date.now = realNow; console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
