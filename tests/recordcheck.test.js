// End-of-day record check (10/12): Alpaca's fills for the day vs the outcome rows. Replays the real 10/6 case —
// two intraday-trend trades bought and sold at Alpaca whose outcome rows were lost — plus the clean case,
// a partial close still open, a recorded close Alpaca never made, and the email section itself.
"use strict";
const H = require("./helpers"); H.quiet();
let fillsPage = [];
H.mockBroker({ get: (u) => (/\/account\/activities\?activity_types=FILL&date=/.test(u) ? fillsPage : undefined) });
const O = require(H.R("outcomes.js"));
const rep = require(H.R("reporting.js"));
const S = require(H.R("state.js"));

const row = (sym) => O.buildOutcomeRow({ ticker: sym.slice(0, 3), contractSymbol: sym, premium: 5, openDate: new Date().toISOString(), contracts: 1 }, { closeTime: Date.now(), pnl: 1 });
const fill = (sym, side, qty, t, oid) => ({ activity_type: "FILL", symbol: sym, side, qty: String(qty), price: "5.00", transaction_time: `2026-10-06T${t}Z`, order_id: oid || sym + side + t });
// 10/6: recorded trades + the two lost ones (SPY 782C, QQQ 764C bought 11:10/11:13, sold during a log gap)
const rec = ["SPY261019C00780000", "SPY261019C00781000", "QQQ261019C00762000"];
const lost = ["SPY261019C00782000", "QQQ261019C00764000"];
const fills = [
  ...rec.flatMap((s, k) => [fill(s, "buy", 1, `14:0${k}:00`), fill(s, "sell", 1, `14:2${k}:00`)]),
  fill(lost[0], "buy", 1, "15:10:52"), fill(lost[0], "sell", 1, "15:40:00"),
  fill(lost[1], "buy", 1, "15:13:02"), fill(lost[1], "sell", 1, "15:41:00"),
  fill("SPY261130C00768000", "buy", 2, "13:31:30"),                        // trend-swing still open
  { activity_type: "FILL", symbol: "SPY", side: "buy", qty: "10", transaction_time: "2026-10-06T14:00:00Z" },   // stock fill: ignored
];
const open = [{ contractSymbol: "SPY261130C00768000" }];

let c = rep.checkFillsAgainstOutcomes(fills, rec.map(row), open);
H.ok(!c.ok && c.missing.map(x => x.sym).sort().join() === lost.slice().sort().join(), "10/6 replay: flags exactly the two lost trades", JSON.stringify(c.missing));
H.ok(c.noSale.length === 0 && c.boughtLost.length === 0 && c.closedAtBroker === 5, "open trend-swing and stock fills don't false-alarm", `closed at broker ${c.closedAtBroker}`);

c = rep.checkFillsAgainstOutcomes(fills, rec.concat(lost).map(row), open);
H.ok(c.ok, "clean day (every close recorded): ok");

// partial close: sold 1 of 2, rest still open -> not missing
c = rep.checkFillsAgainstOutcomes([fill("QQQ261130C00734000", "buy", 2, "14:00:00"), fill("QQQ261130C00734000", "sell", 1, "15:00:00")], [], [{ contractSymbol: "QQQ261130C00734000" }]);
H.ok(c.ok, "partial close with the rest still open: ok");

// APEX wrote a close row but Alpaca shows no sale today
c = rep.checkFillsAgainstOutcomes([], [row("QQQ261019P00750000")], []);
H.ok(!c.ok && c.noSale.length === 1, "outcome row with no sale at Alpaca: flagged");

// a buy that is neither open nor recorded nor sold
c = rep.checkFillsAgainstOutcomes([fill("SPY261019P00770000", "buy", 1, "15:00:00")], [], []);
H.ok(!c.ok && c.boughtLost.length === 1, "bought today, not open, not recorded: flagged");

// quoted CSV fields before contractSym can't shift the column
const tricky = row("SPY261019C00782000").replace(/^[^,]*/, '"10/6/2026, Tue"');
c = rep.checkFillsAgainstOutcomes([fill("SPY261019C00782000", "buy", 1, "14:00:00"), fill("SPY261019C00782000", "sell", 1, "14:30:00")], [tricky], []);
H.ok(c.ok, "quoted CSV field with a comma doesn't misread the contract column");

(async () => {
  S.state.positions = open;
  fillsPage = fills;
  const logs = []; const _le = S.logEvent;
  let html = await rep.buildRecordCheckSection({ outcomeBuffer: rec.map(row) });
  H.ok(/RECORD CHECK — Alpaca and the outcomes file disagree/.test(html) && html.includes(lost[0]) && html.includes(lost[1]), "email section names the missing trades");
  html = await rep.buildRecordCheckSection({ outcomeBuffer: rec.concat(lost).map(row) });
  H.ok(/all recorded in the outcomes file ✓/.test(html) && /5 contract\(s\) closed/.test(html), "email section on a clean day is one quiet line");
  fillsPage = undefined;
  let err = null; try { await rep.buildRecordCheckSection({ outcomeBuffer: [] }); } catch (e) { err = e.message; }
  H.ok(err && /no fill data/.test(err), "no Alpaca data: raises so the email says 'skipped' instead of a false all-clear", err || "");
  H.done();
})();
