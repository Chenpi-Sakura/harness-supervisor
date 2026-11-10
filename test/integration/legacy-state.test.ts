import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "../../src/errors.js";
import type {
  NotificationsResult,
  ReadEventsResult,
  WorkerRecord,
  WorkerStatusResult,
  WorkerSummary,
} from "../../src/types.js";
import { TestDaemon, makeWorkspace, readJson, waitTerminal } from "./helpers.js";

const LEGACY_ID = "w-legacy0-00000001";
const LEGACY_SESSION_ID = "legacy-session-11111111";

function rejectionCode(error: unknown): string | undefined {
  return error instanceof SupervisorError ? error.code : undefined;
}

/** Exact 0.8.0 WorkerRecord shape: none of the 0.9 optional fields. */
function legacyRecord(cwd: string, sessionFile: string, endedAt: string): WorkerRecord {
  return {
    schemaVersion: 1,
    id: LEGACY_ID,
    runtime: "pi",
    name: "legacy-worker",
    cwd,
    promptPreview: "legacy prompt",
    status: "completed",
    createdAt: endedAt,
    updatedAt: endedAt,
    startedAt: endedAt,
    firstStartedAt: endedAt,
    endedAt,
    sessionId: LEGACY_SESSION_ID,
    sessionFile,
    exit: { code: 0, signal: null, at: endedAt },
    result: { text: "LEGACY_RESULT", truncated: false },
    lastSeq: 7,
    eventCount: 7,
    stats: { turns: 1, toolCalls: 1, toolErrors: 0 },
    capabilities: {
      runtime: "pi",
      steer: true,
      followUp: true,
      cancel: true,
      resume: true,
      pause: false,
      interactiveInput: true,
      notes: "legacy fixture",
    },
    config: {},
    resumeCount: 0,
    supervisorId: "legacy-supervisor",
    taskId: undefined,
    notifyTarget: { channel: "none" },
  };
}

function legacyEvents(workerId: string, endedAt: string): string {
  const base = { workerId, ts: endedAt, notifyTarget: { channel: "none" } };
  const events = [
    { ...base, seq: 1, type: "worker.starting", data: { runtime: "pi" } },
    {
      ...base,
      seq: 2,
      type: "worker.session",
      data: { sessionId: LEGACY_SESSION_ID, fileExists: true },
    },
    { ...base, seq: 3, type: "run.accepted", data: {} },
    { ...base, seq: 4, type: "run.started", data: {} },
    {
      ...base,
      seq: 5,
      type: "run.progress",
      data: { kind: "tool", toolName: "bash", text: "legacy tool output" },
    },
    {
      ...base,
      seq: 6,
      type: "run.completed",
      data: { text: "LEGACY_RESULT", truncated: false, sessionFile: "legacy.jsonl" },
    },
    { ...base, seq: 7, type: "worker.exited", data: { code: 0, signal: null } },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function legacyNotification(endedAt: string): string {
  const record = {
    id: `${LEGACY_ID}#6`,
    workerId: LEGACY_ID,
    runtime: "pi",
    seq: 6,
    eventType: "run.completed",
    kind: "completed",
    createdAt: endedAt,
    summary: { status: "completed", text: "LEGACY_RESULT" },
    delivery: { state: "pending", channel: "none", attempts: 0 },
  };
  return `${JSON.stringify(record)}\n`;
}

test("a 0.8.0 worker record, event log, session and inbox remain readable", async (t) => {
  const daemon = await TestDaemon.create("hs-legacy-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace();
  const endedAt = "2026-11-08T10:00:00.000Z";
  const workerDir = path.join(daemon.stateDir, "workers", LEGACY_ID);
  const sessionFile = path.join(daemon.stateDir, "sessions", LEGACY_ID, "legacy.jsonl");
  await mkdir(workerDir, { recursive: true });
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(path.join(workerDir, "worker.json"), JSON.stringify(legacyRecord(cwd, sessionFile, endedAt)));
  await writeFile(path.join(workerDir, "events.jsonl"), legacyEvents(LEGACY_ID, endedAt));
  await writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: LEGACY_SESSION_ID,
      timestamp: endedAt,
      cwd,
    })}\n${JSON.stringify({
      type: "message",
      id: "legacy-msg-1",
      message: { role: "user", content: "legacy context marker LEGACY_CTX_9f2", timestamp: Date.parse(endedAt) },
    })}\n${JSON.stringify({
      type: "message",
      id: "legacy-msg-2",
      message: { role: "assistant", content: "legacy answer", timestamp: Date.parse(endedAt) + 1 },
    })}\n`,
  );
  await writeFile(path.join(daemon.stateDir, "notifications.jsonl"), legacyNotification(endedAt));

  let client = await daemon.start();
  const list = await client.request<WorkerSummary[]>("list", {});
  const listed = list.find((item) => item.id === LEGACY_ID);
  assert.ok(listed, "legacy worker must appear in list");
  assert.equal(listed.persistence, "oneshot");
  assert.equal(listed.status, "completed");
  assert.equal(listed.session.available, true);
  assert.equal(listed.session.restorable, true);

  const status = await client.request<WorkerStatusResult>("status", {
    workerId: LEGACY_ID,
    recentEvents: 100,
  });
  assert.equal(status.worker.result?.text, "LEGACY_RESULT");
  assert.equal(status.worker.sessionId, LEGACY_SESSION_ID);
  assert.equal(status.recentEvents.length, 7);

  const events = await client.request<ReadEventsResult>("events", {
    workerId: LEGACY_ID,
    sinceSeq: 0,
    limit: 100,
  });
  assert.equal(events.events.length, 7);
  assert.equal(events.nextSeq, 7);

  const inbox = await client.request<NotificationsResult>("notifications", {
    workerId: LEGACY_ID,
    state: "all",
  });
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.notifications[0]!.id, `${LEGACY_ID}#6`);
  assert.equal(inbox.notifications[0]!.delivery.channel, "none");
  await client.request("notification_ack", { ids: [`${LEGACY_ID}#6`] });
  const acked = await client.request<NotificationsResult>("notifications", {
    workerId: LEGACY_ID,
    state: "all",
  });
  assert.equal(acked.notifications.length, 1, "reconciliation must not duplicate the legacy record");
  assert.ok(acked.notifications[0]!.ackAt);

  await assert.rejects(
    () => client.request("continue", { workerId: LEGACY_ID, prompt: "legacy continue" }),
    (error: unknown) => rejectionCode(error) === "UNSUPPORTED",
    "a legacy record without persistence must stay oneshot",
  );

  const resumed = await client.request<WorkerSummary>(
    "resume",
    { workerId: LEGACY_ID, prompt: "resume the legacy session" },
    { timeoutMs: 60_000 },
  );
  assert.equal(resumed.id, LEGACY_ID);
  assert.equal(resumed.sessionId, LEGACY_SESSION_ID);
  const settled = await waitTerminal(client, LEGACY_ID, 20_000, resumed.lastSeq);
  assert.equal(settled.worker.status, "completed");
  assert.equal(settled.worker.sessionId, LEGACY_SESSION_ID);
  assert.match(settled.worker.result?.text ?? "", /FAKE_PI_OK/);

  await daemon.stop();
  const persisted = await readJson<WorkerRecord>(
    path.join(workerDir, "worker.json"),
  );
  assert.equal(persisted.persistence, undefined, "compatibility must not invent persistent mode");
  assert.ok(persisted.eventCheckpoint, "startup should backfill the new checkpoint");

  const sizeBeforeRestart = (await readFile(path.join(workerDir, "events.jsonl"))).length;
  client = await daemon.start();
  const afterRestart = await client.request<ReadEventsResult>("events", {
    workerId: LEGACY_ID,
    sinceSeq: 0,
    limit: 100,
  });
  assert.equal(afterRestart.events.length, afterRestart.worker.eventCount);
  assert.equal(afterRestart.events.length, persisted.eventCount);
  assert.equal(
    (await readFile(path.join(workerDir, "events.jsonl"))).length,
    sizeBeforeRestart,
    "checkpoint fast path must not rewrite history",
  );
  assert.doesNotMatch(daemon.output, /is incomplete/);
});
