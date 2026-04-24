import { child } from "../logger.js";
import { quoteBuy, quoteSell } from "./jupiter.js";
import {
  insertActivePosition,
  updatePosition,
  removeActivePosition,
  insertTrade,
} from "../db.js";
import type { Position, SignalSource, ExitReason, StrategyConfig } from "../types.js";
import type { FusedSignal } from "../signals/aggregator.js";

const log = child("paper-exec");

export class PaperExecutor {
  constructor(private cfg: StrategyConfig) {}

  async buy(signal: FusedSignal): Promise<Position | null> {
    const lamportsIn = Math.floor(signal.sizeSol * 1e9);
    const quote = await quoteBuy({
      tokenMint: signal.token,
      lamportsIn,
      slippageBps: this.cfg.execution.buySlippageBps,
    });
    if (!quote) {
      log.warn({ token: signal.token }, "paper buy: no quote");
      return null;
    }
    const priceImpact = parseFloat(quote.priceImpactPct) * 100;
    if (priceImpact > this.cfg.execution.maxPriceImpactPercent) {
      log.warn({ token: signal.token, priceImpact }, "paper buy: price impact too high");
      return null;
    }

    const outTokens = Number(quote.outAmount);
    if (outTokens <= 0) return null;

    const entryPrice = lamportsIn / 1e9 / outTokens;
    const position: Position = {
      token: signal.token,
      entryPrice,
      amountTokens: outTokens,
      amountSol: signal.sizeSol,
      entryTime: Date.now(),
      peakPrice: entryPrice,
      signalSource: signal.source as SignalSource,
      triggeringWallets: signal.triggeringWallets,
      tier1Sold: false,
      tier2Sold: false,
      status: "active",
      mode: "paper",
    };
    position.id = insertActivePosition(position);
    log.info(
      {
        token: signal.token,
        sizeSol: signal.sizeSol,
        tokens: outTokens,
        entryPrice,
        priceImpact: priceImpact.toFixed(2),
      },
      "📄 PAPER BUY",
    );
    return position;
  }

  async sell(params: {
    position: Position;
    ratio: number;
    reason: ExitReason;
    maxGainPercent: number;
  }): Promise<{ soldSol: number; pnlSol: number; pnlPercent: number } | null> {
    const { position, ratio, reason, maxGainPercent } = params;
    const sellTokens = Math.floor(position.amountTokens * ratio);
    if (sellTokens <= 0) return null;

    const quote = await quoteSell({
      tokenMint: position.token,
      tokenAmount: String(sellTokens),
      slippageBps: this.cfg.execution.sellSlippageBps,
    });
    if (!quote) {
      log.warn({ token: position.token }, "paper sell: no quote");
      return null;
    }

    const soldSol = Number(quote.outAmount) / 1e9;
    const costSol = position.amountSol * ratio;
    const pnlSol = soldSol - costSol;
    const pnlPercent = (pnlSol / costSol) * 100;

    const remainingTokens = position.amountTokens - sellTokens;
    const remainingSol = position.amountSol - costSol;
    const fullExit = ratio >= 0.999 || remainingTokens <= 0;

    log.info(
      {
        token: position.token,
        reason,
        ratio,
        soldSol: soldSol.toFixed(4),
        pnlSol: pnlSol.toFixed(4),
        pnlPercent: pnlPercent.toFixed(2),
        fullExit,
      },
      "📄 PAPER SELL",
    );

    if (fullExit) {
      if (position.id) removeActivePosition(position.id);
      insertTrade({
        tokenAddress: position.token,
        signalSource: position.signalSource,
        signalStrength: 0,
        triggeringWallets: position.triggeringWallets,
        entryPrice: position.entryPrice,
        entryTime: position.entryTime,
        entryAmountSol: position.amountSol + costSol,
        exitPrice: soldSol / sellTokens,
        exitTime: Date.now(),
        exitReason: reason,
        realizedPnlSol: pnlSol,
        realizedPnlPercent: pnlPercent,
        maxUnrealizedGainPercent: maxGainPercent,
        mode: "paper",
      });
    } else {
      position.amountTokens = remainingTokens;
      position.amountSol = remainingSol;
      if (reason === "tier1") position.tier1Sold = true;
      if (reason === "tier2") position.tier2Sold = true;
      updatePosition(position);
      insertTrade({
        tokenAddress: position.token,
        signalSource: position.signalSource,
        signalStrength: 0,
        triggeringWallets: position.triggeringWallets,
        entryPrice: position.entryPrice,
        entryTime: position.entryTime,
        entryAmountSol: costSol,
        exitPrice: soldSol / sellTokens,
        exitTime: Date.now(),
        exitReason: reason,
        realizedPnlSol: pnlSol,
        realizedPnlPercent: pnlPercent,
        maxUnrealizedGainPercent: maxGainPercent,
        mode: "paper",
        notes: "partial",
      });
    }

    return { soldSol, pnlSol, pnlPercent };
  }
}
