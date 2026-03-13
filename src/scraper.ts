import type { Page } from "playwright";

/**
 * Primary selector path from the eBay sold listings page:
 * h1.srp-controls__count-heading > span.BOLD
 * The span contains just the numeric count (e.g. "194").
 */
const PRIMARY_SELECTOR = "h1.srp-controls__count-heading span.BOLD";

const FALLBACK_SELECTORS = [
  "h1.srp-controls__count-heading",
  ".srp-controls__count-heading",
  "h2.srp-controls__count-heading",
];

export async function extractSoldCount(page: Page): Promise<number | null> {
  // Strategy 1: Direct span.BOLD selector (most reliable)
  try {
    const bold = await page.$(PRIMARY_SELECTOR);
    if (bold) {
      const text = (await bold.textContent())?.trim();
      if (text) {
        const num = parseInt(text.replace(/,/g, "").replace(/\+/g, ""), 10);
        if (!isNaN(num)) return num;
      }
    }
  } catch {
    // fall through
  }

  // Strategy 2: Heading text (e.g. "194 results for ...")
  for (const selector of FALLBACK_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (!el) continue;
      const text = await el.textContent();
      if (!text) continue;
      const count = parseResultCount(text);
      if (count !== null) return count;
    } catch {
      continue;
    }
  }

  // Strategy 3: Body text scan for zero-result indicators
  try {
    const bodyText = await page.textContent("body");
    if (bodyText) {
      if (
        bodyText.includes("No exact matches found") ||
        bodyText.includes("No results found")
      ) {
        return 0;
      }
      const match = bodyText.match(/(\d[\d,]*)\+?\s+results?\b/i);
      if (match) {
        return parseInt(match[1].replace(/,/g, ""), 10);
      }
    }
  } catch {
    // fall through
  }

  return null;
}

function parseResultCount(text: string): number | null {
  const match = text.match(/^([\d,]+)\+?\s/);
  if (match) return parseInt(match[1].replace(/,/g, ""), 10);
  if (text.toLowerCase().includes("no exact matches")) return 0;
  return null;
}

export async function scrapeSoldPage(
  page: Page,
  url: string,
  timeoutMs: number
): Promise<{ count: number | null; error?: string }> {
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    if (!response) return { count: null, error: "No response from page" };

    const status = response.status();
    if (status >= 400) return { count: null, error: `HTTP ${status}` };

    // Wait for the results count to appear
    try {
      await page.waitForSelector(PRIMARY_SELECTOR, { timeout: 8000 });
    } catch {
      // Selector didn't appear — might be zero results page, try extraction anyway
      await page
        .waitForLoadState("networkidle", { timeout: timeoutMs })
        .catch(() => {});
    }

    await page.waitForTimeout(300);

    const count = await extractSoldCount(page);

    if (count === null) {
      const title = await page.title();
      return {
        count: null,
        error: `Could not extract count (title: "${title}")`,
      };
    }

    return { count };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { count: null, error: message };
  }
}

/**
 * Extract listing titles from the current sold search results page.
 * eBay uses: ul.srp-results > li.s-card, title in div.s-card__title
 */
export async function extractListingTitlesFromPage(
  page: Page,
  maxTitles: number
): Promise<string[]> {
  try {
    await page.waitForSelector("div.s-card__title", { timeout: 5000 });
  } catch {
    // titles may not be present (zero results page)
  }

  const titles = await page.$$eval(
    "ul.srp-results > li.s-card div.s-card__title",
    (els, max) =>
      els
        .map((el) => el.textContent?.trim() ?? "")
        .filter((t) => t.length > 3 && t !== "Shop on eBay")
        .slice(0, max),
    maxTitles
  );

  return titles;
}
