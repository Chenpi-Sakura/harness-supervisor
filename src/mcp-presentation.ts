/**
 * MCP presentation layer.
 *
 * The presentation mode belongs to one MCP process; it never changes the
 * supervisor, the daemon or the persisted records. `production` returns only
 * the information a caller needs to run and observe a task, while
 * `development` is an extended field whitelist for diagnostics. Neither mode
 * serializes a raw internal DTO.
 */
import {
  EVENTS_BUDGET_BYTES,
  MAX_COMPACT_EVENTS,
  STATUS_BUDGET_BYTES,
  compactStatus,
  fullPendingInput,
  jsonBytes,
  packCompactEvents,
} from "./context-budget.js";
import { SupervisorError, errorMessage } from "./errors.js";
import { isProductionEventType } from "./event-policy.js";
import { isTerminal } from "./types.js";
import type {
  NotificationRecord,
  NotificationsResult,
  NotifyTarget,
  PendingInput,
  ReadEventsResult,
  SupervisorInfo,
  WaitResult,
  WorkerEvent,
  WorkerResult,
  WorkerStatusResult,
  WorkerSummary,
} from "./types.js";
import type {
  MetricsReport,
  TaskMetrics,
  TaskRecord,
  UsageRecord,
} from "./metrics.js";

export type McpPresentationMode = "production" | "development";

export const MCP_MODE_ENV = "HARNESS_SUPERVISOR_MCP_MODE";
export const DEFAULT_MCP_MODE: McpPresentationMode = "production";

export interface ResolvedMcpMode {
  mode: McpPresentationMode;
  source: "cli" | "environment" | "default";
}

function parseMode(value: string, origin: string): McpPresentationMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "production" || normalized === "development") return normalized;
  throw new SupervisorError(
    "BAD_REQUEST",
    `Invalid ${origin} value "${value}"; expected "production" or "development"`,
  );
}

/**
 * Resolution order: explicit CLI value > HARNESS_SUPERVISOR_MCP_MODE > production.
 * An empty environment value is treated as unset; an explicit empty CLI value is
 * rejected instead of silently falling back.
 */
export function resolveMcpMode(cliValue?: string): ResolvedMcpMode {
  if (cliValue !== undefined) {
    if (cliValue.trim() === "") {
      throw new SupervisorError(
        "BAD_REQUEST",
        '--mode requires a value: "production" or "development"',
      );
    }
    return { mode: parseMode(cliValue, "--mode"), source: "cli" };
  }
  const fromEnv = process.env[MCP_MODE_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { mode: parseMode(fromEnv, MCP_MODE_ENV), source: "environment" };
  }
  return { mode: DEFAULT_MCP_MODE, source: "default" };
}

function resultOf(value: WorkerResult | undefined): WorkerResult | undefined {
  if (!value) return undefined;
  return { text: value.text, truncated: value.truncated };
}

function pendingOf(value: PendingInput | undefined): PendingInput | undefined {
  if (!value) return undefined;
  return {
    requestId: value.requestId,
    ...(value.seq !== undefined ? { seq: value.seq } : {}),
    method: value.method,
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.message !== undefined ? { message: value.message } : {}),
    ...(value.options !== undefined ? { options: [...value.options] } : {}),
    ...(value.placeholder !== undefined ? { placeholder: value.placeholder } : {}),
    ...(value.prefill !== undefined ? { prefill: value.prefill } : {}),
    createdAt: value.createdAt,
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
  };
}

function targetOf(value: NotifyTarget | undefined): NotifyTarget {
  if (!value) return { channel: "none" };
  return value.codexThreadId
    ? { channel: value.channel, codexThreadId: value.codexThreadId }
    : { channel: value.channel };
}

function sessionRefOf(ref: NonNullable<WorkerSummary["session"]["ref"]>) {
  return {
    runtime: ref.runtime,
    runtimeInstanceRef: ref.runtimeInstanceRef,
    ...(ref.sessionId !== undefined ? { sessionId: ref.sessionId } : {}),
    ...(ref.sessionLocator !== undefined ? { sessionLocator: ref.sessionLocator } : {}),
    ...(ref.cwd !== undefined ? { cwd: ref.cwd } : {}),
    ...(ref.capabilitiesObservedAt !== undefined
      ? { capabilitiesObservedAt: ref.capabilitiesObservedAt }
      : {}),
  };
}

function sessionDevelopmentOf(session: WorkerSummary["session"]) {
  return {
    available: session.available,
    restorable: session.restorable,
    ...(session.reason !== undefined ? { reason: session.reason } : {}),
    ...(session.ref ? { ref: sessionRefOf(session.ref) } : {}),
  };
}

function notificationBindingView(worker: WorkerSummary) {
  if (!worker.notificationBinding) return undefined;
  return {
    ...worker.notificationBinding,
    target: targetOf(worker.notificationBinding.target),
  };
}

/**
 * Development worker view: explicit diagnostic fields, never a raw WorkerSummary.
 * The prompt and promptPreview stay hidden in both modes.
 */
export function presentWorkerDevelopment(worker: WorkerSummary): Record<string, unknown> {
  const binding = notificationBindingView(worker);
  return {
    id: worker.id,
    runtime: worker.runtime,
    ...(worker.name !== undefined ? { name: worker.name } : {}),
    ...(worker.taskId !== undefined ? { taskId: worker.taskId } : {}),
    cwd: worker.cwd,
    status: worker.status,
    ...(worker.statusReason !== undefined ? { statusReason: worker.statusReason } : {}),
    createdAt: worker.createdAt,
    ...(worker.firstStartedAt !== undefined ? { firstStartedAt: worker.firstStartedAt } : {}),
    ...(worker.startedAt !== undefined ? { startedAt: worker.startedAt } : {}),
    ...(worker.endedAt !== undefined ? { endedAt: worker.endedAt } : {}),
    persistence: worker.persistence,
    lifecycle: worker.lifecycle,
    ...(worker.session ? { session: sessionDevelopmentOf(worker.session) } : {}),
    lastSeq: worker.lastSeq,
    eventCount: worker.eventCount,
    resumeCount: worker.resumeCount,
    resumeAvailable: worker.resumeAvailable,
    pidAlive: worker.pidAlive,
    ...(worker.pid !== undefined ? { pid: worker.pid } : {}),
    ...(worker.exit !== undefined ? { exit: { ...worker.exit } } : {}),
    ...adminFields(worker),
    ...(worker.result ? { result: resultOf(worker.result) } : {}),
    ...(worker.error !== undefined ? { error: worker.error } : {}),
    ...(worker.pendingInput ? { pendingInput: fullPendingInput(worker.pendingInput) } : {}),
    ...(worker.notifyTarget ? { notifyTarget: targetOf(worker.notifyTarget) } : {}),
    ...(binding ? { notificationBinding: binding } : {}),
  };
}

function sessionOf(session: WorkerSummary["session"]) {
  return {
    available: session.available,
    restorable: session.restorable,
    ...(session.reason !== undefined ? { reason: session.reason } : {}),
  };
}

/** New fields stay absent when an older daemon did not report them. */
function adminFields(worker: WorkerSummary): Record<string, unknown> {
  return {
    ...(worker.pinned === true ? { pinned: true } : {}),
    ...(worker.archived === true ? { archived: true } : {}),
    ...(worker.retiredAt !== undefined ? { retiredAt: worker.retiredAt } : {}),
  };
}

/** Pin/archive/retire result: identity plus management flags only. */
export function presentWorkerAdmin(worker: WorkerSummary, mode: McpPresentationMode): unknown {
  if (mode === "development") return presentWorkerDevelopment(worker);
  return {
    id: worker.id,
    status: worker.status,
    lifecycle: worker.lifecycle,
    ...adminFields(worker),
    lastSeq: worker.lastSeq,
  };
}

function workerBaseForProduction(worker: WorkerSummary) {
  return {
    id: worker.id,
    runtime: worker.runtime,
    ...(worker.name !== undefined ? { name: worker.name } : {}),
    ...(worker.taskId !== undefined ? { taskId: worker.taskId } : {}),
    status: worker.status,
    ...(worker.persistence !== undefined ? { persistence: worker.persistence } : {}),
    ...(worker.lifecycle !== undefined ? { lifecycle: worker.lifecycle } : {}),
    ...(worker.session ? { session: sessionOf(worker.session) } : {}),
    lastSeq: worker.lastSeq,
    resumeAvailable: worker.resumeAvailable,
  };
}

/** Wait carries the outcome: full result/error and the full pending input. */
function waitWorkerForProduction(worker: WorkerSummary) {
  return {
    ...workerBaseForProduction(worker),
    ...(worker.statusReason !== undefined ? { statusReason: worker.statusReason } : {}),
    ...(worker.result ? { result: resultOf(worker.result) } : {}),
    ...(worker.pendingInput ? { pendingInput: pendingOf(worker.pendingInput) } : {}),
    ...(worker.error !== undefined ? { error: worker.error } : {}),
  };
}

/** spawn/resume: acceptance plus (when already known) the actionable outcome. */
export function presentAcceptedWorker(worker: WorkerSummary, mode: McpPresentationMode): unknown {
  if (mode === "development") {
    return { ...presentWorkerDevelopment(worker), accepted: true };
  }
  const out: Record<string, unknown> = {
    id: worker.id,
    accepted: true,
    runtime: worker.runtime,
    status: worker.status,
    ...(worker.persistence !== undefined ? { persistence: worker.persistence } : {}),
    ...(worker.lifecycle !== undefined ? { lifecycle: worker.lifecycle } : {}),
    ...(worker.session ? { session: sessionOf(worker.session) } : {}),
    lastSeq: worker.lastSeq,
    notifyTarget: targetOf(worker.notifyTarget),
  };
  if (worker.name !== undefined) out.name = worker.name;
  if (worker.taskId !== undefined) out.taskId = worker.taskId;
  const binding = notificationBindingView(worker);
  if (binding) out.notificationBinding = binding;
  if (isTerminal(worker.status) || worker.status === "awaiting_input") {
    if (worker.result) out.result = resultOf(worker.result);
    if (worker.pendingInput) out.pendingInput = pendingOf(worker.pendingInput);
    if (worker.error !== undefined) out.error = worker.error;
    if (worker.statusReason !== undefined) out.statusReason = worker.statusReason;
  }
  return out;
}

export function presentStatus(
  result: WorkerStatusResult,
  mode: McpPresentationMode,
  options: { includeRecentEvents?: boolean; includeInput?: boolean } = {},
): unknown {
  if (mode === "development") {
    return {
      worker: presentWorkerDevelopment(result.worker),
      ...(result.lastProgress ? { lastProgress: result.lastProgress } : {}),
      ...(result.timeline ? { timeline: result.timeline } : {}),
      ...(result.inputState ? { inputState: result.inputState } : {}),
      recentEvents: result.recentEvents,
      stderrTail: result.stderrTail,
    };
  }
  // Production status is a snapshot: no recentEvents, lastProgress, timeline
  // or inputState. The compactStatus budget still bounds the result preview.
  // The preview is renamed and annotated after that budget is applied, so the
  // final response is measured again and the inner budget shrinks to fit.
  const build = (budgetBytes: number): Record<string, unknown> => {
    const compacted = compactStatus(result, {
      budgetBytes,
      eventLimit: 0,
      includeRecentEvents: false,
      includeLastProgress: false,
      includeTimeline: false,
      includeInputState: false,
      includeCwd: false,
      includeInput: options.includeInput === true,
    });
    const worker = compacted.worker as Record<string, unknown>;
    const resultView = worker.result;
    const errorView = worker.error;
    delete worker.result;
    delete worker.error;
    delete worker.cwd;
    if (resultView) {
      worker.resultPreview = resultView;
      worker.resultAvailable = true;
    } else {
      worker.resultAvailable = false;
    }
    if (errorView) {
      worker.errorPreview = errorView;
      worker.errorAvailable = true;
    } else {
      worker.errorAvailable = false;
    }
    const last = [...result.recentEvents]
      .reverse()
      .find((event) => isProductionEventType(event.type));
    if (last) worker.lastEvent = { seq: last.seq, type: last.type };
    if (compacted.budgetExceeded) return { worker, budgetExceeded: true };
    return { worker };
  };

  let budget = STATUS_BUDGET_BYTES;
  let view = build(budget);
  while (jsonBytes(view) > STATUS_BUDGET_BYTES && budget > 512) {
    budget = Math.max(512, budget - (jsonBytes(view) - STATUS_BUDGET_BYTES + 64));
    view = build(budget);
  }
  return view;
}

export function presentWait(
  result: WaitResult,
  compacted: { events: WorkerEvent[]; eventsOmitted: number; progressOmitted?: number },
  mode: McpPresentationMode,
  options: { includeEvents?: boolean } = {},
): unknown {
  if (mode === "development") {
    return {
      worker: presentWorkerDevelopment(result.worker),
      events: compacted.events,
      eventsOmitted: compacted.eventsOmitted,
      nextSeq: result.nextSeq,
      hasMore: result.hasMore,
      timedOut: result.timedOut,
      terminal: result.terminal,
      ...(result.lastProgress ? { lastProgress: result.lastProgress } : {}),
      ...(result.timeline ? { timeline: result.timeline } : {}),
      ...(result.inputState ? { inputState: result.inputState } : {}),
    };
  }
  const out: Record<string, unknown> = {
    worker: waitWorkerForProduction(result.worker),
    terminal: result.terminal,
    timedOut: result.timedOut,
    nextSeq: result.nextSeq,
    hasMore: result.hasMore,
  };
  // A timeout is a status check, not an event dump. Lifecycle events are only
  // an explicit `until=event` result; completion/failure/input are carried by
  // worker.result, worker.error and worker.pendingInput.
  if (!result.timedOut && options.includeEvents) {
    const visible = compacted.events.filter((event) => isProductionEventType(event.type));
    // until=event can carry the whole scanned window; bound it like worker_events
    // so a long batch cannot turn a wait into an event dump.
    const packed = packCompactEvents(visible, result.worker, {
      limit: MAX_COMPACT_EVENTS,
      budgetBytes: EVENTS_BUDGET_BYTES,
    });
    out.events = packed.events;
    out.eventsOmitted =
      compacted.eventsOmitted +
      (compacted.events.length - visible.length) +
      packed.omitted;
    out.progressOmitted = compacted.progressOmitted ?? 0;
  }
  return out;
}

/** Development event read: full stored events behind the explicit worker whitelist. */
export function presentEventsDevelopment(result: ReadEventsResult): unknown {
  return {
    worker: presentWorkerDevelopment(result.worker),
    events: result.events,
    nextSeq: result.nextSeq,
    hasMore: result.hasMore,
  };
}

export function presentWorkerList(
  workers: WorkerSummary[],
  mode: McpPresentationMode,
  page: { nextCursor: string | null; hasMore: boolean } = {
    nextCursor: null,
    hasMore: false,
  },
): unknown {
  if (mode === "development") {
    return {
      workers: workers.map(presentWorkerDevelopment),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
  return {
    workers: workers.map((worker) => ({
      id: worker.id,
      ...(worker.name !== undefined ? { name: worker.name } : {}),
      ...(worker.taskId !== undefined ? { taskId: worker.taskId } : {}),
      runtime: worker.runtime,
      status: worker.status,
      persistence: worker.persistence,
      lifecycle: worker.lifecycle,
      needsInput: worker.status === "awaiting_input",
      lastSeq: worker.lastSeq,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/** send/answer/cancel: the operation result and current state, never a completion claim. */
export function presentWorkerAction(worker: WorkerSummary, mode: McpPresentationMode): unknown {
  if (mode === "development") {
    return {
      ...presentWorkerDevelopment(worker),
      accepted: true,
      terminal: isTerminal(worker.status),
    };
  }
  return {
    id: worker.id,
    accepted: true,
    status: worker.status,
    terminal: isTerminal(worker.status),
    lastSeq: worker.lastSeq,
    ...(worker.statusReason !== undefined ? { statusReason: worker.statusReason } : {}),
  };
}

export function presentInfo(
  info: SupervisorInfo,
  mode: McpPresentationMode,
  mcpMode: McpPresentationMode,
  mcpModeSource: ResolvedMcpMode["source"] = "default",
): unknown {
  if (mode === "development") {
    return {
      version: info.version,
      mcpMode,
      mcpModeSource,
      running: true,
      pid: info.pid,
      stateDir: info.stateDir,
      supervisorId: info.supervisorId,
      startedAt: info.startedAt,
      uptimeMs: info.uptimeMs,
      limits: { ...info.limits },
      wake: { ...info.wake },
      ...(info.codexSteer
        ? {
            codexSteer: {
              status: info.codexSteer.status,
              verified: { ...info.codexSteer.verified },
              reason: info.codexSteer.reason,
            },
          }
        : {}),
      runtimes: info.runtimes.map((runtime) => ({
        runtime: runtime.runtime,
        steer: runtime.steer,
        followUp: runtime.followUp,
        cancel: runtime.cancel,
        resume: runtime.resume,
        pause: runtime.pause,
        interactiveInput: runtime.interactiveInput,
        ...(runtime.idleContinue !== undefined ? { idleContinue: runtime.idleContinue } : {}),
        notes: runtime.notes,
      })),
      ...(info.storage
        ? {
            storage: {
              workers: info.storage.workers,
              eventBytes: info.storage.eventBytes,
              largestEventFileBytes: info.storage.largestEventFileBytes,
              ...(info.storage.largestEventWorkerId !== undefined
                ? { largestEventWorkerId: info.storage.largestEventWorkerId }
                : {}),
              activeWorkers: info.storage.activeWorkers,
              idleWorkers: info.storage.idleWorkers,
              otherWorkers: info.storage.otherWorkers,
              startup: {
                totalMs: info.storage.startup.totalMs,
                storeInitMs: info.storage.startup.storeInitMs,
                store: { ...info.storage.startup.store },
              },
            },
          }
        : {}),
    };
  }
  return {
    version: info.version,
    mcpMode,
    running: true,
    runtimes: info.runtimes.map((runtime) => ({
      runtime: runtime.runtime,
      available: true,
    })),
    ...(info.storage
      ? {
          workers: {
            active: info.storage.activeWorkers,
            total: info.storage.workers,
          },
        }
      : { workersKnown: false }),
  };
}

function summaryOf(record: NotificationRecord) {
  return {
    ...(record.summary.status !== undefined ? { status: record.summary.status } : {}),
    ...(record.summary.text !== undefined ? { text: record.summary.text } : {}),
    ...(record.summary.requestId !== undefined
      ? { requestId: record.summary.requestId }
      : {}),
    ...(record.summary.method !== undefined ? { method: record.summary.method } : {}),
    ...(record.summary.options !== undefined ? { options: [...record.summary.options] } : {}),
  };
}

function notificationForProduction(record: NotificationRecord) {
  return {
    id: record.id,
    workerId: record.workerId,
    seq: record.seq,
    eventType: record.eventType,
    kind: record.kind,
    createdAt: record.createdAt,
    summary: summaryOf(record),
    deliveryState: record.delivery.state,
    acked: Boolean(record.ackAt),
    actionable: record.actionable ?? (!record.ackAt && record.delivery.state !== "superseded"),
    ...(record.staleReason !== undefined ? { staleReason: record.staleReason } : {}),
  };
}

function notificationForDevelopment(record: NotificationRecord) {
  return {
    id: record.id,
    workerId: record.workerId,
    runtime: record.runtime,
    seq: record.seq,
    eventType: record.eventType,
    kind: record.kind,
    createdAt: record.createdAt,
    summary: summaryOf(record),
    delivery: { ...record.delivery },
    ...(record.target ? { target: { ...record.target } } : {}),
    acked: Boolean(record.ackAt),
    ...(record.ackAt ? { ackAt: record.ackAt } : {}),
    ...(record.ackBy ? { ackBy: record.ackBy } : {}),
    actionable: record.actionable ?? (!record.ackAt && record.delivery.state !== "superseded"),
    ...(record.staleReason !== undefined ? { staleReason: record.staleReason } : {}),
  };
}

export function presentNotifications(
  result: NotificationsResult,
  mode: McpPresentationMode,
): unknown {
  if (mode === "development") {
    return {
      notifications: result.notifications.map(notificationForDevelopment),
      counts: result.counts,
      ...(result.filteredCounts ? { filteredCounts: result.filteredCounts } : {}),
      ...(result.globalCounts ? { globalCounts: result.globalCounts } : {}),
      ...(result.scope ? { scope: result.scope } : {}),
      target: { ...result.target },
    };
  }
  return {
    notifications: result.notifications.map(notificationForProduction),
    // `counts` is the legacy whole-inbox view. The two explicit fields below
    // make the distinction visible; `scope` says what `filteredCounts` covers.
    // On an older daemon only `counts` exists; do not relabel it as filtered.
    counts: result.counts,
    countsScope: "global",
    ...(result.filteredCounts ? { filteredCounts: result.filteredCounts } : {}),
    ...(result.globalCounts ? { globalCounts: result.globalCounts } : {}),
    ...(result.scope ? { scope: result.scope } : {}),
  };
}

export function presentNotifyTarget(target: NotifyTarget, mode: McpPresentationMode): unknown {
  const base = {
    channel: target.channel,
    ...(target.codexThreadId !== undefined
      ? { codexThreadId: target.codexThreadId }
      : {}),
    configured: target.channel !== "none" && target.codexThreadId !== undefined,
  };
  if (mode === "development") {
    return {
      ...base,
      ...(target.updatedAt !== undefined ? { updatedAt: target.updatedAt } : {}),
    };
  }
  return base;
}

export function presentNotificationAck(
  result: { acked: number; missing: string[] },
  mode: McpPresentationMode,
  requestedIds: string[],
  by?: string,
): unknown {
  const out = {
    requested: requestedIds.length,
    acked: result.acked,
    missing: [...result.missing],
    ...(by !== undefined ? { by } : {}),
  };
  if (mode === "development") {
    return { ...out, requestedIds: [...requestedIds] };
  }
  return out;
}

export function presentForgetResult(
  result: { workerId: string; forgotten: boolean; sessionPreserved: true; note: string },
  _mode: McpPresentationMode,
): unknown {
  return {
    workerId: result.workerId,
    forgotten: result.forgotten,
    sessionPreserved: result.sessionPreserved,
    note: result.note,
  };
}

function taskSummaryForProduction(task: TaskRecord) {
  return {
    taskId: task.id,
    title: task.title,
    ...(task.category !== undefined ? { category: task.category } : {}),
    createdAt: task.createdAt,
    workerIds: [...task.workerIds],
    ...(task.parentSessionRef !== undefined ? { parentSessionRef: task.parentSessionRef } : {}),
  };
}

function taskForDevelopment(task: TaskRecord) {
  return {
    schemaVersion: task.schemaVersion,
    id: task.id,
    title: task.title,
    ...(task.category !== undefined ? { category: task.category } : {}),
    executionMode: task.executionMode,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    workerIds: [...task.workerIds],
    ...(task.parentSessionRef !== undefined ? { parentSessionRef: task.parentSessionRef } : {}),
    acceptanceStatus: task.acceptanceStatus,
    ...(task.firstAcceptancePassed !== undefined
      ? { firstAcceptancePassed: task.firstAcceptancePassed }
      : {}),
    ...(task.reworkCount !== undefined ? { reworkCount: task.reworkCount } : {}),
    ...(task.interventionCount !== undefined
      ? { interventionCount: task.interventionCount }
      : {}),
    createdBy: task.createdBy,
  };
}

export function presentTaskCreated(task: TaskRecord, mode: McpPresentationMode): unknown {
  if (mode === "development") return taskForDevelopment(task);
  return taskSummaryForProduction(task);
}

function taskWorkerView(
  worker: TaskMetrics["workers"][number],
  mode: McpPresentationMode,
) {
  if (mode === "production") {
    return {
      workerId: worker.workerId,
      missing: worker.missing,
      ...(worker.status !== undefined ? { status: worker.status } : {}),
      ...(worker.runMs !== undefined ? { runMs: worker.runMs } : {}),
      ...(worker.runMsUnknownReason !== undefined
        ? { runMsUnknownReason: worker.runMsUnknownReason }
        : {}),
    };
  }
  return {
    workerId: worker.workerId,
    missing: worker.missing,
    ...(worker.runtime !== undefined ? { runtime: worker.runtime } : {}),
    ...(worker.status !== undefined ? { status: worker.status } : {}),
    ...(worker.createdAt !== undefined ? { createdAt: worker.createdAt } : {}),
    ...(worker.firstStartedAt !== undefined ? { firstStartedAt: worker.firstStartedAt } : {}),
    ...(worker.startedAt !== undefined ? { startedAt: worker.startedAt } : {}),
    ...(worker.endedAt !== undefined ? { endedAt: worker.endedAt } : {}),
    ...(worker.resumeCount !== undefined ? { resumeCount: worker.resumeCount } : {}),
    ...(worker.runMs !== undefined ? { runMs: worker.runMs } : {}),
    ...(worker.runMsUnknownReason !== undefined
      ? { runMsUnknownReason: worker.runMsUnknownReason }
      : {}),
  };
}

export function presentTaskMetrics(metrics: TaskMetrics, mode: McpPresentationMode): unknown {
  const out: Record<string, unknown> = {
    task: mode === "development"
      ? taskForDevelopment(metrics.task)
      : taskSummaryForProduction(metrics.task),
    status: metrics.status,
    timing: { ...metrics.timing },
    workers: metrics.workers.map((worker) => taskWorkerView(worker, mode)),
    usageSummary: {
      worker: { ...metrics.usageSummary.worker },
      parentAttributable: { ...metrics.usageSummary.parentAttributable },
      parentSessionLevel: { ...metrics.usageSummary.parentSessionLevel },
      unverified: { ...metrics.usageSummary.unverified },
    },
    warnings: [...metrics.warnings],
    unknownFields: [...metrics.unknownFields],
  };
  if (mode === "development") {
    out.usage = metrics.usage.map((record) => presentUsageRecord(record, "development"));
  }
  return out;
}

export function presentUsageRecord(record: UsageRecord, mode: McpPresentationMode): unknown {
  const base = {
    usageId: record.id,
    taskId: record.taskId,
    role: record.role,
    ...(record.workerId !== undefined ? { workerId: record.workerId } : {}),
    recordedAt: record.recordedAt,
    confidence: record.confidence,
    attribution: record.attribution,
    ...(record.provider !== undefined ? { provider: record.provider } : {}),
    ...(record.modelId !== undefined ? { modelId: record.modelId } : {}),
    ...(record.harness !== undefined ? { harness: record.harness } : {}),
  };
  if (mode === "production") return base;
  return {
    ...base,
    schemaVersion: record.schemaVersion,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    reportedTotalTokens: record.reportedTotalTokens,
    usageSource: record.usageSource,
    ...(record.note !== undefined ? { note: record.note } : {}),
  };
}

export function presentMetricsReport(report: MetricsReport, mode: McpPresentationMode): unknown {
  const out: Record<string, unknown> = {
    generatedAt: report.generatedAt,
    period: { ...report.period },
    taskCount: report.taskCount,
    workerCount: report.workerCount,
    counts: { ...report.counts },
    usageCoverage: { ...report.usageCoverage },
    knownWorkerUsage: { ...report.knownWorkerUsage },
    knownParentUsage: { ...report.knownParentUsage },
    sessionLevelParentUsage: { ...report.sessionLevelParentUsage },
    unverifiedUsage: { ...report.unverifiedUsage },
    durationStats: {
      endToEnd: { ...report.durationStats.endToEnd },
      workerRun: { ...report.durationStats.workerRun },
      waiting: { ...report.durationStats.waiting },
      note: report.durationStats.note,
    },
    notTracked: { ...report.notTracked },
    unknownFields: [...report.unknownFields],
    dataQualityWarnings: [...report.dataQualityWarnings],
    ...(report.tasksTruncated !== undefined ? { tasksTruncated: report.tasksTruncated } : {}),
  };
  if (report.tasks) {
    out.tasks = mode === "development"
      ? report.tasks.map((task) => presentTaskMetrics(task, "development"))
      : report.tasks.map((task) => ({
          taskId: task.task.id,
          title: task.task.title,
          status: task.status,
          createdAt: task.task.createdAt,
          workerCount: task.workers.length,
          endToEndMs: task.timing.endToEndMs,
        }));
  }
  return out;
}

/**
 * Production errors keep the code, the actionable message and the identifiers
 * needed to reason about CONFLICT/UNCERTAIN. Full diagnostic details stay in
 * development mode.
 */
export function formatToolError(error: unknown, mode: McpPresentationMode): string {
  const code = error instanceof SupervisorError ? error.code : "INTERNAL";
  const base = `${code}: ${errorMessage(error)}`;
  if (mode === "development") {
    return error instanceof SupervisorError && error.details
      ? `${base}\n${JSON.stringify(error.details, null, 2)}`
      : base;
  }
  const details = error instanceof SupervisorError ? error.details : undefined;
  if (!details) return base;
  const identifiers: string[] = [];
  for (const key of [
    "requestId",
    "workerId",
    "status",
    "reason",
    "inputState",
    "expiresAt",
    "pendingRequestId",
  ] as const) {
    const value = details[key];
    if (typeof value === "string" && value.length > 0) {
      identifiers.push(`${key}=${value}`);
    }
  }
  if (Array.isArray(details.nextActions) && details.nextActions.length > 0) {
    identifiers.push(`next=${details.nextActions.filter((item) => typeof item === "string").join("|")}`);
  }
  return identifiers.length > 0 ? `${base} (${identifiers.join(", ")})` : base;
}
