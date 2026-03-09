import { EventEmitter } from "events";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ScraperConfig, ScrapeTask } from "./config.js";
import type { ActiveTask } from "./db.js";
import { scrapeSoldPage } from "./scraper.js";
import {
  writeSoldCount,
  releaseSoldRow,
  writeActiveResult,
  isBrokenUrl,
  SeenUrlTracker,
} from "./db.js";

export type ScraperMode = "sold" | "active";

export interface PoolStats {
  total: number;
  completed: number;
  failed: number;
  flagged: number;
  startTime: number;
  status: "idle" | "running" | "paused" | "stopping" | "stopped";
  activeWorkers: number;
  targetWorkers: number;
  queueRemaining: number;
}

export interface TaskEvent {
  workerId: number;
  taskId: string;
  url: string;
  count: number | null;
  error?: string;
  durationMs: number;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function randomDelay(range: [number, number]): Promise<void> {
  const ms = Math.floor(Math.random() * (range[1] - range[0])) + range[0];
  return new Promise((r) => setTimeout(r, ms));
}

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export class WorkerPool extends EventEmitter {
  private browser: Browser | null = null;
  private queue: Array<ScrapeTask | ActiveTask> = [];
  private _paused = false;
  private _stopping = false;
  private _pauseResolvers: Array<() => void> = [];
  private _activeWorkers = 0;
  private _targetWorkers: number;
  private _runningWorkerPromises: Promise<void>[] = [];
  private _nextWorkerId = 0;
  private seenUrls = new SeenUrlTracker();
  private _sessionStartTime = Date.now();
  private stats: PoolStats = {
    total: 0,
    completed: 0,
    failed: 0,
    flagged: 0,
    startTime: Date.now(),
    status: "idle",
    activeWorkers: 0,
    targetWorkers: 0,
    queueRemaining: 0,
  };

  readonly mode: ScraperMode;

  constructor(
    private config: ScraperConfig,
    mode: ScraperMode,
    private sharedBrowser?: Browser
  ) {
    super();
    this.mode = mode;
    this._targetWorkers = config.maxWorkers;
    this.stats.targetWorkers = config.maxWorkers;
  }

  async initialize(): Promise<void> {
    if (this.sharedBrowser) {
      this.browser = this.sharedBrowser;
    } else {
      this.browser = await chromium.launch({ headless: this.config.headless });
    }
    this.stats.status = "idle";
    this.emit("status", this.getStats());
  }

  loadTasks(tasks: Array<ScrapeTask | ActiveTask>): void {
    this.queue = [...tasks];
    this.stats.total += tasks.length;
    this.stats.queueRemaining = this.queue.length;
    this.emit("status", this.getStats());
  }

  async run(): Promise<PoolStats> {
    if (!this.browser) throw new Error("Browser not initialized");
    if (this.queue.length === 0) return this.getStats();

    this._stopping = false;
    this._paused = false;
    this._nextWorkerId = 0;
    this._runningWorkerPromises = [];
    this.stats.status = "running";
    this.emit("status", this.getStats());

    for (let i = 0; i < this._targetWorkers; i++) {
      this._spawnWorker();
    }

    await Promise.all(this._runningWorkerPromises);
    if (!this._stopping) this.stats.status = "idle";
    this.emit("status", this.getStats());
    return this.getStats();
  }

  setWorkers(count: number): void {
    const clamped = Math.max(1, Math.min(count, 24));
    const previous = this._targetWorkers;
    this._targetWorkers = clamped;
    this.stats.targetWorkers = clamped;
    console.log(`[${this.mode}] Workers: ${previous} → ${clamped}`);

    if (this.stats.status === "running" && clamped > this._activeWorkers) {
      const toSpawn = clamped - this._activeWorkers;
      for (let i = 0; i < toSpawn; i++) {
        this._spawnWorker();
      }
    }

    this.emit("status", this.getStats());
  }

  private _spawnWorker(): void {
    const id = this._nextWorkerId++;
    const promise = this.runWorker(id);
    this._runningWorkerPromises.push(promise);
  }

  pause(): void {
    if (!this._paused) {
      this._paused = true;
      this.stats.status = "paused";
      this.emit("status", this.getStats());
    }
  }

  resume(): void {
    if (this._paused) {
      this._paused = false;
      this.stats.status = "running";
      const resolvers = this._pauseResolvers.splice(0);
      resolvers.forEach((r) => r());
      this.emit("status", this.getStats());
    }
  }

  stop(): void {
    this._stopping = true;
    this.stats.status = "stopping";
    this.queue = [];
    this.stats.queueRemaining = 0;
    if (this._paused) this.resume();
    this.emit("status", this.getStats());
  }

  reset(): void {
    this._stopping = false;
    this._paused = false;
    this.queue = [];
    this._runningWorkerPromises = [];
    this._nextWorkerId = 0;
    this.seenUrls = new SeenUrlTracker();
    this._sessionStartTime = Date.now();
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      flagged: 0,
      startTime: Date.now(),
      status: "idle",
      activeWorkers: 0,
      targetWorkers: this._targetWorkers,
      queueRemaining: 0,
    };
    this.emit("status", this.getStats());
  }

  private async waitIfPaused(): Promise<void> {
    if (!this._paused) return;
    return new Promise<void>((resolve) => {
      this._pauseResolvers.push(resolve);
    });
  }

  private async runWorker(workerId: number): Promise<void> {
    if (!this.browser) return;

    const context = await this.browser.newContext({
      userAgent: pickUserAgent(),
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/Chicago",
    });

    const page = await context.newPage();
    this._activeWorkers++;
    this.stats.activeWorkers = this._activeWorkers;

    try {
      while (!this._stopping) {
        if (this._activeWorkers > this._targetWorkers) break;

        await this.waitIfPaused();
        if (this._stopping) break;

        const task = this.queue.shift();
        if (!task) break;

        this.stats.queueRemaining = this.queue.length;

        if (this.mode === "sold") {
          await this.processSoldTask(page, task as ScrapeTask, workerId);
        } else {
          await this.processActiveTask(page, task as ActiveTask, workerId);
        }

        await randomDelay(this.config.requestDelayMs);
      }
    } finally {
      this._activeWorkers--;
      this.stats.activeWorkers = this._activeWorkers;
      await page.close();
      await context.close();
    }
  }

  private async processSoldTask(
    page: Page,
    task: ScrapeTask,
    workerId: number
  ): Promise<void> {
    if (isBrokenUrl(task.sold_link)) {
      this.stats.flagged++;
      this.stats.queueRemaining = this.queue.length;
      this.emit("task:flagged", { workerId, taskId: task.id, url: task.sold_link });
      this.emit("status", this.getStats());
      return;
    }

    if (this.seenUrls.check(task.sold_link)) {
      this.stats.flagged++;
      this.stats.queueRemaining = this.queue.length;
      this.emit("task:flagged", { workerId, taskId: task.id, url: task.sold_link });
      this.emit("status", this.getStats());
      return;
    }
    this.seenUrls.add(task.sold_link);

    const taskStart = Date.now();

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (this._stopping) return;
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.config.retryDelayMs));
      }

      const { count, error } = await scrapeSoldPage(
        page,
        task.sold_link,
        this.config.pageTimeoutMs
      );

      if (count !== null) {
        if (!this.config.dryRun) {
          await writeSoldCount(task.id, count);
        }
        this.stats.completed++;
        this.stats.queueRemaining = this.queue.length;
        this.emit("task:complete", {
          workerId,
          taskId: task.id,
          url: task.sold_link,
          count,
          durationMs: Date.now() - taskStart,
        } as TaskEvent);
        this.emit("status", this.getStats());
        return;
      }

      if (error && isCaptchaOrBlock(error)) {
        this.emit("task:blocked", { workerId, error });
        await new Promise((r) => setTimeout(r, 10_000 + Math.random() * 10_000));
      }

      if (attempt === this.config.maxRetries) {
        this.stats.failed++;
        this.stats.queueRemaining = this.queue.length;
        if (!this.config.dryRun) {
          await releaseSoldRow(task.id);
        }
        this.emit("task:failed", {
          workerId,
          taskId: task.id,
          url: task.sold_link,
          count: null,
          error,
          durationMs: Date.now() - taskStart,
        } as TaskEvent);
        this.emit("status", this.getStats());
      }
    }
  }

  private async processActiveTask(
    page: Page,
    task: ActiveTask,
    workerId: number
  ): Promise<void> {
    if (isBrokenUrl(task.link)) {
      this.stats.flagged++;
      this.stats.queueRemaining = this.queue.length;
      this.emit("task:flagged", { workerId, taskId: task.id, url: task.link });
      this.emit("status", this.getStats());
      return;
    }

    if (this.seenUrls.check(task.link)) {
      this.stats.flagged++;
      this.stats.queueRemaining = this.queue.length;
      this.emit("task:flagged", { workerId, taskId: task.id, url: task.link });
      this.emit("status", this.getStats());
      return;
    }
    this.seenUrls.add(task.link);

    const taskStart = Date.now();

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (this._stopping) return;
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, this.config.retryDelayMs));
      }

      // Same page structure as sold — count is in the same DOM element
      const { count, error } = await scrapeSoldPage(
        page,
        task.link,
        this.config.pageTimeoutMs
      );

      if (count !== null) {
        if (!this.config.dryRun) {
          await writeActiveResult(task.link, count);
        }
        this.stats.completed++;
        this.stats.queueRemaining = this.queue.length;
        this.emit("task:complete", {
          workerId,
          taskId: task.id,
          url: task.link,
          count,
          durationMs: Date.now() - taskStart,
        } as TaskEvent);
        this.emit("status", this.getStats());
        return;
      }

      if (error && isCaptchaOrBlock(error)) {
        this.emit("task:blocked", { workerId, error });
        await new Promise((r) => setTimeout(r, 10_000 + Math.random() * 10_000));
      }

      if (attempt === this.config.maxRetries) {
        this.stats.failed++;
        this.stats.queueRemaining = this.queue.length;
        this.emit("task:failed", {
          workerId,
          taskId: task.id,
          url: task.link,
          count: null,
          error,
          durationMs: Date.now() - taskStart,
        } as TaskEvent);
        this.emit("status", this.getStats());
      }
    }
  }

  async shutdown(): Promise<void> {
    this._stopping = true;
    this.stats.status = "stopped";
    if (this._paused) this.resume();
    if (this.browser && !this.sharedBrowser) {
      await this.browser.close();
      this.browser = null;
    }
    this.emit("status", this.getStats());
  }

  getStats(): PoolStats & { elapsed: string; rate: string; rateNum: number } {
    const elapsed = Date.now() - this._sessionStartTime;
    const elapsedMin = elapsed / 60_000;
    const processed = this.stats.completed + this.stats.failed;
    const rateNum = elapsedMin > 0.05 ? processed / elapsedMin : 0;

    return {
      ...this.stats,
      queueRemaining: this.queue.length,
      elapsed: formatDuration(elapsed),
      rate: `${rateNum.toFixed(1)} pages/min`,
      rateNum,
    };
  }
}

function isCaptchaOrBlock(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("captcha") ||
    lower.includes("blocked") ||
    lower.includes("access denied") ||
    lower.includes("robot")
  );
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / 60_000) % 60;
  const hr = Math.floor(ms / 3_600_000);
  if (hr > 0) return `${hr}h ${min}m ${sec}s`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}
