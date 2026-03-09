import { chromium } from "playwright";
import { loadConfig } from "./config.js";
import { claimSoldBatch, fetchPendingActiveTasks, resetActiveSeenUrls } from "./db.js";
import { WorkerPool, type TaskEvent, type ScraperMode } from "./worker-pool.js";
import { Dashboard } from "./dashboard.js";

const runningLoops: Record<ScraperMode, boolean> = { sold: false, active: false };

async function runSoldLoop(pool: WorkerPool, batchSize: number) {
  if (runningLoops.sold) return;
  runningLoops.sold = true;

  try {
    let batchNum = 0;
    while (true) {
      batchNum++;
      console.log(`\n[sold] ── Batch ${batchNum} ── Claiming ${batchSize} tasks...`);

      const { tasks, flagged } = await claimSoldBatch(batchSize);
      if (flagged > 0) console.log(`[sold] Flagged ${flagged} duplicates`);
      if (tasks.length === 0) {
        console.log("[sold] No more pending tasks. Done!");
        break;
      }

      console.log(`[sold] Fetched ${tasks.length} tasks`);
      pool.loadTasks(tasks);
      await pool.run();

      const stats = pool.getStats();
      if (stats.status === "stopped" || stats.status === "stopping") {
        console.log("[sold] Stopped by user.");
        break;
      }
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
    let batchNum = 0;
    while (true) {
      batchNum++;
      console.log(`\n[active] ── Batch ${batchNum} ── Fetching ${batchSize} tasks...`);

      const { tasks, flagged } = await fetchPendingActiveTasks(batchSize);
      if (flagged > 0) console.log(`[active] Flagged ${flagged} duplicates`);
      if (tasks.length === 0) {
        console.log("[active] No more pending tasks. Done!");
        break;
      }

      console.log(`[active] Fetched ${tasks.length} tasks`);
      pool.loadTasks(tasks);
      await pool.run();

      const stats = pool.getStats();
      if (stats.status === "stopped" || stats.status === "stopping") {
        console.log("[active] Stopped by user.");
        break;
      }
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
  });
  console.log();

  if (config.dryRun) {
    console.log("⚠  DRY RUN — no data will be written to Supabase\n");
  }

  const browser = await chromium.launch({ headless: config.headless });

  const soldPool = new WorkerPool(config, "sold", browser);
  const activePool = new WorkerPool(config, "active", browser);

  const dashboard = new Dashboard(
    soldPool,
    activePool,
    () => runSoldLoop(soldPool, config.batchSize),
    () => runActiveLoop(activePool, config.batchSize)
  );

  attachPoolLogging(soldPool);
  attachPoolLogging(activePool);

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    soldPool.stop();
    activePool.stop();
    await dashboard.shutdown();
    await browser.close();
    process.exit(0);
  });

  try {
    await soldPool.initialize();
    await activePool.initialize();
    dashboard.start();

    console.log("Dashboard ready. Press Start on either scraper to begin.");

    // Keep process alive
    await new Promise<void>(() => {});
  } catch (err) {
    console.error("Fatal error:", err);
    await dashboard.shutdown();
    await browser.close();
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
