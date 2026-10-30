import { test } from "node:test";
import assert from "node:assert/strict";
import type { NotificationsResult } from "../../src/types.js";
import type { SupervisorError } from "../../src/errors.js";
import { sleep } from "../../src/util/async.js";
import {
  TestDaemon,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  statusOf,
  waitForStatus,
  waitTerminal,
} from "./helpers.js";

test("terminal status carries the final report and a single run segment", async (t) => {
  const daemon = await TestDaemon.create("hs-evidence-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const cwd = await makeWorkspace("hs-evidence-work-");
  const worker = await spawnWorker(client, cwd, "finish with a report");
  const final = await waitTerminal(client, worker.id, 30_000);
  assert.equal(final.worker.status, "completed");

  const status = await statusOf(client, worker.id);
  assert.equal(status.lastProgress?.state, "available");
  assert.equal(status.lastProgress?.evidence, "final_report");
  assert.equal(status.lastProgress?.source, "final_report");
  assert.ok((status.lastProgress?.text ?? "").length > 0);
  const completed = final.events.find((event) => event.type === "run.completed");
  assert.equal(status.lastProgress?.seq, completed?.seq);

  assert.equal(status.timeline?.segmentsTotal, 1);
  assert.equal(status.timeline?.segments[0]?.outcome, "completed");
  assert.equal(status.timeline?.segments[0]?.open, false);
  assert.equal(status.timeline?.firstStartedAt, status.timeline?.currentRunStartedAt);
});

test("a cancelled worker exposes its last partial progress without claiming completion", async (t) => {
  const daemon = await TestDaemon.create("hs-evidence-partial-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const cwd = await makeWorkspace("hs-evidence-partial-work-");
  const worker = await spawnWorker(client, cwd, "[scenario:partial] make progress, then get cancelled");
  await waitForStatus(client, worker.id, ["running"]);
  await sleep(250);
  const cancelled = await client.request<{ status: string }>(
    "cancel",
    { workerId: worker.id, timeoutMs: 8000 },
    { timeoutMs: 20_000 },
  );
  assert.equal(cancelled.status, "cancelled");

  const status = await statusOf(client, worker.id);
  assert.equal(status.worker.status, "cancelled");
  assert.equal(status.lastProgress?.state, "available");
  assert.equal(status.lastProgress?.source, "partial_text");
  assert.equal(status.lastProgress?.evidence, "partial_progress");
  assert.match(status.lastProgress?.text ?? "", /PARTIAL_PROGRESS_FROM_WORKER/);
  // The terminal event proves cancellation, not delivery.
  const terminal = (await eventsOf(client, worker.id)).events.find(
    (event) => event.type === "run.cancelled",
  );
  assert.equal(status.lastProgress?.seq, terminal?.seq);
});

test("resume timestamps keep the original start and expose both run segments", async (t) => {
  const daemon = await TestDaemon.create("hs-evidence-resume-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const cwd = await makeWorkspace("hs-evidence-resume-work-");
  const worker = await spawnWorker(client, cwd, "first run");
  await waitTerminal(client, worker.id, 30_000);
  const first = await statusOf(client, worker.id);
  const firstStartedAt = first.worker.firstStartedAt;
  assert.ok(firstStartedAt);

  const resumed = await client.request<{ status: string; resumeCount: number }>(
    "resume",
    { workerId: worker.id, prompt: "second run" },
    { timeoutMs: 60_000 },
  );
  assert.equal(resumed.status, "running");
  await waitTerminal(client, worker.id, 30_000);
  const second = await statusOf(client, worker.id);
  assert.equal(second.worker.resumeCount, 1);
  assert.equal(second.worker.firstStartedAt, firstStartedAt);
  assert.ok(
    Date.parse(second.worker.startedAt!) > Date.parse(firstStartedAt!),
    "startedAt must be the latest segment start, firstStartedAt the original",
  );
  assert.equal(second.timeline?.segmentsTotal, 2);
  assert.equal(second.timeline?.segments[0]?.outcome, "completed");
  assert.equal(second.timeline?.segments[1]?.outcome, "completed");
});

test("an expired input request is reported as expired and rejects a later answer", async (t) => {
  const daemon = await TestDaemon.create("hs-evidence-input-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start({ env: { FAKE_PI_UI_TIMEOUT: "300" } });
  const cwd = await makeWorkspace("hs-evidence-input-work-");
  const worker = await spawnWorker(client, cwd, "[scenario:ask] ask, then time out");

  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"]);
  const pending = await statusOf(client, worker.id);
  assert.equal(pending.inputState?.state, "pending");
  assert.ok((pending.inputState?.expiresInMs ?? 0) > 0);

  await waitForStatus(client, worker.id, ["running"], 5000).catch(() => undefined);
  let expired = await statusOf(client, worker.id);
  const deadline = Date.now() + 3000;
  while (expired.inputState?.state !== "expired" && Date.now() < deadline) {
    await sleep(50);
    expired = await statusOf(client, worker.id);
  }
  assert.equal(expired.inputState?.state, "expired");
  assert.deepEqual(expired.inputState?.nextActions, ["worker_status", "worker_resume"]);

  await assert.rejects(
    client.request("answer", {
      workerId: worker.id,
      requestId: pending.worker.pendingInput!.requestId,
      response: { value: "late" },
    }),
    (error: SupervisorError) => {
      assert.equal(error.code, "INVALID_STATE");
      assert.equal((error.details as Record<string, unknown>).reason, "input_expired");
      return true;
    },
  );

  // Mutually exclusive fields are rejected by the IPC schema before the
  // supervisor sees the request, even when no pending input exists.
  await assert.rejects(
    client.request("answer", {
      workerId: worker.id,
      requestId: "whatever",
      response: { value: "v", confirmed: true },
    }),
    (error: SupervisorError) => error.code === "BAD_REQUEST",
  );

  // Expiry now cancels the native dialog, so a minimal/fake Pi harness can
  // continue instead of hanging forever. Real Pi extensions may already have
  // resolved their own timeout; the extra cancel is harmless.
  const final = await waitTerminal(client, worker.id, 10_000);
  assert.equal(final.worker.status, "completed");
});

test("Pi's input cap is opt-in and reaches the pending request", async (t) => {
  const daemon = await TestDaemon.create("hs-evidence-pi-cap-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start({
    env: { HARNESS_SUPERVISOR_PI_INPUT_TIMEOUT_MS: "60000" },
  });
  const cwd = await makeWorkspace("hs-evidence-pi-cap-work-");
  const worker = await spawnWorker(client, cwd, "[scenario:ask] cap this dialog");
  await waitForStatus(client, worker.id, ["awaiting_input"]);
  const pending = await statusOf(client, worker.id);
  const remaining = Date.parse(pending.worker.pendingInput!.expiresAt!) - Date.now();
  assert.ok(remaining > 50_000 && remaining <= 61_000, `unexpected window: ${remaining}ms`);
  await client.request("cancel", { workerId: worker.id, timeoutMs: 8000 }, { timeoutMs: 20_000 });
});

test("a repeated answer is rejected with an already_answered reason", async (t) => {
  const daemon = await TestDaemon.create("hs-evidence-repeat-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const cwd = await makeWorkspace("hs-evidence-repeat-work-");
  const worker = await spawnWorker(client, cwd, "[scenario:ask] answer once");
  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"]);
  const requestId = awaiting.pendingInput!.requestId;
  await client.request("answer", {
    workerId: worker.id,
    requestId,
    response: { confirmed: true },
  });
  await waitTerminal(client, worker.id, 30_000);

  const status = await statusOf(client, worker.id);
  assert.equal(status.inputState?.state, "answered");
  await assert.rejects(
    client.request("answer", {
      workerId: worker.id,
      requestId,
      response: { confirmed: true },
    }),
    (error: SupervisorError) => {
      assert.equal(error.code, "INVALID_STATE");
      assert.equal((error.details as Record<string, unknown>).reason, "already_answered");
      return true;
    },
  );
});

test("last progress survives a daemon restart", async (t) => {
  const daemon = await TestDaemon.create("hs-evidence-restart-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const cwd = await makeWorkspace("hs-evidence-restart-work-");
  const worker = await spawnWorker(client, cwd, "[scenario:partial] progress then cancel");
  await waitForStatus(client, worker.id, ["running"]);
  await sleep(250);
  await client.request("cancel", { workerId: worker.id, timeoutMs: 8000 }, { timeoutMs: 20_000 });
  const before = await statusOf(client, worker.id);
  assert.equal(before.lastProgress?.state, "available");

  await daemon.stop();
  const restarted = await daemon.start();
  const after = await statusOf(restarted, worker.id);
  assert.equal(after.lastProgress?.state, "available");
  assert.equal(after.lastProgress?.seq, before.lastProgress?.seq);
  assert.equal(after.lastProgress?.text, before.lastProgress?.text);
});

test("notification counts distinguish the asked worker from the whole inbox", async (t) => {
  const daemon = await TestDaemon.create("hs-evidence-counts-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const client = await daemon.start();
  const cwd = await makeWorkspace("hs-evidence-counts-work-");
  const first = await spawnWorker(client, cwd, "first");
  await waitTerminal(client, first.id, 30_000);
  const second = await spawnWorker(client, cwd, "second");
  await waitTerminal(client, second.id, 30_000);

  const scoped = await client.request<NotificationsResult>("notifications", {
    state: "pending",
    workerId: first.id,
    limit: 50,
  });
  assert.equal(scoped.notifications.length, 1);
  assert.equal(scoped.filteredCounts?.pending, 1);
  assert.ok((scoped.globalCounts?.pending ?? 0) >= 2);
  assert.equal(scoped.scope?.workerId, first.id);
  assert.equal(scoped.scope?.returned, 1);
  // The legacy field stays the whole-inbox view.
  assert.deepEqual(scoped.counts, scoped.globalCounts);

  const empty = await client.request<NotificationsResult>("notifications", {
    state: "pending",
    workerId: "w-does-not-exist",
    limit: 50,
  });
  assert.equal(empty.notifications.length, 0);
  assert.equal(empty.filteredCounts?.pending, 0);
  assert.ok((empty.globalCounts?.pending ?? 0) >= 2);
});