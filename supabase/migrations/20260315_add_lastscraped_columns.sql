-- Timestamp columns for tracking when each link was last scraped.
-- Enables re-scrape loops that prioritize oldest-scraped, non-zero links.
ALTER TABLE "9_Octoparse_Scrapes"
  ADD COLUMN IF NOT EXISTS active_lastscraped TIMESTAMPTZ;
ALTER TABLE "9_Octoparse_Scrapes"
  ADD COLUMN IF NOT EXISTS sold_lastscraped TIMESTAMPTZ;
