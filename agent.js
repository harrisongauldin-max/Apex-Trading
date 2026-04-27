// agent.js — ARGO V3.2
// Claude AI agent: macro analysis, position rescoring, morning briefing.
'use strict';
const fetch = require('node-fetch');
const { ANTHROPIC_API_KEY, ANTHROPIC_MODEL, PDT_RULE_ACTIVE, PDT_LIMIT,
        MS_PER_DAY, OVERNIGHT_INTERVAL, SAME_DAY_INTERVAL, TRIGGER_COOLDOWN_MS,
  AGENT_MACRO_CACHE_MS,
} = require('./constants');
const { state } = require('./state');
const { alpacaGet, getStockQuote, getStockBars, getIntradayBars } = require('./broker');
const { getAccountPhase, effectiveHeatCap , isMarketHours } = require('./signals');

// ─── Module-level cache ──────────────────────────────────────────
let _agentMacroCache = { result: null, fetchedAt: 0 };
let _agentMacroRunning = false; // mutex — prevents concurrent API calls on startup burst

// ─── Injected dependencies ───────────────────────────────────────
let _log        = (type, msg) => console.log(`[agent][${type}] ${msg}`);
let _markDirty  = () => {};
let _saveNow    = async () => {};
let _closePos   = async () => {};
let _isDayTrade = () => false;
let _countDT    = () => 0;
let _getMacro   = async () => ({});
let _calcRSI    = () => 50;
let _checkMacroShift = () => {};
let _withTimeout = (p) => p;

function initAgent({ logFn, markDirty, saveStateNow, closePosition,
                     isDayTrade, countRecentDayTrades, getMacroNews,
                     calcRSI, checkMacroShift, withTimeout } = {}) {
  if (logFn)               _log = logFn;
  if (markDirty)           _markDirty = markDirty;
  if (saveStateNow)        _saveNow = saveStateNow;
  if (closePosition)       _closePos = closePosition;
  if (isDayTrade)          _isDayTrade = isDayTrade;
  if (countRecentDayTrades) _countDT = countRecentDayTrades;
  if (getMacroNews)        _getMacro = getMacroNews;
  if (calcRSI)             _calcRSI = calcRSI;
  if (checkMacroShift)     _checkMacroShift = checkMacroShift;
  if (withTimeout)         _withTimeout = withTimeout;
}


// ─── Agent tool definitions (used when agent needs live data) ─────────────────
const AGENT_TOOLS = [
  { name: "getQuote",         description: "Get current live price and day change % for a stock ticker",
    input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] } },
  { name: "getLiveSignals",   description: "Get live technical signals for a stock: RSI, momentum, VWAP",
    input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] } },
  { name: "getPositionStatus",description: "Get full status of an open position including P&L, DTE, Greeks, entry reasons",
    input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] } },
  { name: "getMarketStatus",  description: "Get overall market status: SPY price/change, VIX, breadth, PDT remaining, cash",
    input_schema: { type: "object", properties: {} } },
  { name: "getIVRank",        description: "Get IV rank (0-100) for the market",
    input_schema: { type: "object", properties: {} } },
  { name: "getRegimeStatus",  description: "Get current regime class (A/B/C), days below 200MA, sustained VIX, SPY drawdown",
    input_schema: { type: "object", properties: {} } },
];
async function callClaudeAgent(systemPrompt, userPrompt, maxTokens = 800, useTools = false, enableCache = true, timeoutMs = 30000) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const messages = [{ role: "user", content: userPrompt }];

    // Prompt caching - system prompt is identical per call type, cache it
    // Cache writes: 125% of normal input price. Cache reads: 10% of normal input price.
    // Break-even: ~2 reads. After that, ~90% savings on input tokens.
    // getAgentMacroAnalysis runs ~80x/day - saves ~$1.50/day in input costs
    const systemBlock = enableCache
      ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
      : systemPrompt;

    const body = {
      model:      ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system:     systemBlock,
      messages,
    };
    if (useTools) body.tools = AGENT_TOOLS;

    const headers = {
      "x-api-key":         ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    };
    if (enableCache) headers["anthropic-beta"] = "prompt-caching-2024-07-31";

    const res = await _withTimeout(fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers,
      body: JSON.stringify(body),
    }), timeoutMs);

    if (!res.ok) {
      const err = await res.text();
      _log("warn", `[AGENT] API error ${res.status}: ${err.slice(0, 120)}`);
      return null;
    }

    const data = await res.json();

    // Handle tool use - agent wants to fetch live data
    if (useTools && data.stop_reason === "tool_use") {
      const toolCalls  = data.content.filter(b => b.type === "tool_use");
      const toolResults= await dispatchAgentTools(toolCalls);

      // Continue conversation with tool results
      const followMessages = [
        { role: "user",      content: userPrompt },
        { role: "assistant", content: data.content },
        {
          role: "user",
          content: toolCalls.map(tc => ({
            type:        "tool_result",
            tool_use_id: tc.id,
            content:     JSON.stringify(toolResults[tc.name + (tc.input.ticker ? '_' + tc.input.ticker : '')] || toolResults[tc.name] || {}),
          }))
        }
      ];

      const followHeaders = {
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      };
      if (enableCache) followHeaders["anthropic-beta"] = "prompt-caching-2024-07-31";
      const followRes = await _withTimeout(fetch("https://api.anthropic.com/v1/messages", {
        method:  "POST",
        headers: followHeaders,
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system: systemBlock, messages: followMessages }),
      }), timeoutMs);

      if (!followRes.ok) {
        const ferr = await followRes.text().catch(() => '');
        _log("warn", `[AGENT] Tool follow error ${followRes.status}: ${ferr.slice(0,80)}`);
        return null;
      }
      const followData = await followRes.json();
      const text = followData.content?.find(b => b.type === "text")?.text || "";
      return text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    }

    // Log cache performance when available
    if (enableCache && data.usage) {
      const u = data.usage;
      const cacheRead  = u.cache_read_input_tokens  || 0;
      const cacheWrite = u.cache_creation_input_tokens || 0;
      const uncached   = u.input_tokens || 0;
      if (cacheRead > 0 || cacheWrite > 0) {
        _log("scan", `[CACHE] read:${cacheRead} write:${cacheWrite} uncached:${uncached} - saved ~$${(cacheRead*3/1000000).toFixed(4)}`);
      }
    }
    // Normal text response
    const text = data.content?.find(b => b.type === "text")?.text || "";
    return text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  } catch(e) {
    _log("warn", `[AGENT] Call failed: ${e.message}`);
    return null;
  }
}

function stripThinking(raw) {
  if (!raw) return "";
  let clean = raw;
  if (clean.includes("<thinking>")) {
    clean = clean.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
  }
  return clean.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
}

async function getAgentDayPlan(scanType = "morning") {
  if (!ANTHROPIC_API_KEY) return null;

  const systemPrompt = `You are the head macro strategist for ARGO-V3.0, a systematic SPY/QQQ options spread trading system. Return ONLY valid JSON - no markdown, no preamble.

{"regime":"trending_bear"|"trending_bull"|"choppy"|"breakdown"|"recovery"|"neutral","signal":"strongly bearish"|"bearish"|"mild bearish"|"neutral"|"mild bullish"|"bullish"|"strongly bullish","confidence":"high"|"medium"|"low","entryBias":"puts_on_bounces"|"calls_on_dips"|"neutral"|"avoid","tradeType":"spread"|"credit"|"naked"|"none","suppressUntil":null|"HH:MM","riskLevel":"low"|"medium"|"high","vixOutlook":"spiking"|"elevated_stable"|"mean_reverting"|"falling","keyLevels":{"spySupport":null,"spyResistance":null},"catalysts":[],"reasoning":"2 sentences max","weeklyBias":"bullish"|"bearish"|"neutral","overnightMove":"string describing futures direction"}

Rules:
- suppressUntil: set to "HH:MM" ET if high-impact event today (CPI 08:30, FOMC 14:00, NFP 08:30) - ARGO-V3.0 will not enter before this time
- riskLevel high = FOMC day, CPI day, major geopolitical event - reduce position size
- entryBias puts_on_bounces = bearish trend, wait for intraday relief before entering puts
- entryBias calls_on_dips = bullish trend, wait for intraday weakness before entering calls
- tradeType naked = sharp mean-reversion expected (quick move), spread = grinding trend
- Focus on 3-10 day outlook, not just today`;

  // Fetch overnight context
  const [headlines, mktStatus] = await Promise.all([
    _getMacro(state).catch(() => ({ headlines: [] })),
    agentTool_getMarketStatus().catch(() => ({})),
  ]);
  const headlineList = (headlines.headlines || headlines.topStories || []).slice(0, 15);

  const userPrompt = `Pre-market ${scanType} assessment - ${new Date().toLocaleString('en-US', {timeZone:'America/New_York'})} ET

Market snapshot:
- VIX: ${mktStatus.vix || state.vix || '--'} | SPY: ${mktStatus.spy?.price || '--'} (${mktStatus.spy?.dayChangePct || '--'}% today)
- Breadth: ${mktStatus.breadth ? (mktStatus.breadth*100).toFixed(0)+'%' : '--'} | F&G: ${mktStatus.fearGreed || '--'}
- Open positions: ${(state.positions||[]).map(p => `${p.ticker}(${p.optionType==='put'?'P':'C'}${p.isSpread?'-SPRD':''})`).join(', ') || 'none'}

${headlineList.length > 0 ? 'Key headlines:\n' + headlineList.map((h,i) => `${i+1}. ${h}`).join('\n') : 'No headlines available'}

What is your strategic assessment for today's trading session?`;

  try {
    const raw = await callClaudeAgent(systemPrompt, userPrompt, 500, false);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.signal || !parsed.regime) return null;
    parsed.generatedAt = new Date().toISOString();
    parsed.scanType = scanType;
    state._dayPlan = parsed;
    state._dayPlanDate = new Date().toLocaleDateString('en-US', {timeZone:'America/New_York'});
    _log("macro", `[DAY PLAN] ${scanType.toUpperCase()} | ${parsed.regime} | ${parsed.signal} (${parsed.confidence}) | bias: ${parsed.entryBias} | risk: ${parsed.riskLevel}${parsed.suppressUntil ? ' | suppress until ' + parsed.suppressUntil : ''} | ${parsed.reasoning?.slice(0,80)}`);
    await _saveNow();
    return parsed;
  } catch(e) {
    _log("warn", `[DAY PLAN] ${scanType} failed: ${e.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// HEADLINE INTELLIGENCE SYSTEM
// Replaces keyword scoring as the macro signal source.
//
// Architecture (Silicon Valley panel approved):
//   1. Headline novelty detection — fuzzy dedup, skip agent if no new headlines
//   2. Emergency keyword triggers — 10 structural shock terms, force immediate call
//   3. Hold last signal with staleness cap — 90 min max, then force full analysis
//   4. No keyword scoring system — agent is the only macro signal
//
// State keys used:
//   state._headlineCache       — Set of normalized headline fingerprints (last 60)
//   state._headlineCacheTs     — Timestamp of last cache update
//   state._agentMacroHistory   — Last 10 agent calls (already implemented)
//   state._agentMacro          — Current agent macro signal
// ═══════════════════════════════════════════════════════════════════════════

// Emergency triggers — structural shocks that force immediate out-of-schedule agent call.
// These are directionally unambiguous and rare. They don't score — they wake the agent.
const EMERGENCY_TRIGGERS = [
  'fed emergency',    // emergency Fed action
  'emergency rate',   // out-of-cycle rate move
  'markets halted',   // market-wide halt (more specific than "circuit breaker")
  'market halted',    // exchange halt
  'trading halted',   // specific halt
  'flash crash',      // rapid market drop
  'margin calls',     // forced deleveraging
  'bank run us',      // US deposit flight (not general international banking news)
  'yen carry',        // carry trade unwind (Aug 2024 style)
  'lehman',           // systemic bank failure reference
  'systemic risk',    // contagion language
  'contagion',        // financial contagion
];

// Normalize a headline to a fingerprint for fuzzy deduplication.
// First 40 chars, lowercase, strip punctuation — catches same story from different sources.
function _normalizeHeadline(h) {
  return (h || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 40);
}

// Check headlines for emergency triggers — returns the trigger found or null.
function _checkEmergencyTriggers(headlines) {
  const text = headlines.join(' ').toLowerCase();
  return EMERGENCY_TRIGGERS.find(t => text.includes(t)) || null;
}

// Compute which headlines are genuinely new since the last agent call.
// Returns { newHeadlines, emergencyTrigger, hasNew }
function _computeHeadlineDelta(headlines) {
  if (!state._headlineCache) state._headlineCache = [];

  const fingerprints = headlines.map(_normalizeHeadline);
  const cachedSet    = new Set(state._headlineCache);
  const newOnes      = headlines.filter((h, i) => !cachedSet.has(fingerprints[i]));
  const emergencyTrigger = _checkEmergencyTriggers(newOnes);

  // Update cache — keep last 60 fingerprints (covers ~20 minutes of news at Alpaca's pace)
  const allFingerprints = [...state._headlineCache, ...fingerprints.filter(f => !cachedSet.has(f))];
  state._headlineCache  = allFingerprints.slice(-60);
  state._headlineCacheTs = Date.now();

  return {
    newHeadlines:    newOnes,
    newCount:        newOnes.length,
    emergencyTrigger,
    hasNew:          newOnes.length > 0,
  };
}

// Determine if the agent needs to run based on headline delta + staleness.
// Returns: { shouldRun, reason, isEmergency }
function _shouldRunMacroAgent(headlines) {
  const lastSignal    = state._agentMacro;
  const signalAgeMs   = lastSignal?.timestamp
    ? Date.now() - new Date(lastSignal.timestamp).getTime() : Infinity;
  const signalAgeMins = signalAgeMs / 60000;
  const MAX_STALE_MS  = 90 * 60 * 1000; // 90 minutes — hard staleness cap

  // Always run if no signal yet
  if (!lastSignal) return { shouldRun: true, reason: 'no_prior_signal', isEmergency: false };

  // Always run if signal is stale beyond 90 minutes
  if (signalAgeMs > MAX_STALE_MS) return { shouldRun: true, reason: `stale_${signalAgeMins.toFixed(0)}min`, isEmergency: false };

  // Compute headline delta
  const delta = _computeHeadlineDelta(headlines);

  // Emergency trigger — run immediately regardless of recency
  if (delta.emergencyTrigger) return { shouldRun: true, reason: `emergency:${delta.emergencyTrigger}`, isEmergency: true };

  // No new headlines — hold current signal
  if (!delta.hasNew) return { shouldRun: false, reason: 'no_new_headlines', isEmergency: false };

  // New headlines exist — run full analysis
  return { shouldRun: true, reason: `${delta.newCount}_new_headlines`, isEmergency: false };
}

async function getAgentMacroAnalysis(headlines, forceRun = false) {
  if (!ANTHROPIC_API_KEY || !headlines || headlines.length === 0) return null;

  // ── Headline delta gate — skip if nothing new, unless forced ─────────────
  const deltaCheck = _shouldRunMacroAgent(headlines);
  if (!forceRun && !deltaCheck.shouldRun) {
    // No new headlines and signal is fresh — hold current signal
    _log("scan", `[AGENT] Macro skipped — ${deltaCheck.reason} (signal: ${state._agentMacro?.signal || 'none'} age: ${state._agentMacro?.timestamp ? ((Date.now() - new Date(state._agentMacro.timestamp).getTime())/60000).toFixed(0) : '?'}min)`);
    return state._agentMacro || null; // return held signal
  }

  // Return cached result if fresh enough and not emergency — check BEFORE logging
  // (prevents "Running macro analysis" log spam when cache is valid)
  if (!deltaCheck.isEmergency && _agentMacroCache.result && Date.now() - _agentMacroCache.fetchedAt < AGENT_MACRO_CACHE_MS) {
    return _agentMacroCache.result;
  }

  // Mutex: if another call is already in-flight, return cache (even if stale) rather than
  // firing a second concurrent API call. On startup burst, 50+ parallel scan init calls
  // would all pass the cache check simultaneously before any call populates it.
  // EXCEPTION: emergencies bypass the mutex — a VIX spike or ceasefire needs fresh analysis,
  // not a stale "mild bullish" signal from 3 hours ago.
  if (_agentMacroRunning && !deltaCheck.isEmergency) {
    if (_agentMacroCache.result) {
      _log("scan", `[AGENT] Macro analysis in-flight — returning cached result (age: ${Math.round((Date.now() - _agentMacroCache.fetchedAt)/60000)}min)`);
      return _agentMacroCache.result;
    }
    // No cache yet and another call is running — wait briefly then return null
    _log("scan", `[AGENT] Macro analysis in-flight on startup — skipping duplicate call`);
    return null;
  }

  if (deltaCheck.isEmergency) {
    _log("macro", `[AGENT] ⚠️ EMERGENCY TRIGGER: "${deltaCheck.reason}" — forcing immediate full analysis`);
  } else {
    _log("scan", `[AGENT] Running macro analysis — reason: ${deltaCheck.reason}`);
  }
  _agentMacroRunning = true;
  try { // outer try/finally guarantees mutex release even if prompt construction throws
  const systemPrompt = `You are the head macro strategist for ARGO-V3.2, a systematic SPY/QQQ/GLD/TLT/XLE options spread trading system. Return ONLY valid JSON - no markdown, no preamble.

RESPONSE SCHEMA:
{"signal":"strongly bearish"|"bearish"|"mild bearish"|"neutral"|"mild bullish"|"bullish"|"strongly bullish","modifier":-20to20,"confidence":"high"|"medium"|"low","mode":"defensive"|"cautious"|"normal"|"aggressive","reasoning":"3 sentences: (1) current regime assessment, (2) key risk or catalyst, (3) implication for ARGO entries","regime":"trending_bear"|"trending_bull"|"choppy"|"breakdown"|"recovery"|"neutral","regimeDuration":"intraday"|"1-3 days"|"3-7 days"|"1-2 weeks"|"multi-week","entryBias":"puts_on_bounces"|"calls_on_dips"|"neutral"|"avoid","tradeType":"spread"|"credit"|"naked"|"none","vixOutlook":"spiking"|"elevated_stable"|"mean_reverting"|"falling"|"unknown","keyLevels":{"spySupport":null,"spyResistance":null},"catalysts":[],"bearishTickers":[],"bullishTickers":[],"themes":[],"exitUrgency":"hold"|"monitor"|"trim"|"exit","positionSizeMult":0.25|0.5|0.75|1.0|1.25|1.5,"schemaVersion":2}

FIELD RULES:
- regime: what SPY does next 3-10 days (not just today)
- entryBias: puts_on_bounces=confirmed bear trend, wait for intraday relief rallies to enter puts; calls_on_dips=confirmed bull, wait for weakness; neutral=no directional edge; avoid=too uncertain
- tradeType: spread=grinding directional trend (preferred), credit=elevated IV premium collection, naked=sharp mean-reversion only, none=unclear
- vixOutlook: spiking=flash crash risk, buy protection; elevated_stable=credit spread environment; mean_reverting=VIX coming off highs; falling=avoid puts, IV crush risk
- exitUrgency: hold=thesis fully intact; monitor=watch closely, may need to act; trim=close half position; exit=close all immediately
- positionSizeMult: 0.25=capital preservation, 0.5=cautious, 0.75=moderate, 1.0=normal conviction, 1.25=high conviction, 1.5=maximum conviction
- modifier: -20=maximum bearish boost to scoring, 0=neutral, +20=maximum bullish boost. Applies to entry scoring.
- schemaVersion: always 2

ARGO SYSTEM CONTEXT (static — use for position sizing and exit decisions):
Instruments: SPY, QQQ (primary — correlated 0.90+), GLD (safe haven / inflation hedge), TLT (rates / flight to quality), XLE (energy — oil-correlated)
Strategy: Regime B (bear trend, VIX>25) = bear call credit spreads as primary + debit puts on intraday bounces. Regime A (bull, VIX<20) = bull put credit spreads + debit calls on dips.
Credit spreads: sell OTM call (0.20-0.35 delta), buy further OTM call (protection). Collect premium. Profit when underlying stays BELOW short strike at expiration. Max profit = net credit. Max loss = spread width minus credit.
Take profit: 30-50% of max profit (time-based). Stop loss: 50% of max loss OR 2x credit received.
DTE targets: 28-45 days. Greeks: negative delta (bear call = short calls), positive theta (time decay works for us daily), negative vega (lower IV = better).
Position sizing: 1-2 contracts per instrument. Max heat 60% of portfolio. No more than 1 position per instrument direction simultaneously.
Exit triggers in priority order: (1) VIX spike +8 points intraday, (2) SPY macro reversal +2.5% from prior close closes losing puts, (3) agent EXIT + high confidence + losing, (4) take profit, (5) stop loss, (6) 48hr time-based stop.
Key risk: credit spreads lose when underlying RALLIES through the short strike. Bear call spread on QQQ: if QQQ rallies above short strike before expiration, full max loss.
When exitUrgency=exit: positions are actively being evaluated for closure. Be direct about why.
When exitUrgency=trim: recommend closing the weakest position first (highest loss % or most threatened strike).

REGIME CLASSIFICATION REFERENCE:
- Regime A (Bull): SPY above 200MA + VIX sustained < 20. Strategy = bull put spreads, debit calls on dips. Puts fight the trend — higher entry bar required.
- Regime A (Bull): SPY above 200MA AND VIX < 20. Bull put spreads, debit calls on dips. No bear call spreads.
- Regime A_elevated (Transitional): SPY above 200MA AND VIX 20-28. Market in uptrend but elevated fear. NO bear call spreads — rally risk too high. Neutral credit spreads or wait. VIX elevated during a bull rally means IV is elevated, NOT that market is bearish.
- Regime B1 (Early Bear): SPY below 200MA < 5 days AND VIX 24-26. Bear call spreads with caution. Puts-on-bounces only on confirmed intraday bounces.
- Regime B2 (Confirmed Bear): SPY below 200MA 5+ days AND VIX sustained >= 26. Full bear call spread mode. Best credit spread environment.
- Regime C (Crisis): SPY drawdown > 20% AND VIX > 35 AND duration > 10 days. Credit structures only. Post-crisis lock 10 days after recovery.
CRITICAL: If SPY is above its 200-day moving average, DO NOT recommend bear call spreads regardless of VIX level. High VIX during a bull rally = mean-reversion opportunity for CALLS, not puts.

INSTRUMENT-SPECIFIC RULES:
- SPY/QQQ: Primary instruments. Correlated — only one position per direction simultaneously unless score >= 80. Bear calls preferred in Regime B.
- GLD: Safe haven. Enters bear call spreads when DXY strengthening + SPY weak. Pre-market gate: no entry if GLD gap > 1.5% against thesis direction.
- TLT: Bond proxy. Call spreads only when SPY equity weakness signals flight to quality. RSI must be below 65 (not overbought). Daily RSI gates apply.
- XLE: Energy/oil proxy. Debit puts only (no credit spreads — oil spike risk too high). Entry requires oil trend weakness and RSI confirmation.

SCORING CONTEXT:
- Entry scores 0-100. Minimum 55-65 (paper) / 65-75 (live) depending on trade type.
- Credit spread scorer uses: IVR quality, trend alignment, VIX stability, OTM safety margin, theta decay quality.
- Agent signal is a TIMING signal — bearish confirms direction, does not override hard gates (RSI, heat cap, PDT).
- positionSizeMult from this response is applied to contract sizing. 1.0 = standard 1-2 contracts. 1.5 = max 2 contracts regardless.
- RECONCILIATION: You will be shown the overnight/pre-market assessment in the user prompt. Your signal should be directionally consistent with it unless intraday price action clearly contradicts it. Both you and the overnight digest read the same headlines — if you diverge, justify it explicitly in your reasoning field.`;

  // Pre-fetch market status so agent doesn't need to tool-call for it
  const mktStatus = await agentTool_getMarketStatus().catch(() => ({}));

  // - AG-1: Gap status - tells agent if today opened with a gap -
  const spyBarsForAgent = await getStockBars("SPY", 60).catch(() => []);
  let gapStatus = "no_gap";
  if (spyBarsForAgent.length >= 2) {
    const prevClose   = spyBarsForAgent[spyBarsForAgent.length-2].c;
    const todayOpen   = spyBarsForAgent[spyBarsForAgent.length-1].o;
    const todayClose  = spyBarsForAgent[spyBarsForAgent.length-1].c;
    const gapPctAgent = (todayOpen - prevClose) / prevClose;
    const isHolding   = Math.abs(todayClose - todayOpen) / Math.abs(todayOpen - prevClose || 1) < 0.5;
    if (gapPctAgent > 0.01) gapStatus = isHolding ? "gap_up_holding" : "gap_up_fading";
    else if (gapPctAgent < -0.01) gapStatus = isHolding ? "gap_down_holding" : "gap_down_fading";
  }

  // - AG-2: SPY 50MA/200MA injection -
  let spyMA50 = null, spyMA200 = null, spyMA50Slope = null;
  // Also stored in state._spyMA50 so TLT gate can access it in scan loop
  if (spyBarsForAgent.length >= 50) {
    const closes50  = spyBarsForAgent.slice(-50).map(b => b.c);
    spyMA50  = parseFloat((closes50.reduce((s,c)=>s+c,0)/50).toFixed(2));
    const prev50Closes = spyBarsForAgent.length >= 55 ? spyBarsForAgent.slice(-55,-5).map(b=>b.c) : closes50;
    const prevMA50 = prev50Closes.reduce((s,c)=>s+c,0)/prev50Closes.length;
    spyMA50Slope = ((spyMA50 - prevMA50) / prevMA50 * 100).toFixed(2);
  }
  if (spyBarsForAgent.length >= 200) {
    const closes200 = spyBarsForAgent.slice(-200).map(b => b.c);
    spyMA200 = parseFloat((closes200.reduce((s,c)=>s+c,0)/200).toFixed(2));
  }
  const spyPrice = mktStatus.spy?.price || state._liveSPY || 0;
  const spyVsMA50  = spyMA50  ? ((spyPrice - spyMA50)  / spyMA50  * 100).toFixed(1) : null;
  const spyVsMA200 = spyMA200 ? ((spyPrice - spyMA200) / spyMA200 * 100).toFixed(1) : null;
  // Persist SPY 50MA for TLT gate and 200MA regime filter
  if (spyMA50)  state._spyMA50  = spyMA50;
  if (spyMA200) state._spyMA200 = spyMA200;

  // - 1C: REGIME DURATION TRACKING -
  // Track how long SPY has been below 200MA, sustained VIX, SPY drawdown
  // Powers regime A/B/C classification and strategy selection
  const spyBelowNow = spyMA200 && spyPrice && spyPrice < spyMA200;
  if (spyBelowNow) {
    state._regimeDuration = (state._regimeDuration || 0) + 1; // days below 200MA
  } else {
    state._regimeDuration = 0; // reset when SPY recovers above 200MA
  }
  // 5-day rolling VIX average (sustained fear vs spike)
  if (!state._vixHistory) state._vixHistory = [];
  state._vixHistory.push(mktStatus.vix || state.vix || 20);
  if (state._vixHistory.length > 5) state._vixHistory.shift();
  state._vixSustained = parseFloat((state._vixHistory.reduce((s,v)=>s+v,0)/state._vixHistory.length).toFixed(1));
  // SPY drawdown from 52-week high
  const spy52wHigh = spyBarsForAgent.length > 0 ? Math.max(...spyBarsForAgent.map(b=>b.h)) : spyPrice;
  state._spyDrawdown = spy52wHigh > 0 ? parseFloat(((spyPrice - spy52wHigh) / spy52wHigh * 100).toFixed(1)) : 0;
  // Regime classification: A (bull), B (bear/trending), C (crisis)
  // Regime A: SPY above 200MA AND VIX sustained < 20 (clear bull)
  // Regime A_elevated: SPY above 200MA AND VIX 20-28 — elevated fear but uptrend intact
  //   → This is NOT Regime B. Sell premium both directions, no directional bear bias.
  //   → Credit spreads valid but must be strikes-based not directional.
  // Regime B: SPY below 200MA (or recently, within 3 days) AND VIX sustained > 24
  //   → True bear trend with elevated fear confirming.
  // Regime C: Deep bear — SPY down 20%+ AND VIX > 35 AND duration > 10 days
  const regimeA = !spyBelowNow && state._vixSustained < 20;
  const regimeC = state._spyDrawdown < -20 && state._vixSustained > 35 && state._regimeDuration > 10;
  // Regime B requires BOTH price evidence (below 200MA or recently so) AND sustained fear
  // NOT just "not A and not C" — that catch-all was classifying SPY-at-ATH as bear trend
  const hasBearPriceEvidence = spyBelowNow || (state._regimeDuration || 0) > 0;
  const hasSustainedFear     = (state._vixSustained || state.vix || 20) > 24;
  const regimeB = !regimeA && !regimeC && hasBearPriceEvidence && hasSustainedFear;
  // Regime A_elevated: above 200MA but VIX elevated (20-28) — transitional, not bear
  // Treat as Regime A for strategy selection but with tighter sizing
  // (falls through to regimeA=false, regimeB=false → defaults to A in classification)
  const prevRegimeClass = state._regimeClass;
  state._regimeClass = regimeC ? "C" : regimeB ? "B" : "A";
  // Regime change B→A: reset signal anchor to neutral so the agent re-evaluates fresh
  // Without this, the stability system keeps the old bearish signal locked in for 2+ tiers
  // even though the market context has fundamentally changed
  // Clear signal anchor and history on ANY regime transition — stale history from the
  // previous regime anchors the agent to wrong framing (bullish history in a new bear regime,
  // bearish history in a new bull regime). Both directions need a clean slate.
  if (prevRegimeClass !== state._regimeClass && prevRegimeClass) {
    if (state._agentMacro) {
      _log("warn", `[REGIME] ${prevRegimeClass}→${state._regimeClass} transition — resetting signal anchor from '${state._agentMacro.signal}' to neutral`);
      state._agentMacro = { ...state._agentMacro, signal: "neutral", modifier: 0, _stabilityHeld: false };
    }
    if (state._agentMacroHistory && state._agentMacroHistory.length > 0) {
      _log("warn", `[REGIME] ${prevRegimeClass}→${state._regimeClass} transition — clearing ${state._agentMacroHistory.length} stale history entries`);
      state._agentMacroHistory = [];
    }
  }

  // ── V3.2: B1/B2 sub-regime split (panel approved) ───────────────────────
  // B1 = early/mild bear: duration < 5d OR VIX < 26. Higher min score, tighter reversal threshold.
  // B2 = confirmed bear: duration >= 5d AND VIX >= 26. Full puts-on-bounces conviction.
  if (regimeB) {
    const isB2 = (state._regimeDuration || 0) >= 5 && (state._vixSustained || state.vix) >= 26;
    state._regimeSubClass = isB2 ? "B2" : "B1";
  } else {
    state._regimeSubClass = null;
  }

  // ── V3.2: Post-crisis recovery lock (panel unanimous) ───────────────────
  // When exiting Regime C → B, block debit puts for 10 trading days.
  // Post-crisis V-recoveries are violent upside — puts-on-bounces fires on the wrong side.
  if (prevRegimeClass === "C" && state._regimeClass === "B") {
    if (!state._postCrisisLock) {
      // 10 calendar days ≈ 7 trading days. For true 10 trading days use 14 calendar days.
      // Using 14 calendar days to ensure full 10-trading-day protection window.
      const TEN_TRADING_DAYS_MS = 3 * 24 * 3600 * 1000; // panel: 10 trading days → 3 days post-crisis lock
      state._postCrisisLock        = true;
      state._postCrisisLockExpiry  = Date.now() + TEN_TRADING_DAYS_MS;
      _log("warn", "[REGIME] C→B transition detected — post-crisis lock active for 10 trading days. Debit puts blocked.");
      _markDirty();
    }
  }
  // Auto-lift post-crisis lock when expired
  if (state._postCrisisLock && state._postCrisisLockExpiry && Date.now() > state._postCrisisLockExpiry) {
    state._postCrisisLock       = false;
    state._postCrisisLockExpiry = null;
    _log("warn", "[REGIME] Post-crisis lock expired — puts-on-bounces re-enabled.");
    _markDirty();
  }
  // Also lift if agent returns trending_bull with high confidence (recovery confirmed)
  // Post-crisis early lift: agent must confirm recovery via SIGNAL field ("strongly bullish")
  // OR via REGIME label ("trending_bull") — both are valid confirmation signals
  // Bug fix: original code read .signal but checked "trending_bull" which is a .regime value
  const _agentSigNow  = (state._agentMacro || {}).signal  || "";
  const _agentRegNow  = (state._agentMacro || {}).regime  || "";
  const _agentConfNow = (state._agentMacro || {}).confidence || "";
  const _agentConfirmsBull = (_agentSigNow === "strongly bullish" || _agentRegNow === "trending_bull");
  if (state._postCrisisLock && _agentConfirmsBull && _agentConfNow === "high") {
    state._postCrisisLock       = false;
    state._postCrisisLockExpiry = null;
    _log("warn", `[REGIME] Post-crisis lock lifted early — agent confirms bull recovery (signal: ${_agentSigNow}, regime: ${_agentRegNow}, confidence: ${_agentConfNow}).`);
    _markDirty();
  }

  // _regimeDuration: days SPY has been below 200MA - increment once per trading day
  // Used for regime duration boost in scoring (+5 after 3d, +10 after 5d, +15 after 10d)
  if (!state._regimeDurationDate) state._regimeDurationDate = "";
  const todayDateStr = new Date().toISOString().slice(0, 10);
  if (spyBelowNow && state._regimeDurationDate !== todayDateStr) {
    state._regimeDuration = (state._regimeDuration || 0) + 1;
    state._regimeDurationDate = todayDateStr;
  } else if (!spyBelowNow) {
    state._regimeDuration = 0; // reset when SPY recovers above 200MA
    state._regimeDurationDate = "";
  }

  _log("scan", `[REGIME] Class:${state._regimeClass} | Below200MA:${state._regimeDuration}d | VIX5d:${state._vixSustained} | SPYdd:${state._spyDrawdown}%`);

  // - AG-3: Account drawdown context -
  const acctBaseline = state.accountBaseline || state.peakCash || 10000;
  const acctCurrent  = state.cash + (state.positions||[]).reduce((s,p)=>s+p.cost,0);
  const acctDrawdown = ((acctCurrent - acctBaseline) / acctBaseline * 100).toFixed(1);
  const acctPhaseNow = getAccountPhase();

  // - AG-4: Portfolio heat -
  const openCost  = (state.positions||[]).reduce((s,p)=>s+p.cost,0);
  const heatPctNow = acctBaseline > 0 ? (openCost / acctBaseline * 100).toFixed(0) : 0;
  const heatCapNow = (effectiveHeatCap() * 100).toFixed(0);

  // - AG-4b: Keyword macro pre-score — structural signal floor -
  // Fetch the keyword-scored macro signal before agent call.
  // Used as a floor: if keywords fire strongly bullish/bearish, agent can moderate
  // but cannot zero it out entirely. Prevents agent from suppressing clear fundamental signals.
  let keywordMacroScore = 0;
  let keywordMacroSignal = "neutral";
  try {
    const kwResult = await _getMacro(state).catch(() => null);
    if (kwResult && kwResult.scoreModifier !== undefined) {
      keywordMacroScore  = kwResult.scoreModifier || 0;
      keywordMacroSignal = kwResult.signal        || "neutral";
    }
  } catch(e) { /* non-critical — proceed without keyword floor */ }

  // - AG-5: Correlation alert -
  const openPutsCount  = (state.positions||[]).filter(p=>p.optionType==="put").length;
  const openCallsCount = (state.positions||[]).filter(p=>p.optionType==="call").length;
  const correlAlert    = openPutsCount >= 3 && openCallsCount === 0 ? "all_puts"
                       : openCallsCount >= 3 && openPutsCount === 0 ? "all_calls"
                       : "balanced";

  // ── Market structure data — all pre-computed in state, zero cost to include ──
  const pcr          = state._pcr?.pcr     || null;
  const termStruct   = state._termStructure || null;
  const breadthTrend = state._breadthTrend  || null;
  const breadthMom   = state._breadthMomentum || 0;
  const zweig        = state._zweigThrust   || null;
  const skew         = state._skew?.skew    || null;

  // Sector relative strength (if tracked)
  const sectorStr = state._sectorRS
    ? Object.entries(state._sectorRS).map(([s,v]) => `${s}:${v>0?'+':''}${v.toFixed(1)}%`).join(' ')
    : null;

  // Last 3 agent calls — give the agent memory of its own recent signals
  const recentCalls  = (state._agentMacroHistory || []).slice(-3);
  const historyLines = recentCalls.map((h,i) => {
    const ago = Math.round((Date.now() - new Date(h.ts).getTime()) / 60000);
    return `  ${ago}min ago: ${h.signal} (${h.confidence}) — ${h.reasoning?.slice(0,60) || ''}`;
  }).join('\n');

  // Overnight/pre-market scan context — inject so macro agent sees the strategic assessment
  // Without this, the macro agent and overnight digest operate independently on the same
  // headlines and often reach contradictory conclusions (e.g. overnight=trending_bear,
  // macro=neutral on the same ceasefire news). Injecting gives the macro agent a prior.
  const overnightScan = state._overnightScan;
  const overnightCtx = overnightScan && overnightScan.generatedAt
    ? (() => {
        const hoursAgo = ((Date.now() - new Date(overnightScan.generatedAt).getTime()) / 3600000).toFixed(1);
        return `  ${overnightScan.scanType || 'overnight'} (${hoursAgo}h ago): ${overnightScan.signal} / ${overnightScan.regime} / bias:${overnightScan.entryBias} — ${(overnightScan.reasoning||'').slice(0,80)}`;
      })()
    : null;

  // Open positions with full context for position-aware reasoning
  const posLines = (state.positions||[]).map(p => {
    const daysOpen = ((Date.now() - new Date(p.openDate||0).getTime()) / MS_PER_DAY).toFixed(1);
    const pnlPct   = p.currentPrice && p.premium
      ? ((p.currentPrice - p.premium) / p.premium * 100).toFixed(1) + '%' : '?';
    if (p.isCreditSpread) {
      return `  ${p.ticker} BEAR CALL $${p.sellStrike}/$${p.buyStrike} exp ${p.expDate} | ${daysOpen}d open | P&L: ${pnlPct} | VIX at entry: ${p.entryVIX||'?'}`;
    }
    return `  ${p.ticker} ${(p.optionType||'').toUpperCase()}${p.isSpread?'-SPRD':''} | ${daysOpen}d open | P&L: ${pnlPct}`;
  }).join('\n') || '  none';

  const userPrompt = `Market analysis — ${new Date().toLocaleTimeString('en-US', {timeZone:'America/Chicago'})} CT

PRICE & REGIME:
- SPY: $${spyPrice||'--'} (${mktStatus.spy?.dayChangePct||'--'}% today) | Gap: ${gapStatus}
- SPY vs 50MA: ${spyVsMA50||'--'}% (slope: ${spyMA50Slope||'--'}%/50d) | vs 200MA: ${spyVsMA200||'--'}%
- Regime: ${state._regimeClass||'A'}${state._regimeSubClass||''} | ${state._regimeDuration||0}d below 200MA | SPY drawdown: ${state._spyDrawdown||'--'}%
- SPY vs 200MA: ${spyVsMA200 !== null ? (parseFloat(spyVsMA200) > 0 ? 'ABOVE by ' + spyVsMA200 + '% — bull uptrend, NOT a bear regime' : 'BELOW by ' + Math.abs(spyVsMA200) + '% — bear regime confirmed') : 'unknown'}

VOLATILITY & FLOW:
- VIX: ${mktStatus.vix||state.vix||20} (5d avg: ${state._vixSustained||'--'}) | IV Rank: ${state._ivRank||'--'} (${state._ivEnv||'--'})
- VIX term structure: ${termStruct ? `near ${(termStruct.nearVol*100).toFixed(1)}% / far ${(termStruct.farVol*100).toFixed(1)}% — ${termStruct.structure}` : '--'}
- Put/Call Ratio: ${pcr||'--'} | Skew: ${skew||'--'} | Credit call mode: ${state.vix>=25&&(state._regimeClass==='B'||state._regimeClass==='C')?'ACTIVE':'inactive'}

BREADTH & SENTIMENT:
- Breadth: ${mktStatus.breadth?(mktStatus.breadth*100).toFixed(0)+'%':'--'} (trend: ${breadthTrend||'--'} | momentum: ${breadthMom>0?'+':''}${breadthMom})
- Fear&Greed: ${mktStatus.fearGreed||'--'} | Zweig thrust: ${zweig?JSON.stringify(zweig):'none'}
${sectorStr ? `- Sector RS: ${sectorStr}` : ''}

OPEN POSITIONS (${(state.positions||[]).length} total | heat: ${heatPctNow}%/${heatCapNow}% cap):
${posLines}

ACCOUNT:
- Cash: $${acctCurrent.toFixed(0)} (${acctDrawdown}% vs baseline) | Phase: ${acctPhaseNow}
- Portfolio: ${openPutsCount}P / ${openCallsCount}C | Correlation alert: ${correlAlert}

YOUR RECENT SIGNALS (last 3 calls):
${historyLines || '  no history yet'}

OVERNIGHT/PRE-MARKET ASSESSMENT (strategic prior — reconcile your signal with this):
${overnightCtx || '  none — first scan of day or overnight scan unavailable'}

KEYWORD PRE-SCORE (rule-based headline analysis before your assessment):
- Signal: ${keywordMacroSignal} | Modifier: ${keywordMacroScore > 0 ? '+' : ''}${keywordMacroScore}
- Your modifier should stay within 10 points of this unless you have strong justification.

TOP HEADLINES (${headlines.length} total, newest first):
${headlines.slice(0, 20).map((h, i) => (i+1) + '. ' + h).join('\n')}

Respond with ONLY the JSON object. No words before or after.`;

  // AG-8: Track agent health
  if (!state._agentHealth) state._agentHealth = { calls: 0, successes: 0, timeouts: 0, parseErrors: 0, lastSuccess: null };
  state._agentHealth.calls++;

  // Panel decision (7/7): disable tools on macro analysis - all data pre-injected.
  // useTools=true caused 2 sequential round-trips (4.9% timeout rate).
  // Pre-injected: VIX, SPY, MAs, breadth, regime, IV rank, headlines, positions.
  // Tools kept on rescore/briefing where live per-ticker data adds real value.
  _log("scan", `[AGENT] Macro call - useTools:false (pre-injected data sufficient)`);
  const raw = await callClaudeAgent(systemPrompt, userPrompt, 1200, false, true, 30000); // useTools=false - single round-trip
  if (!raw) {
    state._agentHealth.timeouts++;
    _log("warn", `[AGENT HEALTH] Timeout/null - ${state._agentHealth.timeouts} timeouts of ${state._agentHealth.calls} calls`);
    return null;
  }
  try {
    // Strip extended thinking tags - model may prepend <thinking>...</thinking> before JSON
    let cleanRaw = raw || "";
    if (cleanRaw.includes("<thinking>")) {
      cleanRaw = cleanRaw.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
      _log("warn", `[AGENT] Stripped <thinking> block - model outputting chain-of-thought before JSON`);
    }
    cleanRaw = cleanRaw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    // V2.84: If response starts with prose instead of {, extract the JSON object
    // Handles "Looking at the market..." preamble before the actual JSON
    if (!cleanRaw.startsWith("{")) {
      const jsonStart = cleanRaw.indexOf("{");
      const jsonEnd   = cleanRaw.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        _log("warn", `[AGENT] Response started with prose - extracting JSON from position ${jsonStart}`);
        cleanRaw = cleanRaw.slice(jsonStart, jsonEnd + 1);
      }
    }
    const parsed = JSON.parse(cleanRaw);
    // Validate required fields
    if (!parsed.signal || parsed.modifier === undefined) {
      state._agentHealth.parseErrors++;
      _log("warn", `[AGENT HEALTH] Parse error - missing required fields. Raw: ${raw?.slice(0,60)}`);
      return null;
    }
    // Resolve signal/mode contradictions — agent occasionally returns internally inconsistent JSON
    // (e.g. signal: "strongly bearish" but mode: "aggressive"). Signal is the primary field;
    // mode must be consistent with it. This prevents puts from being blocked by a contradictory
    // "aggressive" mode while signal correctly says bearish.
    const _bearishSignals = ["strongly bearish","bearish","mild bearish"];
    const _bullishSignals  = ["strongly bullish","bullish","mild bullish"];
    if (_bearishSignals.includes(parsed.signal) && parsed.mode === "aggressive") {
      _log("warn", `[AGENT] Signal/mode contradiction: signal='${parsed.signal}' but mode='aggressive' — correcting to mode='cautious'`);
      parsed.mode = "cautious";
    }
    if (_bullishSignals.includes(parsed.signal) && parsed.mode === "defensive") {
      _log("warn", `[AGENT] Signal/mode contradiction: signal='${parsed.signal}' but mode='defensive' — correcting to mode='cautious'`);
      parsed.mode = "cautious";
    }
    state._agentHealth.successes++;
    state._agentHealth.lastSuccess = new Date().toISOString();
    const successRate = (state._agentHealth.successes / state._agentHealth.calls * 100).toFixed(0);
    _agentMacroCache = { result: parsed, fetchedAt: Date.now() };
    _agentMacroRunning = false; // release mutex — allow next call after cache is populated
    _log("macro", `[AGENT] Macro: ${parsed.signal} (${parsed.confidence}) | ${parsed.reasoning?.slice(0,80)} | health:${successRate}%`);

    // - Agent accuracy tracking (panel requirement) -
    // Record this call with current SPY price. A deferred job resolves it
    // 30min and 120min later to measure directional accuracy.
    // Accuracy = did SPY move in the direction the signal implied?
    // bearish/strongly bearish - expects SPY to fall
    // bullish/strongly bullish - expects SPY to rise
    // neutral/mild = no directional prediction - excluded from accuracy calc
    const spyNow = state._liveSPY || state.spy || 0;
    const isDirectional = !["neutral","mild bullish","mild bearish"].includes(parsed.signal);
    if (spyNow > 0 && isDirectional) {
      if (!state._agentAccuracy) state._agentAccuracy = { calls: 0, correct30: 0, correct120: 0, pending: [] };
      state._agentAccuracy.calls++;
      state._agentAccuracy.pending.push({
        id:         state._agentAccuracy.calls,
        timestamp:  Date.now(),
        signal:     parsed.signal,
        confidence: parsed.confidence,
        spyAtCall:  spyNow,
        resolved30:  false,
        resolved120: false,
      });
      // Cap pending list at 50 - resolved entries cleaned up by the deferred job
      if (state._agentAccuracy.pending.length > 50) {
        state._agentAccuracy.pending = state._agentAccuracy.pending.slice(-50);
      }
    }

    // ── Signal stability: only change if 2+ tiers different or structural event ──
    // Prevents flip-flopping between mild bearish/neutral within same hour on noise.
    const SIGNAL_TIERS = [
      "strongly bullish", "bullish", "mild bullish",
      "neutral",
      "mild bearish", "bearish", "strongly bearish"
    ];
    const prevSignal   = (state._agentMacro || {}).signal || "neutral";
    const prevTier     = SIGNAL_TIERS.indexOf(prevSignal);
    const newTier      = SIGNAL_TIERS.indexOf(parsed.signal);
    const tierDelta    = Math.abs(newTier - prevTier);
    // Structural events that always allow signal change regardless of tier delta
    const vixSpike     = (state.vix || 0) > (state._vixHistory?.slice(-2,-1)[0] || 0) + 3;
    const breadthColl  = (state._breadthMomentum || 0) < -20;
    const gapBig       = gapStatus.includes("gap_up") || gapStatus.includes("gap_down");
    const structEvent  = vixSpike || breadthColl || gapBig;
    // Emergency triggers (ceasefire, flash crash, circuit breaker, etc.) always bypass stability hold
    // These are genuinely market-moving events — holding a stale signal through them is wrong
    const wasEmergency = !!(deltaCheck && deltaCheck.isEmergency);
    // In Regime A (bull), use 1-tier threshold — signal should respond faster to improving conditions
    // In Regime B/C (bear/crisis), keep 2-tier threshold — prevent noise flips in volatile downtrends
    const stabilityThreshold = (state._regimeClass === "A") ? 1 : 2;
    if (tierDelta < stabilityThreshold && !structEvent && !wasEmergency && prevSignal !== "neutral" && recentCalls.length >= 2) {
      // Hold previous signal — change is within noise band
      _log("macro", `[AGENT STABILITY] Signal held at '${prevSignal}' — new '${parsed.signal}' is only ${tierDelta} tier(s) different (threshold: ${stabilityThreshold}, regime: ${state._regimeClass || 'A'})`);
      parsed.signal   = prevSignal;
      parsed.modifier = (state._agentMacro || {}).modifier || parsed.modifier;
      parsed._stabilityHeld = true;
    } else if (tierDelta >= 2 || structEvent) {
      _log("macro", `[AGENT STABILITY] Signal changed ${prevSignal} → ${parsed.signal} (${tierDelta} tiers${structEvent?' + structural event':''})`);
    }

    // ── Keyword floor: prevent agent from zeroing out strong fundamental signals ──
    // If keyword pre-score is strongly directional (|modifier| >= 10) and agent
    // output is neutral (modifier near 0), apply a floor of 1/3 of keyword signal.
    // This prevents the agent from completely suppressing earnings beats, buybacks, etc.
    // Agent reasoning still dominates — this just prevents full suppression.
    if (Math.abs(keywordMacroScore) >= 10 && Math.abs(parsed.modifier || 0) < 5) {
      const floor = Math.round(keywordMacroScore / 3);
      _log("macro", `[AGENT] Keyword floor applied: agent modifier ${parsed.modifier||0} → ${floor} (keyword signal: ${keywordMacroScore})`);
      parsed.modifier = floor;
    }

    // ── Agent macro history — last 10 calls for context injection ──────────
    if (!state._agentMacroHistory) state._agentMacroHistory = [];
    // Cap at 10 entries — prevents unbounded Redis growth over a full trading day
    if (state._agentMacroHistory.length >= 10) state._agentMacroHistory = state._agentMacroHistory.slice(-9);
    state._agentMacroHistory.push({
      ts:         new Date().toISOString(),
      signal:     parsed.signal,
      confidence: parsed.confidence,
      reasoning:  parsed.reasoning,
      modifier:   parsed.modifier,
    });
    if (state._agentMacroHistory.length > 10) {
      state._agentMacroHistory = state._agentMacroHistory.slice(-10);
    }

    _checkMacroShift(parsed.signal);
    return parsed;
  } catch(e) {
    _agentMacroRunning = false; // release mutex on JSON parse error
    state._agentHealth.parseErrors++;
    _log("warn", `[AGENT HEALTH] JSON parse exception: ${e.message} | Raw: ${raw?.slice(0,60)}`);
    return null;
  }
  } catch(outerErr) {
    // Catches prompt construction errors or any throw before the inner try/catch
    _agentMacroRunning = false;
    _log("error", `[AGENT] Unexpected error in macro analysis: ${outerErr.message}`);
    return null;
  }
}

async function dispatchAgentTools(toolCalls) {
  const results = {};
  for (const call of toolCalls) {
    try {
      if (call.name === "getQuote")          results[call.name + '_' + call.input.ticker] = await agentTool_getQuote(call.input.ticker);
      else if (call.name === "getLiveSignals")   results[call.name + '_' + call.input.ticker] = await agentTool_getLiveSignals(call.input.ticker);
      else if (call.name === "getPositionStatus") results[call.name + '_' + call.input.ticker] = await agentTool_getPositionStatus(call.input.ticker);
      else if (call.name === "getMarketStatus")   results["getMarketStatus"] = await agentTool_getMarketStatus();
      else if (call.name === "getIVRank")         results["getIVRank"] = { ivRank: state._ivRank||50, ivEnv: state._ivEnv||"normal", vix: state.vix, recommendation: (state._ivRank||50)>=70?"Sell premium aggressively":(state._ivRank||50)>=50?"Credit spreads favorable":(state._ivRank||50)>=30?"Neutral":"Buy premium preferred" };
      else if (call.name === "getRegimeStatus")   results["getRegimeStatus"] = { regimeClass: state._regimeClass||"A", daysBelow200MA: state._regimeDuration||0, vixSustained5d: state._vixSustained||state.vix, spyDrawdownPct: state._spyDrawdown||0, ivRank: state._ivRank||50, strategyMode: state._regimeClass==="C"?"Crisis: bear call credits only":state._regimeClass==="B"?"Bear trend: bear call credits + debit puts on bounces":"Bull: mean reversion, both directions", creditCallActive: !!(state.vix>=25&&(state._regimeClass==="B"||state._regimeClass==="C")) };
    } catch(e) { results[call.name] = { error: e.message }; }
  }
  return results;
}

async function agentTool_getQuote(ticker) {
  try {
    const quote    = await getStockQuote(ticker);
    const bars     = await getStockBars(ticker, 2);
    const prevClose= bars.length >= 2 ? bars[bars.length-2].c : null;
    const dayChg   = quote && prevClose ? ((quote - prevClose) / prevClose * 100).toFixed(2) : null;
    return { ticker, price: quote, dayChangePct: dayChg, prevClose };
  } catch(e) { return { ticker, error: e.message }; }
}

async function agentTool_getLiveSignals(ticker) {
  try {
    const bars = await getStockBars(ticker, 30);
    if (!bars || bars.length < 14) return { ticker, error: "insufficient data" };
    const rsi  = _calcRSI(bars);
    const intraday = await getIntradayBars(ticker, 78);
    const vwap = intraday && intraday.length > 0
      ? intraday.reduce((s,b) => s + b.c, 0) / intraday.length : null;
    const price = bars[bars.length-1].c;
    const momentum = bars.length >= 5
      ? (price > bars[bars.length-5].c * 1.02 ? "strong"
        : price < bars[bars.length-5].c * 0.98 ? "recovering" : "steady")
      : "steady";
    return { ticker, rsi: parseFloat(rsi.toFixed(1)), momentum, vwap: vwap ? parseFloat(vwap.toFixed(2)) : null, price: parseFloat(price.toFixed(2)) };
  } catch(e) { return { ticker, error: e.message }; }
}

async function agentTool_getPositionStatus(ticker) {
  const pos = (state.positions || []).find(p => p.ticker === ticker);
  if (!pos) return { ticker, error: "not in portfolio" };
  const chgPct = pos.currentPrice && pos.premium
    ? ((pos.currentPrice - pos.premium) / pos.premium * 100).toFixed(1) : "0";
  const dteLeft = pos.expDate
    ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY)) : null;
  const daysOpen = ((Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY).toFixed(1);
  return {
    ticker, optionType: pos.optionType, strike: pos.isSpread ? `${pos.buyStrike}/${pos.sellStrike}` : pos.strike, expDate: pos.expDate,
    entryPrice: pos.premium, currentPrice: pos.currentPrice || pos.premium,
    pnlPct: parseFloat(chgPct), pnlDollar: parseFloat(((pos.currentPrice||pos.premium) - pos.premium) * 100).toFixed(0),
    dteLeft, daysOpen: parseFloat(daysOpen),
    entryScore: pos.score, entryRSI: pos.entryRSI,
    delta: pos.greeks?.delta, theta: pos.greeks?.theta,
    partialClosed: pos.partialClosed,
    entryReasons: (pos.reasons || []).slice(0, 4),
  };
}

async function agentTool_getMarketStatus() {
  try {
    const spyQuote = await getStockQuote("SPY");
    const spyBars  = await getStockBars("SPY", 5);
    const prevClose= spyBars.length >= 2 ? spyBars[spyBars.length-2].c : null;
    const dayChg   = spyQuote && prevClose ? ((spyQuote - prevClose) / prevClose * 100).toFixed(2) : null;
    return {
      spy: { price: spyQuote, dayChangePct: dayChg },
      vix: state.vix,
      breadth: state._breadth || null,
      fearGreed: marketContext.fearGreed?.score || null,
      pdtRemaining: Math.max(0, PDT_LIMIT - _countDT()),
      cash: parseFloat((state.cash||0).toFixed(2)),
      openPositions: (state.positions||[]).length,
    };
  } catch(e) { return { error: e.message }; }
}

async function getAgentRescore(pos) {
  if (!ANTHROPIC_API_KEY) return null;

  const daysOpen = ((Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY).toFixed(1);
  const chgPct   = pos.currentPrice && pos.premium
    ? ((pos.currentPrice - pos.premium) / pos.premium * 100).toFixed(1) : '0';
  const isProfit = parseFloat(chgPct) > 0;
  const isPDT    = _isDayTrade(pos); // opened today
  const pdtLeft  = Math.max(0, PDT_LIMIT - _countDT());
  const alpacaBal= state.alpacaCash || state.cash || 0;
  const pdtProtected = alpacaBal < 25000 && isPDT;

  const systemPrompt = `Options position analyst. Does the entry thesis still hold? Return JSON only.

{"score":0-95,"label":"STRONG"|"VALID"|"WEAK"|"DEGRADED"|"INVALID","confidence":"high"|"medium"|"low","reasoning":"1 sentence","recommendation":"HOLD"|"WATCH"|"EXIT"}

Critical rules:
- NEVER recommend EXIT on a profitable position (P&L > 0) - the exit system handles profit taking
- If PDT protected (same-day position, account <$25k): max recommendation is WATCH, never EXIT
- Score: 85+=intact, 70-84=mostly valid, 50-69=weakening, <50=broken
- Use getLiveSignals to check current RSI/momentum before deciding`;

  // Build agent history context - last 2 rescores for trend awareness
  const agentHistoryLines = (pos.agentHistory || []).slice(-2).map((h,i) =>
    `  ${i===0?'2 rescores ago':'Last rescore'}: ${h.label} (${h.score}/95) - ${h.reasoning}`
  ).join('\n');

  // Thesis integrity for context
  const thesisScore = pos.entryThesisScore || 100;
  const thesisTrend = pos.thesisHistory && pos.thesisHistory.length >= 2
    ? (pos.thesisHistory[pos.thesisHistory.length-1].score - pos.thesisHistory[pos.thesisHistory.length-2].score)
    : 0;

  const userPrompt = `Position to rescore:
- ${pos.ticker} ${pos.optionType.toUpperCase()} ${pos.isSpread ? `$${pos.buyStrike}/$${pos.sellStrike} SPREAD` : `$${pos.strike}`} exp ${pos.expDate}
- Entry: $${pos.premium} | Current: $${pos.currentPrice || pos.premium} | P&L: ${chgPct}% ${isProfit ? '(PROFITABLE - do not recommend EXIT)' : ''}
${pos.isCreditSpread ? '- CREDIT SPREAD: profit = time decay, spread value DECREASING is GOOD. Only recommend EXIT if underlying moved strongly against short strike.' : ''}
- Opened: ${daysOpen} days ago | DTE: ${Math.max(0, Math.round((new Date(pos.expDate)-new Date())/MS_PER_DAY))}d
- Entry score: ${pos.score}/100 | Entry reasons: ${(pos.reasons||[]).slice(0,4).join('; ')}
- Stock: $${pos.price || '--'} | Entry RSI: ${pos.entryRSI || '--'} | Entry MACD: ${pos.entryMACD || '--'}
- Thesis integrity: ${thesisScore}/100 ${thesisTrend < 0 ? '(degrading ' + thesisTrend + ')' : thesisTrend > 0 ? '(improving +' + thesisTrend + ')' : '(stable)'}
- VIX: ${state.vix} | Macro: ${(state._agentMacro || {}).signal || 'neutral'}
${agentHistoryLines ? '- Recent history:\n' + agentHistoryLines : ''}
${pdtProtected ? '- PDT PROTECTED: opened today, account <$25k - max recommendation is WATCH' : ''}
${pdtLeft <= 1 && !pdtProtected ? '- PDT WARNING: only ' + pdtLeft + ' day trade(s) remaining - avoid EXIT unless thesis clearly broken' : ''}

Does the thesis still hold? Score and recommend.`;

  const raw = await callClaudeAgent(systemPrompt, userPrompt, 600, true, true, 45000); // 45s - tool use needs headroom
  if (!raw) return null;
  try {
    const parsed = JSON.parse(stripThinking(raw));
    // Server-side safety guards - never trust agent alone
    if (isProfit && parsed.recommendation === "EXIT") {
      parsed.recommendation = "WATCH";
      parsed.reasoning = "(Auto-adjusted: position profitable - exit system manages profit taking) " + (parsed.reasoning || '');
    }
    if (pdtProtected && parsed.recommendation === "EXIT") {
      parsed.recommendation = "WATCH";
      parsed.reasoning = "(Auto-adjusted: PDT protected same-day position) " + (parsed.reasoning || '');
    }
    // Store in position agentHistory for future context
    const posRef = (state.positions || []).find(p => p.ticker === pos.ticker);
    if (posRef && parsed) {
      if (!posRef.agentHistory) posRef.agentHistory = [];
      posRef.agentHistory.push({
        time:           new Date().toISOString(),
        score:          parsed.score,
        label:          parsed.label,
        confidence:     parsed.confidence,
        reasoning:      parsed.reasoning,
        recommendation: parsed.recommendation,
      });
      if (posRef.agentHistory.length > 5) posRef.agentHistory = posRef.agentHistory.slice(-5);
    }
    return parsed;
  } catch(e) { return null; }
}

async function getAgentMorningBriefing(positions, macro, headlines) {
  if (!ANTHROPIC_API_KEY) return null;

  const systemPrompt = `You are the head of a proprietary options trading desk writing a morning briefing for a solo trader.
Write in the style of a senior analyst - direct, confident, actionable.
No fluff, no disclaimers, no "please note". Just what matters.

You have tools to fetch live market data - use them to get current prices and signals before writing.

Your briefing has three parts:
1. MARKET OPEN (2-3 sentences): What is the macro setup going into today's open? VIX, SPY direction, key themes.
2. POSITION REVIEW (1 sentence per position): For each open position, check its current status and say whether to hold, watch, or exit and why.
3. OPPORTUNITIES (1-2 sentences): Any mean reversion call opportunities forming? Any positions approaching targets?

Keep the entire briefing under 200 words. Be specific with numbers.`;

  const positionList = positions.map(p =>
    p.ticker + ' ' + p.optionType.toUpperCase() + ' $' + p.strike +
    ' | Entry $' + p.premium + ' | DTE ' + (p.expDate ? Math.max(0,Math.round((new Date(p.expDate)-new Date())/MS_PER_DAY)) : '?') + 'd'
  ).join('\n');

  const userPrompt = `Today is ${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}.

Current macro signal: ${macro.signal || 'neutral'} ${macro.agentReasoning ? '- ' + macro.agentReasoning : ''}
VIX: ${state.vix} | Cash: $${(state.cash||0).toFixed(0)} | PDT remaining: ${Math.max(0,3-_countDT())}/3

Open positions:
${positionList || 'None'}

Key headlines overnight:
${headlines.slice(0,5).join('\n')}

Use your tools to check current prices and signals for each position, then write the morning briefing.`;

  try {
    const raw = await callClaudeAgent(systemPrompt, userPrompt, 600, true, true, 45000); // 45s - briefing tool use needs headroom
    if (!raw) return null;
    // Return as plain text - not JSON
    return raw;
  } catch(e) {
    console.log("[AGENT] Morning briefing error:", e.message);
    return null;
  }
}

async function runAgentRescore() {
  if (!ANTHROPIC_API_KEY || !isMarketHours()) return;
  const now         = Date.now();
  const currentHour = new Date().getHours();
  if (!state._agentRescoreHour)    state._agentRescoreHour    = {};
  if (!state._agentRescoreMinute)  state._agentRescoreMinute  = {};

  // Rescore ALL open positions - different cadence by age:
  // Same-day positions: every 30 minutes (more volatile, need more attention)
  // Overnight positions: every hour
  const SAME_DAY_INTERVAL   = 30 * 60 * 1000; // 30 minutes - reduces API cost significantly
  const OVERNIGHT_INTERVAL  = 60 * 60 * 1000; // 60 minutes - overnight positions change slowly

  const toRescore = (state.positions || []).filter(p => {
    const daysOpen  = (now - new Date(p.openDate).getTime()) / MS_PER_DAY;
    const isOvernight = daysOpen >= 1;
    const interval  = isOvernight ? OVERNIGHT_INTERVAL : SAME_DAY_INTERVAL;
    const lastRescore = isOvernight
      ? (state._agentRescoreHour[p.ticker] !== currentHour ? 0 : now) // hour-based for overnight
      : (state._agentRescoreMinute[p.ticker] || 0); // time-based for same-day
    if (isOvernight) return state._agentRescoreHour[p.ticker] !== currentHour;
    return (now - lastRescore) >= interval;
  });

  if (!toRescore.length) return;

  // Skip positions where P&L hasn't moved enough to warrant a rescore - saves tokens
  const needRescore = toRescore.filter(pos => {
    const lastChg = pos._lastRescoreChg ?? null;
    const curChg  = pos.premium > 0 ? (pos.currentPrice - pos.premium) / pos.premium : 0;
    if (lastChg !== null && Math.abs(curChg - lastChg) < 0.08 && pos._liveRescore) {
      // Don't log "skipped" if a trigger rescore fired recently — log would be misleading
      // (trigger rescores run independently via triggerRescore(), not through this path)
      const recentTrigger = pos._triggerRescoreCooldown &&
        Object.values(pos._triggerRescoreCooldown).some(t => (Date.now() - t) < TRIGGER_COOLDOWN_MS);
      if (!recentTrigger) {
        _log("scan", `[AGENT] ${pos.ticker} rescore skipped - P&L stable at ${(curChg*100).toFixed(0)}%`);
      }
      return false;
    }
    pos._lastRescoreChg = curChg;
    return true;
  });

  if (!needRescore.length) return;
  _log("scan", `[AGENT] Auto-rescore: ${needRescore.length} position(s)`);

  // Carr & Wu: reset credit spread target after 5-day IV harvest window
  // Simon & Campasano: flag momentum decay for trending positions 5d+
  for (const pos of state.positions) {
    if (pos.isCreditSpread && pos._creditHarvestExpiry) {
      if (Date.now() > new Date(pos._creditHarvestExpiry).getTime() && pos.takeProfitPct === 0.50) {
        pos.takeProfitPct = 0.50;
        _log("scan", `${pos.ticker} credit harvest window expired - target expanded to 50%`);
      }
    }
    const dOpen = (Date.now() - new Date(pos.openDate).getTime()) / MS_PER_DAY;
    if (dOpen >= 5 && !pos.isMeanReversion && !pos.isCreditSpread && !pos._momentumDecayFlagged) {
      pos._momentumDecayFlagged = true;
      // Simon & Campasano: actually force rescore by resetting the rescore timer
      if (state._agentRescoreMinute) state._agentRescoreMinute[pos.ticker] = 0;
      if (state._agentRescoreHour)   state._agentRescoreHour[pos.ticker]   = -1;
      _log("scan", `${pos.ticker} momentum 5d+ - rescore forced (Simon & Campasano)`);
    }
  }

  // Mark as rescored - stagger same-day positions by 3 minutes each
  // Prevents all positions hitting 30-min mark simultaneously next cycle
  needRescore.forEach((p, i) => {
    const daysOpen = (now - new Date(p.openDate).getTime()) / MS_PER_DAY;
    if (daysOpen >= 1) {
      state._agentRescoreHour[p.ticker]   = currentHour;
    } else {
      const stagger = i * 30 * 1000;
      state._agentRescoreMinute[p.ticker] = now - stagger;
    }
  });

  // Fire rescores in parallel - only positions that actually need it
  const results = await Promise.allSettled(needRescore.map(p => getAgentRescore(p)));

  const toClose = [];
  results.forEach((result, i) => {
    const pos = needRescore[i];
    if (result.status !== 'fulfilled' || !result.value) return;
    const rescore = result.value;
    pos._liveRescore = { ...rescore, updatedAt: new Date().toISOString() };
    _log("scan", `[AGENT] ${pos.ticker}: ${rescore.label} (${rescore.score}/95) - ${rescore.recommendation} | ${rescore.reasoning||''}`);

    const curP = pos.currentPrice || pos.premium;
    const chg  = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
    const posIsPDTp = _isDayTrade(pos);
    const posAlpacaBalp = state.alpacaCash || state.cash || 0;
    const posPDTProtectedp = PDT_RULE_ACTIVE && posAlpacaBalp < 25000 && posIsPDTp;
    if (state.agentAutoExitEnabled &&
        rescore.recommendation === "EXIT" &&
        rescore.confidence === "high" &&
        chg < 0 &&
        !posPDTProtectedp) {
      toClose.push(pos.ticker);
    }
  });

  for (const ticker of toClose) {
    const pos = (state.positions||[]).find(p => p.ticker === ticker);
    if (!pos) continue;
    _log("warn", `[AGENT] AUTO-EXIT ${ticker} - ${pos._liveRescore?.label} | ${pos._liveRescore?.reasoning}`);
    await _closePos(ticker, "agent-exit");
  }

  if (results.some(r => r.status === 'fulfilled') || toClose.length > 0) _markDirty();
}

async function triggerRescore(pos, triggerReason) {
  if (!ANTHROPIC_API_KEY) return;
  const now = Date.now();
  if (!pos._triggerRescoreCooldown) pos._triggerRescoreCooldown = {};
  const lastFired = pos._triggerRescoreCooldown[triggerReason] || 0;
  if (now - lastFired < TRIGGER_COOLDOWN_MS) return; // cooldown active
  pos._triggerRescoreCooldown[triggerReason] = now;

  _log("warn", `[AGENT] Trigger rescore: ${pos.ticker} - ${triggerReason}`);
  try {
    const rescore = await getAgentRescore(pos);
    if (!rescore) return;
    pos._liveRescore = { ...rescore, updatedAt: new Date().toISOString(), trigger: triggerReason };
    _log("scan", `[AGENT] ${pos.ticker} trigger result: ${rescore.label} (${rescore.score}/95) - ${rescore.recommendation} | ${rescore.reasoning||''}`);

    // Auto-exit if enabled + EXIT + high confidence + position losing + not PDT protected
    const curP = pos.currentPrice || pos.premium;
    const chg  = pos.premium > 0 ? (curP - pos.premium) / pos.premium : 0;
    const posIsPDT = _isDayTrade(pos);
    const posAlpacaBal = state.alpacaCash || state.cash || 0;
    const posPDTProtected = PDT_RULE_ACTIVE && posAlpacaBal < 25000 && posIsPDT;
    if (state.agentAutoExitEnabled &&
        rescore.recommendation === "EXIT" &&
        rescore.confidence === "high" &&
        chg < 0 &&
        !posPDTProtected) {
      _log("warn", `[AGENT] TRIGGER AUTO-EXIT ${pos.ticker} - trigger: ${triggerReason} | ${rescore.reasoning}`);
      await _closePos(pos.ticker, "agent-exit");
    }
    _markDirty();
  } catch(e) {
    console.log("[AGENT] Trigger rescore error:", e.message);
  }
}



// ─── Post-market overnight assessment ────────────────────────────────────────
async function getAgentPostMarketAssessment(scanType = "post-market") {
  if (!ANTHROPIC_API_KEY) return null;
  const systemPrompt = `Post-market analyst for ARGO-V3.0. Return ONLY valid JSON - no markdown.
{"overnightRisk":"low"|"medium"|"high","holdRecommendations":{},"tomorrowBias":"bullish"|"bearish"|"neutral","catalystsTomorrow":[],"reasoning":"1-2 sentences"}
holdRecommendations: {ticker: "HOLD"|"MONITOR"|"EXIT_AT_OPEN"} for each open position.`;

  const positions = (state.positions || []).map(p => ({
    ticker: p.ticker, type: p.optionType, isSpread: p.isSpread,
    pnlPct: p.currentPrice && p.premium ? ((p.currentPrice - p.premium)/p.premium*100).toFixed(1) : '0',
    daysOpen: ((Date.now() - new Date(p.openDate).getTime())/MS_PER_DAY).toFixed(1),
    expDate: p.expDate,
  }));

  const [headlines, mktStatus] = await Promise.all([
    _getMacro(state).catch(() => ({ headlines: [] })),
    Promise.resolve({}),
  ]);

  const userPrompt = `${scanType} assessment - ${new Date().toLocaleString('en-US', {timeZone:'America/New_York'})} ET
VIX: ${state.vix} | Open positions: ${JSON.stringify(positions)}
Recent headlines: ${(headlines.headlines || []).slice(0,5).join(' | ')}
What is the overnight risk and tomorrow bias?`;

  try {
    const raw = await callClaudeAgent(systemPrompt, userPrompt, 500, false);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    parsed.generatedAt = new Date().toISOString();
    _log("macro", `[POST-MARKET] overnight risk: ${parsed.overnightRisk} | tomorrow: ${parsed.tomorrowBias} | ${(parsed.reasoning||'').slice(0,80)}`);
    for (const pos of (state.positions || [])) {
      const rec = parsed.holdRecommendations?.[pos.ticker];
      if (rec === "EXIT_AT_OPEN") {
        pos._morningExitFlag = true;
        pos._morningExitReason = `Post-market agent: overnight risk ${parsed.overnightRisk}`;
        _log("warn", `[POST-MARKET] ${pos.ticker} flagged for exit at open - ${parsed.reasoning}`);
      }
    }
    if (_saveNow) await _saveNow();
    return parsed;
  } catch(e) {
    _log("warn", `[POST-MARKET] ${scanType} failed: ${e.message}`);
    return null;
  }
}

// ─── Pre-entry agent check (re-entry veto + borderline score review) ──────────
async function getAgentPreEntryCheck(stock, score, reasons, optionType, isCreditMode = false) {
  if (!ANTHROPIC_API_KEY) return { approved: true, reason: "no API key" };

  const recentLoss = (state._recentLosses || {})[stock.ticker];
  if (recentLoss) {
    const hrsSinceLoss = (Date.now() - recentLoss.closedAt) / 3600000;
    if (hrsSinceLoss < 24) {
      const systemPrompt = `Options pre-entry analyst. Return JSON only: {"approved":true|false,"confidence":"high"|"medium"|"low","reason":"one sentence"}`;
      const userPrompt = `Re-entry check: ${stock.ticker} ${optionType.toUpperCase()}
Closed at a loss ${hrsSinceLoss.toFixed(1)}h ago (reason: ${recentLoss.reason}, P&L: ${recentLoss.pnlPct}%)
Current: RSI ${stock.rsi} | MACD ${stock.macd} | Momentum ${stock.momentum}
Entry macro was: ${recentLoss.agentSignal} | Current macro: ${(state._agentMacro||{}).signal||'neutral'}
Score now: ${score}/100 | Top reasons: ${reasons.slice(0,3).join('; ')}
Has the thesis genuinely changed since the loss? Approve re-entry?`;
      const raw = await callClaudeAgent(systemPrompt, userPrompt, 200, false);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          _log("filter", `[PRE-ENTRY] ${stock.ticker} re-entry check: ${parsed.approved ? 'APPROVED' : 'BLOCKED'} (${parsed.confidence}) - ${parsed.reason}`);
          return parsed;
        } catch(e) { return { approved: true, reason: "parse error - allowing" }; }
      }
      return { approved: true, reason: "agent unavailable - allowing" };
    }
  }

  if (optionType === "put" && stock.rsi <= 35 && !isCreditMode) {
    _log("filter", `[PRE-ENTRY] ${stock.ticker} hard blocked - RSI ${stock.rsi} <= 35`);
    return { approved: false, confidence: "high", reason: `RSI ${stock.rsi} - stock already crashed` };
  }
  if (optionType === "put" && stock.rsi <= 35 && isCreditMode) {
    return { approved: true, confidence: "high", reason: `RSI ${stock.rsi} oversold - ideal credit put spread entry` };
  }

  const hasBullishMACD = (stock.macd || "").includes("bullish");
  const borderline = score < 80;
  if (!borderline && !hasBullishMACD) {
    return { approved: true, reason: "high-confidence setup - skipping pre-entry check" };
  }

  const systemPrompt = `Options pre-entry analyst. Return JSON only: {"approved":true|false,"confidence":"high"|"medium"|"low","reason":"one sentence"}`;
  const userPrompt = `Pre-entry check: ${stock.ticker} ${optionType.toUpperCase()}
RSI: ${stock.rsi} | MACD: ${stock.macd} | Momentum: ${stock.momentum}
Score: ${score}/100 | Top reasons: ${reasons.slice(0,4).join('; ')}
Macro: ${(state._agentMacro||{}).signal||'neutral'} (${(state._agentMacro||{}).confidence||'unknown'})
VIX: ${state.vix}
Should ARGO-V3.0 enter this ${optionType} position?`;

  const raw = await callClaudeAgent(systemPrompt, userPrompt, 200, false);
  if (!raw) return { approved: true, reason: "agent unavailable - allowing" };
  try {
    const parsed = JSON.parse(raw);
    _log("filter", `[PRE-ENTRY] ${stock.ticker} ${optionType}: ${parsed.approved ? 'APPROVED' : 'BLOCKED'} (${parsed.confidence}) - ${parsed.reason}`);
    return parsed;
  } catch(e) { return { approved: true, reason: "parse error - allowing" }; }
}


// ─── Overnight market scan — pre-open intelligence for ARGO ──────────────────
// Schedule: 11pm CT (midnight ET) for news digest + 7:30am CT (8:30am ET) for
// pre-market strike pre-computation.
//
// Two modes:
//   "midnight-digest"   — overnight news, macro events tomorrow, regime risk
//   "premarket-compute" — pre-market prices, futures, strike pre-computation
//
// Output stored in state._overnightScan — read by scanner at first market scan.
// ─────────────────────────────────────────────────────────────────────────────
async function getAgentOvernightScan(scanType = "midnight-digest") {
  if (!ANTHROPIC_API_KEY) return null;

  const ctNow = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const etNow = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  // ── Fetch context ─────────────────────────────────────────────────────────
  const [headlines, mktStatus] = await Promise.all([
    _getMacro(state).catch(() => ({ headlines: [] })),
    agentTool_getMarketStatus().catch(() => ({})),
  ]);
  const headlineList = (headlines.headlines || headlines.topStories || []).slice(0, 20);
  const openPositions = (state.positions || []).map(p => ({
    ticker: p.ticker, type: p.optionType,
    isCreditSpread: p.isCreditSpread || false,
    sellStrike: p.sellStrike, buyStrike: p.buyStrike,
    expDate: p.expDate, expDays: p.expDays,
    premium: p.premium, contracts: p.contracts || 1,
    maxProfit: p.maxProfit, maxLoss: p.maxLoss,
    pnlPct: p.currentPrice && p.premium
      ? ((p.currentPrice - p.premium) / p.premium * 100).toFixed(1) + "%" : "?",
  }));

  // ── Pre-market data (7:30am CT / 8:30am ET mode only) ────────────────────
  let premarketData = null;
  if (scanType === "premarket-compute") {
    try {
      // Fetch live pre-market quotes for all instruments
      const [spyQ, qqqQ, gldQ, tltQ, xleQ] = await Promise.all([
        agentTool_getQuote("SPY").catch(() => null),
        agentTool_getQuote("QQQ").catch(() => null),
        agentTool_getQuote("GLD").catch(() => null),
        agentTool_getQuote("TLT").catch(() => null),
        agentTool_getQuote("XLE").catch(() => null),
      ]);

      // Compute expected strikes for each instrument at VIX-appropriate parameters
      // VIX-tiered: width = 1.0% of price at VIX 28+, R/R floor = 26%
      const vix = state.vix || 28;
      const widthPct = vix >= 35 ? 0.015 : vix >= 28 ? 0.010 : 0.008;
      const computeStrike = (price, deltaOTM = 0.04) => {
        if (!price) return null;
        const shortStrike = Math.round(price * (1 + deltaOTM));
        const width = Math.max(2, Math.min(15, Math.round(price * widthPct * 2) / 2));
        const longStrike = shortStrike + width;
        return { price, shortStrike, longStrike, width, otmPct: (deltaOTM * 100).toFixed(1) + "%" };
      };

      premarketData = {
        fetchedAt: ctNow + " CT",
        vix,
        widthPct: (widthPct * 100).toFixed(1) + "%",
        instruments: {
          SPY: computeStrike(spyQ),
          QQQ: computeStrike(qqqQ),
          GLD: computeStrike(gldQ),
          TLT: computeStrike(tltQ),
          XLE: computeStrike(xleQ),
        },
        // Gap from previous close (stored in state._spyPrevClose)
        spyGapEst: state._spyPrevClose && spyQ
          ? ((spyQ - state._spyPrevClose) / state._spyPrevClose * 100).toFixed(2) + "%"
          : "unknown",
      };
    } catch(e) {
      _log("warn", `[OVERNIGHT] Pre-market data fetch failed: ${e.message}`);
    }
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  const systemPrompt = `You are ARGO's pre-market strategist. ARGO is a systematic options spread trading system.
ARGO trades bear call spreads (Regime B), debit put spreads (bounces), and debit call spreads (Regime A recovery).
All times are CENTRAL TIME (CT). Market opens 8:30am CT.

Return ONLY valid JSON — no markdown, no preamble:

{
  "regime": "trending_bear"|"trending_bull"|"choppy"|"breakdown"|"recovery"|"neutral",
  "signal": "strongly bearish"|"bearish"|"mild bearish"|"neutral"|"mild bullish"|"bullish"|"strongly bullish",
  "confidence": "high"|"medium"|"low",
  "vixOutlook": "spiking"|"elevated_stable"|"mean_reverting"|"falling",
  "riskLevel": "low"|"medium"|"high",
  "entryBias": "puts_on_bounces"|"calls_on_dips"|"neutral"|"avoid",
  "tradeType": "spread"|"credit"|"debit"|"none",
  "suppressUntil": null | "HH:MM CT",
  "catalysts": [],
  "keyLevels": { "spySupport": null, "spyResistance": null },
  "instrumentBias": {
    "SPY":  "bearish"|"neutral"|"bullish"|"skip",
    "QQQ":  "bearish"|"neutral"|"bullish"|"skip",
    "GLD":  "bearish"|"neutral"|"bullish"|"skip",
    "TLT":  "bearish"|"neutral"|"bullish"|"skip",
    "XLE":  "bearish"|"neutral"|"bullish"|"skip"
  },
  "openPositionRisk": "low"|"medium"|"high",
  "earlyEntryWindow": true|false,
  "waitForOpen": true|false,
  "waitReason": null | "string",
  "reasoning": "2-3 sentences covering regime, key risks, and instrument preference"
}

Rules:
- suppressUntil: HH:MM CT if high-impact event before 11am CT (CPI 7:30am CT, FOMC 1:00pm CT, NFP 7:30am CT)
- riskLevel high = FOMC day, CPI, NFP, or major earnings pre-market
- earlyEntryWindow true = conditions look favorable for entry in first 30min after open (9:00am CT)
- waitForOpen true = pre-market move suggests waiting 15-30min for volatility to settle
- instrumentBias: "skip" means avoid this instrument today (e.g. XLE on OPEC day, TLT on Fed day)
- openPositionRisk: risk to existing open positions from overnight/pre-market developments
- RECONCILIATION RULE: You will be shown intraday macro agent signals from today. Your signal and regime should be consistent with those signals unless a major development has occurred overnight that changes the picture. If you diverge, explain why in your reasoning. The macro agent runs every 5 minutes during market hours — it has more current price data than you. Do not contradict it without cause.`;

  // ── User prompt ───────────────────────────────────────────────────────────
  const scanLabel = scanType === "premarket-compute" ? "Pre-market (7:30am CT)" : "Overnight digest (11pm CT)";
  const userPrompt = `${scanLabel} — ${ctNow} CT (${etNow} ET)

CURRENT STATE:
- VIX: ${state.vix || "--"} | Regime: ${state._regimeClass || "--"} | IVR: ${state._ivRank || "--"}
- Open positions: ${openPositions.length ? JSON.stringify(openPositions) : "none"}
- Cash: $${(state.cash || 0).toFixed(2)} | Baseline: $${(state.accountBaseline || 30000).toFixed(2)}

${premarketData ? `PRE-MARKET DATA (${premarketData.fetchedAt}):
- SPY: $${premarketData.instruments.SPY?.price || "--"} | gap est: ${premarketData.spyGapEst}
- QQQ: $${premarketData.instruments.QQQ?.price || "--"}
- GLD: $${premarketData.instruments.GLD?.price || "--"}
- TLT: $${premarketData.instruments.TLT?.price || "--"}
- VIX: ${premarketData.vix} | Width target: ${premarketData.widthPct} of price

ESTIMATED STRIKE TARGETS (bear call spreads, ${premarketData.widthPct} wide, ~4% OTM):
${Object.entries(premarketData.instruments).map(([t, d]) =>
  d ? `  ${t}: short $${d.shortStrike} / long $${d.longStrike} (${d.otmPct} OTM, $${d.width} wide)` : `  ${t}: no data`
).join("\n")}` : ""}

INTRADAY MACRO AGENT SIGNALS (last reading before this overnight scan):
${(() => {
  const last = (state._agentMacroHistory || []).slice(-1)[0];
  if (!last) return "  No intraday macro signals recorded today.";
  const ago = Math.round((Date.now() - new Date(last.ts).getTime()) / 60000);
  return `  ${ago}min ago: ${last.signal} (${last.confidence}) — ${(last.reasoning||"").slice(0,100)}`;
})()}

TODAY'S HEADLINES (${headlineList.length} items):
${headlineList.slice(0, 15).map((h, i) => `${i+1}. ${h}`).join("\n") || "No headlines"}

What is your ${scanType === "premarket-compute" ? "pre-market assessment and entry strategy for today" : "overnight assessment and tomorrow's trading outlook"}?`;

  try {
    const raw = await callClaudeAgent(systemPrompt, userPrompt, 600, false);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    parsed.generatedAt  = new Date().toISOString();
    parsed.generatedCT  = ctNow;
    parsed.scanType     = scanType;
    parsed.premarketData = premarketData || null;

    // Store in state — scanner reads this at first market scan
    state._overnightScan = parsed;

    // If premarket scan has a regime/signal, update dayPlan too
    // This gives the 9:45am CT first scan pre-seeded intelligence
    if (parsed.signal && parsed.regime) {
      state._dayPlan = {
        ...( state._dayPlan || {}),
        signal:        parsed.signal,
        regime:        parsed.regime,
        confidence:    parsed.confidence,
        entryBias:     parsed.entryBias,
        tradeType:     parsed.tradeType,
        riskLevel:     parsed.riskLevel,
        vixOutlook:    parsed.vixOutlook,
        suppressUntil: parsed.suppressUntil,
        keyLevels:     parsed.keyLevels,
        catalysts:     parsed.catalysts,
        reasoning:     parsed.reasoning,
        generatedAt:   parsed.generatedAt,
        scanType:      scanType,
      };
      state._dayPlanDate = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
    }

    _log("macro", `[OVERNIGHT ${scanType.toUpperCase()}] ${parsed.regime} | ${parsed.signal} (${parsed.confidence}) | bias: ${parsed.entryBias} | risk: ${parsed.riskLevel}${parsed.suppressUntil ? " | suppress until " + parsed.suppressUntil : ""}${parsed.waitForOpen ? " | WAIT FOR OPEN" : ""} | ${(parsed.reasoning||"").slice(0,80)}`);

    // Log instrument biases
    if (parsed.instrumentBias) {
      const biasStr = Object.entries(parsed.instrumentBias)
        .filter(([,v]) => v !== "neutral")
        .map(([t,v]) => `${t}:${v}`)
        .join(" | ");
      if (biasStr) _log("macro", `[OVERNIGHT] Instrument bias: ${biasStr}`);
    }

    if (_saveNow) await _saveNow();
    return parsed;
  } catch(e) {
    _log("warn", `[OVERNIGHT] ${scanType} failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  callClaudeAgent, stripThinking,
  getAgentMacroAnalysis, getAgentRescore, getAgentDayPlan,
  getAgentMorningBriefing, runAgentRescore, triggerRescore,
  initAgent,
  getAgentPostMarketAssessment,
  getAgentOvernightScan,
  getAgentPreEntryCheck,
};
