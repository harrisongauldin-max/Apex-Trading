# APEX test suite

Run from the repo root:

```
npm test                 # all files (~85 s)
npm test -- close        # only files whose name contains "close"
```

Each `*.test.js` runs in its own Node process (180 s timeout). The runner exits non-zero if any file fails, so it can gate a deploy.

**Safe by construction:** the helpers set dummy Alpaca keys and delete the Redis env vars before anything loads, and the broker is mocked through `require.cache`. No test talks to Alpaca, Redis, or email.

**Optional:** the dashboard test needs jsdom, which is not an APEX dependency. Install it without touching package.json:

```
npm install --no-save jsdom@24
```

Without it, `dashboard.test.js` prints SKIP and passes.

## What each file covers

| File | Covers |
|---|---|
| truth.test.js | Account-change baseline: APEX's own after-close snapshot, Alpaca fallback (labeled), snapshot timing |
| state.test.js | Day rollover of log/telemetry/chain/outcome buffers, `[DAY-ROLLOVER]` line survives, 10-min checkpoints |
| report.test.js | EOD email: account change, realized week/month, Sleeve column, footer, mr-fade shadow columns in entryfwd CSV |
| labels.test.js | Meta-labels on intraday-trend entries (ADX tier, GEX, skip reasons) and mr-fade stamps |
| orders.test.js | executeTrade: entry cancel/fill race, client_order_id, sizing, mr-fade delta window, ledger row |
| close.test.js | Close-path cancel/fill race and cost sync (slowest file, ~40 s) |
| reconciler.test.js | Reconciler qty changes and duplicate-fill alarm |
| journal.test.js | Journal repair endpoint |
| shutdown.test.js | Graceful shutdown saves state and caps a hung log flush at 7 s |
| schema.test.js | Telemetry (67 cols) and outcome (138 cols) rows always match their headers |
| backtest.test.js | trendBacktest.js invariants: no overlap, triggers honored, sensitivity tables consistent |
| modules.test.js | Every module compiles and loads; every used imported constant exists |
| dashboard.test.js | public/index.html headless: every tab opens, Market State + Trend Backtest render, no JS errors |

## When a test breaks after a code change

Several tests pull a function out of its source file by a text anchor (for example `async function gracefulShutdown(signal)` in server.js) rather than requiring the module. If you rename or move that code, the test fails with "anchor not found" — update the anchor string in the test, not the logic. Column-count checks in schema.test.js will also need the new count if a CSV header grows on purpose.
