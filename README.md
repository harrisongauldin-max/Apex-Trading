# ARGO V3.2 — Autonomous Options Spread Trading System

## File Structure

All files go in the **root** of the repo, flat — no subfolders except `public/`.

```
constants.js        — All trading constants, watchlist
state.js            — State singleton, Redis persistence, logEvent
broker.js           — Alpaca HTTP client, circuit breaker
signals.js          — Technical indicators, portfolio math
market.js           — Macro news, breadth, VIX, sentiment
scoring.js          — scoreIndexSetup, regime detection
entryEngine.js      — Entry scoring, regime rulebook
exitEngine.js       — checkExits() — all 28 exit conditions
execution.js        — Credit/debit spread order submission
closeEngine.js      — closePosition, partialClose, confirmPending
reconciler.js       — Alpaca reconciliation
agent.js            — Claude macro analysis, rescoring
risk.js             — Drawdown, PDT, concentration, filters
reporting.js        — Email, briefings, EOD reports
backtest.js         — Backtesting engine
scanner.js          — runScan() orchestrator
server.js           — Express routes, schedulers, boot (rename from server.new.js)
public/
  index.html        — Dashboard frontend
test.js             — 159 integration tests (run with: node test.js)
```

## Deployment

1. All 17 `.js` files go in the repo root alongside `package.json`
2. `server.new.js` must be renamed to `server.js`
3. Railway auto-deploys on push to main
4. Watch boot logs for: `[IVR SEED] Seeded 252 bars`

## Tests

```bash
node test.js                        # 159 entry/integration tests
node test/exitEngine.test.js        # 66 exit logic tests
node test/reconciler.test.js        # 10 reconciler tests
```

## Key fixes in V3.2

- Reconciler crash (alpacaBySymbol undefined) — fixed and tested
- Credit/debit detection — price-based, not strike-order
- Duplicate close orders — fixed
- IVR seeding — 3 bugs fixed, now seeds from 252-day VIXY history
- Exit logic — 66 tests across all 28 exit conditions
- P&L display sign inversion — fixed
- 200MA — was always returning 0, now live
- 14,098-line monolith split into 17 focused modules
