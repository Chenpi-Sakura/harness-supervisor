import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SupervisorClient } from "../../src/ipc/client.js";
import type { WorkerSummary } from "../../src/types.js";
import { WORKER_PROTOCOL_MARKER } from "../../src/worker-protocol.js";
import { sleep } from "../../src/util/async.js";
import {
  FAKE_DSH_ENTRY,
  TestDaemon,
  eventsOf,
  makeWorkspace,
  statusOf,
  waitForStatus,
  waitTerminal,
} from "./helpers.js";

interface DshHarness {
  daemon: TestDaemon;
  client: SupervisorClient;
  cwd: string;
}

async function startDshHarness(
  t: TestContext,
  extraEnv: Record<string, string> = {},
): Promise<DshHarness> {
  const daemon = await TestDaemon.create("hs-dsh-");
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
  });
  const cwd = await makeWorkspace("hs-dsh-work-");
  const client = await daemon.start({
    env: {
      HARNESS_SUPERVISOR_DSH_ENTRY: FAKE_DSH_ENTRY,
      // Keep the default-mode assertion independent of the developer's ambient env.
      HARNESS_SUPERVISOR_DSH_PERMISSION_MODE: "",
      DSH_PERMISSION_MODE: "",
      ...extraEnv,
    },
  });
  return { daemon, client, cwd };
}

function spawnDsh(
  client: SupervisorClient,
  cwd: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<WorkerSummary> {
  return client.request<WorkerSummary>(
    "spawn",
    { runtime: "dsh", cwd, prompt, ...extra },
    { timeoutMs: 60_000 },
  );
}

test("DSH worker runs over ACP, streams updates and completes", async (t) => {
  const { client, cwd } = await startDshHarness(t);
  const worker = await spawnDsh(client, cwd, "hello");
  assert.equal(worker.runtime, "dsh");
  assert.equal(worker.capabilities.steer, false);
  assert.equal(worker.capabilities.followUp, false);
  assert.equal(worker.capabilities.cancel, true);
  assert.equal(worker.capabilities.resume, true);
  assert.equal(worker.capabilities.interactiveInput, true);

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  const resultText = final.worker.result?.text ?? "";
  assert.ok(
    resultText.startsWith(`FAKE_DSH_OK:${WORKER_PROTOCOL_MARKER}\n`),
    "the native prompt carries the worker protocol block",
  );

  const events = await eventsOf(client, worker.id, 0);
  const kinds = events.events
    .filter((event) => event.type === "run.progress")
    .map((event) => (event.data as { kind?: string } | undefined)?.kind);
  assert.ok(kinds.includes("thinking"), "thought chunks must be recorded");
  assert.ok(kinds.includes("tool_start"), "tool_start must be recorded");
  assert.ok(kinds.includes("tool_end"), "tool_end must be recorded");
  assert.ok(kinds.includes("assistant_message"), "assistant text must be recorded");
  assert.ok(kinds.includes("context_usage"), "context usage must be observable");
  assert.equal(
    events.events.some((event) => event.type === "run.usage"),
    false,
    "context occupancy must not be misreported as billed token usage",
  );
});

test("DSH passes the native workspace-write permission mode by default", async (t) => {
  const { client, cwd } = await startDshHarness(t);
  const worker = await spawnDsh(client, cwd, "hello");
  await waitTerminal(client, worker.id, 20_000);
  const status = await statusOf(client, worker.id);
  const line = status.stderrTail
    .split(/\r?\n/)
    .find((item) => item.includes("FAKE_DSH_ENV"));
  assert.ok(line, "the fake agent must observe DSH_PERMISSION_MODE");
  const env = JSON.parse(line.slice(line.indexOf("{"))) as {
    DSH_PERMISSION_MODE?: string;
  };
  assert.equal(env.DSH_PERMISSION_MODE, "workspace-write");
});

test("DSH permission mode can be overridden for the daemon", async (t) => {
  const { client, cwd } = await startDshHarness(t, {
    HARNESS_SUPERVISOR_DSH_PERMISSION_MODE: "danger-full-access",
  });
  const worker = await spawnDsh(client, cwd, "hello");
  await waitTerminal(client, worker.id, 20_000);
  const status = await statusOf(client, worker.id);
  const line = status.stderrTail
    .split(/\r?\n/)
    .find((item) => item.includes("FAKE_DSH_ENV"));
  assert.ok(line, "the fake agent must observe DSH_PERMISSION_MODE");
  const env = JSON.parse(line.slice(line.indexOf("{"))) as {
    DSH_PERMISSION_MODE?: string;
  };
  assert.equal(env.DSH_PERMISSION_MODE, "danger-full-access");
});

test("DSH session handle records the ACP session id and runtime", async (t) => {
  const { client, cwd } = await startDshHarness(t);
  const worker = await spawnDsh(client, cwd, "hello");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.ok(final.worker.sessionFile);

  const handle = JSON.parse(await readFile(final.worker.sessionFile!, "utf8")) as {
    type?: string;
    id?: string;
    runtime?: string;
    protocol?: string;
  };
  assert.equal(handle.type, "session");
  assert.equal(handle.id, final.worker.sessionId);
  assert.equal(handle.runtime, "dsh");
  assert.equal(handle.protocol, "acp");
});

test("DSH model and reasoning selections are applied through config options", async (t) => {
  const { client, cwd } = await startDshHarness(t);
  const worker = await spawnDsh(client, cwd, "configure", {
    provider: "deepseek-official",
    model: "deepseek-flash",
    thinking: "max",
  });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");

  const status = await statusOf(client, worker.id);
  const configs = status.stderrTail
    .split(/\r?\n/)
    .filter((line) => line.includes("FAKE_DSH_CONFIG"))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as {
      configId?: string;
      value?: string;
    });
  const model = configs.find((item) => item.configId === "model");
  assert.equal(model?.value, JSON.stringify(["deepseek-official", "deepseek-flash"]));
  const reasoning = configs.find((item) => item.configId === "reasoning_effort");
  assert.equal(reasoning?.value, "max");
});

test("DSH refuses an ambiguous model instead of guessing a provider", async (t) => {
  const { client, cwd } = await startDshHarness(t);
  await assert.rejects(
    () => spawnDsh(client, cwd, "configure", { model: "DeepSeek-V4.1-Flash" }),
    /more than one provider/,
  );
});

test("DSH refuses config values the fake agent rejects", async (t) => {
  const { client, cwd } = await startDshHarness(t, { FAKE_DSH_SCENARIO: "configfail" });
  await assert.rejects(
    () => spawnDsh(client, cwd, "configure", { thinking: "max" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSUPPORTED");
      assert.match((error as Error).message, /fake config rejected/);
      return true;
    },
  );
});

test("DSH worker can be resumed from its session handle", async (t) => {
  const { client, cwd } = await startDshHarness(t);
  const worker = await spawnDsh(client, cwd, "first");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  const sessionId = final.worker.sessionId;
  const sessionFile = final.worker.sessionFile;

  const resumed = await client.request<WorkerSummary>(
    "resume",
    { workerId: worker.id, prompt: "second" },
    { timeoutMs: 60_000 },
  );
  assert.equal(resumed.id, worker.id);

  const resumedFinal = await waitTerminal(client, worker.id, 20_000);
  assert.equal(resumedFinal.worker.status, "completed");
  assert.equal(resumedFinal.worker.sessionId, sessionId);
  assert.equal(resumedFinal.worker.sessionFile, sessionFile);
  assert.ok(
    (resumedFinal.worker.result?.text ?? "").startsWith(
      `FAKE_DSH_RESUMED:${WORKER_PROTOCOL_MARKER}\n`,
    ),
    "the fake agent must observe session/resume before the new prompt",
  );

  const events = await eventsOf(client, worker.id, 0);
  const types = events.events.map((event) => event.type);
  assert.ok(types.includes("worker.resumed"), "worker.resumed must be recorded");
});

test("DSH permission request becomes awaiting_input and can be allowed", async (t) => {
  const { client, cwd } = await startDshHarness(t, { FAKE_DSH_SCENARIO: "permission" });
  const worker = await spawnDsh(client, cwd, "needs approval");

  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  assert.ok(awaiting.pendingInput, "pending input must be recorded");
  assert.equal(awaiting.pendingInput!.method, "select");
  assert.deepEqual(awaiting.pendingInput!.options, ["Allow once", "Reject"]);
  assert.match(awaiting.pendingInput!.title ?? "", /call_perm_1/);
  assert.match(awaiting.pendingInput!.message ?? "", /does not include the tool input/);

  const status = await statusOf(client, worker.id);
  const clientIds = status.stderrTail
    .split(/\r?\n/)
    .filter((line) => line.includes("FAKE_DSH_CLIENT_ID"))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { id: unknown });
  assert.ok(clientIds.length > 0, "the fake agent must observe supervisor requests");
  for (const entry of clientIds) {
    assert.equal(
      typeof entry.id,
      "string",
      "supervisor request ids must stay in their own string id space",
    );
  }
  const permissionIds = status.stderrTail
    .split(/\r?\n/)
    .filter((line) => line.includes("FAKE_DSH_PERMISSION_ID"))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { id: unknown });
  assert.equal(permissionIds.length, 1);
  assert.equal(
    typeof permissionIds[0]!.id,
    "number",
    "the fake agent uses a numeric reverse-request id on purpose",
  );

  await client.request(
    "answer",
    {
      workerId: worker.id,
      requestId: awaiting.pendingInput!.requestId,
      response: { value: "Allow once" },
    },
    { timeoutMs: 30_000 },
  );

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_DSH_ALLOWED");
});

test("DSH permission request can be denied by its offered label", async (t) => {
  const { client, cwd } = await startDshHarness(t, { FAKE_DSH_SCENARIO: "permission" });
  const worker = await spawnDsh(client, cwd, "needs approval");
  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  assert.ok(awaiting.pendingInput);

  await client.request(
    "answer",
    {
      workerId: worker.id,
      requestId: awaiting.pendingInput!.requestId,
      response: { value: "Reject" },
    },
    { timeoutMs: 30_000 },
  );

  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "completed");
  assert.equal(final.worker.result?.text, "FAKE_DSH_DENIED");
});

test("DSH permission withdrawal clears the live input", async (t) => {
  const { client, cwd } = await startDshHarness(t, {
    FAKE_DSH_SCENARIO: "permission",
    FAKE_DSH_WITHDRAW_PERMISSION: "1",
  });
  const worker = await spawnDsh(client, cwd, "withdraw this approval");
  const awaiting = await waitForStatus(client, worker.id, ["awaiting_input"], 15_000);
  assert.ok(awaiting.pendingInput);

  const deadline = Date.now() + 10_000;
  let cleared = false;
  while (Date.now() < deadline && !cleared) {
    const events = await eventsOf(client, worker.id, 0);
    cleared = events.events.some(
      (event) =>
        event.type === "run.progress" &&
        event.data?.kind === "permission_withdrawn" &&
        event.data?.pendingInputCleared === true,
    );
    if (!cleared) await sleep(25);
  }
  assert.ok(cleared, "the withdrawn request must clear pendingInput");

  // `wait` returns early on awaiting_input by design, so wait for a terminal
  // status explicitly after the withdrawal has been observed.
  const final = await waitForStatus(
    client,
    worker.id,
    ["completed", "failed", "cancelled", "crashed", "orphaned", "interrupted"],
    20_000,
  );
  assert.equal(final.status, "completed");
  assert.equal(final.result?.text, "FAKE_DSH_WITHDRAWN");
  await assert.rejects(
    client.request("answer", {
      workerId: worker.id,
      requestId: awaiting.pendingInput!.requestId,
      response: { value: "Allow once" },
    }),
  );
});

test("DSH worker can be cancelled while a prompt is running", async (t) => {
  const { client, cwd } = await startDshHarness(t, { FAKE_DSH_SCENARIO: "hang" });
  const worker = await spawnDsh(client, cwd, "never finishes");
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

test("DSH prompt errors become a failed worker", async (t) => {
  const { client, cwd } = await startDshHarness(t, { FAKE_DSH_SCENARIO: "promptfail" });
  const worker = await spawnDsh(client, cwd, "boom");
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "failed");
  assert.match(final.worker.error ?? "", /fake prompt failure/);
});

test("DSH steering and tool restrictions are reported as unsupported", async (t) => {
  const { client, cwd } = await startDshHarness(t, { FAKE_DSH_SCENARIO: "hang" });
  const worker = await spawnDsh(client, cwd, "keep going");
  await waitForStatus(client, worker.id, ["running"], 15_000);
  await assert.rejects(
    client.request(
      "send",
      { workerId: worker.id, message: "steer", mode: "steer" },
      { timeoutMs: 30_000 },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSUPPORTED");
      return true;
    },
  );
  await client.request("cancel", { workerId: worker.id });

  const { client: client2, cwd: cwd2 } = await startDshHarness(t);
  await assert.rejects(
    () => spawnDsh(client2, cwd2, "restrict tools", { tools: ["Read"] }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSUPPORTED");
      assert.match((error as Error).message, /no tool allowlist/);
      return true;
    },
  );
});

test("DSH rejects extraArgs because stdout must stay protocol-only", async (t) => {
  const { client, cwd } = await startDshHarness(t);
  await assert.rejects(
    () => spawnDsh(client, cwd, "extra", { extraArgs: ["--patch", "extra.yml"] }),
    /do not accept extraArgs/,
  );
});

test("DSH maxDuration still cancels an unbounded ACP prompt", async (t) => {
  const { client, cwd } = await startDshHarness(t, { FAKE_DSH_SCENARIO: "hang" });
  const worker = await spawnDsh(client, cwd, "wait for cancellation", {
    maxDurationMs: 1000,
  });
  const final = await waitTerminal(client, worker.id, 20_000);
  assert.equal(final.worker.status, "cancelled");
  assert.equal(final.worker.statusReason, "max_duration_exceeded");
});
