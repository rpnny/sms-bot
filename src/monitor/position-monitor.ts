import { child } from "../logger.js";
import { currentSolPerToken } from "../execution/jupiter.js";
import type { Position, StrategyConfig, ExitReason } from "../types.js";
import type { PositionManager } from "../positions/manager.js";
import type { PaperExecutor } from "../execution/paper.js";

const log = child("monitor");

interface SmartExitHook {
  /** Returns true if any triggering wallet of the position has sold the token recently. */
  (p: Position): boolean;
}

export class PositionMonitor {
  private timer?: NodeJS.Timeout;
  private maxGainByToken = new Map<string, number>();

  constructor(
    private cfg: StrategyConfig,
    private positions: PositionManager,
    private executor: PaperExecutor,
    private smartExitHook: SmartExitHook = () => false,
  ) {}

  start(): void {
    const ms = this.cfg.monitor.pollIntervalMs;
    this.timer = setInterval(() => this.tick().catch((err) => log.error({ err }, "tick error")), ms);
    log.info({ intervalMs: ms }, "position monitor started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const all = this.positions.all();
    if (all.length === 0) return;
    await Promise.all(all.map((p) => this.evaluate(p)));
  }

  private async evaluate(p: Position): Promise<void> {
    const price = await currentSolPerToken(p.token);
    if (price == null || price <= 0) return;

    if (price > p.peakPrice) {
      p.peakPrice = price;
      this.positions.update(p);
    }

    const gainPct = ((price - p.entryPrice) / p.entryPrice) * 100;
    const prevMax = this.maxGainByToken.get(p.token) ?? 0;
    if (gainPct > prevMax) this.maxGainByToken.set(p.token, gainPct);

    const ageMin = (Date.now() - p.entryTime) / 60_000;

    // R1 time stop
    if (
      ageMin > this.cfg.stopLoss.timeStopMinutes &&
      gainPct < this.cfg.stopLoss.timeStopMinGainPercent
    ) {
      await this.exit(p, 1, "time_stop");
      return;
    }

    // R2 hard stop
    if (gainPct <= this.cfg.stopLoss.hardStopPercent) {
      await this.exit(p, 1, "hard_stop");
      return;
    }

    // R6 smart exit (same priority class as hard stop)
    if (this.smartExitHook(p)) {
      await this.exit(p, 1, "smart_exit");
      return;
    }

    // R3 tier1
    if (!p.tier1Sold && gainPct >= this.cfg.takeProfit.tier1TriggerPercent) {
      await this.exit(p, this.cfg.takeProfit.tier1SellRatio / 100, "tier1");
      return;
    }

    // R4 tier2
    if (!p.tier2Sold && gainPct >= this.cfg.takeProfit.tier2TriggerPercent) {
      await this.exit(p, this.cfg.takeProfit.tier2SellRatio / 100, "tier2");
      return;
    }

    // R5 trailing
    if (p.tier2Sold) {
      const drawdownPct = ((p.peakPrice - price) / p.peakPrice) * 100;
      if (drawdownPct >= this.cfg.takeProfit.trailingDrawdownPercent) {
        await this.exit(p, 1, "trailing");
      }
    }
  }

  private async exit(p: Position, ratio: number, reason: ExitReason): Promise<void> {
    const maxGain = this.maxGainByToken.get(p.token) ?? 0;
    const result = await this.executor.sell({ position: p, ratio, reason, maxGainPercent: maxGain });
    if (!result) return;

    if (ratio >= 0.999) {
      this.positions.close(p.token);
      this.maxGainByToken.delete(p.token);
    } else {
      this.positions.update(p);
    }
  }
}
