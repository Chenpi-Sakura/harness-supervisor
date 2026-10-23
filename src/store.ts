import { EventEmitter } from "node:events";
import { appendFile, open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SCHEMA_VERSION, type WorkerEvent, type WorkerEventType, type WorkerRecord } from "./types.js";
import { appendTextCapped, atomicWriteJson, ensureDir, readTail } from "./util/fsx.js";
import type { Logger } from "./util/logger.js";
import { redactText, redactValue, safeText } from "./util/redact.js";

const MAX_STDERR_FILE_BYTES = 128 * 1024;
const MAX_STDERR_TAIL_CHARS = 8000;
/** Hard cap on the on-disk size of one event line (bytes, not characters). */
const MAX_EVENT_LINE_BYTES = 2 * 1024 * 1024;
const EVENT_STREAM = "*all-workers*";
/**
 * Only the newest events stay in memory. The complete history lives in
 * events.jsonl and is read on demand (async, paged) or streamed via scanEvents.
 */
const MAX_CACHED_EVENTS = 500;
/** Sparse seq -> byte offset index, so paged history reads do not rescan from the start. */
const EVENT_INDEX_STRIDE = 256;
const STREAM_CHUNK_BYTES = 64 * 1024;
/**
 * Reader guard. Legacy writers limited *characters*, so an old line may reach
 * 4 bytes/characters; the read cap must stay above that or a legal multibyte
 * event would be dropped on a cold read.
 */
const STREAM_MAX_LINE_BYTES = MAX_EVENT_LINE_BYTES * 4 + 64 * 1024;

export interface StoreInitResult {
  workers: WorkerRecord[];
  warnings: string[];
}

/**
 * One page of event history.
 *
 * `truncated` is only reachable through the synchronous cache accessors: it
 * means the requested range starts before the in-memory window, so the caller
 * must use `readEvents`/`scanEvents` to see the complete history.
 */
export interface EventPage {
  events: WorkerEvent[];
  nextSeq: number;
  hasMore: boolean;
  truncated: boolean;
  source: "cache" | "disk";
}

export interface EventCacheStats {
  /** Events currently held in memory (<= MAX_CACHED_EVENTS). */
  cached: number;
  /** Events evicted from memory (still on disk). */
  evicted: number;
  /** Total events known for the worker (disk scan + appends since init). */
  total: number;
  lastSeq: number;
}

interface EventIndexEntry {
  seq: number;
  offset: number;
}

interface RawLine {
  line: string;
  offset: number;
}

/** Bounded ring of the newest events of a single worker. */
class EventCache {
  private items: WorkerEvent[] = [];
  private head = 0;
  private evicted = 0;

  constructor(private readonly limit: number) {}

  push(event: WorkerEvent): void {
    this.items.push(event);
    while (this.items.length - this.head > this.limit) {
      this.head += 1;
      this.evicted += 1;
    }
    if (this.head > this.limit) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  get size(): number {
    return this.items.length - this.head;
  }

  get evictedCount(): number {
    return this.evicted;
  }

  first(): WorkerEvent | undefined {
    return this.size > 0 ? this.items[this.head] : undefined;
  }

  all(): WorkerEvent[] {
    return this.items.slice(this.head);
  }

  recent(limit: number): WorkerEvent[] {
    if (limit <= 0) return [];
    const start = Math.max(this.head, this.items.length - limit);
    return this.items.slice(start);
  }

  since(seqExclusive: number): WorkerEvent[] {
    return this.all().filter((event) => event.seq > seqExclusive);
  }
}

export class Store {
  readonly stateDir: string;
  readonly workersDir: string;
  readonly sessionsDir: string;
  private readonly logger?: Logger;
  private readonly records = new Map<string, WorkerRecord>();
  private readonly events = new Map<string, EventCache>();
  private readonly eventIndexes = new Map<string, EventIndexEntry[]>();
  private readonly indexCounters = new Map<string, number>();
  private readonly needsLineBreak = new Set<string>();
  private readonly stderrTails = new Map<string, string>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly writeErrors = new Map<string, Error>();
  /** Failed appends remain a history defect even after flush reports the error. */
  private readonly historyErrors = new Map<string, Error>();
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
      const eventsFile = this.eventsFile(record.id);
      const loaded = await this.loadEvents(eventsFile, record.id, warnings);
      if (loaded.gaps || (record.lastSeq ?? 0) > loaded.maxSeq) {
        const message = `Event history for ${record.id} is incomplete: missing confirmed sequence(s)`;
        this.historyErrors.set(record.id, new Error(message));
        warnings.push(message);
        this.logger?.warn(message);
      }
      record.lastSeq = Math.max(record.lastSeq ?? 0, loaded.maxSeq);
      // The scan is authoritative for the count so a stale worker.json cannot inflate it.
      record.eventCount = loaded.count;
      record.updatedAt = record.updatedAt ?? new Date().toISOString();
      this.records.set(record.id, record);
      this.events.set(record.id, loaded.cache);
      this.eventIndexes.set(record.id, loaded.index);
      // A partial trailing line must not swallow the next appended event.
      if (!loaded.endsWithNewline) this.needsLineBreak.add(record.id);
      const tail = await readTail(path.join(workerDir, "stderr.log"), MAX_STDERR_TAIL_CHARS * 2);
      if (tail) this.stderrTails.set(record.id, tail);
      workers.push(record);
    }
    this.initialized = true;
    return { workers, warnings };
  }

  /**
   * Stream events.jsonl once: count them, track the maximum seq and keep only
   * the newest MAX_CACHED_EVENTS in memory plus a sparse byte-offset index.
   */
  private async loadEvents(
    file: string,
    workerId: string,
    warnings: string[],
  ): Promise<{
    cache: EventCache;
    index: EventIndexEntry[];
    count: number;
    maxSeq: number;
    endsWithNewline: boolean;
    gaps: boolean;
  }> {
    const cache = new EventCache(MAX_CACHED_EVENTS);
    const index: EventIndexEntry[] = [];
    let count = 0;
    let maxSeq = 0;
    let invalid = 0;
    let endsWithNewline = true;
    let gaps = false;
    try {
      for await (const { line, offset } of streamLines(file)) {
        if (!line.trim()) continue;
        const event = parseEventLine(line, workerId);
        if (!event) {
          invalid += 1;
          continue;
        }
        if (event.seq <= maxSeq) continue;
        if (event.seq !== maxSeq + 1) gaps = true;
        if (count % EVENT_INDEX_STRIDE === 0) index.push({ seq: event.seq, offset });
        count += 1;
        maxSeq = event.seq;
        cache.push(event);
      }
      endsWithNewline = await fileEndsWithNewline(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { cache, index, count: 0, maxSeq: 0, endsWithNewline: true, gaps: false };
    }
    if (invalid > 0) {
      const warning = `Ignored ${invalid} malformed event line(s) for ${workerId}`;
      warnings.push(warning);
      this.logger?.warn(warning);
    }
    return { cache, index, count, maxSeq, endsWithNewline, gaps };
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
    this.events.set(record.id, new EventCache(MAX_CACHED_EVENTS));
    this.eventIndexes.set(record.id, []);
    this.indexCounters.set(record.id, 0);
    await this.saveWorker(record);
    await this.flush(record.id);
  }

  getWorker(workerId: string): WorkerRecord | undefined {
    return this.records.get(workerId);
  }

  listWorkers(): WorkerRecord[] {
    return [...this.records.values()];
  }

  /**
   * Drop an in-memory worker after its directory was removed by retention.
   * Only ever used for terminal workers that the caller already validated.
   */
  forgetWorker(workerId: string): void {
    this.records.delete(workerId);
    this.events.delete(workerId);
    this.eventIndexes.delete(workerId);
    this.indexCounters.delete(workerId);
    this.needsLineBreak.delete(workerId);
    this.stderrTails.delete(workerId);
    this.writeErrors.delete(workerId);
    this.historyErrors.delete(workerId);
  }

  /**
   * Synchronous read over the in-memory window only (newest MAX_CACHED_EVENTS).
   * Kept for hot paths whose cursor sits at the tail (status, wait).
   * If `truncated` is true the range starts before the window and the caller
   * must use `readEvents` to get the complete history.
   */
  getEvents(workerId: string, sinceSeq: number, limit: number): EventPage {
    const cache = this.events.get(workerId);
    if (!cache) return emptyPage(sinceSeq, "cache");
    const window = cache.since(sinceSeq);
    const size = Math.max(0, Math.trunc(limit));
    const slice = size > 0 ? window.slice(0, size) : [];
    const first = cache.first();
    const truncated =
      cache.evictedCount > 0 && first !== undefined && first.seq > sinceSeq + 1;
    return {
      events: slice.map(cloneEvent),
      nextSeq: slice.length > 0 ? slice[slice.length - 1]!.seq : sinceSeq,
      hasMore: window.length > slice.length,
      truncated,
      source: "cache",
    };
  }

  /**
   * Read a page of the complete history (memory window + events.jsonl).
   *
   * Consistency: queued appends are flushed first, and events appended while
   * the page is being read are merged from the in-memory window, so a reader
   * never sees a gap at the tail. Never performs synchronous file IO.
   */
  async readEvents(workerId: string, sinceSeq: number, limit: number): Promise<EventPage> {
    this.assertInitialized();
    this.assertHistoryComplete(workerId);
    const cursor = Math.max(0, Math.trunc(sinceSeq));
    const size = Math.max(0, Math.trunc(limit));
    const cache = this.events.get(workerId);
    if (!cache || size === 0) return emptyPage(cursor, "cache");
    if (this.cacheCovers(cache, cursor)) return this.getEvents(workerId, cursor, size);
    await this.flushForRead(workerId);
    return this.readDiskPage(workerId, cache, cursor, size);
  }

  /**
   * Async generator over the complete history in seq order, scanning the file
   * exactly once. Used for full-history work such as notification rebuild so a
   * paged caller cannot degrade into O(N^2) rescans.
   */
  async *scanEvents(
    workerId: string,
    options: { sinceSeq?: number } = {},
  ): AsyncGenerator<WorkerEvent> {
    this.assertHistoryComplete(workerId);
    const sinceSeq = Math.max(0, Math.trunc(options.sinceSeq ?? 0));
    const cache = this.events.get(workerId);
    if (!cache) return;
    if (this.cacheCovers(cache, sinceSeq)) {
      for (const event of cache.since(sinceSeq)) yield cloneEvent(event);
      return;
    }
    await this.flushForRead(workerId);
    let lastSeq = sinceSeq;
    try {
      const start = this.seekOffset(workerId, sinceSeq);
      for await (const { line } of streamLines(this.eventsFile(workerId), start)) {
        if (!line.trim()) continue;
        const event = parseEventLine(line, workerId);
        if (!event || event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        yield cloneEvent(event);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.throwIfHistoryMissing(workerId, error);
    }
    // Appends that happened during the scan and are not on disk yet.
    for (const event of cache.since(lastSeq)) {
      lastSeq = event.seq;
      yield cloneEvent(event);
    }
  }

  cacheStats(workerId: string): EventCacheStats {
    const cache = this.events.get(workerId);
    const record = this.records.get(workerId);
    return {
      cached: cache?.size ?? 0,
      evicted: cache?.evictedCount ?? 0,
      total: record?.eventCount ?? 0,
      lastSeq: record?.lastSeq ?? 0,
    };
  }

  private eventsFile(workerId: string): string {
    return path.join(this.workerDir(workerId), "events.jsonl");
  }

  /** True when the in-memory window already holds every event after `sinceSeq`. */
  private cacheCovers(cache: EventCache, sinceSeq: number): boolean {
    if (cache.evictedCount === 0) return true;
    const first = cache.first();
    return first !== undefined && first.seq <= sinceSeq + 1;
  }

  private async readDiskPage(
    workerId: string,
    cache: EventCache,
    sinceSeq: number,
    limit: number,
  ): Promise<EventPage> {
    const events: WorkerEvent[] = [];
    let hasMore = false;
    let lastSeq = sinceSeq;
    try {
      const start = this.seekOffset(workerId, sinceSeq);
      for await (const { line } of streamLines(this.eventsFile(workerId), start)) {
        if (!line.trim()) continue;
        const event = parseEventLine(line, workerId);
        if (!event || event.seq <= lastSeq) continue;
        if (events.length >= limit) {
          hasMore = true;
          break;
        }
        events.push(event);
        lastSeq = event.seq;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.throwIfHistoryMissing(workerId, error);
    }
    if (!hasMore) {
      // Merge appends that are newer than the last event found on disk.
      for (const event of cache.since(lastSeq)) {
        if (events.length >= limit) {
          hasMore = true;
          break;
        }
        events.push(event);
        lastSeq = event.seq;
      }
    }
    return {
      events: events.map(cloneEvent),
      nextSeq: events.length > 0 ? events[events.length - 1]!.seq : sinceSeq,
      hasMore,
      truncated: false,
      source: "disk",
    };
  }

  /** Byte offset of a safe restart point at or before `sinceSeq`. */
  private seekOffset(workerId: string, sinceSeq: number): number {
    const index = this.eventIndexes.get(workerId);
    if (!index || index.length === 0) return 0;
    let low = 0;
    let high = index.length - 1;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const entry = index[mid]!;
      if (entry.seq <= sinceSeq) {
        best = entry.offset;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  /**
   * Fail closed: a read must never present a history it knows to be incomplete.
   * The stored write error is intentionally not consumed here, so repeated
   * reads keep failing until an explicit flush reports it.
   */
  private async flushForRead(workerId: string): Promise<void> {
    const queue = this.writeQueues.get(workerId);
    if (queue) await queue;
    this.assertHistoryComplete(workerId);
    const error = this.writeErrors.get(workerId);
    if (error) {
      throw new Error(
        `Event history for ${workerId} is incomplete: a queued write failed (${error.message})`,
        { cause: error },
      );
    }
  }

  private assertHistoryComplete(workerId: string): void {
    const error = this.historyErrors.get(workerId);
    if (error) throw error;
  }

  /**
   * A missing events.jsonl is only acceptable when the worker never had events.
   * Otherwise the history is incomplete and the read must fail, not pretend.
   */
  private throwIfHistoryMissing(workerId: string, error: unknown): void {
    const record = this.records.get(workerId);
    if ((record?.eventCount ?? 0) > 0 || (record?.lastSeq ?? 0) > 0) {
      throw new Error(
        `Event history for ${workerId} is missing from disk; refusing to report a partial history`,
        { cause: error },
      );
    }
  }

  latestSeq(workerId: string): number {
    return this.records.get(workerId)?.lastSeq ?? 0;
  }

  getRecentEvents(workerId: string, limit: number): WorkerEvent[] {
    const cache = this.events.get(workerId);
    if (!cache) return [];
    return cache.recent(limit).map(cloneEvent);
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
      ...(type !== "run.progress" && record.notifyTarget ? { notifyTarget: { ...record.notifyTarget } } : {}),
      ...(data ? { data: redactValue(data) as Record<string, unknown> } : {}),
    };
    const cache = this.events.get(workerId);
    if (!cache) throw new Error(`Event list missing for worker ${workerId}`);
    cache.push(event);
    record.lastSeq = seq;
    record.eventCount += 1;
    record.updatedAt = event.ts;

    let line = `${JSON.stringify(event)}\n`;
    // Measured in UTF-8 bytes so the on-disk cap matches the reader's guard:
    // a multibyte payload can never produce a line the cold reader would drop.
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
      const trimmed: WorkerEvent = {
        ...event,
        data: { truncated: true, note: "event data exceeded the on-disk size limit" },
      };
      line = `${JSON.stringify(trimmed)}\n`;
    }
    const safeLine = line;
    const lineBytes = Buffer.byteLength(safeLine, "utf8");
    void this.enqueue(workerId, async () => {
      await ensureDir(this.workerDir(workerId));
      // Repair a truncated trailing line left by a crash so this event stays parseable.
      const prefix = this.needsLineBreak.has(workerId) ? "\n" : "";
      try {
        await appendFile(this.eventsFile(workerId), `${prefix}${safeLine}`, "utf8");
        this.needsLineBreak.delete(workerId);
      } catch (error) {
        this.needsLineBreak.add(workerId);
        throw error;
      }
      await this.extendEventIndex(workerId, seq, lineBytes + prefix.length);
    }).catch((error: unknown) => {
      this.historyErrors.set(workerId, new Error(`Event history for ${workerId} is incomplete: an append failed`, { cause: error }));
      this.logWriteError(workerId, error);
    });

    this.bus.emit(workerId, cloneEvent(event));
    this.bus.emit(EVENT_STREAM, cloneEvent(event));
    return cloneEvent(event);
  }

  /**
   * Keep the sparse seq -> byte offset index alive for long-lived workers.
   * One stat per EVENT_INDEX_STRIDE appends keeps deep paging O(page) instead of
   * rescanning the whole file from offset 0 (a small, bounded cost).
   */
  private async extendEventIndex(workerId: string, seq: number, appendedBytes: number): Promise<void> {
    const pending = (this.indexCounters.get(workerId) ?? 0) + 1;
    if (pending < EVENT_INDEX_STRIDE) {
      this.indexCounters.set(workerId, pending);
      return;
    }
    try {
      const { size } = await stat(this.eventsFile(workerId));
      const index = this.eventIndexes.get(workerId);
      if (index) index.push({ seq, offset: Math.max(0, size - appendedBytes) });
      this.indexCounters.set(workerId, 0);
    } catch {
      // Index maintenance is an optimisation only; reads still work without it.
    }
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

  /** Subscribe to every event of every worker (used by the notification inbox). */
  onAnyEvent(listener: (event: WorkerEvent) => void): () => void {
    this.bus.on(EVENT_STREAM, listener);
    return () => this.bus.off(EVENT_STREAM, listener);
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

function emptyPage(sinceSeq: number, source: "cache" | "disk"): EventPage {
  return { events: [], nextSeq: sinceSeq, hasMore: false, truncated: false, source };
}

function parseEventLine(line: string, workerId: string): WorkerEvent | null {
  try {
    const event = JSON.parse(line) as WorkerEvent;
    if (
      !event ||
      event.workerId !== workerId ||
      typeof event.seq !== "number" ||
      !Number.isFinite(event.seq) ||
      typeof event.type !== "string" ||
      typeof event.ts !== "string"
    ) {
      return null;
    }
    return event;
  } catch {
    return null;
  }
}

/**
 * Byte-accurate line stream. Reads in chunks and only decodes complete lines,
 * so a 100k-event file costs O(chunk) memory and a single pass.
 * Pathologically long lines are dropped and the reader resynchronises.
 */
async function* streamLines(
  file: string,
  startOffset = 0,
  maxLineBytes = STREAM_MAX_LINE_BYTES,
): AsyncGenerator<RawLine> {
  const handle = await open(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let pendingOffset = startOffset;
    let position = startOffset;
    let discarding = false;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending =
        pending.length === 0
          ? Buffer.from(chunk.subarray(0, bytesRead))
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let consumed = 0;
      for (;;) {
        const newline = pending.indexOf(0x0a, consumed);
        if (newline === -1) break;
        if (discarding) {
          discarding = false;
        } else {
          const text = pending.subarray(consumed, newline).toString("utf8");
          yield {
            line: text.endsWith("\r") ? text.slice(0, -1) : text,
            offset: pendingOffset + consumed,
          };
        }
        consumed = newline + 1;
      }
      if (consumed > 0) {
        pendingOffset += consumed;
        pending = pending.subarray(consumed);
      }
      if (pending.length > maxLineBytes) {
        pendingOffset += pending.length;
        pending = Buffer.alloc(0);
        discarding = true;
      }
    }
    if (pending.length > 0 && !discarding) {
      const text = pending.toString("utf8");
      yield {
        line: text.endsWith("\r") ? text.slice(0, -1) : text,
        offset: pendingOffset,
      };
    }
  } finally {
    await handle.close();
  }
}

async function fileEndsWithNewline(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    await handle.close();
  }
}
