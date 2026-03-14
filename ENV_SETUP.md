# Scraper environment setup

On a new machine:

1. In the **project root** (folder that contains `scripts/`), create **`.env.local`** with exactly these two variables:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

   - **NEXT_PUBLIC_SUPABASE_URL**: Supabase project URL from **Project Settings → API** (“Project URL”).
   - **SUPABASE_SERVICE_ROLE_KEY**: The **service_role** secret key from the same page (not the anon key). Long JWT string.
   - **ANTHROPIC_API_KEY** or **OPENAI_API_KEY** (optional): For sold-listing verification — when sold count ≥ 60, titles are sent to an LLM to score match confidence (0–1). Anthropic preferred if set. Get from console.anthropic.com or platform.openai.com.

2. Run from `scripts/phantom-scraper`:
   ```bash
   npm install
   npx playwright install chromium
   npm run build
   node dist/index.js --workers=4
   ```
   Dashboard: http://localhost:3847

3. **Long runs (10+ days):** The scraper is tuned for 10-day runs:
   - WebSocket protocol ping every 25s (keeps dashboard connections alive)
   - Supabase keep-alive every 1 min (prevents connection timeouts)
   - Browser recycle every 2,000 tasks or 6 hours
   - Uptime + memory logged every 5 min
   - Use `run.sh` (or `caffeinate -s node dist/index.js --workers=4`) to prevent macOS sleep
