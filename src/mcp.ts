#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callerMetaRejection, callerThreadFromMeta } from "./caller-thread.js";
import { SupervisorError, errorMessage } from "./errors.js";
import { SupervisorClient } from "./ipc/client.js";
import { resolveStateDir, NotifyTargetSchema, OwnerRefSchema } from "./ipc/protocol.js";
import {
  EVENTS_BUDGET_BYTES,
  MAX_COMPACT_EVENTS,
  MAX_EVENT_SUMMARY_CHARS,
  compactEvent,
  lifecycleEvents,
  readCompactEvents,
  singleEventView,
  singleProductionEventView,
} from "./context-budget.js";
import { filterProductionEvents, isProductionEventType, PRODUCTION_EVENT_TYPES } from "./event-policy.js";
import {
  formatToolError,
  presentAcceptedWorker,
  presentEventsDevelopment,
  presentForgetResult,
  presentInfo,
  presentMetricsReport,
  presentNotificationAck,
  presentNotifications,
  presentNotifyTarget,
  presentStatus,
  presentTaskCreated,
  presentTaskMetrics,
  presentUsageRecord,
  presentWait,
  presentWorkerAdmin,
  presentWorkerAction,
  presentWorkerList,
  resolveMcpMode,
  type McpPresentationMode,
  type ResolvedMcpMode,
} from "./mcp-presentation.js";
import {
  isTerminal,
  type ExtensionUiResponse,
  type ForgetWorkerResult,
  type NotificationsResult,
  type NotifyTarget,
  type ReadEventsResult,
  type SendMode,
  type SupervisorInfo,
  type WaitResult,
  type WorkerEvent,
  type WorkerStatus,
  type WorkerStatusResult,
  type WorkerSummary,
} from "./types.js";
import type {
  MetricsReport,
  TaskCreateInput,
  TaskMetrics,
  TaskRecord,
  UsageRecord,
  UsageRecordInput,
} from "./metrics.js";
import { VERSION } from "./version.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Accept both "--mode production" and "--mode=production"; reject a missing value. */
function modeArgument(): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith("--mode="));
  if (inline !== undefined) return inline.slice("--mode=".length);
  const index = process.argv.indexOf("--mode");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new SupervisorError(
      "BAD_REQUEST",
      '--mode requires a value: "production" or "development"',
    );
  }
  return value;
}

function resolveModeOrExit(): ResolvedMcpMode {
  try {
    return resolveMcpMode(modeArgument());
  } catch (error) {
    process.stderr.write(
      `harness-supervisor MCP server configuration error: ${errorMessage(error)}\n`,
    );
    process.exit(1);
  }
}

const modeInfo = resolveModeOrExit();
const mode: McpPresentationMode = modeInfo.mode;

const stateDir = resolveStateDir(argValue("--state-dir"));
const ownerArg = process.argv.find((arg) => arg.startsWith("--owner-ref="))?.slice("--owner-ref=".length) ?? argValue("--owner-ref");
if (process.argv.includes("--owner-ref") && (ownerArg === undefined || ownerArg.startsWith("--"))) {
  throw new SupervisorError("BAD_REQUEST", "--owner-ref requires a Master session reference");
}
const ownerRef = ownerArg === undefined ? undefined : OwnerRefSchema.parse(ownerArg);
const notifyNone = ownerRef !== undefined || process.argv.includes("--notify-none");
const client = new SupervisorClient({
  stateDir,
  autoStart: true,
  connectTimeoutMs: 20_000,
  ...(ownerRef !== undefined || notifyNone ? { scope: { ownerRef, notifyNone } } : {}),
});

const REQUIRED_DAEMON_VERSION = "0.4.0";
const METRICS_DAEMON_VERSION = "0.5.0";
const CALLER_BINDING_DAEMON_VERSION = "0.6.1";
const LIST_CURSOR_DAEMON_VERSION = "0.9.1";
let daemonSupportsNewIpc = false;
let daemonSupportsMetrics = false;
let daemonSupportsCallerBinding = false;
let daemonSupportsListCursor = false;
let daemonVersion = "unknown";

function versionTuple(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function daemonAtLeast(value: unknown, minimum: string): boolean {
  const actual = versionTuple(value);
  const required = versionTuple(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

function upgradeAdvice(version: string): string {
  return `Supervisor daemon ${version} is older than ${REQUIRED_DAEMON_VERSION}. Production MCP output needs the 0.4.0 IPC (unacknowledged inbox view, read-only wake target and the MiniMax Code runtime). Back up ${stateDir}, confirm there are no active workers, then upgrade and restart the daemon manually. Changing only the MCP configuration is not enough; this MCP server never restarts or replaces a running daemon. Development mode can still connect to the old daemon with legacy semantics, but cannot provide the production filtering guarantees.`;
}

async function assessDaemonCompatibility(): Promise<void> {
  let info: SupervisorInfo;
  try {
    info = await client.request<SupervisorInfo>("info", {});
  } catch (error) {
    if (mode === "production") {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Cannot verify supervisor daemon compatibility: ${errorMessage(error)}. ${upgradeAdvice("unknown")}`,
      );
    }
    process.stderr.write(
      `harness-supervisor MCP warning: cannot verify daemon version (${errorMessage(error)}); assuming legacy IPC for development mode.\n`,
    );
    return;
  }
  daemonVersion = typeof info.version === "string" ? info.version : "unknown";
  daemonSupportsNewIpc = daemonAtLeast(info.version, REQUIRED_DAEMON_VERSION);
  daemonSupportsMetrics = daemonAtLeast(info.version, METRICS_DAEMON_VERSION);
  daemonSupportsCallerBinding = daemonAtLeast(info.version, CALLER_BINDING_DAEMON_VERSION);
  daemonSupportsListCursor = daemonAtLeast(info.version, LIST_CURSOR_DAEMON_VERSION);
  if ((ownerRef !== undefined || notifyNone) && info.capabilities?.ownerScope !== true) {
    throw new SupervisorError("UNSUPPORTED", "Scoped MCP requires HS 0.10.0 ownerScope capability. The running daemon must be upgraded in a maintenance window; this MCP process will not replace it.");
  }
  if (daemonSupportsNewIpc) return;
  if (mode === "production") {
    throw new SupervisorError("UNSUPPORTED", upgradeAdvice(daemonVersion));
  }
  process.stderr.write(`harness-supervisor MCP warning: ${upgradeAdvice(daemonVersion)}\n`);
}

function metricsUnsupportedError(): SupervisorError {
  return new SupervisorError(
    "UNSUPPORTED",
    `Task metrics require supervisor daemon ${METRICS_DAEMON_VERSION} or newer; the connected daemon is ${daemonVersion}. Restart or upgrade the daemon, then retry. The MCP server never replaces a running daemon.`,
  );
}

function ok(value: unknown) {
  const text = mode === "production" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
  };
}

function fail(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: formatToolError(error, mode) }],
  };
}

function productionDiagnosticUnsupported(what: string): SupervisorError {
  return new SupervisorError(
    "UNSUPPORTED",
    `${what} is not exposed in production mode. Restart this MCP server with --mode development or HARNESS_SUPERVISOR_MCP_MODE=development to inspect raw execution detail.`,
  );
}

/**
 * worker_list cursor is an opaque keyset position: (createdAt, id) of the last
 * returned record. It deliberately carries no row number, so inserting or
 * removing workers between pages cannot shift the remaining sequence.
 */
function encodeWorkerListCursor(worker: WorkerSummary): string {
  return Buffer.from(
    JSON.stringify({ v: 1, createdAt: worker.createdAt, id: worker.id }),
    "utf8",
  ).toString("base64url");
}

function decodeWorkerListCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { v?: unknown; createdAt?: unknown; id?: unknown };
    if (
      parsed?.v === 1 &&
      typeof parsed.createdAt === "string" &&
      Number.isFinite(Date.parse(parsed.createdAt)) &&
      new Date(parsed.createdAt).toISOString() === parsed.createdAt &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0 &&
      parsed.id.length <= 200
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Fall through to the uniform BAD_REQUEST below.
  }
  throw new SupervisorError(
    "BAD_REQUEST",
    "Invalid worker_list cursor; restart pagination without a cursor",
    { cursor },
  );
}

function compactWaitEvents(events: WorkerEvent[], includeProgress: boolean) {
  if (includeProgress) return { events, eventsOmitted: 0, progressOmitted: 0 };
  // `queue_cleared` is a cancellation fact (how many queued messages were
  // dropped), not a tool call. Every other run.progress event is tool or
  // assistant detail and must be requested explicitly.
  const visible = events.filter(
    (event) => event.type !== "run.progress" || event.data?.kind === "queue_cleared",
  );
  return {
    events: visible,
    eventsOmitted: events.length - visible.length,
    progressOmitted: events.filter((event) => event.type === "run.progress").length,
  };
}

function compactProductionWaitEvents(events: WorkerEvent[]) {
  const filtered = filterProductionEvents(events);
  return {
    events: filtered.events,
    eventsOmitted: filtered.eventsOmitted,
    progressOmitted: filtered.progressOmitted,
  };
}

const RequestIdShape = {
  requestId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Optional idempotency key. Retrying the same requestId with identical parameters replays the first result instead of executing again; different parameters return CONFLICT; an interrupted (unfinished) request returns UNCERTAIN and is never re-executed automatically.",
    ),
};

const ConfigShape = {
  model: z.string().min(1).max(200).optional().describe("Pi model override"),
  provider: z.string().min(1).max(200).optional().describe("Pi provider override"),
  tools: z
    .array(z.string())
    .min(1)
    .max(50)
    .optional()
    .describe("Pi tool allowlist, e.g. ['read','bash','edit','write']"),
  thinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Pi thinking level"),
  maxDurationMs: z
    .number()
    .int()
    .min(1000)
    .max(86_400_000)
    .optional()
    .describe("Automatically cancel the worker after this duration"),
};

const NotifyTargetShape = {
  notifyTarget: NotifyTargetSchema.optional().describe(
    "Explicit notification destination. Pass {channel:'codex-queue',codexThreadId:<verified originating thread id>} or {channel:'none'} for inbox-only. An explicit target overrides auto-binding. Spawn auto-binds to the current Codex thread when the host supplies per-call thread metadata, otherwise it snapshots the daemon default; resume preserves its original binding if omitted. Never guess the most recent session. Explicit resume binding authorizes takeover and affects future events only.",
  ),
};

const DEVELOPMENT_INSTRUCTIONS =
  "Harness Supervisor manages native Pi/Qoder/MiniMax Code/DSH workers. worker_spawn returns prompt acceptance, never completion. Reuse the worker id; do not spawn duplicates. Spawn with persistence='persistent' when the same worker should accept later Turns via worker_continue after its process exits. worker_wait is bounded, omits ordinary progress, and returns when input is needed; answer through worker_answer. MCP event reads are pull-based. Important events also enter a durable inbox; acknowledge processed notification ids. worker_spawn auto-binds to the current Codex thread when the host supplies per-call thread metadata; an explicit worker_spawn.notifyTarget overrides it, and omission falls back to the daemon default only when no caller identity is available. Bindings are persisted per worker and per event; worker_resume omission preserves the binding, while an explicit target authorizes takeover for future events. supervisor_wake_target only changes the shared default for new workers. Without a known route use channel='none'. codex-queue can trigger a new turn while the host has that target loaded; delivery is at-least-once and never itself proves wake-up. Task metrics are phase 1-2: a spawn auto-creates or links a task, and supervisor_metrics_* expose task and report data. Main-agent usage is never read from the host and must be recorded explicitly; unknown is not zero. Cost, acceptance, rework and intervention are not collected yet.";

const PRODUCTION_INSTRUCTIONS =
  "Harness Supervisor manages independent native Pi/Qoder/MiniMax Code/DSH workers and is pull-based: it does not poll; a bound codex-queue target can start a turn when the host has that thread loaded. worker_spawn/worker_resume/worker_continue return acceptance, not completion; keep the returned id and lastSeq, reuse the worker, and when notificationBinding.wake=bound and the host is known to deliver wake-ups for this thread, end the turn and let the completion notification bring you back; otherwise use worker_wait or worker_status. A worker spawned with persistence='persistent' keeps its id, native session and lifecycle=idle after each Turn; send the next instruction with worker_continue instead of spawning a replacement. Every task prompt is prefixed with the HS worker protocol: a worker finishes with its final answer and must not call `codex queue` or otherwise inject into this conversation; its PATH also rejects that subcommand. When a run needs input, answer it with worker_answer using pendingInput.requestId; worker_send only queues steering/follow-up. Pass requestId on side-effecting calls: an identical retry replays, different parameters CONFLICT, and an interrupted request reports UNCERTAIN and is not re-executed. Durable notifications are read with supervisor_notifications (default: all unacknowledged) and acknowledged after processing. Omit notifyTarget to snapshot the daemon default for new workers unless the host supplied per-call thread metadata, in which case HS auto-binds to the current Codex thread (source=caller); an explicit notifyTarget wins. resume omission preserves the binding. For a long-running independent task, spawn once, verify notificationBinding.wake=bound, then end the turn instead of polling worker_wait/worker_status/worker_events; use worker_wait when unbound, when the user asks for an immediate result, or after a notification. A bound target is not proof of wake-up; delivery is at-least-once. Task metrics are phase 1-2: a spawn auto-creates or links a task, and supervisor_metrics_* expose task and report data. Main-agent usage is never read from the host and must be recorded explicitly; unknown is not zero. Cost, acceptance, rework and intervention are not collected yet.";

interface ToolDescriptions {
  spawn: string;
  status: string;
  list: string;
  events: string;
  wait: string;
  send: string;
  answer: string;
  cancel: string;
  resume: string;
  continue: string;
  admin: string;
  forget: string;
  info: string;
  notifications: string;
  ack: string;
  wakeTarget: string;
}

const PRODUCTION_DESCRIPTIONS: ToolDescriptions = {
  spawn:
    "Start an independent native harness process (Pi by default) in its own working directory. Returns when the prompt is accepted, not when the task completes. Keep the returned id/lastSeq and observe with worker_wait or worker_status. Pass persistence='persistent' when the same worker should accept later Turns via worker_continue; the process still exits after each Turn, but the worker id and native session are kept. The task prompt is prefixed with the HS worker protocol: finish the run with the final answer and never call `codex queue`. When notifyTarget is omitted and the Codex host supplies per-call thread metadata, HS auto-binds this worker to the current Codex thread (source=caller); an explicit notifyTarget always wins, and the daemon default is used only when no caller identity is available. The response includes notificationBinding: effective target, source (explicit / caller / daemon-default), wake (bound / unbound), observation (wake / wait) and warnings. For a long-running independent task with wake=bound and a host known to wake this thread, end the turn after spawn instead of polling; otherwise use worker_wait. A bound target is not a guarantee of wake-up.",
  status:
    "Return a bounded status snapshot: identity, status, lastSeq, session availability, a bounded result/error preview (chars/truncated) and a bounded pending input. The default response stays within 2 KiB and never includes recent events, run.progress, lastProgress, timeline or inputState; worker_status is not a result API. Use worker_wait for the full final result, worker_events for lifecycle history, and supervisor_notifications for the inbox. includeInput=true returns the complete pending input while the result/error face stays a bounded preview; this explicit read may exceed the default budget. includeResult and recentEvents are rejected in production with UNSUPPORTED.",
  list:
    "List managed workers (newest first) as {workers,nextCursor,hasMore}. Ordering is createdAt DESC with id as the tie-breaker. Each entry carries identity, runtime, status, persistence, lifecycle, needsInput and lastSeq; call worker_status or worker_wait for details. Archived workers are hidden unless includeArchived=true. Pass nextCursor with the same statuses/includeArchived filters to read the next page; the cursor is a keyset position, so newly added, archived or deleted workers do not shift the remaining sequence. State persists across daemon restarts.",
  events:
    "Read lifecycle events. Without sinceSeq this is a compact tail snapshot: the newest allowed lifecycle events (seq/ts/type/summary), no run.progress, staying within 4 KiB. Use nextSeq as the cursor; pass sinceSeq for strict incremental reads and use hasMore/eventsOmitted to continue. Production exposes only decision-relevant lifecycle events and caps an incremental page at 200; includeProgress=true and seq pointing to run.progress are rejected with UNSUPPORTED. A single seq returns a compact event for an allowed type. Development mode exposes raw progress and full data. Never assume a truncated response is complete: eventsOmitted and progressOmitted say what was left out.",
  wait:
    "Bounded long-poll (default 30s, maximum 120s). MCP is pull-based: the supervisor never wakes the main agent by itself, although optional codex-queue notifications can start a turn when the host has that thread loaded. Without sinceSeq it checks current state first, then waits from the current tail. Returns early when terminal, awaiting_input, or a requested types event appears. On completion it returns the full final result; on input it returns pendingInput; on timeout only status and cursor. Ordinary progress is never returned in production: includeProgress=true or types containing run.progress is rejected with UNSUPPORTED. until='event' without types waits only for allowlisted lifecycle events, so progress alone cannot end the wait; pass explicit lifecycle types to narrow it further. Pass sinceSeq for strict cursor delivery. Timeout is not failure.",
  send:
    "Queue a steering message (before the next model turn) or follow-up (after the current run) through the native harness. Valid only while running; it returns acceptance, not completion. Pi applies both natively. Qoder 1.1.76 accepts the stream message without a verified effect on the running turn. MiniMax Code steers an active turn through its steer extension and was verified to act on it; a steer sent after the turn ended is rejected by the agent. DSH ACP exposes neither, so it returns UNSUPPORTED. This does not answer extension dialogs; use worker_answer.",
  answer:
    "Answer a current pending input request. Read worker_status first: wake messages may be old, request ids may be reused after resume, and inputState may already say expired/answered/closed. Provide exactly one of value, confirmed, or cancelled=true using pendingInput.requestId; any other combination is rejected at the schema boundary. If the request expired or was already answered, INVALID_STATE includes reason and nextActions: do not retry worker_answer, and resume the same worker only when that is the appropriate next step. Native permission options are answered by their offered value.",
  cancel:
    "Clear queued messages, abort the run, stop the harness process tree and return the final cancelled state. Other workers are unaffected. An orphaned process left by a supervisor restart returns UNSUPPORTED because its control channel is gone; verify and terminate it out-of-band. Cancellation cannot be undone.",
  resume:
    "Start a new harness process attached to an existing persisted session and send a new instruction. Only a terminal worker whose old process is gone can resume; the session is verified. It does not continue the interrupted in-memory run or automatically retry the old task. Auto-binding does not apply to resume: omit notifyTarget to keep the existing binding (notificationBinding.source=preserved); an explicit target is a takeover for future events only (source=explicit). The response also reports wake, observation and warnings, so an unbound worker is not mistaken for an automatic notification.",
  "continue":
    "Submit the next Turn to an idle persistent Worker on its existing native session. Requires persistence=persistent and a restorable session; it never creates a replacement session. worker_resume keeps its historical meaning (recover a terminal or interrupted worker); worker_continue is the normal way to give more work after a completed Turn. The response reports lifecycle and session.restorable so callers can tell a finished Turn from an unusable worker.",
  admin:
    "Change HS-level management flags without touching the native session. pin protects a worker from prune and from worker_forget; archive hides it from the default worker_list while keeping identity, events and session reference; retire stops worker_continue/worker_resume until unretired. Active workers cannot be archived or retired. Returns the current flags.",
  forget:
    "Remove the HS record and event directory for a terminal worker. Pinned workers and workers with unacknowledged notifications are refused; active workers are refused. The native session file is deliberately preserved, so this is not a harness-side delete. This operation cannot be undone.",
  info:
    "Return the supervisor version, this MCP process mode, the advertised runtimes and active/total worker counts. Production is a minimal availability snapshot: limits, wake details, storage diagnostics and runtime notes are available in development mode. Delivery remains at-least-once and does not prove wake-up.",
  notifications:
    "Read actionable unacknowledged notifications for important lifecycle events. Each record carries id, workerId, seq, eventType, kind, createdAt, summary, deliveryState, acked and actionable. Superseded requests are omitted by default; state='all' includes history with actionable=false. Wake messages carry a cursor, not the report or current question: read worker_wait or worker_status for the current result/input before acting. Filter by workerId and acknowledge processed ids afterwards. Delivery history and routing targets are development diagnostics; includeDelivery is rejected in production. Counts are scoped explicitly: filteredCounts covers the same filter as this list (before limit), globalCounts covers the whole inbox, scope records state/workerId/limit/returned, and the legacy counts field remains the global view.",
  ack:
    "Mark notification ids as processed. Idempotent; unknown ids are reported rather than treated as errors.",
  wakeTarget:
    "Set the default notification destination for NEW workers; existing workers keep their persisted targets. An explicit worker_spawn.notifyTarget overrides auto-binding; when no caller identity is available, this default is the fallback for new workers. channel='codex-queue' requires a verified thread id and starts a turn only while the host has that thread loaded. Without arguments it returns the current default target.",
};

const DEVELOPMENT_DESCRIPTIONS: ToolDescriptions = {
  spawn:
    "Start an independent native harness process (Pi by default) in its own working directory. Returns as soon as the prompt is accepted, NOT when the task completes. Save the returned worker id and lastSeq; use worker_wait for progress/completion. Do not spawn a duplicate worker for the same task while this one is active. Pass persistence='persistent' to keep the worker available for later Turns via worker_continue after its process exits. The worker survives this MCP client disconnecting because the supervisor daemon owns it.",
  status:
    "Return the current lifecycle status, lastSeq cursor, recent incremental events, pending input request, result/error, and the last harness stderr tail. Status 'running' means the prompt is being processed; only terminal statuses (completed, failed, cancelled, crashed, orphaned, interrupted) end the task. This is an explicit development whitelist, not the raw stored record: it includes session availability/ref, timing, resume counters, pid/exit facts and full result/pending input. Production status is a bounded snapshot and rejects includeResult/recentEvents.",
  list:
    "List workers managed by the supervisor, newest first, as {workers,nextCursor,hasMore}. Ordering is createdAt DESC with id as the tie-breaker; nextCursor is a keyset position, so concurrent additions, archivals and deletions do not shift the remaining sequence. Each entry is the explicit development whitelist (status, timing, session, result and lifecycle diagnostics), never the raw record. Pass nextCursor with the same filters for the next page. State persists across daemon restarts.",
  events:
    "Read stored normalized events after a sequence cursor. Without sinceSeq it starts at seq 1; with sinceSeq it returns events after that cursor, up to limit (default 100, max 500). Use the returned nextSeq as the next sinceSeq. This is a fast, non-blocking read; use worker_wait to block for progress or completion. Development returns the full stored stream including run.progress and event data; includeProgress is accepted for cross-mode compatibility but does not change the development result. Pass seq=<n> for one event in full. Stored text may be clipped before storage; storedTruncated/note and data.*Truncated/originalChars make that explicit.",
  wait:
    "Bounded long-poll. MCP tools are pull-based: this call returns only when the host invokes it; the supervisor never wakes the main agent by itself (optional codex-queue notifications can start a turn only while the host has that thread loaded). Default 30s, maximum 120s. Without sinceSeq, it first checks current status and the latest 20 events: if the worker is already terminal or awaiting_input, or a requested 'types' event is already in that window, it returns immediately; otherwise it waits from the current tail. With sinceSeq, it uses strict cursor semantics and only returns events after that sequence. Normal run.progress events are omitted by default to keep context small; only queue_cleared (a cancellation fact) is retained, so tool calls and tool errors require includeProgress=true. Pass includeProgress=true (or request types=['run.progress']) for full progress, or use worker_events for complete history. By default waits until terminal OR awaiting_input; use until='event' to return on the first matching new event. Pass sinceSeq (from lastSeq/nextSeq) when you need lossless incremental delivery.",
  send:
    "Queue a steering message (delivered before the next model turn) or a follow-up (delivered after the current run) through the native harness. Only valid while the worker is running; if it already reached a terminal state this returns INVALID_STATE, and you should not spawn a replacement automatically. This does not answer extension dialogs; use worker_answer for run.needs_input events. Delivery differs per runtime: Pi applies steering/follow-ups natively, while Qoder 1.1.76 accepts the stream message (run.message_sent) without a verified effect on the running turn, so do not assume the model acted on it. MiniMax Code applies steering through its mcode/session/steer extension and queues follow-ups through mcode/session/queue/enqueue, both of which require a build that advertises them. A real 0.6.12 process accepted a steer sent during an active turn and the agent acted on it (mode 'steered'), but the same call outside an admitted turn is rejected ('Steering requires an admitted, active ACP prompt Turn'), so a steering message can reach a running turn and still be dropped when the turn has ended; check the worker state before assuming it was delivered. DSH ACP exposes no steer/follow-up method and returns UNSUPPORTED. Pass requestId to make a retry after a timeout replay the recorded outcome instead of enqueueing the same text twice; if the daemon crashed mid-send the outcome is reported as UNCERTAIN, because the harness may already have received the message.",
  answer:
    "Respond to a run.needs_input event (Pi extension select/confirm/input/editor). Provide exactly one of value, confirmed, or cancelled. The worker must currently have a matching pending request.",
  cancel:
    "Clear queued steering/follow-up messages, abort the native run, stop the harness process (force-killing its process tree if needed), and return the final cancelled state. Other workers are unaffected. If the worker is an orphaned process left by a supervisor restart, this returns UNSUPPORTED because the supervisor no longer owns its control channel; verify and terminate that PID out-of-band. Cancellation is not a pause and cannot be undone.",
  resume:
    "Start a new harness process attached to an existing Pi session file and send a new instruction. Only works for a terminal worker with a persisted session that still exists and whose old process is not alive. The supervisor verifies the session id and refuses to fake a resume. This does not continue the interrupted in-memory run, replay its tool calls, or automatically retry the old task. Pass requestId so a retry after a timeout cannot start a second process for the same instruction.",
  "continue":
    "Submit the next Turn to an idle persistent Worker on its existing native session. Spawn with persistence='persistent' first; worker_continue then reuses the same worker id and native session, and the lifecycle stays idle between Turns because only the activation process exits. It returns a real error when the session cannot be restored instead of creating a replacement worker. Use worker_resume only for its historical recovery semantics.",
  admin:
    "Change HS-level flags: pin/unpin, archive/unarchive, retire/unretire. Archive only hides the worker from the default list; it keeps the record, events and session reference. Retire blocks continue/resume until unretired. Active workers cannot be archived or retired.",
  forget:
    "Permanently remove the HS record and events for a terminal worker. The native session file is kept. Pinned workers, workers with unacknowledged notifications, and active workers are refused.",
  info:
    "Show daemon information, limits, runtimes, and the explicit event-delivery boundary: events are persisted and pull-based; the supervisor does not claim background wake-up of the main agent.",
  notifications:
    "List durable notifications for important lifecycle events. Ordinary progress never creates notifications. Pending requests are checked before host delivery; resolved undelivered requests become superseded, not delivered. Default pending view excludes them; state='all' retains diagnostic history. Read worker_status for current input/result before acting and acknowledge processed ids. Codex queue messages already accepted by the host cannot be withdrawn.",
  ack:
    "Mark notification ids as processed. Idempotent: acknowledging the same id twice is a no-op. Unknown ids are reported, not treated as errors.",
  wakeTarget:
    "Set the default destination for NEW workers. Existing workers and notifications retain their persisted targets. For parallel Codex conversations, pass an explicit notifyTarget to worker_spawn instead of changing this shared default. channel='none' keeps the inbox only; channel='codex-queue' requires a verified Codex thread id. The official codex queue CLI accepts delivery, and the host starts a turn only while the target is loaded. Delivery is at-least-once and does not prove wake-up. Use worker_resume.notifyTarget only for explicitly authorized takeover; omission preserves binding.",
};

const descriptions =
  mode === "production" ? PRODUCTION_DESCRIPTIONS : DEVELOPMENT_DESCRIPTIONS;

const server = new McpServer(
  {
    name: "harness-supervisor",
    version: VERSION,
  },
  {
    instructions: (mode === "production" ? PRODUCTION_INSTRUCTIONS : DEVELOPMENT_INSTRUCTIONS) +
      (ownerRef !== undefined ? "\nThis connection is fixed to its Master session. Workers and inbox ACKs outside that session are refused. Notification delivery is inbox-only; use worker_wait. Shared notification configuration, global metrics, maintenance and core upgrades are not exposed." : ""),
  },
);

server.registerTool(
  "worker_spawn",
  {
    title: "Spawn a native harness worker",
    description: descriptions.spawn,
    inputSchema: {
      cwd: z.string().min(1).describe("Working directory for the harness process"),
      prompt: z.string().min(1).describe("Task/instruction sent to the native harness"),
      runtime: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Runtime adapter name (default: pi; qoder uses the Qoder CLI; mcode uses MiniMax Code over ACP; dsh uses DeepSeek Harness over ACP)",
        ),
      name: z.string().min(1).max(200).optional().describe("Human-readable worker label"),
      persistence: z
        .enum(["oneshot", "persistent"])
        .optional()
        .describe(
          "Opt-in persistent collaboration. 'persistent' lets the same worker receive later Turns via worker_continue after the process exits; the default 'oneshot' keeps the historical single-run behavior.",
        ),
      taskId: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Link this worker to an existing delegated metrics task. Omit to auto-create one; use metrics_task_create first when several workers belong to the same task.",
        ),
      ...ConfigShape,
      ...RequestIdShape,
      ...NotifyTargetShape,
    },
  },
  async (args, extra) => {
    try {
      const caller =
        args.notifyTarget === undefined ? callerThreadFromMeta(extra?._meta) : undefined;
      const callerRejection =
        args.notifyTarget === undefined ? callerMetaRejection(extra?._meta) : undefined;
      const callerThreadId = daemonSupportsCallerBinding ? caller?.threadId : undefined;
      const result = await client.request(
        "spawn",
        {
          runtime: args.runtime ?? "pi",
          cwd: args.cwd,
          prompt: args.prompt,
          name: args.name,
          persistence: args.persistence,
          taskId: args.taskId,
          model: args.model,
          provider: args.provider,
          tools: args.tools,
          thinking: args.thinking,
          maxDurationMs: args.maxDurationMs,
          requestId: args.requestId,
          notifyTarget: args.notifyTarget,
          callerThreadId,
        },
        { timeoutMs: 90_000 },
      );
      const presented = presentAcceptedWorker(result as WorkerSummary, mode) as {
        notificationBinding?: { warnings?: string[] };
      };
      if (callerRejection && presented.notificationBinding) {
        presented.notificationBinding.warnings?.push(
          `Codex caller metadata was present but rejected (${callerRejection}); this worker was not auto-bound. Check the binding target before ending the turn.`,
        );
      }
      if (caller && !daemonSupportsCallerBinding && presented.notificationBinding) {
        presented.notificationBinding.warnings?.push(
          `Daemon ${daemonVersion} predates caller auto-binding (requires ${CALLER_BINDING_DAEMON_VERSION}); this worker was not auto-bound. Upgrade and restart the daemon, then restart this MCP server (or Codex session) so the version check reruns; or pass notifyTarget explicitly.`,
        );
      }
      return ok(presented);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_status",
  {
    title: "Get a worker status snapshot",
    description: descriptions.status,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      workerId: z.string().min(1),
      recentEvents: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
          "Development only: include recent events. Production status is a snapshot and rejects this parameter; use worker_events.",
        ),
      includeResult: z
        .boolean()
        .optional()
        .describe(
          "Production rejects this parameter; use worker_wait for the full result. Development returns the full result by default.",
        ),
      includeInput: z
        .boolean()
        .optional()
        .describe(
          "Return the complete pending input. The result/error face stays a bounded preview.",
        ),
    },
  },
  async (args) => {
    try {
      if (mode === "production") {
        if (args.includeResult === true) {
          throw productionDiagnosticUnsupported("worker_status.includeResult");
        }
        if (args.recentEvents !== undefined) {
          throw productionDiagnosticUnsupported("worker_status.recentEvents");
        }
        const result = await client.request<WorkerStatusResult>("status", {
          workerId: args.workerId,
          // Ten lifecycle events are enough to derive lastEvent without
          // turning the status read into an event listing.
          recentEvents: 10,
        });
        return ok(
          presentStatus(result, mode, { includeInput: args.includeInput === true }),
        );
      }
      const includeRecentEvents = args.recentEvents !== undefined;
      const result = await client.request<WorkerStatusResult>("status", {
        workerId: args.workerId,
        recentEvents: includeRecentEvents ? args.recentEvents : 20,
      });
      return ok(presentStatus(result, mode, { includeRecentEvents }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_list",
  {
    title: "List workers",
    description: descriptions.list,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      statuses: z
        .array(
          z.enum([
            "starting",
            "running",
            "awaiting_input",
            "completed",
            "failed",
            "cancelled",
            "crashed",
            "orphaned",
            "interrupted",
          ]),
        )
        .optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Opaque keyset cursor from a previous worker_list response. Reuse the same statuses/includeArchived filters; changing them invalidates the traversal.",
        ),
      includeArchived: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
      const after =
        args.cursor !== undefined ? decodeWorkerListCursor(args.cursor) : undefined;
      if (after && !daemonSupportsListCursor) {
        throw new SupervisorError(
          "UNSUPPORTED",
          `worker_list cursor pagination requires supervisor daemon ${LIST_CURSOR_DAEMON_VERSION} or newer; the connected daemon is ${daemonVersion}. The first page is still available without a cursor. Restart or upgrade the daemon, then restart this MCP server; the MCP server never replaces a running daemon.`,
        );
      }
      // Fetch one extra row to prove hasMore without a second IPC round trip.
      const all = await client.request<WorkerSummary[]>("list", {
        statuses: args.statuses as WorkerStatus[] | undefined,
        limit: Math.min(limit + 1, 500),
        ...(args.includeArchived === true ? { includeArchived: true } : {}),
        ...(after ? { after } : {}),
      });
      const page = all.slice(0, limit);
      const hasMore = all.length > limit;
      const nextCursor =
        hasMore && page.length > 0
          ? encodeWorkerListCursor(page[page.length - 1]!)
          : null;
      return ok(presentWorkerList(page, mode, { nextCursor, hasMore }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_events",
  {
    title: "Read incremental worker events",
    description: descriptions.events,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      workerId: z.string().min(1),
      sinceSeq: z.number().int().min(0).optional().describe("Return events with seq > sinceSeq"),
      limit: z.number().int().min(1).max(500).optional(),
      seq: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Read exactly one stored event by seq. Development returns it in full; production returns a compact allowed lifecycle event and rejects run.progress.",
        ),
      includeProgress: z
        .boolean()
        .optional()
        .describe(
          "Development already returns the complete stored stream; this flag is accepted for compatibility and has no additional effect. Production rejects it with UNSUPPORTED.",
        ),
    },
  },
  async (args) => {
    try {
      if (mode === "production" && args.includeProgress === true) {
        throw productionDiagnosticUnsupported("worker_events.includeProgress");
      }
      if (args.seq !== undefined) {
        const window = await client.request<ReadEventsResult>("events", {
          workerId: args.workerId,
          sinceSeq: Math.max(0, args.seq - 1),
          limit: 2,
        });
        const event = window.events.find((item) => item.seq === args.seq);
        if (!event) {
          throw new SupervisorError("NOT_FOUND", `No stored event with seq ${args.seq}`, {
            workerId: args.workerId,
            seq: args.seq,
          });
        }
        if (mode === "production") {
          if (!isProductionEventType(event.type)) {
            throw productionDiagnosticUnsupported(
              `worker_events.seq=${args.seq} (${event.type})`,
            );
          }
          return ok(singleProductionEventView(window.worker, event));
        }
        return ok(singleEventView(window.worker, event));
      }
      if (mode === "production") {
        return ok(
          await readCompactEvents(
            (options) =>
              client.request<ReadEventsResult>("events", {
                workerId: args.workerId,
                sinceSeq: options.sinceSeq,
                limit: options.limit,
              }),
            {
              sinceSeq: args.sinceSeq,
              // Production incremental reads are capped at 200 events per page;
              // the 4 KiB budget trims the response further.
              limit: args.limit === undefined ? undefined : Math.min(args.limit, 200),
              budgetBytes: EVENTS_BUDGET_BYTES,
              eventFilter: (event) => isProductionEventType(event.type),
            },
          ),
        );
      }
      const result = await client.request<ReadEventsResult>("events", {
        workerId: args.workerId,
        sinceSeq: args.sinceSeq ?? 0,
        limit: args.limit ?? 100,
      });
      return ok(presentEventsDevelopment(result));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_wait",
  {
    title: "Wait for worker progress or completion",
    description: descriptions.wait,
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      workerId: z.string().min(1),
      sinceSeq: z.number().int().min(0).optional().describe("Strict cursor: return only events with seq > sinceSeq"),
      timeoutMs: z.number().int().min(0).max(120_000).optional(),
      until: z.enum(["terminal", "event"]).optional(),
      types: z
        .array(z.string())
        .max(30)
        .optional()
        .describe(
          "Wake early on any of these event types. Production accepts only lifecycle types; run.progress is rejected.",
        ),
      includeProgress: z
        .boolean()
        .optional()
        .describe(
          "Development only: include run.progress events. Production rejects this with UNSUPPORTED; use worker_events in development for full history.",
        ),
    },
  },
  async (args) => {
    const timeoutMs = args.timeoutMs ?? 30_000;
    const until = args.until ?? "terminal";
    try {
      if (mode === "production") {
        if (args.includeProgress === true) {
          throw productionDiagnosticUnsupported("worker_wait.includeProgress");
        }
        const unsupportedType = args.types?.find((type) => !isProductionEventType(type));
        if (unsupportedType !== undefined) {
          throw productionDiagnosticUnsupported(
            `worker_wait.types=${unsupportedType}`,
          );
        }
      }
      const includeProgress =
        args.includeProgress === true || (args.types?.includes("run.progress") ?? false);
      const compact = (events: WorkerEvent[]) =>
        mode === "production"
          ? compactProductionWaitEvents(events)
          : compactWaitEvents(events, includeProgress);
      const includeEvents = mode === "development" || until === "event";
      // Production must not wake on a progress-only event when the caller asks
      // for an event without a type filter. Restrict the IPC wait itself to the
      // lifecycle allowlist instead of returning an empty result per progress.
      const waitTypes =
        mode === "production" &&
        until === "event" &&
        (args.types === undefined || args.types.length === 0)
          ? [...PRODUCTION_EVENT_TYPES]
          : args.types;
      let sinceSeq = args.sinceSeq;
      if (sinceSeq === undefined) {
        const snapshot = await client.request<WorkerStatusResult>("status", {
          workerId: args.workerId,
          recentEvents: 20,
        });
        const current = snapshot.worker;
        const recent = snapshot.recentEvents;
        const terminal = isTerminal(current.status);
        const needsInput = current.status === "awaiting_input";
        const typeFilter = args.types?.length ? new Set(args.types) : null;
        const matched = typeFilter
          ? recent.filter((event) => typeFilter.has(event.type))
          : [];
        if (
          terminal ||
          needsInput ||
          (until === "event" && typeFilter !== null && matched.length > 0)
        ) {
          const compacted = compact(terminal || needsInput ? recent : matched);
          return ok(
            presentWait(
              {
                worker: current,
                events: recent,
                nextSeq: current.lastSeq,
                hasMore: false,
                timedOut: false,
                terminal,
                ...(snapshot.lastProgress ? { lastProgress: snapshot.lastProgress } : {}),
                ...(snapshot.timeline ? { timeline: snapshot.timeline } : {}),
                ...(snapshot.inputState ? { inputState: snapshot.inputState } : {}),
              },
              compacted,
              mode,
              { includeEvents },
            ),
          );
        }
        sinceSeq = current.lastSeq;
      }
      const result = await client.request<WaitResult>(
        "wait",
        {
          workerId: args.workerId,
          sinceSeq,
          timeoutMs,
          until,
          types: waitTypes,
        },
        { timeoutMs: timeoutMs + 10_000 },
      );
      const compacted = compact(result.events);
      return ok(presentWait(result, compacted, mode, { includeEvents }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_send",
  {
    title: "Send a supplementary instruction to a running worker",
    description: descriptions.send,
    inputSchema: {
      workerId: z.string().min(1),
      message: z.string().min(1),
      mode: z.enum(["steer", "follow-up"]).optional(),
      ...RequestIdShape,
    },
  },
  async (args) => {
    try {
      const result = await client.request<WorkerSummary>("send", {
        workerId: args.workerId,
        message: args.message,
        mode: (args.mode ?? "steer") as SendMode,
        requestId: args.requestId,
      });
      return ok(presentWorkerAction(result, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_answer",
  {
    title: "Answer a pending native extension dialog",
    description: descriptions.answer,
    inputSchema: z
      .object({
        workerId: z.string().min(1),
        requestId: z.string().min(1),
        value: z.string().optional(),
        confirmed: z.boolean().optional(),
        cancelled: z.literal(true).optional(),
      })
      .strict()
      .superRefine((args, ctx) => {
        const provided = [
          args.value !== undefined,
          args.confirmed !== undefined,
          args.cancelled !== undefined,
        ].filter(Boolean).length;
        if (provided !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide exactly one of value, confirmed, or cancelled=true",
          });
        }
      }),
  },
  async (args) => {
    try {
      const provided = [args.value !== undefined, args.confirmed !== undefined, args.cancelled === true].filter(
        Boolean,
      ).length;
      if (provided !== 1) {
        return fail(
          new SupervisorError(
            "BAD_REQUEST",
            "Provide exactly one of value, confirmed, or cancelled=true",
          ),
        );
      }
      const response: ExtensionUiResponse = args.cancelled
        ? { cancelled: true }
        : args.confirmed !== undefined
          ? { confirmed: args.confirmed }
          : { value: args.value! };
      const worker = await client.request<WorkerSummary>("answer", {
        workerId: args.workerId,
        requestId: args.requestId,
        response,
      });
      const presented = presentWorkerAction(worker, mode) as Record<string, unknown>;
      presented.requestId = args.requestId;
      return ok(presented);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_cancel",
  {
    title: "Cancel a worker and confirm termination",
    description: descriptions.cancel,
    inputSchema: {
      workerId: z.string().min(1),
      timeoutMs: z.number().int().min(500).max(60_000).optional(),
    },
  },
  async (args) => {
    try {
      const timeoutMs = args.timeoutMs ?? 20_000;
      const worker = await client.request<WorkerSummary>(
        "cancel",
        { workerId: args.workerId, timeoutMs },
        { timeoutMs: timeoutMs + 15_000 },
      );
      const presented = presentWorkerAction(worker, mode) as Record<string, unknown>;
      presented.cancellationState =
        worker.status === "cancelled"
          ? "cancelled"
          : isTerminal(worker.status)
            ? "terminal"
            : "requested";
      return ok(presented);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_resume",
  {
    title: "Resume a persisted native session with a new instruction",
    description: descriptions.resume,
    inputSchema: {
      workerId: z.string().min(1),
      prompt: z.string().min(1),
      ...ConfigShape,
      ...RequestIdShape,
      ...NotifyTargetShape,
    },
  },
  async (args) => {
    try {
      const worker = await client.request<WorkerSummary>(
        "resume",
        {
          workerId: args.workerId,
          prompt: args.prompt,
          model: args.model,
          provider: args.provider,
          tools: args.tools,
          thinking: args.thinking,
          maxDurationMs: args.maxDurationMs,
          requestId: args.requestId,
          notifyTarget: args.notifyTarget,
        },
        { timeoutMs: 90_000 },
      );
      const presented = presentAcceptedWorker(worker, mode) as Record<string, unknown>;
      // Daemons before 0.9.0 have no session projection. Omit the field rather
      // than claiming a restore result that the daemon did not report.
      if (worker.session) presented.sessionRestored = worker.session.available === true;
      return ok(presented);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_continue",
  {
    title: "Continue an idle persistent worker with a new Turn",
    description: descriptions.continue,
    inputSchema: {
      workerId: z.string().min(1),
      prompt: z.string().min(1),
      ...ConfigShape,
      ...RequestIdShape,
      ...NotifyTargetShape,
    },
  },
  async (args) => {
    try {
      return ok(
        presentAcceptedWorker(
          await client.request<WorkerSummary>(
            "continue",
            {
              workerId: args.workerId,
              prompt: args.prompt,
              model: args.model,
              provider: args.provider,
              tools: args.tools,
              thinking: args.thinking,
              maxDurationMs: args.maxDurationMs,
              requestId: args.requestId,
              notifyTarget: args.notifyTarget,
            },
            { timeoutMs: 90_000 },
          ),
          mode,
        ),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_admin",
  {
    title: "Pin, archive or retire a worker",
    description: descriptions.admin,
    inputSchema: {
      workerId: z.string().min(1),
      action: z.enum(["pin", "unpin", "archive", "unarchive", "retire", "unretire"]),
    },
  },
  async (args) => {
    try {
      return ok(
        presentWorkerAdmin(
          await client.request<WorkerSummary>("admin", {
            workerId: args.workerId,
            action: args.action,
          }),
          mode,
        ),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_forget",
  {
    title: "Forget a terminal worker's HS record",
    description: descriptions.forget,
    annotations: { destructiveHint: true },
    inputSchema: {
      workerId: z.string().min(1),
    },
  },
  async (args) => {
    try {
      const result = await client.request<ForgetWorkerResult>("forget", {
        workerId: args.workerId,
      });
      return ok(presentForgetResult(result, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "supervisor_info",
  {
    title: "Supervisor capabilities and wake semantics",
    description: descriptions.info,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const info = await client.request<SupervisorInfo>("info", {});
      return ok(presentInfo(info, mode, mode, modeInfo.source));
    } catch (error) {
      return fail(error);
    }
  },
);

const MetricsTokenShape = {
  inputTokens: z.number().int().min(0).max(1_000_000_000_000_000).optional(),
  outputTokens: z.number().int().min(0).max(1_000_000_000_000_000).optional(),
  cacheReadTokens: z.number().int().min(0).max(1_000_000_000_000_000).optional(),
  cacheWriteTokens: z.number().int().min(0).max(1_000_000_000_000_000).optional(),
  reportedTotalTokens: z.number().int().min(0).max(1_000_000_000_000_000).optional(),
};

if (ownerRef === undefined) server.registerTool(
  "metrics_task_create",
  {
    title: "Create a delegated task for metrics",
    description:
      "Create a delegated task that one or more workers can join through worker_spawn.taskId. Spawn without taskId auto-creates a task, so create explicitly only when several workers share one acceptance unit. Phase 1-2 records timing and usage; cost, acceptance, rework and intervention are not collected. A supplied taskId makes creation idempotent only when the title/category/parent reference match.",
    inputSchema: {
      title: z.string().min(1).max(200).describe("Short task title, not the full prompt"),
      category: z.string().min(1).max(50).optional(),
      taskId: z.string().min(1).max(120).optional().describe("Optional caller-supplied stable id"),
      parentSessionRef: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe("Optional opaque reference to the originating main-agent session"),
    },
  },
  async (args) => {
    try {
      if (!daemonSupportsMetrics) throw metricsUnsupportedError();
      const input: TaskCreateInput = { ...args, createdBy: "mcp" };
      const task = await client.request<TaskRecord>("metrics_task_create", input, {
        timeoutMs: 15_000,
      });
      return ok(presentTaskCreated(task, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

if (ownerRef === undefined) server.registerTool(
  "metrics_task_show",
  {
    title: "Show one task's metrics",
    description:
      "Read one task's derived status, worker timings, usage coverage and warnings. Development mode also returns the raw usage records. Worker completion is not acceptance. Unknown values stay null; all-zero runtime usage is unverified and excluded from known totals. Parent-agent usage appears only when explicitly recorded.",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { taskId: z.string().min(1).max(120) },
  },
  async (args) => {
    try {
      if (!daemonSupportsMetrics) throw metricsUnsupportedError();
      const metrics = await client.request<TaskMetrics>("metrics_task_show", {
        taskId: args.taskId,
      });
      return ok(presentTaskMetrics(metrics, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

if (ownerRef === undefined) server.registerTool(
  "metrics_report",
  {
    title: "Summarize task metrics over a time range",
    description:
      "Aggregate tasks whose createdAt falls in the optional since/until window. Reports task status counts, worker/parent/session-level usage separately, per-field coverage, durations, unknown fields and data-quality warnings. Token categories are never added together. Cost, first-pass acceptance, rework and intervention are not tracked in phases 1-2. includeTasks returns task summaries (full task details in development mode); limit applies, while aggregate counts still cover all selected tasks.",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      since: z.string().min(1).max(100).optional().describe("ISO 8601 lower bound on task.createdAt"),
      until: z.string().min(1).max(100).optional().describe("ISO 8601 upper bound on task.createdAt"),
      includeTasks: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  async (args) => {
    try {
      if (!daemonSupportsMetrics) throw metricsUnsupportedError();
      const report = await client.request<MetricsReport>("metrics_report", args, {
        timeoutMs: 30_000,
      });
      return ok(presentMetricsReport(report, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

if (ownerRef === undefined) server.registerTool(
  "metrics_record_usage",
  {
    title: "Record task usage manually",
    description:
      "Record one usage record for a task. Parent-agent usage is never read from the Codex host; record it explicitly with role=parent_agent, and leave attribution=session_level unless you actually measured a task-level before/after increment. Session-level parent usage is reported separately and excluded from task totals. Worker usage requires a workerId already linked to the task. At least one token field is required; unknown must not be recorded as zero. Pass usageId to make retries idempotent; the same usageId with different values returns CONFLICT.",
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      taskId: z.string().min(1).max(120),
      role: z.enum(["parent_agent", "worker"]),
      workerId: z.string().min(1).max(200).optional(),
      usageId: z.string().min(1).max(100).optional(),
      provider: z.string().min(1).max(200).optional(),
      modelId: z.string().min(1).max(200).optional(),
      harness: z.string().min(1).max(100).optional(),
      ...MetricsTokenShape,
      usageSource: z
        .enum(["manual", "host_reported", "imported", "estimated"])
        .optional(),
      attribution: z
        .enum(["exact", "incremental", "session_level", "estimated"])
        .optional()
        .describe(
          "Parent usage defaults to session_level (not attributable); use incremental only for a measured task-level delta. Worker usage defaults to exact.",
        ),
      confidence: z.enum(["verified", "partial", "unverified", "unknown"]).optional(),
      note: z.string().max(500).optional(),
    },
  },
  async (args) => {
    try {
      if (!daemonSupportsMetrics) throw metricsUnsupportedError();
      const input: UsageRecordInput = { ...args };
      const record = await client.request<UsageRecord>("metrics_usage_record", input, {
        timeoutMs: 15_000,
      });
      return ok(presentUsageRecord(record, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "supervisor_notifications",
  {
    title: "Read the durable notification inbox",
    description: descriptions.notifications,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      state: z
        .enum(["pending", "delivered", "failed", "all"])
        .optional()
        .describe(
          "Explicit delivery-state view. Omit for all unacknowledged records (production) or pending (development).",
        ),
      workerId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      includeDelivery: z
        .boolean()
        .optional()
        .describe(
          "Development includes delivery diagnostics by default. Production rejects this flag; delivery is at-least-once and does not prove host consumption.",
        ),
    },
  },
  async (args) => {
    try {
      if (mode === "production" && args.includeDelivery === true) {
        throw productionDiagnosticUnsupported("supervisor_notifications.includeDelivery");
      }
      const unacknowledgedOnly = mode === "production" && args.state === undefined;
      const result = await client.request<NotificationsResult>("notifications", {
        state: unacknowledgedOnly ? "all" : (args.state ?? "pending"),
        workerId: args.workerId,
        limit: args.limit ?? 50,
        ...(unacknowledgedOnly ? { unacknowledgedOnly: true } : {}),
      });
      return ok(presentNotifications(result, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "supervisor_notifications_ack",
  {
    title: "Acknowledge processed notifications",
    description: descriptions.ack,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).max(200),
      by: z.string().min(1).max(100).optional(),
    },
  },
  async (args) => {
    try {
      const by = args.by ?? "mcp";
      const result = await client.request<{ acked: number; missing: string[] }>(
        "notification_ack",
        { ids: args.ids, by },
      );
      return ok(presentNotificationAck(result, mode, args.ids, by));
    } catch (error) {
      return fail(error);
    }
  },
);

if (ownerRef === undefined) server.registerTool(
  "supervisor_wake_target",
  {
    title: "Configure optional Codex thread notification delivery",
    description: descriptions.wakeTarget,
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      channel: z.enum(["none", "codex-queue"]).optional(),
      codexThreadId: z.string().min(1).max(200).optional().describe("Codex thread UUID or exact session name"),
      clearThreadId: z.boolean().optional().describe("Remove the configured thread id"),
    },
  },
  async (args) => {
    try {
      if (args.channel === undefined && args.codexThreadId === undefined && args.clearThreadId !== true) {
        // The read-only method exists from daemon 0.3.0. On an older daemon,
        // read the default target from the legacy notifications result without
        // returning any inbox record to the caller.
        const target = daemonSupportsNewIpc
          ? await client.request<NotifyTarget>("notification_target_get", {})
          : (await client.request<NotificationsResult>("notifications", { state: "all", limit: 1 })).target;
        return ok(presentNotifyTarget(target, mode));
      }
      const target = await client.request<NotifyTarget>("notification_target", {
        channel: args.channel,
        codexThreadId: args.clearThreadId ? null : args.codexThreadId,
      });
      return ok(presentNotifyTarget(target, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

async function shutdown(): Promise<void> {
  try {
    await server.close();
  } catch {
    // Best effort.
  }
  client.close();
  process.exit(0);
}

process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function main(): Promise<void> {
  await client.connect();
  await assessDaemonCompatibility();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `harness-supervisor MCP server v${VERSION} connected to daemon ${daemonVersion} at ${stateDir} (mode=${mode}, source=${modeInfo.source})\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`harness-supervisor MCP server failed: ${errorMessage(error)}\n`);
  process.exit(1);
});
