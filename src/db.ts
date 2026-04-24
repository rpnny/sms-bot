import Database from "better-sqlite3";
import { ensureDataDir, paths } from "./config.js";
import type { Position, SignalSource, ExitReason } from "./types.js";

ensureDataDir();

export const db = new Database(paths.dbFile);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  signal_source TEXT,
  signal_strength REAL,
  triggering_wallets TEXT,
  entry_price REAL,
  entry_time DATETIME,
  entry_amount_sol REAL,
  exit_price REAL,
  exit_time DATETIME,
  exit_reason TEXT,
  realized_pnl_sol REAL,
  realized_pnl_percent REAL,
  max_unrealized_gain_percent REAL,
  filter_scores TEXT,
  mode TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS filter_rejects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT,
  reject_reason TEXT,
  filter_data TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS active_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  entry_price REAL NOT NULL,
  amount_tokens REAL NOT NULL,
  amount_sol REAL NOT NULL,
  entry_time INTEGER NOT NULL,
  peak_price REAL NOT NULL,
  signal_source TEXT NOT NULL,
  triggering_wallets TEXT NOT NULL,
  tier1_sold INTEGER DEFAULT 0,
  tier2_sold INTEGER DEFAULT 0,
  mode TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time);
CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades(exit_time);
`);

export function insertActivePosition(p: Position): number {
  const row = db
    .prepare(
      `INSERT INTO active_positions
       (token, entry_price, amount_tokens, amount_sol, entry_time, peak_price,
        signal_source, triggering_wallets, tier1_sold, tier2_sold, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.token,
      p.entryPrice,
      p.amountTokens,
      p.amountSol,
      p.entryTime,
      p.peakPrice,
      p.signalSource,
      JSON.stringify(p.triggeringWallets),
      p.tier1Sold ? 1 : 0,
      p.tier2Sold ? 1 : 0,
      p.mode,
    );
  return Number(row.lastInsertRowid);
}

export function updatePosition(p: Position): void {
  if (!p.id) throw new Error("position.id required");
  db.prepare(
    `UPDATE active_positions
     SET amount_tokens=?, amount_sol=?, peak_price=?, tier1_sold=?, tier2_sold=?
     WHERE id=?`,
  ).run(
    p.amountTokens,
    p.amountSol,
    p.peakPrice,
    p.tier1Sold ? 1 : 0,
    p.tier2Sold ? 1 : 0,
    p.id,
  );
}

export function removeActivePosition(id: number): void {
  db.prepare("DELETE FROM active_positions WHERE id = ?").run(id);
}

export function loadActivePositions(): Position[] {
  const rows = db.prepare("SELECT * FROM active_positions").all() as Array<{
    id: number;
    token: string;
    entry_price: number;
    amount_tokens: number;
    amount_sol: number;
    entry_time: number;
    peak_price: number;
    signal_source: string;
    triggering_wallets: string;
    tier1_sold: number;
    tier2_sold: number;
    mode: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    token: r.token,
    entryPrice: r.entry_price,
    amountTokens: r.amount_tokens,
    amountSol: r.amount_sol,
    entryTime: r.entry_time,
    peakPrice: r.peak_price,
    signalSource: r.signal_source as SignalSource,
    triggeringWallets: JSON.parse(r.triggering_wallets),
    tier1Sold: r.tier1_sold === 1,
    tier2Sold: r.tier2_sold === 1,
    status: "active",
    mode: r.mode as "paper" | "live",
  }));
}

export interface TradeRecord {
  tokenAddress: string;
  signalSource: SignalSource;
  signalStrength: number;
  triggeringWallets: string[];
  entryPrice: number;
  entryTime: number;
  entryAmountSol: number;
  exitPrice: number;
  exitTime: number;
  exitReason: ExitReason;
  realizedPnlSol: number;
  realizedPnlPercent: number;
  maxUnrealizedGainPercent: number;
  filterScores?: Record<string, unknown>;
  mode: "paper" | "live";
  notes?: string;
}

export function insertTrade(t: TradeRecord): void {
  db.prepare(
    `INSERT INTO trades
     (token_address, signal_source, signal_strength, triggering_wallets,
      entry_price, entry_time, entry_amount_sol,
      exit_price, exit_time, exit_reason,
      realized_pnl_sol, realized_pnl_percent, max_unrealized_gain_percent,
      filter_scores, mode, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.tokenAddress,
    t.signalSource,
    t.signalStrength,
    JSON.stringify(t.triggeringWallets),
    t.entryPrice,
    new Date(t.entryTime).toISOString(),
    t.entryAmountSol,
    t.exitPrice,
    new Date(t.exitTime).toISOString(),
    t.exitReason,
    t.realizedPnlSol,
    t.realizedPnlPercent,
    t.maxUnrealizedGainPercent,
    t.filterScores ? JSON.stringify(t.filterScores) : null,
    t.mode,
    t.notes ?? null,
  );
}

export function insertFilterReject(
  tokenAddress: string,
  reason: string,
  data: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO filter_rejects (token_address, reject_reason, filter_data)
     VALUES (?, ?, ?)`,
  ).run(tokenAddress, reason, JSON.stringify(data));
}

export function dailyRealizedLossSol(since: Date): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(realized_pnl_sol), 0) as total
       FROM trades WHERE exit_time >= ? AND realized_pnl_sol < 0`,
    )
    .get(since.toISOString()) as { total: number };
  return Math.abs(row.total);
}
