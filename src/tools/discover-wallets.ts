/**
 * Smart-money wallet discovery.
 *
 * Strategy:
 *   1. Pull recently-created Raydium pairs from DexScreener where the base
 *      token mint ends in "pump" (i.e. pump.fun graduates).
 *   2. For each graduated mint, fetch its earliest signatures via Helius RPC
 *      and extract wallets that bought the token.
 *   3. A wallet that appears as an early buyer on MANY graduates is likely
 *      smart money. Rank by hit-count, write top N to a candidates file.
 *
 * Run: `npx tsx src/tools/discover-wallets.ts`
 * Output: config/smart_wallets.candidates.json (review before merging)
 */

import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { resolvedHeliusRpcUrl } from "../config.js";
import { child } from "../logger.js";

const log = child("discover");

const GECKO_TRENDING = "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools";
const MIN_LIQUIDITY_USD = 20_000;
const GECKO_PAGES = 3;
const MAX_TOKENS = 40;
const SIGS_PER_TOKEN = 150;
const EARLIEST_N = 30;
const TOP_OUTPUT = 50;
const WSOL = "So11111111111111111111111111111111111111112";

interface GeckoPool {
  attributes: { name: string; reserve_in_usd: string | null };
  relationships: {
    base_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

async function fetchGraduates(): Promise<string[]> {
  const mints = new Set<string>();
  for (let page = 1; page <= GECKO_PAGES; page += 1) {
    const res = await fetch(`${GECKO_TRENDING}?page=${page}&duration=24h`);
    if (!res.ok) {
      log.warn({ status: res.status, page }, "gecko request failed");
      continue;
    }
    const data = (await res.json()) as { data?: GeckoPool[] };
    for (const p of data.data ?? []) {
      const dex = p.relationships.dex.data.id;
      if (dex !== "pumpswap" && dex !== "raydium") continue;
      const reserve = parseFloat(p.attributes.reserve_in_usd ?? "0");
      if (reserve < MIN_LIQUIDITY_USD) continue;
      const mint = p.relationships.base_token.data.id.replace(/^solana_/, "");
      if (!mint.endsWith("pump")) continue;
      mints.add(mint);
      if (mints.size >= MAX_TOKENS) return Array.from(mints);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return Array.from(mints);
}

async function earliestBuyers(rpc: Connection, mint: string): Promise<string[]> {
  const mintPk = new PublicKey(mint);
  const sigs = await rpc.getSignaturesForAddress(mintPk, { limit: SIGS_PER_TOKEN });
  if (sigs.length === 0) return [];
  const sorted = sigs
    .filter((s) => !s.err && s.blockTime)
    .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))
    .slice(0, EARLIEST_N);

  const buyers = new Set<string>();
  for (const s of sorted) {
    try {
      const tx = await rpc.getParsedTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) continue;

      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const pre = new Map<string, Map<string, number>>();
      for (const b of tx.meta?.preTokenBalances ?? []) {
        if (!b.owner) continue;
        const m = pre.get(b.owner) ?? new Map();
        m.set(b.mint, b.uiTokenAmount.uiAmount ?? 0);
        pre.set(b.owner, m);
      }
      for (const b of tx.meta?.postTokenBalances ?? []) {
        if (!b.owner || b.mint !== mint) continue;
        const before = pre.get(b.owner)?.get(mint) ?? 0;
        const after = b.uiTokenAmount.uiAmount ?? 0;
        if (after <= before) continue;
        const ownerIdx = keys.indexOf(b.owner);
        if (ownerIdx < 0) continue;
        const solDelta =
          (tx.meta!.postBalances[ownerIdx] - tx.meta!.preBalances[ownerIdx]) / 1e9;
        if (solDelta >= -0.005) continue;
        if (b.owner === WSOL) continue;
        buyers.add(b.owner);
      }
    } catch {
      // skip unparsable
    }
  }
  return Array.from(buyers);
}

async function main(): Promise<void> {
  const rpc = new Connection(resolvedHeliusRpcUrl(), "confirmed");
  log.info("fetching pump.fun graduates from DexScreener");
  const mints = await fetchGraduates();
  log.info({ count: mints.length }, "graduated tokens found");
  if (mints.length === 0) {
    log.warn("no graduates found — check DexScreener response or filters");
    return;
  }

  const hits = new Map<string, { mints: Set<string> }>();
  let i = 0;
  for (const mint of mints) {
    i += 1;
    log.info({ i, total: mints.length, mint: mint.slice(0, 8) }, "scanning");
    const buyers = await earliestBuyers(rpc, mint);
    for (const b of buyers) {
      const entry = hits.get(b) ?? { mints: new Set() };
      entry.mints.add(mint);
      hits.set(b, entry);
    }
  }

  const ranked = Array.from(hits.entries())
    .map(([addr, v]) => ({ address: addr, hits: v.mints.size }))
    .filter((r) => r.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, TOP_OUTPUT);

  const out = {
    _comment: `auto-discovered ${new Date().toISOString()} — review before merging into smart_wallets.json`,
    scannedTokens: mints.length,
    wallets: ranked.map((r, idx) => ({
      address: r.address,
      label: `discovered-${idx + 1}`,
      note: `appeared as early buyer in ${r.hits}/${mints.length} graduates`,
    })),
  };

  const outPath = path.join(process.cwd(), "config", "smart_wallets.candidates.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  log.info({ candidates: ranked.length, file: outPath }, "done");
}

main().catch((err) => {
  log.error({ err }, "discovery failed");
  process.exit(1);
});
