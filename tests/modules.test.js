// Every module compiles, the core modules load, and every constant a module imports actually exists.
"use strict";
const H = require("./helpers"); H.quiet();
const fs = require("fs");
const { spawnSync } = require("child_process");
const files = fs.readdirSync(H.ROOT).filter(f => f.endsWith(".js"));
const bad = files.filter(f => spawnSync(process.execPath, ["--check", H.R(f)]).status !== 0);
H.ok(bad.length === 0, `all ${files.length} modules compile`, bad.join(", "));
let loadErr = null;
try { for (const m of ["scanner.js", "execution.js", "closeEngine.js", "reconciler.js", "reporting.js", "outcomes.js", "telemetry.js", "market.js", "dayContext.js", "gex.js", "trendBacktest.js"]) require(H.R(m)); }
catch (e) { loadErr = e.message.split("\n")[0]; }
H.ok(!loadErr, "core modules load", loadErr || "");
const C = require(H.R("constants.js"));
const missing = [], unused = [];
for (const f of files) {
  const L = fs.readFileSync(H.R(f), "utf8").split("\n");
  const ri = L.findIndex(l => /require\(["']\.\/constants["']\)/.test(l) && /\}\s*=\s*require/.test(l));
  if (ri < 0) continue;
  let s = ri; while (s > 0 && !/const\s*\{/.test(L[s])) s--;
  const inner = L.slice(s, ri + 1).join("\n").replace(/const\s*\{/, "").replace(/\}\s*=\s*require.*/, "").replace(/\/\/.*$/gm, "");
  const body = L.slice(0, s).concat(L.slice(ri + 1)).join("\n");
  for (const part of inner.split(",").map(x => x.trim()).filter(Boolean)) {
    const n = part.split("=")[0].trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(n) || C[n] !== undefined || part.includes("=")) continue;   // a default value covers it
    if (new RegExp(`\\b${n}\\b`).test(body)) missing.push(`${f}:${n}`); else unused.push(`${f}:${n}`);
  }
}
H.ok(missing.length === 0, "every USED imported constant exists in constants.js (or has a default)", missing.slice(0, 5).join(", "));
if (unused.length) console.log(`  SKIP  note — imported but unused (harmless): ${unused.join(", ")}`);
H.done();
