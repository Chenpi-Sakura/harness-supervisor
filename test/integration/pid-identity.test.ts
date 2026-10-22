import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION, type WorkerRecord } from "../../src/types.js";
import type { NotificationsResult } from "../../src/types.js";
import { TestDaemon } from "./helpers.js";

function recordWithStatus(id: string, pid: number, status: WorkerRecord["status"]): WorkerRecord {
  return { ...runningRecord(id, pid), status };
}

function runningRecord(id: string, pid: number): WorkerRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    runtime: "pi",
    cwd: process.cwd(),
    promptPreview: "reconciled worker",
    status: "running",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    pid,
    lastSeq: 0,
    eventCount: 0,
    stats: { turns: 1, toolCalls: 0, toolErrors: 0 },
    capabilities: {
      runtime: "pi",
      steer: true,
      followUp: true,
      cancel: true,
      resume: true,
      pause: false,
      interactiveInput: true,
      notes: "test",
    },
    config: {},
    resumeCount: 0,
    supervisorId: "previous-supervisor",
  };
}

test("a live PID whose command line is not this worker is reported as interrupted, not orphaned", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-pid-reuse-"));
  const workerId = "w-pidreuse-00000000";
  const workerDir = path.join(stateDir, "workers", workerId);
  await mkdir(path.join(stateDir, "sessions"), { recursive: true });
  await mkdir(workerDir, { recursive: true });
  // The current test process is alive, but its command line carries none of the
  // worker tokens, which is exactly what PID reuse looks like after a restart.
  await writeFile(
    path.join(workerDir, "worker.json"),
    JSON.stringify(runningRecord(workerId, process.pid)),
    "utf8",
  );
  await writeFile(path.join(workerDir, "events.jsonl"), "", "utf8");

  const daemon = new TestDaemon(stateDir);
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const status = await client.request<{ worker: { status: string; statusReason?: string } }>(
    "status",
    { workerId },
  );
  assert.equal(status.worker.status, "interrupted", "PID reuse must not be reported as an owned process");
  assert.match(status.worker.statusReason ?? "", /PID reused|does not match/i);

  const events = await client.request<{ events: Array<{ type: string; data?: Record<string, unknown> }> }>(
    "events",
    { workerId, sinceSeq: 0, limit: 50 },
  );
  const reconcile = events.events.find((event) => event.type === "worker.interrupted");
  assert.ok(reconcile, "reconciliation event must be recorded");
  assert.equal(reconcile.data?.pidAlive, true);
  assert.equal(reconcile.data?.pidVerified, false);

  const inbox = await client.request<NotificationsResult>("notifications", {
    state: "all",
    workerId,
  });
  assert.ok(
    inbox.notifications.some((item) => item.kind === "detached"),
    "an interrupted worker still creates a detached notification",
  );
  // The test process must still be alive: the supervisor never killed the reused PID.
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("cancelling an orphaned worker whose PID was reused reports the truth instead of pretending", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-pid-reuse-cancel-"));
  const workerId = "w-pidreuse-cancel";
  const workerDir = path.join(stateDir, "workers", workerId);
  await mkdir(path.join(stateDir, "sessions"), { recursive: true });
  await mkdir(workerDir, { recursive: true });
  const record = recordWithStatus(workerId, process.pid, "orphaned");
  record.statusReason = "Supervisor restarted and no longer owns the live harness process";
  record.endedAt = new Date().toISOString();
  await writeFile(path.join(workerDir, "worker.json"), JSON.stringify(record), "utf8");
  await writeFile(path.join(workerDir, "events.jsonl"), "", "utf8");

  const daemon = new TestDaemon(stateDir);
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const cancelled = await client.request<{ status: string; statusReason?: string }>("cancel", {
    workerId,
    timeoutMs: 2000,
  });
  assert.equal(cancelled.status, "orphaned");
  assert.match(
    cancelled.statusReason ?? "",
    /PID reused|different process|no live harness/i,
    "the supervisor must not claim it terminated a process it does not own",
  );
  assert.doesNotThrow(() => process.kill(process.pid, 0), "the reused PID is never killed");

  const events = await client.request<{ events: Array<{ type: string; data?: Record<string, unknown> }> }>(
    "events",
    { workerId, sinceSeq: 0, limit: 50 },
  );
  assert.ok(
    events.events.some((event) => event.data?.kind === "pid_identity_mismatch"),
    "the mismatch must be recorded as an event",
  );
});
