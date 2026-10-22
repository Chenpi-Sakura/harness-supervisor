import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SCHEMA_VERSION, type WorkerRecord } from "../../src/types.js";
import { TestDaemon } from "./helpers.js";

function seedRecord(id: string, index: number): WorkerRecord {
  const endedAt = new Date(Date.now() - (index + 1) * 60_000).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    runtime: "pi",
    cwd: process.cwd(),
    promptPreview: `seeded worker ${index}`,
    status: "completed",
    createdAt: endedAt,
    updatedAt: endedAt,
    startedAt: endedAt,
    endedAt,
    lastSeq: 0,
    eventCount: 0,
    stats: { turns: 1, toolCalls: 2, toolErrors: 0 },
    capabilities: {
      runtime: "pi",
      steer: true,
      followUp: true,
      cancel: true,
      resume: true,
      pause: false,
      interactiveInput: true,
      notes: "seed",
    },
    config: {},
    result: { text: `seeded result ${index}`, truncated: false },
    resumeCount: 0,
    supervisorId: "seed",
  };
}

function seedEvents(workerId: string, count: number): string {
  const lines: string[] = [];
  for (let seq = 1; seq <= count; seq += 1) {
    lines.push(
      JSON.stringify({
        seq,
        workerId,
        ts: new Date(Date.now() - (count - seq) * 1000).toISOString(),
        type: seq === count ? "run.completed" : "run.progress",
        data: seq === count ? { text: "done" } : { kind: "tool_start", tool: "bash" },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

test("list/status/events stay fast with many persisted workers and events", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-perf-"));
  await mkdir(path.join(stateDir, "sessions"), { recursive: true });
  const workerCount = 120;
  const eventsPerWorker = 40;
  for (let index = 0; index < workerCount; index += 1) {
    const id = `w-perf-${String(index).padStart(4, "0")}`;
    const dir = path.join(stateDir, "workers", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "worker.json"), JSON.stringify(seedRecord(id, index)), "utf8");
    await writeFile(path.join(dir, "events.jsonl"), seedEvents(id, eventsPerWorker), "utf8");
  }

  const initStarted = Date.now();
  const daemon = new TestDaemon(stateDir);
  const client = await daemon.start({ readyTimeoutMs: 30_000 });
  const initMs = Date.now() - initStarted;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });

  const timed = async <T>(job: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const started = Date.now();
    const value = await job();
    return { value, ms: Date.now() - started };
  };

  const list = await timed(() => client.request<unknown[]>("list", { limit: 200 }));
  const status = await timed(() =>
    client.request("status", { workerId: "w-perf-0100", recentEvents: 20 }),
  );
  const events = await timed(() =>
    client.request("events", { workerId: "w-perf-0100", sinceSeq: 0, limit: 100 }),
  );
  const inbox = await timed(() =>
    client.request("notifications", { state: "all", limit: 200 }),
  );

  assert.equal(list.value.length, workerCount);
  t.diagnostic(`init=${initMs}ms list=${list.ms}ms status=${status.ms}ms events=${events.ms}ms inbox=${inbox.ms}ms`);
  assert.ok(list.ms < 1000, `list took ${list.ms}ms`);
  assert.ok(status.ms < 500, `status took ${status.ms}ms`);
  assert.ok(events.ms < 500, `events took ${events.ms}ms`);
  assert.ok(inbox.ms < 500, `notifications took ${inbox.ms}ms`);
  assert.ok(initMs < 20_000, `init took ${initMs}ms`);

  // Every seeded terminal event is reconciled into the durable inbox exactly once.
  const result = inbox.value as { counts: { pending: number; unacked: number } };
  assert.equal(result.counts.pending, workerCount);
  assert.equal(result.counts.unacked, workerCount);
});

test("a very large final answer is truncated in both the record and the event", async (t) => {
  const daemon = await TestDaemon.create();
  const client = await daemon.start({ env: { FAKE_PI_LONG_TEXT: "1" } });
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const workerId = await client
    .request<{ id: string }>(
      "spawn",
      { runtime: "pi", cwd: process.cwd(), prompt: "produce a long answer" },
      { timeoutMs: 60_000 },
    )
    .then((worker) => worker.id);
  const final = await client.request<{
    worker: { status: string; result?: { text: string; truncated: boolean } };
  }>("wait", { workerId, sinceSeq: 0, timeoutMs: 30_000, until: "terminal" }, { timeoutMs: 40_000 });
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.truncated, true);
  assert.ok(
    (final.worker.result?.text.length ?? 0) <= 64 * 1024 + 200,
    "result must respect maxResultBytes (plus the truncation marker)",
  );

  const events = await client.request<{
    events: Array<{ type: string; data?: { text?: string; truncated?: boolean } }>;
  }>("events", { workerId, sinceSeq: 0, limit: 100 });
  const completed = events.events.find((event) => event.type === "run.completed");
  assert.ok(completed);
  assert.equal(completed.data?.truncated, true);
  assert.ok(
    (completed.data?.text?.length ?? 0) <= 8 * 1024 + 200,
    "event text must respect maxEventStringBytes (plus the truncation marker)",
  );
});
