import { test } from "node:test";
import assert from "node:assert/strict";
import { SupervisorError } from "../../src/errors.js";
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

test("an orphaned live process cannot be cancelled by the restarted supervisor", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let restarted: TestDaemon | null = null;
  let client = await daemon.start({
    env: {
      FAKE_PI_SLOW_STEP_MS: "60000",
      FAKE_PI_SURVIVE_STDIN_END: "1",
    },
  });
  let orphanPid: number | undefined;
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

  const worker = await spawnWorker(client, cwd, "[scenario:slow] outlive the daemon");
  await waitForEvent(client, worker.id, "run.started", 5000);
  orphanPid = worker.pid!;
  assert.ok(orphanPid);
  await daemon.kill();
  await sleep(300);
  assert.equal(isPidAlive(orphanPid), true, "the fixture must survive daemon death");

  restarted = new TestDaemon(daemon.stateDir);
  client = await restarted.start();
  const recovered = await statusOf(client, worker.id);
  assert.equal(recovered.worker.status, "orphaned");
  assert.equal(recovered.worker.pidAlive, true);

  await assert.rejects(
    () => client.request("cancel", { workerId: worker.id, timeoutMs: 2000 }),
    (error: unknown) => error instanceof SupervisorError && error.code === "UNSUPPORTED",
  );
  assert.equal(isPidAlive(orphanPid), true, "no fake cancellation of an orphan");

  await assert.rejects(
    () => client.request("resume", { workerId: worker.id, prompt: "resume anyway" }),
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
