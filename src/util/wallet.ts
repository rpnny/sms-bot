import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { env, resolvedHeliusRpcUrl } from "../config.js";
import { child } from "../logger.js";

const log = child("wallet");

export function rpcConnection(): Connection {
  return new Connection(resolvedHeliusRpcUrl(), "confirmed");
}

export async function walletBalanceSol(): Promise<number> {
  if (!env.botWalletAddress) return Number.POSITIVE_INFINITY;
  try {
    const conn = rpcConnection();
    const lamports = await conn.getBalance(new PublicKey(env.botWalletAddress));
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    log.warn({ err }, "failed to fetch balance");
    return 0;
  }
}

export function paperVirtualBalance(): number {
  return Number.POSITIVE_INFINITY;
}
