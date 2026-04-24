import express from "express";
import path from "node:path";
import { db } from "./db.js";
import { child, recentLogs } from "./logger.js";
import type { PositionManager } from "./positions/manager.js";

const log = child("server");

export function startServer(positions: PositionManager, port = 3000): void {
  const app = express();
  const password = process.env.DASHBOARD_PASSWORD ?? "";

  // simple token auth
  app.use("/api", (req, res, next) => {
    if (!password) return next();
    const token = (req.headers["x-dashboard-token"] as string) ?? req.query.token;
    if (token !== password) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  // ── API ──────────────────────────────────────────────────────────────────

  app.get("/api/stats", (_req, res) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const today = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN realized_pnl_sol <= 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(realized_pnl_sol), 0) as pnl_sol,
        COALESCE(AVG(realized_pnl_percent), 0) as avg_pnl_pct
      FROM trades WHERE exit_time >= ?
    `).get(todayStart.toISOString()) as {
      total: number; wins: number; losses: number;
      pnl_sol: number; avg_pnl_pct: number;
    };

    const allTime = db.prepare(`
      SELECT COALESCE(SUM(realized_pnl_sol), 0) as total_pnl
      FROM trades
    `).get() as { total_pnl: number };

    const byReason = db.prepare(`
      SELECT exit_reason, COUNT(*) as n,
             COALESCE(AVG(realized_pnl_percent), 0) as avg_pct
      FROM trades GROUP BY exit_reason
    `).all() as Array<{ exit_reason: string; n: number; avg_pct: number }>;

    res.json({
      today,
      allTimePnlSol: allTime.total_pnl,
      activePositions: positions.all().length,
      byReason,
    });
  });

  app.get("/api/pnl-curve", (_req, res) => {
    const rows = db.prepare(`
      SELECT exit_time, realized_pnl_sol
      FROM trades
      ORDER BY exit_time ASC
    `).all() as Array<{ exit_time: string; realized_pnl_sol: number }>;

    let cumulative = 0;
    const points = rows.map((r) => {
      cumulative += r.realized_pnl_sol;
      return { t: r.exit_time, v: parseFloat(cumulative.toFixed(4)) };
    });

    res.json(points);
  });

  app.get("/api/trades", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const rows = db.prepare(`
      SELECT token_address, signal_source, entry_price, exit_price,
             entry_amount_sol, realized_pnl_sol, realized_pnl_percent,
             exit_reason, exit_time, mode, notes
      FROM trades ORDER BY exit_time DESC LIMIT ?
    `).all(limit);
    res.json(rows);
  });

  app.get("/api/positions", (_req, res) => {
    const all = positions.all().map((p) => {
      const ageMin = ((Date.now() - p.entryTime) / 60_000).toFixed(1);
      return {
        token: p.token,
        entryPrice: p.entryPrice,
        amountSol: p.amountSol,
        amountTokens: p.amountTokens,
        signalSource: p.signalSource,
        ageMin,
        tier1Sold: p.tier1Sold,
        tier2Sold: p.tier2Sold,
        mode: p.mode,
      };
    });
    res.json(all);
  });

  app.get("/api/logs", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200), 500);
    const minLevel = Number(req.query.minLevel ?? 30); // 30 = info
    const lines = recentLogs(500)
      .filter((l) => l.level >= minLevel)
      .slice(-limit);
    res.json(lines);
  });

  app.get("/api/rejects", (_req, res) => {
    const rows = db.prepare(`
      SELECT token_address, reject_reason, timestamp
      FROM filter_rejects ORDER BY timestamp DESC LIMIT 30
    `).all();
    res.json(rows);
  });

  // ── Static frontend ───────────────────────────────────────────────────────

  const publicDir = path.join(process.cwd(), "public");
  app.use(express.static(publicDir));
  app.get("/", (_req, res) =>
    res.sendFile(path.join(publicDir, "index.html")),
  );

  app.listen(port, () =>
    log.info({ port }, "dashboard running"),
  );
}
