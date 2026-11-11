// EOD report (10/7, 10/12): realized lines, open-position P&L, account-change basis + label, Sleeve column, footer,
// and the entry forward-ledger CSV incl. the mr-fade post-exit shadow columns. Runs the REAL sendEmail("eod")
// with the outgoing HTTP request intercepted — nothing is sent.
"use strict";
const H = require("./helpers"); H.quiet();
// dummy mail config AFTER helpers (which clears real keys); fetch is intercepted below, nothing is sent
process.env.RESEND_API_KEY = "test"; process.env.GMAIL_USER = "test@example.com";
H.mockBroker({ get: () => undefined });
let sent = null;
const nf = require.resolve("node-fetch", { paths: [H.ROOT] });
require(nf);
require.cache[nf].exports = async (url, opts) => {
  if (/resend\.com/.test(url)) { sent = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ id: "x" }), text: async () => "{}" }; }
  return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
};
const S = require(H.R("state.js")); const st = S.state;
const rep = require(H.R("reporting.js"));
const etDay = S.getETDateStr();
const at = (d, h = 14) => Date.parse(`${d}T${String(h + 4).padStart(2, "0")}:00:00Z`);   // h = ET hour (EDT)
const dPlus = (k) => { const t = new Date(etDay + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
const dow = new Date(etDay + "T12:00:00Z").getUTCDay();
const monday = dPlus(-((dow + 6) % 7));

(async () => {
  Object.assign(st, {
    cash: 79090.21, weekStartCash: 70000, totalRevenue: 17944,
    positions: [{ ticker: "SPY", premium: 25.72, currentPrice: 24.0, contracts: 2, cost: 5144, strike: 768, optionType: "call", expDate: "2026-11-30", entryStrategy: "trend-swing" }],
    closedTrades: [{ ticker: "SPY", pnl: 100, reason: "x", closeTime: at(monday) }, { ticker: "QQQ", pnl: -40, reason: "x", closeTime: at(etDay, 11) }],
    _alpacaTruth: { totalPnL: 604, dayBaselineSource: "apex-snapshot 2026-10-08 16:03 ET", openPositions: [{ unrealizedPnL: -185 }] },
  });
  const txt = rep.buildEmailHTML("eod").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const grab = (k, n = 70) => { const i = txt.indexOf(k); return i < 0 ? "" : txt.slice(i, i + n); };
  H.ok(/Open positions \(since entry\): \$-185\.00/.test(txt), "open positions since entry from Alpaca", grab("Open positions"));
  H.ok(/Account change today: \+\$604\.00/.test(txt) && !/vs Alpaca's prior close/.test(txt), "account change on the snapshot basis, no fallback label", grab("Account change"));
  H.ok(/Week-to-date realized \(since Mon\) \+\$60\.00/.test(txt), "week-to-date realized from closed trades", grab("Week-to-date"));
  H.ok(!/Weekly P&L|Monthly Revenue|Unrealized \(open marks\)/.test(txt), "retired mixed-basis lines are gone");
  H.ok(/Sleeve/.test(txt) && /Trend-swing/.test(txt) && !/\?\/100/.test(txt), "positions table shows the sleeve, not the retired score");
  H.ok(/autonomous SPY\/QQQ options/.test(txt) && !/Spread Trader/.test(txt), "footer updated");

  st._alpacaTruth.dayBaselineSource = "alpaca-last-equity";
  const txt2 = rep.buildEmailHTML("eod").replace(/<[^>]+>/g, " ");
  H.ok(/vs Alpaca's prior close/.test(txt2), "fallback basis is labeled in the report");

  // entry forward ledger CSV through the real sendEmail("eod")
  const now = Date.now();
  st._entryFwd = [
    { signalId: "QQQ-call-mrfade-1", ticker: "QQQ", side: "call", at: now - 70 * 60000, px: 751.89, score: 0, volPace: 0.81, fwdPct: -0.728, fwdMins: 30,
      mrInv: 750.01, mrTgt0: 754.1, mrInvMin: 2.4, mrTgtMin: null, mrMfe: 0.02, mrMae: -0.91, mr60: -0.6, mrTrack: 60, mrDone: true },
    { signalId: "QQQ-call-mrfade-2", ticker: "QQQ", side: "call", at: now - 20 * 60000, px: 743.51, score: 0, volPace: 1.2, fwdPct: null, fwdMins: null,
      mrInv: 741.65, mrTgt0: 751.2, mrInvMin: null, mrTgtMin: 14.5, mrMfe: 0.35, mrMae: -0.05, mr60: null, mrTrack: 20, mrDone: false },
    { signalId: "SPY-put-itrend-3", ticker: "SPY", side: "put", at: now - 40 * 60000, px: 774.38, score: 0, volPace: 0.55, fwdPct: 0.027, fwdMins: 30 },
  ];
  sent = null;
  await rep.sendEmail("eod");
  H.ok(sent && /Record check skipped — no fill data from Alpaca/.test(sent.html || ""), "EOD email carries the record check (skipped, and says so, when Alpaca returns nothing)");
  const att = sent && (sent.attachments || []).find(a => /^argo-entryfwd-/.test(a.filename));
  if (!att) { H.ok(false, "entryfwd CSV attached to the EOD email", sent ? `attachments: ${(sent.attachments || []).map(a => a.filename).join(", ")}` : "no email captured"); return H.done(); }
  const csv = Buffer.from(att.content, "base64").toString("utf8").trim().split("\n");
  const head = csv[0].split(","), rows = csv.slice(1).map(l => l.split(","));
  H.ok(rows.length === 3 && rows.every(r => r.length === head.length), "entryfwd CSV aligned", `header ${head.length} cols, rows ${rows.map(r => r.length).join("/")}`);
  const col = (r, k) => r[head.indexOf(k)];
  const r1 = rows.find(r => r[1] === "QQQ-call-mrfade-1"), r2 = rows.find(r => r[1] === "QQQ-call-mrfade-2"), r3 = rows.find(r => r[1] === "SPY-put-itrend-3");
  H.ok(col(r1, "mrFirst") === "invalidation" && col(r1, "mrInvHitMin") === "2.4" && col(r1, "mr60Pct") === "-0.6", "stopped fade: invalidation hit first, 60-min move recorded");
  H.ok(col(r2, "mrFirst") === "target" && col(r2, "mrTgtHitMin") === "14.5" && col(r2, "mr60Pct") === "", "fade that reverted: target hit first, still tracking");
  H.ok(col(r3, "mrInvPx") === "" && col(r3, "mrFirst") === "", "non-fade rows: mr columns blank");
  H.done();
})().catch(e => { console.log("  FAIL  harness error: " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); process.exit(1); });
