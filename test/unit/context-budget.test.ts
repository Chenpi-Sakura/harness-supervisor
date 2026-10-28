import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENTS_BUDGET_BYTES,
  MAX_COMPACT_EVENTS,
  STATUS_BUDGET_BYTES,
  compactEvent,
  compactStatus,
  fitByChars,
  jsonBytes,
  lifecycleEvents,
  packCompactEvents,
  readCompactEvents,
  resultPreview,
  textPreview,
} from "../../src/context-budget.js";
import type { ReadEventsResult, WorkerEvent, WorkerStatusResult, WorkerSummary } from "../../src/types.js";

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: "w-test",
    runtime: "pi",
    cwd: "D:\\work",
    prompt: "do the thing",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    lastSeq: 3,
    eventCount: 3,
    resumeAvailable: true,
    pidAlive: false,
    ...overrides,
  } as WorkerSummary;
}

function event(seq: number, type: WorkerEvent["type"], data?: Record<string, unknown>): WorkerEvent {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return { seq, workerId: "w-test", ts, type, ...(data ? { data } : {}) };
}

test("jsonBytes measures UTF-8 bytes, not characters", () => {
  assert.equal(jsonBytes("abc"), 5);
  assert.equal(jsonBytes("中文"), 8, "two CJK chars become 2 bytes of quotes plus 6 bytes of text");
  assert.ok(jsonBytes("中文") > "中文".length);
});

test("textPreview reports the stored length and never claims a truncated text is complete", () => {
  assert.deepEqual(textPreview("abc", 10), { preview: "abc", chars: 3, truncated: false });
  assert.deepEqual(textPreview("abcdef", 2), { preview: "ab", chars: 6, truncated: true });
});

test("resultPreview keeps the storage-level truncation flag", () => {
  const stored = resultPreview({ text: "stored prefix", truncated: true }, 500);
  assert.equal(stored.preview, "stored prefix");
  assert.equal(stored.chars, "stored prefix".length, "chars is the stored length, not the original");
  assert.equal(stored.truncated, true, "an explicitly full read cannot recover the clipped tail");
  assert.equal(stored.storedTruncated, true);
  assert.equal("storedTruncated" in resultPreview({ text: "short", truncated: false }, 500), false);
});

test("fitByChars returns the largest fitting value and flags an impossible budget", () => {
  const fitted = fitByChars(1000, (chars) => ({ text: "x".repeat(chars) }), 120);
  assert.equal(fitted.overflow, false);
  assert.ok(jsonBytes(fitted.value) <= 120);
  assert.ok(fitted.chars > 0);
  assert.ok(jsonBytes({ text: "x".repeat(fitted.chars + 1) }) > 120);

  const impossible = fitByChars(10, (chars) => ({ text: "x".repeat(chars), pad: "y".repeat(500) }), 100);
  assert.equal(impossible.overflow, true);
  assert.equal(impossible.chars, 0);
});

test("lifecycleEvents drops progress", () => {
  const events = [event(1, "run.started"), event(2, "run.progress", { kind: "tool_start" }), event(3, "run.completed")];
  assert.deepEqual(lifecycleEvents(events).map((item) => item.seq), [1, 3]);
});

test("compactEvent only dedupes the current run's completion text", () => {
  const startedAt = "2026-01-01T00:00:05.000Z";
  const summary = worker({
    startedAt,
    status: "completed",
    result: { text: "NEW RESULT BODY", truncated: false },
  });

  const current: WorkerEvent = {
    seq: 9,
    workerId: "w-test",
    ts: "2026-01-01T00:00:06.000Z",
    type: "run.completed",
    data: { text: "NEW RESULT BODY" },
  };
  assert.equal("summary" in compactEvent(current, summary, 160), false);

  // A historical completion whose text is a prefix of the *new* result must not
  // be dropped: it belongs to an older run.
  const historical: WorkerEvent = {
    seq: 4,
    workerId: "w-test",
    ts: "2026-01-01T00:00:01.000Z",
    type: "run.completed",
    data: { text: "NEW RESULT BODY" },
  };
  assert.equal(compactEvent(historical, summary, 160).summary, "NEW RESULT BODY");
});

test("packCompactEvents drops the oldest event only when even empty summaries do not fit", () => {
  const summary = worker();
  const events = Array.from({ length: 30 }, (_, index) =>
    event(index + 1, "run.failed", { reason: `failure ${index + 1} `.repeat(20) }),
  );
  const packed = packCompactEvents(events, summary, { limit: 10, budgetBytes: 400 });
  assert.ok(packed.events.length < 10, "the budget must reduce the window");
  assert.ok(packed.omitted > 0);
  assert.equal(packed.events.at(-1)?.seq, 30, "the newest event survives; only older ones are dropped");
  assert.ok(jsonBytes(packed.events) <= 400);
});

test("packCompactEvents can budget the whole envelope instead of the array", () => {
  const summary = worker();
  const events = Array.from({ length: 10 }, (_, index) =>
    event(index + 1, "run.failed", { reason: "failure ".repeat(30) }),
  );
  const packed = packCompactEvents(events, summary, {
    limit: 10,
    budgetBytes: 600,
    wrap: (list, omitted) => ({ worker: { id: "w-test" }, events: list, eventsOmitted: omitted, pad: "x".repeat(100) }),
  });
  assert.ok(jsonBytes({ worker: { id: "w-test" }, events: packed.events, eventsOmitted: packed.omitted, pad: "x".repeat(100) }) <= 600);
});

test("compactStatus stays inside 2 KiB and keeps status plus truncation markers", () => {
  const longText = "REPORT ".repeat(4000);
  const result: WorkerStatusResult = {
    worker: worker({
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      result: { text: longText, truncated: false },
      lastSeq: 12,
    }),
    recentEvents: [
      event(1, "run.started"),
      event(2, "run.progress", { kind: "tool_start", tool: "bash" }),
      event(12, "run.completed", { text: longText.slice(0, 500) }),
    ],
    stderrTail: "noise",
  };
  const compact = compactStatus(result) as {
    worker: { status: string; result: { preview: string; chars: number; truncated: boolean } };
    recentEvents: Array<{ type: string; summary?: string }>;
    eventsOmitted?: number;
  };
  assert.equal(jsonBytes(compact) <= STATUS_BUDGET_BYTES, true);
  assert.equal(compact.worker.status, "completed");
  assert.equal(compact.worker.result.chars, longText.length, "the stored length is always reported");
  assert.equal(compact.worker.result.truncated, true);
  assert.ok(compact.worker.result.preview.length < longText.length);
  assert.equal("stderrTail" in compact, false);
  assert.equal(compact.recentEvents.some((item) => item.type === "run.progress"), false);
  assert.equal(
    compact.recentEvents.some((item) => item.type === "run.completed" && "summary" in item),
    false,
    "the current run's completion text is not repeated next to the result",
  );
});

test("compactStatus marks a clipped pending input and reports how many options exist", () => {
  const message = "Please confirm the following operation. ".repeat(40);
  const options = Array.from({ length: 30 }, (_, index) => `option-${index + 1}`);
  const result: WorkerStatusResult = {
    worker: worker({
      status: "awaiting_input",
      pendingInput: {
        requestId: "req-1",
        method: "select",
        title: "Pick one",
        message,
        options,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }),
    recentEvents: [],
    stderrTail: "",
  };
  const compact = compactStatus(result) as {
    worker: {
      pendingInput: {
        message: { preview: string; chars: number; truncated: boolean };
        options: string[];
        optionsTotal?: number;
      };
    };
  };
  const pending = compact.worker.pendingInput;
  assert.equal(pending.message.truncated, true, "a clipped question must say so");
  assert.equal(pending.message.chars, message.length, "the real length stays visible");
  assert.ok(pending.message.preview.length < message.length);
  assert.equal(pending.options.length, 20);
  assert.equal(pending.optionsTotal, 30, "the total option count is never hidden");
  assert.equal(jsonBytes(compact) <= STATUS_BUDGET_BYTES, true);
});

test("compactStatus keeps statusReason and event summaries when there is no result body", () => {
  const result: WorkerStatusResult = {
    worker: worker({
      status: "running",
      statusReason: "max_duration_exceeded",
      result: undefined,
      error: undefined,
    }),
    recentEvents: [event(5, "run.failed", { reason: "the harness exited unexpectedly" })],
    stderrTail: "",
  };
  const compact = compactStatus(result) as {
    worker: { statusReason?: string };
    recentEvents: Array<{ summary?: string }>;
  };
  assert.equal(compact.worker.statusReason, "max_duration_exceeded", "the reason is not blanked by an empty body");
  assert.equal(compact.recentEvents[0]?.summary, "the harness exited unexpectedly");
});

test("compactStatus keeps a failure error even when the budget is tight", () => {
  const result: WorkerStatusResult = {
    worker: worker({ status: "failed", result: undefined, error: "boom ".repeat(500), statusReason: "boom ".repeat(500) }),
    recentEvents: [],
    stderrTail: "",
  };
  const compact = compactStatus(result) as {
    worker: { status: string; error?: { preview: string; chars: number } };
  };
  assert.equal(jsonBytes(compact) <= STATUS_BUDGET_BYTES, true);
  assert.equal(compact.worker.status, "failed");
  assert.ok(compact.worker.error, "the error is the reason the caller reads a failed worker");
  assert.ok(compact.worker.error!.chars > 0);
  assert.ok(compact.worker.error!.preview.length > 0);
});

function fakeReader(events: WorkerEvent[], lastSeq: number) {
  return async (options: { sinceSeq: number; limit: number }): Promise<ReadEventsResult> => {
    const slice = events.filter((item) => item.seq > options.sinceSeq).slice(0, options.limit);
    // Real stores report the last returned seq as the next cursor (exclusive).
    const nextSeq = slice.length > 0 ? slice[slice.length - 1]!.seq : options.sinceSeq;
    return {
      worker: worker({ lastSeq, eventCount: events.length }),
      events: slice,
      nextSeq,
      hasMore: events.some((item) => item.seq > nextSeq),
    };
  };
}

test("readCompactEvents returns a lifecycle tail snapshot without progress", async () => {
  const events: WorkerEvent[] = [];
  for (let seq = 1; seq <= 200; seq += 1) {
    events.push(
      seq % 10 === 0
        ? event(seq, seq === 200 ? "run.completed" : "run.needs_input", { method: "confirm" })
        : event(seq, "run.progress", { kind: "tool_start", tool: "bash" }),
    );
  }
  const seen: Array<{ sinceSeq: number; limit: number }> = [];
  const inner = fakeReader(events, 200);
  const read = await readCompactEvents(
    async (options) => {
      seen.push(options);
      return inner(options);
    },
    { budgetBytes: EVENTS_BUDGET_BYTES },
  );
  assert.ok(seen.length > 0);
  for (const call of seen) {
    assert.ok(call.limit <= 500, "a scan window must stay within the IPC limit cap");
  }
  assert.ok(read.events.length > 0);
  assert.ok(read.events.length <= MAX_COMPACT_EVENTS);
  assert.equal(read.events.some((item) => item.type === "run.progress"), false);
  assert.equal(read.events.at(-1)?.seq, 200, "the newest lifecycle event is included");
  assert.ok(read.progressOmitted > 0);
  assert.ok(jsonBytes(read) <= EVENTS_BUDGET_BYTES);
});

test("readCompactEvents dedupes overlapping scan pages and keeps the newest cursor", async () => {
  const events: WorkerEvent[] = [];
  for (let seq = 1; seq <= 1000; seq += 1) {
    events.push(
      seq === 701 || seq === 1000
        ? event(seq, "run.completed", { text: `completion ${seq}` })
        : event(seq, "run.progress", { kind: "tool_start", tool: "bash" }),
    );
  }
  const read = await readCompactEvents(fakeReader(events, 1000), { budgetBytes: EVENTS_BUDGET_BYTES });
  const seqs = read.events.map((item) => item.seq);
  assert.equal(new Set(seqs).size, seqs.length, "no event may appear twice");
  assert.deepEqual(seqs, [701, 1000]);
  assert.equal(read.nextSeq, 1000, "the cursor comes from the newest window");
  assert.equal(read.hasMore, false);
  assert.equal(
    read.progressOmitted,
    898,
    "three 300-event pages minus the two lifecycle events; overlapping seqs are not double-counted",
  );
});

test("readCompactEvents keeps strict cursor semantics when sinceSeq is given", async () => {
  const events = [
    event(1, "run.started"),
    event(2, "run.progress", { kind: "tool_start" }),
    event(3, "run.progress", { kind: "tool_end" }),
    event(4, "run.completed", { text: "done" }),
  ];
  const onlyProgress = await readCompactEvents(fakeReader(events, 4), {
    sinceSeq: 1,
    limit: 2,
    budgetBytes: EVENTS_BUDGET_BYTES,
  });
  assert.deepEqual(onlyProgress.events, [], "a progress-only window returns no lifecycle events");
  assert.equal(onlyProgress.progressOmitted, 2);
  assert.equal(onlyProgress.nextSeq, 3, "the cursor is the last returned seq, as the store reports");

  const mixed = await readCompactEvents(fakeReader(events, 4), {
    sinceSeq: 2,
    limit: 2,
    budgetBytes: EVENTS_BUDGET_BYTES,
  });
  assert.deepEqual(mixed.events.map((item) => item.seq), [4]);
  assert.equal(mixed.progressOmitted, 1);
  assert.equal(mixed.nextSeq, 4);
});

test("readCompactEvents budgets the whole response, not just the event array", async () => {
  const events: WorkerEvent[] = [];
  for (let seq = 1; seq <= 200; seq += 1) {
    events.push(event(seq, "run.needs_input", { message: `${"detail ".repeat(40)}#${seq}` }));
  }
  const read = await readCompactEvents(fakeReader(events, 200), {
    sinceSeq: 0,
    limit: 100,
    budgetBytes: EVENTS_BUDGET_BYTES,
  });
  assert.ok(jsonBytes(read) <= EVENTS_BUDGET_BYTES, `serialized response ${jsonBytes(read)} exceeds 4 KiB`);
  assert.ok(read.events.length > 0);
  assert.ok((read.eventsOmitted ?? 0) > 0, "trimmed events are counted, not hidden");
});