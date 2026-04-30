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

  // FIX 2: Kelly bootstrap — paper fills count toward calibration threshold.
  // realTrades increments on every confirmed fill (paper or live).
  // Pre-calibration: conviction-based sizing (1-3 contracts) instead of hard 1-contract cap.
  // Unlocks full Kelly after 30 fills.
  const totalFills = (state.dataQuality || {}).realTrades || 0;
  const preCalibration = totalFills < 30;

  if (recentTrades.length >= 10) {
    const wins    = recentTrades.filter(t => t.pnl > 0);
    const losses  = recentTrades.filter(t => t.pnl <= 0);
    const winRate = wins.length / recentTrades.length;
    const avgWin  = wins.length   ? wins.reduce((s,t) => s+t.pnl,0) / wins.length   : TAKE_PROFIT_PCT * premium * 100;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s,t) => s+t.pnl,0) / losses.length) : STOP_LOSS_PCT * premium * 100;
    const payoff  = avgLoss > 0 ? avgWin / avgLoss : 1;
    const kelly   = winRate - (1 - winRate) / payoff;
    kellyBase     = Math.max(0.05, Math.min(preCalibration ? 0.12 : 0.25, kelly * 0.5));
  } else {
    // Pre-calibration bootstrap: score-tiered sizing (not hard 1 contract)
    // High conviction setups (score >= 85) get 2-3 contracts even before 30 fills
    kellyBase = preCalibration ? 0.07 : 0.08; // slightly larger than before to allow 2 contracts on high conviction
  }

  // Pre-calibration cap: max 3 contracts until 30 fills recorded
  // Replaces the hard 1-contract cap — lets conviction drive sizing within tight bounds
  const preCalibCap = preCalibration ? 3 : 99;

  // Step 2: Score conviction multiplier
  // Higher score = more conviction = size up within Kelly bounds
  const convictionMult = score >= 85 ? 1.25 : score >= 75 ? 1.0 : score >= 70 ? 0.80 : 0.60;

  // Time of day sizing — reduce in first 30 mins (wide spreads, price discovery)
  // Pros size down at open — market makers widen spreads until order flow stabilizes
  const etNow  = getETTime();
  const minsSinceOpen = (etNow.getHours() - 9) * 60 + etNow.getMinutes() - 30;
  const openingMult   = minsSinceOpen < 30 ? 0.75 : 1.0; // 25% smaller in first 30 mins

  // FIX 1: VIX sizing — G&W penalty only applies at extreme VIX (>40).
  // APEX buys naked options (long premium). At VIX 25-35 premium is elevated but
  // not absurd — the directional move thesis can still overcome theta.
  // Removed: 0.75x penalty at VIX 25-35 (was permanently choking sizing at current VIX 28).
  // Kept: 0.50x at VIX 35-40 (premium getting expensive), 0.35x at VIX 40+ (G&W threshold).
  const vixMult = vix >= 40  ? 0.35   // G&W: VIX>40 options genuinely overpriced for debit
                : vix >= 35  ? 0.60   // elevated but still directional — modest reduction
                : 1.0;                 // VIX <35: no sizing penalty on naked longs

  // Step 4: Drawdown protocol — use injected _getDrawdown() not marketContext (not in scope here)
  const ddMult = (_getDrawdown()?.sizeMultiplier) || (_getDrawdown()?.sizeMult) || 1.0;

  // Step 5: Combine into single sizing decision
  const effectiveFraction = kellyBase * convictionMult * vixMult * ddMult * openingMult;
  const maxCost           = Math.min(
    state.cash * effectiveFraction,
    state.cash * 0.20,                     // hard cap: never more than 20% per trade
    MAX_LOSS_PER_TRADE / STOP_LOSS_PCT     // risk-based cap
  );

  const contracts = Math.max(1, Math.min(Math.min(5, preCalibCap), Math.floor(maxCost / (premium * 100))));

  // If even 1 contract exceeds the risk-based cap, return 0 to signal skip
  // Caller checks contracts < 1 and skips the trade
  if (premium * 100 > MAX_LOSS_PER_TRADE / STOP_LOSS_PCT) return 0;

  return contracts;
}


// ═══════════════════════════════════════════════════════════════════════════════
// NAKED OPTIONS MODE: Spread execution functions removed.
// Only executeTrade() is used for all entries.
// ═══════════════════════════════════════════════════════════════════════════════

async function executeTrade(stock, price, score, scoreReasons, vix, optionType = "call", isMeanReversion = false, sizeMod = 1.0) {
  // Quick cash pre-check before expensive API calls
  // Use conservative estimate: assume at least $200 premium * 1 contract = $200 min cost
  const estimatedMinCost = price * 0.03 * 100; // ~3% OTM premium estimate * 100
  if (state.cash - estimatedMinCost < CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash pre-check (est. min cost ${fmt(estimatedMinCost)})`);
    return false;
  }

  // Use cached contract from parallel prefetch if available, else fetch now
  // FIX 5: DTE by trade type. MR calls need speed (14-21 DTE, higher gamma).
  // Directional puts/calls need time for the thesis to play out (35-45 DTE).
  const targetDelta = isMeanReversion ? 0.42 : 0.35; // MR: slightly more ATM for faster move
  const targetDTE   = isMeanReversion ? 14   : 38;   // MR: 14 DTE (fast), Directional: 38 DTE
  let contract = stock._cachedContract || await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
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

  // Duplicate guard — if a pending order exists for this ticker, skip.
  if (!_dryRunMode && state._pendingOrder && state._pendingOrder.ticker === stock.ticker) {
    logEvent("filter", `${stock.ticker} pending order exists - skipping naked/MR submission`);
    return false;
  }
  // Set lightweight _pendingOrder for the duration of the 10s poll
  // Prevents a concurrent scan from submitting the same ticker during fill wait
  if (!_dryRunMode) {
    state._pendingOrder = {
      orderId:     `argo-naked-${stock.ticker}-${Date.now()}`,
      ticker:      stock.ticker,
      optionType,
      isCreditSpread: false,
      isNaked:     true,
      submittedAt: Date.now(),
      _preSubmit:  true,
    };
    markDirty();
  }
  // Submit order to Alpaca - fill confirmation happens inside
  // Only submit if we have a real contract symbol (not an estimate)
  let alpacaOrderId = null;
  if (contract.symbol && contract.ask > 0 && !_dryRunMode) {
    try {
      // FIX 6: Limit price concession — try ask, then mid if unfilled, then bid+spread
      // MR entries need fills urgently — don't miss the bounce waiting for a perfect price
      const askPrice = parseFloat(contract.ask.toFixed(2));
      const midPrice = contract.bid > 0 ? parseFloat(((contract.bid + contract.ask) / 2).toFixed(2)) : askPrice;
      const concessionPrices = [askPrice, midPrice]; // ask first, mid as fallback
      let limitPrice = askPrice;
      let fillConfirmed = false;
      let fillPrice = null;
      alpacaOrderId = null;

      for (let attempt = 0; attempt < concessionPrices.length && !fillConfirmed; attempt++) {
        limitPrice = concessionPrices[attempt];
        if (attempt > 0) {
          logEvent("trade", `Order concession attempt ${attempt+1}: widening limit to $${limitPrice} (mid price)`);
        }
        const orderBody = {
          symbol:        contract.symbol,
          qty:           contracts,
          side:          "buy",
          type:          "limit",
          time_in_force: "day",
          limit_price:   limitPrice,
        };
        const orderResp = await alpacaPost("/orders", orderBody);
        if (!orderResp || !orderResp.id) {
          logEvent("warn", `Alpaca order failed (attempt ${attempt+1}): ${JSON.stringify(orderResp)?.slice(0,150)}`);
          continue;
        }
        alpacaOrderId = orderResp.id;
        logEvent("trade", `Alpaca order submitted: ${orderResp.id} | ${contract.symbol} | ${contracts}x @ $${limitPrice} (attempt ${attempt+1})`);

        // Poll up to 8s per attempt (total max ~16s across both attempts)
        const FILL_TIMEOUT  = attempt === 0 ? 6000 : 8000;
        const POLL_INTERVAL = 1000;
        const pollStart = Date.now();

        if (orderResp.status === "filled" && orderResp.filled_avg_price) {
          fillConfirmed = true;
          fillPrice = parseFloat(parseFloat(orderResp.filled_avg_price).toFixed(2));
          logEvent("trade", `Order ${alpacaOrderId} filled immediately @ $${fillPrice}`);
        } else {
          while (!fillConfirmed && Date.now() - pollStart < FILL_TIMEOUT) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            try {
              const pollResp = await alpacaGet(`/orders/${alpacaOrderId}`);
              if (pollResp && pollResp.status === "filled" && pollResp.filled_avg_price) {
                fillConfirmed = true;
                fillPrice = parseFloat(parseFloat(pollResp.filled_avg_price).toFixed(2));
                logEvent("trade", `Order ${alpacaOrderId} fill confirmed @ $${fillPrice} (${((Date.now()-pollStart)/1000).toFixed(1)}s, attempt ${attempt+1})`);
              } else if (pollResp && ["canceled","expired","rejected"].includes(pollResp.status)) {
                logEvent("warn", `Order ${alpacaOrderId} ${pollResp.status}`);
                break;
              }
            } catch(e) { logEvent("warn", `Fill poll error: ${e.message}`); break; }
          }
          if (!fillConfirmed) {
            try { await alpacaDelete(`/orders/${alpacaOrderId}`); } catch(e) {}
            logEvent("warn", `Order not filled in ${FILL_TIMEOUT/1000}s at $${limitPrice} — ${attempt < concessionPrices.length-1 ? 'trying concession' : 'all attempts exhausted'}`);
            alpacaOrderId = null;
          }
        }
      }

      if (!fillConfirmed) {
          state._pendingOrder = null;
          markDirty();
          alpacaOrderId = null;
      } else if (fillPrice) {
          contract.premium = fillPrice; // use actual fill price
          state._pendingOrder = null;
          markDirty();
          if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
          state.dataQuality.realTrades++;
          logEvent("trade", `Live fill confirmed - real trade count: ${state.dataQuality.realTrades}/30 before Kelly activates`);
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
    entryRegime:     state._regimeClass || "A",   // regime at entry — for journal post-mortem
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

module.exports = {
  executeTrade,
  findContract, bsStrikeForDelta, getOptionsPrice,
  initExecution,
  calcPositionSize,
};
