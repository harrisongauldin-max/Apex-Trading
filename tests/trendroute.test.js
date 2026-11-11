// /api/trend-backtest (10/12): option-pricing inputs and real-price validation, end to end with every outside
// service mocked — Alpaca stock + option bars, Cboe VIX/VIX3M/VXN history, FRED T-bill.
// Checks: rate-limit retry, a rejected batch is split and the bad contract skipped, paging, the live circuit
// breaker path (alpacaGet) is never used for option bars, calibration recovers a planted vol error, and the
// study still runs with Cboe/FRED down.
"use strict";
const H = require("./helpers"); H.quiet();
const TO = require(H.R("trendOptions.js"));

// ---- synthetic market: SPY/QQQ daily bars (adjusted + raw) and index history ----
let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
function mk(px, n) {
  const adj = [], raw = [], idx = {}; let d = Date.parse("2016-01-04T05:00:00Z"), dr = 0, v = 16, f = 0.85;
  for (let i = 0; i < n; i++) {
    if (i % 120 === 0) { const r = rnd(); dr = r < .45 ? .0008 : r < .65 ? -.0008 : 0; }
    const o = px * (1 + g() * .003), c = o * (1 + dr + g() * .009), t = new Date(d).toISOString();
    raw.push({ t, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * .997, c });
    adj.push({ t, o: o * f, h: Math.max(o, c) * 1.003 * f, l: Math.min(o, c) * .997 * f, c: c * f });
    v = Math.max(10, Math.min(45, v + g() * .8 - (v - 17) * .05)); idx[t.slice(0, 10)] = v;
    px = c; f = Math.min(1, f + 0.15 / n);
    do { d += 864e5; } while ([0, 6].includes(new Date(d).getUTCDay()));
  }
  return { adj, raw, idx };
}
const M = { SPY: mk(200, 2700), QQQ: mk(100, 2700) };
const csv = (o, mult) => "DATE,OPEN,HIGH,LOW,CLOSE\n" + Object.entries(o).map(([d, v]) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)},${v},${v},${v},${(v * mult).toFixed(2)}`).join("\n");
const fred = "observation_date,DTB3\n" + Object.keys(M.SPY.idx).map(d => `${d},${d < "2022-03-01" ? "0.10" : "4.50"}`).join("\n") + "\n2026-01-01,.";
// "real" option prices: the model's own price at 1.10x its vol
const series = { VIX: M.SPY.idx, VIX3M: Object.fromEntries(Object.entries(M.SPY.idx).map(([d, v]) => [d, +(v * 1.08).toFixed(2)])),
                 VXN: Object.fromEntries(Object.entries(M.QQQ.idx).map(([d, v]) => [d, +(v * 1.25).toFixed(2)])) };
const ctx = TO.buildContext({ SPY: M.SPY.adj, QQQ: M.QQQ.adj }, { SPY: M.SPY.raw, QQQ: M.QQQ.raw }, { ...series, DTB3: TO.parseSeriesCsv(fred) });
const realM = { ...TO.BASE_MODEL(), ivScale: 1.10 };
function realBars(sym, from, to) {
  const m = sym.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/); if (!m) return [];
  const c = { tk: m[1], type: m[5] === "C" ? "call" : "put", K: +m[6] / 1000, exp: `20${m[2]}-${m[3]}-${m[4]}` }, C = ctx.tickers[m[1]], out = [];
  for (let i = 0; i < C.dates.length; i++) { const d = C.dates[i]; if (d < from || d >= to || d > c.exp) continue;
    out.push({ t: d + "T04:00:00Z", o: TO.mark(ctx, c.tk, c, d, "open", +C.adj[i].o * C.factor[i], realM).px, c: TO.mark(ctx, c.tk, c, d, "close", +C.adj[i].c * C.factor[i], realM).px, v: 10 }); }
  return out;
}

// ---- mocks ----
let cboeDown = false, poison = null, sawRateLimit = false, optionCalls = 0, pagedOnce = false;
const optGets = [];
const resp = (status, body) => ({ ok: status === 200, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body });
const nodeFetch = async (url) => {
  url = String(url);
  if (url.includes("cdn.cboe.com")) {
    if (cboeDown) return resp(403, "blocked");
    if (url.includes("VIX3M_")) return resp(200, csv(M.SPY.idx, 1.08));
    if (url.includes("VXN_")) return resp(200, csv(M.QQQ.idx, 1.25));
    if (url.includes("VIX_")) return resp(200, csv(M.SPY.idx, 1));
    return resp(404, "");
  }
  if (url.includes("fred.stlouisfed.org")) return cboeDown ? resp(500, "") : resp(200, fred);
  if (url.includes("/options/bars")) {
    optionCalls++;
    if (!sawRateLimit) { sawRateLimit = true; return resp(429, { message: "too many" }); }
    const q = new URL(url).searchParams, syms = q.get("symbols").split(","), from = q.get("start"), to = q.get("end");
    if (poison && syms.includes(poison)) return resp(400, { message: "invalid symbol" });
    const page = q.get("page_token");
    const half = (!pagedOnce && syms.length > 4 && !page) ? syms.slice(0, syms.length >> 1) : (page ? syms.slice(syms.length >> 1) : syms);
    const body = { bars: {} }; for (const s of half) { const b = realBars(s, from, to); if (b.length) body.bars[s] = b; }
    if (!pagedOnce && syms.length > 4 && !page) { body.next_page_token = "p2"; }
    if (page) pagedOnce = true;
    return resp(200, body);
  }
  return resp(404, "");
};
const broker = require(H.R("broker.js"));
const fakeBroker = { ...broker, ALPACA_CONN_DROP: Symbol("drop"), alpacaHeaders: () => ({}),
  alpacaGet: async (u) => {
    if (/\/options\//.test(u)) optGets.push(u);
    const m = u.match(/^\/stocks\/(SPY|QQQ)\/bars\?.*adjustment=(all|raw)/); if (!m) return null;
    return { bars: m[2] === "raw" ? M[m[1]].raw : M[m[1]].adj, next_page_token: null };
  } };
const sv = H.read("server.js");
const from = sv.indexOf('app.get("/api/trend-backtest"');
const handlerSrc = H.extractBlock(sv, "async (req, res) =>", { includeHead: true, fromIndex: from });
const logs = [];
const req2 = (m) => m === "node-fetch" ? nodeFetch : m === "./broker" ? fakeBroker : require(H.R(m.replace("./", "") + (m.endsWith(".js") ? "" : ".js")));
const handler = new Function("require", "logEvent", "return (" + handlerSrc + ");")(req2, (t, m) => logs.push(m));
const call = (query) => new Promise((resolve) => {
  const res = { _s: 200, status(s) { this._s = s; return this; }, type() { return this; }, send(b) { resolve({ status: this._s, body: b }); }, json(b) { resolve({ status: this._s, json: b }); } };
  handler({ query }, res);
});

(async () => {
  // plan first so we can poison one real contract
  const TB = require(H.R("trendBacktest.js"));
  const need = TB.optionPlan({ SPY: M.SPY.adj, QQQ: M.QQQ.adj }, {}, { raw: { SPY: M.SPY.raw, QQQ: M.QQQ.raw }, series });
  poison = Object.keys(need).sort((a, b) => (need[a][0] < need[b][0] ? -1 : 1))[3];

  const t0 = Date.now();
  const a = await call({ format: "json", start: "2016-01-01" });
  const j = a.json || {}, v = (j.option || {}).validation || {}, fx = v.fetch || {};
  H.ok(a.status === 200 && j.results && j.results.length === 14, "route returns the study (7 variants x 2 exit sets)", `status ${a.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  H.ok(/Cboe VIX/.test(j.option.sources.SPY) && /Cboe VXN/.test(j.option.sources.QQQ) && /raw/.test(j.option.sources.SPY_prices) && /T-bill/.test(j.option.sources.rate),
    "uses Cboe VIX/VXN, raw prices and the T-bill series", JSON.stringify(j.option.sources));
  H.ok(sawRateLimit && fx.symbolsWithBars > 0, "rate limit (429) retried and bars still fetched", `${fx.symbolsWithBars}/${fx.symbolsRequested} contracts, ${fx.calls} calls`);
  H.ok(!(j && v && JSON.stringify(v).includes(poison)) && fx.symbolsWithBars === fx.symbolsRequested - 1 && fx.rejected >= 1 && fx.errors === 0,
    "rejected batch split down; only the bad contract is skipped (and it doesn't count toward the error stop)", `${fx.symbolsRequested - fx.symbolsWithBars} skipped, ${fx.rejected} rejected requests, ${fx.errors} errors`);
  H.ok(pagedOnce, "paged option-bar responses are followed");
  H.ok(optGets.length === 0, "option bars never go through alpacaGet (live circuit breaker untouched)");
  const cal = j.option.model.calib || {};
  H.ok(["SPY", "QQQ"].every(t => cal[t] && Math.abs(cal[t].call - 1.1) < 0.02 && Math.abs(cal[t].put - 1.1) < 0.02) && v.prices.all.medAbsErrCal < 1,
    "calibration recovers the planted vol error (real = model at 1.10x vol)", `calib ${JSON.stringify(cal)}, error ${v.prices.all.medAbsErr}% -> ${v.prices.all.medAbsErrCal}%`);
  const live = j.results.find(r => r.exitSet === "apex" && r.variant === "current");
  H.ok(live.opt && live.opt.all.n === live.all.n && live.opt.consistency.beats == null && j.results.every(r => r.opt && r.opt.consistency),
    "every row has option-priced stats on the same trades, with the consistency check");
  H.ok(/PART 1 — OPTION-PRICED/.test(j.report) && /VALIDATION/.test(j.report) && /beats live \d\/4/.test(j.report) && /PART 2 — UNDERLYING/.test(j.report), "report has both parts, validation and the beats-live column");
  H.ok(logs.some(l => /\[TREND-BACKTEST\].*validation:/.test(l)), "logs the data sources and validation coverage");

  // Cboe + FRED down, validation off: still runs, falls back, says so
  cboeDown = true;
  const b = await call({ format: "json", validate: "0" });
  const s2 = ((b.json || {}).option || {}).sources || {};
  H.ok(b.status === 200 && /realized/.test(s2.SPY) && /flat/.test(s2.rate) && !b.json.option.validation && /NOT calibrated/.test(b.json.report),
    "Cboe/FRED down + validate=0: falls back to realized vol, flat rate, and says so", JSON.stringify(s2));
  H.done();
})().catch(e => { H.ok(false, "route test crashed", e.stack.split("\n").slice(0, 3).join(" | ")); H.done(); });
