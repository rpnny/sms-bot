/**
 * Merge auto-discovered wallet candidates into the live smart_wallets.json.
 *
 * Strategy:
 *   - Preserve every existing entry (don't drop manually curated wallets).
 *   - Append new candidates not already in the list.
 *   - Cap total size at MAX_WALLETS — drop oldest auto-added entries first
 *     (entries labeled "gmgn-*") to make room for fresher ones.
 *
 * Run: `npx tsx src/tools/merge-wallets.ts`
 * Exits 0 on success. Prints "CHANGED" or "UNCHANGED" as the last line so
 * CI can decide whether to commit.
 */

import fs from "node:fs";
import path from "node:path";

const MAX_WALLETS = 50;
const ROOT = path.resolve(process.cwd());
const LIVE = path.join(ROOT, "config", "smart_wallets.json");
const CANDIDATES = path.join(ROOT, "config", "smart_wallets.candidates.json");

interface Wallet {
  address: string;
  label: string;
  note?: string;
}

interface File {
  _comment?: string;
  wallets: Wallet[];
}

function read(p: string): File {
  return JSON.parse(fs.readFileSync(p, "utf8")) as File;
}

function main(): void {
  const live = read(LIVE);
  const candidates = read(CANDIDATES);

  const existing = new Set(live.wallets.map((w) => w.address));
  const added: Wallet[] = [];
  for (const c of candidates.wallets) {
    if (existing.has(c.address)) continue;
    added.push({
      address: c.address,
      label: `auto-${new Date().toISOString().slice(0, 10)}-${added.length + 1}`,
      note: c.note,
    });
  }

  if (added.length === 0) {
    console.log("UNCHANGED");
    return;
  }

  let merged = [...live.wallets, ...added];

  if (merged.length > MAX_WALLETS) {
    const overflow = merged.length - MAX_WALLETS;
    let dropped = 0;
    const keep: Wallet[] = [];
    // Walk front-to-back, drop oldest auto-* entries until under cap.
    for (const w of merged) {
      if (dropped < overflow && w.label.startsWith("auto-")) {
        dropped += 1;
        continue;
      }
      keep.push(w);
    }
    merged = keep.slice(0, MAX_WALLETS);
  }

  const out: File = {
    _comment: `last auto-refresh: ${new Date().toISOString()} — ${live.wallets.length} existing + ${added.length} added, total ${merged.length}`,
    wallets: merged,
  };
  fs.writeFileSync(LIVE, JSON.stringify(out, null, 2) + "\n");
  console.log(`ADDED ${added.length} wallets, total ${merged.length}`);
  console.log("CHANGED");
}

main();
