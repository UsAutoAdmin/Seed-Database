import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { WorkerPool, TaskEvent, PoolStats, ScraperMode } from "./worker-pool.js";

const DASHBOARD_PORT = 3847;

interface RecentTask {
  time: string;
  workerId: number;
  query: string;
  count: number | null;
  error?: string;
  durationMs: number;
  mode: ScraperMode;
  taskId?: string;
  sellThrough?: number | null;
  confidence?: number | null;
}

interface PoolState {
  pool: WorkerPool;
  onStart: (() => void) | null;
  recentTasks: RecentTask[];
  dbWrites: number;
  writeTimestamps: number[];
}

export class Dashboard {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private maxRecent = 200;
  private readonly WINDOW_MS = 5 * 60 * 1000;
  private pools: Record<ScraperMode, PoolState>;

  constructor(
    soldPool: WorkerPool,
    activePool: WorkerPool,
    onStartSold?: () => void,
    onStartActive?: () => void
  ) {
    this.pools = {
      sold: {
        pool: soldPool,
        onStart: onStartSold ?? null,
        recentTasks: [],
        dbWrites: 0,
        writeTimestamps: [],
      },
      active: {
        pool: activePool,
        onStart: onStartActive ?? null,
        recentTasks: [],
        dbWrites: 0,
        writeTimestamps: [],
      },
    };
  }

  start(): void {
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      pingInterval: 25_000,
      pingTimeout: 10_000,
    });

    this.wss.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "init",
          sold: this.getPoolSnapshot("sold"),
          active: this.getPoolSnapshot("active"),
        })
      );

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleCommand(msg);
        } catch {}
      });
    });

    for (const mode of ["sold", "active"] as ScraperMode[]) {
      const state = this.pools[mode];

      state.pool.on("task:complete", (event: TaskEvent) => {
        state.dbWrites++;
        state.writeTimestamps.push(Date.now());
        this.addRecentTask(mode, event, true);
        this.broadcastPoolUpdate(mode);
      });

      state.pool.on("task:failed", (event: TaskEvent) => {
        this.addRecentTask(mode, event, false);
        this.broadcastPoolUpdate(mode);
      });

      state.pool.on("task:flagged", (event: { workerId: number; taskId: string; url: string }) => {
        const query = extractQuery(event.url);
        const flagTask: RecentTask = {
          time: new Date().toLocaleTimeString(),
          workerId: event.workerId,
          query,
          count: null,
          error: "DUPLICATE — flagged",
          durationMs: 0,
          mode,
        };
        state.recentTasks.push(flagTask);
        if (state.recentTasks.length > this.maxRecent) {
          state.recentTasks = state.recentTasks.slice(-this.maxRecent);
        }
        this.broadcastPoolUpdate(mode);
      });

      state.pool.on("status", () => {
        this.broadcast({
          type: "stats",
          [mode]: { stats: state.pool.getStats(), dbWrites: state.dbWrites, dbWritesWindow: state.writeTimestamps.length },
        });
      });
    }

    setInterval(() => {
      this.pruneTimestamps("sold");
      this.pruneTimestamps("active");
      this.broadcast({
        type: "stats",
        sold: this.getPoolSnapshot("sold"),
        active: this.getPoolSnapshot("active"),
      });
    }, 2000);

    setInterval(() => {
      this.broadcast({ type: "ping", ts: Date.now() });
    }, 30_000);

    this.httpServer.listen(DASHBOARD_PORT, () => {
      console.log(`\n  Dashboard: http://localhost:${DASHBOARD_PORT}\n`);
    });
  }

  private addRecentTask(mode: ScraperMode, event: TaskEvent, success: boolean): void {
    const state = this.pools[mode];
    const query = extractQuery(event.url);
    const ev = event as TaskEvent & { sellThrough?: number | null; confidence?: number | null };
    state.recentTasks.push({
      time: new Date().toLocaleTimeString(),
      workerId: event.workerId,
      query,
      count: event.count,
      error: success ? undefined : event.error,
      durationMs: event.durationMs,
      mode,
      taskId: event.taskId,
      sellThrough: ev.sellThrough ?? undefined,
      confidence: ev.confidence ?? undefined,
    });
    if (state.recentTasks.length > this.maxRecent) {
      state.recentTasks = state.recentTasks.slice(-this.maxRecent);
    }
  }

  private handleCommand(msg: { action: string; mode?: ScraperMode; value?: number }): void {
    const mode = msg.mode ?? "sold";
    const state = this.pools[mode];
    if (!state) return;

    switch (msg.action) {
      case "pause":
        state.pool.pause();
        break;
      case "resume":
        state.pool.resume();
        break;
      case "stop":
        state.pool.stop();
        break;
      case "setWorkers":
        if (typeof msg.value === "number") {
          state.pool.setWorkers(msg.value);
        }
        break;
      case "start":
        if (state.onStart) {
          state.pool.reset();
          state.dbWrites = 0;
          state.writeTimestamps = [];
          state.recentTasks = [];
          this.broadcast({ type: "clear", mode });
          state.onStart();
        }
        break;
    }
  }

  private broadcastPoolUpdate(mode: ScraperMode): void {
    this.broadcast({
      type: "poolUpdate",
      mode,
      ...this.getPoolSnapshot(mode),
      task: this.pools[mode].recentTasks.at(-1),
    });
  }

  /** Update confidence for a sold task when verification worker finishes. */
  updateTaskConfidence(mode: ScraperMode, taskId: string, confidence: number): void {
    const state = this.pools[mode];
    const task = state.recentTasks.find((t) => t.taskId === taskId);
    if (task) task.confidence = confidence;
    const payload = { type: "confidence" as const, mode, taskId, confidence };
    this.broadcast(payload);
    console.log(`[dashboard] Confidence broadcast: ${(confidence * 100).toFixed(0)}% for ${taskId.slice(0, 8)}…`);
  }

  private getPoolSnapshot(mode: ScraperMode) {
    const state = this.pools[mode];
    this.pruneTimestamps(mode);
    return {
      stats: state.pool.getStats(),
      dbWrites: state.dbWrites,
      dbWritesWindow: state.writeTimestamps.length,
      recentTasks: state.recentTasks.slice(-100),
    };
  }

  private broadcast(data: unknown): void {
    if (!this.wss) return;
    const json = JSON.stringify(data);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === "/" || req.url === "/index.html") {
      const html = readFileSync(
        resolve(import.meta.dirname, "../public/dashboard.html"),
        "utf-8"
      );
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

  private pruneTimestamps(mode: ScraperMode): void {
    const state = this.pools[mode];
    const cutoff = Date.now() - this.WINDOW_MS;
    while (state.writeTimestamps.length > 0 && state.writeTimestamps[0] < cutoff) {
      state.writeTimestamps.shift();
    }
  }

  async shutdown(): Promise<void> {
    this.wss?.close();
    this.httpServer?.close();
  }
}

function extractQuery(url: string): string {
  try {
    const u = new URL(url);
    return (u.searchParams.get("_nkw") ?? "").replace(/\+/g, " ");
  } catch {
    return url.substring(0, 60);
  }
}
