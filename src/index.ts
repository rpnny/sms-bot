import { env, loadStrategy, validateEnv, optional } from "./config.js";
import { child, logger } from "./logger.js";
import { loadActivePositions, insertFilterReject } from "./db.js";
import { SmartMoneyListener } from "./listeners/smart-money.js";
import { PumpFunListener } from "./listeners/pumpfun.js";
import { SignalAggregator } from "./signals/aggregator.js";
import { SafetyFilter } from "./filters/safety.js";
import { PositionManager } from "./positions/manager.js";
import { PaperExecutor } from "./execution/paper.js";
import { PositionMonitor } from "./monitor/position-monitor.js";
import { paperVirtualBalance, walletBalanceSol } from "./util/wallet.js";
import { startServer } from "./server.js";

const log = child("main");

async function main(): Promise<void> {
  validateEnv();
  const cfg = loadStrategy();

  log.info({ mode: env.runMode }, "🚀 SMS-Bot starting");
  if (env.runMode === "live") {
    log.warn("LIVE mode is not implemented in v1.0 — aborting");
    process.exit(1);
  }

  const positions = new PositionManager(cfg);
  positions.loadFromDb(loadActivePositions().filter((p) => p.mode === env.runMode));

  const filter = new SafetyFilter(cfg);
  const executor = new PaperExecutor(cfg);
  const aggregator = new SignalAggregator(cfg);
  const smartListener = new SmartMoneyListener(cfg);
  const pumpListener = new PumpFunListener(cfg);

  const monitor = new PositionMonitor(cfg, positions, executor);
  monitor.start();

  smartListener.on("signal", (ev) => aggregator.ingest(ev));
  pumpListener.on("signal", (ev) => aggregator.ingest(ev));

  aggregator.on("fused", async (signal) => {
    if (positions.checkDailyHalt()) {
      log.warn({ token: signal.token }, "daily halt — signal skipped");
      return;
    }

    const balance =
      env.runMode === "paper" ? paperVirtualBalance() : await walletBalanceSol();
    const canOpen = positions.canOpen(signal.token, signal.sizeSol, balance);
    if (!canOpen.ok) {
      log.info({ token: signal.token, reason: canOpen.reason }, "signal rejected by pm");
      return;
    }

    const res = await filter.evaluate(signal.token);
    if (!res.passed) {
      insertFilterReject(signal.token, res.rejectReason ?? "unknown", res.scores);
      log.info(
        { token: signal.token, reason: res.rejectReason },
        "filter rejected",
      );
      return;
    }

    const pos = await executor.buy(signal);
    if (pos) positions.register(pos);
  });

  const port = parseInt(optional("PORT", "3000"));
  startServer(positions, port);

  smartListener.start();
  pumpListener.start();
  log.info("listeners started — waiting for signals");

  const shutdown = () => {
    log.info("shutting down");
    smartListener.stop();
    pumpListener.stop();
    monitor.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "fatal error");
  process.exit(1);
});
