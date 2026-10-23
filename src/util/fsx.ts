import { mkdir, readFile, rename, writeFile, appendFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { redactText, safeText, truncateText } from "./redact.js";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // Windows scanners/readers can briefly deny replacement even after the temp
  // file is closed. Retry only that rename; never unlink the existing record.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 8) {
        throw error;
      }
      await delay(Math.min(20 * 2 ** attempt, 200));
    }
  }
}

export async function writeJsonExclusive(file: string, value: unknown): Promise<boolean> {
  try {
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function appendTextCapped(file: string, text: string, maxBytes: number): Promise<void> {
  await ensureDir(path.dirname(file));
  const clean = redactText(text);
  await appendFile(file, clean, "utf8");
  try {
    const info = await stat(file);
    if (info.size > maxBytes) {
      const raw = await readFile(file, "utf8");
      const tail = truncateText(raw, Math.floor(maxBytes * 0.8)).text;
      await writeFile(file, `... [earlier stderr truncated]\n${tail}`, { encoding: "utf8", mode: 0o600 });
    }
  } catch {
    // Best-effort log trimming only.
  }
}

export async function readTail(file: string, maxBytes: number): Promise<string> {
  try {
    const info = await stat(file);
    const { open } = await import("node:fs/promises");
    const handle = await open(file, "r");
    try {
      const length = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, info.size - length));
      return safeText(buffer.toString("utf8"), maxBytes);
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
