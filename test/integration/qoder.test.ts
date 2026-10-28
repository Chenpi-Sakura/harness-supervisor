import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupervisorClient } from "../../src/ipc/client.js";
import type { WorkerSummary } from "../../src/types.js";
import { sleep } from "../../src/util/async.js";
import {
  FAKE_QODER_ENTRY,
  TestDaemon,
  eventsOf,
  makeWorkspace,
  statusOf,
  waitForEvent,
  waitForStatus,
  waitPidDead,
  waitTerminal,
} from "./helpers.js";

interface QoderHarness {
  daemon: TestDaemon;
  client: SupervisorClient;
  cwd: string;
  configDir: string;
}

async function startQoderHarness(
  t: TestContext,
  extraEnv: Record<string, string> = {},
): Promise<QoderHarness> {
  const daemon = await TestDaemon.create("hs-qoder-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const configDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-config-"));
  const cwd = await makeWorkspace("hs-qoder-work-");
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_QODER_ENTRY: FAKE_QODER_ENTRY,
      QODER_CONFIG_DIR: configDir,
      QODERCN_CONFIG_DIR: configDir,
      ...extraEnv,
    },
  });
  return { daemon, client, cwd, configDir };
}

function spawnQoder(
  client: SupervisorClient,
  cwd: string,
  prompt: string,
): Promise<WorkerSummary> {
  return client.request<WorkerSummary>(
    "spawn",
    { runtime: "qoder", cwd, prompt },
    { timeoutMs: 60_000 },
  );
}

test("Qoder worker runs through stream-json, persists a session, and exposes tool events", async (t) => {
  const { client, cwd } = await startQoderHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:basic] inspect and report");
  assert.equal(worker.runtime, "qoder");
  assert.equal(worker.capabilities.steer, true);
  assert.equal(worker.capabilities.interactiveInput, true);

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_QODER_OK");
  assert.equal(final.worker.stats.turns, 1);
  assert.equal(final.worker.stats.toolCalls, 1);
  assert.equal(final.worker.stats.toolErrors, 0);
  assert.ok(final.worker.sessionId, "session id must be recorded");
  assert.ok(final.worker.sessionFile, "session file must be recorded");
  assert.equal(existsSync(final.worker.sessionFile!), true);
  assert.ok(final.worker.sessionFile!.endsWith(`${final.worker.sessionId}.jsonl`));

  const events = await eventsOf(client, worker.id, 0);
  const progressKinds = events.events
    .filter((event) => event.type === "run.progress")
    .map((event) => event.data?.kind);
  for (const kind of [
    "session_init",
    "tool_start",
    "tool_end",
    "assistant_message",
    "turn_complete",
    "usage",
  ]) {
    assert.ok(progressKinds.includes(kind), `missing progress kind ${kind}`);
  }
  const sessionEvent = events.events.find((event) => event.type === "worker.session");
  assert.equal(sessionEvent?.data?.fileExists, true);
  assert.equal(events.events.some((event) => event.type === "run.failed"), false);
  assert.equal(events.events.filter((event) => event.type === "run.completed").length, 1);

  const list = await client.request<WorkerSummary[]>("list", {});
  assert.equal(list.length, 1, "one spawn must create exactly one worker");
});

async function qoderArgv(t: TestContext, env: Record<string, string> = {}): Promise<{
  client: SupervisorClient;
  cwd: string;
  args: string[];
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-argv-"));
  const argvLog = path.join(dir, "argv.jsonl");
  const { client, cwd } = await startQoderHarness(t, {
    FAKE_QODER_ARGV_LOG: argvLog,
    ...env,
  });
  const worker = await spawnQoder(client, cwd, "[scenario:basic] permission mode");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  const calls = (await readFile(argvLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  assert.ok(calls.length >= 1, "the fake CLI must record its argv");
  return { client, cwd, args: calls[0]! };
}

test("Qoder starts workers with bypass_permissions and the init record confirms it", async (t) => {
  const { client, args } = await qoderArgv(t);
  const flag = args.indexOf("--permission-mode");
  assert.ok(flag >= 0, "HS must pass --permission-mode explicitly");
  assert.equal(args[flag + 1], "bypass_permissions");
  assert.equal(
    args.filter((arg) => arg === "--permission-mode").length,
    1,
    "the mode is passed exactly once",
  );

  const worker = (await client.request<WorkerSummary[]>("list", {}))[0]!;
  const events = await eventsOf(client, worker.id, 0);
  const init = events.events.find(
    (event) => event.type === "run.progress" && event.data?.kind === "session_init",
  );
  assert.match(String(init?.data?.detail ?? ""), /bypass_permissions/);
  assert.equal(
    events.events.some((event) => event.type === "run.needs_input"),
    false,
    "a full-permission run must not ask for approval",
  );
});

test("an explicit Qoder permission mode wins over the default", async (t) => {
  const { args } = await qoderArgv(t, { HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "auto" });
  const flag = args.indexOf("--permission-mode");
  assert.equal(args[flag + 1], "auto");
});

test("a Qoder permission downgrade fails startup instead of falling back", async (t) => {
  const { client, cwd } = await startQoderHarness(t, {
    FAKE_QODER_EFFECTIVE_PERMISSION_MODE: "auto",
  });
  await assert.rejects(
    spawnQoder(client, cwd, "[scenario:basic] downgrade"),
    /permission mode "auto".*"bypass_permissions" was requested/,
  );
  const list = await client.request<WorkerSummary[]>("list", {});
  assert.equal(
    list.some((worker) => worker.status === "starting" || worker.status === "running"),
    false,
    "a failed startup must not leave a live worker",
  );
});

test("Qoder accepts the camelCase init form of the requested mode", async (t) => {
  const { client, cwd } = await startQoderHarness(t, {
    FAKE_QODER_EFFECTIVE_PERMISSION_MODE: "bypassPermissions",
  });
  const worker = await spawnQoder(client, cwd, "[scenario:basic] camelCase mode");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_QODER_OK");
});

test("Qoder records a session file that appears after the first turn in another config root", async (t) => {
  const expectedRoot = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-config-a-"));
  const actualRoot = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-config-b-"));
  const { client, cwd } = await startQoderHarness(t, {
    QODER_CONFIG_DIR: expectedRoot,
    QODERCN_CONFIG_DIR: actualRoot,
    FAKE_QODER_LATE_SESSION: "1",
  });
  const worker = await spawnQoder(client, cwd, "[scenario:basic] write the session late");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.ok(final.worker.sessionFile, "the late session path must be recorded");
  assert.equal(existsSync(final.worker.sessionFile!), true);
  assert.ok(
    path.resolve(final.worker.sessionFile!).startsWith(path.resolve(actualRoot)),
    `expected the actual config root, got ${final.worker.sessionFile}`,
  );
  const events = await eventsOf(client, worker.id, 0);
  const sessionEvents = events.events.filter((event) => event.type === "worker.session");
  assert.ok(sessionEvents.some((event) => event.data?.fileExists === false));
  assert.ok(
    sessionEvents.some(
      (event) => event.data?.refreshed === true && event.data?.fileExists === true,
    ),
    "a refreshed worker.session event must record the late file",
  );
  assert.equal(final.worker.resumeAvailable, true);
});

test("Qoder steering interrupts a running turn and the final result reflects the steer", async (t) => {
  const { client, cwd } = await startQoderHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:steer] start with red");
  await waitForEvent(client, worker.id, "run.started", 5000);
  await sleep(100);

  await client.request("send", {
    workerId: worker.id,
    message: "STEER: use blue instead",
    mode: "steer",
  });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.match(final.worker.result?.text ?? "", /STEERED:STEER: use blue instead/);

  const events = await eventsOf(client, worker.id, 0);
  const sent = events.events.filter((event) => event.type === "run.message_sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.data?.mode, "steer");
  assert.equal(events.events.filter((event) => event.type === "run.completed").length, 1);
  const list = await client.request<WorkerSummary[]>("list", {});
  assert.equal(list.length, 1, "steering must not spawn a duplicate worker");
});

test("Qoder cancellation clears a queued follow-up, kills the process, and stays idempotent", async (t) => {
  const { client, cwd } = await startQoderHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:cancel] long running task");
  await waitForEvent(client, worker.id, "run.started", 5000);
  await sleep(100);

  await client.request("send", {
    workerId: worker.id,
    message: "queued follow-up that must not run",
    mode: "follow-up",
  });
  const cancelled = await client.request<WorkerSummary>("cancel", {
    workerId: worker.id,
    timeoutMs: 8000,
  });
  assert.equal(cancelled.status, "cancelled");

  const events = await eventsOf(client, worker.id, 0);
  const queueCleared = events.events.find(
    (event) => event.type === "run.progress" && event.data?.kind === "queue_cleared",
  );
  assert.ok(queueCleared, "queue_cleared progress is missing");
  assert.equal(queueCleared.data?.followUp, 1);
  assert.equal(
    events.events.filter((event) => event.type === "run.cancelled").length,
    1,
  );
  assert.equal(
    events.events.filter((event) => event.type === "run.completed").length,
    0,
  );
  if (cancelled.pid) await waitPidDead(cancelled.pid, 10_000);

  const again = await client.request<WorkerSummary>("cancel", {
    workerId: worker.id,
    timeoutMs: 5000,
  });
  assert.equal(again.status, "cancelled");
  const after = await eventsOf(client, worker.id, 0);
  assert.equal(
    after.events.filter((event) => event.type === "run.cancelled").length,
    1,
    "duplicate cancel must not record a second run.cancelled",
  );
});

test("Qoder resume continues the same native session and reads prior context", async (t) => {
  const { client, cwd } = await startQoderHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:basic] seed the session");
  const first = await waitTerminal(client, worker.id, 20_000);
  assert.equal(first.worker.status, "completed");
  const sessionId = first.worker.sessionId!;
  const sessionFile = first.worker.sessionFile!;
  const firstPid = first.worker.pid!;
  await waitPidDead(firstPid, 10_000);

  await client.request("resume", {
    workerId: worker.id,
    prompt: "recall the hidden seed",
  }, { timeoutMs: 60_000 });
  const resumed = await waitTerminal(client, worker.id, 20_000);
  assert.equal(resumed.worker.status, "completed");
  assert.equal(resumed.worker.sessionId, sessionId);
  assert.equal(resumed.worker.sessionFile, sessionFile);
  assert.equal(resumed.worker.resumeCount, 1);
  assert.match(resumed.worker.result?.text ?? "", /^RECALL:SEED-/);
  assert.doesNotMatch(resumed.worker.result?.text ?? "", /seed the session/);
  await waitPidDead(resumed.worker.pid!, 10_000);

  const events = await eventsOf(client, worker.id, 0);
  assert.equal(events.events.filter((event) => event.type === "worker.resumed").length, 1);
  assert.ok(
    events.events.filter((event) => event.type === "run.started").length >= 2,
    "resume must start a second run on the same worker",
  );
});

test("Qoder permission requests surface as awaiting_input and allow or deny correctly", async (t) => {
  const { client, cwd } = await startQoderHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:permission] run a command");
  await waitForStatus(client, worker.id, ["awaiting_input"], 10_000);
  const pending = await statusOf(client, worker.id);
  assert.ok(pending.worker.pendingInput);
  assert.equal(pending.worker.pendingInput?.method, "select");
  assert.deepEqual(pending.worker.pendingInput?.options, ["allow", "deny"]);

  await client.request("answer", {
    workerId: worker.id,
    requestId: pending.worker.pendingInput!.requestId,
    response: { value: "allow" },
  });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "PERMISSION_OK");
  const events = await eventsOf(client, worker.id, 0);
  assert.equal(
    events.events.filter((event) => event.type === "run.input_answered").length,
    1,
  );

  const deniedWorker = await spawnQoder(client, cwd, "[scenario:permission] run another command");
  await waitForStatus(client, deniedWorker.id, ["awaiting_input"], 10_000);
  const deniedPending = await statusOf(client, deniedWorker.id);
  await client.request("answer", {
    workerId: deniedWorker.id,
    requestId: deniedPending.worker.pendingInput!.requestId,
    response: { value: "deny" },
  });
  const denied = await waitTerminal(client, deniedWorker.id, 20_000);
  assert.equal(denied.worker.status, "failed");
  assert.match(denied.worker.error ?? "", /TOOL_DENIED/);
});

test("Qoder in-band auth failures are reported as failed, not completed", async (t) => {
  const { client, cwd } = await startQoderHarness(t, { FAKE_QODER_NOT_LOGGED_IN: "1" });
  const worker = await spawnQoder(client, cwd, "this must fail honestly");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "failed");
  assert.match(final.worker.error ?? "", /Not logged in/);
  assert.match(final.worker.error ?? "", /qodercli login/);
  const events = await eventsOf(client, worker.id, 0);
  const failed = events.events.find((event) => event.type === "run.failed");
  assert.ok(failed);
  assert.match(String(failed.data?.reason ?? ""), /Not logged in/);
  assert.equal(events.events.some((event) => event.type === "run.completed"), false);
});

test("Qoder pre-prompt in-band auth errors fail the spawn with the login hint", async (t) => {
  const { client, cwd } = await startQoderHarness(t, {
    FAKE_QODER_PREEMPTIVE_AUTH_FAIL: "1",
  });
  await assert.rejects(spawnQoder(client, cwd, "must never reach a model"), /Not logged in/);
  const list = await client.request<WorkerSummary[]>("list", {});
  assert.equal(list.length, 1);
  assert.equal(list[0]?.status, "failed");
  assert.match(list[0]?.error ?? "", /qodercli login/);
});

test("Qoder startup reports an honest login error when the CLI is not authenticated", async (t) => {
  const daemon = await TestDaemon.create("hs-qoder-auth-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const configDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-config-"));
  const cwd = await makeWorkspace("hs-qoder-work-");
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_QODER_ENTRY: FAKE_QODER_ENTRY,
      QODER_CONFIG_DIR: configDir,
      QODERCN_CONFIG_DIR: configDir,
      FAKE_QODER_AUTH_FAIL: "1",
    },
  });

  await assert.rejects(
    spawnQoder(client, cwd, "this must not start"),
    /qodercli login/,
  );
  const list = await client.request<WorkerSummary[]>("list", {});
  assert.equal(list.length, 1);
  assert.equal(list[0]?.status, "failed");
  assert.match(list[0]?.error ?? "", /qodercli login/);
});

test("two result records inside the settle window merge into one terminal state", async (t) => {
  const { client, cwd } = await startQoderHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:multi-result-near] two results quickly");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "SECOND", "the last result inside the window wins");

  const events = await eventsOf(client, worker.id);
  assert.equal(
    events.events.filter((event) => event.type === "run.completed").length,
    1,
    "a near-duplicate result must not create a second terminal event",
  );
});

test("a second result beyond the quiet window is ignored (documented early-settle limit)", async (t) => {
  const { client, cwd } = await startQoderHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:multi-result-wide] late second result");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FIRST", "the run settles on the first quiet result");

  // The late result arrives after the run already settled: it must not resurrect
  // the worker or emit a second completion (the risk is documented in README).
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await client.request<{ worker: { status: string; result?: { text: string } } }>(
    "status",
    { workerId: worker.id },
  );
  assert.equal(after.worker.status, "completed");
  assert.equal(after.worker.result?.text, "FIRST");
  const events = await eventsOf(client, worker.id);
  assert.equal(
    events.events.filter((event) => event.type === "run.completed").length,
    1,
    "exactly one terminal event even when a late result arrives",
  );
});
