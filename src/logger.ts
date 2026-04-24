import pino from "pino";
import { env } from "./config.js";

export const logger = pino({
  level: env.logLevel,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

export function child(mod: string) {
  return logger.child({ mod });
}
