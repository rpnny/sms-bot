import { EventEmitter } from "node:events";
import { child } from "../logger.js";
import type { SignalEvent, SignalSource, StrategyConfig } from "../types.js";

const log = child("signal-agg");

const MERGE_WINDOW_MS = 60_000;

interface FusedSignal extends SignalEvent {
  sizeSol: number;
}

const FUSE_DEDUP_MS = 30_000;

export class SignalAggregator extends EventEmitter {
  private pending = new Map<string, SignalEvent[]>();
  private lastEmitted = new Map<string, { sources: string; ts: number }>();

  constructor(private cfg: StrategyConfig) {
    super();
  }

  ingest(ev: SignalEvent): void {
    log.info(
      { token: ev.token, source: ev.source, priority: ev.priority, strength: ev.strength },
      "signal ingested",
    );
    const list = (this.pending.get(ev.token) ?? []).filter(
      (e) => ev.timestamp - e.timestamp < MERGE_WINDOW_MS,
    );
    list.push(ev);
    this.pending.set(ev.token, list);

    const fused = this.fuse(ev.token, list);
    // Dedup: skip emit if we recently emitted the same fused source-set for this token.
    // An upgrade (e.g. smart_money → both) still passes through.
    const sourcesKey = Array.from(new Set(list.map((e) => e.source))).sort().join(",");
    const last = this.lastEmitted.get(ev.token);
    if (last && last.sources === sourcesKey && Date.now() - last.ts < FUSE_DEDUP_MS) {
      log.debug({ token: ev.token, sources: sourcesKey }, "fused skipped (dedup)");
      return;
    }
    this.lastEmitted.set(ev.token, { sources: sourcesKey, ts: Date.now() });
    this.emit("fused", fused);

    setTimeout(() => {
      const cur = this.pending.get(ev.token);
      if (!cur) return;
      const kept = cur.filter((e) => Date.now() - e.timestamp < MERGE_WINDOW_MS);
      if (kept.length === 0) this.pending.delete(ev.token);
      else this.pending.set(ev.token, kept);
    }, MERGE_WINDOW_MS + 1000);
  }

  private fuse(token: string, list: SignalEvent[]): FusedSignal {
    const sources = new Set<SignalSource>(list.map((e) => e.source));
    const wallets = new Set<string>();
    for (const e of list) e.triggeringWallets.forEach((w) => wallets.add(w));

    const hasSmart = sources.has("smart_money");
    const hasNew = sources.has("new_token");

    let priority: SignalEvent["priority"];
    let source: SignalSource;
    let sizeSol: number;
    if (hasSmart && hasNew) {
      priority = "MAX";
      source = "both";
      sizeSol = this.cfg.positions.sizeBothSol;
    } else if (hasSmart) {
      priority = "HIGH";
      source = "smart_money";
      sizeSol = this.cfg.positions.sizeSmartMoneySol;
    } else {
      priority = "MEDIUM";
      source = "new_token";
      sizeSol = this.cfg.positions.sizeNewTokenSol;
    }

    const strength = list.reduce((m, e) => Math.max(m, e.strength), 0);
    return {
      source,
      token,
      strength,
      triggeringWallets: Array.from(wallets),
      priority,
      timestamp: Date.now(),
      sizeSol,
    };
  }
}

export type { FusedSignal };
