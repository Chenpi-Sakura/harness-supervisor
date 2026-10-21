import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sleep } from "../../src/util/async.js";
import {
  FAKE_ENTRY,
  MCP_ENTRY,
  connectExisting,
  makeWorkspace,
} from "./helpers.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function parseTool(result: ToolResult): any {
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool result has no text");
  return JSON.parse(text);
}

test("MCP client can spawn, observe, steer, cancel, and outlive its own disconnect", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-mcp-"));
  const cwd = await makeWorkspace();
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY, "--state-dir", stateDir],
    env: {
      ...process.env,
      HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY,
      FAKE_PI_STEP_MS: "20",
      FAKE_PI_SLOW_STEP_MS: "5000",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const mcp = new Client({ name: "harness-supervisor-test", version: "1.0.0" });
  await mcp.connect(transport);
  t.after(async () => {
    try {
      await mcp.close();
    } catch {
      // Already closed by the test.
    }
    try {
      const daemonClient = await connectExisting(stateDir, 5000);
      await daemonClient.shutdown();
      daemonClient.close();
    } catch {
      // Daemon may already be stopped.
    }
  });

  const tools = await mcp.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const name of [
    "worker_spawn",
    "worker_status",
    "worker_list",
    "worker_events",
    "worker_wait",
    "worker_send",
    "worker_answer",
    "worker_cancel",
    "worker_resume",
    "supervisor_info",
  ]) {
    assert.ok(toolNames.includes(name), `missing tool ${name}; stderr=${stderr}`);
  }

  const info = parseTool(
    (await mcp.callTool({ name: "supervisor_info", arguments: {} })) as ToolResult,
  );
  assert.equal(info.wake.proactive, false);
  assert.match(info.wake.note, /pull-based/i);

  const worker = parseTool(
    (await mcp.callTool({
      name: "worker_spawn",
      arguments: { cwd, prompt: "[scenario:slow] MCP controlled worker" },
    })) as ToolResult,
  );
  assert.equal(worker.status, "running");

  const started = parseTool(
    (await mcp.callTool({
      name: "worker_wait",
      arguments: {
        workerId: worker.id,
        sinceSeq: 0,
        timeoutMs: 5000,
        until: "event",
        types: ["run.started"],
      },
    })) as ToolResult,
  );
  assert.ok(started.events.some((event: { type: string }) => event.type === "run.started"));

  const sent = parseTool(
    (await mcp.callTool({
      name: "worker_send",
      arguments: {
        workerId: worker.id,
        message: "MCP says hello",
        mode: "steer",
      },
    })) as ToolResult,
  );
  assert.equal(sent.status, "running");

  const doomed = parseTool(
    (await mcp.callTool({
      name: "worker_spawn",
      arguments: { cwd, prompt: "[scenario:slow] MCP cancel target" },
    })) as ToolResult,
  );
  const cancelled = parseTool(
    (await mcp.callTool({
      name: "worker_cancel",
      arguments: { workerId: doomed.id, timeoutMs: 8000 },
    })) as ToolResult,
  );
  assert.equal(cancelled.status, "cancelled");

  const errorResult = (await mcp.callTool({
    name: "worker_answer",
    arguments: { workerId: worker.id, requestId: "missing", cancelled: true },
  })) as ToolResult;
  assert.equal(errorResult.isError, true);
  assert.match(errorResult.content[0]?.text ?? "", /INVALID_STATE/);

  await mcp.close();
  await sleep(5500);

  const daemonClient = await connectExisting(stateDir, 10_000);
  const status = await daemonClient.request<{
    worker: { status: string; result?: { text: string } };
  }>("status", { workerId: worker.id, recentEvents: 50 });
  assert.equal(status.worker.status, "completed");
  assert.match(status.worker.result?.text ?? "", /FAKE_PI_OK/);
  assert.match(status.worker.result?.text ?? "", /STEERED:MCP says hello/);

  const cancelledStatus = await daemonClient.request<{
    worker: { status: string };
  }>("status", { workerId: doomed.id });
  assert.equal(cancelledStatus.worker.status, "cancelled");

  await daemonClient.shutdown();
  daemonClient.close();
});
