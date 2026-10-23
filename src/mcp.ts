#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SupervisorError, errorMessage } from "./errors.js";
import { SupervisorClient } from "./ipc/client.js";
import { resolveStateDir, NotifyTargetSchema } from "./ipc/protocol.js";
import {
  formatToolError,
  presentAcceptedWorker,
  presentEvents,
  presentInfo,
  presentNotifications,
  presentNotifyTarget,
  presentStatus,
  presentWait,
  presentWorkerAction,
  presentWorkerList,
  resolveMcpMode,
  type McpPresentationMode,
  type ResolvedMcpMode,
} from "./mcp-presentation.js";
import {
  isTerminal,
  type ExtensionUiResponse,
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
const client = new SupervisorClient({
  stateDir,
  autoStart: true,
  connectTimeoutMs: 20_000,
});

const REQUIRED_DAEMON_VERSION = "0.4.0";
let daemonSupportsNewIpc = false;
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
  if (daemonSupportsNewIpc) return;
  if (mode === "production") {
    throw new SupervisorError("UNSUPPORTED", upgradeAdvice(daemonVersion));
  }
  process.stderr.write(`harness-supervisor MCP warning: ${upgradeAdvice(daemonVersion)}\n`);
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

function compactWaitEvents(events: WorkerEvent[], includeProgress: boolean) {
  if (includeProgress) return { events, eventsOmitted: 0 };
  const visible = events.filter((event) => {
    if (event.type !== "run.progress") return true;
    const kind = event.data?.kind;
    return kind === "queue_cleared" || (kind === "tool_end" && event.data?.isError === true);
  });
  return { events: visible, eventsOmitted: events.length - visible.length };
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
    "Explicit notification destination. Pass {channel:'codex-queue',codexThreadId:<verified originating thread id>} or {channel:'none'} for inbox-only. Spawn snapshots the current daemon default if omitted; resume preserves its original binding if omitted. Never guess the most recent session. MCP does not automatically identify the caller's Codex thread. Explicit resume binding authorizes takeover and affects future events only.",
  ),
};

const DEVELOPMENT_INSTRUCTIONS =
  "Harness Supervisor manages native Pi/Qoder/MiniMax Code workers. worker_spawn returns prompt acceptance, never completion. Reuse the worker id; do not spawn duplicates. worker_wait is bounded, omits ordinary progress, and returns when input is needed; answer through worker_answer. MCP event reads are pull-based. Important events also enter a durable inbox; acknowledge processed notification ids. For multiple Codex conversations, pass worker_spawn.notifyTarget with a verified originating thread id. It is persisted per worker and per event. Omission snapshots the daemon default for new workers; worker_resume omission preserves binding, while an explicit target authorizes takeover for future events. supervisor_wake_target only changes the shared default for new workers. No per-request Codex identity is inferred from MCP or the most recent session. Without a known route use channel='none'. codex-queue can trigger a new turn while the host has that target loaded; delivery is at-least-once and never itself proves wake-up.";

const PRODUCTION_INSTRUCTIONS =
  "Harness Supervisor manages independent native Pi/Qoder/MiniMax Code workers and is pull-based: it never wakes this conversation by itself. worker_spawn/worker_resume return acceptance, not completion; keep the returned id and lastSeq, reuse the worker, and use worker_wait or worker_status for the final state. When a run needs input, answer it with worker_answer using pendingInput.requestId; worker_send only queues steering/follow-up. Pass requestId on side-effecting calls: an identical retry replays, different parameters CONFLICT, and an interrupted request reports UNCERTAIN and is not re-executed. Durable notifications are read with supervisor_notifications (default: all unacknowledged) and acknowledged after processing. Omit notifyTarget to snapshot the daemon default for new workers; resume omission preserves the binding; for parallel conversations pass an explicit verified thread id. codex-queue delivery can start a turn only while the host has that thread loaded; delivery is at-least-once and is not proof of wake-up. MCP does not infer the caller's thread.";

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
  info: string;
  notifications: string;
  ack: string;
  wakeTarget: string;
}

const PRODUCTION_DESCRIPTIONS: ToolDescriptions = {
  spawn:
    "Start an independent native harness process (Pi by default) in its own working directory. Returns when the prompt is accepted, not when the task completes. Keep the returned id/lastSeq and observe with worker_wait or worker_status. Pass notifyTarget only for a verified destination; omission snapshots the daemon default for new workers.",
  status:
    "Return the current status, full result or error, pending input and lastSeq cursor. Recent events are returned only when recentEvents is explicitly set.",
  list:
    "List managed workers (newest first) with id, name, runtime, status and lastSeq. State persists across daemon restarts.",
  events:
    "Read stored normalized events after sinceSeq. Use the returned nextSeq as the next cursor; pass sinceSeq=0 for full history. This is a non-blocking read; use worker_wait to block.",
  wait:
    "Bounded long-poll (default 20s, maximum 120s). MCP is pull-based: the supervisor never wakes the main agent by itself, although optional codex-queue notifications can start a turn when the host has that thread loaded. Without sinceSeq it checks current state and the latest events first, then waits from the current tail. Returns early when terminal, awaiting_input, or a requested types event appears. Ordinary run.progress is omitted unless includeProgress=true or types includes run.progress. Pass sinceSeq for strict cursor delivery. Timeout is not failure.",
  send:
    "Queue a steering message (before the next model turn) or follow-up (after the current run) through the native harness. Valid only while running; it returns acceptance, not completion. Pi applies both natively. Qoder 1.1.76 accepts the stream message without a verified effect on the running turn. MiniMax Code steers an active turn through its steer extension and was verified to act on it; a steer sent after the turn ended is rejected by the agent. This does not answer extension dialogs; use worker_answer.",
  answer:
    "Answer a pending run.needs_input request (Pi extension select/confirm/input/editor). Provide exactly one of value, confirmed, or cancelled=true, with the returned requestId. The worker must still have that matching pending request.",
  cancel:
    "Clear queued messages, abort the run, stop the harness process tree and return the final cancelled state. Other workers are unaffected. An orphaned process left by a supervisor restart returns UNSUPPORTED because its control channel is gone; verify and terminate it out-of-band. Cancellation cannot be undone.",
  resume:
    "Start a new harness process attached to an existing persisted session and send a new instruction. Only a terminal worker whose old process is gone can resume; the session is verified. It does not continue the interrupted in-memory run or automatically retry the old task. Omit notifyTarget to keep the existing binding.",
  info:
    "Show the supervisor version, this MCP process mode, limits, runtimes and the explicit notification-delivery boundary. Delivery is at-least-once and is not proof of wake-up.",
  notifications:
    "Read durable notifications for important lifecycle events (completed, failed, cancelled, needs_input, crashed, detached). By default returns all unacknowledged records regardless of delivery state, so old acknowledged records never hide new ones. Filter by workerId; use state only for an explicit delivery-state view. Acknowledge processed ids afterwards.",
  ack:
    "Mark notification ids as processed. Idempotent; unknown ids are reported rather than treated as errors.",
  wakeTarget:
    "Set the default notification destination for NEW workers; existing workers keep their persisted targets. channel='codex-queue' requires a verified thread id and starts a turn only while the host has that thread loaded. Without arguments it returns the current default target. Use an explicit worker_spawn.notifyTarget for parallel conversations.",
};

const DEVELOPMENT_DESCRIPTIONS: ToolDescriptions = {
  spawn:
    "Start an independent native harness process (Pi by default) in its own working directory. Returns as soon as the prompt is accepted, NOT when the task completes. Save the returned worker id and lastSeq; use worker_wait for progress/completion. Do not spawn a duplicate worker for the same task while this one is active. The worker survives this MCP client disconnecting because the supervisor daemon owns it.",
  status:
    "Return the current lifecycle status, lastSeq cursor, recent incremental events, pending input request, result/error, and the last harness stderr tail. Status 'running' means the prompt is being processed; only terminal statuses (completed, failed, cancelled, crashed, orphaned, interrupted) end the task.",
  list:
    "List workers managed by the supervisor, newest first. State persists across daemon restarts.",
  events:
    "Read normalized events after a sequence cursor. Use the returned nextSeq as the next sinceSeq. Pass sinceSeq=0 for full stored history. This is a fast, non-blocking read; use worker_wait when you want to block for progress or completion.",
  wait:
    "Bounded long-poll. MCP tools are pull-based: this call returns only when the host invokes it; the supervisor never wakes the main agent by itself (optional codex-queue notifications can start a turn only while the host has that thread loaded). Default 20s, maximum 120s. Without sinceSeq, it first checks current status and the latest 20 events: if the worker is already terminal or awaiting_input, or a requested 'types' event is already in that window, it returns immediately; otherwise it waits from the current tail. With sinceSeq, it uses strict cursor semantics and only returns events after that sequence. Normal run.progress events are omitted by default to keep context small; queue_cleared and tool-error progress are retained. Pass includeProgress=true (or request types=['run.progress']) for full progress, or use worker_events for complete history. By default waits until terminal OR awaiting_input; use until='event' to return on the first matching new event. Pass sinceSeq (from lastSeq/nextSeq) when you need lossless incremental delivery.",
  send:
    "Queue a steering message (delivered before the next model turn) or a follow-up (delivered after the current run) through the native harness. Only valid while the worker is running; if it already reached a terminal state this returns INVALID_STATE, and you should not spawn a replacement automatically. This does not answer extension dialogs; use worker_answer for run.needs_input events. Delivery differs per runtime: Pi applies steering/follow-ups natively, while Qoder 1.1.76 accepts the stream message (run.message_sent) without a verified effect on the running turn, so do not assume the model acted on it. MiniMax Code applies steering through its mcode/session/steer extension and queues follow-ups through mcode/session/queue/enqueue, both of which require a build that advertises them. A real 0.6.12 process accepted a steer sent during an active turn and the agent acted on it (mode 'steered'), but the same call outside an admitted turn is rejected ('Steering requires an admitted, active ACP prompt Turn'), so a steering message can reach a running turn and still be dropped when the turn has ended; check the worker state before assuming it was delivered. Pass requestId to make a retry after a timeout replay the recorded outcome instead of enqueueing the same text twice; if the daemon crashed mid-send the outcome is reported as UNCERTAIN, because the harness may already have received the message.",
  answer:
    "Respond to a run.needs_input event (Pi extension select/confirm/input/editor). Provide exactly one of value, confirmed, or cancelled. The worker must currently have a matching pending request.",
  cancel:
    "Clear queued steering/follow-up messages, abort the native run, stop the harness process (force-killing its process tree if needed), and return the final cancelled state. Other workers are unaffected. If the worker is an orphaned process left by a supervisor restart, this returns UNSUPPORTED because the supervisor no longer owns its control channel; verify and terminate that PID out-of-band. Cancellation is not a pause and cannot be undone.",
  resume:
    "Start a new harness process attached to an existing Pi session file and send a new instruction. Only works for a terminal worker with a persisted session that still exists and whose old process is not alive. The supervisor verifies the session id and refuses to fake a resume. This does not continue the interrupted in-memory run, replay its tool calls, or automatically retry the old task. Pass requestId so a retry after a timeout cannot start a second process for the same instruction.",
  info:
    "Show daemon information, limits, runtimes, and the explicit event-delivery boundary: events are persisted and pull-based; the supervisor does not claim background wake-up of the main agent.",
  notifications:
    "List durable notifications for important lifecycle events (completed, failed, cancelled, needs_input, crashed, detached). Each notification has a stable id, worker id, runtime, event seq, kind, a short summary and delivery state. Ordinary run.progress events are never included. Use it after a reconnect or daemon restart instead of polling worker status. Acknowledge processed ids with supervisor_notifications_ack so repeated sessions do not reprocess them; unacknowledged records are never dropped.",
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
    instructions: mode === "production" ? PRODUCTION_INSTRUCTIONS : DEVELOPMENT_INSTRUCTIONS,
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
          "Runtime adapter name (default: pi; qoder uses the Qoder CLI; mcode uses MiniMax Code over ACP)",
        ),
      name: z.string().min(1).max(200).optional().describe("Human-readable worker label"),
      ...ConfigShape,
      ...RequestIdShape,
      ...NotifyTargetShape,
    },
  },
  async (args) => {
    try {
      const result = await client.request(
        "spawn",
        {
          runtime: args.runtime ?? "pi",
          cwd: args.cwd,
          prompt: args.prompt,
          name: args.name,
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
      return ok(presentAcceptedWorker(result as WorkerSummary, mode));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_status",
  {
    title: "Get worker status and recent events",
    description: descriptions.status,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      workerId: z.string().min(1),
      recentEvents: z.number().int().min(0).max(100).optional(),
    },
  },
  async (args) => {
    try {
      const includeRecentEvents = args.recentEvents !== undefined;
      const result = await client.request<WorkerStatusResult>("status", {
        workerId: args.workerId,
        recentEvents: includeRecentEvents ? args.recentEvents : mode === "production" ? 0 : 20,
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
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async (args) => {
    try {
      return ok(
        presentWorkerList(
          await client.request<WorkerSummary[]>("list", {
            statuses: args.statuses as WorkerStatus[] | undefined,
            limit: args.limit,
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
  "worker_events",
  {
    title: "Read incremental worker events",
    description: descriptions.events,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      workerId: z.string().min(1),
      sinceSeq: z.number().int().min(0).optional().describe("Return events with seq > sinceSeq"),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async (args) => {
    try {
      const result = await client.request<ReadEventsResult>("events", {
        workerId: args.workerId,
        sinceSeq: args.sinceSeq ?? 0,
        limit: args.limit ?? 100,
      });
      return ok(presentEvents(result, mode));
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
      types: z.array(z.string()).max(30).optional().describe("Wake early on any of these event types"),
      includeProgress: z
        .boolean()
        .optional()
        .describe("Include run.progress events (tool/turn/assistant updates). Defaults to false; use worker_events for full history"),
    },
  },
  async (args) => {
    const timeoutMs = args.timeoutMs ?? 20_000;
    const until = args.until ?? "terminal";
    const includeProgress =
      args.includeProgress === true || (args.types?.includes("run.progress") ?? false);
    try {
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
          const compacted = compactWaitEvents(
            terminal || needsInput ? recent : matched,
            includeProgress,
          );
          return ok(
            presentWait(
              {
                worker: current,
                events: recent,
                nextSeq: current.lastSeq,
                hasMore: false,
                timedOut: false,
                terminal,
              },
              compacted,
              mode,
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
          types: args.types,
        },
        { timeoutMs: timeoutMs + 10_000 },
      );
      const compacted = compactWaitEvents(result.events, includeProgress);
      return ok(presentWait(result, compacted, mode));
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
    inputSchema: {
      workerId: z.string().min(1),
      requestId: z.string().min(1),
      value: z.string().optional(),
      confirmed: z.boolean().optional(),
      cancelled: z.boolean().optional(),
    },
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
      return ok(
        presentWorkerAction(
          await client.request<WorkerSummary>("answer", {
            workerId: args.workerId,
            requestId: args.requestId,
            response,
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
      return ok(
        presentWorkerAction(
          await client.request<WorkerSummary>(
            "cancel",
            { workerId: args.workerId, timeoutMs },
            { timeoutMs: timeoutMs + 15_000 },
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
      return ok(
        presentAcceptedWorker(
          await client.request<WorkerSummary>(
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
  "supervisor_info",
  {
    title: "Supervisor capabilities and wake semantics",
    description: descriptions.info,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const info = await client.request<SupervisorInfo>("info", {});
      return ok(presentInfo(info, mode, mode));
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
    },
  },
  async (args) => {
    try {
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
      return ok(await client.request("notification_ack", { ids: args.ids, by: args.by ?? "mcp" }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
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
