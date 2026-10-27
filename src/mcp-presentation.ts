/**
 * MCP presentation layer.
 *
 * The presentation mode belongs to one MCP process; it never changes the
 * supervisor, the daemon or the persisted records. `production` returns only
 * the information a caller needs to run and observe a task, while
 * `development` keeps the pre-0.3.0 full JSON payloads for existing tooling.
 *
 * These are explicit field whitelists per tool, not a recursive redaction
 * pass: a report or answer written by the worker is never mistaken for a
 * management field.
 */
import { SupervisorError, errorMessage } from "./errors.js";
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

/** Management-only event data keys. Everything else is process fact or user content. */
const EVENT_DATA_MANAGEMENT_KEYS = new Set([
  "pid",
  "sessionId",
  "sessionFile",
  "fileExists",
  "supervisorId",
  "notifyTarget",
]);

function eventDataForProduction(data: Record<string, unknown> | undefined) {
  if (!data) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (EVENT_DATA_MANAGEMENT_KEYS.has(key)) continue;
    kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

interface EventViewOptions {
  /**
   * Only set for wait responses, where worker.result is also returned. The
   * completion text is removed only when the event belongs to the current run
   * and its text is provably contained in that result. Historical completions
   * and unverifiable cases keep their stored text.
   */
  currentRun?: WorkerSummary;
}

const TRUNCATION_SUFFIX = /^(.*)\n\.\.\.\[truncated \d+ chars\]$/s;

/**
 * Event text is stored with a visible truncation suffix. Compare only the
 * original prefix so a larger worker.result can still be recognized as the
 * same completion. If the marker is absent or malformed, keep the text as-is;
 * an unverifiable match must preserve the event.
 */
function eventCompletionPrefix(event: WorkerEvent): string | null {
  const text = event.data?.text;
  if (typeof text !== "string") return null;
  if (event.data?.truncated !== true) return text;
  const match = TRUNCATION_SUFFIX.exec(text);
  return match ? match[1]! : text;
}

function completionTextIsCurrentResult(event: WorkerEvent, worker: WorkerSummary): boolean {
  if (event.type !== "run.completed" || !worker.result || !worker.startedAt) return false;
  const prefix = eventCompletionPrefix(event);
  if (prefix === null) return false;
  const startedMs = Date.parse(worker.startedAt);
  const eventMs = Date.parse(event.ts);
  if (!Number.isFinite(startedMs) || !Number.isFinite(eventMs) || eventMs < startedMs) {
    return false;
  }
  // The event text is normally a prefix of the (larger) result text. If either
  // limit is configured the other way around, preserve the event text instead
  // of risking silent data loss.
  return worker.result.text.startsWith(prefix);
}

/** Deduplicate only the current run's completion text that is already in worker.result. */
function eventForProduction(event: WorkerEvent, options: EventViewOptions = {}) {
  let data = eventDataForProduction(event.data);
  if (
    options.currentRun &&
    data &&
    "text" in data &&
    completionTextIsCurrentResult(event, options.currentRun)
  ) {
    const { text: _text, truncated: _truncated, ...rest } = data;
    data = Object.keys(rest).length > 0 ? rest : undefined;
  }
  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    ...(data ? { data } : {}),
  };
}

function eventsForProduction(events: WorkerEvent[], options: EventViewOptions = {}) {
  return events.map((event) => eventForProduction(event, options));
}

function statusWorkerForProduction(worker: WorkerSummary) {
  return {
    id: worker.id,
    runtime: worker.runtime,
    ...(worker.name !== undefined ? { name: worker.name } : {}),
    ...(worker.taskId !== undefined ? { taskId: worker.taskId } : {}),
    cwd: worker.cwd,
    status: worker.status,
    lastSeq: worker.lastSeq,
    ...(worker.statusReason !== undefined ? { statusReason: worker.statusReason } : {}),
    ...(worker.result ? { result: resultOf(worker.result) } : {}),
    ...(worker.pendingInput ? { pendingInput: pendingOf(worker.pendingInput) } : {}),
    ...(worker.error !== undefined ? { error: worker.error } : {}),
    resumeAvailable: worker.resumeAvailable,
  };
}

/** spawn/resume: acceptance plus (when already known) the actionable outcome. */
export function presentAcceptedWorker(worker: WorkerSummary, mode: McpPresentationMode): unknown {
  if (mode === "development") return worker;
  const out: Record<string, unknown> = {
    id: worker.id,
    runtime: worker.runtime,
    status: worker.status,
    lastSeq: worker.lastSeq,
    notifyTarget: targetOf(worker.notifyTarget),
  };
  if (worker.name !== undefined) out.name = worker.name;
  if (worker.taskId !== undefined) out.taskId = worker.taskId;
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
  options: { includeRecentEvents: boolean },
): unknown {
  if (mode === "development") return result;
  const out: Record<string, unknown> = {
    worker: statusWorkerForProduction(result.worker),
  };
  if (options.includeRecentEvents) {
    out.recentEvents = eventsForProduction(result.recentEvents);
  }
  return out;
}

export function presentWait(
  result: WaitResult,
  compacted: { events: WorkerEvent[]; eventsOmitted: number },
  mode: McpPresentationMode,
): unknown {
  if (mode === "development") {
    return { ...result, events: compacted.events, eventsOmitted: compacted.eventsOmitted };
  }
  return {
    worker: statusWorkerForProduction(result.worker),
    events: eventsForProduction(compacted.events, { currentRun: result.worker }),
    eventsOmitted: compacted.eventsOmitted,
    nextSeq: result.nextSeq,
    hasMore: result.hasMore,
    timedOut: result.timedOut,
    terminal: result.terminal,
  };
}

export function presentEvents(result: ReadEventsResult, mode: McpPresentationMode): unknown {
  if (mode === "development") return result;
  return {
    worker: {
      id: result.worker.id,
      status: result.worker.status,
      lastSeq: result.worker.lastSeq,
    },
    events: eventsForProduction(result.events),
    nextSeq: result.nextSeq,
    hasMore: result.hasMore,
  };
}

export function presentWorkerList(workers: WorkerSummary[], mode: McpPresentationMode): unknown {
  if (mode === "development") return workers;
  return workers.map((worker) => ({
    id: worker.id,
    ...(worker.name !== undefined ? { name: worker.name } : {}),
    ...(worker.taskId !== undefined ? { taskId: worker.taskId } : {}),
    runtime: worker.runtime,
    status: worker.status,
    lastSeq: worker.lastSeq,
  }));
}

/** send/answer/cancel: the operation result and current state, never a completion claim. */
export function presentWorkerAction(worker: WorkerSummary, mode: McpPresentationMode): unknown {
  if (mode === "development") return worker;
  return {
    id: worker.id,
    status: worker.status,
    lastSeq: worker.lastSeq,
    ...(worker.statusReason !== undefined ? { statusReason: worker.statusReason } : {}),
  };
}

const PRODUCTION_RUNTIME_NOTES: Record<string, string> = {
  pi: "Native Pi RPC. Steering/follow-ups use Pi queues. Cancel uses abort. Resume loads a persisted session.",
  qoder:
    "Qoder CLI stream-json. Steer/follow-up messages are accepted by the stream, but a real 1.1.76 run did not apply an accepted steer to the running turn: unverified effect. Cancel was validated (interrupt + process termination). Permission prompts surface as awaiting_input; AskUserQuestion was validated, allow/deny for Bash calls was not exercised end to end. Resume uses --resume and verifies the returned session id.",
  mcode:
    "MiniMax Code ACP over ndJSON stdio. Steering is verified inside an active turn (the agent acted on it); a steer sent after the turn ended is dropped, so the turn must still be alive. Follow-ups are queued through the agent's queue extension. Cancel was validated on a real run. Permission prompts surface as awaiting_input and are answered with the offered option. Resume loads the recorded ACP session id.",
};

/**
 * A runtime the production table does not know about must not fall back to the
 * adapter's own note: those run to over a thousand characters, and the
 * production mode exists to keep the response small. The full notes stay
 * available in development mode and through the CLI.
 */
const UNREGISTERED_RUNTIME_NOTE =
  "Runtime adapter; its capability details are available in development mode and through the CLI.";

export function presentInfo(
  info: SupervisorInfo,
  mode: McpPresentationMode,
  mcpMode: McpPresentationMode,
): unknown {
  if (mode === "development") return info;
  return {
    version: info.version,
    mcpMode,
    limits: {
      maxWorkers: info.limits.maxWorkers,
      maxWaitMs: info.limits.maxWaitMs,
      defaultWaitMs: info.limits.defaultWaitMs,
      maxResultBytes: info.limits.maxResultBytes,
      maxEventStringBytes: info.limits.maxEventStringBytes,
    },
    wake: {
      proactive: info.wake.proactive,
      channel: info.wake.channel,
      ...(info.wake.codexThreadId !== undefined
        ? { codexThreadId: info.wake.codexThreadId }
        : {}),
      note:
        "Pull-based reads; this is the default route for NEW workers and each worker/event keeps its own snapshot. codex-queue delivery can start a turn only while the host has that thread loaded. Delivery is at-least-once and does not prove wake-up.",
    },
    runtimes: info.runtimes.map((runtime) => ({
      runtime: runtime.runtime,
      steer: runtime.steer,
      followUp: runtime.followUp,
      cancel: runtime.cancel,
      resume: runtime.resume,
      pause: runtime.pause,
      interactiveInput: runtime.interactiveInput,
      notes: PRODUCTION_RUNTIME_NOTES[runtime.runtime] ?? UNREGISTERED_RUNTIME_NOTE,
    })),
  };
}

function notificationForProduction(record: NotificationRecord, includeDelivery = false) {
  return {
    id: record.id,
    workerId: record.workerId,
    kind: record.kind,
    summary: {
      ...(record.summary.status !== undefined ? { status: record.summary.status } : {}),
      ...(record.summary.text !== undefined ? { text: record.summary.text } : {}),
      ...(record.summary.requestId !== undefined
        ? { requestId: record.summary.requestId }
        : {}),
      ...(record.summary.method !== undefined ? { method: record.summary.method } : {}),
      ...(record.summary.options !== undefined ? { options: [...record.summary.options] } : {}),
    },
    acked: Boolean(record.ackAt),
    ...(includeDelivery ? {
      createdAt: record.createdAt,
      ...(record.ackAt ? { ackAt: record.ackAt } : {}),
      delivery: { ...record.delivery },
      ...(record.target ? { target: { ...record.target } } : {}),
    } : {}),
    ...(record.delivery.state === "superseded" ? { actionable: false } : {}),
  };
}

export function presentNotifications(
  result: NotificationsResult,
  mode: McpPresentationMode,
  includeDelivery = false,
): unknown {
  if (mode === "development") return result;
  return {
    notifications: result.notifications.map(record => notificationForProduction(record, includeDelivery)),
    counts: result.counts,
  };
}

export function presentNotifyTarget(target: NotifyTarget, mode: McpPresentationMode): unknown {
  if (mode === "development") return target;
  return targetOf(target);
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
  for (const key of ["requestId", "workerId", "status", "pendingRequestId"] as const) {
    const value = details[key];
    if (typeof value === "string" && value.length > 0) {
      identifiers.push(`${key}=${value}`);
    }
  }
  return identifiers.length > 0 ? `${base} (${identifiers.join(", ")})` : base;
}
