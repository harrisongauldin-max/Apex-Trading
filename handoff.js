// handoff.js — 11/08 (Harrison): ONE trading process at a time across a Railway deploy overlap.
// On 11/05, 5 of 9 deploys overlapped mid-session: for a few seconds two copies of APEX ran at once. Two risks:
//   1. both copies place the same order (the 10:00 straddle, the 9:35 stock entries);
//   2. the old copy's shutdown save lands AFTER the new copy loaded state, so the new copy runs on stale state and its
//      next save overwrites the old copy's final trades.
// Fix: a new process that boots while the previous one still looks alive HOLDS — no scans, no sleeve ticks, no 3:30/3:45/
// 3:58 actions, no state saves to Redis — until the old process writes the hand-off mark after its final save (or 90 s
// pass). It then reloads state from Redis and starts trading. A process that is held when it gets SIGTERM skips its state
// save (its state is the stale copy). Cost: one SET per shutdown, a GET every 3 s during a hold (<= 30 per deploy).
'use strict';
const crypto = require('crypto');
const KEY = 'apex:handoff';
const BOOT_ID = `${(process.env.RAILWAY_DEPLOYMENT_ID || 'local').slice(0, 8)}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
let held = false, heldSince = 0, heldWhy = '', waiters = [];

const isHeld = () => held;
const info = () => ({ held, heldSince, heldWhy, bootId: BOOT_ID });
function hold(why) { held = true; heldSince = Date.now(); heldWhy = why || ''; }
function release() { held = false; const w = waiters; waiters = []; for (const f of w) { try { f(true); } catch (_) {} } }
// resolves true when released, false on timeout (callers then go ahead anyway — a missed 3:58 exit is worse than a late one)
function waitReady(maxMs = 90000) {
  if (!held) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { waiters = waiters.filter(f => f !== done); resolve(false); }, maxMs);
    const done = (v) => { clearTimeout(t); resolve(v); };
    waiters.push(done);
  });
}
// the previous process looks alive: it scanned within the last 60 s and left neither a shutdown nor a crash record after it
function overlapSuspected({ lastScan, lastShutdown, lastCrash, now = Date.now() } = {}) {
  const alive = lastScan ? (typeof lastScan === 'number' ? lastScan : Date.parse(lastScan)) : 0;
  if (!alive || now - alive > 60000) return false;
  if (lastShutdown && lastShutdown.at >= alive - 5000) return false;
  if (lastCrash && lastCrash.at >= alive - 5000) return false;
  return true;
}
async function writeMark(redisFetch, url, token, extra = {}) {
  if (!url || !token) return false;
  const body = JSON.stringify([['set', KEY, JSON.stringify({ bootId: BOOT_ID, at: Date.now(), ...extra }), 'EX', '900']]);
  const r = await redisFetch(`${url}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body });
  const j = await r.json().catch(() => null);
  return !!(j && j[0] && !j[0].error);
}
async function readMark(redisFetch, url, token) {
  if (!url || !token) return null;
  const r = await redisFetch(`${url}/get/${KEY}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => null);
  if (!j || j.result == null) return null;
  try { return typeof j.result === 'string' ? JSON.parse(j.result) : j.result; } catch (_) { return null; }
}
// poll for a mark written by ANOTHER process at/after (boot - 2 min). -> { ok, mark, waitedMs }
async function waitForMark({ read, bootAt = Date.now(), maxMs = 90000, everyMs = 3000, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = () => Date.now() }) {
  const t0 = now();
  for (;;) {
    let m = null; try { m = await read(); } catch (_) { m = null; }
    if (m && m.bootId !== BOOT_ID && +m.at >= bootAt - 120000) return { ok: true, mark: m, waitedMs: now() - t0 };
    if (now() - t0 >= maxMs) return { ok: false, mark: m, waitedMs: now() - t0 };
    await sleep(everyMs);
  }
}

module.exports = { KEY, BOOT_ID, isHeld, info, hold, release, waitReady, overlapSuspected, writeMark, readMark, waitForMark };
