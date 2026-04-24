import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { StrategyConfig } from "./types.js";

const ROOT = path.resolve(process.cwd());

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  runMode: (optional("RUN_MODE", "paper") as "paper" | "live"),
  logLevel: optional("LOG_LEVEL", "info"),

  heliusApiKey: optional("HELIUS_API_KEY"),
  heliusWsUrl: optional("HELIUS_WS_URL"),
  heliusRpcUrl: optional("HELIUS_RPC_URL"),
  fluxRpcUrl: optional("FLUXRPC_URL"),
  fluxRpcWsUrl: optional("FLUXRPC_WS_URL"),

  botWalletAddress: optional("BOT_WALLET_ADDRESS"),
  botWalletKeypairPath: optional("BOT_WALLET_KEYPAIR_PATH"),

  rugcheckBaseUrl: optional("RUGCHECK_BASE_URL", "https://api.rugcheck.xyz/v1"),
  birdeyeApiKey: optional("BIRDEYE_API_KEY"),

  telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
  telegramChatId: optional("TELEGRAM_CHAT_ID"),
};

export function validateEnv(): void {
  if (!env.heliusApiKey && !env.heliusWsUrl) {
    throw new Error("HELIUS_API_KEY or HELIUS_WS_URL must be set");
  }
  if (env.runMode === "live") {
    if (!env.botWalletKeypairPath) {
      throw new Error("BOT_WALLET_KEYPAIR_PATH required in live mode");
    }
    required("BOT_WALLET_ADDRESS");
  }
}

export function resolvedHeliusWsUrl(): string {
  if (env.heliusWsUrl) {
    return env.heliusWsUrl.endsWith("=")
      ? env.heliusWsUrl + env.heliusApiKey
      : env.heliusWsUrl;
  }
  return `wss://mainnet.helius-rpc.com/?api-key=${env.heliusApiKey}`;
}

export function resolvedHeliusRpcUrl(): string {
  if (env.heliusRpcUrl) {
    return env.heliusRpcUrl.endsWith("=")
      ? env.heliusRpcUrl + env.heliusApiKey
      : env.heliusRpcUrl;
  }
  return `https://mainnet.helius-rpc.com/?api-key=${env.heliusApiKey}`;
}

export function loadStrategy(): StrategyConfig {
  const p = path.join(ROOT, "config", "strategy.json");
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as StrategyConfig;
}

export interface SmartWalletEntry {
  address: string;
  label: string;
  note?: string;
}

export function loadSmartWallets(): SmartWalletEntry[] {
  const p = path.join(ROOT, "config", "smart_wallets.json");
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as { wallets: SmartWalletEntry[] };
  return parsed.wallets.filter(
    (w) => w.address && !w.address.startsWith("placeholder"),
  );
}

export const paths = {
  root: ROOT,
  dataDir: path.join(ROOT, "data"),
  dbFile: path.join(ROOT, "data", "sms-bot.sqlite"),
};

export function ensureDataDir(): void {
  if (!fs.existsSync(paths.dataDir)) fs.mkdirSync(paths.dataDir, { recursive: true });
}
