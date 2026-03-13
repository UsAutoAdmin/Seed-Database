-- Add sell_through column to 9_Octoparse_Scrapes
ALTER TABLE "9_Octoparse_Scrapes"
  ADD COLUMN IF NOT EXISTS sell_through DECIMAL(10, 2);

-- Populate sell_through from existing sold/active data
UPDATE "9_Octoparse_Scrapes"
SET sell_through = ROUND((sold::DECIMAL / NULLIF(active::INTEGER, 0)) * 100, 2)
WHERE active IS NOT NULL
  AND active::INTEGER > 0
  AND sold IS NOT NULL;

-- Add manually_verified column to 6_user_database_parts
-- Values: 'true', 'false', 'pending'
ALTER TABLE "6_user_database_parts"
  ADD COLUMN IF NOT EXISTS manually_verified TEXT DEFAULT 'pending';
