// 11/09: the discretionary macro closes (macro-reversal, macro-bullish, macro-defensive) skip hold-to-close straddle legs.
// On 11/09 macro-reversal (SPY +2.7%) sold the QQQ straddle put at 15:31 and the call was then closed as an orphan.
"use strict";
const H = require("./helpers"); H.quiet();
const sc = H.read("scanner.js");
const rev = sc.slice(sc.indexOf("if (spyDayMove > _macroRevThreshold) {"), sc.indexOf('closePosition(pos.ticker, "macro-reversal"'));
H.ok(/if \(pos\._straddleHold\) \{/.test(rev) && /continue; \}/.test(rev), "macro-reversal: straddle puts are skipped (logged once)");
const bul = sc.slice(sc.indexOf('logEvent("macro", `BULLISH MACRO - closing losing puts`);'), sc.indexOf('"macro-bullish"'));
H.ok(/pos\.optionType !== "put" \|\| pos\._straddleHold\) continue;/.test(bul), "macro-bullish: straddle puts are skipped");
const def = sc.slice(sc.indexOf("const openCallPositions"), sc.indexOf('"macro-defensive"') + 80);
H.ok(/p\.optionType === "call" && !p\._straddleHold/.test(def) && /pos\.optionType === "call" && !pos\._straddleHold/.test(def) && /"macro-defensive", null, pos\.contractSymbol \|\| pos\.buySymbol/.test(def),
     "macro-defensive: straddle calls are skipped, and each close names its own contract (not the ticker's first position)");
// run the macro-reversal loop body on a book: a straddle put + an ordinary put
const body = rev.slice(rev.indexOf("for (const pos of [...state.positions]) {"));
const fn = new Function("state", "logEvent", "posSnapshots", "closePosition", "spyDayMove", `return (async () => { let reversalCount = 0; ${body} closePosition(pos.ticker, "macro-reversal", null, pos.contractSymbol || pos.buySymbol, { bypassPDT: true }); reversalCount++; } return reversalCount; })();`);
const st = { positions: [{ ticker: "QQQ", optionType: "put", contractSymbol: "QP", premium: 10, _straddleHold: true, _isStraddle: true }, { ticker: "SPY", optionType: "put", contractSymbol: "SP", premium: 4 }] };
const closed = [], LG = [];
fn(st, (t, m) => LG.push(m), {}, async (tk, r, e, sym) => closed.push(sym), 0.027).then((n) => {
  H.ok(n === 1 && closed.join() === "SP" && LG.some(m => /straddle put EXEMPT/.test(m)), "SPY +2.7%: the ordinary put is closed, the straddle put is kept", closed.join());
  H.done();
}).catch(e => { console.log("  FAIL  harness error: " + e.message); process.exit(1); });
