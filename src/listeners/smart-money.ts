import { EventEmitter } from "node:events";
import { Connection, PublicKey } from "@solana/web3.js";
import { child } from "../logger.js";
import { loadSmartWallets, resolvedHeliusRpcUrl, resolvedHeliusWsUrl } from "../config.js";
import { createReconnectingWs } from "../util/ws.js";
import type { SignalEvent, SmartMoneyBuy, StrategyConfig } from "../types.js";

const log = child("smart-money");

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SWAP_KEYWORDS = ["Swap", "swap", "Jupiter", "Raydium", "Orca", "Pump"];

interface LogsNotification {
  method?: string;
  params?: {
    subscription: number;
    result: {
      context: { slot: number };
      value: {
        signature: string;
        err: unknown;
        logs: string[];
      };
    };
  };
  id?: number;
  result?: number;
}

export class SmartMoneyListener extends EventEmitter {
  private ws?: ReturnType<typeof createReconnectingWs>;
  private wallets: string[];
  private subIdToWallet = new Map<number, string>();
  private pendingSubs = new Map<number, string>();
  private recentBuys: Map<string, SmartMoneyBuy[]> = new Map();
  private rpc: Connection;
  private processed = new Set<string>();

  constructor(private cfg: StrategyConfig) {
    super();
    this.wallets = loadSmartWallets().map((w) => w.address);
    this.rpc = new Connection(resolvedHeliusRpcUrl(), "confirmed");
    log.info({ count: this.wallets.length }, "loaded smart wallets");
    if (this.wallets.length === 0) {
      log.warn("no smart wallets configured — listener will idle");
    }
  }

  start(): void {
    if (this.wallets.length === 0) return;

    this.ws = createReconnectingWs({
      name: "helius-logs",
      url: resolvedHeliusWsUrl(),
      onOpen: (sock) => {
        this.subIdToWallet.clear();
        this.pendingSubs.clear();
        this.wallets.forEach((wallet, idx) => {
          const reqId = idx + 1;
          this.pendingSubs.set(reqId, wallet);
          sock.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: reqId,
              method: "logsSubscribe",
              params: [{ mentions: [wallet] }, { commitment: "confirmed" }],
            }),
          );
        });
      },
      onMessage: (raw) => this.handle(raw as LogsNotification),
    });
  }

  stop(): void {
    this.ws?.close();
  }

  private handle(msg: LogsNotification): void {
    if (msg.id != null && typeof msg.result === "number") {
      const wallet = this.pendingSubs.get(msg.id);
      if (wallet) {
        this.subIdToWallet.set(msg.result, wallet);
        this.pendingSubs.delete(msg.id);
      }
      return;
    }

    if (msg.method !== "logsNotification" || !msg.params) return;
    const { subscription, result } = msg.params;
    const wallet = this.subIdToWallet.get(subscription);
    if (!wallet) return;
    const { signature, err, logs } = result.value;
    if (err) return;
    if (!logs.some((l) => SWAP_KEYWORDS.some((k) => l.includes(k)))) return;
    log.debug({ sig: signature.slice(0, 8), wallet: wallet.slice(0, 6) }, "swap tx candidate");
    if (this.processed.has(signature)) return;
    this.processed.add(signature);
    if (this.processed.size > 5000) {
      this.processed = new Set(Array.from(this.processed).slice(-2000));
    }

    void this.parseTx(signature, wallet);
  }

  private async parseTx(signature: string, wallet: string): Promise<void> {
    try {
      const tx = await this.rpc.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) return;

      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const idx = keys.indexOf(wallet);
      if (idx < 0) return;

      const solDelta = (tx.meta!.postBalances[idx] - tx.meta!.preBalances[idx]) / 1e9;
      if (solDelta >= -0.01) return;

      const pre = new Map<string, number>();
      for (const b of tx.meta!.preTokenBalances ?? []) {
        if (b.owner !== wallet) continue;
        pre.set(b.mint, b.uiTokenAmount.uiAmount ?? 0);
      }
      let boughtMint: string | null = null;
      let boughtDelta = 0;
      for (const b of tx.meta!.postTokenBalances ?? []) {
        if (b.owner !== wallet) continue;
        if (b.mint === WSOL_MINT) continue;
        const before = pre.get(b.mint) ?? 0;
        const after = b.uiTokenAmount.uiAmount ?? 0;
        const delta = after - before;
        if (delta > 0 && delta > boughtDelta) {
          boughtDelta = delta;
          boughtMint = b.mint;
        }
      }
      if (!boughtMint) return;
      this.record(boughtMint, wallet, Math.abs(solDelta));
    } catch (err) {
      log.warn({ err, signature }, "parseTx failed");
    }
  }

  private record(token: string, wallet: string, amountSol: number): void {
    const now = Date.now();
    const windowMs = this.cfg.signals.smartMoney.windowSeconds * 1000;
    const list = (this.recentBuys.get(token) ?? []).filter(
      (b) => now - b.timestamp < windowMs,
    );
    list.push({ wallet, amountSol, timestamp: now });
    this.recentBuys.set(token, list);

    const unique = new Set(list.map((b) => b.wallet));
    log.info(
      { token, wallet: wallet.slice(0, 8), amountSol, uniqueWallets: unique.size },
      "smart money buy",
    );

    if (unique.size >= this.cfg.signals.smartMoney.minUniqueWallets) {
      const ev: SignalEvent = {
        source: "smart_money",
        token,
        strength: unique.size,
        triggeringWallets: Array.from(unique),
        priority: "HIGH",
        timestamp: now,
      };
      this.emit("signal", ev);
      this.recentBuys.delete(token);
    }
  }

  watchedWallets(): string[] {
    return this.wallets;
  }
}

// PublicKey imported to validate addresses on startup if needed
export const _pk = PublicKey;
