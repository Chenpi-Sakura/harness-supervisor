import assert from "node:assert/strict";
import test from "node:test";
import { chooseWorkerSelection, mergeWorkerLists, mergeWorkerPages, workerPageCursor } from "../src/worker-pages.ts";

const worker = (id, createdAt, ownerRef = "other") => ({ id, createdAt, ownerRef });

test("an old preferred worker is visible without becoming the global pagination cursor", () => {
  const global = [worker("newest", "2026-11-11T13:00:00Z"), worker("page-one-last", "2026-11-11T12:00:00Z")];
  const preferred = worker("old-current", "2026-10-01T12:00:00Z", "current");
  const page = { workers: global, preferredWorkers: [preferred], hasMore: true };
  const merged = mergeWorkerPages([page]);
  assert.equal(merged.workers.at(-1).id, "old-current");
  assert.deepEqual(merged.cursor, { id: "page-one-last", createdAt: "2026-11-11T12:00:00Z" });
  assert.deepEqual(workerPageCursor(page), merged.cursor);
  assert.equal(chooseWorkerSelection(merged.workers, null, "current"), "old-current");
});

test("refreshing several global pages keeps their last cursor and deduplicates supplementary rows", () => {
  const current = worker("current", "2026-11-11T09:00:00Z", "current");
  const pages = [
    { workers: [worker("new", "2026-11-11T13:00:00Z")], preferredWorkers: [current], hasMore: true },
    { workers: [worker("last", "2026-11-11T10:00:00Z"), { ...current, status: "completed" }], hasMore: true },
  ];
  const merged = mergeWorkerPages(pages);
  assert.deepEqual(merged.workers.map(row => row.id), ["new", "last", "current"]);
  assert.equal(merged.workers.at(-1).status, "completed", "fresh global rows take precedence over supplementary duplicates");
  assert.deepEqual(merged.cursor, { id: "current", createdAt: current.createdAt });
  assert.equal(merged.hasMore, true);
  assert.equal(mergeWorkerPages([{ workers: [], preferredWorkers: [current], hasMore: false }]).cursor, undefined);
});

test("an empty current session never auto-selects an outside worker, while a manual selection survives refresh", () => {
  const workers = [worker("outside", "2026-11-11T13:00:00Z"), worker("current", "2026-11-11T12:00:00Z", "current")];
  assert.equal(chooseWorkerSelection([workers[0]], null, "current"), null);
  assert.equal(chooseWorkerSelection(workers, null, "current"), "current");
  assert.equal(chooseWorkerSelection(workers, "outside", "current"), "outside");
  assert.equal(chooseWorkerSelection(workers, "deleted", "current"), "current");
  assert.equal(chooseWorkerSelection(workers, null), "outside");
});

test("appended pages use server keyset order without mutating existing lists", () => {
  const existing = [worker("z", "2026-11-11T12:00:00Z"), worker("a", "2026-11-11T12:00:00Z")];
  const added = [worker("old", "2026-11-10T12:00:00Z"), { ...existing[0], status: "running" }];
  const merged = mergeWorkerLists(added, existing);
  assert.deepEqual(merged.map(row => row.id), ["a", "z", "old"]);
  assert.equal(merged.find(row => row.id === "z").status, "running");
  assert.deepEqual(existing.map(row => row.id), ["z", "a"]);
});
