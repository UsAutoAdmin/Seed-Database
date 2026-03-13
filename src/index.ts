import { loadConfig, getOpenAIApiKey, getAnthropicApiKey } from "./config.js";
import { claimSoldBatch, fetchPendingActiveTasks, resetActiveSeenUrls } from "./db.js";
import { WorkerPool, type TaskEvent, type ScraperMode } from "./worker-pool.js";
import { Dashboard } from "./dashboard.js";
import {
  enqueueVerification,
  startVerificationWorker,
  stopVerificationWorker,
  setOnConfidenceUpdate,
} from "./verification.js";

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
  process.on("uncaughtException", (err) => {
    const mem = process.memoryUsage();
    console.error(`\n[FATAL] Uncaught exception (RSS ${(mem.rss / 1024 / 1024).toFixed(0)} MB):`, err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason, _promise) => {
    const mem = process.memoryUsage();
    console.error(`\n[FATAL] Unhandled rejection (RSS ${(mem.rss / 1024 / 1024).toFixed(0)} MB):`, reason);
    process.exit(1);
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

  setInterval(() => {
    const mem = process.memoryUsage();
    const rss = (mem.rss / 1024 / 1024).toFixed(0);
    const heap = (mem.heapUsed / 1024 / 1024).toFixed(0);
    console.log(`[keep-alive] Scraper running — RSS ${rss} MB, heap ${heap} MB`);
  }, 5 * 60 * 1000);

  const supabaseKeepAlive = async () => {
    try {
      const { getClient } = await import("./db.js");
      await getClient().from("9_Octoparse_Scrapes").select("id").limit(1).maybeSingle();
    } catch {
      // ignore
    }
  };
  setInterval(supabaseKeepAlive, 5 * 60 * 1000);

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    stopVerificationWorker();
    soldPool.stop();
    activePool.stop();
    await soldPool.shutdown();
    await activePool.shutdown();
    await dashboard.shutdown();
    process.exit(0);
  });

  try {
    await soldPool.initialize();
    await activePool.initialize();
    dashboard.start();

    console.log("Dashboard ready. Press Start on either scraper to begin.");

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
