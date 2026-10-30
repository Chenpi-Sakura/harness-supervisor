import assert from "node:assert/strict";
import test from "node:test";
import { buildInputState, refreshInputStateTime } from "../../src/input-state.js";
import type { WorkerEvent, WorkerRecord } from "../../src/types.js";

function record(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    schemaVersion: 1,
    id: "w-test",
    runtime: "qoder",
    cwd: "D:\\work",
    promptPreview: "do it",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    startedAt: "2026-01-01T00:00:02.000Z",
    firstStartedAt: "2026-01-01T00:00:02.000Z",
    lastSeq: 3,
    eventCount: 3,
    stats: { turns: 0, toolCalls: 0, toolErrors: 0 },
    capabilities: {
      runtime: "qoder",
      steer: true,
      followUp: true,
      cancel: true,
      resume: true,
      pause: false,
      interactiveInput: true,
      notes: "",
    },
    config: {},
    resumeCount: 0,
    supervisorId: "s",
    ...overrides,
  };
}

function event(seq: number, type: WorkerEvent["type"], data?: Record<string, unknown>): WorkerEvent {
  return {
    seq,
    workerId: "w-test",
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    type,
    ...(data ? { data } : {}),
  };
}

test("pending input exposes the deadline and the only valid action", () => {
  const state = buildInputState(
    record({
      status: "awaiting_input",
      pendingInput: {
        requestId: "req-1",
        method: "select",
        createdAt: "2026-01-01T00:00:05.000Z",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
    [],
  );
  assert.equal(state?.state, "pending");
  assert.deepEqual(state?.nextActions, ["worker_answer"]);
  assert.ok((state?.expiresInMs ?? 0) > 0);
});

test("an answered request is reported as answered, not pending", () => {
  const events = [
    event(1, "run.needs_input", { requestId: "req-1", method: "confirm" }),
    event(2, "run.input_answered", {
      requestId: "req-1",
      method: "confirm",
      cancelled: false,
      outcome: "confirmed",
    }),
  ];
  const state = buildInputState(record({ lastSeq: 2 }), events);
  assert.equal(state?.state, "answered");
  assert.equal(state?.requestId, "req-1");
  assert.equal(state?.outcome, "confirmed");
  assert.deepEqual(state?.nextActions, ["worker_status", "worker_wait"]);
});

test("a timed-out request is expired and points at resume instead of answer", () => {
  const events = [
    event(1, "run.needs_input", { requestId: "req-1", method: "input", expiresAt: "2026-01-01T00:05:00.000Z" }),
    event(2, "run.progress", { kind: "input_timeout", requestId: "req-1" }),
  ];
  const state = buildInputState(record({ lastSeq: 2 }), events);
  assert.equal(state?.state, "expired");
  assert.deepEqual(state?.nextActions, ["worker_status", "worker_resume"]);
  assert.equal(state?.expiresAt, "2026-01-01T00:05:00.000Z");
  assert.match(state?.note ?? "", /do not retry worker_answer/);
});

test("a request left unresolved when the worker ended is closed", () => {
  const events = [event(1, "run.needs_input", { requestId: "req-1", method: "input" })];
  const state = buildInputState(record({ status: "cancelled", lastSeq: 1 }), events);
  assert.equal(state?.state, "closed");
  assert.deepEqual(state?.nextActions, ["worker_resume"]);
  assert.match(state?.note ?? "", /cannot be answered/);
});

test("no input event at all yields no input state", () => {
  assert.equal(buildInputState(record(), [event(1, "run.accepted")]), undefined);
});

test("a legacy terminal record with pendingInput is closed, not answerable", () => {
  const state = buildInputState(
    record({
      status: "cancelled",
      pendingInput: {
        requestId: "req-1",
        method: "input",
        createdAt: "2026-01-01T00:00:05.000Z",
      },
    }),
    [],
  );
  assert.equal(state?.state, "closed");
  assert.deepEqual(state?.nextActions, ["worker_resume"]);
});

test("a cached pending view gets a fresh remaining time", () => {
  const cached = buildInputState(
    record({
      status: "awaiting_input",
      pendingInput: {
        requestId: "req-1",
        method: "select",
        createdAt: "2026-01-01T00:00:05.000Z",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
    [],
  );
  const frozen = { ...cached!, expiresInMs: 999_999 };
  const fresh = refreshInputStateTime(frozen, Date.now());
  assert.ok((fresh?.expiresInMs ?? 0) < 70_000);
  const expired = refreshInputStateTime(
    { ...frozen, expiresAt: new Date(Date.now() - 1_000).toISOString() },
    Date.now(),
  );
  assert.ok((expired?.expiresInMs ?? 0) < 0);
  assert.match(expired?.note ?? "", /deadline has passed/);
});