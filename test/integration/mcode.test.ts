import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SupervisorClient } from "../../src/ipc/client.js";
import type { WorkerSummary } from "../../src/types.js";
import { WORKER_PROTOCOL_MARKER } from "../../src/worker-protocol.js";
import { sleep } from "../../src/util/async.js";
import {
  FAKE_MCODE_ENTRY,
  TestDaemon,
  eventsOf,
  makeWorkspace,
  statusOf,
  waitForEvent,
  waitForStatus,
  waitTerminal,
} from "./helpers.js";

interface McodeHarness {
  daemon: TestDaemon;
  client: SupervisorClient;
  cwd: string;
}

async function startMcodeHarness(
  t: TestContext,
  extraEnv: Record<string, string> = {},
): Promise<McodeHarness> {
  const daemon = await TestDaemon.create("hs-mcode-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-mcode-work-");
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_MCODE_ENTRY: FAKE_MCODE_ENTRY,
      // The suite must not depend on the ambient environment. A shell that
      // exports a permission mode (for example while a real daemon runs in
      // bypass mode) would otherwise decide what these tests observe: the
      // permission cases would silently see no approval request at all. The
      // Ask mode is pinned here, and a test that needs another mode states it
      // explicitly.
      HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "bypassPermissions",
      ...extraEnv,
    },
  });
  return { daemon, client, cwd };
}

function spawnMcode(
  client: SupervisorClient,
  cwd: string,
  prompt: string,
): Promise<WorkerSummary> {
  return client.request<WorkerSummary>(
    "spawn",
    { runtime: "mcode", cwd, prompt },
    { timeoutMs: 60_000 },
  );
}

test("MiniMax Code worker runs over ACP, streams the assistant message and completes", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "basic" });
  const worker = await spawnMcode(client, cwd, "hello");
  assert.equal(worker.runtime, "mcode");
  assert.equal(worker.capabilities.steer, true);
  assert.equal(worker.capabilities.followUp, true);
  assert.equal(worker.capabilities.cancel, true);
  assert.equal(worker.capabilities.resume, true);
  assert.equal(worker.capabilities.interactiveInput, true);

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  const resultText = final.worker.result?.text ?? "";
  assert.ok(
    resultText.startsWith(`FAKE_MCODE_OK:${WORKER_PROTOCOL_MARKER}\n`),
    "the native prompt carries the worker protocol block",
  );
  assert.ok(resultText.endsWith("\n\nhello"), "the original task stays at the end");
  assert.ok(final.worker.sessionId, "session id must be recorded");
  assert.ok(final.worker.sessionFile, "session file must be recorded");
  assert.equal(existsSync(final.worker.sessionFile!), true);

  const events = await eventsOf(client, worker.id, 0);
  const types = events.events.map((event) => event.type);
  assert.ok(types.includes("run.started"), "run.started must be recorded");
  assert.ok(types.includes("run.completed"), "run.completed must be recorded");
});

test("MiniMax Code session handle records the ACP session id for resume", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "basic" });
  const worker = await spawnMcode(client, cwd, "hello");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");

  const handle = JSON.parse(await readFile(final.worker.sessionFile!, "utf8")) as {
    type?: string;
    id?: string;
    runtime?: string;
  };
  assert.equal(handle.type, "session");
  assert.equal(handle.id, final.worker.sessionId);
  assert.equal(handle.runtime, "mcode");
});

test("MiniMax Code supervisor requests use string ids so agent requests cannot collide", async (t) => {
  // MiniMax Code numbers its reverse requests from zero. If the supervisor
  // used numeric ids too, an agent permission request could share an id with a
  // pending supervisor request and be mistaken for its answer.
  //
  // The fake agent is hostile on purpose: when the client uses a numeric id it
  // reuses that exact number for its own permission request, which is the
  // worst-case collision.
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "permission", HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default" });
  const worker = await spawnMcode(client, cwd, "needs approval");
  await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);

  const status = await statusOf(client, worker.id);
  const clientIds = status.stderrTail
    .split(/\r?\n/)
    .filter((line) => line.includes("FAKE_MCODE_CLIENT_ID"))
    .map((line) => line.slice(line.indexOf("{")).trim());
  assert.ok(clientIds.length > 0, "the fake agent must observe the supervisor's requests");
  for (const raw of clientIds) {
    const id = (JSON.parse(raw) as { id: unknown }).id;
    assert.equal(
      typeof id,
      "string",
      "supervisor request ids must be strings, because the agent uses numeric reverse-request ids",
    );
  }

  const events = await eventsOf(client, worker.id, 0);
  const needsInput = events.events.find((event) => event.type === "run.needs_input");
  assert.ok(needsInput, "the permission request must reach the supervisor");

  // The supervisor answered the agent's numeric id, so the agent's request was
  // not swallowed and the turn is still pending rather than silently settled.
  const completed = events.events.find((event) => event.type === "run.completed");
  assert.equal(completed, undefined, "the turn must not settle while waiting for an answer");
});

test("MiniMax Code permission request can be answered with the always-allow option", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "permission", HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default" });
  const worker = await spawnMcode(client, cwd, "needs approval");

  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  assert.ok(awaiting.pendingInput);

  // "Always allow" is a second allow option. Answering with it must not be
  // turned into a denial.
  await client.request<WorkerSummary>(
    "answer",
    {
      workerId: worker.id,
      requestId: awaiting.pendingInput!.requestId,
      response: { value: "Always allow" },
    },
    { timeoutMs: 30_000 },
  );

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_MCODE_OK");
});

test("MiniMax Code worker can be resumed from its session handle", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "basic" });
  const worker = await spawnMcode(client, cwd, "first");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");

  const resumed = await client.request<WorkerSummary>(
    "resume",
    { workerId: worker.id, prompt: "second" },
    { timeoutMs: 60_000 },
  );
  assert.equal(resumed.id, worker.id);
  const resumedFinal = await waitTerminal(client, worker.id, 20_000);
  assert.equal(resumedFinal.worker.status, "completed");
  const resumedEvents = await eventsOf(client, worker.id, 0);
  const types = resumedEvents.events.map((event) => event.type);
  assert.ok(types.includes("worker.resumed"), "worker.resumed must be recorded");
});

test("MiniMax Code tool calls are surfaced as progress events", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "tools" });
  const worker = await spawnMcode(client, cwd, "run a tool");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");

  const events = await eventsOf(client, worker.id, 0);
  const progress = events.events.filter((event) => event.type === "run.progress");
  const kinds = progress.map((event) => (event.data as { kind?: string } | undefined)?.kind);
  assert.ok(kinds.includes("tool_start"), "tool_start progress must be recorded");
  assert.ok(kinds.includes("tool_end"), "tool_end progress must be recorded");
});

test("MiniMax Code permission request becomes awaiting_input and is answerable", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "permission", HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default" });
  const worker = await spawnMcode(client, cwd, "needs approval");

  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  assert.ok(awaiting.pendingInput, "pending input must be recorded");
  assert.equal(awaiting.pendingInput!.method, "select");
  assert.deepEqual(awaiting.pendingInput!.options, ["Allow once", "Always allow", "Deny"]);
  const pendingStatus = await statusOf(client, worker.id);
  assert.equal(pendingStatus.inputState?.state, "pending");
  assert.ok(
    Date.parse(awaiting.pendingInput!.expiresAt!) - Date.now() > 20 * 60_000,
    "MiniMax Code uses the 30-minute default, not the old five-minute timer",
  );

  const answered = await client.request<WorkerSummary>(
    "answer",
    {
      workerId: worker.id,
      requestId: awaiting.pendingInput!.requestId,
      response: { value: "Allow once" },
    },
    { timeoutMs: 30_000 },
  );
  assert.equal(answered.pendingInput, undefined);

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_MCODE_OK");
});

test("MiniMax Code input deadline can be configured for the runtime", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, {
    FAKE_MCODE_SCENARIO: "permission",
    HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default",
    HARNESS_SUPERVISOR_MCODE_INPUT_TIMEOUT_MS: "60000",
  });
  const worker = await spawnMcode(client, cwd, "configurable deadline");
  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  const remaining = Date.parse(awaiting.pendingInput!.expiresAt!) - Date.now();
  assert.ok(remaining > 50_000 && remaining <= 61_000, `unexpected window: ${remaining}ms`);
  await client.request("answer", {
    workerId: worker.id,
    requestId: awaiting.pendingInput!.requestId,
    response: { value: "Allow once" },
  });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
});

test("native permission withdrawal clears the live input and suppresses its inbox reminder", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, {
    FAKE_MCODE_SCENARIO: "permission",
    HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default",
    FAKE_MCODE_WITHDRAW_PERMISSION: "1",
  });
  const worker = await spawnMcode(client, cwd, "withdraw this approval");
  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 10000);
  assert.ok(awaiting.pendingInput);
  const running = await waitForStatus(client, worker.id, ["running"], 10000);
  assert.equal(running.pendingInput, undefined);
  const current = await client.request<{notifications: {kind: string}[]}>("notifications", {workerId: worker.id});
  assert.equal(current.notifications.some(n => n.kind === "needs_input"), false);
  const history = await client.request<{notifications: {kind: string; delivery: {state: string}}[]}>("notifications", {workerId: worker.id, state: "all"});
  assert.ok(history.notifications.some(n => n.kind === "needs_input" && n.delivery.state === "superseded"));
  await assert.rejects(client.request("answer", {workerId: worker.id, requestId: awaiting.pendingInput.requestId, response: {value: "Allow once"}}));
  const events = await eventsOf(client, worker.id, 0);
  assert.ok(events.events.some(e => e.type === "run.progress" && e.data?.kind === "permission_withdrawn" && e.data?.pendingInputCleared === true));
  await client.request("cancel", {workerId: worker.id});
});

test("MiniMax Code permission request can be denied by option label", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "permission", HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default" });
  const worker = await spawnMcode(client, cwd, "needs approval");

  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  assert.ok(awaiting.pendingInput);

  await client.request<WorkerSummary>(
    "answer",
    {
      workerId: worker.id,
      requestId: awaiting.pendingInput!.requestId,
      response: { value: "Deny" },
    },
    { timeoutMs: 30_000 },
  );

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_MCODE_DENIED");
});

test("MiniMax Code defaults to bypassPermissions without approval prompts", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "permission" });
  const worker = await spawnMcode(client, cwd, "needs approval");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_MCODE_OK");
  const events = await eventsOf(client, worker.id, 0);
  assert.equal(
    events.events.some((event) => event.type === "run.needs_input"),
    false,
    "the default full-permission mode must not ask for approval",
  );
});

test("MiniMax Code worker switches the session into the Ask permission mode", async (t) => {
  // MiniMax Code itself starts in bypassPermissions, so a permission request
  // only appears when the supervisor switches the session to the Ask mode.
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "permission", HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default" });
  const worker = await spawnMcode(client, cwd, "needs approval");

  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  assert.ok(awaiting.pendingInput, "the supervisor must ask for approval by default");

  await client.request<WorkerSummary>(
    "answer",
    {
      workerId: worker.id,
      requestId: awaiting.pendingInput!.requestId,
      response: { value: "Allow once" },
    },
    { timeoutMs: 30_000 },
  );
  await waitTerminal(client, worker.id, 20_000);
});

test("MiniMax Code worker can keep the bypass permission mode", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, {
    FAKE_MCODE_SCENARIO: "permission",
    HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "bypassPermissions",
  });
  const worker = await spawnMcode(client, cwd, "needs approval");

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  // No permission was requested, so the run finished on its own.
  assert.equal(final.worker.result?.text, "FAKE_MCODE_OK");
  assert.equal(final.worker.pendingInput, undefined);
});

test("MiniMax Code run can be cancelled while it is still running", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "hang" });
  const worker = await spawnMcode(client, cwd, "never finishes");
  await waitForStatus(client, worker.id, ["running"], 15_000);

  const cancelled = await client.request<WorkerSummary>(
    "cancel",
    { workerId: worker.id },
    { timeoutMs: 30_000 },
  );
  assert.equal(cancelled.status, "cancelled");

  const events = await eventsOf(client, worker.id, 0);
  const types = events.events.map((event) => event.type);
  assert.ok(types.includes("run.cancelled"), "run.cancelled must be recorded");
});

test("Supervisor maxDuration still cancels an unbounded ACP prompt", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "hang" });
  const worker = await client.request<WorkerSummary>("spawn", {
    runtime: "mcode", cwd, prompt: "wait for cancellation", maxDurationMs: 1000,
  }, { timeoutMs: 60_000 });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "cancelled");
  assert.equal(final.worker.statusReason, "max_duration_exceeded");
});

test("MiniMax Code run errors are reported as a failed worker", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "fail" });
  const worker = await spawnMcode(client, cwd, "boom");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "failed");
  assert.ok(final.worker.error, "failure reason must be recorded");
});

test("MiniMax Code steering uses the mcode/session/steer extension", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "hang" });
  const worker = await spawnMcode(client, cwd, "keep going");
  await waitForStatus(client, worker.id, ["running"], 15_000);

  const sent = await client.request<WorkerSummary>(
    "send",
    { workerId: worker.id, message: "adjust the plan", mode: "steer" },
    { timeoutMs: 30_000 },
  );
  assert.equal(sent.id, worker.id);

  const events = await eventsOf(client, worker.id, 0);
  const types = events.events.map((event) => event.type);
  assert.ok(types.includes("run.message_sent"), "run.message_sent must be recorded");
});

test("MiniMax Code reports unsupported steering when the build lacks the extension", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, {
    FAKE_MCODE_SCENARIO: "noext",
    // Without this the turn can finish between the status read and the send,
    // turning the expected UNSUPPORTED into a terminal-state error.
    FAKE_MCODE_FINISH_MS: "1500",
  });
  const worker = await spawnMcode(client, cwd, "keep going");
  await waitForStatus(client, worker.id, ["running"], 15_000);

  await assert.rejects(
    () =>
      client.request(
        "send",
        { workerId: worker.id, message: "adjust the plan", mode: "steer" },
        { timeoutMs: 30_000 },
      ),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      assert.equal(code, "UNSUPPORTED");
      return true;
    },
  );
});

test("MiniMax Code runtime is listed in supervisor info", async (t) => {
  const { client } = await startMcodeHarness(t);
  const info = await client.request<{
    runtimes: Array<{ runtime: string; steer: boolean; resume: boolean }>;
  }>("info", {});
  const runtime = info.runtimes.find((item) => item.runtime === "mcode");
  assert.ok(runtime, "mcode must be advertised as a runtime");
  assert.equal(runtime!.steer, true);
  assert.equal(runtime!.resume, true);
});

test("MiniMax Code worker records a progress event before it finishes", async (t) => {
  const { client, cwd } = await startMcodeHarness(t, { FAKE_MCODE_SCENARIO: "basic" });
  const worker = await spawnMcode(client, cwd, "hello");
  const event = await waitForEvent(client, worker.id, "run.progress", 15_000);
  assert.ok(event.events.length > 0);
  const kinds = event.events
    .filter((item) => item.type === "run.progress")
    .map((item) => (item.data as { kind?: string } | undefined)?.kind);
  assert.ok(kinds.includes("assistant_message"), "assistant message progress must be recorded");
  await sleep(10);
  await statusOf(client, worker.id);
});
