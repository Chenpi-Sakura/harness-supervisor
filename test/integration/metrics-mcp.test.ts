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

async function connectMcp(
  t: TestContext,
  stateDir: string,
  mode?: "production" | "development",
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY, "--state-dir", stateDir],
    env: { ...process.env, HARNESS_SUPERVISOR_MCP_MODE: mode ?? "" },
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
  const development = await connectMcp(t, daemon.stateDir, "development");

  const task = (await call(mcp, "metrics_task_create", {
    title: "MCP metrics task",
    category: "coding",
  })) as unknown as { taskId: string; title: string; category?: string };
  assert.equal(task.title, "MCP metrics task");
  assert.equal(task.category, "coding");
  assert.equal(
    "createdBy" in task,
    false,
    "production task summaries omit metrics diagnostics",
  );
  const taskId = task.taskId;
  assert.ok(taskId);

  const accepted = (await call(mcp, "worker_spawn", {
    cwd,
    prompt: "MCP metrics worker",
    name: "MCP metrics worker",
    taskId,
  })) as WorkerSummary;
  assert.equal(accepted.taskId, taskId);
  await waitTerminal(client, accepted.id, 30_000);

  const shown = (await call(mcp, "metrics_task_show", { taskId })) as TaskMetrics;
  assert.equal(shown.status, "completed");
  assert.deepEqual(shown.task.workerIds, [accepted.id]);
  assert.equal(
    "usage" in shown,
    false,
    "production task metrics return summaries, not raw usage records",
  );

  const shownDevelopment = (await call(development, "metrics_task_show", {
    taskId,
  })) as TaskMetrics;
  assert.equal(shownDevelopment.task.createdBy, "mcp");
  assert.equal(shownDevelopment.usage.length, 1);
  assert.equal(shownDevelopment.usage[0]?.inputTokens, 10);
  assert.equal(shownDevelopment.usage[0]?.confidence, "partial");

  const usage = (await call(mcp, "metrics_record_usage", {
    taskId,
    role: "parent_agent",
    usageId: "mcp-parent-1",
    inputTokens: 77,
    outputTokens: 11,
    attribution: "incremental",
    confidence: "partial",
  })) as unknown as { usageId: string; attribution: string };
  assert.equal(usage.usageId, "manual:mcp-parent-1");
  assert.equal(usage.attribution, "incremental");
  assert.equal("inputTokens" in usage, false, "production usage records omit token details");

  const report = (await call(mcp, "metrics_report", {
    includeTasks: true,
  })) as MetricsReport;
  assert.equal(report.taskCount, 1);
  assert.equal(report.counts.completed, 1);
  assert.equal(report.knownWorkerUsage.inputTokens.value, 10);
  assert.equal(report.knownParentUsage.inputTokens.value, 77);
  assert.equal(report.usageCoverage.tasksWithAttributableParentUsage, 1);
  assert.equal(report.notTracked.intervention.includes("Not collected"), true);
  const reportTask = (report.tasks?.[0] ?? {}) as unknown as Record<string, unknown>;
  assert.equal(reportTask.taskId, taskId);
  assert.equal("usage" in reportTask, false);

  const developmentReport = (await call(development, "metrics_report", {
    includeTasks: true,
  })) as MetricsReport;
  assert.equal(developmentReport.tasks?.[0]?.task.id, taskId);
  assert.equal(
    developmentReport.tasks?.[0]?.usage.some(
      (record) =>
        (record as unknown as { usageId: string }).usageId === "manual:mcp-parent-1" &&
        record.inputTokens === 77,
    ),
    true,
  );
});
