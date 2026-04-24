import { child } from "../logger.js";

const log = child("jupiter");

const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  slippageBps: number;
}

export async function quoteBuy(params: {
  tokenMint: string;
  lamportsIn: number;
  slippageBps: number;
}): Promise<JupiterQuote | null> {
  const url = new URL(QUOTE_URL);
  url.searchParams.set("inputMint", SOL_MINT);
  url.searchParams.set("outputMint", params.tokenMint);
  url.searchParams.set("amount", String(params.lamportsIn));
  url.searchParams.set("slippageBps", String(params.slippageBps));
  url.searchParams.set("onlyDirectRoutes", "false");

  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      log.warn({ status: res.status, token: params.tokenMint }, "quote non-200");
      return null;
    }
    return (await res.json()) as JupiterQuote;
  } catch (err) {
    log.warn({ err, token: params.tokenMint }, "quote failed");
    return null;
  }
}

export async function quoteSell(params: {
  tokenMint: string;
  tokenAmount: string;
  slippageBps: number;
}): Promise<JupiterQuote | null> {
  const url = new URL(QUOTE_URL);
  url.searchParams.set("inputMint", params.tokenMint);
  url.searchParams.set("outputMint", SOL_MINT);
  url.searchParams.set("amount", params.tokenAmount);
  url.searchParams.set("slippageBps", String(params.slippageBps));

  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as JupiterQuote;
  } catch (err) {
    log.warn({ err, token: params.tokenMint }, "sell quote failed");
    return null;
  }
}

export async function currentSolPerToken(tokenMint: string): Promise<number | null> {
  const probeTokens = 1_000_000;
  const q = await quoteSell({
    tokenMint,
    tokenAmount: String(probeTokens),
    slippageBps: 5000,
  });
  if (!q) return null;
  const outLamports = Number(q.outAmount);
  return outLamports / 1e9 / probeTokens;
}
