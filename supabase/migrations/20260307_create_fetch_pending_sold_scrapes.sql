-- Queue table for the phantom scraper.
-- Materializes rows from 9_Octoparse_Scrapes that need sold scraping,
-- pre-sorted by highest active count for priority processing.

DROP TABLE IF EXISTS _sold_scrape_queue;

CREATE TABLE _sold_scrape_queue (
  id uuid PRIMARY KEY,
  sold_link text NOT NULL,
  active_count integer NOT NULL,
  scraped boolean DEFAULT false
);

CREATE INDEX idx_sold_scrape_queue_pending
  ON _sold_scrape_queue (active_count DESC)
  WHERE scraped = false;

-- Populates the queue from 9_Octoparse_Scrapes.
-- Strips commas from the text active column to cast to integer.
-- Usage: SELECT populate_sold_scrape_queue();

CREATE OR REPLACE FUNCTION populate_sold_scrape_queue()
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_count int;
BEGIN
  INSERT INTO _sold_scrape_queue (id, sold_link, active_count)
  SELECT
    id,
    sold_link,
    REPLACE(active, ',', '')::int AS active_count
  FROM "9_Octoparse_Scrapes"
  WHERE active IS NOT NULL
    AND active != ''
    AND active != '0'
    AND sold_link IS NOT NULL
    AND sold_link != ''
    AND (sold IS NULL OR sold = '' OR sold = '0')
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$$;

-- Fast fetch for the scraper — reads from pre-sorted queue, no joins.
-- Usage: SELECT * FROM fetch_pending_sold_scrapes(500);

CREATE OR REPLACE FUNCTION fetch_pending_sold_scrapes(batch_size int DEFAULT 500)
RETURNS TABLE(id uuid, sold_link text)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN QUERY
    SELECT q.id, q.sold_link
    FROM _sold_scrape_queue q
    WHERE q.scraped = false
    ORDER BY q.active_count DESC
    LIMIT batch_size;
END;
$$;
