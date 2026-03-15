import { loadConfig, getOpenAIApiKey, getAnthropicApiKey } from "./config.js";
import {
  claimSoldBatch,
  fetchPendingActiveTasks,
  resetActiveSeenUrls,
  fetchRescrapeActiveBatch,
  fetchRescrapeSoldBatch,
} from "./db.js";
import { WorkerPool, type TaskEvent, type ScraperMode } from "./worker-pool.js";
import { Dashboard } from "./dashboard.js";
import {
  enqueueVerification,
  startVerificationWorker,
  stopVerificationWorker,
  setOnConfidenceUpdate,
} from "./verification.js";

const runningLoops: Record<ScraperMode, boolean> = { sold: false, active: false };
const RESCRAPE_PAUSE_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runSoldLoop(pool: WorkerPool, batchSize: number) {
  if (runningLoops.sold) return;
  runningLoops.sold = true;

  try {
    // Phase 1: Initial scrape — claim pending rows (sold_scraped IS NULL)
    let batchNum = 0;
    while (true) {
      batchNum++;
      console.log(`\n[sold] ── Phase 1 · Batch ${batchNum} ── Claiming ${batchSize} tasks...`);

      const { tasks, flagged } = await claimSoldBatch(batchSize);
      if (flagged > 0) console.log(`[sold] Flagged ${flagged} duplicates`);
      if (tasks.length === 0) {
        console.log("[sold] Phase 1 complete — no more pending tasks.");
        break;
      }

      console.log(`[sold] Fetched ${tasks.length} tasks`);
      pool.loadTasks(tasks);
      await pool.run();

      const stats = pool.getStats();
      if (stats.status === "stopped" || stats.status === "stopping") {
        console.log("[sold] Stopped by user.");
        return;
      }
    }

    // Phase 2: Re-scrape loop — non-zero sold rows, oldest-first, forever
    console.log("[sold] Entering re-scrape mode (non-zero sold, oldest first)...");
    pool.clearSeenUrls();
    let rescrapePass = 0;

    while (true) {
      rescrapePass++;
      let rescrapeBatch = 0;
      let processedThisPass = 0;

      while (true) {
        rescrapeBatch++;
        console.log(`\n[sold] ── Re-scrape pass ${rescrapePass} · Batch ${rescrapeBatch} ── Fetching ${batchSize} tasks...`);

        const tasks = await fetchRescrapeSoldBatch(batchSize);
        if (tasks.length === 0) {
          console.log(`[sold] Re-scrape pass ${rescrapePass} complete (${processedThisPass} tasks processed).`);
          break;
        }

        console.log(`[sold] Re-scrape: ${tasks.length} tasks`);
        pool.loadTasks(tasks);
        await pool.run();
        processedThisPass += tasks.length;

        const stats = pool.getStats();
        if (stats.status === "stopped" || stats.status === "stopping") {
          console.log("[sold] Stopped by user.");
          return;
        }
      }

      pool.clearSeenUrls();
      console.log(`[sold] Waiting ${RESCRAPE_PAUSE_MS / 1000}s before next re-scrape pass...`);
      await sleep(RESCRAPE_PAUSE_MS);

      const stats = pool.getStats();
      if (stats.status === "stopped" || stats.status === "stopping") return;
    }
  } finally {
    runningLoops.sold = false;
  }
}

async function runActiveLoop(pool: WorkerPool, batchSize: number) {
  if (runningLoops.active) return;
  runningLoops.active = true;
  resetActiveSeenUrls();

  try {
    // Phase 1: Initial scrape — new links from table 8 not yet in table 9
    let batchNum = 0;
    while (true) {
      batchNum++;
      console.log(`\n[active] ── Phase 1 · Batch ${batchNum} ── Fetching ${batchSize} tasks...`);

      const { tasks, flagged } = await fetchPendingActiveTasks(batchSize);
      if (flagged > 0) console.log(`[active] Flagged ${flagged} duplicates`);
      if (tasks.length === 0) {
        console.log("[active] Phase 1 complete — no more pending tasks.");
        break;
      }

      console.log(`[active] Fetched ${tasks.length} tasks`);
      pool.loadTasks(tasks);
      await pool.run();

      const stats = pool.getStats();
      if (stats.status === "stopped" || stats.status === "stopping") {
        console.log("[active] Stopped by user.");
        return;
      }
    }

    // Phase 2: Re-scrape loop — non-zero active rows, oldest-first, forever
    console.log("[active] Entering re-scrape mode (non-zero active, oldest first)...");
    pool.clearSeenUrls();
    let rescrapePass = 0;

    while (true) {
      rescrapePass++;
      let rescrapeBatch = 0;
      let processedThisPass = 0;

      while (true) {
        rescrapeBatch++;
        console.log(`\n[active] ── Re-scrape pass ${rescrapePass} · Batch ${rescrapeBatch} ── Fetching ${batchSize} tasks...`);

        const tasks = await fetchRescrapeActiveBatch(batchSize);
        if (tasks.length === 0) {
          console.log(`[active] Re-scrape pass ${rescrapePass} complete (${processedThisPass} tasks processed).`);
          break;
        }

        console.log(`[active] Re-scrape: ${tasks.length} tasks`);
        pool.loadTasks(tasks);
        await pool.run();
        processedThisPass += tasks.length;

        const stats = pool.getStats();
        if (stats.status === "stopped" || stats.status === "stopping") {
          console.log("[active] Stopped by user.");
          return;
        }
      }

      pool.clearSeenUrls();
      console.log(`[active] Waiting ${RESCRAPE_PAUSE_MS / 1000}s before next re-scrape pass...`);
      await sleep(RESCRAPE_PAUSE_MS);

      const stats = pool.getStats();
      if (stats.status === "stopped" || stats.status === "stopping") return;
    }
  } finally {
    runningLoops.active = false;
  }
}

function attachPoolLogging(pool: WorkerPool) {
  const tag = `[${pool.mode}]`;

  pool.on("task:complete", (e: TaskEvent) => {
    const query = extractQuery(e.url);
    const stats = pool.getStats();
    const progress = `${stats.completed + stats.failed}/${stats.total}`;
    console.log(
      `${tag} [W${e.workerId}] [${progress}] ✓ count=${e.count} "${query}" (${(e.durationMs / 1000).toFixed(1)}s)`
    );
  });

  pool.on("task:failed", (e: TaskEvent) => {
    const query = extractQuery(e.url);
    const stats = pool.getStats();
    const progress = `${stats.completed + stats.failed}/${stats.total}`;
    console.error(
      `${tag} [W${e.workerId}] [${progress}] ✗ "${query}" — ${e.error}`
    );
  });

  pool.on("task:flagged", (e: { workerId: number; taskId: string; url: string }) => {
    const query = extractQuery(e.url);
    console.log(`${tag} [W${e.workerId}] ⚑ Duplicate: "${query}"`);
  });
}

async function main() {
  process.on("uncaughtException", (err) => {
    const mem = process.memoryUsage();
    console.error(`\n[FATAL] Uncaught exception (RSS ${(mem.rss / 1024 / 1024).toFixed(0)} MB):`, err);
    console.error("[FATAL] Process will exit in 5s so run.sh can restart…");
    setTimeout(() => process.exit(1), 5000);
  });
  process.on("unhandledRejection", (reason, _promise) => {
    const mem = process.memoryUsage();
    console.error(`\n[FATAL] Unhandled rejection (RSS ${(mem.rss / 1024 / 1024).toFixed(0)} MB):`, reason);
    console.error("[FATAL] Process will exit in 5s so run.sh can restart…");
    setTimeout(() => process.exit(1), 5000);
  });

  const config = loadConfig();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     Phantom Local Boost — Dual Scraper       ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();
  console.log("Config:", {
    workers: config.maxWorkers,
    batchSize: config.batchSize,
    timeout: `${config.pageTimeoutMs / 1000}s`,
    retries: config.maxRetries,
    delay: `${config.requestDelayMs[0]}-${config.requestDelayMs[1]}ms`,
    headless: config.headless,
    dryRun: config.dryRun,
    soldVerificationThreshold: config.soldVerificationThreshold || "off",
  });
  if (config.soldVerificationThreshold > 0) {
    const hasAnthropic = getAnthropicApiKey();
    const hasOpenAI = getOpenAIApiKey();
    console.log(
      hasAnthropic
        ? `[verify] LLM verification when sell-through > ${config.soldVerificationThreshold}% (ANTHROPIC_API_KEY)`
        : hasOpenAI
          ? `[verify] LLM verification when sell-through > ${config.soldVerificationThreshold}% (OPENAI_API_KEY)`
          : `[verify] Sell-through > ${config.soldVerificationThreshold}% set but no ANTHROPIC_API_KEY or OPENAI_API_KEY — confidence will not be written`
    );
  }
  console.log();

  if (config.dryRun) {
    console.log("⚠  DRY RUN — no data will be written to Supabase\n");
  }

  const soldPool = new WorkerPool(config, "sold");
  const activePool = new WorkerPool(config, "active");

  const dashboard = new Dashboard(
    soldPool,
    activePool,
    () => runSoldLoop(soldPool, config.batchSize),
    () => runActiveLoop(activePool, config.batchSize)
  );

  attachPoolLogging(soldPool);
  attachPoolLogging(activePool);

  soldPool.on("verification:enqueue", (job: { id: string; nkw: string; titles: string[] }) => {
    enqueueVerification(job);
  });
  setOnConfidenceUpdate((id, confidence) => {
    dashboard.updateTaskConfidence("sold", id, confidence);
  });
  startVerificationWorker();

  const sessionStart = Date.now();
  const formatUptime = (ms: number) => {
    const d = Math.floor(ms / 86400_000);
    const h = Math.floor((ms % 86400_000) / 3600_000);
    const m = Math.floor((ms % 3600_000) / 60_000);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  setInterval(() => {
    const mem = process.memoryUsage();
    const rss = (mem.rss / 1024 / 1024).toFixed(0);
    const heap = (mem.heapUsed / 1024 / 1024).toFixed(0);
    const uptime = formatUptime(Date.now() - sessionStart);
    console.log(`[keep-alive] Uptime ${uptime} — RSS ${rss} MB, heap ${heap} MB`);
  }, 5 * 60 * 1000);

  const supabaseKeepAlive = async () => {
    try {
      const { getClient } = await import("./db.js");
      await getClient().from("9_Octoparse_Scrapes").select("id").limit(1).maybeSingle();
    } catch (err) {
      console.warn("[keep-alive] Supabase ping failed:", err instanceof Error ? err.message : err);
    }
  };
  supabaseKeepAlive();
  setInterval(supabaseKeepAlive, 60 * 1000);

  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    stopVerificationWorker();
    soldPool.stop();
    activePool.stop();
    await soldPool.shutdown();
    await activePool.shutdown();
    await dashboard.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

  try {
    await soldPool.initialize();
    await activePool.initialize();
    dashboard.start();

    console.log("Dashboard ready. Press Start on either scraper to begin.");
    console.log(`[keep-alive] Session started — tuned for 10-day runs (Supabase ping 1m, browser recycle 6h)`);

    await new Promise<void>(() => {});
  } catch (err) {
    console.error("Fatal error:", err);
    await soldPool.shutdown();
    await activePool.shutdown();
    await dashboard.shutdown();
    process.exit(1);
  }
}

function extractQuery(url: string): string {
  try {
    const u = new URL(url);
    return (u.searchParams.get("_nkw") ?? "").replace(/\+/g, " ");
  } catch {
    return url.substring(0, 50);
  }
}

main();
