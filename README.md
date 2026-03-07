# Phantom Local Boost — eBay Sold Scraper

High-performance local web scraper that extracts sold listing counts from eBay search results pages and writes them to Supabase. Uses parallel headless Chromium workers via Playwright.

## Setup

```bash
npm install
npx playwright install chromium
```

Copy `.env.example` to `.env.local` and fill in your Supabase credentials:

```bash
cp .env.example .env.local
```

### Database Setup

Run the SQL migration in your Supabase SQL Editor to create the queue table and functions:

```bash
# File: 20260307_create_fetch_pending_sold_scrapes.sql
```

Then populate the scrape queue:

```sql
SELECT populate_sold_scrape_queue();
```

## Usage

```bash
# Default (4 workers, 500 per batch)
npm start

# Custom workers and batch size
npx tsx src/index.ts --workers 8 --batch-size 1000

# Dry run (no DB writes)
npm run start:dry

# Headed mode (visible browser)
npx tsx src/index.ts --headed --workers 1
```

### CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--workers N` | 4 | Number of parallel browser contexts |
| `--batch-size N` | 500 | Rows fetched per batch from Supabase |
| `--timeout N` | 30000 | Page load timeout in ms |
| `--retries N` | 3 | Max retries per failed page |
| `--headed` | false | Show the browser window |
| `--dry-run` | false | Skip all DB writes |

## Dashboard

A live monitoring dashboard starts automatically at **http://localhost:3847** with:

- Real-time metrics: completed, failed, flagged duplicates, rate (pages/min)
- Progress bar
- Pause / Resume / Stop controls
- Live feed of every scraped page

## Architecture

```
src/
├── index.ts          Main orchestrator — batch loop
├── config.ts         CLI args + env config
├── db.ts             Supabase reads/writes + duplicate detection
├── scraper.ts        eBay page extraction (span.BOLD selector)
├── worker-pool.ts    Parallel browser contexts with pause/stop
└── dashboard.ts      HTTP + WebSocket monitoring server

public/
└── dashboard.html    Live monitoring UI
```

### Duplicate Protection

Three layers prevent wasted scrapes on bad data:

1. **Within-batch** — deduplicates by `sold_link` before dispatching
2. **Cross-batch** — `SeenUrlTracker` compares `_nkw` search queries across all batches
3. **Broken URL detection** — flags malformed URLs (e.g. unescaped `&` in model names like "TOWN & COUNTRY")

All flagged rows get `flag_for_review = true` in `9_Octoparse_Scrapes`.

## Performance

| Workers | Expected Throughput |
|---------|-------------------|
| 1 | 15–25 pages/min |
| 2 | 30–50 pages/min |
| 4 | 60–100 pages/min |
| 8 | 100–180 pages/min |
