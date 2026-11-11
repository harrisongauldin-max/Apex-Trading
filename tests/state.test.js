// Day rollover of the log + data buffers (10/7, 10/12) and the in-session checkpoint schedule (10/7).
"use strict";
const H = require("./helpers"); H.quiet();
const S = require(H.R("state.js"));
const st = S.state;
const today = S.getETDateStr();
const fill = () => { st._telemetryBuffer = ["a", "b", "c"]; st._chainSnaps = [{ x: 1 }]; st._outcomeBuffer = ["o"]; };
const rollLine = () => (st._dailyLogBuffer || []).find(e => /DAY-ROLLOVER/.test(e.message || ""));

(async () => {
  // deploy-safe: the first call with no stamp only stamps
  fill(); delete st._buffersDay; S.logEvent("scan", "x");
  H.ok(st._telemetryBuffer.length === 3 && st._chainSnaps.length === 1 && st._buffersDay === today, "first call after a deploy stamps the day and keeps buffers");
  S.logEvent("scan", "y");
  H.ok(st._telemetryBuffer.length === 3, "same day: buffers kept");

  // new day via logEvent: data buffers cleared AND the rollover line survives in today's log (10/12 fix)
  fill(); st._buffersDay = "2026-10-06"; st._dailyLogDay = "2026-10-06"; st._dailyLogBuffer = [{ msg: "yesterday's line" }];
  delete st._lastEodSave;
  S.logEvent("scan", "first line of the new day");
  H.ok(st._telemetryBuffer.length === 0 && st._chainSnaps.length === 0 && st._outcomeBuffer.length === 0, "new day: telemetry, chain snaps and outcomes cleared");
  H.ok(!st._dailyLogBuffer.some(e => e.msg === "yesterday's line"), "new day: yesterday's log lines cleared");
  let L = rollLine();
  H.ok(!!L && /NOT RECORDED/.test(L.message) && L.type === "warn", "[DAY-ROLLOVER] line survives in TODAY's log (was erased before 10/12)", L ? L.message.slice(0, 90) : "missing");

  // new day via a SAVE path first (the 9:30 checkpoint), then a log line — the rollover line must still survive
  fill(); st._buffersDay = "2026-10-06"; st._dailyLogDay = "2026-10-06"; st._dailyLogBuffer = [{ msg: "yesterday's line" }];
  st._lastEodSave = { day: "2026-10-06", at: "16:05:03", ms: 2140, ok: true };
  await S.saveTelemetryToRedis(false);
  H.ok(st._telemetryBuffer.length === 0, "save path (checkpoint before any log line): stale telemetry cleared before saving");
  S.logEvent("scan", "later line");
  L = rollLine();
  H.ok(!!L && /completed at 16:05:03/.test(L.message) && L.type === "scan", "rollover triggered by a save: its line survives the next log call", L ? L.message.slice(60, 150) : "missing");

  // record paths drop stale rows
  fill(); st._buffersDay = "2026-10-06";
  require(H.R("telemetry.js")).recordTelemetry(st, { tkr: "SPY", px: 1 });
  H.ok(st._telemetryBuffer.length === 1, "telemetry record path: stale rows dropped, today's kept");
  st._buffersDay = "2026-10-06"; st._outcomeBuffer = ["STALE"];
  require(H.R("outcomes.js")).recordOutcome(st, { ticker: "SPY", premium: 1, openDate: new Date().toISOString(), contracts: 1 }, { closeTime: Date.now(), pnl: 5, reason: "x" });
  H.ok(!st._outcomeBuffer.includes("STALE") && st._outcomeBuffer.length === 1, "outcome record path: stale row dropped, today's kept");

  // checkpoint schedule: run the REAL cron callback for every minute of a session
  const src = H.read("server.js");
  const a = src.indexOf('cron.schedule("*/5 13-21');
  if (a < 0) { H.ok(false, "checkpoint cron found in server.js"); return H.done(); }
  const cb = H.extractBlock(src, "async () =>", { fromIndex: a });
  const fires = [];
  for (let h = 9; h <= 16; h++) for (let m = 0; m < 60; m += 5) {
    const et = new Date(); et.setHours(h, m, 0, 0);
    const fn = new Function("getETTime", "state", "logEvent", "saveDailyLogToRedis", "require", "return async () => " + cb)(
      () => et, { _dailyLogBuffer: [1] }, () => {}, async () => { fires.push(`${h}:${String(m).padStart(2, "0")}`); }, (p) => require(H.R(p.replace("./", "") + ".js")));
    await fn();
  }
  const C = require(H.R("constants.js"));
  const exp = Math.floor((390 - 1) / (C.LOG_CHECKPOINT_MIN || 10)) + 1 - (C.LOG_CHECKPOINT_MIN === 10 ? 0 : 0);
  H.ok(fires[0] === "9:30" && fires[fires.length - 1] === `15:${String(60 - (C.LOG_CHECKPOINT_MIN || 10)).padStart(2, "0")}` && fires.length === exp,
       `checkpoints every ${C.LOG_CHECKPOINT_MIN} min, 9:30-close`, `${fires.length}/day: ${fires[0]}, ${fires[1]} ... ${fires[fires.length - 1]}`);
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + e.message); process.exit(1); });
