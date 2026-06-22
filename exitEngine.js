// exitEngine.js — APEX V3.0
// Exit decision engine: evaluates all open positions and returns exit decisions.
// checkExits() is a pure function — it returns decisions, never calls closePosition.
// APEX: naked options only (SPY/QQQ). TP removed. Trail floor is sole profitable exit.
'use strict';

const { state, logEvent, markDirty }           = require('./state');
const { alpacaGet, getStockBars, getStockQuote, getCached: _getCached }
                                                = require('./broker');
const { triggerRescore }                       = require('./agent');
const { calcRSI, openRisk, realizedPnL,
        getETTime, isMarketHours }             = require('./signals');
const { getCached, setCache }                  = require('./market');
const { analyzeNews }                          = require('./market');
const { calcThesisIntegrity, isDayTrade }      = require('./risk');
const {
  STOP_LOSS_PCT, FAST_STOP_PCT, FAST_STOP_HOURS,
  MA50_BUFFER, MS_PER_DAY,
  MONTHLY_BUDGET, IV_COLLAPSE_PCT,
  ANTHROPIC_API_KEY,
  EARNINGS_SKIP_DAYS,
  GIVEBACK_EXIT_ENABLED = false, GIVEBACK_PEAK_MIN = 0.01, GIVEBACK_FLOOR = 0, GIVEBACK_MIN_HOLD_MIN = 10,
} = require('./constants');


// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTimeOfDayAnalysis() {
  const trades = state.closedTrades || [];
  if (trades.length < 5) return { best: "insufficient data", hourly: [] };
  const hourly = {};
  for (const trade of trades) {
    if (!trade.openDate) continue;
    const hour = new Date(trade.openDate).getHours();
    if (!hourly[hour]) hourly[hour] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
    hourly[hour].trades++;
    hourly[hour].pnl += trade.pnl || 0;
    if ((trade.pnl || 0) > 0) hourly[hour].wins++;
    else hourly[hour].losses++;
  }
  const sorted = Object.entries(hourly)
    .map(([h, d]) => ({ hour: parseInt(h), ...d, winRate: d.trades ? Math.round(d.wins / d.trades * 100) : 0 }))
    .sort((a, b) => b.pnl - a.pnl);
  return {
    best:   sorted[0] ? `${sorted[0].hour}:00 ET (${sorted[0].winRate}% WR, $${sorted[0].pnl.toFixed(0)} P&L)` : "insufficient data",
    worst:  sorted[sorted.length-1] ? `${sorted[sorted.length-1].hour}:00 ET` : "--",
    hourly: sorted,
  };
}

function getTimeAdjustedStop(pos) {
  const daysOpen = (Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY;
  const chgPct   = pos.currentPrice && pos.premium
    ? (pos.currentPrice - pos.premium) / pos.premium : 0;
  const isFlat   = Math.abs(chgPct) < 0.05;
  let stopPct    = STOP_LOSS_PCT;
  if      (daysOpen >= 8) stopPct = 0.15;
  else if (daysOpen >= 6) stopPct = 0.20;
  else if (daysOpen >= 4) stopPct = 0.25;
  else if (daysOpen >= 2) stopPct = 0.30;
  if (isFlat && daysOpen >= 4) stopPct = Math.min(stopPct, 0.20);
  if (isFlat && daysOpen >= 6) stopPct = Math.min(stopPct, 0.12);
  return stopPct;
}

// getDTEExitParams — returns stop/fast-stop params only.
// takeProfitPct removed. Trail floor is the sole profitable exit mechanism.
function getDTEExitParams(dte, daysOpen = 0) {
  const label = dte <= 21 ? "SHORT-DTE" : dte <= 45 ? "MONTHLY" : "MONTHLY+";
  return {
    stopLossPct:   0.35,
    fastStopPct:   dte <= 21 ? 0.15 : 0.20,
    trailActivate: dte <= 21 ? 0.12 : 0.22,
    trailStop:     dte <= 21 ? 0.07 : 0.12,
    label,
  };
}

function applyExitUrgency(agentResult) {
  if (!agentResult || !agentResult.exitUrgency) return;
  const urgency = agentResult.exitUrgency;
  if (urgency === "hold" || urgency === "monitor") return;
  const positions = state.positions || [];
  if (positions.length === 0) return;
  if (urgency === "trim" || urgency === "exit") {
    logEvent("macro", `[AGENT] exitUrgency=${urgency} — ${urgency === "exit" ? "scheduling exit on all losing positions" : "flagging for trim review"}`);
    positions.forEach(p => { p._exitUrgencyFlag = urgency; p._exitUrgencySetAt = Date.now(); });
  }
}

// ─── Pre-fetch position data (called by scanner before checkExits) ────────────
async function fetchPositionData(positions) {
  const posNewsCache = {};
  if (positions.length > 0) {
    const posNewsFetches = await Promise.all(positions.map(p => require('./market').getNewsForTicker(p.ticker)));
    positions.forEach((p, i) => { posNewsCache[p.ticker] = posNewsFetches[i] || []; });
  }

  const posSymbols = [...new Set(positions.flatMap(p => {
    if (p.isSpread) return [p.buySymbol, p.sellSymbol].filter(Boolean);
    return p.contractSymbol ? [p.contractSymbol] : [];
  }))].join(",");

  const { ALPACA_OPT_SNAP } = require('./constants');
  const [posSnapData, ...posQuotes] = await Promise.all([
    posSymbols ? alpacaGet(`/options/snapshots?symbols=${posSymbols}&feed=indicative`, ALPACA_OPT_SNAP) : Promise.resolve({}),
    ...positions.map(p => getStockQuote(p.ticker)),
  ]);
  const posSnapshots = posSnapData?.snapshots || {};
  return { posSnapshots, posQuotes, posNewsCache };
}

// ─── Bar cache for RSI checks (per scan cycle) ───────────────────────────────
const _posBarCache = new Map();

// ─── Main exit decision function ─────────────────────────────────────────────
// Returns: ExitDecision[] = [{pi, ticker, action, reason, exitPremium, contractSym}]
// Never mutates state. Never calls closePosition. Pure decision function.
async function checkExits(positions, posSnapshots, posQuotes, posNewsCache, ctx) {
  const {
    dryRunMode = false,
    scanET,
    alpacaBalance = state.alpacaCash || state.cash || 0,
    pdtCount = 0,
    marketContext = {},
  } = ctx;

  const decisions = [];
  const _closedThisCycle = new Set();

  for (let pi = 0; pi < positions.length; pi++) {
    const pos   = positions[pi];
    const price = posQuotes[pi];
    if (!price) continue;
    if (pos._dryRunWouldClose) continue;
    if (pos._permissionBlocked) {
      const _blockedMins = pos._permissionBlockedAt
        ? (Date.now() - new Date(pos._permissionBlockedAt).getTime()) / 60000
        : 999;
      if (_blockedMins < 15) {
        logEvent("warn", `${pos.ticker} exit skipped — permission blocked (40310000), retrying in ${(15 - _blockedMins).toFixed(0)}min`);
        continue;
      }
      logEvent("warn", `${pos.ticker} permission block cooldown expired (${_blockedMins.toFixed(0)}min) — clearing flag`);
      delete pos._permissionBlocked;
      delete pos._permissionBlockedAt;
      delete pos._permBlockReason;
    }
    try {

    const dte       = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
    const hoursOpen = (new Date() - new Date(pos.openDate)) / 3600000;
    const daysOpen  = hoursOpen / 24;

    // ── Price resolution (naked options only) ────────────────────────────────
    let curP;
    if (pos.contractSymbol && posSnapshots[pos.contractSymbol]) {
      const snap   = posSnapshots[pos.contractSymbol];
      const quote  = snap?.latestQuote || {};
      const greeks = snap?.greeks || {};
      const bid    = parseFloat(quote.bp || 0);
      const ask    = parseFloat(quote.ap || 0);
      const realPrice = bid > 0 && ask > 0 ? parseFloat(((bid + ask) / 2).toFixed(2)) : null;
      if (bid > 0) pos.bid = bid;
      if (ask > 0) pos.ask = ask;
      const _staleSecs = pos._currentPriceUpdatedAt ? (Date.now() - pos._currentPriceUpdatedAt) / 1000 : 9999;
      const _freshCurrentPrice = _staleSecs < 30 ? pos.currentPrice : null;
      // FIX (6/17): when there's no live quote AND the cache is stale, carry forward the
      // LAST KNOWN real price instead of pos.premium. Falling back to premium forces
      // chg=0 → the position reads FLAT → every chg-based stop tier is silently skipped,
      // so a position down 45% on a dropped quote rides untouched to the 3:15 flatten.
      // _lastRealPrice preserves the true drawdown so the existing stops still fire.
      // Only changes behavior when blinded, and only toward seeing the real loss (safe
      // direction for long premium). _priceSource/_blindScans = provenance for Part B.
      const _liveOrFresh = realPrice || _freshCurrentPrice;
      curP = _liveOrFresh || pos._lastRealPrice || pos.premium;
      if (realPrice) {
        pos.realData = true; pos._currentPriceUpdatedAt = Date.now();
        pos._lastRealPrice = realPrice; pos._lastRealAt = Date.now();
        pos._priceSource = 'real'; pos._blindScans = 0;
      } else if (_freshCurrentPrice) {
        pos._lastRealPrice = _freshCurrentPrice; pos._lastRealAt = Date.now();
        pos._priceSource = 'cache'; pos._blindScans = 0;
      } else if (pos._lastRealPrice) {
        pos._priceSource = 'lastKnown';
        pos._blindScans = (pos._blindScans || 0) + 1;
        logEvent("warn", `${pos.ticker} no live price — carrying last-known $${pos._lastRealPrice} (blind ${pos._blindScans} scan(s), age ${((Date.now() - (pos._lastRealAt || Date.now())) / 1000).toFixed(0)}s)`);
      } else {
        pos._priceSource = 'premium';
        pos._blindScans = (pos._blindScans || 0) + 1;
        logEvent("warn", `${pos.ticker} no live price and no last-known — using entry premium floor (blind ${pos._blindScans})`);
      }
      if (greeks.delta) {
        pos.greeks = {
          delta: parseFloat(greeks.delta || 0).toFixed(3),
          theta: parseFloat(greeks.theta || 0).toFixed(3),
          gamma: parseFloat(greeks.gamma || 0).toFixed(4),
          vega:  parseFloat(greeks.vega  || 0).toFixed(3),
        };
        if (snap.impliedVolatility) pos.iv = parseFloat(snap.impliedVolatility);
      }
    } else {
      const _staleSecs = pos._currentPriceUpdatedAt ? (Date.now() - pos._currentPriceUpdatedAt) / 1000 : 0;
      const _valid     = pos.currentPrice > 0 && pos.currentPrice !== pos.premium;
      curP = (_staleSecs < 300 && _valid ? pos.currentPrice : null)
          || (pos.currentPrice > 0 ? pos.currentPrice : null)
          || pos.premium;
    }

    const chg = (curP > 0 && pos.premium > 0 && !isNaN(curP))
      ? (curP - pos.premium) / pos.premium : 0;

    if (curP > (pos.peakPremium || 0)) {
      pos.peakPremium = curP;
      pos._peakTime   = Date.now();
    }
    if (!pos._peakTime) pos._peakTime = new Date(pos.openDate || Date.now()).getTime();

    // ── Confirmed peak (bolt-on 2: anti-whipsaw) ──────────────────────────────
    // The trail floor ratchets off _confirmedPeak, NOT the raw peakPremium above.
    // A new high must be corroborated by a SECOND consecutive scan (price still at/
    // above the staged high, within 2%) before it can raise the floor. This filters
    // single-print premium spikes / bid-ask wicks that would otherwise arm a floor we
    // immediately whipsaw through. In a genuine rally each new high confirms one scan
    // later, so the floor lags real moves by ~1 cycle but is never set by a lone wick.
    // _confirmedPeak is monotonic non-decreasing → the floor only ever ratchets up.
    if (pos._confirmedPeak == null) pos._confirmedPeak = pos.premium;
    if (curP > pos._confirmedPeak) {
      if (pos._peakStaged && curP >= (pos._peakStagedValue || 0) * 0.98) {
        // Second scan: the new high held → confirm it (to the higher of staged/current).
        pos._confirmedPeak   = Math.max(pos._peakStagedValue || curP, curP);
        pos._peakStaged      = false;
        pos._peakStagedValue = null;
      } else {
        // First scan seeing this new high (or price slipped vs the stage) — stage, don't act.
        pos._peakStaged      = true;
        pos._peakStagedValue = curP;
      }
    } else if (pos._peakStaged) {
      // Price fell back below the confirmed peak before confirming → discard the spike.
      pos._peakStaged      = false;
      pos._peakStagedValue = null;
    }

    const curCash = state.cash + openRisk() + realizedPnL();
    if (curCash > (state.peakCash || MONTHLY_BUDGET)) state.peakCash = curCash;

    // ── Trigger 1: Rapid loss ─────────────────────────────────────────────────
    if (ANTHROPIC_API_KEY && isMarketHours()) {
      const prevChg  = pos._prevScanChg || chg;
      const scanDrop = chg - prevChg;
      if (scanDrop <= -0.05 && chg < 0) triggerRescore(pos, `rapid-loss: ${(scanDrop*100).toFixed(1)}% this scan`);
      pos._prevScanChg = chg;

      // ── Trigger 2: RSI reversal ───────────────────────────────────────────
      const lastRSICheck = pos._lastRSITriggerCheck || 0;
      if (Date.now() - lastRSICheck > 5 * 60 * 1000) {
        pos._lastRSITriggerCheck = Date.now();
        try {
          const rsiB = _posBarCache.get(pos.ticker) || await getStockBars(pos.ticker, 20);
          if (!_posBarCache.has(pos.ticker) && rsiB.length) _posBarCache.set(pos.ticker, rsiB);
          if (rsiB.length >= 14) {
            const liveRSI  = calcRSI(rsiB);
            const entryRSI = pos.optionType === "put"
              ? (pos.entryDailyRSI || pos.entryRSI || 70)
              : (pos.entryRSI || 70);
            const prevRSI  = pos._prevRSI || liveRSI;
            pos._prevRSI   = liveRSI;
            const putThesisDegrading  = pos.optionType === "put"  && entryRSI >= 65 && liveRSI > 60 && prevRSI <= 55;
            const callRSIDegrading    = pos.optionType === "call" && entryRSI <= 40 && liveRSI > 55 && prevRSI <= 50;
            const _liveMACD           = pos._lastMACD || pos.entryMACD || "";
            const callMACDDegrading   = pos.optionType === "call" && _liveMACD.includes("bearish crossover") && !(pos.entryMACD||"").includes("bearish");
            if (putThesisDegrading || callRSIDegrading || callMACDDegrading) {
              const reason = callMACDDegrading ? "macd-crossover-bearish" : `rsi-reversal: entry ${entryRSI} → now ${liveRSI.toFixed(0)}`;
              triggerRescore(pos, reason);
            }
          }
        } catch(e) {}
      }
    }

    // ── Delta compression stop ────────────────────────────────────────────────
    if (pos.contractSymbol) {
      const liveSnap = posSnapshots[pos.contractSymbol];
      if (liveSnap?.greeks) {
        const liveDelta = Math.abs(parseFloat(liveSnap.greeks.delta || 0));
        if (liveDelta > 0 && liveDelta < 0.12 && chg <= -0.15) {
          logEvent("scan", `${pos.ticker} delta compression stop — delta ${liveDelta.toFixed(3)} < 0.12, down ${(chg*100).toFixed(0)}%`);
          if (!_closedThisCycle.has(pi)) {
            _closedThisCycle.add(pi);
            decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "delta-compression", exitPremium: null, contractSym: pos.contractSymbol }); continue;
          }
        }
      }
    }

    // ── 50% premium floor stop ────────────────────────────────────────────────
    if (pos.premium > 0 && curP > 0) {
      const premiumFloor = pos.premium * 0.50;
      if (curP <= premiumFloor) {
        logEvent("scan", `${pos.ticker} 50% premium floor stop — entry $${pos.premium} floor $${premiumFloor.toFixed(2)} cur $${curP}`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "premium-floor", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── Thesis integrity check ────────────────────────────────────────────────
    const _thesisCheckHours = hoursOpen < 24 ? 1 : 48;
    if (hoursOpen >= _thesisCheckHours && pos.optionType) {
      const curRSI      = pos._prevRSI      || pos.entryRSI      || 52;
      const curMACD     = pos._lastMACD     || pos.entryMACD     || "neutral";
      const curMomentum = pos._lastMomentum || pos.entryMomentum || "steady";
      const curMacro    = (state._agentMacro || {}).signal || "neutral";
      const integrity   = calcThesisIntegrity(pos, curRSI, curMACD, curMomentum, curMacro);

      pos.entryThesisScore = integrity.score;
      if (!pos.thesisHistory) pos.thesisHistory = [];
      if (!pos.thesisHistory.length || pos.thesisHistory[pos.thesisHistory.length-1]?.score !== integrity.score) {
        pos.thesisHistory.push({ time: new Date().toISOString(), score: integrity.score, notes: integrity.reasons.join("; ") });
        if (pos.thesisHistory.length > 10) pos.thesisHistory = pos.thesisHistory.slice(-10);
      }

      if (integrity.score < 20) {
        logEvent("warn", `[THESIS] ${pos.ticker} integrity collapsed ${integrity.score}/100 — closing`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "thesis-collapsed", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      } else if (integrity.score < 40) {
        logEvent("warn", `[THESIS] ${pos.ticker} integrity degraded ${integrity.score}/100`);
        if ((pos.fastStopPct || FAST_STOP_PCT) > 0.25) {
          pos.fastStopPct = 0.25;
          logEvent("warn", `[THESIS] ${pos.ticker} stop tightened to 25%`);
        }
      }

      const adjStop = getTimeAdjustedStop(pos);
      if (adjStop < STOP_LOSS_PCT && chg < -adjStop) {
        logEvent("warn", `[THESIS] ${pos.ticker} time-adjusted stop ${(adjStop*100).toFixed(0)}% hit after ${daysOpen.toFixed(1)} days`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "time-stop", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── DTE expiry urgency ────────────────────────────────────────────────────
    const dteDaysLeft = pos.expDate ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY)) : 30;
    if (dteDaysLeft <= 5 && dteDaysLeft > 0 && chg < -0.15) {
      logEvent("warn", `${pos.ticker} DTE urgency: ${dteDaysLeft}d remaining, ${(chg*100).toFixed(0)}% — closing`);
      if (!_closedThisCycle.has(pi)) {
        _closedThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "dte-urgency", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
      }
    }

    // ── Give-back exit (D3): worked, then round-tripped the whole move
    // Flag-gated. If premium peaked >= GIVEBACK_PEAK_MIN above entry and has given it
    // all back to <= GIVEBACK_FLOOR (curP basis, same as the peak), exit — independent
    // of the tiered stop. Min-hold filters early-noise round-trips. Catches the
    // "green then red" bleed the tiered stop only stops at -25%.
    if (GIVEBACK_EXIT_ENABLED) {
      const _gbHeldMin = (Date.now() - new Date(pos.openDate || pos.entryTime || Date.now()).getTime()) / 60000;
      const _gbPeakChg = ((pos.peakPremium || pos.premium) - pos.premium) / pos.premium;
      if (_gbHeldMin >= GIVEBACK_MIN_HOLD_MIN && _gbPeakChg >= GIVEBACK_PEAK_MIN && chg <= GIVEBACK_FLOOR) {
        logEvent("scan", `${pos.ticker} give-back exit — peaked +${(_gbPeakChg*100).toFixed(0)}% now ${(chg*100).toFixed(0)}% after ${_gbHeldMin.toFixed(0)}min`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "give-back", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── Intraday tiered stop (day-trade loss schedule) ────────────────────────
    // Primary intraday loss control. Active from ENTRY (after a 2-min stale-
    // snapshot guard), measured from entry, evaluated on the BID (realizable
    // sell-side price). Tightens as the session runs; the hard -35% stop and the
    // -50% premium floor below remain always-on backstops. This replaces the old
    // hoursOpen>=2 fast-stop arming gap that left a day trade protected only by
    // the -35% hard stop for its first ~2 hours.
    {
      const _entryMsTS      = new Date(pos.openDate || pos.entryTime || Date.now()).getTime();
      const _minsSinceEntry = (Date.now() - _entryMsTS) / 60000;
      const _etDecimalTS    = scanET.getHours() + scanET.getMinutes() / 60;
      const _bidChg = (pos.bid > 0 && pos.premium > 0)
        ? (pos.bid - pos.premium) / pos.premium : chg;       // realizable (sell-side), fall back to mid
      let _tierStop;                                          // tightest applicable rung wins
      if      (_etDecimalTS >= 14.75) _tierStop = 0.12;       // after 2:45pm ET — tighten into the 3:15 flatten
      else if (_minsSinceEntry >= 90) _tierStop = 0.18;
      else if (_minsSinceEntry >= 60) _tierStop = 0.22;
      else if (_minsSinceEntry >= 30) _tierStop = 0.25;
      else                            _tierStop = 0.30;       // 0–30 min: room for the dip-buy to breathe
      if (_minsSinceEntry >= 2 && _bidChg <= -_tierStop) {
        const _tierLabel = _etDecimalTS >= 14.75 ? "after-2:45pm" : `${_minsSinceEntry.toFixed(0)}min`;
        logEvent("scan", `${pos.ticker} tiered-stop ${(_bidChg*100).toFixed(0)}% (bid) — tier ${_tierLabel} threshold -${(_tierStop*100).toFixed(0)}%`);
        pos._tierStopContext = {                              // instrumentation for rung calibration
          minsSinceEntry: Math.round(_minsSinceEntry),
          etDecimal: parseFloat(_etDecimalTS.toFixed(2)),
          tierStop: _tierStop,
          bidChg: parseFloat(_bidChg.toFixed(3)),
          peakChg: parseFloat((((pos.peakPremium || pos.premium) - pos.premium) / pos.premium).toFixed(3)),
        };
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "tiered-stop", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── Fast stop (weekly / legacy only — day trades use the tiered stop above) ─
    const isWeeklyPos    = pos.expiryType === "weekly" || (pos.expDays || 30) <= 21;
    const fastStopWindow = isWeeklyPos ? FAST_STOP_HOURS : 120;
    const _agentBearish  = (state._agentMacro?.signal || "").includes("bearish");
    const _macroFastStop = (!pos.isSpread && pos.optionType === "call" && _agentBearish && chg <= -0.10)
      ? 0.12 : (pos.fastStopPct || FAST_STOP_PCT);
    const activeFastStop   = isWeeklyPos ? _macroFastStop : Math.min(0.15, _macroFastStop);
    const fastStopEligible = isWeeklyPos && hoursOpen >= 2 && hoursOpen <= fastStopWindow;
    if (fastStopEligible && chg <= -activeFastStop) {
      logEvent("scan", `${pos.ticker} fast-stop ${(chg*100).toFixed(0)}% in ${hoursOpen.toFixed(1)}hrs (threshold ${(activeFastStop*100).toFixed(0)}%)`);
      if (!_closedThisCycle.has(pi)) {
        _closedThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "fast-stop", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
      }
    }

    // ── IV collapse exit ──────────────────────────────────────────────────────
    if (pos.entryIV && pos.iv && pos.iv > 0) {
      const ivDrop = (pos.entryIV - pos.iv) / pos.entryIV;
      if (!(pos.optionType === "put" && chg > 0) && ivDrop >= IV_COLLAPSE_PCT && chg > -0.20) {
        logEvent("warn", `${pos.ticker} IV collapse: entry ${(pos.entryIV*100).toFixed(0)}% → current ${(pos.iv*100).toFixed(0)}% (${(ivDrop*100).toFixed(0)}% drop)`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "iv-collapse", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── Hard stop ─────────────────────────────────────────────────────────────
    const _isOvernightCarry = hoursOpen >= 16 && pos.premium > 0;
    const _activeHardStop   = _isOvernightCarry && chg <= -0.10 ? 0.28 : STOP_LOSS_PCT;
    if (chg <= -_activeHardStop) {
      const _minsOpen = hoursOpen * 60;
      if (_minsOpen < 2 && chg <= -0.50) {
        logEvent("warn", `${pos.ticker} stop skipped — only ${_minsOpen.toFixed(1)}min old, ${(chg*100).toFixed(0)}% likely stale snapshot`);
      } else {
        const _stopLabel = _activeHardStop < STOP_LOSS_PCT
          ? `overnight-tightened-stop (${(_activeHardStop*100).toFixed(0)}%)` : `stop-loss`;
        logEvent("scan", `${pos.ticker} ${_stopLabel} ${(chg*100).toFixed(0)}%`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "stop", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── Progress check ────────────────────────────────────────────────────────
    if (!pos._progressCheckFired) {
      const _entryTime   = new Date(pos.openDate || pos.entryTime || Date.now()).getTime();
      const _minsOpen    = (Date.now() - _entryTime) / 60000;
      const peakChgForPC = pos.premium > 0 ? (pos.peakPremium - pos.premium) / pos.premium : 0;
      const _entryRSI    = pos.entryRSI || 50;
      let _checkMins     = 90;
      if (_entryRSI < 20) _checkMins = 120;
      else if ((pos.macroSignal || '').includes('bearish') || pos._isGapDayEntry) _checkMins = 60;

      if (_minsOpen >= _checkMins && peakChgForPC < 0.05) {
        pos._progressCheckFired = true;
        logEvent("scan", `[PROGRESS-CHECK] ${pos.ticker} — held ${_minsOpen.toFixed(0)}min, peak only +${(peakChgForPC*100).toFixed(1)}% — thesis not gaining traction, exiting`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'progress-check', exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── Trail floor — sole profitable exit (Schedule A) ───────────────────────
    // One-way profit-protection ratchet. NO fixed take-profit: the floor lifts as
    // the (confirmed) peak grows, banking more of the gain while the rest runs.
    // Persisted on pos.trailFloorPct; it only moves up, never down.
    //
    // Floor is measured off ENTRY premium and selected from the CONFIRMED peak.
    // Schedule A — floor sits 5pts behind peak at the bottom two rungs, then 2.5pts
    // behind from +12.5% upward:
    //   confirmed peak ≥ +5%    → floor   0%   (breakeven — don't give back once up 5%)
    //   confirmed peak ≥ +10%   → floor  +5%
    //   confirmed peak ≥ +12.5% → floor +10%
    //   confirmed peak ≥ +15%   → floor +12.5%
    //   confirmed peak ≥ +17.5% → floor +15%
    //   confirmed peak ≥ +20%   → floor +17.5%
    //   confirmed peak ≥ +22.5% → floor +20%   … +2.5pt per +2.5pt peak, no ceiling
    //   (e.g. peak +40% → floor +37.5%)
    // Above +12.5% the rung is floor% = floor(peakChg/0.025) * 0.025 − 0.025, i.e.
    // peak rounded down to the 2.5pt grid, minus 2.5pts. The +1e-9 nudge defeats a
    // float-floor error where e.g. 0.15/0.025 == 5.9999999999 → would mis-round down.
    const peakChg       = pos.premium > 0 ? ((pos._confirmedPeak || pos.premium) - pos.premium) / pos.premium : 0;
    const _entryPremium = pos.premium || curP;

    // 1. Candidate floor% from the confirmed peak (Schedule A)
    let _candidateFloorPct = null;
    if      (peakChg >= 0.125) _candidateFloorPct = Math.floor(peakChg / 0.025 + 1e-9) * 0.025 - 0.025;
    else if (peakChg >= 0.10)  _candidateFloorPct = 0.05;   // +10–12.5% band → lock +5%
    else if (peakChg >= 0.05)  _candidateFloorPct = 0.00;   // +5–10%  band → breakeven
    // peakChg < 5%: no profit floor yet — hard stop governs

    // 2. Ratchet up only — never lower an existing floor
    if (_candidateFloorPct != null &&
        (pos.trailFloorPct == null || _candidateFloorPct > pos.trailFloorPct)) {
      pos.trailFloorPct = parseFloat(_candidateFloorPct.toFixed(4));
      const _lbl = _candidateFloorPct === 0 ? "breakeven" : `+${(_candidateFloorPct*100).toFixed(1)}%`;
      if (!pos[`_floorLogged_${_lbl}`]) {
        pos[`_floorLogged_${_lbl}`] = true;
        logEvent("scan", `[TRAIL-FLOOR] ${pos.ticker} confirmed peak +${(peakChg*100).toFixed(1)}% — floor raised to ${_lbl} of entry`);
      }
    }

    // 3. Enforce the active floor against the BID (bolt-on 1: realizable sell price,
    //    not mid). A "+5% floor" should be +5% you can actually fill — selling at the
    //    bid after crossing the spread. Falls back to mid when no live bid is present.
    if (pos.trailFloorPct != null) {
      const _floorPrice = _entryPremium * (1 + pos.trailFloorPct);
      const _exitMark   = (pos.bid > 0) ? pos.bid : curP;
      const _markLabel  = (pos.bid > 0) ? "bid" : "mark";
      if (_exitMark <= _floorPrice && !_closedThisCycle.has(pi)) {
        const _floorTxt = pos.trailFloorPct === 0 ? "breakeven" : `+${(pos.trailFloorPct*100).toFixed(1)}%`;
        logEvent("scan",
          `[TRAIL-EXIT] ${pos.ticker} ${_markLabel} $${_exitMark.toFixed(2)} <= floor $${_floorPrice.toFixed(2)} ` +
          `(${_floorTxt} of entry, confirmed peak +${(peakChg*100).toFixed(1)}%) — banking gain`
        );
        _closedThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'trail-floor', exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
      }
    }

    // ── Thesis complete — RSI normalization ───────────────────────────────────
    const _entryRSITC   = pos.entryRSI || 50;
    const _curRSI       = pos._prevRSI || _entryRSITC;
    const _callFulfilled = pos.optionType === "call" && _entryRSITC <= 45 && _curRSI > 55;
    const _entryDRSI    = pos.entryDailyRSI || pos.entryRSI || 50;
    const _curDRSI      = pos.dailyRsi || _curRSI;
    const _putFulfilled  = pos.optionType === "put"  && _entryDRSI >= 65 && _curDRSI < 50;

    if ((_callFulfilled || _putFulfilled) && !pos._thesisFulfilled) {
      pos._thesisFulfilled   = true;
      pos._thesisFulfilledAt = Date.now();
      logEvent("scan", `[THESIS FULFILLED] ${pos.ticker} RSI ${_entryRSITC}→${_curRSI.toFixed(0)} | gain: ${chg >= 0 ? '+' : ''}${(chg*100).toFixed(1)}%`);
    }

    if (pos._thesisFulfilled && !pos._thesisAutoClose && hoursOpen >= 0.5) {
      if (chg >= 0.03) {
        pos._thesisAutoClose = true;
        logEvent("scan", `[THESIS COMPLETE] ${pos.ticker} RSI normalized | gain: +${(chg*100).toFixed(1)}% — closing`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'thesis-complete', exitPremium: null, contractSym: pos.contractSymbol || null });
        }
        if (!state._dailyThesisComplete) state._dailyThesisComplete = {};
        state._dailyThesisComplete[pos.ticker] = {
          entryRSI:   pos.optionType === "put" ? _entryDRSI : _entryRSITC,
          closedAt:   new Date().toISOString(),
          optionType: pos.optionType,
        };
        markDirty();
        continue;
      } else if (chg > -0.05) {
        const _hrsAfter = (Date.now() - (pos._thesisFulfilledAt || Date.now())) / 3600000;
        if (_hrsAfter >= 4) {
          pos._thesisAutoClose = true;
          logEvent("scan", `[THESIS COMPLETE] ${pos.ticker} RSI normalized ${_hrsAfter.toFixed(1)}h ago, flat — closing`);
          if (!_closedThisCycle.has(pi)) {
            _closedThisCycle.add(pi);
            decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: 'thesis-no-follow', exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
          }
        }
      }
    }

    // ── Hourly thesis degradation ─────────────────────────────────────────────
    if (hoursOpen >= 1 && Math.floor(hoursOpen) > (pos._lastThesisCheck || 0)) {
      pos._lastThesisCheck = Math.floor(hoursOpen);
      try {
        const tBars = _posBarCache.get(pos.ticker) || await getStockBars(pos.ticker, 20);
        if (!_posBarCache.has(pos.ticker) && tBars.length) _posBarCache.set(pos.ticker, tBars);
        if (tBars.length >= 15) {
          const curRSI  = calcRSI(tBars);
          const entryRSI = pos.entryRSI || (pos.optionType === "put" ? 75 : 30);
          if (pos.optionType === "put" && entryRSI >= 65 && curRSI < 50 && !pos.partialClosed && chg < 0.10) {
            logEvent("scan", `${pos.ticker} PUT thesis degradation — RSI ${entryRSI}→${curRSI.toFixed(0)}`);
            if (pos.trailFloorPct == null || pos.trailFloorPct < 0) {
              pos.trailFloorPct = 0; // lock to breakeven on degradation
              logEvent("scan", `${pos.ticker} trail floor set to breakeven on PUT degradation`);
            }
          }
          if (pos.optionType === "call" && entryRSI <= 40 && curRSI > 55 && chg < -0.10) {
            const curMacro = (state._agentMacro || {}).signal || "neutral";
            if (!curMacro.includes("bullish") && curMacro !== "neutral") {
              logEvent("scan", `${pos.ticker} CALL degradation — RSI recovered but down ${(chg*100).toFixed(0)}% bearish macro`);
              if (pos.trailFloorPct == null || pos.trailFloorPct < 0) pos.trailFloorPct = 0;
            }
          }
        }
      } catch(e) {}
    }

    // ── Time stop ─────────────────────────────────────────────────────────────
    if (daysOpen >= 7 && Math.abs(chg) < 0.05) {
      logEvent("scan", `${pos.ticker} time-stop — ${daysOpen.toFixed(0)}d, only ${(chg*100).toFixed(1)}% move`);
      if (!_closedThisCycle.has(pi)) {
        _closedThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "time-stop", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
      }
    }

    // ── Expiry roll ───────────────────────────────────────────────────────────
    if (dte <= 7 && chg > 0) {
      logEvent("scan", `${pos.ticker} expiry-roll — ${dte}DTE with profit`);
      if (!_closedThisCycle.has(pi)) {
        _closedThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "expiry-roll", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
      }
    }

    // ── 50MA break ────────────────────────────────────────────────────────────
    if (hoursOpen >= 2 && !(pos.dteLabel && pos.dteLabel.includes("RECONCIL"))) {
      try {
        const _maCacheKey = `ma55:${pos.ticker}`;
        const maBars = getCached(_maCacheKey, 10 * 60 * 1000)
          || setCache(_maCacheKey, await getStockBars(pos.ticker, 55));
        if (maBars.length >= 50) {
          const ma50 = maBars.slice(-50).reduce((s, b) => s + b.c, 0) / 50;
          const ma50Break = pos.optionType === "put"
            ? price > ma50 * (1 + MA50_BUFFER)
            : price < ma50 * (1 - MA50_BUFFER);
          if (ma50Break) {
            logEvent("scan", `${pos.ticker} 50ma-break | price $${price.toFixed(2)} | 50MA $${ma50.toFixed(2)} | held ${hoursOpen.toFixed(1)}h`);
            if (!_closedThisCycle.has(pi)) {
              _closedThisCycle.add(pi);
              decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "50ma-break", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
            }
          }
        }
      } catch(e) {}
    }

    // ── Earnings close ────────────────────────────────────────────────────────
    if (pos.earningsDate) {
      const daysToE = Math.round((new Date(pos.earningsDate) - new Date()) / MS_PER_DAY);
      if (daysToE >= 0 && daysToE <= EARNINGS_SKIP_DAYS) {
        logEvent("scan", `${pos.ticker} earnings in ${daysToE}d — closing`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "earnings-close", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── News exit ─────────────────────────────────────────────────────────────
    const newsArts = posNewsCache[pos.ticker] || [];
    const newsSent = analyzeNews(newsArts);
    if (pos.optionType === "put"  && newsSent.signal === "strongly bullish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit — strongly bullish news vs losing put`);
      if (!_closedThisCycle.has(pi)) {
        _closedThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "news-exit", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
      }
    }
    if (pos.optionType === "call" && newsSent.signal === "strongly bearish" && chg <= -0.15) {
      logEvent("scan", `${pos.ticker} news-exit — strongly bearish news vs losing call`);
      if (!_closedThisCycle.has(pi)) {
        _closedThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "news-exit", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
      }
    }

    // ── Overnight risk ────────────────────────────────────────────────────────
    const etHourNow = scanET.getHours() + scanET.getMinutes() / 60;
    if (etHourNow >= 15.0 && state.vix >= 25 && chg <= -0.20) {
      logEvent("scan", `${pos.ticker} overnight-risk TIER1 — severely losing ${(chg*100).toFixed(0)}% at 3pm | VIX ${state.vix}`);
      if (!_closedThisCycle.has(pi)) {
        _closedThisCycle.add(pi);
        decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
      }
    }
    if (etHourNow >= 15.5 && state.vix >= 30) {
      if (chg <= -0.08) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 — losing ${(chg*100).toFixed(0)}% into close VIX ${state.vix}`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
      if (dte <= 3) {
        logEvent("scan", `${pos.ticker} overnight-risk TIER2 — ${dte}DTE too short for overnight hold`);
        if (!_closedThisCycle.has(pi)) {
          _closedThisCycle.add(pi);
          decisions.push({ pi, ticker: pos.ticker, action: 'close', reason: "overnight-risk", exitPremium: null, contractSym: pos.contractSymbol || null }); continue;
        }
      }
    }

    // ── HOLD — update and log ─────────────────────────────────────────────────
    pos.price        = price;
    pos.currentPrice = curP;
    const _floorStr  = pos.trailFloorPct != null ? `+${(pos.trailFloorPct*100).toFixed(1)}%` : 'none';
    logEvent("scan", `${pos.ticker} | chg:${(chg*100).toFixed(1)}% | cur:$${curP} | peak:$${(pos.peakPremium||curP).toFixed(2)} | DTE:${dte} | floor:${_floorStr} | HOLD`);
    markDirty();

    } catch(posErr) {
      logEvent("error", `Position scan error for ${pos?.ticker || "unknown"}: ${posErr.message}`);
    }
  }

  return decisions;
}

module.exports = {
  checkExits,
  fetchPositionData,
  getTimeAdjustedStop,
  getDTEExitParams,
  applyExitUrgency,
  getTimeOfDayAnalysis,
};
