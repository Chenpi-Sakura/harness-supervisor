import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { SupervisorError, errorMessage } from "./errors.js";
import { Store } from "./store.js";
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
  type PendingInput,
  type ReadEventsResult,
  type ResumeInput,
  type SendMode,
  type SpawnInput,
  type SupervisorInfo,
  type SupervisorLimits,
  type WaitResult,
  type WorkerConfig,
  type WorkerEventType,
  type WorkerRecord,
  type WorkerStatus,
  type WorkerStatusResult,
  type WorkerSummary,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import { clampInt, Deferred, isPidAlive, newWorkerId, sleep, withTimeout } from "./util/async.js";
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
}

export class Supervisor {
  readonly store: Store;
  readonly supervisorId: string;
  readonly stateDir: string;
  readonly startedAt: string;
  readonly limits: SupervisorLimits;
  private readonly adapters: Map<string, HarnessAdapter>;
  private readonly logger: Logger;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly resuming = new Set<string>();
  private pendingSpawns = 0;
  private initialized = false;
  private shuttingDown = false;

  constructor(options: SupervisorOptions) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.logger = options.logger;
    this.supervisorId = options.supervisorId;
    this.stateDir = options.stateDir;
    this.startedAt = options.startedAt ?? new Date().toISOString();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const { workers, warnings } = await this.store.init();
    const now = new Date().toISOString();
    for (const record of workers) {
      if (!isTerminal(record.status)) {
        const previousStatus = record.status;
        const pidAlive = isPidAlive(record.pid);
        const status: WorkerStatus = pidAlive ? "orphaned" : "interrupted";
        record.status = status;
        record.statusReason = pidAlive
          ? "Supervisor restarted and no longer owns the live harness process"
          : "Supervisor restarted after the harness process was lost; outcome unknown";
        record.endedAt = now;
        record.updatedAt = now;
        this.store.appendEvent(
          record.id,
          pidAlive ? "worker.orphaned" : "worker.interrupted",
          {
            pid: record.pid,
            pidAlive,
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
    this.logger.info("Supervisor initialized", {
      workers: workers.length,
      warnings: warnings.length,
    });
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
        proactive: false,
        note: "Events are persisted and retrievable. MCP tools are pull-based: the host must call worker_wait or worker_events to observe them. The supervisor does not claim the ability to wake the main agent in the background.",
      },
      runtimes: [...this.adapters.values()].map((adapter) => adapter.capabilities),
    };
  }

  async spawn(input: SpawnInput): Promise<WorkerSummary> {
    this.assertInitialized();
    this.assertAcceptingWork();
    this.reserveSpawnSlot();
    try {
      return await this.spawnInternal(input);
    } finally {
      this.pendingSpawns -= 1;
    }
  }

  private async spawnInternal(input: SpawnInput): Promise<WorkerSummary> {
    const runtimeName = input.runtime ?? "pi";
    const adapter = this.adapters.get(runtimeName);
    if (!adapter) {
      throw new SupervisorError("UNSUPPORTED", `Unknown runtime: ${runtimeName}`, {
        available: [...this.adapters.keys()],
      });
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
    };
    await this.store.createWorker(record);
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

  async resume(workerId: string, input: ResumeInput): Promise<WorkerSummary> {
    this.assertInitialized();
    this.assertAcceptingWork();
    const record = this.requireWorker(workerId);
    if (this.resuming.has(workerId)) {
      throw new SupervisorError("INVALID_STATE", "Resume is already in progress for this worker", {
        workerId,
        status: record.status,
      });
    }
    this.resuming.add(workerId);
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
      throw new SupervisorError(
        "INVALID_STATE",
        "The previous harness process still appears to be alive. Refusing concurrent resume of the same session.",
        { pid: record.pid },
      );
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

  events(workerId: string, options?: { sinceSeq?: number; limit?: number }): ReadEventsResult {
    this.assertInitialized();
    const record = this.requireWorker(workerId);
    const sinceSeq = Math.max(0, Math.trunc(options?.sinceSeq ?? 0));
    const limit = clampInt(options?.limit ?? 100, 1, 500);
    const result = this.store.getEvents(workerId, sinceSeq, limit);
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

    return new Promise<WaitResult>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      let unsubscribe: (() => void) | undefined;

      const finish = (timedOut: boolean) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        const data = this.store.getEvents(workerId, sinceSeq, 500);
        resolve({
          worker: this.summary(this.requireWorker(workerId)),
          events: data.events,
          nextSeq: data.nextSeq,
          hasMore: data.hasMore,
          timedOut,
          terminal: isTerminal(this.requireWorker(workerId).status),
        });
      };

      const evaluate = (): boolean => {
        const current = this.requireWorker(workerId);
        const data = this.store.getEvents(workerId, sinceSeq, 500);
        const hasMatchingEvent = typeFilter
          ? data.events.some((event) => typeFilter.has(event.type))
          : data.events.length > 0;
        // A run that needs input cannot reach a terminal state without the client.
        // Returning immediately makes the authorization request observable instead
        // of hiding it behind a wait timeout.
        const needsInput = current.status === "awaiting_input";
        if (
          isTerminal(current.status) ||
          needsInput ||
          (until === "event" && hasMatchingEvent)
        ) {
          finish(false);
          return true;
        }
        return false;
      };

      unsubscribe = this.store.subscribe(workerId, () => {
        if (!finished) evaluate();
      });
      if (evaluate()) return;
      if (timeoutMs === 0) {
        finish(true);
        return;
      }
      timer = setTimeout(() => finish(true), timeoutMs);
      timer.unref?.();
    });
  }

  async send(
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
      throw new SupervisorError("HARNESS_ERROR", safeText(errorMessage(error), 2000), {
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
        throw new SupervisorError(
          "UNSUPPORTED",
          "The supervisor no longer owns this live process after a restart. It cannot be cancelled through the supervisor; verify and terminate the recorded PID out-of-band.",
          { pid: record.pid, workerId },
        );
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
        this.store.appendEvent(record.id, "run.progress", data);
        await this.store.saveWorker(record);
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
        this.store.appendEvent(record.id, "run.needs_input", {
          requestId: pending.requestId,
          method: pending.method,
          title: safeText(pending.title ?? "", 300),
          message: safeText(pending.message ?? "", 1000),
          options: pending.options,
          expiresAt: pending.expiresAt,
        });
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
          "Pi did not load the expected session (session ID mismatch). Refusing to report a fake resume.",
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
            "Pi did not report a usable persisted session after resume.",
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
        note: "Pi's extension dialog timeout elapsed; the supervisor no longer reports awaiting_input.",
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
