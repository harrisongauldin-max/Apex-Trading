// reporting.js — ARGO V3.2
// Email delivery, morning briefings, end-of-day reports.
'use strict';
const fetch = require('node-fetch');
const { withTimeout } = require('./broker');
const { state, logEvent, saveStateNow, markDirty } = require('./state');
const { realizedPnL, openRisk, openCostBasis,
        getETTime, isMarketHours }                 = require('./signals');
const { RESEND_API_KEY, GMAIL_USER, MONTHLY_BUDGET,
        CAPITAL_FLOOR }                            = require('./constants');

let _getAgentBriefing = async () => '';
let _getMacroNews     = async () => ({});
let _getDrawdown      = () => ({ level: 'normal' });
let _getFearGreed     = async () => ({ score: 50, label: 'Neutral' });
let _getVIX           = async () => null;

function initReporting({ getAgentMorningBriefing, getMacroNews,
                         getDrawdownProtocol, getFearAndGreed, getVIX } = {}) {
  if (getAgentMorningBriefing) _getAgentBriefing = getAgentMorningBriefing;
  if (getMacroNews)            _getMacroNews     = getMacroNews;
  if (getDrawdownProtocol)     _getDrawdown      = getDrawdownProtocol;
  if (getFearAndGreed)         _getFearGreed     = getFearAndGreed;
  if (getVIX)                  _getVIX           = getVIX;
}

// ─── marketContext placeholder (reporting reads it for email content) ─
let _marketContext = {};
function setReportingContext(ctx) { _marketContext = ctx; }

async function sendResendEmail(subject, html) {
  if (!RESEND_API_KEY || !GMAIL_USER) {
    console.log("[EMAIL] Resend not configured - set RESEND_API_KEY and GMAIL_USER in Railway");
    return false;
  }
  try {
    const res  = await withTimeout(fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    "ARGO-V3.0 <onboarding@resend.dev>",
        to:      [GMAIL_USER],
        subject,
        html,
      }),
    }), 10000);
    const data = await res.json();
    if (data.id) {
      console.log(`[EMAIL] Sent via Resend: ${data.id}`);
      return true;
    } else {
      console.log("[EMAIL] Resend error:", JSON.stringify(data));
      return false;
    }
  } catch(e) {
    console.log("[EMAIL] Resend failed:", e.message);
    return false;
  }
}

async function sendEmail(type) {
  if (!RESEND_API_KEY || !GMAIL_USER) { logEvent("warn", "Email not configured"); return; }
  const subject = type === "morning"
    ? `ARGO-V3.0 Morning Briefing - ${new Date().toLocaleDateString()}`
    : `ARGO-V3.0 EOD Report - P&L ${(state.cash-state.dayStartCash)>=0?"+":""}$${(state.cash-state.dayStartCash).toFixed(2)}`;
  try {
    await sendResendEmail(subject, buildEmailHTML(type));
    logEvent("email", `${type} email sent to ${GMAIL_USER}`);
  } catch(e) { logEvent("error", `Email failed: ${e.message}`); }
}

function buildEmailHTML(type) {
  const pnl    = realizedPnL();
  const trades = state.closedTrades;
  const wins   = trades.filter(t=>t.pnl>0);
  const heat   = (heatPct()*100).toFixed(0);
  const curPortfolio = state.cash + openRisk() ;
  const daily  = (curPortfolio - state.dayStartCash).toFixed(2);
  const weekly = (curPortfolio - state.weekStartCash).toFixed(2);

  const posRows = state.positions.map(p => {
    const strikeLabel = p.isSpread ? `$${p.buyStrike}/$${p.sellStrike} ${p.optionType.toUpperCase()} SPRD` : `$${p.strike}${p.optionType === 'put' ? 'P' : 'C'}`;
    return `<tr><td>${p.ticker}</td><td>${strikeLabel}</td><td>${p.expDate}</td><td>${p.contracts}x</td><td>$${p.premium}</td><td>${p.score||"?"}/100</td></tr>`;
  }).join("") || "<tr><td colspan='6' style='color:#666'>No open positions</td></tr>";

  const recentTrades = trades.slice(-5).reverse().map(t =>
    `<tr><td>${t.ticker}</td><td style='color:${t.pnl>=0?"#00aa44":"#cc2222"}'>${t.pnl>=0?"+":""}$${t.pnl.toFixed(2)}</td><td>${t.reason}</td><td>${t.date}</td></tr>`
  ).join("") || "<tr><td colspan='4' style='color:#666'>No trades yet</td></tr>";

  const isGood = parseFloat(daily) >= 0;

  return `
<!DOCTYPE html><html><body style="font-family:monospace;background:#07101f;color:#cce8ff;padding:20px;max-width:600px">
<div style="background:#0a1628;border:1px solid #0d3050;border-radius:12px;padding:20px;margin-bottom:16px">
  <h2 style="color:#00ff88;margin:0 0 4px">- ARGO-V3.0 ${type === "morning" ? "Morning Briefing" : "End of Day Report"}</h2>
  <p style="color:#336688;margin:0;font-size:12px">${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</p>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
  <div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px">
    <div style="font-size:10px;color:#336688">CASH</div>
    <div style="font-size:18px;font-weight:700;color:#00ff88">${fmt(state.cash)}</div>
  </div>
  <div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px">
    <div style="font-size:10px;color:#336688">DAILY P&L</div>
    <div style="font-size:18px;font-weight:700;color:${isGood?"#00ff88":"#ff5555"}">${daily>=0?"+":""}$${daily}</div>
  </div>
  <div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px">
    <div style="font-size:10px;color:#336688">POSITIONS</div>
    <div style="font-size:18px;font-weight:700;color:#00c4ff">${state.positions.length}</div>
  </div>
  <div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px">
    <div style="font-size:10px;color:#336688">PORTFOLIO HEAT</div>
    <div style="font-size:18px;font-weight:700;color:${parseFloat(heat)>50?"#ff5555":parseFloat(heat)>35?"#ff9944":"#00ff88"}">${heat}%</div>
  </div>
</div>

<div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px;margin-bottom:12px">
  <h3 style="color:#336688;font-size:11px;margin:0 0 10px;text-transform:uppercase">Performance</h3>
  <table style="width:100%;font-size:12px;border-collapse:collapse">
    <tr><td style="color:#336688;padding:3px 0">Total Realized P&L</td><td style="text-align:right;color:${pnl>=0?"#00ff88":"#ff5555"};font-weight:700">${pnl>=0?"+":""}${fmt(pnl)}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">Weekly P&L</td><td style="text-align:right;color:${parseFloat(weekly)>=0?"#00ff88":"#ff5555"};font-weight:700">${parseFloat(weekly)>=0?"+":""}$${weekly}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">Monthly Revenue</td><td style="text-align:right;font-weight:700">${fmt(state.totalRevenue)}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">Win Rate</td><td style="text-align:right;font-weight:700">${trades.length?Math.round(wins.length/trades.length*100)+"% ("+wins.length+"/"+trades.length+")":"N/A"}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">VIX</td><td style="text-align:right;font-weight:700;color:${state.vix>25?"#ff9944":"#00ff88"}">${state.vix}</td></tr>
    <tr><td style="color:#336688;padding:3px 0">Circuit Breaker</td><td style="text-align:right;font-weight:700;color:${state.circuitOpen?"#00ff88":"#ff5555"}">${state.circuitOpen?"OPEN":"TRIPPED"}</td></tr>
  </table>
</div>

<div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px;margin-bottom:12px">
  <h3 style="color:#336688;font-size:11px;margin:0 0 10px;text-transform:uppercase">Open Positions</h3>
  <table style="width:100%;font-size:11px;border-collapse:collapse">
    <tr style="color:#336688"><th style="text-align:left">Ticker</th><th>Strike</th><th>Expiry</th><th>Qty</th><th>Entry</th><th>Score</th></tr>
    ${posRows}
  </table>
</div>

<div style="background:#0a1628;border:1px solid #0d3050;border-radius:8px;padding:14px;margin-bottom:12px">
  <h3 style="color:#336688;font-size:11px;margin:0 0 10px;text-transform:uppercase">Recent Trades</h3>
  <table style="width:100%;font-size:11px;border-collapse:collapse">
    <tr style="color:#336688"><th style="text-align:left">Ticker</th><th>P&L</th><th>Reason</th><th>Date</th></tr>
    ${recentTrades}
  </table>
</div>

${type === "morning" ? `
<div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.15);border-radius:8px;padding:14px">
  <h3 style="color:#00ff88;font-size:11px;margin:0 0 6px">TODAY'S OUTLOOK</h3>
  <p style="font-size:12px;color:#cce8ff;margin:0">ARGO-V3.0 will scan every 10 seconds. New entries: 9:30AM-3:00PM ET (mean reversion to 3:30PM). Position management runs until 3:50PM. VIX is currently ${state.vix} - ${state.vix<20?"normal conditions, full sizing":"reduced sizing active"}. ${state.positions.length} position${state.positions.length!==1?"s":""} currently open.</p>
</div>` : `
<div style="background:rgba(0,196,255,0.05);border:1px solid rgba(0,196,255,0.15);border-radius:8px;padding:14px">
  <h3 style="color:#00c4ff;font-size:11px;margin:0 0 6px">END OF DAY SUMMARY</h3>
  <p style="font-size:12px;color:#cce8ff;margin:0">Market closed. ${state.todayTrades} trade${state.todayTrades!==1?"s":""} executed today. Daily P&L: ${parseFloat(daily)>=0?"+":""}$${daily}. ARGO-V3.0 resumes scanning tomorrow at 10:00 AM ET.</p>
</div>`}

<p style="font-size:10px;color:#336688;text-align:center;margin-top:16px">ARGO-V3.0 SPY Spread Trader - Paper Trading - Not financial advice</p>
</body></html>`;
}

async function getBenchmarkComparison() {
  try {
    const spyBars = await getStockBars("SPY", 30);
    if (spyBars.length < 2) return null;
    const spyReturn   = (spyBars[spyBars.length-1].c - spyBars[0].c) / spyBars[0].c * 100;
    const apexReturn  = ((state.cash + (state.positions||[]).reduce((s,p)=>s+p.cost,0)) - MONTHLY_BUDGET) / MONTHLY_BUDGET * 100;
    const alpha       = apexReturn - spyReturn;
    return {
      spyReturn:  parseFloat(spyReturn.toFixed(2)),
      apexReturn: parseFloat(apexReturn.toFixed(2)),
      alpha:      parseFloat(alpha.toFixed(2)),
      beating:    alpha > 0,
    };
  } catch(e) { return null; }
}

function buildMonthlyReport() {
  const trades   = state.closedTrades;
  const pnl      = realizedPnL();
  const wins     = trades.filter(t=>t.pnl>0);
  const losses   = trades.filter(t=>t.pnl<=0);
  const avgWin   = wins.length   ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length   : 0;
  const avgLoss  = losses.length ? losses.reduce((s,t)=>s+t.pnl,0)/losses.length : 0;
  const grossW   = wins.reduce((s,t)=>s+t.pnl,0);
  const grossL   = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const pf       = grossL>0 ? (grossW/grossL).toFixed(2) : "-";
  const maxDD    = Math.min(0, state.cash - state.peakCash);
  const returns  = trades.map(t=>t.pnl/MONTHLY_BUDGET);
  const avgRet   = returns.length ? returns.reduce((s,r)=>s+r,0)/returns.length : 0;
  const stdDev   = returns.length > 1 ? Math.sqrt(returns.reduce((s,r)=>s+Math.pow(r-avgRet,2),0)/(returns.length-1)) : 0;
  const sharpe   = stdDev > 0 ? (avgRet / stdDev * Math.sqrt(252)).toFixed(2) : "N/A";
  const bestTrade  = trades.length ? trades.reduce((b,t)=>t.pnl>b.pnl?t:b) : null;
  const worstTrade = trades.length ? trades.reduce((w,t)=>t.pnl<w.pnl?t:w) : null;

  return `ARGO-V3.0 MONTHLY PERFORMANCE REPORT
${"-".repeat(48)}
Period:           ${state.monthStart} - ${new Date().toLocaleDateString()}

RETURNS
  Starting Budget: ${fmt(MONTHLY_BUDGET)}
  Current Cash:    ${fmt(state.cash)}
  Total P&L:       ${pnl>=0?"+":""}${fmt(pnl)}
  Monthly Revenue: ${fmt(state.totalRevenue)}
  Bonus Earned:    ${fmt(state.extraBudget)}

TRADE STATISTICS
  Total Trades:    ${trades.length}
  Win Rate:        ${trades.length?Math.round(wins.length/trades.length*100)+"%":"N/A"} (${wins.length}W / ${losses.length}L)
  Avg Win:         ${avgWin?"+"+fmt(avgWin):"N/A"}
  Avg Loss:        ${avgLoss?fmt(avgLoss):"N/A"}
  Profit Factor:   ${pf}
  Best Trade:      ${bestTrade?bestTrade.ticker+" +"+fmt(bestTrade.pnl):"N/A"}
  Worst Trade:     ${worstTrade?worstTrade.ticker+" "+fmt(worstTrade.pnl):"N/A"}

RISK METRICS
  Sharpe Ratio:    ${sharpe}
  Max Drawdown:    ${fmt(maxDD)}
  Peak Cash:       ${fmt(state.peakCash)}
  VIX Avg:         ${state.vix}

STOCK PORTFOLIO
  Positions:       ${state.stockPositions.length}
  Total Value:     ${fmt(stockValue())}`;
}

async function sendMorningBriefing() {
  if (!RESEND_API_KEY || !GMAIL_USER) return;
  try {
    const positions = state.positions || [];
    const pdtUsed   = countRecentDayTrades();
    const pdtLeft   = Math.max(0, 3 - pdtUsed);
    // Fetch fresh macro + news at send time - don't rely on cached context
    const freshMacro = await _getMacroNews();
    _marketContext.macro = freshMacro;
    const macro = freshMacro;

    // Also fetch Marketaux directly for guaranteed fresh headlines
    const mxDirect = await getMarketauxNews();
    const today     = new Date();
    const dateStr   = today.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    const macroSignal = (macro.signal || 'neutral').toUpperCase();

    // - Agent narrative briefing -
    let agentNarrative = null;
    if (ANTHROPIC_API_KEY) {
      try {
        agentNarrative = await _getAgentBriefing(positions, macro, macro.headlines || []);
        logEvent("scan", "[AGENT] Morning briefing written by Claude");
      } catch(e) {
        console.log("[AGENT] Morning briefing failed:", e.message);
      }
    }

    // - Divider helper -
    const divider = '<div style="border-top:1px solid #333;margin:14px 0"></div>';
    const sectionHead = (title) =>
      `<div style="font-family:Georgia,serif;font-size:10px;font-weight:bold;letter-spacing:2px;color:#555;text-transform:uppercase;margin-bottom:6px">${title}</div>`;

    // - Header -
    const header = `
      <div style="text-align:center;border-bottom:3px double #333;padding-bottom:12px;margin-bottom:12px">
        <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#111;letter-spacing:1px">ARGO-V3.0 TRADING DESK</div>
        <div style="font-size:10px;color:#555;margin-top:4px;letter-spacing:1px">${dateStr.toUpperCase()}</div>
      </div>
      <div style="display:flex;gap:0;border:1px solid #ccc;margin-bottom:4px">
        <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
          <div style="font-size:9px;color:#555;letter-spacing:1px">VIX</div>
          <div style="font-size:20px;font-weight:bold;color:${state.vix>30?'#cc0000':state.vix>20?'#cc6600':'#006600'}">${state.vix}</div>
        </div>
        <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
          <div style="font-size:9px;color:#555;letter-spacing:1px">CASH</div>
          <div style="font-size:16px;font-weight:bold;color:#111">$${(state.cash||0).toFixed(0)}</div>
        </div>
        <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
          <div style="font-size:9px;color:#555;letter-spacing:1px">DAY TRADES</div>
          <div style="font-size:16px;font-weight:bold;color:${pdtLeft===0?'#cc0000':pdtLeft===1?'#cc6600':'#111'}">${pdtLeft}/3</div>
        </div>
        <div style="flex:1;text-align:center;padding:8px">
          <div style="font-size:9px;color:#555;letter-spacing:1px">MACRO</div>
          <div style="font-size:12px;font-weight:bold;color:${macro.mode==='aggressive'?'#006600':macro.mode==='defensive'?'#cc0000':'#333'}">${macroSignal}</div>
        </div>
      </div>`;

    // - Positions table -
    const posRows = positions.length ? positions.map(p => {
      const dteDays   = p.expDate ? Math.max(0, Math.round((new Date(p.expDate) - today) / MS_PER_DAY)) : '?';
      // Use live price if available, fall back to after-hours estimate, then show entry
      const useAH     = !p.currentPrice && p.estimatedAH;
      const curPrice  = p.currentPrice || (useAH ? p.estimatedAH.price : null);
      const chgNum    = curPrice && p.premium ? ((curPrice - p.premium) / p.premium * 100) : null;
      const chgStr    = chgNum !== null ? chgNum.toFixed(1) : '-';
      const pnlDollar = chgNum !== null ? ((curPrice - p.premium) * 100 * (p.contracts||1)).toFixed(0) : '-';
      const warn      = chgNum !== null && chgNum <= -12 ? ' -' : '';
      const pnlColor  = chgNum === null ? '#555' : chgNum >= 0 ? '#006600' : '#cc0000';
      const estLabel  = useAH ? '<span style="font-size:8px;color:#999"> est</span>' : '';
      const stockPx   = p.price ? ` <span style="font-size:9px;color:#999">- ${p.ticker} $${p.price.toFixed(2)}</span>` : '';
      return `<tr style="border-bottom:1px solid #eee">
        <td style="padding:5px 4px;font-weight:bold">${p.ticker}${warn}</td>
        <td style="padding:5px 4px;color:#555">${p.optionType.toUpperCase()} $${p.strike}</td>
        <td style="padding:5px 4px;color:#555">${dteDays}d</td>
        <td style="padding:5px 4px">
          <span style="font-size:9px;color:#555">entry $${p.premium}</span>
          ${curPrice ? ` - <span style="color:${pnlColor};font-weight:bold">$${curPrice.toFixed(2)}${estLabel}</span>` : ''}
        </td>
        <td style="padding:5px 4px;font-weight:bold;color:${pnlColor}">${chgNum!==null?(chgNum>=0?'+':'')+chgStr+'%':'-'}${stockPx}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" style="padding:8px;color:#999;font-style:italic">No open positions</td></tr>';

    const posTable = `
      <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:monospace">
        <tr style="border-bottom:2px solid #333">
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">TICKER</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">CONTRACT</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">DTE</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">PRICE</th>
          <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">P&amp;L - STOCK</th>
        </tr>
        ${posRows}
      </table>`;

    // - Position news (latest headline per ticker) -
    let posNewsHTML = '';
    if (positions.length > 0) {
      const posNewsItems = [];
      for (const pos of positions) {
        try {
          const news = await getNewsForTicker(pos.ticker);
          if (news && news.length > 0) {
            const article = news[0];
            const ageHrs  = ((Date.now() - new Date(article.created_at||0).getTime()) / 3600000).toFixed(0);
            posNewsItems.push(
              `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
                <span style="font-weight:bold;font-size:11px">${pos.ticker}</span>
                <span style="font-size:10px;color:#555"> - ${article.headline}</span>
                <div style="font-size:9px;color:#999;margin-top:2px">${ageHrs}h ago</div>
              </div>`
            );
          }
        } catch(e) {}
      }
      if (posNewsItems.length > 0) {
        posNewsHTML = divider + sectionHead('Position News') + posNewsItems.join('');
      }
    }

    // - Top headlines (regardless of keyword match) -
    const allHeadlines = macro.headlines || [];
    const topStories   = macro.topStories || [];
    // Combine: credible keyword stories first, then fill with general headlines
    const storySet = new Set();
    const storyItems = [];
    for (const s of topStories.slice(0,3)) {
      if (!storySet.has(s.headline)) {
        storySet.add(s.headline);
        const tag = s.recencyMult >= 2 ? 'BREAKING' : s.recencyMult >= 1.5 ? 'RECENT' : '';
        storyItems.push(
          `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
            ${tag ? `<span style="font-size:9px;font-weight:bold;color:${s.direction==='bullish'?'#006600':'#cc0000'};letter-spacing:1px">${tag} - ${(s.source||'').toUpperCase()} - ${s.direction.toUpperCase()}</span><br>` : ''}
            <span style="font-size:11px;color:#111">${s.headline}</span>
          </div>`
        );
      }
    }
    for (const h of allHeadlines) {
      if (storyItems.length >= 5) break;
      if (!storySet.has(h)) {
        storySet.add(h);
        storyItems.push(
          `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
            <span style="font-size:11px;color:#111">${h}</span>
          </div>`
        );
      }
    }
    // Always show at least 3 recent headlines - even on quiet nights
    if (storyItems.length === 0 && allHeadlines.length > 0) {
      allHeadlines.slice(0, 3).forEach(h => {
        storyItems.push(
          `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
            <span style="font-size:11px;color:#111">${h}</span>
          </div>`
        );
      });
    }
    // Last resort: use pre-fetched Marketaux headlines directly
    if (storyItems.length === 0 && mxDirect && mxDirect.length > 0) {
      mxDirect.slice(0, 5).forEach(a => {
        if (a.headline && !storySet.has(a.headline)) {
          storySet.add(a.headline);
          storyItems.push(
            `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee">
              <span style="font-size:9px;color:#555;letter-spacing:1px">${(a.source||'MARKETAUX').toUpperCase()}</span><br>
              <span style="font-size:11px;color:#111">${a.headline}</span>
            </div>`
          );
        }
      });
    }
    const headlinesHTML = storyItems.length > 0
      ? divider + sectionHead(`Top Stories (${macro.sourceCount || 'Alpaca + Marketaux'})`) + storyItems.join('')
      : ''; // omit section entirely if truly nothing available

    // - Economic calendar -
    const todayStr   = today.toISOString().split('T')[0];
    const calEvents  = getUpcomingMacroEvents(1).filter(e => e.date === todayStr);
    const tomorrowEvents = getUpcomingMacroEvents(2).filter(e => e.date !== todayStr);
    let calHTML = '';
    if (calEvents.length > 0 || tomorrowEvents.length > 0) {
      const calItems = [];
      calEvents.forEach(e => calItems.push(
        `<div style="margin-bottom:4px">
          <span style="font-weight:bold;color:${e.impact==='high'?'#cc0000':'#333'}">TODAY</span>
          <span style="font-size:11px;margin-left:8px">${e.event}</span>
          <span style="font-size:9px;color:#999;margin-left:4px">${e.impact.toUpperCase()} IMPACT</span>
        </div>`
      ));
      tomorrowEvents.forEach(e => calItems.push(
        `<div style="margin-bottom:4px">
          <span style="color:#555">TOMORROW</span>
          <span style="font-size:11px;margin-left:8px">${e.event}</span>
          <span style="font-size:9px;color:#999;margin-left:4px">${e.impact.toUpperCase()} IMPACT</span>
        </div>`
      ));
      calHTML = divider + sectionHead("Economic Calendar") + calItems.join('');
    }

    // - Macro triggers -
    const triggersHTML = macro.triggers && macro.triggers.length
      ? divider + `<div style="font-size:10px;color:#555"><strong style="letter-spacing:1px">MACRO SIGNALS:</strong> ${macro.triggers.join(' - ')}</div>`
      : '';

    // - Footer -
    const footer = `
      <div style="border-top:3px double #333;margin-top:16px;padding-top:8px;text-align:center;font-size:9px;color:#999;letter-spacing:1px">
        ARGO V3.2 - Entry window 9:30am-3:45pm ET - SPY/QQQ primary - Monthly options
      </div>`;

    // - Assemble -
    const html = `
      <div style="font-family:Georgia,serif;background:#ffffff;color:#111;padding:24px;max-width:620px;border:1px solid #ccc">
        ${header}
        ${divider}
        ${agentNarrative ? sectionHead('ANALYST BRIEFING - ARGO-V3.0 INTELLIGENCE') + '<div style="font-family:Georgia,serif;font-size:13px;color:#111;line-height:1.7;white-space:pre-wrap;padding:8px 0">' + agentNarrative + '</div>' + divider : ''}
        ${sectionHead('Open Positions - ' + positions.length + ' active')}
        ${posTable}
        ${triggersHTML}
        ${headlinesHTML}
        ${posNewsHTML}
        ${calHTML}
        ${footer}
      </div>`;

    await sendResendEmail(
      `ARGO-V3.0 Desk - ${dateStr} | VIX ${state.vix} | ${positions.length} positions`,
      html
    );
    logEvent("scan", "Morning briefing email sent");
  } catch(e) { console.error("[EMAIL] Morning briefing error:", e.message); }
}

async function premarketAssessment() {
  // Always run - even with no positions, show macro outlook and day plan
  try {
    const macro = await _getMacroNews();
    _marketContext.macro = macro;
    const fg   = await _getFearGreed();
    const vix  = await _getVIX();
    if (vix) state.vix = vix;
    _marketContext.fearGreed = fg;

    logEvent("scan", `[PREMARKET] Assessing ${state.positions.length} positions | VIX:${state.vix} | Macro:${macro.signal}`);

    // Assess each position - build recommendation
    const assessments = [];
    for (const pos of state.positions) {
      const reasons   = [];
      const riskFlags = [];
      let recommendation = "HOLD"; // default

      // - P&L check -
      const curP  = pos.currentPrice || (pos.estimatedAH ? pos.estimatedAH.price : null) || pos.premium;
      const chg   = pos.premium > 0 ? ((curP - pos.premium) / pos.premium) * 100 : 0;
      const pnlEst= ((curP - pos.premium) * 100 * (pos.contracts||1)).toFixed(0);
      const isAH  = !pos.currentPrice && pos.estimatedAH;

      if (chg <= -20) {
        riskFlags.push(`Down ${chg.toFixed(1)}% - near stop loss`);
        recommendation = "CLOSE";
      } else if (chg <= -10) {
        riskFlags.push(`Down ${chg.toFixed(1)}% - monitor closely`);
        recommendation = "WATCH";
      } else if (chg >= 20) {
        riskFlags.push(`Up ${chg.toFixed(1)}% - consider taking profit`);
        recommendation = "WATCH";
      }

      // - Thesis check -
      try {
        const bars = await getStockBars(pos.ticker, 20);
        if (bars.length >= 14) {
          const curRSI   = calcRSI(bars);
          const entryRSI = pos.entryRSI || 70;
          if (pos.optionType === "put" && entryRSI >= 65 && curRSI < 50) {
            riskFlags.push(`RSI recovered from ${entryRSI} - ${curRSI.toFixed(0)} - put thesis degraded`);
            if (recommendation === "HOLD") recommendation = "WATCH";
          }
        }
      } catch(e) {}

      // - Macro alignment -
      if (pos.optionType === "put" && macro.mode === "aggressive") {
        riskFlags.push("Bullish macro overnight - put thesis at risk");
        recommendation = "WATCH";
      }
      if (pos.optionType === "call" && macro.mode === "defensive") {
        riskFlags.push("Bearish macro overnight - call thesis at risk");
        recommendation = "WATCH";
      }

      // - DTE checks -
      const dte = pos.expDate
        ? Math.max(0, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY))
        : (pos.expDays || 30);
      if (dte <= 3) {
        riskFlags.push(`${dte}DTE - expiring imminently, theta accelerating`);
        recommendation = "CLOSE";
      } else if (dte <= 7 && state.vix > 35) {
        riskFlags.push(`${dte}DTE + VIX ${state.vix} - short-dated in high vol`);
        if (recommendation === "HOLD") recommendation = "WATCH";
      }

      // - VIX extreme -
      if (state.vix > 45) {
        riskFlags.push(`VIX ${state.vix} - extreme volatility, wide spreads at open`);
      }

      assessments.push({
        ticker:         pos.ticker,
        optionType:     pos.optionType,
        strike:         pos.isSpread ? `$${pos.buyStrike}/$${pos.sellStrike}` : pos.strike,
        dte,
        chg:            parseFloat(chg.toFixed(1)),
        pnlEst:         parseFloat(pnlEst),
        curP:           parseFloat(curP.toFixed(2)),
        isAH,
        recommendation,
        riskFlags,
      });

      const emoji = recommendation === "CLOSE" ? "-" : recommendation === "WATCH" ? "-" : "-";
      logEvent(recommendation === "HOLD" ? "scan" : "warn",
        `[PREMARKET] ${emoji} ${pos.ticker} - ${recommendation} | ${chg.toFixed(1)}% | ${riskFlags.join(" | ") || "OK"}`
      );
    }

    // Always send email - show macro outlook even with no positions
    if (RESEND_API_KEY && GMAIL_USER) {
      const closes = assessments.filter(a => a.recommendation === "CLOSE");
      const watches = assessments.filter(a => a.recommendation === "WATCH");
      const holds  = assessments.filter(a => a.recommendation === "HOLD");
      const subject = assessments.length === 0
        ? `ARGO-V3.0 Pre-Market - No Positions | ${macro.signal.toUpperCase()} | ${new Date().toLocaleDateString()}`
        : closes.length
        ? `ARGO-V3.0 Pre-Market - ${closes.length} CLOSE, ${watches.length} WATCH | ${new Date().toLocaleDateString()}`
        : `ARGO-V3.0 Pre-Market - All Clear | ${new Date().toLocaleDateString()}`;

      const rowColor = (rec) => rec === "CLOSE" ? "#cc0000" : rec === "WATCH" ? "#cc6600" : "#006600";
      const rows = assessments.map(a => `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:6px 4px;font-weight:bold">${a.ticker}</td>
          <td style="padding:6px 4px;color:#555">${a.optionType.toUpperCase()} $${a.strike}</td>
          <td style="padding:6px 4px;color:#555">${a.dte}d</td>
          <td style="padding:6px 4px;color:${a.chg>=0?'#006600':'#cc0000'};font-weight:bold">${a.chg>=0?'+':''}${a.chg}%${a.isAH?' <small style="color:#999">(est)</small>':''}</td>
          <td style="padding:6px 4px;font-weight:bold;color:${rowColor(a.recommendation)}">${a.recommendation}</td>
          <td style="padding:6px 4px;font-size:10px;color:#555">${a.riskFlags.join(" - ") || "-"}</td>
        </tr>`
      ).join("");

      await sendResendEmail(subject, `
        <div style="font-family:Georgia,serif;background:#fff;color:#111;padding:24px;max-width:700px;border:1px solid #ccc">
          <div style="text-align:center;border-bottom:3px double #333;padding-bottom:12px;margin-bottom:16px">
            <div style="font-size:20px;font-weight:bold;letter-spacing:1px">ARGO-V3.0 PRE-MARKET ASSESSMENT</div>
            <div style="font-size:10px;color:#555;margin-top:4px;letter-spacing:1px">${new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase()} - 8:45AM ET</div>
          </div>
          <div style="display:flex;gap:0;border:1px solid #ccc;margin-bottom:16px">
            <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
              <div style="font-size:9px;color:#555;letter-spacing:1px">VIX</div>
              <div style="font-size:18px;font-weight:bold;color:${state.vix>30?'#cc0000':'#333'}">${state.vix}</div>
            </div>
            <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
              <div style="font-size:9px;color:#555;letter-spacing:1px">MACRO</div>
              <div style="font-size:14px;font-weight:bold;color:${macro.mode==='aggressive'?'#006600':macro.mode==='defensive'?'#cc0000':'#333'}">${macro.signal.toUpperCase()}</div>
            </div>
            <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
              <div style="font-size:9px;color:#555;letter-spacing:1px">CLOSE</div>
              <div style="font-size:18px;font-weight:bold;color:${closes.length?'#cc0000':'#333'}">${closes.length}</div>
            </div>
            <div style="flex:1;text-align:center;padding:8px;border-right:1px solid #ccc">
              <div style="font-size:9px;color:#555;letter-spacing:1px">WATCH</div>
              <div style="font-size:18px;font-weight:bold;color:${watches.length?'#cc6600':'#333'}">${watches.length}</div>
            </div>
            <div style="flex:1;text-align:center;padding:8px">
              <div style="font-size:9px;color:#555;letter-spacing:1px">HOLD</div>
              <div style="font-size:18px;font-weight:bold;color:#006600">${holds.length}</div>
            </div>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:12px;font-family:monospace">
            <tr style="border-bottom:2px solid #333">
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">TICKER</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">CONTRACT</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">DTE</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">P&amp;L</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">ACTION</th>
              <th style="padding:5px 4px;text-align:left;font-size:10px;letter-spacing:1px">FLAGS</th>
            </tr>
            ${rows}
          </table>
          <div style="border-top:1px solid #ccc;margin-top:12px;padding-top:8px;font-size:10px;color:#555">
            ${macro.triggers && macro.triggers.length ? '<strong>Macro signals:</strong> ' + macro.triggers.join(' - ') + '<br>' : ''}
            <em>These are recommendations only. ARGO-V3.0 will manage exits automatically at open.</em>
          </div>
          <div style="border-top:3px double #333;margin-top:12px;padding-top:8px;text-align:center;font-size:9px;color:#999;letter-spacing:1px">
            ARGO V3.2 - Market opens in ~45 minutes - Entry window 9:30am ET
          </div>
        </div>`
      );
    }
    markDirty();
  } catch(e) { console.error("[PREMARKET] Assessment error:", e.message); }
}

async function updateAfterHoursContext() {
  const et  = getETTime();
  const day = et.getDay();
  if (day === 0 || day === 6) return; // skip weekends
  if (isMarketHours()) return; // market scan handles this during hours
  try {
    // - Macro / sentiment context -
    const macro = await _getMacroNews();
    _marketContext.macro = macro;
    if (macro.mode !== "normal") {
      logEvent("macro", `[AH] Overnight macro: ${macro.signal} - ${macro.triggers.slice(0,3).join(", ")}`);
    }
    const fg = await _getFearGreed();
    _marketContext.fearGreed = fg;
    const newVIX = await _getVIX();
    if (newVIX) state.vix = newVIX;
    if (state.positions.length > 0 && macro.mode === "aggressive") {
      logEvent("warn", `[AH] Bullish macro overnight - ${state.positions.filter(p=>p.optionType==="put").length} puts may be at risk at open`);
    }

    // - Overnight position pricing -
    // Options don't trade after hours - fetch underlying stock price instead
    // Use Black-Scholes to estimate what the option is worth at the new stock price
    // Stored separately as estimatedAH - never overwrites real currentPrice
    if (state.positions.length > 0) {
      const etHour = et.getHours() + et.getMinutes() / 60;
      // Use extended hours quotes if available (4am-9:30am ET pre-market, 4pm-8pm post-market)
      const isPreMarket  = etHour >= 4   && etHour < 9.5;
      const isPostMarket = etHour >= 16  && etHour < 20;
      const hasExtended  = isPreMarket || isPostMarket;

      // Fetch all underlying prices in parallel
      const underlyingPrices = await Promise.all(
        state.positions.map(async pos => {
          try {
            // Try extended hours snapshot first (pre/post market)
            if (hasExtended) {
              const snap = await alpacaGet(`/stocks/${pos.ticker}/snapshot`, ALPACA_DATA);
              if (snap) {
                // Pre-market: use minuteBar (most recent extended hours)
                // Post-market: use minuteBar (after-hours activity)
                const extPrice = snap.minuteBar?.c || snap.latestTrade?.p || null;
                if (extPrice && extPrice > 0) return { ticker: pos.ticker, price: extPrice, source: isPreMarket ? "pre-market" : "post-market" };
              }
            }
            // Fallback: last daily close
            const bars = await getStockBars(pos.ticker, 2);
            if (bars.length > 0) return { ticker: pos.ticker, price: bars[bars.length-1].c, source: "last-close" };
            return null;
          } catch(e) { return null; }
        })
      );

      // Estimate option value at new underlying price using Black-Scholes
      let updatedCount = 0;
      for (const pos of state.positions) {
        const underlying = underlyingPrices.find(u => u && u.ticker === pos.ticker);
        if (!underlying) continue;
        try {
          const newStockPrice = underlying.price;
          const dte           = Math.max(1, Math.round((new Date(pos.expDate) - new Date()) / MS_PER_DAY));
          const iv            = pos.iv ? pos.iv / 100 : 0.30;

          let estPrice, estPnl, estPct;

          if (pos.isSpread && pos.buyStrike && pos.sellStrike) {
            // Spread: compute delta of both legs and use net spread delta
            // This is more accurate than single-leg delta for spread AH estimates
            const buyGreeks  = calcGreeks(newStockPrice, pos.buyStrike,  dte, iv, pos.optionType);
            const sellGreeks = calcGreeks(newStockPrice, pos.sellStrike, dte, iv, pos.optionType);
            const netDelta   = (parseFloat(buyGreeks.delta) || 0) - (parseFloat(sellGreeks.delta) || 0);
            const prevStockPrice = pos.price || newStockPrice;
            const stockMove  = newStockPrice - prevStockPrice;
            const curVal     = pos.currentPrice || pos.premium;
            estPrice  = parseFloat(Math.max(0.01, curVal + (stockMove * netDelta)).toFixed(2));
            if (pos.isCreditSpread) {
              // Credit spread: profitable when value decreases (we sold premium)
              estPnl = parseFloat(((pos.premium - estPrice) * 100 * (pos.contracts || 1)).toFixed(2));
              estPct = parseFloat((((pos.premium - estPrice) / pos.premium) * 100).toFixed(1));
            } else {
              estPnl = parseFloat(((estPrice - pos.premium) * 100 * (pos.contracts || 1)).toFixed(2));
              estPct = parseFloat((((estPrice - pos.premium) / pos.premium) * 100).toFixed(1));
            }
          } else {
            // Single leg option
            const strikeForCalc = pos.strike;
            if (!strikeForCalc) continue;
            const greeks       = calcGreeks(newStockPrice, strikeForCalc, dte, iv, pos.optionType);
            const priceDelta   = newStockPrice - (pos.price || newStockPrice);
            const optionDelta  = parseFloat(pos.greeks?.delta || greeks.delta);
            estPrice = parseFloat(Math.max(0.01, (pos.currentPrice || pos.premium) + (priceDelta * optionDelta)).toFixed(2));
            estPnl   = parseFloat(((estPrice - pos.premium) * 100 * (pos.contracts || 1)).toFixed(2));
            estPct   = parseFloat((((estPrice - pos.premium) / pos.premium) * 100).toFixed(1));
          }

          // Store as estimatedAH - separate from real currentPrice
          pos.estimatedAH = {
            price:       estPrice,
            pnl:         estPnl,
            pct:         estPct,
            stockPrice:  newStockPrice,
            source:      underlying.source,
            updatedAt:   new Date().toISOString(),
          };
          pos.price = newStockPrice; // update underlying price for display
          updatedCount++;
        } catch(e) {}
      }
      if (updatedCount > 0) {
        logEvent("scan", `[AH] Updated ${updatedCount}/${state.positions.length} position estimates | ${isPreMarket ? "pre-market" : isPostMarket ? "post-market" : "last-close"} prices`);
        markDirty();
      }
    }

    logEvent("scan", `[AH] Context updated | VIX:${state.vix} | F&G:${fg.score} | Macro:${macro.signal}`);
    markDirty();
  } catch(e) { console.error("[AH] Context update error:", e.message); }
}


module.exports = {
  sendEmail, sendResendEmail, buildEmailHTML, getBenchmarkComparison,
  buildMonthlyReport, sendMorningBriefing, premarketAssessment,
  updateAfterHoursContext, initReporting, setReportingContext,
};
