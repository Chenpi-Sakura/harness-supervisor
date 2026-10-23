import { test } from "node:test";
import assert from "node:assert/strict";
import { SupervisorError } from "../../src/errors.js";
import {
  MCP_MODE_ENV,
  formatToolError,
  presentEvents,
  presentStatus,
  presentWait,
  resolveMcpMode,
} from "../../src/mcp-presentation.js";
import type { ReadEventsResult, WaitResult, WorkerEvent, WorkerSummary } from "../../src/types.js";

test("resolveMcpMode defaults to production and rejects invalid CLI/env values", () => {
  const previous = process.env[MCP_MODE_ENV];
  try {
    delete process.env[MCP_MODE_ENV];
    assert.deepEqual(resolveMcpMode(), { mode: "production", source: "default" });
    assert.deepEqual(resolveMcpMode("development"), {
      mode: "development",
      source: "cli",
    });
    process.env[MCP_MODE_ENV] = "development";
    assert.deepEqual(resolveMcpMode(), { mode: "development", source: "environment" });
    assert.deepEqual(resolveMcpMode("production"), {
      mode: "production",
      source: "cli",
    });
    process.env[MCP_MODE_ENV] = "staging";
    assert.throws(() => resolveMcpMode(), /HARNESS_SUPERVISOR_MCP_MODE/);
    assert.throws(() => resolveMcpMode("staging"), /Invalid --mode/);
    assert.throws(() => resolveMcpMode(""), /--mode requires a value/);
  } finally {
    if (previous === undefined) delete process.env[MCP_MODE_ENV];
    else process.env[MCP_MODE_ENV] = previous;
  }
});

test("production errors keep CONFLICT/UNCERTAIN identifiers but not diagnostics", () => {
  const uncertain = new SupervisorError(
    "UNCERTAIN",
    "The daemon restarted while requestId req-1 (spawn) was being processed.",
    { requestId: "req-1", method: "spawn", workerId: "w-1", firstSeenAt: "secret-diagnostic" },
  );
  const production = formatToolError(uncertain, "production");
  assert.match(production, /^UNCERTAIN: /);
  assert.match(production, /requestId=req-1/);
  assert.match(production, /workerId=w-1/);
  assert.doesNotMatch(production, /secret-diagnostic/);
  assert.doesNotMatch(production, /firstSeenAt/);

  const development = formatToolError(uncertain, "development");
  assert.match(development, /firstSeenAt/);
  assert.match(development, /"method": "spawn"/);

  const conflict = formatToolError(
    new SupervisorError("CONFLICT", "requestId req-2 was already used", {
      requestId: "req-2",
      method: "send",
    }),
    "production",
  );
  assert.match(conflict, /^CONFLICT: /);
  assert.match(conflict, /requestId=req-2/);
});

test("production events remove management keys without touching user report content", () => {
  const result = {
    worker: {
      id: "w-1",
      status: "completed",
      lastSeq: 2,
      runtime: "pi",
      cwd: "C:/work",
      promptPreview: "secret prompt",
      supervisorId: "secret-supervisor",
      capabilities: {},
      config: {},
      stats: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      eventCount: 2,
      resumeCount: 0,
      pidAlive: null,
      resumeAvailable: false,
      schemaVersion: 1,
    } as unknown as WorkerSummary,
    events: [
      {
        seq: 1,
        workerId: "w-1",
        ts: "2026-01-01T00:00:01.000Z",
        type: "worker.session",
        data: {
          sessionId: "session-1",
          sessionFile: "C:/secrets/session.jsonl",
          fileExists: true,
        },
        notifyTarget: { channel: "codex-queue", codexThreadId: "thread-1" },
      },
      {
        seq: 2,
        workerId: "w-1",
        ts: "2026-01-01T00:00:02.000Z",
        type: "run.completed",
        data: {
          sessionFile: "C:/secrets/session.jsonl",
          pid: 1234,
          text: "FULL REPORT",
          nested: { sessionFile: "user-authored field stays" },
        },
        notifyTarget: { channel: "none" },
      },
    ],
    nextSeq: 2,
    hasMore: false,
  } as unknown as ReadEventsResult;

  const view = presentEvents(result, "production") as any;
  assert.deepEqual(Object.keys(view.worker).sort(), ["id", "lastSeq", "status"]);
  assert.equal("workerId" in view.events[0], false);
  assert.equal("notifyTarget" in view.events[0], false);
  assert.deepEqual(view.events[0].data, undefined, "management-only data is omitted");
  assert.equal("data" in view.events[0], false);
  assert.equal(view.events[1].data.sessionFile, undefined);
  assert.equal(view.events[1].data.pid, undefined);
  assert.equal(view.events[1].data.text, "FULL REPORT");
  assert.deepEqual(view.events[1].data.nested, {
    sessionFile: "user-authored field stays",
  });
  assert.equal(view.nextSeq, 2);
  assert.equal(view.hasMore, false);

  const development = presentEvents(result, "development") as any;
  assert.equal(development.worker.promptPreview, "secret prompt");
  assert.equal(development.events[0].notifyTarget.codexThreadId, "thread-1");
  assert.equal(development.events[1].data.sessionFile, "C:/secrets/session.jsonl");
});
function waitFixture(
  worker: Partial<WorkerSummary>,
  events: WorkerEvent[],
): WaitResult {
  return {
    worker: {
      id: "w-1",
      runtime: "pi",
      status: "running",
      lastSeq: events.at(-1)?.seq ?? 0,
      result: undefined,
      startedAt: undefined,
      ...worker,
    } as unknown as WorkerSummary,
    events,
    nextSeq: events.at(-1)?.seq ?? 0,
    hasMore: false,
    timedOut: false,
    terminal: worker.status === "completed",
  };
}

test("production wait dedupes only a completion text already returned in the current result", () => {
  const oldEvent = {
    seq: 10,
    workerId: "w-1",
    ts: "2026-01-01T00:00:10.000Z",
    type: "run.completed",
    data: { text: "OLD_RUN_REPORT", truncated: false, stopReason: "stop" },
  } as WorkerEvent;
  const currentEvent = {
    seq: 22,
    workerId: "w-1",
    ts: "2026-01-02T00:00:10.000Z",
    type: "run.completed",
    data: { text: "NEW_RUN_REPORT", truncated: false, stopReason: "stop" },
  } as WorkerEvent;

  // Resumed and running: worker.result is gone, so the old report must survive.
  const running = presentWait(
    waitFixture({ status: "running", startedAt: "2026-01-02T00:00:00.000Z" }, [oldEvent]),
    { events: [oldEvent], eventsOmitted: 0 },
    "production",
  ) as any;
  assert.equal(running.events[0].data.text, "OLD_RUN_REPORT");

  // The new result exists, but only the current run's event may be deduplicated.
  const completed = presentWait(
    waitFixture(
      {
        status: "completed",
        startedAt: "2026-01-02T00:00:00.000Z",
        result: { text: "NEW_RUN_REPORT", truncated: false },
      },
      [oldEvent, currentEvent],
    ),
    { events: [oldEvent, currentEvent], eventsOmitted: 0 },
    "production",
  ) as any;
  assert.equal(completed.events[0].data.text, "OLD_RUN_REPORT");
  assert.equal("text" in (completed.events[1].data ?? {}), false);

  // No result at all: nothing proves the text was returned, so keep it.
  const noResult = presentWait(
    waitFixture(
      { status: "failed", startedAt: "2026-01-02T00:00:00.000Z", result: undefined },
      [currentEvent],
    ),
    { events: [currentEvent], eventsOmitted: 0 },
    "production",
  ) as any;
  assert.equal(noResult.events[0].data.text, "NEW_RUN_REPORT");

  // Current 20 KB report: the 8 KB event prefix is deduplicated, the full
  // result remains complete and the end marker occurs exactly once.
  const fullReport = `FAKE_PI_REPORT_BEGIN
${"R".repeat(20_000)}
FAKE_PI_REPORT_END`;
  const eventPrefix = `${fullReport.slice(0, 8_192)}
...[truncated 11848 chars]`;
  const longEvent = {
    seq: 30,
    workerId: "w-1",
    ts: "2026-01-02T00:00:10.000Z",
    type: "run.completed",
    data: { text: eventPrefix, truncated: true },
  } as WorkerEvent;
  const long = presentWait(
    waitFixture(
      {
        status: "completed",
        startedAt: "2026-01-02T00:00:00.000Z",
        result: { text: fullReport, truncated: false },
      },
      [longEvent],
    ),
    { events: [longEvent], eventsOmitted: 0 },
    "production",
  ) as any;
  assert.equal(long.worker.result.text, fullReport);
  assert.equal("text" in (long.events[0].data ?? {}), false);
  assert.equal(JSON.stringify(long).split("FAKE_PI_REPORT_END").length - 1, 1);
});

test("production presentation adds no report length limit and keeps every pendingInput field", () => {
  const text = `BEGIN
${"X".repeat(100_000)}
END`;
  const pendingInput = {
    requestId: "ui-1",
    method: "select" as const,
    title: "Choose",
    message: "Pick one",
    options: ["alpha", "beta"],
    placeholder: "type here",
    prefill: "alpha",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
  };
  const view = presentStatus(
    {
      worker: {
        id: "w-1",
        runtime: "pi",
        cwd: "C:/work",
        status: "awaiting_input",
        lastSeq: 10,
        result: { text, truncated: false },
        pendingInput,
        resumeAvailable: false,
      } as unknown as WorkerSummary,
      recentEvents: [],
      stderrTail: "diagnostic only",
    },
    "production",
    { includeRecentEvents: false },
  ) as any;
  assert.equal(view.worker.result.text, text);
  assert.equal(view.worker.result.text.length, text.length);
  assert.deepEqual(view.worker.pendingInput, pendingInput);
  assert.equal("stderrTail" in view, false);
});
