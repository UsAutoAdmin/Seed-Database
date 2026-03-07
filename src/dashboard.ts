import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { WorkerPool, TaskEvent, PoolStats } from "./worker-pool.js";

const DASHBOARD_PORT = 3847;

interface RecentTask {
  time: string;
  workerId: number;
  query: string;
  count: number | null;
  error?: string;
  durationMs: number;
}

export class Dashboard {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private recentTasks: RecentTask[] = [];
  private maxRecent = 200;
  private dbWrites = 0;

  constructor(private pool: WorkerPool) {}

  start(): void {
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws) => {
      ws.send(
        JSON.stringify({
          type: "init",
          stats: this.pool.getStats(),
          recentTasks: this.recentTasks.slice(-50),
          dbWrites: this.dbWrites,
        })
      );

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleCommand(msg);
        } catch {}
      });
    });

    this.pool.on("task:complete", (event: TaskEvent) => {
      this.dbWrites++;
      this.addRecentTask(event, true);
      this.broadcast({ type: "task", task: this.recentTasks.at(-1), stats: this.pool.getStats(), dbWrites: this.dbWrites });
    });

    this.pool.on("task:failed", (event: TaskEvent) => {
      this.addRecentTask(event, false);
      this.broadcast({ type: "task", task: this.recentTasks.at(-1), stats: this.pool.getStats(), dbWrites: this.dbWrites });
    });

    this.pool.on("task:flagged", (event: { workerId: number; taskId: string; url: string }) => {
      const query = extractQuery(event.url);
      const flagTask: RecentTask = {
        time: new Date().toLocaleTimeString(),
        workerId: event.workerId,
        query,
        count: null,
        error: "DUPLICATE — flagged for review",
        durationMs: 0,
      };
      this.recentTasks.push(flagTask);
      if (this.recentTasks.length > this.maxRecent) {
        this.recentTasks = this.recentTasks.slice(-this.maxRecent);
      }
      this.broadcast({ type: "task", task: flagTask, stats: this.pool.getStats(), dbWrites: this.dbWrites });
    });

    this.pool.on("status", () => {
      this.broadcast({ type: "stats", stats: this.pool.getStats(), dbWrites: this.dbWrites });
    });

    // Periodic stats broadcast (rate calculations update even when no tasks complete)
    setInterval(() => {
      this.broadcast({ type: "stats", stats: this.pool.getStats(), dbWrites: this.dbWrites });
    }, 2000);

    this.httpServer.listen(DASHBOARD_PORT, () => {
      console.log(`\n  Dashboard: http://localhost:${DASHBOARD_PORT}\n`);
    });
  }

  private addRecentTask(event: TaskEvent, success: boolean): void {
    const query = extractQuery(event.url);
    this.recentTasks.push({
      time: new Date().toLocaleTimeString(),
      workerId: event.workerId,
      query,
      count: event.count,
      error: success ? undefined : event.error,
      durationMs: event.durationMs,
    });
    if (this.recentTasks.length > this.maxRecent) {
      this.recentTasks = this.recentTasks.slice(-this.maxRecent);
    }
  }

  private handleCommand(msg: { action: string }): void {
    switch (msg.action) {
      case "pause":
        this.pool.pause();
        break;
      case "resume":
        this.pool.resume();
        break;
      case "stop":
        this.pool.stop();
        break;
    }
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
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    if (req.url === "/api/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ stats: this.pool.getStats(), dbWrites: this.dbWrites }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
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
