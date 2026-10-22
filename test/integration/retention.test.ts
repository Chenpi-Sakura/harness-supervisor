import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import type { NotificationsResult } from "../../src/types.js";
import type { WorkerSummary } from "../../src/types.js";
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

  const pruned = await client.request<{ removed: string[]; freedBytes: number }>("prune", {
    olderThanDays: 0,
    keep: 0,
  });
  assert.ok(pruned.removed.includes(worker.id), "an acked, old terminal worker can be pruned");
  assert.ok(pruned.freedBytes > 0);
  assert.equal(existsSync(workerDir(daemon.stateDir, worker.id)), false);
  const list = await client.request<WorkerSummary[]>("list", {});
  assert.equal(list.length, 0);

  // The harness session directory survives unless includeSessions is requested.
  assert.equal(existsSync(path.join(daemon.stateDir, "sessions", worker.id)), true);
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