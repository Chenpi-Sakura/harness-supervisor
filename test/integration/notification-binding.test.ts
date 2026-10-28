import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TestDaemon,
  makeWorkspace,
  spawnWorker,
  waitTerminal,
} from "./helpers.js";
import type { WorkerSummary } from "../../src/types.js";

const THREAD_A = "01a1623d-d0a4-7493-b44d-5d1143efb6fe";
const THREAD_B = "01a1623d-d0a4-7493-b44d-5d1143efb6ff";

test("spawn reports an unbound daemon default and suggests waiting", async (t) => {
  const daemon = await TestDaemon.create("hs-binding-default-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  const client = await daemon.start();

  const worker = await spawnWorker(client, cwd, "[scenario:slow] binding default");
  const binding = worker.notificationBinding;
  assert.ok(binding, "spawn must return a binding");
  assert.equal(binding.source, "daemon-default");
  assert.equal(binding.wake, "unbound");
  assert.equal(binding.observation, "wait");
  assert.equal(binding.target.channel, "none");
  assert.ok(binding.warnings.length > 0, "an unbound worker must explain the degradation");
  assert.match(binding.warnings.join(" "), /will not wake/);
  await client.request("cancel", { workerId: worker.id });
});

test("an explicit target overrides a channel=none default and reports its source", async (t) => {
  const daemon = await TestDaemon.create("hs-binding-explicit-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  const client = await daemon.start();

  const worker = await spawnWorker(client, cwd, "[scenario:slow] binding explicit", {
    notifyTarget: { channel: "codex-queue", codexThreadId: THREAD_A },
  });
  const binding = worker.notificationBinding!;
  assert.equal(binding.source, "explicit");
  assert.equal(binding.wake, "bound");
  assert.equal(binding.observation, "wake");
  assert.equal(binding.target.codexThreadId, THREAD_A);
  assert.deepEqual(binding.warnings, []);
  await client.request("cancel", { workerId: worker.id });
});

test("a daemon default is used only when notifyTarget is omitted", async (t) => {
  const daemon = await TestDaemon.create("hs-binding-daemon-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  const client = await daemon.start();
  await client.request("notification_target", {
    channel: "codex-queue",
    codexThreadId: THREAD_A,
  });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] binding daemon");
  const binding = worker.notificationBinding!;
  assert.equal(binding.source, "daemon-default");
  assert.equal(binding.wake, "bound");
  assert.equal(binding.target.codexThreadId, THREAD_A);
  await client.request("cancel", { workerId: worker.id });
});

test("resume preserves an existing binding and marks an explicit takeover", async (t) => {
  const daemon = await TestDaemon.create("hs-binding-resume-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  const client = await daemon.start();

  const worker = await spawnWorker(client, cwd, "[scenario:report] binding resume", {
    notifyTarget: { channel: "codex-queue", codexThreadId: THREAD_A },
  });
  await waitTerminal(client, worker.id, 20_000);

  const preserved = await client.request<WorkerSummary>("resume", {
    workerId: worker.id,
    prompt: "[scenario:report] keep binding",
  });
  assert.equal(preserved.notificationBinding?.source, "preserved");
  assert.equal(preserved.notificationBinding?.wake, "bound");
  assert.equal(preserved.notificationBinding?.target.codexThreadId, THREAD_A);
  await waitTerminal(client, worker.id, 20_000);

  const takeover = await client.request<WorkerSummary>("resume", {
    workerId: worker.id,
    prompt: "[scenario:report] take over",
    notifyTarget: { channel: "codex-queue", codexThreadId: THREAD_B },
  });
  assert.equal(takeover.notificationBinding?.source, "explicit");
  assert.equal(takeover.notificationBinding?.target.codexThreadId, THREAD_B);
  await waitTerminal(client, worker.id, 20_000);
});

test("HS does not infer the caller thread from the environment", async (t) => {
  const daemon = await TestDaemon.create("hs-binding-env-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  const client = await daemon.start({ env: { CODEX_THREAD_ID: THREAD_A } });

  const worker = await spawnWorker(client, cwd, "[scenario:slow] binding env");
  const binding = worker.notificationBinding!;
  assert.equal(binding.source, "daemon-default");
  assert.equal(binding.wake, "unbound", "an environment variable is not a verified caller identity");
  assert.equal(binding.target.channel, "none");
  await client.request("cancel", { workerId: worker.id });
});