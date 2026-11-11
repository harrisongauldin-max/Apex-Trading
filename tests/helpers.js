// tests/helpers.js — shared test utilities for APEX's regression suite (10/12).
// No network: every test that touches Alpaca installs a mock broker BEFORE requiring the module under test.
"use strict";
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const R = (m) => path.join(ROOT, m);

// Dummy credentials so modules take their "keys present" code paths; the broker is mocked, so nothing is sent.
process.env.ALPACA_API_KEY = process.env.ALPACA_API_KEY_TEST || "test-key";
process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY_TEST || "test-secret";
// Never touch a real Redis, mailbox or model from a test, even if run in a shell where the real keys are set.
for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "REDIS_URL", "REDIS_TOKEN", "RESEND_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[k];

// The save path writes state.json / state-backup.json next to the code. Put back whatever was there (or nothing)
// when this test process exits, so a test run never leaves or overwrites a local state file.
const _stateFiles = ["state.json", "state-backup.json"].map(f => {
  const p = path.join(__dirname, "..", f);
  return { p, before: fs.existsSync(p) ? fs.readFileSync(p) : null };
});
process.on("exit", () => {
  for (const { p, before } of _stateFiles) {
    try { if (before === null) { if (fs.existsSync(p)) fs.unlinkSync(p); } else fs.writeFileSync(p, before); } catch (_) {}
  }
});

// ---- results -------------------------------------------------------------------------------------------
const results = [];
function ok(cond, name, detail = "") {
  results.push({ pass: !!cond, name, detail });
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function done() {
  const failed = results.filter(r => !r.pass).length;
  console.log(`  [${results.length - failed}/${results.length} passed]`);
  process.exit(failed ? 1 : 0);
}
function quiet() {   // modules log heavily to console; keep test output readable
  const keep = console.log.bind(console);
  console.log = (...a) => { const s = a.join(" "); if (/^\s+(PASS|FAIL|SKIP)\b|^\s+\[\d+\/\d+ passed\]/.test(s)) keep(...a); };
  console.warn = () => {}; console.error = () => {};
  process.removeAllListeners("warning"); process.on("warning", () => {});
}

// ---- mock broker -------------------------------------------------------------------------------------------
// handlers: { get(url) -> obj|undefined, post(url, body) -> obj, del(url) -> obj }. Unhandled GETs return null.
function mockBroker(handlers = {}) {
  const bp = require.resolve(R("broker.js"));
  const real = require(bp);
  const calls = { get: [], post: [], del: [] };
  require.cache[bp].exports = {
    ...real,
    alpacaGet: async (u, base) => { calls.get.push(u); const r = handlers.get ? await handlers.get(u, base) : undefined; return r === undefined ? null : r; },
    alpacaPost: async (u, b) => { calls.post.push({ u, b }); return handlers.post ? handlers.post(u, b) : null; },
    alpacaDelete: async (u) => { calls.del.push(u); return handlers.del ? handlers.del(u) : {}; },
  };
  return calls;
}

// ---- a synthetic SPY/QQQ option chain (Black-Scholes-ish prices + greeks) -----------------------------------
const N = (x) => 0.5 * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)));
function chainHandlers(spot = 780, ticker = "SPY", dtes = [1, 3, 7, 14, 21, 30, 45, 60, 70], strikeStep = 1) {
  const today = new Date();
  const iso = (k) => new Date(today.getTime() + k * 864e5).toISOString().split("T")[0];
  return {
    get: (u) => {
      if (u.startsWith("/options/contracts")) {
        const type = /type=put/.test(u) ? "put" : "call", out = [];
        for (const d of dtes) for (let k = spot - 40; k <= spot + 40; k += strikeStep)
          out.push({ symbol: `${ticker}${iso(d).replace(/-/g, "").slice(2)}${type === "call" ? "C" : "P"}${String(Math.round(k * 1000)).padStart(8, "0")}`,
                     expiration_date: iso(d), strike_price: String(k), open_interest: 5000, type });
        return { option_contracts: out };
      }
      if (u.startsWith("/options/snapshots")) {
        const s = {}, m0 = /symbols=([^&]+)/.exec(u); if (!m0) return { snapshots: s };
        for (const x of m0[1].split(",")) {
          const m = new RegExp(`${ticker}(\\d{6})([CP])(\\d{8})`).exec(x); if (!m) continue;
          const K = +m[3] / 1000, call = m[2] === "C";
          const exp = new Date(`20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`);
          const T = Math.max(1, Math.round((exp - today) / 864e5)) / 365, v = 0.16;
          const d1 = (Math.log(spot / K) + 0.5 * v * v * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
          const pr = Math.max(0.05, call ? spot * N(d1) - K * N(d2) : K * N(-d2) - spot * N(-d1));
          s[x] = { latestQuote: { bp: +(pr * 0.997).toFixed(2), ap: +(pr * 1.003).toFixed(2) }, latestTrade: { p: +pr.toFixed(2) },
                   greeks: { delta: call ? N(d1) : N(d1) - 1, gamma: 0.01, theta: -0.05, vega: 0.3 }, impliedVolatility: v };
        }
        return { snapshots: s };
      }
      return undefined;
    },
  };
}

// ---- source extraction (for code that isn't exported: server handlers, scanner blocks) ----------------------
// Returns the text of the balanced {...} block that starts at the first "{" at/after `anchor`'s position
// (or, with includeHead, from the anchor itself). JS-aware: skips strings, template literals, comments, regexes.
function extractBlock(src, anchor, { includeHead = false, fromIndex = 0 } = {}) {
  const a = src.indexOf(anchor, fromIndex);
  if (a < 0) throw new Error(`anchor not found: ${JSON.stringify(anchor.slice(0, 60))} — the code it tests has moved or been renamed`);
  let i = src.indexOf("{", a + (includeHead ? 0 : 0));
  if (i < 0) throw new Error("no block after anchor");
  const start = includeHead ? a : i;
  let depth = 0, prevSig = "";
  const tplStack = [];
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2) + 1; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; } prevSig = q; continue; }
    if (c === "`") { i = skipTemplate(src, i); prevSig = "`"; continue; }
    if (c === "/" && /[(,=:[!&|?{};+\-*%<>~^]|^$|return$/.test(prevSig)) {   // regex literal
      i++; let inClass = false;
      while (i < src.length) { const d = src[i]; if (d === "\\") { i += 2; continue; } if (d === "[") inClass = true; else if (d === "]") inClass = false; else if (d === "/" && !inClass) break; i++; }
      prevSig = "/"; continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    if (!/\s/.test(c)) prevSig = /[A-Za-z0-9_$]/.test(c) ? (src.slice(Math.max(0, i - 5), i + 1).endsWith("return") ? "return" : "w") : c;
  }
  throw new Error("unbalanced block after anchor " + JSON.stringify(anchor.slice(0, 40)));
}
function skipTemplate(src, i) {   // i at opening backtick; returns index of closing backtick
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i;
    if (c === "$" && src[i + 1] === "{") {
      let d = 1; i += 2;
      while (i < src.length && d > 0) {
        const e = src[i];
        if (e === "`") { i = skipTemplate(src, i) + 1; continue; }
        if (e === '"' || e === "'") { const q = e; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; } i++; continue; }
        if (e === "{") d++; else if (e === "}") d--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}
// Text from `startAnchor` through the end of `endAnchor` (inclusive), for straight-line snippets.
function extractBetween(src, startAnchor, endAnchor) {
  const a = src.indexOf(startAnchor);
  if (a < 0) throw new Error(`anchor not found: ${JSON.stringify(startAnchor.slice(0, 60))}`);
  const b = src.indexOf(endAnchor, a);
  if (b < 0) throw new Error(`end anchor not found: ${JSON.stringify(endAnchor.slice(0, 60))}`);
  return src.slice(a, b + endAnchor.length);
}
// 11/08: CRLF -> LF. execution.js is committed with Windows line endings, so any extraction anchor containing "\n" never
// matched it: chandelier.test.js failed on the deployed repo (it passed only on copies an editor had re-saved as LF).
const read = (f) => fs.readFileSync(R(f), "utf8").replace(/\r\n/g, "\n");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { ROOT, R, ok, done, quiet, mockBroker, chainHandlers, extractBlock, extractBetween, read, sleep, N };
