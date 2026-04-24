/**
 * Smart-money wallet discovery via GMGN.
 *
 * Pulls recent smart-money & KOL trades from `gmgn-cli track` and ranks
 * makers by trade frequency. GMGN maintains the smart_degen / renowned
 * tag lists — this is far higher-signal than building our own via RPC.
 *
 * Run: `npm run discover`
 * Output: config/smart_wallets.candidates.json (review before merging)
 *
 * Prereq: gmgn-cli installed + GMGN_API_KEY configured at ~/.config/gmgn/.env
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { child } from "../logger.js";

const log = child("discover");

const GMGN_CLI = process.env.GMGN_CLI ?? "gmgn-cli";
const CHAIN = "sol";
const LIMIT = 200;
const TOP_OUTPUT = 50;
const EXCLUDE = new Set<string>();
const BLOCKED_TAGS = new Set(["sandwich_bot", "mev_bot", "bot_degen", "sniper"]);

interface Trade {
  maker: string;
  side: "buy" | "sell";
  base_address: string;
  timestamp: number;
  amount_usd: number;
  maker_info?: { tags?: string[] };
}

function runCli(args: string[]): Trade[] {
  const out = execFileSync(GMGN_CLI, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}` },
  });
  const parsed = JSON.parse(out) as { list?: Trade[] };
  return parsed.list ?? [];
}

interface Stats {
  address: string;
  tags: Set<string>;
  buys: number;
  sells: number;
  uniqueTokens: Set<string>;
  volumeUsd: number;
  lastSeen: number;
}

function collect(trades: Trade[], agg: Map<string, Stats>): void {
  for (const t of trades) {
    if (!t.maker || EXCLUDE.has(t.maker)) continue;
    const s =
      agg.get(t.maker) ??
      {
        address: t.maker,
        tags: new Set<string>(),
        buys: 0,
        sells: 0,
        uniqueTokens: new Set<string>(),
        volumeUsd: 0,
        lastSeen: 0,
      };
    for (const tag of t.maker_info?.tags ?? []) s.tags.add(tag);
    if (t.side === "buy") s.buys += 1;
    else if (t.side === "sell") s.sells += 1;
    if (t.base_address) s.uniqueTokens.add(t.base_address);
    s.volumeUsd += t.amount_usd || 0;
    if (t.timestamp > s.lastSeen) s.lastSeen = t.timestamp;
    agg.set(t.maker, s);
  }
}

function main(): void {
  const agg = new Map<string, Stats>();

  log.info("fetching GMGN smart money buys");
  const smBuys = runCli([
    "track", "smartmoney",
    "--chain", CHAIN,
    "--limit", String(LIMIT),
    "--side", "buy",
    "--raw",
  ]);
  collect(smBuys, agg);
  log.info({ records: smBuys.length }, "smartmoney buy records");

  log.info("fetching GMGN KOL buys");
  try {
    const kolBuys = runCli([
      "track", "kol",
      "--chain", CHAIN,
      "--limit", String(LIMIT),
      "--side", "buy",
      "--raw",
    ]);
    collect(kolBuys, agg);
    log.info({ records: kolBuys.length }, "kol buy records");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "kol feed failed, skipping");
  }

  const ranked = Array.from(agg.values())
    .filter((s) => s.buys >= 2 && s.uniqueTokens.size >= 2)
    .filter((s) => ![...s.tags].some((t) => BLOCKED_TAGS.has(t)))
    .sort((a, b) => {
      if (b.uniqueTokens.size !== a.uniqueTokens.size) {
        return b.uniqueTokens.size - a.uniqueTokens.size;
      }
      return b.buys - a.buys;
    })
    .slice(0, TOP_OUTPUT);

  const out = {
    _comment: `auto-discovered ${new Date().toISOString()} via gmgn-cli — review before merging into smart_wallets.json`,
    source: "gmgn smartmoney + kol feeds",
    wallets: ranked.map((s, idx) => ({
      address: s.address,
      label: `gmgn-${idx + 1}`,
      note: `tags=${Array.from(s.tags).join("|") || "-"} buys=${s.buys} tokens=${s.uniqueTokens.size} volumeUsd=${Math.round(s.volumeUsd)}`,
    })),
  };

  const outPath = path.join(process.cwd(), "config", "smart_wallets.candidates.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  log.info({ candidates: ranked.length, file: outPath }, "done");
}

try {
  main();
} catch (err) {
  log.error({ err }, "discovery failed");
  process.exit(1);
}
