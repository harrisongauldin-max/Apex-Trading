// Upstash compression + metering + fewer transfers (10/12). Real state.js save/load code against a local fake Upstash:
// old (uncompressed) keys still read, new writes are compressed, a checkpoint re-downloads the day only once per
// process, an end-of-day clear can never let a thin buffer overwrite the day, the state record round-trips, an
// identical state upload is skipped, and the meter counts bytes.
"use strict";
const H = require("./helpers"); H.quiet();
const http = require("http");
const db = new Map(); const reqs = [];
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    let out;
    if (req.url === "/pipeline") { const cmds = JSON.parse(b); reqs.push({ op: "pipe", cmds: cmds.map(c => [c[0], c[1]]) });
      out = cmds.map(c => String(c[0]).toLowerCase() === "set" ? (db.set(c[1], c[2]), { result: "OK" }) : { result: db.has(c[1]) ? db.get(c[1]) : null }); }
    else if (req.url.startsWith("/get/")) { const k = decodeURIComponent(req.url.slice(5)); reqs.push({ op: "get", key: k }); out = { result: db.has(k) ? db.get(k) : null }; }
    else if (req.url.startsWith("/keys/")) { const pat = new RegExp("^" + decodeURIComponent(req.url.slice(6)).replace(/\*/g, ".*") + "$"); out = { result: [...db.keys()].filter(k => pat.test(k)) }; }
    else out = { result: null };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
  });
});
srv.listen(0, async () => {
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${srv.address().port}`; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  try {
    const IO = require(H.R("redisIO.js"));
    const S = require(H.R("state.js")); const st = S.state;
    const big = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => `row,${i},SPY,call,770,${i % 7}`) });
    H.ok(IO.decode(IO.encode(big)) === big && IO.encode(big).startsWith("gz1:") && IO.encode(big).length < big.length / 3, "compress round-trip, >3x smaller", `${big.length} -> ${IO.encode(big).length} chars`);
    H.ok(IO.encode("small") === "small" && IO.decode('{"legacy":true}') === '{"legacy":true}', "small values and old uncompressed values pass through untouched");

    const day = S.getETDateStr(), logKey = `argo:logs:${day}`;
    const ent = (i) => ({ time: new Date(Date.parse(day + "T14:00:00Z") + i * 1000).toISOString(), type: "scan", message: "line " + i });
    // 1) a day log written by the OLD code (plain JSON) — the new code must merge with it
    db.set(logKey, JSON.stringify({ date: day, entries: Array.from({ length: 100 }, (_, i) => ent(i)) }));
    st._dailyLogBuffer = Array.from({ length: 50 }, (_, i) => ent(100 + i));
    reqs.length = 0; await S.saveDailyLogToRedis(false);
    let raw = db.get(logKey), n = JSON.parse(IO.decode(raw)).entries.length;
    H.ok(raw.startsWith("gz1:") && n === 150, "first checkpoint reads the old-format key, merges, writes compressed", `${n} entries`);
    H.ok(st._dailyLogBuffer.length >= 150, "entries only Redis had are folded into the live buffer", `buffer ${st._dailyLogBuffer.length}`);
    // 2) next checkpoint: no re-download, still complete
    st._dailyLogBuffer.push(ent(150)); reqs.length = 0; await S.saveDailyLogToRedis(false);
    n = JSON.parse(IO.decode(db.get(logKey))).entries.length;
    H.ok(!reqs.some(r => r.op === "get" && r.key === logKey) && n >= 151, "later checkpoint: no re-download, nothing lost", `${n} entries, gets ${reqs.filter(r => r.op === "get").length}`);
    // 3) end-of-day clear, then a stray save with a thin buffer must merge again, never overwrite
    await S.saveDailyLogToRedis(true);
    H.ok((st._dailyLogBuffer || []).length === 0, "EOD save clears the buffer");
    st._dailyLogBuffer = [ent(999)]; reqs.length = 0; await S.saveDailyLogToRedis(false);
    n = JSON.parse(IO.decode(db.get(logKey))).entries.length;
    H.ok(reqs.some(r => r.op === "get" && r.key === logKey) && n >= 152, "after the EOD clear a thin buffer re-merges — the day is never overwritten", `${n} entries`);
    // 4) telemetry follows the same rules (old key, schema-width filter, merge once)
    const { TELEMETRY_HEADER } = require(H.R("telemetry.js")); const w = TELEMETRY_HEADER.split(",").length;
    const tr = (i) => Array.from({ length: w }, (_, k) => k === 0 ? `r${i}` : "1").join(",");
    const tKey = `argo:telemetry:${day}`;
    db.set(tKey, JSON.stringify({ date: day, header: TELEMETRY_HEADER, rows: [tr(1), tr(2)] }));
    st._telemetryBuffer = [tr(3)]; reqs.length = 0; await S.saveDailyLogToRedis(false);
    const trows = JSON.parse(IO.decode(db.get(tKey))).rows;
    st._telemetryBuffer.push(tr(4)); reqs.length = 0; await S.saveDailyLogToRedis(false);
    const trows2 = JSON.parse(IO.decode(db.get(tKey))).rows;
    H.ok(trows.length === 3 && trows2.length === 4 && !reqs.some(r => r.op === "get" && r.key === tKey), "telemetry: old key merged once, then saved without re-download", `${trows.length} -> ${trows2.length}`);
    // 5) state record: compressed, reloads, identical upload skipped
    Object.assign(st, { positions: [{ ticker: "QQQ", premium: 33.2, contracts: 1 }], closedTrades: Array.from({ length: 200 }, (_, i) => ({ ticker: "SPY", pnl: i, reason: "itrend-noarm", closeTime: i })) });
    reqs.length = 0; await S.saveStateNow();
    const sraw = db.get("spt1:state");
    const loaded = await S.redisLoad();
    H.ok(sraw && sraw.startsWith("gz1:") && loaded && loaded.closedTrades.length === 200 && loaded.positions[0].ticker === "QQQ", "state record stored compressed and reloads", `${(sraw || "").length} chars`);
    reqs.length = 0; await S.saveStateNow();
    H.ok(!reqs.some(r => r.op === "pipe" && r.cmds.some(c => c[1] === "spt1:state")), "identical state upload skipped");
    st.positions[0].currentPrice = 31; reqs.length = 0; await S.saveStateNow();
    H.ok(reqs.some(r => r.op === "pipe" && r.cmds.some(c => c[1] === "spt1:state")), "changed state is uploaded");
    // 6) an old-format state record (what's in Upstash today) still loads
    db.set("spt1:state", JSON.stringify({ cash: 123, positions: [], closedTrades: [{ ticker: "SPY" }] }));
    const old = await S.redisLoad();
    H.ok(old && old.cash === 123, "today's uncompressed state record loads after the deploy");
    // 7) meter
    const u = IO.usageSummary(st);
    H.ok(u && u.todayMB >= 0 && u.families.some(f => f.family === "spt1:state") && u.families.some(f => f.family === "argo:logs") && u.monthReq > 5, "meter counts bytes by data type", JSON.stringify(u.families.slice(0, 3)));
    const line = require(H.R("reporting.js")).buildRedisUsageLine();
    H.ok(/Upstash today: .* MB .* month to date .* of 10,240 MB free/.test(line), "EOD email usage line", line.replace(/<[^>]+>/g, "").slice(0, 120));
    // 8) chain snapshots: hourly, 7-day expiry
    st._chainSnaps = [{ ts: Date.now(), ticker: "SPY", side: "call", targetDTE: 3, rows: [{ a: 1 }] }]; st._chainSnapsSaveLast = Date.now() - 20 * 60000;
    reqs.length = 0; await S.saveDailyLogToRedis(false);
    const csSaved20 = reqs.some(r => r.op === "pipe" && r.cmds.some(c => String(c[1]).startsWith("argo:chainsnaps")));
    st._chainSnapsSaveLast = Date.now() - 61 * 60000; reqs.length = 0; await S.saveDailyLogToRedis(false);
    const csSaved61 = reqs.some(r => r.op === "pipe" && r.cmds.some(c => String(c[1]).startsWith("argo:chainsnaps")));
    H.ok(!csSaved20 && csSaved61, "chain snapshots save hourly, not every checkpoint");
    // 8b) 10/14: the end of every scan must NOT force a full state upload (it did: ~2,000/day, 215 MB on 10/13)
    const scSrc = H.read("scanner.js"); const i0 = scSrc.indexOf("_lastScanTelemetryAt = scanNow;");
    const tail = scSrc.slice(i0, scSrc.indexOf("} catch(e) {", i0)).replace(/\/\/.*$/gm, "");   // code only, not comments
    H.ok(i0 > 0 && !/saveStateNow|redisSave/.test(tail) && /markDirty\(\)/.test(tail), "end of scan only marks the state dirty (flush timer uploads it)");
    // 9) compression switch off (before a rollback): values written plain again
    IO.attach(st, { compress: false }); st.positions[0].currentPrice = 30; await S.saveStateNow();
    H.ok(!db.get("spt1:state").startsWith("gz1:"), "REDIS_COMPRESS=false writes plain values (rollback path)");
  } catch (e) { H.ok(false, "redis test crashed", e.stack.split("\n").slice(0, 3).join(" | ")); }
  srv.close(); H.done();
});
