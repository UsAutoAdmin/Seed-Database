-- Sold listing verification: LLM confidence that sold results match the search (0-1)
ALTER TABLE "9_Octoparse_Scrapes"
  ADD COLUMN IF NOT EXISTS sold_confidence REAL;
ALTER TABLE "9_Octoparse_Scrapes"
  ADD COLUMN IF NOT EXISTS sold_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN "9_Octoparse_Scrapes".sold_confidence IS 'LLM confidence 0-1 that sold listings match the search (e.g. carrier case vs transfer case)';
COMMENT ON COLUMN "9_Octoparse_Scrapes".sold_verified_at IS 'When sold_confidence was computed';
