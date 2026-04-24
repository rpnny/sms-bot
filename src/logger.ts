import pino from "pino";
import PinoPretty from "pino-pretty";
import { env } from "./config.js";

export interface LogEntry {
  t: number;
  level: number;
  mod?: string;
  msg: string;
  extra?: Record<string, unknown>;
}

const RING_MAX = 500;
const ring: LogEntry[] = [];

const prettyStream = PinoPretty({
  colorize: true,
  translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
  ignore: "pid,hostname",
});

const captureStream = {
  write(chunk: string): void {
    try {
      const o = JSON.parse(chunk) as Record<string, unknown>;
      const { time, level, mod, msg, err, ...rest } = o as {
        time: number;
        level: number;
        mod?: string;
        msg: string;
        err?: { message?: string };
        [k: string]: unknown;
      };
      const extra: Record<string, unknown> = { ...rest };
      if (err) extra.err = err.message ?? String(err);
      ring.push({
        t: time,
        level,
        mod,
        msg: msg ?? "",
        extra: Object.keys(extra).length ? extra : undefined,
      });
      if (ring.length > RING_MAX) ring.shift();
    } catch {
      // ignore non-JSON frames
    }
  },
};

export const logger = pino(
  { level: env.logLevel },
  pino.multistream([
    { stream: prettyStream as NodeJS.WritableStream },
    { stream: captureStream as NodeJS.WritableStream },
  ]),
);

export function child(mod: string) {
  return logger.child({ mod });
}

export function recentLogs(limit = 200): LogEntry[] {
  return ring.slice(-limit);
}
