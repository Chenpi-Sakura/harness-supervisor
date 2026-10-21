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

test("cancel during startup cancels before the prompt is accepted", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_START_DELAY_MS: "1500" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const spawning = client.request<{ id: string; status: string }>(
    "spawn",
    { runtime: "pi", cwd, prompt: "must never start" },
    { timeoutMs: 20_000 },
  );
  let workerId: string | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const list = await client.request<Array<{ id: string; status: string }>>("list", {});
    const starting = list.find((worker) => worker.status === "starting");
    if (starting) {
      workerId = starting.id;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(workerId, "spawn record must be visible while startup is in progress");

  const cancelled = await client.request<{ status: string; pid?: number }>(
    "cancel",
    { workerId, timeoutMs: 8000 },
    { timeoutMs: 20_000 },
  );
  assert.equal(cancelled.status, "cancelled");
  await waitPidDead(cancelled.pid!, 5000);
  const spawned = await spawning;
  assert.equal(spawned.status, "cancelled");

  const events = await eventsOf(client, workerId);
  assert.equal(
    events.events.filter((event) => event.type === "run.accepted").length,
    0,
    "the prompt must not be accepted after cancellation won the race",
  );
  assert.equal(
    events.events.filter((event) => event.type === "run.cancelled").length,
    1,
  );
});

test("concurrent cancels are idempotent and record one cancellation", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "15000" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] cancel twice");
  await waitForEvent(client, worker.id, "run.started", 5000);
  const first = client.request<{ status: string }>(
    "cancel",
    { workerId: worker.id, timeoutMs: 8000 },
    { timeoutMs: 25_000 },
  );
  const second = client.request<{ status: string }>(
    "cancel",
    { workerId: worker.id, timeoutMs: 8000 },
    { timeoutMs: 25_000 },
  );
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["cancelled", "cancelled"]);
  const events = await eventsOf(client, worker.id);
  assert.equal(events.events.filter((event) => event.type === "run.cancelled").length, 1);
  await waitPidDead(worker.pid!, 5000);
});

test("shutdown waits out an in-flight spawn and leaves no live worker", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let restarted: TestDaemon | null = null;
  const client = await daemon.start({ env: { FAKE_PI_START_DELAY_MS: "1500" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });

  const spawning = client.request("spawn", {
    runtime: "pi",
    cwd,
    prompt: "slow to become ready",
  }, { timeoutMs: 20_000 });
  const shutdown = client.request("shutdown", {}, { timeoutMs: 30_000 });
  const [spawnResult, shutdownResult] = await Promise.allSettled([spawning, shutdown]);
  assert.equal(shutdownResult.status, "fulfilled");
  assert.equal(spawnResult.status, "rejected");
  assert.equal(rejectionCode((spawnResult as PromiseRejectedResult).reason), "INVALID_STATE");

  restarted = new TestDaemon(daemon.stateDir);
  const after = await restarted.start();
  const list = await after.request<Array<{ status: string }>>("list", {});
  assert.ok(
    list.every((worker) =>
      ["completed", "failed", "cancelled", "crashed", "orphaned", "interrupted"].includes(
        worker.status,
      ),
    ),
    `no worker may survive shutdown: ${JSON.stringify(list)}`,
  );
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
