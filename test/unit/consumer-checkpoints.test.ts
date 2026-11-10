import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readConsumerCheckpoint,
  writeConsumerCheckpoint,
} from "../../src/consumer-checkpoints.js";

test("a missing checkpoint reads as zero and round-trips per consumer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-checkpoints-"));
  assert.equal(await readConsumerCheckpoint(dir, "notifications"), 0);
  assert.equal(await readConsumerCheckpoint(dir, "metrics"), 0);

  await writeConsumerCheckpoint(dir, "notifications", 42);
  await writeConsumerCheckpoint(dir, "metrics", 7);
  assert.equal(await readConsumerCheckpoint(dir, "notifications"), 42);
  assert.equal(await readConsumerCheckpoint(dir, "metrics"), 7);
});

test("a malformed or mismatched checkpoint falls back to a full scan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-checkpoints-bad-"));
  await writeFile(path.join(dir, "notifications.checkpoint.json"), "{not json", "utf8");
  assert.equal(await readConsumerCheckpoint(dir, "notifications"), 0);

  await writeFile(
    path.join(dir, "notifications.checkpoint.json"),
    JSON.stringify({ schemaVersion: 2, consumer: "notifications", seq: 9 }),
    "utf8",
  );
  assert.equal(await readConsumerCheckpoint(dir, "notifications"), 0);

  await writeFile(
    path.join(dir, "notifications.checkpoint.json"),
    JSON.stringify({ schemaVersion: 1, consumer: "metrics", seq: 9 }),
    "utf8",
  );
  assert.equal(await readConsumerCheckpoint(dir, "notifications"), 0);

  await writeFile(
    path.join(dir, "notifications.checkpoint.json"),
    JSON.stringify({ schemaVersion: 1, consumer: "notifications", seq: -1 }),
    "utf8",
  );
  assert.equal(await readConsumerCheckpoint(dir, "notifications"), 0);
});
