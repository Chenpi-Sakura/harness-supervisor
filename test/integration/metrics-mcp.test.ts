import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SupervisorClient } from "../../src/ipc/client.js";
import type { MetricsReport, TaskMetrics, TaskRecord, UsageRecord } from "../../src/metrics.js";
import type { WorkerSummary } from "../../src/types.js";
import { MCP_ENTRY, TestDaemon, makeWorkspace, waitTerminal } from "./helpers.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

function parseTool(result: ToolResult): unknown {
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
}

async function connectMcp(t: TestContext, stateDir: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY, "--state-dir", stateDir],
    env: { ...process.env, HARNESS_SUPERVISOR_MCP_MODE: "" },
    stderr: "pipe",
  });
  const mcp = new Client({ name: "hs-metrics-mcp-test", version: "1.0.0" });
  await mcp.connect(transport);
  t.after(async () => {
    await mcp.close().catch(() => undefined);
  });
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  return parseTool((await mcp.callTool({ name, arguments: args })) as ToolResult);
}

test("MCP exposes task creation, worker linking, usage recording and reports", async (t) => {
  const daemon = await TestDaemon.create("hs-metrics-mcp-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client: SupervisorClient = await daemon.start();
  const cwd = await makeWorkspace("hs-metrics-mcp-work-");
  const mcp = await connectMcp(t, daemon.stateDir);

  const task = (await call(mcp, "metrics_task_create", {
    title: "MCP metrics task",
    category: "coding",
  })) as TaskRecord;
  assert.equal(task.title, "MCP metrics task");
  assert.equal(task.createdBy, "mcp");

  const accepted = (await call(mcp, "worker_spawn", {
    cwd,
    prompt: "MCP metrics worker",
    name: "MCP metrics worker",
    taskId: task.id,
  })) as WorkerSummary;
  assert.equal(accepted.taskId, task.id);
  await waitTerminal(client, accepted.id, 30_000);

  const shown = (await call(mcp, "metrics_task_show", { taskId: task.id })) as TaskMetrics;
  assert.equal(shown.status, "completed");
  assert.deepEqual(shown.task.workerIds, [accepted.id]);
  assert.equal(shown.usage.length, 1);
  assert.equal(shown.usage[0]?.inputTokens, 10);
  assert.equal(shown.usage[0]?.confidence, "partial");

  const usage = (await call(mcp, "metrics_record_usage", {
    taskId: task.id,
    role: "parent_agent",
    usageId: "mcp-parent-1",
    inputTokens: 77,
    outputTokens: 11,
    attribution: "incremental",
    confidence: "partial",
  })) as UsageRecord;
  assert.equal(usage.inputTokens, 77);
  assert.equal(usage.attribution, "incremental");

  const report = (await call(mcp, "metrics_report", {
    includeTasks: true,
  })) as MetricsReport;
  assert.equal(report.taskCount, 1);
  assert.equal(report.counts.completed, 1);
  assert.equal(report.knownWorkerUsage.inputTokens.value, 10);
  assert.equal(report.knownParentUsage.inputTokens.value, 77);
  assert.equal(report.usageCoverage.tasksWithAttributableParentUsage, 1);
  assert.equal(report.notTracked.intervention.includes("Not collected"), true);
  assert.equal(report.tasks?.[0]?.task.id, task.id);
});
