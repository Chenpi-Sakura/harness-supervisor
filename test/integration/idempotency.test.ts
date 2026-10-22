import { test } from "node:test";
import assert from "node:assert/strict";
import { SupervisorError } from "../../src/errors.js";
import type { WorkerSummary } from "../../src/types.js";
import { sleep } from "../../src/util/async.js";
import {
  TestDaemon,
  connectExisting,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  waitForEvent,
  waitTerminal,
} from "./helpers.js";

function code(error: unknown): string | undefined {
  return error instanceof SupervisorError ? error.code : undefined;
}

test("a repeated spawn requestId replays the accepted worker instead of spawning again", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const first = await client.request<WorkerSummary>(
    "spawn",
    { runtime: "pi", cwd, prompt: "idempotent task", requestId: "req-spawn-1" },
    { timeoutMs: 60_000 },
  );
  const second = await client.request<WorkerSummary>("spawn", {
    runtime: "pi",
    cwd,
    prompt: "idempotent task",
    requestId: "req-spawn-1",
  });
  assert.equal(second.id, first.id, "the same request id must not create a second worker");

  const workers = await client.request<WorkerSummary[]>("list", {});
  assert.equal(workers.length, 1);

  const terminal = await waitTerminal(client, first.id, 20_000);
  assert.equal(terminal.worker.status, "completed");

  const third = await client.request<WorkerSummary>("spawn", {
    runtime: "pi",
    cwd,
    prompt: "idempotent task",
    requestId: "req-spawn-1",
  });
  assert.equal(third.id, first.id);
  assert.equal(third.status, "completed", "a replay reports the current state of that worker");
  const after = await client.request<WorkerSummary[]>("list", {});
  assert.equal(after.length, 1, "still exactly one worker");
});

test("the same requestId with different parameters is a conflict", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  await client.request<WorkerSummary>(
    "spawn",
    { runtime: "pi", cwd, prompt: "first prompt", requestId: "req-conflict" },
    { timeoutMs: 60_000 },
  );
  await assert.rejects(
    () =>
      client.request("spawn", {
        runtime: "pi",
        cwd,
        prompt: "a different prompt",
        requestId: "req-conflict",
      }),
    (error: unknown) => code(error) === "CONFLICT",
  );
  const workers = await client.request<WorkerSummary[]>("list", {});
  assert.equal(workers.length, 1, "a conflicting retry must not execute");
});

test("concurrent duplicates with one requestId create exactly one worker", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_START_DELAY_MS: "500" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const results = await Promise.allSettled([
    client.request<WorkerSummary>(
      "spawn",
      { runtime: "pi", cwd, prompt: "concurrent duplicate", requestId: "req-race" },
      { timeoutMs: 60_000 },
    ),
    client.request<WorkerSummary>(
      "spawn",
      { runtime: "pi", cwd, prompt: "concurrent duplicate", requestId: "req-race" },
      { timeoutMs: 60_000 },
    ),
    client.request<WorkerSummary>(
      "spawn",
      { runtime: "pi", cwd, prompt: "concurrent duplicate", requestId: "req-race" },
      { timeoutMs: 60_000 },
    ),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(fulfilled.length, 1, "only the first request may execute");
  assert.equal(rejected.length, 2);
  for (const result of rejected) {
    assert.equal(code(result.reason), "INVALID_STATE", String(result.reason));
  }
  const workers = await client.request<WorkerSummary[]>("list", {});
  assert.equal(workers.length, 1);
  await waitTerminal(client, workers[0]!.id, 20_000);
});

test("a startup failure is replayed as a failure, not retried", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_START_FAIL: "1" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  await assert.rejects(
    () =>
      client.request(
        "spawn",
        { runtime: "pi", cwd, prompt: "never starts", requestId: "req-fail" },
        { timeoutMs: 60_000 },
      ),
    (error: unknown) => code(error) === "HARNESS_ERROR" || code(error) === "INVALID_STATE",
  );
  const workersAfterFailure = await client.request<WorkerSummary[]>("list", {});
  assert.equal(workersAfterFailure.length, 1);
  assert.equal(workersAfterFailure[0]!.status, "failed");

  await assert.rejects(
    () =>
      client.request("spawn", {
        runtime: "pi",
        cwd,
        prompt: "never starts",
        requestId: "req-fail",
      }),
    (error: unknown) => {
      assert.match(String((error as Error).message), /Replayed result/);
      return true;
    },
  );
  const workersAfterReplay = await client.request<WorkerSummary[]>("list", {});
  assert.equal(workersAfterReplay.length, 1, "the replay must not spawn a second worker");
});

test("a run that fails after acceptance is replayed as the same worker", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const accepted = await client.request<WorkerSummary>(
    "spawn",
    { runtime: "pi", cwd, prompt: "[scenario:error] fails later", requestId: "req-run-fail" },
    { timeoutMs: 60_000 },
  );
  const terminal = await waitTerminal(client, accepted.id, 20_000);
  assert.equal(terminal.worker.status, "failed");

  const replay = await client.request<WorkerSummary>("spawn", {
    runtime: "pi",
    cwd,
    prompt: "[scenario:error] fails later",
    requestId: "req-run-fail",
  });
  assert.equal(replay.id, accepted.id);
  assert.equal(replay.status, "failed", "the replay reports the real final state");
  const workers = await client.request<WorkerSummary[]>("list", {});
  assert.equal(workers.length, 1, "a timed-out spawn retry must not start a second run");
});

test("a repeated send requestId enqueues the message once", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "4000" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] steer once");
  await waitForEvent(client, worker.id, "run.started", 10_000);

  await client.request("send", {
    workerId: worker.id,
    message: "only once",
    mode: "steer",
    requestId: "req-send-1",
  });
  const replay = await client.request<WorkerSummary>("send", {
    workerId: worker.id,
    message: "only once",
    mode: "steer",
    requestId: "req-send-1",
  });
  assert.equal(replay.id, worker.id);

  await assert.rejects(
    () =>
      client.request("send", {
        workerId: worker.id,
        message: "different text",
        mode: "steer",
        requestId: "req-send-1",
      }),
    (error: unknown) => code(error) === "CONFLICT",
  );

  const final = await waitTerminal(client, worker.id, 30_000);
  const events = await eventsOf(client, worker.id);
  const sent = events.events.filter((event) => event.type === "run.message_sent");
  assert.equal(sent.length, 1, "the message must be queued exactly once");
  assert.equal(final.worker.status, "completed");
});

test("an interrupted requestId returns UNCERTAIN after a daemon restart and is never re-executed", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let restarted: TestDaemon | null = null;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });
  const client = await daemon.start({ env: { FAKE_PI_START_DELAY_MS: "20000" } });

  const inFlight = client
    .request(
      "spawn",
      { runtime: "pi", cwd, prompt: "startup takes forever", requestId: "req-interrupted" },
      { timeoutMs: 60_000 },
    )
    .catch((error: unknown) => error);
  await sleep(800);
  await daemon.kill();
  await inFlight;

  restarted = new TestDaemon(daemon.stateDir);
  const client2 = await connectExisting(daemon.stateDir, 20_000).catch(async () => {
    const fresh = await restarted!.start();
    return fresh;
  });
  await assert.rejects(
    () =>
      client2.request("spawn", {
        runtime: "pi",
        cwd,
        prompt: "startup takes forever",
        requestId: "req-interrupted",
      }),
    (error: unknown) => {
      assert.equal(code(error), "UNCERTAIN");
      return true;
    },
  );
  const workers = await client2.request<WorkerSummary[]>("list", {});
  assert.equal(workers.length, 1, "the retry must not start a second worker");
  assert.ok(["orphaned", "interrupted", "starting", "running"].includes(workers[0]!.status));
  client2.close();
});