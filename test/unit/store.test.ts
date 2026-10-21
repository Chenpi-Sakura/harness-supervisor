import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/store.js";
import { SCHEMA_VERSION, type WorkerRecord } from "../../src/types.js";

function makeRecord(id: string): WorkerRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    runtime: "pi",
    cwd: process.cwd(),
    promptPreview: "test",
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastSeq: 0,
    eventCount: 0,
    stats: { turns: 0, toolCalls: 0, toolErrors: 0 },
    capabilities: {
      runtime: "pi",
      steer: true,
      followUp: true,
      cancel: true,
      resume: true,
      pause: false,
      interactiveInput: true,
      notes: "test",
    },
    config: {},
    resumeCount: 0,
    supervisorId: "test-supervisor",
  };
}

test("persists records and events and reloads them with a valid cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-1");
  await store.createWorker(record);
  for (let i = 1; i <= 5; i += 1) {
    store.appendEvent(record.id, "run.progress", { kind: "tool_end", n: i });
  }
  record.status = "completed";
  await store.saveWorker(record);
  await store.flush(record.id);

  const page = store.getEvents(record.id, 2, 2);
  assert.deepEqual(
    page.events.map((event) => event.seq),
    [3, 4],
  );
  assert.equal(page.nextSeq, 4);
  assert.equal(page.hasMore, true);

  const reloaded = new Store(dir);
  const { workers, warnings } = await reloaded.init();
  assert.equal(warnings.length, 0);
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.lastSeq, 5);
  assert.equal(workers[0]!.eventCount, 5);
  assert.equal(reloaded.getWorker(record.id)?.status, "completed");
  assert.deepEqual(
    reloaded.getEvents(record.id, 0, 100).events.map((event) => event.seq),
    [1, 2, 3, 4, 5],
  );
});

test("ignores a corrupt trailing event line on reload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-corrupt-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-corrupt");
  await store.createWorker(record);
  store.appendEvent(record.id, "run.started");
  await store.flush(record.id);
  const eventsFile = path.join(dir, "workers", record.id, "events.jsonl");
  await appendFile(eventsFile, "{ this is not json\n", "utf8");

  const reloaded = new Store(dir);
  const { warnings } = await reloaded.init();
  assert.equal(warnings.length, 1);
  assert.equal(reloaded.getEvents(record.id, 0, 10).events.length, 1);
});

test("event writes preserve ordering even when enqueued together", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-order-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-order");
  await store.createWorker(record);
  for (let i = 0; i < 20; i += 1) {
    store.appendEvent(record.id, "run.progress", { i });
  }
  await store.flush(record.id);
  const lines = (await readFile(path.join(dir, "workers", record.id, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { seq: number });
  assert.deepEqual(
    lines.map((line) => line.seq),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
});

test("stderr tail keeps the newest content", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-stderr-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-stderr");
  await store.createWorker(record);
  await store.appendStderr(record.id, "a".repeat(9000));
  await store.appendStderr(record.id, "latest-line\n");
  const tail = store.stderrTail(record.id);
  assert.ok(tail.endsWith("latest-line\n"));
  assert.ok(tail.length <= 8000);
});
