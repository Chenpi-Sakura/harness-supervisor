import { isTerminal, type WorkerEvent, type WorkerInputState, type WorkerRecord } from "./types.js";

/** Recompute time-dependent fields that must not be frozen by a cached view. */
export function refreshInputStateTime(
  state: WorkerInputState | undefined,
  now = Date.now(),
): WorkerInputState | undefined {
  if (!state || state.state !== "pending" || !state.expiresAt) return state;
  const expiresInMs = Date.parse(state.expiresAt) - now;
  if (!Number.isFinite(expiresInMs)) return state;
  const { note: _note, ...rest } = state;
  return {
    ...rest,
    expiresInMs: Math.trunc(expiresInMs),
    ...(expiresInMs <= 0
      ? { note: "The deadline has passed; the supervisor is about to clear this request." }
      : {}),
  };
}

type Outcome =
  | { kind: "request"; event: WorkerEvent; requestId: string; method?: WorkerInputState["method"]; expiresAt?: string; createdAt: string }
  | { kind: "answered"; event: WorkerEvent; requestId: string; outcome: WorkerInputState["outcome"]; at: string }
  | { kind: "expired"; event: WorkerEvent; requestId: string; at: string }
  | { kind: "withdrawn"; event: WorkerEvent; requestId: string; at: string };

function methodOf(value: unknown): WorkerInputState["method"] | undefined {
  return value === "select" || value === "confirm" || value === "input" || value === "editor"
    ? value
    : undefined;
}

function answerOutcome(data: Record<string, unknown> | undefined): WorkerInputState["outcome"] {
  if (data?.outcome === "cancelled" || data?.outcome === "confirmed" || data?.outcome === "value") {
    return data.outcome;
  }
  if (data?.cancelled === true) return "cancelled";
  if (typeof data?.confirmed === "boolean") return "confirmed";
  return "value";
}

/**
 * Derive the current or last input request from the record + event log.
 * `pendingInput` is authoritative while it exists. After it is cleared, the
 * newest correlated event explains whether it was answered, expired or
 * withdrawn; an unresolved request on a terminal worker is reported as closed,
 * never as still answerable.
 */
export function buildInputState(
  record: WorkerRecord,
  events: readonly WorkerEvent[],
): WorkerInputState | undefined {
  const pending = record.pendingInput;
  if (pending) {
    if (isTerminal(record.status)) {
      return {
        state: "closed",
        requestId: pending.requestId,
        method: pending.method,
        createdAt: pending.createdAt,
        ...(pending.expiresAt !== undefined ? { expiresAt: pending.expiresAt } : {}),
        nextActions: record.status === "orphaned" ? ["worker_status"] : ["worker_resume"],
        note: "The worker is already terminal, so this recorded request cannot be answered.",
      };
    }
    const expiresInMs = pending.expiresAt
      ? Date.parse(pending.expiresAt) - Date.now()
      : undefined;
    return {
      state: "pending",
      requestId: pending.requestId,
      method: pending.method,
      createdAt: pending.createdAt,
      ...(pending.expiresAt !== undefined ? { expiresAt: pending.expiresAt } : {}),
      ...(expiresInMs !== undefined && Number.isFinite(expiresInMs)
        ? { expiresInMs: Math.trunc(expiresInMs) }
        : {}),
      nextActions: ["worker_answer"],
      ...(expiresInMs !== undefined && Number.isFinite(expiresInMs) && expiresInMs <= 0
        ? { note: "The deadline has passed; the supervisor is about to clear this request." }
        : {}),
    };
  }

  let latest: Outcome | undefined;
  let lastRequest:
    | { requestId: string; method?: WorkerInputState["method"]; createdAt: string; expiresAt?: string }
    | undefined;
  for (const event of events) {
    const data = event.data;
    if (event.type === "run.needs_input") {
      const requestId = typeof data?.requestId === "string" ? data.requestId : undefined;
      if (!requestId) continue;
      lastRequest = {
        requestId,
        method: methodOf(data?.method),
        createdAt: event.ts,
        expiresAt: typeof data?.expiresAt === "string" ? data.expiresAt : undefined,
      };
      latest = { kind: "request", event, ...lastRequest };
      continue;
    }
    if (event.type === "run.input_answered") {
      const requestId = typeof data?.requestId === "string" ? data.requestId : undefined;
      if (!requestId) continue;
      latest = {
        kind: "answered",
        event,
        requestId,
        outcome: answerOutcome(data),
        at: event.ts,
      };
      continue;
    }
    if (event.type !== "run.progress") continue;
    const kind = typeof data?.kind === "string" ? data.kind : "";
    if (kind === "input_timeout" || kind === "permission_timeout") {
      const requestId =
        typeof data?.requestId === "string"
          ? data.requestId
          : latest?.kind === "request"
            ? latest.requestId
            : undefined;
      if (!requestId) continue;
      latest = { kind: "expired", event, requestId, at: event.ts };
      continue;
    }
    if (kind === "input_withdrawn" || kind === "permission_withdrawn") {
      const requestId =
        typeof data?.requestId === "string"
          ? data.requestId
          : typeof data?.detail === "string"
            ? data.detail
            : undefined;
      if (!requestId) continue;
      latest = { kind: "withdrawn", event, requestId, at: event.ts };
    }
  }
  if (!latest) return undefined;

  if (latest.kind === "answered") {
    return {
      state: "answered",
      requestId: latest.requestId,
      outcome: latest.outcome,
      answeredAt: latest.at,
      nextActions: ["worker_status", "worker_wait"],
    };
  }
  if (latest.kind === "expired") {
    const request = lastRequest?.requestId === latest.requestId ? lastRequest : undefined;
    return {
      state: "expired",
      requestId: latest.requestId,
      ...(request?.method !== undefined ? { method: request.method } : {}),
      ...(request?.createdAt !== undefined ? { createdAt: request.createdAt } : {}),
      ...(request?.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      nextActions: ["worker_status", "worker_resume"],
      note: "The native request is no longer answerable. Resume the same session with a new instruction; do not retry worker_answer.",
    };
  }
  if (latest.kind === "withdrawn") {
    return {
      state: "withdrawn",
      requestId: latest.requestId,
      nextActions: ["worker_status"],
      note: "The harness withdrew the request; worker_answer is no longer valid.",
    };
  }
  if (isTerminal(record.status)) {
    return {
      state: "closed",
      requestId: latest.requestId,
      method: latest.method,
      createdAt: latest.createdAt,
      ...(latest.expiresAt !== undefined ? { expiresAt: latest.expiresAt } : {}),
      nextActions: record.status === "orphaned" ? ["worker_status"] : ["worker_resume"],
      note: "The worker ended without a recorded answer. The original request cannot be answered; resume the session to continue.",
    };
  }
  return {
    state: "unknown",
    requestId: latest.requestId,
    method: latest.method,
    createdAt: latest.createdAt,
    nextActions: ["worker_status"],
    note: "A request was recorded but is no longer pending and no answer/timeout was observed.",
  };
}