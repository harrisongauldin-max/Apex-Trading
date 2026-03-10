# APEX — Professional Options Agent

Always-on paper trading agent. Runs daily scans at 9:35 AM ET, Mon–Fri.

## Deploy to Railway (free)

1. Go to [railway.app](https://railway.app) and sign up (free)
2. Click **New Project → Deploy from GitHub**
3. Push this folder to a GitHub repo (or use Railway's CLI)
4. Railway auto-detects Node.js and runs `npm start`
5. Go to your project → **Variables** → add:
   ```
   FINNHUB_KEY = your_finnhub_api_key_here
   ```
6. Your dashboard will be live at the URL Railway gives you

## Deploy to Render (free alternative)

1. Go to [render.com](https://render.com) and sign up
2. New → **Web Service** → connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add environment variable: `FINNHUB_KEY = your_key`

## Local development

```bash
npm install
FINNHUB_KEY=your_key node server.js
# Open http://localhost:3000
```

## How it works

- **9:35 AM ET daily (Mon–Fri)**: Auto-scan runs automatically
- **Manages open positions**: Checks stops, targets, partial closes, roll candidates
- **Enters new trades**: Runs all filters (IVR, earnings, heat, sector, delta)
- **State persists**: All trades saved to `state.json` — survives restarts
- **Dashboard**: Open your Railway/Render URL from any browser or phone

## Filters active

| Filter | Rule |
|---|---|
| IVR | Skip if implied vol rank > 70 |
| Earnings | Skip within 5 days of report |
| Portfolio heat | Max 60% of capital at risk |
| Sector exposure | Max 50% per sector |
| Delta targeting | 0.30–0.40 per contract |
| Partial close | Take 50% off at +50% gain |
| Stop loss | Close at -55% |
| Take profit | Close at +75% |
| Roll logic | Close within 7 days of expiry |
| Circuit breaker | Pause if daily loss > 8% |
