import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Notifier,
  notificationId,
  renderMessage,
  staleNotificationReason,
  type NotifyFreshnessSubject,
} from "../../src/notify.js";
import { silentLogger } from "../../src/util/logger.js";
import type { NotificationRecord, WorkerEvent, WorkerStatus } from "../../src/types.js";

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
  options: {
    channel?: "none" | "codex-queue";
    threadId?: string;
    env?: NodeJS.ProcessEnv;
    deliveryDelayMs?: number;
    staleReason?: (record: NotificationRecord) => string | undefined;
  } = {},
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
    deliveryDelayMs: options.deliveryDelayMs,
    staleReason: options.staleReason,
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
  assert.deepEqual(counts, { pending: 2, delivered: 0, failed: 0, superseded: 0, unacked: 2 });
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

test("delivery renders a short pointer, never the event payload", async () => {
  const { notifier } = await makeNotifier();
  const record = notifier.ingest(
    worker,
    makeEvent(4, "run.completed", { text: "line one\nline two\twith   spaces" }),
  );
  assert.ok(record);
  const message = renderMessage(record);
  assert.equal(message, `[harness-supervisor] ${worker.id} completed seq=${record.seq} | read worker_status for result`);
  assert.ok(!message.includes("\n"));
  // The summary stays in the structured inbox; it must not be re-injected.
  assert.ok(!message.includes("line one"));
});

test("a needs_input pointer tells the agent to read the current pendingInput", async () => {
  const { notifier } = await makeNotifier();
  const record = notifier.ingest(
    worker,
    makeEvent(5, "run.needs_input", { requestId: "req-old", method: "confirm", message: "ok?" }),
  );
  assert.ok(record);
  const message = renderMessage(record);
  assert.equal(
    message,
    `[harness-supervisor] ${worker.id} needs_input seq=${record.seq} | read worker_status; answer current pendingInput`,
  );
  assert.ok(!message.includes("req-old"), "the old requestId must not invite a stale answer");
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
    assert.ok(String(call.argv[4]).includes(worker.id));
    assert.ok(String(call.argv[4]).includes("completed"));
    assert.ok(!String(call.argv[4]).includes("worker says hi"), "the payload stays in the inbox");
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

/* ------------------------------------------------------------------------- *
 * Delivery gate (noise control)
 * ------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("condition was not met in time");
}

function codexNotifier(
  dir: string,
  options: {
    deliveryDelayMs?: number;
    staleReason?: (record: NotificationRecord) => string | undefined;
    maxAttempts?: number;
    retryDelayMs?: number;
  } = {},
): Notifier {
  return new Notifier({
    stateDir: dir,
    logger: silentLogger,
    channel: "codex-queue",
    codexThreadId: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
    codexBin: fakeCodexCommand(),
    deliveryDelayMs: options.deliveryDelayMs ?? 0,
    staleReason: options.staleReason,
    maxAttempts: options.maxAttempts ?? 2,
    retryDelayMs: options.retryDelayMs ?? 100,
  });
}

async function withCodexLog<T>(logFile: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HS_FAKE_CODEX_LOG;
  process.env.HS_FAKE_CODEX_LOG = logFile;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HS_FAKE_CODEX_LOG;
    else process.env.HS_FAKE_CODEX_LOG = previous;
  }
}

async function readCalls(logFile: string): Promise<Array<{ argv: string[] }>> {
  const raw = await readFile(logFile, "utf8").catch(() => "");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[] });
}

test("freshness gate: needs_input must match the live pending request, not the payload", async () => {
  const { notifier } = await makeNotifier();
  const record = notifier.ingest(
    worker,
    makeEvent(10, "run.needs_input", { requestId: "req-1", method: "confirm" }),
  )!;
  const at = record.createdAt;
  const subject = (
    pendingInput: NotifyFreshnessSubject["pendingInput"],
    status: WorkerStatus = "awaiting_input",
    lastRunStartSeq?: number,
  ): NotifyFreshnessSubject => ({
    status,
    pendingInput,
    ...(lastRunStartSeq !== undefined ? { lastRunStartSeq: () => lastRunStartSeq } : {}),
  });

  assert.match(staleNotificationReason(undefined, record) ?? "", /no longer exists/);
  // Answered / withdrawn / run ended: nothing pending any more.
  assert.match(staleNotificationReason({ status: "running" }, record) ?? "", /no longer pending/);
  // The request this notification is about is still the current one.
  assert.equal(
    staleNotificationReason(subject({ requestId: "req-1", seq: 10, createdAt: at }), record),
    undefined,
  );
  // Same id, newer event: a harness reused the id after a resume.
  assert.match(
    staleNotificationReason(subject({ requestId: "req-1", seq: 44, createdAt: at }), record) ?? "",
    /newer request/,
  );
  // A different request replaced it.
  assert.match(
    staleNotificationReason(subject({ requestId: "req-2", seq: 11, createdAt: at }), record) ?? "",
    /no longer pending/,
  );
  // Already expired before delivery.
  assert.match(
    staleNotificationReason(
      subject({
        requestId: "req-1",
        seq: 10,
        createdAt: at,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      record,
    ) ?? "",
    /expired/,
  );
  // Terminal worker: no answer can be accepted.
  assert.match(
    staleNotificationReason(
      subject({ requestId: "req-1", seq: 10, createdAt: at }, "completed"),
      record,
    ) ?? "",
    /cannot be answered/,
  );
  // A cancellation in progress wins even though the request still looks pending:
  // the record is only rewritten after the drain, while answer() already refuses.
  assert.match(
    staleNotificationReason(
      {
        status: "awaiting_input",
        cancelRequested: true,
        pendingInput: { requestId: "req-1", seq: 10, createdAt: at },
      },
      record,
    ) ?? "",
    /cancellation is in progress/,
  );
  // No flag, no suppression: the same pending request stays deliverable.
  assert.equal(
    staleNotificationReason(
      {
        status: "awaiting_input",
        cancelRequested: false,
        pendingInput: { requestId: "req-1", seq: 10, createdAt: at },
      },
      record,
    ),
    undefined,
  );
  // Legacy pending input without an event seq: same request stays deliverable...
  assert.equal(staleNotificationReason(subject({ requestId: "req-1", createdAt: at }), record), undefined);
  // ...but one created far from the event is a different request.
  assert.match(
    staleNotificationReason(
      subject({ requestId: "req-1", createdAt: new Date(Date.parse(at) + 60_000).toISOString() }),
      record,
    ) ?? "",
    /different request/,
  );
});

test("only cancellations are suppressed by a later run, and never a new turn's own cancel", async () => {
  const { notifier } = await makeNotifier();
  const cancelled = notifier.ingest(worker, makeEvent(20, "run.cancelled", { reason: "maintenance" }))!;

  // Cancelled and left alone: still worth reporting.
  assert.equal(staleNotificationReason({ status: "cancelled" }, cancelled), undefined);
  // A later run-start event proves this cancellation belongs to the previous run,
  // even when the resumed run already finished again.
  const resumedStart = 25;
  assert.match(
    staleNotificationReason({ status: "running", lastRunStartSeq: () => resumedStart }, cancelled) ?? "",
    /new run started/,
  );
  assert.match(
    staleNotificationReason({ status: "completed", lastRunStartSeq: () => resumedStart }, cancelled) ?? "",
    /new run started/,
    "a fast resume that already completed must still suppress the old cancel",
  );
  assert.match(
    staleNotificationReason(
      { status: "starting", lastRunStartSeq: () => resumedStart },
      cancelled,
    ) ?? "",
    /new run started/,
  );
  // A new turn's own cancel happens *after* the run start, so it stays deliverable.
  const cancelledAgain = notifier.ingest(
    worker,
    makeEvent(26, "run.cancelled", { reason: "new turn cancelled" }),
  )!;
  assert.equal(
    staleNotificationReason(
      { status: "cancelled", lastRunStartSeq: () => resumedStart },
      cancelledAgain,
    ),
    undefined,
    "the resumed run's own cancellation must never be swallowed",
  );
  // startedAt later than the event is equivalent evidence.
  assert.match(
    staleNotificationReason(
      { status: "failed", startedAt: new Date(Date.parse(cancelled.createdAt) + 5_000).toISOString() },
      cancelled,
    ) ?? "",
    /resumed/,
  );
  // Failures and completions are never suppressed because the worker resumed.
  const failed = notifier.ingest(worker, makeEvent(21, "run.failed", { error: "boom" }))!;
  const completed = notifier.ingest(worker, makeEvent(22, "run.completed", { text: "ok" }))!;
  for (const record of [failed, completed]) {
    assert.equal(
      staleNotificationReason(
        { status: "running", lastRunStartSeq: () => resumedStart, startedAt: new Date().toISOString() },
        record,
      ),
      undefined,
    );
  }
});

test("a record that stopped being current is superseded, never reported as delivered", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  await withCodexLog(logFile, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
    const notifier = codexNotifier(dir, {
      staleReason: (record) =>
        record.kind === "needs_input" ? "request answered before delivery" : undefined,
    });
    await notifier.init();
    try {
      const record = notifier.ingest(
        worker,
        makeEvent(30, "run.needs_input", { requestId: "req-x", method: "confirm" }),
      )!;
      await waitFor(() => record.delivery.state !== "pending");
      assert.equal(record.delivery.state, "superseded");
      assert.equal(record.delivery.attempts, 0, "the host must not be called at all");
      assert.match(record.delivery.supersededReason ?? "", /answered/);
      assert.ok(record.delivery.supersededAt);
      assert.equal(record.ackAt, undefined, "superseding is not an acknowledgement");
      assert.deepEqual(await readCalls(logFile), []);
      assert.deepEqual(notifier.counts(), {
        pending: 0,
        delivered: 0,
        failed: 0,
        superseded: 1,
        unacked: 0,
      });
      assert.equal(notifier.list().length, 0, "the actionable inbox must not show it");
      assert.equal(notifier.list({ state: "all" }).length, 1, "but the evidence stays readable");
      assert.equal(await notifier.retryPending(["pending"]), 0);
      assert.equal(await notifier.retryPending(["superseded"]), 0, "superseded is never retried");
      assert.deepEqual(await readCalls(logFile), []);

// The decision is durable: a restarted daemon does not redeliver it either.
      await notifier.flush();
      notifier.stop();
      const restarted = codexNotifier(dir);
      await restarted.init();
      assert.equal(restarted.list({ state: "all" })[0]!.delivery.state, "superseded");
      assert.equal(await restarted.retryPending(["pending"]), 0);
      assert.deepEqual(await readCalls(logFile), []);
      restarted.stop();
    } finally {
      notifier.stop();
    }
  });
});

test("a delivered record is never rewritten as superseded", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  await withCodexLog(logFile, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
    let stale = false;
    const notifier = codexNotifier(dir, { staleReason: () => (stale ? "became stale" : undefined) });
    await notifier.init();
    try {
      const record = notifier.ingest(worker, makeEvent(31, "run.completed", { text: "done" }))!;
      await waitFor(() => record.delivery.state === "delivered");
      // The event that would make it stale happens after the host already got it.
      stale = true;
      await notifier.deliver(record.id);
      assert.equal(record.delivery.state, "delivered", "the host cannot be un-told");
      assert.equal(record.delivery.supersededReason, undefined);
      assert.equal(notifier.list({ state: "delivered" }).length, 1);
      // Reading the actionable inbox must not rewrite delivered history either.
      notifier.list();
      notifier.list({ unacknowledgedOnly: true });
      assert.equal(notifier.list({ state: "all" })[0]!.delivery.state, "delivered");
    } finally {
      notifier.stop();
    }
  });
});

test("inbox-only records are re-checked on read so answered requests leave the default inbox", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
  const notifier = new Notifier({ stateDir: dir, logger: silentLogger });
  await notifier.init();
  const needsInput = notifier.ingest(
    worker,
    makeEvent(40, "run.needs_input", { requestId: "req-1", method: "confirm" }),
  )!;
  // Inbox-only delivery never passes through deliver(), so the actionable view
  // itself has to apply the freshness check.
  assert.deepEqual(notifier.list().map((record) => record.id), [needsInput.id]);
  await notifier.flush();
  notifier.stop();

  // Now the supervisor would report the request as answered.
  const gated = new Notifier({
    stateDir: dir,
    logger: silentLogger,
    staleReason: (record) =>
      record.kind === "needs_input" ? "the input request is no longer pending" : undefined,
  });
  await gated.init();
  assert.deepEqual(gated.list(), [], "an answered request must not stay actionable");
  const all = gated.list({ state: "all" });
  assert.equal(all.length, 1);
  assert.equal(all[0]!.delivery.state, "superseded");
  assert.equal(all[0]!.ackAt, undefined, "nothing is acknowledged on the consumer's behalf");
  assert.deepEqual(gated.counts(), {
    pending: 0,
    delivered: 0,
    failed: 0,
    superseded: 1,
    unacked: 0,
  });
  gated.stop();
});

test("the delivery gate is per worker: one stale record never blocks another worker", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  await withCodexLog(logFile, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
    const notifier = codexNotifier(dir, {
      staleReason: (record) => (record.workerId === "w-stale" ? "worker is gone" : undefined),
    });
    await notifier.init();
    try {
      const stale = notifier.ingest(
        { ...worker, id: "w-stale" },
        makeEvent(1, "run.completed", { text: "stale" }),
      )!;
      const fresh = notifier.ingest(
        { ...worker, id: "w-fresh" },
        makeEvent(1, "run.completed", { text: "fresh" }),
      )!;
      await waitFor(
        () => stale.delivery.state === "superseded" && fresh.delivery.state === "delivered",
      );
      const calls = await readCalls(logFile);
      assert.equal(calls.length, 1, "only the fresh worker reaches the host");
      assert.ok(calls[0]!.argv[4]!.includes("w-fresh"));
      assert.ok(!calls[0]!.argv[4]!.includes("w-stale"));
    } finally {
      notifier.stop();
    }
  });
});

test("an unacknowledged delivered reminder never suppresses the next needs_input", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  await withCodexLog(logFile, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
    const notifier = codexNotifier(dir, { staleReason: () => undefined });
    await notifier.init();
    try {
      const first = notifier.ingest(
        worker,
        makeEvent(50, "run.needs_input", { requestId: "req-1", method: "confirm" }),
      )!;
      await waitFor(() => first.delivery.state === "delivered");
      // Delivered but deliberately not acknowledged: the consumer has not seen it.
      assert.equal(first.ackAt, undefined);
      const second = notifier.ingest(
        worker,
        makeEvent(51, "run.needs_input", { requestId: "req-2", method: "confirm" }),
      )!;
      await waitFor(() => second.delivery.state === "delivered");
      assert.equal(second.delivery.state, "delivered", "a new request must never be swallowed");
      assert.equal((await readCalls(logFile)).length, 2);
      assert.equal(notifier.counts().unacked, 2);
    } finally {
      notifier.stop();
    }
  });
});

test("a burst never starves the delivery window opened by the first record", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  await withCodexLog(logFile, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
    const notifier = codexNotifier(dir, { deliveryDelayMs: 150 });
    await notifier.init();
    try {
      const first = notifier.ingest(worker, makeEvent(60, "run.completed", { text: "first" }))!;
      let firstAttemptStartedDuringBurst = false;
      for (let index = 1; index < 12; index += 1) {
        await sleep(40);
        notifier.ingest(worker, makeEvent(60 + index, "run.completed", { text: `burst ${index}` }));
        // The host process can start slowly on a busy machine; the attempt
        // timestamp proves the window opened without depending on spawn time.
        if (first.delivery.lastAttemptStartedAt) firstAttemptStartedDuringBurst = true;
      }
      assert.ok(
        firstAttemptStartedDuringBurst,
        "later events must not postpone the first record's window (no timer reset)",
      );
      await waitFor(() => notifier.list({ state: "delivered" }).length === 12, 20_000);
      const calls = await readCalls(logFile);
      assert.equal(calls.length, 12);
      assert.match(calls[0]!.argv[4]!, /seq=60(?!\d)/, "delivery stays in event order");
    } finally {
      notifier.stop();
    }
  });
});
test("reading the inbox during an in-flight host call never rewrites it as superseded", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  const previousSleep = process.env.HS_FAKE_CODEX_SLEEP_MS;
  // A slow fake host makes the in-flight window deterministic.
  process.env.HS_FAKE_CODEX_SLEEP_MS = "600";
  await withCodexLog(logFile, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
    let stale = false;
    const notifier = codexNotifier(dir, {
      staleReason: () => (stale ? "became stale while the host call ran" : undefined),
    });
    await notifier.init();
    try {
      const record = notifier.ingest(
        worker,
        makeEvent(70, "run.needs_input", { requestId: "req-1", method: "confirm" }),
      )!;
      // Wait until the host invocation has actually started.
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if ((await readFile(logFile, "utf8").catch(() => "")).length > 0) break;
        await sleep(10);
      }
      assert.ok((await readFile(logFile, "utf8")).length > 0, "the host call must have started");
      assert.equal(record.delivery.state, "pending");
      // The request dies while the CLI is still deciding: the message may already
      // be accepted, so the record must not be rewritten as "not delivered".
      stale = true;
      notifier.list();
      notifier.list({ unacknowledgedOnly: true });
      assert.equal(record.delivery.state, "pending", "an in-flight delivery is not stale");
      assert.equal(record.delivery.supersededReason, undefined);
      await waitFor(() => record.delivery.state === "delivered");
      assert.equal(record.delivery.state, "delivered");
      assert.equal(record.delivery.supersededReason, undefined);
      assert.equal((await readCalls(logFile)).length, 1);
    } finally {
      notifier.stop();
    }
  });
  if (previousSleep === undefined) delete process.env.HS_FAKE_CODEX_SLEEP_MS;
  else process.env.HS_FAKE_CODEX_SLEEP_MS = previousSleep;
});

test("a failed delivery of a request that is no longer current stops being actionable", async () => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-log-"));
  const logFile = path.join(logDir, "calls.jsonl");
  const previousFail = process.env.HS_FAKE_CODEX_FAIL;
  process.env.HS_FAKE_CODEX_FAIL = "1";
  await withCodexLog(logFile, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-notify-"));
    let stale = false;
    const notifier = codexNotifier(dir, {
      maxAttempts: 1,
      staleReason: () => (stale ? "the input request is no longer pending" : undefined),
    });
    await notifier.init();
    try {
      const record = notifier.ingest(
        worker,
        makeEvent(71, "run.needs_input", { requestId: "req-1", method: "confirm" }),
      )!;
      await waitFor(() => record.delivery.state === "failed");
      assert.equal(record.delivery.attempts, 1);
      assert.ok(record.delivery.lastError);
      // The request is answered after the failed attempt: retrying is pointless.
      stale = true;
      assert.deepEqual(notifier.list(), [], "not actionable any more");
      assert.deepEqual(notifier.list({ unacknowledgedOnly: true }), []);
      const all = notifier.list({ state: "all" })[0]!;
      assert.equal(all.delivery.state, "superseded");
      assert.match(all.delivery.supersededReason ?? "", /failed .*no longer current/);
      assert.equal(all.delivery.attempts, 1, "the failure history is preserved");
      assert.ok(all.delivery.lastError, "the delivery error is preserved");
      assert.equal(all.ackAt, undefined, "still nothing is acknowledged");
      assert.deepEqual(notifier.counts(), {
        pending: 0,
        delivered: 0,
        failed: 0,
        superseded: 1,
        unacked: 0,
      });
      assert.equal(await notifier.retryPending(["failed"]), 0, "a dead request is not retried");
    } finally {
      notifier.stop();
    }
  });
  if (previousFail === undefined) delete process.env.HS_FAKE_CODEX_FAIL;
  else process.env.HS_FAKE_CODEX_FAIL = previousFail;
});