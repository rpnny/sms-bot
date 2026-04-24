import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const API_KEY = process.env.GMGN_API_KEY;
if (!API_KEY) {
  console.error("Missing GMGN_API_KEY in .env");
  process.exit(1);
}

const PERIOD = (process.argv[2] as "1d" | "7d" | "30d") ?? "7d";
const LIMIT = Number(process.argv[3] ?? 20);

// GMGN public quotation endpoint (unofficial but commonly used).
const URL = `https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/${PERIOD}?tag=smart_degen&orderby=pnl_${PERIOD}&direction=desc`;

async function main(): Promise<void> {
  console.log(`Fetching ${URL}`);
  const res = await fetch(URL, {
    headers: {
      accept: "application/json",
      "x-api-key": API_KEY!,
      authorization: `Bearer ${API_KEY}`,
      "user-agent": "Mozilla/5.0 sms-bot/1.0",
    },
  });
  console.log(`HTTP ${res.status}`);
  const text = await res.text();
  if (!res.ok) {
    console.error("Response body:");
    console.error(text.slice(0, 2000));
    process.exit(2);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.error("Not JSON, first 1500 chars:");
    console.error(text.slice(0, 1500));
    process.exit(3);
  }

  // Print the raw shape so we can adjust parsing
  console.log("Response keys:", Object.keys(json as object));
  console.log("Sample:", JSON.stringify(json, null, 2).slice(0, 2000));

  // Common shapes: { code, data: { rank: [...] } } or { data: [...] }
  const candidates: Array<Record<string, unknown>> = extractList(json);
  if (candidates.length === 0) {
    console.error("Could not locate wallet list in response — inspect the sample above.");
    process.exit(4);
  }

  const wallets = candidates.slice(0, LIMIT).map((w, i) => {
    const address =
      (w.address as string) ??
      (w.wallet_address as string) ??
      (w.wallet as string) ??
      (w.owner as string);
    const pnl = w.pnl ?? w.realized_profit ?? w.pnl_7d ?? w.pnl_30d ?? null;
    const winrate = w.winrate ?? w.win_rate ?? null;
    return {
      address,
      label: `gmgn_${PERIOD}_#${i + 1}`,
      note: `pnl=${pnl}, winrate=${winrate}`,
    };
  }).filter((w) => !!w.address);

  const outPath = path.join(process.cwd(), "config", "smart_wallets.json");
  const payload = {
    _comment: `Auto-generated from GMGN ${PERIOD} top traders @ ${new Date().toISOString()}`,
    wallets,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`✅ Wrote ${wallets.length} wallets to ${outPath}`);
}

function extractList(obj: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(obj)) return obj as Array<Record<string, unknown>>;
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.rank)) return o.rank as Array<Record<string, unknown>>;
    for (const v of Object.values(o)) {
      const found = extractList(v);
      if (found.length > 0) return found;
    }
  }
  return [];
}

main().catch((err) => {
  console.error(err);
  process.exit(99);
});
