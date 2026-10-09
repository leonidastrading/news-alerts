# News Alerts

Watches market news as it breaks and emails you when a stock in a headline starts moving. Each alert is
paper-traded in the direction of the move and the website records how it turned out.

## How it works

Two parts share one Neon Postgres database:

- **Monitor** (`worker/`, runs on Railway, always on)
  - Listens to Alpaca's live news stream (Benzinga headlines, each tagged with its tickers). If the stream drops,
    it polls the news API every 15 seconds until it reconnects.
  - For every fresh headline tagged with 1–4 US tickers, watches those stocks for 30 minutes. Roundups tagged
    with many tickers, stocks under $3 and thinly traded stocks are skipped.
  - Checks prices every 5 seconds (IEX feed). The price at the first check after the headline is the starting
    point; when a stock is 1.5% or more away from it on two checks in a row, that's an alert.
  - News from while the market is closed (after the close, overnight, pre-market) is collected at the open:
    every stock with headlines since the previous close gets an opening range (its high and low over the first
    5 minutes). A break above the high or below the low, held for two checks, before 10:30 is an alert. The
    overnight gap and the range are recorded with it.
  - On an alert: saves it, places a paper trade in the direction of the move (about $2,000, market order, only
    during regular hours, held to the end of the day and closed about 5 minutes before the close) and emails you.
  - Afterwards fills in the trade's fill prices and P&L and the stock's price 15 and 60 minutes after the alert
    and at the next day's close.
- **News origin**: each headline is labelled from its wording and author as a press release, SEC filing,
  earnings numbers, analyst action, a report citing another outlet, a reactive article written after the move
  ("Why is XYZ stock trading lower?"), or other. Alerts and missed moves carry the label, and the dashboard breaks
  results down by it.
- **Missed moves**: every 5 minutes during the session the monitor checks Alpaca's top gainers and losers. A
  stock up or down 5% or more on the day, liquid enough to have been watched, with no alert, is recorded with
  why it was missed: no headline tagged with it, only in roundups, filtered out, already alerted, moved before
  the headline, watched but the move came outside the 30-minute window, or pre-open news with no range break.
- **Website** (Next.js on Vercel): every alert from the last 30 days as a card with the headline, its category,
  source and summary; a timeline (published, received, alert, entry sent and filled, exit sent and filled);
  price and gap; IEX volume; the paper trade's fills, slippage and P&L; and how riding the move would have done at
  +15 min, +60 min and the next close. A breakdown splits results by intraday vs pre-open news and long vs short.

Trades only ever go to `paper-api.alpaca.markets`; the code has no way to reach a live account.

## Setup

1. **Database**: in Vercel, create a Neon database (Storage → Create → Neon) and connect it to the
   `news-alerts` project. Copy its `DATABASE_URL`.
2. **Alpaca**: Paper Trading → API Keys → generate. Copy the key ID and secret.
3. **Resend** (email): sign up at resend.com with the address you want alerts sent to, then create an API key.
4. **Railway**: New Project → Deploy from GitHub repo → this repo. `railway.json` sets the start command, and
   `npm start` runs the monitor too, in case Railway falls back to it (Vercel doesn't use `npm start`; run the
   website locally with `npm run dev` or `npm run start:web`).
   Add the variables from `.env.example`.

The monitor creates the database tables the first time it starts.

## Local development

```bash
npm install
npm test
npm run build && npm run typecheck
npm run dev       # website, needs DATABASE_URL
npm run worker    # monitor, needs the variables in .env.example
```
