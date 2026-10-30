import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLastProgress,
  buildTimeline,
  findLastProgressEvent,
} from "../../src/progress-evidence.js";
import type { WorkerEvent, WorkerRecord } from "../../src/types.js";

function event(seq: number, type: WorkerEvent["type"], data?: Record<string, unknown>): WorkerEvent {
  return {
    seq,
    workerId: "w-test",
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    type,
    ...(data ? { data } : {}),
  };
}

function record(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    schemaVersion: 1,
    id: "w-test",
    runtime: "pi",
    cwd: "D:\\work",
    promptPreview: "do it",
    status: "cancelled",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:20.000Z",
    startedAt: "2026-01-01T00:00:02.000Z",
    firstStartedAt: "2026-01-01T00:00:02.000Z",
    endedAt: "2026-01-01T00:00:20.000Z",
    lastSeq: 10,
    eventCount: 10,
    stats: { turns: 0, toolCalls: 0, toolErrors: 0 },
    capabilities: {
      runtime: "pi",
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

test("last progress skips tool arguments and keeps the newest assistant text", () => {
  const events = [
    event(1, "run.accepted"),
    event(2, "run.progress", { kind: "assistant_message", preview: "FIRST PROGRESS" }),
    event(3, "run.progress", { kind: "tool_start", tool: "bash", detail: "sleep 60" }),
    event(4, "run.progress", { kind: "tool_end", tool: "bash" }),
  ];
  const picked = findLastProgressEvent(events);
  assert.equal(picked?.seq, 2);
  const progress = buildLastProgress(picked, { maxChars: 400, scannedThroughSeq: 4 });
  assert.equal(progress.state, "available");
  assert.equal(progress.source, "assistant_message");
  assert.equal(progress.text, "FIRST PROGRESS");
  assert.equal(progress.evidence, "partial_progress");
});

test("a terminal partialText is the last progress and is labelled as partial", () => {
  const events = [
    event(1, "run.progress", { kind: "assistant_message", preview: "EARLIER" }),
    event(2, "run.cancelled", { reason: "max_duration_exceeded", partialText: "LAST VALID PROGRESS" }),
  ];
  const progress = buildLastProgress(findLastProgressEvent(events), {
    maxChars: 400,
    scannedThroughSeq: 2,
  });
  assert.equal(progress.state, "available");
  assert.equal(progress.seq, 2);
  assert.equal(progress.source, "partial_text");
  assert.equal(progress.evidence, "partial_progress");
  assert.equal(progress.text, "LAST VALID PROGRESS");
});

test("a terminal event without partialText falls back to earlier progress", () => {
  const events = [
    event(1, "run.progress", { kind: "assistant_message", preview: "STILL USEFUL" }),
    event(2, "run.failed", { reason: "harness error", error: "boom" }),
  ];
  const progress = buildLastProgress(findLastProgressEvent(events), {
    maxChars: 400,
    scannedThroughSeq: 2,
  });
  assert.equal(progress.seq, 1);
  assert.equal(progress.text, "STILL USEFUL");
});

test("no usable text is reported as none, not as an empty success", () => {
  const events = [
    event(1, "run.accepted"),
    event(2, "run.progress", { kind: "tool_start", tool: "bash", detail: "ls" }),
  ];
  const progress = buildLastProgress(findLastProgressEvent(events), {
    maxChars: 400,
    scannedThroughSeq: 2,
  });
  assert.equal(progress.state, "none");
  assert.equal(progress.scannedThroughSeq, 2);
  assert.match(progress.note ?? "", /does not mean the worker made no tool calls/);
});

test("stored truncation is preserved and the original length is reported", () => {
  const events = [
    event(1, "run.progress", {
      kind: "assistant_message",
      preview: "x".repeat(400) + "\n...[truncated 131 chars]",
      previewTruncated: true,
      previewChars: 531,
    }),
  ];
  const progress = buildLastProgress(findLastProgressEvent(events), { maxChars: 100 });
  assert.equal(progress.storedTruncated, true);
  assert.equal(progress.originalChars, 531);
  assert.equal(progress.chars, 400);
  assert.equal(progress.truncated, true);
  assert.equal(progress.text?.length, 100);
});

test("timeline separates resumed run segments and leaves the last one open", () => {
  const events = [
    event(1, "worker.starting"),
    event(2, "run.accepted"),
    event(3, "run.completed"),
    event(4, "worker.starting"),
    event(5, "worker.resumed"),
    event(6, "run.accepted"),
    event(7, "run.cancelled"),
    event(8, "worker.starting"),
    event(9, "run.accepted"),
  ];
  const timeline = buildTimeline(record({ resumeCount: 2, status: "running" }), events, {
    maxSegments: 10,
  });
  assert.equal(timeline.segmentsTotal, 3);
  assert.equal(timeline.segments.length, 3);
  assert.equal(timeline.segments[0]?.outcome, "completed");
  assert.equal(timeline.segments[1]?.outcome, "cancelled");
  assert.equal(timeline.segments[2]?.open, true);
  assert.equal(timeline.segments[2]?.outcome, undefined);
  assert.equal(timeline.firstStartedAt, events[1]!.ts);
  assert.match(timeline.note, /currentRunStartedAt/);
});