import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupervisorClient } from "../../src/ipc/client.js";
import type { NotificationsResult } from "../../src/types.js";
import {
  TestDaemon,
  connectExisting,
  makeWorkspace,
  spawnWorker,
  waitForStatus,
  waitTerminal,
} from "./helpers.js";

const FAKE_CODEX = fileURLToPath(
  new URL("../../../test/fixtures/fake-codex-queue.mjs", import.meta.url),
);

function inbox(
  client: SupervisorClient,
  params: Record<string, unknown> = {},
): Promise<NotificationsResult> {
  return client.request<NotificationsResult>("notifications", {
    state: "all",
    limit: 200,
    ...params,
  });
}

test("a completed worker produces exactly one inbox record and progress never does", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "plain task");
  await waitTerminal(client, worker.id, 20_000);

  const result = await inbox(client);
  const mine = result.notifications.filter((item) => item.workerId === worker.id);
  assert.equal(mine.length, 1, "one important event -> one notification");
  assert.equal(mine[0]!.kind, "completed");
  assert.equal(mine[0]!.id, `${worker.id}#${mine[0]!.seq}`);
  assert.equal(mine[0]!.eventType, "run.completed");
  assert.equal(mine[0]!.delivery.state, "pending");
  assert.ok(mine[0]!.summary.text && mine[0]!.summary.text.includes("FAKE_PI_OK"));
  assert.equal(
    result.notifications.some((item) => item.eventType === "run.progress"),
    false,
    "progress must never create a notification",
  );
});

test("failed runs and input requests are recorded with actionable summaries", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const failing = await spawnWorker(client, cwd, "[scenario:error] fail please");
  await waitTerminal(client, failing.id, 20_000);
  const afterFailure = await inbox(client);
  const failedRecord = afterFailure.notifications.find((item) => item.workerId === failing.id);
  assert.ok(failedRecord, "failed run must be recorded");
  assert.equal(failedRecord.kind, "failed");
  assert.ok(failedRecord.summary.text, "failure summary must carry the error text");

  const asking = await spawnWorker(client, cwd, "[scenario:ask] needs approval");
  const waiting = await waitForStatus(client, asking.id, ["awaiting_input"], 15_000);
  assert.ok(waiting.pendingInput);
  const afterAsk = await inbox(client);
  const askRecord = afterAsk.notifications.find((item) => item.workerId === asking.id);
  assert.ok(askRecord, "input request must be recorded");
  assert.equal(askRecord.kind, "needs_input");
  assert.equal(askRecord.summary.requestId, waiting.pendingInput!.requestId);
  assert.equal(askRecord.summary.method, "confirm");

  await client.request("answer", {
    workerId: asking.id,
    requestId: waiting.pendingInput!.requestId,
    response: { confirmed: true },
  });
  await waitTerminal(client, asking.id, 20_000);
  const afterAnswer = await inbox(client);
  const kinds = afterAnswer.notifications
    .filter((item) => item.workerId === asking.id)
    .map((item) => item.kind);
  assert.deepEqual(kinds, ["needs_input", "completed"]);
});

test("two workers finishing produce two independent records", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const [first, second] = await Promise.all([
    spawnWorker(client, cwd, "task one"),
    spawnWorker(client, cwd, "task two"),
  ]);
  await Promise.all([
    waitTerminal(client, first.id, 20_000),
    waitTerminal(client, second.id, 20_000),
  ]);
  const result = await inbox(client);
  const ids = new Set(result.notifications.map((item) => item.id));
  assert.equal(ids.size, result.notifications.length, "ids must be unique");
  assert.ok(result.notifications.some((item) => item.workerId === first.id));
  assert.ok(result.notifications.some((item) => item.workerId === second.id));
  assert.equal(result.counts.unacked, result.notifications.length);
});

test("an offline consumer reconnects without losing or duplicating records", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "survive a consumer disconnect");
  await waitTerminal(client, worker.id, 20_000);

  client.close();
  // While no client is connected, the daemon keeps working and keeps records.
  const other = await spawnWorker(client, cwd, "second task").catch(() => null);
  if (other) await waitTerminal(client, other.id, 20_000).catch(() => undefined);

  const reconnected = await connectExisting(daemon.stateDir);
  try {
    const pending = await inbox(reconnected, { state: "pending" });
    const ids = pending.notifications.map((item) => item.id);
    assert.ok(ids.includes(`${worker.id}#${pending.notifications.find((i) => i.workerId === worker.id)!.seq}`));
    const acked = await reconnected.request<{ acked: number; missing: string[] }>(
      "notification_ack",
      { ids, by: "test" },
    );
    assert.equal(acked.acked, ids.length);
    const repeated = await reconnected.request<{ acked: number }>("notification_ack", { ids });
    assert.equal(repeated.acked, 0, "acknowledging twice must be a no-op");
  } finally {
    reconnected.close();
  }

  const third = await connectExisting(daemon.stateDir);
  try {
    const after = await inbox(third, { state: "all" });
    assert.equal(after.counts.unacked, 0, "acknowledgement must be durable");
    assert.ok(after.notifications.length >= 1, "records stay readable for diagnostics");
    assert.equal(
      after.counts.pending,
      0,
      "acknowledged records must not come back as pending work",
    );
    assert.equal((await inbox(third, { state: "pending" })).notifications.length, 0);
  } finally {
    third.close();
  }
});

test("a daemon restart keeps records stable and adds no duplicates", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  let restarted: TestDaemon | null = null;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "restart me");
  await waitTerminal(client, worker.id, 20_000);
  const before = await inbox(client);
  const beforeIds = before.notifications.map((item) => item.id).sort();

  await daemon.stop();
  restarted = new TestDaemon(daemon.stateDir);
  const client2 = await restarted.start();
  const after = await inbox(client2);
  const afterIds = after.notifications.map((item) => item.id).sort();
  assert.deepEqual(afterIds, beforeIds, "restart must not duplicate or drop records");
});

test("workers lost in a daemon crash are recorded as detached", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let restarted: TestDaemon | null = null;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "15000" } });
  const worker = await spawnWorker(client, cwd, "[scenario:slow] interrupted work");
  await client.request("wait", {
    workerId: worker.id,
    sinceSeq: 0,
    timeoutMs: 5000,
    until: "event",
    types: ["run.started"],
  });

  await daemon.kill();
  restarted = new TestDaemon(daemon.stateDir);
  const client2 = await restarted.start();
  const result = await inbox(client2);
  const record = result.notifications.find((item) => item.workerId === worker.id);
  assert.ok(record, "an interrupted worker must produce a notification");
  assert.equal(record.kind, "detached");
  assert.equal(record.eventType, "worker.interrupted");
  // Crash recovery must never invent a successful completion.
  assert.equal(
    result.notifications.some(
      (item) => item.workerId === worker.id && item.kind === "completed",
    ),
    false,
  );
});

test("codex-queue delivery calls the Codex CLI once per important event", async (t) => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-calls-"));
  const logFile = path.join(logDir, "calls.jsonl");
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_NOTIFY_CHANNEL: "codex-queue",
      HARNESS_SUPERVISOR_CODEX_WAKE_THREAD: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
      HARNESS_SUPERVISOR_CODEX_BIN: `"${process.execPath}" "${FAKE_CODEX}"`,
      HS_FAKE_CODEX_LOG: logFile,
      HARNESS_SUPERVISOR_NOTIFY_RETRY_MS: "200",
    },
  });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const info = await client.request<{ wake: { proactive: boolean; channel: string; codexThreadId?: string } }>(
    "info",
    {},
  );
  assert.equal(info.wake.proactive, true);
  assert.equal(info.wake.channel, "codex-queue");
  assert.equal(info.wake.codexThreadId, "01a1623d-d0a4-7493-b44d-5d1143efb6fe");

  const worker = await spawnWorker(client, cwd, "deliver me");
  await waitTerminal(client, worker.id, 20_000);

  let delivered = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await inbox(client, { state: "delivered" });
    if (result.notifications.some((item) => item.workerId === worker.id)) {
      delivered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(delivered, "notification should be delivered to the Codex queue");

  const lines = (await readFile(logFile, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1, "exactly one CLI call for one event");
  const call = JSON.parse(lines[0]!) as { argv: string[] };
  assert.equal(call.argv[0], "queue");
  assert.equal(call.argv[2], "01a1623d-d0a4-7493-b44d-5d1143efb6fe");
  assert.ok(call.argv[4]!.includes(worker.id));
  assert.ok(!call.argv[4]!.includes("\n"));
});
test("a burst of progress events creates no notifications and stays queryable", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const worker = await spawnWorker(client, cwd, "[scenario:busy] 150 progress events");
  await waitTerminal(client, worker.id, 30_000);

  const events = await client.request<{ events: Array<{ type: string }>; nextSeq: number }>(
    "events",
    { workerId: worker.id, sinceSeq: 0, limit: 500 },
  );
  const progress = events.events.filter((event) => event.type === "run.progress");
  assert.ok(progress.length >= 150, `expected many progress events, got ${progress.length}`);

  const burstInbox = await inbox(client, { workerId: worker.id });
  assert.equal(burstInbox.notifications.length, 1, "only the terminal event may create a notification");
  assert.equal(burstInbox.notifications[0]!.kind, "completed");
  assert.equal(burstInbox.counts.pending, 1);
});

test("a worker with a lost notification file is repaired from persisted events", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let restarted: TestDaemon | null = null;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "notification written then lost");
  await waitTerminal(client, worker.id, 20_000);
  const before = await inbox(client, { workerId: worker.id });
  assert.equal(before.notifications.length, 1);
  const expectedId = before.notifications[0]!.id;

  await daemon.stop();
  // Simulate a crash between the event write and the notification write.
  const { rm } = await import("node:fs/promises");
  await rm(path.join(daemon.stateDir, "notifications.jsonl"), { force: true });

  restarted = new TestDaemon(daemon.stateDir);
  const client2 = await restarted.start();
  const after = await inbox(client2, { workerId: worker.id });
  assert.equal(after.notifications.length, 1, "the notification is rebuilt from the event log");
  assert.equal(after.notifications[0]!.id, expectedId, "the rebuilt record keeps the stable id");
  assert.equal(after.notifications[0]!.kind, "completed");
});

test("a daemon killed mid-delivery re-delivers after restart with one inbox record", async (t) => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-calls-"));
  const logFile = path.join(logDir, "calls.jsonl");
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  let restarted: TestDaemon | null = null;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });
  const env = {
    HARNESS_SUPERVISOR_NOTIFY_CHANNEL: "codex-queue",
    HARNESS_SUPERVISOR_CODEX_WAKE_THREAD: "01a1623d-d0a4-7493-b44d-5d1143efb6fe",
    HARNESS_SUPERVISOR_CODEX_BIN: `"${process.execPath}" "${FAKE_CODEX}"`,
    HARNESS_SUPERVISOR_NOTIFY_RETRY_MS: "200",
    HS_FAKE_CODEX_LOG: logFile,
    // Keep the first delivery in flight long enough to kill the daemon.
    HS_FAKE_CODEX_SLEEP_MS: "8000",
  };
  const client = await daemon.start({ env });
  const worker = await spawnWorker(client, cwd, "delivery interrupted by daemon death");
  await waitTerminal(client, worker.id, 20_000);
  await new Promise((resolve) => setTimeout(resolve, 500));

  await daemon.kill();
  restarted = new TestDaemon(daemon.stateDir);
  const client2 = await restarted.start({ env: { ...env, HS_FAKE_CODEX_SLEEP_MS: "0" } });

  let delivered = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await inbox(client2, { workerId: worker.id });
    if (result.notifications.length === 1 && result.notifications[0]!.delivery.state === "delivered") {
      delivered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(delivered, "the pending notification must be delivered after the restart");

  const final = await inbox(client2, { workerId: worker.id });
  assert.equal(final.notifications.length, 1, "recovery must not duplicate the inbox record");
  const calls = (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean);
  assert.ok(calls.length >= 1, "at least one delivery attempt happened");
  assert.ok(calls.length <= 2, `at-least-once, at most one retry in this scenario; got ${calls.length}`);
});
