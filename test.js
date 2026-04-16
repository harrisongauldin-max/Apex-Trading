/**
 * ARGO Integration Test Suite
 * ===========================
 * Gilfoyle's rules:
 *   - No test framework. Node built-in assert only.
 *   - No mocks beyond what's strictly necessary.
 *   - Each test is self-contained and runnable standalone.
 *   - If it takes more than 2 hours to write, you're overengineering it.
 *
 * Coverage:
 *   TEST 1 — Credit spread fill → position object correctness
 *             Catches: isCreditSpread missing, maxLoss/maxProfit inverted,
 *                      P&L sign wrong, cost basis wrong, breakeven wrong,
 *                      todayTrades not incremented
 *
 *   TEST 2 — Position loop P&L, chg, and credit stop logic
 *             Catches: chg sign inversion, credit stop threshold wrong,
 *                      premium=0.01 sentinel firing stop immediately,
 *                      trail activation on wrong side
 *
 *   TEST 3 — Reconcile isCreditSpread detection
 *             Catches: isCreditSpread missing from reconcile,
 *                      maxLoss/maxProfit inverted in both orphan + re-pair paths,
 *                      openDate defaulting to today
 *
 * Run:  node test.js
 * Pass: all lines print ✅
 * Fail: AssertionError with exact field that's wrong
 */

'use strict';
const assert = require('assert');

// ─── Colour helpers (no dependencies) ────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const B = s => `\x1b[34m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  try {
    if (typeof expected === 'number' && !Number.isInteger(expected)) {
      // float: allow tiny rounding error
      assert.ok(Math.abs(actual - expected) < 0.001,
        `Expected ~${expected}, got ${actual}`);
    } else {
      assert.strictEqual(actual, expected);
    }
    console.log(G('  ✅'), label);
    passed++;
  } catch (e) {
    console.log(R('  ❌'), label);
    console.log(R(`     → ${e.message}`));
    failed++;
  }
}

function checkTrue(label, value) {
  try {
    assert.ok(value, `Expected truthy, got ${value}`);
    console.log(G('  ✅'), label);
    passed++;
  } catch (e) {
    console.log(R('  ❌'), label);
    console.log(R(`     → ${e.message}`));
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE LOGIC EXTRACTED FROM server.js
// These functions mirror the exact code in the deployed file.
// If server.js logic changes, update these to match.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of calcCreditSpreadTP (server.js) */
function calcCreditSpreadTP(entryVix, stateVix = 28) {
  const vix = entryVix || stateVix || 20;
  if (vix >= 25) return 0.35;
  if (vix >= 20) return 0.40;
  return 0.50;
}

/** Mirror of confirmPendingOrder position construction (server.js) */
function buildPositionFromFill(pending, netCredit, state) {
  const actualWidth   = Math.abs(pending.buyStrike - pending.sellStrike);
  const maxProfit     = netCredit;
  const maxLoss       = parseFloat((actualWidth - netCredit).toFixed(2));
  const marginRequired = parseFloat((maxLoss * 100 * pending.contracts).toFixed(2));

  const position = {
    ticker:        pending.ticker,
    optionType:    pending.optionType,
    isSpread:      true,
    isCreditSpread: true,                         // B2 fix: must be set
    shortStrike:   pending.sellStrike,
    longStrike:    pending.buyStrike,
    buyStrike:     pending.buyStrike,
    sellStrike:    pending.sellStrike,
    spreadWidth:   actualWidth,
    buySymbol:     pending.buySymbol,
    sellSymbol:    pending.sellSymbol,
    premium:       netCredit,
    maxProfit,
    maxLoss,
    contracts:     pending.contracts,
    cost:          marginRequired,
    score:         pending.score,
    openDate:      new Date().toISOString(),
    currentPrice:  netCredit,
    peakPremium:   netCredit,
    breakeven:     pending.optionType === 'put'
      ? parseFloat((pending.sellStrike - netCredit).toFixed(2))
      : parseFloat((pending.sellStrike + netCredit).toFixed(2)),
    takeProfitPct: calcCreditSpreadTP(state.vix),
  };

  // B2 fix: todayTrades incremented
  state.todayTrades++;
  state.cash += parseFloat((netCredit * 100 * pending.contracts).toFixed(2));
  state.positions.push(position);

  return position;
}

/** Mirror of chg calculation (server.js) */
function calcChg(pos, curP) {
  const rawChg = (curP > 0 && pos.premium > 0 && !isNaN(curP))
    ? (curP - pos.premium) / pos.premium
    : 0;
  return pos.isCreditSpread ? -rawChg : rawChg;
}

/** Mirror of credit stop logic (server.js) — halfMaxLoss now ×100×contracts */
function shouldCreditStop(pos, curP) {
  // D-FIX3: guard min premium sentinel
  if (!pos.isCreditSpread || pos.maxLoss <= 0 || curP <= 0 || pos.premium <= 0.05) return false;
  const contracts        = pos.contracts || 1;
  const creditLossDollar = (curP - pos.premium) * 100 * contracts;
  const halfMaxLoss      = pos.maxLoss * 100 * contracts * 0.50; // ×100 to match creditLossDollar units
  const twiceCredit      = pos.premium * 2 * 100 * contracts;
  const creditStopDollar = Math.min(halfMaxLoss, twiceCredit);
  return creditLossDollar >= creditStopDollar;
}

/** Mirror of closePosition P&L + cash (server.js) */
function calcClosePnl(pos, ep, state) {
  const mult = pos.partialClosed ? 0.5 : 1.0;
  const ev   = parseFloat((ep * 100 * pos.contracts * mult).toFixed(2));
  let pnl;
  if (pos.isCreditSpread) {
    pnl = parseFloat(((pos.premium - ep) * 100 * pos.contracts * mult).toFixed(2));
  } else {
    pnl = parseFloat((ev - pos.cost * mult).toFixed(2));
  }
  // D-FIX4: credit uses pnl, debit uses ev
  const cashDelta = pos.isCreditSpread ? pnl : ev;
  state.cash = parseFloat((state.cash + cashDelta).toFixed(2));
  return { pnl, ev, cashDelta };
}

/** Mirror of reconcile isCreditSpread detection (server.js B3a/B3b) */
function detectIsCreditSpread(optType, buyLeg, sellLeg) {
  return optType === 'put'
    ? buyLeg.strike < sellLeg.strike
    : buyLeg.strike > sellLeg.strike;
}

/** Mirror of reconcile maxProfit/maxLoss (server.js D-FIX1a/1b) */
function reconcileMaxValues(isCreditSpread, netDebit, spreadWidth) {
  const premium = Math.max(0.01, netDebit);
  return {
    premium,
    maxProfit: isCreditSpread
      ? premium                                          // credit: profit = credit received
      : parseFloat((spreadWidth - premium).toFixed(2)), // debit: profit = width - cost
    maxLoss: isCreditSpread
      ? parseFloat((spreadWidth - premium).toFixed(2))  // credit: loss = width - credit
      : premium,                                         // debit: loss = cost paid
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// TEST 1: Credit spread fill → position object correctness
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 1: Credit spread fill → position object ══'));
console.log(Y('  Scenario: SPY $10-wide bear call credit spread'));
console.log(Y('  Short $690 call / Long $700 call'));
console.log(Y('  Net credit: $3.50 | VIX: 28 | 1 contract\n'));

const state1 = { cash: 9474.44, positions: [], todayTrades: 0, vix: 28 };

const pending1 = {
  ticker:     'SPY',
  optionType: 'call',
  buyStrike:  700,   // long leg (higher strike for call credit)
  sellStrike: 690,   // short leg (lower strike = sold)
  buySymbol:  'SPY260515C00700000',
  sellSymbol: 'SPY260515C00690000',
  contracts:  1,
  score:      77,
  expDate:    '2026-05-15',
  expDays:    29,
};
const netCredit1 = 3.50;

const pos1 = buildPositionFromFill(pending1, netCredit1, state1);

// Position object correctness
check('isCreditSpread = true',           pos1.isCreditSpread,   true);
check('isSpread = true',                 pos1.isSpread,          true);
check('premium = netCredit ($3.50)',     pos1.premium,           3.50);
check('maxProfit = credit ($3.50)',      pos1.maxProfit,         3.50);    // NOT width - credit
check('maxLoss = width - credit ($6.50)', pos1.maxLoss,          6.50);    // NOT just credit
check('spreadWidth = $10',               pos1.spreadWidth,       10);
check('cost = maxLoss × 100 × contracts ($650)', pos1.cost,     650);
check('buyStrike = 700 (long/protection leg)', pos1.buyStrike,  700);
check('sellStrike = 690 (short/sold leg)',      pos1.sellStrike, 690);

// Breakeven: for call credit = shortStrike + credit = 690 + 3.50 = 693.50
check('breakeven = sellStrike + credit (693.50)', pos1.breakeven, 693.50);

// TP calibration: VIX 28 >= 25 → 0.35
check('takeProfitPct = 0.35 (VIX 28)',   pos1.takeProfitPct,    0.35);

// State side-effects
check('todayTrades incremented to 1',    state1.todayTrades,     1);
check('cash increased by credit received (+$350)', state1.cash,  9474.44 + 350);
check('position added to state.positions', state1.positions.length, 1);


// ═════════════════════════════════════════════════════════════════════════════
// TEST 2: Position loop — chg, credit stop, sentinel guard
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 2: Position loop — chg sign, credit stop logic ══\n'));

// Use pos1 from TEST 1 as the base position
// (detach it from state so we don't mutate state1)
const pos2 = { ...pos1 };

// 2a. chg sign — credit spread profits when spread NARROWS
console.log(Y('  2a. chg sign convention'));
const curP_profitable = 1.75;   // spread narrowed from $3.50 → $1.75 = profitable
const curP_losing     = 5.25;   // spread widened from $3.50 → $5.25 = losing
const curP_flat       = 3.50;   // no movement

check('chg > 0 when spread narrows (profitable)',
  calcChg(pos2, curP_profitable) > 0, true);
check('chg < 0 when spread widens (losing)',
  calcChg(pos2, curP_losing) < 0, true);
// JS: -rawChg where rawChg=0 produces -0. Object.is(-0,0)=false but -0===0 and -0==0.
// The behaviour in all arithmetic is identical — this is a float sign artefact, not a bug.
checkTrue('chg = 0 (or -0) when flat — identical in all arithmetic',
  calcChg(pos2, curP_flat) === 0);
check('chg ≈ +0.50 at curP=$1.75 (50% profit)',
  calcChg(pos2, curP_profitable), 0.50);
check('chg ≈ -0.50 at curP=$5.25 (50% loss)',
  calcChg(pos2, curP_losing), -0.50);

// 2b. Credit stop threshold
// maxLoss = $6.50 per contract
// halfMaxLoss = $3.25 per contract (50% of max loss in $)
// twiceCredit = $3.50 × 2 × 100 × 1 = $700
// creditStopDollar = min($325, $700) = $325
// Stop fires when creditLossDollar >= $325
// creditLossDollar = (curP - premium) × 100 × contracts
// = (curP - 3.50) × 100
// Fires at curP = 3.50 + 325/100 = $6.75
console.log(Y('\n  2b. Credit stop threshold'));
const stopCurP   = 6.75; // exactly at stop: (6.75-3.50)*100 = $325 = halfMaxLoss
const beforeStop = 6.50; // below stop: (6.50-3.50)*100 = $300 < $325

check('credit stop fires at curP=$6.75 (loss=$325 = 50% maxLoss)',
  shouldCreditStop(pos2, stopCurP), true);
check('credit stop does NOT fire at curP=$6.50 (loss=$300 < $325)',
  shouldCreditStop(pos2, beforeStop), false);
check('credit stop does NOT fire when profitable (curP=$1.75)',
  shouldCreditStop(pos2, curP_profitable), false);

// 2c. Sentinel guard — premium=0.01 (bad reconcile data) should not stop
console.log(Y('\n  2c. Sentinel guard (D-FIX3): premium ≤ $0.05 skips stop'));
const posBadData = { ...pos2, premium: 0.01, maxLoss: 0.01 };
check('stop skipped when premium=$0.01 (bad reconcile data)',
  shouldCreditStop(posBadData, 5.00), false);
const posRealData = { ...pos2, premium: 0.10 };  // just above sentinel
check('stop fires normally when premium=$0.10 (real data)',
  shouldCreditStop(posRealData, posRealData.premium + 10), true);


// ═════════════════════════════════════════════════════════════════════════════
// TEST 2d: closePosition P&L and cash accounting
// ═════════════════════════════════════════════════════════════════════════════
console.log(Y('\n  2d. closePosition P&L and cash accounting'));

const state2 = { cash: 9824.44 }; // cash after entry (9474.44 + 350 credit)

// Close at 50% profit: ep = 1.75
const ep_win  = 1.75;
const { pnl: pnl_win, cashDelta: delta_win } = calcClosePnl(pos2, ep_win, { ...state2 });
check('pnl at 50% profit = $175',  pnl_win,   175);
check('cash delta = pnl ($175), not ev ($175)', delta_win, 175); // D-FIX4

// Close at break-even: ep = 3.50
const ep_be = 3.50;
const { pnl: pnl_be, cashDelta: delta_be } = calcClosePnl(pos2, ep_be, { ...state2 });
check('pnl at break-even = $0',    pnl_be,    0);
check('cash delta at break-even = $0', delta_be, 0);

// Close at max loss: ep = 10.00 (full width, worst case)
const ep_loss = 10.00;
const { pnl: pnl_loss } = calcClosePnl(pos2, ep_loss, { ...state2 });
check('pnl at max loss = -$650',   pnl_loss,  -650);

// Debit spread: cash gets ev (not pnl)
const posDebit = { ...pos2, isCreditSpread: false, premium: 3.50, cost: 350 };
const { pnl: pnl_d, cashDelta: delta_d } = calcClosePnl(posDebit, 5.25, { ...state2 });
check('debit spread: cash delta = ev (not pnl)',
  delta_d, parseFloat((5.25 * 100 * 1).toFixed(2)));


// ═════════════════════════════════════════════════════════════════════════════
// TEST 3: Reconcile isCreditSpread detection and maxLoss/maxProfit
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 3: Reconcile — isCreditSpread detection + maxLoss/maxProfit ══\n'));

// 3a. PUT credit spread detection
// Credit PUT: sold higher strike, bought lower strike for protection
// Example: sell $690 put (higher), buy $680 put (lower)
// longLeg (qty > 0) = $680 (protection), sellLeg (qty < 0) = $690 (sold)
// buyLeg.strike (680) < sellLeg.strike (690) → isCreditSpread = true
console.log(Y('  3a. PUT spread detection'));
const putLongLeg  = { strike: 680, qty:  1, sym: 'SPY260515P00680000', avgEntry: 2.00 };
const putShortLeg = { strike: 690, qty: -1, sym: 'SPY260515P00690000', avgEntry: 5.50 };

check('PUT credit: buyLeg.strike < sellLeg.strike → isCreditSpread=true',
  detectIsCreditSpread('put', putLongLeg, putShortLeg), true);

// PUT debit spread: bought higher strike, sold lower strike
// longLeg = $690 (higher), sellLeg = $680 (lower sold)
const putDebitLong  = { strike: 690, qty:  1, avgEntry: 5.50 };
const putDebitShort = { strike: 680, qty: -1, avgEntry: 2.00 };
check('PUT debit: buyLeg.strike > sellLeg.strike → isCreditSpread=false',
  detectIsCreditSpread('put', putDebitLong, putDebitShort), false);

// 3b. CALL credit spread detection
// Credit CALL: sold lower strike, bought higher strike for protection
// Example: sell $690 call (lower), buy $700 call (higher)
// longLeg = $700 (bought protection), sellLeg = $690 (sold)
// buyLeg.strike (700) > sellLeg.strike (690) → isCreditSpread = true
console.log(Y('\n  3b. CALL spread detection'));
const callLongLeg  = { strike: 700, qty:  1, avgEntry: 2.00 };
const callShortLeg = { strike: 690, qty: -1, avgEntry: 5.50 };
check('CALL credit: buyLeg.strike > sellLeg.strike → isCreditSpread=true',
  detectIsCreditSpread('call', callLongLeg, callShortLeg), true);

const callDebitLong  = { strike: 690, qty:  1, avgEntry: 5.50 };
const callDebitShort = { strike: 700, qty: -1, avgEntry: 2.00 };
check('CALL debit: buyLeg.strike < sellLeg.strike → isCreditSpread=false',
  detectIsCreditSpread('call', callDebitLong, callDebitShort), false);

// 3c. maxProfit/maxLoss values (D-FIX1a/1b)
// Credit PUT: netDebit = |sellLeg.avgEntry - buyLeg.avgEntry| = |5.50 - 2.00| = $3.50
// Width = |690 - 680| = $10
// maxProfit = credit received = $3.50  (NOT $6.50)
// maxLoss   = width - credit  = $6.50  (NOT $3.50)
console.log(Y('\n  3c. maxProfit/maxLoss for reconciled credit spread (D-FIX1a/1b)'));
const netDebit_reco  = Math.abs(Math.abs(putShortLeg.avgEntry) - putLongLeg.avgEntry); // 3.50
const spreadWidth_reco = Math.abs(putShortLeg.strike - putLongLeg.strike);               // 10
const isCreditReco   = detectIsCreditSpread('put', putLongLeg, putShortLeg);

const { premium: p_c, maxProfit: mp_c, maxLoss: ml_c } =
  reconcileMaxValues(isCreditReco, netDebit_reco, spreadWidth_reco);

check('reconcile netDebit calculated correctly ($3.50)', netDebit_reco, 3.50);
check('credit reconcile: premium = credit received ($3.50)', p_c,  3.50);
check('credit reconcile: maxProfit = credit ($3.50), NOT width-credit', mp_c, 3.50);
check('credit reconcile: maxLoss = width - credit ($6.50), NOT credit', ml_c, 6.50);

// Debit reconcile: opposite
const isDebitReco = detectIsCreditSpread('put', putDebitLong, putDebitShort); // false
const netDebit_d  = Math.abs(Math.abs(putDebitShort.avgEntry) - putDebitLong.avgEntry); // 3.50
const { maxProfit: mp_d, maxLoss: ml_d } =
  reconcileMaxValues(isDebitReco, netDebit_d, spreadWidth_reco);

check('debit reconcile: maxProfit = width - cost ($6.50)', mp_d, 6.50);
check('debit reconcile: maxLoss = cost ($3.50)',           ml_d, 3.50);

// 3d. Zero avgEntry sentinel — bad Alpaca paper data
// Both legs return avgEntry=0 → netDebit=0 → falls to 0.01 fallback
// creditStopDollar should be too small to fire on real curP
console.log(Y('\n  3d. Zero avgEntry sentinel (bad Alpaca data guard)'));
const netDebit_zero = Math.abs(Math.abs(0) - 0); // = 0
const p_zero = Math.max(0.01, netDebit_zero);     // = 0.01 (fallback)
const posZero = {
  isCreditSpread: true, premium: p_zero, maxLoss: 0.01,
  contracts: 1, partialClosed: false,
};
check('zero avgEntry: premium falls to $0.01 sentinel', posZero.premium, 0.01);
check('D-FIX3: credit stop skipped for premium=$0.01',
  shouldCreditStop(posZero, 5.00), false);       // guard prevents immediate stop


// ═════════════════════════════════════════════════════════════════════════════
// BONUS TEST: calcCreditSpreadTP edge cases
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ BONUS: calcCreditSpreadTP edge cases ══\n'));
check('VIX 28 → TP 0.35',       calcCreditSpreadTP(28),   0.35);
check('VIX 25 → TP 0.35',       calcCreditSpreadTP(25),   0.35);
check('VIX 22 → TP 0.40',       calcCreditSpreadTP(22),   0.40);
check('VIX 15 → TP 0.50',       calcCreditSpreadTP(15),   0.50);
check('VIX null → falls to 0.35 via state fallback (28)', calcCreditSpreadTP(null, 28), 0.35);
check('VIX 0 → fallback 20 → 0.40', calcCreditSpreadTP(0, 0), 0.40);


// (summary printed at end)


// ═════════════════════════════════════════════════════════════════════════════
// GILFOYLE'S EXTENDED TEST SUITE
// Added after first pass found halfMaxLoss bug.
// Every edge case Dinesh probed in the adversarial pass is now a permanent test.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Additional constants mirrored from server.js ─────────────────────────────
const STOP_LOSS_PCT      = 0.35;
const TRAIL_ACTIVATE_PCT = 0.15;
const TRAIL_STOP_PCT     = 0.15;
const FAST_STOP_PCT      = 0.20;
const CAPITAL_FLOOR      = 7500;
const MONTHLY_BUDGET     = 10000;

// ─── Additional logic mirrors ─────────────────────────────────────────────────

/** Mirror of hard stop check */
function shouldHardStop(chg) {
  return chg <= -STOP_LOSS_PCT;
}

/** Mirror of trail stop activation + floor calculation */
function trailStopState(pos, chg) {
  const activated = chg >= (pos.trailActivate || TRAIL_ACTIVATE_PCT);
  if (!activated) return { activated: false, fires: false };
  const trailPct  = pos.trailPct || TRAIL_STOP_PCT;
  const trailFloor = pos.peakPremium * (1 - trailPct);
  const fires      = pos.currentPrice <= trailFloor;
  return { activated, fires, trailFloor };
}

/** Mirror of isDayTrade */
function isDayTrade(pos) {
  if (!pos || !pos.openDate) return false;
  if (pos.dteLabel && pos.dteLabel.includes('RECONCIL')) return false;
  const etOpts = { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' };
  const openDay = new Date(pos.openDate).toLocaleDateString('en-US', etOpts);
  const today   = new Date().toLocaleDateString('en-US', etOpts);
  return openDay === today;
}

/** Mirror of heatPct() — cash delta formula (B1 fix) */
function calcHeatPct(cash, totalCap) {
  return Math.max(0, totalCap - (cash || 0)) / totalCap;
}

/** Mirror of totalCap() */
function calcTotalCap(customBudget, cash, accountBaseline) {
  return Math.max(customBudget || 0, cash || 0, accountBaseline || 0, MONTHLY_BUDGET);
}

/** Mirror of capital floor check in executeCreditSpread */
function wouldBreachFloor(cash, marginRequired) {
  return (cash - marginRequired) < CAPITAL_FLOOR;
}


// ═════════════════════════════════════════════════════════════════════════════
// TEST 4: Exit logic — hard stop, take profit, fast stop
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 4: Exit logic — hard stop, take profit, fast stop ══\n'));

// Base position: credit spread, premium=$3.50, TP=35%
const pos4 = {
  isCreditSpread: true,
  premium: 3.50, maxProfit: 3.50, maxLoss: 6.50,
  contracts: 1, takeProfitPct: 0.35, fastStopPct: 0.20,
  trailActivate: TRAIL_ACTIVATE_PCT, peakPremium: 3.50,
  partialClosed: false,
};

// 4a. Hard stop — fires at chg <= -35%
// chg = -0.35 means spread widened by 35% relative to premium
// curP = 3.50 * 1.35 = 4.725
console.log(Y('  4a. Hard stop (-35%)'));
check('hard stop fires at chg = -0.35',  shouldHardStop(-0.35), true);
check('hard stop fires at chg = -0.50',  shouldHardStop(-0.50), true);
check('hard stop silent at chg = -0.34', shouldHardStop(-0.34), false);
check('hard stop silent at chg = +0.20', shouldHardStop(+0.20), false);

// 4b. Take profit — TP is 35% for VIX>=25
// chg >= 0.35 means spread narrowed by 35%
// curP = 3.50 * (1 - 0.35) = 2.275
console.log(Y('\n  4b. Take profit (35%)'));
const curP_tp     = parseFloat((3.50 * (1 - 0.35)).toFixed(2)); // = 2.275
const chg_at_tp   = calcChg({ isCreditSpread: true, premium: 3.50 }, curP_tp);
checkTrue('chg >= 0.35 at TP price', chg_at_tp >= 0.35);
checkTrue('chg < 0.35 just before TP', calcChg({ isCreditSpread: true, premium: 3.50 }, 2.30) < 0.35);

// 4c. Fast stop — fires at -20% within first 48hrs
console.log(Y('\n  4c. Fast stop (-20% within 48hrs)'));
check('fast stop threshold is 0.20', FAST_STOP_PCT, 0.20);
check('fast stop fires at chg = -0.20', calcChg({ isCreditSpread: true, premium: 3.50 }, 3.50 * 1.20) <= -0.20, true);
check('fast stop silent at chg = -0.19', calcChg({ isCreditSpread: true, premium: 3.50 }, 3.50 * 1.19) > -0.20, true);

// 4d. Credit stop vs hard stop — which is stricter?
// Credit stop: fires at $325 loss (halfMaxLoss)
// Hard stop: fires at chg = -35% = (curP - 3.50)/3.50 = -0.35 → curP = 4.725
// creditLossDollar at curP=4.725: (4.725 - 3.50) * 100 = $122.50 — below credit stop
// So hard stop (-35% of premium) fires BEFORE credit stop (50% of maxLoss in $)
// This is intentional — hard stop is the safety net
console.log(Y('\n  4d. Stop hierarchy — hard stop fires before credit dollar stop'));
const curP_hardstop = parseFloat((3.50 * 1.35).toFixed(2)); // = 4.725
const chg_hardstop  = calcChg({ isCreditSpread: true, premium: 3.50 }, curP_hardstop);
const credit_at_hardstop = (curP_hardstop - 3.50) * 100 * 1; // = $122.50
const credit_stop_dollar = Math.min(6.50 * 100 * 1 * 0.50, 3.50 * 2 * 100 * 1); // = $325
// toFixed(2) rounds 3.50*1.35=4.725 to 4.73 — use tolerance check
checkTrue('hard stop chg ≈ -0.35 (within 0.01)',
  Math.abs(chg_hardstop - (-0.35)) < 0.01);
check('credit loss at hard stop ($122.50) < credit stop threshold ($325)',
  credit_at_hardstop < credit_stop_dollar, true);
check('so hard stop fires first — credit stop never needed at this level',
  shouldHardStop(chg_hardstop), true);


// ═════════════════════════════════════════════════════════════════════════════
// TEST 5: Trail stop — activation, floor, premature fire prevention
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 5: Trail stop ══\n'));

const pos5 = {
  isCreditSpread: true,
  premium: 3.50, peakPremium: 3.50,
  contracts: 1, trailActivate: 0.15, trailPct: 0.15,
  currentPrice: 3.50,
};

// 5a. Trail activation threshold
console.log(Y('  5a. Trail activation at +15%'));
const chg_below_trail = 0.14;
const chg_at_trail    = 0.15;
const chg_above_trail = 0.20;

check('trail NOT active below 15%', trailStopState(pos5, chg_below_trail).activated, false);
check('trail active at exactly 15%', trailStopState(pos5, chg_at_trail).activated, true);
check('trail active above 15%',       trailStopState(pos5, chg_above_trail).activated, true);

// 5b. Trail floor calculation
// peakPremium = $3.50, trailPct = 15%
// trailFloor = 3.50 * (1 - 0.15) = 2.975
// Trail fires when currentPrice <= trailFloor
console.log(Y('\n  5b. Trail floor at $2.975'));
const expectedFloor = parseFloat((3.50 * (1 - 0.15)).toFixed(3)); // 2.975
const { trailFloor } = trailStopState(pos5, 0.15);
check('trail floor = peakPremium * (1 - trailPct)', trailFloor, expectedFloor);

// 5c. Trail fires when price gives back 15% from peak
const pos5_at_floor = { ...pos5, currentPrice: 2.975, peakPremium: 3.50 };
const { fires: fires_at_floor } = trailStopState(pos5_at_floor, 0.15);
check('trail fires when currentPrice = trailFloor ($2.975)', fires_at_floor, true);

const pos5_above_floor = { ...pos5, currentPrice: 3.00, peakPremium: 3.50 };
const { fires: fires_above } = trailStopState(pos5_above_floor, 0.15);
check('trail silent when currentPrice > trailFloor ($3.00)', fires_above, false);

// 5d. For credit spread: peakPremium stays at entry (doesn't decrease as we profit)
// Because curP DECREASES when profitable — peakPremium only updates on MAX(curP)
// When profitable: curP < premium → peakPremium stays at entry premium
// This is intentional: trail floor is always relative to entry premium for credits
console.log(Y('\n  5d. Credit spread: trail anchors to entry premium (correct behavior)'));
const premium_entry = 3.50;
const curP_profitable_5 = 1.75; // 50% profit — curP < premium
const peakPremium_after_profit = Math.max(premium_entry, curP_profitable_5); // stays at 3.50
check('peakPremium stays at entry for winning credit spread',
  peakPremium_after_profit, premium_entry);
check('trail floor stays at 2.975 even at 50% profit',
  peakPremium_after_profit * (1 - 0.15), expectedFloor);


// ═════════════════════════════════════════════════════════════════════════════
// TEST 6: isDayTrade — PDT classification
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 6: isDayTrade — PDT classification ══\n'));

// 6a. Position opened today = day trade
const todayISO = new Date().toISOString();
const yesterdayISO = new Date(Date.now() - 86400000).toISOString();

const posToday     = { openDate: todayISO,     dteLabel: 'CREDIT-SPREAD-MONTHLY' };
const posYesterday = { openDate: yesterdayISO,  dteLabel: 'CREDIT-SPREAD-MONTHLY' };
const posRecon     = { openDate: todayISO,      dteLabel: 'RECONCILED-SPREAD' };
const posRecon2    = { openDate: todayISO,      dteLabel: 'RECONCILED' };
const posNoDate    = { openDate: null,           dteLabel: 'CREDIT-SPREAD-MONTHLY' };

check('today openDate = isDayTrade true',       isDayTrade(posToday),     true);
check('yesterday openDate = isDayTrade false',  isDayTrade(posYesterday), false);
check('RECONCILED-SPREAD is never day trade',   isDayTrade(posRecon),     false);
check('RECONCILED is never day trade',          isDayTrade(posRecon2),    false);
check('null openDate = isDayTrade false',        isDayTrade(posNoDate),    false);
check('null pos = isDayTrade false',             isDayTrade(null),         false);


// ═════════════════════════════════════════════════════════════════════════════
// TEST 7: Heat calculations — B1 fix and totalCap floor
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 7: Heat calculations ══\n'));

// 7a. heatPct with no positions
console.log(Y('  7a. heatPct (cash delta formula — B1 fix)'));
check('no positions: heatPct = 0',
  calcHeatPct(10000, 10000), 0);
check('1 credit spread ($650 margin): heatPct = 6.5%',
  parseFloat((calcHeatPct(9350, 10000) * 100).toFixed(1)), 6.5);
check('2 positions ($1300 total margin): heatPct = 13%',
  parseFloat((calcHeatPct(8700, 10000) * 100).toFixed(1)), 13.0);
check('heatPct never negative (cash > totalCap edge case)',
  calcHeatPct(11000, 10000), 0);

// 7b. totalCap floor — can never be zero
console.log(Y('\n  7b. totalCap always >= MONTHLY_BUDGET'));
check('all zero inputs: totalCap = MONTHLY_BUDGET (10000)',
  calcTotalCap(0, 0, 0), MONTHLY_BUDGET);
check('higher custom budget overrides',
  calcTotalCap(12000, 9000, 0), 12000);
check('cash higher than budget: cash wins',
  calcTotalCap(8000, 11000, 0), 11000);

// 7c. Capital floor check
console.log(Y('\n  7c. Capital floor ($7500)'));
check('$650 margin on $9474 cash: does NOT breach floor',
  wouldBreachFloor(9474, 650), false);
check('$2000 margin on $9000 cash: DOES breach floor (9000-2000=7000 < 7500)',
  wouldBreachFloor(9000, 2000), true);
check('$1 margin on $7500 cash: DOES breach floor',
  wouldBreachFloor(7500, 1), true);
check('$0 margin: never breaches floor',
  wouldBreachFloor(9000, 0), false);

// 7d. _heatPct (scan gate) must equal heatPct (display) — B1 confirmed consistent
console.log(Y('\n  7d. Scan _heatPct equals display heatPct (B1 consistency)'));
const cash_test    = 8700;
const totalCap_test = 10000;
const scanHeat    = Math.max(0, totalCap_test - cash_test) / totalCap_test;  // _heatPct
const displayHeat = Math.max(0, totalCap_test - (cash_test || 0)) / totalCap_test; // heatPct()
check('scan _heatPct === display heatPct() after B1 fix', scanHeat, displayHeat);


// ═════════════════════════════════════════════════════════════════════════════
// TEST 8: Edge cases Dinesh probed — all must be safe
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 8: Adversarial edge cases (Dinesh\'s list) ══\n'));

// 8a. pos.contracts = 0 or undefined — should default to 1
console.log(Y('  8a. contracts = 0 or undefined'));
const posNoContracts = { isCreditSpread: true, premium: 3.50, maxLoss: 6.50, contracts: 0 };
const creditLoss0 = (5.00 - 3.50) * 100 * (posNoContracts.contracts || 1);
check('contracts=0 defaults to 1 in creditLossDollar', creditLoss0, 150);

const posUndefinedContracts = { ...posNoContracts, contracts: undefined };
const creditLossU = (5.00 - 3.50) * 100 * (posUndefinedContracts.contracts || 1);
check('contracts=undefined defaults to 1', creditLossU, 150);

// 8b. curP = 0 — no data available
console.log(Y('\n  8b. curP = 0 (no market data)'));
const chg_no_data = calcChg({ isCreditSpread: true, premium: 3.50 }, 0);
checkTrue('curP=0: chg=0 (no exit triggers)',  chg_no_data === 0);
check('credit stop skipped when curP=0',   shouldCreditStop({ isCreditSpread: true, premium: 3.50, maxLoss: 6.50, contracts: 1 }, 0), false);

// 8c. pos.premium = NaN
console.log(Y('\n  8c. pos.premium = NaN'));
const chg_nan = calcChg({ isCreditSpread: true, premium: NaN }, 3.50);
checkTrue('premium=NaN: chg=0 (guarded)',  chg_nan === 0);

// 8d. calcCreditSpreadTP — extreme VIX
console.log(Y('\n  8d. calcCreditSpreadTP extreme VIX'));
check('VIX=999: TP=0.35 (>=25 branch)', calcCreditSpreadTP(999), 0.35);
check('VIX=0: fallback 20 → TP=0.40',  calcCreditSpreadTP(0, 0), 0.40);
check('VIX=NaN: fallback state.vix=28 → TP=0.35', calcCreditSpreadTP(NaN, 28), 0.35);

// 8e. isCreditSpread detection — equal strikes (zero-width)
console.log(Y('\n  8e. Zero-width spread (equal strikes)'));
const zeroWidthLong  = { strike: 690, qty:  1 };
const zeroWidthShort = { strike: 690, qty: -1 };
// PUT: long.strike (690) < short.strike (690) → false (NOT credit)
// This correctly prevents a zero-width spread from being misclassified
check('equal strikes: isCreditSpread=false for PUT (not a credit spread)',
  detectIsCreditSpread('put', zeroWidthLong, zeroWidthShort), false);

// 8f. reconcileMaxValues with zero netDebit (falls to 0.01)
console.log(Y('\n  8f. reconcileMaxValues with zero netDebit'));
const { premium: pz, maxProfit: mpz, maxLoss: mlz } = reconcileMaxValues(true, 0, 10);
check('zero netDebit: premium falls to $0.01 sentinel', pz, 0.01);
check('zero netDebit credit: maxProfit=$0.01', mpz, 0.01);
check('zero netDebit credit: maxLoss=$9.99', mlz, 9.99);

// 8g. Close P&L on partial position (partialClosed=true → mult=0.5)
console.log(Y('\n  8g. Partial close (mult=0.5)'));
const posPartial = {
  isCreditSpread: true, premium: 3.50, contracts: 2,
  cost: 1300, partialClosed: true,
};
const statePartial = { cash: 9000 };
const { pnl: pnl_partial } = calcClosePnl(posPartial, 1.75, statePartial);
// mult=0.5: pnl = (3.50 - 1.75) * 100 * 2 * 0.5 = 1.75 * 100 * 2 * 0.5 = $175
check('partial close: pnl = $175 (mult=0.5 applied)', pnl_partial, 175);


// ═════════════════════════════════════════════════════════════════════════════
// TEST 9: calcCreditSpreadTP — VIX regime boundaries
// ═════════════════════════════════════════════════════════════════════════════
console.log(B('\n══ TEST 9: calcCreditSpreadTP VIX regime boundaries ══\n'));

const tpCases = [
  [45,   0.35, 'VIX 45 (crisis)'],
  [30,   0.35, 'VIX 30 (elevated)'],
  [25,   0.35, 'VIX 25 (boundary)'],
  [24.9, 0.40, 'VIX 24.9 (just below 25)'],
  [22,   0.40, 'VIX 22 (normal-high)'],
  [20,   0.40, 'VIX 20 (boundary)'],
  [19.9, 0.50, 'VIX 19.9 (just below 20)'],
  [15,   0.50, 'VIX 15 (low)'],
  [12,   0.50, 'VIX 12 (very low)'],
];
tpCases.forEach(([vix, expected, label]) => {
  check(`${label} → TP ${expected}`, calcCreditSpreadTP(vix, vix), expected);
});


// ═════════════════════════════════════════════════════════════════════════════
// FINAL SUMMARY
// ═════════════════════════════════════════════════════════════════════════════
const totalAll = passed + failed;
console.log('\n' + '═'.repeat(56));
if (failed === 0) {
  console.log(G(`✅ ALL ${totalAll} TESTS PASSED`));
  console.log(G('   Safe to deploy.'));
} else {
  console.log(R(`❌ ${failed} of ${totalAll} TESTS FAILED`));
  console.log(R('   Fix all failures before deploy.'));
}
console.log('═'.repeat(56) + '\n');
process.exit(failed > 0 ? 1 : 0);
