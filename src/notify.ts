import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SupervisorError, errorMessage } from "./errors.js";
import { isTerminal } from "./types.js";
import type {
  NotificationDeliveryState,
  NotificationKind,
  NotificationRecord,
  NotifyTarget,
  WorkerEvent,
  WorkerStatus,
} from "./types.js";
import { safeText } from "./util/redact.js";
import type { Logger } from "./util/logger.js";

/**
 * Notification kinds are the important, low-frequency lifecycle events that a
 * long-running consumer should never miss. Ordinary progress is deliberately
 * excluded: it stays in the per-worker event log and must not wake anyone.
 */
export interface NotifierOptions {
  stateDir: string;
  logger: Logger;
  /** Delivery channel; defaults to the inbox only. */
  channel?: "none" | "codex-queue";
  codexThreadId?: string;
  codexBin?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  /**
   * Short bounded delay before a *new* notification is handed to the host.
   * It only exists to coalesce/absorb events that stop being true within the
   * window (e.g. a maintenance cancel immediately followed by a resume).
   * `0` delivers on the next macrotask; repair paths (`retryPending`) ignore it.
   */
  deliveryDelayMs?: number;
  /**
   * Returns a reason when the record no longer describes current state and must
   * not be delivered. Optional so the notifier stays independent of the
   * supervisor; the supervisor injects the real freshness check.
   */
  staleReason?: (record: NotificationRecord) => string | undefined;
  onNewNotification?: (notification: NotificationRecord) => void;
}

/**
 * The subset of a worker record the delivery gate needs.
 * `pendingInput.seq` is the seq of the `run.needs_input` event that produced the
 * request, which is what makes a reused requestId detectable.
 */
export interface NotifyFreshnessSubject {
  status: WorkerStatus;
  pendingInput?: {
    requestId: string;
    seq?: number;
    createdAt: string;
    expiresAt?: string;
  };
  startedAt?: string;
  /**
   * A cancellation has been requested and the supervisor is still draining the
   * run. The worker record may still say `awaiting_input` with a pending input,
   * but `answer` already refuses, so a reminder would be for nothing.
   */
  cancelRequested?: boolean;
  /**
   * Seq of the newest run-start marker (`worker.starting`/`worker.resumed`/
   * `run.accepted`). Lazy so the cost is only paid when a check needs it.
   */
  lastRunStartSeq?: () => number | undefined;
}

const MAX_SUMMARY_CHARS = 600;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_DELIVERY_OUTPUT = 2000;
const DEFAULT_DELIVERY_DELAY_MS = 1_000;
const MAX_DELIVERY_DELAY_MS = 60_000;
/**
 * Legacy pending inputs have no event seq. They are created a few ms before the
 * event is appended, so anything further apart than this is a different request.
 */
const LEGACY_PENDING_TOLERANCE_MS = 2_000;

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,120}$/;

export function validateNotifyTarget(input: NotifyTarget): NotifyTarget {
  if (!input || (input.channel !== "none" && input.channel !== "codex-queue")) {
    throw new SupervisorError("BAD_REQUEST", "notification channel must be none or codex-queue");
  }
  const thread = input.codexThreadId?.trim();
  if (thread !== undefined && !THREAD_ID_PATTERN.test(thread)) {
    throw new SupervisorError("BAD_REQUEST", "codexThreadId must look like a Codex thread UUID or session name");
  }
  if (input.channel === "codex-queue" && !thread) {
    throw new SupervisorError("BAD_REQUEST", "channel codex-queue requires codexThreadId");
  }
  return input.channel === "none" ? { channel: "none" } : { channel: "codex-queue", codexThreadId: thread };
}

/** Only these event types create notifications; ordinary progress never does. */
const EVENT_KIND: Record<string, NotificationKind> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "worker.crashed": "crashed",
  "run.needs_input": "needs_input",
  "worker.orphaned": "detached",
  "worker.interrupted": "detached",
};

export function notificationKindFor(eventType: string): NotificationKind | undefined {
  return EVENT_KIND[eventType];
}

export function notificationId(workerId: string, seq: number): string {
  return `${workerId}#${seq}`;
}

/**
 * Decide whether a recorded notification still describes current truth.
 *
 * This is the delivery gate: a record that fails it is marked `superseded` and
 * never handed to the host. Its event and inbox record stay readable, so a
 * consumer can still see that the request existed — it just is not news.
 *
 * `needs_input` is checked against the *live* pending input, not against the
 * notification's own fields, because harnesses can reuse a requestId for a new
 * request after a resume:
 * - no pending input at all -> answered, cancelled, expired or the run ended;
 * - requestId mismatch -> a different request is current;
 * - event-seq mismatch -> same requestId, different request (cross-resume reuse);
 * - already expired -> the harness can no longer accept an answer.
 *
 * Only `cancelled` terminal records get the resume check: an explicit cancel
 * followed by a resume is maintenance, not a result worth waking anyone.
 * `completed`, `failed`, `crashed` and `detached` are never suppressed this way.
 *
 * The resume check keys off *evidence that a newer run started after this event*
 * (a later run-start event seq, or a `startedAt` later than the event), never off
 * the worker's current status. A fast resume that already finished must still
 * suppress the old cancel, while the new run's own cancel must stay deliverable.
 */
export function staleNotificationReason(
  subject: NotifyFreshnessSubject | undefined,
  record: NotificationRecord,
): string | undefined {
  if (!subject) return "the worker record no longer exists";
  if (record.kind === "needs_input") {
    // Cancellation wins before any pending-input reasoning: `cancel()` marks the
    // runtime first and only later rewrites the record, and in that window
    // `answer` already refuses. Reading the flag (not a status reason string) is
    // the only reliable signal.
    if (subject.cancelRequested) {
      return "a cancellation is in progress; the input request can no longer be answered";
    }
    const pending = subject.pendingInput;
    if (!pending) {
      return "the input request is no longer pending (answered, expired, cancelled or the run ended) before delivery";
    }
    if (isTerminal(subject.status)) {
      return `the worker is ${subject.status}; this input request cannot be answered any more`;
    }
    if (pending.requestId !== record.summary.requestId) {
      return `request ${record.summary.requestId ?? "unknown"} is no longer pending (current: ${pending.requestId})`;
    }
    if (pending.seq !== undefined && pending.seq !== record.seq) {
      return `requestId ${pending.requestId} now belongs to a newer request (pending event seq ${pending.seq}, notification seq ${record.seq})`;
    }
    if (pending.expiresAt && Date.parse(pending.expiresAt) < Date.now()) {
      return `request ${pending.requestId} expired at ${pending.expiresAt}`;
    }
    if (pending.seq === undefined) {
      const gap = Math.abs(Date.parse(pending.createdAt) - Date.parse(record.createdAt));
      if (Number.isFinite(gap) && gap > LEGACY_PENDING_TOLERANCE_MS) {
        return `legacy pending input (no event seq) was created ${gap}ms away from this event; treating it as a different request`;
      }
    }
    return undefined;
  }
  if (record.kind === "cancelled") {
    const runStart = subject.lastRunStartSeq?.();
    if (runStart !== undefined && runStart > record.seq) {
      return `a new run started after this cancellation (run-start seq ${runStart}, current status ${subject.status})`;
    }
    if (
      subject.startedAt !== undefined &&
      Date.parse(subject.startedAt) > Date.parse(record.createdAt)
    ) {
      return `the worker was resumed after this cancellation (startedAt ${subject.startedAt})`;
    }
  }
  return undefined;
}

/**
 * Durable inbox of important worker events plus an optional delivery channel.
 *
 * Delivery semantics are explicit and not stronger than reality:
 * - a record is created exactly once per (worker, seq) because ids are derived;
 * - the inbox itself is at-least-once readable until acknowledged;
 * - `codex-queue` delivery is best effort: it records success once the Codex CLI
 *   accepted the message, and it may deliver twice if the daemon dies between
 *   the CLI call and the state write;
 * - delivery never implies that the host woke the main agent.
 */
export class Notifier {
  readonly stateDir: string;
  private readonly file: string;
  private readonly targetFile: string;
  private readonly logger: Logger;
  private readonly records = new Map<string, NotificationRecord>();
  private readonly writeChain = { current: Promise.resolve() as Promise<void> };
  private readonly inFlight = new Set<string>();
  /** Resolved when the current attempt for that id leaves `inFlight`. */
  private readonly inFlightWait = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** One coalescing timer per worker: batched, never global, never per-record. */
  private readonly dispatchTimers = new Map<string, NodeJS.Timeout>();
  private started = false;
  private writeError?: Error;
  private needsLineBreak = false;
  private targetChanges: Promise<unknown> = Promise.resolve();
  private target: NotifyTarget;
  private readonly codexBin: string;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly deliveryDelayMs: number;
  private readonly staleReason?: (record: NotificationRecord) => string | undefined;
  private readonly onNewNotification?: (notification: NotificationRecord) => void;

  constructor(options: NotifierOptions) {
    this.stateDir = path.resolve(options.stateDir);
    this.file = path.join(this.stateDir, "notifications.jsonl");
    this.targetFile = path.join(this.stateDir, "notify-target.json");
    this.logger = options.logger;
    this.target = {
      channel: options.channel ?? "none",
      codexThreadId: options.codexThreadId,
    };
    this.codexBin = options.codexBin ?? process.env.HARNESS_SUPERVISOR_CODEX_BIN ?? "codex";
    this.maxAttempts =
      options.maxAttempts ?? intEnv("HARNESS_SUPERVISOR_NOTIFY_MAX_ATTEMPTS", MAX_ATTEMPTS, 1, 10);
    this.retryDelayMs =
      options.retryDelayMs ??
      intEnv("HARNESS_SUPERVISOR_NOTIFY_RETRY_MS", 5_000, 200, MAX_RETRY_DELAY_MS);
    this.deliveryDelayMs =
      options.deliveryDelayMs ??
      intEnv(
        "HARNESS_SUPERVISOR_NOTIFY_DELAY_MS",
        DEFAULT_DELIVERY_DELAY_MS,
        0,
        MAX_DELIVERY_DELAY_MS,
      );
    this.staleReason = options.staleReason;
    this.onNewNotification = options.onNewNotification;
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await this.loadRecords();
    await this.loadTarget();
    this.started = true;
  }

  getTarget(): NotifyTarget {
    return { ...this.target };
  }

  async setTarget(input: { channel?: "none" | "codex-queue"; codexThreadId?: string | null }): Promise<NotifyTarget> {
    const change = this.targetChanges.catch(() => undefined).then(async () => {
      const target = validateNotifyTarget({
        channel: input.channel ?? this.target.channel,
        codexThreadId: input.codexThreadId === null ? undefined : input.codexThreadId ?? this.target.codexThreadId,
      });
      target.updatedAt = new Date().toISOString();
      await this.persistTarget(target);
      this.target = target;
      return this.getTarget();
    });
    this.targetChanges = change;
    return change;
  }

  /**
   * Create notifications for important events that do not have one yet.
   * Safe to call repeatedly; used both live and while reconciling after restart.
   */
  ingest(worker: { id: string; runtime: string; status: WorkerStatus; notifyTarget?: NotifyTarget }, event: WorkerEvent): NotificationRecord | null {
    const kind = notificationKindFor(event.type);
    if (!kind) return null;
    const id = notificationId(worker.id, event.seq);
    const existing = this.records.get(id);
    if (existing) return existing;
    const target = validateNotifyTarget(event.notifyTarget ?? worker.notifyTarget ?? this.getTarget());
    const record: NotificationRecord = {
      target,
      id,
      workerId: worker.id,
      runtime: worker.runtime,
      seq: event.seq,
      eventType: event.type,
      kind,
      createdAt: event.ts,
      summary: summarize(event, kind, worker.status),
      delivery: { state: "pending", channel: target.channel, attempts: 0 },
    };
    this.records.set(id, record);
    void this.persist(record);
    this.onNewNotification?.(record);
    if (this.started && target.channel !== "none") {
      // Not delivered yet: a short per-worker window lets a burst (e.g. cancel
      // then immediate resume) collapse before anything reaches the host.
      this.scheduleDispatch(worker.id);
    }
    return record;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  /** Workers that still have an unacknowledged, actionable notification. */
  unackedWorkerIds(): Set<string> {
    return new Set(
      [...this.records.values()]
        .filter((record) => !record.ackAt && record.delivery.state !== "superseded")
        .map((record) => record.workerId),
    );
  }

  /**
   * Rewrite the inbox file, dropping only old *resolved* records (acknowledged
   * or superseded). Actionable records are never removed, regardless of age.
   */
  async compact(options: { olderThanDays?: number } = {}): Promise<{ kept: number; dropped: number }> {
    const olderThanDays = Math.max(0, options.olderThanDays ?? 30);
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let dropped = 0;
    for (const [id, record] of [...this.records.entries()]) {
      const resolvedAt = record.ackAt ?? record.delivery.supersededAt;
      if (!resolvedAt) continue;
      const resolvedMs = Date.parse(resolvedAt);
      if (!Number.isNaN(resolvedMs) && resolvedMs < cutoff) {
        this.records.delete(id);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      const snapshot = [...this.records.values()]
        .map((record) => JSON.stringify(record))
        .join("\n");
      await this.rewrite(snapshot ? `${snapshot}\n` : "");
    }
    return { kept: this.records.size, dropped };
  }

  list(filter: {
    state?: "pending" | "delivered" | "failed" | "all";
    workerId?: string;
    limit?: number;
    /** Optional cross-state view used by the production MCP presentation. */
    unacknowledgedOnly?: boolean;
  } = {}): NotificationRecord[] {
    const state = filter.state ?? "pending";
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    // Actionable views re-verify freshness before answering. Inbox-only workers
    // (`channel: "none"`) never pass through delivery, so a request that was
    // answered or withdrawn would otherwise stay in the default inbox forever.
    // Only *undelivered* records are re-classified: nothing is acknowledged here
    // and `state: "all"` keeps the full evidence untouched.
    if (state === "pending" || filter.unacknowledgedOnly) this.supersedeStaleOnRead();
    return [...this.records.values()]
      .filter((record) => {
        // Filtering happens before the limit so old acknowledged records can
        // never crowd out a newer unacknowledged one.
        if (filter.unacknowledgedOnly && (record.ackAt || record.delivery.state === "superseded")) return false;
        // The default view is the *actionable* inbox: acknowledged records must
        // never show up again, otherwise a reconnecting consumer would process
        // them forever. Acknowledged records stay readable for diagnostics via
        // state="all"/"delivered"/"failed".
        if (state === "all") return true;
        if (state === "pending") return record.delivery.state === "pending" && !record.ackAt;
        return record.delivery.state === state;
      })
      .filter((record) => (filter.workerId ? record.workerId === filter.workerId : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  /**
 * Counts for a filter. With no filter this is the whole-inbox view; with a
 * filter it applies the same state/worker/unacknowledged rules as `list`, but
 * ignores `limit`, so a caller can tell "this response was truncated" from
 * "this is how many records exist in scope".
 */
  counts(filter: {
    state?: "pending" | "delivered" | "failed" | "all";
    workerId?: string;
    unacknowledgedOnly?: boolean;
  } = {}): { pending: number; delivered: number; failed: number; superseded: number; unacked: number } {
    // No state filter means the whole inbox, matching the legacy counts().
    const state = filter.state ?? "all";
    let pending = 0;
    let delivered = 0;
    let failed = 0;
    let superseded = 0;
    let unacked = 0;
    for (const record of this.records.values()) {
      if (filter.workerId && record.workerId !== filter.workerId) continue;
      if (filter.unacknowledgedOnly && (record.ackAt || record.delivery.state === "superseded")) {
        continue;
      }
      if (state !== "all") {
        if (state === "pending") {
          if (record.delivery.state !== "pending" || record.ackAt) continue;
        } else if (record.delivery.state !== state) {
          continue;
        }
      }
      if (record.delivery.state === "delivered") delivered += 1;
      else if (record.delivery.state === "failed") failed += 1;
      else if (record.delivery.state === "superseded") superseded += 1;
      else if (!record.ackAt) pending += 1;
      // Superseded records are resolved, not actionable: they never block a
      // consumer that waits for "everything is acknowledged" and never protect
      // an old worker from retention.
      if (!record.ackAt && record.delivery.state !== "superseded") unacked += 1;
    }
    return { pending, delivered, failed, superseded, unacked };
  }

  async ack(ids: string[], by?: string): Promise<{ acked: number; missing: string[] }> {
    const missing: string[] = [];
    const now = new Date().toISOString();
    const changed: NotificationRecord[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) {
        missing.push(id);
        continue;
      }
      if (record.ackAt) continue;
      record.ackAt = now;
      this.clearRetryTimer(id);
      if (by) record.ackBy = safeText(by, 100);
      changed.push(record);
    }
    for (const record of changed) void this.persist(record);
    await this.flush();
    for (const record of changed) this.logger.info("Notification acknowledged", {
      notificationId: record.id, ackAt: record.ackAt,
      deliveryState: record.delivery.state, attempts: record.delivery.attempts,
      enqueuedAt: record.delivery.enqueuedAt, messageId: record.delivery.messageId,
    });
    return { acked: changed.length, missing };
  }

  /**
   * Re-deliver notifications that were never delivered (daemon restart, offline host,
   * channel switch). Acknowledged records are never re-delivered.
   *
   * `resetFailed` is the explicit manual retry path (`retry-notifications --states failed`):
   * a failed record gets a fresh attempt budget instead of being permanently stuck at
   * `attempts === maxAttempts`.
   */
  async retryPending(
    states: NotificationDeliveryState[] = ["pending"],
    options: { resetFailed?: boolean } = {},
  ): Promise<number> {
    const wanted = new Set(states);
    const resetFailed = options.resetFailed ?? wanted.has("failed");
    const candidates = [...this.records.values()].filter((record) => {
      if (record.ackAt) return false;
      // Superseded records are resolved: retrying them would deliver something
      // that is no longer true.
      if (record.delivery.state === "superseded") return false;
      if (record.target?.channel !== "codex-queue") return false;
      if (!wanted.has(record.delivery.state)) return false;
      if (record.delivery.state === "failed") return resetFailed;
      return record.delivery.attempts < this.maxAttempts;
    });
    for (const record of candidates) {
      if (record.delivery.state === "failed" && resetFailed) {
        record.delivery.state = "pending";
        record.delivery.attempts = 0;
        record.delivery.lastError = undefined;
        void this.persist(record);
      }
      await this.deliver(record.id).catch((error: unknown) => {
        this.logger.warn(`Notification retry failed for ${record.id}`, {
          error: errorMessage(error),
        });
      });
    }
    return candidates.length;
  }

  async deliver(id: string): Promise<NotificationRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    // An explicit retry can arrive while the previous attempt is still finishing
    // (the record already shows `failed`, but the host call is not done). Waiting
    // for that attempt keeps the request honest: reporting `retried` must mean a
    // new attempt really happened, not that it was dropped as a concurrent call.
    for (let wait = 0; this.inFlight.has(id) && wait < 2; wait += 1) {
      await this.inFlightWait.get(id)?.catch(() => undefined);
    }
    if (this.inFlight.has(id)) return record;
    // Acknowledged notifications are finished work; never send them again.
    if (record.ackAt) return record;
    if (record.delivery.state === "delivered") return record;
    // Superseded records are terminal: the event is kept for audit, but it must
    // never be retried, because nothing about it is still current.
    if (record.delivery.state === "superseded") return record;
    const target = record.target ?? { channel: "none" };
    if (target.channel === "none") return record;
    if (!target.codexThreadId) {
      record.delivery.lastError = "no codexThreadId configured";
      void this.persist(record);
      return record;
    }
    this.inFlight.add(id);
    let release: () => void = () => undefined;
    this.inFlightWait.set(
      id,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      // Confirm the route and inbox record are written before invoking the host.
      await this.flush();
      if (record.ackAt || !this.started) return record;
      // Last-moment freshness gate. Everything that is about to reach the host
      // passes through here, including retries and restart repair. Once the
      // Codex CLI accepted a message it cannot be recalled, so this check has to
      // happen *before* the call; the delivered text also tells the agent to
      // read the current pendingInput instead of trusting the message.
      record.delivery.dispatchPreparedAt = new Date().toISOString();
      void this.persist(record);
      await this.flush();
      if (record.ackAt || !this.started) return record;
      const staleReason = this.checkStale(record);
      if (staleReason) {
        this.markSuperseded(record, staleReason);
        await this.flush().catch(() => undefined);
        return record;
      }
      const message = renderMessage(record);
      record.delivery.lastAttemptStartedAt = new Date().toISOString();
      void this.persist(record);
      const result = await this.runCodexQueue(target.codexThreadId, message);
      record.delivery.attempts += 1;
      record.delivery.lastAttemptAt = new Date().toISOString();
      record.delivery.lastAttemptFinishedAt = record.delivery.lastAttemptAt;
      record.delivery.channel = target.channel;
      if (result.ok) {
        record.delivery.state = "delivered";
        record.delivery.lastError = undefined;
        record.delivery.messageId = result.messageId;
        record.delivery.enqueuedAt = record.delivery.lastAttemptFinishedAt;
        this.logger.info("Notification accepted by Codex queue", {
          notificationId: record.id, workerId: record.workerId, seq: record.seq,
          threadId: target.codexThreadId, attempts: record.delivery.attempts,
          startedAt: record.delivery.lastAttemptStartedAt, enqueuedAt: record.delivery.enqueuedAt,
          ackAt: record.ackAt, messageId: result.messageId,
        });
        this.clearRetryTimer(id);
      } else {
        record.delivery.lastError = result.error;
        record.delivery.state =
          record.delivery.attempts >= this.maxAttempts ? "failed" : "pending";
        if (record.delivery.state === "pending") this.scheduleRetry(id, record.delivery.attempts);
      }
      void this.persist(record);
      await this.flush();
      return record;
    } finally {
      this.inFlight.delete(id);
      this.inFlightWait.delete(id);
      release();
    }
  }

  async flush(): Promise<void> {
    await this.writeChain.current;
    if (this.writeError) throw this.writeError;
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.dispatchTimers.values()) clearTimeout(timer);
    this.dispatchTimers.clear();
  }

  /**
   * Re-check undelivered records when a consumer reads an actionable view.
   *
   * Inbox-only workers (`channel: "none"`) never pass through `deliver()`, so this
   * is the only place their answered/withdrawn requests can be retired; without it
   * a dead request would sit in the default inbox forever. Only records that were
   * never handed to the host are touched:
   * - a host call in flight is left alone, because the CLI may already have
   *   accepted the message and flipping it to `superseded` would then be a lie;
   * - `delivered` history is immutable (the host cannot be un-told);
   * - a record whose delivery had already failed keeps its attempt history and
   *   error, but stops being actionable since retrying it would deliver something
   *   that is no longer true.
   */
  private supersedeStaleOnRead(): void {
    if (!this.staleReason) return;
    for (const record of this.records.values()) {
      if (record.ackAt) continue;
      const state = record.delivery.state;
      if (state !== "pending" && state !== "failed") continue;
      // A failed record's host call is already over; the in-flight flag may only
      // cover its final persist. Skipping it would leave a dead request readable
      // as actionable for that window. A pending record may still be delivered.
      if (state === "pending" && this.inFlight.has(record.id)) continue;
      const reason = this.checkStale(record);
      if (!reason) continue;
      this.markSuperseded(
        record,
        state === "failed"
          ? `delivery had failed (${record.delivery.lastError ?? "unknown error"}) and the notification is no longer current: ${reason}`
          : reason,
      );
    }
  }

  private checkStale(record: NotificationRecord): string | undefined {    if (!this.staleReason) return undefined;
    try {
      return this.staleReason(record);
    } catch (error) {
      // Fail open: a broken freshness check must not silently swallow a real
      // reminder. The event stays in the inbox either way.
      this.logger.warn(`Notification freshness check failed for ${record.id}`, {
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  private markSuperseded(record: NotificationRecord, reason: string): void {
    record.delivery.state = "superseded";
    // One line: the reason is surfaced in CLI/inbox output and may quote a
    // multi-line host error.
    record.delivery.supersededReason = safeText(oneLine(reason), 400);
    record.delivery.supersededAt = new Date().toISOString();
    this.clearRetryTimer(record.id);
    void this.persist(record);
    this.logger.info(`Notification ${record.id} superseded before delivery`, {
      workerId: record.workerId,
      kind: record.kind,
      reason: record.delivery.supersededReason,
    });
  }

  /**
   * One short timer per worker. Records for *other* workers keep their own
   * timers, so batching can never delay or swallow a different worker's event.
   */
  private scheduleDispatch(workerId: string): void {
    if (this.dispatchTimers.has(workerId)) return;
    const timer = setTimeout(() => {
      this.dispatchTimers.delete(workerId);
      void this.dispatchWorker(workerId).catch((error: unknown) => {
        this.logger.warn(`Notification dispatch failed for ${workerId}`, {
          error: errorMessage(error),
        });
      });
    }, this.deliveryDelayMs);
    timer.unref?.();
    this.dispatchTimers.set(workerId, timer);
  }

  /**
   * Deliver the worker's pending records in seq order. Nothing is filtered out
   * by "a previous record was delivered but not acknowledged": the only reason
   * to drop a record here is that it stopped being true (see checkStale).
   */
  private async dispatchWorker(workerId: string): Promise<void> {
    const queued = [...this.records.values()]
      .filter(
        (record) =>
          record.workerId === workerId &&
          !record.ackAt &&
          record.delivery.state === "pending" &&
          (record.target?.channel ?? "none") !== "none",
      )
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
    for (const record of queued) {
      await this.deliver(record.id).catch((error: unknown) => {
        this.logger.warn(`Notification delivery failed for ${record.id}`, {
          error: errorMessage(error),
        });
      });
    }
  }

  private scheduleRetry(id: string, attempt: number): void {
    if (this.timers.has(id)) return;
    const delay = Math.min(this.retryDelayMs * attempt, MAX_RETRY_DELAY_MS);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const record = this.records.get(id);
      if (!record || record.delivery.state !== "pending") return;
      void this.deliver(id).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private clearRetryTimer(id: string): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  private async runCodexQueue(
    threadId: string,
    message: string,
  ): Promise<{ ok: boolean; error?: string; messageId?: string }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: { ok: boolean; error?: string; messageId?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      // The Codex binary may be an npm shim (.cmd) that needs a shell on Windows,
      // and hosts may configure a command line (e.g. an absolute node + script).
      // Every argument is validated or sanitized before it reaches this point.
      const args = ["queue", "--thread", threadId, "--message", sanitizeArg(message)];
      const command = [this.codexBin, ...args.map(quoteCmdArg)].join(" ");
      const child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
        finish({ ok: false, error: "codex queue timed out" });
      }, 20_000);
      timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = cap(stdout + chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = cap(stderr + chunk.toString("utf8"));
      });
      child.on("error", (error) => finish({ ok: false, error: `codex queue failed to start: ${error.message}` }));
      child.on("close", (code) => {
        if (code === 0) {
          const match = /Queued message (\S+) for thread/.exec(stdout);
          finish({ ok: true, messageId: match?.[1] });
        } else {
          finish({
            ok: false,
            error: `codex queue exited with code ${code}: ${safeText(stderr || stdout, 400)}`,
          });
        }
      });
    });
  }

  private rewrite(content: string): Promise<void> {
    this.writeChain.current = this.writeChain.current
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.file, content))
      .catch((error: unknown) => {
        this.writeError = error instanceof Error ? error : new Error(String(error));
        this.logger.error("Failed to compact notification inbox", { error: errorMessage(error) });
        throw error;
      });
    return this.writeChain.current;
  }

  private async loadRecords(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.needsLineBreak = raw.length > 0 && !raw.endsWith("\n");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as NotificationRecord;
        if (!record || typeof record.id !== "string" || typeof record.workerId !== "string") continue;
        // A historical record without a provable destination must never be sent
        // to whoever happens to configure the daemon next.
        record.target = record.target ? validateNotifyTarget(record.target) : { channel: "none" };
        this.records.set(record.id, record);
      } catch {
        // A partially written trailing line is expected after a crash.
      }
    }
  }

  private async loadTarget(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.targetFile, "utf8")) as NotifyTarget;
      if (parsed && (parsed.channel === "none" || parsed.channel === "codex-queue")) {
        if (parsed.codexThreadId && !THREAD_ID_PATTERN.test(parsed.codexThreadId)) {
          this.logger.warn("Ignoring invalid persisted notification target", {
            codexThreadId: parsed.codexThreadId,
          });
        } else if (parsed.channel === "codex-queue" && !parsed.codexThreadId) {
          this.logger.warn("Ignoring persisted codex-queue target without a thread id");
          this.target = { channel: "none" };
        } else {
          this.target = { channel: parsed.channel, codexThreadId: parsed.codexThreadId, updatedAt: parsed.updatedAt };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("Failed to read notification target", { error: errorMessage(error) });
      }
    }
  }

  private async persistTarget(target: NotifyTarget): Promise<void> {
    const snapshot = { ...target };
    this.writeChain.current = this.writeChain.current
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.targetFile, `${JSON.stringify(snapshot, null, 2)}\n`));
    await this.writeChain.current;
  }

  private persist(record: NotificationRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.writeChain.current = this.writeChain.current
      .catch(() => undefined)
      .then(async () => {
        await appendFile(this.file, `${this.needsLineBreak ? "\n" : ""}${line}`, "utf8");
        this.needsLineBreak = false;
      })
      .catch((error: unknown) => {
        this.needsLineBreak = true;
        this.writeError = error instanceof Error ? error : new Error(String(error));
        this.logger.error(`Failed to persist notification ${record.id}`, {
          error: errorMessage(error),
        });
      });
    return this.writeChain.current;
  }
}

function summarize(
  event: WorkerEvent,
  kind: NotificationKind,
  workerStatus: WorkerStatus,
): NotificationRecord["summary"] {
  const data = event.data ?? {};
  const summary: NotificationRecord["summary"] = { status: workerStatus };
  if (kind === "needs_input") {
    summary.requestId = typeof data.requestId === "string" ? data.requestId : undefined;
    summary.method = typeof data.method === "string" ? data.method : undefined;
    const message = pickText(data.message) ?? pickText(data.title);
    if (message) summary.text = message;
    if (Array.isArray(data.options)) {
      summary.options = data.options.filter((item): item is string => typeof item === "string").slice(0, 20);
    }
    return summary;
  }
  const text =
    pickText(data.text) ??
    pickText(data.error) ??
    pickText(data.reason) ??
    pickText(data.partialText);
  if (text) summary.text = text;
  return summary;
}

function pickText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? safeText(value, MAX_SUMMARY_CHARS) : undefined;
}

/**
 * The production wake message is deliberately a pointer, not a report.
 *
 * It carries only the worker id, the event and its seq plus what to read next:
 * re-injecting the command or the report duplicated the inbox in the main agent
 * context, and echoing the old requestId invited answers to a request that may
 * already be gone. The agent must read the live status/pendingInput first.
 *
 * This only shrinks the wake message: the inbox record keeps its existing summary
 * (MAX_SUMMARY_CHARS) and worker results keep their existing maxResultBytes.
 * No storage or result-size policy is changed here; the wake message is a pointer.
 */
export function renderMessage(record: NotificationRecord): string {
  const next =
    record.kind === "needs_input"
      ? "read worker_status; answer current pendingInput"
      : "read worker_status for result";
  return `[harness-supervisor] ${record.workerId} ${record.kind} seq=${record.seq} | ${next}`;
}

/** cmd.exe does not escape arguments for us, so quote what needs quoting. */
function quoteCmdArg(arg: string): string {
  return /^[A-Za-z0-9_\-.:\/@=]+$/.test(arg) ? arg : `"${arg.replace(/"/g, "'")}"`;
}

/** Keep the delivered text on one line and free of shell-hostile characters. */
function sanitizeArg(text: string): string {
  return oneLine(text).replace(/["`]/g, "'");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cap(text: string): string {
  return text.length > MAX_DELIVERY_OUTPUT ? text.slice(-MAX_DELIVERY_OUTPUT) : text;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const { rename, writeFile } = await import("node:fs/promises");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}
