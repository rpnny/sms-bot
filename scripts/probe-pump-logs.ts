import WebSocket from "ws";
import "dotenv/config";

const url = process.env.HELIUS_WS_URL?.endsWith("=")
  ? process.env.HELIUS_WS_URL + process.env.HELIUS_API_KEY
  : process.env.HELIUS_WS_URL || "";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const ws = new WebSocket(url);
let count = 0;
const samples: string[][] = [];

ws.on("open", () => {
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "logsSubscribe",
    params: [{ mentions: [PUMP] }, { commitment: "confirmed" }]
  }));
  setTimeout(() => {
    console.log(`received ${count} events in 15s`);
    console.log("--- UNIQUE INSTRUCTION LOGS (first 40) ---");
    const instrs = new Set<string>();
    for (const logs of samples) {
      for (const l of logs) {
        if (l.includes("Program log: Instruction:") || l.includes("Program data:")) {
          instrs.add(l.slice(0, 120));
        }
      }
    }
    Array.from(instrs).slice(0, 40).forEach((x) => console.log(x));
    console.log("--- SAMPLE FULL LOG SET (1 random event) ---");
    if (samples.length > 0) {
      samples[Math.floor(samples.length / 2)].slice(0, 25).forEach((l) => console.log(l));
    }
    process.exit(0);
  }, 15000);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  const logs = msg.params?.result?.value?.logs;
  if (!logs) return;
  count++;
  if (samples.length < 200) samples.push(logs);
});
