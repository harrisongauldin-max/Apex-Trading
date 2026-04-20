// market.js — ARGO V3.2
// Market data: macro news, breadth, VIX, sentiment, economic indicators.
'use strict';
const MARKETAUX_CACHE_MS = 60 * 60 * 1000  // 60 minutes;
const fetch = require('node-fetch');
const { alpacaGet, getStockBars, getStockQuote, withTimeout, getIntradayBars } = require('./broker');
const { state, logEvent, markDirty }             = require('./state');

// Macro calendar — key events that affect options pricing
// Update dates as needed; daysTo is computed live from today
const MACRO_EVENTS_2025 = [
  { date: "2026-04-29", event: "FOMC Meeting", impact: "high" },
  { date: "2026-05-07", event: "FOMC Minutes", impact: "medium" },
  { date: "2026-05-12", event: "CPI Report", impact: "high" },
  { date: "2026-05-15", event: "PPI Report", impact: "medium" },
  { date: "2026-05-30", event: "PCE Inflation", impact: "high" },
  { date: "2026-06-02", event: "Jobs Report (NFP)", impact: "high" },
  { date: "2026-06-17", event: "FOMC Meeting", impact: "high" },
  { date: "2026-06-10", event: "CPI Report", impact: "high" },
];
const { calcRSI, getETTime }                    = require('./signals');
const { getAgentMacroAnalysis }                    = require('./agent');

// Callbacks registered by scanner at boot to avoid circular dependency:
// market.js → scoring.js → market.js (would cause undefined exports)
let _checkMacroShift           = () => {};
let _applyIntradayRegimeOverride = () => {};
let _applyExitUrgency          = () => {};
function registerMacroCallbacks(cbs) {
  if (cbs.checkMacroShift)            _checkMacroShift            = cbs.checkMacroShift;
  if (cbs.applyIntradayRegimeOverride) _applyIntradayRegimeOverride = cbs.applyIntradayRegimeOverride;
  if (cbs.applyExitUrgency)           _applyExitUrgency           = cbs.applyExitUrgency;
}
const { SLOW_CACHE_TTL, BARS_CACHE_TTL, MARKETAUX_KEY,
        MS_PER_DAY, ALPACA_NEWS }                = require('./constants');

// ─── In-process cache ────────────────────────────────────────────
const _slowCache     = new Map();
let   _barsCache     = new Map();
let   _marketauxCache = { data: [], fetchedAt: 0 };
let _vixCache       = { value: 15, ts: 0 };   // cached VIX value + timestamp
let lastVIXReading  = 0;                       // 0 = uninitialized; used by checkVIXVelocity
let vixFallingPause = false;                   // true when VIX falling - suppresses put entries
let marketContext   = null;                    // set externally by scanner before calls

// ─── Constants (moved from monolith during V3.2 modular split) ──────────────
const ALPACA_DATA       = 'https://data.alpaca.markets/v2';
const ALPACA_OPT_SNAP   = 'https://data.alpaca.markets/v1beta1';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const COMPANY_NAMES = {
  NVDA:'Nvidia', AAPL:'Apple', MSFT:'Microsoft', AMZN:'Amazon', META:'Meta',
  GOOGL:'Alphabet Google', AMD:'AMD Advanced Micro', AVGO:'Broadcom', ARM:'ARM Holdings',
  MU:'Micron', SMCI:'Super Micro', CRM:'Salesforce', NOW:'ServiceNow', SNOW:'Snowflake',
  CRWD:'CrowdStrike', PANW:'Palo Alto Networks', NET:'Cloudflare',
  JPM:'JPMorgan', BAC:'Bank of America', C:'Citigroup', MS:'Morgan Stanley',
  COIN:'Coinbase', HOOD:'Robinhood', MSTR:'MicroStrategy', SQ:'Block Square',
  TSLA:'Tesla', NFLX:'Netflix', UBER:'Uber', SHOP:'Shopify',
  DKNG:'DraftKings', NKE:'Nike', ROKU:'Roku', PLTR:'Palantir',
  WFC:'Wells Fargo', BABA:'Alibaba', TTD:'The Trade Desk',
  SPY:'S&P 500', QQQ:'Nasdaq',
};

const MACRO_BEARISH_KEYWORDS = [
  { kw: 'fed rate hike',          w: 3 }, { kw: 'rate hike',               w: 2 },
  { kw: 'hawkish',                w: 2 }, { kw: 'quantitative tightening', w: 2 },
  { kw: 'tightening',             w: 1 },
  { kw: 'inflation surge',        w: 3 }, { kw: 'cpi beat',                w: 3 },
  { kw: 'inflation hot',          w: 2 }, { kw: 'pce beat',                w: 2 },
  { kw: 'core inflation',         w: 2 },
  { kw: 'tariff',                 w: 2 }, { kw: 'trade war',               w: 3 },
  { kw: 'sanctions',              w: 2 }, { kw: 'export controls',         w: 2 },
  { kw: 'chip ban',               w: 2 }, { kw: 'china tariff',            w: 3 },
  { kw: 'china tensions',         w: 2 }, { kw: 'taiwan strait',           w: 3 },
  { kw: 'war',                    w: 3 }, { kw: 'military strike',         w: 3 },
  { kw: 'invasion',               w: 3 }, { kw: 'conflict escalation',     w: 3 },
  { kw: 'blockade',               w: 2 }, { kw: 'strait',                  w: 2 },
  { kw: 'recession',              w: 3 }, { kw: 'gdp miss',                w: 3 },
  { kw: 'gdp contraction',        w: 3 }, { kw: 'unemployment rise',       w: 2 },
  { kw: 'jobless claims surge',   w: 2 }, { kw: 'layoffs',                 w: 2 },
  { kw: 'job cuts',               w: 1 },
  { kw: 'bank failure',           w: 3 }, { kw: 'credit crunch',           w: 3 },
  { kw: 'debt ceiling',           w: 2 }, { kw: 'default',                 w: 3 },
  { kw: 'downgrade',              w: 2 }, { kw: 'bank run',                w: 3 },
  { kw: 'regional banks',         w: 2 }, { kw: 'liquidity crisis',        w: 3 },
  { kw: 'oil spike',              w: 2 }, { kw: 'energy crisis',           w: 2 },
  { kw: 'supply shock',           w: 2 }, { kw: 'shortage',                w: 1 },
  { kw: 'opec cut',               w: 2 }, { kw: 'production cut',          w: 2 },
  { kw: 'yield inversion',        w: 2 }, { kw: '10-2 spread',             w: 2 },
  { kw: 'volatility surge',       w: 2 }, { kw: 'government shutdown',     w: 2 },
  { kw: 'shutdown',               w: 1 }, { kw: 'dollar strengthening',    w: 1 },
  { kw: 'earnings miss',          w: 2 }, { kw: 'guidance cut',            w: 2 },
  { kw: 'profit warning',         w: 2 },
];

const MACRO_BULLISH_KEYWORDS = [
  { kw: 'fed rate cut',           w: 3 }, { kw: 'rate cut',                w: 2 },
  { kw: 'dovish',                 w: 2 }, { kw: 'quantitative easing',     w: 2 },
  { kw: 'easing',                 w: 1 }, { kw: 'stimulus',                w: 2 },
  { kw: 'soft landing',           w: 2 }, { kw: 'pause rate',              w: 2 },
  { kw: 'inflation cooling',      w: 2 }, { kw: 'cpi miss',                w: 3 },
  { kw: 'inflation slows',        w: 2 }, { kw: 'pce miss',                w: 2 },
  { kw: 'disinflation',           w: 2 },
  { kw: 'strong jobs',            w: 2 }, { kw: 'unemployment falls',      w: 2 },
  { kw: 'gdp beat',               w: 3 }, { kw: 'gdp growth',              w: 2 },
  { kw: 'beat expectations',      w: 1 }, { kw: 'consumer confidence rises',w: 2 },
  { kw: 'retail sales beat',      w: 2 }, { kw: 'earnings beat',           w: 2 },
  { kw: 'record earnings',        w: 2 }, { kw: 'guidance raised',         w: 2 },
  { kw: 'profit beat',            w: 2 },
  { kw: 'ceasefire',              w: 3 }, { kw: 'peace deal',              w: 3 },
  { kw: 'peace talks',            w: 2 }, { kw: 'truce',                   w: 3 },
  { kw: 'accord',                 w: 2 }, { kw: 'end to conflict',         w: 3 },
  { kw: 'deescalation',           w: 2 }, { kw: 'de-escalation',           w: 2 },
  { kw: 'diplomatic',             w: 1 },
  { kw: 'tariff pause',           w: 3 }, { kw: 'tariff suspended',        w: 3 },
  { kw: 'tariff removed',         w: 3 }, { kw: 'tariff cut',              w: 2 },
  { kw: 'trade deal',             w: 3 }, { kw: 'trade agreement',         w: 3 },
  { kw: 'trade truce',            w: 2 }, { kw: 'sanctions lifted',        w: 2 },
  { kw: 'sanctions relief',       w: 2 }, { kw: 'iran deal',               w: 3 },
  { kw: 'us-iran',                w: 2 }, { kw: 'trump deal',              w: 2 },
  { kw: 'trade resolution',       w: 2 }, { kw: 'agreement reached',       w: 2 },
  { kw: 'china stimulus',         w: 2 }, { kw: 'pboc',                    w: 2 },
  { kw: 'beijing stimulus',       w: 2 },
  { kw: 'debt deal',              w: 2 }, { kw: 'budget deal',             w: 2 },
  { kw: 'continuing resolution',  w: 1 },
  { kw: 'ai breakthrough',        w: 1 }, { kw: 'nvidia beat',             w: 2 },
  { kw: 'oil falls',              w: 2 }, { kw: 'energy prices drop',      w: 2 },
  { kw: 'supply chain recovery',  w: 2 }, { kw: 'risk on',                 w: 1 },
  { kw: 'market rally',           w: 1 }, { kw: 'stocks surge',            w: 1 },
];

const CREDIBLE_SOURCES = [
  'reuters', 'bloomberg', 'ap ', 'associated press', 'wall street journal', 'wsj',
  'financial times', 'ft ', 'cnbc', 'federal reserve', 'fed ', 'white house',
  'treasury', 'sec ', 'imf', 'world bank', 'ecb', 'bank of england',
  'new york times', 'washington post', 'the economist'
];

const SECTOR_MACRO_IMPACT = {
  'rate hike':     { bearish: ['Technology', 'Financial'], bullish: [] },
  'rate cut':      { bearish: [], bullish: ['Technology', 'Financial'] },
  'oil spike':     { bearish: ['Consumer', 'Technology'], bullish: ['Energy'] },
  'opec cut':      { bearish: ['Consumer', 'Technology'], bullish: ['Energy'] },
  'oil falls':     { bearish: ['Energy'], bullish: ['Consumer', 'Technology'] },
  'tariff':        { bearish: ['Technology', 'Consumer'], bullish: [] },
  'china tariff':  { bearish: ['Technology', 'Consumer'], bullish: [] },
  'trade deal':    { bearish: [], bullish: ['Technology', 'Consumer'] },
  'recession':     { bearish: ['Financial', 'Consumer', 'Technology'], bullish: [] },
  'stimulus':      { bearish: [], bullish: ['Technology', 'Financial', 'Consumer'] },
  'chip ban':      { bearish: ['Technology'], bullish: [] },
  'bank failure':  { bearish: ['Financial'], bullish: [] },
  'ai breakthrough':{ bearish: [], bullish: ['Technology'] },
};
// ────────────────────────────────────────────────────────────────────────────


function getCached(key, ttl = SLOW_CACHE_TTL) {
  const entry = _slowCache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

function setCache(key, data) { _slowCache.set(key, { data, ts: Date.now() }); return data; }

async function getMarketauxNews() {
  const MARKETAUX_KEY = process.env.MARKETAUX_KEY || "";
  if (!MARKETAUX_KEY) return [];
  // Return cached data if fresh enough
  if (_marketauxCache.data.length > 0 && Date.now() - _marketauxCache.fetchedAt < MARKETAUX_CACHE_MS) {
    return _marketauxCache.data;
  }
  try {
    const url = `https://api.marketaux.com/v1/news/all?language=en&limit=20&api_token=${MARKETAUX_KEY}&filter_entities=true&must_have_entities=false`;
    const res  = await withTimeout(fetch(url), 8000);
    if (!res.ok) return _marketauxCache.data; // return stale on error
    const data = await res.json();
    if (!data.data) return _marketauxCache.data;
    _marketauxCache = {
      fetchedAt: Date.now(),
      data: data.data.map(a => ({
        headline:    a.title || "",
        summary:     a.description || "",
        source:      (a.source || "").toLowerCase(),
        publishedAt: a.published_at || new Date().toISOString(),
        url:         a.url || "",
      }))
    };
    console.log(`[MARKETAUX] Fetched ${_marketauxCache.data.length} articles`);
    return _marketauxCache.data;
  } catch(e) {
    console.log("[MARKETAUX] Fetch error:", e.message);
    return _marketauxCache.data; // return stale on error
  }
}

function scoreArticle(article) {
  const text       = (article.headline + " " + (article.summary || "")).toLowerCase();
  const source     = (article.source || "").toLowerCase();
  const ageMinutes = (Date.now() - new Date(article.publishedAt || 0).getTime()) / 60000;

  // Source credibility multiplier
  const isCredible    = CREDIBLE_SOURCES.some(s => source.includes(s) || text.includes(s));
  const sourceMult    = isCredible ? 1.5 : 1.0;

  // Recency multiplier - news within 2 hours is most relevant
  const recencyMult   = ageMinutes < 120  ? 2.0   // last 2 hours - breaking news
                      : ageMinutes < 360  ? 1.5   // last 6 hours
                      : ageMinutes < 720  ? 1.2   // last 12 hours
                      : ageMinutes < 1440 ? 1.0   // last 24 hours
                      : 0.5;                      // older - deprioritize

  let bearishScore = 0, bullishScore = 0;
  const triggers = [], sectorImpact = { bearish: new Set(), bullish: new Set() };

  for (const entry of MACRO_BEARISH_KEYWORDS) {
    if (text.includes(entry.kw)) {
      const pts = entry.w * sourceMult * recencyMult;
      bearishScore += pts;
      triggers.push({ kw: entry.kw, pts: parseFloat(pts.toFixed(1)), direction: "bearish" });
      const impact = SECTOR_MACRO_IMPACT[entry.kw];
      if (impact) {
        impact.bearish.forEach(s => sectorImpact.bearish.add(s));
        impact.bullish.forEach(s => sectorImpact.bullish.add(s));
      }
    }
  }

  for (const entry of MACRO_BULLISH_KEYWORDS) {
    if (text.includes(entry.kw)) {
      const pts = entry.w * sourceMult * recencyMult;
      bullishScore += pts;
      triggers.push({ kw: entry.kw, pts: parseFloat(pts.toFixed(1)), direction: "bullish" });
      const impact = SECTOR_MACRO_IMPACT[entry.kw];
      if (impact) {
        impact.bullish.forEach(s => sectorImpact.bullish.add(s));
        impact.bearish.forEach(s => sectorImpact.bearish.add(s));
      }
    }
  }

  return { bearishScore, bullishScore, triggers, sectorImpact,
    sourceMult, recencyMult, isCredible };
}

function analyzeNews(articles) {
  if (!articles || !articles.length) return { modifier: 0, signal: "neutral", headlines: [] };
  const bullishWords = ["beat","beats","raised","upgrade","strong","surge","record","growth","positive","bullish","buy","outperform","exceeds"];
  const bearishWords = ["miss","misses","cut","downgrade","weak","falls","concern","negative","bearish","sell","underperform","below","warning","recall","investigation","lawsuit","fraud"];
  let bullCount = 0, bearCount = 0;
  const headlines = [];
  for (const article of articles.slice(0, 5)) {
    const text = (article.headline + " " + (article.summary || "")).toLowerCase();
    if (bullishWords.some(w => text.includes(w))) bullCount++;
    if (bearishWords.some(w => text.includes(w))) bearCount++;
    headlines.push(article.headline);
  }
  const net = bullCount - bearCount;
  if (net >= 2)  return { modifier: 10,  signal: "bullish",      headlines };
  if (net === 1) return { modifier: 5,   signal: "mild bullish", headlines };
  if (net <= -2) return { modifier: -15, signal: "bearish",      headlines };
  if (net === -1)return { modifier: -8,  signal: "mild bearish", headlines };
  return { modifier: 0, signal: "neutral", headlines };
}

async function getNewsForTicker(ticker) {
  const cached = getCached('news:' + ticker);
  if (cached) return cached;
  try {
    const data = await alpacaGet(`/news?symbols=${ticker}&limit=5`, ALPACA_NEWS);
    const articles = data && data.news ? data.news : [];
    if (articles.length > 0) return setCache('news:' + ticker, articles);

    // Alpaca returned nothing - try Marketaux with company name
    const MARKETAUX_KEY = process.env.MARKETAUX_KEY || "";
    if (MARKETAUX_KEY) {
      const name    = COMPANY_NAMES[ticker] || ticker;
      const url     = `https://api.marketaux.com/v1/news/all?search=${encodeURIComponent(name)}&language=en&limit=3&api_token=${MARKETAUX_KEY}`;
      const res     = await withTimeout(fetch(url), 6000);
      if (res.ok) {
        const mxData = await res.json();
        if (mxData.data && mxData.data.length > 0) {
          // Normalize to Alpaca format
          const normalized = mxData.data.map(a => ({
            headline:   a.title || "",
            summary:    a.description || "",
            created_at: a.published_at || new Date().toISOString(),
            author:     a.source || "Marketaux",
          }));
          return setCache('news:' + ticker, normalized);
        }
      }
    }
    return setCache('news:' + ticker, []);
  } catch(e) { return []; }
}

async function getMacroNews() {
  // Cache for 60 seconds - news doesn't change faster than this
  // Prevents redundant fetches when both the 3-min interval and scan medium tier fire close together
  const cached = getCached("macronews:v1");
  if (cached) return cached;
  try {
    // Fetch from both sources in parallel - Alpaca + Marketaux
    const [alpacaData, marketauxArticles] = await Promise.all([
      alpacaGet(`/news?limit=50`, ALPACA_NEWS),
      getMarketauxNews(),
    ]);

    const alpacaArticles = (alpacaData && alpacaData.news ? alpacaData.news : []).map(a => ({
      headline:    a.headline || "",
      summary:     a.summary  || "",
      source:      (a.author  || "alpaca").toLowerCase(),
      publishedAt: a.created_at || new Date().toISOString(),
    }));

    // Deduplicate by headline similarity - avoid double-counting same story
    const allArticles = [...alpacaArticles];
    for (const ma of marketauxArticles) {
      const isDupe = alpacaArticles.some(a =>
        a.headline.toLowerCase().slice(0,40) === ma.headline.toLowerCase().slice(0,40)
      );
      if (!isDupe) allArticles.push(ma);
    }

    let totalBearish = 0, totalBullish = 0;
    const allTriggers  = [];
    const sectorImpact = { bearish: new Set(), bullish: new Set() };
    const headlines    = []; // for email display
    const topStories   = []; // credible/recent stories for email

    for (const article of allArticles) {
      const scored = scoreArticle(article);
      totalBearish += scored.bearishScore;
      totalBullish += scored.bullishScore;
      scored.triggers.forEach(t => allTriggers.push(t));
      scored.sectorImpact.bearish.forEach(s => sectorImpact.bearish.add(s));
      scored.sectorImpact.bullish.forEach(s => sectorImpact.bullish.add(s));

      if (article.headline) headlines.push(article.headline);

      // Track top stories for email - credible sources with meaningful scores
      if (scored.isCredible && (scored.bearishScore > 0 || scored.bullishScore > 0)) {
        topStories.push({
          headline:  article.headline,
          source:    article.source,
          direction: scored.bullishScore > scored.bearishScore ? "bullish" : "bearish",
          score:     Math.max(scored.bullishScore, scored.bearishScore),
          recencyMult: scored.recencyMult,
        });
      }
    }

    // Sort top stories by score desc, keep top 5
    topStories.sort((a, b) => b.score - a.score);

    const net = totalBullish - totalBearish;
    let signal = "neutral", scoreModifier = 0, mode = "normal";
    // Weighted scoring needs higher threshold than count-based
    if (net <= -10)     { signal = "strongly bearish"; scoreModifier = -20; mode = "defensive"; } // raised from -6: prevents single story triggering defensive
    else if (net <= -3) { signal = "bearish";          scoreModifier = -10; mode = "cautious";  }
    else if (net <= -1) { signal = "mild bearish";     scoreModifier = -5;  mode = "cautious";  }
    else if (net >= 6)  { signal = "strongly bullish"; scoreModifier = 15;  mode = "aggressive";}
    else if (net >= 3)  { signal = "bullish";          scoreModifier = 8;   mode = "normal";    }
    else if (net >= 1)  { signal = "mild bullish";     scoreModifier = 4;   mode = "normal";    }

    // Get unique top triggers by score
    const triggerMap = {};
    for (const t of allTriggers) {
      if (!triggerMap[t.kw] || triggerMap[t.kw] < t.pts) triggerMap[t.kw] = t.pts;
    }
    // MACRO-1: Only include direction-matching triggers in the summary
    // In bearish macro, bullish keywords (e.g. "stocks surge", "accord") are noise
    const isBearishSignal  = net < 0;
    const directionTriggers = Object.entries(triggerMap)
      .filter(([kw]) => {
        // Keep only keywords that match the dominant direction
        const isBearishKw = MACRO_BEARISH_KEYWORDS.some(e => typeof e === 'object' ? e.keyword === kw : e === kw);
        return isBearishSignal ? isBearishKw : !isBearishKw;
      })
      .sort((a,b) => b[1]-a[1])
      .slice(0, 5)
      .map(([kw]) => kw);
    const uniqueTriggers = directionTriggers.length > 0 ? directionTriggers : Object.entries(triggerMap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([kw])=>kw);

    const sourceCount = marketauxArticles.length > 0
      ? `Alpaca(${alpacaArticles.length}) + Marketaux(${marketauxArticles.length})`
      : `Alpaca(${alpacaArticles.length})`;

    if (uniqueTriggers.length > 0) {
      logEvent("macro", `Macro: ${signal} | ${sourceCount} | triggers: ${uniqueTriggers.join(", ")} | modifier: ${scoreModifier > 0 ? "+" : ""}${scoreModifier}`);
    }
    // Check for macro shift even on keyword path
    _checkMacroShift(signal);
    // SCORE-1: Seed _agentMacro from keyword result when agent hasn't run yet
    // Without this, first scan after boot scores with no agent signal (neutral default)
    // even when macro is clearly bearish from keywords
    if (!state._agentMacro || !state._agentMacro.timestamp) {
      const seededSignal = signal; // keyword signal as temporary seed
      const seedRegime   = signal === "strongly bearish" ? "trending_bear"
                         : signal === "bearish"          ? "trending_bear"
                         : signal === "mild bearish"     ? "choppy"
                         : signal === "strongly bullish" ? "trending_bull"
                         : signal === "bullish"          ? "trending_bull"
                         : "neutral";
      markDirty(); // C6: persist agent macro immediately -- drives all gate decisions
      state._agentMacro = {
        signal:      seededSignal,
        confidence:  "medium", // keyword is less reliable than agent - medium confidence
        regime:      seedRegime,
        entryBias:   signal.includes("bearish") ? "puts_on_bounces" : signal.includes("bullish") ? "calls_on_dips" : "neutral",
        tradeType:   "spread",
        vixOutlook:  state.vix >= 30 ? "spiking" : state.vix >= 25 ? "elevated_stable" : "unknown",
        timestamp:   new Date().toISOString(),
        _seededFromKeyword: true, // flag - will be overwritten when agent runs
      };
      logEvent("scan", `[AGENT] No prior signal - seeding _agentMacro from keyword: ${seededSignal} (medium conf) - agent will override on next run`);
    }

    // - Agent enhancement - replace keyword scoring with Claude analysis -
    // Only use agent during market hours + 30min pre/post - saves ~40% API cost
    const etNow = getETTime();
    const etH = etNow.getHours() + etNow.getMinutes() / 60;
    const agentWindowOpen = etH >= 8.5 && etH <= 17.0; // 8:30am-5pm ET
    if (ANTHROPIC_API_KEY && headlines.length > 0 && agentWindowOpen) {
      try {
        logEvent("macro", `[AGENT] Running macro analysis (${headlines.length} headlines)...`);
        const agentResult = await getAgentMacroAnalysis(headlines);
        if (agentResult) {
          // Store for rescore use
          state._agentMacro = {
            ...agentResult,
            timestamp: new Date().toISOString(),
            // AG-6: exitUrgency - trim/exit open positions if thesis broken
            exitUrgency:      agentResult.exitUrgency      || "hold",
            // AG-7: positionSizeMult - continuous sizing vs binary riskLevel
            positionSizeMult: agentResult.positionSizeMult || 1.0,
            // AG-9: schemaVersion - backward compat
            schemaVersion:    agentResult.schemaVersion    || 1,
          };
                    const _r = state._regimeClass;
          const _s = state._agentMacro.signal;
          if (_r === "B" || _r === "C") {
            state._agentMacro.entryBias = "puts_on_bounces";
          } else if (_r === "A") {
            state._agentMacro.entryBias = "calls_on_dips";
          } else {
            if (_s.includes("bearish")) state._agentMacro.entryBias = "puts_on_bounces";
            else if (_s.includes("bullish")) state._agentMacro.entryBias = "calls_on_dips";
            else state._agentMacro.entryBias = "neutral";
          }
          // Apply intraday regime override if signal is strong enough
          _applyIntradayRegimeOverride(agentResult);
          // AG-6: Apply exit urgency signal
          _applyExitUrgency(agentResult);
          // Map agent result to expected format
          const agentModeMap = {
            "strongly bearish": { modifier: -20, mode: "defensive" },
            "bearish":          { modifier: -10, mode: "cautious"  },
            "mild bearish":     { modifier: -5,  mode: "cautious"  },
            "neutral":          { modifier: 0,   mode: "normal"    },
            "mild bullish":     { modifier: 4,   mode: "normal"    },
            "bullish":          { modifier: 8,   mode: "normal"    },
            "strongly bullish": { modifier: 15,  mode: "aggressive"},
          };
          const mapped = agentModeMap[agentResult.signal] || { modifier: 0, mode: "normal" };
          const result = {
            signal:       agentResult.signal,
            scoreModifier:mapped.modifier,
            mode:         mapped.mode, // always derive from signal - never trust agent mode field directly
            triggers:     agentResult.keyThemes || [],
            topStories:   (agentResult.topStories || []).slice(0, 5).map(s => ({
              headline:    s.headline,
              source:      s.source || "agent",
              direction:   s.direction || "neutral",
              score:       s.importance === "high" ? 10 : s.importance === "medium" ? 5 : 2,
              recencyMult: 2.0,
            })),
            sectorBearish: [...sectorImpact.bearish],
            sectorBullish: [...sectorImpact.bullish],
            headlines:     headlines.slice(0, 15),
            agentReasoning: agentResult.reasoning || "",
            agentConfidence: agentResult.confidence || "medium",
            bearishTickers: agentResult.bearishTickers || [],
            bullishTickers: agentResult.bullishTickers || [],
            sourceCount:   sourceCount + " + Claude",
            updatedAt:     new Date().toISOString(),
          };
          setCache("macronews:v1", result, 60);
          return result;
        }
      } catch(agentErr) {
        logEvent("warn", `[AGENT] Macro analysis failed, using keywords: ${agentErr.message}`);
      }
    }

    // Keyword fallback
    const kwResult = {
      signal, scoreModifier, mode,
      bearishScore: parseFloat(totalBearish.toFixed(1)),
      bullishScore: parseFloat(totalBullish.toFixed(1)),
      triggers: uniqueTriggers,
      topStories: topStories.slice(0, 5),
      sectorBearish: [...sectorImpact.bearish],
      sectorBullish: [...sectorImpact.bullish],
      headlines: headlines.slice(0, 15),
      sourceCount,
      updatedAt: new Date().toISOString(),
    };
    setCache("macronews:v1", kwResult, 60);
    return kwResult;
  } catch(e) {
    logEvent("error", `getMacroNews: ${e.message}`);
    return { signal: "neutral", scoreModifier: 0, mode: "normal", triggers: [], topStories: [], sectorBearish: [], sectorBullish: [] };
  }
}

async function getFearAndGreed() {
  const cached = getCached("feargreed:v1");
  if (cached) return cached;
  try {
    const res  = await withTimeout(fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata"), 5000);
    const data = await res.json();
    const score  = data?.fear_and_greed?.score || 50;
    const rating = data?.fear_and_greed?.rating || "neutral";
    const result = { score: parseFloat(parseFloat(score).toFixed(0)), rating };
    setCache("feargreed:v1", result, 300); // 5 minute TTL - updates once per day
    return result;
  } catch(e) { return { score: 50, rating: "neutral" }; }
}

async function getMarketBreadth() {
  // TODO #1 FIX: Use intraday bars (open vs current) instead of daily bars
  // Daily bars don't update during the session — stale during sharp intraday reversals
  // This was causing breadth to show 80% while RSI had already collapsed to 18-34
  // Fix: compare current price to open price using intraday bars — updates every scan
  try {
    const sectors = ["XLK","XLF","XLE","XLV","XLI","XLY","XLP","XLU","XLB","XLRE"];
    // Also include new data tickers for richer breadth signal
    const breadthTickers = [...sectors, "SMH", "IWM", "HYG"];
    const allBars = await Promise.all(breadthTickers.map(etf =>
      getIntradayBars(etf, 1).catch(() => [])
    ));
    let advancing = 0, declining = 0, strength = 0;
    allBars.forEach(bars => {
      if (bars && bars.length > 0) {
        const bar = bars[bars.length - 1];
        if (bar && bar.o > 0 && bar.c > 0) {
          if (bar.c > bar.o) { advancing++; strength += (bar.c - bar.o) / bar.o; }
          else { declining++; strength -= (bar.o - bar.c) / bar.o; }
        }
      }
    });
    const total      = advancing + declining;
    const breadthPct = total > 0 ? (advancing / total) * 100 : 50;
    // breadthStrength: magnitude of move, useful for scoring (positive = broad strength)
    const breadthStrength = parseFloat((strength * 100).toFixed(2));
    return { advancing, declining, breadthPct: parseFloat(breadthPct.toFixed(0)), breadthStrength };
  } catch(e) { return { advancing: 5, declining: 5, breadthPct: 50, breadthStrength: 0 }; }
}

async function getSyntheticPCR() {
  try {
    const cached = getCached("pcr:spy");
    if (cached) return cached;

    // Fetch SPY options chain - already have this infrastructure
    const today  = new Date().toISOString().split("T")[0];
    const expiry = new Date(Date.now() + 45 * MS_PER_DAY).toISOString().split("T")[0]; // 0-45 DTE full range
    const url    = `/options/snapshots/SPY?feed=indicative&limit=1000&expiration_date_gte=${today}&expiration_date_lte=${expiry}`;
    const data   = await alpacaGet(url, ALPACA_OPT_SNAP);

    if (!data || !data.snapshots) return null;

    let putOI = 0, callOI = 0, putVol = 0, callVol = 0;
    let contractsFound = 0;
    for (const [sym, snap] of Object.entries(data.snapshots)) {
      // Alpaca snapshot fields: openInterest (not greeks.open_interest), dailyBar.v (not .volume)
      const oi  = parseFloat(snap.openInterest || snap.greeks?.open_interest || 0);
      const vol = parseFloat(snap.dailyBar?.v || snap.dailyBar?.volume || 0);
      // Option type character after the 6-digit date: SPY260419P00500000
      const optChar = sym.match(/\d{6}([CP])\d/)?.[1];
      if (optChar === "P") { putOI  += oi; putVol  += vol; }
      else if (optChar === "C") { callOI += oi; callVol += vol; }
      contractsFound++;
    }
    if (contractsFound === 0) return null;

    const oiPCR  = callOI  > 0 ? parseFloat((putOI  / callOI ).toFixed(3)) : null;
    const volPCR = callVol > 0 ? parseFloat((putVol / callVol).toFixed(3)) : null;
    // Blend OI and volume PCR - OI is more stable, vol is more current
    const pcr = oiPCR && volPCR
      ? parseFloat(((oiPCR * 0.6 + volPCR * 0.4)).toFixed(3))
      : (oiPCR || volPCR);

    const signal = !pcr ? "neutral"
      : pcr > 1.3  ? "extreme_fear"    // very strong contrarian call signal
      : pcr > 1.1  ? "fear"            // contrarian call signal
      : pcr < 0.45 ? "extreme_greed"   // very strong contrarian put signal
      : pcr < 0.6  ? "greed"           // contrarian put signal
      : "neutral";

    const result = { pcr, oiPCR, volPCR, signal };
    setCache("pcr:spy", result);
    return result;
  } catch(e) {
    return null;
  }
}

async function getVolTermStructure() {
  try {
    const cached = getCached("vol:termstruct");
    if (cached) return cached;

    const today     = new Date();
    const nearExp   = new Date(today.getTime() + 20 * MS_PER_DAY).toISOString().split("T")[0];
    const farExp    = new Date(today.getTime() + 50 * MS_PER_DAY).toISOString().split("T")[0];

    // Fetch ATM options for near and far expiry to get IV
    // Use live SPY quote if state.spyPrice not yet populated
    let spyPrice = state.spyPrice || 0;
    if (!spyPrice || spyPrice < 100) {
      const liveQ = await getStockQuote("SPY").catch(() => null);
      spyPrice = liveQ || 500; // hard fallback if quote fails
    }
    const nearStrike = Math.round(spyPrice / 5) * 5; // nearest $5 strike

    const [nearData, farData] = await Promise.all([
      alpacaGet(`/options/snapshots/SPY?feed=indicative&limit=50&expiration_date_gte=${nearExp}&strike_price_gte=${nearStrike - 10}&strike_price_lte=${nearStrike + 10}&type=put`, ALPACA_OPT_SNAP),
      alpacaGet(`/options/snapshots/SPY?feed=indicative&limit=50&expiration_date_gte=${farExp}&strike_price_gte=${nearStrike - 10}&strike_price_lte=${nearStrike + 10}&type=put`, ALPACA_OPT_SNAP),
    ]);

    const getAvgIV = (data) => {
      if (!data?.snapshots) return null;
      const ivs = Object.values(data.snapshots)
        .map(s => parseFloat(s.greeks?.iv || s.impliedVolatility || 0))
        .filter(iv => iv > 0.05 && iv < 2.0);
      return ivs.length ? ivs.reduce((a,b)=>a+b,0)/ivs.length : null;
    };

    const nearIV = getAvgIV(nearData);
    const farIV  = getAvgIV(farData);
    if (!nearIV || !farIV) return null;

    const ratio  = parseFloat((nearIV / farIV).toFixed(3));
    // Ratio > 1.0 = backwardation (near > far = acute fear)
    // Ratio < 1.0 = contango (far > near = normal)
    const structure = ratio > 1.15 ? "steep_backwardation"  // extreme fear, sell puts
                    : ratio > 1.05 ? "mild_backwardation"    // elevated fear
                    : ratio < 0.90 ? "steep_contango"        // very calm, calls cheap
                    : ratio < 0.97 ? "mild_contango"         // normal
                    : "flat";

    const creditFavorable = ratio > 1.05; // backwardation = near-term IV elevated = good for credit
    const callFavorable   = ratio < 0.95; // contango = calls relatively cheap

    const result = { nearIV: parseFloat(nearIV.toFixed(4)), farIV: parseFloat(farIV.toFixed(4)), ratio, structure, creditFavorable, callFavorable };
    setCache("vol:termstruct", result);
    return result;
  } catch(e) { return null; }
}

async function getCBOESKEW() {
  // Synthetic SKEW — computed from SPY options chain IV smirk
  // Replaces cdn.cboe.com dependency (blocked on Railway)
  // Methodology: compare avg IV of OTM puts (delta 0.15-0.25) vs ATM puts (delta 0.45-0.55)
  // smirkRatio > 1.30 = steep smirk = market pricing heavy tail risk = "extreme"
  // smirkRatio > 1.15 = elevated smirk = good credit put environment = "elevated"
  // smirkRatio < 1.05 = flat smirk = tail risk not priced = "low"
  try {
    const cached = getCached("synth:skew");
    if (cached) return cached;

    const today  = getETTime().toISOString().split("T")[0];
    const expMax = new Date(getETTime().getTime() + 35 * 86400000).toISOString().split("T")[0];
    // Fetch SPY puts in 14-35 DTE window — liquid strikes, IV well-defined
    const data = await alpacaGet(
      `/options/snapshots/SPY?feed=indicative&limit=200&type=put&expiration_date_gte=${today}&expiration_date_lte=${expMax}`,
      ALPACA_OPT_SNAP
    );
    if (!data?.snapshots) return null;

    const otmIVs = [], atmIVs = [];
    for (const snap of Object.values(data.snapshots)) {
      const delta = Math.abs(parseFloat(snap.greeks?.delta || 0));
      const iv    = parseFloat(snap.impliedVolatility || snap.greeks?.iv || 0);
      if (!delta || !iv || iv < 0.05 || iv > 3.0) continue;
      if (delta >= 0.15 && delta <= 0.25) otmIVs.push(iv);  // OTM puts
      if (delta >= 0.45 && delta <= 0.55) atmIVs.push(iv);  // ATM puts
    }

    if (otmIVs.length < 3 || atmIVs.length < 3) return null;

    const avgOTM = otmIVs.reduce((a,b)=>a+b,0) / otmIVs.length;
    const avgATM = atmIVs.reduce((a,b)=>a+b,0) / atmIVs.length;
    const smirkRatio = parseFloat((avgOTM / avgATM).toFixed(3));

    // Map smirk ratio to SKEW-equivalent signal
    // Historical calibration: CBOE SKEW 130 ~ smirkRatio 1.20, SKEW 140 ~ smirkRatio 1.30
    const signal = smirkRatio >= 1.30 ? "extreme"
                 : smirkRatio >= 1.15 ? "elevated"
                 : smirkRatio >= 1.05 ? "moderate"
                 : smirkRatio <  1.02 ? "low"
                 : "neutral";

    const creditPutIdeal = smirkRatio >= 1.15 && (state.vix || 20) >= 25;
    // Express as pseudo-SKEW index for logging (rough equivalence)
    const skewEquiv = Math.round(100 + (smirkRatio - 1.0) * 200);

    const result = { skew: skewEquiv, smirkRatio, avgOTM: parseFloat(avgOTM.toFixed(4)),
                     avgATM: parseFloat(avgATM.toFixed(4)), signal, creditPutIdeal,
                     source: "synthetic" };
    setCache("synth:skew", result);
    return result;
  } catch(e) {
    logEvent("warn", `[SKEW] Synthetic computation failed: ${e.message}`);
    return null;
  }
}

async function getCBOEPCR() { return null; }

async function getSentimentSignal() {
  try {
    const cached = getCached("sentiment:signal");
    if (cached) return cached;

    // VIX momentum: how fast is VIX moving? Spiking = fear, falling = complacency
    const vixNow  = state.vix || 20;
    const vixHist = state._vixHistory || [];
    const vix5dAgo = vixHist.length >= 5 ? vixHist[vixHist.length - 5] : vixNow;
    const vixMomentum = vixNow - vix5dAgo; // positive = rising fear, negative = falling

    // SPY drawdown from recent peak (last 20 bars)
    const spyBarsRecent = state._spyBars20 || [];
    const spyPeak = spyBarsRecent.length > 0 ? Math.max(...spyBarsRecent.map(b => b.h || b.c)) : 0;
    const spyNow  = state.spyPrice || 0;
    const spyDrawdown = spyPeak > 0 && spyNow > 0
      ? parseFloat(((spyNow - spyPeak) / spyPeak * 100).toFixed(2))
      : 0;

    // Breadth context
    const breadth = marketContext?.breadth?.breadthPct || 50;

    // Classify sentiment
    // extreme_bearish: VIX spiking hard AND big drawdown AND breadth collapsed
    // extreme_bullish: VIX falling fast AND breadth strong AND near highs
    let signal, bullish, bearish;

    if (vixMomentum >= 8 && spyDrawdown <= -5 && breadth <= 30) {
      signal = "extreme_bearish"; bullish = 20; bearish = 60;
    } else if (vixMomentum >= 4 && spyDrawdown <= -3) {
      signal = "bearish"; bullish = 30; bearish = 50;
    } else if (vixMomentum <= -5 && spyDrawdown >= -1 && breadth >= 65) {
      signal = "extreme_bullish"; bullish = 65; bearish = 15;
    } else if (vixMomentum <= -3 && breadth >= 55) {
      signal = "bullish"; bullish = 55; bearish = 25;
    } else {
      signal = "neutral"; bullish = 40; bearish = 40;
    }

    const result = {
      signal, bullish, bearish, spread: bullish - bearish,
      vixMomentum: parseFloat(vixMomentum.toFixed(1)),
      spyDrawdown,
      source: "synthetic",
    };
    setCache("sentiment:signal", result);
    return result;
  } catch(e) {
    return null;
  }
}

async function getAAIISentiment() {
  try {
    const cached = getCached("aaii:sentiment");
    if (cached) return cached;

    // AAII publishes weekly sentiment - try multiple endpoints
    // Primary: AAII investor sentiment page (may need HTML parsing)
    // Fallback: Use manually set value via /api/set-aaii endpoint
    if (state._aaiiManual) {
      // Manual override set by user - use it (lasts until next Thursday)
      return state._aaiiManual;
    }

    // Try fetching AAII data - endpoint may vary
    let bullish = 0, bearish = 0, neutral = 0, date = "unknown";
    const urls = [
      "https://www.aaii.com/sentimentsurvey/sent_results.js",
      "https://surveys.aaii.com/sentiment/sentiment_data.json",
    ];

    let parsed = false;
    for (const url of urls) {
      try {
        const res = await withTimeout(fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" }
        }), 4000);
        if (!res.ok) continue;
        const text = await res.text();
        // Try JSON parse first
        try {
          const data = JSON.parse(text);
          const latest = Array.isArray(data) ? data[data.length-1] : data;
          bullish = parseFloat(latest?.bullish || latest?.Bullish || latest?.bull || 0);
          bearish = parseFloat(latest?.bearish || latest?.Bearish || latest?.bear || 0);
          neutral = parseFloat(latest?.neutral || latest?.Neutral || 0);
          date    = latest?.date || latest?.Date || "unknown";
          if (bullish > 0) { parsed = true; break; }
        } catch(e) {
          // Try regex extraction from JS/HTML
          const bullMatch = text.match(/[Bb]ullish["\s:]+(\d+\.?\d*)/);
          const bearMatch = text.match(/[Bb]earish["\s:]+(\d+\.?\d*)/);
          if (bullMatch && bearMatch) {
            bullish = parseFloat(bullMatch[1]);
            bearish = parseFloat(bearMatch[1]);
            neutral = Math.max(0, 100 - bullish - bearish);
            parsed = true; break;
          }
        }
      } catch(e) { continue; }
    }
    if (!bullish) return null;

    // Historical thresholds (Ned Davis Research validation):
    // Bulls < 20% = extreme pessimism = contrarian buy (call signal)
    // Bulls > 55% = extreme optimism = contrarian sell (put signal)
    // Spread (bull-bear) < -20 = strong contrarian buy signal
    const spread  = bullish - bearish;
    const signal  = bullish < 20 ? "extreme_bearish"   // strong contrarian call
                  : bullish < 30 ? "bearish"            // mild contrarian call
                  : bullish > 55 ? "extreme_bullish"    // strong contrarian put
                  : bullish > 45 ? "bullish"            // mild contrarian put
                  : "neutral";

    const result = { bullish, bearish, neutral, spread: parseFloat(spread.toFixed(1)), signal, date };
    // Cache for 24 hours - weekly data published every Thursday
    _slowCache.set("aaii:sentiment", { data: result, ts: Date.now() - (SLOW_CACHE_TTL - 24*60*60*1000) });
    return result;
  } catch(e) {
    logEvent("warn", `[AAII] Sentiment fetch failed: ${e.message}`);
    return null;
  }
}

async function getDXY() {
  try {
    const bars = await getStockBars("UUP", 5);
    if (bars.length < 2) return { trend: "neutral", change: 0 };
    const change = (bars[bars.length-1].c - bars[0].c) / bars[0].c * 100;
    return {
      trend:  change > 0.3 ? "strengthening" : change < -0.3 ? "weakening" : "neutral",
      change: parseFloat(change.toFixed(2))
    };
  } catch(e) { return { trend: "neutral", change: 0 }; }
}

async function getYieldCurve() {
  try {
    const tlt = await getStockBars("TLT", 5);
    const shy = await getStockBars("SHY", 5);
    if (!tlt.length || !shy.length) return { signal: "normal" };
    const tltChange = (tlt[tlt.length-1].c - tlt[0].c) / tlt[0].c;
    const shyChange = (shy[shy.length-1].c - shy[0].c) / shy[0].c;
    if (tltChange < shyChange - 0.005) return { signal: "steepening" };
    if (tltChange > shyChange + 0.005) return { signal: "flattening" };
    return { signal: "normal" };
  } catch(e) { return { signal: "normal" }; }
}

async function getEarningsDate(ticker) {
  // OPT2: Cache for 6 hours — earnings dates don't change intraday
  // Was: raw Alpaca corporate actions call every scan per ticker (1,080 calls/hour)
  const _earningsCacheKey = `earnings:${ticker}`;
  const _earningsCached   = getCached(_earningsCacheKey, 6 * 60 * 60 * 1000);
  if (_earningsCached !== null && _earningsCached !== undefined) return _earningsCached;
  try {
    const today = getETTime().toISOString().split("T")[0];
    const end   = new Date(Date.now() + 60 * MS_PER_DAY).toISOString().split("T")[0];
    const data  = await alpacaGet(`/corporate_actions/announcements?ca_types=Earnings&symbols=${ticker}&since=${today}&until=${end}`, ALPACA_DATA);
    if (data && data.announcements && data.announcements.length > 0) {
      return setCache(_earningsCacheKey, data.announcements[0].ex_date || null);
    }
    return setCache(_earningsCacheKey, null);
  } catch(e) { return null; }
}

async function getAnalystActivity(ticker) {
  const cached = getCached('analyst:' + ticker);
  if (cached) return cached;
  try {
    const data = await alpacaGet(`/news?symbols=${ticker}&limit=10`, ALPACA_NEWS);
    const articles = data && data.news ? data.news : [];
    const upgrades   = [];
    const downgrades = [];
    const upgradeKW  = ["upgrade", "upgraded", "outperform", "overweight", "buy rating", "price target raised", "pt raised"];
    const downgradeKW= ["downgrade", "downgraded", "underperform", "underweight", "sell rating", "price target cut", "pt cut", "pt lowered"];
    for (const a of articles) {
      const text = (a.headline + " " + (a.summary || "")).toLowerCase();
      if (upgradeKW.some(k => text.includes(k)))   upgrades.push(a.headline);
      if (downgradeKW.some(k => text.includes(k))) downgrades.push(a.headline);
    }
    return setCache('analyst:' + ticker, { upgrades, downgrades,
      signal: upgrades.length > downgrades.length ? "bullish" : downgrades.length > upgrades.length ? "bearish" : "neutral",
      modifier: (upgrades.length - downgrades.length) * 5
    });
  } catch(e) { return { upgrades: [], downgrades: [], signal: "neutral", modifier: 0 }; }
}

async function getShortInterestSignal(ticker, bars) {
  // True short interest requires paid data feed
  // Approximate squeeze potential from: price momentum + volume spike + RSI
  try {
    if (!bars || bars.length < 10) return { squeezeRisk: "low", modifier: 0 };
    const recentVol  = bars.slice(-5).reduce((s, b) => s + b.v, 0) / 5;
    const avgVol     = bars.slice(-20).reduce((s, b) => s + b.v, 0) / 20;
    const volRatio   = avgVol > 0 ? recentVol / avgVol : 1;
    const priceMove  = bars.length >= 5 ? (bars[bars.length-1].c - bars[bars.length-5].c) / bars[bars.length-5].c : 0;
    // High volume + strong upward move = potential short squeeze
    if (volRatio > 2.5 && priceMove > 0.05)  return { squeezeRisk: "high",   modifier: 15 };
    if (volRatio > 1.5 && priceMove > 0.02)  return { squeezeRisk: "medium", modifier: 8  };
    return { squeezeRisk: "low", modifier: 0 };
  } catch(e) { return { squeezeRisk: "low", modifier: 0 }; }
}

// MACRO_EVENTS_2025 moved to top


function getUpcomingMacroEvents(daysAhead = 7) {
  // Compare date strings to avoid timezone/time-of-day issues
  const todayStr = getETTime().toISOString().split("T")[0]; // "2026-03-17"
  const todayDate = new Date(todayStr);
  const events = [];
  for (const ev of MACRO_EVENTS_2025) {
    const evDate = new Date(ev.date);
    const daysTo = Math.round((evDate - todayDate) / MS_PER_DAY);
    if (daysTo >= 0 && daysTo <= daysAhead) {
      events.push({ ...ev, daysTo });
    }
  }
  return events;
}

function getMacroCalendarModifier() {
  const events = getUpcomingMacroEvents(3);
  if (!events.length) return { modifier: 0, events: [] };
  const highImpact = events.filter(e => e.impact === "high");
  // Within 3 days of FOMC - reduce position sizing, avoid new entries day-of
  if (highImpact.length > 0) {
    const soonest = highImpact.sort((a, b) => a.daysTo - b.daysTo)[0];
    if (soonest.daysTo === 0) return { modifier: -25, events, message: `${soonest.event} TODAY - minimal new entries` };
    if (soonest.daysTo <= 1) return { modifier: -15, events, message: `${soonest.event} tomorrow - reduced sizing` };
    if (soonest.daysTo <= 3) return { modifier: -8,  events, message: `${soonest.event} in ${soonest.daysTo} days - caution` };
  }
  return { modifier: 0, events };
}

async function getPreMarketData(ticker) {
  const cached = getCached('premarket:' + ticker);
  if (cached) return cached;
  try {
    // Get latest quote - pre-market activity shows in extended hours
    const snap = await alpacaGet(`/stocks/${ticker}/snapshot`, ALPACA_DATA);
    if (!snap) return null;
    const prevClose   = snap.prevDailyBar  ? snap.prevDailyBar.c  : null;
    const preMarket   = snap.minuteBar     ? snap.minuteBar.c     : null;
    const dailyOpen   = snap.dailyBar      ? snap.dailyBar.o      : null;
    if (!prevClose || !preMarket) return null;
    const gapPct      = (preMarket - prevClose) / prevClose * 100;
    return setCache('premarket:' + ticker, { prevClose, preMarket, gapPct: parseFloat(gapPct.toFixed(2)) });
  } catch(e) { return null; }
}

function checkVIXVelocity(currentVIX) {
  if (lastVIXReading === 0) { lastVIXReading = currentVIX; return false; }
  const delta   = currentVIX - lastVIXReading;
  const prevVIX = lastVIXReading; // save before updating
  lastVIXReading = currentVIX;
  const fallPct = prevVIX > 0 ? (delta / prevVIX) : 0;

  // Black swan: VIX spiked 8+ points — close all positions + set flash crash cooldown
  if (delta >= 8) {
    state._vixSpikeAt = Date.now(); // V3.2: 48h cooldown on debit put re-entry after spike
    markDirty();
    logEvent("circuit", `VIX VELOCITY ALERT - jumped ${delta.toFixed(1)} points to ${currentVIX} - closing all positions`);
    return true;
  }

  // VIX falling >3% = market recovering = pause new put entries
  // Falling VIX means options premiums deflating - puts entered now lose value fast
  if (delta <= -1.0 && fallPct <= -0.03) {
    if (!vixFallingPause) logEvent("filter", `VIX falling (${delta.toFixed(1)} pts) - pausing new PUT entries until VIX stabilizes`);
    vixFallingPause = true;
  } else if (delta >= 0) {
    // VIX stable or rising - resume put entries
    if (vixFallingPause) logEvent("filter", `VIX stabilized - resuming PUT entries`);
    vixFallingPause = false;
  }
  return false;
}

function getVIXReversionDays(vix) {
  // Based on G&W empirical half-life estimates by VIX regime
  if (vix >= 40) return 8;   // extreme VIX reverts fastest (mean-pull strongest)
  if (vix >= 35) return 12;  // very elevated - expect 2-3 week reversion
  if (vix >= 30) return 18;  // elevated - 3-4 week typical reversion
  if (vix >= 25) return 25;  // moderately elevated
  return 40;                  // near normal - slow reversion
}

async function getEarningsQualityScore(ticker, bars) {
  try {
    if (!bars || bars.length < 30) return { score: 50, signal: "unknown" };
    const bigMoves = [];
    for (let i = 1; i < bars.length; i++) {
      const move = Math.abs((bars[i].c - bars[i-1].c) / bars[i-1].c * 100);
      if (move > 3) bigMoves.push({ move, direction: bars[i].c > bars[i-1].c ? 1 : -1 });
    }
    if (!bigMoves.length) return { score: 50, signal: "neutral" };
    const positiveMoves = bigMoves.filter(m => m.direction > 0).length;
    const score = Math.round((positiveMoves / bigMoves.length) * 100);
    return { score, signal: score >= 65 ? "positive" : score <= 35 ? "negative" : "mixed", bigMoves: bigMoves.length, positiveReactions: positiveMoves };
  } catch(e) { return { score: 50, signal: "unknown" }; }
}

async function getVIX() {
  // OPT-2: 60s TTL -- VIX at 30s granularity has zero trading value, saves 1 API call/scan
  if (Date.now() - _vixCache.ts < 60000) return _vixCache.value;
  const data = await alpacaGet(`/stocks/VIXY/quotes/latest`, ALPACA_DATA);
  if (data && data.quote) {
    _vixCache = { value: parseFloat(data.quote.ap || 15), ts: Date.now() };
    return _vixCache.value;
  }
  return _vixCache.value; // return last known on error
}



function setMarketContext(ctx) { marketContext = ctx; }
module.exports = {
  getCached, setCache, getMacroNews, getFearAndGreed, getMarketBreadth,
  getSyntheticPCR, getVolTermStructure, getCBOESKEW, getSentimentSignal,
  getDXY, getYieldCurve, getEarningsDate, getNewsForTicker, analyzeNews,
  scoreArticle, getAnalystActivity, getShortInterestSignal,
  getUpcomingMacroEvents, getMacroCalendarModifier, getPreMarketData,
  checkVIXVelocity, getVIXReversionDays, getVIX, setMarketContext, registerMacroCallbacks,
};
