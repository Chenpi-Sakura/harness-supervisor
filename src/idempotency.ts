import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SupervisorError, errorMessage } from "./errors.js";
import type { Logger } from "./util/logger.js";

/**
 * Lightweight request idempotency for side-effecting operations
 * (worker_spawn / worker_resume / worker_send).
 *
 * Semantics are deliberately weak but honest:
 * - same key + same params + completed  -> the stored result is replayed, never re-executed;
 * - same key + same params + running    -> INVALID_STATE, nothing is executed twice;
 * - same key + different params         -> CONFLICT;
 * - same key + interrupted daemon       -> UNCERTAIN, the caller must inspect state;
 * - no key                              -> legacy behaviour, unchanged.
 *
 * Records are append-only snapshots in `<stateDir>/idempotency.jsonl`, so a
 * crash can only ever leave an `in_progress` record (which is reported as
 * UNCERTAIN) and never a half-reported success.
 */

export type IdempotencyState = "in_progress" | "done" | "failed";

export interface IdempotencyRecord {
  key: string;
  method: string;
  paramsHash: string;
  state: IdempotencyState;
  createdAt: string;
  updatedAt: string;
  workerId?: string;
  result?: unknown;
  error?: { code: string; message: string };
  /** Set when the record was still in_progress when the daemon restarted. */
  uncertainAt?: string;
}

export type IdempotencyBegin =
  | { kind: "new"; record: IdempotencyRecord }
  | { kind: "replay"; record: IdempotencyRecord }
  | { kind: "conflict"; record: IdempotencyRecord }
  | { kind: "running"; record: IdempotencyRecord }
  | { kind: "uncertain"; record: IdempotencyRecord };

const MAX_KEY_CHARS = 200;
const MAX_RESULT_BYTES = 16 * 1024;

export function idempotencyKeyId(method: string, key: string): string {
  return `${method}:${key}`;
}

export function hashParams(params: unknown): string {
  return createHash("sha256").update(stableStringify(params)).digest("hex");
}

export function validateIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SupervisorError("BAD_REQUEST", "requestId must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_CHARS) {
    throw new SupervisorError(
      "BAD_REQUEST",
      `requestId must be a non-empty string of at most ${MAX_KEY_CHARS} characters`,
    );
  }
  return trimmed;
}

export class IdempotencyStore {
  readonly stateDir: string;
  private readonly file: string;
  private readonly logger: Logger;
  private readonly records = new Map<string, IdempotencyRecord>();
  private chain: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly maxRecords: number;

  constructor(stateDir: string, logger: Logger, options: { maxRecords?: number } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.file = path.join(this.stateDir, "idempotency.jsonl");
    this.logger = logger;
    this.maxRecords = options.maxRecords ?? 2000;
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    let raw = "";
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as IdempotencyRecord & { released?: boolean };
        if (!record || typeof record.key !== "string") continue;
        if (record.released === true) {
          this.records.delete(record.key);
          continue;
        }
        if (typeof record.method !== "string") continue;
        this.records.set(record.key, record);
      } catch {
        // Ignore a torn trailing line from a crash.
      }
    }
    // Anything still marked in_progress was interrupted by a daemon crash.
    for (const record of this.records.values()) {
      if (record.state === "in_progress") {
        record.uncertainAt = new Date().toISOString();
      }
    }
    this.initialized = true;
  }

  get(key: string): IdempotencyRecord | undefined {
    const record = this.records.get(key);
    return record ? structuredClone(record) : undefined;
  }

  size(): number {
    return this.records.size;
  }

  begin(method: string, key: string, paramsHash: string): IdempotencyBegin {
    this.assertInitialized();
    const id = idempotencyKeyId(method, key);
    const existing = this.records.get(id);
    if (!existing) {
      const now = new Date().toISOString();
      const record: IdempotencyRecord = {
        key: id,
        method,
        paramsHash,
        state: "in_progress",
        createdAt: now,
        updatedAt: now,
      };
      this.records.set(id, record);
      void this.persist(record);
      return { kind: "new", record: clone(record) };
    }
    if (existing.paramsHash !== paramsHash) {
      return { kind: "conflict", record: clone(existing) };
    }
    if (existing.state === "in_progress") {
      // A record loaded from disk with a crash marker can never be replayed.
      return { kind: existing.uncertainAt ? "uncertain" : "running", record: clone(existing) };
    }
    return { kind: "replay", record: clone(existing) };
  }

  complete(method: string, key: string, result: unknown, workerId?: string): Promise<void> {
    return this.update(method, key, (record) => {
      record.state = "done";
      record.result = capResult(result);
      if (workerId) record.workerId = workerId;
      record.error = undefined;
    });
  }

  fail(method: string, key: string, error: unknown, workerId?: string): Promise<void> {
    return this.update(method, key, (record) => {
      record.state = "failed";
      record.error = {
        code: error instanceof SupervisorError ? error.code : "INTERNAL",
        message: errorMessage(error).slice(0, 2000),
      };
      record.result = undefined;
      if (workerId) record.workerId = workerId;
    });
  }

  /** Forget an interrupted record so a later explicit request can start fresh. */
  async release(method: string, key: string): Promise<void> {
    const id = idempotencyKeyId(method, key);
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => appendFile(this.file, `${JSON.stringify({ key: id, released: true })}\n`, "utf8"))
      .catch((error: unknown) => {
        this.logger.warn("Failed to persist idempotency release", {
          error: errorMessage(error),
        });
      });
    await this.chain;
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  /**
   * Rewrite the log keeping the newest `keep` records. Older keys simply become
   * unknown, which is safe: a very old retry is treated as a fresh request.
   * In-progress records are always kept so crash detection is never lost.
   */
  async compact(options: { keep?: number } = {}): Promise<{ kept: number; dropped: number }> {
    this.assertInitialized();
    const keep = Math.max(1, Math.trunc(options.keep ?? this.maxRecords));
    const ordered = [...this.records.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    const survivors = new Map<string, IdempotencyRecord>();
    for (const record of ordered.slice(0, keep)) survivors.set(record.key, record);
    for (const record of ordered) {
      if (record.state === "in_progress") survivors.set(record.key, record);
    }
    const dropped = this.records.size - survivors.size;
    if (dropped <= 0) return { kept: this.records.size, dropped: 0 };
    this.records.clear();
    for (const [key, record] of survivors) this.records.set(key, record);
    const content = `${[...this.records.values()]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`;
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.file, content))
      .catch((error: unknown) => {
        this.logger.error("Failed to compact idempotency log", { error: errorMessage(error) });
      });
    await this.chain;
    return { kept: this.records.size, dropped };
  }

  private async update(
    method: string,
    key: string,
    mutate: (record: IdempotencyRecord) => void,
  ): Promise<void> {
    this.assertInitialized();
    const id = idempotencyKeyId(method, key);
    const record = this.records.get(id);
    if (!record) return;
    mutate(record);
    record.updatedAt = new Date().toISOString();
    void this.persist(record);
  }

  private persist(record: IdempotencyRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => appendFile(this.file, line, "utf8"))
      .catch((error: unknown) => {
        this.logger.error("Failed to persist idempotency record", {
          key: record.key,
          error: errorMessage(error),
        });
      });
    return this.chain;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("IdempotencyStore.init() must be called first");
  }
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const { rename, writeFile } = await import("node:fs/promises");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

function capResult(result: unknown): unknown {
  if (result === undefined) return undefined;
  try {
    const text = JSON.stringify(result);
    if (text.length <= MAX_RESULT_BYTES) return JSON.parse(text) as unknown;
    return { truncated: true, note: "result exceeded the idempotency record size limit" };
  } catch {
    return undefined;
  }
}

function clone(record: IdempotencyRecord): IdempotencyRecord {
  return structuredClone(record);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}