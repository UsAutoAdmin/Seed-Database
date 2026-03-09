# Phantom Scraper — Dual eBay Sold & Active Count Engine

A high-performance local web scraping engine that extracts sold and active listing counts from eBay search pages using parallel headless Chromium workers. Designed to replace cloud-based scraping services like Octoparse.

## Features

- **Dual Scraper System** — Sold scraper and Active scraper run independently with separate controls
- **Real-time Dashboard** — Live monitoring at `http://localhost:3847` with per-scraper metrics, worker controls, and task feeds
- **Parallel Workers** — Configurable worker count with dynamic scaling via the dashboard
- **Claim-based Batching** — Sold scraper uses `FOR UPDATE SKIP LOCKED` so multiple machines can scrape without overlapping
- **Anti-detection** — User agent rotation, randomized delays, retry with exponential backoff
- **Duplicate Detection** — Cross-batch URL tracking, broken URL flagging, unique constraint on `original_url`

## Architecture

```
Table 8 (8_Research_Assistant)          Table 9 (9_Octoparse_Scrapes)
┌──────────────────────────┐            ┌──────────────────────────────┐
│  id, link                │            │  id, original_url, active,   │
│  (active eBay search URL)│            │  sold, sold_link,            │
│                          │            │  sold_scraped, scraped_at    │
└───────────┬──────────────┘            └──────────┬───────────────────┘
            │                                      │
    Active Scraper                          Sold Scraper
    ─────────────                           ────────────
    1. Fetch from table 8                   1. Claim batch from table 9
       WHERE NOT EXISTS in table 9             (sold_scraped: NULL → 'pending')
    2. Visit link, extract active count     2. Visit sold_link, extract sold count
    3. INSERT into table 9                  3. UPDATE table 9
       (with generated sold_link               (sold = count,
        if active > 0)                          sold_scraped = 'true')
```

## Prerequisites

- **Node.js** v20+
- **npm**
- Access to the Supabase project (URL + service role key)

## Setup on a New Machine

### 1. Clone the repository

```bash
git clone https://github.com/UsAutoAdmin/Seed-Database.git
cd Seed-Database
```

### 2. Install dependencies

```bash
npm install
```

### 3. Install Playwright browsers

```bash
npx playwright install chromium
```

### 4. Create environment file

Create a `.env.local` file in the project root with your Supabase credentials:

```bash
# .env.local
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6...
```

> **Where to find these:**
> - `NEXT_PUBLIC_SUPABASE_URL` — Supabase Dashboard → Settings → API → Project URL
> - `SUPABASE_SERVICE_ROLE_KEY` — Supabase Dashboard → Settings → API → `service_role` key (secret)

### 5. Build

```bash
npm run build
```

### 6. Run

```bash
npm start
```

Open `http://localhost:3847` in your browser. Press **Start** on either scraper card to begin.

## CLI Options

```bash
node dist/index.js [options]

Options:
  --workers <n>       Number of parallel workers (default: 4)
  --batch-size <n>    Tasks per batch (default: 500)
  --timeout <ms>      Page load timeout in ms (default: 30000)
  --retries <n>       Max retries per task (default: 3)
  --headed            Show browser windows (default: headless)
  --dry-run           Scrape pages but don't write to Supabase
```

### Examples

```bash
# Run with 8 workers
node dist/index.js --workers 8

# Dry run to test without writing
node dist/index.js --dry-run --headed

# High-throughput on dedicated machine
node dist/index.js --workers 12
```

## Dashboard Controls

Each scraper card has independent controls:

| Button  | Action                                    |
|---------|-------------------------------------------|
| Start   | Begin scraping (enabled when idle/stopped)|
| Pause   | Pause all workers (resume to continue)    |
| Resume  | Resume paused workers                     |
| Stop    | Stop after current tasks complete         |
| +/-     | Scale workers up/down while running       |

## Recommended Worker Counts

| Machine                    | Workers | Est. Pages/Min |
|----------------------------|---------|----------------|
| MacBook (shared workload)  | 2-4     | ~35-70         |
| M4 Mac Mini 16GB (dedicated)| 10-12  | ~175-210       |
| Two M4 Mac Minis           | 12 each | ~400           |

> Beyond ~12-16 workers per IP, eBay's anti-bot detection becomes the bottleneck, not hardware.

## Running on Multiple Machines

The sold scraper uses claim-based batching (`FOR UPDATE SKIP LOCKED`), so you can run it on multiple machines simultaneously without overlap. Each machine claims its own batch atomically.

The active scraper uses `NOT EXISTS` checks plus a unique constraint on `original_url` to prevent duplicate work. Running on two machines may cause minor redundant page visits but no duplicate database entries.

## Database Requirements

The following Supabase tables and functions must exist:

### Tables
- `8_Research_Assistant` — Source table with `link` (active eBay search URLs)
- `9_Octoparse_Scrapes` — Results table with `original_url`, `active`, `sold`, `sold_link`, `sold_scraped`

### RPC Functions
- `fetch_pending_active_scrapes(batch_size)` — Returns rows from table 8 not yet in table 9
- `claim_sold_scrape_batch(batch_size)` — Atomically claims and returns sold tasks from table 9

### Indexes
- `idx_octoparse_original_url` — Unique index on `9_Octoparse_Scrapes.original_url`
- `idx_octoparse_sold_unscraped` — Partial index for fast sold batch claiming

## File Structure

```
├── src/
│   ├── index.ts          # Entry point, dual scrape loop orchestration
│   ├── config.ts         # CLI args, Supabase credentials, interfaces
│   ├── db.ts             # All Supabase reads/writes for both scrapers
│   ├── worker-pool.ts    # Parallel Playwright workers, task processing
│   ├── scraper.ts        # eBay page navigation and count extraction
│   └── dashboard.ts      # HTTP + WebSocket server for the dashboard
├── public/
│   └── dashboard.html    # Dashboard UI (metrics, controls, live feed)
├── package.json
├── tsconfig.json
└── .env.local            # (create this — not committed)
```
