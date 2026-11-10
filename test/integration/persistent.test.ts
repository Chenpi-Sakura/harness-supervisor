import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SupervisorError } from "../../src/errors.js";
import type { NotificationsResult, WorkerSummary } from "../../src/types.js";
import { isPidAlive, sleep } from "../../src/util/async.js";
import {
  TestDaemon,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  statusOf,
  waitForEvent,
  waitForStatus,
  waitTerminal,
} from "./helpers.js";

const THREAD_A = { channel: "codex-queue" as const, codexThreadId: "persistent-thread-A" };
const THREAD_B = { channel: "codex-queue" as const, codexThreadId: "persistent-thread-B" };
const FAKE_CODEX = fileURLToPath(new URL("../fixtures/fake-codex-queue.mjs", import.meta.url));

function rejectionCode(error: unknown): string | undefined {
  return error instanceof SupervisorError ? error.code : undefined;
}

test("a persistent worker runs three Turns on one native session", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();

  const firstToken = "TURN_ONE_SECRET_4f21";
  const worker = await spawnWorker(
    client,
    cwd,
    `[scenario:slow] remember ${firstToken} for later`,
    { persistence: "persistent" },
  );
  assert.equal(worker.persistence, "persistent");
  assert.equal(worker.lifecycle, "active");

  const turn1 = await waitTerminal(client, worker.id);
  assert.equal(turn1.worker.status, "completed");
  assert.equal(turn1.worker.lifecycle, "idle", "a finished Turn is not a retired worker");
  assert.equal(turn1.worker.session.available, true);
  assert.equal(turn1.worker.session.restorable, true);
  assert.equal(isPidAlive(turn1.worker.pid), false, "the activation process must exit");
  const sessionId = turn1.worker.sessionId;
  const sessionFile = turn1.worker.sessionFile;
  assert.ok(sessionId);
  assert.ok(sessionFile);
  assert.equal(turn1.worker.sessionRef?.sessionId, sessionId);
  assert.equal(turn1.worker.sessionRef?.sessionLocator, sessionFile);

  const secondToken = "TURN_TWO_SECRET_9a17";
  const turn2 = await client.request<typeof worker>(
    "continue",
    { workerId: worker.id, prompt: `[scenario:recall] keep ${secondToken} too` },
    { timeoutMs: 60_000 },
  );
  assert.equal(turn2.id, worker.id, "continuation must keep the worker identity");
  assert.ok(
    ["active", "idle"].includes(turn2.lifecycle),
    `unexpected lifecycle after continue: ${turn2.lifecycle}`,
  );
  const settled2 = await waitTerminal(client, worker.id, 30_000, turn2.lastSeq);
  assert.equal(settled2.worker.status, "completed");
  assert.equal(settled2.worker.lifecycle, "idle");
  assert.equal(settled2.worker.sessionId, sessionId, "the native session id must not change");
  assert.equal(settled2.worker.sessionFile, sessionFile);
  assert.match(
    settled2.worker.result?.text ?? "",
    new RegExp(firstToken),
    "the second Turn must see the first Turn's stored context",
  );

  const thirdToken = "TURN_THREE_SECRET_c3";
  const turn3 = await client.request<typeof worker>(
    "continue",
    { workerId: worker.id, prompt: `[scenario:recall] also ${thirdToken}` },
    { timeoutMs: 60_000 },
  );
  const settled3 = await waitTerminal(client, worker.id, 30_000, turn3.lastSeq);
  assert.equal(settled3.worker.status, "completed");
  assert.equal(settled3.worker.sessionId, sessionId);
  assert.equal(settled3.worker.sessionFile, sessionFile);
  assert.equal(settled3.worker.resumeCount, 2);
  assert.match(
    settled3.worker.result?.text ?? "",
    new RegExp(secondToken),
    "the third Turn must see the second Turn's context",
  );
  assert.equal(isPidAlive(settled3.worker.pid), false);

  const history = await eventsOf(client, worker.id);
  assert.equal(
    history.events.filter((event) => event.type === "worker.continued").length,
    2,
  );
  assert.equal(
    history.events.filter((event) => event.type === "worker.resumed").length,
    0,
    "a normal continuation is not a resume recovery",
  );
  const accepted = history.events.filter((event) => event.type === "run.accepted");
  assert.equal(accepted.length, 3);
  assert.equal(accepted[0]?.data?.continued, undefined);
  assert.equal(accepted[1]?.data?.continued, true);
  assert.equal(accepted[2]?.data?.continued, true);
});

test("a cancelled persistent Turn can continue on the same session", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-cancel-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "5000" } });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] cancel this Turn", {
    persistence: "persistent",
  });
  await waitForStatus(client, worker.id, ["running"], 10_000);
  const cancelled = await client.request<{ status: string; sessionId?: string }>(
    "cancel",
    { workerId: worker.id, timeoutMs: 8000 },
    { timeoutMs: 20_000 },
  );
  assert.equal(cancelled.status, "cancelled");
  const sessionId = cancelled.sessionId;
  assert.ok(sessionId);

  const resumed = await client.request<typeof worker>(
    "continue",
    { workerId: worker.id, prompt: "[scenario:recall] continue after cancellation" },
    { timeoutMs: 60_000 },
  );
  assert.equal(resumed.sessionId, sessionId);
  const settled = await waitTerminal(client, worker.id, 20_000, resumed.lastSeq);
  assert.equal(settled.worker.status, "completed");
  assert.equal(settled.worker.sessionId, sessionId);
  assert.equal(settled.worker.resumeCount, 1);
});

test("a failed persistent Turn reports the error and can continue", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-failed-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();

  const worker = await spawnWorker(client, cwd, "[scenario:error] fail this Turn", {
    persistence: "persistent",
  });
  const failed = await waitTerminal(client, worker.id);
  assert.equal(failed.worker.status, "failed");
  assert.match(failed.worker.error ?? "", /FAKE_PROVIDER_ERROR/);
  assert.equal(failed.worker.session.restorable, true);
  const sessionId = failed.worker.sessionId;
  assert.ok(sessionId);

  const resumed = await client.request<typeof worker>(
    "continue",
    { workerId: worker.id, prompt: "retry after the failure" },
    { timeoutMs: 60_000 },
  );
  assert.equal(resumed.sessionId, sessionId);
  const settled = await waitTerminal(client, worker.id, 20_000, resumed.lastSeq);
  assert.equal(settled.worker.status, "completed");
  assert.equal(settled.worker.sessionId, sessionId);
  assert.match(settled.worker.result?.text ?? "", /FAKE_PI_OK/);
});

test("continue and resume obey maxWorkers", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-capacity-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start({
    env: { HARNESS_SUPERVISOR_MAX_WORKERS: "2", FAKE_PI_START_DELAY_MS: "800" },
  });
  const workers: WorkerSummary[] = [];
  for (let index = 0; index < 3; index += 1) {
    const worker = await spawnWorker(client, cwd, `seed ${index}`, { persistence: "persistent" });
    await waitTerminal(client, worker.id);
    workers.push(worker);
  }

  const attempts = await Promise.allSettled(
    workers.map((worker) =>
      client.request<WorkerSummary>(
        "continue",
        { workerId: worker.id, prompt: "capacity probe" },
        { timeoutMs: 60_000 },
      ),
    ),
  );
  const fulfilled = attempts.filter(
    (item): item is PromiseFulfilledResult<WorkerSummary> => item.status === "fulfilled",
  );
  const rejected = attempts.filter(
    (item): item is PromiseRejectedResult => item.status === "rejected",
  );
  const outcomes = attempts.map((item) =>
    item.status === "fulfilled" ? `ok:${item.value.id}` : `err:${item.reason.message}`,
  );
  assert.equal(fulfilled.length, 2, `maxWorkers=2 allows exactly two activations: ${outcomes}`);
  assert.equal(rejected.length, 1, outcomes.join(" | "));
  assert.match(
    String((rejected[0]!.reason as Error).message),
    /Maximum concurrent workers/i,
  );
  for (const item of fulfilled) {
    await waitTerminal(client, item.value.id, 30_000, item.value.lastSeq);
  }

  const idle = workers.find(
    (worker) => !fulfilled.some((item) => item.value.id === worker.id),
  )!;
  const retried = await client.request<WorkerSummary>(
    "continue",
    { workerId: idle.id, prompt: "after capacity frees" },
    { timeoutMs: 60_000 },
  );
  await waitTerminal(client, idle.id, 30_000, retried.lastSeq);
});

test("continue refuses a oneshot worker and a missing native session", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-errors-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();

  const oneshot = await spawnWorker(client, cwd, "[scenario:normal] oneshot");
  const settled = await waitTerminal(client, oneshot.id);
  assert.equal(settled.worker.persistence, "oneshot");
  assert.equal(settled.worker.status, "completed");
  await assert.rejects(
    () => client.request("continue", { workerId: oneshot.id, prompt: "next turn" }),
    (error: unknown) => {
      assert.equal(rejectionCode(error), "UNSUPPORTED");
      assert.match(String((error as Error).message), /not persistent/i);
      return true;
    },
  );

  const persistent = await spawnWorker(client, cwd, "[scenario:normal] persistent", {
    persistence: "persistent",
  });
  const settled2 = await waitTerminal(client, persistent.id);
  assert.equal(settled2.worker.session.restorable, true);
  assert.ok(settled2.worker.sessionFile);
  await rm(settled2.worker.sessionFile, { force: true });

  const status = await statusOf(client, persistent.id);
  assert.equal(status.worker.session.available, false);
  assert.equal(status.worker.session.restorable, false);
  assert.equal(status.worker.session.reason, "session_file_missing");
  assert.equal(status.worker.lifecycle, "unavailable");

  await assert.rejects(
    () => client.request("continue", { workerId: persistent.id, prompt: "next turn" }),
    (error: unknown) => {
      assert.equal(rejectionCode(error), "UNSUPPORTED");
      assert.match(String((error as Error).message), /session_file_missing/);
      return true;
    },
  );

  const after = await statusOf(client, persistent.id);
  assert.equal(after.worker.status, "completed", "a rejected continue must not change the worker");
  assert.equal(after.worker.sessionId, settled2.worker.sessionId);
});

test("continue rejects an active worker and concurrent continuation", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-races-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "4000" } });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] busy", {
    persistence: "persistent",
  });
  await waitForEvent(client, worker.id, "run.started", 5000);
  await assert.rejects(
    () => client.request("continue", { workerId: worker.id, prompt: "while running" }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );

  const settled = await waitTerminal(client, worker.id, 30_000);
  assert.equal(settled.worker.lifecycle, "idle");

  const results = await Promise.allSettled([
    client.request<typeof worker>(
      "continue",
      { workerId: worker.id, prompt: "[scenario:slow] first continuation" },
      { timeoutMs: 60_000 },
    ),
    client.request<typeof worker>(
      "continue",
      { workerId: worker.id, prompt: "[scenario:slow] racing continuation" },
      { timeoutMs: 60_000 },
    ),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(fulfilled.length, 1, "only one continuation may start an activation");
  assert.equal(rejected.length, 1);
  assert.equal(rejectionCode(rejected[0]!.reason), "INVALID_STATE");

  const accepted = fulfilled[0] as PromiseFulfilledResult<typeof worker>;
  const final = await waitTerminal(client, worker.id, 30_000, accepted.value.lastSeq);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.sessionId, settled.worker.sessionId);
});

test("a persistent worker survives a daemon restart between Turns", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-restart-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const firstClient = await daemon.start();
  const token = "RESTART_TOKEN_6e2";
  const worker = await spawnWorker(firstClient, cwd, `Remember ${token}`, {
    persistence: "persistent",
  });
  const settled = await waitTerminal(firstClient, worker.id);
  assert.equal(settled.worker.lifecycle, "idle");
  const sessionId = settled.worker.sessionId;

  await daemon.stop();
  const restarted = await daemon.start();

  const restored = await statusOf(restarted, worker.id);
  assert.equal(restored.worker.persistence, "persistent");
  assert.equal(restored.worker.status, "completed");
  assert.equal(restored.worker.lifecycle, "idle");
  assert.equal(restored.worker.session.restorable, true);
  assert.equal(restored.worker.sessionRef?.sessionId, sessionId);

  const accepted = await restarted.request<typeof worker>(
    "continue",
    { workerId: worker.id, prompt: "[scenario:recall] after restart" },
    { timeoutMs: 60_000 },
  );
  const final = await waitTerminal(restarted, worker.id, 30_000, accepted.lastSeq);
  assert.equal(final.worker.sessionId, sessionId);
  assert.match(final.worker.result?.text ?? "", new RegExp(token));
  assert.equal(final.worker.lifecycle, "idle");
});

test("each persistent Turn produces its own notification on the bound thread", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-notify-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_CODEX_BIN: `"${process.execPath}" "${FAKE_CODEX}"`,
    },
  });

  const a = await spawnWorker(client, cwd, "[scenario:slow] A turn 1", {
    persistence: "persistent",
    notifyTarget: THREAD_A,
  });
  const b = await spawnWorker(client, cwd, "[scenario:slow] B turn 1", {
    persistence: "persistent",
    notifyTarget: THREAD_B,
  });
  await waitTerminal(client, a.id, 20_000);
  await waitTerminal(client, b.id, 20_000);

  const a2 = await client.request<typeof a>(
    "continue",
    { workerId: a.id, prompt: "A turn 2" },
    { timeoutMs: 60_000 },
  );
  const b2 = await client.request<typeof b>(
    "continue",
    { workerId: b.id, prompt: "B turn 2" },
    { timeoutMs: 60_000 },
  );
  await waitTerminal(client, a.id, 20_000, a2.lastSeq);
  await waitTerminal(client, b.id, 20_000, b2.lastSeq);

  let inbox = await client.request<NotificationsResult>("notifications", { state: "all" });
  const deadline = Date.now() + 5000;
  while (inbox.notifications.length < 4 && Date.now() < deadline) {
    await sleep(50);
    inbox = await client.request<NotificationsResult>("notifications", { state: "all" });
  }

  for (const [worker, target] of [
    [a, THREAD_A],
    [b, THREAD_B],
  ] as const) {
    const records = inbox.notifications.filter((record) => record.workerId === worker.id);
    assert.equal(records.length, 2, "each Turn must produce its own notification");
    assert.equal(new Set(records.map((record) => record.id)).size, 2);
    assert.equal(new Set(records.map((record) => record.seq)).size, 2);
    for (const record of records) {
      assert.equal(record.kind, "completed");
      assert.equal(record.id, `${worker.id}#${record.seq}`);
      assert.deepEqual(record.target, target, "a worker-level target must not cross threads");
    }
    const history = await eventsOf(client, worker.id);
    assert.equal(
      history.events.filter((event) => event.type === "run.completed").length,
      2,
      "both Turns must be in the same worker history",
    );
  }
});

test("needs_input on a persistent worker can be answered and the session continued", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-input-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_CODEX_BIN: `"${process.execPath}" "${FAKE_CODEX}"`,
    },
  });

  const worker = await spawnWorker(client, cwd, "[scenario:ask] request authorization", {
    persistence: "persistent",
    notifyTarget: THREAD_A,
  });
  const waiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  assert.equal(waiting.lifecycle, "awaiting_input");
  assert.equal(waiting.pendingInput?.method, "confirm");
  assert.ok(waiting.pendingInput?.requestId);

  await client.request("answer", {
    workerId: worker.id,
    requestId: waiting.pendingInput!.requestId,
    response: { confirmed: true },
  });
  const turn1 = await waitTerminal(client, worker.id, 15_000);
  assert.equal(turn1.worker.status, "completed");
  assert.equal(turn1.worker.lifecycle, "idle");
  assert.match(turn1.worker.result?.text ?? "", /ANSWER:true/);

  const inbox = await client.request<NotificationsResult>("notifications", {
    workerId: worker.id,
    state: "all",
  });
  assert.ok(
    inbox.notifications.some((record) => record.kind === "needs_input"),
    "the input request must be recorded as a worker-level notification",
  );
  const history = await eventsOf(client, worker.id);
  assert.ok(history.events.some((event) => event.type === "run.input_answered"));

  const accepted = await client.request<typeof worker>(
    "continue",
    { workerId: worker.id, prompt: "[scenario:recall] after the answer" },
    { timeoutMs: 60_000 },
  );
  const turn2 = await waitTerminal(client, worker.id, 20_000, accepted.lastSeq);
  assert.equal(turn2.worker.sessionId, turn1.worker.sessionId);
  assert.equal(turn2.worker.lifecycle, "idle");
  assert.match(
    turn2.worker.result?.text ?? "",
    /request authorization/,
    "the continuation must see the first Turn's stored context",
  );
});

test("supervisor info reports storage and active/idle worker counts", async (t) => {
  const daemon = await TestDaemon.create("hs-persistent-storage-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:slow] storage probe", {
    persistence: "persistent",
  });

  const running = await client.request<{
    storage?: {
      workers: number;
      eventBytes: number;
      largestEventFileBytes: number;
      activeWorkers: number;
      idleWorkers: number;
      startup: { totalMs: number; storeInitMs: number; store: { eventBytes: number } };
    };
  }>("info", {});
  assert.ok(running.storage);
  assert.ok(running.storage.workers >= 1);
  assert.ok(running.storage.activeWorkers >= 1);
  assert.ok(running.storage.eventBytes > 0, "event bytes must come from the loaded log sizes");

  await waitTerminal(client, worker.id, 20_000);
  const idle = await client.request<typeof running>("info", {});
  assert.ok(idle.storage);
  assert.equal(idle.storage.idleWorkers >= 1, true);
  assert.equal(idle.storage.activeWorkers, 0);
  assert.ok(idle.storage.largestEventFileBytes > 0);
  assert.ok(idle.storage.startup.totalMs >= 0);
  assert.equal(typeof idle.storage.startup.store.eventBytes, "number");
});
