#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SupervisorError, errorMessage } from "./errors.js";
import { SupervisorClient } from "./ipc/client.js";
import { resolveStateDir } from "./ipc/protocol.js";
import type { ExtensionUiResponse, SendMode, WorkerStatus } from "./types.js";
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

const server = new McpServer({
  name: "harness-supervisor",
  version: VERSION,
});

server.registerTool(
  "worker_spawn",
  {
    title: "Spawn a native harness worker",
    description:
      "Start an independent native harness process (Pi by default) in its own working directory. Returns as soon as the prompt is accepted, NOT when the task completes. Save the returned worker id and poll with worker_wait or worker_status. The worker survives this MCP client disconnecting because the supervisor daemon owns it.",
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
      "Return the current lifecycle status, recent incremental events, pending input request, result/error, and the last harness stderr tail. Status 'running' means the prompt is being processed; only terminal statuses (completed, failed, cancelled, crashed, orphaned, interrupted) end the task.",
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
      "Read normalized events after a sequence cursor. Use the returned nextSeq as the next sinceSeq. This is a fast, non-blocking read; use worker_wait when you want to block for progress or completion.",
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
      "Bounded long-poll for new events or a terminal state. MCP tools are pull-based: this returns when the host calls it, and the supervisor cannot wake the main agent in the background. Default 20s, maximum 120s. By default waits until the worker reaches a terminal state OR needs input (status awaiting_input), since it cannot progress without the client; use until='event' to return on the first new event. Pass sinceSeq to avoid re-reading events.",
    inputSchema: {
      workerId: z.string().min(1),
      sinceSeq: z.number().int().min(0).optional(),
      timeoutMs: z.number().int().min(0).max(120_000).optional(),
      until: z.enum(["terminal", "event"]).optional(),
      types: z.array(z.string()).max(30).optional().describe("Wake early on any of these event types"),
    },
  },
  async (args) => {
    const timeoutMs = args.timeoutMs ?? 20_000;
    try {
      return ok(
        await client.request(
          "wait",
          {
            workerId: args.workerId,
            sinceSeq: args.sinceSeq,
            timeoutMs,
            until: args.until ?? "terminal",
            types: args.types,
          },
          { timeoutMs: timeoutMs + 10_000 },
        ),
      );
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
      "Queue a steering message (delivered before the next model turn) or a follow-up (delivered after the current run) through the native harness. Only valid while the worker is running. This does not answer extension dialogs; use worker_answer for run.needs_input events.",
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
      "Abort the native run, stop the harness process (force-killing its process tree if needed), and return the final cancelled state. Other workers are unaffected. Cancellation is not a pause and cannot be undone.",
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
      "Start a new harness process attached to an existing Pi session file and send a new instruction. Only works for a terminal worker with a persisted session that still exists and whose old process is not alive. The supervisor verifies the session id and refuses to fake a resume. Does not automatically retry the old task.",
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
