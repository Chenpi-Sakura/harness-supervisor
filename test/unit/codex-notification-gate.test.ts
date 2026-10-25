import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkNotificationPrompt, parseNotificationPointer } from "../../src/codex-notification-gate.js";
import { Notifier, renderMessage } from "../../src/notify.js";
import { silentLogger } from "../../src/util/logger.js";
import type { NotificationRecord, WorkerEvent } from "../../src/types.js";

const thread = "thread-gate-test";
function record(seq: number, ack = true): NotificationRecord {
  return {
    id: `w-same-worker#${seq}`, workerId: "w-same-worker", runtime: "pi", seq,
    eventType: "run.completed", kind: "completed", createdAt: "2026-10-24T17:54:42.092Z",
    target: { channel: "codex-queue", codexThreadId: thread },
    summary: { status: "completed" }, delivery: {state: "delivered", channel: "codex-queue", attempts: 1},
    ...(ack ? {ackAt: "2026-10-24T18:01:46.426Z"} : {}),
  };
}
function input(n: NotificationRecord) {
  return {hook_event_name: "UserPromptSubmit", session_id: thread, turn_id: "test-turn", prompt: renderMessage(n)};
}
async function setup(records: NotificationRecord[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-ack-gate-"));
  await writeFile(path.join(dir, "notifications.jsonl"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

test("already enqueued then ACKed: the pre-submit gate blocks without changing ACK or delivery", async () => {
  const n = record(445);
  const dir = await setup([{...n, ackAt: undefined, delivery: {...n.delivery, state: "pending"}}, {...n, ackAt: undefined}, n]);
  const before = await readFile(path.join(dir, "notifications.jsonl"), "utf8");
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await checkNotificationPrompt(input(n), dir);
    assert.equal(result.block, true);
    assert.equal(result.id, n.id);
    assert.equal(result.ackAt, n.ackAt);
  }
  assert.equal(await readFile(path.join(dir, "notifications.jsonl"), "utf8"), before);
  const checks = (await readFile(path.join(dir, "notification-gate.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(checks.every(check => check.decision === "block_acknowledged" && check.checkedAt && !check.consumedAt));
});

test("same worker with a new seq remains actionable; only the full ACKed id is blocked", async () => {
  const old = record(445);
  const fresh = record(714, false);
  const dir = await setup([old, fresh]);
  assert.equal((await checkNotificationPrompt(input(old), dir)).block, true);
  assert.equal((await checkNotificationPrompt(input(fresh), dir)).block, false);
});

test("ordinary prompts, quoted reports and other threads are never vetoed", async () => {
  const n = record(445);
  const dir = await setup([n]);
  const original = input(n);
  for (const value of [
    {...original, prompt: "please explain " + original.prompt},
    {...original, prompt: original.prompt + "\nWhy did this happen?"},
    {...original, session_id: "another-thread"},
    {...original, hook_event_name: "SessionStart"},
    {...original, prompt: original.prompt.replace("completed", "failed")},
    {...original, session_id: undefined},
  ]) assert.equal((await checkNotificationPrompt(value, dir)).block, false);
});

test("unknown, missing, unbound and torn state fails open instead of losing a real alert", async () => {
  const n = record(445);
  const dir = await setup([{...n, target: {channel: "none"}}]);
  assert.equal((await checkNotificationPrompt(input(n), dir)).block, false);
  await writeFile(path.join(dir, "notifications.jsonl"), JSON.stringify({...n, ackAt: undefined}) + '\n{"id":"w-same-worker#445","ackAt":');
  assert.equal((await checkNotificationPrompt(input(n), dir)).block, false);
  assert.equal((await checkNotificationPrompt(input(record(999)), dir)).block, false);
  assert.equal((await checkNotificationPrompt(input(n), path.join(dir, "missing"))).block, false);
});

test("hook executable blocks the exact pointer but emits no context for a normal prompt", async () => {
  const n = record(445);
  const dir = await setup([n]);
  const entry = fileURLToPath(new URL("../../src/codex-notification-hook.js", import.meta.url));
  async function invoke(value: unknown) {
    const child = spawn(process.execPath, [entry, "--state-dir", dir], {stdio: ["pipe", "pipe", "pipe"], windowsHide: true});
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    child.stdin.end(JSON.stringify(value));
    const code = await new Promise(resolve => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    return stdout;
  }
  assert.equal(JSON.parse(await invoke(input(n))).decision, "block");
  assert.equal(await invoke({...input(n), prompt: "normal user question"}), "");
  assert.equal(parseNotificationPointer(renderMessage(n))?.id, n.id);
});

test("a single queue acceptance can outlive ACK: restart never retries it, gate rejects the late pointer", async (t) => {
  const dir = await setup([]);
  const queue = fileURLToPath(new URL("../../../test/fixtures/fake-codex-queue.mjs", import.meta.url));
  const notifier = new Notifier({stateDir: dir, logger: silentLogger, channel: "codex-queue", codexThreadId: thread,
    codexBin: `"${process.execPath}" "${queue}"`, deliveryDelayMs: 0});
  await notifier.init(); t.after(() => notifier.stop());
  const event: WorkerEvent = {workerId: "w-same-worker", seq: 445, ts: new Date().toISOString(), type: "run.completed", data: {text: "report"}};
  const queued = notifier.ingest({id: event.workerId, runtime: "pi", status: "completed"}, event)!;
  await notifier.deliver(queued.id);
  assert.equal(queued.delivery.state, "delivered");
  assert.equal(queued.delivery.attempts, 1);
  assert.ok(queued.delivery.lastAttemptStartedAt && queued.delivery.enqueuedAt);
  assert.ok(Date.parse(queued.delivery.lastAttemptStartedAt) <= Date.parse(queued.delivery.enqueuedAt));
  await notifier.ack([queued.id]);
  // This is a simulated delayed host consumption, not an actual Codex GUI E2E.
  assert.equal((await checkNotificationPrompt(input(queued), dir)).block, true);
  const restarted = new Notifier({stateDir: dir, logger: silentLogger});
  await restarted.init(); t.after(() => restarted.stop());
  assert.equal(await restarted.retryPending(["pending", "delivered", "failed"]), 0);
  assert.equal(restarted.list({state: "all"})[0]?.delivery.attempts, 1);
});
