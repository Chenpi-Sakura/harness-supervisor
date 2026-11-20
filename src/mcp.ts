#!/usr/bin/env node
import { retainCurrentRuntime } from "./runtime-cache.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callerMetaRejection, callerThreadFromMeta } from "./caller-thread.js";
import { harnessNames } from "./harness-catalog.js";
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
  presentJobObservation,
  presentMetricsReport,
  presentNotificationAck,
  presentNotifications,
  presentNotifyTarget,
  presentStatus,
  presentStructuredResult,
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
  MIN_RUN_DURATION_MS,
  MAX_RUN_DURATION_MS,
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
import { JobAttachSchema, StructuredResultSchema } from "./worker-result.js";
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
      "Idempotency key. Reuse with identical parameters to replay the recorded result.",
    ),
};

const turnDurationRange = "Set maxDurationMs from 1 second to 24 hours.";
const inheritedTurnDuration = turnDurationRange + " Omit to inherit the previous limit, or default to 1 hour.";

const ConfigShape = {
  model: z.string().min(1).max(200).optional().describe("Requested model; ACP requires an advertised id (OpenCode: provider/model)"),
  provider: z.string().min(1).max(200).optional().describe("Provider override where supported; otherwise uses native runtime settings"),
  tools: z
    .array(z.string())
    .min(1)
    .max(50)
    .optional()
    .describe("Tool allowlist where supported, e.g. ['read','bash','edit','write']"),
  thinking: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional()
    .describe("Requested reasoning effort where supported"),
  maxDurationMs: z
    .number()
    .int()
    .min(MIN_RUN_DURATION_MS)
    .max(MAX_RUN_DURATION_MS)
    .optional()
    .describe("Turn execution limit in milliseconds."),
};

const NotifyTargetShape = {
  notifyTarget: NotifyTargetSchema.optional().describe(
    "Explicit destination for future notifications. Use codex-queue with the originating Codex thread ID, or none for inbox-only delivery.",
  ),
};

const DEVELOPMENT_INSTRUCTIONS =
  "Harness Supervisor manages native " + Object.values(harnessNames).join("/") + " workers. worker_spawn returns prompt acceptance, never completion. Reuse the worker id; do not spawn duplicates. Spawn with persistence='persistent' when the same worker should accept later Turns via worker_continue after its process exits. worker_wait is bounded, omits ordinary progress, and returns when input is needed; answer through worker_answer. MCP event reads are pull-based. Important events also enter a durable inbox; acknowledge processed notification ids. worker_spawn auto-binds to the current Codex thread when the host supplies per-call thread metadata; an explicit worker_spawn.notifyTarget overrides it, and omission falls back to the daemon default only when no caller identity is available. Bindings are persisted per worker and per event; worker_resume omission preserves the binding, while an explicit target authorizes takeover for future events. supervisor_wake_target only changes the shared default for new workers. Without a known route use channel='none'. codex-queue can trigger a new turn while the host has that target loaded; delivery is at-least-once and never itself proves wake-up. Task metrics are phase 1-2: a spawn auto-creates or links a task, and supervisor_metrics_* expose task and report data. Main-agent usage is never read from the host and must be recorded explicitly; unknown is not zero. Cost, acceptance, rework and intervention are not collected yet.";

const PRODUCTION_INSTRUCTIONS =
  "Harness Supervisor manages independent native " + Object.values(harnessNames).join("/") + " workers and is pull-based: it does not poll; a bound codex-queue target can start a turn when the host has that thread loaded. worker_spawn/worker_resume/worker_continue return acceptance, not completion; keep the returned id and lastSeq, reuse the worker, and when notificationBinding.wake=bound and the host is known to deliver wake-ups for this thread, end the turn and let the completion notification bring you back; otherwise use worker_wait or worker_status. A worker spawned with persistence='persistent' keeps its id, native session and lifecycle=idle after each Turn; send the next instruction with worker_continue instead of spawning a replacement. Every task prompt is prefixed with the HS worker protocol: a worker finishes with its final answer and must not call `codex queue` or otherwise inject into this conversation; its PATH also rejects that subcommand. When a run needs input, answer it with worker_answer using pendingInput.requestId; worker_send only queues steering/follow-up. Pass requestId on side-effecting calls: an identical retry replays, different parameters CONFLICT, and an interrupted request reports UNCERTAIN and is not re-executed. Durable notifications are read with supervisor_notifications (default: all unacknowledged) and acknowledged after processing. Omit notifyTarget to snapshot the daemon default for new workers unless the host supplied per-call thread metadata, in which case HS auto-binds to the current Codex thread (source=caller); an explicit notifyTarget wins. resume omission preserves the binding. For a long-running independent task, spawn once, verify notificationBinding.wake=bound, then end the turn instead of polling worker_wait/worker_status/worker_events; use worker_wait when unbound, when the user asks for an immediate result, or after a notification. A bound target is not proof of wake-up; delivery is at-least-once. Task metrics are phase 1-2: a spawn auto-creates or links a task, and supervisor_metrics_* expose task and report data. Main-agent usage is never read from the host and must be recorded explicitly; unknown is not zero. Cost, acceptance, rework and intervention are not collected yet.";

const descriptions = {
  spawn: "Start a native Harness Worker and return prompt acceptance. Set persistence='persistent' to enable worker_continue. Use worker_wait for the result.",
  status: mode === "production"
    ? "Read the current Worker status, session availability, and a short result preview. Use includeInput for the full pending input or worker_wait for the final result."
    : "Read the current Worker status, result, pending input, and lifecycle diagnostics. Use recentEvents to include history.",
  list: "List Workers newest first. Use nextCursor with the same filters to get the next page. Set includeArchived to include archived Workers.",
  events: mode === "production"
    ? "Read compact lifecycle events. Omit sinceSeq for recent events, pass nextSeq as sinceSeq to continue, or use seq for one event."
    : "Read stored Worker events and payloads. Pass nextSeq as sinceSeq to continue, or use seq for one event.",
  wait: mode === "production"
    ? "Wait for a Worker result, input request, or selected lifecycle event. Use sinceSeq to resume from a cursor. Defaults to 30 seconds and allows up to 120 seconds."
    : "Wait for a Worker result, input request, or selected event. Use sinceSeq for a cursor and includeProgress for progress events. Defaults to 30 seconds and allows up to 120 seconds.",
  send: "Send steering or queue a follow-up for an active Worker when its Harness supports the requested mode.",
  answer: "Answer the Worker’s current input or approval request. Use pendingInput.requestId and provide one of value, confirmed, or cancelled.",
  cancel: "Cancel the Worker’s active run, clear queued messages, and stop its Harness process.",
  resume: "Run a new instruction on a terminal Worker’s persisted native session. Omit notifyTarget to keep its notification binding.",
  continue: "Give an idle persistent Worker its next instruction on the same native session.",
  resultSubmit: "Record one structured result for a settled Turn. Pass the exact Turn from worker_status or worker_wait; a stale Turn is rejected. Large detail belongs in artifact files; an identical resubmit replays and a different payload for the same Turn conflicts.",
  resultGet: "Read the full persisted structured report for the latest Turn or a specific Turn, including inputs, thresholds, items and execution evidence. Status and wait only show a compact summary.",
  jobAttach: "Link this Worker to an already-running long job by stable jobId and execution-side evidence path. This never starts or retries the job.",
  jobStatus: "Read job state from execution-side evidence. Job state is reported separately from the Worker lifecycle; artifacts are capped and the evidence file remains on disk.",
  admin: "Pin a Worker, archive it from the default list, or retire it to stop future runs. Each action is reversible.",
  forget: "Delete a terminal Worker’s HS record and events while preserving its native session. Requires an unpinned Worker with no unacknowledged notifications.",
  info: mode === "production"
    ? "Read the supervisor version, available runtimes, and Worker counts."
    : "Read the supervisor version, runtime capabilities, limits, and storage diagnostics.",
  notifications: mode === "production"
    ? "Read unacknowledged Worker notifications. Filter by workerId or delivery state."
    : "Read pending Worker notifications with delivery details. Filter by workerId or delivery state.",
  ack: "Mark notification IDs as processed. Repeating an acknowledgement is safe.",
  wakeTarget: "Read or set the default notification target for new Workers. Use none for inbox-only delivery or codex-queue with a Codex thread ID.",
};

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
    description: `${descriptions.spawn} ${turnDurationRange} The default is 1 hour.`,
    inputSchema: {
      cwd: z.string().min(1).describe("Working directory for the harness process"),
      prompt: z.string().min(1).describe("Task/instruction sent to the native harness"),
      runtime: z
        .string()
        .min(1)
        .optional()
        .describe(
          `Runtime adapter: ${Object.entries(harnessNames).map(([id, name]) => `${id}=${name}`).join(", ")} (default: pi). Codex and Claude use optional ACP adapters. OpenCode v2 uses its native CLI.`,
        ),
      name: z.string().min(1).max(200).optional().describe("Human-readable worker label"),
      persistence: z
        .enum(["oneshot", "persistent"])
        .optional()
        .describe(
          "Choose oneshot for a single Turn (default) or persistent to enable worker_continue.",
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
          "Include recent events in development mode.",
        ),
      includeResult: z
        .boolean()
        .optional()
        .describe(
          "Compatibility flag. Development mode includes the result by default.",
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
          "Read one event by sequence number. Production returns a compact lifecycle event.",
        ),
      includeProgress: z
        .boolean()
        .optional()
        .describe(
          "Compatibility flag. Development includes progress by default.",
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
          "Include progress events in development mode.",
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
                currentTurn: snapshot.currentTurn,
                events: recent,
                nextSeq: current.lastSeq,
                hasMore: false,
                timedOut: false,
                terminal,
                ...(snapshot.lastProgress ? { lastProgress: snapshot.lastProgress } : {}),
                ...(snapshot.timeline ? { timeline: snapshot.timeline } : {}),
                ...(snapshot.inputState ? { inputState: snapshot.inputState } : {}),
                ...(snapshot.latestResult ? { latestResult: snapshot.latestResult } : {}),
                ...(snapshot.jobs?.length ? { jobs: snapshot.jobs } : {}),
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
  "worker_result_submit",
  {
    title: "Record a structured result for the current Turn",
    description: descriptions.resultSubmit,
    inputSchema: {
      workerId: z.string().min(1),
      turn: z.number().int().min(1).describe("The Turn this result belongs to; get it from worker_status or worker_wait."),
      result: StructuredResultSchema,
      ...RequestIdShape,
    },
  },
  async (args) => {
    try {
      const response = await client.request<{
        accepted: true;
        duplicate: boolean;
        turn: number;
        result: Parameters<typeof presentStructuredResult>[0];
      }>("result_submit", {
        workerId: args.workerId,
        turn: args.turn,
        result: args.result,
        requestId: args.requestId,
      });
      return ok({
        accepted: response.accepted,
        duplicate: response.duplicate,
        turn: response.turn,
        submittedAt: response.result.submittedAt,
        execution: response.result.execution,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_result_get",
  {
    title: "Read persisted structured Turn results",
    description: descriptions.resultGet,
    inputSchema: {
      workerId: z.string().min(1),
      turn: z.number().int().min(1).optional().describe("Omit for the latest Turn."),
    },
  },
  async (args) => {
    try {
      const response = await client.request<{
        workerId: string;
        currentTurn: number;
        results: Array<Parameters<typeof presentStructuredResult>[0]>;
      }>("result_get", { workerId: args.workerId, turn: args.turn });
      const selected = args.turn === undefined ? response.results.slice(-1) : response.results;
      return ok({
        workerId: response.workerId,
        currentTurn: response.currentTurn,
        availableTurns: response.results.map((entry) => entry.turn),
        // Explicit result reads return the whole 8 KB-capped report. Compact
        // views belong to status/wait, where context is at a premium.
        results: selected,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_job_attach",
  {
    title: "Link a long-running job to this Worker",
    description: descriptions.jobAttach,
    inputSchema: {
      workerId: z.string().min(1),
      job: JobAttachSchema,
      ...RequestIdShape,
    },
  },
  async (args) => {
    try {
      const response = await client.request<{
        accepted: true;
        duplicate: boolean;
        job: unknown;
        observation: unknown;
      }>("job_attach", {
        workerId: args.workerId,
        job: args.job,
        requestId: args.requestId,
      });
      return ok({
        ...response,
        observation: response.observation
          ? presentJobObservation(response.observation as Parameters<typeof presentJobObservation>[0], mode)
          : null,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_job_status",
  {
    title: "Read long-job state from execution-side evidence",
    description: descriptions.jobStatus,
    inputSchema: {
      workerId: z.string().min(1),
      jobId: z.string().min(1).optional(),
    },
  },
  async (args) => {
    try {
      const response = await client.request<{
        workerId: string;
        currentTurn: number;
        jobs: Array<Parameters<typeof presentJobObservation>[0]>;
      }>("job_status", {
        workerId: args.workerId,
        jobId: args.jobId,
      });
      return ok({
        ...response,
        jobs: response.jobs.map((job) => presentJobObservation(job, mode)),
      });
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
    description: `${descriptions.resume} ${inheritedTurnDuration}`,
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
    description: `${descriptions.continue} ${inheritedTurnDuration}`,
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
    description: "Create a metrics task shared by Workers. Pass its taskId to worker_spawn to link a Worker.",
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
    description: "Read a task’s status, Worker timings, and recorded usage. Development mode includes individual usage records.",
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
    description: "Summarize task status, duration, and token usage over a creation-time range. Use includeTasks to include task summaries.",
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
    description: "Record token usage for a task. Supply a linked workerId for Worker usage and a usageId for safe retries.",
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
          "Include delivery diagnostics in development mode.",
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
  await retainCurrentRuntime(import.meta.url, stateDir);
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
