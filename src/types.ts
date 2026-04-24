export type SignalSource = "smart_money" | "new_token" | "both";
export type SignalPriority = "MAX" | "HIGH" | "MEDIUM" | "LOW";

export interface SignalEvent {
  source: SignalSource;
  token: string;
  strength: number;
  triggeringWallets: string[];
  priority: SignalPriority;
  timestamp: number;
}

export interface SmartMoneyBuy {
  wallet: string;
  amountSol: number;
  timestamp: number;
}

export interface Position {
  id?: number;
  token: string;
  entryPrice: number;
  amountTokens: number;
  amountSol: number;
  entryTime: number;
  peakPrice: number;
  signalSource: SignalSource;
  triggeringWallets: string[];
  tier1Sold: boolean;
  tier2Sold: boolean;
  status: "active" | "closed";
  mode: "paper" | "live";
}

export type ExitReason =
  | "tier1"
  | "tier2"
  | "trailing"
  | "hard_stop"
  | "time_stop"
  | "smart_exit";

export interface FilterResult {
  passed: boolean;
  rejectReason?: string;
  scores: Record<string, number | string | boolean | null>;
}

export interface StrategyConfig {
  positions: {
    maxConcurrent: number;
    dailyLossLimitSol: number;
    gasReserveSol: number;
    sizeSmartMoneySol: number;
    sizeNewTokenSol: number;
    sizeBothSol: number;
    maxSingleSol: number;
  };
  signals: {
    smartMoney: { minUniqueWallets: number; windowSeconds: number };
    pumpfun: {
      observeSeconds: number;
      minInitialLiquiditySol: number;
      minHolders: number;
      minVolume1minSol: number;
    };
  };
  filter: {
    rugcheckMinScore: number;
    minPoolLiquiditySol: number;
    maxTop10Percent: number;
    maxDevPercent: number;
    timeoutMs: number;
  };
  takeProfit: {
    tier1TriggerPercent: number;
    tier1SellRatio: number;
    tier2TriggerPercent: number;
    tier2SellRatio: number;
    trailingDrawdownPercent: number;
  };
  stopLoss: {
    hardStopPercent: number;
    timeStopMinutes: number;
    timeStopMinGainPercent: number;
  };
  execution: {
    buySlippageBps: number;
    sellSlippageBps: number;
    maxPriceImpactPercent: number;
    priorityFeeBuySol: number;
    priorityFeeSellSol: number;
    jitoTipSol: number;
    txTimeoutSec: number;
  };
  monitor: { pollIntervalMs: number };
}
