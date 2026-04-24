import { child } from "../logger.js";
import { dailyRealizedLossSol } from "../db.js";
import type { Position, StrategyConfig } from "../types.js";

const log = child("positions");

export class PositionManager {
  private active = new Map<string, Position>();
  private halted = false;

  constructor(private cfg: StrategyConfig) {}

  loadFromDb(rows: Position[]): void {
    for (const p of rows) this.active.set(p.token, p);
    log.info({ count: this.active.size }, "restored active positions");
  }

  hasPosition(token: string): boolean {
    return this.active.has(token);
  }

  canOpen(token: string, sizeSol: number, walletBalanceSol: number): { ok: boolean; reason?: string } {
    if (this.halted) return { ok: false, reason: "daily_halt" };
    if (this.active.has(token)) return { ok: false, reason: "already_held" };
    if (this.active.size >= this.cfg.positions.maxConcurrent) {
      return { ok: false, reason: `max_concurrent:${this.active.size}` };
    }
    if (sizeSol > this.cfg.positions.maxSingleSol) {
      return { ok: false, reason: `size_gt_max:${sizeSol}` };
    }
    const needed = sizeSol + this.cfg.positions.gasReserveSol;
    if (walletBalanceSol < needed) {
      return { ok: false, reason: `insufficient_balance:${walletBalanceSol}<${needed}` };
    }
    return { ok: true };
  }

  register(p: Position): void {
    this.active.set(p.token, p);
    log.info({ token: p.token, size: p.amountSol, count: this.active.size }, "position opened");
  }

  update(p: Position): void {
    this.active.set(p.token, p);
  }

  close(token: string): void {
    this.active.delete(token);
    log.info({ token, remaining: this.active.size }, "position closed");
  }

  all(): Position[] {
    return Array.from(this.active.values());
  }

  get(token: string): Position | undefined {
    return this.active.get(token);
  }

  checkDailyHalt(): boolean {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const loss = dailyRealizedLossSol(start);
    if (loss >= this.cfg.positions.dailyLossLimitSol) {
      if (!this.halted) {
        log.error({ loss, limit: this.cfg.positions.dailyLossLimitSol }, "DAILY HALT triggered");
      }
      this.halted = true;
    }
    return this.halted;
  }

  resetDailyHalt(): void {
    this.halted = false;
  }
}
