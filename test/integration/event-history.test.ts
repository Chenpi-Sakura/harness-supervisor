import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Store } from "../../src/store.js";
import { SCHEMA_VERSION, type WorkerRecord } from "../../src/types.js";

const TOTAL = 100_000;
const PAGE = 1000;
/** Early "important" event that must survive cache eviction. */
const EARLY_FAILED_SEQ = 7;

function makeRecord(id: string): WorkerRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    runtime: "pi",
    cwd: process.cwd(),
    promptPreview: "history test",
    status: "completed",
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

function eventLine(workerId: string, seq: number): string {
  const type = seq === EARLY_FAILED_SEQ ? "run.failed" : seq % 50 === 0 ? "run.started" : "run.progress";
  return `${JSON.stringify({
    seq,
    workerId,
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    type,
    data: { seq, note: "history-fixture" },
  })}\n`;
}

async function writeHistory(file: string, workerId: string, total: number, from = 1): Promise<void> {
  const stream = createWriteStream(file, { encoding: "utf8" });
  let buffer = "";
  for (let seq = from; seq < from + total; seq += 1) {
    buffer += eventLine(workerId, seq);
    if (buffer.length > 512 * 1024) {
      if (!stream.write(buffer)) await once(stream, "drain");
      buffer = "";
    }
  }
  if (buffer) stream.write(buffer);
  stream.end();
  await once(stream, "finish");
}

/** Fixture: a real state dir with one worker and a pre-existing 100k-line history. */
async function makeStateDir(workerId: string): Promise<{ dir: string; record: WorkerRecord }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-history-"));
  const store = new Store(dir);
  await store.init();
  const record = makeRecord(workerId);
  await store.createWorker(record);
  await store.saveWorker(record);
  await store.flush(workerId);
  await writeHistory(path.join(dir, "workers", workerId, "events.jsonl"), workerId, TOTAL);
  return { dir, record };
}

test("100k-event history: startup streams the file and keeps only 500 events cached", async (t) => {
  const workerId = "w-history-100k";
  const { dir } = await makeStateDir(workerId);
  const file = path.join(dir, "workers", workerId, "events.jsonl");
  const fileBytes = (await readFile(file)).byteLength;

  const store = new Store(dir);
  const startedAt = performance.now();
  const { workers, warnings } = await store.init();
  const initMs = performance.now() - startedAt;

  assert.equal(warnings.length, 0);
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.lastSeq, TOTAL);
  assert.equal(workers[0]!.eventCount, TOTAL);

  const stats = store.cacheStats(workerId);
  assert.equal(stats.cached, 500, "memory holds only the newest window");
  assert.equal(stats.evicted, TOTAL - 500);
  assert.equal(stats.total, TOTAL);
  assert.equal(stats.lastSeq, TOTAL);

  // The synchronous cache accessor is honest about evicted history.
  const cached = store.getEvents(workerId, 0, 10);
  assert.equal(cached.truncated, true);
  assert.equal(cached.events[0]!.seq, TOTAL - 500 + 1);
  assert.equal(store.getRecentEvents(workerId, 2).map((event) => event.seq).join(","), `${TOTAL - 1},${TOTAL}`);

  t.diagnostic(
    `init of ${TOTAL} events: ${initMs.toFixed(1)} ms (${(fileBytes / 1024 / 1024).toFixed(1)} MiB, ` +
      `cached=${stats.cached}, evicted=${stats.evicted}, heapUsed=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MiB)`,
  );
  assert.ok(initMs < 15_000, `startup should stay bounded, took ${initMs.toFixed(0)} ms`);
});

test("100k-event history: full paginated read is ordered, complete and cursor-safe", async (t) => {
  const workerId = "w-history-paged";
  const { dir } = await makeStateDir(workerId);
  const store = new Store(dir);
  await store.init();

  const startedAt = performance.now();
  const seen: number[] = [];
  let cursor = 0;
  let pages = 0;
  let fromCache = 0;
  for (;;) {
    const page = await store.readEvents(workerId, cursor, PAGE);
    pages += 1;
    if (page.source === "cache") fromCache += 1;
    assert.equal(page.truncated, false);
    if (page.events.length > 0) {
      assert.equal(page.events[0]!.seq, cursor + 1, "pages are contiguous");
      assert.equal(page.nextSeq, page.events[page.events.length - 1]!.seq);
      for (let i = 1; i < page.events.length; i += 1) {
        assert.ok(page.events[i]!.seq > page.events[i - 1]!.seq, "pages are strictly ordered");
      }
    }
    for (const event of page.events) seen.push(event.seq);
    if (!page.hasMore) break;
    cursor = page.nextSeq;
    assert.ok(pages <= TOTAL / PAGE + 2, "pagination terminates");
  }
  const pagingMs = performance.now() - startedAt;

  assert.equal(seen.length, TOTAL);
  assert.equal(seen[0], 1);
  assert.equal(seen[TOTAL - 1], TOTAL);
  assert.equal(new Set(seen).size, TOTAL, "no duplicated events across pages");

  // A cursor that falls inside the memory window never touches the disk.
  const tailPage = await store.readEvents(workerId, TOTAL - 100, 100);
  assert.equal(tailPage.source, "cache");
  assert.equal(tailPage.events.length, 100);
  assert.equal(tailPage.events[99]!.seq, TOTAL);
  assert.equal(fromCache, 0, "deep pages come from disk, not from a partial cache");

  // Early important events are still reachable after eviction (notification rebuild).
  const early = await store.readEvents(workerId, EARLY_FAILED_SEQ - 1, 1);
  assert.equal(early.events[0]!.seq, EARLY_FAILED_SEQ);
  assert.equal(early.events[0]!.type, "run.failed");

  // Deep page seek is sublinear thanks to the byte-offset index.
  const mid = await store.readEvents(workerId, Math.floor(TOTAL / 2), PAGE);
  assert.equal(mid.events[0]!.seq, Math.floor(TOTAL / 2) + 1);
  assert.equal(mid.events.length, PAGE);

  const beyond = await store.readEvents(workerId, TOTAL, PAGE);
  assert.deepEqual(beyond.events, []);
  assert.equal(beyond.hasMore, false);
  assert.equal(beyond.nextSeq, TOTAL);

  t.diagnostic(
    `paged full history: ${pages} pages in ${pagingMs.toFixed(1)} ms ` +
      `(deep-page cache hits=${fromCache}, complete=${seen.length})`,
  );
});

test("100k-event history: scanEvents reads all history in one pass", async (t) => {
  const workerId = "w-history-scan";
  const { dir } = await makeStateDir(workerId);
  const store = new Store(dir);
  await store.init();

  const startedAt = performance.now();
  let count = 0;
  let lastSeq = 0;
  let previous = 0;
  let earlySeen = 0;
  for await (const event of store.scanEvents(workerId)) {
    assert.ok(event.seq > previous, "scan yields increasing seq");
    previous = event.seq;
    lastSeq = event.seq;
    count += 1;
    if (event.seq === EARLY_FAILED_SEQ) {
      assert.equal(event.type, "run.failed");
      earlySeen += 1;
    }
  }
  const scanMs = performance.now() - startedAt;
  assert.equal(count, TOTAL);
  assert.equal(lastSeq, TOTAL);
  assert.equal(earlySeen, 1, "the early important event is never skipped");

  const tail: number[] = [];
  for await (const event of store.scanEvents(workerId, { sinceSeq: TOTAL - 3 })) tail.push(event.seq);
  assert.deepEqual(tail, [TOTAL - 2, TOTAL - 1, TOTAL]);

  t.diagnostic(`single-pass scan: ${count} events in ${scanMs.toFixed(1)} ms`);
});

test("100k-event history: restart, malformed tail recovery and continued appends", async (t) => {
  const workerId = "w-history-restart";
  const { dir } = await makeStateDir(workerId);

  // A crash left a partial line without a trailing newline.
  const file = path.join(dir, "workers", workerId, "events.jsonl");
  await appendFile(file, `{"seq":${TOTAL + 1},"workerId":"${workerId}","ts":"`, "utf8");

  const store = new Store(dir);
  const { workers, warnings } = await store.init();
  assert.equal(warnings.length, 1, "the truncated line is reported, not silently accepted");
  assert.equal(workers[0]!.lastSeq, TOTAL);
  assert.equal(workers[0]!.eventCount, TOTAL);
  assert.equal(store.cacheStats(workerId).cached, 500);

  const appended = store.appendEvent(workerId, "run.completed", { after: "restart" });
  assert.equal(appended.seq, TOTAL + 1);
  for (let i = 0; i < 199; i += 1) store.appendEvent(workerId, "run.progress", { i });
  await store.flush(workerId);

  const restarted = new Store(dir);
  await restarted.init();
  const stats = restarted.cacheStats(workerId);
  assert.equal(stats.cached, 500);
  assert.equal(stats.total, TOTAL + 200);
  assert.equal(stats.lastSeq, TOTAL + 200);

  const reopened = await restarted.readEvents(workerId, TOTAL, 10);
  assert.deepEqual(
    reopened.events.map((event) => event.seq),
    Array.from({ length: 10 }, (_, index) => TOTAL + 1 + index),
  );
  assert.equal(reopened.events[0]!.type, "run.completed");

  const early = await restarted.readEvents(workerId, EARLY_FAILED_SEQ - 1, 1);
  assert.equal(early.events[0]!.seq, EARLY_FAILED_SEQ);

  t.diagnostic(
    `restart: cached=${stats.cached}, total=${stats.total}, lastSeq=${stats.lastSeq}, warnings=${warnings.length}`,
  );
});