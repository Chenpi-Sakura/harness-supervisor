import { EventEmitter } from "node:events";
import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { SCHEMA_VERSION, type WorkerEvent, type WorkerEventType, type WorkerRecord } from "./types.js";
import { appendTextCapped, atomicWriteJson, ensureDir, readTail } from "./util/fsx.js";
import type { Logger } from "./util/logger.js";
import { redactText, redactValue, safeText } from "./util/redact.js";

const MAX_STDERR_FILE_BYTES = 128 * 1024;
const MAX_STDERR_TAIL_CHARS = 8000;
const MAX_EVENT_LINE_CHARS = 2 * 1024 * 1024;

export interface StoreInitResult {
  workers: WorkerRecord[];
  warnings: string[];
}

export class Store {
  readonly stateDir: string;
  readonly workersDir: string;
  readonly sessionsDir: string;
  private readonly logger?: Logger;
  private readonly records = new Map<string, WorkerRecord>();
  private readonly events = new Map<string, WorkerEvent[]>();
  private readonly stderrTails = new Map<string, string>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly writeErrors = new Map<string, Error>();
  private readonly bus = new EventEmitter();
  private initialized = false;

  constructor(stateDir: string, logger?: Logger) {
    this.stateDir = path.resolve(stateDir);
    this.workersDir = path.join(this.stateDir, "workers");
    this.sessionsDir = path.join(this.stateDir, "sessions");
    this.logger = logger;
    this.bus.setMaxListeners(0);
  }

  async init(): Promise<StoreInitResult> {
    await ensureDir(this.stateDir);
    await ensureDir(this.workersDir);
    await ensureDir(this.sessionsDir);
    const warnings: string[] = [];
    const entries = await readdir(this.workersDir, { withFileTypes: true });
    const workers: WorkerRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workerDir = path.join(this.workersDir, entry.name);
      const recordFile = path.join(workerDir, "worker.json");
      let record: WorkerRecord;
      try {
        record = JSON.parse(await readFile(recordFile, "utf8")) as WorkerRecord;
      } catch (error) {
        const warning = `Skipping unreadable worker ${entry.name}: ${(error as Error).message}`;
        warnings.push(warning);
        this.logger?.warn(warning);
        continue;
      }
      if (!record || record.schemaVersion !== SCHEMA_VERSION || record.id !== entry.name) {
        const warning = `Skipping incompatible worker record ${entry.name}`;
        warnings.push(warning);
        this.logger?.warn(warning);
        continue;
      }
      const eventsFile = path.join(workerDir, "events.jsonl");
      const loaded = await this.loadEvents(eventsFile, record.id, warnings);
      record.lastSeq = Math.max(record.lastSeq ?? 0, loaded.maxSeq);
      record.eventCount = loaded.events.length;
      record.updatedAt = record.updatedAt ?? new Date().toISOString();
      this.records.set(record.id, record);
      this.events.set(record.id, loaded.events);
      const tail = await readTail(path.join(workerDir, "stderr.log"), MAX_STDERR_TAIL_CHARS * 2);
      if (tail) this.stderrTails.set(record.id, tail);
      workers.push(record);
    }
    this.initialized = true;
    return { workers, warnings };
  }

  private async loadEvents(
    file: string,
    workerId: string,
    warnings: string[],
  ): Promise<{ events: WorkerEvent[]; maxSeq: number }> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], maxSeq: 0 };
      throw error;
    }
    const events: WorkerEvent[] = [];
    let maxSeq = 0;
    let invalid = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as WorkerEvent;
        if (
          event &&
          event.workerId === workerId &&
          typeof event.seq === "number" &&
          event.seq > maxSeq &&
          typeof event.type === "string" &&
          typeof event.ts === "string"
        ) {
          events.push(event);
          maxSeq = event.seq;
        }
      } catch {
        invalid += 1;
      }
    }
    if (invalid > 0) {
      const warning = `Ignored ${invalid} malformed event line(s) for ${workerId}`;
      warnings.push(warning);
      this.logger?.warn(warning);
    }
    return { events, maxSeq };
  }

  assertInitialized(): void {
    if (!this.initialized) throw new Error("Store.init() must be called first");
  }

  workerDir(workerId: string): string {
    return path.join(this.workersDir, workerId);
  }

  async createWorker(record: WorkerRecord): Promise<void> {
    this.assertInitialized();
    const dir = this.workerDir(record.id);
    await ensureDir(dir);
    this.records.set(record.id, record);
    this.events.set(record.id, []);
    await this.saveWorker(record);
    await this.flush(record.id);
  }

  getWorker(workerId: string): WorkerRecord | undefined {
    return this.records.get(workerId);
  }

  listWorkers(): WorkerRecord[] {
    return [...this.records.values()];
  }

  getEvents(workerId: string, sinceSeq: number, limit: number): {
    events: WorkerEvent[];
    nextSeq: number;
    hasMore: boolean;
  } {
    const all = this.events.get(workerId) ?? [];
    const startIndex = all.findIndex((event) => event.seq > sinceSeq);
    if (startIndex === -1) {
      return { events: [], nextSeq: sinceSeq, hasMore: false };
    }
    const slice = all.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < all.length;
    const nextSeq = slice.length > 0 ? slice[slice.length - 1]!.seq : sinceSeq;
    return { events: slice.map(cloneEvent), nextSeq, hasMore };
  }

  latestSeq(workerId: string): number {
    return this.records.get(workerId)?.lastSeq ?? 0;
  }

  getRecentEvents(workerId: string, limit: number): WorkerEvent[] {
    if (limit <= 0) return [];
    const all = this.events.get(workerId) ?? [];
    return all.slice(-limit).map(cloneEvent);
  }

  appendEvent(
    workerId: string,
    type: WorkerEventType,
    data?: Record<string, unknown>,
  ): WorkerEvent {
    this.assertInitialized();
    const record = this.records.get(workerId);
    if (!record) throw new Error(`Unknown worker ${workerId}`);
    const seq = record.lastSeq + 1;
    const event: WorkerEvent = {
      seq,
      workerId,
      ts: new Date().toISOString(),
      type,
      ...(data ? { data: redactValue(data) as Record<string, unknown> } : {}),
    };
    const list = this.events.get(workerId);
    if (!list) throw new Error(`Event list missing for worker ${workerId}`);
    list.push(event);
    record.lastSeq = seq;
    record.eventCount = list.length;
    record.updatedAt = event.ts;

    let line = `${JSON.stringify(event)}\n`;
    if (line.length > MAX_EVENT_LINE_CHARS) {
      const trimmed: WorkerEvent = {
        ...event,
        data: { truncated: true, note: "event data exceeded the on-disk size limit" },
      };
      line = `${JSON.stringify(trimmed)}\n`;
    }
    const safeLine = line;
    void this.enqueue(workerId, async () => {
      await ensureDir(this.workerDir(workerId));
      await appendFile(path.join(this.workerDir(workerId), "events.jsonl"), safeLine, "utf8");
    }).catch((error: unknown) => this.logWriteError(workerId, error));

    this.bus.emit(workerId, cloneEvent(event));
    return cloneEvent(event);
  }

  saveWorker(record: WorkerRecord): Promise<void> {
    this.assertInitialized();
    this.records.set(record.id, record);
    const snapshot = redactValue(structuredClone(record)) as WorkerRecord;
    return this.enqueue(record.id, async () => {
      await atomicWriteJson(path.join(this.workerDir(record.id), "worker.json"), snapshot);
    }).catch((error: unknown) => {
      this.logWriteError(record.id, error);
      throw error;
    });
  }

  subscribe(workerId: string, listener: (event: WorkerEvent) => void): () => void {
    this.bus.on(workerId, listener);
    return () => this.bus.off(workerId, listener);
  }

  async appendStderr(workerId: string, text: string): Promise<void> {
    if (!text) return;
    const clean = redactText(text);
    const combined = `${this.stderrTails.get(workerId) ?? ""}${clean}`;
    this.stderrTails.set(
      workerId,
      combined.length > MAX_STDERR_TAIL_CHARS
        ? combined.slice(-MAX_STDERR_TAIL_CHARS)
        : combined,
    );
    await appendTextCapped(
      path.join(this.workerDir(workerId), "stderr.log"),
      clean,
      MAX_STDERR_FILE_BYTES,
    );
  }

  stderrTail(workerId: string): string {
    return safeText(this.stderrTails.get(workerId) ?? "", MAX_STDERR_TAIL_CHARS);
  }

  private enqueue(workerId: string, job: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(workerId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(job);
    const tracked = next.finally(() => {
      if (this.writeQueues.get(workerId) === tracked) this.writeQueues.delete(workerId);
    });
    this.writeQueues.set(workerId, tracked);
    return tracked;
  }

  private logWriteError(workerId: string, error: unknown): void {
    this.writeErrors.set(workerId, error instanceof Error ? error : new Error(String(error)));
    this.logger?.error(`Failed to persist worker ${workerId}`, {
      error: (error as Error).message,
    });
  }

  async flush(workerId?: string): Promise<void> {
    if (workerId) {
      const queue = this.writeQueues.get(workerId);
      if (queue) await queue;
      const error = this.writeErrors.get(workerId);
      if (error) {
        this.writeErrors.delete(workerId);
        throw error;
      }
      return;
    }
    await Promise.allSettled([...this.writeQueues.values()]);
    const [firstWorker, firstError] = [...this.writeErrors.entries()][0] ?? [];
    if (firstWorker && firstError) {
      this.writeErrors.delete(firstWorker);
      throw firstError;
    }
  }
}

function cloneEvent(event: WorkerEvent): WorkerEvent {
  return JSON.parse(JSON.stringify(event)) as WorkerEvent;
}
