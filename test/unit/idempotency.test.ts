import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IdempotencyStore, hashParams } from "../../src/idempotency.js";
import { silentLogger } from "../../src/util/logger.js";

async function makeStore(): Promise<{ dir: string; store: IdempotencyStore }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-idem-"));
  const store = new IdempotencyStore(dir, silentLogger);
  await store.init();
  return { dir, store };
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

test("a record interrupted by a daemon restart is uncertain, never replayable", async () => {
  const { dir, store } = await makeStore();
  const hash = hashParams({ prompt: "slow" });
  store.begin("spawn", "req-crash", hash);
  await store.flush();

  const reloaded = new IdempotencyStore(dir, silentLogger);
  await reloaded.init();
  const after = reloaded.begin("spawn", "req-crash", hash);
  assert.equal(after.kind, "uncertain");
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
