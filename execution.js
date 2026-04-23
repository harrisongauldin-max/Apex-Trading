// execution.js — ARGO V3.2
// Order execution: credit spreads, debit spreads, single-leg options.
// Handles order submission, fill confirmation, position state updates.
'use strict';

let dryRunMode = false; // set by scanner via setDryRunMode()
function setDryRunMode(v) { dryRunMode = v; }
const fmt = (n) => '$' + (n||0).toFixed(2);
const MAX_LOSS_PER_TRADE = 500;
const VIX_REDUCE50 = 35;
const VIX_REDUCE25 = 28;

const { alpacaGet, alpacaPost, alpacaDelete, getStockBars } = require('./broker');
const { state, logEvent, markDirty, saveStateNow }          = require('./state');
const { calcGreeks, getETTime,
        openRisk, heatPct, getDeployableCash, effectiveHeatCap,
        calcCreditSpreadTP ,
  totalCap
}                                 = require('./signals');
const { CAPITAL_FLOOR, MIN_OPTION_PREMIUM, MIN_OI,
        MAX_SPREAD_PCT, EARLY_SPREAD_PCT, TARGET_DELTA_MIN,
        TARGET_DELTA_MAX, MONTHLY_BUDGET, INDIVIDUAL_STOCKS_ENABLED,
        WATCHLIST ,
  ALPACA_OPT_SNAP
,
  ALPACA_OPTIONS, MAX_HEAT, STOP_LOSS_PCT, TAKE_PROFIT_PCT
}                                          = require('./constants');
const { confirmPendingOrder } = require('./closeEngine');
const { getDTEExitParams } = require('./exitEngine');

// ─── Injected dependencies ───────────────────────────────────────
let _dryRunMode    = false;
let _sendAlert     = async () => {};
let _syncCash      = async () => {};
let _checkFilters  = () => ({ allowed: true });
let _getDrawdown   = () => ({ level: 'normal', sizeMult: 1 });

function initExecution({ dryRunMode, sendAlert, syncCash,
                         checkAllFilters, getDrawdownProtocol } = {}) {
  if (dryRunMode      !== undefined) _dryRunMode   = dryRunMode;
  if (sendAlert)      _sendAlert   = sendAlert;
  if (syncCash)       _syncCash    = syncCash;
  if (checkAllFilters) _checkFilters = checkAllFilters;
  if (getDrawdownProtocol) _getDrawdown = getDrawdownProtocol;
}

function bsStrikeForDelta(price, targetDelta, T, sigma, optionType = "put", r = 0.05) {
  // Put:  |delta| = N(-d1) = targetDelta  =>  d1 = -normInv(targetDelta)
  // Call: |delta| = N(d1)  = targetDelta  =>  d1 = +normInv(targetDelta)
  // normInv via Beasley-Springer-Moro rational approximation
  const d = Math.max(0.01, Math.min(0.99, targetDelta));
  const q = Math.min(d, 1 - d);
  const t = Math.sqrt(-2 * Math.log(q));
  const normInvD = (d < 0.5 ? -1 : 1) * (t - (2.515517 + 0.802853*t + 0.010328*t*t) /
                   (1 + 1.432788*t + 0.189269*t*t + 0.001308*t*t*t));
  // d1: negative for puts (strike below spot), positive for calls (strike above spot)
  const d1 = optionType === "put" ? -normInvD : normInvD;
  const lnSK = d1 * sigma * Math.sqrt(T) - (r + sigma*sigma/2) * T;
  const strikeRaw = price * Math.exp(-lnSK);
  const inc = price < 200 ? 0.5 : 1;
  return Math.round(strikeRaw / inc) * inc;
}

async function getOptionsPrice(symbol) {
  try {
    const data = await alpacaGet(`/options/snapshots?symbols=${symbol}&feed=indicative`, ALPACA_OPT_SNAP);
    if (!data || !data.snapshots || !data.snapshots[symbol]) return null;
    const snap  = data.snapshots[symbol];
    const quote = snap.latestQuote || snap.latest_quote || snap.quote || {};
    const bid   = parseFloat(quote.bp || quote.bid_price || quote.b || 0);
    const ask   = parseFloat(quote.ap || quote.ask_price || quote.a || 0);
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  } catch(e) { return null; }
}

async function findContract(ticker, optionType, targetDelta, targetDTE, vix, stock, fixedExpiry = null) {
  try {
    const today = getETTime();
    const sigma = (stock && stock._realIV && stock._realIV > 0.05) ? stock._realIV : vix / 100;
    const T     = Math.max(0.01, targetDTE / 365);

    // Step 1: compute target strike via B-S inversion
    const targetStrike = bsStrikeForDelta(stock ? stock.price || 0 : 0, targetDelta, T, sigma, optionType);
    if (!targetStrike || targetStrike <= 0) return null;

    // Step 2: fetch contract list
    // If fixedExpiry: fetch only that single expiry (for protection legs)
    // Otherwise: fetch [targetDTE-7, targetDTE+14] window
    let fetchMin, fetchMax;
    if (fixedExpiry) {
      fetchMin = fixedExpiry;
      fetchMax = fixedExpiry;
    } else {
      const minDays = Math.max(7, targetDTE - 7);
      const maxDays = Math.min(60, targetDTE + 14);
      fetchMin = new Date(today.getTime() + minDays * 86400000).toISOString().split("T")[0];
      fetchMax = new Date(today.getTime() + maxDays * 86400000).toISOString().split("T")[0];
    }

    const baseUrl = `/options/contracts?underlying_symbol=${ticker}&expiration_date_gte=${fetchMin}&expiration_date_lte=${fetchMax}&type=${optionType}&limit=200`;
    let allC = [], tok = null, pages = 0;
    do {
      const pg = await alpacaGet(tok ? `${baseUrl}&page_token=${tok}` : baseUrl, ALPACA_OPTIONS);
      if (!pg || !pg.option_contracts) break;
      allC = allC.concat(pg.option_contracts);
      tok = pg.next_page_token || null;
      pages++;
    } while (tok && pages < 5);

    if (!allC.length) {
      logEvent("filter", `${ticker} findContract: no contracts ${fetchMin}->${fetchMax}`);
      return null;
    }

    // Step 3: sort by strike proximity (tiebreak: DTE proximity to targetDTE)
    allC.sort((a, b) => {
      const da = Math.abs(parseFloat(a.strike_price) - targetStrike);
      const db = Math.abs(parseFloat(b.strike_price) - targetStrike);
      if (Math.abs(da - db) > 0.01) return da - db;
      const aDTE = Math.round((new Date(a.expiration_date) - today) / 86400000);
      const bDTE = Math.round((new Date(b.expiration_date) - today) / 86400000);
      return Math.abs(aDTE - targetDTE) - Math.abs(bDTE - targetDTE);
    });

    // Step 4: batch-fetch snapshots for top 50 candidates
    const symbols = allC.slice(0, 50).map(c => c.symbol);
    const batches = [];
    for (let i = 0; i < symbols.length; i += 25) batches.push(symbols.slice(i, i+25).join(","));
    const snapResults = await Promise.all(
      batches.map(b => alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP).catch(() => null))
    );
    const snaps = snapResults.reduce((acc, r) => ({ ...acc, ...(r?.snapshots || {}) }), {});

    // Step 5: pick first contract with price and delta in acceptable range
    const deltaMin = Math.max(0.05, targetDelta - 0.12);
    const deltaMax = Math.min(0.65, targetDelta + 0.12);

    for (const c of allC.slice(0, 50)) {
      const snap = snaps[c.symbol];
      if (!snap) continue;
      const q   = snap.latestQuote || {};
      const g   = snap.greeks || {};
      const bid = parseFloat(q.bp || 0);
      const ask = parseFloat(q.ap || 0);
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid <= 0) continue;
      const delta = Math.abs(parseFloat(g.delta || 0));
      if (delta < deltaMin || delta > deltaMax) continue;
      const strike = parseFloat(c.strike_price);
      const expDTE = Math.round((new Date(c.expiration_date) - today) / 86400000);
      const otm    = Math.abs((targetStrike - strike) / targetStrike * 100);
      logEvent("filter", `${ticker} findContract: ${optionType} $${strike} | ${expDTE}DTE | delta${delta.toFixed(3)} | $${mid.toFixed(2)} | target delta${targetDelta} strike $${targetStrike}`);
      return {
        symbol:  c.symbol,
        strike,
        expDate: c.expiration_date,
        expDays: expDTE,
        premium: parseFloat(mid.toFixed(2)),
        bid, ask,
        spread:  ask > 0 ? (ask - bid) / ask : 1,
        greeks:  { delta: parseFloat(g.delta || 0).toFixed(3),
                   theta: parseFloat(g.theta || 0).toFixed(3),
                   gamma: parseFloat(g.gamma || 0).toFixed(4),
                   vega:  parseFloat(g.vega  || 0).toFixed(3) },
        oi:      parseInt(snap.openInterest || 0),
        iv:      parseFloat(snap.impliedVolatility || sigma),
      };
    }

    logEvent("filter", `${ticker} findContract: no valid ${optionType} found (target delta${targetDelta} strike $${targetStrike} window ${fetchMin}->${fetchMax})`);
    return null;
  } catch(e) {
    logEvent("error", `findContract(${ticker}): ${e.message}`);
    return null;
  }
}

function calcPositionSize(premium, score, vix) {
  // Step 1: Kelly base from actual trade history (dynamic)
  const recentTrades = (state.closedTrades || []).slice(0, 30);
  let kellyBase;

  if (recentTrades.length >= 10) {
    // Use real historical Kelly when we have enough data
    const wins    = recentTrades.filter(t => t.pnl > 0);
    const losses  = recentTrades.filter(t => t.pnl <= 0);
    const winRate = wins.length / recentTrades.length;
    const avgWin  = wins.length   ? wins.reduce((s,t) => s+t.pnl,0) / wins.length   : TAKE_PROFIT_PCT * premium * 100;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s,t) => s+t.pnl,0) / losses.length) : STOP_LOSS_PCT * premium * 100;
    const payoff  = avgLoss > 0 ? avgWin / avgLoss : 1;
    const kelly   = winRate - (1 - winRate) / payoff;
    kellyBase     = Math.max(0.05, Math.min(0.25, kelly * 0.5)); // half-Kelly, capped 5-25% of capital
  } else {
    // Bootstrap: hard cap at 1 contract until 30 live trades give real edge data
    // Paper trade Kelly is inflated — don't let it size up until live fills calibrate it
    kellyBase = 0.05; // conservative 5% of capital = typically 1 contract
  }

  // Live trading protection — never exceed 1 contract until 30 real trades recorded
  const liveTrades = (state.dataQuality || {}).realTrades || 0;
  if (liveTrades < 30) {
    // Force single contract sizing until system is calibrated on live fills
    return 1;
  }

  // Step 2: Score conviction multiplier
  // Higher score = more conviction = size up within Kelly bounds
  const convictionMult = score >= 85 ? 1.25 : score >= 75 ? 1.0 : score >= 70 ? 0.80 : 0.60;

  // Time of day sizing — reduce in first 30 mins (wide spreads, price discovery)
  // Pros size down at open — market makers widen spreads until order flow stabilizes
  const etNow  = getETTime();
  const minsSinceOpen = (etNow.getHours() - 9) * 60 + etNow.getMinutes() - 30;
  const openingMult   = minsSinceOpen < 30 ? 0.75 : 1.0; // 25% smaller in first 30 mins

  // Step 3: VIX adjustment — Guo & Whitelaw (2006): DEBIT put returns asymmetric to VIX
  // G&W finding applies to BUYING puts (debit) — premium too high at VIX > 40
  // SELLING puts (credit) is OPPOSITE — VIX > 40 = maximum premium collection
  // isCreditEntry is set from useCreditSpread flag passed through
  const isCreditEntry = (state._lastEntryType === "credit");
  const vixMult = isCreditEntry
    ? (vix >= 40 ? 1.25 : vix >= 35 ? 1.10 : 1.0)  // credit: INCREASE size at high VIX
    : (vix >= 40  ? 0.35                              // debit: G&W — VIX>40 puts overpriced
    : vix >= VIX_REDUCE50 ? 0.50                      // VIX 35-40: moderate reduction
    : vix >= VIX_REDUCE25 ? 0.75                      // VIX 25-35: slight reduction
    : 1.0);

  // Step 4: Drawdown protocol from marketContext
  const ddMult = (marketContext?.drawdownProtocol?.sizeMultiplier) || 1.0;

  // Step 5: Combine into single sizing decision
  const effectiveFraction = kellyBase * convictionMult * vixMult * ddMult * openingMult;
  const maxCost           = Math.min(
    state.cash * effectiveFraction,
    state.cash * 0.20,                     // hard cap: never more than 20% per trade
    MAX_LOSS_PER_TRADE / STOP_LOSS_PCT     // risk-based cap
  );

  const contracts = Math.max(1, Math.min(5, Math.floor(maxCost / (premium * 100))));

  // If even 1 contract exceeds the risk-based cap, return 0 to signal skip
  // Caller checks contracts < 1 and skips the trade
  if (premium * 100 > MAX_LOSS_PER_TRADE / STOP_LOSS_PCT) return 0;

  return contracts;
}

async function executeDebitSpread(stock, price, optionType, vix, score, scoreReasons, sizeMod, isMR = false) {
  try {
    const targetDelta = optionType === "call" ? (isMR ? 0.40 : 0.35) : 0.35;
    const targetDTE   = isMR ? 21 : 28;
    // Spread width: price-relative (SPY->$15, QQQ->$13, TLT->$5)
    const spreadWidth = Math.max(5, Math.round(price * 0.022));

    // Find buy (primary direction) leg
    const buyLeg = await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
    if (!buyLeg) {
      logEvent("filter", `${stock.ticker} debit spread: no buy leg found (delta${targetDelta} DTE~${targetDTE})`);
      return null;
    }

    // Find sell (protection) leg on same expiry, spreadWidth away
    const sellStrike = optionType === "put" ? buyLeg.strike - spreadWidth : buyLeg.strike + spreadWidth;
    const sellDelta  = Math.max(0.05, parseFloat(buyLeg.greeks.delta) - 0.15);  // approx further OTM
    const sellLeg    = await findContract(stock.ticker, optionType, sellDelta, targetDTE, vix, stock, buyLeg.expDate);
    if (!sellLeg) {
      logEvent("filter", `${stock.ticker} debit spread: no sell leg found on ${buyLeg.expDate}`);
      return null;
    }

    const actualWidth = Math.abs(buyLeg.strike - sellLeg.strike);
    if (actualWidth < spreadWidth * 0.5) {
      logEvent("filter", `${stock.ticker} debit spread: width $${actualWidth} too narrow`);
      return null;
    }

    const netDebit = parseFloat((buyLeg.premium - sellLeg.premium).toFixed(2));
    if (netDebit <= 0) {
      logEvent("filter", `${stock.ticker} debit spread: no debit (${netDebit}) - legs mispriced`);
      return null;
    }

    const rrRatio = actualWidth > 0 ? netDebit / actualWidth : 1;
    if (rrRatio > 0.40) {
      logEvent("filter", `${stock.ticker} debit spread R/R ${(rrRatio*100).toFixed(0)}% (debit $${netDebit} / width $${actualWidth}) - above 40% max`);
      return null;
    }

    logEvent("filter", `${stock.ticker} debit spread: buy $${buyLeg.strike} / sell $${sellLeg.strike} | width $${actualWidth} | net $${netDebit} | R/R ${(rrRatio*100).toFixed(0)}%`);
    return await executeSpreadTrade(stock, price, score, scoreReasons, vix, optionType, buyLeg, sellLeg, false);
  } catch(e) {
    logEvent("error", `executeDebitSpread(${stock.ticker}): ${e.message}`);
    return null;
  }
}

async function executeIronCondor(stock, price, score, scoreReasons, vix) {
  try {
    const ivRankNow = state._ivRank || 50;
    if (ivRankNow < 60) { logEvent("filter", `${stock.ticker} iron condor: IVR ${ivRankNow} < 60`); return null; }
    if (vix > 35)        { logEvent("filter", `${stock.ticker} iron condor: VIX ${vix} too high`); return null; }

    const targetDTE   = 21;
    const spreadWidth = Math.max(5, Math.round(price * 0.022));

    logEvent("filter", `${stock.ticker} iron condor: VIX ${vix.toFixed(1)} | IVR ${ivRankNow} | width $${spreadWidth}`);

    // Put side short leg
    const putShort = await findContract(stock.ticker, "put", 0.20, targetDTE, vix, stock);
    if (!putShort) { logEvent("filter", `${stock.ticker} iron condor: no put short leg`); return null; }
    // Put side long leg (same expiry, spreadWidth below)
    const putLong = await findContract(stock.ticker, "put", 0.08, targetDTE, vix, stock, putShort.expDate);
    if (!putLong)  { logEvent("filter", `${stock.ticker} iron condor: no put long leg`); return null; }
    // Call side short leg
    const callShort = await findContract(stock.ticker, "call", 0.20, targetDTE, vix, stock);
    if (!callShort) { logEvent("filter", `${stock.ticker} iron condor: no call short leg`); return null; }
    // Call side long leg (same expiry, spreadWidth above)
    const callLong = await findContract(stock.ticker, "call", 0.08, targetDTE, vix, stock, callShort.expDate);
    if (!callLong)  { logEvent("filter", `${stock.ticker} iron condor: no call long leg`); return null; }

    const putCredit   = parseFloat((putShort.premium  - putLong.premium).toFixed(2));
    const callCredit  = parseFloat((callShort.premium - callLong.premium).toFixed(2));
    const totalCredit = parseFloat((putCredit + callCredit).toFixed(2));
    if (totalCredit <= 0.50) { logEvent("filter", `${stock.ticker} iron condor: total credit $${totalCredit} too low`); return null; }

    const putWidth  = Math.abs(putShort.strike  - putLong.strike);
    const callWidth = Math.abs(callShort.strike - callLong.strike);
    const maxLoss   = Math.max(putWidth, callWidth) - totalCredit;
    if (maxLoss <= 0) { logEvent("filter", `${stock.ticker} iron condor: invalid max loss`); return null; }
    const rrRatio   = totalCredit / maxLoss;
    if (rrRatio < 0.20) { logEvent("filter", `${stock.ticker} iron condor: R/R ${(rrRatio*100).toFixed(0)}% below 20%`); return null; }

    const marginRequired = parseFloat((maxLoss * 100).toFixed(2));
    const creditCapPct   = (state.closedTrades||[]).filter(t=>t.pnl>0).length >= 20 ? 0.25 : 0.15;
    if (marginRequired > state.cash * creditCapPct) { logEvent("filter", `${stock.ticker} iron condor: margin $${marginRequired} exceeds limit`); return null; }
    if (_dryRunMode) {
      logEvent("dryrun", `WOULD IRON CONDOR ${stock.ticker} put $${putShort.strike}/$${putLong.strike} call $${callShort.strike}/$${callLong.strike} | credit $${totalCredit} | R/R ${(rrRatio*100).toFixed(0)}%`);
      return null;
    }

    logEvent("trade", `[IRON CONDOR] ${stock.ticker} put $${putShort.strike}/$${putLong.strike} | call $${callShort.strike}/$${callLong.strike} | credit $${totalCredit}`);
    const _clientOrderId = `argo-ic-${stock.ticker}-${Math.floor(Date.now()/10000)}`;
    const mlegBody = {
      order_class: "mleg", type: "limit", time_in_force: "day", qty: "1",
      limit_price: String(-totalCredit),
      client_order_id: _clientOrderId,
      legs: [
        { symbol: putShort.symbol,  side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
        { symbol: putLong.symbol,   side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"  },
        { symbol: callShort.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
        { symbol: callLong.symbol,  side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"  },
      ],
    };
    const resp = await alpacaPost("/orders", mlegBody);
    if (!resp || resp.code || !resp.id) { logEvent("warn", `${stock.ticker} iron condor order failed: ${JSON.stringify(resp)?.slice(0,200)}`); return null; }
    logEvent("trade", `[IRON CONDOR] submitted: ${resp.id}`);
    return { pending: true };
  } catch(e) {
    logEvent("error", `executeIronCondor(${stock.ticker}): ${e.message}`);
    return null;
  }
}

async function executeSpreadTrade(stock, price, score, scoreReasons, vix, optionType, buyContract, sellContract, isChoppyEntry = false) {
  if (!buyContract || !sellContract) return null;
  // BUG-3: Duplicate order guard - same protection as credit spreads
  // If Alpaca already has a short leg in this ticker+direction, don't add another long+short pair
  if (!_dryRunMode) {
    const existingSameDir = state.positions.filter(p =>
      p.ticker === stock.ticker && p.optionType === optionType
    );
    if (existingSameDir.length > 0) {
      logEvent("filter", `[SPREAD] Duplicate guard: ${stock.ticker} already has ${existingSameDir.length} ${optionType} position(s) - skipping`);
      return null;
    }
  }

  // - Score-based contract sizing -
  // Before 30 fills (Kelly pre-activation): scale by conviction
  // Hard cap: never more than 15% of cash per position
  const netDebit  = parseFloat((buyContract.premium - sellContract.premium).toFixed(2));
  const costPer1  = parseFloat((netDebit * 100).toFixed(2));
  // Scale position cap based on validated win count
  // Under 20 profitable trades: conservative 15% - system unvalidated
  // 20+ profitable trades: unlock 25% - system has demonstrated edge
  const profitableTradeCount = (state.closedTrades || []).filter(t => t.pnl > 0).length;
  // SIZING HIERARCHY (explicit priority order):
  // 1. Score-based starting point: score>=90=3, score>=80=2, else=1
  // 2. Kelly adjustment: multiplies base by Kelly fraction (win-rate informed)
  // 3. posCapPct hard dollar cap: overrides everything - max 15%/25% of cash
  // This order is intentional: score sets intent, Kelly adjusts for edge, cap enforces risk limit
  const posCapPct = profitableTradeCount >= 20 ? 0.25 : 0.15;
  if (profitableTradeCount < 20) logEvent("filter", `Position cap at 15% (${profitableTradeCount}/20 profitable trades - unlocks at 20)`);
  const cashCap   = Math.floor((state.cash * posCapPct) / costPer1);
  let baseContracts;
  if (score >= 90)      baseContracts = 3;
  else if (score >= 80) baseContracts = 2;
  else                  baseContracts = 1;
  // High risk day: halve sizing
  // If _dayPlan is null (e.g. after mid-day reset), default to high risk (conservative)
  // A missing day plan should never unlock full sizing - fail safe, not fail open
  // 200MA bear regime: additional 50% size reduction (stacks with other multipliers)
  // Derived from state directly -- spyBelow200MA is a runScan-scoped var, not available here
  // Panel: _dayPlan defaults to normal (was null→high, causing permanent 50% sizing)
  // High risk day only applies when _dayPlan is explicitly set with riskLevel="high"
  const riskMult = (state._dayPlan?.riskLevel === "high" ? 0.5 : 1.0);
  // 3B: Score-proportional sizing - higher conviction = larger position (pre-30 fills cap still applies)
  // Applied downstream as a multiplier on contract count
  const scoreSizeMult = (score) => score >= 90 ? 2.0 : score >= 85 ? 1.5 : score >= 80 ? 1.25 : 1.0;
  // AG-7: positionSizeMult from agent - continuous sizing vs binary riskLevel
  // Cap at 1.0 before 30 fills - agent amplification only unlocks on validated system
  const rawAgentSizeMult = (state._agentMacro || {}).positionSizeMult || 1.0;
  const agentSizeMult = (state.closedTrades||[]).length < 30
    ? Math.min(1.0, Math.max(0.25, rawAgentSizeMult))  // capped at 1.0 pre-validation
    : Math.min(1.5, Math.max(0.25, rawAgentSizeMult)); // full range post-validation
  // Hard cap: before 30 fills, never exceed 3 contracts regardless of multipliers
  // After 30 fills, trust the Kelly/sizing system - it's been validated
  const preFillCap  = (state.closedTrades||[]).length < 30 ? 3 : 99;
  // 3B: Apply score-proportional multiplier to debit spread sizing
  const scoreMultiplier = scoreSizeMult(score);
  const ivDebitMult = 1.0; // debit spreads don't benefit from high IV (they pay it)
  const contracts   = Math.max(1, Math.min(cashCap, preFillCap, Math.floor(baseContracts * riskMult * agentSizeMult * scoreMultiplier)));
  if (scoreMultiplier > 1.0) logEvent("scan", `[SIZING] ${stock?.ticker||''} debit spread: ${scoreMultiplier}x score mult (score ${score})`);

  const actualSpreadWidth = Math.abs(buyContract.strike - sellContract.strike);
  const maxProfit = parseFloat((actualSpreadWidth - netDebit).toFixed(2));
  const maxLoss   = netDebit;
  const finalCost = parseFloat((netDebit * 100 * contracts).toFixed(2));

  if (finalCost > state.cash * posCapPct) {
    logEvent("filter", `${stock.ticker} spread cost $${finalCost} exceeds ${(posCapPct*100).toFixed(0)}% position limit`);
    return null;
  }
  if (state.cash - finalCost < CAPITAL_FLOOR) {
    logEvent("filter", `${stock.ticker} spread would breach capital floor`);
    return null;
  }
  // Gate on Alpaca's actual options buying power - prevents rejected orders
  // options_buying_power is separate from cash - naked puts reserve margin
  const optBP = state.alpacaOptBP || state.alpacaBuyPower || state.cash;
  if (finalCost > optBP) {
    logEvent("filter", `${stock.ticker} spread cost $${finalCost} exceeds Alpaca options buying power $${optBP.toFixed(2)} - skip`);
    return null;
  }

  let buyOrderId  = null;
  let sellOrderId = null;

  // - DRY RUN - log what would happen, don't submit orders -
  if (_dryRunMode) {
    logEvent("dryrun", `WOULD BUY SPREAD ${stock.ticker} $${buyContract.strike}/${sellContract.strike} ${optionType.toUpperCase()} exp ${buyContract.expDate} | net debit $${netDebit} | max profit $${maxProfit} | max loss $${maxLoss} | cost $${finalCost} | score ${score}`);
    return null;
  }

  if (buyContract.symbol && sellContract.symbol && !_dryRunMode) {
    try {
      // - MULTI-LEG ORDER - both legs submit and fill atomically -
      // Uses Alpaca mleg order class - no partial fill risk, no sequential timing
      // limit_price = net debit (positive = we pay, negative = we receive)
      // Use mid price for better fills than ask/bid separately
      const buyMid  = buyContract.bid > 0 && buyContract.ask > 0
        ? parseFloat(((buyContract.bid + buyContract.ask) / 2).toFixed(2))
        : parseFloat(buyContract.ask.toFixed(2));
      const sellMid = sellContract.bid > 0 && sellContract.ask > 0
        ? parseFloat(((sellContract.bid + sellContract.ask) / 2).toFixed(2))
        : parseFloat(sellContract.bid.toFixed(2));
      const netDebitLimit = parseFloat((buyMid - sellMid).toFixed(2));

      // C2: Idempotency key -- prevents duplicate fills on network timeout
      const _clientOrderId = `argo-ds-${stock.ticker}-${optionType}-${Math.floor(Date.now()/10000)}`;
      const mlegBody = {
        order_class:    "mleg",
        type:           "limit",
        time_in_force:  "day",
        qty:            String(contracts),
        limit_price:    String(netDebitLimit), // positive = debit
        client_order_id: _clientOrderId,
        legs: [
          { symbol: buyContract.symbol,  side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"  },
          { symbol: sellContract.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
        ],
      };

      // C1: Record pending order BEFORE Alpaca submission (crash safety)
      state._pendingOrder = {
        orderId:      _clientOrderId,
        ticker:       stock.ticker,
        optionType,
        buySymbol:    buyContract.symbol,
        sellSymbol:   sellContract.symbol,
        buyStrike:    buyContract.strike,
        sellStrike:   sellContract.strike,
        netDebit,
        netDebitLimit,
        finalCost,
        contracts,
        score,
        scoreReasons,
        expDate:      buyContract.expDate,
        expDays:      buyContract.expDays,
        submittedAt:  Date.now(),
        isSpread:     true,
        isChoppyEntry,
        mlegBody,
        _preSubmit:   true,
      };
      markDirty();

      logEvent("trade", `[SPREAD] Submitting mleg order: buy $${buyContract.strike} / sell $${sellContract.strike} | ${contracts}x | net debit $${netDebitLimit} | id: ${_clientOrderId}`);
      const mlegResp = await alpacaPost("/orders", mlegBody);

      if (!mlegResp || mlegResp.code || !mlegResp.id) {
        logEvent("warn", `[SPREAD] mleg order failed: ${JSON.stringify(mlegResp)?.slice(0,200)}`);
        return null;
      }

      buyOrderId  = mlegResp.id;
      sellOrderId = mlegResp.id;
      // Replace pre-submit client_order_id with real Alpaca order ID
      state._pendingOrder.orderId    = mlegResp.id;
      state._pendingOrder._preSubmit = false;
      markDirty();
      logEvent("trade", `[SPREAD] mleg order submitted: ${mlegResp.id} | status: ${mlegResp.status}`);
      logEvent("trade", `[SPREAD] Order pending - will confirm fill on next scan`);
      return { pending: true };
    } catch(e) {
      logEvent("error", `[SPREAD] mleg order error: ${e.message}`);
      state._pendingOrder = null;
      return null;
    }
  }
  return null;
}

async function executeCreditSpread(stock, price, score, scoreReasons, vix, optionType, sizeMod = 1.0, spreadParamsOverride = null) {
  try {
    // -- CREDIT SPREAD CONTRACT SELECTION -------------------------------------
    // Rebuilt from scratch. Simple, direct, no layered abstraction.
    //
    // Step 1: Compute target short strike from delta (not OTM%)
    // Step 2: Fetch the options chain for the target expiry window only
    // Step 3: Find the contract closest to the target strike with valid price
    // Step 4: Find the long leg protection contract on the same expiry
    // Step 5: Validate width, credit, and R/R
    // -------------------------------------------------------------------------

    // Parameters from entryEngine or sensible defaults
    const targetDelta  = (spreadParamsOverride && spreadParamsOverride.shortDeltaTarget) || 0.20;
    const targetDTE    = (spreadParamsOverride && spreadParamsOverride.targetDTE)        || 35; // panel: 35 DTE lands on monthlies, matches TP/stop calibration
    const minDTE       = (spreadParamsOverride && spreadParamsOverride.minDTE)           || 21; // panel: raised from 14 to match 35 DTE target (avoid weeklies)
    const minCreditRR  = (spreadParamsOverride && spreadParamsOverride.minCreditRatio)   || 0.25;  // panel CRITICAL #1: 0.20 is breakeven, 0.25 is true EV-positive floor
    // Spread width: price-relative from entryEngine spreadParams (panel 4/22/2026)
    // creditWidthPct: VIX>35=1.5%, VIX28-35=1.0%, VIX20-28=0.8%, VIX<20=disabled
    // Clamp: min $2 (bid-ask eats smaller credits), max $15 (SPY cap)
    const widthPct     = (spreadParamsOverride && spreadParamsOverride.creditWidthPct) || 0.010;
    const baseWidth    = (spreadParamsOverride && spreadParamsOverride.creditWidth)    || 10;
    const priceRelWidth = widthPct > 0 ? Math.round(price * widthPct * 2) / 2 : baseWidth; // round to $0.50
    const spreadWidth  = Math.max(2, Math.min(15, priceRelWidth));
    logEvent("filter", `${stock.ticker} credit width: $${spreadWidth} (${(widthPct*100).toFixed(1)}% of $${price.toFixed(0)} price)`);

    // -- STEP 1: Target strike via B-S delta inversion ----------------------
    // Use live IV from prefetch, fallback to VIX/100
    const sigma = (stock._realIV && stock._realIV > 0.05) ? stock._realIV : vix / 100;
    const T     = Math.max(0.01, targetDTE / 365);
    const r     = 0.05;
    // Delta inversion via A&S rational approximation — option-type aware
    // PUT:  target strike BELOW price → invPhi(1 - delta)
    // CALL: target strike ABOVE price → invPhi(delta)
    // Using wrong formula for calls was targeting ITM strikes (below price)
    const _p = optionType === "put" ? (1 - targetDelta) : targetDelta;
    const _q = Math.min(_p, 1 - _p);
    const _t = Math.sqrt(-2 * Math.log(_q));
    const _num = 2.515517 + 0.802853*_t + 0.010328*_t*_t;
    const _den = 1 + 1.432788*_t + 0.189269*_t*_t + 0.001308*_t*_t*_t;
    const _z   = (_p < 0.5 ? -1 : 1) * (_t - _num/_den);
    const shortStrikeRaw = price * Math.exp(-(_z * sigma * Math.sqrt(T) - (r + sigma*sigma/2) * T));
    const inc = price < 200 ? 0.5 : 1;  // $0.50 increments for TLT/GLD, $1 for SPY/QQQ
    const shortStrike = Math.round(shortStrikeRaw / inc) * inc;
    const longStrike  = optionType === "put" ? shortStrike - spreadWidth : shortStrike + spreadWidth;
    const actualOTM   = Math.abs((price - shortStrike) / price * 100);
    logEvent("filter", `${stock.ticker} credit spread: $${spreadWidth} wide | target delta ${targetDelta} -> short $${shortStrike} (${actualOTM.toFixed(1)}% OTM) / long $${longStrike} | ?=${(sigma*100).toFixed(0)}% DTE~${targetDTE}`);

    // -- STEP 2: Fetch options chain for target expiry window only -----------
    // Fetch minDTE->(targetDTE+14) window so short-dated weeklies don't fill the 1000-cap.
    // This is the fix that stopped May contracts being crowded out by Apr weeklies.
    const today      = getETTime();
    const fetchMin   = new Date(today.getTime() + minDTE * 86400000).toISOString().split("T")[0];
    const fetchMax   = new Date(today.getTime() + Math.min(45, targetDTE + 14) * 86400000).toISOString().split("T")[0];
    const chainUrl   = `/options/contracts?underlying_symbol=${stock.ticker}&expiration_date_gte=${fetchMin}&expiration_date_lte=${fetchMax}&type=${optionType}&limit=200`;

    let chainContracts = [];
    let pageToken  = null;
    let pages = 0;
    do {
      const url  = pageToken ? `${chainUrl}&page_token=${pageToken}` : chainUrl;
      const page = await alpacaGet(url, ALPACA_OPTIONS);
      if (!page || !page.option_contracts) break;
      chainContracts = chainContracts.concat(page.option_contracts);
      pageToken = page.next_page_token || null;
      pages++;
    } while (pageToken && pages < 5);

    if (!chainContracts.length) {
      logEvent("filter", `${stock.ticker} credit spread: no contracts in window ${fetchMin}->${fetchMax}`);
      return null;
    }
    logEvent("filter", `${stock.ticker} credit spread: ${chainContracts.length} contracts in window (${fetchMin}->${fetchMax})`);

    // -- STEP 3: Find short leg - closest contract to shortStrike, on best expiry -
    // Sort by DTE closeness FIRST, then strike proximity within that expiry.
    // Critical: wrong expiry at same strike = wrong delta = wrong premium.
    // A near-dated (14DTE) contract at $649 has delta 0.09 vs a 21DTE having delta 0.21.
    // Prior sort (strike first) was picking the wrong expiry causing delta mismatch.
    chainContracts.sort((a, b) => {
      const aExpDTE = Math.round((new Date(a.expiration_date) - today) / 86400000);
      const bExpDTE = Math.round((new Date(b.expiration_date) - today) / 86400000);
      const aDTEDist = Math.abs(aExpDTE - targetDTE);
      const bDTEDist = Math.abs(bExpDTE - targetDTE);
      // Primary sort: prefer expiry closest to targetDTE (within 7 days = same group)
      if (Math.abs(aDTEDist - bDTEDist) > 7) return aDTEDist - bDTEDist;
      // Secondary sort: within same expiry group, prefer strike closest to target
      const aDist = Math.abs(parseFloat(a.strike_price) - shortStrike);
      const bDist = Math.abs(parseFloat(b.strike_price) - shortStrike);
      return aDist - bDist;
    });

    // Fetch snapshots for top candidates (sorted by strike proximity)
    const candidateSymbols = chainContracts.slice(0, 50).map(c => c.symbol);
    const snapBatches = [];
    for (let i = 0; i < candidateSymbols.length; i += 25)
      snapBatches.push(candidateSymbols.slice(i, i+25).join(","));

    const snapResults = await Promise.all(snapBatches.map(b =>
      alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP)
    ));
    const snapshots = snapResults.reduce((acc, r) => ({ ...acc, ...(r?.snapshots || {}) }), {});

    // Find best short leg contract: has price, delta in range, closest to target strike
    // Select short leg by closest delta to targetDelta — more accurate than BS target strike
    let shortContract = null;
    let _bestDeltaDist = Infinity;
    for (const c of chainContracts.slice(0, 50)) {
      const snap   = snapshots[c.symbol];
      if (!snap) continue;
      const quote  = snap.latestQuote || {};
      const greeks = snap.greeks || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid <= 0) continue;
      const delta  = Math.abs(parseFloat(greeks.delta || 0));
      if (delta < 0.10 || delta > 0.40) continue;
      const deltaDist = Math.abs(delta - targetDelta);
      if (deltaDist >= _bestDeltaDist) continue;
      const strike = parseFloat(c.strike_price);
      const expDTE = Math.round((new Date(c.expiration_date) - today) / 86400000);
      _bestDeltaDist = deltaDist;
      shortContract = {
        symbol:  c.symbol,
        strike,
        expDate: c.expiration_date,
        expDays: expDTE,
        premium: parseFloat(mid.toFixed(2)),
        bid, ask,
        spread:  ask > 0 ? (ask - bid) / ask : 1,
        greeks:  { delta: parseFloat(greeks.delta || 0).toFixed(3) },
        oi:      parseInt(snap.openInterest || 0),
        iv:      parseFloat(snap.impliedVolatility || sigma),
      };
    }
    if (shortContract) {
      const _d = Math.abs(parseFloat(shortContract.greeks.delta));
      logEvent("filter", `${stock.ticker} short leg: $${shortContract.strike} | ${shortContract.expDays}DTE | delta${_d.toFixed(3)} | $${shortContract.premium} (closest to target delta ${targetDelta})`);
    }

    if (!shortContract) {
      logEvent("filter", `${stock.ticker} credit spread: no valid short leg found in window`);
      return null;
    }

    // -- STEP 4: Find long leg - same expiry, spreadWidth away --------------
    const longStrikeActual = optionType === "put"
      ? shortContract.strike - spreadWidth
      : shortContract.strike + spreadWidth;

    // Filter chain to same expiry, find closest to longStrikeActual
    const sameExpiry = chainContracts.filter(c => c.expiration_date === shortContract.expDate);
    sameExpiry.sort((a, b) =>
      Math.abs(parseFloat(a.strike_price) - longStrikeActual) -
      Math.abs(parseFloat(b.strike_price) - longStrikeActual)
    );

    // Pre-fetch snapshots for long leg candidates in one batch (avoids serial Alpaca calls)
    const longCandidates = sameExpiry.slice(0, 20);
    const longSymbolsNeeded = longCandidates.map(c => c.symbol).filter(s => !snapshots[s]);
    if (longSymbolsNeeded.length > 0) {
      const longBatches = [];
      for (let i = 0; i < longSymbolsNeeded.length; i += 25)
        longBatches.push(longSymbolsNeeded.slice(i, i+25).join(","));
      const longSnaps = await Promise.all(longBatches.map(b =>
        alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP).catch(() => null)
      ));
      longSnaps.forEach(r => { if (r?.snapshots) Object.assign(snapshots, r.snapshots); });
    }

    let longContract = null;
    for (const c of longCandidates) {
      const snap   = snapshots[c.symbol];
      if (!snap) continue;
      const quote  = snap.latestQuote || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid <= 0) continue;
      const strike = parseFloat(c.strike_price);
      longContract = {
        symbol:  c.symbol,
        strike,
        expDate: c.expiration_date,
        expDays: shortContract.expDays,
        premium: parseFloat(mid.toFixed(2)),
        bid, ask,
      };
      break;
    }

    if (!longContract) {
      logEvent("filter", `${stock.ticker} credit spread: no long leg found at $${longStrikeActual} on ${shortContract.expDate}`);
      return null;
    }

    const actualWidth = Math.abs(shortContract.strike - longContract.strike);
    if (actualWidth < spreadWidth * 0.5) {
      logEvent("filter", `${stock.ticker} credit spread: width $${actualWidth} too narrow (need ? $${(spreadWidth * 0.5).toFixed(0)})`);
      return null;
    }
    logEvent("filter", `${stock.ticker} long leg: $${longContract.strike} | width $${actualWidth} | $${longContract.premium.toFixed(2)}`);

    // Dinesh/Gilfoyle: bid-ask stability gate — Alpaca returns bid+ask on all option snapshots
    // Wide bid-ask = market maker uncertainty = mispriced credit (gap days, illiquid strikes)
    // Gate on both legs: unstable long leg means exit cost is uncertain
    const MAX_SPREAD_PCT = 0.20; // 20% of mid — tighter than panel's 15% for safety
    const shortMid = shortContract.bid > 0 ? (shortContract.ask + shortContract.bid) / 2 : shortContract.premium;
    const longMid  = longContract.bid  > 0 ? (longContract.ask  + longContract.bid)  / 2 : longContract.premium;
    // Dinesh: no-quote guard — bid=0 AND ask=0 means no market, not a stable spread
    const shortNoQuote   = shortContract.bid <= 0 && shortContract.ask <= 0;
    const longNoQuote    = longContract.bid  <= 0 && longContract.ask  <= 0;
    const shortSpreadPct = shortNoQuote ? 1.0 : shortMid > 0 ? (shortContract.ask - shortContract.bid) / shortMid : 0;
    const longSpreadPct  = longNoQuote  ? 1.0 : longMid  > 0 ? (longContract.ask  - longContract.bid)  / longMid  : 0;
    if (shortSpreadPct > MAX_SPREAD_PCT) {
      logEvent("filter", `${stock.ticker} credit spread skipped — short leg bid-ask ${(shortSpreadPct*100).toFixed(0)}% of mid (unstable market, retry next scan)`);
      return null;
    }
    if (longSpreadPct > MAX_SPREAD_PCT) {
      logEvent("filter", `${stock.ticker} credit spread skipped — long leg bid-ask ${(longSpreadPct*100).toFixed(0)}% of mid (unstable market, retry next scan)`);
      return null;
    }

    // let so retry block can reassign — all downstream code naturally uses correct values
    let netCredit  = parseFloat((shortContract.premium - longContract.premium).toFixed(2));
    if (netCredit <= 0) { logEvent("filter", `${stock.ticker} credit spread: no credit available (${netCredit})`); return null; }

    let maxProfit  = netCredit;                              // keep all credit if expires worthless
    let maxLoss    = parseFloat((actualWidth - netCredit).toFixed(2)); // width - credit = max risk

    // V2.84: Risk/reward validation for credit spreads
    // Maximum acceptable risk/reward ratio: 4:1 (risk $400 to make $100)
    // This requires ~80% win rate to break even -- achievable with proper strike selection
    // Worse than 4:1 (e.g. TLT $97 profit / $903 loss = 9.3:1) is not a viable strategy
    const rrRatioCred = maxLoss > 0 ? maxProfit / maxLoss : 0;
    const MIN_CREDIT_RR = (spreadParamsOverride && spreadParamsOverride.minCreditRatio) || 0.20; // PAPER: 0.20 floor — meaningful entries. Production: 0.26/0.28.
    if (rrRatioCred < MIN_CREDIT_RR) {
      // Cache actual market R/R in state so score debug shows real execution viability
      if (!state._lastCreditRR) state._lastCreditRR = {};
      state._lastCreditRR[stock.ticker] = {
        ts: Date.now(), rr: rrRatioCred, netCredit, maxLoss, width: actualWidth,
        viable: false, reason: `market R/R ${(rrRatioCred*100).toFixed(0)}% < ${(MIN_CREDIT_RR*100).toFixed(0)}% min ($${netCredit} credit on $${actualWidth} wide)`
      };
      // Richard/Gilfoyle/Dinesh: width retry — compute narrowest width achieving 25% R/R
      // Algebraic inversion: credit/(width-credit) >= 0.25  →  maxWidth = 5 × netCredit
      // sameExpiry + snapshots already in memory — zero extra Alpaca calls
      // Dynamic retry width: solve credit/(width-credit) >= MIN_CREDIT_RR algebraically
      // width <= credit * (1 + 1/MIN_CREDIT_RR). Was hardcoded to 5x (= 1 + 1/0.25 = 25% floor).
      // Now uses actual MIN_CREDIT_RR so retry is consistent with the VIX-tiered floor.
      const _retryMultiplier = 1 + (1 / MIN_CREDIT_RR); // e.g. at 26%: 1 + 3.846 = 4.846
      const _retryWidth = Math.max(2, Math.round(netCredit * _retryMultiplier * 2) / 2); // round to $0.50
      if (_retryWidth >= actualWidth) {
        logEvent("filter", `${stock.ticker} credit spread R/R ${(rrRatioCred*100).toFixed(0)}% (credit $${netCredit} / risk $${maxLoss}) — below ${(MIN_CREDIT_RR*100).toFixed(0)}% minimum — skip`);
        return null;
      }
      const _retryLongStrike = optionType === "put"
        ? shortContract.strike - _retryWidth
        : shortContract.strike + _retryWidth;
      const _retryCandidate = sameExpiry
        .filter(c => snapshots[c.symbol])
        .map(c => ({ c, dist: Math.abs(parseFloat(c.strike_price) - _retryLongStrike) }))
        .sort((a, b) => a.dist - b.dist)[0];
      if (!_retryCandidate) {
        logEvent("filter", `${stock.ticker} credit spread R/R ${(rrRatioCred*100).toFixed(0)}% — no cached strike near $${_retryLongStrike} for $${_retryWidth} retry — skip`);
        return null;
      }
      const _rSnap = snapshots[_retryCandidate.c.symbol];
      const _rQ    = _rSnap?.latestQuote || {};
      const _rBid  = parseFloat(_rQ.bp || 0);
      const _rAsk  = parseFloat(_rQ.ap || 0);
      const _rMid  = _rBid > 0 && _rAsk > 0 ? (_rBid + _rAsk) / 2 : 0;
      const _rSpreadPct = _rMid > 0 ? (_rAsk - _rBid) / _rMid : 1;
      // Richard: retry long leg must also pass bid-ask stability gate
      if (!(_rMid > 0 && _rSpreadPct <= MAX_SPREAD_PCT)) {
        logEvent("filter", `${stock.ticker} credit spread R/R ${(rrRatioCred*100).toFixed(0)}% — retry long leg bid-ask ${(_rSpreadPct*100).toFixed(0)}% unstable — skip`);
        return null;
      }
      const _retryCredit  = parseFloat((shortContract.premium - _rMid).toFixed(2));
      const _retryMaxLoss = parseFloat((_retryWidth - _retryCredit).toFixed(2));
      const _retryRR      = _retryMaxLoss > 0 ? _retryCredit / _retryMaxLoss : 0;
      if (_retryRR < MIN_CREDIT_RR || _retryCredit <= 0) {
        if (!state._lastCreditRR) state._lastCreditRR = {};
        state._lastCreditRR[stock.ticker] = {
          ts: Date.now(), rr: rrRatioCred, retryRR: _retryRR, netCredit, maxLoss, width: actualWidth,
          viable: false, reason: `market R/R ${(rrRatioCred*100).toFixed(0)}% — retry $${_retryWidth} wide also fails (${(_retryRR*100).toFixed(0)}%)`
        };
        logEvent("filter", `${stock.ticker} credit spread R/R ${(rrRatioCred*100).toFixed(0)}% — retry $${_retryWidth} wide also fails (${(_retryRR*100).toFixed(0)}%) — skip`);
        return null;
      }
      // Retry succeeded — update longContract and reassign lets so all downstream uses correct values
      if (!state._lastCreditRR) state._lastCreditRR = {};
      state._lastCreditRR[stock.ticker] = {
        ts: Date.now(), rr: _retryRR, netCredit: _retryCredit, width: _retryWidth,
        viable: true, reason: `R/R ${(_retryRR*100).toFixed(0)}% via retry $${_retryWidth} wide`
      };
      logEvent("filter", `${stock.ticker} [R/R RETRY] $${actualWidth}→$${_retryWidth} wide | ${(rrRatioCred*100).toFixed(0)}%→${(_retryRR*100).toFixed(0)}% R/R | credit $${_retryCredit}`);
      longContract = {
        symbol:  _retryCandidate.c.symbol,
        strike:  parseFloat(_retryCandidate.c.strike_price),
        expDate: longContract.expDate,
        expDays: longContract.expDays,
        premium: parseFloat(_rMid.toFixed(2)),
        bid: _rBid, ask: _rAsk,
        spread: _rSpreadPct,
      };
      // Reassign lets — marginRequired and position object pick up correct narrower-spread values
      netCredit = _retryCredit;
      maxProfit = _retryCredit;
      maxLoss   = _retryMaxLoss;
    }
    logEvent("filter", `${stock.ticker} credit spread R/R: collect $${(netCredit*100).toFixed(0)} / risk $${(maxLoss*100).toFixed(0)} per contract (${(maxLoss > 0 ? netCredit/maxLoss*100 : 0).toFixed(0)}% ratio)`);
    // C10: Sizing from entryEngine sizeMod parameter (replaces inline scoreBaseMult + ivSizeMultCredit)
    // entryEngine.scoreCandidate already computed: base * ivBoostCredit * crisisAdj * oversoldMod
    // Using internal computation here was overriding that work silently
    // sizeMod arrives as 1.0 base (no boost) to 1.5x (IVR>=70 credit boost)
    const scoreBaseMult      = score >= 90 ? 2.0 : score >= 85 ? 1.5 : score >= 80 ? 1.25 : 1.0;
    const rawCreditContracts = Math.max(1, Math.floor(scoreBaseMult * sizeMod));
    const preFillCapCredit   = (state.closedTrades||[]).length < 30 ? 3 : 99;
    const contracts          = Math.min(preFillCapCredit, rawCreditContracts);
    if (contracts > 1) logEvent("scan", `[SIZING] ${stock.ticker} credit spread: ${contracts}x (score ${score} sizeMod ${sizeMod.toFixed(2)})`);

    // Credit received reduces capital requirement - margin = max loss
    const profitableCount = (state.closedTrades || []).filter(t => t.pnl > 0).length;
    const creditCapPct    = profitableCount >= 20 ? 0.25 : 0.20; // panel: raised from 0.15 (too tight pre-fills)
    const marginRequired  = parseFloat((maxLoss * 100 * contracts).toFixed(2));
    if (marginRequired > state.cash * creditCapPct) {
      logEvent("filter", `${stock.ticker} credit spread margin $${marginRequired} exceeds ${(creditCapPct*100).toFixed(0)}% limit`);
      return null;
    }
    if (state.cash - marginRequired < CAPITAL_FLOOR) {
      logEvent("filter", `${stock.ticker} credit spread would breach capital floor`);
      return null;
    }
    const optBPCredit = state.alpacaOptBP || state.alpacaBuyPower || state.cash;
    if (marginRequired > optBPCredit) {
      logEvent("filter", `${stock.ticker} credit spread margin $${marginRequired} exceeds Alpaca options buying power $${optBPCredit.toFixed(2)} - skip`);
      return null;
    }

    if (_dryRunMode) {
      logEvent("dryrun", `WOULD SELL CREDIT SPREAD ${stock.ticker} $${shortContract.strike}/$${longContract.strike} ${optionType.toUpperCase()} | credit $${netCredit} | max profit $${maxProfit} | max loss $${maxLoss} | margin $${marginRequired} | score ${score}`);
      return null;
    }

    // BUG-3: Duplicate order guard - verify no existing position in same ticker+direction
    // Prevents double-short scenario where two spread orders create asymmetric leg counts
    const existingSameDir = state.positions.filter(p =>
      p.ticker === stock.ticker && p.optionType === optionType
    );
    if (existingSameDir.length > 0) {
      logEvent("filter", `[CREDIT SPREAD] Duplicate guard: ${stock.ticker} already has ${existingSameDir.length} ${optionType} position(s) - skipping to prevent asymmetric legs`);
      return null;
    }

    let shortOrderId = null, longOrderId = null;
    try {
      // - MULTI-LEG ORDER for credit spread -
      // limit_price is NEGATIVE for credit (we receive money)
      const shortMid = shortContract.bid > 0 && shortContract.ask > 0
        ? parseFloat(((shortContract.bid + shortContract.ask) / 2).toFixed(2))
        : parseFloat(shortContract.bid.toFixed(2));
      const longMid = longContract.bid > 0 && longContract.ask > 0
        ? parseFloat(((longContract.bid + longContract.ask) / 2).toFixed(2))
        : parseFloat(longContract.ask.toFixed(2));
      const netCreditLimit = parseFloat((longMid - shortMid).toFixed(2)); // negative = credit

      // C2: Idempotency key -- prevents duplicate orders on network timeout/retry
      // Deterministic: same ticker+direction+timestamp bucket will not double-submit
      const _clientOrderId = `argo-cs-${stock.ticker}-${optionType}-${Math.floor(Date.now()/10000)}`;
      const mlegBody = {
        order_class:    "mleg",
        type:           "limit",
        time_in_force:  "day",
        qty:            String(contracts),
        limit_price:    String(netCreditLimit), // negative = credit received
        client_order_id: _clientOrderId,
        legs: [
          { symbol: shortContract.symbol, side: "sell", ratio_qty: "1", position_intent: "sell_to_open" },
          { symbol: longContract.symbol,  side: "buy",  ratio_qty: "1", position_intent: "buy_to_open"  },
        ],
      };

      // C1: Record pending order BEFORE submission so crash-recovery catches it
      // If process dies between record and submit, reconciliation sees the pending order
      // If submit fails, catch block clears _pendingOrder
      state._pendingOrder = {
        orderId:        _clientOrderId, // will be replaced with real ID on success
        ticker:         stock.ticker,
        optionType,
        isCreditSpread: true,
        buySymbol:      longContract.symbol,
        sellSymbol:     shortContract.symbol,
        buyStrike:      longContract.strike,
        sellStrike:     shortContract.strike,
        buyPremium:     parseFloat(longContract.premium.toFixed(2)),   // long leg entry price
        sellPremium:    parseFloat(shortContract.premium.toFixed(2)),  // short leg entry price
        netCredit,
        netDebitLimit:  netCredit,
        finalCost:      marginRequired,
        contracts,
        score,
        scoreReasons,
        expDate:        shortContract.expDate,
        expDays:        shortContract.expDays,
        submittedAt:    Date.now(),
        isSpread:       true,
        isChoppyEntry:  false,
        mlegBody,
        spreadPct:      shortContract.spread || 0.05, // B6-concern fix: real bid/ask spread % for retry concession scaling
        _preSubmit:     true, // flag: not yet confirmed submitted to Alpaca
      };
      markDirty();

      logEvent("trade", `[CREDIT SPREAD] Submitting mleg: sell $${shortContract.strike} / buy $${longContract.strike} | ${contracts}x | net credit $${Math.abs(netCreditLimit)} | id: ${_clientOrderId}`);
      const mlegResp = await alpacaPost("/orders", mlegBody);

      if (!mlegResp || mlegResp.code || !mlegResp.id) {
        logEvent("warn", `[CREDIT SPREAD] mleg order failed: ${JSON.stringify(mlegResp)?.slice(0,200)}`);
        return null;
      }

      shortOrderId = mlegResp.id;
      longOrderId  = mlegResp.id;
      // Update pending order with real Alpaca ID (replace the pre-submit client_order_id)
      state._pendingOrder.orderId  = mlegResp.id;
      state._pendingOrder._preSubmit = false;
      markDirty();
      logEvent("trade", `[CREDIT SPREAD] mleg submitted: ${mlegResp.id} | status: ${mlegResp.status}`);
      logEvent("trade", `[CREDIT SPREAD] Order pending - will confirm fill on next scan`);
      return { pending: true };
    } catch(e) {
      logEvent("error", `[CREDIT SPREAD] mleg error: ${e.message}`);
      state._pendingOrder = null;
      return null;
    }
    // Position recording now handled by confirmPendingOrder() on fill confirmation
  } catch(e) {
    logEvent("error", `executeCreditSpread(${stock.ticker}): ${e.message}`);
    state._pendingOrder = null;
    return null;
  }
}

async function executeTrade(stock, price, score, scoreReasons, vix, optionType = "call", isMeanReversion = false, sizeMod = 1.0) {
  // Quick cash pre-check before expensive API calls
  // Use conservative estimate: assume at least $200 premium * 1 contract = $200 min cost
  const estimatedMinCost = price * 0.03 * 100; // ~3% OTM premium estimate * 100
  if (state.cash - estimatedMinCost < CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash pre-check (est. min cost ${fmt(estimatedMinCost)})`);
    return false;
  }

  // Use cached contract from parallel prefetch if available, else fetch now
  let contract = stock._cachedContract || await findContract(stock.ticker, optionType, isMeanReversion ? 0.40 : 0.35, isMeanReversion ? 21 : 28, vix, stock);
  delete stock._cachedContract; // clean up cache after use

  // Fallback to estimated contract if real data unavailable
  // NOTE: If the chain exists but no liquid contracts found, estimation is unreliable
  // Only estimate if we got no chain data at all (API failure)
  if (!contract) {
    logEvent("warn", `- ${stock.ticker} - NO REAL OPTIONS DATA - using Black-Scholes estimate. Check Alpaca Pro subscription.`);
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.estimatedTrades++;
    state.dataQuality.totalTrades++;
    const iv       = 0.25 + stock.ivr * 0.003;
    // Simple fallback DTE: 28 days for directional, 21 for MR
    const expDays = isMeanReversion ? 21 : 28;
    const _expDate = new Date(Date.now() + expDays * 86400000);
    const expDate = _expDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
    const expiryType = 'weekly';
    const otmPct   = stock.momentum === "strong" ? 0.035 : 0.045;
    const strike   = optionType === "put"
      ? Math.round(price * (1 - otmPct) / 5) * 5
      : Math.round(price * (1 + otmPct) / 5) * 5;
    const t        = expDays / 365;
    const premium  = parseFloat((price * iv * Math.sqrt(t) * 0.4 + 0.3).toFixed(2));
    const greeks   = calcGreeks(price, strike, expDays, iv, optionType);
    contract = { symbol: null, strike, expDate, expDays, expiryType,
      premium, bid: premium * 0.95, ask: premium * 1.05,
      greeks, iv, oi: 0, vol: 0, optionType };
  } else {
    // Real data - track totalTrades for stats only
    // realTrades is incremented AFTER a confirmed live fill (see below)
    // Never increment in dry run - would bypass the 1-contract cap
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.totalTrades++;
  }

  // Position sizing based on real premium
  // Unified Kelly-primary sizing - single call, all adjustments inside
  let contracts = calcPositionSize(contract.premium, score, vix);
  // V2.84: apply Regime B oversold sizing modifier (0.75x when RSI <=40 in bear trend)
  if (sizeMod < 1.0) {
    contracts = Math.max(1, Math.floor(contracts * sizeMod));
    logEvent("scan", `[SIZING] ${stock.ticker} sizeMod ${sizeMod}x applied - ${contracts} contracts (oversold bear trend)`);
  }
  if (contracts < 1) {
    logEvent("skip", `${stock.ticker} - position size too small`);
    return false;
  }

  const cost      = parseFloat((contract.premium * 100 * contracts).toFixed(2));
  const target    = parseFloat((contract.premium * (1 + TAKE_PROFIT_PCT)).toFixed(2));
  const stop      = parseFloat((contract.premium * (1 - STOP_LOSS_PCT)).toFixed(2));
  const breakeven = optionType === "put"
    ? parseFloat((contract.strike - contract.premium).toFixed(2))
    : parseFloat((contract.strike + contract.premium).toFixed(2));

  // Ensure liquid cash

  if (cost > state.cash - CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash after floor (need ${fmt(cost)})`);
    return false;
  }

  // Delta check - already filtered in getRealOptionsContract but double check estimate fallback
  const delta = parseFloat(contract.greeks.delta || 0);
  if (Math.abs(delta) < TARGET_DELTA_MIN || Math.abs(delta) > TARGET_DELTA_MAX) {
    logEvent("filter", `${stock.ticker} - delta ${delta} outside target range`);
    return false;
  }

  // Submit order to Alpaca - fill confirmation happens inside
  // Only submit if we have a real contract symbol (not an estimate)
  let alpacaOrderId = null;
  if (contract.symbol && contract.ask > 0 && !_dryRunMode) {
    try {
      const limitPrice = parseFloat(contract.ask.toFixed(2)); // number not string
      const orderBody = {
        symbol:        contract.symbol,
        qty:           contracts,              // number not string
        side:          "buy",
        type:          "limit",
        time_in_force: "day",
        limit_price:   limitPrice,
      };
      const orderResp = await alpacaPost("/orders", orderBody);
      if (orderResp && orderResp.id) {
        alpacaOrderId = orderResp.id;
        logEvent("trade", `Alpaca order submitted: ${orderResp.id} | ${contract.symbol} | ${contracts}x @ $${limitPrice}`);

        // - FILL CONFIRMATION - poll for up to 10 seconds -
        // Limit orders are not guaranteed to fill immediately
        // If unfilled after 10s, cancel and skip - don't update state on unfilled orders
        let fillConfirmed  = false;
        let fillPrice      = null;
        const pollStart    = Date.now();
        const FILL_TIMEOUT = 10000; // 10 seconds
        const POLL_INTERVAL= 1000;  // check every 1 second

        // Check if immediately filled
        if (orderResp.status === "filled" && orderResp.filled_avg_price) {
          fillConfirmed = true;
          fillPrice = parseFloat(parseFloat(orderResp.filled_avg_price).toFixed(2));
          logEvent("trade", `Order ${alpacaOrderId} filled immediately @ $${fillPrice}`);
        } else {
          // Poll for fill
          while (!fillConfirmed && Date.now() - pollStart < FILL_TIMEOUT) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            try {
              const pollResp = await alpacaGet(`/orders/${alpacaOrderId}`);
              if (pollResp && pollResp.status === "filled" && pollResp.filled_avg_price) {
                fillConfirmed = true;
                fillPrice = parseFloat(parseFloat(pollResp.filled_avg_price).toFixed(2));
                logEvent("trade", `Order ${alpacaOrderId} fill confirmed @ $${fillPrice} (${((Date.now()-pollStart)/1000).toFixed(1)}s)`);
              } else if (pollResp && ["canceled","expired","rejected"].includes(pollResp.status)) {
                logEvent("warn", `Order ${alpacaOrderId} ${pollResp.status} - not filled`);
                break;
              }
            } catch(e) { logEvent("warn", `Fill poll error: ${e.message}`); break; }
          }
        }

        if (!fillConfirmed) {
          // Cancel unfilled order and abort trade
          try { await alpacaDelete(`/orders/${alpacaOrderId}`); } catch(e) {}
          logEvent("warn", `Order ${alpacaOrderId} not filled in ${FILL_TIMEOUT/1000}s - cancelled, skipping trade`);
          alpacaOrderId = null; // signal to caller to abort
        } else if (fillPrice) {
          contract.premium = fillPrice; // use actual fill price not limit price
          // Confirmed live fill - now count as a real trade for Kelly calibration
          if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
          state.dataQuality.realTrades++;
          logEvent("trade", `Live fill confirmed - real trade count: ${state.dataQuality.realTrades}/30 before Kelly activates`);
        }
      } else {
        logEvent("warn", `Alpaca order failed for ${contract.symbol}: ${JSON.stringify(orderResp)?.slice(0, 150)}`);
      }
    } catch(e) {
      logEvent("error", `Alpaca order submission error: ${e.message}`);
    }
  }

  // Abort if order was not confirmed filled - don't update state on unfilled orders
  if (contract.symbol && !_dryRunMode && alpacaOrderId === null && contract.symbol) {
    logEvent("skip", `${stock.ticker} - trade aborted, order not filled`);
    return false;
  }

  // Recalculate cost/target/stop using final premium (may have been updated by fill)
  const finalCost     = parseFloat((contract.premium * 100 * contracts).toFixed(2));
  // Use DTE-tiered exit params - short-dated options need faster exits
  const exitParams    = getDTEExitParams(contract.expDays || 30, 0); // 0 days open - fresh entry
  const finalTarget   = parseFloat((contract.premium * (1 + exitParams.takeProfitPct)).toFixed(2));
  const finalStop     = parseFloat((contract.premium * (1 - exitParams.stopLossPct)).toFixed(2));
  const finalBreakeven = optionType === "put"
    ? parseFloat((contract.strike - contract.premium).toFixed(2))
    : parseFloat((contract.strike + contract.premium).toFixed(2));

  // Re-check cash with final cost (fill might be slightly different from ask)
  if (finalCost > state.cash - CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash after fill price adjustment`);
    // Cancel the Alpaca order if we submitted one
    if (alpacaOrderId) {
      try {
        await alpacaDelete(`/orders/${alpacaOrderId}`);
        logEvent("trade", `Alpaca order ${alpacaOrderId} cancelled - insufficient cash`);
      } catch(e) { logEvent("error", `Failed to cancel order ${alpacaOrderId}: ${e.message}`); }
    }
    return false;
  }

  // In dry run - log what would happen but don't mutate state
  if (_dryRunMode) {
    logEvent("dryrun", `WOULD BUY ${stock.ticker} ${optionType.toUpperCase()} $${contract.strike} | ${contracts}x @ $${contract.premium} | cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta}`);
    return true;
  }

  // Final heat check - projected heat AFTER this position is added
  // This catches the scan-level blindness where multiple positions queue before any are entered
  const projectedHeat = (openRisk() + finalCost) / totalCap();
  if (projectedHeat > effectiveHeatCap()) {
    logEvent("filter", `${stock.ticker} - projected heat ${(projectedHeat*100).toFixed(0)}% would exceed ${MAX_HEAT*100}% max - skipping`);
    if (alpacaOrderId) {
      try { await alpacaDelete(`/orders/${alpacaOrderId}`); } catch(e) {}
    }
    return false;
  }

  state.cash = parseFloat((state.cash - finalCost).toFixed(2));
  state.todayTrades++;

  const position = {
    ticker:         stock.ticker,
    sector:         stock.sector,
    assetClass:     ["GLD","SLV","USO","TLT","GDX"].includes(stock.ticker) ? "commodity" : "equity",
    strike:         contract.strike,
    premium:        contract.premium,
    contracts,
    expDate:        contract.expDate,
    expiryDays:     contract.expDays,
    target:         finalTarget,
    stop:           finalStop,
    breakeven:      finalBreakeven,
    cost:           finalCost,
    takeProfitPct:  exitParams.takeProfitPct,
    trailActivate:  exitParams.trailActivate,
    trailStop:      exitParams.trailStop,
    fastStopPct:    exitParams.fastStopPct,
    dteLabel:       exitParams.label,
    isMeanReversion: isMeanReversion,
    entryVIX:       vix,
    partialClosed:  false,
    openDate:       new Date().toISOString(),
    ivr:            stock.ivr,
    iv:             contract.iv,
    greeks:         contract.greeks,
    beta:           stock.beta || 1,
    peakPremium:    contract.premium,
    trailStop:      null,
    breakevenLocked: false,
    score,
    halfPosition:   false,
    price,
    optionType,
    expiryType:      contract.expiryType,
    currentPrice:    contract.premium,
    contractSymbol:  contract.symbol,
    alpacaOrderId:   alpacaOrderId,
    bid:             contract.bid,
    ask:             contract.ask,
    realData:        !!contract.symbol,
    entryRSI:        stock.rsi || 52,        // capture entry signal for decay detection
    entryMomentum:   stock.momentum || "steady",
    entryMACD:       stock.macd || "neutral",
    entryMacro:      (state._agentMacro || {}).signal || "neutral",
    entryRelStr:     stock._relStrength || 1.0,
    entryADX:        stock._adx || 0,
    entryThesisScore: 100, // starts at 100, degrades over time
    thesisHistory:   [], // [{time, score, notes}] - tracks degradation
    agentHistory:    [], // last 5 rescore results
  };

  state.positions.push(position);

  // - Paper slippage estimate -
  const _singleSlipEst = parseFloat((0.08 * (contract.contracts || 1)).toFixed(2));
  if (!state._paperSlippage) state._paperSlippage = { trades: 0, totalEst: 0 };
  state._paperSlippage.trades++;
  state._paperSlippage.totalEst = parseFloat((state._paperSlippage.totalEst + _singleSlipEst).toFixed(2));
  state._paperSlippage.avgEst   = parseFloat((state._paperSlippage.totalEst / state._paperSlippage.trades).toFixed(2));
  logEvent("trade", `[SLIPPAGE EST] $${_singleSlipEst} this trade | $${state._paperSlippage.totalEst} cumulative across ${state._paperSlippage.trades} trades (paper mid-fill assumption)`);
  const isEarningsPlay = scoreReasons.some(r => r.includes("Earnings play"));
  if (isEarningsPlay) position.earningsPlay = true;

  state.tradeJournal.unshift({
    time:          new Date().toISOString(),
    ticker:        stock.ticker,
    action:        "OPEN",
    optionType,
    strike:        contract.strike,
    expDate:       contract.expDate,
    premium:       contract.premium,
    contracts,
    cost:          finalCost,
    score,
    scoreReasons:  scoreReasons, // F13: full list for dashboard transparency
    delta:         contract.greeks.delta,
    iv:            parseFloat(((contract.iv||0.3)*100).toFixed(1)),
    vix,
    washSaleFlag:  stock._washSaleWarning || false,
    reasoning:     `Score ${score}/100. ${scoreReasons.slice(0,3).join(". ")}.${stock._washSaleWarning ? " - WASH SALE WARNING." : ""}`,
  });
  if (state.tradeJournal.length > 100) state.tradeJournal = state.tradeJournal.slice(0,100);

  const typeLabel = optionType === "put" ? "P" : "C";
  const dataLabel = contract.symbol ? "REAL" : "EST";

  // - LIQUIDITY HARD GATES -
  // OI < MIN_OI (5) = essentially no market - unfillable in live trading
  if (!_dryRunMode && contract.oi > 0 && contract.oi < MIN_OI) {
    logEvent("filter", `${stock.ticker} BLOCKED - OI:${contract.oi} below minimum ${MIN_OI} - unfillable in live trading`);
    return false;
  }
  // Spread > MAX_SPREAD_PCT (30%) = slippage destroys the trade
  if (!_dryRunMode && contract.spread > MAX_SPREAD_PCT) {
    const slippageEst = parseFloat((contract.premium * contract.spread * 0.5 * 100 * contracts).toFixed(2));
    logEvent("filter", `${stock.ticker} BLOCKED - spread ${(contract.spread*100).toFixed(0)}% exceeds ${(MAX_SPREAD_PCT*100).toFixed(0)}% max - est. slippage $${slippageEst}`);
    return false;
  }
  // Warn on borderline OI (5-50) and spread (15-30%) - don't block but flag
  if (contract.oi > 0 && contract.oi < 50) {
    logEvent("warn", `- ${stock.ticker} LOW OI: ${contract.oi} - fill may be slow`);
  } else if (contract.oi === 0) {
    logEvent("warn", `- ${stock.ticker} OI UNKNOWN - treat as potentially illiquid`);
  }
  if (contract.spread > 0.15) {
    const slippageEst = parseFloat((contract.premium * contract.spread * 0.5 * 100 * contracts).toFixed(2));
    logEvent("warn", `- ${stock.ticker} WIDE SPREAD: ${(contract.spread*100).toFixed(0)}% - est. slippage $${slippageEst}`);
  }

  await saveStateNow(); // critical - persist trade immediately
  logEvent("trade",
    `BUY ${stock.ticker} $${contract.strike}${typeLabel} exp ${contract.expDate} | ${contracts}x @ $${contract.premium} | ` +
    `cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta} | ${isMeanReversion ? "MEAN-REV" : exitParams.label} | [${dataLabel}] | ` +
    `OI:${contract.oi} spread:${(contract.spread*100).toFixed(1)}% | cash ${fmt(state.cash)} | heat ${(heatPct()*100).toFixed(0)}%`
  );
  return true;
}



// ============================================================
// executeDebitCallSpread — debit call spread execution
// Panel 4/22/2026: buy OTM call + sell further OTM call to reduce cost.
// Profit from confirmed upward move. Theta works against you.
// Parameters: price-relative width, 40% max debit/width gate.
// ============================================================
async function executeDebitCallSpread(stock, price, score, scoreReasons, vix, sizeMod = 1.0, spreadParamsOverride = null) {
  try {
    // Panel parameters from rulebook
    const longDeltaTarget  = (spreadParamsOverride && spreadParamsOverride.debitCallLongDelta)   || 0.42; // buy leg: just OTM, delta-responsive
    const shortDeltaTarget = (spreadParamsOverride && spreadParamsOverride.debitCallShortDelta)  || 0.22; // sell leg: caps upside, reduces cost
    const targetDTE        = (spreadParamsOverride && spreadParamsOverride.debitCallTargetDTE)   || (vix >= 28 ? 28 : 21);
    const minDTE           = (spreadParamsOverride && spreadParamsOverride.debitCallMinDTE)       || 14;
    const maxDebitPct      = (spreadParamsOverride && spreadParamsOverride.debitCallMaxDebitPct)  || 0.40; // max debit as % of width (R/R floor)

    // Price-relative width: 1.2% of price at VIX 28+, 1.5% at VIX 20-28
    const widthPct   = (spreadParamsOverride && spreadParamsOverride.debitCallWidthPct) || (vix >= 28 ? 0.012 : 0.015);
    const rawWidth   = Math.round(price * widthPct * 2) / 2; // round to $0.50
    const spreadWidth = Math.max(2, Math.min(15, rawWidth));

    logEvent("filter", `${stock.ticker} debit call spread: $${spreadWidth} wide (${(widthPct*100).toFixed(1)}% of $${price.toFixed(0)}) | long delta ${longDeltaTarget} / short delta ${shortDeltaTarget} | DTE~${targetDTE}`);

    // -- STEP 1: Find buy (long) leg — delta 0.40-0.45, just OTM call -------
    const today    = getETTime();
    const fetchMin = new Date(today.getTime() + minDTE * 86400000).toISOString().split("T")[0];
    const fetchMax = new Date(today.getTime() + Math.min(45, targetDTE + 14) * 86400000).toISOString().split("T")[0];
    const chainUrl = `/options/contracts?underlying_symbol=${stock.ticker}&expiration_date_gte=${fetchMin}&expiration_date_lte=${fetchMax}&type=call&limit=200`;

    let chainContracts = [];
    let pageToken = null, pages = 0;
    do {
      const url  = pageToken ? `${chainUrl}&page_token=${pageToken}` : chainUrl;
      const page = await alpacaGet(url, ALPACA_OPTIONS);
      if (!page || !page.option_contracts) break;
      chainContracts = chainContracts.concat(page.option_contracts);
      pageToken = page.next_page_token || null;
      pages++;
    } while (pageToken && pages < 5);

    if (!chainContracts.length) {
      logEvent("filter", `${stock.ticker} debit call spread: no contracts in window ${fetchMin}->${fetchMax}`);
      return null;
    }
    logEvent("filter", `${stock.ticker} debit call spread: ${chainContracts.length} contracts in window`);

    // Sort by DTE closeness first, then strike proximity
    chainContracts.sort((a, b) => {
      const aExpDTE = Math.round((new Date(a.expiration_date) - today) / 86400000);
      const bExpDTE = Math.round((new Date(b.expiration_date) - today) / 86400000);
      const aDTEDist = Math.abs(aExpDTE - targetDTE);
      const bDTEDist = Math.abs(bExpDTE - targetDTE);
      if (Math.abs(aDTEDist - bDTEDist) > 7) return aDTEDist - bDTEDist;
      // Within same expiry: prefer strike closest to ATM (long leg should be near current price)
      const aDist = Math.abs(parseFloat(a.strike_price) - price);
      const bDist = Math.abs(parseFloat(b.strike_price) - price);
      return aDist - bDist;
    });

    // Fetch snapshots for top 50 candidates
    const candidateSymbols = chainContracts.slice(0, 50).map(c => c.symbol);
    const snapBatches = [];
    for (let i = 0; i < candidateSymbols.length; i += 25)
      snapBatches.push(candidateSymbols.slice(i, i + 25).join(","));
    const snapResults = await Promise.all(snapBatches.map(b =>
      alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP)
    ));
    const snapshots = snapResults.reduce((acc, r) => ({ ...acc, ...(r?.snapshots || {}) }), {});

    // Find long leg: closest delta to longDeltaTarget, call above current price
    let longContract = null;
    let _bestDeltaDist = Infinity;
    for (const c of chainContracts.slice(0, 50)) {
      const snap   = snapshots[c.symbol];
      if (!snap) continue;
      const quote  = snap.latestQuote || {};
      const greeks = snap.greeks || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid <= 0) continue;
      const delta  = Math.abs(parseFloat(greeks.delta || 0));
      if (delta < 0.25 || delta > 0.60) continue; // long leg range
      const strike = parseFloat(c.strike_price);
      if (strike <= price * 0.995) continue; // must be OTM (above price)
      const deltaDist = Math.abs(delta - longDeltaTarget);
      if (deltaDist >= _bestDeltaDist) continue;
      _bestDeltaDist = deltaDist;
      longContract = {
        symbol:  c.symbol,
        strike,
        expDate: c.expiration_date,
        expDays: Math.round((new Date(c.expiration_date) - today) / 86400000),
        premium: parseFloat(mid.toFixed(2)),
        bid, ask,
        spread:  ask > 0 ? (ask - bid) / ask : 1,
        greeks:  { delta: parseFloat(greeks.delta || 0).toFixed(3) },
      };
    }

    if (!longContract) {
      logEvent("filter", `${stock.ticker} debit call spread: no valid long leg found (delta ${longDeltaTarget})`);
      return null;
    }
    logEvent("filter", `${stock.ticker} long leg: $${longContract.strike} | ${longContract.expDays}DTE | delta${longContract.greeks.delta} | $${longContract.premium}`);

    // -- STEP 2: Bid-ask stability gate on long leg --------------------------
    const MAX_SPREAD_PCT = 0.20;
    const longSpreadPct  = longContract.bid > 0 ? (longContract.ask - longContract.bid) / ((longContract.ask + longContract.bid) / 2) : 1;
    if (longSpreadPct > MAX_SPREAD_PCT) {
      logEvent("filter", `${stock.ticker} debit call spread: long leg bid-ask ${(longSpreadPct*100).toFixed(0)}% unstable — skip`);
      return null;
    }

    // -- STEP 3: Find short leg — same expiry, spreadWidth OTM from long ----
    const shortStrikeTarget = longContract.strike + spreadWidth;
    const sameExpiry = chainContracts.filter(c => c.expiration_date === longContract.expDate);
    sameExpiry.sort((a, b) =>
      Math.abs(parseFloat(a.strike_price) - shortStrikeTarget) -
      Math.abs(parseFloat(b.strike_price) - shortStrikeTarget)
    );

    // Pre-fetch snapshots for short leg candidates
    const shortCandidates    = sameExpiry.slice(0, 20);
    const shortSymbolsNeeded = shortCandidates.map(c => c.symbol).filter(s => !snapshots[s]);
    if (shortSymbolsNeeded.length > 0) {
      const shortBatches = [];
      for (let i = 0; i < shortSymbolsNeeded.length; i += 25)
        shortBatches.push(shortSymbolsNeeded.slice(i, i + 25).join(","));
      const shortSnaps = await Promise.all(shortBatches.map(b =>
        alpacaGet(`/options/snapshots?symbols=${b}&feed=indicative`, ALPACA_OPT_SNAP).catch(() => null)
      ));
      shortSnaps.forEach(r => { if (r?.snapshots) Object.assign(snapshots, r.snapshots); });
    }

    let shortContract = null;
    for (const c of shortCandidates) {
      const snap   = snapshots[c.symbol];
      if (!snap) continue;
      const quote  = snap.latestQuote || {};
      const greeks = snap.greeks || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const mid    = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      if (mid <= 0) continue;
      const delta  = Math.abs(parseFloat(greeks.delta || 0));
      if (delta < 0.08 || delta > 0.40) continue; // short leg range
      const strike = parseFloat(c.strike_price);
      if (strike <= longContract.strike) continue; // must be further OTM
      const shortSpreadPct = bid > 0 ? (ask - bid) / ((ask + bid) / 2) : 1;
      if (shortSpreadPct > MAX_SPREAD_PCT) continue; // bid-ask stability
      shortContract = {
        symbol:  c.symbol,
        strike,
        expDate: c.expiration_date,
        premium: parseFloat(mid.toFixed(2)),
        bid, ask,
        greeks:  { delta: parseFloat(greeks.delta || 0).toFixed(3) },
      };
      break;
    }

    if (!shortContract) {
      logEvent("filter", `${stock.ticker} debit call spread: no valid short leg found near $${shortStrikeTarget}`);
      return null;
    }
    logEvent("filter", `${stock.ticker} short leg: $${shortContract.strike} | delta${shortContract.greeks.delta} | $${shortContract.premium}`);

    // -- STEP 4: R/R validation — max debit 40% of width ---------------------
    const actualWidth = shortContract.strike - longContract.strike;
    if (actualWidth < spreadWidth * 0.5) {
      logEvent("filter", `${stock.ticker} debit call spread: width $${actualWidth} too narrow`);
      return null;
    }

    const netDebit  = parseFloat((longContract.premium - shortContract.premium).toFixed(2));
    if (netDebit <= 0) {
      logEvent("filter", `${stock.ticker} debit call spread: no debit (${netDebit}) — legs mispriced`);
      return null;
    }

    const debitRatio = netDebit / actualWidth;
    if (debitRatio > maxDebitPct) {
      logEvent("filter", `${stock.ticker} debit call spread: debit ratio ${(debitRatio*100).toFixed(0)}% > ${(maxDebitPct*100).toFixed(0)}% max (paying too much for too little upside)`);
      return null;
    }

    const maxProfit = parseFloat((actualWidth - netDebit).toFixed(2));
    const maxLoss   = netDebit;
    const rrRatio   = maxProfit / maxLoss;
    logEvent("filter", `${stock.ticker} debit call spread: buy $${longContract.strike} / sell $${shortContract.strike} | width $${actualWidth} | debit $${netDebit} | R/R ${rrRatio.toFixed(1)}:1 | max profit $${(maxProfit*100).toFixed(0)}/contract`);

    // -- STEP 5: Sizing -------------------------------------------------------
    const scoreBaseMult    = score >= 90 ? 2.0 : score >= 85 ? 1.5 : score >= 80 ? 1.25 : 1.0;
    const rawContracts     = Math.max(1, Math.floor(scoreBaseMult * sizeMod));
    const preFillCap       = (state.closedTrades || []).length < 30 ? 3 : 99;
    const contracts        = Math.min(preFillCap, rawContracts);
    const costPer1         = parseFloat((netDebit * 100).toFixed(2));
    const profitableCount  = (state.closedTrades || []).filter(t => t.pnl > 0).length;
    const capPct           = profitableCount >= 20 ? 0.20 : 0.15;
    const cashCap          = Math.floor((state.cash * capPct) / costPer1);
    const finalContracts   = Math.max(1, Math.min(contracts, cashCap));

    // Heat check
    const totalCost = finalContracts * costPer1;
    const projectedHeat = totalCost / (state.cash || 30000);
    if (projectedHeat > 0.15 && !state.positions.length) {
      logEvent("filter", `${stock.ticker} debit call spread: heat ${(projectedHeat*100).toFixed(0)}% exceeds 15% cap`);
      return null;
    }

    if (finalContracts > 1) logEvent("scan", `[SIZING] ${stock.ticker} debit call spread: ${finalContracts}x (score ${score} sizeMod ${sizeMod.toFixed(2)})`);

    // -- STEP 6: Submit mleg order -------------------------------------------
    // Debit call spread: BUY long leg + SELL short leg simultaneously
    return await executeSpreadTrade(stock, price, score, scoreReasons, vix, "call", longContract, shortContract, false, "debit_call");

  } catch(e) {
    logEvent("error", `executeDebitCallSpread(${stock.ticker}): ${e.message}`);
    return null;
  }
}

module.exports = {
  executeCreditSpread, executeDebitSpread, executeDebitCallSpread, executeIronCondor,
  executeSpreadTrade, executeTrade,
  findContract, bsStrikeForDelta, getOptionsPrice,
  initExecution,
  calcPositionSize,

};;;
