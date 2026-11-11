// 11/08: deploy hand-off — a new process that boots while the old one is alive holds (no trades, no saves) until the old
// one writes the hand-off mark after its final save, then reloads state.
"use strict";
const H = require("./helpers"); H.quiet();
const HO = require(H.R("handoff.js"));
const now = Date.now();
H.ok(HO.overlapSuspected({ lastScan: now - 8000, now }) === true, "previous process scanned 8 s ago, no shutdown record -> overlap (hold)");
H.ok(HO.overlapSuspected({ lastScan: now - 8000, lastShutdown: { at: now - 2000 }, now }) === false, "it already shut down cleanly -> no hold");
H.ok(HO.overlapSuspected({ lastScan: now - 8000, lastCrash: { at: now - 1000 }, now }) === false, "it crashed -> no hold");
H.ok(HO.overlapSuspected({ lastScan: now - 5 * 60000, now }) === false && HO.overlapSuspected({ now }) === false, "no scan in the last minute (night, weekend) -> no hold");
H.ok(HO.overlapSuspected({ lastScan: new Date(now - 3000).toISOString(), now }) === true, "accepts the ISO lastScan string state stores");

(async () => {
  // hold / waitReady / release
  H.ok(HO.isHeld() === false && (await HO.waitReady(10)) === true, "not held: waitReady resolves at once");
  HO.hold("test");
  const late = HO.waitReady(20), soon = HO.waitReady(5000);
  H.ok((await late) === false && HO.isHeld(), "held: waitReady times out (false) — callers then go ahead anyway");
  HO.release();
  H.ok((await soon) === true && !HO.isHeld(), "release() wakes every waiter");

  // waitForMark with a fake clock
  let t = 0; const clock = () => t, sleep = async (ms) => { t += ms; };
  let marks = [null, null, { bootId: HO.BOOT_ID, at: 1e12 }, { bootId: "other", at: 1 }, { bootId: "other", at: 1e12 }];
  let i = 0; const read = async () => marks[Math.min(i++, marks.length - 1)];
  const r = await HO.waitForMark({ read, bootAt: 1e12, maxMs: 90000, everyMs: 3000, sleep, now: clock });
  H.ok(r.ok && r.mark.bootId === "other" && r.waitedMs === 12000, "ignores no mark, its OWN mark and a stale mark; takes the other process's fresh one", JSON.stringify(r));
  t = 0; i = 0; marks = [null];
  const r2 = await HO.waitForMark({ read, bootAt: 1e12, maxMs: 9000, everyMs: 3000, sleep, now: clock });
  H.ok(!r2.ok && r2.waitedMs >= 9000, "no mark: gives up after the cap (killed without warning) and the caller proceeds");
  t = 0; const r3 = await HO.waitForMark({ read: async () => { throw new Error("redis down"); }, bootAt: 0, maxMs: 6000, everyMs: 3000, sleep, now: clock });
  H.ok(!r3.ok, "Redis errors while polling are survived (timeout path)");

  // write/read round trip through a fake Upstash
  const kv = {};
  const fake = async (url, opts = {}) => {
    if (/\/pipeline$/.test(url)) { const cmds = JSON.parse(opts.body); for (const c of cmds) if (c[0] === "set") kv[c[1]] = c[2]; return { json: async () => cmds.map(() => ({ result: "OK" })) }; }
    const m = url.match(/\/get\/(.+)$/); return { json: async () => ({ result: kv[decodeURIComponent(m[1])] ?? null }) };
  };
  const okW = await HO.writeMark(fake, "https://x", "tok", { signal: "SIGTERM", saved: true });
  const back = await HO.readMark(fake, "https://x", "tok");
  H.ok(okW && back && back.bootId === HO.BOOT_ID && back.signal === "SIGTERM" && back.saved === true && back.at > 0, "mark round-trips (SET with 15-min expiry, GET)", JSON.stringify(back));
  H.ok((await HO.writeMark(fake, "", "")) === false && (await HO.readMark(fake, "", "")) === null, "no Redis configured: no-ops");

  // wiring (source checks)
  const srv = H.read("server.js"), st = H.read("state.js");
  H.ok(/if \(isShuttingDown \|\| HANDOFF\.isHeld\(\)\) return;\s*\/\/ 11\/08: no scans/.test(srv), "scan loop: nothing while shutting down or held");
  H.ok(/if \(isShuttingDown \|\| HANDOFF\.isHeld\(\)\) return; SIP\.tick\(/.test(srv), "stocks sleeve clock: nothing while held");
  H.ok((srv.match(/await HANDOFF\.waitReady\(45000\);/g) || []).length === 3, "3:30 entry, 3:58 exit and 3:45 flatten crons WAIT for a hand-off (then go ahead) instead of skipping");
  H.ok(/const _wasHeld = HANDOFF\.isHeld\(\);/.test(srv) && /for \(let i = 1; i <= 3 && !_wasHeld; i\+\+\)/.test(srv) && /HANDOFF\.writeMark\(redisFetch, REDIS_URL, REDIS_TOKEN/.test(srv),
       "shutdown: a held process doesn't save its stale state; every process writes the mark after its save");
  const iSave = srv.indexOf("for (let i = 1; i <= 3 && !_wasHeld; i++)"), iMark = srv.indexOf("HANDOFF.writeMark(redisFetch");
  H.ok(iSave > 0 && iMark > iSave, "the mark is written AFTER the final state save");
  H.ok(/HANDOFF\.overlapSuspected\(\{ lastScan: _alive, lastShutdown: _ls, lastCrash: _lc \}\)/.test(srv) && /Object\.assign\(state, fresh, keep\);/.test(srv) && /HANDOFF\.release\(\);/.test(srv),
       "boot: hold on a suspected overlap, reload state after the hand-off, then release");
  H.ok(/if \(require\('\.\/handoff'\)\.isHeld\(\)\) return;/.test(st), "redisSave: no Redis write while held");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
