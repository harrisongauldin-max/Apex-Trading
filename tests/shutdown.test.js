// Graceful shutdown (10/6): saves state, flushes the day's log/telemetry/outcomes, never hangs past the cap.
// 11/08: + the deploy hand-off — the mark is written after the save; a process still HELD skips its (stale) state save.
"use strict";
const H = require("./helpers"); H.quiet();
const sv = H.read("server.js");
(async () => {
  try {
    const gs = H.extractBlock(sv, "async function gracefulShutdown(signal)", { includeHead: true });
    const make = (o) => new Function("state", "redisSave", "saveDailyLogToRedis", "fs", "STATE_FILE", "process", "console", "HANDOFF", "redisFetch", "REDIS_URL", "REDIS_TOKEN",
      "let isShuttingDown = false;\n" + gs + "\nreturn gracefulShutdown;")(
      { cash: 1, positions: [] }, o.save, o.flush, { writeFileSync() {} }, "/dev/null", { exit: o.exit, env: {} }, { log() {}, error() {} }, o.HO, async () => ({}), "https://r", "tok");
    for (const [lbl, delay] of [["fast Redis", 200], ["hung Redis", 20000]]) {
      let exited = null, flushed = false, saved = false, mark = null, order = []; const t0 = Date.now();
      const HO = { isHeld: () => false, writeMark: async (rf, u, t, x) => { mark = x; order.push("mark"); return true; } };
      const G = make({ save: async () => { saved = true; order.push("save"); }, flush: () => new Promise(r => setTimeout(() => { flushed = true; r(); }, delay)), exit: c => { exited = c; }, HO });
      await G("SIGTERM");
      const secs = (Date.now() - t0) / 1000;
      H.ok(exited === 0 && saved && (delay < 7000 ? flushed : secs < 8), `${lbl}: state saved, log flush ${delay < 7000 ? "completed" : "capped"}, exits`, `${secs.toFixed(1)}s`);
      H.ok(order.join() === "save,mark" && mark && mark.signal === "SIGTERM" && mark.saved === true, `${lbl}: hand-off mark written AFTER the state save`, order.join());
    }
    // a process held for a hand-off: no state save, still writes the mark
    { let saved = false, mark = null, exited = null;
      const G = make({ save: async () => { saved = true; }, flush: async () => {}, exit: c => { exited = c; }, HO: { isHeld: () => true, writeMark: async (rf, u, t, x) => { mark = x; return true; } } });
      await G("SIGTERM");
      H.ok(!saved && mark && exited === 0, "held process: stale state NOT saved; mark written; exits"); }
    // a hung mark write is capped at 3 s
    { const t0 = Date.now(); let exited = null;
      const G = make({ save: async () => {}, flush: async () => {}, exit: c => { exited = c; }, HO: { isHeld: () => false, writeMark: () => new Promise(() => {}) } });
      await G("SIGTERM");
      H.ok(exited === 0 && Date.now() - t0 < 4500, "a hung hand-off mark write can't hold the shutdown (3 s cap)", `${((Date.now() - t0) / 1000).toFixed(1)}s`); }
  } catch (e) { H.ok(false, "gracefulShutdown", e.message); }
  H.done();
})();
