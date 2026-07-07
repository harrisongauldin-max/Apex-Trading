// execution.js — ARGO V3.2
// Order execution: credit spreads, debit spreads, single-leg options.
// Handles order submission, fill confirmation, position state updates.
'use strict';

let dryRunMode = false; // set by scanner via setDryRunMode()
function setDryRunMode(v) { dryRunMode = v; }
const fmt = (n) => '$' + (n||0).toFixed(2);
const MAX_LOSS_PER_TRADE = 900;
const MAX_CONTRACTS = 1;   // 6/30 (Harrison): 3→1. Single contract per position keeps per-leg heat minimal so twin-entry pairs aren't throttled by MAX_HEAT; also makes the same-week vs standard legs directly comparable (equal contract count).
const VIX_REDUCE50 = 35;
const VIX_REDUCE25 = 28;

const { alpacaGet, alpacaPost, alpacaDelete, getStockBars } = require('./broker');
const { state, logEvent, markDirty, saveStateNow, dataGatherActive }          = require('./state');
const { calcGreeks, getETTime,
        openRisk, heatPct, getDeployableCash, effectiveHeatCap,
        calcCreditSpreadTP ,
  totalCap
}                                 = require('./signals');
const { CAPITAL_FLOOR, MIN_OPTION_PREMIUM, MIN_OI,
        MAX_SPREAD_PCT, EARLY_SPREAD_PCT, TARGET_DELTA_MIN,
        TARGET_DELTA_MAX, MONTHLY_BUDGET, INDIVIDUAL_STOCKS_ENABLED,
        WATCHLIST, ALPACA_OPT_SNAP, ALPACA_OPTIONS, OPTION_FEED,
        MAX_HEAT, STOP_LOSS_PCT, TAKE_PROFIT_PCT, DATA_GATHER_MODE,
}                                          = require('./constants');
const { confirmPendingOrder } = require('./closeEngine');
const { writeJournalEntry } = require('./state');
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
  const d = Math.max(0.01, Math.min(0.99, targetDelta));
  const q = Math.min(d, 1 - d);
  const t = Math.sqrt(-2 * Math.log(q));
  const normInvD = (d < 0.5 ? -1 : 1) * (t - (2.515517 + 0.802853*t + 0.010328*t*t) /
                   (1 + 1.432788*t + 0.189269*t*t + 0.001308*t*t*t));
  const d1 = optionType === "put" ? -normInvD : normInvD;
  const lnSK = d1 * sigma * Math.sqrt(T) - (r + sigma*sigma/2) * T;
  const strikeRaw = price * Math.exp(-lnSK);
  const inc = price < 200 ? 0.5 : 1;
  return Math.round(strikeRaw / inc) * inc;
}

async function getOptionsPrice(symbol) {
  try {
    const data = await alpacaGet(`/options/snapshots?symbols=${symbol}&feed=${OPTION_FEED}`, ALPACA_OPT_SNAP);
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

    const targetStrike = bsStrikeForDelta(stock ? stock.price || 0 : 0, targetDelta, T, sigma, optionType);
    if (!targetStrike || targetStrike <= 0) return null;

    let fetchMin, fetchMax;
    if (fixedExpiry) {
      fetchMin = fixedExpiry;
      fetchMax = fixedExpiry;
    } else {
      // 6/30: band-aware window. Same-week profile (small targetDTE) → 0-8 DTE. Monthly profile → ±10 (30-50).
      const minDays = targetDTE <= 10 ? 0 : Math.max(0, targetDTE - 10);
      const maxDays = targetDTE <= 10 ? 8 : Math.min(120, targetDTE + 10);
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

    allC.sort((a, b) => {
      const da = Math.abs(parseFloat(a.strike_price) - targetStrike);
      const db = Math.abs(parseFloat(b.strike_price) - targetStrike);
      if (Math.abs(da - db) > 0.01) return da - db;
      const aDTE = Math.round((new Date(a.expiration_date) - today) / 86400000);
      const bDTE = Math.round((new Date(b.expiration_date) - today) / 86400000);
      return Math.abs(aDTE - targetDTE) - Math.abs(bDTE - targetDTE);
    });

    const symbols = allC.slice(0, 50).map(c => c.symbol);
    const batches = [];
    for (let i = 0; i < symbols.length; i += 25) batches.push(symbols.slice(i, i+25).join(","));
    const snapResults = await Promise.all(
      batches.map(b => alpacaGet(`/options/snapshots?symbols=${b}&feed=${OPTION_FEED}`, ALPACA_OPT_SNAP).catch(() => null))
    );
    const snaps = snapResults.reduce((acc, r) => ({ ...acc, ...(r?.snapshots || {}) }), {});

    const deltaMin = Math.max(0.05, targetDelta - 0.12);
    const deltaMax = Math.min(0.65, targetDelta + 0.12);

    let _best = null, _bestDist = Infinity, _bestRawIV = 0;   // BUG-1 fix: closest-to-target delta
    let _ivWin = { withIV: 0, total: 0 };   // Q3.1: measure indicative-feed IV coverage across the evaluated window
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
      // Cap derives from the requested band: a same-week request (targetDTE<=10) caps at 8; a standard
      // request caps at 55 (covers 30-50). Keeps each twin-entry leg inside its own band.
      const DTE_ENTRY_CAP = targetDTE <= 10 ? 8 : 55;
      if (expDTE > DTE_ENTRY_CAP) {
        logEvent("filter", `${ticker} findContract: skipping $${strike} ${expDTE}DTE — exceeds ${DTE_ENTRY_CAP}DTE entry cap (${targetDTE <= 10 ? "same-week" : "standard"} band)`);
        continue;
      }
      const _rawIV = parseFloat(snap.impliedVolatility || 0);   // Q3.1: raw feed IV (pre sigma-fallback)
      _ivWin.total++; if (_rawIV > 0) _ivWin.withIV++;
      const _dist = Math.abs(delta - targetDelta);
      if (_dist < _bestDist) {
        _bestDist = _dist;
        _bestRawIV = _rawIV;
        _best = {
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
    }

    if (_best) {
      // Q3.1: track whether the indicative feed returned real IV for the contract we would actually use.
      if (!state._ivCoverage) state._ivCoverage = { withIV: 0, total: 0 };
      state._ivCoverage.total++; if (_bestRawIV > 0) state._ivCoverage.withIV++;
      const _covPct = (100 * state._ivCoverage.withIV / state._ivCoverage.total).toFixed(0);
      logEvent("filter", `[IV-COVERAGE] ${ticker} chosen ${_bestRawIV > 0 ? `feed IV ${_bestRawIV.toFixed(3)}` : "feed IV MISSING (realized-vol proxy)"} | window ${_ivWin.withIV}/${_ivWin.total} | session ${_covPct}% (${state._ivCoverage.withIV}/${state._ivCoverage.total})`);
      logEvent("filter", `${ticker} findContract: ${optionType} $${_best.strike} | ${_best.expDays}DTE | delta${Math.abs(parseFloat(_best.greeks.delta)).toFixed(3)} | $${_best.premium} | target delta${targetDelta} strike $${targetStrike} (closest in-window)`);
      return _best;
    }

    logEvent("filter", `${ticker} findContract: no valid ${optionType} found (target delta${targetDelta} strike $${targetStrike} window ${fetchMin}->${fetchMax})`);
    return null;
  } catch(e) {
    logEvent("error", `findContract(${ticker}): ${e.message}`);
    return null;
  }
}

function calcPositionSize(premium, score, vix) {
  const recentTrades = (state.closedTrades || []).slice(-30);   // BUG-3 fix: closedTrades is push-ordered (oldest-first); slice(-30) = newest 30. Was slice(0,30) = OLDEST 30, so Kelly never saw recent performance.
  let kellyBase;

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
    kellyBase = preCalibration ? 0.07 : 0.08;
  }

  const preCalibCap = preCalibration ? 3 : 99;
  const convictionMult = score >= 85 ? 1.25 : score >= 75 ? 1.0 : score >= 70 ? 0.80 : 0.60;

  const etNow  = getETTime();
  const minsSinceOpen = (etNow.getHours() - 9) * 60 + etNow.getMinutes() - 30;
  const openingMult   = minsSinceOpen < 30 ? 0.75 : 1.0;

  const vixMult = vix >= 40  ? 0.35
                : vix >= 35  ? 0.60
                : 1.0;

  const ddMult = (_getDrawdown()?.sizeMultiplier) || (_getDrawdown()?.sizeMult) || 1.0;

  const effectiveFraction = kellyBase * convictionMult * vixMult * ddMult * openingMult;
  const maxCost           = Math.min(
    state.cash * effectiveFraction,
    state.cash * 0.20,
    MAX_LOSS_PER_TRADE / STOP_LOSS_PCT
  );

  const contracts = Math.max(1, Math.min(Math.min(MAX_CONTRACTS, preCalibCap), Math.floor(maxCost / (premium * 100))));

  const singleContractCost = premium * 100;
  const riskCap = MAX_LOSS_PER_TRADE / STOP_LOSS_PCT;
  if (singleContractCost > riskCap) {
    if (score >= 85 && singleContractCost < state.cash * 0.20 && premium < 25) {
      return 1;
    }
    return 0;
  }

  return contracts;
}

async function executeTrade(stock, price, score, scoreReasons, vix, optionType = "call", isMeanReversion = false, sizeMod = 1.0, dteBand = null, targetCost = null) {
  const estimatedMinCost = price * 0.03 * 100;
  if (state.cash - estimatedMinCost < CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash pre-check (est. min cost ${fmt(estimatedMinCost)})`);
    return false;
  }

  const targetDelta = isMeanReversion ? 0.42 : 0.35;
  // 6/30 (Harrison): DTE resolution.
  //   dteBand === "sameweek" → force 0-8 DTE leg.  dteBand === "standard" → force the 30-50 momentum band.
  //   dteBand === null (normal call) → DATA_GATHER_MODE forces same-week; otherwise per-profile default.
  // Twin-entry A/B (data-gather on) calls this TWICE with each band so both expiries open on one signal.
  const _dgm = dataGatherActive(DATA_GATHER_MODE);
  const targetDTE = dteBand === "sameweek" ? 3
                  : dteBand === "standard" ? 40
                  : (_dgm ? 3 : (isMeanReversion ? 3 : 40));
  const _sameWeekLeg = (dteBand === "sameweek") || (dteBand === null && _dgm);
  // Twin-entry: the prefetch caches ONE contract. Only the same-week leg may use it; the standard leg
  // must select its own (else it would inherit the same-week cache). Validate the cache against the band.
  let contract;
  if (dteBand === "standard") {
    contract = await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
  } else {
    contract = stock._cachedContract || await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
    if (contract && _sameWeekLeg) {
      const _cDTE = contract.expDays || contract.dte ||
        (contract.expiration_date ? Math.round((new Date(contract.expiration_date) - new Date()) / 86400000) : 0);
      if (_cDTE > 8) {
        logEvent("filter", `${stock.ticker} - cached ${_cDTE}DTE contract rejected (same-week leg) — re-selecting`);
        contract = await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
      }
    }
  }
  delete stock._cachedContract;

  if (!contract) {
    logEvent("warn", `- ${stock.ticker} - NO REAL OPTIONS DATA - using Black-Scholes estimate. Check Alpaca Pro subscription.`);
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.estimatedTrades++;
    state.dataQuality.totalTrades++;
    const iv       = 0.25 + stock.ivr * 0.003;
    const expDays = _sameWeekLeg ? 4 : (dteBand === "standard" ? 35 : (isMeanReversion ? 21 : 28));   // 6/30: leg-aware fallback DTE
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
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.totalTrades++;
  }

  if (contract.premium < MIN_OPTION_PREMIUM) {
    logEvent("skip", `${stock.ticker} - premium $${contract.premium} below minimum $${MIN_OPTION_PREMIUM} (penny option — spread risk too high)`);
    return false;
  }

  let contracts = calcPositionSize(contract.premium, score, vix);
  if (sizeMod < 1.0) {
    contracts = Math.max(1, Math.floor(contracts * sizeMod));
    logEvent("scan", `[SIZING] ${stock.ticker} sizeMod ${sizeMod}x applied - ${contracts} contracts (oversold bear trend)`);
  }
  // 7/7 (Harrison): COST-MATCH the same-week twin leg to the standard leg's dollar cost. The A/B compares
  // same-week vs standard on EQUAL CAPITAL, not equal contract count — a 3-DTE option is far cheaper than a
  // 40-DTE one, so 1 contract each deployed lopsided capital. When targetCost (the standard leg's finalCost)
  // is passed for the same-week leg, size to match it, buying more of the cheaper weekly. Still bounded by
  // the normal per-trade risk caps and a hard contract cap so a very cheap weekly can't blow up the count.
  if (targetCost && targetCost > 0 && _sameWeekLeg) {
    const _perContract = contract.premium * 100;
    if (_perContract > 0) {
      const _riskCap   = MAX_LOSS_PER_TRADE / STOP_LOSS_PCT;                       // max $ cost/trade
      const _dollarCap = Math.min(targetCost * 1.15, _riskCap, state.cash * 0.20); // don't exceed standard by >15%, or the normal caps
      const _capN      = Math.max(1, Math.floor(_dollarCap / _perContract));
      const _matchN    = Math.max(1, Math.round(targetCost / _perContract));
      contracts        = Math.min(_matchN, _capN, 25);                            // 25 = hard sanity cap (liquidity/slippage on cheap weeklies)
      logEvent("scan", `[COST-MATCH] ${stock.ticker} same-week sized ${contracts}x @ $${contract.premium} ≈ $${(contracts*_perContract).toFixed(0)} to match standard leg cost $${targetCost.toFixed(0)}`);
    }
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

  if (cost > state.cash - CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash after floor (need ${fmt(cost)})`);
    return false;
  }

  const delta = parseFloat(contract.greeks.delta || 0);
  if (Math.abs(delta) < TARGET_DELTA_MIN || Math.abs(delta) > TARGET_DELTA_MAX) {
    logEvent("filter", `${stock.ticker} - delta ${delta} outside target range`);
    return false;
  }

  if (!_dryRunMode && state._pendingOrder && state._pendingOrder.ticker === stock.ticker) {
    logEvent("filter", `${stock.ticker} pending order exists - skipping naked/MR submission`);
    return false;
  }
  if (!_dryRunMode) {
    state._pendingOrder = {
      orderId:        `argo-naked-${stock.ticker}-${Date.now()}`,
      ticker:         stock.ticker,
      optionType,
      isCreditSpread: false,
      isNaked:        true,
      submittedAt:    Date.now(),
      _preSubmit:     true,
      strike:         contract.strike,
      expDate:        contract.expDate || contract.exp,
      expDays:        contract.dte || contract.expDays,
      contractSymbol: contract.symbol,
      premium:        contract.ask,
      delta:          contract.delta,
      iv:             contract.iv,
      score:          stock._lastScore || stock.score || 0,
      reasons:        stock._lastReasons || [],
      rsi:            stock.rsi || stock.liveRSI,
      dailyRsi:       stock.dailyRsi,
      macd:           stock.macd,
      momentum:       stock.momentum,
      dte:            contract.dte,
      isMeanReversion: stock.isMeanReversion || false,
    };
    markDirty();
  }
  let alpacaOrderId = null;
  if (contract.symbol && contract.ask > 0 && !_dryRunMode) {
    try {
      const askPrice = parseFloat(contract.ask.toFixed(2));
      const midPrice = contract.bid > 0 ? parseFloat(((contract.bid + contract.ask) / 2).toFixed(2)) : askPrice;
      const _payUp = parseFloat(Math.min(askPrice * 1.02, askPrice + 0.15).toFixed(2));
      const concessionPrices = [askPrice, _payUp];   // BUG-5 fix: escalate for a BUY — cross at ask, then pay up (<=2% / 15c) to catch a quote that moved between findContract and submit. Was [ask, mid], which RETREATED and guaranteed the 2nd attempt missed in a fast tape.
      let limitPrice = askPrice;
      let fillConfirmed = false;
      let fillPrice = null;
      alpacaOrderId = null;

      for (let attempt = 0; attempt < concessionPrices.length && !fillConfirmed; attempt++) {
        limitPrice = concessionPrices[attempt];
        if (attempt > 0) {
          logEvent("trade", `Order concession attempt ${attempt+1}: paying up to $${limitPrice} to ensure fill`);
        }
        const orderBody = {
          symbol:          contract.symbol,
          qty:             contracts,
          side:            "buy",
          type:            "limit",
          time_in_force:   "day",
          limit_price:     limitPrice,
          position_intent: "buy_to_open",
        };
        const orderResp = await alpacaPost("/orders", orderBody);
        if (!orderResp || !orderResp.id) {
          logEvent("warn", `Alpaca order failed (attempt ${attempt+1}): ${JSON.stringify(orderResp)?.slice(0,150)}`);
          continue;
        }
        alpacaOrderId = orderResp.id;
        logEvent("trade", `Alpaca order submitted: ${orderResp.id} | ${contract.symbol} | ${contracts}x @ $${limitPrice} (attempt ${attempt+1})`);

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
          contract.premium = fillPrice;
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

  if (contract.symbol && !_dryRunMode && alpacaOrderId === null && contract.symbol) {
    logEvent("skip", `${stock.ticker} - trade aborted, order not filled`);
    return false;
  }

  const finalCost     = parseFloat((contract.premium * 100 * contracts).toFixed(2));
  const exitParams    = getDTEExitParams(contract.expDays || 30, 0, optionType);
  const finalTarget   = parseFloat((contract.premium * (1 + exitParams.takeProfitPct)).toFixed(2));
  const finalStop     = parseFloat((contract.premium * (1 - exitParams.stopLossPct)).toFixed(2));
  const finalBreakeven = optionType === "put"
    ? parseFloat((contract.strike - contract.premium).toFixed(2))
    : parseFloat((contract.strike + contract.premium).toFixed(2));

  if (finalCost > state.cash - CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash after fill price adjustment`);
    if (alpacaOrderId) {
      try {
        await alpacaDelete(`/orders/${alpacaOrderId}`);
        logEvent("trade", `Alpaca order ${alpacaOrderId} cancelled - insufficient cash`);
      } catch(e) { logEvent("error", `Failed to cancel order ${alpacaOrderId}: ${e.message}`); }
    }
    return false;
  }

  if (_dryRunMode) {
    logEvent("dryrun", `WOULD BUY ${stock.ticker} ${optionType.toUpperCase()} $${contract.strike} | ${contracts}x @ $${contract.premium} | cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta}`);
    return { filled: true, cost: finalCost, contracts, premium: contract.premium };   // 7/7: return cost so twin-entry can size the same-week leg to match (object is truthy → all existing `if (entered)` / `_leg || _leg` checks still work)
  }

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
    dteBand:        dteBand || (_sameWeekLeg ? "sameweek" : "standard"),   // 6/30: A/B leg tag for twin-entry comparison
    isTier3:        (contract.expDays || contract.dte || 0) > 45 && !isMeanReversion,
    entryVIX:       vix,
    partialClosed:  false,
    openDate:       new Date().toISOString(),
    ivr:            stock.ivr,
    iv:             contract.iv,
    greeks:         contract.greeks,
    beta:           stock.beta || 1,
    peakPremium:    contract.premium,
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
    entryRSI:        stock.rsi || 52,
    entryDailyRSI:   stock.dailyRsi || stock.rsi || 52,
    entryMomentum:   stock.momentum || "steady",
    entryMACD:       stock.macd || "neutral",
    entryMacro:      (state._agentMacro || {}).signal || "neutral",
    entryRegime:     state._regimeClass || "A",
    entryRelStr:     stock._relStrength || 1.0,
    entryADX:        stock._adx || 0,
    entryThesisScore: 100,
    thesisHistory:   [],
    agentHistory:    [],
  };

  state.positions.push(position);

  const _singleSlipEst = parseFloat((0.08 * (contracts || 1)).toFixed(2));   // 7/7: was contract.contracts (never set → always 1); now uses the real (possibly cost-matched) contract count so paper-slippage isn't undercounted on multi-contract legs
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
    scoreReasons:  scoreReasons,
    delta:         contract.greeks.delta,
    iv:            parseFloat(((contract.iv||0.3)*100).toFixed(1)),
    vix,
    washSaleFlag:  stock._washSaleWarning || false,
    reasoning:     `Score ${score}/100. ${scoreReasons.slice(0,3).join(". ")}.${stock._washSaleWarning ? " - WASH SALE WARNING." : ""}`,
  });
  if (state.tradeJournal.length > 100) state.tradeJournal = state.tradeJournal.slice(0,100);

  const typeLabel = optionType === "put" ? "P" : "C";
  const dataLabel = contract.symbol ? "REAL" : "EST";

  if (!_dryRunMode && contract.oi > 0 && contract.oi < MIN_OI) {
    logEvent("filter", `${stock.ticker} BLOCKED - OI:${contract.oi} below minimum ${MIN_OI} - unfillable in live trading`);
    return false;
  }
  if (!_dryRunMode && contract.spread > MAX_SPREAD_PCT) {
    const slippageEst = parseFloat((contract.premium * contract.spread * 0.5 * 100 * contracts).toFixed(2));
    logEvent("filter", `[WIDE-SPREAD] ${stock.ticker} BLOCKED — spread ${(contract.spread*100).toFixed(0)}% exceeds ${(MAX_SPREAD_PCT*100).toFixed(0)}% max - est. slippage $${slippageEst}`);
    return false;
  }
  if (contract.oi > 0 && contract.oi < 50) {
    logEvent("warn", `- ${stock.ticker} LOW OI: ${contract.oi} - fill may be slow`);
  } else if (contract.oi === 0) {
    logEvent("warn", `- ${stock.ticker} OI UNKNOWN - treat as potentially illiquid`);
  }
  if (contract.spread > 0.15) {
    const slippageEst = parseFloat((contract.premium * contract.spread * 0.5 * 100 * contracts).toFixed(2));
    logEvent("warn", `- ${stock.ticker} WIDE SPREAD: ${(contract.spread*100).toFixed(0)}% - est. slippage $${slippageEst}`);
  }

  await saveStateNow();

  // ADD (6/14): one grep-able structured line per entry — slices put fires by tier/breadth/lab
  {
    const _lab = state._breadthLab;
    const _labStr = _lab
      ? `RSP-SPY:${_lab.spSpread ?? '?'}(${_lab.spLabel || '?'}) QQQE-QQQ:${_lab.nqSpread ?? '?'}(${_lab.nqLabel || '?'}) accel:${_lab.accel ?? '?'}`
      : 'lab:n/a';
    const _wt = stock._weeklyTrend;
    const _wkStr = _wt ? `${_wt.trendContext || '?'}/above10wk:${_wt.above10wk}` : 'weekly:n/a';
    const _tierStr = optionType === 'put'
      ? (((stock.dailyRsi || 0) >= 75) ? 'full' : ((stock.dailyRsi || 0) >= 70) ? 'soft' : 'standard')
      : 'call';
    logEvent('filter', `[ENTRY-FIRED] ${stock.ticker} ${optionType.toUpperCase()} score:${score} tier:${_tierStr} | RSI:${stock.rsi ?? '?'} dailyRSI:${stock.dailyRsi ?? '?'} | breadth:${state._breadth ?? '?'}% | ${_labStr} | wk:${_wkStr} | regime:${state._regimeClass || '?'} | reasons:${(scoreReasons||[]).slice(0,4).join(' · ')}`);
  }

  writeJournalEntry({
    id:             `${contract.symbol}_${Date.now()}`,
    contractSymbol: contract.symbol,
    ticker:         stock.ticker,
    optionType,
    strike:         contract.strike,
    expDate:        contract.expDate || contract.exp,
    tradeType:      'naked',
    isMeanReversion: isMeanReversion || false,
    openDate:       new Date().toISOString(),
    openDateET:     new Date().toLocaleString('en-US', {timeZone:'America/New_York'}),
    entryPrice:     contract.premium,
    entryContracts: contracts,
    entryCost:      finalCost,
    entryScore:     score,
    entryReasons:   scoreReasons || [],
    entryRSI:       optionType === 'put'
                      ? (stock.dailyRsi || stock.rsi || null)
                      : (stock.rsi || stock.liveRSI || null),
    entryDailyRSI:  stock.dailyRsi || null,
    entryDelta:     contract.greeks?.delta || contract.delta || null,
    entryIV:        contract.iv || null,
    entryVIX:       vix || null,
    entryIVR:       state._ivRank || null,
    entryIVP:            stock.ivPercentile ?? null,
    entryBreadth:        state._breadth ?? null,
    entryRegimeClass:    state._regimeClass || null,
    entryRegimeDuration: state._regimeDuration || 0,
    // ADD (6/14): put-validation slicing context for [ENTRY-FIRED] / journal breakdown
    entryPutTier:    optionType === 'put'
                       ? (((stock.dailyRsi || 0) >= 75) ? 'full' : ((stock.dailyRsi || 0) >= 70) ? 'soft' : 'standard')
                       : null,
    entryWeeklyTrend: stock._weeklyTrend
                       ? { above10wk: stock._weeklyTrend.above10wk, trendContext: stock._weeklyTrend.trendContext }
                       : null,
    entryBreadthLab: state._breadthLab
                       ? { spSpread: state._breadthLab.spSpread, spLabel: state._breadthLab.spLabel,
                           nqSpread: state._breadthLab.nqSpread, nqLabel: state._breadthLab.nqLabel,
                           accel: state._breadthLab.accel, trend: state._breadthLab.trend }
                       : null,
    entryMACD:      stock.macd || null,
    entryMomentum:  stock.momentum || null,
    macroSignal:    (state._agentMacro || {}).signal || 'neutral',
    _isGapDayEntry: (state._todayGapAbs || 0) >= 1.5,
    regimeAtEntry:  (state._marketRegime || {}).regime || 'unknown',
    peakPrice:      contract.premium,
    peakPct:        0,
    peakTime:       new Date().toISOString(),
    minsToPeak:     0,
    maxAdverseMove: 0,
    _thesisFulfilled: false,
    _thesisFailure:   false,
    closeDate:      null,
    closeDateET:    null,
    exitPrice:      null,
    exitReason:     null,
    exitRSI:        null,
    exitVIX:        null,
    pnl_apex:       null,
    pnl_alpaca:     null,
    pnl_pct:        null,
    hoursHeld:      null,
    isWin:          null,
    status:         'OPEN',
  }).catch(e => {});

  logEvent("trade",
    `BUY ${stock.ticker} $${contract.strike}${typeLabel} exp ${contract.expDate} | ${contracts}x @ $${contract.premium} | ` +
    `cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta} | ${isMeanReversion ? "MEAN-REV" : exitParams.label} | [${dataLabel}] | ` +
    `OI:${contract.oi} spread:${(contract.spread*100).toFixed(1)}% | cash ${fmt(state.cash)} | heat ${(heatPct()*100).toFixed(0)}%`
  );
  return { filled: true, cost: finalCost, contracts, premium: contract.premium };   // 7/7: return cost so twin-entry can cost-match the same-week leg
}

function executeCreditSpread() {
  logEvent("warn", "executeCreditSpread called but APEX trades naked options only — returning null");
  return null;
}

module.exports = {
  executeTrade,
  executeCreditSpread,
  findContract, bsStrikeForDelta, getOptionsPrice,
  initExecution,
  calcPositionSize,
};
