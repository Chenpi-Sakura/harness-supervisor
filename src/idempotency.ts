import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
 * - same key + unwritable log           -> UNCERTAIN, never re-executed;
 * - no key                              -> legacy behaviour, unchanged.
 *
 * Durability contract (what this store does, and what it does not do):
 * - `begin()` is a synchronous, atomic in-memory admission. It never awaits, so two
 *   concurrent requests with the same key can never both be admitted as `new`.
 * - The admission line is queued for append immediately. Because `begin()` cannot
 *   await, the caller MUST `await store.flush()` before running the side effect.
 *   `flush()` rejects when any queued write failed, so a side effect is never
 *   executed while its `in_progress` marker could not be written. (`release()` /
 *   `complete()` / `fail()` await their own write and reject on failure.)
 * - Every failed write also marks the affected record as uncertain in memory, so a
 *   retry of that request returns UNCERTAIN instead of being replayed or re-executed.
 * - Records are append-only snapshots in `<stateDir>/idempotency.jsonl`, so a crash
 *   can only ever leave a last `in_progress` record (reported as UNCERTAIN) and
 *   never a half-reported success. A torn trailing line (a crash during append) is
 *   skipped on load, and the next append is written on its own line so it can never
 *   be merged into the unparsable fragment.
 * - `compact()` snapshots inside the write queue and only removes the exact records
 *   it dropped, so requests admitted or updated while the rewrite is in flight are
 *   never forgotten while their line is on disk.
 *
 * Non-claims: writes are plain `appendFile` calls with no `fsync`. Durability is
 * therefore bounded by the OS page cache: a machine power loss can lose the newest
 * lines, including a completion. This is at-most-once-per-key-in-practice, not a
 * power-loss-safe or exactly-once guarantee, and it is not a substitute for the
 * native harness reporting its own effects.
 */

export type IdempotencyState = "in_progress" | "done" | "failed";

export interface IdempotencyRecord {
  key: string;
  method: string;
  paramsHash: string;
  state: IdempotencyState;
  createdAt: string;
  updatedAt: string;
  /**
   * Write rank: the position of this record's last line in the log.
   *
   * It counts writes, not admissions, and it is deliberately independent of the
   * wall clock. `updatedAt` only has millisecond resolution, so records written
   * in the same millisecond tie and "newest" cannot be decided from the
   * timestamp alone; worse, a clock step backwards would make a later write
   * look older. The write rank says exactly when the record was last touched:
   * a request that was admitted early but finished late is the most recent
   * one, and dropping it would let its side effect run twice.
   *
   * The value is recomputed from the log on load, so a log written by an
   * older build (whose counter meant "admission order") is repaired instead
   * of being trusted.
   */
  seq: number;
  workerId?: string;
  result?: unknown;
  error?: { code: string; message: string };
  /**
   * Set when the persisted state can no longer be trusted: either the record was
   * still in_progress when the daemon restarted, or a write for it failed.
   */
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
/** Pseudo key used to report a failed compaction through `flush()`. */
const COMPACT_KEY = "@compact";

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
  /**
   * Serialized append queue. It always resolves: a failed write is remembered in
   * `writeFailures` (and surfaced by `flush()`), but must not block later writes.
   */
  private chain: Promise<void> = Promise.resolve();
  /** Writes that failed since the last `flush()`/await, keyed by record id. */
  private readonly writeFailures = new Map<string, Error>();
  private initialized = false;
  private readonly maxRecords: number;
  /**
   * True when the on-disk log ends mid-line, i.e. a previous append was torn by a
   * crash. The next write must be separated by a newline, otherwise the new marker
   * is glued onto the unparsable line and is lost on the following restart (which
   * would make the request re-executable).
   */
  private needsLineBreak = false;
  /**
   * Next write rank to hand out. It is monotonic for the lifetime of the
   * store, so the order of two records never depends on the wall clock.
   */
  private nextSeq = 1;

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
    let skipped = 0;
    let maxSeq = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      // Every line takes a position, so the position of a record's last line
      // is its write rank. Release markers and torn lines consume a position
      // too, which only leaves gaps — the order stays exact.
      const position = ++maxSeq;
      try {
        const record = JSON.parse(line) as IdempotencyRecord & { released?: boolean };
        if (!record || typeof record.key !== "string") {
          skipped += 1;
          continue;
        }
        if (record.released === true) {
          this.records.delete(record.key);
          continue;
        }
        if (typeof record.method !== "string") {
          skipped += 1;
          continue;
        }
        // The stored `seq` is not trusted: an older build wrote "admission
        // order" there, which mis-ranks a request that was admitted early and
        // finished late. The file position is the write order, so it is used
        // instead.
        record.seq = position;
        this.records.set(record.key, record);
      } catch {
        // Ignore a torn trailing line from a crash.
        skipped += 1;
      }
    }
    this.nextSeq = maxSeq + 1;
    if (skipped > 0) {
      this.logger.warn("Ignored unreadable idempotency log lines", { lines: skipped });
    }
    // A crash can leave the last append without its trailing newline. Remember it
    // so the next line is written on its own line instead of merging with it.
    this.needsLineBreak = raw.length > 0 && !raw.endsWith("\n");
    if (this.needsLineBreak) {
      this.logger.warn("Idempotency log ends mid-line; the next record will be separated", {
        file: this.file,
      });
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

  /**
   * Synchronous, atomic admission. The returned `new` record is only in memory;
   * the caller must `await flush()` (which rejects on a failed write) before it
   * runs the side effect.
   */
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
        seq: this.nextSeq++,
      };
      this.records.set(id, record);
      void this.append(id, record);
      return { kind: "new", record: clone(record) };
    }
    if (existing.paramsHash !== paramsHash) {
      return { kind: "conflict", record: clone(existing) };
    }
    if (existing.uncertainAt) {
      // A crash marker or a failed write: the persisted state is unknown, so this
      // request must never be replayed or executed again automatically.
      return { kind: "uncertain", record: clone(existing) };
    }
    if (existing.state === "in_progress") {
      return { kind: "running", record: clone(existing) };
    }
    return { kind: "replay", record: clone(existing) };
  }

  /** Persist the success and confirm the write; rejects if it could not be stored. */
  async complete(method: string, key: string, result: unknown, workerId?: string): Promise<void> {
    const id = idempotencyKeyId(method, key);
    const previous = this.records.get(id);
    if (!previous) return;
    const record = { ...previous };
    this.records.set(id, record);
    record.state = "done";
    record.result = capResult(result);
    if (workerId) record.workerId = workerId;
    record.error = undefined;
    record.updatedAt = new Date().toISOString();
    record.seq = this.nextSeq++;
    await this.awaitAppend(id, record);
  }

  /** Persist the failure and confirm the write; rejects if it could not be stored. */
  async fail(method: string, key: string, error: unknown, workerId?: string): Promise<void> {
    const id = idempotencyKeyId(method, key);
    const previous = this.records.get(id);
    if (!previous) return;
    if (previous.state === "done") {
      // Never downgrade a recorded success because a later bookkeeping step failed.
      this.logger.warn("Refusing to overwrite a completed idempotency record", { key: id });
      return;
    }
    const record = { ...previous };
    this.records.set(id, record);
    record.state = "failed";
    record.error = {
      code: error instanceof SupervisorError ? error.code : "INTERNAL",
      message: errorMessage(error).slice(0, 2000),
    };
    record.result = undefined;
    if (workerId) record.workerId = workerId;
    record.updatedAt = new Date().toISOString();
    record.seq = this.nextSeq++;
    await this.awaitAppend(id, record);
  }

  /**
   * Forget an interrupted record so a later explicit request can start fresh.
   * The record is dropped from memory only once the release marker is durable, so
   * a failed release can never turn an unknown record into a re-executable one.
   */
  async release(method: string, key: string): Promise<void> {
    const id = idempotencyKeyId(method, key);
    const record = this.records.get(id);
    if (!record) return;
    const line = `${JSON.stringify({ key: id, released: true })}\n`;
    await this.awaitWrite(id, () => this.writeLine(line));
    if (this.records.get(id) === record) this.records.delete(id);
  }

  /**
   * Await all queued writes and surface any failure. Callers must await this
   * before running a side effect admitted by `begin()`.
   */
  async flush(): Promise<void> {
    await this.chain;
    if (this.writeFailures.size === 0) return;
    const failures = [...this.writeFailures.entries()];
    this.writeFailures.clear();
    const keys = failures.map(([id]) => id);
    const first = failures[0]![1];
    throw new SupervisorError(
      "INTERNAL",
      `Idempotency log write failed for ${keys.length} record(s); the state of those requests is not durable. Affected: ${keys.join(", ")}. First error: ${errorMessage(first)}`,
      { records: keys, error: errorMessage(first) },
    );
  }

  /**
   * Rewrite the log keeping the newest `keep` records. Older keys simply become
   * unknown, which is safe: a very old retry is treated as a fresh request.
   * In-progress records are always kept so crash detection is never lost.
   *
   * Memory is only rewritten after the new file is in place: a failed compaction
   * must not drop records that are still on disk, which would let a retry execute
   * a side effect that was already recorded.
   */
  async compact(options: { keep?: number } = {}): Promise<{ kept: number; dropped: number }> {
    this.assertInitialized();
    const keep = Math.max(1, Math.trunc(options.keep ?? this.maxRecords));
    let outcome = { kept: this.records.size, dropped: 0 };
    await this.awaitWrite(COMPACT_KEY, async () => {
      // The snapshot is taken *inside* the write queue: every earlier write has
      // completed, and anything queued afterwards is appended after the rewrite.
      // Taking it outside the queue would drop requests admitted while the rewrite
      // is in flight (their in_progress line would survive on disk, but memory would
      // forget them and admit the same key twice).
      //
      // The order is the write rank, not the wall clock. `updatedAt` only has
      // millisecond resolution, so records written in the same millisecond tie
      // and the newest one could be dropped instead of kept; a clock step
      // backwards would make a later write look older still. The write rank
      // counts writes, so the record that finished last has the highest one
      // and survives.
      const ordered = [...this.records.values()].sort(
        (a, b) => b.seq - a.seq || b.updatedAt.localeCompare(a.updatedAt),
      );
      const survivors = new Map<string, IdempotencyRecord>();
      for (const record of ordered.slice(0, keep)) survivors.set(record.key, record);
      for (const record of ordered) {
        // In-progress and uncertain records are recovery information: never drop them.
        if (record.state === "in_progress" || record.uncertainAt) {
          survivors.set(record.key, record);
        }
      }
      const droppedSnapshot = new Map<string, IdempotencyRecord>();
      for (const [key, record] of this.records) {
        if (!survivors.has(key)) droppedSnapshot.set(key, record);
      }
      if (droppedSnapshot.size === 0) {
        outcome = { kept: this.records.size, dropped: 0 };
        return;
      }
      // The survivors are written oldest first, so the file order stays the
      // write order. That is what makes the write rank recoverable from the
      // file position on the next load.
      const content = `${[...survivors.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`;
      await writeFileAtomic(this.file, content);
      this.needsLineBreak = false;
      // Delete only the exact snapshots that were dropped, and never rebuild the
      // map: a record admitted or updated during the rewrite keeps its own (later,
      // still appended) line on disk and must stay replayable in memory too.
      let dropped = 0;
      for (const [key, snapshot] of droppedSnapshot) {
        const current = this.records.get(key);
        if (current !== snapshot || current.uncertainAt) continue;
        this.records.delete(key);
        dropped += 1;
      }
      outcome = { kept: this.records.size, dropped };
    });
    return outcome;
  }

  /** Queue an append of the current record snapshot. Never awaited by `begin()`. */
  private append(id: string, record: IdempotencyRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    void this.enqueue(id, () => this.writeLine(line));
  }

  /**
   * Queue an append and confirm it. Unlike the admission write, this failure is
   * reported to the awaiting caller, so it is not left for an unrelated `flush()`.
   */
  private awaitAppend(id: string, record: IdempotencyRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    return this.awaitWrite(id, () => this.writeLine(line));
  }

  /** Append one complete line, separating it from a torn line left by a crash. */
  private async writeLine(text: string): Promise<void> {
    const payload = this.needsLineBreak ? `\n${text}` : text;
    try {
      await appendFile(this.file, payload, "utf8");
      this.needsLineBreak = false;
    } catch (error) {
      this.needsLineBreak = true;
      throw error;
    }
  }

  private async awaitWrite(id: string, job: () => Promise<void>): Promise<void> {
    try {
      await this.enqueue(id, job);
    } catch (error) {
      this.writeFailures.delete(id);
      throw error;
    }
  }

  /**
   * Serialize a write on the queue. The returned promise rejects when the write
   * fails, and the queue itself always keeps going. A failure is remembered for
   * `flush()` and marks the record uncertain, so the request is never re-executed.
   */
  private enqueue(id: string, job: () => Promise<void>): Promise<void> {
    const write = this.chain.then(job);
    const tracked = write.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(errorMessage(error));
      this.writeFailures.set(id, failure);
      const record = this.records.get(id);
      if (record) record.uncertainAt = record.uncertainAt ?? new Date().toISOString();
      this.logger.error("Failed to persist the idempotency log", {
        key: id,
        error: errorMessage(error),
      });
      throw failure;
    });
    // Fire-and-forget callers (begin) must not produce an unhandled rejection.
    tracked.catch(() => undefined);
    this.chain = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("IdempotencyStore.init() must be called first");
  }
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
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
