import { test } from "node:test";
import assert from "node:assert/strict";
import { isPidAlive } from "../../src/util/async.js";
import {
  TestDaemon,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  waitPidDead,
  waitTerminal,
} from "./helpers.js";

test("completed, failed, crashed, and cancelled are distinct terminal outcomes", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "4000" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const good = await spawnWorker(client, cwd, "do the normal thing");
  const goodFinal = await waitTerminal(client, good.id, 10_000);
  assert.equal(goodFinal.worker.status, "completed");
  assert.equal(goodFinal.worker.result?.text, "FAKE_PI_OK");

  const bad = await spawnWorker(client, cwd, "[scenario:error] hit a provider error");
  const badFinal = await waitTerminal(client, bad.id, 10_000);
  assert.equal(badFinal.worker.status, "failed");
  assert.match(badFinal.worker.error ?? "", /FAKE_PROVIDER_ERROR/);
  assert.equal(badFinal.worker.exit?.code, 0);

  const crash = await spawnWorker(client, cwd, "[scenario:crash] kill the process");
  const crashFinal = await waitTerminal(client, crash.id, 10_000);
  assert.equal(crashFinal.worker.status, "crashed");
  assert.equal(crashFinal.worker.exit?.code, 7);
  assert.match(crashFinal.worker.error ?? "", /exited unexpectedly/);

  const active = await spawnWorker(client, cwd, "[scenario:slow] cancel this run");
  const cancelled = await client.request<{
    status: string;
    exit?: { code: number | null; signal: string | null };
  }>(
    "cancel",
    { workerId: active.id, timeoutMs: 8000 },
    { timeoutMs: 20_000 },
  );
  assert.equal(cancelled.status, "cancelled");
  assert.notEqual(cancelled.status, "failed");
  assert.notEqual(cancelled.status, "crashed");
  await waitPidDead(active.pid!, 5000);
  assert.equal(isPidAlive(active.pid), false);

  const statuses = new Set(
    [goodFinal.worker.status, badFinal.worker.status, crashFinal.worker.status, cancelled.status],
  );
  assert.deepEqual(statuses, new Set(["completed", "failed", "crashed", "cancelled"]));
});

test("cancellation force-kills a harness that ignores abort", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "15000" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const worker = await spawnWorker(client, cwd, "[scenario:slow] [ignore-abort] refuse to stop");
  const startedAt = Date.now();
  const cancelled = await client.request<{ status: string; pid?: number; statusReason?: string }>(
    "cancel",
    { workerId: worker.id, timeoutMs: 8000 },
    { timeoutMs: 25_000 },
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(cancelled.status, "cancelled");
  assert.ok(elapsed < 12_000, `cancel took too long: ${elapsed}ms`);
  await waitPidDead(worker.pid!, 5000);
  assert.equal(isPidAlive(worker.pid), false);
  const events = await eventsOf(client, worker.id);
  assert.ok(events.events.some((event) => event.type === "worker.cancel_requested"));
  assert.ok(events.events.some((event) => event.type === "run.cancelled"));
  assert.ok(events.events.some((event) => event.type === "worker.exited"));
});
