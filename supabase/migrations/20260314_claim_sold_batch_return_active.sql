-- Return active from claim so we can compute sell_through and trigger verification by sell-through %
DROP FUNCTION IF EXISTS claim_sold_scrape_batch(integer);
CREATE FUNCTION claim_sold_scrape_batch(batch_size int DEFAULT 500)
RETURNS TABLE(id uuid, sold_link text, active text)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
    WITH candidates AS (
      SELECT o.id
      FROM "9_Octoparse_Scrapes" o
      WHERE o.sold_scraped IS NULL
        AND o.sold_link IS NOT NULL
        AND o.sold_link != ''
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "9_Octoparse_Scrapes" o
    SET sold_scraped = 'pending'
    FROM candidates c
    WHERE o.id = c.id
    RETURNING o.id, o.sold_link, o.active;
END;
$$;
