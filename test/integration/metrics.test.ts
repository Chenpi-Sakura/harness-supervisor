import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupervisorClient } from "../../src/ipc/client.js";
import type { MetricsReport, TaskMetrics, TaskRecord, UsageRecord } from "../../src/metrics.js";
import { FAKE_QODER_ENTRY, TestDaemon, makeWorkspace, spawnWorker, waitTerminal } from "./helpers.js";

async function startMetricsDaemon(t: TestContext, prefix = "hs-metrics-"): Promise<{
  daemon: TestDaemon;
  client: SupervisorClient;
  cwd: string;
}> {
  const daemon = await TestDaemon.create(prefix);
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const cwd = await makeWorkspace("hs-metrics-work-");
  return { daemon, client, cwd };
}

function showTask(client: SupervisorClient, taskId: string): Promise<TaskMetrics> {
  return client.request<TaskMetrics>("metrics_task_show", { taskId });
}

test("spawn auto-creates a task and records Pi usage without inventing parent usage", async (t) => {
  const { client, cwd } = await startMetricsDaemon(t);
  const worker = await spawnWorker(client, cwd, "metrics auto task", { name: "auto metrics" });
  assert.ok(worker.taskId, "spawn must create a task");
  const final = await waitTerminal(client, worker.id, 30_000);
  assert.equal(final.worker.status, "completed");

  const task = await showTask(client, worker.taskId!);
  assert.equal(task.task.title, "auto metrics");
  assert.equal(task.task.executionMode, "delegated");
  assert.equal(task.task.createdBy, "spawn");
  assert.equal(task.status, "completed");
  assert.deepEqual(task.task.workerIds, [worker.id]);
  assert.equal(task.workers.length, 1);
  assert.equal(task.workers[0]?.status, "completed");
  assert.ok(task.workers[0]?.runMs !== undefined);
  assert.ok(task.timing.endToEndMs !== null);
  assert.equal(task.usage.length, 1);
  assert.equal(task.usage[0]?.role, "worker");
  assert.equal(task.usage[0]?.inputTokens, 10);
  assert.equal(task.usage[0]?.outputTokens, 5);
  assert.equal(task.usage[0]?.reportedTotalTokens, 15);
  assert.equal(task.usage[0]?.confidence, "partial");
  assert.equal(task.usageSummary.worker.usableRecords, 1);
  assert.equal(task.usageSummary.parentAttributable.usableRecords, 0);
  assert.ok(task.warnings.some((warning) => /parent-agent usage/i.test(warning)));

  const report = await client.request<MetricsReport>("metrics_report", {});
  assert.equal(report.taskCount, 1);
  assert.equal(report.counts.completed, 1);
  assert.equal(report.knownWorkerUsage.inputTokens.value, 10);
  assert.equal(report.knownWorkerUsage.outputTokens.value, 5);
  assert.equal(report.knownParentUsage.usableRecords, 0);
  assert.equal(report.usageCoverage.tasksWithWorkerUsage, 1);
  assert.equal(report.usageCoverage.tasksWithAttributableParentUsage, 0);
  assert.equal(report.notTracked.cost.includes("Not collected"), true);
  assert.ok(report.dataQualityWarnings.some((warning) => /parent-agent usage/i.test(warning)));
});

test("an explicit task can link multiple workers and receive idempotent parent usage", async (t) => {
  const { client, cwd } = await startMetricsDaemon(t, "hs-metrics-shared-");
  const task = await client.request<TaskRecord>("metrics_task_create", {
    title: "shared task",
    category: "coding",
    createdBy: "cli",
  });
  const first = await spawnWorker(client, cwd, "first shared worker", { taskId: task.id });
  const second = await spawnWorker(client, cwd, "second shared worker", { taskId: task.id });
  await waitTerminal(client, first.id, 30_000);
  await waitTerminal(client, second.id, 30_000);

  const show = await showTask(client, task.id);
  assert.equal(show.status, "completed");
  assert.deepEqual(new Set(show.task.workerIds), new Set([first.id, second.id]));
  assert.equal(show.usage.length, 2);
  assert.equal(show.usageSummary.worker.inputTokens.value, 20);
  assert.equal(show.usageSummary.worker.outputTokens.value, 10);
  assert.equal(show.timing.waitingMs, null, "waiting is not derived for multi-worker tasks");

  const session = await client.request<UsageRecord>("metrics_usage_record", {
    taskId: task.id,
    role: "parent_agent",
    inputTokens: 999,
    outputTokens: 111,
    confidence: "partial",
  });
  assert.equal(session.attribution, "session_level");
  let report = await client.request<MetricsReport>("metrics_report", {});
  assert.equal(report.knownParentUsage.usableRecords, 0);
  assert.equal(report.sessionLevelParentUsage.inputTokens.value, 999);
  assert.equal(report.usageCoverage.tasksWithSessionLevelParentUsage, 1);
  assert.equal(report.usageCoverage.tasksWithAttributableParentUsage, 0);

  const parent = await client.request<UsageRecord>("metrics_usage_record", {
    taskId: task.id,
    role: "parent_agent",
    usageId: "parent-delta-1",
    inputTokens: 100,
    outputTokens: 20,
    attribution: "incremental",
    confidence: "partial",
    usageSource: "manual",
  });
  const replay = await client.request<UsageRecord>("metrics_usage_record", {
    taskId: task.id,
    role: "parent_agent",
    usageId: "parent-delta-1",
    inputTokens: 100,
    outputTokens: 20,
    attribution: "incremental",
    confidence: "partial",
    usageSource: "manual",
  });
  assert.equal(replay.id, parent.id);
  await assert.rejects(
    client.request("metrics_usage_record", {
      taskId: task.id,
      role: "parent_agent",
      usageId: "parent-delta-1",
      inputTokens: 101,
      outputTokens: 20,
      attribution: "incremental",
    }),
    /CONFLICT|already exists/,
  );

  report = await client.request<MetricsReport>("metrics_report", {});
  assert.equal(report.knownParentUsage.inputTokens.value, 100);
  assert.equal(report.knownParentUsage.outputTokens.value, 20);
  assert.equal(report.sessionLevelParentUsage.inputTokens.value, 999);
  assert.equal(report.knownWorkerUsage.inputTokens.value, 20);
  assert.equal(report.usageCoverage.tasksWithAttributableParentUsage, 1);
  assert.equal(report.usageCoverage.tasksWithWorkerUsage, 1);
});

test("Qoder usage events feed the same task record", async (t) => {
  const daemon = await TestDaemon.create("hs-metrics-qoder-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const configDir = await mkdtemp(path.join(os.tmpdir(), "hs-metrics-qoder-config-"));
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_QODER_ENTRY: FAKE_QODER_ENTRY,
      QODER_CONFIG_DIR: configDir,
      QODERCN_CONFIG_DIR: configDir,
    },
  });
  const cwd = await makeWorkspace("hs-metrics-qoder-work-");
  const worker = await client.request<{ id: string; taskId?: string }>(
    "spawn",
    { runtime: "qoder", cwd, prompt: "[scenario:basic] metrics usage" },
    { timeoutMs: 60_000 },
  );
  assert.ok(worker.taskId);
  await waitTerminal(client, worker.id, 30_000);
  const task = await showTask(client, worker.taskId!);
  assert.equal(task.status, "completed");
  assert.equal(task.usage.length, 1);
  assert.equal(task.usage[0]?.harness, "qoder");
  assert.equal(task.usage[0]?.inputTokens, 1);
  assert.equal(task.usage[0]?.outputTokens, 1);
  assert.equal(task.usage[0]?.confidence, "partial");

  const near = await client.request<{ id: string; taskId?: string }>(
    "spawn",
    { runtime: "qoder", cwd, prompt: "[scenario:multi-result-near] one settled turn" },
    { timeoutMs: 60_000 },
  );
  await waitTerminal(client, near.id, 20_000);
  const nearTask = await showTask(client, near.taskId!);
  assert.equal(nearTask.usage.length, 1, "near-duplicate results must not count usage twice");
});

test("metrics survive a daemon restart without duplicating runtime usage", async (t) => {
  const daemon = await TestDaemon.create("hs-metrics-restart-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-metrics-restart-work-");
  let client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "restart metrics task");
  await waitTerminal(client, worker.id, 30_000);
  const before = await showTask(client, worker.taskId!);
  assert.equal(before.usage.length, 1);

  await daemon.stop();
  client = await daemon.start();
  const after = await showTask(client, worker.taskId!);
  assert.equal(after.status, "completed");
  assert.equal(after.usage.length, 1, "reconciliation must not duplicate a persisted runtime usage record");
  assert.equal(after.usage[0]?.id, before.usage[0]?.id);
  const report = await client.request<MetricsReport>("metrics_report", {});
  assert.equal(report.taskCount, 1);
  assert.equal(report.knownWorkerUsage.inputTokens.value, 10);
});

test("metrics storage failure is reported but never blocks the worker lifecycle", async (t) => {
  const daemon = await TestDaemon.create("hs-metrics-broken-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  await mkdir(path.join(daemon.stateDir, "metrics", "metrics.jsonl"), { recursive: true });
  const cwd = await makeWorkspace("hs-metrics-broken-work-");
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "worker with broken metrics storage");
  const final = await waitTerminal(client, worker.id, 30_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.taskId, undefined, "no task should be claimed when metrics is unavailable");
  await assert.rejects(
    client.request("metrics_report", {}),
    /metrics are unavailable|UNSUPPORTED/i,
  );
});
