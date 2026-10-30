import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MetricsStore,
  type MetricsReport,
} from "../../src/metrics.js";
import { SCHEMA_VERSION, type WorkerRecord, type WorkerEvent, type WorkerStatus } from "../../src/types.js";

function workerRecord(
  id: string,
  taskId: string,
  options: {
    status?: WorkerStatus;
    startedAt?: string;
    firstStartedAt?: string;
    endedAt?: string;
    runtime?: string;
    model?: string;
    resumeCount?: number;
  } = {},
): WorkerRecord {
  const now = "2026-10-25T10:00:00.000Z";
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    runtime: options.runtime ?? "pi",
    cwd: process.cwd(),
    promptPreview: "test task",
    status: options.status ?? "completed",
    createdAt: options.startedAt ?? now,
    updatedAt: options.endedAt ?? options.startedAt ?? now,
    lastSeq: 1,
    eventCount: 1,
    stats: { turns: 1, toolCalls: 0, toolErrors: 0 },
    capabilities: {
      runtime: options.runtime ?? "pi",
      steer: true,
      followUp: true,
      cancel: true,
      resume: true,
      pause: false,
      interactiveInput: true,
      notes: "test",
    },
    config: options.model ? { model: options.model } : {},
    resumeCount: options.resumeCount ?? 0,
    supervisorId: "test",
    taskId,
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.firstStartedAt ? { firstStartedAt: options.firstStartedAt } : {}),
    ...(options.endedAt ? { endedAt: options.endedAt } : {}),
  };
}

function usageEvent(workerId: string, seq: number, data: Record<string, unknown>): WorkerEvent {
  return {
    seq,
    workerId,
    ts: new Date().toISOString(),
    type: "run.usage",
    data,
  };
}

async function newStore(): Promise<{ store: MetricsStore; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-metrics-unit-"));
  const store = new MetricsStore(dir);
  await store.init();
  return { store, dir };
}

test("tasks and manual usage survive a reload", async () => {
  const { store, dir } = await newStore();
  const task = await store.createTask({
    title: "reload task",
    category: "coding",
    createdBy: "mcp",
  });
  await store.linkWorker(task.id, "w-one");
  const usage = await store.recordUsage({
    taskId: task.id,
    role: "parent_agent",
    usageId: "parent-1",
    inputTokens: 120,
    outputTokens: 30,
    attribution: "incremental",
    confidence: "partial",
  });
  await store.flush();

  const reloaded = new MetricsStore(dir);
  const warnings = await reloaded.init();
  assert.deepEqual(warnings, []);
  const loadedTask = reloaded.getTask(task.id);
  assert.equal(loadedTask?.title, "reload task");
  assert.equal(loadedTask?.category, "coding");
  assert.deepEqual(loadedTask?.workerIds, ["w-one"]);
  assert.equal(loadedTask?.acceptanceStatus, "pending", "worker completion is not acceptance");
  const loadedUsage = reloaded.listUsage(task.id);
  assert.equal(loadedUsage.length, 1);
  assert.equal(loadedUsage[0]?.id, usage.id);
  assert.equal(loadedUsage[0]?.inputTokens, 120);
  assert.equal(loadedUsage[0]?.attribution, "incremental");
});

test("runtime usage is ingested once and all-zero reports stay unknown", async () => {
  const { store } = await newStore();
  const task = await store.createTask({ title: "zero usage", workerId: "w-zero", createdBy: "spawn" });
  const worker = workerRecord("w-zero", task.id);
  const first = store.ingestEvent(
    worker,
    usageEvent(worker.id, 10, { inputTokens: 0, outputTokens: 0, reportedTotalTokens: 0 }),
  );
  assert.equal(first?.confidence, "unverified");
  assert.equal(first?.inputTokens, null);
  assert.equal(first?.outputTokens, null);
  const duplicate = store.ingestEvent(
    worker,
    usageEvent(worker.id, 10, { inputTokens: 0, outputTokens: 0, reportedTotalTokens: 0 }),
  );
  assert.equal(duplicate?.id, first?.id);
  const report = store.report(() => worker);
  assert.equal(report.knownWorkerUsage.usableRecords, 0);
  assert.equal(report.unverifiedUsage.records, 1);
  assert.equal(report.unverifiedUsage.taskCount, 1);
  assert.match(report.dataQualityWarnings.join("\n"), /unverified/i);
});

test("nonzero runtime usage is partial, keeps token categories separate and never invents missing fields", async () => {
  const { store } = await newStore();
  const task = await store.createTask({ title: "runtime usage", workerId: "w-pi", createdBy: "spawn" });
  const worker = workerRecord("w-pi", task.id, { model: "fake-model" });
  const usage = store.ingestEvent(
    worker,
    usageEvent(worker.id, 3, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      reportedTotalTokens: 120,
    }),
  );
  assert.equal(usage?.confidence, "partial");
  assert.equal(usage?.modelId, "fake-model");
  const report = store.report(() => worker);
  assert.equal(report.knownWorkerUsage.inputTokens.value, 100);
  assert.equal(report.knownWorkerUsage.outputTokens.value, 20);
  assert.equal(report.knownWorkerUsage.cacheReadTokens.value, 7);
  assert.equal(report.knownWorkerUsage.reportedTotalTokens.value, 120);
  assert.equal(report.knownWorkerUsage.usableRecords, 1);
  assert.equal(report.knownWorkerUsage.verifiedRecords, 0);
});

test("manual usage is idempotent by usageId and conflicts on different values", async () => {
  const { store } = await newStore();
  const task = await store.createTask({ title: "idempotent usage", createdBy: "cli" });
  const first = await store.recordUsage({
    taskId: task.id,
    role: "parent_agent",
    usageId: "retry-key",
    inputTokens: 10,
    attribution: "incremental",
  });
  const replay = await store.recordUsage({
    taskId: task.id,
    role: "parent_agent",
    usageId: "retry-key",
    inputTokens: 10,
    attribution: "incremental",
  });
  assert.equal(replay.id, first.id);
  assert.equal(store.listUsage(task.id).length, 1);
  await assert.rejects(
    store.recordUsage({
      taskId: task.id,
      role: "parent_agent",
      usageId: "retry-key",
      inputTokens: 11,
      attribution: "incremental",
    }),
    /CONFLICT|already exists|different values/,
  );
  assert.equal(store.listUsage(task.id).length, 1);
});

test("a usage record needs at least one token field and a linked worker", async () => {
  const { store } = await newStore();
  const task = await store.createTask({ title: "validation", createdBy: "manual" });
  await assert.rejects(
    store.recordUsage({ taskId: task.id, role: "parent_agent" }),
    /At least one token field is required/,
  );
  await assert.rejects(
    store.recordUsage({ taskId: task.id, role: "worker", workerId: "w-not-linked", inputTokens: 1 }),
    /not linked/,
  );
});

test("session-level parent usage is reported separately and excluded from task totals", async () => {
  const { store } = await newStore();
  const task = await store.createTask({ title: "parent usage", workerId: "w-parent", createdBy: "spawn" });
  const worker = workerRecord("w-parent", task.id);
  await store.recordUsage({
    taskId: task.id,
    role: "parent_agent",
    inputTokens: 999,
    outputTokens: 111,
    attribution: "session_level",
  });
  await store.recordUsage({
    taskId: task.id,
    role: "parent_agent",
    usageId: "task-delta",
    inputTokens: 100,
    outputTokens: 20,
    attribution: "incremental",
  });
  const report = store.report(() => worker);
  assert.equal(report.knownParentUsage.inputTokens.value, 100);
  assert.equal(report.knownParentUsage.outputTokens.value, 20);
  assert.equal(report.sessionLevelParentUsage.inputTokens.value, 999);
  assert.equal(report.usageCoverage.tasksWithAttributableParentUsage, 1);
  assert.equal(report.usageCoverage.tasksWithSessionLevelParentUsage, 1);
  assert.match(report.dataQualityWarnings.join("\n"), /session-level/i);
});

test("report derives task status and durations without inventing unknown values", async () => {
  const { store } = await newStore();
  const base = Date.now();
  const completed = await store.createTask({ title: "two workers", createdBy: "mcp" });
  await store.linkWorker(completed.id, "w-a");
  await store.linkWorker(completed.id, "w-b");
  const missing = await store.createTask({ title: "missing worker", workerId: "w-gone", createdBy: "mcp" });
  const startedA = new Date(base + 1_000).toISOString();
  const endedA = new Date(base + 11_000).toISOString();
  const startedB = new Date(base + 3_000).toISOString();
  const endedB = new Date(base + 23_000).toISOString();
  const workers = new Map<string, WorkerRecord>([
    [
      "w-a",
      workerRecord("w-a", completed.id, {
        startedAt: startedA,
        endedAt: endedA,
      }),
    ],
    [
      "w-b",
      workerRecord("w-b", completed.id, {
        startedAt: startedB,
        endedAt: endedB,
      }),
    ],
  ]);
  for (const [id, worker] of workers) {
    store.ingestEvent(
      worker,
      usageEvent(id, 4, { inputTokens: 10, outputTokens: 5, reportedTotalTokens: 15 }),
    );
  }
  const report = store.report((id) => workers.get(id), { includeTasks: true });
  assert.equal(report.taskCount, 2);
  assert.equal(report.counts.completed, 1);
  assert.equal(report.counts.unknown, 1);
  assert.equal(report.workerCount, 3);
  assert.equal(report.usageCoverage.tasksWithMissingWorkers, 1);
  assert.equal(report.knownWorkerUsage.inputTokens.value, 20);
  assert.equal(report.knownWorkerUsage.inputTokens.knownRecords, 2);
  assert.equal(report.durationStats.endToEnd.knownCount, 1);
  assert.equal(report.durationStats.workerRun.knownCount, 2);
  assert.equal(report.durationStats.waiting.knownCount, 0, "two workers must not be treated as one waiting window");
  const completedView = report.tasks?.find((item) => item.task.id === completed.id);
  assert.equal(completedView?.status, "completed");
  assert.ok((completedView?.timing.endToEndMs ?? -1) >= 20_000);
  assert.ok((completedView?.timing.endToEndMs ?? 0) <= 30_000);
  assert.equal(completedView?.timing.waitingMs, null);
  const missingView = report.tasks?.find((item) => item.task.id === missing.id);
  assert.equal(missingView?.status, "unknown");
  assert.equal(missingView?.timing.finishedAt, null);
  assert.equal(missingView?.timing.endToEndMs, null);
  assert.ok((missingView?.warnings ?? []).some((warning) => /missing/i.test(warning)));
  assert.deepEqual(report.unknownFields.includes("cost"), true);
  assert.equal(report.notTracked.cost.includes("Not collected"), true);
});

test("a resumed worker reports firstStartedAt and warns that runMs is only the latest segment", async () => {
  const { store } = await newStore();
  const task = await store.createTask({ title: "resumed", workerId: "w-resumed", createdBy: "mcp" });
  const worker = workerRecord("w-resumed", task.id, {
    firstStartedAt: "2026-10-25T09:00:00.000Z",
    startedAt: "2026-10-25T10:00:00.000Z",
    endedAt: "2026-10-25T10:01:00.000Z",
    resumeCount: 2,
  });
  const report = store.report(() => worker, { includeTasks: true });
  const view = report.tasks?.[0];
  assert.equal(view?.timing.firstStartedAt, "2026-10-25T09:00:00.000Z");
  assert.equal(view?.timing.startedAt, "2026-10-25T10:00:00.000Z");
  assert.equal(view?.workers[0]?.firstStartedAt, "2026-10-25T09:00:00.000Z");
  assert.equal(view?.workers[0]?.resumeCount, 2);
  assert.ok((view?.warnings ?? []).some((warning) => /latest run segment/.test(warning)));
});

test("failed, cancelled and interrupted workers are never counted as completed", async () => {
  const { store } = await newStore();
  const base = Date.now();
  const cases: Array<[string, WorkerStatus]> = [
    ["w-failed", "failed"],
    ["w-crashed", "crashed"],
    ["w-cancelled", "cancelled"],
    ["w-interrupted", "interrupted"],
    ["w-orphaned", "orphaned"],
    ["w-running", "running"],
  ];
  const workers = new Map<string, WorkerRecord>();
  for (const [id, status] of cases) {
    const task = await store.createTask({ title: id, workerId: id, createdBy: "mcp" });
    workers.set(
      id,
      workerRecord(id, task.id, {
        status,
        startedAt: new Date(base).toISOString(),
        ...(status !== "running" ? { endedAt: new Date(base + 2_000).toISOString() } : {}),
      }),
    );
  }
  const report = store.report((id) => workers.get(id));
  assert.equal(report.taskCount, cases.length);
  assert.equal(report.counts.completed, 0);
  assert.equal(report.counts.failed, 2, "failed and crashed are failures");
  assert.equal(report.counts.interrupted, 2, "interrupted and orphaned are interruptions");
  assert.equal(report.counts.cancelled, 1);
  assert.equal(report.counts.running, 1);
  assert.equal(report.counts.unknown, 0);
});

test("corrupt and torn metrics lines are ignored without losing valid records", async () => {
  const { store, dir } = await newStore();
  const task = await store.createTask({ title: "torn file", createdBy: "manual" });
  await store.recordUsage({
    taskId: task.id,
    role: "parent_agent",
    usageId: "kept",
    inputTokens: 5,
    attribution: "incremental",
  });
  await store.flush();
  await appendFile(
    path.join(dir, "metrics", "metrics.jsonl"),
    '{"schemaVersion":1,"kind":"usage","usage":\n{"broken":true}\n',
    "utf8",
  );
  const reloaded = new MetricsStore(dir);
  const warnings = await reloaded.init();
  assert.ok(warnings.some((warning) => /malformed/i.test(warning)));
  assert.equal(reloaded.listTasks().length, 1);
  assert.equal(reloaded.listUsage(task.id).length, 1);
  assert.equal(reloaded.getTask(task.id)?.title, "torn file");
});

test("report range filters by task.createdAt and rejects invalid dates", async () => {
  const { store } = await newStore();
  await store.createTask({ title: "old", createdBy: "manual" });
  await store.createTask({ title: "new", createdBy: "manual" });
  const future = store.report(() => undefined, {
    since: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(future.taskCount, 0);
  const past = store.report(() => undefined, {
    since: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(past.taskCount, 2);
  assert.throws(() => store.report(() => undefined, { since: "not-a-date" }), /ISO 8601/);
  assert.throws(
    () => store.report(() => undefined, { since: "2026-10-26T00:00:00Z", until: "2026-10-25T00:00:00Z" }),
    /since must not be after until/,
  );
});

test("task creation is idempotent only for matching metadata", async () => {
  const { store } = await newStore();
  const task = await store.createTask({
    taskId: "t-fixed",
    title: "fixed task",
    createdBy: "cli",
  });
  const replay = await store.createTask({
    taskId: "t-fixed",
    title: "fixed task",
    createdBy: "mcp",
  });
  assert.equal(replay.id, task.id);
  assert.equal(replay.createdBy, "cli", "the original creation source is not overwritten");
  await assert.rejects(
    store.createTask({ taskId: "t-fixed", title: "different", createdBy: "cli" }),
    /already exists with different metadata/,
  );
});

test("report returns task summaries with a bounded detail list", async () => {
  const { store } = await newStore();
  for (let index = 0; index < 3; index += 1) {
    await store.createTask({ title: `task ${index}`, createdBy: "manual" });
  }
  const report: MetricsReport = store.report(() => undefined, { includeTasks: true, limit: 2 });
  assert.equal(report.taskCount, 3);
  assert.equal(report.tasks?.length, 2);
  assert.equal(report.tasksTruncated, true);
  assert.match(report.dataQualityWarnings.join("\n"), /truncated/i);
});
