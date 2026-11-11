#!/usr/bin/env node
// tests/run.js — APEX regression suite runner (10/12).  Usage:  npm test   |   node tests/run.js [filter]
// Each *.test.js runs in its OWN process (module state is global in APEX, so tests must not share it).
// No network, no Redis, no Alpaca: tests mock the broker. Exit code is non-zero if anything fails.
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const filter = process.argv[2] || "";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".test.js") && f.includes(filter)).sort();
let failed = 0, t0 = Date.now();
console.log(`APEX regression suite — ${files.length} file(s)\n`);
for (const f of files) {
  const s = Date.now();
  console.log(`▶ ${f}`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { cwd: path.join(dir, ".."), encoding: "utf8", timeout: 180000,
                      env: { ...process.env, NODE_NO_WARNINGS: "1", TZ: "UTC" } });   // 11/08: Railway runs in UTC; date code assumes it
  const out = (r.stdout || "") + (r.status !== 0 && r.stderr ? r.stderr.split("\n").slice(0, 8).map(l => "  ! " + l).join("\n") : "");
  process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  if (r.status !== 0) { failed++; console.log(`  ✗ ${f} FAILED${r.signal ? " (" + r.signal + ")" : ""}\n`); }
  else console.log(`  ✓ ${f} (${((Date.now() - s) / 1000).toFixed(1)}s)\n`);
}
console.log(`${failed ? "✗" : "✓"} ${files.length - failed}/${files.length} test files passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed ? 1 : 0);
