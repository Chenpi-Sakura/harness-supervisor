import { test } from "node:test";
import assert from "node:assert/strict";
import { SupervisorError } from "../../src/errors.js";
import { isPidAlive } from "../../src/util/async.js";
import {
  TestDaemon,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  waitForEvent,
  waitPidDead,
  waitTerminal,
} from "./helpers.js";

function rejectionCode(error: unknown): string | undefined {
  return error instanceof SupervisorError ? error.code : undefined;
}

test("concurrent spawn requests cannot exceed maxWorkers", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_MAX_WORKERS: "1",
      FAKE_PI_SLOW_STEP_MS: "8000",
    },
  });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const results = await Promise.allSettled([
    spawnWorker(client, cwd, "[scenario:slow] first"),
    spawnWorker(client, cwd, "[scenario:slow] second"),
    spawnWorker(client, cwd, "[scenario:slow] third"),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(fulfilled.length, 1, "exactly one spawn may win the only slot");
  assert.equal(rejected.length, 2);
  for (const result of rejected) {
    assert.equal(rejectionCode(result.reason), "LIMIT_EXCEEDED", String(result.reason));
  }
  const list = await client.request<Array<{ id: string; status: string }>>("list", {});
  assert.equal(list.length, 1);
  assert.ok(["starting", "running"].includes(list[0]!.status));
});

test("send and duplicate answer are rejected once cancellation starts", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "15000" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] cancel with a race");
  await waitForEvent(client, worker.id, "run.started", 5000);

  const cancellation = client.request<{ status: string }>(
    "cancel",
    { workerId: worker.id, timeoutMs: 8000 },
    { timeoutMs: 20_000 },
  );
  await assert.rejects(
    () =>
      client.request("send", {
        workerId: worker.id,
        message: "too late",
        mode: "steer",
      }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );
  const cancelled = await cancellation;
  assert.equal(cancelled.status, "cancelled");
  const events = await eventsOf(client, worker.id);
  assert.equal(
    events.events.filter((event) => event.type === "run.message_sent").length,
    0,
    "a rejected send must not be recorded as delivered",
  );
});

test("duplicate concurrent answers to one dialog are rejected", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "[scenario:ask] answer once");
  const waiting = await client.request<{
    worker: { pendingInput?: { requestId: string } };
  }>(
    "wait",
    { workerId: worker.id, sinceSeq: 0, timeoutMs: 5000, until: "terminal" },
    { timeoutMs: 15_000 },
  );
  const requestId = waiting.worker.pendingInput!.requestId;
  const results = await Promise.allSettled([
    client.request("answer", { workerId: worker.id, requestId, response: { confirmed: true } }),
    client.request("answer", { workerId: worker.id, requestId, response: { confirmed: false } }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(rejected);
  assert.equal(rejectionCode(rejected.reason), "INVALID_STATE");
  const final = await waitTerminal(client, worker.id, 10_000);
  assert.equal(final.worker.status, "completed");
});

test("cancel clears queued steering before aborting", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "15000" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] queued messages must not survive");
  await waitForEvent(client, worker.id, "run.started", 5000);
  await client.request("send", {
    workerId: worker.id,
    message: "do this after the abort",
    mode: "steer",
  });
  await waitForEvent(client, worker.id, "run.message_sent", 5000);

  const cancelled = await client.request<{ status: string; pid?: number }>(
    "cancel",
    { workerId: worker.id, timeoutMs: 8000 },
    { timeoutMs: 25_000 },
  );
  assert.equal(cancelled.status, "cancelled");
  await waitPidDead(cancelled.pid ?? worker.pid!, 5000);
  assert.equal(isPidAlive(cancelled.pid ?? worker.pid), false);

  const events = await eventsOf(client, worker.id);
  const cleared = events.events.find(
    (event) => event.type === "run.progress" && event.data?.kind === "queue_cleared",
  );
  assert.ok(cleared, "cancel must report that the harness queue was cleared");
  assert.equal(cleared.data?.steering, 1);
  assert.equal(cleared.data?.followUp, 0);
});

test("concurrent resumes produce one live runtime only", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "finish before resume");
  const first = await waitTerminal(client, worker.id, 10_000);
  assert.equal(first.worker.status, "completed");

  const results = await Promise.allSettled([
    client.request("resume", { workerId: worker.id, prompt: "resume A" }),
    client.request("resume", { workerId: worker.id, prompt: "resume B" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(rejected);
  assert.equal(rejectionCode(rejected.reason), "INVALID_STATE");
  const final = await waitTerminal(client, worker.id, 10_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.resumeCount, 1);
});
