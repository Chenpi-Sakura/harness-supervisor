import { test } from "node:test";
import assert from "node:assert/strict";
import { SupervisorError } from "../../src/errors.js";
import {
  MCP_MODE_ENV,
  formatToolError,
  presentAcceptedWorker,
  presentEventsDevelopment,
  presentForgetResult,
  presentInfo,
  presentMetricsReport,
  presentNotificationAck,
  presentNotifications,
  presentStatus,
  presentTaskCreated,
  presentTaskMetrics,
  presentUsageRecord,
  presentWait,
  presentWorkerAdmin,
  presentWorkerDevelopment,
  presentWorkerList,
  resolveMcpMode,
} from "../../src/mcp-presentation.js";
import type {
  NotificationsResult,
  ReadEventsResult,
  SupervisorInfo,
  WaitResult,
  WorkerEvent,
  WorkerSummary,
} from "../../src/types.js";
import type { MetricsReport, TaskMetrics, TaskRecord, UsageRecord } from "../../src/metrics.js";

test("accepted worker presentation keeps the notification binding", () => {
  const worker = {
    id: "w-1",
    runtime: "pi",
    status: "running",
    lastSeq: 2,
    notifyTarget: { channel: "codex-queue", codexThreadId: "thread-a" },
    notificationBinding: {
      target: {
        channel: "codex-queue",
        codexThreadId: "thread-a",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      source: "explicit",
      wake: "bound",
      observation: "wake",
      warnings: [],
    },
  } as unknown as WorkerSummary;
  const view = presentAcceptedWorker(worker, "production") as {
    notificationBinding: {
      target: Record<string, unknown>;
      source: string;
      wake: string;
      observation: string;
      warnings: string[];
    };
  };
  assert.equal(view.notificationBinding.source, "explicit");
  assert.equal(view.notificationBinding.wake, "bound");
  assert.equal(view.notificationBinding.observation, "wake");
  assert.equal(view.notificationBinding.target.codexThreadId, "thread-a");
  assert.equal(
    "updatedAt" in view.notificationBinding.target,
    false,
    "the binding target uses the same compact shape as notifyTarget",
  );
  assert.deepEqual(view.notificationBinding.warnings, []);
});

test("explicit history marks superseded input as non-actionable in production", () => {
  const result: NotificationsResult = {
    notifications: [{id: "w#4", workerId: "w", runtime: "mcode", seq: 4,
      eventType: "run.needs_input", kind: "needs_input", createdAt: "2026-10-23T00:00:00Z",
      summary: {requestId: "0", text: "old question"},
      delivery: {state: "superseded", channel: "codex-queue", attempts: 0}}],
    counts: {pending: 0, delivered: 0, failed: 0, superseded: 1, unacked: 0},
    target: {channel: "none"},
  };
  const view = presentNotifications(result, "production") as {notifications: {actionable?: boolean; acked: boolean}[]};
  assert.equal(view.notifications[0]?.actionable, false);
  assert.equal(view.notifications[0]?.acked, false, "superseding is not a consumer acknowledgement");
  const compact = view.notifications[0] as unknown as Record<string, unknown>;
  assert.equal("delivery" in compact, false);
  const debug = presentNotifications(result, "development") as {
    notifications: { delivery: { state: string }; createdAt: string; target?: unknown }[];
  };
  assert.equal(debug.notifications[0]?.delivery.state, "superseded");
  assert.equal(debug.notifications[0]?.createdAt, result.notifications[0]?.createdAt);
});

test("notification presentation preserves read-time freshness and old-daemon compatibility", () => {
  const notification = {
    id: "w#4", workerId: "w", runtime: "pi", seq: 4,
    eventType: "run.needs_input", kind: "needs_input" as const,
    createdAt: "2026-11-11T00:00:00Z", summary: { requestId: "old" },
    delivery: { state: "delivered" as const, channel: "codex-queue", attempts: 1 },
  };
  const result: NotificationsResult = {
    notifications: [notification],
    counts: { pending: 0, delivered: 1, failed: 0, unacked: 1 },
    target: { channel: "none" },
  };
  for (const mode of ["production", "development"] as const) {
    const legacy = presentNotifications(result, mode) as { notifications: Record<string, unknown>[] };
    assert.equal(legacy.notifications[0]?.actionable, true);
    const current = presentNotifications({
      ...result,
      notifications: [{ ...notification, actionable: false, staleReason: "request already answered" }],
    }, mode) as { notifications: Record<string, unknown>[] };
    assert.equal(current.notifications[0]?.actionable, false);
    assert.equal(current.notifications[0]?.staleReason, "request already answered");
    assert.equal(current.notifications[0]?.acked, false, "freshness must never act as an acknowledgement");
    if (mode === "production") assert.equal(current.notifications[0]?.deliveryState, "delivered");
    else assert.equal((current.notifications[0]?.delivery as { state: string }).state, "delivered");
  }
});

test("notification presentation labels global counts and never relabels them as filtered", () => {
  const base: NotificationsResult = {
    notifications: [],
    counts: { pending: 7, delivered: 119, failed: 0, superseded: 0, unacked: 10 },
    target: { channel: "none" },
  };
  const legacy = presentNotifications(base, "production") as Record<string, unknown>;
  assert.equal(legacy.countsScope, "global");
  assert.deepEqual(legacy.counts, base.counts);
  assert.equal("filteredCounts" in legacy, false);
  assert.equal("globalCounts" in legacy, false);

  const scoped = presentNotifications(
    {
      ...base,
      filteredCounts: { pending: 1, delivered: 0, failed: 0, unacked: 1 },
      globalCounts: base.counts,
      scope: { state: "pending", workerId: "w-1", unacknowledgedOnly: true, limit: 50, returned: 0 },
    },
    "production",
  ) as Record<string, unknown>;
  assert.deepEqual(scoped.filteredCounts, {
    pending: 1,
    delivered: 0,
    failed: 0,
    unacked: 1,
  });
  assert.deepEqual(scoped.globalCounts, base.counts);
  assert.deepEqual(scoped.scope, {
    state: "pending",
    workerId: "w-1",
    unacknowledgedOnly: true,
    limit: 50,
    returned: 0,
  });
});

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

test("development events keep raw data behind the explicit worker whitelist", () => {
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
      session: { available: false, restorable: false },
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

  const development = presentEventsDevelopment(result) as any;
  assert.equal(
    "promptPreview" in development.worker,
    false,
    "development is an explicit whitelist, not the raw WorkerSummary",
  );
  assert.equal("schemaVersion" in development.worker, false);
  assert.equal(development.worker.eventCount, 2);
  assert.equal(development.events[0].notifyTarget.codexThreadId, "thread-1");
  assert.equal(development.events[1].data.sessionFile, "C:/secrets/session.jsonl");
  assert.equal(development.nextSeq, 2);
  assert.equal(development.hasMore, false);
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

test("production wait returns the final result without events unless until=event", () => {
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
  const progress = {
    seq: 21,
    workerId: "w-1",
    ts: "2026-01-02T00:00:09.000Z",
    type: "run.progress",
    data: { kind: "assistant_message", preview: "streamed token" },
  } as WorkerEvent;

  const completedResult = waitFixture(
    {
      status: "completed",
      startedAt: "2026-01-02T00:00:00.000Z",
      result: { text: "NEW_RUN_REPORT", truncated: false },
    },
    [oldEvent, progress, currentEvent],
  );
  const compacted = {
    events: [oldEvent, progress, currentEvent],
    eventsOmitted: 0,
    progressOmitted: 1,
  };

  const defaultView = presentWait(completedResult, compacted, "production") as any;
  assert.equal(defaultView.worker.result.text, "NEW_RUN_REPORT");
  assert.equal("events" in defaultView, false, "completion carries the result, not an event log");
  assert.equal("progressOmitted" in defaultView, false);
  assert.equal("lastProgress" in defaultView, false);
  assert.equal("timeline" in defaultView, false);

  const withEvents = presentWait(completedResult, compacted, "production", {
    includeEvents: true,
  }) as any;
  assert.equal(withEvents.events.length, 2, "progress is never returned in production");
  assert.equal(
    withEvents.events.some((event: { type: string }) => event.type === "run.progress"),
    false,
  );
  assert.deepEqual(Object.keys(withEvents.events[0]).sort(), ["seq", "summary", "ts", "type"]);
  assert.equal(withEvents.events[0].summary, "OLD_RUN_REPORT");
  assert.equal(
    "summary" in withEvents.events[1],
    false,
    "the current run's completion text already appears in worker.result",
  );
  assert.equal(withEvents.progressOmitted, 1);
  assert.equal(JSON.stringify(withEvents).split("NEW_RUN_REPORT").length - 1, 1);

  const manyEvents = Array.from({ length: 20 }, (_, index) => ({
    seq: index + 1,
    workerId: "w-1",
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    type: "worker.started",
    data: {},
  })) as WorkerEvent[];
  const manyView = presentWait(
    waitFixture({ status: "running" }, manyEvents),
    { events: manyEvents, eventsOmitted: 0, progressOmitted: 0 },
    "production",
    { includeEvents: true },
  ) as any;
  assert.ok(manyView.events.length <= 10, "a wait event batch is bounded");
  assert.ok(manyView.events.length > 0);
  assert.equal(
    manyView.eventsOmitted,
    manyEvents.length - manyView.events.length,
    "bounded wait events report what was omitted",
  );
});

test("production wait timeout is a status check, not a progress dump", () => {
  const result = {
    ...waitFixture({ status: "running" }, []),
    timedOut: true,
    lastProgress: {
      state: "available" as const,
      text: "streamed token",
      chars: 14,
      truncated: false,
      evidence: "partial_progress" as const,
    },
    timeline: {
      createdAt: "2026-01-01T00:00:00.000Z",
      resumeCount: 0,
      segmentsTotal: 0,
      segments: [],
      note: "",
    },
    inputState: { state: "unknown" as const, nextActions: [] },
  };
  const view = presentWait(result, { events: [], eventsOmitted: 0 }, "production", {
    includeEvents: true,
  }) as any;
  assert.deepEqual(Object.keys(view).sort(), [
    "hasMore",
    "nextSeq",
    "terminal",
    "timedOut",
    "worker",
  ]);
  assert.equal(view.timedOut, true);
  assert.equal("events" in view, false);
  assert.equal("lastProgress" in view, false);
  assert.equal("timeline" in view, false);
  assert.equal("inputState" in view, false);
});

test("production status is a bounded snapshot while wait carries the full result", () => {
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
  const worker = {
    id: "w-1",
    runtime: "pi",
    cwd: "C:/work",
    status: "awaiting_input",
    lastSeq: 10,
    result: { text, truncated: false },
    pendingInput,
    resumeAvailable: false,
    session: { available: false, restorable: false },
  } as unknown as WorkerSummary;
  const status = {
    worker,
    recentEvents: [
      {
        seq: 9,
        workerId: "w-1",
        ts: "2026-01-01T00:00:09.000Z",
        type: "run.progress",
        data: { kind: "assistant_message", preview: "streamed token" },
      },
      {
        seq: 10,
        workerId: "w-1",
        ts: "2026-01-01T00:00:10.000Z",
        type: "run.needs_input",
        data: { requestId: "ui-1" },
      },
    ] as WorkerEvent[],
    stderrTail: "diagnostic only",
    lastProgress: {
      state: "available" as const,
      text: "streamed token",
      chars: 14,
      truncated: false,
      evidence: "partial_progress" as const,
    },
    timeline: {
      createdAt: "2026-01-01T00:00:00.000Z",
      resumeCount: 0,
      segmentsTotal: 0,
      segments: [],
      note: "",
    },
    inputState: { state: "unknown" as const, nextActions: [] },
  };

  const view = presentStatus(status, "production") as any;
  assert.deepEqual(Object.keys(view), ["worker"]);
  assert.equal("result" in view.worker, false, "status never returns the full result");
  assert.equal(
    "error" in view.worker,
    false,
    "status never returns the full error",
  );
  assert.equal(view.worker.resultAvailable, true);
  assert.equal(view.worker.errorAvailable, false);
  assert.equal(view.worker.resultPreview.truncated, true);
  assert.ok(view.worker.resultPreview.preview.length < text.length);
  assert.equal("cwd" in view.worker, false);
  assert.equal("recentEvents" in view, false);
  assert.equal("lastProgress" in view, false);
  assert.equal("timeline" in view, false);
  assert.equal("inputState" in view, false);
  assert.equal("stderrTail" in view, false);
  assert.deepEqual(view.worker.lastEvent, { seq: 10, type: "run.needs_input" });
  assert.equal(
    typeof view.worker.pendingInput.message,
    "object",
    "the default status input stays a bounded preview",
  );

  const withInput = presentStatus(status, "production", { includeInput: true }) as any;
  assert.deepEqual(withInput.worker.pendingInput, pendingInput);

  const waited = presentWait(
    {
      ...waitFixture(
        {
          status: "awaiting_input",
          result: { text, truncated: false },
          pendingInput,
        },
        [],
      ),
      terminal: false,
    },
    { events: [], eventsOmitted: 0 },
    "production",
  ) as any;
  assert.equal(waited.worker.result.text, text, "wait is the full-result path");
  assert.equal(waited.worker.result.text.length, text.length);
  assert.deepEqual(waited.worker.pendingInput, pendingInput);

  const development = presentStatus(status, "development") as any;
  assert.equal(development.worker.result.text, text);
  assert.deepEqual(development.worker.pendingInput, pendingInput);
  assert.equal(development.recentEvents.length, 2);
  assert.equal(development.stderrTail, "diagnostic only");
  assert.equal("promptPreview" in development.worker, false);
});

test("production status budgets long native input labels without changing answer values", () => {
  const pendingInput = {
    requestId: "request-1",
    method: "select" as const,
    title: "审批标题".repeat(250),
    message: "请检查完整的操作说明后选择。".repeat(100),
    options: Array.from({ length: 20 }, (_, index) => `${index}:` + "选项".repeat(500)),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
  };
  const original = structuredClone(pendingInput);
  const worker = {
    id: "w-long-input",
    runtime: "pi",
    cwd: `D:/${"目录".repeat(1000)}`,
    name: "任务".repeat(100),
    taskId: "t".repeat(120),
    status: "awaiting_input",
    persistence: "persistent",
    lifecycle: "awaiting_input",
    lastSeq: 10,
    pendingInput,
    resumeAvailable: false,
    session: { available: true, restorable: false, reason: "process_may_be_running" },
  } as unknown as WorkerSummary;
  const status = { worker, recentEvents: [], stderrTail: "" };
  const view = presentStatus(status, "production") as any;
  assert.ok(Buffer.byteLength(JSON.stringify(view), "utf8") <= 2048);
  assert.equal(view.budgetExceeded, undefined);
  const input = view.worker.pendingInput;
  assert.equal(input.truncated, true);
  assert.equal(input.fullInputAvailable, true);
  assert.equal(input.optionsTotal, pendingInput.options.length);
  assert.ok(input.options.length < pendingInput.options.length);
  for (const option of input.options) {
    assert.ok(pendingInput.options.includes(option), "displayed choices must remain valid native answers");
  }
  assert.deepEqual(pendingInput, original, "budgeting cannot mutate the native input");
  const explicit = presentStatus(status, "production", { includeInput: true }) as any;
  assert.deepEqual(explicit.worker.pendingInput, original);
});

test("production status budgets oversized native request ids with an explicit full-read marker", () => {
  const pendingInput = {
    requestId: "native-request-" + "x".repeat(5000),
    method: "confirm" as const,
    title: "Allow?",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const worker = {
    id: "w-long-request",
    runtime: "pi",
    cwd: "D:/workspace",
    status: "awaiting_input",
    lastSeq: 10,
    pendingInput,
    resumeAvailable: false,
  } as unknown as WorkerSummary;
  const status = { worker, recentEvents: [], stderrTail: "" };
  const view = presentStatus(status, "production") as any;
  assert.ok(Buffer.byteLength(JSON.stringify(view), "utf8") <= 2048);
  assert.equal(view.worker.pendingInput.requestId, undefined, "a partial request id cannot be used as an answer id");
  assert.equal(view.worker.pendingInput.truncated, true);
  assert.equal(view.worker.pendingInput.fullInputAvailable, true);
  assert.deepEqual(
    (presentStatus(status, "production", { includeInput: true }) as any).worker.pendingInput,
    pendingInput,
  );
});

test("production info is a minimal availability snapshot; development keeps diagnostics", () => {
  // Adapter notes run to over a thousand characters. They belong to the
  // development diagnostics, never to the production response.
  const longNote =
    "MiniMax Code Agent Client Protocol (ACP) over ndJSON stdio. The protocol version was verified against a real 0.6.12 process: initialize, session/new, session/prompt, session/cancel and session/load all answered on the wire, and agent_message_chunk updates arrived during a live turn. session/prompt blocks until the turn ends and the agent rejects a second concurrent prompt. Steering goes through the mcode/session/steer extension and queued follow-ups through mcode/session/queue/enqueue; both require a build that advertises those extensions and are otherwise reported as unsupported. Permission requests arrive as client-side session/request_permission calls and are surfaced as awaiting_input; the reply must reuse the request id and one of the offered option ids. MiniMax Code itself defaults to bypassPermissions, so the worker asks the session to use the Ask mode unless HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE says otherwise. There is no sandbox: cwd is not a file-isolation boundary.";
  const info = {
    name: "harness-supervisor",
    version: "0.4.0",
    pid: 1,
    stateDir: "C:/state",
    supervisorId: "s-1",
    startedAt: "2026-10-23T00:00:00.000Z",
    uptimeMs: 1000,
    limits: {
      maxWorkers: 8,
      maxWaitMs: 120000,
      defaultWaitMs: 30000,
      closeGraceMs: 1500,
      abortTimeoutMs: 20000,
      maxResultBytes: 65536,
      maxEventStringBytes: 8192,
    },
    wake: { proactive: false, channel: "none", note: "pull-based" },
    codexSteer: {
      status: "unavailable",
      verified: { appServerRpc: false, modelApplied: false, desktopActiveTurn: false },
      reason: "not exposed by this host",
    },
    runtimes: [
      {
        runtime: "pi",
        steer: true,
        followUp: true,
        cancel: true,
        resume: true,
        pause: false,
        interactiveInput: true,
        idleContinue: "L3",
        notes: longNote,
      },
      {
        runtime: "mcode",
        steer: true,
        followUp: true,
        cancel: true,
        resume: true,
        pause: false,
        interactiveInput: true,
        notes: longNote,
      },
    ],
    storage: {
      workers: 3,
      eventBytes: 12345,
      largestEventFileBytes: 9000,
      largestEventWorkerId: "w-1",
      activeWorkers: 1,
      idleWorkers: 2,
      otherWorkers: 0,
      startup: {
        totalMs: 12,
        storeInitMs: 7,
        store: { checkpointed: 2, scanned: 1, eventBytes: 12345 },
      },
    },
  } as unknown as SupervisorInfo;

  const view = presentInfo(info, "production", "production", "cli") as any;
  assert.deepEqual(Object.keys(view).sort(), [
    "mcpMode",
    "running",
    "runtimes",
    "version",
    "workers",
  ]);
  assert.equal(view.running, true);
  assert.deepEqual(view.runtimes, [
    { runtime: "pi", available: true },
    { runtime: "mcode", available: true },
  ]);
  assert.deepEqual(view.workers, { active: 1, total: 3 });
  assert.equal(view.mcpMode, "production");
  assert.equal(
    "mcpModeSource" in view,
    false,
    "resolved mode provenance is a diagnostic, not a production decision input",
  );
  for (const key of ["pid", "stateDir", "supervisorId", "uptimeMs", "limits", "wake", "storage"]) {
    assert.equal(key in view, false, `${key} must not leak into the production info`);
  }
  assert.doesNotMatch(JSON.stringify(view), /session\/prompt/);

  const unknownStorage = presentInfo(
    { ...info, storage: undefined } as unknown as SupervisorInfo,
    "production",
    "production",
  ) as any;
  assert.equal(unknownStorage.workersKnown, false);
  assert.equal("workers" in unknownStorage, false);

  const development = presentInfo(info, "development", "development", "environment") as any;
  assert.equal(development.pid, 1);
  assert.equal(development.stateDir, "C:/state");
  assert.equal(development.mcpModeSource, "environment");
  assert.deepEqual(development.limits, info.limits);
  assert.deepEqual(development.wake, info.wake);
  assert.deepEqual(development.storage, info.storage);
  const pi = development.runtimes.find((runtime: { runtime: string }) => runtime.runtime === "pi");
  assert.equal(pi.idleContinue, "L3");
  assert.equal(pi.notes, longNote);
});

test("development worker views tolerate an old daemon without a session projection", () => {
  const legacy = {
    id: "w-legacy",
    runtime: "pi",
    cwd: "C:/work",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeq: 3,
    eventCount: 3,
    resumeCount: 0,
    resumeAvailable: false,
    pidAlive: null,
  } as unknown as WorkerSummary;
  const view = presentWorkerDevelopment(legacy) as Record<string, unknown>;
  assert.equal("session" in view, false, "an unreported session must stay absent, not be invented");
  assert.equal(view.id, "w-legacy");
  assert.doesNotThrow(() => presentAcceptedWorker(legacy, "development"));
  assert.doesNotThrow(() => presentWorkerList([legacy], "development"));
});

test("admin presentation carries management flags and hides them when absent", () => {
  const base = {
    id: "w-1",
    status: "completed",
    lifecycle: "idle",
    lastSeq: 7,
  } as unknown as WorkerSummary;
  const plain = presentWorkerAdmin(base, "production") as Record<string, unknown>;
  assert.deepEqual(Object.keys(plain).sort(), ["id", "lastSeq", "lifecycle", "status"]);

  const managed = presentWorkerAdmin(
    { ...base, pinned: true, archived: true, retiredAt: "2026-11-09T00:00:00.000Z" } as WorkerSummary,
    "production",
  ) as Record<string, unknown>;
  assert.equal(managed.pinned, true);
  assert.equal(managed.archived, true);
  assert.equal(managed.retiredAt, "2026-11-09T00:00:00.000Z");
  assert.equal("promptPreview" in managed, false);
});

test("worker list has one envelope in both modes and stays a summary in production", () => {
  const worker = {
    id: "w-1",
    runtime: "pi",
    cwd: "C:/work",
    status: "awaiting_input",
    persistence: "persistent",
    lifecycle: "active",
    lastSeq: 12,
    session: {
      available: true,
      restorable: true,
      ref: { runtime: "pi", runtimeInstanceRef: "r-1", sessionId: "s-1" },
    },
    promptPreview: "secret prompt",
    result: { text: "secret result", truncated: false },
  } as unknown as WorkerSummary;

  const production = presentWorkerList([worker], "production", {
    nextCursor: "w-1",
    hasMore: true,
  }) as any;
  assert.deepEqual(Object.keys(production).sort(), ["hasMore", "nextCursor", "workers"]);
  assert.equal(production.hasMore, true);
  assert.equal(production.nextCursor, "w-1");
  assert.deepEqual(Object.keys(production.workers[0]).sort(), [
    "id",
    "lastSeq",
    "lifecycle",
    "needsInput",
    "persistence",
    "runtime",
    "status",
  ]);
  assert.equal(production.workers[0].needsInput, true);
  assert.equal("cwd" in production.workers[0], false);
  assert.equal("session" in production.workers[0], false);
  assert.equal("result" in production.workers[0], false);

  const development = presentWorkerList([worker], "development") as any;
  assert.deepEqual(Object.keys(development).sort(), ["hasMore", "nextCursor", "workers"]);
  assert.equal(development.nextCursor, null);
  assert.equal(development.hasMore, false);
  assert.equal(development.workers[0].cwd, "C:/work");
  assert.equal(development.workers[0].session.ref.sessionId, "s-1");
  assert.equal(
    "promptPreview" in development.workers[0],
    false,
    "development is an explicit whitelist, not the raw summary",
  );

  assert.deepEqual(presentWorkerList([], "production"), {
    workers: [],
    nextCursor: null,
    hasMore: false,
  });
});

test("ack and forget projections keep decision fields in both modes", () => {
  assert.deepEqual(
    presentNotificationAck({ acked: 1, missing: ["n-2"] }, "production", ["n-1", "n-2"], "master"),
    { requested: 2, acked: 1, missing: ["n-2"], by: "master" },
  );
  assert.deepEqual(
    presentNotificationAck({ acked: 1, missing: [] }, "development", ["n-1"]),
    { requested: 1, acked: 1, missing: [], requestedIds: ["n-1"] },
  );

  const forgotten = {
    workerId: "w-1",
    forgotten: true,
    sessionPreserved: true as const,
    note: "native session file was not deleted",
  };
  assert.deepEqual(presentForgetResult(forgotten, "production"), forgotten);
  assert.deepEqual(presentForgetResult(forgotten, "development"), forgotten);
});

const taskFixture: TaskRecord = {
  schemaVersion: 1,
  id: "t-1",
  title: "Ship 0.9.1",
  category: "release",
  executionMode: "delegated",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T01:00:00.000Z",
  workerIds: ["w-1"],
  parentSessionRef: "session-parent",
  acceptanceStatus: "pending",
  reworkCount: 2,
  interventionCount: 1,
  createdBy: "mcp",
};

const usageFixture: UsageRecord = {
  schemaVersion: 1,
  id: "u-1",
  taskId: "t-1",
  workerId: "w-1",
  role: "worker",
  provider: "deepseek",
  modelId: "deepseek-v4",
  harness: "pi",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  reportedTotalTokens: 165,
  usageSource: "manual",
  attribution: "exact",
  confidence: "verified",
  recordedAt: "2026-11-10T00:30:00.000Z",
  note: "measured locally",
};

const usageSummaryFixture = {
  records: 1,
  usableRecords: 1,
  verifiedRecords: 1,
  partialRecords: 0,
  unverifiedRecords: 0,
  unknownRecords: 0,
  inputTokens: { value: 100, knownRecords: 1, missingRecords: 0 },
  outputTokens: { value: 50, knownRecords: 1, missingRecords: 0 },
  cacheReadTokens: { value: 10, knownRecords: 1, missingRecords: 0 },
  cacheWriteTokens: { value: 5, knownRecords: 1, missingRecords: 0 },
  reportedTotalTokens: { value: 165, knownRecords: 1, missingRecords: 0 },
};

function metricsFixture(): TaskMetrics {
  return {
    schemaVersion: 1,
    task: { ...taskFixture },
    status: "running",
    timing: {
      createdAt: taskFixture.createdAt,
      firstStartedAt: taskFixture.createdAt,
      startedAt: taskFixture.createdAt,
      finishedAt: null,
      endToEndMs: null,
      waitingMs: 1000,
    },
    workers: [
      {
        workerId: "w-1",
        missing: false,
        runtime: "pi",
        status: "running",
        createdAt: taskFixture.createdAt,
        firstStartedAt: taskFixture.createdAt,
        startedAt: taskFixture.createdAt,
        resumeCount: 1,
        runMs: 5000,
      },
    ],
    usage: [{ ...usageFixture } as UsageRecord],
    usageSummary: {
      worker: { ...usageSummaryFixture },
      parentAttributable: { ...usageSummaryFixture, records: 0, usableRecords: 0 },
      parentSessionLevel: { ...usageSummaryFixture, records: 0, usableRecords: 0 },
      unverified: { records: 0, note: "no unverified usage" },
    },
    warnings: ["worker w-2 is missing"],
    unknownFields: ["customField"],
  };
}

test("production metrics summaries never carry raw usage or task diagnostics", () => {
  const metrics = metricsFixture();

  const task = presentTaskCreated({ ...taskFixture } as any, "production") as any;
  assert.deepEqual(Object.keys(task).sort(), [
    "category",
    "createdAt",
    "parentSessionRef",
    "taskId",
    "title",
    "workerIds",
  ]);
  assert.equal("schemaVersion" in task, false);
  assert.equal("executionMode" in task, false);
  assert.equal("acceptanceStatus" in task, false);
  assert.equal("reworkCount" in task, false);
  assert.equal("createdBy" in task, false);

  const production = presentTaskMetrics(metrics, "production") as any;
  assert.equal("usage" in production, false);
  assert.equal("schemaVersion" in production.task, false);
  assert.deepEqual(Object.keys(production.workers[0]).sort(), [
    "missing",
    "runMs",
    "status",
    "workerId",
  ]);
  assert.equal("runtime" in production.workers[0], false);
  assert.equal("resumeCount" in production.workers[0], false);

  const development = presentTaskMetrics(metrics, "development") as any;
  assert.equal(development.usage.length, 1);
  assert.equal(development.usage[0].inputTokens, 100);
  assert.equal(development.task.schemaVersion, 1);
  assert.equal(development.task.reworkCount, 2);
  assert.equal(development.workers[0].runtime, "pi");

  const usage = presentUsageRecord({ ...usageFixture } as UsageRecord, "production") as any;
  assert.equal(usage.usageId, "u-1");
  assert.equal(usage.attribution, "exact");
  for (const key of [
    "schemaVersion",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reportedTotalTokens",
    "usageSource",
    "note",
  ]) {
    assert.equal(key in usage, false, `${key} must stay out of the production usage record`);
  }
  const usageDevelopment = presentUsageRecord(
    { ...usageFixture } as UsageRecord,
    "development",
  ) as any;
  assert.equal(usageDevelopment.inputTokens, 100);
  assert.equal(usageDevelopment.note, "measured locally");
});

test("metrics report production tasks are a summary; development keeps task metrics", () => {
  const metrics = metricsFixture();
  const report = {
    schemaVersion: 1,
    generatedAt: "2026-11-10T02:00:00.000Z",
    period: { since: null, until: null, field: "task.createdAt" },
    taskCount: 1,
    workerCount: 1,
    counts: {
      running: 1,
      completed: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      unknown: 0,
    },
    usageCoverage: {
      tasks: 1,
      tasksWithWorkers: 1,
      tasksWithWorkerUsage: 1,
      tasksWithAttributableParentUsage: 0,
      tasksWithSessionLevelParentUsage: 0,
      tasksWithAnyUsableUsage: 1,
      tasksWithVerifiedUsage: 1,
      tasksWithUnverifiedUsage: 0,
      tasksWithMissingWorkers: 0,
      workerUsageRecords: 1,
      parentUsageRecords: 0,
    },
    knownWorkerUsage: { ...usageSummaryFixture },
    knownParentUsage: { ...usageSummaryFixture, records: 0 },
    sessionLevelParentUsage: { ...usageSummaryFixture, records: 0 },
    unverifiedUsage: { records: 0, taskCount: 0, note: "none" },
    durationStats: {
      endToEnd: {
        knownCount: 0,
        missingCount: 1,
        totalMs: null,
        avgMs: null,
        medianMs: null,
        minMs: null,
        maxMs: null,
      },
      workerRun: {
        knownCount: 1,
        missingCount: 0,
        totalMs: 5000,
        avgMs: 5000,
        medianMs: 5000,
        minMs: 5000,
        maxMs: 5000,
      },
      waiting: {
        knownCount: 1,
        missingCount: 0,
        totalMs: 1000,
        avgMs: 1000,
        medianMs: 1000,
        minMs: 1000,
        maxMs: 1000,
      },
      note: "durations only cover known intervals",
    },
    notTracked: {
      cost: "not tracked",
      firstPassAcceptance: "not tracked",
      rework: "not tracked",
      intervention: "not tracked",
      comparison: "not tracked",
    },
    unknownFields: [],
    dataQualityWarnings: ["one missing worker"],
    tasks: [metrics],
  } as unknown as MetricsReport;

  const production = presentMetricsReport(report, "production") as any;
  assert.deepEqual(production.period, report.period);
  assert.deepEqual(production.tasks, [
    {
      taskId: "t-1",
      title: "Ship 0.9.1",
      status: "running",
      createdAt: taskFixture.createdAt,
      workerCount: 1,
      endToEndMs: null,
    },
  ]);
  assert.equal("usage" in production.tasks[0], false);

  const development = presentMetricsReport(report, "development") as any;
  assert.equal(development.tasks[0].usage[0].inputTokens, 100);
  assert.deepEqual(development.tasks[0].usageSummary, metrics.usageSummary);
  assert.deepEqual(development.durationStats, report.durationStats);
});
