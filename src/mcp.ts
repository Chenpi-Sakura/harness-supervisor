#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SupervisorError, errorMessage } from "./errors.js";
import { SupervisorClient } from "./ipc/client.js";
import { resolveStateDir } from "./ipc/protocol.js";
import {
  isTerminal,
  type ExtensionUiResponse,
  type SendMode,
  type WaitResult,
  type WorkerEvent,
  type WorkerStatus,
  type WorkerStatusResult,
} from "./types.js";
import { VERSION } from "./version.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const stateDir = resolveStateDir(argValue("--state-dir"));
const client = new SupervisorClient({
  stateDir,
  autoStart: true,
  connectTimeoutMs: 20_000,
});

function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function fail(error: unknown) {
  const code = error instanceof SupervisorError ? error.code : "INTERNAL";
  const details =
    error instanceof SupervisorError && error.details
      ? `\n${JSON.stringify(error.details, null, 2)}`
      : "";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${code}: ${errorMessage(error)}${details}` }],
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

const server = new McpServer(
  {
    name: "harness-supervisor",
    version: VERSION,
  },
  {
    instructions:
      "Harness Supervisor owns native Pi workers. worker_spawn returns after prompt acceptance, never completion. Use worker_wait without sinceSeq for condition waits (it checks current status and the latest events first), or pass a cursor for strict incremental reads. worker_wait omits noisy run.progress events by default (queue_cleared and tool-error progress are kept); pass includeProgress=true or use worker_events for the full history. worker_wait returns immediately when the worker needs input; answer with worker_answer. MCP is pull-based: there is no background wake-up. Reuse the worker id until terminal; do not spawn a duplicate for the same task.",
  },
);

server.registerTool(
  "worker_spawn",
  {
    title: "Spawn a native harness worker",
    description:
      "Start an independent native harness process (Pi by default) in its own working directory. Returns as soon as the prompt is accepted, NOT when the task completes. Save the returned worker id and lastSeq; use worker_wait for progress/completion. Do not spawn a duplicate worker for the same task while this one is active. The worker survives this MCP client disconnecting because the supervisor daemon owns it.",
    inputSchema: {
      cwd: z.string().min(1).describe("Working directory for the harness process"),
      prompt: z.string().min(1).describe("Task/instruction sent to the native harness"),
      runtime: z.string().min(1).optional().describe("Runtime adapter name (default: pi)"),
      name: z.string().min(1).max(200).optional().describe("Human-readable worker label"),
      ...ConfigShape,
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
        },
        { timeoutMs: 90_000 },
      );
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_status",
  {
    title: "Get worker status and recent events",
    description:
      "Return the current lifecycle status, lastSeq cursor, recent incremental events, pending input request, result/error, and the last harness stderr tail. Status 'running' means the prompt is being processed; only terminal statuses (completed, failed, cancelled, crashed, orphaned, interrupted) end the task.",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      workerId: z.string().min(1),
      recentEvents: z.number().int().min(0).max(100).optional(),
    },
  },
  async (args) => {
    try {
      const result = await client.request("status", {
        workerId: args.workerId,
        recentEvents: args.recentEvents ?? 20,
      });
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_list",
  {
    title: "List workers",
    description: "List workers managed by the supervisor, newest first. State persists across daemon restarts.",
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
        await client.request("list", {
          statuses: args.statuses as WorkerStatus[] | undefined,
          limit: args.limit,
        }),
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
    description:
      "Read normalized events after a sequence cursor. Use the returned nextSeq as the next sinceSeq. Pass sinceSeq=0 for full stored history. This is a fast, non-blocking read; use worker_wait when you want to block for progress or completion.",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      workerId: z.string().min(1),
      sinceSeq: z.number().int().min(0).optional().describe("Return events with seq > sinceSeq"),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async (args) => {
    try {
      return ok(
        await client.request("events", {
          workerId: args.workerId,
          sinceSeq: args.sinceSeq ?? 0,
          limit: args.limit ?? 100,
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_wait",
  {
    title: "Wait for worker progress or completion",
    description:
      "Bounded long-poll. MCP tools are pull-based: this returns when the host calls it, and the supervisor cannot wake the main agent in the background. Default 20s, maximum 120s. Without sinceSeq, it first checks current status and the latest 20 events: if the worker is already terminal or awaiting_input, or a requested 'types' event is already in that window, it returns immediately; otherwise it waits from the current tail. With sinceSeq, it uses strict cursor semantics and only returns events after that sequence. Normal run.progress events are omitted by default to keep context small; queue_cleared and tool-error progress are retained. Pass includeProgress=true (or request types=['run.progress']) for full progress, or use worker_events for complete history. By default waits until terminal OR awaiting_input; use until='event' to return on the first matching new event. Pass sinceSeq (from lastSeq/nextSeq) when you need lossless incremental delivery.",
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
          return ok({
            worker: current,
            events: compacted.events,
            eventsOmitted: compacted.eventsOmitted,
            nextSeq: current.lastSeq,
            hasMore: false,
            timedOut: false,
            terminal,
          });
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
      return ok({
        ...result,
        events: compacted.events,
        eventsOmitted: compacted.eventsOmitted,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_send",
  {
    title: "Send a supplementary instruction to a running worker",
    description:
      "Queue a steering message (delivered before the next model turn) or a follow-up (delivered after the current run) through the native harness. Only valid while the worker is running; if it already reached a terminal state this returns INVALID_STATE, and you should not spawn a replacement automatically. This does not answer extension dialogs; use worker_answer for run.needs_input events.",
    inputSchema: {
      workerId: z.string().min(1),
      message: z.string().min(1),
      mode: z.enum(["steer", "follow-up"]).optional(),
    },
  },
  async (args) => {
    try {
      return ok(
        await client.request("send", {
          workerId: args.workerId,
          message: args.message,
          mode: (args.mode ?? "steer") as SendMode,
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "worker_answer",
  {
    title: "Answer a pending native extension dialog",
    description:
      "Respond to a run.needs_input event (Pi extension select/confirm/input/editor). Provide exactly one of value, confirmed, or cancelled. The worker must currently have a matching pending request.",
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
        await client.request("answer", {
          workerId: args.workerId,
          requestId: args.requestId,
          response,
        }),
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
    description:
      "Clear queued steering/follow-up messages, abort the native run, stop the harness process (force-killing its process tree if needed), and return the final cancelled state. Other workers are unaffected. If the worker is an orphaned process left by a supervisor restart, this returns UNSUPPORTED because the supervisor no longer owns its control channel; verify and terminate that PID out-of-band. Cancellation is not a pause and cannot be undone.",
    inputSchema: {
      workerId: z.string().min(1),
      timeoutMs: z.number().int().min(500).max(60_000).optional(),
    },
  },
  async (args) => {
    try {
      const timeoutMs = args.timeoutMs ?? 20_000;
      return ok(
        await client.request(
          "cancel",
          { workerId: args.workerId, timeoutMs },
          { timeoutMs: timeoutMs + 15_000 },
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
    description:
      "Start a new harness process attached to an existing Pi session file and send a new instruction. Only works for a terminal worker with a persisted session that still exists and whose old process is not alive. The supervisor verifies the session id and refuses to fake a resume. This does not continue the interrupted in-memory run, replay its tool calls, or automatically retry the old task.",
    inputSchema: {
      workerId: z.string().min(1),
      prompt: z.string().min(1),
      ...ConfigShape,
    },
  },
  async (args) => {
    try {
      return ok(
        await client.request(
          "resume",
          {
            workerId: args.workerId,
            prompt: args.prompt,
            model: args.model,
            provider: args.provider,
            tools: args.tools,
            thinking: args.thinking,
            maxDurationMs: args.maxDurationMs,
          },
          { timeoutMs: 90_000 },
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
    description:
      "Show daemon information, limits, runtimes, and the explicit event-delivery boundary: events are persisted and pull-based; the supervisor does not claim background wake-up of the main agent.",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      return ok(await client.request("info", {}));
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `harness-supervisor MCP server v${VERSION} connected to daemon at ${stateDir}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`harness-supervisor MCP server failed: ${errorMessage(error)}\n`);
  process.exit(1);
});
