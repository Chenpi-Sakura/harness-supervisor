import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { SupervisorError } from "../../src/errors.js";
import type { NotificationsResult, WorkerSummary } from "../../src/types.js";
import {
  TestDaemon,
  makeWorkspace,
  spawnWorker,
  statusOf,
  waitForStatus,
  waitTerminal,
} from "./helpers.js";

function rejectionCode(error: unknown): string | undefined {
  return error instanceof SupervisorError ? error.code : undefined;
}

test("pin protects a terminal worker from prune, and archive only hides it", async (t) => {
  const daemon = await TestDaemon.create("hs-admin-flags-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();

  const worker = await spawnWorker(client, cwd, "admin flags", {
    persistence: "persistent",
  });
  await waitTerminal(client, worker.id);

  const pinned = await client.request<WorkerSummary>("admin", {
    workerId: worker.id,
    action: "pin",
  });
  assert.equal(pinned.pinned, true);
  const pruned = await client.request<{ removed: string[]; skipped: Array<{ workerId: string; reason: string }> }>(
    "prune",
    { olderThanDays: 0, keep: 0 },
  );
  assert.deepEqual(pruned.removed, []);
  assert.equal(
    pruned.skipped.some((item) => item.workerId === worker.id && item.reason === "pinned"),
    true,
  );

  const unpinned = await client.request<WorkerSummary>("admin", {
    workerId: worker.id,
    action: "unpin",
  });
  assert.equal(unpinned.pinned, undefined);

  const archived = await client.request<WorkerSummary>("admin", {
    workerId: worker.id,
    action: "archive",
  });
  assert.equal(archived.archived, true);
  const defaultList = await client.request<WorkerSummary[]>("list", {});
  assert.equal(defaultList.some((item) => item.id === worker.id), false);
  const fullList = await client.request<WorkerSummary[]>("list", { includeArchived: true });
  assert.equal(fullList.some((item) => item.id === worker.id), true);
  assert.equal((await statusOf(client, worker.id)).worker.archived, true);

  const unarchived = await client.request<WorkerSummary>("admin", {
    workerId: worker.id,
    action: "unarchive",
  });
  assert.equal(unarchived.archived, undefined);
  assert.equal((await client.request<WorkerSummary[]>("list", {})).some((item) => item.id === worker.id), true);
});

test("retire blocks new Turns until unretire", async (t) => {
  const daemon = await TestDaemon.create("hs-admin-retire-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();

  const worker = await spawnWorker(client, cwd, "retire me", {
    persistence: "persistent",
  });
  await waitTerminal(client, worker.id);

  const retired = await client.request<WorkerSummary>("admin", {
    workerId: worker.id,
    action: "retire",
  });
  assert.equal(typeof retired.retiredAt, "string");
  assert.equal(retired.lifecycle, "retired");
  assert.equal(retired.resumeAvailable, false);
  assert.equal(retired.session.restorable, false);
  assert.equal(retired.session.reason, "retired");

  await assert.rejects(
    () => client.request("continue", { workerId: worker.id, prompt: "next" }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );
  await assert.rejects(
    () => client.request("resume", { workerId: worker.id, prompt: "next" }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );

  const unretired = await client.request<WorkerSummary>("admin", {
    workerId: worker.id,
    action: "unretire",
  });
  assert.equal(unretired.retiredAt, undefined);
  assert.equal(unretired.lifecycle, "idle");
  assert.equal(unretired.session.restorable, true);
  assert.equal(unretired.resumeAvailable, true);

  const accepted = await client.request<WorkerSummary>(
    "continue",
    { workerId: worker.id, prompt: "back to work" },
    { timeoutMs: 60_000 },
  );
  const final = await waitTerminal(client, worker.id, 20_000, accepted.lastSeq);
  assert.equal(final.worker.status, "completed");
});

test("active workers cannot be archived or retired", async (t) => {
  const daemon = await TestDaemon.create("hs-admin-active-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "4000" } });
  const worker = await spawnWorker(client, cwd, "[scenario:slow] active", {
    persistence: "persistent",
  });
  for (const action of ["archive", "retire"] as const) {
    await assert.rejects(
      () => client.request("admin", { workerId: worker.id, action }),
      (error: unknown) => rejectionCode(error) === "INVALID_STATE",
    );
  }
});

test("retire, forget and compact cannot race an in-flight continue", async (t) => {
  const daemon = await TestDaemon.create("hs-admin-race-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_START_DELAY_MS: "1500" } });
  const worker = await spawnWorker(client, cwd, "race guard", {
    persistence: "persistent",
  });
  await waitTerminal(client, worker.id);
  const inbox = await client.request<{ notifications: Array<{ id: string }> }>("notifications", {
    workerId: worker.id,
    state: "all",
  });
  await client.request("notification_ack", {
    ids: inbox.notifications.map((item) => item.id),
    by: "test",
  });

  const continuing = client.request<WorkerSummary>(
    "continue",
    { workerId: worker.id, prompt: "next turn" },
    { timeoutMs: 60_000 },
  );
  await waitForStatus(client, worker.id, ["starting", "running"], 10_000);

  for (const action of ["retire", "archive"] as const) {
    await assert.rejects(
      () => client.request("admin", { workerId: worker.id, action }),
      (error: unknown) => rejectionCode(error) === "INVALID_STATE",
    );
  }
  await assert.rejects(
    () => client.request("forget", { workerId: worker.id }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );
  await assert.rejects(
    () => client.request("compact", { workerId: worker.id }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );
  const pruned = await client.request<{
    removed: string[];
    skipped: Array<{ workerId: string; reason: string }>;
  }>("prune", { olderThanDays: 0, keep: 0 });
  assert.equal(pruned.removed.includes(worker.id), false);

  const accepted = await continuing;
  await waitTerminal(client, worker.id, 30_000, accepted.lastSeq);
  const retired = await client.request<WorkerSummary>("admin", {
    workerId: worker.id,
    action: "retire",
  });
  assert.equal(retired.lifecycle, "retired");
});

test("forget refuses a pinned worker and unacked notifications, then preserves the session", async (t) => {
  const daemon = await TestDaemon.create("hs-admin-forget-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "forget me", {
    persistence: "persistent",
  });
  const settled = await waitTerminal(client, worker.id);
  assert.ok(settled.worker.sessionFile);

  await assert.rejects(
    () => client.request("forget", { workerId: worker.id }),
    (error: unknown) => {
      assert.equal(rejectionCode(error), "INVALID_STATE");
      assert.match(String((error as Error).message), /acknowledge/i);
      return true;
    },
  );

  const inbox = await client.request<NotificationsResult>("notifications", {
    workerId: worker.id,
    state: "all",
  });
  await client.request("notification_ack", { ids: inbox.notifications.map((record) => record.id) });

  await client.request("admin", { workerId: worker.id, action: "pin" });
  await assert.rejects(
    () => client.request("forget", { workerId: worker.id }),
    (error: unknown) => rejectionCode(error) === "INVALID_STATE",
  );
  await client.request("admin", { workerId: worker.id, action: "unpin" });

  const result = await client.request<{
    workerId: string;
    forgotten: boolean;
    sessionPreserved: boolean;
    note: string;
  }>("forget", { workerId: worker.id });
  assert.equal(result.forgotten, true);
  assert.equal(result.sessionPreserved, true);
  assert.match(result.note, /session file was left in place/i);
  await assert.rejects(
    () => statusOf(client, worker.id),
    (error: unknown) => rejectionCode(error) === "NOT_FOUND",
  );
  await access(settled.worker.sessionFile!);
});
