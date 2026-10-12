// redisIO.js — 10/12 (Harrison): one transparent layer under every Upstash call.
//
// Why: the free Upstash plan allows 10 GB of bandwidth a month, and APEX was at 9 GB by 10/12. Almost all of it is
// JSON (the state record every 30 s, the day's log / telemetry / option chains re-sent at every checkpoint), which
// compresses 6-10x. Callers keep doing exactly what they did; this layer:
//   * WRITES: any SET value of 512+ chars is stored as "gz1:" + base64(gzip(value)).
//   * READS:  a "gz1:" value is unpacked before the caller sees it; anything else (every key written before this
//             change, small values) passes through untouched — so old data keeps reading, and keys convert as they
//             are next written.
//   * METERS: bytes sent / received per key family (spt1:state, argo:logs, ...) per ET day, plus month-to-date,
//             kept on state._redisUsage so it survives restarts. Shown in the EOD email.
// REDIS_COMPRESS=false (constants) turns compression off — needed only before rolling back to pre-10/12 code, which
// cannot read "gz1:" values.

"use strict";
const zlib = require("zlib");
const _nodeFetch = require("node-fetch");

const PREFIX = "gz1:";
const MIN_LEN = 512;
let _state = null;            // attached by state.js so the meter persists with the state record
let _compress = true;
let _fetch = _nodeFetch;      // state.js passes its no-keep-alive fetch (Node 22's keep-alive sockets get dropped by the edge)

function attach(stateObj, { compress = true, fetch } = {}) { _state = stateObj; _compress = compress !== false; if (typeof fetch === "function") _fetch = fetch; }

function encode(str) {
  if (!_compress || typeof str !== "string" || str.length < MIN_LEN || str.startsWith(PREFIX)) return str;
  try { return PREFIX + zlib.gzipSync(Buffer.from(str, "utf8"), { level: 6 }).toString("base64"); }
  catch (_) { return str; }
}
function decode(v) {
  if (typeof v !== "string" || !v.startsWith(PREFIX)) return v;
  try { return zlib.gunzipSync(Buffer.from(v.slice(PREFIX.length), "base64")).toString("utf8"); }
  catch (_) { return null; }   // corrupt -> treated as missing by every caller
}

// key family: "argo:logs:2026-10-12" -> "argo:logs", "spt1:state" -> "spt1:state", "argo:chainsnaps:2026-10-12:3" -> "argo:chainsnaps"
function family(key) {
  const k = String(key || "");
  if (k.startsWith("spt1:")) return "spt1:state";
  const p = k.split(":"); return p.length >= 2 ? `${p[0]}:${p[1]}` : (k || "other");
}
const _etDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function meter(fam, out, inn) {
  if (!_state) return;
  const day = _etDay(), month = day.slice(0, 7);
  let u = _state._redisUsage;
  if (!u || typeof u !== "object") u = _state._redisUsage = { day, month, fam: {}, monthBytes: 0, monthReq: 0, days: {} };
  if (u.month !== month) { u.month = month; u.monthBytes = 0; u.monthReq = 0; u.days = {}; }
  if (u.day !== day) { u.day = day; u.fam = {}; }
  const f = u.fam[fam] = u.fam[fam] || { out: 0, in: 0, n: 0 };
  f.out += out; f.in += inn; f.n++;
  u.monthBytes += out + inn; u.monthReq++;
  u.days[day] = (u.days[day] || 0) + out + inn;
}

const _wrap = (status, ok, text, data) => ({ ok, status, text: async () => text, json: async () => { if (data === undefined) return JSON.parse(text); return data; } });

// Drop-in replacement for fetch(`${REDIS_URL}/...`, opts) as used across state.js / server.js / reporting.js.
async function redisFetch(url, opts = {}) {
  const u = String(url);
  let body = opts.body, fam = "other", sent = 0;
  const isPipe = /\/pipeline$/.test(u);
  if (isPipe && typeof body === "string") {
    try {
      const cmds = JSON.parse(body);
      if (Array.isArray(cmds)) {
        for (const c of cmds) {
          if (!Array.isArray(c)) continue;
          if (c[1] != null) fam = family(c[1]);
          if (String(c[0]).toLowerCase() === "set" && typeof c[2] === "string") c[2] = encode(c[2]);
        }
        body = JSON.stringify(cmds);
      }
    } catch (_) { /* leave the body as it was */ }
  } else {
    const m = u.match(/\/(get|keys|del|exists|ttl)\/(.+)$/);
    if (m) fam = family(decodeURIComponent(m[2]));
  }
  sent = (typeof body === "string" ? Buffer.byteLength(body) : 0) + u.length;
  const r = await _fetch(u, { ...opts, body });
  const text = await r.text();
  meter(fam, sent, Buffer.byteLength(text));
  let data;
  try { data = JSON.parse(text); } catch (_) { return _wrap(r.status, r.ok, text, undefined); }
  if (Array.isArray(data)) { for (const x of data) if (x && typeof x.result === "string") x.result = decode(x.result); }
  else if (data && typeof data.result === "string") data.result = decode(data.result);
  return _wrap(r.status, r.ok, text, data);
}

// one line for the EOD email / log: today by family + month-to-date against the 10 GB free allowance
function usageSummary(stateObj) {
  const u = (stateObj || _state || {})._redisUsage;
  if (!u) return null;
  const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 2 : 1);
  const fams = Object.entries(u.fam || {}).map(([k, v]) => ({ k, b: v.out + v.in, n: v.n })).sort((a, b) => b.b - a.b);
  const today = fams.reduce((s, x) => s + x.b, 0);
  const dayVals = Object.values(u.days || {});
  const avgDay = dayVals.length ? dayVals.reduce((a, b) => a + b, 0) / dayVals.length : today;
  return { day: u.day, todayMB: +mb(today), monthMB: +mb(u.monthBytes || 0), monthReq: u.monthReq || 0, avgDayMB: +mb(avgDay),
           families: fams.map(x => ({ family: x.k, mb: +mb(x.b), requests: x.n })) };
}

module.exports = { attach, encode, decode, family, redisFetch, usageSummary, PREFIX, MIN_LEN };
