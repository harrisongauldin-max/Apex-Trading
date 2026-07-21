// reconciler.js — ARGO V3.2
// Position reconciliation: keeps ARGO state aligned with Alpaca ground truth.
// Runs on startup and every 3 minutes during market hours.
'use strict';

const { alpacaGet } = require('./broker');
const { updateJournalExit, writeJournalEntry, loadJournalDay, closeOrphanJournalOpens } = require('./state');
const { WATCHLIST,
  ALPACA_KEY, INDIVIDUAL_STOCKS_ENABLED, MS_PER_DAY, STOP_LOSS_PCT, TAKE_PROFIT_PCT
} = require('./constants');
const { findContract } = require('./execution');

// ─── Injected dependencies (set by server.js at boot) ────────────
let _state        = null;
let _log          = (type, msg) => console.log(`[reconciler][${type}] ${msg}`);
let _redisSave    = async () => {};
let _indStockList = [];
let _markDirty    = () => {};

function initReconciler({ state, logFn, redisSaveFn, calcCreditSpreadTP, indStockList, markDirtyFn }) {
  _state        = state;
  if (logFn)        _log          = logFn;
  if (redisSaveFn)  _redisSave    = redisSaveFn;
  if (indStockList) _indStockList = indStockList;
  if (markDirtyFn)  _markDirty    = markDirtyFn;
  // calcCreditSpreadTP removed: APEX trades naked options only
}

async function runReconciliation() {
  if (!ALPACA_KEY) return;
  // FIX: Guard against being called before initReconciler() injects _state
  if (!_state || !_state.positions) {
    _log("warn", "[RECONCILE] Skipped — _state not yet initialized (called before initReconciler?)");
    return;
  }
  try {
    const alpacaPositions = await alpacaGet("/positions");
    if (!alpacaPositions || !Array.isArray(alpacaPositions)) return;

    const alpacaSymbols  = new Set(alpacaPositions.map(p => p.symbol));
    const alpacaBySymbol = {};
    for (const ap of alpacaPositions) alpacaBySymbol[ap.symbol] = ap;
    let ghosts = 0, orphans = 0;

    // ── Deduplicate state.positions by contractSymbol ────────────────────────
    // Addon bug can create two records with the same contractSymbol.
    // Keep the one with highest contracts; if tied, keep the more recent openDate.
    const _symSeen = new Map();
    for (const pos of _state.positions) {
      const sym = pos.contractSymbol || pos.buySymbol || `${pos.ticker}_${pos.optionType}`;
      if (!sym) continue;
      if (!_symSeen.has(sym)) {
        _symSeen.set(sym, pos);
      } else {
        const existing = _symSeen.get(sym);
        const existContracts = existing.contracts || 0;
        const posContracts   = pos.contracts || 0;
        if (posContracts > existContracts ||
           (posContracts === existContracts && new Date(pos.openDate||0) > new Date(existing.openDate||0))) {
          _symSeen.set(sym, pos);
        }
      }
    }
    const _dedupedPositions = Array.from(_symSeen.values());
    if (_dedupedPositions.length < _state.positions.length) {
      _log("warn", `[RECONCILE] Deduped ${_state.positions.length - _dedupedPositions.length} duplicate position(s)`);
      _state.positions = _dedupedPositions;
    }

    // ── Update currentPrice on existing positions from Alpaca ────────────────
    for (const pos of _state.positions) {
      const alpPos = alpacaPositions.find(p =>
        p.symbol === pos.contractSymbol ||
        p.symbol === pos.buySymbol ||
        p.symbol === pos.sellSymbol
      );
      if (alpPos) {
        const mktVal = parseFloat(alpPos.market_value || 0);
        const qty    = Math.abs(parseInt(alpPos.qty || 1));
        const curP   = qty > 0 && mktVal > 0 ? parseFloat((mktVal / (qty * 100)).toFixed(2)) : pos.currentPrice;
        if (curP > 0) {
          pos.currentPrice = curP;
          pos._currentPriceUpdatedAt = Date.now();
        }
        if (alpPos.greeks?.delta) {
          pos.probabilityOfProfit = parseFloat(((1 - Math.abs(parseFloat(alpPos.greeks.delta))) * 100).toFixed(1));
        }
      }
    }

    // ── Credit/debit label correction ────────────────────────────────────────
    for (const pos of _state.positions) {
      if (!pos.isSpread || !pos.buySymbol || !pos.sellSymbol) continue;
      const buyLeg  = alpacaBySymbol[pos.buySymbol];
      const sellLeg = alpacaBySymbol[pos.sellSymbol];
      if (!buyLeg || !sellLeg) continue;
      const buyEntry  = parseFloat(buyLeg.avg_entry_price  || 0);
      const sellEntry = parseFloat(sellLeg.avg_entry_price || 0);
      if (buyEntry <= 0 || sellEntry <= 0) continue;
      const shouldBeCredit = sellEntry > buyEntry;
      if (pos.isCreditSpread !== shouldBeCredit) {
        _log("warn", `[RECONCILE] Correcting ${pos.ticker} isCreditSpread: ${pos.isCreditSpread} → ${shouldBeCredit}`);
        pos.isCreditSpread = shouldBeCredit;
        const netPremium = parseFloat(Math.abs(sellEntry - buyEntry).toFixed(2));
        if (netPremium > 0) pos.premium = netPremium;
        const width = Math.abs((pos.buyStrike || 0) - (pos.sellStrike || 0));
        if (width > 0) {
          pos.maxProfit = shouldBeCredit
            ? parseFloat((pos.premium * 100 * (pos.contracts || 1)).toFixed(2))
            : parseFloat(((width - pos.premium) * 100 * (pos.contracts || 1)).toFixed(2));
          pos.maxLoss = shouldBeCredit
            ? parseFloat(((width - pos.premium) * 100 * (pos.contracts || 1)).toFixed(2))
            : parseFloat((pos.premium * 100 * (pos.contracts || 1)).toFixed(2));
        }
      }
      const alpacaContracts = Math.min(
        Math.abs(parseInt(buyLeg.qty || 1)),
        Math.abs(parseInt(sellLeg.qty || 1))
      );
      if (alpacaContracts > 0 && alpacaContracts !== pos.contracts) {
        _log("warn", `[RECONCILE] Correcting ${pos.ticker} contracts: ${pos.contracts} → ${alpacaContracts}`);
        pos.contracts = alpacaContracts;
        const width = Math.abs((pos.buyStrike || 0) - (pos.sellStrike || 0));
        if (width > 0 && pos.premium > 0) {
          pos.maxProfit = pos.isCreditSpread
            ? parseFloat((pos.premium * 100 * alpacaContracts).toFixed(2))
            : parseFloat(((width - pos.premium) * 100 * alpacaContracts).toFixed(2));
          pos.maxLoss = pos.isCreditSpread
            ? parseFloat(((width - pos.premium) * 100 * alpacaContracts).toFixed(2))
            : parseFloat((pos.premium * 100 * alpacaContracts).toFixed(2));
        }
      }
    }

    // ── Broken spread → naked conversion ─────────────────────────────────────
    for (const pos of _state.positions) {
      if (!pos.isSpread) continue;
      const hasOnlyOneSym = (pos.buySymbol && !pos.sellSymbol) || (!pos.buySymbol && pos.sellSymbol);
      if (!hasOnlyOneSym) continue;
      const sym = pos.buySymbol || pos.sellSymbol;
      const alpacaLeg = alpacaBySymbol[sym];
      if (!alpacaLeg) continue;
      _log("warn", `[RECONCILE] ${pos.ticker} spread missing one leg (${sym}) — converting to naked`);
      const _prevBuyStrike  = pos.buyStrike;
      const _prevSellStrike = pos.sellStrike;
      pos.isSpread       = false;
      pos.isCreditSpread = false;
      const legQty = parseInt(alpacaLeg.qty || 1);
      pos.contracts      = Math.abs(legQty);
      pos.contractSymbol = sym;
      pos.buySymbol      = legQty > 0 ? sym : null;
      pos.sellSymbol     = legQty < 0 ? sym : null;
      pos.premium        = parseFloat(alpacaLeg.avg_entry_price || pos.premium || 0);
      pos.maxLoss        = null;
      pos.maxProfit      = null;
      pos.buyStrike      = _prevBuyStrike  || null;
      pos.sellStrike     = _prevSellStrike || null;
    }

    // ── Ghost detection — APEX has position, Alpaca doesn't ─────────────────
    for (const pos of [..._state.positions]) {
      const symbols    = [pos.contractSymbol, pos.buySymbol, pos.sellSymbol].filter(Boolean);
      const allMissing = symbols.length > 0 && symbols.every(s => !alpacaSymbols.has(s));
      const noSymbolsStored = symbols.length === 0;
      const alpacaHasTickerOption = alpacaPositions.some(p => {
        const underlying = p.symbol?.match(/^([A-Z]+)\d{6}[CP]/)?.[1];
        return underlying === pos.ticker;
      });
      const symbollessGhost = noSymbolsStored && !alpacaHasTickerOption;

      if (allMissing || symbollessGhost) {
        const ghostReason = symbollessGhost
          ? "no contract symbols stored + Alpaca empty for ticker"
          : "closed externally";
        _log("warn", `[RECONCILE] Ghost: ${pos.ticker} ${pos.contractSymbol||pos.buySymbol||"(no symbol)"} - ${ghostReason}`);
        const idx = _state.positions.indexOf(pos);
        if (idx === -1) { _log("warn", `[RECONCILE] splice guard: ${pos.ticker} not found`); continue; }
        _state.positions.splice(idx, 1);
        _state.closedTrades.push({
          ticker: pos.ticker, pnl: 0, pct: "0", reason: "reconcile-removed",
          date: new Date().toLocaleDateString(), score: pos.score || 0, closeTime: Date.now(),
          tradeType: "naked",
        });

        // Write _recentLosses so re-entry gate fires correctly
        const _ghostCurrentPrice = pos.currentPrice || pos.premium || 0;
        const _ghostPnlEstimate  = (_ghostCurrentPrice - pos.premium) * 100 * (pos.contracts || 1);
        if (_ghostPnlEstimate < 0 || pos.premium > _ghostCurrentPrice) {
          _state._recentLosses = _state._recentLosses || {};
          _state._recentLosses[pos.ticker] = {
            closedAt:   Date.now(),
            reason:     'reconcile-removed',
            agentSignal: (_state._agentMacro || {}).signal || 'neutral',
            price:      _ghostCurrentPrice,
            pnlPct:     pos.premium > 0
              ? parseFloat((((_ghostCurrentPrice - pos.premium) / pos.premium) * 100).toFixed(1))
              : -100,
            exitRSI:    pos._prevRSI || pos.rsi || pos.entryRSI || 50,
            optionType: pos.optionType || null,
          };
          _log('warn', `[RECONCILE] Loss record written for ${pos.ticker} — re-entry cooldown active`);
        }
        // 30-min same-instrument cooldown regardless of P&L
        _state._recentCloses = _state._recentCloses || {};
        _state._recentCloses[pos.ticker] = {
          closedAt:  Date.now(),
          direction: pos.optionType || 'call',
          reason:    'reconcile-removed',
          pnl:       _ghostPnlEstimate,
        };

        // Try to resolve actual fill price from Alpaca activities
        if (!_state.tradeJournal) _state.tradeJournal = [];
        let _ghostPnl = 0;
        let _ghostEp  = pos.currentPrice || pos.premium || 0;
        let _ghostReasoning = `Position closed externally. Check Alpaca fills.`;
        try {
          const today = new Date().toISOString().split('T')[0];
          const acts  = await alpacaGet(`/account/activities?activity_type=FILL&date=${today}&direction=desc&page_size=50`);
          if (Array.isArray(acts)) {
            const sym = pos.contractSymbol || pos.buySymbol;
            const sellFill = acts.find(a =>
              a.symbol === sym && a.side === 'sell' &&
              new Date(a.transaction_time).getTime() > Date.now() - 2 * 60 * 60 * 1000
            );
            if (sellFill) {
              _ghostEp  = parseFloat(sellFill.price || _ghostEp);
              _ghostPnl = parseFloat(((_ghostEp - pos.premium) * 100 * (pos.contracts || 1)).toFixed(2));
              _ghostReasoning = `Closed externally @ $${_ghostEp} via Alpaca fill.`;
              _log("info", `[RECONCILE] ${pos.ticker} ghost P&L from fill: $${_ghostPnl}`);
              const _ghostProceeds = parseFloat((parseFloat(sellFill.price || 0) * 100 * (pos.contracts || 1)).toFixed(2));
              const _ghostExitFields = {
                actualFillProceeds: _ghostProceeds,
                pnl_alpaca:  parseFloat((_ghostProceeds - (pos.premium * 100 * (pos.contracts || 1))).toFixed(2)),
                exitPrice:   _ghostEp,
                exitReason:  'reconcile-removed',
                closeDate:   new Date().toISOString(),
                closeDateET: new Date().toLocaleString('en-US', {timeZone:'America/New_York'}),
                isWin:       _ghostPnl > 0,
                status:      'CLOSED',
              };
              updateJournalExit(sym, _ghostExitFields, {
                ticker: pos.ticker, optionType: pos.optionType, strike: pos.strike, expDate: pos.expDate
              }).then(found => {
                if (!found) {
                  writeJournalEntry({
                    id: `${sym}_reconcile_${Date.now()}`,
                    contractSymbol: sym, ticker: pos.ticker, optionType: pos.optionType,
                    strike: pos.strike, expDate: pos.expDate, tradeType: 'naked',
                    openDate: pos.openDate || new Date().toISOString(),
                    openDateET: pos.openDate
                      ? new Date(pos.openDate).toLocaleString('en-US', {timeZone:'America/New_York'})
                      : new Date().toLocaleString('en-US', {timeZone:'America/New_York'}),
                    entryPrice: pos.premium, entryContracts: pos.contracts || 1,
                    entryCost: pos.cost || 0, entryScore: pos.score || 0,
                    entryRSI: pos.entryRSI || null, _reconstructed: true,
                    ..._ghostExitFields,
                  }).catch(e => _log('warn', `[RECONCILE] standalone exit write failed: ${e.message}`));
                }
              }).catch(e => _log('warn', `[RECONCILE] exit update failed: ${e.message}`));
            }
          }
        } catch(e) {
          _log("warn", `[RECONCILE] Alpaca activities fetch failed: ${e.message}`);
        }
        _state.tradeJournal.unshift({
          time: new Date().toISOString(), ticker: pos.ticker, action: "CLOSE",
          reason: "reconcile-removed", optionType: pos.optionType, tradeType: "naked",
          strike: pos.strike || null, expDate: pos.expDate || null,
          exitPremium: _ghostEp, pnl: _ghostPnl,
          pct: pos.premium > 0 ? ((_ghostPnl / (pos.premium * 100 * (pos.contracts||1))) * 100).toFixed(1) : "0",
          reasoning: _ghostReasoning, score: pos.score || 0,
        });
        if (_state.tradeJournal.length > 100) _state.tradeJournal = _state.tradeJournal.slice(0, 100);
        ghosts++;
      }
    }

    // ── Orphan detection — Alpaca has position, APEX doesn't ─────────────────
    const activeTickers = new Set([
      ...WATCHLIST.map(w => w.ticker),
      ...(INDIVIDUAL_STOCKS_ENABLED ? _indStockList.map(w => w.ticker) : []),
    ]);

    const orphanedAlpaca = alpacaPositions.filter(alpPos => {
      if (!/^[A-Z]+\d{6}[CP]\d{8}$/.test(alpPos.symbol)) return false;
      const underlyingTicker = alpPos.symbol.match(/^([A-Z]+)\d{6}[CP]/)?.[1];
      if (underlyingTicker && !activeTickers.has(underlyingTicker)) {
        _log("warn", `[RECONCILE] Skipping orphan for inactive ticker ${underlyingTicker} (${alpPos.symbol})`);
        return false;
      }
      return !_state.positions.find(p =>
        (p.contractSymbol === alpPos.symbol ||
         p.buySymbol      === alpPos.symbol ||
         p.sellSymbol     === alpPos.symbol) &&
        (p.contracts || 0) > 0
      );
    });

    if (orphanedAlpaca.length > 0) {
      orphans = orphanedAlpaca.length;
      const parsed = orphanedAlpaca.map(alpPos => {
        const sym     = alpPos.symbol;
        const isCall  = /\d{6}C\d{8}$/.test(sym);
        const optType = isCall ? 'call' : 'put';
        const strikeM = sym.match(/[CP](\d{8})$/);
        const strike  = strikeM ? parseFloat(strikeM[1]) / 1000 : 0;
        const expM    = sym.match(/(\d{2})(\d{2})(\d{2})[CP]/);
        const expDate = expM
          ? new Date(`20${expM[1]}-${expM[2]}-${expM[3]}`).toLocaleDateString('en-US', {month:'short',day:'2-digit',year:'numeric'})
          : '';
        const expDays = expDate ? Math.max(1, Math.round((new Date(expDate) - new Date()) / MS_PER_DAY)) : 30;
        const qty     = parseInt(alpPos.qty || 1);
        const avgEntry = parseFloat(alpPos.avg_entry_price || 0);
        const mktVal  = parseFloat(alpPos.market_value || 0);
        const ticker  = sym.match(/^([A-Z]+)\d/)?.[1] || 'SPY';
        return { sym, ticker, optType, strike, expDate, expDays, qty, avgEntry, mktVal, alpPos };
      });

      // Try to pair spread legs: same ticker+expiry+optType, opposite qty, strike within range
      const used = new Set();
      for (let i = 0; i < parsed.length; i++) {
        if (used.has(i)) continue;
        const a = parsed[i];
        let paired = false;

        for (let j = i + 1; j < parsed.length; j++) {
          if (used.has(j)) continue;
          const b = parsed[j];
          const sameTickerExp = a.ticker === b.ticker && a.expDate === b.expDate && a.optType === b.optType;
          const widthOk = Math.abs(a.strike - b.strike) >= 1 && Math.abs(a.strike - b.strike) <= 100;
          const oppDir  = (a.qty > 0 && b.qty < 0) || (a.qty < 0 && b.qty > 0);
          if (sameTickerExp && widthOk && oppDir) {
            const longLeg  = a.qty > 0 ? a : b;
            const shortLeg = a.qty > 0 ? b : a;
            const buyLeg   = longLeg;
            const sellLeg  = shortLeg;
            const netDebit = parseFloat(Math.abs(Math.abs(sellLeg.avgEntry) - buyLeg.avgEntry).toFixed(2));
            const spreadWidth = Math.abs(buyLeg.strike - sellLeg.strike);
            const _isCredit = sellLeg.avgEntry > buyLeg.avgEntry;
            _state.positions.push({
              ticker: a.ticker, optionType: a.optType,
              isSpread: true, isCreditSpread: _isCredit,
              buyStrike: buyLeg.strike, sellStrike: sellLeg.strike,
              spreadWidth, buySymbol: buyLeg.sym, sellSymbol: sellLeg.sym,
              contractSymbol: buyLeg.sym,
              premium: Math.max(0.01, netDebit),
              buyPremium:  parseFloat((buyLeg.avgEntry || 0).toFixed(2)),
              sellPremium: parseFloat((sellLeg.avgEntry || 0).toFixed(2)),
              maxProfit: _isCredit
                ? parseFloat((Math.max(0.01, netDebit) * 100 * Math.abs(buyLeg.qty)).toFixed(2))
                : parseFloat((spreadWidth - Math.max(0.01, netDebit)).toFixed(2)),
              maxLoss: _isCredit
                ? parseFloat(((spreadWidth - Math.max(0.01, netDebit)) * 100 * Math.abs(buyLeg.qty)).toFixed(2))
                : Math.max(0.01, netDebit),
              contracts: Math.abs(buyLeg.qty),
              expDate: a.expDate, expDays: a.expDays,
              cost: _isCredit
                ? parseFloat(((spreadWidth - Math.max(0.01, netDebit)) * 100 * Math.abs(buyLeg.qty)).toFixed(2))
                : parseFloat((Math.max(0.01, netDebit) * 100 * Math.abs(buyLeg.qty)).toFixed(2)),
              score: 75, reasons: ['Reconstructed spread from Alpaca reconciliation'],
              openDate: buyLeg.alpPos.created_at || new Date(Date.now() - 86400000).toISOString(),
              currentPrice: Math.max(0.01, netDebit), peakPremium: Math.max(0.01, netDebit),
              entryRSI: 50, entryMACD: 'neutral', entryMomentum: 'steady', entryMacro: 'neutral',
              entryThesisScore: 100, thesisHistory: [], agentHistory: [],
              realData: true, vix: _state.vix || 20, entryVIX: _state.vix || 20,
              expiryType: 'monthly', dteLabel: 'RECONCILED-SPREAD',
              partialClosed: false, isMeanReversion: false, trailStop: null,
              breakevenLocked: false, halfPosition: false,
              target: parseFloat((Math.max(0.01, netDebit) * 1.5).toFixed(2)),
              stop:   parseFloat((Math.max(0.01, netDebit) * 0.65).toFixed(2)),
              takeProfitPct: TAKE_PROFIT_PCT, fastStopPct: STOP_LOSS_PCT,
            });
            used.add(i); used.add(j); paired = true;
            _log("warn", `[RECONCILE] Reconstructed SPREAD: ${a.ticker} $${buyLeg.strike}/$${sellLeg.strike} ${a.optType.toUpperCase()} exp ${a.expDate}`);
            break;
          }
        }

        if (!paired) {
          const p = a;

          // Skip if CLOSED journal entry already exists today (pending fill scenario)
          const _today = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'}).split('/');
          const _todayStr = `${_today[2]}-${_today[0]}-${_today[1]}`;
          let _alreadyClosed = false;
          try {
            const _todayEntries = await loadJournalDay(_todayStr);
            _alreadyClosed = _todayEntries.some(e =>
              e.contractSymbol === p.sym && e.status === 'CLOSED'
            );
          } catch(_) {}

          if (_alreadyClosed) {
            _log('warn', `[RECONCILE] Skipping ${p.ticker} (${p.sym}) — CLOSED journal entry exists (sell order pending fill)`);
            continue;
          }

          const curP = p.mktVal > 0 ? p.mktVal / (Math.abs(p.qty) * 100) : p.avgEntry;

          // ── FIX: Reconstruct the position object FIRST, then reference it ──────
          // BEFORE (bug): code pushed to _state.positions then did:
          //   const _reconPos = newPositions[newPositions.length - 1]
          //   'newPositions' was never declared → ReferenceError → caught silently
          //   → _redisSave never called → position lost on next restart
          // FIX: build the object, push it, save it, then write journal entry.
          const reconPos = {
            ticker: p.ticker, optionType: p.optType, isSpread: false,
            strike: p.strike, contractSymbol: p.sym,
            buySymbol:  p.qty > 0 ? p.sym : null,
            sellSymbol: p.qty < 0 ? p.sym : null,
            premium: p.avgEntry, currentPrice: curP,
            _currentPriceUpdatedAt: Date.now(),
            breakeven: p.optType === 'put'
              ? parseFloat((p.strike - p.avgEntry).toFixed(2))
              : parseFloat((p.strike + p.avgEntry).toFixed(2)),
            contracts: Math.abs(p.qty), expDate: p.expDate, expDays: p.expDays,
            cost: p.qty > 0
              ? parseFloat((p.avgEntry * 100 * Math.abs(p.qty)).toFixed(2))
              : 0,
            score: 75, reasons: ['Reconstructed from Alpaca reconciliation'],
            openDate: (function() {
              const created = p.alpPos.created_at ? new Date(p.alpPos.created_at) : new Date();
              const backdated = new Date(created.getTime() - 120000);
              return backdated.toISOString();
            })(),
            peakPremium: Math.max(p.avgEntry, curP || 0) || p.avgEntry,
            entryRSI: 50, entryMACD: 'neutral', entryMomentum: 'steady', entryMacro: 'neutral',
            entryThesisScore: 100, thesisHistory: [], agentHistory: [],
            realData: true, vix: _state.vix || 20, entryVIX: _state.vix || 20,
            expiryType: 'monthly', dteLabel: 'RECONCILED',
            partialClosed: false, isMeanReversion: false, trailStop: null,
            breakevenLocked: false, halfPosition: false,
            target: parseFloat((p.avgEntry * (1 + TAKE_PROFIT_PCT)).toFixed(2)),
            stop:   parseFloat((p.avgEntry * (1 - STOP_LOSS_PCT)).toFixed(2)),
            takeProfitPct: TAKE_PROFIT_PCT, fastStopPct: STOP_LOSS_PCT,
          };

          // Push, save, THEN write journal — all in correct order
          _state.positions.push(reconPos);
          _markDirty(); // mark state dirty so periodic flush catches it too

          _log("warn", `[RECONCILE] Reconstructed: ${p.ticker} ${p.optType.toUpperCase()} $${p.strike} exp ${p.expDate} | ${Math.abs(p.qty)}x @ $${p.avgEntry}`);

          // Write OPEN journal entry with whatever Alpaca gave us
          if (writeJournalEntry) {
            writeJournalEntry({
              id:             `${p.sym}_recon_${Date.now()}`,
              contractSymbol: p.sym,
              ticker:         p.ticker,
              optionType:     p.optType,
              strike:         p.strike,
              expDate:        p.expDate,
              tradeType:      'naked',
              openDate:       reconPos.openDate,
              openDateET:     new Date(reconPos.openDate).toLocaleString('en-US', {timeZone:'America/New_York'}),
              entryPrice:     p.avgEntry,
              entryContracts: Math.abs(p.qty),
              entryCost:      reconPos.cost,
              entryScore:     75,
              entryReasons:   ['Reconstructed from Alpaca reconciliation'],
              entryRSI:       null,
              entryDelta:     null,
              entryIV:        null,
              entryVIX:       _state.vix || null,
              entryIVR:       null,
              entryMACD:      null,
              entryMomentum:  null,
              macroSignal:    'unknown',
              regimeAtEntry:  'unknown',
              status:         'OPEN',
              _reconstructed: true,
            }).catch(e => _log('warn', `[RECONCILE] Journal write failed for ${p.ticker}: ${e.message}`));
          }
        }
      }
    }

    if (ghosts > 0 || orphans > 0) {
      _log("warn", `[RECONCILE] ${ghosts} ghost(s) removed, ${orphans} orphan(s) reconstructed`);
      await _redisSave(_state);
      _markDirty();
    }

    // ── Re-pair individual legs into spreads ──────────────────────────────────
    let pairsFound = 0;
    const toRemove = new Set();
    const toAdd    = [];

    for (let i = 0; i < _state.positions.length; i++) {
      if (toRemove.has(i)) continue;
      const a = _state.positions[i];
      if (a.isSpread || !a.contractSymbol) continue;

      for (let j = i + 1; j < _state.positions.length; j++) {
        if (toRemove.has(j)) continue;
        const b = _state.positions[j];
        if (b.isSpread || !b.contractSymbol) continue;

        const sameTickerExp = a.ticker === b.ticker && a.expDate === b.expDate && a.optionType === b.optionType;
        const strikeA = a.strike || 0;
        const strikeB = b.strike || 0;
        const width   = Math.abs(strikeA - strikeB);
        const widthOk = width >= 1 && width <= 100;
        const aIsShort = a.sellSymbol && !a.buySymbol;
        const bIsShort = b.sellSymbol && !b.buySymbol;
        const oppDir   = aIsShort !== bIsShort;

        if (sameTickerExp && widthOk && oppDir) {
          const buyLeg  = !aIsShort ? a : b;
          const sellLeg = aIsShort  ? a : b;
          const buyIdx  = !aIsShort ? i : j;
          const sellIdx = aIsShort  ? i : j;
          const netDebit = parseFloat((buyLeg.premium - sellLeg.premium).toFixed(2));
          const curNet   = parseFloat(((buyLeg.currentPrice || buyLeg.premium) - (sellLeg.currentPrice || sellLeg.premium)).toFixed(2));
          const _isCredit = sellLeg.premium > buyLeg.premium;
          const _credit = _isCredit
            ? parseFloat(Math.abs(netDebit).toFixed(2))
            : parseFloat(Math.max(0.01, netDebit).toFixed(2));

          const merged = {
            ticker: a.ticker, optionType: a.optionType,
            isSpread: true, isCreditSpread: _isCredit,
            buyStrike: buyLeg.strike, sellStrike: sellLeg.strike, spreadWidth: width,
            buySymbol: buyLeg.contractSymbol, sellSymbol: sellLeg.contractSymbol,
            contractSymbol: buyLeg.contractSymbol,
            premium: Math.max(0.01, _credit),
            maxProfit: _isCredit
              ? parseFloat((_credit * 100 * Math.max(buyLeg.contracts||1, sellLeg.contracts||1)).toFixed(2))
              : parseFloat((width - _credit).toFixed(2)),
            maxLoss: _isCredit
              ? parseFloat(((width - _credit) * 100 * Math.max(buyLeg.contracts||1, sellLeg.contracts||1)).toFixed(2))
              : _credit,
            contracts: Math.max(buyLeg.contracts || 1, sellLeg.contracts || 1),
            expDate: a.expDate, expDays: a.expDays,
            cost: _isCredit
              ? parseFloat(((width - _credit) * 100 * Math.max(buyLeg.contracts||1, sellLeg.contracts||1)).toFixed(2))
              : parseFloat((_credit * 100 * Math.max(buyLeg.contracts||1, sellLeg.contracts||1)).toFixed(2)),
            score: Math.max(buyLeg.score || 75, sellLeg.score || 75),
            reasons: ['Re-paired from individual legs'],
            openDate: buyLeg.openDate || new Date().toISOString(),
            currentPrice: Math.max(0.01, curNet), peakPremium: Math.max(0.01, netDebit),
            entryRSI: buyLeg.entryRSI || 50, entryMACD: 'neutral',
            entryMomentum: 'steady', entryMacro: 'neutral',
            entryThesisScore: 100, thesisHistory: [], agentHistory: [],
            realData: true, vix: _state.vix || 20, entryVIX: _state.vix || 20,
            expiryType: 'monthly', dteLabel: 'RECONCILED-SPREAD',
            partialClosed: false, isMeanReversion: false, trailStop: null,
            breakevenLocked: false, halfPosition: false,
            target: parseFloat((Math.max(0.01, netDebit) * 1.5).toFixed(2)),
            stop:   parseFloat((Math.max(0.01, netDebit) * 0.65).toFixed(2)),
            takeProfitPct: TAKE_PROFIT_PCT, fastStopPct: STOP_LOSS_PCT,
          };
          toRemove.add(buyIdx);
          toRemove.add(sellIdx);
          toAdd.push(merged);
          pairsFound++;
          _log("warn", `[RECONCILE] Re-paired: ${a.ticker} $${buyLeg.strike}/$${sellLeg.strike} ${a.optionType.toUpperCase()} exp ${a.expDate}`);
          break;
        }
      }
    }

    if (pairsFound > 0) {
      _state.positions = _state.positions.filter((_, idx) => !toRemove.has(idx));
      _state.positions.push(...toAdd);
      _log("warn", `[RECONCILE] Re-paired ${pairsFound} spread(s) from individual legs`);
      await _redisSave(_state);
      _markDirty();
    }

    // ── Journal sweep — enforce "no live position ⇒ no OPEN journal row" ──────
    // alpacaSymbols came from a successful /positions fetch (guarded at top), so an
    // empty set genuinely means flat. Journal-only: never touches positions or orders.
    try {
      const swept = await closeOrphanJournalOpens(alpacaSymbols);
      if (swept > 0) _log("warn", `[RECONCILE] Journal sweep: closed ${swept} orphan OPEN journal entr${swept === 1 ? 'y' : 'ies'} with no live position`);
    } catch (e) {
      _log("warn", `[RECONCILE] journal sweep failed: ${e.message}`);
    }

    _state.lastReconcile   = new Date().toISOString();
    _state.reconcileStatus = ghosts === 0 && orphans === 0 && pairsFound === 0 ? "ok" : "warning";
    _state.orphanCount     = orphans;

  } catch(e) {
    _log("error", `[RECONCILE] Failed: ${e.message}\n${e.stack?.split('\n')[1]?.trim() || ''}`);
  }
}

async function syncPositionPnLFromAlpaca() {
  if (!ALPACA_KEY) return;
  if (!_state || !_state.positions) return;
  try {
    const alpacaPositions = await alpacaGet('/positions');
    if (!alpacaPositions || !Array.isArray(alpacaPositions)) return;
    const alpacaBySymbol = {};
    for (const ap of alpacaPositions) alpacaBySymbol[ap.symbol] = ap;

    // fix: collapse any pre-existing duplicate OPEN positions sharing a contract
    // (legacy scale-in dupes created before merge-on-addon). One record per contract:
    // summed contracts, weighted-avg premium. New dupes can't form post-fix.
    {
      const _seen = {};
      for (const p of _state.positions) {
        if (!p.contractSymbol) continue;
        if (!_seen[p.contractSymbol]) { _seen[p.contractSymbol] = p; continue; }
        const a = _seen[p.contractSymbol];
        const qa = a.contracts || 0, qb = p.contracts || 0, q = qa + qb;
        if (q > 0) a.premium = parseFloat(((a.premium*qa + p.premium*qb)/q).toFixed(4));
        a.contracts = q;
        a.cost = parseFloat(((a.cost||0) + (p.cost||0)).toFixed(2));
        p._dupCollapsed = true;
      }
      if (_state.positions.some(p => p._dupCollapsed)) {
        _state.positions = _state.positions.filter(p => !p._dupCollapsed);
        _log('warn', `[RECONCILE] collapsed duplicate open positions (legacy scale-in)`);
      }
    }

    for (const pos of _state.positions) {
      const ap = alpacaBySymbol[pos.contractSymbol];
      if (!ap) continue;
      const qty    = Math.abs(parseInt(ap.qty || 1));
      const mktVal = parseFloat(ap.market_value || 0);
      if (qty > 0 && mktVal > 0) {
        pos.currentPrice = parseFloat((mktVal / (qty * 100)).toFixed(2));
        pos._currentPriceUpdatedAt = Date.now();
        pos.realData = true;
      }
      const alpacaQty  = Math.abs(parseInt(ap.qty || 1));
      const _avgEntry  = parseFloat(ap.avg_entry_price || 0);
      if (alpacaQty !== pos.contracts) {
        _log('scan', `[ALPACA SYNC] ${pos.ticker} contracts: ${pos.contracts} → ${alpacaQty}`);
        pos.contracts = alpacaQty;
        // fix: on ANY qty change, re-sync cost basis to Alpaca's blended avg —
        // otherwise a scale-in leaves premium at the first fill → wrong P&L at close.
        if (_avgEntry > 0 && Math.abs(_avgEntry - pos.premium) > 0.01) {
          _log('scan', `[ALPACA SYNC] ${pos.ticker} premium: ${pos.premium} → ${_avgEntry} (blended avg_entry_price)`);
          pos.premium = _avgEntry;
        }
      }
      if (pos.currentPrice > 0 && pos.premium > 0) {
        pos.unrealizedPnL = parseFloat(((pos.currentPrice - pos.premium) * 100 * pos.contracts).toFixed(2));
      }
      if (pos.currentPrice > (pos.peakPremium || 0)) {
        pos.peakPremium = pos.currentPrice;
      }
      // MAE — max adverse excursion. Mirror of the peak (MFE) above. Always-on observability;
      // written into the journal at close so PUT-entry quality can be read against how low it went.
      if (pos.currentPrice > 0 && pos.currentPrice < (pos.troughPremium ?? Infinity)) {
        pos.troughPremium = pos.currentPrice;
      }
    }
  } catch(e) {
    _log('warn', `[SYNC] syncPositionPnLFromAlpaca error: ${e.message}`);
  }
}

module.exports = {
  initReconciler,
  runReconciliation,
  syncPositionPnLFromAlpaca,
};
