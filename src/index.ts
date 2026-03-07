import { loadConfig } from "./config.js";
import { fetchPendingTasks } from "./db.js";
import { WorkerPool, type TaskEvent } from "./worker-pool.js";
import { Dashboard } from "./dashboard.js";

async function main() {
  const config = loadConfig();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     Phantom Local Boost — eBay Sold Scraper  ║");
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

  const pool = new WorkerPool(config);
  const dashboard = new Dashboard(pool);

  pool.on("task:complete", (e: TaskEvent) => {
    const query = extractQuery(e.url);
    const stats = pool.getStats();
    const progress = `${stats.completed + stats.failed}/${stats.total}`;
    console.log(
      `[W${e.workerId}] [${progress}] ✓ sold=${e.count} "${query}" (${(e.durationMs / 1000).toFixed(1)}s)`
    );
  });

  pool.on("task:failed", (e: TaskEvent) => {
    const query = extractQuery(e.url);
    const stats = pool.getStats();
    const progress = `${stats.completed + stats.failed}/${stats.total}`;
    console.error(
      `[W${e.workerId}] [${progress}] ✗ "${query}" — ${e.error}`
    );
  });

  pool.on("task:flagged", (e: { workerId: number; taskId: string; url: string }) => {
    const query = extractQuery(e.url);
    console.log(
      `[W${e.workerId}] ⚑ Duplicate flagged: "${query}"`
    );
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down gracefully...");
    pool.stop();
    const stats = pool.getStats();
    printStats(stats);
    await dashboard.shutdown();
    await pool.shutdown();
    process.exit(0);
  });

  try {
    await pool.initialize();
    dashboard.start();

    let totalProcessed = 0;
    let totalFlagged = 0;
    let batchNum = 0;

    while (true) {
      batchNum++;
      console.log(
        `\n── Batch ${batchNum} ── Fetching up to ${config.batchSize} tasks...`
      );

      const { tasks, flagged } = await fetchPendingTasks(config.batchSize);
      totalFlagged += flagged;

      if (flagged > 0) {
        console.log(`⚑ Flagged ${flagged} duplicates in this batch`);
      }

      if (tasks.length === 0) {
        console.log("No more pending tasks. All done!");
        break;
      }

      console.log(`Fetched ${tasks.length} tasks\n`);
      pool.loadTasks(tasks);
      await pool.run();

      const stats = pool.getStats();
      totalProcessed += stats.completed + stats.failed;

      console.log(`\n── Batch ${batchNum} Complete ──`);
      printStats(stats);

      if (stats.status === "stopped" || stats.status === "stopping") {
        console.log("Stopped by user.");
        break;
      }

      if (tasks.length < config.batchSize) {
        console.log("Last batch was partial — no more tasks remain.");
        break;
      }

      console.log("Fetching next batch...\n");
    }

    console.log(`\nTotal processed: ${totalProcessed}`);
    console.log(`Total flagged as duplicates: ${totalFlagged}`);
    console.log("Dashboard still running. Press Ctrl+C to exit.");

    await new Promise<void>((resolve) => {
      process.on("SIGINT", async () => {
        await dashboard.shutdown();
        await pool.shutdown();
        resolve();
      });
    });
  } catch (err) {
    console.error("Fatal error:", err);
    await dashboard.shutdown();
    await pool.shutdown();
    process.exit(1);
  }
}

function printStats(stats: ReturnType<WorkerPool["getStats"]>) {
  console.log(`  Total:     ${stats.total}`);
  console.log(`  Completed: ${stats.completed}`);
  console.log(`  Failed:    ${stats.failed}`);
  console.log(`  Flagged:   ${stats.flagged}`);
  console.log(`  Elapsed:   ${stats.elapsed}`);
  console.log(`  Rate:      ${stats.rate}`);
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
