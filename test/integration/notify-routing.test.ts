import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NotificationsResult, WorkerSummary } from "../../src/types.js";
import { TestDaemon, makeWorkspace, waitTerminal } from "./helpers.js";

const A = { channel: "codex-queue" as const, codexThreadId: "thread-origin-A" };
const B = { channel: "codex-queue" as const, codexThreadId: "thread-origin-B" };
const fake = fileURLToPath(new URL("../../../test/fixtures/fake-codex-queue.mjs", import.meta.url));

test("concurrent workers retain separate destinations across default changes, restart and ack", async (t) => {
  const daemon = await TestDaemon.create();
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  const log = path.join(cwd, "queue.jsonl");
  const env = { HARNESS_SUPERVISOR_CODEX_BIN: `"${process.execPath}" "${fake}"`, HS_FAKE_CODEX_LOG: log };
  let client = await daemon.start({ env });
  await client.request("notification_target", A);
  const workers = await Promise.all([
    client.request<WorkerSummary>("spawn", { cwd, prompt: "[scenario:slow] A", notifyTarget: A }),
    client.request<WorkerSummary>("spawn", { cwd, prompt: "[scenario:slow] B", notifyTarget: B }),
    client.request<WorkerSummary>("spawn", { cwd, prompt: "inherited default" }),
    client.request<WorkerSummary>("spawn", { cwd, prompt: "inbox only", notifyTarget: { channel: "none" } }),
  ]);
  await client.request("notification_target", B);
  await Promise.all(workers.map(w => waitTerminal(client, w.id, 20000)));
  // Retry also waits for each already in-flight invocation to finish on restart.
  await daemon.stop();
  client = await daemon.start({ env });
  await client.request("notification_retry", {});
  const inbox = await client.request<NotificationsResult>("notifications", { state: "all" });
  assert.equal(inbox.notifications.length, 4);
  for (const [index, w] of workers.entries()) {
    const n = inbox.notifications.find(n => n.workerId === w.id)!;
    assert.deepEqual(n.target, index === 1 ? B : index === 3 ? { channel: "none" } : A);
    assert.deepEqual((await client.request<{ worker: WorkerSummary }>("status", { workerId: w.id })).worker.notifyTarget, n.target);
  }
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(l => JSON.parse(l).argv as string[]);
  for (const call of calls) {
    const id = workers.find(w => call[4]!.includes(w.id))!.id;
    assert.equal(call[2], id === workers[1]!.id ? B.codexThreadId : A.codexThreadId);
    assert.notEqual(id, workers[3]!.id);
  }
  const ids = inbox.notifications.map(n => n.id);
  assert.equal((await client.request<{ acked: number }>("notification_ack", { ids })).acked, 4);
  assert.equal((await client.request<{ acked: number }>("notification_ack", { ids })).acked, 0);
  const before = calls.length;
  await client.request("notification_target", A);
  await client.request("notification_retry", { states: ["pending", "failed"] });
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, before);
});

test("resume preserves binding by default; explicit takeover affects only future events and reconstruction", async (t) => {
  const daemon = await TestDaemon.create();
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  const env = { HARNESS_SUPERVISOR_CODEX_BIN: `"${process.execPath}" "${fake}"` };
  let client = await daemon.start({ env });
  const worker = await client.request<WorkerSummary>("spawn", { cwd, prompt: "first", notifyTarget: A });
  await waitTerminal(client, worker.id, 20000);
  await client.request("notification_target", B);
  const preserved = await client.request<WorkerSummary>("resume", { workerId: worker.id, prompt: "second" });
  assert.deepEqual(preserved.notifyTarget, A);
  await waitTerminal(client, worker.id, 20000);
  const rebound = await client.request<WorkerSummary>("resume", { workerId: worker.id, prompt: "third", notifyTarget: B });
  assert.deepEqual(rebound.notifyTarget, B);
  await waitTerminal(client, worker.id, 20000);
  await daemon.stop();
  await rm(path.join(daemon.stateDir, "notifications.jsonl"));
  client = await daemon.start({ env });
  const inbox = await client.request<NotificationsResult>("notifications", { state: "all" });
  assert.deepEqual(inbox.notifications.map(n => n.target), [A, A, B]);
});

test("legacy unbound workers and old inbox records stay inbox-only after configuration changes", async (t) => {
  const daemon = await TestDaemon.create();
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  let client = await daemon.start();
  const worker = await client.request<WorkerSummary>("spawn", { cwd, prompt: "legacy seed" });
  await waitTerminal(client, worker.id, 20000);
  await daemon.stop();
  const file = path.join(daemon.stateDir, "workers", worker.id, "worker.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  delete record.notifyTarget;
  await writeFile(file, JSON.stringify(record));
  const inboxFile = path.join(daemon.stateDir, "notifications.jsonl");
  const lines = (await readFile(inboxFile, "utf8")).trim().split("\n").map(l => {
    const n = JSON.parse(l); delete n.target; return JSON.stringify(n);
  });
  await writeFile(inboxFile, lines.join("\n") + "\n");
  client = await daemon.start();
  await client.request("notification_target", B);
  assert.equal((await client.request<{ retried: number }>("notification_retry", {})).retried, 0);
  const status = await client.request<{ worker: WorkerSummary }>("status", { workerId: worker.id });
  assert.deepEqual(status.worker.notifyTarget, { channel: "none" });
  const inbox = await client.request<NotificationsResult>("notifications", { state: "all" });
  assert.deepEqual(inbox.notifications[0]!.target, { channel: "none" });
});
