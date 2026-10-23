import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Notifier, notificationId, renderMessage } from "../../src/notify.js";
import { silentLogger } from "../../src/util/logger.js";
import type { WorkerEvent } from "../../src/types.js";

// Resolve from the compiled dist/test/unit back to the repository test directory.
const FAKE_CODEX = fileURLToPath(
  new URL("../../../test/fixtures/fake-codex-queue.mjs", import.meta.url),
);

function fakeCodexCommand(): string {
  return `"${process.execPath}" "${FAKE_CODEX}"`;
}

const worker = { id: "w-test", runtime: "pi", status: "running" as const };

test("invalid default changes are atomic and do not change the current route", async () => {
  const { notifier } = await makeNotifier();
  const before = notifier.getTarget();
  await assert.rejects(notifier.setTarget({ channel: "codex-queue" }), /requires codexThreadId/);
  assert.deepEqual(notifier.getTarget(), before);
  await notifier.setTarget({ channel: "codex-queue", codexThreadId: "thread-original" });
  const valid = notifier.getTarget();
  await assert.rejects(notifier.setTarget({ codexThreadId: "invalid thread" }), /must look/);
  assert.deepEqual(notifier.getTarget(), valid);
});

test("pending records never migrate when the global default changes", async () => {
  const { notifier } = await makeNotifier();
  const record = notifier.ingest(worker, makeEvent(1, "run.completed"))!;
  await notifier.setTarget({ channel: "codex-queue", codexThreadId: "thread-new-default" });
  assert.deepEqual(record.target, { channel: "none" });
  assert.equal(await notifier.retryPending(), 0);
  assert.equal(record.delivery.attempts, 0);
});

test("an inbox write failure prevents host invocation and is observable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-fail-"));
  const log = path.join(dir, "calls.jsonl");
  const previous = process.env.HS_FAKE_CODEX_LOG;
  process.env.HS_FAKE_CODEX_LOG = log;
  const notifier = new Notifier({ stateDir: dir, logger: silentLogger, codexBin: fakeCodexCommand() });
  await notifier.init();
  await mkdir(path.join(dir, "notifications.jsonl"));
  try {
    const record = notifier.ingest({ ...worker, notifyTarget: { channel: "codex-queue", codexThreadId: "thread-safe" } }, makeEvent(1, "run.completed"))!;
    await assert.rejects(notifier.flush());
    await assert.rejects(notifier.deliver(record.id));
    assert.equal(await readFile(log, "utf8").catch(() => ""), "");
    assert.equal(record.delivery.attempts, 0);
  } finally {
    notifier.stop();
    if (previous === undefined) delete process.env.HS_FAKE_CODEX_LOG;
    else process.env.HS_FAKE_CODEX_LOG = previous;
  }
});

test("a legacy inbox record has no inferred route after restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-legacy-inbox-"));
  const notifier = new Notifier({ stateDir: dir, logger: silentLogger });
  await notifier.init();
  const record = notifier.ingest(worker, makeEvent(1, "run.completed"))!;
  await notifier.flush();
  delete record.target;
  await writeFile(path.join(dir, "notifications.jsonl"), JSON.stringify(record) + "\n");
  const restarted = new Notifier({ stateDir: dir, logger: silentLogger, channel: "codex-queue", codexThreadId: "thread-unrelated" });
  await restarted.init();
  assert.equal(await restarted.retryPending(), 0);
  assert.deepEqual(restarted.list()[0]!.target, { channel: "none" });
});

test("a torn inbox tail does not swallow a newly persisted notification", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-torn-inbox-"));
  await writeFile(path.join(dir, "notifications.jsonl"), '{"id":"partial');
  const notifier = new Notifier({ stateDir: dir, logger: silentLogger });
  await notifier.init();
  const record = notifier.ingest(worker, makeEvent(1, "run.completed"))!;
  await notifier.flush();
  const restarted = new Notifier({ stateDir: dir, logger: silentLogger });
  await restarted.init();
  assert.equal(restarted.list()[0]!.id, record.id);
  await restarted.ack([record.id]);
  const third = new Notifier({ stateDir: dir, logger: silentLogger });
  await third.init();
  assert.equal(third.counts().unacked, 0);
});

function makeEvent(seq: number, type: string, data?: Record<string, unknown>): WorkerEvent {
  return {
    seq,
    workerId: worker.id,
    ts: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    type: type as WorkerEvent["type"],
    ...(data ? { data } : {}),
  };
}

async function makeNotifier(
  options: { channel?: "none" | "codex-queue"; threadId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ dir: string; notifier: Notifier }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  if (options.env) Object.assign(process.env, options.env);
  const notifier = new Notifier({
    stateDir: dir,
    logger: silentLogger,
    channel: options.channel ?? "none",
    codexThreadId: options.threadId,
    maxAttempts: 2,
    retryDelayMs: 1_000,
  });
  await notifier.init();
  return { dir, notifier };
}

test("records one durable notification per important event and ignores progress", async () => {
  const { notifier } = await makeNotifier();

  assert.equal(notifier.ingest(worker, makeEvent(1, "run.progress", { kind: "tool_start" })), null);
  const completed = notifier.ingest(
    worker,
    makeEvent(2, "run.completed", { text: "all done" }),
  );
  assert.ok(completed);
  assert.equal(completed.id, notificationId("w-test", 2));
  assert.equal(completed.kind, "completed");
  assert.equal(completed.summary.text, "all done");
  assert.equal(completed.delivery.state, "pending");

  // Same event twice must not create a second record.
  const again = notifier.ingest(worker, makeEvent(2, "run.completed", { text: "all done" }));
  assert.equal(again?.id, completed.id);
  assert.equal(notifier.list({ state: "all" }).length, 1);

  notifier.ingest(worker, makeEvent(3, "run.needs_input", {
    requestId: "req-1",
    method: "confirm",
    message: "Allow the tool?",
  }));
  const counts = notifier.counts();
  assert.deepEqual(counts, { pending: 2, delivered: 0, failed: 0, unacked: 2 });
  const needsInput = notifier.list().find((record) => record.kind === "needs_input");
  assert.equal(needsInput?.summary.requestId, "req-1");
  assert.equal(needsInput?.summary.method, "confirm");
});

test("notifications survive a restart and acknowledgements are idempotent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  const first = new Notifier({ stateDir: dir, logger: silentLogger });
  await first.init();
  first.ingest(worker, makeEvent(1, "run.completed", { text: "done" }));
  first.ingest(worker, makeEvent(2, "run.failed", { error: "boom" }));
  await first.flush();

  const second = new Notifier({ stateDir: dir, logger: silentLogger });
  await second.init();
  assert.equal(second.list({ state: "all" }).length, 2);
  const ids = second.list().map((record) => record.id);

  const acked = await second.ack(ids, "test");
  assert.equal(acked.acked, 2);
  const repeated = await second.ack(ids, "test");
  assert.equal(repeated.acked, 0);
  assert.deepEqual(repeated.missing, []);
  assert.equal(second.counts().unacked, 0);

  const third = new Notifier({ stateDir: dir, logger: silentLogger });
  await third.init();
  assert.equal(third.counts().unacked, 0, "acknowledgement must persist");
  assert.equal(third.list({ state: "all" }).length, 2);
});

test("unknown ids are reported instead of failing the whole acknowledgement", async () => {
  const { notifier } = await makeNotifier();
  notifier.ingest(worker, makeEvent(1, "run.completed", {}));
  const result = await notifier.ack(["missing#1", notificationId("w-test", 1)]);
  assert.equal(result.acked, 1);
  assert.deepEqual(result.missing, ["missing#1"]);
});

test("delivery renders a compact single-line message", async () => {
  const { notifier } = await makeNotifier();
  const record = notifier.ingest(
    worker,
    makeEvent(4, "run.completed", { text: "line one\nline two\twith   spaces" }),
  );
  assert.ok(record);
  const message = renderMessage(record);
  assert.ok(!message.includes("\n"));
  assert.ok(message.includes("w-test"));
  assert.ok(message.includes("completed"));
  assert.ok(message.includes("line one line two with spaces"));
});

test("codex-queue delivery runs the Codex CLI once and records success", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  const previousBin = process.env.HARNESS_SUPERVISOR_CODEX_BIN;
  const previousLog = process.env.HS_FAKE_CODEX_LOG;
  process.env.HS_FAKE_CODEX_LOG = logFile;
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  const notifier = new Notifier({
    stateDir: dir,
    logger: silentLogger,
    channel: "codex-queue",
    codexThreadId: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
    codexBin: fakeCodexCommand(),
  });
  await notifier.init();
  try {
    const record = notifier.ingest(
      worker,
      makeEvent(7, "run.completed", { text: "worker says hi" }),
    );
    assert.ok(record);
    await notifier.flush();
    // ingest dispatches asynchronously; wait for the CLI call to settle.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = notifier.list({ state: "all" })[0];
      if (current?.delivery.state === "delivered") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const delivered = notifier.list({ state: "delivered" })[0];
    assert.ok(delivered, "notification should be delivered");
    assert.equal(delivered.delivery.channel, "codex-queue");
    assert.ok(delivered.delivery.messageId?.startsWith("fake-"));
    assert.equal(delivered.delivery.lastError, undefined);

    const lines = (await readFile(logFile, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1, "exactly one CLI invocation");
    const call = JSON.parse(lines[0]!);
    assert.deepEqual(call.argv.slice(0, 4), [
      "queue",
      "--thread",
      "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
      "--message",
    ]);
    assert.ok(String(call.argv[4]).includes("worker says hi"));
  } finally {
    notifier.stop();
    if (previousBin === undefined) delete process.env.HARNESS_SUPERVISOR_CODEX_BIN;
    else process.env.HARNESS_SUPERVISOR_CODEX_BIN = previousBin;
    if (previousLog === undefined) delete process.env.HS_FAKE_CODEX_LOG;
    else process.env.HS_FAKE_CODEX_LOG = previousLog;
  }
});

test("failed delivery is retried, then marked failed without losing the record", async () => {
  const previousLog = process.env.HS_FAKE_CODEX_LOG;
  const previousFail = process.env.HS_FAKE_CODEX_FAIL;
  process.env.HS_FAKE_CODEX_FAIL = "1";
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  const notifier = new Notifier({
    stateDir: dir,
    logger: silentLogger,
    channel: "codex-queue",
    codexThreadId: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
    codexBin: fakeCodexCommand(),
    maxAttempts: 2,
    retryDelayMs: 10,
  });
  await notifier.init();
  try {
    const record = notifier.ingest(worker, makeEvent(8, "run.failed", { error: "boom" }));
    assert.ok(record);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const current = notifier.list({ state: "all" })[0];
      if (current?.delivery.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = notifier.list({ state: "failed" })[0];
    assert.ok(failed, "delivery should end in failed state");
    assert.equal(failed.delivery.attempts, 2);
    assert.match(failed.delivery.lastError ?? "", /simulated failure|exited with code 3/);
    // The notification itself is never dropped.
    assert.equal(notifier.list({ state: "all" }).length, 1);
  } finally {
    notifier.stop();
    if (previousLog === undefined) delete process.env.HS_FAKE_CODEX_LOG;
    else process.env.HS_FAKE_CODEX_LOG = previousLog;
    if (previousFail === undefined) delete process.env.HS_FAKE_CODEX_FAIL;
    else process.env.HS_FAKE_CODEX_FAIL = previousFail;
  }
});

test("codex-queue target requires a thread id and validates it", async () => {
  const { notifier } = await makeNotifier();
  await assert.rejects(
    () => notifier.setTarget({ channel: "codex-queue" }),
    /requires codexThreadId/,
  );
  await assert.rejects(
    () => notifier.setTarget({ codexThreadId: "bad id with spaces" }),
    /must look like a Codex thread/,
  );
  const target = await notifier.setTarget({
    channel: "codex-queue",
    codexThreadId: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
  });
  assert.equal(target.channel, "codex-queue");
  assert.equal(target.codexThreadId, "01a1623d-d0a4-7493-b44d-5d1143efb6fe");

  const reloaded = new Notifier({ stateDir: notifier.stateDir, logger: silentLogger });
  await reloaded.init();
  assert.equal(reloaded.getTarget().channel, "codex-queue");
  assert.equal(reloaded.getTarget().codexThreadId, "01a1623d-d0a4-7493-b44d-5d1143efb6fe");
  await reloaded.setTarget({ codexThreadId: null, channel: "none" });
  assert.equal(reloaded.getTarget().codexThreadId, undefined);
});
test("compaction drops old acknowledged records but never unacknowledged ones", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  const notifier = new Notifier({ stateDir: dir, logger: silentLogger });
  await notifier.init();
  const old = notifier.ingest(worker, makeEvent(10, "run.completed", { text: "old acked" }));
  const keptUnacked = notifier.ingest(worker, makeEvent(11, "run.failed", { error: "unacked" }));
  assert.ok(old && keptUnacked);
  await notifier.flush();
  await notifier.ack([old.id]);
  // Backdate the acknowledgement so it falls outside the retention window.
  const raw = await readFile(path.join(dir, "notifications.jsonl"), "utf8");
  const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
  const patched = lines.map((record) =>
    record.id === old.id
      ? JSON.stringify({ ...record, ackAt: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString() })
      : JSON.stringify(record),
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "notifications.jsonl"), `${patched.join("\n")}\n`, "utf8");

  const reloaded = new Notifier({ stateDir: dir, logger: silentLogger });
  await reloaded.init();
  const result = await reloaded.compact({ olderThanDays: 30 });
  assert.equal(result.dropped, 1);
  assert.equal(reloaded.list({ state: "all" }).length, 1);
  assert.equal(reloaded.list({ state: "all" })[0]!.id, keptUnacked.id);

  const third = new Notifier({ stateDir: dir, logger: silentLogger });
  await third.init();
  assert.equal(third.list({ state: "all" }).length, 1, "compaction must be durable");
});

test("acknowledged records leave the default inbox and are never re-delivered", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  const previousLog = process.env.HS_FAKE_CODEX_LOG;
  process.env.HS_FAKE_CODEX_LOG = logFile;
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  const notifier = new Notifier({
    stateDir: dir,
    logger: silentLogger,
    codexBin: fakeCodexCommand(),
  });
  await notifier.init();
  try {
    const acked = notifier.ingest(worker, makeEvent(20, "run.completed", { text: "already handled" }));
    assert.ok(acked);
    await notifier.ack([acked.id], "test");
    assert.equal(notifier.list().length, 0, "default inbox must not return acknowledged records");
    assert.equal(notifier.counts().pending, 0);
    assert.equal(notifier.list({ state: "all" }).length, 1, "diagnostics can still see it");

    // Switching the delivery channel must not resurrect the acknowledged record.
    await notifier.setTarget({
      channel: "codex-queue",
      codexThreadId: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
    });
    await notifier.retryPending(["pending"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const calls = await readFile(logFile, "utf8").catch(() => "");
    assert.equal(calls.trim(), "", "acknowledged notification must never be sent");
    assert.equal(notifier.list({ state: "all" })[0]!.delivery.state, "pending");

    // A new, unacknowledged record is still delivered by the same channel.
    notifier.ingest(worker, makeEvent(21, "run.failed", { error: "new failure" }));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (notifier.list({ state: "delivered" }).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(notifier.list({ state: "delivered" }).length, 1);
    assert.equal((await readFile(logFile, "utf8")).trim().split("\n").length, 1);
  } finally {
    notifier.stop();
    if (previousLog === undefined) delete process.env.HS_FAKE_CODEX_LOG;
    else process.env.HS_FAKE_CODEX_LOG = previousLog;
  }
});

test("an explicitly retried failed delivery gets a fresh attempt budget", async () => {
  const previousFail = process.env.HS_FAKE_CODEX_FAIL;
  process.env.HS_FAKE_CODEX_FAIL = "1";
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  const notifier = new Notifier({
    stateDir: dir,
    logger: silentLogger,
    channel: "codex-queue",
    codexThreadId: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
    codexBin: fakeCodexCommand(),
    maxAttempts: 1,
    retryDelayMs: 10,
  });
  await notifier.init();
  try {
    notifier.ingest(worker, makeEvent(30, "run.completed", { text: "retry me" }));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (notifier.list({ state: "failed" }).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(notifier.list({ state: "failed" }).length, 1);
    assert.equal(notifier.list({ state: "failed" })[0]!.delivery.attempts, 1);

    // Automatic retries must not hammer a failed record.
    assert.equal(await notifier.retryPending(["pending"]), 0);

    process.env.HS_FAKE_CODEX_FAIL = "0";
    const retried = await notifier.retryPending(["failed"]);
    assert.equal(retried, 1, "explicit failed retry must re-attempt");
    const delivered = notifier.list({ state: "delivered" })[0];
    assert.ok(delivered, "the notification should now be delivered");
    assert.equal(delivered.delivery.attempts, 1, "attempt budget restarts on manual retry");
    assert.equal(delivered.delivery.lastError, undefined);
  } finally {
    notifier.stop();
    if (previousFail === undefined) delete process.env.HS_FAKE_CODEX_FAIL;
    else process.env.HS_FAKE_CODEX_FAIL = previousFail;
  }
});

test("a retry requested while an attempt is in flight still performs a real attempt", async () => {
  const previousSleep = process.env.HS_FAKE_CODEX_SLEEP_MS;
  // Slow host call so the concurrent-request window is deterministic, not timing luck.
  process.env.HS_FAKE_CODEX_SLEEP_MS = "300";
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  const notifier = new Notifier({
    stateDir: dir,
    logger: silentLogger,
    channel: "codex-queue",
    codexThreadId: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
    codexBin: fakeCodexCommand(),
    maxAttempts: 3,
    retryDelayMs: 10,
  });
  await notifier.init();
  try {
    notifier.ingest(worker, makeEvent(40, "run.completed", { text: "slow" }));
    // ingest() starts the first attempt synchronously; this retry must not be
    // silently dropped just because that attempt is still running.
    assert.equal(await notifier.retryPending(["pending"]), 1);
    const delivered = notifier.list({ state: "delivered" })[0];
    assert.ok(delivered, "the explicit retry must end in a delivered record");
    assert.equal(delivered.delivery.attempts, 1);
  } finally {
    notifier.stop();
    if (previousSleep === undefined) delete process.env.HS_FAKE_CODEX_SLEEP_MS;
    else process.env.HS_FAKE_CODEX_SLEEP_MS = previousSleep;
  }
});
