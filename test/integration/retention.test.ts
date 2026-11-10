import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION } from "../../src/types.js";
import type { NotificationsResult } from "../../src/types.js";
import type { WorkerRecord, WorkerSummary } from "../../src/types.js";
import { isPidAlive, sleep } from "../../src/util/async.js";
import {
  TestDaemon,
  makeWorkspace,
  spawnWorker,
  waitForEvent,
  waitTerminal,
} from "./helpers.js";

function workerDir(stateDir: string, workerId: string): string {
  return path.join(stateDir, "workers", workerId);
}

function orphanedRecord(id: string, pid: number): WorkerRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    runtime: "pi",
    cwd: process.cwd(),
    promptPreview: "orphaned worker",
    status: "orphaned",
    statusReason: "Supervisor restarted and no longer owns the live harness process",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    endedAt: now,
    pid,
    lastSeq: 0,
    eventCount: 0,
    stats: { turns: 0, toolCalls: 0, toolErrors: 0 },
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

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(50);
  assert.equal(isPidAlive(pid), false, "test process did not exit");
}

test("prune never touches active workers or unacknowledged notifications", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "12000" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const active = await spawnWorker(client, cwd, "[scenario:slow] still running");
  await waitForEvent(client, active.id, "run.started", 10_000);

  const dry = await client.request<{ removed: string[]; skipped: Array<{ workerId: string; reason: string }> }>(
    "prune",
    { olderThanDays: 0, keep: 0, dryRun: true },
  );
  assert.equal(dry.removed.includes(active.id), false);
  assert.ok(existsSync(workerDir(daemon.stateDir, active.id)));

  const real = await client.request<{ removed: string[]; skipped: Array<{ workerId: string; reason: string }> }>(
    "prune",
    { olderThanDays: 0, keep: 0 },
  );
  assert.equal(real.removed.includes(active.id), false, "an active worker is never pruned");
  assert.ok(existsSync(workerDir(daemon.stateDir, active.id)));
  const still = await client.request<{ worker: WorkerSummary }>("status", { workerId: active.id });
  assert.equal(still.worker.status, "running");
});

test("prune skips terminal workers with unacknowledged notifications, then removes them after ack", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "prune candidate");
  await waitTerminal(client, worker.id, 20_000);

  const blocked = await client.request<{ removed: string[]; skipped: Array<{ workerId: string; reason: string }> }>(
    "prune",
    { olderThanDays: 0, keep: 0 },
  );
  assert.equal(blocked.removed.includes(worker.id), false);
  assert.equal(
    blocked.skipped.find((item) => item.workerId === worker.id)?.reason,
    "unacknowledged notification",
  );

  const inbox = await client.request<NotificationsResult>("notifications", {
    state: "all",
    workerId: worker.id,
  });
  await client.request("notification_ack", {
    ids: inbox.notifications.map((item) => item.id),
    by: "test",
  });

  let prunedResult: {
    removed: string[];
    freedBytes: number;
    skipped: Array<{ workerId: string; reason: string }>;
  } | null = null;
  // The terminal event can be visible before the finalizer removes its runtime;
  // prune protects that short window and must succeed on a later pass.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await client.request<{
      removed: string[];
      freedBytes: number;
      skipped: Array<{ workerId: string; reason: string }>;
    }>("prune", { olderThanDays: 0, keep: 0 });
    prunedResult = current;
    if (current.removed.includes(worker.id)) break;
    await sleep(100);
  }
  assert.ok(prunedResult, "prune returned a result");
  const pruned = prunedResult!;
  assert.ok(
    pruned.removed.includes(worker.id),
    `an acked, old terminal worker can be pruned: ${JSON.stringify(pruned)}`,
  );
  assert.ok(pruned.freedBytes > 0);
  assert.equal(existsSync(workerDir(daemon.stateDir, worker.id)), false);
  const list = await client.request<WorkerSummary[]>("list", {});
  assert.equal(list.length, 0);

  // The harness session directory survives unless includeSessions is requested.
  assert.equal(existsSync(path.join(daemon.stateDir, "sessions", worker.id)), true);
});

test("prune never removes a persistent worker or its native session", async (t) => {
  const daemon = await TestDaemon.create("hs-retention-persistent-");
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "persistent prune candidate", {
    persistence: "persistent",
  });
  const settled = await waitTerminal(client, worker.id, 20_000);
  assert.ok(settled.worker.sessionFile);
  const inbox = await client.request<NotificationsResult>("notifications", {
    state: "all",
    workerId: worker.id,
  });
  await client.request("notification_ack", {
    ids: inbox.notifications.map((item) => item.id),
    by: "test",
  });

  const pruned = await client.request<{
    removed: string[];
    skipped: Array<{ workerId: string; reason: string }>;
  }>("prune", { olderThanDays: 0, keep: 0, includeSessions: true });
  assert.equal(pruned.removed.includes(worker.id), false);
  assert.match(
    pruned.skipped.find((item) => item.workerId === worker.id)?.reason ?? "",
    /persistent worker retains its native session/i,
  );
  assert.equal(existsSync(workerDir(daemon.stateDir, worker.id)), true);
  assert.equal(existsSync(settled.worker.sessionFile!), true);

  const forgotten = await client.request<{ forgotten: boolean; sessionPreserved: boolean }>(
    "forget",
    { workerId: worker.id },
  );
  assert.equal(forgotten.forgotten, true);
  assert.equal(forgotten.sessionPreserved, true);
  assert.equal(existsSync(settled.worker.sessionFile!), true);
});

test("keep protects the newest terminal workers and dry-run is side-effect free", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const workers: WorkerSummary[] = [];
  for (const prompt of ["one", "two", "three"]) {
    const worker = await spawnWorker(client, cwd, prompt);
    await waitTerminal(client, worker.id, 20_000);
    workers.push(worker);
  }
  const inbox = await client.request<NotificationsResult>("notifications", {
    state: "all",
    limit: 200,
  });
  await client.request("notification_ack", { ids: inbox.notifications.map((item) => item.id) });

  const dry = await client.request<{ dryRun: boolean; removed: string[] }>("prune", {
    olderThanDays: 0,
    keep: 1,
    dryRun: true,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.removed.length, 2);
  for (const worker of workers) {
    assert.ok(existsSync(workerDir(daemon.stateDir, worker.id)), "dry-run must not delete anything");
  }

  const real = await client.request<{ removed: string[] }>("prune", {
    olderThanDays: 0,
    keep: 1,
  });
  assert.equal(real.removed.length, 2);
  const remaining = await client.request<WorkerSummary[]>("list", {});
  assert.equal(remaining.length, 1);
});

test("orphaned workers are protected while their process is alive and reconciled after it exits", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-orphan-retention-"));
  const workerId = "w-orphan-protected";
  const dir = workerDir(stateDir, workerId);
  await mkdir(path.join(stateDir, "sessions"), { recursive: true });
  await mkdir(dir, { recursive: true });

  // A live process whose command line carries the worker id is what a real
  // orphan looks like to the identity check.
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", workerId], {
    stdio: "ignore",
    windowsHide: true,
  });
  const orphanPid = orphan.pid;
  assert.ok(orphanPid);
  t.after(() => {
    if (isPidAlive(orphanPid)) {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  await writeFile(path.join(dir, "worker.json"), JSON.stringify(orphanedRecord(workerId, orphanPid)), "utf8");
  await writeFile(path.join(dir, "events.jsonl"), "", "utf8");

  const daemon = new TestDaemon(stateDir);
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const status = await client.request<{ worker: { status: string } }>("status", { workerId });
  assert.equal(status.worker.status, "orphaned", "a live, identity-matched orphan stays orphaned");

  const dry = await client.request<{ removed: string[]; skipped: Array<{ workerId: string; reason: string }> }>(
    "prune",
    { olderThanDays: 0, keep: 0, dryRun: true },
  );
  assert.equal(dry.removed.includes(workerId), false);
  assert.equal(
    dry.skipped.find((item) => item.workerId === workerId)?.reason,
    "orphaned worker may still be running",
  );

  const real = await client.request<{ removed: string[] }>("prune", {
    olderThanDays: 0,
    keep: 0,
  });
  assert.equal(real.removed.includes(workerId), false);
  assert.ok(existsSync(dir), "an orphaned worker directory must survive prune");

  process.kill(orphanPid, "SIGKILL");
  await waitForProcessExit(orphanPid);
  await daemon.stop();

  const restarted = new TestDaemon(stateDir);
  const restartedClient = await restarted.start();
  t.after(async () => {
    await restarted.stop().catch(() => undefined);
  });

  const reconciled = await restartedClient.request<{ worker: { status: string; statusReason?: string } }>(
    "status",
    { workerId },
  );
  assert.equal(reconciled.worker.status, "interrupted");
  assert.match(reconciled.worker.statusReason ?? "", /process was lost|outcome unknown/i);

  const inbox = await restartedClient.request<NotificationsResult>("notifications", {
    state: "all",
    workerId,
  });
  await restartedClient.request("notification_ack", {
    ids: inbox.notifications.map((item) => item.id),
    by: "test",
  });

  const pruned = await restartedClient.request<{ removed: string[] }>("prune", {
    olderThanDays: 0,
    keep: 0,
  });
  assert.ok(pruned.removed.includes(workerId), "a confirmed-dead orphan can be pruned after reconciliation");
});