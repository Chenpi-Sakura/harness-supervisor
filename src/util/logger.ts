import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redactText } from "./redact.js";

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  flush(): Promise<void>;
}

type Level = "debug" | "info" | "warn" | "error";

export function createLogger(file: string | null, stderr = false): Logger {
  let queue = Promise.resolve();
  const write = (level: Level, message: string, meta?: unknown) => {
    const metaText =
      meta === undefined
        ? ""
        : ` ${(() => {
            try {
              return JSON.stringify(meta);
            } catch {
              return "[unserializable]";
            }
          })()}`;
    const line = redactText(
      `${new Date().toISOString()} ${level.toUpperCase()} ${message}${metaText}`,
    );
    if (stderr) process.stderr.write(`${line}\n`);
    if (file) {
      queue = queue
        .then(async () => {
          await mkdir(path.dirname(file), { recursive: true });
          await appendFile(file, `${line}\n`, "utf8");
        })
        .catch(() => undefined);
    }
  };
  return {
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
    flush: async () => {
      await queue;
    },
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  flush: async () => undefined,
};
