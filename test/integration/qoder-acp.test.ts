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
  FAKE_QODER_ACP_ENTRY,
  FAKE_QODER_ENTRY,
  TestDaemon,
  eventsOf,
  makeWorkspace,
  statusOf,
  waitForEvent,
  waitForStatus,
  waitPidDead,
  waitTerminal,
  waitTerminalLong,
} from "./helpers.js";

interface AcpHarness {
  daemon: TestDaemon;
  client: SupervisorClient;
  cwd: string;
  configDir: string;
}

async function startAcpHarness(
  t: TestContext,
  extraEnv: Record<string, string> = {},
): Promise<AcpHarness> {
  const daemon = await TestDaemon.create("hs-qoder-acp-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const configDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-acp-config-"));
  const cwd = await makeWorkspace("hs-qoder-acp-work-");
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_QODER_ENTRY: FAKE_QODER_ACP_ENTRY,
      HARNESS_SUPERVISOR_QODER_PROTOCOL: "acp",
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
  extra: Record<string, unknown> = {},
): Promise<WorkerSummary> {
  return client.request<WorkerSummary>(
    "spawn",
    { runtime: "qoder", cwd, prompt, ...extra },
    { timeoutMs: 60_000 },
  );
}

async function readJsonLines(file: string): Promise<unknown[]> {
  const raw = await readFile(file, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

test("Qoder ACP runs a worker, maps mode/model, and resumes through its handle", async (t) => {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-acp-logs-"));
  const argvLog = path.join(logDir, "argv.jsonl");
  const configLog = path.join(logDir, "config.jsonl");
  const promptLog = path.join(logDir, "prompts.jsonl");
  const { client, cwd } = await startAcpHarness(t, {
    FAKE_QODER_ARGV_LOG: argvLog,
    FAKE_QODER_ACP_CONFIG_LOG: configLog,
    FAKE_QODER_ACP_PROMPT_LOG: promptLog,
  });

  const worker = await spawnQoder(client, cwd, "[scenario:basic] acp spawn", {
    model: "Fake Model B",
    thinking: "high",
  });
  assert.equal(worker.runtime, "qoder");
  assert.equal(worker.capabilities.steer, false);
  assert.equal(worker.capabilities.followUp, false);
  assert.equal(worker.capabilities.resume, true);
  assert.equal(worker.capabilities.interactiveInput, true);

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_QODER_ACP_OK");
  assert.equal(final.worker.stats.turns, 1);
  assert.equal(final.worker.stats.toolCalls, 0);
  assert.ok(final.worker.sessionId, "ACP session id must be recorded");
  assert.ok(
    final.worker.sessionFile?.endsWith("qoder-acp-session.json"),
    `unexpected session handle: ${final.worker.sessionFile}`,
  );
  assert.equal(existsSync(final.worker.sessionFile!), true);
  const handle = JSON.parse(
    (await readFile(final.worker.sessionFile!, "utf8")).split("\n")[0]!,
  ) as { type?: string; id?: string; protocol?: string; models?: unknown[] };
  assert.equal(handle.type, "session");
  assert.equal(handle.protocol, "acp");
  assert.equal(handle.id, final.worker.sessionId);
  assert.ok(Array.isArray(handle.models) && handle.models.length > 0);

  assert.deepEqual(await readJsonLines(argvLog), [["--acp"]]);
  assert.deepEqual(await readJsonLines(configLog), [
    { configId: "mode", value: "yolo" },
    { configId: "model", value: "fake-model-b" },
    { configId: "reasoning_effort", value: "high" },
  ]);

  const events = await eventsOf(client, worker.id, 0);
  const progressKinds = events.events
    .filter((event) => event.type === "run.progress")
    .map((event) => event.data?.kind);
  for (const kind of ["session_init", "assistant_message", "thinking", "turn_complete"]) {
    assert.ok(progressKinds.includes(kind), `missing progress kind ${kind}`);
  }
  assert.equal(
    events.events.some((event) => event.type === "run.usage"),
    false,
    "all-zero ACP usage must not be recorded as real token usage",
  );
  assert.equal(events.events.filter((event) => event.type === "run.completed").length, 1);

  await client.request(
    "resume",
    {
      workerId: worker.id,
      prompt: "[scenario:basic] acp resume",
      model: "Fake Model B",
      thinking: "low",
    },
    { timeoutMs: 60_000 },
  );
  const resumed = await waitTerminal(client, worker.id, 20_000, final.nextSeq);
  assert.equal(resumed.worker.status, "completed");
  assert.equal(resumed.worker.result?.text, "FAKE_QODER_ACP_OK");
  assert.equal(resumed.worker.sessionId, final.worker.sessionId);
  assert.equal(resumed.worker.sessionFile, final.worker.sessionFile);
  assert.equal(resumed.worker.resumeCount, 1);
  assert.equal(resumed.worker.capabilities.steer, false);

  const configsAfterResume = await readJsonLines(configLog);
  assert.deepEqual(configsAfterResume.slice(3), [
    { configId: "mode", value: "yolo" },
    { configId: "model", value: "fake-model-b" },
    { configId: "reasoning_effort", value: "low" },
  ]);
  const prompts = await readJsonLines(promptLog);
  assert.equal(prompts.length, 2);
  assert.match(String(prompts[0]), /acp spawn/);
  assert.match(String(prompts[1]), /acp resume/);
});

test("Qoder ACP permission requests surface the native options and map the answer", async (t) => {
  const { client, cwd } = await startAcpHarness(t, {
    HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "default",
  });
  const worker = await spawnQoder(client, cwd, "[scenario:permission] edit a file");
  await waitForStatus(client, worker.id, ["awaiting_input"], 10_000);
  const pending = await statusOf(client, worker.id);
  assert.equal(pending.worker.pendingInput?.method, "select");
  assert.deepEqual(pending.worker.pendingInput?.options, [
    "Always allow",
    "Allow once",
    "Reject",
  ]);
  const expiry = Date.parse(pending.worker.pendingInput!.expiresAt!);
  assert.ok(
    expiry - Date.now() > 20 * 60_000,
    "the ACP input window is 30 minutes by default",
  );

  await client.request("answer", {
    workerId: worker.id,
    requestId: pending.worker.pendingInput!.requestId,
    response: { value: "Allow once" },
  });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "PERMISSION_ALLOWED:proceed_once");

  const events = await eventsOf(client, worker.id, 0);
  const toolStart = events.events.find(
    (event) => event.type === "run.progress" && event.data?.kind === "tool_start",
  );
  assert.equal(toolStart?.data?.tool, "edit");
  const toolEnd = events.events.find(
    (event) => event.type === "run.progress" && event.data?.kind === "tool_end",
  );
  assert.equal(toolEnd?.data?.tool, "edit");
  assert.equal(events.events.filter((event) => event.type === "run.needs_input").length, 1);
  assert.equal(events.events.filter((event) => event.type === "run.input_answered").length, 1);

  const deniedWorker = await spawnQoder(client, cwd, "[scenario:permission] deny this one");
  await waitForStatus(client, deniedWorker.id, ["awaiting_input"], 10_000);
  const deniedPending = await statusOf(client, deniedWorker.id);
  await client.request("answer", {
    workerId: deniedWorker.id,
    requestId: deniedPending.worker.pendingInput!.requestId,
    response: { value: "Reject" },
  });
  const denied = await waitTerminal(client, deniedWorker.id, 20_000);
  assert.equal(denied.worker.status, "completed");
  assert.equal(denied.worker.result?.text, "PERMISSION_DENIED:cancel");
});

test("Qoder ACP AskUserQuestion arrives as a selectable elicitation", async (t) => {
  const { client, cwd } = await startAcpHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:elicitation] ask me");
  await waitForStatus(client, worker.id, ["awaiting_input"], 10_000);
  const pending = await statusOf(client, worker.id);
  assert.equal(pending.worker.pendingInput?.method, "select");
  assert.equal(pending.worker.pendingInput?.title, "确认");
  assert.deepEqual(pending.worker.pendingInput?.options, ["是", "否"]);

  await client.request("answer", {
    workerId: worker.id,
    requestId: pending.worker.pendingInput!.requestId,
    response: { value: "是" },
  });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, 'ANSWERED:{"q0":"是"}');
  const events = await eventsOf(client, worker.id, 0);
  assert.equal(events.events.filter((event) => event.type === "run.needs_input").length, 1);
  assert.equal(events.events.filter((event) => event.type === "run.input_answered").length, 1);
});

test("Qoder ACP multi-field elicitation accepts a JSON object answer", async (t) => {
  const { client, cwd } = await startAcpHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:multi-question] ask two questions");
  await waitForStatus(client, worker.id, ["awaiting_input"], 10_000);
  const pending = await statusOf(client, worker.id);
  assert.equal(pending.worker.pendingInput?.method, "input");
  assert.match(pending.worker.pendingInput?.message ?? "", /"q0"/);

  await client.request("answer", {
    workerId: worker.id,
    requestId: pending.worker.pendingInput!.requestId,
    response: { value: JSON.stringify({ q0: "Blue", q1: "备注" }) },
  });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, 'MULTI_ACCEPT:{"q0":"blue","q1":"备注"}');
});

test("Qoder ACP withdrawals clear pending input instead of leaving awaiting_input", async (t) => {
  const { client, cwd } = await startAcpHarness(t);

  const permissionWorker = await spawnQoder(
    client,
    cwd,
    "[scenario:withdraw-permission] withdraw the approval",
  );
  await waitForStatus(client, permissionWorker.id, ["awaiting_input"], 10_000);
  const permissionPending = await statusOf(client, permissionWorker.id);
  const permissionRequestId = permissionPending.worker.pendingInput!.requestId;
  const permissionFinal = await waitTerminalLong(client, permissionWorker.id, 20_000);
  assert.equal(permissionFinal.worker.status, "completed");
  assert.equal(permissionFinal.worker.pendingInput, undefined);
  assert.equal(permissionFinal.inputState?.state, "withdrawn");
  const permissionEvents = await eventsOf(client, permissionWorker.id, 0);
  const permissionWithdrawal = permissionEvents.events.find(
    (event) =>
      event.type === "run.progress" && event.data?.kind === "permission_withdrawn",
  );
  assert.equal(permissionWithdrawal?.data?.detail, permissionRequestId);
  assert.equal(permissionWithdrawal?.data?.pendingInputCleared, true);

  const questionWorker = await spawnQoder(
    client,
    cwd,
    "[scenario:withdraw-question] withdraw the question",
  );
  await waitForStatus(client, questionWorker.id, ["awaiting_input"], 10_000);
  const questionPending = await statusOf(client, questionWorker.id);
  const questionRequestId = questionPending.worker.pendingInput!.requestId;
  const questionFinal = await waitTerminalLong(client, questionWorker.id, 20_000);
  assert.equal(questionFinal.worker.status, "completed");
  assert.equal(questionFinal.worker.pendingInput, undefined);
  assert.equal(questionFinal.inputState?.state, "withdrawn");
  const questionEvents = await eventsOf(client, questionWorker.id, 0);
  const questionWithdrawal = questionEvents.events.find(
    (event) => event.type === "run.progress" && event.data?.kind === "input_withdrawn",
  );
  assert.equal(questionWithdrawal?.data?.detail, questionRequestId);
  assert.equal(questionWithdrawal?.data?.pendingInputCleared, true);
});

test("Qoder ACP cancellation stops the turn and the process", async (t) => {
  const { client, cwd } = await startAcpHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:cancel] keep working");
  await waitForEvent(client, worker.id, "run.started", 5000);
  await sleep(100);
  const running = await statusOf(client, worker.id);
  assert.equal(running.worker.status, "running");
  assert.ok(running.worker.pid);

  await client.request("cancel", { workerId: worker.id }, { timeoutMs: 30_000 });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "cancelled");
  await waitPidDead(running.worker.pid!, 10_000);
  const events = await eventsOf(client, worker.id, 0);
  assert.equal(events.events.filter((event) => event.type === "run.cancelled").length, 1);
  assert.equal(events.events.some((event) => event.type === "run.completed"), false);
});

test("Qoder ACP prompt failures become failed workers with the runtime error", async (t) => {
  const { client, cwd } = await startAcpHarness(t);
  const worker = await spawnQoder(client, cwd, "[scenario:fail] fail honestly");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "failed");
  assert.match(final.worker.error ?? "", /FAKE_QODER_ACP_FAILURE/);
  const events = await eventsOf(client, worker.id, 0);
  assert.equal(events.events.some((event) => event.type === "run.completed"), false);
});

test("Qoder ACP rejects plan mode and tool allowlists instead of ignoring them", async (t) => {
  const { client, cwd } = await startAcpHarness(t, {
    HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "plan",
  });
  await assert.rejects(
    spawnQoder(client, cwd, "[scenario:basic] plan mode"),
    /no equivalent for permission mode "plan"/,
  );
  await assert.rejects(
    spawnQoder(client, cwd, "[scenario:basic] tool allowlist", { tools: ["Read"] }),
    /does not expose a tool allowlist/,
  );
});

test("Qoder refuses to resume a worker with the other transport's handle", async (t) => {
  const daemon = await TestDaemon.create("hs-qoder-acp-mismatch-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const configDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-acp-mismatch-config-"));
  const cwd = await makeWorkspace("hs-qoder-acp-mismatch-work-");
  const baseEnv = {
    QODER_CONFIG_DIR: configDir,
    QODERCN_CONFIG_DIR: configDir,
  };
  const streamClient = await daemon.start({
    env: {
      ...baseEnv,
      HARNESS_SUPERVISOR_QODER_ENTRY: FAKE_QODER_ENTRY,
    },
  });
  const worker = await spawnQoder(streamClient, cwd, "[scenario:basic] stream first");
  const final = await waitTerminal(streamClient, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.ok(final.worker.sessionFile?.endsWith(`${final.worker.sessionId}.jsonl`));
  await daemon.stop();

  const acpClient = await daemon.start({
    env: {
      ...baseEnv,
      HARNESS_SUPERVISOR_QODER_ENTRY: FAKE_QODER_ACP_ENTRY,
      HARNESS_SUPERVISOR_QODER_PROTOCOL: "acp",
    },
  });
  await assert.rejects(
    acpClient.request(
      "resume",
      { workerId: worker.id, prompt: "must not load" },
      { timeoutMs: 30_000 },
    ),
    /stream-json transport/,
  );
  const after = await statusOf(acpClient, worker.id);
  assert.equal(after.worker.status, "completed", "the failed resume must not fake a run");
});
