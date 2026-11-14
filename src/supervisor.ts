import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SupervisorError, errorMessage } from "./errors.js";
import {
  IdempotencyStore,
  hashParams,
  validateIdempotencyKey,
  type IdempotencyRecord,
} from "./idempotency.js";
import {
  Notifier,
  notificationId,
  notificationKindFor,
  staleNotificationReason,
  validateNotifyTarget,
} from "./notify.js";
import { Retention, type PruneOptions, type PruneResult } from "./retention.js";
import { Store } from "./store.js";
import { readConsumerCheckpoint, writeConsumerCheckpoint } from "./consumer-checkpoints.js";
import { withWorkerProtocol } from "./worker-protocol.js";
import { isThreadUuid } from "./caller-thread.js";
import {
  buildLastProgress,
  buildTimeline,
  findLastProgressEvent,
} from "./progress-evidence.js";
import { buildInputState, refreshInputStateTime } from "./input-state.js";
import {
  MetricsStore,
  type MetricsReport,
  type MetricsReportOptions,
  type TaskCreateInput,
  type TaskMetrics,
  type TaskRecord,
  type UsageRecord,
  type UsageRecordInput,
} from "./metrics.js";
import {
  ACTIVE_STATUSES,
  isTerminal,
  type ExtensionUiResponse,
  type HarnessAdapter,
  type HarnessCallbacks,
  type HarnessEvent,
  type HarnessExit,
  type HarnessSession,
  type CompactResult,
  type CompactWorkerResult,
  type HarnessSpawnSpec,
  type NotificationsResult,
  type NotificationBinding,
  type NotificationBindingSource,
  type NotificationDeliveryState,
  type NotifyTarget,
  type PendingInput,
  type ReadEventsResult,
  type ResumeInput,
  type ForgetWorkerResult,
  type SendMode,
  type SpawnInput,
  type SupervisorInfo,
  type SupervisorLimits,
  type StorageDiagnostics,
  type WaitResult,
  type WorkerAdminAction,
  type WorkerConfig,
  type WorkerEvent,
  type WorkerEventType,
  type WorkerInputState,
  type WorkerLastProgress,
  type WorkerLifecycle,
  type WorkerPersistence,
  type WorkerRecord,
  type WorkerSessionProjection,
  type WorkerStatus,
  type WorkerStatusResult,
  type WorkerSummary,
  type WorkerTimeline,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { clampInt, Deferred, isPidAlive, newWorkerId, sleep, withTimeout } from "./util/async.js";
import { inspectProcess } from "./util/process.js";
import type { Logger } from "./util/logger.js";
import { redactText, safeText, truncateText } from "./util/redact.js";
import { VERSION, TOOL_NAME } from "./version.js";
import { validateExtraArgs } from "./adapters/pi/launch.js";

const DEFAULT_LIMITS: SupervisorLimits = {
  maxWorkers: 8,
  maxWaitMs: 120_000,
  defaultWaitMs: 30_000,
  closeGraceMs: 1_500,
  abortTimeoutMs: 20_000,
  maxResultBytes: 64 * 1024,
  maxEventStringBytes: 8 * 1024,
};

const MAX_PROMPT_CHARS = 256 * 1024;
const MAX_MESSAGE_CHARS = 64 * 1024;
/**
 * Storage caps for progress text. Presentation is separately capped by the
 * context budget; these caps only decide what a single-event read can recover
 * after the fact. The runtime session file remains the source for anything
 * longer.
 */
const MAX_STORED_PROGRESS_DETAIL_CHARS = 8 * 1024;
const MAX_STORED_PROGRESS_PREVIEW_CHARS = 4 * 1024;
const MAX_STORED_PARTIAL_TEXT_CHARS = 4 * 1024;
/**
 * Progress kinds that mean "the harness no longer wants that answer".
 * They are the only progress kinds allowed to clear a pending input request.
 */
const INPUT_WITHDRAWAL_KINDS = new Set(["permission_withdrawn", "input_withdrawn"]);

/**
 * Whether a progress event means "clear this pending input request".
 *
 * Matching is strict: the kind must be a withdrawal and `detail` must carry the
 * *current* requestId. Nothing is inferred from timing, from the newest session or
 * from "the most recent request" — a wrong guess either hides a real blocking
 * request or leaves a dead one looking actionable. An answer already in flight
 * wins over a withdrawal, and a worker that is terminal or being cancelled keeps
 * its own transition.
 */
export function shouldClearPendingInput(input: {
  kind: string;
  detail?: string;
  pendingRequestId?: string;
  answeringRequestId?: string;
  cancelRequested: boolean;
  finalizing: boolean;
  terminal: boolean;
}): boolean {
  if (!INPUT_WITHDRAWAL_KINDS.has(input.kind)) return false;
  if (input.answeringRequestId !== undefined) return false;
  if (input.cancelRequested || input.finalizing || input.terminal) return false;
  if (!input.pendingRequestId) return false;
  const withdrawn = typeof input.detail === "string" ? input.detail.trim() : "";
  return withdrawn.length > 0 && withdrawn === input.pendingRequestId;
}

interface Runtime {
  record: WorkerRecord;
  adapter: HarnessAdapter;
  session?: HarnessSession;
  ready: Deferred<void>;
  terminal: Deferred<void>;
  eventChain: Promise<void>;
  cancelRequested: boolean;
  cancelReason?: string;
  cancelPromise?: Promise<void>;
  finalizing: boolean;
  settled?: Extract<HarnessEvent, { type: "settled" }>;
  exitInfo?: HarnessExit;
  runAccepted: boolean;
  maxDurationTimer?: NodeJS.Timeout;
  pendingUiTimer?: NodeJS.Timeout;
  /** Native IDs may be reused; callers only see the unique HS request ID. */
  pendingNativeInput?: { requestId: string; nativeRequestId: string };
  answeringRequestId?: string;
  lastAssistantText?: string;
  lastError?: string;
}

type SettledEvent = Extract<HarnessEvent, { type: "settled" }>;

export interface CancelOptions {
  timeoutMs?: number;
  reason?: string;
}

export interface WaitOptions {
  sinceSeq?: number;
  timeoutMs?: number;
  until?: "terminal" | "event";
  types?: WorkerEventType[];
}

export interface SupervisorOptions {
  store: Store;
  adapters: Map<string, HarnessAdapter>;
  logger: Logger;
  supervisorId: string;
  stateDir: string;
  startedAt?: string;
  limits?: Partial<SupervisorLimits>;
  /**
   * Per-worker environment additions (for example the command guard). It is
   * merged into the worker process only; the daemon's own environment and its
   * notification delivery are never changed.
   */
  workerEnv?: (workerId: string) => NodeJS.ProcessEnv;
  notify?: {
    channel?: "none" | "codex-queue";
    codexThreadId?: string;
    codexBin?: string;
    /** Short coalescing window before host delivery; 0 delivers immediately. */
    deliveryDelayMs?: number;
  };
}

export class Supervisor {
  readonly store: Store;
  readonly supervisorId: string;
  readonly stateDir: string;
  readonly startedAt: string;
  readonly limits: SupervisorLimits;
  readonly notifier: Notifier;
  readonly idempotency: IdempotencyStore;
  readonly retention: Retention;
  readonly metrics: MetricsStore;
  private readonly adapters: Map<string, HarnessAdapter>;
  private readonly logger: Logger;
  private readonly workerEnv?: (workerId: string) => NodeJS.ProcessEnv;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly resuming = new Set<string>();
  private pendingSpawns = 0;
  /** One destructive maintenance operation at a time; blocks new activations. */
  private maintenance: string | null = null;
  /** A managed update closes only new admission; accepted work and answers drain normally. */
  private drainIntent: string | null = null;
  private drainSealed = false;
  private pendingDurableMutations = 0;
  private pendingAdmissions = 0;
  private initialized = false;
  private shuttingDown = false;
  private metricsReady = false;
  private metricsError: string | undefined;
  private startupStorage: StorageDiagnostics["startup"] = {
    totalMs: 0,
    storeInitMs: 0,
    store: { checkpointed: 0, scanned: 0, eventBytes: 0 },
  };
  private readonly evidenceCache = new Map<
    string,
    {
      lastSeq: number;
      lastProgress: WorkerLastProgress;
      timeline: WorkerTimeline;
      inputState?: WorkerInputState;
    }
  >();

  constructor(options: SupervisorOptions) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.logger = options.logger;
    this.workerEnv = options.workerEnv;
    this.supervisorId = options.supervisorId;
    this.stateDir = options.stateDir;
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.idempotency = new IdempotencyStore(this.stateDir, this.logger);
    this.notifier = new Notifier({
      stateDir: this.stateDir,
      logger: this.logger,
      channel: options.notify?.channel ?? "none",
      codexThreadId: options.notify?.codexThreadId,
      codexBin: options.notify?.codexBin,
      deliveryDelayMs: options.notify?.deliveryDelayMs,
      // The gate asks the *current* worker record, not the notification payload:
      // a request that was answered, replaced or invalidated by a resume must
      // not wake anyone, and must not be reported as delivered either.
      staleReason: (record) => {
        const worker = this.store.getWorker(record.workerId);
        if (!worker) return staleNotificationReason(undefined, record);
        return staleNotificationReason(
          {
            status: worker.status,
            pendingInput: worker.pendingInput,
            startedAt: worker.startedAt,
            // `cancel()` flags the runtime before it rewrites the record, so this
            // is the only honest signal for the in-between window.
            cancelRequested: this.runtimes.get(record.workerId)?.cancelRequested === true,
            lastRunStartSeq: () => this.lastRunStartSeq(record.workerId),
          },
          record,
        );
      },
    });
    this.retention = new Retention({
      store: this.store,
      notifier: this.notifier,
      logger: this.logger,
      sessionsDir: this.store.sessionsDir,
    });
    this.metrics = new MetricsStore(this.stateDir, this.logger);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const initStartedAt = Date.now();
    const timings = {
      notifierInitMs: 0,
      idempotencyInitMs: 0,
      metricsInitMs: 0,
      storeInitMs: 0,
      reconcileMetricsMs: 0,
      reconcileNotificationsMs: 0,
    };
    let phaseStartedAt = Date.now();
    await this.notifier.init();
    timings.notifierInitMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await this.idempotency.init();
    timings.idempotencyInitMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    try {
      const warnings = await this.metrics.init();
      this.metricsReady = true;
      if (warnings.length > 0) {
        this.logger.warn("Task metrics loaded with warnings", {
          warnings: warnings.length,
        });
      }
    } catch (error) {
      this.metricsError = errorMessage(error);
      this.logger.error("Task metrics are unavailable; worker lifecycle continues without them", {
        error: this.metricsError,
      });
    }
    timings.metricsInitMs = Date.now() - phaseStartedAt;
    this.store.onAnyEvent((event) => {
      const record = this.store.getWorker(event.workerId);
      if (!record) return;
      try {
        this.notifier.ingest(record, event);
      } catch (error) {
        // A malformed persisted route must not break the event append path.
        this.logger.warn(`Failed to ingest notification for ${event.workerId}`, {
          error: errorMessage(error),
        });
      }
      this.ingestMetricsEvent(record, event);
    });
    phaseStartedAt = Date.now();
    const { workers, warnings, stats: storeStats } = await this.store.init();
    timings.storeInitMs = Date.now() - phaseStartedAt;
    const now = new Date().toISOString();
    for (const record of workers) {
      if (!record.notifyTarget) {
        // Legacy records have no reliable origin. Do not guess from the current
        // global default or the most recently used Codex session.
        record.notifyTarget = { channel: "none" };
        await this.store.saveWorker(record);
      } else {
        try {
          record.notifyTarget = validateNotifyTarget(record.notifyTarget);
        } catch (error) {
          this.logger.warn(
            `Worker ${record.id} has an invalid persisted notification target; using the inbox only`,
            { error: errorMessage(error) },
          );
          record.notifyTarget = { channel: "none" };
          await this.store.saveWorker(record);
        }
      }
      if (record.status === "orphaned") {
        // Orphaned is terminal, so the ordinary reconciliation below skips it.
        // Re-check the recorded process instead: keeping the label forever would
        // protect a dead record from retention, and would misdescribe a PID that
        // now belongs to another process.
        const identity = await inspectProcess(record.pid, [
          record.id,
          record.sessionId,
          record.sessionFile,
        ]);
        const pidAlive = identity.alive;
        const pidOurs = this.pidMayBelongToWorker(record, identity);
        if (!pidAlive || !pidOurs) {
          const now = new Date().toISOString();
          record.status = "interrupted";
          record.statusReason = pidAlive
            ? "The recorded PID is alive but its command line does not match this worker (PID reused); the original process is gone and the outcome is unknown"
            : "Supervisor restarted after the orphaned harness process was lost; outcome unknown";
          record.pendingInput = undefined;
          record.updatedAt = now;
          record.endedAt ??= now;
          this.store.appendEvent(record.id, "worker.interrupted", {
            pid: record.pid,
            pidAlive,
            pidVerified: identity.verified,
            previousStatus: "orphaned",
            note: "Orphan protection released only after the recorded process was confirmed gone or reused.",
          });
          await this.store.saveWorker(record);
          await this.store.flush(record.id).catch((error: unknown) => {
            this.logger.error(`Failed to persist orphan reconciliation for ${record.id}`, {
              error: errorMessage(error),
            });
          });
        }
        continue;
      }
      if (!isTerminal(record.status)) {
        const previousStatus = record.status;
        const identity = await inspectProcess(record.pid, [
          record.id,
          record.sessionId,
          record.sessionFile,
        ]);
        const pidAlive = identity.alive;
        // A live PID is only treated as ours when its command line carries a
        // worker/session token, or when the runtime (ACP) cannot expose one and
        // the conservative policy keeps the session locked.
        const pidOurs = this.pidMayBelongToWorker(record, identity);
        const orphaned = pidAlive && pidOurs;
        const status: WorkerStatus = orphaned ? "orphaned" : "interrupted";
        record.status = status;
        record.statusReason = orphaned
          ? "Supervisor restarted and no longer owns the live harness process"
          : pidAlive
            ? "The recorded PID is alive but its command line does not match this worker (PID reused); the original process is gone and the outcome is unknown"
            : "Supervisor restarted after the harness process was lost; outcome unknown";
        // No live runtime exists after reconciliation, so an old dialog is not
        // answerable. Keep the events for evidence; clear the actionable field.
        record.pendingInput = undefined;
        record.endedAt = now;
        record.updatedAt = now;
        this.store.appendEvent(
          record.id,
          orphaned ? "worker.orphaned" : "worker.interrupted",
          {
            pid: record.pid,
            pidAlive,
            pidVerified: identity.verified,
            previousStatus,
            note: "Not resumed automatically. Resume is an explicit operation using the persisted session file.",
          },
        );
        await this.store.saveWorker(record);
        await this.store.flush(record.id).catch((error: unknown) => {
          this.logger.error(`Failed to persist reconciliation for ${record.id}`, {
            error: errorMessage(error),
          });
        });
      }
    }
    this.initialized = true;
    phaseStartedAt = Date.now();
    await this.reconcileMetricsUsage();
    timings.reconcileMetricsMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    await this.reconcileNotifications();
    timings.reconcileNotificationsMs = Date.now() - phaseStartedAt;
    this.logger.info("Supervisor initialized", {
      workers: workers.length,
      warnings: warnings.length,
      store: storeStats,
      timings: { ...timings, totalMs: Date.now() - initStartedAt },
    });
    this.startupStorage = {
      totalMs: Date.now() - initStartedAt,
      storeInitMs: timings.storeInitMs,
      store: storeStats,
    };
  }

  /**
   * Rebuild inbox records for important events that were persisted before a
   * crash (event written, notification not yet written). Ids are derived from
   * (worker, seq), so this can never duplicate a notification. The per-worker
   * checkpoint skips history that was already ingested and flushed.
   */
  private async reconcileNotifications(): Promise<void> {
    let created = 0;
    const advanced = new Map<string, number>();
    // A missing inbox means the records covered by any checkpoint are gone;
    // rebuild from the event log instead of trusting the position.
    const resetCheckpoints = this.notifier.wasStoreMissing();
    for (const record of this.store.listWorkers()) {
      const workerDir = this.store.workerDir(record.id);
      // The persisted consumer checkpoint is the authoritative ingest position.
      // Do not jump to the newest surviving inbox id: that would skip an earlier
      // record lost from the inbox and never rebuild it.
      const checkpoint = resetCheckpoints
        ? 0
        : Math.min(await readConsumerCheckpoint(workerDir, "notifications"), record.lastSeq);
      let lastSeq = checkpoint;
      try {
        for await (const event of this.store.scanEvents(record.id, { sinceSeq: checkpoint })) {
          lastSeq = Math.max(lastSeq, event.seq);
          if (notificationKindFor(event.type) && !this.notifier.has(notificationId(record.id, event.seq))) {
            created += 1;
          }
          this.notifier.ingest({ ...record, notifyTarget: { channel: "none" } }, event);
        }
        if (lastSeq > checkpoint) advanced.set(record.id, lastSeq);
      } catch (error) {
        // A damaged history must not prevent the daemon controlling other workers.
        this.logger.warn(`Cannot fully rebuild notifications for ${record.id}`, { error: errorMessage(error) });
      }
    }
    if (created > 0) {
      this.logger.info("Reconciled notification inbox from persisted events", { created });
    }
    await this.notifier.flush();
    for (const [workerId, seq] of advanced) {
      await writeConsumerCheckpoint(this.store.workerDir(workerId), "notifications", seq).catch(
        (error: unknown) => {
          this.logger.warn(`Failed to persist notification checkpoint for ${workerId}`, {
            error: errorMessage(error),
          });
        },
      );
    }
    void this.notifier.retryPending(["pending"]).catch((error: unknown) => {
      this.logger.warn("Failed to retry pending notifications", {
        error: errorMessage(error),
      });
    });
  }

  private ingestMetricsEvent(record: WorkerRecord, event: WorkerEvent): void {
    if (!this.metricsReady || event.type !== "run.usage") return;
    try {
      this.metrics.ingestEvent(record, event);
    } catch (error) {
      this.logger.warn(`Failed to ingest metrics usage for ${record.id}`, {
        error: errorMessage(error),
      });
    }
  }

  private async reconcileMetricsUsage(): Promise<void> {
    if (!this.metricsReady) return;
    let created = 0;
    const advanced = new Map<string, number>();
    // A missing metrics file means the usage records covered by any checkpoint
    // are gone; rebuild from events instead of trusting the position.
    const resetCheckpoints = this.metrics.wasStoreMissing();
    for (const record of this.store.listWorkers()) {
      if (!record.taskId) continue;
      const workerDir = this.store.workerDir(record.id);
      const checkpoint = resetCheckpoints
        ? 0
        : Math.min(await readConsumerCheckpoint(workerDir, "metrics"), record.lastSeq);
      let lastSeq = checkpoint;
      try {
        for await (const event of this.store.scanEvents(record.id, { sinceSeq: checkpoint })) {
          lastSeq = Math.max(lastSeq, event.seq);
          if (event.type !== "run.usage") continue;
          const existed = this.metrics.hasUsage(`runtime:${record.id}:${event.seq}`);
          const usage = this.metrics.ingestEvent(record, event);
          if (usage && !existed) created += 1;
        }
        if (lastSeq > checkpoint) advanced.set(record.id, lastSeq);
      } catch (error) {
        this.logger.warn(`Cannot fully rebuild metrics usage for ${record.id}`, {
          error: errorMessage(error),
        });
      }
    }
    let flushed = true;
    await this.metrics.flush().catch((error: unknown) => {
      flushed = false;
      this.logger.warn("Failed to flush reconciled metrics usage", {
        error: errorMessage(error),
      });
    });
    if (flushed) {
      for (const [workerId, seq] of advanced) {
        await writeConsumerCheckpoint(this.store.workerDir(workerId), "metrics", seq).catch(
          (error: unknown) => {
            this.logger.warn(`Failed to persist metrics checkpoint for ${workerId}`, {
              error: errorMessage(error),
            });
          },
        );
      }
    }
    if (created > 0) {
      this.logger.info("Reconciled task usage from persisted events", { created });
    }
  }

  createMetricsTask(input: TaskCreateInput): Promise<TaskRecord> {
    this.assertInitialized();
    this.assertNewAdmission();
    return this.withDurableMutation(() => this.requireMetrics().createTask(input));
  }

  metricsTask(taskId: string): TaskMetrics {
    this.assertInitialized();
    return this.requireMetrics().taskMetrics(taskId, (workerId) => this.store.getWorker(workerId));
  }

  metricsReport(options: MetricsReportOptions = {}): MetricsReport {
    this.assertInitialized();
    return this.requireMetrics().report(
      (workerId) => this.store.getWorker(workerId),
      options,
    );
  }

  recordMetricsUsage(input: UsageRecordInput): Promise<UsageRecord> {
    this.assertInitialized();
    this.assertNewAdmission();
    return this.withDurableMutation(() => this.requireMetrics().recordUsage(input));
  }

  private requireMetrics(): MetricsStore {
    if (!this.metricsReady) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Task metrics are unavailable in this daemon${this.metricsError ? `: ${this.metricsError}` : ""}. Worker lifecycle is unaffected.`,
      );
    }
    return this.metrics;
  }

  notifications(filter: {
    ownerRef?: string;
    state?: "pending" | "delivered" | "failed" | "all";
    workerId?: string;
    limit?: number;
    unacknowledgedOnly?: boolean;
  } = {}): NotificationsResult {
    this.assertInitialized();
    if (filter.ownerRef !== undefined && filter.workerId) this.assertOwner(filter.workerId, filter.ownerRef);
    const workerIds = filter.ownerRef === undefined ? undefined : new Set(
      this.store.listWorkers().filter((worker) => worker.ownerRef === filter.ownerRef).map((worker) => worker.id),
    );
    const scoped = { ...filter, workerIds };
    const notifications = this.notifier.list(scoped);
    const state = filter.state ?? "pending";
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    return {
      notifications,
      // Legacy field: always the whole inbox. Kept so older callers never read
      // a worker-filtered number as if it were global.
      counts: this.notifier.counts({ state: "all", workerIds }),
      filteredCounts: this.notifier.counts({ ...scoped, state }),
      globalCounts: this.notifier.counts({ state: "all", workerIds }),
      scope: {
        ...(filter.ownerRef !== undefined ? { ownerRef: filter.ownerRef } : {}),
        state,
        ...(filter.workerId !== undefined ? { workerId: filter.workerId } : {}),
        unacknowledgedOnly: filter.unacknowledgedOnly === true,
        limit,
        returned: notifications.length,
      },
      target: filter.ownerRef === undefined ? this.notifier.getTarget() : { channel: "none" },
    };
  }

  getNotifyTarget(): NotifyTarget {
    this.assertInitialized();
    return this.notifier.getTarget();
  }

  async ackNotifications(ids: string[], by?: string, ownerRef?: string): Promise<{ acked: number; missing: string[] }> {
    this.assertInitialized();
    if (ownerRef !== undefined) {
      for (const id of ids) {
        const workerId = this.notifier.workerForNotification(id);
        if (workerId !== undefined) this.assertOwner(workerId, ownerRef);
      }
    }
    return this.withDurableMutation(() => this.notifier.ack(ids, by));
  }

  /** Correlation guard for cooperating clients; same-user processes can bypass it. */
  assertOwner(workerId: string, ownerRef: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker || worker.ownerRef !== ownerRef) {
      throw new SupervisorError("UNAUTHORIZED", "Worker is outside this Master session");
    }
  }

  async setNotifyTarget(input: {
    channel?: "none" | "codex-queue";
    codexThreadId?: string | null;
  }): Promise<NotifyTarget> {
    this.assertInitialized();
    this.assertNewAdmission();
    return this.withDurableMutation(() => this.notifier.setTarget(input));
  }

  async retryNotifications(states?: NotificationDeliveryState[]): Promise<number> {
    this.assertInitialized();
    this.assertNewAdmission();
    return this.withDurableMutation(() => this.notifier.retryPending(states));
  }

  /**
   * Opt-in maintenance: drop old terminal workers, compact metadata logs.
   * Never removes an active worker or a worker with an unacknowledged notification.
   */
  async prune(options: PruneOptions = {}): Promise<PruneResult & { compacted: unknown }> {
    this.assertInitialized();
    return this.withMaintenance("prune", async () => {
      const protectedWorkerIds = new Set<string>([
        ...this.runtimes.keys(),
        ...this.resuming.keys(),
      ]);
      const result = await this.retention.prune({ ...options, protectedWorkerIds });
      if (options.dryRun) return { ...result, compacted: null };
      const notifications = await this.notifier.compact({ olderThanDays: 30 });
      const idempotency = await this.idempotency.compact();
      // Records dropped by inbox compaction must not be recreated from an old
      // per-worker checkpoint on the next daemon start.
      for (const record of this.store.listWorkers()) {
        await writeConsumerCheckpoint(
          this.store.workerDir(record.id),
          "notifications",
          record.lastSeq,
        ).catch((error: unknown) => {
          this.logger.warn(`Failed to advance notification checkpoint for ${record.id}`, {
            error: errorMessage(error),
          });
        });
      }
      return { ...result, compacted: { notifications, idempotency } };
    });
  }

  info(): SupervisorInfo {
    return {
      name: TOOL_NAME,
      version: VERSION,
      capabilities: { ownerScope: true, webUi: true, managedRuntime: true, drain: true },
      pid: process.pid,
      stateDir: this.stateDir,
      supervisorId: this.supervisorId,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - Date.parse(this.startedAt),
      limits: this.limits,
      wake: {
        proactive: this.notifier.getTarget().channel !== "none",
        channel: this.notifier.getTarget().channel,
        codexThreadId: this.notifier.getTarget().codexThreadId,
        workerRouting: true,
        note:
          "MCP event queries are pull-based. channel/proactive describe the fallback default for NEW workers only when no caller thread can be identified; explicit spawn.notifyTarget overrides auto-binding, and an identified Codex caller thread takes precedence over this default. Each worker persists its destination, and each important event snapshots that route. Resume preserves it unless explicitly rebound. Legacy unbound records use the inbox only. codex-queue uses the official CLI; whether a new turn starts depends on the host having that thread loaded. Delivery is at-least-once and does not itself prove wake-up.",
      },
      codexSteer: {
        status: "unavailable",
        verified: { appServerRpc: true, modelApplied: true, desktopActiveTurn: false },
        reason:
          "Codex app-server turn/steer was verified against a real active turn, including rejection of a wrong expectedTurnId. HS cannot use it for Codex Desktop: Desktop owns its thread in a private stdio app-server, and the shared app-server refuses to resume a thread with an active writer (\"already has an active writer\"). codex-queue remains the supported delivery path.",
      },
      runtimes: [...this.adapters.values()].map((adapter) => adapter.capabilities),
      storage: this.storageDiagnostics(),
    };
  }

  private storageDiagnostics(): StorageDiagnostics {
    const stats = this.store.storageStats();
    let activeWorkers = 0;
    let idleWorkers = 0;
    let otherWorkers = 0;
    for (const record of this.store.listWorkers()) {
      if (ACTIVE_STATUSES.has(record.status)) {
        activeWorkers += 1;
        continue;
      }
      const pidAlive = record.pid !== undefined ? isPidAlive(record.pid) : null;
      if (isTerminal(record.status) && this.sessionProjection(record, pidAlive).restorable) {
        idleWorkers += 1;
      } else {
        otherWorkers += 1;
      }
    }
    return {
      ...stats,
      activeWorkers,
      idleWorkers,
      otherWorkers,
      startup: { ...this.startupStorage },
    };
  }

  async spawn(input: SpawnInput, options: { requestId?: string } = {}): Promise<WorkerSummary> {
    this.assertInitialized();
    this.assertNewAdmission();
    this.assertAcceptingWork();
    const requestId = validateIdempotencyKey(options.requestId);
    const source: NotificationBindingSource =
      input.notifyTarget !== undefined
        ? "explicit"
        : isThreadUuid(input.callerThreadId)
          ? "caller"
          : "daemon-default";
    const run = async (workerIdOut?: { value?: string }) =>
      this.attachNotificationBinding(await this.spawnOnce(input, workerIdOut), source);
    return this.withAdmittedWork(async () => requestId
      ? await this.withIdempotency("spawn", requestId, input, (workerIdOut) => run(workerIdOut))
      : await run());
  }

  private async spawnOnce(input: SpawnInput, workerIdOut?: { value?: string }): Promise<WorkerSummary> {
    this.assertAcceptingWork();
    this.reserveSpawnSlot();
    try {
      const summary = await this.spawnInternal(input);
      if (workerIdOut) workerIdOut.value = summary.id;
      return summary;
    } finally {
      this.pendingSpawns -= 1;
    }
  }

  /**
   * Run a side-effecting operation under an optional client request id.
   * The record is written before execution starts, so a daemon crash leaves an
   * explicit `in_progress` marker that is reported as UNCERTAIN instead of being
   * silently re-executed.
   */
  private async withIdempotency(
    method: "spawn" | "resume" | "continue" | "send",
    requestId: string,
    params: unknown,
    run: (workerIdOut: { value?: string }) => Promise<WorkerSummary>,
  ): Promise<WorkerSummary> {
    const hash = hashParams({ method, params });
    const begin = this.idempotency.begin(method, requestId, hash);
    if (begin.kind === "conflict") {
      throw new SupervisorError(
        "CONFLICT",
        `requestId ${requestId} was already used for ${method} with different parameters`,
        { requestId, method, firstSeenAt: begin.record.createdAt },
      );
    }
    if (begin.kind === "running") {
      throw new SupervisorError(
        "INVALID_STATE",
        `requestId ${requestId} is still being processed for ${method}; nothing was executed again`,
        { requestId, method },
      );
    }
    if (begin.kind === "uncertain") {
      throw new SupervisorError(
        "UNCERTAIN",
        `The daemon restarted while requestId ${requestId} (${method}) was being processed. The operation may or may not have executed; inspect workers before retrying with a new requestId.`,
        { requestId, method, workerId: begin.record.workerId },
      );
    }
    if (begin.kind === "replay") {
      const record = begin.record;
      const workerId = record.workerId;
      if (record.state === "failed" && record.error) {
        // The original attempt threw; replaying must not look like a success.
        throw new SupervisorError(
          record.error.code as SupervisorError["code"],
          `Replayed result for requestId ${requestId}: ${record.error.message}`,
          { requestId, method, replayed: true, workerId },
        );
      }
      const current = workerId ? this.store.getWorker(workerId) : undefined;
      if (current) {
        const summary = this.summary(current);
        // Idempotency replays the first acceptance result, not a recomputed
        // binding: the worker may have been explicitly rebound by resume since.
        const stored = record.result as WorkerSummary | undefined;
        if (stored?.notificationBinding) {
          summary.notificationBinding = stored.notificationBinding;
        }
        return summary;
      }
      return record.result as WorkerSummary;
    }

    const workerIdOut: { value?: string } = {};
    // Fail closed before creating a process or sending a message if the request
    // marker could not be written. Keep this outside the operation's catch path.
    await this.idempotency.flush();
    try {
      const summary = await run(workerIdOut);
      await this.idempotency.complete(method, requestId, summary, summary.id);
      return summary;
    } catch (error) {
      const workerId =
        workerIdOut.value ??
        (error instanceof SupervisorError && typeof error.details?.workerId === "string"
          ? (error.details.workerId as string)
          : undefined);
      if (isPreSideEffectError(error) && !workerId) {
        // Nothing was created, so the request id stays reusable.
        await this.idempotency.release(method, requestId);
      } else {
        await this.idempotency.fail(method, requestId, error, workerId);
      }
      throw error;
    }
  }

  private async spawnInternal(input: SpawnInput): Promise<WorkerSummary> {
    if (input.ownerRef !== undefined && (typeof input.ownerRef !== "string" || input.ownerRef.length < 1 || input.ownerRef.length > 300 || /[\x00-\x1f\x7f]/.test(input.ownerRef))) {
      throw new SupervisorError("BAD_REQUEST", "ownerRef must be a nonempty reference of at most 300 characters without control characters");
    }
    const runtimeName = input.runtime ?? "pi";
    const adapter = this.adapters.get(runtimeName);
    if (!adapter) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Unknown runtime: ${runtimeName}. The daemon may predate this runtime.`,
        {
          available: [...this.adapters.keys()],
        },
      );
    }
    if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
      throw new SupervisorError("BAD_REQUEST", "prompt must be a non-empty string");
    }
    if (input.prompt.length > MAX_PROMPT_CHARS) {
      throw new SupervisorError("BAD_REQUEST", `prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    const persistence: WorkerPersistence = input.persistence ?? "oneshot";
    if (persistence !== "oneshot" && persistence !== "persistent") {
      throw new SupervisorError("BAD_REQUEST", `Unknown persistence mode: ${String(persistence)}`);
    }
    const cwd = path.resolve(input.cwd || process.cwd());
    let cwdStat;
    try {
      cwdStat = await stat(cwd);
    } catch {
      throw new SupervisorError("BAD_REQUEST", `cwd does not exist: ${cwd}`);
    }
    if (!cwdStat.isDirectory()) {
      throw new SupervisorError("BAD_REQUEST", `cwd is not a directory: ${cwd}`);
    }
    const config = validateConfig(input);
    const now = new Date().toISOString();
    const id = newWorkerId();
    this.assertAcceptingWork();
    const taskBinding = await this.resolveTaskForSpawn(input, id, runtimeName);
    const record: WorkerRecord = {
      schemaVersion: SCHEMA_VERSION,
      id,
      runtime: runtimeName,
      ownerRef: input.ownerRef,
      name: optionalString(input.name, 200, "name"),
      cwd,
      promptPreview: safeText(input.prompt, 500),
      status: "starting",
      persistence,
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      eventCount: 0,
      stats: { turns: 0, toolCalls: 0, toolErrors: 0 },
      capabilities: { ...adapter.capabilities },
      config,
      resumeCount: 0,
      supervisorId: this.supervisorId,
      notifyTarget: validateNotifyTarget(
        input.notifyTarget ??
          (isThreadUuid(input.callerThreadId)
            ? { channel: "codex-queue", codexThreadId: input.callerThreadId }
            : this.notifier.getTarget()),
      ),
      ...(taskBinding.taskId ? { taskId: taskBinding.taskId } : {}),
    };
    await this.store.createWorker(record);
    if (taskBinding.linkAfterCreate && taskBinding.taskId) {
      await this.metrics.linkWorker(taskBinding.taskId, id).catch((error: unknown) => {
        this.logger.warn(`Failed to link worker ${id} to task ${taskBinding.taskId}`, {
          error: errorMessage(error),
        });
      });
    }
    const runtime = this.createRuntime(record, adapter);
    this.runtimes.set(id, runtime);
    this.store.appendEvent(id, "worker.starting", {
      runtime: runtimeName,
      cwd,
      resumed: false,
    });

    const initialPrompt = withWorkerProtocol(input.prompt);
    try {
      await this.store.flush(id);
      this.assertAcceptingWork();
      await this.initializeSession(runtime, { initialPrompt });
      this.assertAcceptingWork();
      if (runtime.cancelRequested) {
        await this.ensureCancelled(runtime);
        return this.summary(record);
      }
      const disposition = await this.requireSession(runtime).prompt(initialPrompt);
      if (disposition.disposition !== "handled" && (runtime.cancelRequested || isTerminal(record.status))) {
        await this.store.savePrompt(record, input.prompt).catch((error: unknown) => {
          this.logger.warn("Failed to save task prompt for WebUI", { workerId: id, error: errorMessage(error) });
        });
      }
      if (runtime.cancelRequested) {
        await this.ensureCancelled(runtime);
        return this.summary(record);
      }
      if (isTerminal(record.status)) return this.summary(record);
      if (disposition.disposition === "handled") {
        throw new SupervisorError(
          "UNSUPPORTED",
          "The prompt was handled by an extension without starting an agent run. Use a normal task prompt for workers.",
        );
      }
      runtime.runAccepted = true;
      record.startedAt = new Date().toISOString();
      record.firstStartedAt ??= record.startedAt;
      record.status = record.pendingInput ? "awaiting_input" : "running";
      record.statusReason = record.pendingInput ? "harness requested input" : undefined;
      this.store.appendEvent(id, "run.accepted", {
        disposition: disposition.disposition,
      });
      this.ensureDurationTimer(runtime);
      await this.store.savePrompt(record, input.prompt).catch((error: unknown) => {
        this.logger.warn("Failed to save task prompt for WebUI", { workerId: id, error: errorMessage(error) });
      });
      await this.store.saveWorker(record);
      await this.store.flush(id);
      return this.summary(record);
    } catch (error) {
      if (isTerminal(record.status)) {
        if (runtime.cancelRequested) return this.summary(record);
        throw new SupervisorError(
          classifyErrorCode(error),
          safeText(errorMessage(error), 2000),
          { workerId: id, status: record.status },
        );
      }
      await this.failStartup(runtime, error);
      throw new SupervisorError(classifyErrorCode(error), safeText(errorMessage(error), 2000), {
        workerId: id,
        status: record.status,
      });
    }
  }

  private async resolveTaskForSpawn(
    input: SpawnInput,
    workerId: string,
    runtime: string,
  ): Promise<{ taskId?: string; linkAfterCreate: boolean }> {
    if (!this.metricsReady) {
      if (input.taskId) {
        this.logger.warn(
          `Task metrics are unavailable; worker ${workerId} was not linked to ${input.taskId}`,
        );
      }
      return { linkAfterCreate: false };
    }
    if (input.taskId) {
      const task = this.metrics.getTask(input.taskId);
      if (!task) {
        throw new SupervisorError("NOT_FOUND", `Unknown taskId: ${input.taskId}`, {
          taskId: input.taskId,
        });
      }
      if (task.executionMode !== "delegated") {
        throw new SupervisorError(
          "UNSUPPORTED",
          `Task ${task.id} is not a delegated task; only delegated tasks can link workers`,
          { taskId: task.id },
        );
      }
      return { taskId: task.id, linkAfterCreate: true };
    }
    try {
      const task = await this.metrics.createTask({
        title:
          typeof input.name === "string" && input.name.trim().length > 0
            ? safeText(input.name.trim(), 200)
            : `delegated ${runtime} task`,
        createdBy: "spawn",
        workerId,
      });
      return { taskId: task.id, linkAfterCreate: false };
    } catch (error) {
      this.logger.warn(
        `Failed to create a metrics task for worker ${workerId}; continuing without task statistics`,
        { error: errorMessage(error) },
      );
      return { linkAfterCreate: false };
    }
  }

  async resume(
    workerId: string,
    input: ResumeInput,
    options: { requestId?: string } = {},
  ): Promise<WorkerSummary> {
    this.assertInitialized();
    this.assertNewAdmission();
    this.assertAcceptingWork();
    const requestId = validateIdempotencyKey(options.requestId);
    const source: NotificationBindingSource =
      input.notifyTarget !== undefined ? "explicit" : "preserved";
    const run = async (workerIdOut?: { value?: string }) =>
      this.attachNotificationBinding(
        await this.resumeOnce(workerId, input, workerIdOut),
        source,
      );
    return this.withAdmittedWork(async () => requestId
      ? await this.withIdempotency("resume", requestId, { workerId, input }, (workerIdOut) =>
          run(workerIdOut),
        )
      : await run());
  }

  private async resumeOnce(
    workerId: string,
    input: ResumeInput,
    workerIdOut?: { value?: string },
  ): Promise<WorkerSummary> {
    this.assertAcceptingWork();
    const record = this.requireWorker(workerId);
    if (this.resuming.has(workerId)) {
      throw new SupervisorError("INVALID_STATE", "Resume is already in progress for this worker", {
        workerId,
        status: record.status,
      });
    }
    this.resuming.add(workerId);
    if (workerIdOut) workerIdOut.value = workerId;
    let slotReserved = false;
    try {
      // Resume is a new activation; it consumes the same concurrency budget.
      this.reserveSpawnSlot();
      slotReserved = true;
      return await this.resumeInternal(workerId, input, record, {
        releaseSlot: () => {
          if (!slotReserved) return;
          slotReserved = false;
          this.pendingSpawns -= 1;
        },
      });
    } finally {
      if (slotReserved) this.pendingSpawns -= 1;
      this.resuming.delete(workerId);
    }
  }

  /**
   * Submit the next Turn to an idle persistent Worker on its existing native
   * session. This reuses the cold-restore path; it is not a new Worker and it
   * never invents a replacement session when the recorded one is unusable.
   */
  async continue(
    workerId: string,
    input: ResumeInput,
    options: { requestId?: string } = {},
  ): Promise<WorkerSummary> {
    this.assertInitialized();
    this.assertNewAdmission();
    this.assertAcceptingWork();
    const requestId = validateIdempotencyKey(options.requestId);
    const source: NotificationBindingSource =
      input.notifyTarget !== undefined ? "explicit" : "preserved";
    const run = async (workerIdOut?: { value?: string }) =>
      this.attachNotificationBinding(
        await this.continueOnce(workerId, input, workerIdOut),
        source,
      );
    return this.withAdmittedWork(async () => requestId
      ? await this.withIdempotency("continue", requestId, { workerId, input }, (workerIdOut) =>
          run(workerIdOut),
        )
      : await run());
  }

  private async continueOnce(
    workerId: string,
    input: ResumeInput,
    workerIdOut?: { value?: string },
  ): Promise<WorkerSummary> {
    this.assertAcceptingWork();
    const record = this.requireWorker(workerId);
    const persistence = record.persistence ?? "oneshot";
    if (persistence !== "persistent") {
      throw new SupervisorError(
        "UNSUPPORTED",
        "This worker is not persistent. Spawn it with persistence=\"persistent\" to continue it across Turns.",
        { workerId, persistence },
      );
    }
    if (record.retiredAt) {
      throw new SupervisorError("INVALID_STATE", "This worker is retired; unretire it before continuing", {
        workerId,
        retiredAt: record.retiredAt,
      });
    }
    if (record.status === "orphaned") {
      throw new SupervisorError(
        "INVALID_STATE",
        "This worker is orphaned: its previous process may still hold the session. Reconcile it before continuing.",
        { workerId, status: record.status },
      );
    }
    if (ACTIVE_STATUSES.has(record.status)) {
      throw new SupervisorError(
        "INVALID_STATE",
        "Worker is currently active; wait for the current Turn to settle before continuing.",
        { workerId, status: record.status },
      );
    }
    if (this.resuming.has(workerId)) {
      throw new SupervisorError("INVALID_STATE", "A continue or resume is already in progress for this worker", {
        workerId,
        status: record.status,
      });
    }
    this.resuming.add(workerId);
    if (workerIdOut) workerIdOut.value = workerId;
    let slotReserved = false;
    try {
      // A continuation starts a real harness process and must obey maxWorkers.
      this.reserveSpawnSlot();
      slotReserved = true;
      // `isPidAlive` alone would treat a reused PID as a live activation and make
      // this permanent; recover the same command-line proof that resume uses.
      let pidMayBeRunning = record.pid !== undefined ? isPidAlive(record.pid) : null;
      if (pidMayBeRunning && record.pid !== undefined) {
        const identity = await inspectProcess(record.pid, [
          record.id,
          record.sessionId,
          record.sessionFile,
        ]);
        if (identity.alive && !this.pidMayBelongToWorker(record, identity)) {
          pidMayBeRunning = false;
        }
      }
      const session = this.sessionProjection(record, pidMayBeRunning);
      if (!session.restorable) {
        throw new SupervisorError(
          "UNSUPPORTED",
          `The native session for this worker cannot be restored (${session.reason ?? "unknown"}). Refusing to fake continuity.`,
          { workerId, reason: session.reason, session },
        );
      }
      return await this.resumeInternal(workerId, input, record, {
        continuation: true,
        releaseSlot: () => {
          if (!slotReserved) return;
          slotReserved = false;
          this.pendingSpawns -= 1;
        },
      });
    } finally {
      if (slotReserved) this.pendingSpawns -= 1;
      this.resuming.delete(workerId);
    }
  }

  private async resumeInternal(
    workerId: string,
    input: ResumeInput,
    record: WorkerRecord,
    options: { continuation?: boolean; releaseSlot?: () => void } = {},
  ): Promise<WorkerSummary> {
    let activeRuntime = this.runtimes.get(workerId);
    if (activeRuntime?.finalizing) {
      await this.waitForRuntimeTerminal(activeRuntime, 10_000);
      activeRuntime = this.runtimes.get(workerId);
    }
    if (ACTIVE_STATUSES.has(record.status) || activeRuntime) {
      throw new SupervisorError(
        "INVALID_STATE",
        activeRuntime?.finalizing
          ? "Worker is still shutting down; retry resume shortly"
          : "Worker is currently active",
        { status: record.status },
      );
    }
    if (!isTerminal(record.status)) {
      throw new SupervisorError("INVALID_STATE", "Only a terminal or detached worker can be resumed", {
        status: record.status,
      });
    }
    if (record.retiredAt) {
      throw new SupervisorError("INVALID_STATE", "This worker is retired; unretire it before resuming", {
        workerId,
        retiredAt: record.retiredAt,
      });
    }
    if (!input || typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
      throw new SupervisorError("BAD_REQUEST", "prompt must be a non-empty string");
    }
    if (input.prompt.length > MAX_PROMPT_CHARS) {
      throw new SupervisorError("BAD_REQUEST", `prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    const adapter = this.adapters.get(record.runtime);
    if (!adapter) {
      throw new SupervisorError("UNSUPPORTED", `Runtime is no longer available: ${record.runtime}`);
    }
    if (!adapter.capabilities.resume) {
      throw new SupervisorError("UNSUPPORTED", `Runtime ${record.runtime} does not support resume`);
    }
    if (!record.sessionFile) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "This worker has no persisted session file. It cannot be resumed without starting a new conversation.",
      );
    }
    if (!existsSync(record.sessionFile)) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "The persisted session file no longer exists; refusing to fake a resume.",
        { sessionFile: record.sessionFile },
      );
    }
    if (isPidAlive(record.pid)) {
      const identity = await inspectProcess(record.pid, [
        record.id,
        record.sessionId,
        record.sessionFile,
      ]);
      // A reused PID must not block resuming our own persisted session, but an
      // ACP child whose argv has no worker token must keep it locked.
      if (identity.alive && this.pidMayBelongToWorker(record, identity)) {
        throw new SupervisorError(
          "INVALID_STATE",
          "The previous harness process still appears to be alive. Refusing concurrent resume of the same session.",
          { pid: record.pid, pidVerified: identity.verified },
        );
      }
    }
    let expectedSessionId: string | undefined = record.sessionId;
    if (!expectedSessionId) {
      const headerId = await readSessionHeaderId(record.sessionFile);
      if (!headerId) {
        throw new SupervisorError(
          "UNSUPPORTED",
          "Cannot verify the persisted session identity (missing session id). Refusing to report a fake resume.",
          { sessionFile: record.sessionFile },
        );
      }
      expectedSessionId = headerId;
    }
    const previous = {
      status: record.status,
      statusReason: record.statusReason,
      result: record.result,
      error: record.error,
      endedAt: record.endedAt,
      exit: record.exit,
      startedAt: record.startedAt,
      pid: record.pid,
    };
    const config = validateConfig(input, record.config);
    if (input.notifyTarget !== undefined) {
      record.notifyTarget = validateNotifyTarget(input.notifyTarget);
      // Persist takeover before emitting any events or starting a new process.
      await this.store.saveWorker(record);
      await this.store.flush(workerId);
    }
    record.status = "starting";
    record.statusReason = "resuming persisted session";
    record.pendingInput = undefined;
    record.config = config;
    record.startedAt = undefined;
    record.endedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.exit = undefined;
    record.pid = undefined;
    record.updatedAt = new Date().toISOString();
    // The record now counts as active, so the admission reservation can go.
    options.releaseSlot?.();
    this.store.appendEvent(workerId, "worker.starting", {
      runtime: record.runtime,
      resumed: !options.continuation,
      ...(options.continuation ? { continued: true } : {}),
      sessionFile: record.sessionFile,
    });
    const runtime = this.createRuntime(record, adapter);
    this.runtimes.set(workerId, runtime);

    const initialPrompt = withWorkerProtocol(input.prompt);
    try {
      await this.store.saveWorker(record);
      this.assertAcceptingWork();
      await this.initializeSession(runtime, {
        sessionFile: record.sessionFile,
        expectedSessionId,
        resume: true,
        initialPrompt,
      });
      this.assertAcceptingWork();
      if (runtime.cancelRequested) {
        await this.ensureCancelled(runtime);
        return this.summary(record);
      }
      const disposition = await this.requireSession(runtime).prompt(initialPrompt);
      if (disposition.disposition !== "handled" && (runtime.cancelRequested || isTerminal(record.status))) {
        record.promptPreview = safeText(input.prompt, 500);
        await this.store.savePrompt(record, input.prompt).catch((error: unknown) => {
          this.logger.warn("Failed to save task prompt for WebUI", { workerId, error: errorMessage(error) });
        });
        await this.store.saveWorker(record);
      }
      if (runtime.cancelRequested) {
        await this.ensureCancelled(runtime);
        return this.summary(record);
      }
      if (isTerminal(record.status)) return this.summary(record);
      if (disposition.disposition === "handled") {
        throw new SupervisorError(
          "UNSUPPORTED",
          "The prompt was handled by an extension without starting an agent run.",
        );
      }
      runtime.runAccepted = true;
      record.startedAt = new Date().toISOString();
      record.firstStartedAt ??= record.startedAt;
      record.promptPreview = safeText(input.prompt, 500);
      await this.store.savePrompt(record, input.prompt).catch((error: unknown) => {
        this.logger.warn("Failed to save task prompt for WebUI", { workerId, error: errorMessage(error) });
      });
      record.status = record.pendingInput ? "awaiting_input" : "running";
      record.statusReason = record.pendingInput ? "harness requested input" : undefined;
      this.store.appendEvent(workerId, "run.accepted", {
        disposition: disposition.disposition,
        resumed: !options.continuation,
        ...(options.continuation ? { continued: true } : {}),
      });
      record.resumeCount += 1;
      this.store.appendEvent(
        workerId,
        options.continuation ? "worker.continued" : "worker.resumed",
        {
          sessionId: record.sessionId,
          sessionFile: record.sessionFile,
          resumeCount: record.resumeCount,
        },
      );
      this.ensureDurationTimer(runtime);
      await this.store.saveWorker(record);
      await this.store.flush(workerId);
      return this.summary(record);
    } catch (error) {
      if (isTerminal(record.status)) {
        if (runtime.cancelRequested) return this.summary(record);
        throw new SupervisorError(classifyErrorCode(error), safeText(errorMessage(error), 2000), {
          workerId,
          status: record.status,
        });
      }
      if (!runtime.runAccepted) {
        await this.abortResumeAttempt(runtime, previous, error);
      } else {
        await this.failStartup(runtime, error);
      }
      throw new SupervisorError(classifyErrorCode(error), safeText(errorMessage(error), 2000), {
        workerId,
        status: record.status,
      });
    }
  }

  list(filter?: {
    ownerRef?: string;
    statuses?: WorkerStatus[];
    limit?: number;
    includeArchived?: boolean;
    after?: { createdAt: string; id: string };
  }): WorkerSummary[] {
    this.assertInitialized();
    const statuses = filter?.statuses ? new Set(filter.statuses) : null;
    const limit = clampInt(filter?.limit ?? 100, 1, 500);
    const after = filter?.after;
    return this.store
      .listWorkers()
      .filter((record) => filter?.ownerRef === undefined || record.ownerRef === filter.ownerRef)
      .filter((record) => !statuses || statuses.has(record.status))
      .filter((record) => filter?.includeArchived === true || !record.archived)
      // Keyset order is (createdAt DESC, id ASC). Comparing the pair rather
      // than a row position keeps the page stable when the cursor record is
      // deleted, archived, or when newer workers arrive between pages.
      .filter((record) => {
        if (!after) return true;
        const byCreatedAt = record.createdAt.localeCompare(after.createdAt);
        if (byCreatedAt !== 0) return byCreatedAt < 0;
        return record.id.localeCompare(after.id) > 0;
      })
      .sort((a, b) => {
        const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
        return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
      })
      .slice(0, limit)
      .map((record) => this.summary(record));
  }

  async admin(workerId: string, action: WorkerAdminAction): Promise<WorkerSummary> {
    this.assertInitialized();
    this.assertNewAdmission();
    this.assertAcceptingWork();
    const record = this.requireWorker(workerId);
    const apply = async (): Promise<void> => {
      if (action === "archive" || action === "retire") {
        if (ACTIVE_STATUSES.has(record.status)) {
          throw new SupervisorError(
            "INVALID_STATE",
            `An active worker cannot be ${action === "archive" ? "archived" : "retired"}`,
            { workerId, status: record.status },
          );
        }
        await this.awaitRuntimeQuiet(workerId);
        if (this.runtimes.has(workerId)) {
          throw new SupervisorError("INVALID_STATE", "Worker is still shutting down; retry shortly", {
            workerId,
            status: record.status,
          });
        }
      }
      const previous = {
        pinned: record.pinned,
        archived: record.archived,
        retiredAt: record.retiredAt,
        updatedAt: record.updatedAt,
      };
      try {
        switch (action) {
          case "pin":
            record.pinned = true;
            break;
          case "unpin":
            delete record.pinned;
            break;
          case "archive":
            record.archived = true;
            break;
          case "unarchive":
            delete record.archived;
            break;
          case "retire":
            record.retiredAt = new Date().toISOString();
            break;
          case "unretire":
            delete record.retiredAt;
            break;
          default:
            throw new SupervisorError("BAD_REQUEST", `Unknown admin action: ${String(action)}`);
        }
        record.updatedAt = new Date().toISOString();
        this.store.appendEvent(workerId, "worker.admin", {
          action,
          pinned: record.pinned === true,
          archived: record.archived === true,
          retiredAt: record.retiredAt,
        });
        await this.store.saveWorker(record);
        await this.store.flush(workerId);
      } catch (error) {
        if (previous.pinned === undefined) delete record.pinned;
        else record.pinned = previous.pinned;
        if (previous.archived === undefined) delete record.archived;
        else record.archived = previous.archived;
        if (previous.retiredAt === undefined) delete record.retiredAt;
        else record.retiredAt = previous.retiredAt;
        record.updatedAt = previous.updatedAt;
        throw error;
      }
    };
    // The two state changes that promise "no new Turn" must not interleave with
    // a continue that already passed its initial status check.
    if (action === "archive" || action === "retire") {
      await this.withWorkerMutation(workerId, action, apply);
    } else {
      await this.withDurableMutation(apply);
    }
    return this.summary(record);
  }

  /**
   * Remove the HS record and its state directory. Native session files are
   * deliberately preserved: forgetting HS bookkeeping is not a harness delete.
   */
  async forget(workerId: string): Promise<ForgetWorkerResult> {
    this.assertInitialized();
    this.assertNewAdmission();
    this.assertAcceptingWork();
    this.requireWorker(workerId);
    return this.withWorkerMutation(workerId, "forget", async () => {
      const record = this.requireWorker(workerId);
      if (record.pinned) {
        throw new SupervisorError("INVALID_STATE", "Unpin the worker before forgetting it", { workerId });
      }
      if (ACTIVE_STATUSES.has(record.status)) {
        throw new SupervisorError("INVALID_STATE", "An active worker cannot be forgotten", {
          workerId,
          status: record.status,
        });
      }
      if (record.status === "orphaned") {
        throw new SupervisorError(
          "INVALID_STATE",
          "An orphaned worker may still hold its session; reconcile it before forgetting",
          { workerId, status: record.status },
        );
      }
      await this.awaitRuntimeQuiet(workerId);
      if (this.runtimes.has(workerId)) {
        throw new SupervisorError("INVALID_STATE", "Worker is still shutting down; retry shortly", {
          workerId,
          status: record.status,
        });
      }
      if (this.notifier.unackedWorkerIds().has(workerId)) {
        throw new SupervisorError(
          "INVALID_STATE",
          "Acknowledge outstanding notifications before forgetting this worker",
          { workerId },
        );
      }
      await rm(this.store.workerDir(workerId), { recursive: true, force: true });
      this.store.forgetWorker(workerId);
      await this.store.flush().catch(() => undefined);
      return {
        workerId,
        forgotten: true,
        sessionPreserved: true,
        note: "HS record and events were removed; the native session file was left in place.",
      };
    });
  }

  /**
   * Compact finished workers' event logs: lifecycle events are kept, only the
   * newest progress events survive. Orphaned, pinned, active or still-running
   * workers are never touched, and native session files are preserved.
   */
  async compact(
    options: { workerId?: string; keepProgress?: number; dryRun?: boolean } = {},
  ): Promise<CompactResult> {
    this.assertInitialized();
    this.assertNewAdmission();
    this.assertAcceptingWork();
    const dryRun = options.dryRun === true;
    const keepProgress = clampInt(options.keepProgress ?? 200, 0, 100_000);
    const workers: CompactWorkerResult[] = [];
    const compactOne = async (record: WorkerRecord): Promise<CompactWorkerResult> =>
      this.withWorkerMutation(record.id, "compact", async () => {
        if (!isTerminal(record.status)) {
          throw new SupervisorError("INVALID_STATE", "Only terminal workers can be compacted", {
            workerId: record.id,
            status: record.status,
          });
        }
        if (record.status === "orphaned") {
          throw new SupervisorError(
            "INVALID_STATE",
            "An orphaned worker may still be running; reconcile it before compacting",
            { workerId: record.id, status: record.status },
          );
        }
        if (record.pinned) {
          throw new SupervisorError("INVALID_STATE", "Unpin the worker before compacting it", {
            workerId: record.id,
          });
        }
        await this.awaitRuntimeQuiet(record.id);
        if (this.runtimes.has(record.id)) {
          throw new SupervisorError("INVALID_STATE", "Worker is still shutting down; retry shortly", {
            workerId: record.id,
            status: record.status,
          });
        }
        return this.store.compactWorker(record.id, { keepProgress, dryRun });
      });

    if (options.workerId) {
      const record = this.requireWorker(options.workerId);
      const result = await compactOne(record);
      workers.push(result);
      if (!dryRun && !result.skipped) this.evidenceCache.delete(record.id);
    } else {
      for (const record of this.store.listWorkers()) {
        if (!isTerminal(record.status)) continue;
        if (record.status === "orphaned" || record.pinned || this.runtimes.has(record.id)) continue;
        if (this.resuming.has(record.id)) {
          workers.push({
            workerId: record.id,
            dryRun,
            removedEvents: 0,
            keptEvents: record.eventCount,
            removedBytes: 0,
            keptBytes: 0,
            skipped: "continue or resume in progress",
          });
          continue;
        }
        try {
          const result = await compactOne(record);
          workers.push(result);
          if (!dryRun && !result.skipped) this.evidenceCache.delete(record.id);
        } catch (error) {
          workers.push({
            workerId: record.id,
            dryRun,
            removedEvents: 0,
            keptEvents: record.eventCount,
            removedBytes: 0,
            keptBytes: 0,
            skipped: errorMessage(error),
          });
        }
      }
    }
    const removedEvents = workers.reduce((total, item) => total + item.removedEvents, 0);
    const removedBytes = workers.reduce((total, item) => total + item.removedBytes, 0);
    if (!dryRun && removedEvents > 0) {
      await this.store.flush().catch(() => undefined);
      this.logger.info("Compacted worker event logs", {
        workers: workers.filter((item) => !item.skipped).length,
        removedEvents,
        removedBytes,
      });
    }
    return { dryRun, workers, removedEvents, removedBytes };
  }

  async status(workerId: string, recentEventLimit = 20): Promise<WorkerStatusResult> {
    this.assertInitialized();
    const record = this.requireWorker(workerId);
    const evidence = await this.progressEvidence(record);
    const inputState = refreshInputStateTime(evidence.inputState);
    return {
      worker: this.summary(record),
      recentEvents: this.store.getRecentEvents(workerId, clampInt(recentEventLimit, 0, 100)),
      stderrTail: this.store.stderrTail(workerId),
      lastProgress: evidence.lastProgress,
      timeline: evidence.timeline,
      ...(inputState ? { inputState } : {}),
    };
  }

  /**
   * The status view must explain what the worker got to before it stopped.
   * Recent events answer that for almost every worker; a terminal worker whose
   * useful text sits beyond the in-memory window is scanned from events.jsonl.
   * Results are memoized by lastSeq so repeated status reads do not rescan.
   */
  private async progressEvidence(
    record: WorkerRecord,
  ): Promise<{
    lastProgress: WorkerLastProgress;
    timeline: WorkerTimeline;
    inputState?: WorkerInputState;
  }> {
    const cached = this.evidenceCache.get(record.id);
    if (cached && cached.lastSeq === record.lastSeq) return cached;

    const recent = this.store.getRecentEvents(record.id, 500);
    let events = recent;
    const needsOlder = record.eventCount > recent.length;
    const wantOlderProgress = isTerminal(record.status) && !findLastProgressEvent(recent);
    const wantOlderSegments = needsOlder && isTerminal(record.status) && record.resumeCount > 0;
    const wantOlderInput = needsOlder && isTerminal(record.status) && !record.pendingInput;
    if (needsOlder && (wantOlderProgress || wantOlderSegments || wantOlderInput)) {
      const all: WorkerEvent[] = [];
      for await (const event of this.store.scanEvents(record.id)) all.push(event);
      events = all;
    }
    const lastProgress = buildLastProgress(findLastProgressEvent(events), {
      maxChars: 1000,
      scannedThroughSeq: record.lastSeq,
    });
    const timeline = buildTimeline(record, events, { maxSegments: 20 });
    const inputState = buildInputState(record, events);
    const value = { lastSeq: record.lastSeq, lastProgress, timeline, inputState };
    if (this.evidenceCache.size > 200) this.evidenceCache.clear();
    this.evidenceCache.set(record.id, value);
    return value;
  }

  async events(workerId: string, options?: { sinceSeq?: number; limit?: number }): Promise<ReadEventsResult> {
    this.assertInitialized();
    const record = this.requireWorker(workerId);
    const sinceSeq = Math.max(0, Math.trunc(options?.sinceSeq ?? 0));
    const limit = clampInt(options?.limit ?? 100, 1, 500);
    const result = await this.store.readEvents(workerId, sinceSeq, limit);
    return {
      worker: this.summary(record),
      events: result.events,
      nextSeq: result.nextSeq,
      hasMore: result.hasMore,
    };
  }

  async wait(workerId: string, options: WaitOptions = {}): Promise<WaitResult> {
    this.assertInitialized();
    const record = this.requireWorker(workerId);
    const timeoutMs = clampInt(
      options.timeoutMs ?? this.limits.defaultWaitMs,
      0,
      this.limits.maxWaitMs,
    );
    const until = options.until ?? "terminal";
    const sinceSeq = Math.max(0, Math.trunc(options.sinceSeq ?? record.lastSeq));
    const typeFilter = options.types?.length ? new Set(options.types) : null;

    return new Promise<WaitResult>((resolve, reject) => {
      let finished = false;
      let evaluating = false;
      let dirty = false;
      let timer: NodeJS.Timeout | undefined;
      let unsubscribe: (() => void) | undefined;
      // Matching can scan past a response page without advancing the caller's
      // delivery cursor. Keep this cursor so each progress event is scanned once.
      let scannedThroughSeq = sinceSeq;

      const fail = (error: unknown) => {
        finished = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        reject(error);
      };
      const finish = async (timedOut: boolean) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        const data = await this.store.readEvents(workerId, sinceSeq, 500);
        const current = this.requireWorker(workerId);
        const evidence = await this.progressEvidence(current);
        const inputState = refreshInputStateTime(evidence.inputState);
        resolve({
          worker: this.summary(current),
          events: data.events,
          nextSeq: data.nextSeq,
          hasMore: data.hasMore,
          timedOut,
          terminal: isTerminal(current.status),
          lastProgress: evidence.lastProgress,
          timeline: evidence.timeline,
          ...(inputState ? { inputState } : {}),
        });
      };

      const evaluate = async (): Promise<void> => {
        if (finished) return;
        dirty = true;
        if (evaluating) return;
        evaluating = true;
        try {
          while (dirty && !finished) {
            dirty = false;
            const current = this.requireWorker(workerId);
            let hasMatchingEvent = false;
            if (until === "event" && !isTerminal(current.status) && current.status !== "awaiting_input") {
              const scanThroughSeq = current.lastSeq;
              while (scannedThroughSeq < scanThroughSeq && !finished) {
                const data = await this.store.readEvents(workerId, scannedThroughSeq, 500);
                if (finished) return;
                hasMatchingEvent = typeFilter
                  ? data.events.some((event) => typeFilter.has(event.type))
                  : data.events.length > 0;
                const previousSeq = scannedThroughSeq;
                scannedThroughSeq = Math.max(scannedThroughSeq, data.nextSeq);
                if (hasMatchingEvent || !data.hasMore || scannedThroughSeq <= previousSeq) break;
              }
            }
            // A run that needs input cannot finish without a consumer response.
            if (isTerminal(current.status) || current.status === "awaiting_input" ||
                (until === "event" && hasMatchingEvent)) {
              await finish(false);
              return;
            }
          }
        } finally {
          evaluating = false;
        }
        if (timeoutMs === 0 && !finished) await finish(true);
      };

      unsubscribe = this.store.subscribe(workerId, () => {
        if (!finished) void evaluate().catch(fail);
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => { void finish(true).catch(fail); }, timeoutMs);
        timer.unref?.();
      }
      void evaluate().catch(fail);
    });
  }

  async send(
    workerId: string,
    message: string,
    mode: SendMode = "steer",
    options: { requestId?: string } = {},
  ): Promise<WorkerSummary> {
    this.assertInitialized();
    this.assertNewAdmission();
    const requestId = validateIdempotencyKey(options.requestId);
    return this.withAdmittedWork(async () => !requestId
      ? this.sendOnce(workerId, message, mode)
      : this.withIdempotency("send", requestId, { workerId, message, mode }, () =>
          this.sendOnce(workerId, message, mode),
        ));
  }

  private async sendOnce(
    workerId: string,
    message: string,
    mode: SendMode = "steer",
  ): Promise<WorkerSummary> {
    this.assertInitialized();
    const record = this.requireWorker(workerId);
    const runtime = this.runtimes.get(workerId);
    if (!runtime || !runtime.session || isTerminal(record.status)) {
      throw new SupervisorError("INVALID_STATE", "Worker is not running", {
        status: record.status,
      });
    }
    if (record.status !== "running" && record.status !== "awaiting_input") {
      throw new SupervisorError("INVALID_STATE", "Worker is not running", {
        status: record.status,
      });
    }
    this.assertAcceptingWork();
    if (runtime.cancelRequested || runtime.finalizing) {
      throw new SupervisorError("INVALID_STATE", "Worker is being cancelled", {
        status: record.status,
      });
    }
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new SupervisorError("BAD_REQUEST", "message must be a non-empty string");
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      throw new SupervisorError("BAD_REQUEST", `message exceeds ${MAX_MESSAGE_CHARS} characters`);
    }
    if (mode !== "steer" && mode !== "follow-up") {
      throw new SupervisorError("BAD_REQUEST", "mode must be steer or follow-up");
    }
    try {
      if (mode === "steer") await runtime.session.steer(message);
      else await runtime.session.followUp(message);
    } catch (error) {
      // An adapter can report that the runtime build does not support the
      // requested mode. That is a capability fact, not a harness malfunction,
      // so it must not be flattened into HARNESS_ERROR.
      const code = classifyErrorCode(error);
      throw new SupervisorError(code === "UNSUPPORTED" ? "UNSUPPORTED" : "HARNESS_ERROR", safeText(errorMessage(error), 2000), {
        workerId,
        mode,
      });
    }
    if (runtime.cancelRequested || runtime.finalizing || isTerminal(record.status)) {
      throw new SupervisorError(
        "INVALID_STATE",
        "Worker finished or cancellation started while the message was being delivered; the queued message will not be executed",
        { status: record.status, mode },
      );
    }
    this.store.appendEvent(workerId, "run.message_sent", {
      mode,
      preview: safeText(message, 500),
    });
    await this.store.saveWorker(record);
    await this.store.flush(workerId);
    return this.summary(record);
  }

  async answer(
    workerId: string,
    requestId: string,
    response: ExtensionUiResponse,
  ): Promise<WorkerSummary> {
    this.assertInitialized();
    // Shape errors are independent of worker state and must be reported as
    // BAD_REQUEST even when the request has already expired.
    validateUiResponseShape(response);
    const record = this.requireWorker(workerId);
    const runtime = this.runtimes.get(workerId);
    const pending = record.pendingInput;
    if (!runtime || !runtime.session || !pending) {
      throw this.answerFailure(record, requestId);
    }
    if (pending.requestId !== requestId) {
      throw new SupervisorError("INVALID_STATE", "requestId does not match the pending request", {
        reason: "request_mismatch",
        pendingRequestId: pending.requestId,
        status: record.status,
        nextActions: ["worker_status", "worker_answer"],
      });
    }
    this.assertAcceptingWork();
    if (runtime.cancelRequested || runtime.finalizing) {
      throw new SupervisorError("INVALID_STATE", "Worker is being cancelled", {
        reason: "worker_cancelling",
        status: record.status,
      });
    }
    if (pending.expiresAt && Date.now() >= Date.parse(pending.expiresAt)) {
      throw new SupervisorError(
        "INVALID_STATE",
        "The input request deadline has passed; the harness is no longer waiting for this answer",
        {
          reason: "input_expired",
          requestId,
          expiresAt: pending.expiresAt,
          status: record.status,
          nextActions: ["worker_status", "worker_resume"],
        },
      );
    }
    if (runtime.answeringRequestId) {
      throw new SupervisorError("INVALID_STATE", "Another answer is already being delivered", {
        reason: "answer_in_flight",
        requestId: runtime.answeringRequestId,
        nextActions: ["worker_status"],
      });
    }
    validateUiResponse(pending, response);
    const nativeInput = runtime.pendingNativeInput;
    if (!nativeInput || nativeInput.requestId !== pending.requestId) {
      throw new SupervisorError("INVALID_STATE", "The input request is no longer attached to this harness", {
        reason: "request_mismatch",
        nextActions: ["worker_status"],
      });
    }
    runtime.answeringRequestId = requestId;
    try {
      await runtime.session.answer(nativeInput.nativeRequestId, response);
    } catch (error) {
      throw new SupervisorError("HARNESS_ERROR", safeText(errorMessage(error), 2000), {
        workerId,
      });
    } finally {
      runtime.answeringRequestId = undefined;
    }
    if (runtime.cancelRequested || runtime.finalizing || isTerminal(record.status)) {
      throw new SupervisorError(
        "INVALID_STATE",
        "Worker finished or cancellation started while the answer was being delivered",
        { status: record.status },
      );
    }
    // A new needs_input can replace the pending request while the answer is in
    // flight. Only clear the request we actually answered.
    if (record.pendingInput === pending) {
      if (runtime.pendingUiTimer) {
        clearTimeout(runtime.pendingUiTimer);
        runtime.pendingUiTimer = undefined;
      }
      record.pendingInput = undefined;
      runtime.pendingNativeInput = undefined;
      if (!isTerminal(record.status)) {
        record.status = "running";
        record.statusReason = undefined;
      }
    }
    this.store.appendEvent(workerId, "run.input_answered", {
      requestId,
      method: pending.method,
      cancelled: "cancelled" in response && response.cancelled === true,
      outcome:
        "cancelled" in response
          ? "cancelled"
          : "confirmed" in response
            ? "confirmed"
            : "value",
    });
    await this.store.saveWorker(record);
    await this.store.flush(workerId);
    return this.summary(record);
  }

  private answerFailure(record: WorkerRecord, requestId: string): SupervisorError {
    const input = buildInputState(record, this.store.getRecentEvents(record.id, 500));
    const common = {
      requestId,
      status: record.status,
      ...(input?.state ? { inputState: input.state } : {}),
      ...(input?.nextActions ? { nextActions: input.nextActions } : {}),
    };
    if (input?.requestId === requestId) {
      if (input.state === "answered") {
        return new SupervisorError(
          "INVALID_STATE",
          "This input request was already answered; do not deliver the answer twice",
          {
            ...common,
            reason: "already_answered",
            ...(input.answeredAt ? { answeredAt: input.answeredAt } : {}),
            ...(input.outcome ? { outcome: input.outcome } : {}),
          },
        );
      }
      if (input.state === "expired") {
        return new SupervisorError(
          "INVALID_STATE",
          "This input request expired before an answer was delivered; it cannot be answered now",
          {
            ...common,
            reason: "input_expired",
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          },
        );
      }
      if (input.state === "withdrawn") {
        return new SupervisorError(
          "INVALID_STATE",
          "The harness withdrew this input request; there is nothing to answer",
          { ...common, reason: "input_withdrawn" },
        );
      }
    }
    if (isTerminal(record.status)) {
      return new SupervisorError(
        "INVALID_STATE",
        "The worker is no longer running, so its input request cannot be answered; resume the same session with a new instruction instead",
        {
          ...common,
          inputState: input?.state === "answered" || input?.state === "expired" || input?.state === "withdrawn"
            ? input.state
            : "closed",
          reason: "worker_finished",
          nextActions: record.status === "orphaned" ? ["worker_status"] : ["worker_resume"],
        },
      );
    }
    if (!this.runtimes.get(record.id)) {
      return new SupervisorError(
        "INVALID_STATE",
        "This worker has no live harness process in this daemon; its old request cannot be answered",
        {
          ...common,
          inputState: "closed",
          reason: "worker_not_live",
          nextActions: ["worker_resume"],
        },
      );
    }
    const current = record.pendingInput;
    if (current) {
      return new SupervisorError(
        "INVALID_STATE",
        "requestId does not match the current pending request",
        {
          ...common,
          reason: "request_mismatch",
          pendingRequestId: current.requestId,
          nextActions: ["worker_status", "worker_answer"],
        },
      );
    }
    return new SupervisorError(
      "INVALID_STATE",
      "Worker has no pending input request. Check worker_status for the next actionable state",
      { ...common, reason: "no_pending_input", nextActions: ["worker_status"] },
    );
  }

  async cancel(workerId: string, options: CancelOptions = {}): Promise<WorkerSummary> {
    this.assertInitialized();
    const record = this.requireWorker(workerId);
    if (this.resuming.has(workerId) && !this.runtimes.has(workerId)) {
      throw new SupervisorError(
        "INVALID_STATE",
        "Resume is in progress for this worker; retry cancel after the worker starts",
        { status: record.status },
      );
    }
    const existingRuntime = this.runtimes.get(workerId);
    if (isTerminal(record.status)) {
      if (record.status === "orphaned" && isPidAlive(record.pid)) {
        const identity = await inspectProcess(record.pid, [
          record.id,
          record.sessionId,
          record.sessionFile,
        ]);
        if (identity.alive && this.pidMayBelongToWorker(record, identity)) {
          throw new SupervisorError(
            "UNSUPPORTED",
            "The supervisor no longer owns this live process after a restart. It cannot be cancelled through the supervisor; verify and terminate the recorded PID out-of-band.",
            { pid: record.pid, workerId, pidVerified: identity.verified },
          );
        }
        if (identity.alive) {
          // The PID now belongs to an unrelated process: report that honestly
          // instead of pretending the worker was terminated.
          record.statusReason =
            "The recorded PID belongs to a different process (PID reused); there is no live harness process to cancel.";
          this.store.appendEvent(workerId, "run.progress", {
            kind: "pid_identity_mismatch",
            pid: record.pid,
            note: "Recorded PID is alive but not this worker; nothing was terminated.",
          });
          await this.store.saveWorker(record);
        }
      }
      if (existingRuntime) {
        await this.waitForRuntimeTerminal(
          existingRuntime,
          options.timeoutMs ?? this.limits.closeGraceMs + 5000,
        );
      }
      return this.summary(record);
    }
    const runtime = existingRuntime;
    if (!runtime) {
      record.status = "cancelled";
      record.statusReason = options.reason ?? "cancelled_without_active_runtime";
      record.endedAt = new Date().toISOString();
      this.store.appendEvent(workerId, "run.cancelled", {
        reason: record.statusReason,
        note: "No active control channel existed for this worker",
      });
      await this.store.saveWorker(record);
      await this.store.flush(workerId).catch(() => undefined);
        return this.summary(record);
    }
    if (!runtime.cancelRequested) {
      if (runtime.finalizing || runtime.settled) {
        await this.waitForRuntimeTerminal(runtime, options.timeoutMs ?? this.limits.closeGraceMs + 5000);
        return this.summary(record);
      }
      runtime.cancelRequested = true;
      runtime.cancelReason = options.reason ?? "user_cancel";
      this.store.appendEvent(workerId, "worker.cancel_requested", {
        reason: runtime.cancelReason,
      });
      await this.store.saveWorker(record);
    }
    if (!runtime.cancelPromise) {
      runtime.cancelPromise = this.performCancel(
        runtime,
        options.timeoutMs ?? this.limits.abortTimeoutMs + this.limits.closeGraceMs,
      );
    }
    await runtime.cancelPromise.catch((error: unknown) => {
      this.logger.error(`Cancel cleanup failed for ${workerId}`, { error: errorMessage(error) });
    });
    return this.summary(record);
  }

  beginDrain(intentId: string): void {
    this.assertInitialized();
    if (this.drainIntent && this.drainIntent !== intentId) {
      throw new SupervisorError("CONFLICT", "Another managed update is already draining", {
        intentId: this.drainIntent,
      });
    }
    this.drainIntent = intentId;
  }

  cancelDrain(intentId: string): void {
    if (this.drainIntent !== intentId) {
      throw new SupervisorError("CONFLICT", "The drain intent does not match");
    }
    this.drainIntent = null;
    this.drainSealed = false;
  }

  /** Freeze the last durable human actions after quiescence, before backup. */
  sealDrain(intentId: string): void {
    if (this.drainIntent !== intentId || !this.drainStatus().ready) {
      throw new SupervisorError("INVALID_STATE", "Cannot seal a managed update before quiescence");
    }
    this.drainSealed = true;
  }

  drainStatus(): {
    intentId: string | null;
    ready: boolean;
    workerIds: string[];
    pendingSpawns: number;
    resuming: string[];
    runtimeIds: string[];
    maintenance: string | null;
    pendingDurableMutations: number;
    pendingAdmissions: number;
  } {
    // Orphaned workers are terminal for observation, but a detached native
    // process is not proof that it is safe to hand off a shared daemon.
    const workerIds = this.store.listWorkers()
      .filter((record) => !isTerminal(record.status) || record.status === "orphaned")
      .map((record) => record.id);
    const runtimeIds = [...this.runtimes.keys()];
    return {
      intentId: this.drainIntent,
      ready: workerIds.length === 0 && runtimeIds.length === 0 &&
        this.pendingSpawns === 0 && this.resuming.size === 0 && this.maintenance === null && this.pendingDurableMutations === 0 && this.pendingAdmissions === 0,
      workerIds,
      pendingSpawns: this.pendingSpawns,
      resuming: [...this.resuming],
      runtimeIds,
      maintenance: this.maintenance,
      pendingDurableMutations: this.pendingDurableMutations,
      pendingAdmissions: this.pendingAdmissions,
    };
  }

  async flushForHandoff(): Promise<void> {
    if (!this.drainIntent || !this.drainStatus().ready) {
      throw new SupervisorError("INVALID_STATE", "Managed update has not finished draining");
    }
    await this.store.flush();
    await this.notifier.flush();
    await this.metrics.flush();
    await this.idempotency.flush();
    if (!this.drainStatus().ready) {
      throw new SupervisorError("INVALID_STATE", "Supervisor changed while preparing handoff");
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const drainDeadline = Date.now() + 5000;
    while (
      (this.pendingSpawns > 0 || this.resuming.size > 0 || this.maintenance !== null || this.pendingDurableMutations > 0 || this.pendingAdmissions > 0) &&
      Date.now() < drainDeadline
    ) {
      await sleep(25);
    }
    const active = this.store.listWorkers().filter((record) => !isTerminal(record.status));
    await Promise.allSettled(
      active.map((record) =>
        this.cancel(record.id, {
          timeoutMs: Math.min(this.limits.abortTimeoutMs, 8000),
          reason: "supervisor_shutdown",
        }),
      ),
    );
    const remaining = [...this.runtimes.values()];
    for (const runtime of remaining) {
      try {
        await runtime.session?.forceKill();
      } catch {
        // Best effort.
      }
      await this.waitForRuntimeTerminal(runtime, 3000);
    }
    for (const runtime of [...this.runtimes.values()]) {
      if (!isTerminal(runtime.record.status)) {
        runtime.cancelRequested = true;
        runtime.cancelReason = "supervisor_shutdown";
        await this.forceTerminalCancelled(runtime);
      }
    }
    this.notifier.stop();
    await this.notifier.flush().catch(() => undefined);
    await this.metrics.flush().catch((error: unknown) => {
      this.logger.warn("Failed to flush task metrics during shutdown", {
        error: errorMessage(error),
      });
    });
    await this.store.flush().catch((error: unknown) => {
      this.logger.error("Failed to flush persistence during shutdown", {
        error: errorMessage(error),
      });
    });
  }

  private async performCancel(runtime: Runtime, timeoutMs: number): Promise<void> {
    const record = runtime.record;
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    await runtime.ready.promise.catch(() => undefined);
    if (isTerminal(record.status) || runtime.finalizing) return;
    if (runtime.settled) {
      await this.waitForRuntimeTerminal(runtime, 3000);
      return;
    }
    const session = runtime.session;
    if (session?.isAlive()) {
      const clearBudget = Math.max(250, Math.min(2000, deadline - Date.now()));
      try {
        const cleared = await withTimeout(
          session.clearQueue(),
          clearBudget,
          "clear_queue timed out",
        );
        const steering = cleared.steering.length;
        const followUp = cleared.followUp.length;
        if (steering + followUp > 0) {
          this.store.appendEvent(record.id, "run.progress", {
            kind: "queue_cleared",
            steering,
            followUp,
          });
        }
      } catch (error) {
        this.logger.warn(
          `Failed to clear queued messages for ${record.id}; aborting anyway`,
          { error: errorMessage(error) },
        );
      }
      if (isTerminal(record.status) || runtime.finalizing) return;
      const remaining = Math.max(500, Math.min(this.limits.abortTimeoutMs, deadline - Date.now()));
      try {
        await withTimeout(session.abort(), remaining, "abort timed out");
      } catch (error) {
        this.logger.warn(`Abort failed for ${record.id}; forcing termination`, {
          error: errorMessage(error),
        });
      }
    }
    if (await this.waitForRuntimeTerminal(runtime, 3000)) return;
    if (session?.isAlive()) {
      try {
        await session.forceKill();
      } catch (error) {
        this.logger.warn(`Force kill failed for ${record.id}`, { error: errorMessage(error) });
      }
    }
    if (await this.waitForRuntimeTerminal(runtime, 3000)) return;
    await this.forceTerminalCancelled(runtime);
  }

  private async ensureCancelled(runtime: Runtime): Promise<void> {
    if (isTerminal(runtime.record.status)) return;
    if (!runtime.cancelPromise) {
      runtime.cancelPromise = this.performCancel(
        runtime,
        this.limits.abortTimeoutMs + this.limits.closeGraceMs,
      );
    }
    await runtime.cancelPromise.catch((error: unknown) => {
      this.logger.error(`Cancellation failed for ${runtime.record.id}`, {
        error: errorMessage(error),
      });
    });
  }

  private async forceTerminalCancelled(runtime: Runtime): Promise<void> {
    if (isTerminal(runtime.record.status) || runtime.finalizing) return;
    runtime.finalizing = true;
    this.clearRuntimeTimers(runtime);
    if (runtime.session?.isAlive()) {
      try {
        await runtime.session.forceKill();
      } catch {
        // Best effort; status and exit details still get recorded.
      }
    }
    const record = runtime.record;
    const exit = runtime.exitInfo ?? null;
    record.status = "cancelled";
    record.statusReason = runtime.cancelReason ?? "cancelled_after_forced_termination";
    record.endedAt = new Date().toISOString();
    record.pendingInput = undefined;
    if (exit) record.exit = { ...exit, at: record.endedAt };
    this.store.appendEvent(record.id, "run.cancelled", {
      reason: record.statusReason,
      forced: true,
      stage: runtime.runAccepted ? "run" : "startup",
      processExit: exit,
    });
    if (exit) {
      this.store.appendEvent(record.id, "worker.exited", {
        code: exit.code,
        signal: exit.signal,
        forced: true,
      });
    }
    await this.store.saveWorker(record).catch((error: unknown) => {
      this.logger.error(`Failed to persist cancelled worker ${record.id}`, {
        error: errorMessage(error),
      });
    });
    await this.store.flush(record.id).catch(() => undefined);
    this.runtimes.delete(record.id);
    runtime.terminal.resolve();
  }

  private async refreshSessionState(runtime: Runtime): Promise<void> {
    const session = runtime.session;
    const record = runtime.record;
    if (!session) return;
    try {
      const state = await withTimeout(session.getState(), 1500, "session state refresh timed out");
      if (state.runtimeInfo && JSON.stringify(state.runtimeInfo) !== JSON.stringify(record.runtimeInfo)) {
        record.runtimeInfo = state.runtimeInfo;
        await this.store.saveWorker(record);
      }
      if (state.sessionId) record.sessionId = state.sessionId;
      if (
        state.sessionFile &&
        existsSync(state.sessionFile) &&
        (!record.sessionFile ||
          normalizePath(state.sessionFile) !== normalizePath(record.sessionFile))
      ) {
        record.sessionFile = state.sessionFile;
        this.store.appendEvent(record.id, "worker.session", {
          sessionId: record.sessionId,
          sessionFile: state.sessionFile,
          fileExists: true,
          refreshed: true,
        });
        this.syncSessionRef(record, runtime.adapter);
        await this.store.saveWorker(record);
      }
    } catch (error) {
      this.logger.debug(`Session state refresh failed for ${record.id}`, {
        error: errorMessage(error),
      });
    }
  }

  private async finalizeSettled(runtime: Runtime): Promise<void> {
    if (runtime.finalizing || isTerminal(runtime.record.status)) return;
    runtime.finalizing = true;
    this.clearRuntimeTimers(runtime);
    const record = runtime.record;
    const settled = runtime.settled as SettledEvent;
    const cancelled = runtime.cancelRequested || settled.aborted;
    const failed = !cancelled && Boolean(settled.error);
    const outcome: WorkerStatus = cancelled ? "cancelled" : failed ? "failed" : "completed";
    const errorText = cancelled
      ? runtime.cancelReason ?? "harness_aborted"
      : failed
        ? settled.error ?? "run failed"
        : undefined;
    const finalText = settled.finalText ?? runtime.lastAssistantText ?? "";

    let forced = false;
    if (runtime.session) {
      try {
        const closeResult = await runtime.session.close({ graceMs: this.limits.closeGraceMs });
        forced = closeResult.forced;
      } catch (error) {
        this.logger.warn(`Failed to close harness for ${record.id}; forcing kill`, {
          error: errorMessage(error),
        });
        try {
          await runtime.session.forceKill();
          forced = true;
        } catch {
          // Best effort; the process may already be gone.
        }
      }
    }
    // Terminal status becomes visible only after the harness has been stopped.
    const exit = runtime.exitInfo ?? null;
    record.status = outcome;
    record.statusReason = errorText;
    record.endedAt = new Date().toISOString();
    record.pendingInput = undefined;
    if (exit) record.exit = { ...exit, at: record.endedAt };
    if (outcome === "completed") {
      const clipped = truncateText(redactText(finalText), this.limits.maxResultBytes);
      record.result = { text: clipped.text, truncated: clipped.truncated };
      record.error = undefined;
    } else {
      record.result = undefined;
      record.error = safeText(errorText ?? "worker did not complete", 4000);
    }
    const eventData: Record<string, unknown> = {
      sessionFile: record.sessionFile,
      aborted: settled.aborted,
      stopReason: settled.stopReason,
      forcedCleanup: forced,
    };
    if (outcome === "completed") {
      const clipped = storedText(finalText, this.limits.maxEventStringBytes);
      eventData.text = clipped.text;
      eventData.truncated = clipped.truncated;
      if (clipped.originalChars !== undefined) eventData.originalChars = clipped.originalChars;
    } else {
      eventData.reason = errorText;
      eventData.error = record.error;
      const partial = storedText(finalText, MAX_STORED_PARTIAL_TEXT_CHARS);
      eventData.partialText = partial.text;
      if (partial.truncated) {
        eventData.partialTextTruncated = true;
        if (partial.originalChars !== undefined) {
          eventData.partialTextChars = partial.originalChars;
        }
      }
    }
    this.store.appendEvent(
      record.id,
      outcome === "completed"
        ? "run.completed"
        : outcome === "failed"
          ? "run.failed"
          : "run.cancelled",
      eventData,
    );
    if (exit || forced) {
      this.store.appendEvent(record.id, "worker.exited", {
        code: exit?.code ?? null,
        signal: exit?.signal ?? null,
        forced,
      });
    }
    await this.store.saveWorker(record).catch((error: unknown) => {
      this.logger.error(`Failed to persist terminal state for ${record.id}`, {
        error: errorMessage(error),
      });
    });
    await this.store.flush(record.id).catch((error: unknown) => {
      this.logger.error(`Failed to flush terminal state for ${record.id}`, {
        error: errorMessage(error),
      });
    });
    this.runtimes.delete(record.id);
    runtime.terminal.resolve();
    this.logger.info(`Worker ${record.id} finished`, { status: outcome });
  }

  private async failStartup(runtime: Runtime, error: unknown): Promise<void> {
    if (runtime.finalizing || isTerminal(runtime.record.status)) return;
    runtime.finalizing = true;
    this.clearRuntimeTimers(runtime);
    const record = runtime.record;
    let forced = false;
    if (runtime.session) {
      try {
        const closeResult = await runtime.session.close({ graceMs: 500 });
        forced = closeResult.forced;
      } catch {
        try {
          await runtime.session.forceKill();
          forced = true;
        } catch {
          // Best effort.
        }
      }
    }
    const exit = runtime.exitInfo ?? null;
    record.status = "failed";
    record.statusReason = "startup_failed";
    record.error = safeText(errorMessage(error), 4000);
    record.endedAt = new Date().toISOString();
    record.pendingInput = undefined;
    if (exit) record.exit = { ...exit, at: record.endedAt };
    this.store.appendEvent(record.id, "run.failed", {
      stage: "startup",
      error: record.error,
      forcedCleanup: forced,
    });
    if (exit) {
      this.store.appendEvent(record.id, "worker.exited", {
        code: exit.code,
        signal: exit.signal,
        forced,
      });
    }
    await this.store.saveWorker(record).catch((saveError: unknown) => {
      this.logger.error(`Failed to persist failed startup for ${record.id}`, {
        error: errorMessage(saveError),
      });
    });
    await this.store.flush(record.id).catch(() => undefined);
    this.runtimes.delete(record.id);
    runtime.terminal.resolve();
  }

  private async abortResumeAttempt(
    runtime: Runtime,
    previous: Partial<WorkerRecord>,
    error: unknown,
  ): Promise<void> {
    if (runtime.finalizing) return;
    runtime.finalizing = true;
    this.clearRuntimeTimers(runtime);
    const record = runtime.record;
    if (runtime.session) {
      try {
        await runtime.session.close({ graceMs: 500 });
      } catch {
        try {
          await runtime.session.forceKill();
        } catch {
          // Best effort.
        }
      }
    }
    record.status = previous.status ?? "interrupted";
    record.statusReason = previous.statusReason;
    record.result = previous.result;
    record.error = previous.error;
    record.endedAt = previous.endedAt;
    record.exit = previous.exit;
    record.startedAt = previous.startedAt;
    record.pid = previous.pid;
    record.pendingInput = undefined;
    this.store.appendEvent(record.id, "worker.resume_failed", {
      error: safeText(errorMessage(error), 2000),
      restoredStatus: record.status,
      sessionFile: record.sessionFile,
    });
    await this.store.saveWorker(record).catch((saveError: unknown) => {
      this.logger.error(`Failed to persist resume failure for ${record.id}`, {
        error: errorMessage(saveError),
      });
    });
    await this.store.flush(record.id).catch(() => undefined);
    this.runtimes.delete(record.id);
    runtime.terminal.resolve();
  }

  private async handleHarnessEvent(runtime: Runtime, event: HarnessEvent): Promise<void> {
    const record = runtime.record;
    if (isTerminal(record.status) || runtime.finalizing) {
      if (event.type === "settled") runtime.settled = event;
      return;
    }
    switch (event.type) {
      case "run_started": {
        if (!record.startedAt) record.startedAt = new Date().toISOString();
        record.firstStartedAt ??= record.startedAt;
        if (!isTerminal(record.status) && !record.pendingInput) {
          record.status = "running";
          record.statusReason = undefined;
        }
        this.ensureDurationTimer(runtime);
        this.store.appendEvent(record.id, "run.started", {
          pid: record.pid,
          resumed: record.resumeCount > 0,
        });
        await this.store.saveWorker(record);
        break;
      }
      case "progress": {
        const data: Record<string, unknown> = { kind: event.kind };
        if (event.tool !== undefined) data.tool = event.tool;
        if (event.detail !== undefined) {
          const detail = storedText(event.detail, MAX_STORED_PROGRESS_DETAIL_CHARS);
          data.detail = detail.text;
          if (detail.truncated) {
            data.detailTruncated = true;
            if (detail.originalChars !== undefined) data.detailChars = detail.originalChars;
          }
        }
        if (event.preview !== undefined) {
          const preview = storedText(event.preview, MAX_STORED_PROGRESS_PREVIEW_CHARS);
          data.preview = preview.text;
          if (preview.truncated) {
            data.previewTruncated = true;
            if (preview.originalChars !== undefined) data.previewChars = preview.originalChars;
          }
        }
        if (event.isError !== undefined) data.isError = event.isError;
        if (event.durationMs !== undefined) data.durationMs = event.durationMs;
        if (event.kind === "tool_start") record.stats.toolCalls += 1;
        if (event.kind === "tool_end" && event.isError) record.stats.toolErrors += 1;
        if (event.kind === "turn_complete") record.stats.turns += 1;
        if (event.kind === "assistant_message" && event.preview) {
          runtime.lastAssistantText = event.preview;
        }
        const nativeInput = runtime.pendingNativeInput;
        const withdrawalId = INPUT_WITHDRAWAL_KINDS.has(event.kind) && nativeInput &&
          nativeInput.nativeRequestId === event.detail?.trim()
          ? nativeInput.requestId
          : event.detail;
        if (INPUT_WITHDRAWAL_KINDS.has(event.kind) && withdrawalId !== undefined) {
          data.detail = safeText(withdrawalId, MAX_STORED_PROGRESS_DETAIL_CHARS);
        }
        // A withdrawal is a decision, not progress: the harness no longer needs
        // an answer, so the worker must stop reporting awaiting_input. Without
        // this the request would stay "current" for the notification gate and a
        // reminder would be delivered for something nobody can answer.
        if (
          INPUT_WITHDRAWAL_KINDS.has(event.kind) &&
          this.applyInputWithdrawal(runtime, event.kind, withdrawalId)
        ) {
          data.pendingInputCleared = true;
        }
        this.store.appendEvent(record.id, "run.progress", data);
        await this.store.saveWorker(record);
        break;
      }
      case "usage": {
        const data: Record<string, unknown> = {};
        for (const key of [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
          "reportedTotalTokens",
        ] as const) {
          const value = event.usage[key];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            data[key] = Math.trunc(value);
          }
        }
        if (event.usage.provider) data.provider = safeText(event.usage.provider, 200);
        if (event.usage.modelId) data.modelId = safeText(event.usage.modelId, 200);
        if (Object.keys(data).length > 0) {
          this.store.appendEvent(record.id, "run.usage", data);
        }
        break;
      }
      case "needs_input": {
        const requestId = `input-${randomUUID()}`;
        const pending: PendingInput = {
          requestId,
          method: event.method,
          title: event.title,
          message: event.message,
          options: event.options,
          placeholder: event.placeholder,
          prefill: event.prefill,
          createdAt: new Date().toISOString(),
          expiresAt:
            event.timeoutMs !== undefined
              ? new Date(Date.now() + event.timeoutMs).toISOString()
              : undefined,
        };
        runtime.pendingNativeInput = { requestId, nativeRequestId: event.requestId };
        record.pendingInput = pending;
        if (!isTerminal(record.status)) {
          record.status = "awaiting_input";
          record.statusReason = "harness requested input";
        }
        this.schedulePendingInputExpiry(runtime, pending, event.requestId);
        const needsInputEvent = this.store.appendEvent(record.id, "run.needs_input", {
          requestId: pending.requestId,
          method: pending.method,
          title: safeText(pending.title ?? "", 300),
          message: safeText(pending.message ?? "", 1000),
          options: pending.options,
          expiresAt: pending.expiresAt,
        });
        // Provenance, not just the (reusable) requestId: the delivery gate can
        // then tell "the request this notification is about" apart from a later
        // request that happens to reuse the same id after a resume.
        pending.seq = needsInputEvent.seq;
        await this.store.saveWorker(record);
        break;
      }
      case "run_error": {
        runtime.lastError = event.message;
        this.store.appendEvent(record.id, "run.error", {
          message: safeText(event.message, 2000),
          fatal: event.fatal === true,
        });
        await this.store.saveWorker(record);
        break;
      }
      case "settled": {
        runtime.settled = event;
        await this.refreshSessionState(runtime);
        await this.finalizeSettled(runtime);
        break;
      }
      case "exit": {
        runtime.exitInfo = { code: event.code, signal: event.signal };
        await this.handleHarnessExit(runtime);
        break;
      }
    }
  }

  private async handleHarnessExit(runtime: Runtime): Promise<void> {
    const record = runtime.record;
    if (isTerminal(record.status) || runtime.finalizing) return;
    if (runtime.settled) {
      await this.refreshSessionState(runtime);
      await this.finalizeSettled(runtime);
      return;
    }
    runtime.finalizing = true;
    this.clearRuntimeTimers(runtime);
    const exit = runtime.exitInfo;
    if (exit) record.exit = { ...exit, at: new Date().toISOString() };
    record.pendingInput = undefined;
    record.endedAt = new Date().toISOString();
    if (runtime.cancelRequested) {
      record.status = "cancelled";
      record.statusReason = runtime.cancelReason ?? "cancelled_on_process_exit";
      this.store.appendEvent(record.id, "run.cancelled", {
        reason: record.statusReason,
        stage: runtime.runAccepted ? "run" : "startup",
        processExit: exit,
      });
      if (exit) {
        this.store.appendEvent(record.id, "worker.exited", {
          code: exit.code,
          signal: exit.signal,
          forced: false,
        });
      }
    } else {
      record.status = "crashed";
      record.statusReason = "harness_process_exited";
      record.error = `Harness process exited unexpectedly (code=${exit?.code ?? "null"}, signal=${exit?.signal ?? "null"})`;
      this.store.appendEvent(record.id, "worker.exited", {
        code: exit?.code ?? null,
        signal: exit?.signal ?? null,
        forced: false,
      });
      this.store.appendEvent(record.id, "worker.crashed", {
        error: record.error,
        stage: runtime.runAccepted ? "run" : "startup",
        stderrTail: this.store.stderrTail(record.id),
      });
    }
    await this.store.saveWorker(record).catch((error: unknown) => {
      this.logger.error(`Failed to persist exit state for ${record.id}`, {
        error: errorMessage(error),
      });
    });
    await this.store.flush(record.id).catch(() => undefined);
    this.runtimes.delete(record.id);
    runtime.terminal.resolve();
  }

  private createRuntime(record: WorkerRecord, adapter: HarnessAdapter): Runtime {
    const ready = new Deferred<void>();
    const terminal = new Deferred<void>();
    void ready.promise.catch(() => undefined);
    void terminal.promise.catch(() => undefined);
    return {
      record,
      adapter,
      ready,
      terminal,
      eventChain: Promise.resolve(),
      cancelRequested: false,
      finalizing: false,
      runAccepted: false,
    };
  }

  private async initializeSession(
    runtime: Runtime,
    options?: {
      sessionFile?: string;
      expectedSessionId?: string;
      resume?: boolean;
      initialPrompt?: string;
    },
  ): Promise<void> {
    const record = runtime.record;
    const spec: HarnessSpawnSpec = {
      workerId: record.id,
      cwd: record.cwd,
      sessionDir: path.join(this.store.sessionsDir, record.id),
      ...record.config,
      ...(options?.initialPrompt !== undefined
        ? { initialPrompt: options.initialPrompt }
        : {}),
      ...(this.workerEnv ? { env: this.workerEnv(record.id) } : {}),
    };
    const callbacks: HarnessCallbacks = {
      onEvent: (event) => {
        runtime.eventChain = runtime.eventChain
          .then(() => this.handleHarnessEvent(runtime, event))
          .catch((error: unknown) => {
            this.logger.error(`Failed to process harness event for ${record.id}`, {
              error: errorMessage(error),
              eventType: event.type,
            });
          });
      },
      onExit: (exit) => {
        runtime.exitInfo = exit;
        setImmediate(() => {
          runtime.eventChain = runtime.eventChain
            .then(() => this.handleHarnessExit(runtime))
            .catch((error: unknown) => {
              this.logger.error(`Failed to process harness exit for ${record.id}`, {
                error: errorMessage(error),
              });
            });
        });
      },
    };
    try {
      const session =
        options?.sessionFile && options.resume
          ? await runtime.adapter.resume(spec, options.sessionFile, callbacks)
          : await runtime.adapter.spawn(spec, callbacks);
      runtime.session = session;
      record.pid = session.pid;
      record.capabilities = { ...runtime.adapter.capabilities };
      this.store.appendEvent(record.id, "worker.started", {
        pid: session.pid,
        runtime: record.runtime,
      });
      await this.store.saveWorker(record);
      const state = await session.getState();
      if (
        options?.resume &&
        options.expectedSessionId &&
        state.sessionId !== options.expectedSessionId
      ) {
        throw new SupervisorError(
          "UNSUPPORTED",
          "The harness did not load the expected session (session ID mismatch). Refusing to report a fake resume.",
          {
            expectedSessionId: options.expectedSessionId,
            actualSessionId: state.sessionId,
          },
        );
      }
      if (options?.resume) {
        if (!state.sessionFile || !existsSync(state.sessionFile)) {
          throw new SupervisorError(
            "UNSUPPORTED",
            "The harness did not report a usable persisted session after resume.",
            { sessionFile: state.sessionFile },
          );
        }
        if (
          options.sessionFile &&
          normalizePath(state.sessionFile) !== normalizePath(options.sessionFile)
        ) {
          throw new SupervisorError(
            "UNSUPPORTED",
            "Pi loaded a different session file than requested. Refusing to report a fake resume.",
            { requested: options.sessionFile, actual: state.sessionFile },
          );
        }
      }
      record.sessionId = state.sessionId;
      record.sessionFile = state.sessionFile;
      record.runtimeInfo = state.runtimeInfo;
      this.syncSessionRef(record, runtime.adapter);
      this.store.appendEvent(record.id, "worker.session", {
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        fileExists: Boolean(state.sessionFile && existsSync(state.sessionFile)),
      });
      await this.store.saveWorker(record);
      await this.store.flush(record.id);
      runtime.ready.resolve();
    } catch (error) {
      runtime.ready.reject(error);
      throw error;
    }
  }

  private ensureDurationTimer(runtime: Runtime): void {
    const maxDurationMs = runtime.record.config.maxDurationMs;
    if (!maxDurationMs || runtime.maxDurationTimer || isTerminal(runtime.record.status)) return;
    runtime.maxDurationTimer = setTimeout(() => {
      if (isTerminal(runtime.record.status) || runtime.cancelRequested) return;
      runtime.cancelRequested = true;
      runtime.cancelReason = "max_duration_exceeded";
      this.store.appendEvent(runtime.record.id, "worker.cancel_requested", {
        reason: runtime.cancelReason,
        maxDurationMs,
      });
      void this.store
        .saveWorker(runtime.record)
        .then(() => this.ensureCancelled(runtime))
        .catch((error: unknown) => {
          this.logger.error(`Failed to enforce max duration for ${runtime.record.id}`, {
            error: errorMessage(error),
          });
        });
    }, maxDurationMs);
    runtime.maxDurationTimer.unref?.();
  }

  /**
   * Clear a pending input request that the harness itself withdrew.
   *
   * The decision (kind + current requestId + answer/cancel races) lives in
   * `shouldClearPendingInput` so it can be tested without a harness. Clearing
   * also stops the expiry timer and restores `running`, which is what stops the
   * notification freshness gate from treating the withdrawal as still current.
   */
  private applyInputWithdrawal(runtime: Runtime, kind: string, detail: string | undefined): boolean {
    const record = runtime.record;
    if (
      !shouldClearPendingInput({
        kind,
        detail,
        pendingRequestId: record.pendingInput?.requestId,
        answeringRequestId: runtime.answeringRequestId,
        cancelRequested: runtime.cancelRequested,
        finalizing: runtime.finalizing,
        terminal: isTerminal(record.status),
      })
    ) {
      return false;
    }
    record.pendingInput = undefined;
    runtime.pendingNativeInput = undefined;
    if (runtime.pendingUiTimer) {
      clearTimeout(runtime.pendingUiTimer);
      runtime.pendingUiTimer = undefined;
    }
    record.status = "running";
    record.statusReason = undefined;
    return true;
  }

  private schedulePendingInputExpiry(runtime: Runtime, pending: PendingInput, nativeRequestId: string): void {
    if (runtime.pendingUiTimer) clearTimeout(runtime.pendingUiTimer);
    const timeoutMs = pending.expiresAt
      ? Math.max(0, Date.parse(pending.expiresAt) - Date.now())
      : undefined;
    if (timeoutMs === undefined) return;
    runtime.pendingUiTimer = setTimeout(() => {
      const record = runtime.record;
      if (record.pendingInput !== pending || isTerminal(record.status)) return;
      if (runtime.cancelRequested || runtime.finalizing) return;
      record.pendingInput = undefined;
      runtime.pendingNativeInput = undefined;
      record.status = "running";
      record.statusReason = undefined;
      this.store.appendEvent(record.id, "run.progress", {
        kind: "input_timeout",
        requestId: pending.requestId,
        note: "The harness input timeout elapsed; the supervisor no longer reports awaiting_input.",
      });
      // Pi's native dialog may have its own timeout, but an HS-imposed cap (or
      // a fake/minimal harness) would otherwise leave the extension waiting
      // forever. Cancel the dialog explicitly; runtimes that already timed out
      // simply report that no such request exists, which is harmless here.
      void runtime.session
        ?.answer(nativeRequestId, { cancelled: true })
        .catch((error: unknown) => {
          this.logger.debug(`Input expiry could not cancel ${pending.requestId}`, {
            workerId: record.id,
            error: errorMessage(error),
          });
        });
      void this.store.saveWorker(record).catch(() => undefined);
    }, timeoutMs + 250);
    runtime.pendingUiTimer.unref?.();
  }

  private clearRuntimeTimers(runtime: Runtime): void {
    if (runtime.maxDurationTimer) clearTimeout(runtime.maxDurationTimer);
    if (runtime.pendingUiTimer) clearTimeout(runtime.pendingUiTimer);
    runtime.maxDurationTimer = undefined;
    runtime.pendingUiTimer = undefined;
  }

  /** Wait for a terminating activation to release its files before admin work. */
  private async awaitRuntimeQuiet(workerId: string): Promise<void> {
    const runtime = this.runtimes.get(workerId);
    if (!runtime) return;
    await this.waitForRuntimeTerminal(runtime, 10_000);
  }

  /**
   * Serialize destructive lifecycle changes with continue/resume. `resuming`
   * already guards new activations, so the same guard prevents retire, forget
   * and compact from racing a Turn that passed its initial status check.
   */
  private async withWorkerMutation<T>(
    workerId: string,
    action: string,
    run: () => Promise<T>,
  ): Promise<T> {
    this.assertNewAdmission();
    if (this.resuming.has(workerId)) {
      throw new SupervisorError(
        "INVALID_STATE",
        `A continue or resume is in progress for this worker; retry ${action} shortly`,
        { workerId },
      );
    }
    this.resuming.add(workerId);
    try {
      return await run();
    } finally {
      this.resuming.delete(workerId);
    }
  }

  private async waitForRuntimeTerminal(runtime: Runtime, timeoutMs: number): Promise<boolean> {
    if (isTerminal(runtime.record.status) && !this.runtimes.has(runtime.record.id)) return true;
    try {
      await withTimeout(runtime.terminal.promise, Math.max(1, timeoutMs), "terminal wait timed out");
      return true;
    } catch {
      return (
        isTerminal(runtime.record.status) && !this.runtimes.has(runtime.record.id)
      );
    }
  }

  private requireSession(runtime: Runtime): HarnessSession {
    if (!runtime.session) {
      throw new SupervisorError("INTERNAL", "Harness session is not available");
    }
    return runtime.session;
  }

  private attachNotificationBinding(
    worker: WorkerSummary,
    source: NotificationBindingSource,
  ): WorkerSummary {
    const target = validateNotifyTarget(worker.notifyTarget ?? { channel: "none" });
    const wakeable = target.channel === "codex-queue" && Boolean(target.codexThreadId);
    const warnings: string[] = [];
    if (!wakeable) {
      if (target.channel === "codex-queue") {
        warnings.push(
          "The bound codex-queue target has no thread id, so this worker cannot wake a conversation.",
        );
      } else if (source === "explicit") {
        warnings.push(
          "This worker is explicitly bound to channel 'none'; it will not wake this conversation. Use worker_wait or read the notification inbox.",
        );
      } else if (source === "daemon-default") {
        warnings.push(
          "No notifyTarget was passed and the daemon default is channel 'none'; this worker will not wake this conversation. Use worker_wait or read the notification inbox, and do not tell the user it will notify automatically.",
        );
      } else {
        warnings.push(
          "This worker has no wake target (resume preserved an unbound binding). Use worker_wait or read the notification inbox.",
        );
      }
    }
    const binding: NotificationBinding = {
      target,
      source,
      wake: wakeable ? "bound" : "unbound",
      observation: wakeable ? "wake" : "wait",
      warnings,
    };
    return { ...worker, notificationBinding: binding };
  }

  private syncSessionRef(record: WorkerRecord, adapter: HarnessAdapter): void {
    record.sessionRef = {
      runtime: record.runtime,
      runtimeInstanceRef: adapter.instanceRef?.() ?? record.runtime,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.sessionFile ? { sessionLocator: record.sessionFile } : {}),
      cwd: record.cwd,
      capabilitiesObservedAt: new Date().toISOString(),
    };
  }

  /**
   * Whether a live PID may still be this worker's harness. A matching command
   * line proves it; an unreadable command line stays conservative. ACP children
   * have no worker/session token in argv, so for those runtimes an alive PID is
   * never treated as a reused PID: locking the session is safer than a
   * concurrent writer.
   */
  private pidMayBelongToWorker(
    record: WorkerRecord,
    identity: { alive: boolean; verified: boolean | null },
  ): boolean {
    if (!identity.alive) return false;
    if (identity.verified === true) return true;
    if (identity.verified === null) return true;
    return this.adapters.get(record.runtime)?.processIdentity === "conservative";
  }

  /**
   * Availability of the recorded native session, derived on every read. It is
   * deliberately conservative: a live or uncertain process, an orphaned worker
   * and a missing file all make a concurrent activation unsafe.
   */
  private sessionProjection(
    record: WorkerRecord,
    pidAlive: boolean | null,
  ): WorkerSessionProjection {
    const adapter = this.adapters.get(record.runtime);
    const ref =
      record.sessionRef ??
      (adapter
        ? {
            runtime: record.runtime,
            runtimeInstanceRef: adapter.instanceRef?.() ?? record.runtime,
            ...(record.sessionId ? { sessionId: record.sessionId } : {}),
            ...(record.sessionFile ? { sessionLocator: record.sessionFile } : {}),
            cwd: record.cwd,
          }
        : undefined);
    const fileExists = Boolean(record.sessionFile && existsSync(record.sessionFile));
    let reason: string | undefined;
    if (!adapter) reason = "runtime_unavailable";
    else if (!adapter.capabilities.resume) reason = "resume_unsupported";
    else if (!record.sessionFile) reason = "no_session_locator";
    else if (!fileExists) reason = "session_file_missing";
    else if (record.retiredAt) reason = "retired";
    else if (record.status === "orphaned") reason = "orphaned_session_may_be_in_use";
    else if (ACTIVE_STATUSES.has(record.status)) reason = "worker_active";
    else if (pidAlive) reason = "process_may_be_running";
    return {
      available: Boolean(record.sessionFile) && fileExists,
      restorable: reason === undefined,
      ...(reason ? { reason } : {}),
      ...(ref ? { ref } : {}),
    };
  }

  private lifecycleFor(
    record: WorkerRecord,
    pidAlive: boolean | null,
    session: WorkerSessionProjection,
  ): WorkerLifecycle {
    switch (record.status) {
      case "starting":
        return "activating";
      case "running":
        return "active";
      case "awaiting_input":
        return "awaiting_input";
      case "orphaned":
        return "orphaned";
      default:
        break;
    }
    if (record.retiredAt) return "retired";
    if (isTerminal(record.status)) {
      if (session.restorable) return "idle";
      return pidAlive ? "unknown" : "unavailable";
    }
    return "unknown";
  }

  private summary(record: WorkerRecord): WorkerSummary {
    const pidAlive = record.pid !== undefined ? isPidAlive(record.pid) : null;
    const resumeAvailable = Boolean(
      !record.retiredAt &&
        isTerminal(record.status) &&
        record.sessionFile &&
        existsSync(record.sessionFile) &&
        !pidAlive &&
        this.adapters.get(record.runtime)?.capabilities.resume,
    );
    const persistence: WorkerPersistence = record.persistence ?? "oneshot";
    const session = this.sessionProjection(record, pidAlive);
    return {
      ...structuredClone(record),
      pidAlive,
      resumeAvailable,
      persistence,
      lifecycle: this.lifecycleFor(record, pidAlive, session),
      session,
    };
  }

  /**
   * Seq of the newest run-start marker for a worker, from the in-memory event
   * cache. This is the evidence that decides whether a cancellation belongs to a
   * run that has already been superseded; the current status alone is not enough,
   * because a fast resume may already be terminal (completed/failed) again.
   */
  private lastRunStartSeq(workerId: string): number | undefined {
    let events: WorkerEvent[] = [];
    try {
      events = this.store.getRecentEvents(workerId, 60);
    } catch {
      return undefined;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;
      if (
        event.type === "worker.starting" ||
        event.type === "worker.resumed" ||
        event.type === "worker.continued" ||
        event.type === "run.accepted"
      ) {
        return event.seq;
      }
    }
    return undefined;
  }

  private requireWorker(workerId: string): WorkerRecord {
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new SupervisorError("BAD_REQUEST", "workerId is required");
    }
    const record = this.store.getWorker(workerId);
    if (!record) {
      throw new SupervisorError("NOT_FOUND", `Worker not found: ${workerId}`);
    }
    return record;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new SupervisorError("INTERNAL", "Supervisor is not initialized");
  }

  private assertAcceptingWork(): void {
    if (this.shuttingDown) {
      throw new SupervisorError("INVALID_STATE", "Supervisor is shutting down");
    }
    if (this.maintenance) {
      throw new SupervisorError(
        "INVALID_STATE",
        `Maintenance (${this.maintenance}) is in progress; retry shortly`,
      );
    }
  }

  private assertNewAdmission(): void {
    if (this.drainIntent) {
      throw new SupervisorError("INVALID_STATE", "Supervisor is draining for a managed core update", {
        intentId: this.drainIntent,
      });
    }
  }

  private async withDurableMutation<T>(run: () => Promise<T>): Promise<T> {
    if (this.drainSealed || this.shuttingDown) {
      throw new SupervisorError("INVALID_STATE", "Supervisor is switching cores or shutting down; retry after reconnection");
    }
    this.pendingDurableMutations += 1;
    try { return await run(); }
    finally { this.pendingDurableMutations -= 1; }
  }

  private async withAdmittedWork<T>(run: () => Promise<T>): Promise<T> {
    this.assertNewAdmission();
    // Reserve before idempotency.flush or any other await. Once accepted, this
    // operation may complete during draining, but handoff must wait for it.
    this.pendingAdmissions += 1;
    try { return await run(); }
    finally { this.pendingAdmissions -= 1; }
  }

  private async withMaintenance<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.assertNewAdmission();
    if (this.maintenance) {
      throw new SupervisorError(
        "INVALID_STATE",
        `Another maintenance operation (${this.maintenance}) is already running`,
      );
    }
    this.maintenance = name;
    try {
      return await run();
    } finally {
      this.maintenance = null;
    }
  }

  private reserveSpawnSlot(): void {
    const active = this.store
      .listWorkers()
      .filter((record) => ACTIVE_STATUSES.has(record.status)).length;
    if (active + this.pendingSpawns >= this.limits.maxWorkers) {
      throw new SupervisorError(
        "LIMIT_EXCEEDED",
        `Maximum concurrent workers reached (${this.limits.maxWorkers})`,
        { active, pendingSpawns: this.pendingSpawns },
      );
    }
    this.pendingSpawns += 1;
  }
}

function optionalString(value: string | undefined, max: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SupervisorError("BAD_REQUEST", `${field} must be a string`);
  }
  return safeText(value, max);
}

function validateConfig(
  input: Partial<SpawnInput | ResumeInput>,
  existing?: WorkerConfig,
): WorkerConfig {
  const config: WorkerConfig = { ...(existing ?? {}) };
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || input.model.length === 0 || input.model.length > 200) {
      throw new SupervisorError("BAD_REQUEST", "model must be a string of 1-200 characters");
    }
    config.model = input.model;
  }
  if (input.provider !== undefined) {
    if (
      typeof input.provider !== "string" ||
      input.provider.length === 0 ||
      input.provider.length > 200
    ) {
      throw new SupervisorError("BAD_REQUEST", "provider must be a string of 1-200 characters");
    }
    config.provider = input.provider;
  }
  if (input.thinking !== undefined) {
    if (
      typeof input.thinking !== "string" ||
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.thinking)
    ) {
      throw new SupervisorError("BAD_REQUEST", "thinking must be a valid Pi thinking level");
    }
    config.thinking = input.thinking;
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length === 0 || input.tools.length > 50) {
      throw new SupervisorError("BAD_REQUEST", "tools must be a non-empty array (max 50)");
    }
    for (const tool of input.tools) {
      if (typeof tool !== "string" || tool.length === 0 || tool.length > 100) {
        throw new SupervisorError("BAD_REQUEST", "each tool must be a string of 1-100 characters");
      }
    }
    config.tools = [...input.tools];
  }
  if (input.maxDurationMs !== undefined) {
    if (
      typeof input.maxDurationMs !== "number" ||
      !Number.isFinite(input.maxDurationMs) ||
      input.maxDurationMs < 1000 ||
      input.maxDurationMs > 24 * 60 * 60 * 1000
    ) {
      throw new SupervisorError(
        "BAD_REQUEST",
        "maxDurationMs must be between 1000 and 86400000",
      );
    }
    config.maxDurationMs = Math.trunc(input.maxDurationMs);
  }
  if (input.extraArgs !== undefined) {
    if (!Array.isArray(input.extraArgs) || input.extraArgs.length > 30) {
      throw new SupervisorError("BAD_REQUEST", "extraArgs must be an array (max 30)");
    }
    try {
      validateExtraArgs(input.extraArgs);
    } catch (error) {
      throw new SupervisorError("BAD_REQUEST", errorMessage(error));
    }
    config.extraArgs = [...input.extraArgs];
  }
  return config;
}

function normalizePath(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readSessionHeaderId(sessionFile: string): Promise<string | null> {
  try {
    const raw = await readFile(sessionFile, "utf8");
    const firstLine = raw.split("\n", 1)[0];
    if (!firstLine) return null;
    const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string" ? header.id : null;
  } catch {
    return null;
  }
}

function storedText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean; originalChars?: number } {
  const clipped = truncateText(redactText(value), maxChars);
  if (clipped.truncated) {
    return { text: clipped.text, truncated: true, originalChars: value.length };
  }
  // The adapter may already have clipped this string. Preserve that fact in
  // structured fields so a reader does not have to parse the visible suffix.
  const match = /^(.*)\n\.\.\.\[truncated (\d+) chars\]$/s.exec(clipped.text);
  if (match) {
    return {
      text: clipped.text,
      truncated: true,
      originalChars: match[1]!.length + Number(match[2]),
    };
  }
  return { text: clipped.text, truncated: false };
}

function validateUiResponseShape(response: ExtensionUiResponse): void {
  if (!response || typeof response !== "object") {
    throw new SupervisorError("BAD_REQUEST", "response is required");
  }
  const provided = ["value" in response, "confirmed" in response, "cancelled" in response].filter(
    Boolean,
  ).length;
  if (provided !== 1) {
    throw new SupervisorError(
      "BAD_REQUEST",
      "Provide exactly one of value, confirmed, or cancelled=true",
    );
  }
  if ("cancelled" in response && response.cancelled !== true) {
    throw new SupervisorError("BAD_REQUEST", "cancelled must be true");
  }
}

function validateUiResponse(pending: PendingInput, response: ExtensionUiResponse): void {
  if (!response || typeof response !== "object") {
    throw new SupervisorError("BAD_REQUEST", "response is required");
  }
  if ("cancelled" in response) {
    if (response.cancelled !== true) {
      throw new SupervisorError("BAD_REQUEST", "cancelled must be true");
    }
    return;
  }
  if (pending.method === "confirm") {
    if (!("confirmed" in response) || typeof response.confirmed !== "boolean") {
      throw new SupervisorError("BAD_REQUEST", "confirm requires a boolean confirmed value");
    }
    return;
  }
  if (!("value" in response) || typeof response.value !== "string") {
    throw new SupervisorError("BAD_REQUEST", `${pending.method} requires a string value`);
  }
  if (pending.method === "select" && pending.options && !pending.options.includes(response.value)) {
    throw new SupervisorError("BAD_REQUEST", "value must be one of the offered options", {
      options: pending.options,
    });
  }
}

/**
 * Errors that happen before any worker or message was created. For these the
 * request id stays reusable instead of pinning the caller to a transient failure.
 */
function isPreSideEffectError(error: unknown): boolean {
  if (!(error instanceof SupervisorError)) return false;
  if (typeof error.details?.workerId === "string") return false;
  return (
    error.code === "BAD_REQUEST" ||
    error.code === "UNSUPPORTED" ||
    error.code === "INVALID_STATE" ||
    error.code === "LIMIT_EXCEEDED"
  );
}

function classifyErrorCode(
  error: unknown,
): "BAD_REQUEST" | "UNSUPPORTED" | "INVALID_STATE" | "HARNESS_ERROR" | "HARNESS_TIMEOUT" | "INTERNAL" {
  if (error instanceof SupervisorError) {
    return error.code === "BAD_REQUEST" ||
      error.code === "UNSUPPORTED" ||
      error.code === "INVALID_STATE" ||
      error.code === "HARNESS_ERROR" ||
      error.code === "HARNESS_TIMEOUT"
      ? error.code
      : "INTERNAL";
  }
  return "HARNESS_ERROR";
}
