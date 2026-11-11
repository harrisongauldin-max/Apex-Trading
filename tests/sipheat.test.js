// 11/05: open share-sleeve risk counts in PORTFOLIO HEAT (risk to the stop + stop slippage; filled shares only).
"use strict";
const H = require("./helpers"); H.quiet();
H.mockBroker({ get: () => undefined });
const S = require(H.R("state.js")); const st = S.state;
const SIP = require(H.R("stocksInPlay.js"));
const SG = require(H.R("signals.js"));
SIP.CFG.STOP_BASE = "fill";
st.alpacaCash = 80000; st.positions = [{ ticker: "SPY", optionType: "call", cost: 400, contracts: 1, premium: 4 }];
st._sip = null;
H.ok(Math.abs(SG.heatPct() - 400 / 80000) < 1e-12 && SG.sipOpenRisk() === 0, "no sleeve: heat exactly as before (options cost / cash)");
st._sip = { day: "2026-11-05", last: { AAA: { px: 31 } }, carry: [], cands: [
  { sym: "AAA", side: "long", fillPx: 30, filledQty: 25, exitQty: 0, stopDist: 0.5, stopPx: 29.5, atr: 2 },          // $12.50 to stop + 25 x 0.20 slip = $17.50
  { sym: "BBB", side: "short", fillPx: 20, filledQty: 40, exitQty: 0, stopDist: 0.3, stopPx: 19.85, atr: 1.5 },     // locked in profit: slippage only 40 x 0.15 = $6
  { sym: "CCC", side: "long", fillPx: 10, filledQty: 50, exitQty: 50, stopDist: 0.25, stopPx: 9.75, atr: 1 },        // closed: nothing
  { sym: "DDD", side: "long", entry: 50, filledQty: 0, exitQty: 0, stopDist: 1, atr: 4, status: "entry placed" },  // resting entry: nothing yet
] };
const r = SIP.openRiskUsd(st);
H.ok(r.n === 2 && Math.abs(r.risk - 23.5) < 1e-9 && r.riskLong === 17.5 && r.riskShort === 6, "risk: long $17.50 (to stop + slippage), short locked in profit $6 (slippage only); closed and unfilled rows add nothing", JSON.stringify(r));
H.ok(r.notional === 25 * 31 + 40 * 20 && r.long === 775 && r.short === 800, "notional reported at the last price (long at Now, short at fill when no quote)", JSON.stringify(r));
H.ok(Math.abs(SG.heatPct() - (400 + 23.5) / 80000) < 1e-12 && SG.sipOpenRisk() === 23.5, "portfolio heat = (options cost + share risk) / cash", String(SG.heatPct()));
// no stop recorded yet (just filled): falls back to the 1R stop distance
st._sip.cands = [{ sym: "EEE", side: "long", fillPx: 40, filledQty: 10, exitQty: 0, stopDist: 0.8, atr: 3 }];
H.ok(Math.abs(SIP.openRiskUsd(st).risk - 10 * (0.8 + 0.3)) < 1e-9, "a fill with no stop on record yet counts the full 1R + slippage");
// wiring: execution's pre-submit and post-fill heat checks, scanner's heat and directional heat include the sleeve
const fs = require("fs"), ex = fs.readFileSync(H.R("execution.js"), "utf8"), sc = fs.readFileSync(H.R("scanner.js"), "utf8");
H.ok((ex.match(/openRisk\(\) \+ sipOpenRisk\(\)/g) || []).length === 2, "execution.js: both heat checks add the share risk");
H.ok(/const _heatPct   = heatPct\(\);/.test(sc) && /_sipDir = optionType === "call" \? _sr\.riskLong : _sr\.riskShort/.test(sc), "scanner.js: scan heat + directional heat (long shares = call side, short = put side)");
H.done();
