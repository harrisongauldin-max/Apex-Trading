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
// 8/12: DEFENSIVE REQUIRE. vol.js is OPTIONAL instrumentation — realized vol, IV-RV, surface,
// feasibility. It gates nothing and executes no trades. A hard top-level require made a missing
// file fatal: server.js -> scanner.js -> vol.js, so one absent module killed the whole process and
// Railway crash-looped it. That is not a degraded mode, it is a DEAD BOT — no stops, no fast-cut,
// no 3:15 flatten, open positions unmanaged. Optional instrumentation must never be able to do
// that. If vol.js is absent the measurement layer goes dark and everything else runs normally.
let VOL = null;
try {
  VOL = require('./vol.js');
} catch (_volReqErr) {
  console.error('[VOL] vol.js not found — vol instrumentation DISABLED, trading and exits unaffected. Add vol.js to the repo root to enable it.');
}
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
        MR_SCALP_TARGET_DTE = 1, MR_SCALP_DELTA = 0.42,
        VOL_INFRA_ENABLED = false, CHAIN_RETAIN_ENABLED = false, CHAIN_RETAIN_MAX = 60,
        SLIPPAGE_LOG_ENABLED = false, DECISION_SPLIT_LOG = false,
        SPREAD_COST_LOG = false, FEASIBILITY_ENABLED = false, FEASIBILITY_ENFORCE = false,
        FEASIBILITY_MAX_RATIO = 1.0, FEASIBILITY_HOLD_MIN = 20, FLAT_SIZING_ENABLED = false,
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

// Two open contracts on the same ticker+optionType+expiry within this many strikes are the SAME
// trade, not two signals. Twin-leg legs differ by EXPIRY so they are unaffected.
const MIN_STRIKE_DISTINCT = 5;

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
      // 8/03: biweekly gets an EXPLICIT 9-16 window. The generic targetDTE±10 would give 3-23,
      // which overlaps the same-week band and would let the two legs resolve to the same contract.
      const _isBiweekly = targetDTE > 10 && targetDTE <= 20;
      // 8/14: TIGHTEN THE SHORT WINDOW. targetDTE<=10 used to open a 0-8 day window, and because the
      // contract sort ranks by STRIKE distance first (DTE only breaks ties within a cent), a "3 DTE"
      // request could fill anywhere from 0 to 8 days — a 5x spread in rung-reachability masquerading
      // as one treatment. +/-2 pins it. The floor of 1 deliberately excludes 0DTE: at 2:30pm a 0DTE
      // contract loses ~3.4% to theta in the fast-cut's first six minutes, so it would trip the +3%
      // bar on decay alone with no adverse price move at all.
      const minDays = _isBiweekly ? 9 : (targetDTE <= 10 ? Math.max(1, targetDTE - 2) : Math.max(0, targetDTE - 10));
      const maxDays = _isBiweekly ? 16 : (targetDTE <= 10 ? targetDTE + 2 : Math.min(120, targetDTE + 10));
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
    // 8/11 ITEM 1: RETAIN THE CHAIN. Every contract below is already priced, greeked and quoted;
    // the loop kept ONE and dropped the rest. Collecting them costs nothing extra on the wire and
    // yields the IV surface — skew across strikes, term structure across expiries.
    const _chainRows = [];
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
      // 8/03: biweekly caps at 16 so it cannot drift up into the standard band.
      const _bwBand = targetDTE > 10 && targetDTE <= 20;
      const DTE_ENTRY_CAP = targetDTE <= 10 ? 8 : (_bwBand ? 16 : 55);
      const _bandName = targetDTE <= 10 ? "same-week" : (_bwBand ? "biweekly" : "standard");
      if (expDTE > DTE_ENTRY_CAP) {
        logEvent("filter", `${ticker} findContract: skipping $${strike} ${expDTE}DTE — exceeds ${DTE_ENTRY_CAP}DTE entry cap (${_bandName} band)`);
        continue;
      }
      const _rawIV = parseFloat(snap.impliedVolatility || 0);   // Q3.1: raw feed IV (pre sigma-fallback)
      _ivWin.total++; if (_rawIV > 0) _ivWin.withIV++;

      // 8/11 ITEM 1: capture EVERY evaluated contract. Raw IV only — never the sigma fallback,
      // or the surface fills with a VIX-derived constant posing as a per-strike measurement.
      if (CHAIN_RETAIN_ENABLED && _chainRows.length < CHAIN_RETAIN_MAX) {
        _chainRows.push({
          symbol: c.symbol, strike, dte: expDTE,
          delta: parseFloat(g.delta || 0), iv: _rawIV > 0 ? _rawIV : null,
          bid, ask, mid: parseFloat(mid.toFixed(2)),
          spreadPct: ask > 0 ? (ask - bid) / ask : null,
          oi: parseInt(snap.openInterest || 0),
          theta: parseFloat(g.theta || 0), gamma: parseFloat(g.gamma || 0), vega: parseFloat(g.vega || 0),
        });
      }
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
      // 8/11 ITEM 1+3: collapse the retained chain into surface stats and stash on the chosen
      // contract. Wrapped — a surface failure must never block an otherwise valid trade.
      // 8/12: WRITE _realIV AT THE SOURCE. It was only assigned at scanner.js:2820, inside the
      // options prefetch gated on `scored.length > 0`. findContract has FOUR call sites and runs
      // constantly regardless of whether anything clears the floor — so on a session where nothing
      // scores, _realIV stayed empty all day and the VRP was suppressed even though [IV-COVERAGE]
      // was reporting 100% real feed IV on every single scan. Setting it here covers every path.
      if (stock && _bestRawIV > 0) stock._realIV = _bestRawIV;

      if (CHAIN_RETAIN_ENABLED && VOL && _chainRows.length) {
        try {
          _best._surface = VOL.surfaceStats(_chainRows);
          _best._chainN  = _chainRows.length;
          if (!state._chainSnaps) state._chainSnaps = [];
          // 8/24: throttle to ~1/min per (ticker,side,DTE) and hold a full session. The old 400-cap
          // FIFO'd all but the last ~45min out before the EOD flush — the whole trading day was
          // computed and discarded, leaving volsurface unusable for backtesting (only ~2:45-3:30pm
          // survived). ~1/min x ~12 keys x 390min ~= 4.7k rows; cap 6000 keeps the day. In-memory only.
          if (!state._chainSnapLast) state._chainSnapLast = {};
          const _csKey = `${ticker}|${optionType}|${targetDTE}`;
          if ((Date.now() - (state._chainSnapLast[_csKey] || 0)) >= 60000) {
            state._chainSnapLast[_csKey] = Date.now();
            state._chainSnaps.push({ ts: Date.now(), ticker, side: optionType, targetDTE, rows: _chainRows });
            if (state._chainSnaps.length > 6000) state._chainSnaps.shift();
          }
          // 8/24: stash the chain BY SIDE so GEX (dealer-gamma regime) can be computed from both
          // sides at telemetry time. findContract runs per-side, so each pass fills one side.
          // 8/24 (panel): only NEAR-TERM chains feed GEX — 0DTE gamma drives intraday pinning; the
          // 40-DTE standard leg's chain gives a different, wrong regime. Tag the DTE so the scanner
          // nets calls+puts from the SAME expiry only (mixing expiries = meaningless net GEX).
          const _cdte = (_chainRows[0] && _chainRows[0].dte != null) ? _chainRows[0].dte : null;
          if (_cdte != null && _cdte <= 7) {
            if (!state._gexChain) state._gexChain = {};
            if (!state._gexChain[ticker]) state._gexChain[ticker] = {};
            state._gexChain[ticker][optionType] = { rows: _chainRows, dte: _cdte, spot: (stock && (stock.price || stock.lastPrice)) || 0, ts: Date.now() };
          }
        } catch (_sErr) {
          logEvent("scan", `[SURFACE] ${ticker} surface failed — ${_sErr.message} (trade unaffected)`);
        }
      }
      // Q3.1: track whether the indicative feed returned real IV for the contract we would actually use.
      if (!state._ivCoverage) state._ivCoverage = { withIV: 0, total: 0 };
      state._ivCoverage.total++; if (_bestRawIV > 0) state._ivCoverage.withIV++;
      const _covPct = (100 * state._ivCoverage.withIV / state._ivCoverage.total).toFixed(0);
      logEvent("filter", `[IV-COVERAGE] ${ticker} chosen ${_bestRawIV > 0 ? `feed IV ${_bestRawIV.toFixed(3)}` : "feed IV MISSING (realized-vol proxy)"} | window ${_ivWin.withIV}/${_ivWin.total} | session ${_covPct}% (${state._ivCoverage.withIV}/${state._ivCoverage.total})`);
      logEvent("filter", `${ticker} findContract: ${optionType} $${_best.strike} | ${_best.expDays}DTE | delta${Math.abs(parseFloat(_best.greeks.delta)).toFixed(3)} | $${_best.premium} | target delta${targetDelta} strike $${targetStrike} (closest in-window)`);
      // ── MATERIAL-DISTINCTNESS GATE (7/28) ────────────────────────────────────────────────
      // With data-gather live, scanner's same-ticker-same-direction block is BYPASSED by design
      // (state._dataGatherMode overrides DATA_GATHER_MODE=false), so consecutive signals can stack
      // near-identical contracts. 7/28: QQQ 701C and 702C, SAME expiry 9/04, both ~37 DTE, both
      // score 95 — one idea bought twice for double the premium, together -$127. That is not a
      // second data point, it is the same trade. The twin-leg A/B is preserved because its legs
      // use DIFFERENT expiries (sameweek vs standard); only same-expiry near-strikes are rejected.
      const _dupOpen = (state.positions || []).find(p =>
        p.ticker === ticker
        && p.optionType === optionType
        && String(p.expDate || "") === String(_best.expDate || "")
        && Math.abs((parseFloat(p.strike) || 0) - (parseFloat(_best.strike) || 0)) <= MIN_STRIKE_DISTINCT
      );
      if (_dupOpen) {
        logEvent("filter", );
        return null;
      }

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
  // 8/11 ITEM 5: FLAT SIZING. convictionMult scaled the bet by the entry score (1.25x at >=85
  // down to 0.60x below 70). The score correlates -0.07..-0.19 with winning, so weighting size by
  // it adds variance with no expected return — flat strictly dominates. It compounded a second
  // error: puts skew high on this scorer, so the side holding the most points was sized UP by a
  // multiplier carrying no information. Kelly is negative at 37%/1.36x regardless — size to
  // gather signal, not to bet. Flag-gated so the old behaviour is one edit away.
  const convictionMult = FLAT_SIZING_ENABLED
    ? 1.0
    : (score >= 85 ? 1.25 : score >= 75 ? 1.0 : score >= 70 ? 0.80 : 0.60);

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

async function executeTrade(stock, price, score, scoreReasons, vix, optionType = "call", isMeanReversion = false, sizeMod = 1.0, dteBand = null, targetCost = null, signalId = null) {
  const estimatedMinCost = price * 0.03 * 100;
  if (state.cash - estimatedMinCost < CAPITAL_FLOOR) {
    logEvent("skip", `${stock.ticker} - insufficient cash pre-check (est. min cost ${fmt(estimatedMinCost)})`);
    return false;
  }

  // 8/09: MR-SCALP forces the lowest-vega structure — 0-1 DTE + 0.42Δ — to dodge the IV-collapse-on-
  // bounce trap while keeping the gamma that captures the fast snap. Detected via stock._mrScalp
  // (set in the scanner detector). Otherwise the normal MR/momentum profile applies.
  const _mrScalp = stock && stock._mrScalp === true;
  const targetDelta = _mrScalp ? MR_SCALP_DELTA : (isMeanReversion ? 0.42 : 0.35);
  // 6/30 (Harrison): DTE resolution.
  //   dteBand === "sameweek" → force 0-8 DTE leg.  dteBand === "standard" → force the 30-50 momentum band.
  //   dteBand === null (normal call) → DATA_GATHER_MODE forces same-week; otherwise per-profile default.
  // Twin-entry A/B (data-gather on) calls this TWICE with each band so both expiries open on one signal.
  const _dgm = dataGatherActive(DATA_GATHER_MODE);
  // 8/03: THIRD BAND. 13 sits mid-window of an empty 9-16 DTE gap between the two existing
  // legs — 20 sessions produced literally zero trades there, so its behaviour is unknown.
  const targetDTE = _mrScalp ? MR_SCALP_TARGET_DTE
                  : dteBand === "sameweek" ? 3
                  : dteBand === "biweekly" ? 13
                  : dteBand === "standard" ? 40
                  // 8/14: DEFAULT SHORTENED 40 -> 3. Across 247 forward-move windows on 3 sessions,
                // ZERO reached the move a 29- or 43-DTE leg needs to hit the +12.5% rung (0.419%
                // / 0.513%); 25% reached 1DTE's 0.078% and 16% reached 3DTE's 0.115%. The old
                // default was structurally incapable of paying, and because targetDTE=40 drove a
                // 30-50 fetch window, APEX had never even LOOKED at a short contract — 30,782
                // surface rows across two sessions contained nothing under 27 DTE.
                : (_dgm ? 3 : 3);
  const _sameWeekLeg = (dteBand === "sameweek") || (dteBand === null && _dgm);
  // Twin-entry: the prefetch caches ONE contract. Only the same-week leg may use it; the standard leg
  // must select its own (else it would inherit the same-week cache). Validate the cache against the band.
  let contract;
  if (dteBand === "standard") {
    contract = await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
  } else {
    contract = stock._cachedContract || await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
    // 8/17: VALIDATE THE CACHE AGAINST targetDTE, ALWAYS. This guard previously ran only when
    // _sameWeekLeg was true — and _sameWeekLeg is (dteBand === "sameweek") || (dteBand === null &&
    // _dgm). With data-gather off the scanner calls executeTrade with NO dteBand argument, so it is
    // `undefined` (not null), both clauses are false, and the cache was never checked. The prefetch
    // at scanner.js:2835 was seeding a 38-DTE contract and it won every time, silently overriding
    // the targetDTE computed above. The 40->3 default shipped and changed nothing for three days.
    // Now: any cached contract more than TOL days from target is rejected and re-selected,
    // whatever the leg. TOL mirrors the fetch window (+/-2 short, +/-10 long).
    if (contract && stock._cachedContract === contract) {
      const _cDTE = contract.expDays || contract.dte ||
        (contract.expiration_date ? Math.round((new Date(contract.expiration_date) - new Date()) / 86400000) : 0);
      // 8/17 FIX: was `targetDTE <= 10 ? 2 : 10`. The prefetch now caches a 3-DTE contract, and the
      // biweekly leg targets 13 — |3-13| = 10, which is NOT > 10, so it silently accepted the 3-DTE
      // cache. Two of the three A/B/C legs would have been the same contract and the DTE experiment
      // would have collapsed into a duplicate. Proportional tolerance instead: a leg may deviate by
      // 2 days or 25% of its target, whichever is larger. 3->2, 13->3.25, 40->10.
      const _tol  = Math.max(2, targetDTE * 0.25);
      if (Number.isFinite(_cDTE) && Math.abs(_cDTE - targetDTE) > _tol) {
        logEvent("filter", `${stock.ticker} - cached ${_cDTE}DTE contract rejected (target ${targetDTE}DTE, tol ±${_tol}) — re-selecting`);
        contract = await findContract(stock.ticker, optionType, targetDelta, targetDTE, vix, stock);
      }
    }
  }
  delete stock._cachedContract;

  if (!contract) {
    // ── 7/30: THE BLACK-SCHOLES ESTIMATE FALLBACK THAT LIVED HERE IS REMOVED. DO NOT RESTORE. ──
    // It fabricated a contract with symbol:null when findContract came back empty. Because the
    // Alpaca submit block is gated on contract.symbol, no order was ever sent — yet the position
    // was still pushed to state.positions and cash was still debited. Three separate failures
    // traced to it: (a) phantom positions exitEngine cannot price (it skips positions with no
    // contractSymbol), (b) cash drift — 7/30 logged "[CASH SYNC] Drift $2851.66", (c) worst, on
    // 7/30 it armed state._pendingOrder and could never clear it, so scanner:248 blocked EVERY
    // entry for 78+ minutes. The premium it invents is not even close: $28.51 against a real
    // $13.04 contract on the same scan. A trade we cannot price is not a trade — abort.
    logEvent("skip", `${stock.ticker} - no tradeable contract from findContract - entry aborted (synthetic fallback removed)`);
    return false;
  } else {
    if (!state.dataQuality) state.dataQuality = { realTrades: 0, estimatedTrades: 0, totalTrades: 0 };
    state.dataQuality.totalTrades++;
  }

  // 7/30: NO SYMBOL, NO TRADE. The post-submit abort further down reads
  //   if (contract.symbol && !_dryRunMode && alpacaOrderId === null && contract.symbol)
  // i.e. it only fires when a symbol EXISTS — so a symbol-less contract slips past both the submit
  // block and that abort and opens a position with no broker order behind it. That is the phantom
  // shape that caused the 7/29 zombie positions and the 7/30 entry deadlock. Rejecting here makes
  // the whole class structurally impossible regardless of what produced the contract.
  if (!contract.symbol) {
    logEvent("skip", `${stock.ticker} - contract has no tradeable symbol - entry aborted`);
    return false;
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

  // 8/05 fix (orphan-position bug): heat was ONLY checked post-fill (below, ~L540), where a
  // failed check tried to cancel an already-filled order (a no-op) and returned false without
  // recording the position — leaving a live contract in NO state.positions entry (no stop/exit
  // ever touches it) and overstating cash. Gate heat HERE, before any order is submitted, using
  // the pre-fill cost estimate. Mirrors the pre-submit cash check directly above.
  if (!_dryRunMode) {
    const _projHeatPre = (openRisk() + cost) / totalCap();
    if (_projHeatPre > effectiveHeatCap()) {
      logEvent("filter", `${stock.ticker} - projected heat ${(_projHeatPre*100).toFixed(0)}% would exceed ${(effectiveHeatCap()*100).toFixed(0)}% max - skipping before submit`);
      return false;
    }
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
  // 7/30: arm the pending-order flag ONLY when an order will really be sent. This condition is
  // DELIBERATELY BYTE-IDENTICAL to the submit guard below (contract.symbol && contract.ask > 0 &&
  // !_dryRunMode). If the two ever diverge, a contract that passes here but fails there arms the
  // flag with no submission to clear it, and scanner:248 blocks every entry for the session —
  // exactly the 7/30 deadlock. Keep them in lockstep.
  if (contract.symbol && contract.ask > 0 && !_dryRunMode) {
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
          // ── 8/11 ITEM 3: CAPTURE THE MID BEFORE IT IS DESTROYED ───────────────────
          // contract.premium holds the decision-time MID until the line below replaces it with
          // the actual fill. The cost basis, stop and target that follow are all computed from
          // the fill, which is correct — but once overwritten the mid is gone and implementation
          // shortfall can never be reconstructed. NOTE: Alpaca PAPER fills are simulated and do
          // not model real queue position, so this number is a FLOOR on live slippage, not a
          // prediction of it. The outcome column is named accordingly.
          contract._midAtDecision = contract.premium;
          if (SLIPPAGE_LOG_ENABLED && contract._midAtDecision > 0) {
            const _slip = (fillPrice - contract._midAtDecision) / contract._midAtDecision;
            contract._slipPct = parseFloat((_slip * 100).toFixed(3));
            logEvent("trade", `[SLIPPAGE] ${stock.ticker} mid $${contract._midAtDecision.toFixed(2)} → fill $${fillPrice.toFixed(2)} = ${_slip >= 0 ? "+" : ""}${(_slip*100).toFixed(2)}% (paper-simulated)`);
          }
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
    if (alpacaOrderId) {
      // Order already FILLED (alpacaOrderId is non-null only when fillConfirmed). Canceling a
      // filled order is a no-op — we own the contract. Record it so it gets stops/exits and cash
      // is debited; do NOT return false (that orphaned it). Cash may dip below the floor for one
      // position, which the exit engine will resolve — strictly safer than an untracked position.
      logEvent("warn", `${stock.ticker} - filled above estimate, cash tight (need ${fmt(finalCost)}) — recording position anyway; cannot un-buy filled order ${alpacaOrderId}`);
    } else {
      logEvent("skip", `${stock.ticker} - insufficient cash after fill price adjustment`);
      return false;
    }
  }

  if (_dryRunMode) {
    logEvent("dryrun", `WOULD BUY ${stock.ticker} ${optionType.toUpperCase()} $${contract.strike} | ${contracts}x @ $${contract.premium} | cost ${fmt(finalCost)} | score ${score} | delta ${contract.greeks.delta}`);
    return { filled: true, cost: finalCost, contracts, premium: contract.premium };   // 7/7: return cost so twin-entry can size the same-week leg to match (object is truthy → all existing `if (entered)` / `_leg || _leg` checks still work)
  }

  // Post-fill heat is now a safety net only — the primary gate runs pre-submit (above). If it
  // still trips here the order has already FILLED, so record the position rather than orphan it.
  const projectedHeat = (openRisk() + finalCost) / totalCap();
  if (projectedHeat > effectiveHeatCap()) {
    if (alpacaOrderId) {
      logEvent("warn", `${stock.ticker} - projected heat ${(projectedHeat*100).toFixed(0)}% over ${(effectiveHeatCap()*100).toFixed(0)}% cap but order already filled — recording position rather than orphaning it`);
    } else {
      logEvent("filter", `${stock.ticker} - projected heat ${(projectedHeat*100).toFixed(0)}% would exceed ${MAX_HEAT*100}% max - skipping`);
      return false;
    }
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
    entryStrategy:  _mrScalp ? "mr-scalp" : (stock._mrStrong ? "mr" : "breakout-or-context"),   // 8/09: A/B label — mr-scalp vs the rest
    _mrScalp:       _mrScalp,                                              // 8/09: routes the fast scalp exits in exitEngine
    _mrEntryVWAP:   _mrScalp ? (stock._mrEntryVWAP || price || null) : null,   // reversion target = reclaim of entry VWAP
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
    entryADX:        stock._adx ?? stock.adx ?? 0,   // 8/09 FIX: was `stock._adx || 0` but liveStock carries `.adx` (from signals.adx, scanner:1565), no underscore — so entryADX (and the outcome table's eADX) was 0 on every trade. Mirrors the journal stamp at ~L775.
    entryThesisScore: 100,
    thesisHistory:   [],
    agentHistory:    [],
  };

  // ── ADDON MERGE (fix: duplicate-position → fabricated close/reconcile P&L) ──
  // state.positions holds only OPEN positions (closed are spliced in closeEngine),
  // so a match here means we're scaling into a live contract. A 2nd buy must
  // blend into it (weighted-avg premium, summed contracts) — NOT push a duplicate.
  // Duplicates are what the reconciler inflates (contracts→Alpaca qty on every copy)
  // and what orphan-close later force-closes into phantom P&L.
  const _openSame = state.positions.find(p => p.contractSymbol === position.contractSymbol);
  if (_openSame) {
    const _oldQty = _openSame.contracts || 0;
    const _addQty = position.contracts || 0;
    const _newQty = _oldQty + _addQty;
    const _oldPrem = _openSame.premium;
    if (_newQty > 0) {
      _openSame.premium   = parseFloat((((_openSame.premium * _oldQty) + (position.premium * _addQty)) / _newQty).toFixed(4));
      _openSame.contracts = _newQty;
      _openSame.cost      = parseFloat(((_openSame.cost || 0) + (position.cost || 0)).toFixed(2));
      _openSame.partialClosed = false;
      // 8/17: THE COST BASIS JUST MOVED. Every checkpoint is (curP - pos.premium) / pos.premium,
      // so marks recorded before this merge are relative to the OLD premium and marks after are
      // relative to the weighted average. Keeping both in one series produces a P&L attribution
      // curve that mixes two denominators and looks like a price move that never happened.
      // Clear them and flag the position: an addon has no single clean entry, so the honest
      // record is blank checkpoints plus a marker that says why. Same reason _entryX below is
      // already known to carry the SECOND signal's context rather than the original entry's.
      _openSame._cp = {}; _openSame._cpG = {};
      _openSame._addonMerged = true;
      logEvent("scan", `[ADDON MERGE] ${position.contractSymbol}: +${_addQty}@$${position.premium} → ${_newQty}@avg $${_openSame.premium} (was ${_oldQty}@$${_oldPrem})`);
    }
  } else {
    state.positions.push(position);
  }

  const _singleSlipEst = parseFloat((0.08 * (contracts || 1)).toFixed(2));   // 7/7: was contract.contracts (never set → always 1); now uses the real (possibly cost-matched) contract count so paper-slippage isn't undercounted on multi-contract legs
  if (!state._paperSlippage) state._paperSlippage = { trades: 0, totalEst: 0 };
  state._paperSlippage.trades++;
  state._paperSlippage.totalEst = parseFloat((state._paperSlippage.totalEst + _singleSlipEst).toFixed(2));
  state._paperSlippage.avgEst   = parseFloat((state._paperSlippage.totalEst / state._paperSlippage.trades).toFixed(2));
  logEvent("trade", `[SLIPPAGE EST] $${_singleSlipEst} this trade | $${state._paperSlippage.totalEst} cumulative across ${state._paperSlippage.trades} trades (paper mid-fill assumption)`);
  const isEarningsPlay = scoreReasons.some(r => r.includes("Earnings play"));
  // 7/28: stamp breakdown-vs-fade EXPLICITLY at entry. exitEngine previously inferred it from
  // entryDailyRSI < 65, but the breakdown channel does not require low RSI — a put entering on an
  // opening-range break with dRSI 68 would be misread as a FADE put and given the wrong thesis
  // exits. The "Breakdown put -" reason is emitted by scoring ONLY when a breakdown tier fired,
  // so it is true by construction. (All 7/27 puts had dRSI ~61, just under the line — luck.)
  const isBreakdownPut = optionType === "put" && (scoreReasons || []).some(r => r.startsWith("Breakdown put"));
  if (isEarningsPlay) (_openSame || position).earningsPlay = true;  // live position (merged or pushed) — not the discarded local on an addon merge

  // 8/05: entry-feature snapshot for the outcome-joined table (outcomes.js) — the handful of
  // decision inputs NOT already on the position, captured at DECISION time because state drifts
  // by the close. Observation only; stamped on the live position (merged or freshly pushed).
  // ── 8/11 ITEM 3: FEASIBILITY ──────────────────────────────────────────
  // The desk question: does THIS contract need a bigger move than the tape actually delivers
  // in the holding window? ratio > 1 means no. Measured on 8/11 data, every 40-DTE leg sat
  // above 1.0 at every range regime APEX has traded — which is the structural reason that leg
  // drags, derived from first principles rather than from corrupted journal P&L.
  // LOGGED ONLY until FEASIBILITY_ENFORCE.
  // ── 8/11 ITEM 5: DECISION SPLIT (LOG-ONLY) ─────────────────────────────────
  // Emit the three decisions a desk keeps separate — what the view is, which contract expresses
  // it, and how much — as independent records. The score still gates everything exactly as
  // before; this changes nothing at runtime. The point is ATTRIBUTION: when a day goes badly,
  // these three tell you whether alpha picked the wrong side, the instrument could not reach
  // the rung, or sizing was wrong. Today all three failures produce an identical symptom.
  if (DECISION_SPLIT_LOG) {
    try {
      const _alpha = { side: optionType,
                       source: stock._mrScalp ? "mr-scalp"
                             : stock._breakSide ? "break-" + stock._breakSide
                             : "score",
                       score, isMR: !!isMeanReversion,
                       horizonMin: stock._mrScalp ? 15 : null };
      const _instr = { dte: contract.expDays, delta: parseFloat(contract.greeks && contract.greeks.delta) || null,
                       strike: contract.strike, premium: contract.premium,
                       spreadPct: contract.spread != null ? parseFloat(contract.spread.toFixed(4)) : null };
      const _size  = { contracts, cost: parseFloat((contract.premium * 100 * contracts).toFixed(2)),
                       flat: !!FLAT_SIZING_ENABLED };
      logEvent("trade", `[DECISION] ${stock.ticker} alpha=${_alpha.side}/${_alpha.source}(${_alpha.score}) | instrument=${_instr.dte}DTE d${_instr.delta} $${_instr.premium} sprd${_instr.spreadPct != null ? (_instr.spreadPct*100).toFixed(1)+"%" : "?"} | size=${_size.contracts}x $${_size.cost}${_size.flat ? " flat" : ""}`);
    } catch (_dsErr) { /* attribution logging must never affect a trade */ }
  }

  let _feas = null, _rrOut = null;
  if (FEASIBILITY_ENABLED && VOL) {
    try {
      // stock._intraRangePct is range SO FAR, so the observation window is the elapsed session,
      // not 390. Passing it is what makes the ratio honest in the morning.
      const _feasElapsed = (typeof state._sessionMinsNow === "number" && state._sessionMinsNow > 0)
        ? state._sessionMinsNow : 390;
      _feas = VOL.moveFeasibility(
        contract.premium, parseFloat(contract.greeks && contract.greeks.delta) || 0,
        price, stock._intraRangePct, FEASIBILITY_HOLD_MIN, _feasElapsed
      );
      // ── 8/18: RANGE REGIME COMPUTED HERE, NOT IN THE SCAN LOOP ───────────────────────
      // It was computed at scanner.js:~1838 off `stock._cachedContract`, and produced BLANK on all
      // 68 rows of 8/18. Three reasons, any one fatal: the cache is written onto `liveStock` (the
      // ephemeral spread copy built fresh each scan at scanner.js:1853 and pushed at :2848), while
      // the scan loop reads the PERSISTENT watchlist object destructured at :1449 — different
      // objects; the prefetch that writes it is gated on `scored.length > 0` so it may never run;
      // and execution.js:403 DELETES it after use, so it cannot survive to the next scan anyway.
      // Feasibility populated correctly all day because it uses the REAL `contract` in hand here.
      // Same inputs, same site — requiredMovePct is already computed inside moveFeasibility above.
      if (_feas && _feas.requiredPct != null) {
        try {
          _rrOut = VOL.rangeRegime(stock._intraRangePct, _feasElapsed, _feas.requiredPct, FEASIBILITY_HOLD_MIN);
        } catch (_rrErr) { /* observational */ }
      }
      if (_feas && _feas.ratio != null) {
        logEvent("filter", `[FEASIBILITY] ${stock.ticker} ${contract.expDays}DTE needs ${(_feas.requiredPct*100).toFixed(3)}% vs ${(_feas.availablePct*100).toFixed(3)}% available — ratio ${_feas.ratio.toFixed(2)} ${_feas.feasible ? "OK" : "NEEDS OUTSIZED MOVE"}${FEASIBILITY_ENFORCE ? "" : " | SHADOW"}`);
      }
    } catch (_fErr) { /* feasibility is observational — never block a trade on it */ }
  }

  (_openSame || position)._entryX = {
    breadth:    (typeof state._breadth === "number") ? state._breadth : null,
    breadthMom: (typeof state._breadthMomentum === "number") ? state._breadthMomentum : null,
    ivp:        (typeof stock.ivPercentile === "number") ? stock.ivPercentile
                : (typeof state._ivRank === "number" ? state._ivRank : null),
    vwapDist:   (stock.intradayVWAP > 0 && price > 0)
                ? parseFloat((((price - stock.intradayVWAP) / stock.intradayVWAP) * 100).toFixed(3)) : null,
    buActive:   !!(state._buEpisode && state._buEpisode[stock.ticker] && state._buEpisode[stock.ticker].active),
    gapState:   stock._gapState || null,
    underlying: (typeof price === "number") ? parseFloat(price.toFixed(2)) : null,   // entry underlying (pos.price drifts to latest during the hold)
    rangePct:   (typeof stock._intraRangePct === "number") ? stock._intraRangePct : null,
    // ── 8/11: VOL INFRA (X-side). Measurements, not forecasts — every one of these was
    // observable at entry and none of them existed in the table before today.
    rv:         (typeof stock._rv === "number") ? parseFloat(stock._rv.toFixed(4)) : null,
    rvMethod:   stock._rvMethod || null,
    rvSparse:   stock._rvSparse === true ? 1 : (stock._rvSparse === false ? 0 : null),
    vrp:        (typeof stock._vrp === "number") ? parseFloat(stock._vrp.toFixed(4)) : null,
    ivrvRatio:  (typeof stock._ivrvRatio === "number") ? parseFloat(stock._ivrvRatio.toFixed(3)) : null,
    volRegime:  stock._volRegime || null,
    rangeRegime: (_rrOut && _rrOut.regime && _rrOut.regime !== "unknown") ? _rrOut.regime
               : (stock._rangeRegime || null),
    // ── 8/17: SIGNAL CLUSTERING ────────────────────────────────────────────
    // In data-gather the A/B/C fan-out turns ONE decision into THREE rows. Without a shared id
    // they are indistinguishable from three independent trades, and every N computed on the
    // outcome table inflates ~3x — the same error that made 2,320 telemetry rows look like a
    // sample until they collapsed to 112 independent windows. 8/11 read as "22 trades"; it was 7
    // decisions. Cluster on signalId before computing anything.
    signalId:   signalId || null,
    // minutes since the last close in the SAME ticker and direction. Data-gather removes the
    // post-close and post-stop cooldowns, so a re-entry 30s after a stop is path-dependent on the
    // trade before it, not a fresh observation. Blank means no prior close today.
    minSincePrior: (() => {
      try {
        // 8/17 FIX: the field is `optionType`, not `side` (closeEngine.js:501). Reading _rl.side
        // gave `undefined !== "call"` — always true — so this returned null on EVERY row and the
        // column would have been silently empty forever. The reconciler variant (reconciler.js:196)
        // omits the field entirely, so treat a missing optionType as "same ticker, side unknown"
        // and still report the gap rather than discarding it — a reconcile-removed position is
        // exactly the kind of prior close worth knowing about.
        const _rl = (state._recentLosses || {})[stock.ticker];
        if (!_rl || !_rl.closedAt) return null;
        if (_rl.optionType && _rl.optionType !== optionType) return null;
        return parseFloat(((Date.now() - _rl.closedAt) / 60000).toFixed(1));
      } catch (_e) { return null; }
    })(),
    rangeProj:  (_rrOut && _rrOut.projRange != null) ? parseFloat(_rrOut.projRange.toFixed(3))
              : (typeof stock._rangeProj === "number") ? parseFloat(stock._rangeProj.toFixed(3)) : null,
    rangeRatio: (_rrOut && _rrOut.ratio != null) ? parseFloat(_rrOut.ratio.toFixed(3))
              : (typeof stock._rangeRatio === "number") ? parseFloat(stock._rangeRatio.toFixed(3)) : null,
    atmIV:      (contract._surface && contract._surface.atmIV != null) ? parseFloat(contract._surface.atmIV.toFixed(4)) : null,
    skew:       (contract._surface && contract._surface.skew != null) ? parseFloat(contract._surface.skew.toFixed(4)) : null,
    termSlope:  (contract._surface && contract._surface.termSlope != null) ? parseFloat(contract._surface.termSlope.toExponential(3)) : null,
    chainN:     (contract._chainN != null) ? contract._chainN : null,
    medSpread:  (contract._surface && contract._surface.medSpreadPct != null) ? parseFloat(contract._surface.medSpreadPct.toFixed(4)) : null,
    spreadPct:  (typeof contract.spread === "number") ? parseFloat(contract.spread.toFixed(4)) : null,
    // spread as a share of the +12.5% target — the same 5% ceiling is ~43% of the prize on a
    // $1.86 1DTE contract and ~10% on an $8.26 40DTE one. Flat ceilings hide that.
    spreadCostShare: (typeof contract.spread === "number") ? parseFloat(((contract.spread / 0.125) * 100).toFixed(1)) : null,
    midAtDecision: (typeof contract._midAtDecision === "number") ? contract._midAtDecision : null,
    slipPct:    (typeof contract._slipPct === "number") ? contract._slipPct : null,
    reqMovePct: _feas && _feas.requiredPct  != null ? parseFloat((_feas.requiredPct  * 100).toFixed(4)) : null,
    availMovePct: _feas && _feas.availablePct != null ? parseFloat((_feas.availablePct * 100).toFixed(4)) : null,
    feasRatio:  _feas && _feas.ratio != null ? parseFloat(_feas.ratio.toFixed(3)) : null,   // 8/09: intraday range-so-far — the range-governor signal
    volPace:    (stock.hasIntraday && typeof stock.volPaceRatio === "number") ? parseFloat(stock.volPaceRatio.toFixed(3)) : null,   // 8/24: continuous volume pace at entry — the direction signal. null (not the ||1 default) when no intraday tape.
    arm:        stock._arm || null,   // 8/24: volPace split-book arm tag (vf | ctl)
  };

  // 8/24: ENTRY FORWARD-MOVE LEDGER — mirrors the near-miss/momo forward stamp. Records the
  // underlying at entry so a later scan stamps where it went at MOMO_SHADOW_MINS, independent of
  // when THIS position exits. Joined to outcomes on signalId. Observation only; wrapped so it can
  // never disturb the trade path.
  try {
    if (!Array.isArray(state._entryFwd)) state._entryFwd = [];
    // One row per SIGNAL. The A/B/C triple calls executeTrade 3x with a shared signalId; the
    // forward move is a property of ticker+time (identical for all legs) and outcomes join on
    // signalId, so dedupe here rather than write 3 near-identical rows.
    if (!signalId || !state._entryFwd.some(e => e.signalId === signalId)) {
      state._entryFwd.push({
        signalId: signalId || null, ticker: stock.ticker, side: optionType,
        at: Date.now(), px: price, score,
        volPace: (stock.hasIntraday && typeof stock.volPaceRatio === "number") ? parseFloat(stock.volPaceRatio.toFixed(3)) : null,
        fwdPct: null, fwdMins: null,
      });
      while (state._entryFwd.length > 500) state._entryFwd.shift();   // bounded: it now rides the Redis payload
    }
  } catch (_efErr) { /* observation only — never disturb an entry */ }

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
    isBreakdownPut,                 // explicit: drives exitEngine's breakdown-vs-fade thesis exits
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
    dteBand:         dteBand || (_sameWeekLeg ? "sameweek" : "standard"),   // leg tag — was missing from the journal (needed for the leg A/B)
    entryADX:        stock._adx ?? stock.adx ?? 0,                            // intraday trend strength at entry — was missing from the journal
    isMeanReversion: isMeanReversion || false,                               // entry type — was missing from the journal
    entryRelStr:     stock._relStrength || 1.0,                              // relative strength at entry — for the SPY/QQQ divergence
    entryIntradayScore: (() => {                                             // 7/28: logging-only intraday score, for ranking validation vs the legacy score
      const _is = (state._intradayScore || {})[stock.ticker];
      return _is && _is[optionType] ? _is[optionType].score : null;
    })(),
    entryIntradayReasons: (() => {
      const _is = (state._intradayScore || {})[stock.ticker];
      return _is && _is[optionType] ? _is[optionType].reasons.join(" · ") : null;
    })(),
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
