import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseCredentials, type ScrapeTask } from "./config.js";

let client: SupabaseClient | null = null;
let consecutiveFailures = 0;
const MAX_FAILURES_BEFORE_RECONNECT = 5;

export function getClient(): SupabaseClient {
  if (!client) {
    buildClient();
  }
  return client!;
}

function buildClient(): void {
  const { url, key } = getSupabaseCredentials();
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  consecutiveFailures = 0;
}

export function markDbSuccess(): void {
  consecutiveFailures = 0;
}

export function markDbFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES_BEFORE_RECONNECT) {
    console.warn(`[db] ${consecutiveFailures} consecutive failures — rebuilding Supabase client`);
    buildClient();
  }
}

// ─── Sold Scraper (table 9 → table 9) ────────────────────────────────────────

/**
 * Claim a batch of sold tasks directly from 9_Octoparse_Scrapes.
 * Uses FOR UPDATE SKIP LOCKED so multiple machines don't overlap.
 * Marks claimed rows as sold_scraped='pending'.
 */
export async function claimSoldBatch(
  batchSize: number
): Promise<{ tasks: ScrapeTask[]; flagged: number }> {
  const db = getClient();

  const { data, error } = await db.rpc("claim_sold_scrape_batch", {
    batch_size: batchSize,
  });

  if (error) {
    markDbFailure();
    console.error(`[sold] claimSoldBatch error: ${error.message}`);
    return { tasks: [], flagged: 0 };
  }
  markDbSuccess();

  const rows: Array<Record<string, unknown> & { id: string; sold_link: string }> = data ?? [];

  const seen = new Map<string, string[]>();
  const unique: ScrapeTask[] = [];
  const duplicateIds: string[] = [];

  for (const row of rows) {
    const key = extractNkw(row.sold_link);
    const activeVal = row.active ?? row.Active;
    const active = activeVal != null && activeVal !== "" ? String(activeVal) : undefined;
    const existing = seen.get(key);
    if (existing) {
      existing.push(row.id);
      duplicateIds.push(row.id);
    } else {
      seen.set(key, [row.id]);
      unique.push({
        id: row.id,
        sold_link: row.sold_link,
        active,
        status: "pending",
        retry_count: 0,
      });
    }
  }

  if (duplicateIds.length > 0) {
    await flagSoldRows(duplicateIds);
  }

  return { tasks: unique, flagged: duplicateIds.length };
}

/**
 * Write sold count to 9_Octoparse_Scrapes and mark sold_scraped='true'.
 * When sold > 0 and active is provided (and > 0), set sell_through = (sold/active)*100.
 * When sold === 0, only set sold and sold_scraped; leave sell_through and sold_confidence null.
 */
export async function writeSoldCount(
  id: string,
  soldCount: number,
  active?: string
): Promise<void> {
  const db = getClient();
  const payload: Record<string, unknown> = {
    sold: String(soldCount),
    sold_scraped: "true",
    sold_lastscraped: new Date().toISOString(),
  };
  if (soldCount > 0 && active != null && active !== "") {
    const activeNum = parseFloat(active.replace(/,/g, ""));
    if (!Number.isNaN(activeNum) && activeNum > 0) {
      payload.sell_through = Math.round((soldCount / activeNum) * 100 * 100) / 100;
    }
  }
  const { error } = await db
    .from("9_Octoparse_Scrapes")
    .update(payload)
    .eq("id", id);

  if (error) {
    markDbFailure();
    throw new Error(`Failed to write sold count for ${id}: ${error.message}`);
  }
  markDbSuccess();
}

/**
 * Flag sold rows as reviewed (skip them).
 */
async function flagSoldRows(ids: string[]): Promise<void> {
  const db = getClient();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await db
      .from("9_Octoparse_Scrapes")
      .update({ flag_for_review: true, sold_scraped: "true" })
      .in("id", chunk);
  }
}

/**
 * Fetch active count for a row (fallback when RPC doesn't return active).
 */
export async function getActiveForSoldRow(id: string): Promise<string | null> {
  const db = getClient();
  const { data, error } = await db
    .from("9_Octoparse_Scrapes")
    .select("active")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const a = (data as { active?: string | null }).active;
  return a != null && a !== "" ? a : null;
}

/**
 * Release a pending sold row back (e.g. on failure after retries).
 */
export async function releaseSoldRow(id: string): Promise<void> {
  const db = getClient();
  await db
    .from("9_Octoparse_Scrapes")
    .update({ sold_scraped: null })
    .eq("id", id);
}

/**
 * Update sold_confidence (0-1) and sold_verified_at after LLM verification.
 */
export async function updateSoldConfidence(
  id: string,
  confidence: number
): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from("9_Octoparse_Scrapes")
    .update({
      sold_confidence: Math.max(0, Math.min(1, confidence)),
      sold_verified_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    markDbFailure();
    throw new Error(`Failed to update sold_confidence for ${id}: ${error.message}`);
  }
  markDbSuccess();
}

// ─── Active Scraper (table 8 → table 9) ──────────────────────────────────────

export interface ActiveTask {
  id: string;
  link: string;
  status: string;
  retry_count: number;
  rescrape?: boolean;
}

// Persists across all batches within a session to prevent cross-batch duplicates.
// Caps at 500k entries to prevent OOM; evicts oldest half when full.
const ACTIVE_SEEN_MAX = 500_000;
let activeSeenUrls = new Set<string>();

export function resetActiveSeenUrls(): void {
  activeSeenUrls.clear();
}

function activeSeenGuard(): void {
  if (activeSeenUrls.size >= ACTIVE_SEEN_MAX) {
    const entries = [...activeSeenUrls];
    const half = Math.floor(entries.length / 2);
    activeSeenUrls = new Set(entries.slice(half));
    console.log(`[activeSeenUrls] Evicted ${half} oldest entries (now ${activeSeenUrls.size})`);
  }
}

/**
 * Fetch active links from table 8 that don't yet exist in table 9.
 * Deduplicates against all previously fetched URLs in this session.
 */
export async function fetchPendingActiveTasks(
  batchSize: number
): Promise<{ tasks: ActiveTask[]; flagged: number }> {
  const db = getClient();

  // Fetch extra to account for duplicates we'll filter out
  const fetchSize = Math.min(batchSize * 3, 2000);
  const { data, error } = await db.rpc("fetch_pending_active_scrapes", {
    batch_size: fetchSize,
  });

  if (error) {
    markDbFailure();
    throw new Error(`Failed to fetch active tasks: ${error.message}`);
  }
  markDbSuccess();

  const rows: Array<{ id: string; link: string }> = data ?? [];

  const unique: ActiveTask[] = [];
  let flagged = 0;

  for (const row of rows) {
    const key = row.link;
    if (activeSeenUrls.has(key)) {
      flagged++;
      continue;
    }
    activeSeenGuard();
    activeSeenUrls.add(key);
    if (unique.length < batchSize) {
      unique.push({
        id: row.id,
        link: row.link,
        status: "pending",
        retry_count: 0,
      });
    }
  }

  return { tasks: unique, flagged };
}

/**
 * Write active scrape result: INSERT a new row into 9_Octoparse_Scrapes.
 * Generates sold_link if activeCount > 0.
 */
export async function writeActiveResult(
  originalUrl: string,
  activeCount: number
): Promise<void> {
  const db = getClient();

  const soldLink =
    activeCount > 0 ? generateSoldLink(originalUrl) : null;

  const { error } = await db.from("9_Octoparse_Scrapes").upsert(
    {
      original_url: originalUrl,
      active: String(activeCount),
      sold_link: soldLink,
      scraped_at: new Date().toISOString(),
      active_lastscraped: new Date().toISOString(),
    },
    { onConflict: "original_url", ignoreDuplicates: true }
  );

  if (error) {
    markDbFailure();
    throw new Error(
      `Failed to write active result for ${originalUrl}: ${error.message}`
    );
  }
  markDbSuccess();
}

// ─── Re-scrape Queries ───────────────────────────────────────────────────────

/**
 * Fetch a batch of non-zero active rows for re-scraping, oldest-scraped first.
 * Skips rows where active is '0' or null.
 */
export async function fetchRescrapeActiveBatch(
  batchSize: number
): Promise<ActiveTask[]> {
  const db = getClient();

  const { data, error } = await db
    .from("9_Octoparse_Scrapes")
    .select("id, original_url")
    .not("active", "eq", "0")
    .not("active", "is", null)
    .not("original_url", "is", null)
    .order("active_lastscraped", { ascending: true, nullsFirst: true })
    .limit(batchSize);

  if (error) {
    markDbFailure();
    throw new Error(`Failed to fetch active re-scrape batch: ${error.message}`);
  }
  markDbSuccess();

  const rows = (data ?? []) as Array<{ id: string; original_url: string }>;
  return rows.map((row) => ({
    id: row.id,
    link: row.original_url,
    status: "pending",
    retry_count: 0,
    rescrape: true,
  }));
}

/**
 * Fetch a batch of non-zero sold rows for re-scraping, oldest-scraped first.
 * Skips rows where sold is '0' or null.
 */
export async function fetchRescrapeSoldBatch(
  batchSize: number
): Promise<ScrapeTask[]> {
  const db = getClient();

  const { data, error } = await db
    .from("9_Octoparse_Scrapes")
    .select("id, sold_link, active")
    .not("sold", "eq", "0")
    .not("sold", "is", null)
    .not("sold_link", "is", null)
    .order("sold_lastscraped", { ascending: true, nullsFirst: true })
    .limit(batchSize);

  if (error) {
    markDbFailure();
    throw new Error(`Failed to fetch sold re-scrape batch: ${error.message}`);
  }
  markDbSuccess();

  const rows = (data ?? []) as Array<{ id: string; sold_link: string; active?: string | null }>;
  return rows.map((row) => ({
    id: row.id,
    sold_link: row.sold_link,
    active: row.active != null && row.active !== "" ? row.active : undefined,
    status: "pending" as const,
    retry_count: 0,
  }));
}

/**
 * Update active count and timestamp for an existing row during re-scrape.
 */
export async function updateActiveRescrape(
  id: string,
  activeCount: number
): Promise<void> {
  const db = getClient();
  const { error } = await db
    .from("9_Octoparse_Scrapes")
    .update({
      active: String(activeCount),
      active_lastscraped: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    markDbFailure();
    throw new Error(`Failed to update active re-scrape for ${id}: ${error.message}`);
  }
  markDbSuccess();
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Generate a sold_link from an active link URL.
 * Extracts _nkw and constructs the sold search URL.
 */
function generateSoldLink(activeLink: string): string {
  try {
    const u = new URL(activeLink);
    const nkw = u.searchParams.get("_nkw") ?? "";
    return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(nkw).replace(/%20/g, "+")}&_sacat=0&_from=R40&LH_ItemCondition=3000&rt=nc&LH_Sold=1`;
  } catch {
    return "";
  }
}

export function extractNkw(url: string): string {
  try {
    const u = new URL(url);
    return u.searchParams.get("_nkw") ?? url;
  } catch {
    return url;
  }
}

/**
 * Check if a URL has a broken _nkw parameter (e.g. unescaped & in model names).
 */
export function isBrokenUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const nkw = u.searchParams.get("_nkw") ?? "";
    if (nkw.endsWith(" ") || nkw.endsWith("+")) return true;
    const nkwEnd = url.indexOf("&_sacat");
    if (nkwEnd > 0) {
      const nkwPart = url.substring(0, nkwEnd);
      if (nkwPart.includes("+&+") || nkwPart.includes("+&")) return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Tracks seen search queries across batches for cross-batch duplicate detection.
 * Caps at MAX_SIZE to prevent OOM during multi-day runs; evicts oldest half when full.
 */
export class SeenUrlTracker {
  private seen = new Set<string>();
  private static readonly MAX_SIZE = 500_000;

  check(url: string): boolean {
    return this.seen.has(extractNkw(url));
  }

  add(url: string): void {
    if (this.seen.size >= SeenUrlTracker.MAX_SIZE) {
      const entries = [...this.seen];
      const half = Math.floor(entries.length / 2);
      this.seen = new Set(entries.slice(half));
      console.log(`[SeenUrlTracker] Evicted ${half} oldest entries (was ${entries.length}, now ${this.seen.size})`);
    }
    this.seen.add(extractNkw(url));
  }

  get size(): number {
    return this.seen.size;
  }
}
