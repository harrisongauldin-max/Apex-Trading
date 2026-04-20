// reconciler.js — ARGO V3.2
// Position reconciliation: keeps ARGO state aligned with Alpaca ground truth.
// Runs on startup and every 3 minutes during market hours.
'use strict';

const { alpacaGet } = require('./broker');
const { WATCHLIST }  = require('./constants');
const { executeIronCondor, findContract } = require('./execution');

// ─── Injected dependencies (set by server.js at boot) ────────────
let _state         = null;
let _log           = (type, msg) => console.log(`[reconciler][${type}] ${msg}`);
let _redisSave     = async () => {};
let _calcTP        = (vix) => 0.35;   // calcCreditSpreadTP
let _indStockList  = [];
let _markDirty     = () => {};    // injected by initReconciler

function initReconciler({ state, logFn, redisSaveFn, calcCreditSpreadTP, indStockList, markDirtyFn }) {
  _state        = state;
  if (logFn)           _log       = logFn;
  if (redisSaveFn)     _redisSave = redisSaveFn;
  if (calcCreditSpreadTP) _calcTP = calcCreditSpreadTP;
  if (indStockList)    _indStockList = indStockList;
}

async function runReconciliation() {
  if (!ALPACA_KEY) return;
  try {
    const alpacaPositions = await alpacaGet("/positions");
    if (!alpacaPositions || !Array.isArray(alpacaPositions)) return;

    const alpacaSymbols = new Set(alpacaPositions.map(p => p.symbol));
    // Build symbol lookup — used by credit/debit correction and broken-spread passes
    const alpacaBySymbol = {};
    for (const ap of alpacaPositions) alpacaBySymbol[ap.symbol] = ap;
    let ghosts = 0, orphans = 0;

    // - Update currentPrice on existing positions from Alpaca data -
    for (const pos of _state.positions) {
      const alpPos = alpacaPositions.find(p =>
        p.symbol === pos.contractSymbol ||
        p.symbol === pos.buySymbol ||
        p.symbol === pos.sellSymbol
      );
      if (alpPos) {
        const mktVal  = parseFloat(alpPos.market_value || 0);
        const qty     = Math.abs(parseInt(alpPos.qty || 1));
        const curP    = qty > 0 && mktVal > 0 ? parseFloat((mktVal / (qty * 100)).toFixed(2)) : pos.currentPrice;
        if (curP > 0) pos.currentPrice = curP;
        // Update POP from live delta (market maker: track current not entry POP)
        if (alpPos.greeks?.delta) {
          pos.probabilityOfProfit = parseFloat(((1 - Math.abs(parseFloat(alpPos.greeks.delta))) * 100).toFixed(1));
        }
      }
    }

    // - Credit/debit label correction for existing spread positions -
    // Fixes positions entered with wrong isCreditSpread flag before the fix
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
        _log("warn", `[RECONCILE] Correcting ${pos.ticker} isCreditSpread: ${pos.isCreditSpread} → ${shouldBeCredit} (sell avg $${sellEntry} vs buy avg $${buyEntry})`);
        pos.isCreditSpread = shouldBeCredit;
        // Recalculate premium as net credit/debit from actual fill prices
        const netPremium = parseFloat(Math.abs(sellEntry - buyEntry).toFixed(2));
        if (netPremium > 0) pos.premium = netPremium;
        // Recalculate max profit/loss
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
      // Correct contracts from Alpaca — use MIN of both legs
      // A spread can only have as many matched pairs as the smaller leg allows
      // e.g. 4x long $745 / 1x short $739 = 1x spread (not 4x)
      const alpacaContracts = Math.min(
        Math.abs(parseInt(buyLeg.qty || 1)),
        Math.abs(parseInt(sellLeg.qty || 1))
      );
      if (alpacaContracts > 0 && alpacaContracts !== pos.contracts) {
        _log("warn", `[RECONCILE] Correcting ${pos.ticker} contracts: ${pos.contracts} → ${alpacaContracts} (min of both legs)`);
        pos.contracts = alpacaContracts;
        // Recalculate maxProfit/maxLoss with corrected contracts
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

    // - Broken spread correction: if spread has only one leg in Alpaca, convert to naked -
    for (const pos of _state.positions) {
      if (!pos.isSpread) continue;
      const hasOnlyOneSym = (pos.buySymbol && !pos.sellSymbol) || (!pos.buySymbol && pos.sellSymbol);
      if (!hasOnlyOneSym) continue;
      const sym = pos.buySymbol || pos.sellSymbol;
      const alpacaLeg = alpacaBySymbol[sym];
      if (!alpacaLeg) continue; // ghost detection will handle it
      // Only one leg exists in Alpaca — convert to naked position
      _log("warn", `[RECONCILE] ${pos.ticker} spread missing one leg (${sym}) — converting to naked`);
      pos.isSpread     = false;
      pos.isCreditSpread = false;
      const legQty = parseInt(alpacaLeg.qty || 1);
      pos.contracts    = Math.abs(legQty);
      pos.contractSymbol = sym;
      pos.buySymbol    = legQty > 0 ? sym : null;
      pos.sellSymbol   = legQty < 0 ? sym : null;
      pos.premium      = parseFloat(alpacaLeg.avg_entry_price || pos.premium || 0);
      pos.maxLoss      = null;
      pos.maxProfit    = null;
      pos.buyStrike    = legQty > 0 ? pos.buyStrike : null;
      pos.sellStrike   = legQty < 0 ? (pos.sellStrike || pos.buyStrike) : null;
    }

    // - Ghost detection - ARGO has position, Alpaca doesn't -
    for (const pos of [..._state.positions]) {
      const symbols = [pos.contractSymbol, pos.buySymbol, pos.sellSymbol].filter(Boolean);
      // A spread is a ghost only if BOTH legs are missing from Alpaca
      const allMissing = symbols.length > 0 && symbols.every(s => !alpacaSymbols.has(s));
      // V2.84 fix: positions with NO symbols stored (estimated entries, pre-spread architecture)
      // cannot be matched by symbol -- fall back to checking if Alpaca has ANY option on this ticker
      const noSymbolsStored = symbols.length === 0;
      const alpacaHasTickerOption = alpacaPositions.some(p => {
        const underlying = p.symbol?.match(/^([A-Z]+)\d{6}[CP]/)?.[1];
        return underlying === pos.ticker;
      });
      const symbollessGhost = noSymbolsStored && !alpacaHasTickerOption;
      if (allMissing || symbollessGhost) {
        const ghostReason = symbollessGhost ? "no contract symbols stored + Alpaca empty for ticker" : "closed externally";
        _log("warn", `[RECONCILE] Ghost: ${pos.ticker} ${pos.contractSymbol||pos.buySymbol||"(no symbol)"} - ${ghostReason}`);
        const idx = _state.positions.indexOf(pos);
        if (idx === -1) { _log("warn", `[RECONCILE] splice guard: ${pos.ticker} not found in positions array`); continue; }
        _state.positions.splice(idx, 1);
        _state.closedTrades.push({
          ticker: pos.ticker, pnl: 0, pct: "0", reason: "reconcile-removed",
          date: new Date().toLocaleDateString(), score: pos.score || 0, closeTime: Date.now(),
          tradeType: pos.isCreditSpread ? "credit_spread" : pos.isSpread ? "debit_spread" : "naked",
        });
        ghosts++;
      }
    }

    // - Orphan detection - Alpaca has position, ARGO doesn't -
    // Only reconstruct orphans for active watchlist tickers - prevents IWM and removed
    // instruments from being resurrected on every restart causing reconciliation loops
    const activeTickers = new Set([
      ...WATCHLIST.map(w => w.ticker),
      ...(INDIVIDUAL_STOCKS_ENABLED ? _indStockList.map(w => w.ticker) : []),
    ]);

    const orphanedAlpaca = alpacaPositions.filter(alpPos => {
      if (!/^[A-Z]+\d{6}[CP]\d{8}$/.test(alpPos.symbol)) return false;
      const underlyingTicker = alpPos.symbol.match(/^([A-Z]+)\d{6}[CP]/)?.[1];
      if (underlyingTicker && !activeTickers.has(underlyingTicker)) {
        _log("warn", `[RECONCILE] Skipping orphan for removed ticker ${underlyingTicker} (${alpPos.symbol}) - not in active watchlist`);
        return false;
      }
      return !_state.positions.find(p =>
        p.contractSymbol === alpPos.symbol ||
        p.buySymbol      === alpPos.symbol ||
        p.sellSymbol     === alpPos.symbol
      );
    });

    if (orphanedAlpaca.length > 0) {
      orphans = orphanedAlpaca.length;
      // Parse each orphan
      const parsed = orphanedAlpaca.map(alpPos => {
        const sym      = alpPos.symbol;
        const isCall   = /\d{6}C\d{8}$/.test(sym);
        const optType  = isCall ? 'call' : 'put';
        const strikeM  = sym.match(/[CP](\d{8})$/);
        const strike   = strikeM ? parseFloat(strikeM[1]) / 1000 : 0;
        const expM     = sym.match(/(\d{2})(\d{2})(\d{2})[CP]/);
        const expDate  = expM
          ? new Date(`20${expM[1]}-${expM[2]}-${expM[3]}`).toLocaleDateString('en-US', {month:'short',day:'2-digit',year:'numeric'})
          : '';
        const expDays  = expDate ? Math.max(1, Math.round((new Date(expDate) - new Date()) / MS_PER_DAY)) : 30;
        const qty      = parseInt(alpPos.qty || 1);
        const avgEntry = parseFloat(alpPos.avg_entry_price || 0);
        const mktVal   = parseFloat(alpPos.market_value || 0);
        const ticker   = sym.match(/^([A-Z]+)\d/)?.[1] || 'SPY';
        return { sym, ticker, optType, strike, expDate, expDays, qty, avgEntry, mktVal, alpPos };
      });

      // Pair spread legs: long + short, same ticker+expiry, ~$10 apart
      const used = new Set();
      for (let i = 0; i < parsed.length; i++) {
        if (used.has(i)) continue;
        const a = parsed[i];
        let paired = false;
        for (let j = i + 1; j < parsed.length; j++) {
          if (used.has(j)) continue;
          const b = parsed[j];
          const sameTickerExp = a.ticker === b.ticker && a.expDate === b.expDate && a.optType === b.optType;
          // Width cap raised to 25 - spread widths scale with VIX (up to $20 at VIX 35)
          // Previous cap of 12 caused $14+ wide spreads to be reconciled as individual legs
          const widthOk = Math.abs(a.strike - b.strike) >= 5 && Math.abs(a.strike - b.strike) <= 100; // B11: match re-pairing block
          const oppDir  = (a.qty > 0 && b.qty < 0) || (a.qty < 0 && b.qty > 0);
          if (sameTickerExp && widthOk && oppDir) {
            const longLeg  = a.qty > 0 ? a : b;
            const shortLeg = a.qty > 0 ? b : a;
            // buyLeg = what we own (qty > 0), sellLeg = what we sold (qty < 0)
            // Do NOT assign by strike order — that inverts credit call spreads
            // (credit call: short LOWER strike, long HIGHER strike → lower strike has qty < 0)
            const buyLeg   = longLeg;   // always the qty > 0 leg
            const sellLeg  = shortLeg;  // always the qty < 0 leg
            // Credit detection: if we received more for selling than we paid for protection
            // sellLeg.avgEntry > buyLeg.avgEntry → net credit → isCreditSpread = true
            const netDebit = parseFloat(Math.abs(Math.abs(sellLeg.avgEntry) - buyLeg.avgEntry).toFixed(2));
            const spreadWidth = Math.abs(buyLeg.strike - sellLeg.strike);
            const _isCredit3a = sellLeg.avgEntry > buyLeg.avgEntry;  // price-based: no strike-order assumption
            _state.positions.push({
              ticker: a.ticker, optionType: a.optType,
              isSpread: true, isCreditSpread: _isCredit3a,
              buyStrike: buyLeg.strike, sellStrike: sellLeg.strike,
              spreadWidth, buySymbol: buyLeg.sym, sellSymbol: sellLeg.sym,
              contractSymbol: buyLeg.sym,
              // D-FIX1a: credit=netDebit is credit received; debit=netDebit is cost paid
              premium:   Math.max(0.01, netDebit),
              maxProfit: _isCredit3a
                ? Math.max(0.01, netDebit)                                                  // credit: max profit = credit received
                : parseFloat((spreadWidth - Math.max(0.01, netDebit)).toFixed(2)),          // debit: max profit = width - cost
              maxLoss:   _isCredit3a
                ? parseFloat((spreadWidth - Math.max(0.01, netDebit)).toFixed(2))           // credit: max loss = width - credit
                : Math.max(0.01, netDebit),                                                 // debit: max loss = cost paid
              contracts: Math.abs(buyLeg.qty),
              expDate: a.expDate, expDays: a.expDays,
              cost: parseFloat((Math.max(0.01, netDebit) * 100 * Math.abs(buyLeg.qty)).toFixed(2)),
              score: 75, reasons: ['Reconstructed spread from Alpaca reconciliation'],
              openDate: buyLeg.alpPos.created_at || new Date(Date.now() - 86400000).toISOString(), // B10: fallback=yesterday
              currentPrice: Math.max(0.01, netDebit), peakPremium: Math.max(0.01, netDebit),
              entryRSI: 50, entryMACD: 'neutral', entryMomentum: 'steady', entryMacro: 'neutral',
              entryThesisScore: 100, thesisHistory: [], agentHistory: [],
              realData: true, vix: _state.vix || 20, entryVIX: _state.vix || 20,
              expiryType: 'monthly', dteLabel: 'RECONCILED-SPREAD',
              partialClosed: false, isMeanReversion: false, trailStop: null,
              breakevenLocked: false, halfPosition: false,
              target: parseFloat((Math.max(0.01, netDebit) * 1.5).toFixed(2)),
              stop: parseFloat((Math.max(0.01, netDebit) * 0.65).toFixed(2)),
              takeProfitPct: _isCredit3a ? _calcTP(_state.vix) : TAKE_PROFIT_PCT, // B7a
              fastStopPct: STOP_LOSS_PCT,
            });
            used.add(i); used.add(j); paired = true;
            _log("warn", `[RECONCILE] Reconstructed SPREAD: ${a.ticker} \$${buyLeg.strike}/\$${sellLeg.strike} ${a.optType.toUpperCase()} exp ${a.expDate}`);
            break;
          }
        }
        if (!paired) {
          const p = a;
          const curP = p.mktVal > 0 ? p.mktVal / (Math.abs(p.qty) * 100) : p.avgEntry;
          _state.positions.push({
            ticker: p.ticker, optionType: p.optType, isSpread: false,
            strike: p.strike, contractSymbol: p.sym,
            buySymbol: p.qty > 0 ? p.sym : null,
            sellSymbol: p.qty < 0 ? p.sym : null,
            premium: p.avgEntry, currentPrice: curP,
            breakeven: p.optType === 'put'
              ? parseFloat((p.strike - p.avgEntry).toFixed(2))
              : parseFloat((p.strike + p.avgEntry).toFixed(2)),
            contracts: Math.abs(p.qty), expDate: p.expDate, expDays: p.expDays,
            cost: Math.abs(p.mktVal) || parseFloat((p.avgEntry * 100 * Math.abs(p.qty)).toFixed(2)),
            score: 75, reasons: ['Reconstructed from Alpaca reconciliation'],
            openDate: p.alpPos.created_at || new Date().toISOString(), peakPremium: p.avgEntry,
            entryRSI: 50, entryMACD: 'neutral', entryMomentum: 'steady', entryMacro: 'neutral',
            entryThesisScore: 100, thesisHistory: [], agentHistory: [],
            realData: true, vix: _state.vix || 20, entryVIX: _state.vix || 20,
            expiryType: 'monthly', dteLabel: 'RECONCILED',
            partialClosed: false, isMeanReversion: false, trailStop: null,
            breakevenLocked: false, halfPosition: false,
            target: parseFloat((p.avgEntry * 1.5).toFixed(2)),
            stop: parseFloat((p.avgEntry * 0.65).toFixed(2)),
            takeProfitPct: TAKE_PROFIT_PCT, fastStopPct: STOP_LOSS_PCT, // individual leg: type unknown
          });
          used.add(i);
          _log("warn", `[RECONCILE] Reconstructed leg: ${p.ticker} ${p.optType.toUpperCase()} \$${p.strike} exp ${p.expDate} | ${Math.abs(p.qty)}x @ \$${p.avgEntry}`);
        }
      }
    }

    // BIL ETF removed - cash parked in spreads instead

    if (ghosts > 0 || orphans > 0) {
      _log("warn", `[RECONCILE] ${ghosts} ghost(s) removed, ${orphans} orphan(s) reconstructed`);
      await _redisSave(_state);
    }

    // - Re-pair existing individual legs into spreads -
    // Handles case where legs were previously reconciled individually
    // but should be tracked as a spread pair
    let pairsFound = 0;
    const toRemove = new Set();
    const toAdd    = [];

    for (let i = 0; i < _state.positions.length; i++) {
      if (toRemove.has(i)) continue;
      const a = _state.positions[i];
      if (a.isSpread) continue; // already a spread
      if (!a.contractSymbol) continue;

      for (let j = i + 1; j < _state.positions.length; j++) {
        if (toRemove.has(j)) continue;
        const b = _state.positions[j];
        if (b.isSpread) continue;
        if (!b.contractSymbol) continue;

        // Same ticker, same expiry, same option type, ~$10 apart, opposite direction
        const sameTickerExp = a.ticker === b.ticker && a.expDate === b.expDate && a.optionType === b.optionType;
        const strikeA = a.strike || 0;
        const strikeB = b.strike || 0;
        const width   = Math.abs(strikeA - strikeB);
        const widthOk = width >= 5 && width <= 100;
        // One should be long (no sellSymbol), one short (has sellSymbol or negative cost)
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

          // B3b: detect credit vs debit — price-based (matches B3a fix)
          // sellLeg.premium > buyLeg.premium → net credit received → isCreditSpread = true
          const _isCredit3b = sellLeg.premium > buyLeg.premium;
          const merged = {
            ticker:      a.ticker, optionType: a.optionType,
            isSpread:    true, isCreditSpread: _isCredit3b,
            buyStrike:   buyLeg.strike, sellStrike: sellLeg.strike,
            spreadWidth: width,
            buySymbol:   buyLeg.contractSymbol,
            sellSymbol:  sellLeg.contractSymbol,
            contractSymbol: buyLeg.contractSymbol,
            premium:     Math.max(0.01, netDebit),
            // D-FIX1b: same correction as 1a
            maxProfit:   _isCredit3b
              ? Math.max(0.01, netDebit)                                             // credit: max profit = credit received
              : parseFloat((width - Math.max(0.01, netDebit)).toFixed(2)),           // debit: max profit = width - cost
            maxLoss:     _isCredit3b
              ? parseFloat((width - Math.max(0.01, netDebit)).toFixed(2))            // credit: max loss = width - credit
              : Math.max(0.01, netDebit),                                            // debit: max loss = cost paid
            contracts:   Math.max(buyLeg.contracts || 1, sellLeg.contracts || 1),
            expDate:     a.expDate, expDays: a.expDays,
            cost:        parseFloat((Math.max(0.01, netDebit) * 100 * Math.max(buyLeg.contracts||1, sellLeg.contracts||1)).toFixed(2)),
            score:       Math.max(buyLeg.score || 75, sellLeg.score || 75),
            reasons:     ['Re-paired from individual legs'],
            openDate:    buyLeg.openDate || new Date().toISOString(),
            currentPrice: Math.max(0.01, curNet),
            peakPremium: Math.max(0.01, netDebit),
            entryRSI: buyLeg.entryRSI || 50, entryMACD: 'neutral',
            entryMomentum: 'steady', entryMacro: 'neutral',
            entryThesisScore: 100, thesisHistory: [], agentHistory: [],
            realData: true, vix: _state.vix || 20, entryVIX: _state.vix || 20,
            expiryType: 'monthly', dteLabel: 'RECONCILED-SPREAD',
            partialClosed: false, isMeanReversion: false, trailStop: null,
            breakevenLocked: false, halfPosition: false,
            target: parseFloat((Math.max(0.01, netDebit) * 1.5).toFixed(2)),
            stop:   parseFloat((Math.max(0.01, netDebit) * 0.65).toFixed(2)),
            takeProfitPct: _isCredit3b ? _calcTP(_state.vix) : TAKE_PROFIT_PCT, // B7c
            fastStopPct: STOP_LOSS_PCT,
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
    }

    _state.lastReconcile    = new Date().toISOString();
    _state.reconcileStatus  = ghosts === 0 && orphans === 0 && pairsFound === 0 ? "ok" : "warning";
    _state.orphanCount      = orphans;

  } catch(e) {
    _log("error", `[RECONCILE] Failed: ${e.message}`);
  }
}

async function syncPositionPnLFromAlpaca() {
  if (!ALPACA_KEY) return;
  try {
    const alpacaPositions = await alpacaGet("/positions");
    if (!alpacaPositions || !Array.isArray(alpacaPositions)) return;

    // Alpaca is the single source of truth for all financial data
    // Build lookup by symbol
    const alpacaBySymbol = {};
    for (const ap of alpacaPositions) {
      alpacaBySymbol[ap.symbol] = ap;
    }

    let updated = 0;
    for (const pos of _state.positions) {
      if (!pos.isSpread) {
        const sym = pos.contractSymbol || pos.buySymbol || pos.sellSymbol;
        if (!sym) continue;
        const ap = alpacaBySymbol[sym];
        if (!ap) continue;
        const curPrice = parseFloat(ap.current_price || 0);
        if (curPrice > 0) { pos.currentPrice = curPrice; pos.realData = true; }
        pos.unrealizedPnL = parseFloat(parseFloat(ap.unrealized_pl || 0).toFixed(2));
        updated++; continue;
      }
      if (!pos.buySymbol || !pos.sellSymbol) continue;
      const buyLeg  = alpacaBySymbol[pos.buySymbol];
      const sellLeg = alpacaBySymbol[pos.sellSymbol];
      if (!buyLeg || !sellLeg) continue;

      // ── Contracts: Alpaca is authoritative ─────────────────────────────
      // Use abs(qty) from the buy leg (long leg always positive qty)
      const alpacaContracts = Math.abs(parseInt(buyLeg.qty || 1));
      if (alpacaContracts !== pos.contracts) {
        _log("scan", `[ALPACA SYNC] ${pos.ticker} contracts: ${pos.contracts} → ${alpacaContracts} (Alpaca authoritative)`);
        pos.contracts = alpacaContracts;
      }

      // ── Current prices ──────────────────────────────────────────────────
      const buyPrice  = parseFloat(buyLeg.current_price  || 0);
      const sellPrice = parseFloat(sellLeg.current_price || 0);

      if (buyPrice > 0 && sellPrice > 0) {
        const netPrice = pos.isCreditSpread
          ? parseFloat((sellPrice - buyPrice).toFixed(2))   // cost to close
          : parseFloat((buyPrice  - sellPrice).toFixed(2)); // current value
        pos.currentPrice = netPrice;
        pos.realData     = true;
      }

      // ── P&L: sum both legs (Alpaca handles sign correctly) ──────────────
      const netPnL = parseFloat(buyLeg.unrealized_pl || 0) + parseFloat(sellLeg.unrealized_pl || 0);
      pos.unrealizedPnL = parseFloat(netPnL.toFixed(2));

      // ── Entry price / premium ───────────────────────────────────────────
      // Do NOT overwrite pos.premium from avg_entry_price — individual leg
      // avg_entry_price doesn't reflect the net credit/debit received at entry.
      // pos.premium is set correctly at fill confirmation and must be preserved.

      // ── Cost basis ──────────────────────────────────────────────────────
      // Credit spread cost = margin reserved = maxLoss (max risk)
      // Debit spread cost  = net debit paid  = premium × 100 × contracts
      if (pos.maxLoss > 0) {
        pos.cost = pos.isCreditSpread
          ? pos.maxLoss // credit: margin reserved
          : parseFloat((pos.premium * 100 * pos.contracts).toFixed(2)); // B5: debit = cash paid
      }

      // ── Max profit / max loss (always recalculate from Alpaca data) ─────
      const width = Math.abs((pos.buyStrike || 0) - (pos.sellStrike || 0));
      if (width > 0 && pos.premium > 0) {
        if (pos.isCreditSpread) {
          pos.maxProfit = parseFloat((pos.premium          * 100 * pos.contracts).toFixed(2));
          pos.maxLoss   = parseFloat(((width - pos.premium)* 100 * pos.contracts).toFixed(2));
        } else {
          pos.maxProfit = parseFloat(((width - pos.premium)* 100 * pos.contracts).toFixed(2));
          pos.maxLoss   = parseFloat((pos.premium          * 100 * pos.contracts).toFixed(2));
        }
      }

      // ── Breakeven ───────────────────────────────────────────────────────
      if (!pos.breakeven && pos.premium > 0) {
        if (pos.isCreditSpread) {
          pos.breakeven = pos.optionType === "put"
            ? parseFloat((pos.sellStrike - pos.premium).toFixed(2))
            : parseFloat((pos.sellStrike + pos.premium).toFixed(2));
        } else {
          pos.breakeven = pos.optionType === "put"
            ? parseFloat((pos.buyStrike  - pos.premium).toFixed(2))
            : parseFloat((pos.buyStrike  + pos.premium).toFixed(2));
        }
      }

      // ── dteLabel cleanup ────────────────────────────────────────────────
      if (pos.dteLabel === "RECONCILED-SPREAD") pos.dteLabel = "SPREAD-MONTHLY";

      updated++;
    }
    if (updated > 0) _markDirty();
  } catch(e) { _log("warn", `[ALPACA SYNC] syncPositionPnLFromAlpaca error: ${e.message}`); }
}

// =======================================================================
// ARGO CONTRACT SELECTION - v3.0
// One shared primitive: findContract()
// Replaces: getRealOptionsContract, getSpreadSellLeg, selectExpiry
// Used by: executeDebitSpread, executeIronCondor (executeCreditSpread has its own)
// =======================================================================

// -- B-S delta inversion -----------------------------------------------
// Returns the strike where a put (or call) has the given delta.
// Uses Abramowitz & Stegun rational approximation for invPhi.


module.exports = { runReconciliation, syncPositionPnLFromAlpaca, initReconciler };
