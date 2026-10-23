import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IdempotencyStore, hashParams } from "../../src/idempotency.js";
import { SupervisorError } from "../../src/errors.js";
import { silentLogger } from "../../src/util/logger.js";

async function makeStore(): Promise<{ dir: string; store: IdempotencyStore }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-idem-"));
  const store = new IdempotencyStore(dir, silentLogger);
  await store.init();
  return { dir, store };
}

function logFile(dir: string): string {
  return path.join(dir, "idempotency.jsonl");
}

async function readLog(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(logFile(dir), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function code(error: unknown): string | undefined {
  return error instanceof SupervisorError ? error.code : undefined;
}

/**
 * Deterministic disk failure: the state directory disappears, so every later
 * append fails with ENOENT on every platform (no permissions tricks, no mocks).
 */
async function breakLog(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

test("parameter hashes ignore object key order but detect value changes", () => {
  assert.equal(hashParams({ a: 1, b: { c: 2, d: 3 } }), hashParams({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(hashParams({ a: 1 }), hashParams({ a: 2 }));
  // Explicitly-undefined optional fields must not change the request identity.
  assert.equal(hashParams({ a: 1 }), hashParams({ a: 1, b: undefined }));
});

test("first request is new, an identical retry replays, different params conflict", async () => {
  const { store } = await makeStore();
  const hash = hashParams({ prompt: "hello" });
  const first = store.begin("spawn", "req-1", hash);
  assert.equal(first.kind, "new");

  const running = store.begin("spawn", "req-1", hash);
  assert.equal(running.kind, "running");

  const conflict = store.begin("spawn", "req-1", hashParams({ prompt: "different" }));
  assert.equal(conflict.kind, "conflict");

  await store.complete("spawn", "req-1", { id: "w-1" }, "w-1");
  const replay = store.begin("spawn", "req-1", hash);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.record.state, "done");
  assert.deepEqual(replay.record.result, { id: "w-1" });
  assert.equal(replay.record.workerId, "w-1");
});

test("begin() admits synchronously and only flush() makes the admission durable", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "sync admission" });

  const first = store.begin("spawn", "req-sync", hash);
  assert.equal(first.kind, "new");
  // No await has happened yet, so nothing can have been written to disk.
  assert.equal(existsSync(logFile(dir)), false, "begin() must not write before returning");
  // Admission is atomic even when two requests arrive in the same tick.
  assert.equal(store.begin("spawn", "req-sync", hash).kind, "running");

  await store.flush();
  const lines = await readLog(dir);
  assert.equal(lines.length, 1, "exactly one admission line for one admitted request");
  assert.equal(lines[0]!.key, "spawn:req-sync");
  assert.equal(lines[0]!.state, "in_progress");
});

test("concurrent duplicate admissions before flush create exactly one record", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "race" });
  const kinds = [
    store.begin("spawn", "req-race", hash).kind,
    store.begin("spawn", "req-race", hash).kind,
    store.begin("spawn", "req-race", hash).kind,
  ];
  assert.deepEqual(kinds, ["new", "running", "running"]);
  await Promise.all([store.flush(), store.flush(), store.flush()]);

  const lines = await readLog(dir);
  assert.equal(
    lines.filter((line) => line.key === "spawn:req-race").length,
    1,
    "a duplicate must never append a second admission line",
  );
});

test("an admission write failure is reported by flush() and never becomes replayable", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "no disk" });
  await breakLog(dir);

  assert.equal(store.begin("spawn", "req-nodisk", hash).kind, "new");
  await assert.rejects(
    () => store.flush(),
    (error: unknown) => {
      assert.equal(code(error), "INTERNAL", "flush() must surface the write failure");
      return true;
    },
  );
  assert.equal(existsSync(logFile(dir)), false, "nothing was persisted, so nothing may be claimed");

  // The side effect was not allowed to run, and the key must not silently restart.
  const retry = store.begin("spawn", "req-nodisk", hash);
  assert.equal(retry.kind, "uncertain", "a failed admission write must never be re-executed");
  assert.ok(retry.record.uncertainAt);

  // The reported failure is not replayed into an unrelated later flush().
  await store.flush();
});

test("complete() and fail() confirm their write and reject when it fails", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "confirm" });
  assert.equal(store.begin("spawn", "req-done", hash).kind, "new");
  await store.flush();
  await breakLog(dir);

  await assert.rejects(
    () => store.complete("spawn", "req-done", { id: "w-9" }, "w-9"),
    (error: unknown) => {
      assert.ok((error as Error).message.length > 0);
      return true;
    },
  );
  // An unconfirmed completion must not look like a confirmed success.
  assert.equal(store.begin("spawn", "req-done", hash).kind, "uncertain");
  await store.flush();

  const other = hashParams({ prompt: "confirm fail" });
  assert.equal(store.begin("spawn", "req-fail", other).kind, "new");
  await assert.rejects(() => store.fail("spawn", "req-fail", new Error("boom"), "w-10"));
  assert.equal(store.begin("spawn", "req-fail", other).kind, "uncertain");
});

test("a record interrupted by a daemon restart is uncertain, never replayable", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "slow" });
  store.begin("spawn", "req-crash", hash);
  await store.flush();
  // The admission marker must be on disk before the side effect runs.
  const [line] = await readLog(dir);
  assert.equal(line!.state, "in_progress");

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  const after = reloaded.begin("spawn", "req-crash", hash);
  assert.equal(after.kind, "uncertain");
  assert.ok(after.record.uncertainAt);
});

test("failed records replay the failure instead of executing again", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "boom" });
  store.begin("spawn", "req-2", hash);
  await store.fail("spawn", "req-2", new Error("boom"), "w-2");
  await store.flush();

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  const replay = reloaded.begin("spawn", "req-2", hash);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.record.state, "failed");
  assert.equal(replay.record.error?.message, "boom");
  assert.equal(replay.record.workerId, "w-2");
});

test("fail() never downgrades a completed record", async () => {
  const { store } = await makeStore();
  const hash = hashParams({ prompt: "keep success" });
  store.begin("spawn", "req-keep", hash);
  await store.complete("spawn", "req-keep", { id: "w-keep" }, "w-keep");
  // Late bookkeeping errors (for example an unrelated persistence failure) must
  // not turn a recorded success into a reported failure.
  await store.fail("spawn", "req-keep", new Error("late noise"));
  const replay = store.begin("spawn", "req-keep", hash);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.record.state, "done");
  assert.deepEqual(replay.record.result, { id: "w-keep" });
});

test("released keys are reusable", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "retry me" });
  store.begin("spawn", "req-3", hash);
  await store.release("spawn", "req-3");
  await store.flush();

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  const afterReload = reloaded.begin("spawn", "req-3", hash);
  assert.equal(afterReload.kind, "new", "release must be durable across reloads");
});

test("a release that cannot be written keeps the record and never re-executes it", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "release fails" });
  store.begin("spawn", "req-release", hash);
  await store.flush();
  await breakLog(dir);

  await assert.rejects(() => store.release("spawn", "req-release"));
  assert.ok(store.get("spawn:req-release"), "the record must survive a failed release");
  assert.equal(
    store.begin("spawn", "req-release", hash).kind,
    "uncertain",
    "an unconfirmed release must not make the key look fresh",
  );
});

test("concurrent completions are serialized and all durable", async () => {
  const { dir, store } = await makeStore();
  const keys = ["a", "b", "c", "d"];
  for (const key of keys) {
    assert.equal(store.begin("spawn", `req-${key}`, hashParams({ key })).kind, "new");
  }
  await Promise.all(
    keys.map((key) => store.complete("spawn", `req-${key}`, { id: `w-${key}` }, `w-${key}`)),
  );
  await store.flush();

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  for (const key of keys) {
    const replay = reloaded.begin("spawn", `req-${key}`, hashParams({ key }));
    assert.equal(replay.kind, "replay", `request ${key} must replay after reload`);
    assert.deepEqual(replay.record.result, { id: `w-${key}` });
  }
});

test("a request admitted and completed while compaction is queued is never forgotten", async () => {
  const { dir, store } = await makeStore();
  const olderHash = (key: string) => hashParams({ key });
  for (const key of ["a", "b", "c"]) {
    store.begin("spawn", `req-${key}`, olderHash(key));
    await store.complete("spawn", `req-${key}`, { id: `w-${key}` }, `w-${key}`);
  }
  await store.flush();

  // The compaction job is queued but has not applied yet: the begin/complete below
  // land in the window the old implementation lost.
  const compaction = store.compact({ keep: 1 });
  const liveHash = hashParams({ key: "live" });
  assert.equal(store.begin("spawn", "req-live", liveHash).kind, "new");
  await store.complete("spawn", "req-live", { id: "w-live" }, "w-live");
  const result = await compaction;
  assert.ok(result.dropped >= 1, "older records must still be compacted away");

  const replay = store.begin("spawn", "req-live", liveHash);
  assert.equal(replay.kind, "replay", "a concurrent admission must not be forgotten");
  assert.equal(replay.record.workerId, "w-live");

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  const afterReload = reloaded.begin("spawn", "req-live", liveHash);
  assert.equal(afterReload.kind, "replay", "its line must still be on disk after the rewrite");
  assert.deepEqual(afterReload.record.result, { id: "w-live" });
});

test("compaction never resurrects a key released while the rewrite is queued", async () => {
  const { dir, store } = await makeStore();
  const oldHash = hashParams({ key: "old" });
  const targetHash = hashParams({ key: "target" });
  store.begin("spawn", "req-old", oldHash);
  await store.complete("spawn", "req-old", { id: "w-old" }, "w-old");
  store.begin("spawn", "req-target", targetHash);
  await store.flush();

  const compaction = store.compact({ keep: 1 });
  await store.release("spawn", "req-target");
  const result = await compaction;
  assert.ok(result.dropped >= 1, "req-old must be dropped by this compaction");

  assert.equal(store.get("spawn:req-target"), undefined, "a released key must stay released");

  // The release must be durable too (checked before any new admission is written).
  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  assert.equal(reloaded.begin("spawn", "req-target", targetHash).kind, "new");

  assert.equal(
    store.begin("spawn", "req-target", targetHash).kind,
    "new",
    "a released key must be reusable, not resurrected by compaction",
  );
});

test("compaction never drops uncertain or in-progress records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-idem-"));
  const seeded = new IdempotencyStore(dir, silentLogger);
  await seeded.init();
  const interruptedHash = hashParams({ key: "interrupted" });
  seeded.begin("spawn", "req-interrupted", interruptedHash);
  await seeded.flush();

  // A reload turns the unfinished record into an uncertain one (daemon crash).
  const store = new IdempotencyStore(dir, silentLogger);
  await store.init();
  assert.equal(store.begin("spawn", "req-interrupted", interruptedHash).kind, "uncertain");

  for (const key of ["a", "b", "c"]) {
    store.begin("spawn", `req-${key}`, hashParams({ key }));
    await store.complete("spawn", `req-${key}`, { id: `w-${key}` }, `w-${key}`);
  }
  await store.flush();

  const result = await store.compact({ keep: 1 });
  assert.equal(result.dropped, 2, "only the two old, untouched records are dropped");
  assert.equal(result.kept, 2, "the newest record plus the uncertain one");

  const stillUncertain = store.begin("spawn", "req-interrupted", interruptedHash);
  assert.equal(stillUncertain.kind, "uncertain", "an uncertain record must never be dropped");
  assert.equal(store.begin("spawn", "req-c", hashParams({ key: "c" })).kind, "replay");

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  assert.equal(
    reloaded.begin("spawn", "req-interrupted", interruptedHash).kind,
    "uncertain",
    "the uncertain record must still be on disk after compaction",
  );
});

test("a torn trailing line cannot swallow the next admission marker after a restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-idem-"));
  // A crash during append leaves the last line unterminated.
  const torn = `{"key":"spawn:req-torn","method":"spawn","paramsHash":"deadbeef","state":"in_pro`;
  await writeFile(logFile(dir), torn, "utf8");

  const store = new IdempotencyStore(dir, silentLogger);
  await store.init();
  const first = hashParams({ key: "first" });
  const second = hashParams({ key: "second" });
  assert.equal(store.begin("spawn", "req-first", first).kind, "new");
  assert.equal(store.begin("spawn", "req-second", second).kind, "new");
  await store.flush();

  const raw = await readFile(logFile(dir), "utf8");
  assert.match(
    raw,
    /in_pro\n\{"key":"spawn:req-first"/,
    "the first marker after a torn line must start on its own line",
  );
  assert.ok(raw.endsWith("\n"), "every appended line is terminated");

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  assert.equal(
    reloaded.begin("spawn", "req-first", first).kind,
    "uncertain",
    "the first marker must survive the restart, not be swallowed by the torn line",
  );
  assert.equal(reloaded.begin("spawn", "req-second", second).kind, "uncertain");
  assert.equal(reloaded.size(), 2);
});

test("a failed compaction keeps records in memory so nothing is re-executed", async () => {
  const { dir, store } = await makeStore();
  for (const key of ["a", "b"]) {
    store.begin("spawn", `req-${key}`, hashParams({ key }));
    await store.complete("spawn", `req-${key}`, { id: `w-${key}` }, `w-${key}`);
  }
  await store.flush();
  await breakLog(dir);

  await assert.rejects(() => store.compact({ keep: 1 }));
  const replay = store.begin("spawn", "req-a", hashParams({ key: "a" }));
  assert.equal(replay.kind, "replay", "a failed compaction must not make a key look new");
  assert.deepEqual(replay.record.result, { id: "w-a" });
  await store.flush();
});

test("a record updated during atomic compaction remains replayable in memory and on disk", async () => {
  const { dir, store } = await makeStore();
  for (const key of ["old", "new"]) {
    store.begin("spawn", key, key);
    await store.complete("spawn", key, { version: 1 });
  }
  // Force the first key outside the retention window independently of clock resolution.
  const internal = store as unknown as {
    records: Map<string, { updatedAt: string }>;
    enqueue(id: string, job: () => Promise<void>): Promise<void>;
  };
  internal.records.get("spawn:old")!.updatedAt = "2000-01-01T00:00:00Z";
  const enqueue = internal.enqueue.bind(store);
  let update: Promise<void> | undefined;
  internal.enqueue = (id, job) => enqueue(id, id !== "@compact" ? job : async () => {
    const writing = job(); // Snapshot has been taken, replacement is now awaiting I/O.
    update = store.complete("spawn", "old", { version: 2 });
    await writing;
  });
  await store.compact({ keep: 1 });
  await update;
  assert.equal(store.begin("spawn", "old", "old").kind, "replay");
  const restarted = new IdempotencyStore(dir, silentLogger);
  await restarted.init();
  const replay = restarted.begin("spawn", "old", "old");
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.record.result, { version: 2 });
});

test("compaction keeps the newest records and all in-progress records", async () => {
  const { dir, store } = await makeStore();
  for (let index = 0; index < 5; index += 1) {
    const hash = hashParams({ index });
    store.begin("spawn", `req-${index}`, hash);
    if (index < 4) await store.complete("spawn", `req-${index}`, { id: `w-${index}` });
  }
  await store.flush();
  const result = await store.compact({ keep: 1 });
  assert.ok(result.dropped >= 3, `expected at least 3 dropped, got ${result.dropped}`);
  assert.ok(result.kept <= 2, "keep=1 plus the in-progress record at most");
  assert.ok(store.get("spawn:req-4"), "the in-progress record must survive compaction");

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  assert.ok(reloaded.get("spawn:req-4"), "compaction must be durable");
});
