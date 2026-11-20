import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { SupervisorError } from "../../src/errors.js";
import { Store } from "../../src/store.js";
import { Supervisor } from "../../src/supervisor.js";
import { SCHEMA_VERSION, type JobObservation, type WaitResult, type WorkerRecord, type WorkerStatusResult, type WorkerSummary, type WorkerTurnResult } from "../../src/types.js";
import { Deferred } from "../../src/util/async.js";
import { silentLogger } from "../../src/util/logger.js";
import {
  CLI_ENTRY,
  FAKE_DSH_ENTRY,
  TestDaemon,
  connectExisting,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  statusOf,
  waitForStatus,
  waitTerminal,
} from "./helpers.js";

function code(error: unknown): string | undefined {
  return error instanceof SupervisorError ? error.code : undefined;
}

function report(summary: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    summary,
    inputs: { samples: 4 },
    config: { mode: "strict" },
    thresholds: [
      { name: "p95", requested: "100ms", adopted: "120ms", unit: "ms", met: true },
    ],
    items: [{ name: "sample", status: "passed", artifact: "out/result.txt" }],
    anomalies: ["one warmup sample excluded"],
    artifacts: [{ name: "result", path: "out/result.txt" }],
    ...overrides,
  };
}

test("structured results are immutable per Turn and survive a daemon restart", async (t) => {
  const daemon = await TestDaemon.create("hs-result-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-result-work-");
  let client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:recall] first turn", {
    persistence: "persistent",
    maxDurationMs: 60_000,
  });
  const settled1 = await waitTerminal(client, worker.id);
  assert.equal(settled1.worker.status, "completed");

  const submitted1 = await client.request<{
    accepted: true;
    duplicate: boolean;
    turn: number;
    result: WorkerTurnResult;
  }>("result_submit", { workerId: worker.id, turn: 1, result: report("first result") });
  assert.equal(submitted1.turn, 1);
  assert.equal(submitted1.duplicate, false);
  assert.equal(submitted1.result.report.summary, "first result");
  assert.ok(["worker_process", "missing"].includes(submitted1.result.execution.source));

  const replay = await client.request<typeof submitted1>("result_submit", {
    workerId: worker.id,
    turn: 1,
    result: report("first result"),
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.turn, 1);

  await assert.rejects(
    () => client.request("result_submit", { workerId: worker.id, turn: 1, result: report("different") }),
    (error: unknown) => code(error) === "CONFLICT",
  );

  const continued = await client.request<WorkerSummary>(
    "continue",
    { workerId: worker.id, prompt: "[scenario:recall] second turn" },
    { timeoutMs: 60_000 },
  );
  await waitTerminal(client, worker.id, 30_000, continued.lastSeq);
  await assert.rejects(
    () => client.request("result_submit", { workerId: worker.id, turn: 1, result: report("stale result") }),
    (error: unknown) => code(error) === "INVALID_STATE",
  );
  const submitted2 = await client.request<typeof submitted1>("result_submit", {
    workerId: worker.id,
    turn: 2,
    result: report("second result"),
  });
  assert.equal(submitted2.turn, 2);

  const all = await client.request<{
    workerId: string;
    currentTurn: number;
    results: WorkerTurnResult[];
  }>("result_get", { workerId: worker.id });
  assert.equal(all.currentTurn, 2);
  assert.deepEqual(all.results.map((entry) => entry.report.summary), ["first result", "second result"]);
  const firstOnly = await client.request<typeof all>("result_get", { workerId: worker.id, turn: 1 });
  assert.equal(firstOnly.results.length, 1);
  assert.equal(firstOnly.results[0]?.report.summary, "first result");

  const status = await statusOf(client, worker.id);
  assert.equal(status.currentTurn, 2);
  assert.equal(status.latestResult?.turn, 2);
  assert.equal(status.latestResult?.report.summary, "second result");
  const waited = await client.request<WaitResult>("wait", {
    workerId: worker.id,
    sinceSeq: status.worker.lastSeq,
    timeoutMs: 0,
  });
  assert.equal(waited.currentTurn, 2);
  assert.equal(waited.latestResult?.turn, 2);

  await daemon.stop();
  client = await daemon.start();
  const restored = await client.request<typeof all>("result_get", { workerId: worker.id, turn: 1 });
  assert.equal(restored.results[0]?.report.summary, "first result");
  const restoredStatus = await client.request<WorkerStatusResult>("status", {
    workerId: worker.id,
    recentEvents: 10,
  });
  assert.equal(restoredStatus.latestResult?.turn, 2);
});

test("structured results reject active Turns and oversized reports", async (t) => {
  const daemon = await TestDaemon.create("hs-result-invalid-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-result-invalid-work-");
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "5000" } });
  const worker = await spawnWorker(client, cwd, "[scenario:slow] keep running");
  await waitForStatus(client, worker.id, ["running", "awaiting_input"]);
  await assert.rejects(
    () => client.request("result_submit", { workerId: worker.id, turn: 1, result: report("too early") }),
    (error: unknown) => code(error) === "INVALID_STATE",
  );
  await client.request("cancel", { workerId: worker.id });

  const oversized = report("oversized", { anomalies: ["x".repeat(9000)] });
  await assert.rejects(
    () => client.request("result_submit", { workerId: worker.id, turn: 1, result: oversized }),
    (error: unknown) => code(error) === "BAD_REQUEST",
  );
});

test("job state comes from execution-side evidence and is reported separately", async (t) => {
  const daemon = await TestDaemon.create("hs-job-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-job-work-");
  const evidenceDir = await mkdtemp(path.join(os.tmpdir(), "hs-job-evidence-"));
  const client = await daemon.start({
    env: { HARNESS_SUPERVISOR_JOB_EVIDENCE_DIRS: evidenceDir },
  });
  const worker = await spawnWorker(client, cwd, "[scenario:recall] launch the job");
  await waitTerminal(client, worker.id);
  const evidencePath = path.join(evidenceDir, "job.json");
  const jobId = "train-7f21";
  const writeEvidence = (state: string, extra: Record<string, unknown> = {}) =>
    writeFile(
      evidencePath,
      JSON.stringify({
        v: 1,
        jobId,
        state,
        updatedAt: new Date().toISOString(),
        ...extra,
      }),
    );
  await writeEvidence("running");

  const attached = await client.request<{ duplicate: boolean; observation: JobObservation }>(
    "job_attach",
    {
      workerId: worker.id,
      job: {
        jobId,
        location: "local",
        stage: "training",
        expectedArtifacts: ["result"],
        evidencePath,
      },
    },
  );
  assert.equal(attached.duplicate, false);
  assert.equal(attached.observation.state, "running");
  assert.deepEqual(attached.observation.missingArtifacts, ["result"]);

  const duplicate = await client.request<{ duplicate: boolean }>("job_attach", {
    workerId: worker.id,
    job: { jobId, location: "local", evidencePath },
  });
  assert.equal(duplicate.duplicate, true);

  await writeEvidence("exited", { exitCode: 0, artifacts: [{ name: "result", path: "out/result.txt" }] });
  const exited = await client.request<{ jobs: JobObservation[] }>("job_status", {
    workerId: worker.id,
    jobId,
  });
  assert.equal(exited.jobs[0]?.state, "exited");
  assert.equal(exited.jobs[0]?.exitCodeKnown, true);
  assert.equal(exited.jobs[0]?.exitCode, 0);
  assert.deepEqual(exited.jobs[0]?.missingArtifacts, []);

  const status = await statusOf(client, worker.id);
  assert.equal(status.worker.status, "completed", "job state must not overwrite worker status");
  assert.equal(status.jobs?.[0]?.state, "exited");

  await writeEvidence("failed", { exitCode: 2 });
  const failed = await client.request<{ jobs: JobObservation[] }>("job_status", { workerId: worker.id, jobId });
  assert.equal(failed.jobs[0]?.state, "failed");
  assert.equal(failed.jobs[0]?.exitCode, 2);

  await writeFile(evidencePath, "not json");
  const unknown = await client.request<{ jobs: JobObservation[] }>("job_status", { workerId: worker.id, jobId });
  assert.equal(unknown.jobs[0]?.state, "unknown");
  assert.ok(unknown.jobs[0]?.problem);

  await assert.rejects(
    () =>
      client.request("job_attach", {
        workerId: worker.id,
        job: { jobId: "remote-1", location: "remote-host", evidencePath, pid: 1234 },
      }),
    (error: unknown) => code(error) === "BAD_REQUEST",
  );
});

test("evidence mutations interlock with forget and prune in either order", { timeout: 5000 }, async (t) => {
  const cwd = await makeWorkspace("hs-job-race-");
  const workerId = "w-race-1";
  const store = new Store(cwd, silentLogger);
  const supervisor = new Supervisor({
    store, stateDir: cwd, supervisorId: "job-race", logger: silentLogger, adapters: new Map(),
  });
  await supervisor.init();
  const releaseWrite = new Deferred<void>();
  const releasePrune = new Deferred<void>();
  t.after(async () => {
    releaseWrite.resolve();
    releasePrune.resolve();
    await supervisor.shutdown();
  });
  const endedAt = "2020-01-01T00:00:00.000Z";
  await store.createWorker({
    schemaVersion: SCHEMA_VERSION, id: workerId, runtime: "pi", cwd,
    promptPreview: "job race", status: "completed",
    createdAt: endedAt, updatedAt: endedAt, endedAt, lastSeq: 0, eventCount: 0,
    stats: { turns: 1, toolCalls: 0, toolErrors: 0 },
    capabilities: {
      runtime: "pi", cancel: true, steer: false, followUp: false, resume: false,
      pause: false, interactiveInput: false, notes: "test fixture",
    },
    config: {}, turn: 1, resumeCount: 0, supervisorId: "job-race",
  });
  const writing = new Deferred<void>();
  const saveWorker = store.saveWorker.bind(store);
  t.mock.method(store, "saveWorker", async (record: WorkerRecord) => {
    writing.resolve();
    await releaseWrite.promise;
    await saveWorker(record);
  });
  const job = { jobId: "race-job", location: "local", evidencePath: "race-job.json" };
  const attaching = supervisor.attachJob(workerId, job);
  void attaching.catch(() => undefined);
  await writing.promise;
  await assert.rejects(supervisor.forget(workerId), { code: "INVALID_STATE" });
  assert.deepEqual((await supervisor.prune({ olderThanDays: 0, keep: 0 })).removed, []);
  releaseWrite.resolve();
  assert.equal((await attaching).job.jobId, job.jobId);

  const pruning = new Deferred<void>();
  const prune = supervisor.retention.prune.bind(supervisor.retention);
  t.mock.method(supervisor.retention, "prune", async (options: Parameters<typeof prune>[0]) => {
    pruning.resolve();
    await releasePrune.promise;
    return prune(options);
  });
  const removal = supervisor.prune({ olderThanDays: 0, keep: 0 });
  void removal.catch(() => undefined);
  await pruning.promise;
  await assert.rejects(supervisor.attachJob(workerId, job), /Maintenance \(prune\)/);
  await assert.rejects(supervisor.submitResult(workerId, report("late"), { turn: 1 }), /Maintenance \(prune\)/);
  releasePrune.resolve();
  assert.deepEqual((await removal).removed, [workerId]);
  await assert.rejects(supervisor.attachJob(workerId, job), { code: "NOT_FOUND" });
});

test("a structured result keeps the job exit separate from the harness exit", async (t) => {
  const daemon = await TestDaemon.create("hs-result-job-exit-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-result-job-exit-work-");
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:recall] finish normally");
  await waitTerminal(client, worker.id);

  const evidencePath = path.join(cwd, "job-exit.json");
  await writeFile(
    evidencePath,
    JSON.stringify({
      v: 1,
      jobId: "job-exit",
      state: "failed",
      exitCode: 2,
      updatedAt: new Date().toISOString(),
    }),
  );
  await client.request("job_attach", {
    workerId: worker.id,
    job: { jobId: "job-exit", location: "local", evidencePath },
  });

  const submitted = await client.request<{
    turn: number;
    result: WorkerTurnResult;
  }>("result_submit", {
    workerId: worker.id,
    turn: 1,
    result: report("harness finished while the job failed"),
  });
  assert.equal(submitted.result.execution.exitCode, 0);
  assert.equal(submitted.result.execution.source, "worker_process");
  const job = submitted.result.execution.jobs?.[0];
  assert.equal(job?.jobId, "job-exit");
  assert.equal(job?.state, "failed");
  assert.equal(job?.exitCode, 2);
  assert.equal(job?.exitCodeKnown, true);
  assert.equal(job?.source, "job_evidence");
  assert.notEqual(job?.exitCode, submitted.result.execution.exitCode);
});

test("a persistent worker without steer points at cancel then continue", async (t) => {
  const daemon = await TestDaemon.create("hs-steer-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-steer-work-");
  const client = await daemon.start({
    env: { HARNESS_SUPERVISOR_DSH_ENTRY: FAKE_DSH_ENTRY, FAKE_DSH_SCENARIO: "hang" },
  });
  const worker = await client.request<WorkerSummary>(
    "spawn",
    { runtime: "dsh", cwd, prompt: "[scenario:hang] wait", persistence: "persistent" },
    { timeoutMs: 60_000 },
  );
  await waitForStatus(client, worker.id, ["running", "awaiting_input"]);
  const persisted = await statusOf(client, worker.id);
  assert.equal(persisted.worker.persistence, "persistent");
  await assert.rejects(
    () =>
      client.request("send", {
        workerId: worker.id,
        message: "corrected instruction",
        mode: "steer",
      }),
    (error: unknown) => {
      if (code(error) !== "UNSUPPORTED") return false;
      const message = (error as Error).message;
      return message.includes("worker_cancel") && message.includes("worker_continue");
    },
  );
  const stillRunning = await statusOf(client, worker.id);
  assert.equal(stillRunning.worker.status, "running", "a rejected steer must not cancel the current Turn");
  await client.request("cancel", { workerId: worker.id });
  const after = await waitTerminal(client, worker.id);
  assert.equal(after.worker.status, "cancelled");

  const continued = await client.request<WorkerSummary>(
    "continue",
    { workerId: worker.id, prompt: "corrected instruction after cancel" },
    { timeoutMs: 60_000 },
  );
  assert.equal(continued.id, worker.id, "the correction continues the same persistent Worker");
  assert.equal(continued.turn, 2);
  await waitForStatus(client, worker.id, ["running", "awaiting_input"]);
  await client.request("cancel", { workerId: worker.id });
  await waitTerminal(client, worker.id);
});

test("a running job keeps the same identity and evidence across daemon restart", async (t) => {
  const daemon = await TestDaemon.create("hs-job-restart-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-job-restart-work-");
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:recall] job restart");
  await waitTerminal(client, worker.id);

  const evidencePath = path.join(cwd, "job-evidence.json");
  const writeEvidence = async (payload: Record<string, unknown>) => {
    await writeFile(evidencePath, JSON.stringify(payload));
  };
  await writeEvidence({
    v: 1,
    jobId: "restart-job",
    state: "running",
    updatedAt: new Date().toISOString(),
  });
  await client.request("job_attach", {
    workerId: worker.id,
    job: {
      jobId: "restart-job",
      location: "local",
      stage: "training",
      expectedArtifacts: ["out.txt"],
      evidencePath,
    },
  });

  await daemon.stop();
  const next = await daemon.start();
  const before = await next.request<{ jobs: Array<{ jobId: string; state: string; workerTurn: number }> }>(
    "job_status",
    { workerId: worker.id, jobId: "restart-job" },
  );
  assert.equal(before.jobs.length, 1);
  assert.equal(before.jobs[0]?.jobId, "restart-job");
  assert.equal(before.jobs[0]?.state, "running");
  assert.equal(before.jobs[0]?.workerTurn, 1);

  await writeEvidence({
    v: 1,
    jobId: "restart-job",
    state: "exited",
    exitCode: 0,
    updatedAt: new Date().toISOString(),
    artifacts: [{ name: "out.txt", path: path.join(cwd, "out.txt") }],
  });
  const after = await next.request<{
    jobs: Array<{ jobId: string; state: string; exitCode: number | null; exitCodeKnown: boolean; missingArtifacts: string[] }>;
  }>("job_status", { workerId: worker.id, jobId: "restart-job" });
  assert.equal(after.jobs[0]?.state, "exited");
  assert.equal(after.jobs[0]?.exitCode, 0);
  assert.equal(after.jobs[0]?.exitCodeKnown, true);
  assert.deepEqual(after.jobs[0]?.missingArtifacts, []);

  const attachEvents = (await eventsOf(next, worker.id)).events.filter(
    (event) => event.type === "worker.job_attached" && event.data?.jobId === "restart-job",
  );
  assert.equal(attachEvents.length, 1, "restart must not duplicate or restart the job link");
  const status = await statusOf(next, worker.id);
  assert.equal(status.worker.status, "completed", "job state must not masquerade as worker state");
});

test("an independent job process survives Supervisor restart and keeps its jobId", async (t) => {
  const daemon = await TestDaemon.create("hs-job-real-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-job-real-work-");
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:recall] job owner");
  await waitTerminal(client, worker.id);

  const evidencePath = path.join(cwd, "real-job.json");
  const artifactPath = path.join(cwd, "real-artifact.txt");
  const script = `
const fs = require("fs");
const [file, artifact, jobId] = process.argv.slice(1);
const write = (value) => fs.writeFileSync(file, JSON.stringify(value));
write({ v: 1, jobId, state: "running", stage: "bench", updatedAt: new Date().toISOString() });
setTimeout(() => {
  fs.writeFileSync(artifact, "real artifact");
  write({ v: 1, jobId, state: "exited", exitCode: 0, stage: "bench", updatedAt: new Date().toISOString(), artifacts: [{ name: "out", path: artifact }] });
}, 4000);
`;
  const child = spawn(process.execPath, ["-e", script, evidencePath, artifactPath, "real-job"], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(evidencePath);
      break;
    } catch {
      await sleep(50);
    }
  }
  await client.request("job_attach", {
    workerId: worker.id,
    job: {
      jobId: "real-job",
      location: "local",
      stage: "bench",
      expectedArtifacts: ["out"],
      evidencePath,
    },
  });
  const attached = await client.request<{ jobs: JobObservation[] }>("job_status", {
    workerId: worker.id,
    jobId: "real-job",
  });
  assert.equal(attached.jobs[0]?.state, "running");

  await daemon.stop();
  const next = await daemon.start();
  const observed = await next.request<{ jobs: JobObservation[] }>("job_status", {
    workerId: worker.id,
    jobId: "real-job",
  });
  assert.equal(observed.jobs[0]?.jobId, "real-job");
  assert.equal(observed.jobs[0]?.evidencePath, evidencePath);
  assert.equal(observed.jobs[0]?.state, "running", "the independent job keeps running across the Supervisor restart");

  let final: JobObservation | undefined = observed.jobs[0];
  const exitDeadline = Date.now() + 15_000;
  while (Date.now() < exitDeadline) {
    const polled = await next.request<{ jobs: JobObservation[] }>("job_status", {
      workerId: worker.id,
      jobId: "real-job",
    });
    final = polled.jobs[0];
    if (final?.state === "exited") break;
    await sleep(100);
  }
  assert.equal(final?.state, "exited");
  assert.equal(final?.exitCode, 0);
  assert.deepEqual(final?.missingArtifacts, []);
  const events = (await eventsOf(next, worker.id)).events.filter(
    (event) => event.type === "worker.job_attached" && event.data?.jobId === "real-job",
  );
  assert.equal(events.length, 1, "restart must not create a second job link");
});

test("CLI exposes the structured result and job evidence commands", async (t) => {
  const daemon = await TestDaemon.create("hs-long-cli-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-long-cli-work-");
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:recall] cli result");
  await waitTerminal(client, worker.id);
  const env = { ...process.env, HARNESS_SUPERVISOR_HOME: daemon.stateDir };

  const reportFile = path.join(cwd, "result.json");
  await writeFile(
    reportFile,
    JSON.stringify({
      v: 1,
      summary: "cli result",
      thresholds: [{ name: "accuracy", requested: ">0.9", adopted: "0.92" }],
      artifacts: [{ name: "log", path: "run.log" }],
    }),
  );
  const run = promisify(execFile);
  const submitted = await run(process.execPath, [
    CLI_ENTRY,
    "result-submit",
    worker.id,
    "--turn",
    "1",
    "--file",
    reportFile,
    "--json",
  ], { env, timeout: 30_000, windowsHide: true });
  const submitPayload = JSON.parse(submitted.stdout) as {
    turn: number;
    duplicate: boolean;
    result: { report: { summary: string } };
  };
  assert.equal(submitPayload.turn, 1);
  assert.equal(submitPayload.duplicate, false);
  assert.equal(submitPayload.result.report.summary, "cli result");

  const got = await run(process.execPath, [CLI_ENTRY, "result-get", worker.id, "--json"], {
    env,
    timeout: 30_000,
    windowsHide: true,
  });
  const gotPayload = JSON.parse(got.stdout) as { results: Array<{ report: { summary: string } }> };
  assert.equal(gotPayload.results[0]?.report.summary, "cli result");

  const evidencePath = path.join(cwd, "job.json");
  await writeFile(
    evidencePath,
    JSON.stringify({ v: 1, jobId: "cli-job", state: "running", updatedAt: new Date().toISOString() }),
  );
  const attached = await run(process.execPath, [
    CLI_ENTRY,
    "job-attach",
    worker.id,
    "--job-id",
    "cli-job",
    "--location",
    "local",
    "--evidence",
    evidencePath,
    "--json",
  ], { env, timeout: 30_000, windowsHide: true });
  const attachPayload = JSON.parse(attached.stdout) as { job: { jobId: string } };
  assert.equal(attachPayload.job.jobId, "cli-job");

  const jobStatus = await run(process.execPath, [
    CLI_ENTRY,
    "job-status",
    worker.id,
    "--job-id",
    "cli-job",
    "--json",
  ], { env, timeout: 30_000, windowsHide: true });
  const jobPayload = JSON.parse(jobStatus.stdout) as { jobs: Array<{ jobId: string; state: string }> };
  assert.equal(jobPayload.jobs[0]?.jobId, "cli-job");
  assert.equal(jobPayload.jobs[0]?.state, "running");
});
