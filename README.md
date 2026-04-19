# APEX v2.0 — Professional Options Trading Agent

## Alpaca Paper Trading Edition

### Railway Environment Variables Required
| Variable | Description |
|---|---|
| `ALPACA_API_KEY` | Alpaca paper trading API key ID |
| `ALPACA_SECRET_KEY` | Alpaca paper trading secret key |
| `GMAIL_USER` | Your Gmail address |
| `GMAIL_APP_PASSWORD` | Gmail app password (16 chars) |

### What's New in v2.0
- Full Alpaca API integration (real options chain data)
- 1-minute scans during market hours
- Entry window: 10:00 AM - 3:30 PM ET only
- Trade quality scoring (0-100, min 70 to enter)
- Trailing stops, breakeven lock, fast stop
- VIX tiered position sizing
- Kelly Criterion (half Kelly) sizing
- Stock portfolio auto-buy from profits
- Daily email summaries (9AM + 4PM ET)
- Monthly performance report
- Full trade journal with entry reasoning
- Beta-weighted delta tracking
- Weekly + daily circuit breakers
- Consecutive loss limit (pause at 3)
- Gap detection, time-of-day filter
- ADX trend strength filter
- Relative strength vs SPY

### Deploy to Railway
1. Push this repo to GitHub
2. Connect to Railway
3. Set environment variables above
4. Railway auto-deploys on every push

