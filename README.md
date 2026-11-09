# Stock Tracker

A one-page tracker for logging each stock's daily close against the S&P 500. It also has:

- **Your TradingView chart**, using the `tv-advanced-chart` embed. Switch between TTWO, SKYD, META and the S&P 500. The other stocks open as compare panes, like your original embed.
- **Yahoo Finance articles for each ticker.** Click **+ Source** to attach an article to that day's log, or open Yahoo Finance's news page for the ticker.
- **A daily log** of closing prices, notes for the market and for each stock, and your sources. **Fill closing prices** loads the official closes for the chosen date.
- **A performance comparison chart** of everything you've logged: each stock, the S&P 500 and the whole portfolio on one chart.
- **The tracker spreadsheet.** The math matches `STOCK_TRACKER_WORKSHEET_V4` exactly (values, % vs. day 1, S&P % and portfolio % day over day, total portfolio %). You can download it as Excel or CSV in the same layout.

Your history from `STOCK_TRACKER_WORKSHEET_V42` (10/20/2026 to 11/6/2026) is preloaded. That's V41 plus researched sources for every logged day (Yahoo Finance, Nasdaq, Google Finance, NYSE, company investor-relations pages and SEC filings), and the actual S&P 500 close on 10/20/2026 (7,712.57) as the starting point.

## Comparing your stocks

The **Performance comparison** card plots every logged day.

- **% since start** (default): every line starts at 0% on the STARTING POINT date, so a $8 stock and a $600 stock compare directly. Your portfolio is the solid dark line; the S&P 500 is the dashed gray line.
- **Value ($)**: what each holding and the whole portfolio are worth. The S&P 500 line shows what your starting $10,000 would be worth if it had gone into the index.
- **Pick what to compare**: click the chips (TTWO, SKYD, META, S&P 500, Portfolio) to show or hide lines. A stock keeps its color when others are hidden. With four or fewer lines showing, each line is labeled with its latest value.
- **Read any day**: hover over or tap the chart. You can also click the chart and use the ← / → arrow keys.
- **Comparison table** (best performer first):
  - change since start
  - percentage points ahead of or behind the S&P 500
  - latest price
  - biggest gain and biggest drop between two logged days
- **Download PNG** saves the chart, with a title and legend, for a report or slide. It includes only the lines you're showing.

## Using it

### Option A: hosted on GitHub Pages (recommended)

1. In the repo on GitHub, go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
2. Merge this branch into `main`. The **Publish tracker** workflow builds and deploys the site to
   **https://jmooreinteractive.github.io/Stock-Tracking/**

The workflow also runs on weekdays at the open, at midday, and after the 4 pm ET close. Each run fetches fresh Yahoo Finance headlines and closing prices for the tickers in `tracker.config.json`. To refresh by hand, go to **Actions → Publish tracker → Run workflow**.

### Option B: on your computer, with live data

Requires Python 3. Nothing to install.

```bash
python3 serve.py
```

This opens http://localhost:8000. Headlines and closes come live from Yahoo Finance, and **Refresh** fetches new ones.

## Daily routine

1. Pick the date in **Daily log**. It defaults to today; an existing day opens for editing.
2. Click **Fill closing prices**, or type the closes in. Yellow fields are what you enter; blue fields are calculated.
3. Read the chart and articles. Click **+ Source** on anything you used. You can also paste other links (SEC filings, etc.) under **Sources**.
4. Write your analysis: one box for the overall market, plus one box per stock.
5. Click **Save entry**.

## Getting the data into your spreadsheet

| Button | What you get |
| --- | --- |
| **Download Excel (.xlsx)** | The full Tracker sheet in your worksheet's layout (columns A–V, plus W for sources). Yellow input cells, blue formula cells, frozen headers. Formulas are guarded, so a missing price leaves a blank instead of `#VALUE!`. |
| **Download CSV** | The same sheet as values. Opens in Excel or imports into Google Sheets. |
| **Copy as spreadsheet row** | One day as a tab-separated row. Click column A of that day's row in your existing sheet and paste. |
| **Import spreadsheet…** | Loads a tracker CSV or .xlsx: your V4/V41/V42 worksheet (including the Info & Setup layout), or a file this app exported. Days in the file are added or updated (prices from the file, sources combined). Days, notes and sources that exist only in the tracker are kept. |

In the NOTES column, market notes come first, then `TICKER: …` lines. SOURCES has one `[TICKER] Title — URL` line per source. Re-importing the file turns these back into per-stock notes and sources.

## Where your data lives

Entries are saved in your browser (local storage), per device and per browser. Use **Download backup (.json)** at the bottom of the page to keep a copy or move to another device, and **Restore backup** to load one.

## Changing tickers

Open **Portfolio settings** to add, remove or rename stocks. For each one you can set the Yahoo symbol, the TradingView symbol (e.g. `NASDAQ:TTWO`) and the starting investment. Shares are calculated as starting investment ÷ STARTING POINT price.

The scheduled job reads its ticker list from `tracker.config.json`. Add new tickers there as well so their headlines and closes are fetched on GitHub Pages.

## Project layout

```
index.html                 the app
assets/js/model.js         portfolio math, parsing, notes/sources formatting
assets/js/spreadsheet.js   CSV / Excel export + import (worksheet layout)
assets/js/market.js        loads prices + headlines (local server or published snapshot)
assets/js/perf.js          performance comparison chart, comparison table, PNG export
assets/js/app.js           UI
tracker.config.json        tickers, TradingView symbols, starting investments
data/seed-history.json     your worksheet history, loaded on first visit
scripts/market_data.py     Yahoo Finance fetcher (standard library only)
serve.py                   local server with live /api/market
tests/                     npm test (JS + Python)
```

Browsers can't call Yahoo Finance directly, because Yahoo blocks cross-site requests. So headlines and closes come from `serve.py` or from the snapshot the workflow publishes. Without either, the app still works and shows direct Yahoo Finance links.

## Development

```bash
npm ci
```

```bash
npm test
```
