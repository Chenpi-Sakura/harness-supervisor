import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
  type HarnessSpawnSpec,
  type NotificationsResult,
  type NotificationDeliveryState,
  type NotifyTarget,
  type PendingInput,
  type ReadEventsResult,
  type ResumeInput,
  type SendMode,
  type SpawnInput,
  type SupervisorInfo,
  type SupervisorLimits,
  type WaitResult,
  type WorkerConfig,
  type WorkerEvent,
  type WorkerEventType,
  type WorkerRecord,
  type WorkerStatus,
  type WorkerStatusResult,
  type WorkerSummary,
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
  private readonly runtimes = new Map<string, Runtime>();
  private readonly resuming = new Set<string>();
  private pendingSpawns = 0;
  private initialized = false;
  private shuttingDown = false;
  private metricsReady = false;
  private metricsError: string | undefined;

  constructor(options: SupervisorOptions) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.logger = options.logger;
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
    await this.notifier.init();
    await this.idempotency.init();
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
    this.store.onAnyEvent((event) => {
      const record = this.store.getWorker(event.workerId);
      if (!record) return;
      this.notifier.ingest(record, event);
      this.ingestMetricsEvent(record, event);
    });
    const { workers, warnings } = await this.store.init();
    const now = new Date().toISOString();
    for (const record of workers) {
      if (!record.notifyTarget) {
        // Legacy records have no reliable origin. Do not guess from the current
        // global default or the most recently used Codex session.
        record.notifyTarget = { channel: "none" };
        await this.store.saveWorker(record);
      }
      if (!isTerminal(record.status)) {
        const previousStatus = record.status;
        const identity = await inspectProcess(record.pid, [
          record.id,
          record.sessionId,
          record.sessionFile,
        ]);
        const pidAlive = identity.alive;
        // A live PID is only treated as our harness when its command line carries
        // one of our worker/session tokens. Otherwise it is a reused PID and the
        // original process is gone.
        const pidOurs = identity.verified !== false;
        const orphaned = pidAlive && pidOurs;
        const status: WorkerStatus = orphaned ? "orphaned" : "interrupted";
        record.status = status;
        record.statusReason = orphaned
          ? "Supervisor restarted and no longer owns the live harness process"
          : pidAlive
            ? "The recorded PID is alive but its command line does not match this worker (PID reused); the original process is gone and the outcome is unknown"
            : "Supervisor restarted after the harness process was lost; outcome unknown";
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
    await this.reconcileMetricsUsage();
    await this.reconcileNotifications();
    this.logger.info("Supervisor initialized", {
      workers: workers.length,
      warnings: warnings.length,
    });
  }

  /**
   * Rebuild inbox records for important events that were persisted before a
   * crash (event written, notification not yet written). Ids are derived from
   * (worker, seq), so this can never duplicate a notification.
   */
  private async reconcileNotifications(): Promise<void> {
    let created = 0;
    for (const record of this.store.listWorkers()) {
      try {
        for await (const event of this.store.scanEvents(record.id)) {
          if (notificationKindFor(event.type) && !this.notifier.has(notificationId(record.id, event.seq))) {
            created += 1;
          }
          this.notifier.ingest({ ...record, notifyTarget: { channel: "none" } }, event);
        }
      } catch (error) {
        // A damaged history must not prevent the daemon controlling other workers.
        this.logger.warn(`Cannot fully rebuild notifications for ${record.id}`, { error: errorMessage(error) });
      }
    }
    if (created > 0) {
      this.logger.info("Reconciled notification inbox from persisted events", { created });
    }
    await this.notifier.flush();
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
    for (const record of this.store.listWorkers()) {
      if (!record.taskId) continue;
      try {
        for await (const event of this.store.scanEvents(record.id)) {
          if (event.type !== "run.usage") continue;
          const existed = this.metrics.hasUsage(`runtime:${record.id}:${event.seq}`);
          const usage = this.metrics.ingestEvent(record, event);
          if (usage && !existed) created += 1;
        }
      } catch (error) {
        this.logger.warn(`Cannot fully rebuild metrics usage for ${record.id}`, {
          error: errorMessage(error),
        });
      }
    }
    await this.metrics.flush().catch((error: unknown) => {
      this.logger.warn("Failed to flush reconciled metrics usage", {
        error: errorMessage(error),
      });
    });
    if (created > 0) {
      this.logger.info("Reconciled task usage from persisted events", { created });
    }
  }

  createMetricsTask(input: TaskCreateInput): Promise<TaskRecord> {
    this.assertInitialized();
    return this.requireMetrics().createTask(input);
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
    return this.requireMetrics().recordUsage(input);
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
    state?: "pending" | "delivered" | "failed" | "all";
    workerId?: string;
    limit?: number;
    unacknowledgedOnly?: boolean;
  } = {}): NotificationsResult {
    this.assertInitialized();
    return {
      notifications: this.notifier.list(filter),
      counts: this.notifier.counts(),
      target: this.notifier.getTarget(),
    };
  }

  getNotifyTarget(): NotifyTarget {
    this.assertInitialized();
    return this.notifier.getTarget();
  }

  async ackNotifications(ids: string[], by?: string): Promise<{ acked: number; missing: string[] }> {
    this.assertInitialized();
    return this.notifier.ack(ids, by);
  }

  async setNotifyTarget(input: {
    channel?: "none" | "codex-queue";
    codexThreadId?: string | null;
  }): Promise<NotifyTarget> {
    this.assertInitialized();
    return this.notifier.setTarget(input);
  }

  async retryNotifications(states?: NotificationDeliveryState[]): Promise<number> {
    this.assertInitialized();
    return this.notifier.retryPending(states);
  }

  /**
   * Opt-in maintenance: drop old terminal workers, compact metadata logs.
   * Never removes an active worker or a worker with an unacknowledged notification.
   */
  async prune(options: PruneOptions = {}): Promise<PruneResult & { compacted: unknown }> {
    this.assertInitialized();
    const result = await this.retention.prune(options);
    if (options.dryRun) return { ...result, compacted: null };
    const notifications = await this.notifier.compact({ olderThanDays: 30 });
    const idempotency = await this.idempotency.compact();
    return { ...result, compacted: { notifications, idempotency } };
  }

  info(): SupervisorInfo {
    return {
      name: TOOL_NAME,
      version: VERSION,
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
          "MCP event queries are pull-based. channel/proactive describe the default for NEW workers; explicit spawn.notifyTarget overrides it. Each worker persists its destination, and each important event snapshots that route. Resume preserves it unless explicitly rebound. Legacy unbound records use the inbox only. codex-queue uses the official CLI; whether a new turn starts depends on the host having that thread loaded. Delivery is at-least-once and does not itself prove wake-up.",
      },
      runtimes: [...this.adapters.values()].map((adapter) => adapter.capabilities),
    };
  }

  async spawn(input: SpawnInput, options: { requestId?: string } = {}): Promise<WorkerSummary> {
    this.assertInitialized();
    this.assertAcceptingWork();
    const requestId = validateIdempotencyKey(options.requestId);
    if (!requestId) return this.spawnOnce(input);
    return this.withIdempotency("spawn", requestId, input, (workerId) =>
      this.spawnOnce(input, workerId),
    );
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
    method: "spawn" | "resume" | "send",
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
      if (current) return this.summary(current);
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
      name: optionalString(input.name, 200, "name"),
      cwd,
      promptPreview: safeText(input.prompt, 500),
      status: "starting",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      eventCount: 0,
      stats: { turns: 0, toolCalls: 0, toolErrors: 0 },
      capabilities: { ...adapter.capabilities },
      config,
      resumeCount: 0,
      supervisorId: this.supervisorId,
      notifyTarget: validateNotifyTarget(input.notifyTarget ?? this.notifier.getTarget()),
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

    try {
      await this.store.flush(id);
      this.assertAcceptingWork();
      await this.initializeSession(runtime);
      this.assertAcceptingWork();
      if (runtime.cancelRequested) {
        await this.ensureCancelled(runtime);
        return this.summary(record);
      }
      const disposition = await this.requireSession(runtime).prompt(input.prompt);
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
      record.status = record.pendingInput ? "awaiting_input" : "running";
      record.statusReason = record.pendingInput ? "harness requested input" : undefined;
      this.store.appendEvent(id, "run.accepted", {
        disposition: disposition.disposition,
      });
      this.ensureDurationTimer(runtime);
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
    this.assertAcceptingWork();
    const requestId = validateIdempotencyKey(options.requestId);
    if (!requestId) return this.resumeOnce(workerId, input);
    return this.withIdempotency("resume", requestId, { workerId, input }, (workerIdOut) =>
      this.resumeOnce(workerId, input, workerIdOut),
    );
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
    try {
      return await this.resumeInternal(workerId, input, record);
    } finally {
      this.resuming.delete(workerId);
    }
  }

  private async resumeInternal(
    workerId: string,
    input: ResumeInput,
    record: WorkerRecord,
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
      // A reused PID must not block resuming our own persisted session.
      if (identity.alive && identity.verified !== false) {
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
    this.store.appendEvent(workerId, "worker.starting", {
      runtime: record.runtime,
      resumed: true,
      sessionFile: record.sessionFile,
    });
    const runtime = this.createRuntime(record, adapter);
    this.runtimes.set(workerId, runtime);

    try {
      await this.store.saveWorker(record);
      this.assertAcceptingWork();
      await this.initializeSession(runtime, {
        sessionFile: record.sessionFile,
        expectedSessionId,
        resume: true,
      });
      this.assertAcceptingWork();
      if (runtime.cancelRequested) {
        await this.ensureCancelled(runtime);
        return this.summary(record);
      }
      const disposition = await this.requireSession(runtime).prompt(input.prompt);
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
      record.promptPreview = safeText(input.prompt, 500);
      record.status = record.pendingInput ? "awaiting_input" : "running";
      record.statusReason = record.pendingInput ? "harness requested input" : undefined;
      this.store.appendEvent(workerId, "run.accepted", {
        disposition: disposition.disposition,
        resumed: true,
      });
      record.resumeCount += 1;
      this.store.appendEvent(workerId, "worker.resumed", {
        sessionId: record.sessionId,
        sessionFile: record.sessionFile,
        resumeCount: record.resumeCount,
      });
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

  list(filter?: { statuses?: WorkerStatus[]; limit?: number }): WorkerSummary[] {
    this.assertInitialized();
    const statuses = filter?.statuses ? new Set(filter.statuses) : null;
    const limit = clampInt(filter?.limit ?? 100, 1, 500);
    return this.store
      .listWorkers()
      .filter((record) => !statuses || statuses.has(record.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((record) => this.summary(record));
  }

  status(workerId: string, recentEventLimit = 20): WorkerStatusResult {
    this.assertInitialized();
    const record = this.requireWorker(workerId);
    return {
      worker: this.summary(record),
      recentEvents: this.store.getRecentEvents(workerId, clampInt(recentEventLimit, 0, 100)),
      stderrTail: this.store.stderrTail(workerId),
    };
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
        resolve({
          worker: this.summary(this.requireWorker(workerId)),
          events: data.events,
          nextSeq: data.nextSeq,
          hasMore: data.hasMore,
          timedOut,
          terminal: isTerminal(this.requireWorker(workerId).status),
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
            const data = await this.store.readEvents(workerId, sinceSeq, 500);
            if (finished) return;
            const current = this.requireWorker(workerId);
            const hasMatchingEvent = typeFilter
              ? data.events.some((event) => typeFilter.has(event.type))
              : data.events.length > 0;
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
    const requestId = validateIdempotencyKey(options.requestId);
    if (!requestId) return this.sendOnce(workerId, message, mode);
    return this.withIdempotency("send", requestId, { workerId, message, mode }, () =>
      this.sendOnce(workerId, message, mode),
    );
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
    const record = this.requireWorker(workerId);
    const runtime = this.runtimes.get(workerId);
    const pending = record.pendingInput;
    if (!runtime || !runtime.session || !pending) {
      throw new SupervisorError("INVALID_STATE", "Worker has no pending input request", {
        status: record.status,
      });
    }
    if (pending.requestId !== requestId) {
      throw new SupervisorError("INVALID_STATE", "requestId does not match the pending request", {
        pendingRequestId: pending.requestId,
      });
    }
    this.assertAcceptingWork();
    if (runtime.cancelRequested || runtime.finalizing) {
      throw new SupervisorError("INVALID_STATE", "Worker is being cancelled", {
        status: record.status,
      });
    }
    if (runtime.answeringRequestId) {
      throw new SupervisorError("INVALID_STATE", "Another answer is already being delivered", {
        requestId: runtime.answeringRequestId,
      });
    }
    validateUiResponse(pending, response);
    runtime.answeringRequestId = requestId;
    try {
      await runtime.session.answer(requestId, response);
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
    if (runtime.pendingUiTimer) {
      clearTimeout(runtime.pendingUiTimer);
      runtime.pendingUiTimer = undefined;
    }
    record.pendingInput = undefined;
    if (!isTerminal(record.status)) {
      record.status = "running";
      record.statusReason = undefined;
    }
    this.store.appendEvent(workerId, "run.input_answered", {
      requestId,
      method: pending.method,
      cancelled: "cancelled" in response && response.cancelled === true,
    });
    await this.store.saveWorker(record);
    await this.store.flush(workerId);
    return this.summary(record);
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
        if (identity.alive && identity.verified !== false) {
          throw new SupervisorError(
            "UNSUPPORTED",
            "The supervisor no longer owns this live process after a restart. It cannot be cancelled through the supervisor; verify and terminate the recorded PID out-of-band.",
            { pid: record.pid, workerId, pidVerified: identity.verified },
          );
        }
        if (identity.verified === false) {
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

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const drainDeadline = Date.now() + 5000;
    while (
      (this.pendingSpawns > 0 || this.resuming.size > 0) &&
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
      const clipped = truncateText(redactText(finalText), this.limits.maxEventStringBytes);
      eventData.text = clipped.text;
      eventData.truncated = clipped.truncated;
    } else {
      eventData.reason = errorText;
      eventData.error = record.error;
      eventData.partialText = safeText(finalText, 1000);
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
        if (event.detail !== undefined) data.detail = safeText(event.detail, 500);
        if (event.preview !== undefined) data.preview = safeText(event.preview, 1000);
        if (event.isError !== undefined) data.isError = event.isError;
        if (event.durationMs !== undefined) data.durationMs = event.durationMs;
        if (event.kind === "tool_start") record.stats.toolCalls += 1;
        if (event.kind === "tool_end" && event.isError) record.stats.toolErrors += 1;
        if (event.kind === "turn_complete") record.stats.turns += 1;
        if (event.kind === "assistant_message" && event.preview) {
          runtime.lastAssistantText = event.preview;
        }
        // A withdrawal is a decision, not progress: the harness no longer needs
        // an answer, so the worker must stop reporting awaiting_input. Without
        // this the request would stay "current" for the notification gate and a
        // reminder would be delivered for something nobody can answer.
        if (
          INPUT_WITHDRAWAL_KINDS.has(event.kind) &&
          this.applyInputWithdrawal(runtime, event.kind, event.detail)
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
        const pending: PendingInput = {
          requestId: event.requestId,
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
        record.pendingInput = pending;
        if (!isTerminal(record.status)) {
          record.status = "awaiting_input";
          record.statusReason = "harness requested input";
        }
        this.schedulePendingInputExpiry(runtime, pending);
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
    options?: { sessionFile?: string; expectedSessionId?: string; resume?: boolean },
  ): Promise<void> {
    const record = runtime.record;
    const spec: HarnessSpawnSpec = {
      workerId: record.id,
      cwd: record.cwd,
      sessionDir: path.join(this.store.sessionsDir, record.id),
      ...record.config,
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
    if (runtime.pendingUiTimer) {
      clearTimeout(runtime.pendingUiTimer);
      runtime.pendingUiTimer = undefined;
    }
    record.status = "running";
    record.statusReason = undefined;
    return true;
  }

  private schedulePendingInputExpiry(runtime: Runtime, pending: PendingInput): void {
    if (runtime.pendingUiTimer) clearTimeout(runtime.pendingUiTimer);
    const timeoutMs = pending.expiresAt
      ? Math.max(0, Date.parse(pending.expiresAt) - Date.now())
      : undefined;
    if (timeoutMs === undefined) return;
    runtime.pendingUiTimer = setTimeout(() => {
      const record = runtime.record;
      if (record.pendingInput?.requestId !== pending.requestId || isTerminal(record.status)) return;
      record.pendingInput = undefined;
      record.status = "running";
      record.statusReason = undefined;
      this.store.appendEvent(record.id, "run.progress", {
        kind: "input_timeout",
        requestId: pending.requestId,
        note: "The harness input timeout elapsed; the supervisor no longer reports awaiting_input.",
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

  private summary(record: WorkerRecord): WorkerSummary {
    const pidAlive = record.pid !== undefined ? isPidAlive(record.pid) : null;
    const resumeAvailable = Boolean(
      isTerminal(record.status) &&
        record.sessionFile &&
        existsSync(record.sessionFile) &&
        !pidAlive &&
        this.adapters.get(record.runtime)?.capabilities.resume,
    );
    return {
      ...structuredClone(record),
      pidAlive,
      resumeAvailable,
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
