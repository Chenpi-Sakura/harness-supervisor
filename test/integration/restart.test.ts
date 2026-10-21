import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "../../src/errors.js";
import type { WorkerRecord } from "../../src/types.js";
import { isPidAlive, sleep } from "../../src/util/async.js";
import {
  TestDaemon,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  statusOf,
  waitForEvent,
  waitPidDead,
  waitTerminalLong,
} from "./helpers.js";

test("daemon crash leaves an explicitly detached worker; resume is manual and verified", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "15000" } });
  let restarted: TestDaemon | null = null;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] survive daemon death");
  await waitForEvent(client, worker.id, "run.started", 5000);
  const pid = worker.pid!;
  const sessionId = worker.sessionId;
  assert.ok(pid);
  assert.ok(sessionId);

  await daemon.kill();
  await waitPidDead(pid, 10_000);

  restarted = new TestDaemon(daemon.stateDir);
  client = await restarted.start();
  const recovered = await statusOf(client, worker.id);
  assert.ok(
    ["orphaned", "interrupted"].includes(recovered.worker.status),
    `unexpected recovered status ${recovered.worker.status}`,
  );
  assert.notEqual(recovered.worker.status, "completed");
  assert.notEqual(recovered.worker.status, "failed");
  assert.notEqual(recovered.worker.status, "running");

  const events = await eventsOf(client, worker.id);
  assert.ok(
    events.events.some(
      (event) => event.type === "worker.interrupted" || event.type === "worker.orphaned",
    ),
  );

  await sleep(200);
  const stillDetached = await statusOf(client, worker.id);
  assert.ok(["orphaned", "interrupted"].includes(stillDetached.worker.status));
  assert.equal(stillDetached.worker.eventCount, recovered.worker.eventCount);

  const resumed = await client.request<{
    id: string;
    status: string;
    sessionId?: string;
    resumeCount: number;
  }>("resume", {
    workerId: worker.id,
    prompt: "continue after restart",
  });
  assert.equal(resumed.status, "running");
  const final = await waitTerminalLong(client, worker.id, 30_000);
  assert.equal(final.worker.status, "completed");
  assert.match(final.worker.result?.text ?? "", /RESUMED/);
  assert.equal(final.worker.sessionId, sessionId);
  assert.equal(final.worker.resumeCount, 1);
});

test("an orphaned live PID is reported honestly and cannot be cancelled", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let restarted: TestDaemon | null = null;
  let orphanPid: number | undefined;
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
    if (orphanPid && isPidAlive(orphanPid)) {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  const worker = await spawnWorker(client, cwd, "finish before becoming orphaned");
  const final = await waitTerminalLong(client, worker.id, 10_000);
  assert.equal(final.worker.status, "completed");

  // The orphaned state normally comes from restart reconciliation. Simulate it
  // with a live detached PID so the control-boundary behavior is testable on
  // platforms where non-detached children die with their parent.
  await daemon.stop();
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  orphan.unref();
  orphanPid = orphan.pid;
  assert.ok(orphanPid);
  const recordPath = path.join(daemon.stateDir, "workers", worker.id, "worker.json");
  const record = JSON.parse(await readFile(recordPath, "utf8")) as WorkerRecord;
  record.status = "orphaned";
  record.statusReason = "Supervisor restarted and no longer owns the live harness process";
  record.pid = orphanPid;
  record.endedAt = new Date().toISOString();
  record.updatedAt = record.endedAt;
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  restarted = new TestDaemon(daemon.stateDir);
  const recoveredClient = await restarted.start();
  const recovered = await statusOf(recoveredClient, worker.id);
  assert.equal(recovered.worker.status, "orphaned");
  assert.equal(recovered.worker.pidAlive, true);

  await assert.rejects(
    () => recoveredClient.request("cancel", { workerId: worker.id, timeoutMs: 2000 }),
    (error: unknown) => error instanceof SupervisorError && error.code === "UNSUPPORTED",
  );
  assert.equal(isPidAlive(orphanPid), true, "no fake cancellation of an orphan");

  await assert.rejects(
    () => recoveredClient.request("resume", { workerId: worker.id, prompt: "resume anyway" }),
    (error: unknown) => error instanceof SupervisorError && error.code === "INVALID_STATE",
  );
});

test("graceful daemon shutdown cancels active workers and records why", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "15000" } });
  let restarted: TestDaemon | null = null;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] shutdown target");
  await waitForEvent(client, worker.id, "run.started", 5000);
  await daemon.stop();
  await waitPidDead(worker.pid!, 5000);

  restarted = new TestDaemon(daemon.stateDir);
  const after = await restarted.start();
  const status = await statusOf(after, worker.id);
  assert.equal(status.worker.status, "cancelled");
  assert.match(status.worker.statusReason ?? "", /supervisor_shutdown/);
  const events = await eventsOf(after, worker.id);
  assert.ok(
    events.events.some(
      (event) =>
        event.type === "run.cancelled" && event.data?.reason === "supervisor_shutdown",
    ),
  );
});
