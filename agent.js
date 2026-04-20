// agent.js — ARGO V3.2
// Claude AI agent: macro analysis, position rescoring, morning briefing.
'use strict';
let marketContext = {}; // populated by scanner
const AGENT_MACRO_CACHE_MS = 5 * 60 * 1000  // 5 minutes;
const AGENT_TOOLS = [];
const fetch = require('node-fetch');
const { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } = require('./constants');
const { state } = require('./state');
const { getAccountPhase ,
  effectiveHeatCap, isMarketHours
} = require('./signals');
const { alpacaGet, getStockQuote, getStockBars, getIntradayBars } = require('./broker');

// ─── Module-level cache ──────────────────────────────────────────
let _agentMacroCache = { result: null, fetchedAt: 0 };

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
    _getMacro().catch(() => ({ headlines: [] })),
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

async function getAgentMacroAnalysis(headlines) {
  if (!ANTHROPIC_API_KEY || !headlines || headlines.length === 0) return null;
  // Return cached result if fresh
  if (_agentMacroCache.result && Date.now() - _agentMacroCache.fetchedAt < AGENT_MACRO_CACHE_MS) {
    return _agentMacroCache.result;
  }
  const systemPrompt = `You are the head macro strategist for ARGO-V3.0, a systematic SPY/QQQ options trading system. Return ONLY valid JSON - no markdown, no preamble.

{"signal":"strongly bearish"|"bearish"|"mild bearish"|"neutral"|"mild bullish"|"bullish"|"strongly bullish","modifier":-20to20,"confidence":"high"|"medium"|"low","mode":"defensive"|"cautious"|"normal"|"aggressive","reasoning":"1 sentence","regime":"trending_bear"|"trending_bull"|"choppy"|"breakdown"|"recovery"|"neutral","regimeDuration":"intraday"|"1-3 days"|"3-7 days"|"1-2 weeks"|"multi-week","entryBias":"puts_on_bounces"|"calls_on_dips"|"neutral"|"avoid","tradeType":"spread"|"credit"|"naked"|"none","vixOutlook":"spiking"|"elevated_stable"|"mean_reverting"|"falling"|"unknown","keyLevels":{"spySupport":null,"spyResistance":null},"catalysts":[],"bearishTickers":[],"bullishTickers":[],"themes":[],"exitUrgency":"hold"|"monitor"|"trim"|"exit","positionSizeMult":0.25|0.5|0.75|1.0|1.25|1.5,"schemaVersion":2}

Rules: regime=what SPY does next 3-10 days. entryBias: puts_on_bounces=bearish trend wait for relief; calls_on_dips=bullish wait for weakness. tradeType: spread=grinding trend, naked=sharp mean-reversion, none=unclear. vixOutlook: spiking=buy puts aggressively, falling=puts losing value. exitUrgency: hold=thesis intact, monitor=watch closely, trim=close half, exit=close all. positionSizeMult: 0.25=minimal, 1.0=normal, 1.5=high conviction. Focus on 3-10 day outlook not just today. schemaVersion always 2.`;

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
  const regimeA = !spyBelowNow && state._vixSustained < 20;
  const regimeC = state._spyDrawdown < -20 && state._vixSustained > 35 && state._regimeDuration > 10;
  const regimeB = !regimeA && !regimeC; // trending/transitional - the current environment
  const prevRegimeClass = state._regimeClass;
  state._regimeClass = regimeC ? "C" : regimeB ? "B" : "A";

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

  // - AG-5: Correlation alert -
  const openPutsCount  = (state.positions||[]).filter(p=>p.optionType==="put").length;
  const openCallsCount = (state.positions||[]).filter(p=>p.optionType==="call").length;
  const correlAlert    = openPutsCount >= 3 && openCallsCount === 0 ? "all_puts"
                       : openCallsCount >= 3 && openPutsCount === 0 ? "all_calls"
                       : "balanced";

  const userPrompt = `Market snapshot (live data - no need to call getMarketStatus):
- VIX: ${mktStatus.vix || state.vix || 20} | SPY: ${spyPrice || '--'} (${mktStatus.spy?.dayChangePct || '--'}%)
- Breadth: ${mktStatus.breadth ? (mktStatus.breadth*100).toFixed(0)+'%' : '--'} | Fear&Greed: ${mktStatus.fearGreed || '--'}
- Gap status: ${gapStatus}${spyMA50 ? ` | SPY vs 50MA: ${spyVsMA50}% (slope: ${spyMA50Slope}%/50d)` : ''}${spyMA200 ? ` | SPY vs 200MA: ${spyVsMA200}%` : ''}
- IV Rank: ${state._ivRank || '--'} (${state._ivEnv || '--'}) | Regime: ${state._regimeClass || 'A'} (${state._regimeDuration || 0}d below 200MA) | VIX 5d avg: ${state._vixSustained || '--'}
- SPY drawdown from 52wk high: ${state._spyDrawdown || '--'}% | Credit call mode: ${state.vix >= 25 && (state._regimeClass === 'B' || state._regimeClass === 'C') ? 'ACTIVE' : 'inactive'}
- Account: $${acctCurrent.toFixed(0)} (${acctDrawdown}% vs baseline) | Phase: ${acctPhaseNow} | Heat: ${heatPctNow}%/${heatCapNow}% cap
- Portfolio: ${openPutsCount}P / ${openCallsCount}C open | Correlation: ${correlAlert} | PDT remaining: ${mktStatus.pdtRemaining || '--'}
- Options flow: ${state._optFlow ? Object.entries(state._optFlow).map(([t,f])=>`${t} ${f.volRatio}x vol`).join(', ') : 'no unusual activity'}
- Time: ${new Date().toLocaleTimeString('en-US', {timeZone:'America/New_York'})} ET
- Open positions: ${(state.positions||[]).map(p => p.ticker + '(' + (p.optionType==='put'?'P':'C') + '@' + (p.chgPct !== undefined ? (p.chgPct*100).toFixed(0)+'%' : '--') + ')').join(', ') || 'none'}

Headlines to analyze (newest first):
${headlines.slice(0, 15).map((h, i) => (i+1) + '. ' + h).join('\n')}

Respond with ONLY the JSON object. No words before or after. Start your response with { and end with }.`;

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
    state._agentHealth.successes++;
    state._agentHealth.lastSuccess = new Date().toISOString();
    const successRate = (state._agentHealth.successes / state._agentHealth.calls * 100).toFixed(0);
    _agentMacroCache = { result: parsed, fetchedAt: Date.now() };
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

    _checkMacroShift(parsed.signal);
    return parsed;
  } catch(e) {
    state._agentHealth.parseErrors++;
    _log("warn", `[AGENT HEALTH] JSON parse exception: ${e.message} | Raw: ${raw?.slice(0,60)}`);
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
      _log("scan", `[AGENT] ${pos.ticker} rescore skipped - P&L stable at ${(curChg*100).toFixed(0)}%`);
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
    const posPDTProtectedp = posAlpacaBalp < 25000 && posIsPDTp;
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
    const posPDTProtected = posAlpacaBal < 25000 && posIsPDT;
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


module.exports = {
  callClaudeAgent, stripThinking,
  getAgentMacroAnalysis, getAgentRescore, getAgentDayPlan,
  getAgentMorningBriefing, runAgentRescore, triggerRescore,
  initAgent,
};
