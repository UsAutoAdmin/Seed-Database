import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(import.meta.dirname, "../.env.local") });

export interface ScrapeTask {
  id: string;
  sold_link: string;
  /** Active count (from table 9) for computing sell_through = sold/active * 100. */
  active?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  retry_count: number;
  result?: number | null;
  error?: string;
}

export interface ScraperConfig {
  maxWorkers: number;
  /** Number of independent Chromium browser processes to launch. Workers are distributed round-robin. Default 1. */
  browsersCount: number;
  batchSize: number;
  requestDelayMs: [number, number]; // [min, max] random delay between requests
  pageTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  headless: boolean;
  dryRun: boolean;
  /** When sell-through (sold/active %) > this, we run LLM verification and set sold_confidence (0 = disabled). Default 60. */
  soldVerificationThreshold: number;
}

function parseArgs(): Partial<ScraperConfig> {
  const args = process.argv.slice(2);
  const parsed: Partial<ScraperConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--workers":
        parsed.maxWorkers = parseInt(next, 10);
        i++;
        break;
      case "--browsers":
        parsed.browsersCount = parseInt(next, 10);
        i++;
        break;
      case "--batch-size":
        parsed.batchSize = parseInt(next, 10);
        i++;
        break;
      case "--timeout":
        parsed.pageTimeoutMs = parseInt(next, 10);
        i++;
        break;
      case "--retries":
        parsed.maxRetries = parseInt(next, 10);
        i++;
        break;
      case "--headed":
        parsed.headless = false;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--verify-threshold":
        parsed.soldVerificationThreshold = parseInt(next, 10);
        i++;
        break;
    }
  }

  return parsed;
}

export function loadConfig(): ScraperConfig {
  const overrides = parseArgs();

  return {
    maxWorkers: overrides.maxWorkers ?? 4,
    browsersCount: overrides.browsersCount ?? 1,
    batchSize: overrides.batchSize ?? 500,
    requestDelayMs: overrides.requestDelayMs ?? [800, 2500],
    pageTimeoutMs: overrides.pageTimeoutMs ?? 30_000,
    maxRetries: overrides.maxRetries ?? 3,
    retryDelayMs: overrides.retryDelayMs ?? 5_000,
    headless: overrides.headless ?? true,
    dryRun: overrides.dryRun ?? false,
    soldVerificationThreshold: overrides.soldVerificationThreshold ?? 60,
  };
}

export function getOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

export function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY;
}

export function getSupabaseCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
  }

  return { url, key };
}
