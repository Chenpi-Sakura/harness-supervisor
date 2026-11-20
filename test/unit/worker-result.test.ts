import { test } from "node:test";
import assert from "node:assert/strict";
import { SupervisorError } from "../../src/errors.js";
import {
  MAX_RESULT_REPORT_CHARS,
  compactTurnResult,
  currentTurn,
  executionEvidence,
  parseStructuredResult,
} from "../../src/worker-result.js";
import type { WorkerRecord } from "../../src/types.js";

function baseRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    schemaVersion: 1,
    id: "w-1",
    runtime: "pi",
    cwd: "/tmp",
    promptPreview: "prompt",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeq: 0,
    eventCount: 0,
    stats: { turns: 1, toolCalls: 0, toolErrors: 0 },
    capabilities: {} as WorkerRecord["capabilities"],
    config: {} as WorkerRecord["config"],
    resumeCount: 0,
    supervisorId: "s-1",
    ...overrides,
  };
}

test("structured results are validated and size-capped", () => {
  const parsed = parseStructuredResult({
    v: 1,
    summary: "done",
    thresholds: [{ name: "p95", requested: "100ms", adopted: "120ms", met: true }],
  });
  assert.equal(parsed.summary, "done");

  assert.throws(
    () => parseStructuredResult({ v: 1, summary: "x", unknown: true }),
    (error: unknown) => error instanceof SupervisorError && error.code === "BAD_REQUEST",
  );
  assert.throws(
    () => parseStructuredResult({ v: 1, summary: "x".repeat(MAX_RESULT_REPORT_CHARS + 1) }),
    (error: unknown) => error instanceof SupervisorError && error.code === "BAD_REQUEST",
  );
});

test("currentTurn keeps legacy records usable and execution evidence stays authoritative", () => {
  assert.equal(currentTurn(baseRecord()), 1);
  assert.equal(currentTurn(baseRecord({ turn: 3 })), 3);
  assert.equal(currentTurn(baseRecord({ turn: undefined })), 1);

  const missing = executionEvidence(baseRecord());
  assert.deepEqual(missing, { exitCode: null, signal: null, source: "missing" });
  const exited = executionEvidence(
    baseRecord({ exit: { code: 2, signal: null, at: "2026-01-01T00:00:00.000Z" } }),
  );
  assert.equal(exited.exitCode, 2);
  assert.equal(exited.source, "worker_process");
});

test("compactTurnResult keeps the requested and adopted thresholds plus counts", () => {
  const report = parseStructuredResult({
    v: 1,
    summary: "bench",
    inputs: { n: 4 },
    config: { mode: "strict" },
    thresholds: [{ name: "p95", requested: "100ms", adopted: "120ms", unit: "ms", met: false }],
    items: [{ name: "sample", status: "failed", artifact: "out.txt" }],
    anomalies: ["warmup excluded"],
    artifacts: [{ name: "out", path: "out.txt" }],
  });
  const compact = compactTurnResult({
    turn: 2,
    submittedAt: "2026-01-01T00:00:00.000Z",
    report,
    execution: { exitCode: 0, signal: null, source: "worker_process" },
  }) as {
    turn: number;
    thresholds: Array<{ requested: string; adopted: string }>;
    counts: Record<string, number>;
    items: Array<{ status: string; artifact: string }>;
  };
  assert.equal(compact.turn, 2);
  assert.equal(compact.thresholds[0]?.requested, "100ms");
  assert.equal(compact.thresholds[0]?.adopted, "120ms");
  assert.equal(compact.counts.inputs, 1);
  assert.equal(compact.counts.artifacts, 1);
  assert.equal(compact.items[0]?.status, "failed");
});
