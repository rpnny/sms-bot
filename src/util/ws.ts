import WebSocket from "ws";
import { child } from "../logger.js";

const log = child("ws");

export interface ReconnectingWsOptions {
  url: string;
  name: string;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (data: unknown) => void;
  onClose?: () => void;
}

export function createReconnectingWs(opts: ReconnectingWsOptions): {
  close: () => void;
  send: (data: string | object) => void;
} {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    log.info({ name: opts.name, url: maskKey(opts.url) }, "connecting");
    ws = new WebSocket(opts.url);

    ws.on("open", () => {
      retry = 0;
      log.info({ name: opts.name }, "connected");
      opts.onOpen?.(ws!);
    });

    ws.on("message", (raw) => {
      try {
        const text = raw.toString();
        const data = JSON.parse(text);
        opts.onMessage(data);
      } catch (err) {
        log.error({ err, name: opts.name }, "parse error");
      }
    });

    ws.on("close", () => {
      log.warn({ name: opts.name }, "socket closed");
      opts.onClose?.();
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.error({ err: err.message, name: opts.name }, "socket error");
    });
  };

  const scheduleReconnect = () => {
    if (closed) return;
    retry += 1;
    const delay = Math.min(60_000, 1000 * Math.pow(2, retry));
    log.info({ name: opts.name, retry, delayMs: delay }, "reconnecting");
    setTimeout(connect, delay);
  };

  const send = (data: string | object) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.warn({ name: opts.name }, "send skipped, socket not open");
      return;
    }
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
  };

  const close = () => {
    closed = true;
    ws?.close();
  };

  connect();
  return { close, send };
}

function maskKey(url: string): string {
  return url.replace(/api-key=([^&]+)/, (_, k: string) => `api-key=${k.slice(0, 6)}...`);
}
