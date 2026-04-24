import { EventEmitter } from "node:events";
import { child } from "../logger.js";
import { env } from "../config.js";
import { createReconnectingWs } from "../util/ws.js";
import type { SignalEvent, StrategyConfig } from "../types.js";

const log = child("pumpfun");

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

interface LogsMessage {
  params?: {
    result?: {
      value?: {
        signature: string;
        err: unknown;
        logs: string[];
      };
    };
  };
}

export class PumpFunListener extends EventEmitter {
  private ws?: ReturnType<typeof createReconnectingWs>;
  private observed = new Set<string>();

  constructor(private cfg: StrategyConfig) {
    super();
  }

  start(): void {
    const url = env.heliusWsUrl.endsWith("=")
      ? env.heliusWsUrl + env.heliusApiKey
      : env.heliusWsUrl || `wss://mainnet.helius-rpc.com/?api-key=${env.heliusApiKey}`;

    this.ws = createReconnectingWs({
      name: "pumpfun-logs",
      url,
      onOpen: (ws) => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }],
          }),
        );
      },
      onMessage: (raw) => this.handle(raw as LogsMessage),
    });
  }

  stop(): void {
    this.ws?.close();
  }

  private handle(msg: LogsMessage): void {
    const v = msg.params?.result?.value;
    if (!v || v.err) return;
    if (!v.logs.some((l) => l.includes("Instruction: Create") && !l.includes("CreateAccount"))) return;

    const token = this.extractMintFromLogs(v.logs);
    if (!token || this.observed.has(token)) return;
    this.observed.add(token);

    log.info({ token, signature: v.signature }, "new pump.fun token detected");

    setTimeout(() => this.evaluate(token), this.cfg.signals.pumpfun.observeSeconds * 1000);
  }

  private extractMintFromLogs(logs: string[]): string | null {
    for (const l of logs) {
      const m = l.match(/mint[: ]+([A-Za-z0-9]{32,44})/i);
      if (m) return m[1];
    }
    return null;
  }

  private async evaluate(token: string): Promise<void> {
    try {
      const metrics = await fetchPumpFunMetrics(token);
      if (!metrics) return;
      const { holders, volume1minSol } = metrics;
      const minH = this.cfg.signals.pumpfun.minHolders;
      const minV = this.cfg.signals.pumpfun.minVolume1minSol;
      log.info({ token, holders, volume1minSol }, "pumpfun observation window done");
      // volume1minSol may be unavailable (pump.fun frontend blocks bots).
      // Skip the volume gate when it's null/unknown — rely on holder count alone.
      const volumeOk = volume1minSol == null || volume1minSol > minV;
      if (holders > minH && volumeOk) {
        const ev: SignalEvent = {
          source: "new_token",
          token,
          strength: holders / Math.max(1, minH),
          triggeringWallets: [],
          priority: "MEDIUM",
          timestamp: Date.now(),
        };
        this.emit("signal", ev);
      }
    } catch (err) {
      log.warn({ err, token }, "pumpfun evaluate failed");
    }
  }
}

interface PumpFunMetrics {
  holders: number;
  volume1minSol: number | null;
}

async function fetchPumpFunMetrics(token: string): Promise<PumpFunMetrics | null> {
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${token}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      holder_count?: number;
      last_trade_timestamp?: number;
      virtual_sol_reserves?: number;
    };
    const holders = data.holder_count ?? 0;
    return { holders, volume1minSol: null };
  } catch {
    return null;
  }
}
