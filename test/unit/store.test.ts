import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile, readFile, rm, writeFile } from "node:fs/promises";
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

test("in-memory cache is bounded to the newest 500 events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-cap-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-cap");
  await store.createWorker(record);
  for (let i = 1; i <= 800; i += 1) {
    store.appendEvent(record.id, "run.progress", { i });
  }
  await store.flush(record.id);

  const stats = store.cacheStats(record.id);
  assert.equal(stats.cached, 500);
  assert.equal(stats.evicted, 300);
  assert.equal(stats.total, 800);
  assert.equal(stats.lastSeq, 800);

  assert.deepEqual(
    store.getRecentEvents(record.id, 3).map((event) => event.seq),
    [798, 799, 800],
  );

  const cachePage = store.getEvents(record.id, 0, 10);
  assert.equal(cachePage.source, "cache");
  assert.equal(cachePage.truncated, true, "old history is not in memory");
  assert.deepEqual(
    cachePage.events.map((event) => event.seq),
    [301, 302, 303, 304, 305, 306, 307, 308, 309, 310],
  );

  const diskPage = await store.readEvents(record.id, 0, 10);
  assert.equal(diskPage.source, "disk");
  assert.equal(diskPage.truncated, false);
  assert.deepEqual(
    diskPage.events.map((event) => event.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(diskPage.nextSeq, 10);
  assert.equal(diskPage.hasMore, true);
});

test("readEvents pages through the complete history with cursor semantics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-page-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-page");
  await store.createWorker(record);
  for (let i = 1; i <= 1200; i += 1) {
    store.appendEvent(record.id, "run.progress", { i });
  }
  await store.flush(record.id);

  const seen: number[] = [];
  let cursor = 0;
  let pages = 0;
  for (;;) {
    const page = await store.readEvents(record.id, cursor, 250);
    pages += 1;
    for (const event of page.events) seen.push(event.seq);
    if (!page.hasMore) break;
    assert.equal(page.nextSeq, page.events[page.events.length - 1]!.seq);
    cursor = page.nextSeq;
    assert.ok(pages < 20, "pagination must terminate");
  }
  assert.equal(seen.length, 1200);
  assert.deepEqual(
    seen,
    Array.from({ length: 1200 }, (_, index) => index + 1),
  );

  const beyond = await store.readEvents(record.id, 1200, 10);
  assert.deepEqual(beyond.events, []);
  assert.equal(beyond.nextSeq, 1200);
  assert.equal(beyond.hasMore, false);

  // A tail cursor is served straight from the cache, without touching disk.
  const tail = await store.readEvents(record.id, 1190, 10);
  assert.equal(tail.source, "cache");
  assert.deepEqual(
    tail.events.map((event) => event.seq),
    Array.from({ length: 10 }, (_, index) => 1191 + index),
  );
  assert.equal(tail.hasMore, false);
});

test("scanEvents streams the full history once, in order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-scan-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-scan");
  await store.createWorker(record);
  for (let i = 1; i <= 700; i += 1) {
    store.appendEvent(record.id, i === 3 ? "run.failed" : "run.progress", { i });
  }
  await store.flush(record.id);

  const seen: number[] = [];
  for await (const event of store.scanEvents(record.id)) seen.push(event.seq);
  assert.equal(seen.length, 700);
  assert.equal(seen[0], 1);
  assert.equal(seen[699], 700);

  const rest: number[] = [];
  for await (const event of store.scanEvents(record.id, { sinceSeq: 690 })) rest.push(event.seq);
  assert.deepEqual(rest, [691, 692, 693, 694, 695, 696, 697, 698, 699, 700]);

  // Early events are still reachable even though they were evicted from memory.
  const early = await store.readEvents(record.id, 2, 1);
  assert.equal(early.events[0]?.seq, 3);
  assert.equal(early.events[0]?.type, "run.failed");
});

test("appended events are readable before their write is flushed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-pending-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-pending");
  await store.createWorker(record);
  for (let i = 1; i <= 600; i += 1) store.appendEvent(record.id, "run.progress", { i });
  await store.flush(record.id);

  // Start a full-history read and append while it is in flight.
  const pending = store.readEvents(record.id, 0, 1000);
  store.appendEvent(record.id, "run.completed", { late: true });
  const page = await pending;

  const seqs = page.events.map((event) => event.seq);
  assert.equal(seqs.length, 601);
  assert.equal(new Set(seqs).size, 601, "no duplicates when merging cache and disk");
  assert.deepEqual(seqs, Array.from({ length: 601 }, (_, index) => index + 1));
  assert.equal(page.events[600]?.type, "run.completed");

  await store.flush(record.id);
  const reloaded = new Store(dir);
  await reloaded.init();
  assert.equal(reloaded.getWorker(record.id)?.eventCount, 601);
  assert.equal((await reloaded.readEvents(record.id, 600, 10)).events.length, 1);
});

test("recovers a truncated trailing line and keeps sequence continuity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-truncated-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-truncated");
  await store.createWorker(record);
  for (let i = 1; i <= 3; i += 1) store.appendEvent(record.id, "run.progress", { i });
  await store.flush(record.id);
  const eventsFile = path.join(dir, "workers", record.id, "events.jsonl");
  await appendFile(eventsFile, '{"seq":4,"workerId":"w-test-truncated","ts":"', "utf8");

  const reloaded = new Store(dir);
  const { workers, warnings } = await reloaded.init();
  assert.equal(warnings.length, 1);
  assert.equal(workers[0]!.lastSeq, 3);
  assert.equal(workers[0]!.eventCount, 3);

  const appended = reloaded.appendEvent(record.id, "run.completed");
  assert.equal(appended.seq, 4);
  await reloaded.flush(record.id);

  const again = new Store(dir);
  await again.init();
  assert.equal(again.getWorker(record.id)?.lastSeq, 4);
  assert.equal(again.getWorker(record.id)?.eventCount, 4);
  const page = await again.readEvents(record.id, 0, 10);
  assert.deepEqual(
    page.events.map((event) => event.seq),
    [1, 2, 3, 4],
  );
  assert.equal(page.events[3]?.type, "run.completed");
});

test("restart recomputes lastSeq and eventCount from a full streamed scan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-restart-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-restart");
  await store.createWorker(record);
  for (let i = 1; i <= 620; i += 1) store.appendEvent(record.id, "run.progress", { i });
  await store.flush(record.id);
  // worker.json still says eventCount 0: the scan, not the metadata, is authoritative.
  assert.equal(JSON.parse(await readFile(path.join(dir, "workers", record.id, "worker.json"), "utf8")).eventCount, 0);

  const reloaded = new Store(dir);
  const { workers, warnings } = await reloaded.init();
  assert.equal(warnings.length, 0);
  assert.equal(workers[0]!.lastSeq, 620);
  assert.equal(workers[0]!.eventCount, 620);
  assert.equal(reloaded.cacheStats(record.id).cached, 500);
});

test("multibyte (CJK) events survive a cold read and the size cap is byte-based", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-utf8-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-utf8");
  await store.createWorker(record);
  const eventsFile = path.join(dir, "workers", record.id, "events.jsonl");

  // 1) A legacy line that is legal under the old *character* cap (750k CJK
  //    chars = 2.25 MiB of UTF-8) must not be dropped by the reader guard.
  const cjk = "中文事件".repeat(187_500);
  await appendFile(
    eventsFile,
    `${JSON.stringify({ seq: 1, workerId: record.id, ts: new Date().toISOString(), type: "run.completed", data: { cjk } })}\n`,
    "utf8",
  );

  const reloaded = new Store(dir);
  const { workers, warnings } = await reloaded.init();
  assert.equal(warnings.length, 0);
  assert.equal(workers[0]!.eventCount, 1);
  const page = await reloaded.readEvents(record.id, 0, 10);
  assert.equal(page.events.length, 1, "a legal multibyte event must not be lost on a cold read");
  assert.equal((page.events[0]!.data as { cjk: string }).cjk.length, cjk.length);

  // 2) An append above the byte cap is truncated with an explicit marker, never dropped.
  const appended = reloaded.appendEvent(record.id, "run.failed", { cjk: "汉".repeat(900_000) });
  assert.equal(appended.seq, 2);
  await reloaded.flush(record.id);
  const again = new Store(dir);
  await again.init();
  const cold = await again.readEvents(record.id, 0, 10);
  assert.deepEqual(cold.events.map((event) => event.seq), [1, 2]);
  assert.equal((cold.events[1]!.data as { truncated?: boolean }).truncated, true);
});

test("event history reads fail closed when a queued write failed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-store-failclosed-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord("w-test-failclosed");
  await store.createWorker(record);
  for (let i = 1; i <= 600; i += 1) store.appendEvent(record.id, "run.progress", { i });
  await store.flush(record.id);

  // Break persistence: events.jsonl becomes a directory, so the append fails.
  const eventsFile = path.join(dir, "workers", record.id, "events.jsonl");
  await rm(eventsFile);
  await mkdir(eventsFile);
  store.appendEvent(record.id, "run.completed");
  await new Promise((resolve) => setTimeout(resolve, 100));

  await assert.rejects(store.readEvents(record.id, 0, 10), /incomplete/);
  await assert.rejects(async () => {
    for await (const _event of store.scanEvents(record.id)) {
      // consume
    }
  }, /incomplete/);
  await assert.rejects(store.flush(record.id));
  // Reporting the I/O error does not repair the missing event.
  await assert.rejects(store.readEvents(record.id, 0, 10), /incomplete/);
});

test("missing confirmed history and gaps remain explicit after restart", async () => {
  for (const missingFile of [true, false]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hs-history-gap-"));
    const store = new Store(dir);
    await store.init();
    const record = makeRecord("w-gap");
    await store.createWorker(record);
    for (let i = 0; i < 3; i++) store.appendEvent(record.id, "run.progress");
    await store.saveWorker(record);
    await store.flush(record.id);
    const file = path.join(store.workerDir(record.id), "events.jsonl");
    if (missingFile) await rm(file);
    else {
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      await writeFile(file, [lines[0], lines[2]].join("\n") + "\n");
    }
    const restarted = new Store(dir);
    const { warnings } = await restarted.init();
    assert.ok(warnings.some(w => w.includes("incomplete")));
    await assert.rejects(restarted.readEvents(record.id, 0, 10), /incomplete/);
    await assert.rejects(async () => { for await (const _event of restarted.scanEvents(record.id)) {} }, /incomplete/);
    assert.equal(restarted.getWorker(record.id)?.lastSeq, 3);
  }
});
