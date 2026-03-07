import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseCredentials, type ScrapeTask } from "./config.js";

let client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  if (!client) {
    const { url, key } = getSupabaseCredentials();
    client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

/**
 * Fetch a batch of sold_links from the pre-sorted queue table.
 * Returns rows ordered by highest active count first.
 * Detects duplicates within the batch and flags them, returning only unique tasks.
 */
export async function fetchPendingTasks(
  batchSize: number
): Promise<{ tasks: ScrapeTask[]; flagged: number }> {
  const db = getClient();

  // Fetch extra rows to account for duplicates we'll filter out
  const { data, error } = await db.rpc("fetch_pending_sold_scrapes", {
    batch_size: batchSize * 2,
  });

  if (error) {
    throw new Error(`Failed to fetch pending tasks: ${error.message}`);
  }

  const rows: Array<{ id: string; sold_link: string }> = data ?? [];
  const seen = new Map<string, string[]>();
  const unique: ScrapeTask[] = [];
  const duplicateIds: string[] = [];

  for (const row of rows) {
    const existing = seen.get(row.sold_link);
    if (existing) {
      existing.push(row.id);
      duplicateIds.push(row.id);
    } else {
      seen.set(row.sold_link, [row.id]);
      if (unique.length < batchSize) {
        unique.push({
          id: row.id,
          sold_link: row.sold_link,
          status: "pending",
          retry_count: 0,
        });
      }
    }
  }

  // Flag all duplicates (including the first occurrence's ID in each group)
  const allDuplicateIds: string[] = [];
  for (const [, ids] of seen) {
    if (ids.length > 1) {
      allDuplicateIds.push(...ids);
      // Also remove the first occurrence from the unique tasks
      const firstId = ids[0];
      const idx = unique.findIndex((t) => t.id === firstId);
      if (idx !== -1) unique.splice(idx, 1);
    }
  }

  if (allDuplicateIds.length > 0) {
    await flagForReview(allDuplicateIds);
  }

  return { tasks: unique, flagged: allDuplicateIds.length };
}

/**
 * Flag rows in 9_Octoparse_Scrapes and mark them scraped in the queue.
 */
export async function flagForReview(ids: string[]): Promise<void> {
  const db = getClient();
  const CHUNK = 200;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);

    await Promise.all([
      db
        .from("9_Octoparse_Scrapes")
        .update({ flag_for_review: true })
        .in("id", chunk),
      db
        .from("_sold_scrape_queue")
        .update({ scraped: true })
        .in("id", chunk),
    ]);
  }
}

/**
 * Write a scraped sold count back to 9_Octoparse_Scrapes
 * and mark the queue row as scraped.
 */
export async function writeSoldCount(
  id: string,
  soldCount: number
): Promise<void> {
  const db = getClient();

  const [tableUpdate, queueUpdate] = await Promise.all([
    db
      .from("9_Octoparse_Scrapes")
      .update({ sold: String(soldCount) })
      .eq("id", id),
    db
      .from("_sold_scrape_queue")
      .update({ scraped: true })
      .eq("id", id),
  ]);

  if (tableUpdate.error) {
    throw new Error(
      `Failed to write sold count for ${id}: ${tableUpdate.error.message}`
    );
  }
  if (queueUpdate.error) {
    console.error(
      `  ⚠ Queue update failed for ${id}: ${queueUpdate.error.message}`
    );
  }
}

/**
 * Check if a sold_link has a broken URL (e.g. unescaped & in the search query).
 * "TOWN & COUNTRY" produces `+&+` which breaks the _nkw parameter.
 */
export function isBrokenUrl(soldLink: string): boolean {
  try {
    const u = new URL(soldLink);
    const nkw = u.searchParams.get("_nkw") ?? "";
    // If the _nkw ends with a space or is suspiciously short, the & broke it
    if (nkw.endsWith(" ") || nkw.endsWith("+")) return true;
    // Direct check for +&+ pattern in the raw URL before _sacat
    const nkwEnd = soldLink.indexOf("&_sacat");
    if (nkwEnd > 0) {
      const nkwPart = soldLink.substring(0, nkwEnd);
      if (nkwPart.includes("+&+") || nkwPart.includes("+&")) return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Tracks seen search queries across batches for cross-batch duplicate detection.
 * Uses the extracted _nkw parameter (not full URL) for comparison.
 */
export class SeenUrlTracker {
  private seen = new Set<string>();

  check(soldLink: string): boolean {
    return this.seen.has(this.extractKey(soldLink));
  }

  add(soldLink: string): void {
    this.seen.add(this.extractKey(soldLink));
  }

  get size(): number {
    return this.seen.size;
  }

  private extractKey(soldLink: string): string {
    try {
      const u = new URL(soldLink);
      return u.searchParams.get("_nkw") ?? soldLink;
    } catch {
      return soldLink;
    }
  }
}
