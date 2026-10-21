import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "../../src/errors.js";
import { isPidAlive, sleep } from "../../src/util/async.js";
import {
  TestDaemon,
  connectExisting,
  eventsOf,
  makeWorkspace,
  spawnWorker,
  statusOf,
  waitForEvent,
  waitForStatus,
  waitPidDead,
  waitTerminal,
} from "./helpers.js";

test("spawn returns while running, and the worker survives main-client disconnect", async (t) => {
  const daemon = await TestDaemon.create();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  const startedAt = Date.now();
  const worker = await spawnWorker(client, cwd, "[scenario:slow] survive a disconnected client");
  assert.equal(worker.status, "running");
  assert.equal(worker.result, undefined);
  assert.ok(Date.now() - startedAt < 1500, "spawn should return before completion");

  client.close();
  daemon.client = null;
  await sleep(2500);

  const reconnected = await connectExisting(daemon.stateDir);
  const final = await waitForStatus(reconnected, worker.id, ["completed"], 5000);
  assert.equal(final.status, "completed");
  assert.equal(final.result?.text, "FAKE_PI_OK");
  assert.equal(isPidAlive(final.pid), false);
  reconnected.close();
});

test("event cursors are incremental and bounded waits do not replay history", async (t) => {
  const daemon = await TestDaemon.create();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:slow] observe events");

  const first = await waitForEvent(client, worker.id, "run.started", 5000);
  const runStarted = first.events.find((event) => event.type === "run.started");
  assert.ok(runStarted);
  assert.ok(first.nextSeq >= runStarted.seq);

  const idle = await client.request<{
    events: Array<{ seq: number }>;
    timedOut: boolean;
    nextSeq: number;
  }>(
    "wait",
    {
      workerId: worker.id,
      sinceSeq: first.nextSeq,
      timeoutMs: 150,
      until: "terminal",
    },
    { timeoutMs: 5000 },
  );
  assert.equal(idle.timedOut, true);
  assert.ok(idle.events.every((event) => event.seq > first.nextSeq));

  const final = await waitTerminal(client, worker.id, 10_000, first.nextSeq);
  assert.equal(final.worker.status, "completed");
  const all = await eventsOf(client, worker.id, 0);
  const seqs = all.events.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length, "event sequence numbers must be unique");
  const types = all.events.map((event) => event.type);
  const index = (type: string) => types.findIndex((eventType) => eventType === type);
  assert.ok(index("run.started") >= 0);
  assert.ok(index("run.started") < index("run.completed"));
  assert.ok(index("run.completed") < index("worker.exited"));
  assert.ok(types.includes("run.progress"));

  const cursor = all.nextSeq;
  const after = await eventsOf(client, worker.id, cursor);
  assert.equal(after.events.length, 0);
  assert.equal(after.nextSeq, cursor);
});

test("a steering message reaches a running worker", async (t) => {
  const daemon = await TestDaemon.create();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:slow] accept steering");
  await waitForEvent(client, worker.id, "run.started", 5000);
  const steered = await client.request<{ status: string }>("send", {
    workerId: worker.id,
    message: "prefer the blue path",
    mode: "steer",
  });
  assert.equal(steered.status, "running");
  const final = await waitTerminal(client, worker.id, 10_000);
  assert.equal(final.worker.status, "completed");
  assert.match(final.worker.result?.text ?? "", /FAKE_PI_OK/);
  assert.match(final.worker.result?.text ?? "", /STEERED:prefer the blue path/);
  const events = await eventsOf(client, worker.id);
  const sent = events.events.find((event) => event.type === "run.message_sent");
  assert.ok(sent);
  assert.equal(sent.data?.mode, "steer");
});

test("extension dialogs surface as awaiting_input and can be answered", async (t) => {
  const daemon = await TestDaemon.create();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  const worker = await spawnWorker(client, cwd, "[scenario:ask] request authorization");
  const waitingResult = await client.request<{
    timedOut: boolean;
    terminal: boolean;
    worker: { status: string; pendingInput?: { method: string; requestId: string } };
    events: Array<{ type: string }>;
  }>(
    "wait",
    { workerId: worker.id, sinceSeq: 0, timeoutMs: 5000, until: "terminal" },
    { timeoutMs: 15_000 },
  );
  assert.equal(waitingResult.timedOut, false);
  assert.equal(waitingResult.terminal, false);
  assert.equal(waitingResult.worker.status, "awaiting_input");
  assert.equal(waitingResult.worker.pendingInput?.method, "confirm");
  assert.ok(waitingResult.worker.pendingInput?.requestId);
  assert.ok(waitingResult.events.some((event) => event.type === "run.needs_input"));

  await client.request("answer", {
    workerId: worker.id,
    requestId: waitingResult.worker.pendingInput!.requestId,
    response: { confirmed: true },
  });
  const final = await waitTerminal(client, worker.id, 10_000);
  assert.equal(final.worker.status, "completed");
  assert.match(final.worker.result?.text ?? "", /ANSWER:true/);
  const events = await eventsOf(client, worker.id);
  assert.ok(events.events.some((event) => event.type === "run.needs_input"));
  assert.ok(events.events.some((event) => event.type === "run.input_answered"));

  await assert.rejects(
    () =>
      client.request("answer", {
        workerId: worker.id,
        requestId: "stale",
        response: { cancelled: true },
      }),
    (error: unknown) => error instanceof SupervisorError && error.code === "INVALID_STATE",
  );
});

test("cancelling one worker does not disturb another", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({
    env: { FAKE_PI_SLOW_STEP_MS: "4000" },
  });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const first = await spawnWorker(client, cwd, "[scenario:slow] cancel this one");
  const second = await spawnWorker(client, cwd, "[scenario:slow] let this one finish");
  const cancelled = await client.request<{
    status: string;
    pid?: number;
    exit?: { code: number | null; signal: string | null };
  }>(
    "cancel",
    { workerId: first.id, timeoutMs: 8000 },
    { timeoutMs: 20_000 },
  );
  assert.equal(cancelled.status, "cancelled");
  await waitPidDead(first.pid!, 5000);
  assert.equal(isPidAlive(first.pid), false);

  const secondStatus = await statusOf(client, second.id);
  assert.ok(["running", "completed"].includes(secondStatus.worker.status));
  const secondFinal = await waitTerminal(client, second.id, 15_000);
  assert.equal(secondFinal.worker.status, "completed");
  assert.match(secondFinal.worker.result?.text ?? "", /FAKE_PI_OK/);
  const events = await eventsOf(client, first.id);
  assert.ok(events.events.some((event) => event.type === "run.cancelled"));
  assert.ok(events.events.some((event) => event.type === "worker.exited"));
});

test("max duration cancels the run and reports why", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "6000" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const worker = await spawnWorker(client, cwd, "[scenario:slow] run too long", {
    maxDurationMs: 1000,
  });
  const final = await waitTerminal(client, worker.id, 15_000);
  assert.equal(final.worker.status, "cancelled");
  assert.match(final.worker.statusReason ?? "", /max_duration/);
  const events = await eventsOf(client, worker.id);
  assert.ok(
    events.events.some(
      (event) =>
        event.type === "worker.cancel_requested" &&
        event.data?.reason === "max_duration_exceeded",
    ),
  );
});

test("resume refuses to fake a session that no longer exists", async (t) => {
  const daemon = await TestDaemon.create();
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const worker = await spawnWorker(client, cwd, "complete normally");
  const final = await waitTerminal(client, worker.id, 10_000);
  assert.equal(final.worker.status, "completed");
  assert.ok(final.worker.sessionFile);
  assert.equal(final.worker.resumeAvailable, true);
  const sessionFile = final.worker.sessionFile!;
  await rm(sessionFile, { force: true });
  await assert.rejects(
    () =>
      client.request("resume", { workerId: worker.id, prompt: "try again" }),
    (error: unknown) =>
      error instanceof SupervisorError &&
      error.code === "UNSUPPORTED" &&
      /session file/i.test(error.message),
  );
  const after = await statusOf(client, worker.id);
  assert.equal(after.worker.status, "completed");
  assert.equal(after.worker.result?.text, "FAKE_PI_OK");
  assert.equal(path.isAbsolute(sessionFile), true);
});
