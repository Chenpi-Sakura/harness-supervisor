import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "../../src/errors.js";
import type {
  CompactResult,
  NotificationsResult,
  WorkerStatusResult,
  WorkerSummary,
} from "../../src/types.js";
import { sleep } from "../../src/util/async.js";
import {
  TestDaemon,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  statusOf,
  waitTerminal,
} from "./helpers.js";

function rejectionCode(error: unknown): string | undefined {
  return error instanceof SupervisorError ? error.code : undefined;
}

async function eventFileSize(stateDir: string, workerId: string): Promise<number> {
  return (await stat(path.join(stateDir, "workers", workerId, "events.jsonl"))).size;
}

/** Teardown may append a late session/exit event after the terminal status. */
async function waitStableSequence(
  client: Parameters<typeof statusOf>[0],
  workerId: string,
): Promise<WorkerStatusResult> {
  let last = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await statusOf(client, workerId);
    if (status.worker.lastSeq === last) {
      stable += 1;
      if (stable >= 3) return status;
    } else {
      last = status.worker.lastSeq;
      stable = 0;
    }
    await sleep(50);
  }
  throw new Error(`event sequence for ${workerId} did not stabilize`);
}

test("compaction prunes progress, keeps lifecycle and result, and survives a restart", async (t) => {
  const daemon = await TestDaemon.create("hs-compact-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:busy] compact me");
  await waitTerminal(client, worker.id);
  const stable = await waitStableSequence(client, worker.id);
  const settledSeq = stable.worker.lastSeq;
  const inboxBefore = await client.request<NotificationsResult>("notifications", {
    workerId: worker.id,
    state: "all",
  });
  const notificationIds = inboxBefore.notifications.map((item) => item.id).sort();

  const before = await eventsOf(client, worker.id);
  const beforeProgress = before.events.filter((event) => event.type === "run.progress").length;
  assert.ok(beforeProgress > 20, `expected many progress events, got ${beforeProgress}`);
  const beforeBytes = await eventFileSize(daemon.stateDir, worker.id);

  const dryRun = await client.request<CompactResult>("compact", {
    workerId: worker.id,
    keepProgress: 5,
    dryRun: true,
  });
  assert.equal(dryRun.dryRun, true);
  assert.ok(dryRun.removedEvents > 0);
  assert.equal(await eventFileSize(daemon.stateDir, worker.id), beforeBytes);
  assert.equal((await eventsOf(client, worker.id)).events.length, before.events.length);

  const compacted = await client.request<CompactResult>("compact", {
    workerId: worker.id,
    keepProgress: 5,
  });
  const result = compacted.workers[0]!;
  assert.equal(result.skipped, undefined);
  assert.ok(result.removedEvents > 0);
  assert.ok(result.removedBytes > 0);
  const afterBytes = await eventFileSize(daemon.stateDir, worker.id);
  assert.ok(afterBytes < beforeBytes, `expected ${afterBytes} < ${beforeBytes}`);

  const after = await eventsOf(client, worker.id);
  assert.equal(after.events.length, result.keptEvents);
  assert.equal(after.worker.compacted?.retainedFromSeq, after.events[0]?.seq);
  assert.equal(after.events.filter((event) => event.type === "run.progress").length, 5);
  assert.equal(after.nextSeq, settledSeq);
  for (const type of ["run.started", "run.completed", "worker.exited", "worker.session"]) {
    assert.equal(
      after.events.some((event) => event.type === type),
      true,
      `expected lifecycle event ${type} to survive compaction`,
    );
  }
  const progressSeq = after.events
    .filter((event) => event.type === "run.progress")
    .map((event) => event.seq);
  assert.deepEqual(progressSeq, [...progressSeq].sort((a, b) => a - b));

  const status = await client.request<WorkerStatusResult>("status", {
    workerId: worker.id,
    recentEvents: 100,
  });
  assert.equal(status.worker.status, "completed");
  assert.equal(status.worker.eventCount, result.keptEvents);
  assert.equal(status.worker.lastSeq, settledSeq);
  assert.equal(status.lastProgress?.state, "available");
  assert.match(status.worker.result?.text ?? "", /FAKE_PI_OK/);
  const inboxAfter = await client.request<NotificationsResult>("notifications", {
    workerId: worker.id,
    state: "all",
  });
  assert.deepEqual(
    inboxAfter.notifications.map((item) => item.id).sort(),
    notificationIds,
    "compaction must not change notification IDs",
  );
  assert.ok(notificationIds.length > 0);

  await daemon.stop();
  // A lost inbox must be reconstructible from the compacted (gapped) log.
  await rm(path.join(daemon.stateDir, "notifications.jsonl"), { force: true });
  const restarted = await daemon.start();
  const afterRestart = await eventsOf(restarted, worker.id);
  assert.equal(afterRestart.events.length, result.keptEvents);
  assert.equal((await statusOf(restarted, worker.id)).worker.status, "completed");
  const rebuilt = await restarted.request<NotificationsResult>("notifications", {
    workerId: worker.id,
    state: "all",
  });
  assert.deepEqual(
    rebuilt.notifications.map((item) => item.id).sort(),
    notificationIds,
    "notification rebuild after compaction must keep the stable ids",
  );
  assert.doesNotMatch(daemon.output, /is incomplete/);
});

test("compaction refuses active and pinned workers", async (t) => {
  const daemon = await TestDaemon.create("hs-compact-guard-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "4000" } });
  const active = await spawnWorker(client, cwd, "[scenario:slow] active");
  await assert.rejects(
    () => client.request("compact", { workerId: active.id }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );

  const worker = await spawnWorker(client, cwd, "[scenario:busy] pinned");
  await waitTerminal(client, worker.id);
  await client.request("admin", { workerId: worker.id, action: "pin" });
  await assert.rejects(
    () => client.request("compact", { workerId: worker.id }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );

  const batch = await client.request<CompactResult>("compact", { keepProgress: 0 });
  assert.equal(batch.workers.some((item) => item.workerId === active.id), false);
  assert.equal(batch.workers.some((item) => item.workerId === worker.id), false);
});

test("a compacted persistent worker continues on the same session", async (t) => {
  const daemon = await TestDaemon.create("hs-compact-continue-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:busy] compact then continue", {
    persistence: "persistent",
  });
  await waitTerminal(client, worker.id);
  const stable = await waitStableSequence(client, worker.id);
  const sessionId = stable.worker.sessionId;
  assert.ok(sessionId);

  await client.request<CompactResult>("compact", { workerId: worker.id, keepProgress: 3 });
  const resumed = await client.request<WorkerSummary>(
    "continue",
    { workerId: worker.id, prompt: "second turn after compaction" },
    { timeoutMs: 60_000 },
  );
  assert.equal(resumed.sessionId, sessionId);
  const second = await waitTerminal(client, worker.id, 20_000, resumed.lastSeq);
  assert.equal(second.worker.status, "completed");
  assert.equal(second.worker.sessionId, sessionId);
  assert.equal(second.worker.resumeCount, 1);
  assert.match(second.worker.result?.text ?? "", /FAKE_PI_OK/);
});