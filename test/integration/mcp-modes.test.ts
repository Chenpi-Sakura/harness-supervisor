import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../../src/util/async.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SupervisorClient } from "../../src/ipc/client.js";
import { VERSION } from "../../src/version.js";
import { OldDaemonFixture } from "../fixtures/old-daemon.js";
import {
  FAKE_ENTRY,
  MCP_ENTRY,
  TestDaemon,
  connectExisting,
  makeWorkspace,
} from "./helpers.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

interface McpConnection {
  mcp: Client;
  stderr(): string;
}

function parseTool(result: ToolResult): any {
  assert.notEqual(result.isError, true, result.content[0]?.text);
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool result has no text");
  return JSON.parse(text);
}

function rawText(result: ToolResult): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

async function connectMcp(
  t: TestContext,
  stateDir: string,
  options: { args?: string[]; modeEnv?: string; name?: string } = {},
): Promise<McpConnection> {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY, "--state-dir", stateDir, ...(options.args ?? [])],
    env: {
      ...process.env,
      HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY,
      FAKE_PI_STEP_MS: "20",
      HARNESS_SUPERVISOR_MCP_MODE: options.modeEnv ?? "",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const mcp = new Client({ name: options.name ?? "harness-supervisor-mode-test", version: "1.0.0" });
  await mcp.connect(transport);
  t.after(async () => {
    try {
      await mcp.close();
    } catch {
      // Already closed.
    }
  });
  return { mcp, stderr: () => stderr };
}

async function runMcpProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [MCP_ENTRY, ...args], {
    env,
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  return { code, stderr };
}

async function call(connection: McpConnection, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await connection.mcp.callTool({ name, arguments: args })) as ToolResult;
}

async function waitForIdempotencyRecord(
  stateDir: string,
  key: string,
  predicate: (record: { state?: string }) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let records: Array<{ key?: string; state?: string }> = [];
    try {
      const raw = await readFile(path.join(stateDir, "idempotency.jsonl"), "utf8");
      records = raw
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } catch {
      // The log appears once the admission record is written.
    }
    if (records.some((record) => record.key === key && predicate(record))) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for idempotency record ${key}`);
}

test("MCP mode comes from CLI/env, defaults to production, and rejects invalid values", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-mode-");
  t.after(() => daemon.stop());
  await daemon.start();
  const stateDir = daemon.stateDir;

  const production = await connectMcp(t, stateDir, {});
  const productionInfo = parseTool(await call(production, "supervisor_info", {}));
  assert.equal(productionInfo.mcpMode, "production");
  assert.equal(productionInfo.version, VERSION);
  assert.ok(productionInfo.limits.maxWorkers > 0);
  const qoder = productionInfo.runtimes.find((runtime: { runtime: string }) => runtime.runtime === "qoder");
  assert.ok(qoder, "Qoder must remain visible");
  assert.match(qoder.notes, /unverified/i, "the unverified Qoder steer effect must not be hidden");
  assert.equal("stateDir" in productionInfo, false, "production info omits daemon diagnostics");

  const development = await connectMcp(t, stateDir, { modeEnv: "development" });
  const developmentInfo = parseTool(await call(development, "supervisor_info", {}));
  assert.equal(developmentInfo.version, VERSION);
  assert.equal("stateDir" in developmentInfo, true, "development keeps the legacy daemon payload");
  assert.equal("pid" in developmentInfo, true);
  assert.equal("mcpMode" in developmentInfo, false);

  const overridden = await connectMcp(t, stateDir, {
    modeEnv: "development",
    args: ["--mode", "production"],
  });
  const overriddenInfo = parseTool(await call(overridden, "supervisor_info", {}));
  assert.equal(overriddenInfo.mcpMode, "production", "CLI --mode must override the environment");

  const baseEnv = { ...process.env, HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY };
  const invalidCli = spawnSync(
    process.execPath,
    [MCP_ENTRY, "--state-dir", stateDir, "--mode", "staging"],
    { env: { ...baseEnv, HARNESS_SUPERVISOR_MCP_MODE: "" }, encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(invalidCli.status, 1);
  assert.match(invalidCli.stderr, /Invalid --mode value "staging"/);

  const invalidEnv = spawnSync(process.execPath, [MCP_ENTRY, "--state-dir", stateDir], {
    env: { ...baseEnv, HARNESS_SUPERVISOR_MCP_MODE: "staging" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(invalidEnv.status, 1);
  assert.match(invalidEnv.stderr, /HARNESS_SUPERVISOR_MCP_MODE/);

  const missingValue = spawnSync(process.execPath, [MCP_ENTRY, "--state-dir", stateDir, "--mode"], {
    env: { ...baseEnv, HARNESS_SUPERVISOR_MCP_MODE: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /--mode requires a value/);
});

test("production hides diagnostics while development keeps the legacy status payload", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-shape-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start({ env: { FAKE_PI_SLOW_STEP_MS: "4000" } });
  const stateDir = daemon.stateDir;
  const production = await connectMcp(t, stateDir, {});
  const development = await connectMcp(t, stateDir, { modeEnv: "development" });

  const spawned = parseTool(
    await call(production, "worker_spawn", {
      cwd,
      prompt: "[scenario:slow] production shape",
      notifyTarget: { channel: "none" },
    }),
  );
  assert.equal(spawned.status, "running", "spawn returns acceptance, not completion");
  assert.deepEqual(
    Object.keys(spawned).sort(),
    ["id", "lastSeq", "notifyTarget", "runtime", "status"],
  );
  assert.deepEqual(spawned.notifyTarget, { channel: "none" });

  const status = parseTool(
    await call(production, "worker_status", { workerId: spawned.id }),
  );
  assert.equal(status.worker.id, spawned.id);
  assert.equal(status.worker.status, "running");
  assert.equal(status.worker.lastSeq > 0, true);
  assert.equal("recentEvents" in status, false, "production status omits events unless requested");
  assert.equal("stderrTail" in status, false);
  for (const field of [
    "pid",
    "sessionId",
    "sessionFile",
    "supervisorId",
    "promptPreview",
    "capabilities",
    "config",
    "stats",
    "createdAt",
    "updatedAt",
  ]) {
    assert.equal(field in status.worker, false, `production status must not expose ${field}`);
  }
  assert.equal(status.worker.cwd, cwd, "cwd stays available for artifact verification");

  const statusWithEvents = parseTool(
    await call(production, "worker_status", { workerId: spawned.id, recentEvents: 3 }),
  );
  assert.equal(Array.isArray(statusWithEvents.recentEvents), true);
  assert.ok(statusWithEvents.recentEvents.length <= 3);
  for (const event of statusWithEvents.recentEvents) {
    assert.equal("notifyTarget" in event, false);
  }

  const sent = parseTool(
    await call(production, "worker_send", {
      workerId: spawned.id,
      message: "PRODUCTION_STEER",
      mode: "steer",
    }),
  );
  assert.deepEqual(Object.keys(sent).sort(), ["id", "lastSeq", "status"]);
  assert.equal(sent.status, "running");

  const cancelled = parseTool(
    await call(production, "worker_cancel", { workerId: spawned.id, timeoutMs: 10_000 }),
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal("pid" in cancelled, false);

  const legacySpawn = parseTool(
    await call(development, "worker_spawn", {
      cwd,
      prompt: "[scenario:slow] development shape",
      notifyTarget: { channel: "none" },
    }),
  );
  for (const field of [
    "pid",
    "sessionId",
    "sessionFile",
    "supervisorId",
    "promptPreview",
    "capabilities",
    "config",
    "stats",
    "createdAt",
    "updatedAt",
  ]) {
    assert.ok(field in legacySpawn, `development spawn must keep ${field}`);
  }
  const legacyStatus = parseTool(
    await call(development, "worker_status", { workerId: legacySpawn.id }),
  );
  assert.equal("stderrTail" in legacyStatus, true);
  assert.equal(Array.isArray(legacyStatus.recentEvents), true);
  assert.equal(
    legacyStatus.recentEvents.length,
    Math.min(20, legacyStatus.worker.eventCount),
    "development keeps the recentEvents=20 default request",
  );
  assert.equal("pid" in legacyStatus.worker, true);
  parseTool(await call(development, "worker_cancel", { workerId: legacySpawn.id }));
});

test("production returns a complete report once, answers native input, and preserves failure/idempotency semantics", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-outcome-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start({ env: { FAKE_PI_REPORT_CHARS: "20000" } });
  const stateDir = daemon.stateDir;
  const production = await connectMcp(t, stateDir, {});
  const development = await connectMcp(t, stateDir, { modeEnv: "development" });

  const reportWorker = parseTool(
    await call(production, "worker_spawn", {
      cwd,
      prompt: "[scenario:report] fixed report",
      notifyTarget: { channel: "none" },
    }),
  );
  const reportWait = await call(production, "worker_wait", {
    workerId: reportWorker.id,
    timeoutMs: 20_000,
    until: "terminal",
  });
  const report = parseTool(reportWait);
  assert.equal(report.terminal, true);
  assert.equal(report.worker.status, "completed");
  const reportText: string = report.worker.result?.text ?? "";
  assert.equal(report.worker.result?.truncated, false);
  assert.ok(reportText.includes("FAKE_PI_REPORT_BEGIN"));
  assert.ok(reportText.includes("FAKE_PI_REPORT_END"), "the report must be complete");
  assert.ok(reportText.length >= 20_000);
  assert.equal(
    rawText(reportWait).split("FAKE_PI_REPORT_END").length - 1,
    1,
    "the final report must appear exactly once",
  );
  const completedEvent = report.events.find((event: { type: string }) => event.type === "run.completed");
  assert.ok(completedEvent);
  assert.equal("text" in (completedEvent.data ?? {}), false, "run.completed must not repeat result.text");

  const developmentWait = parseTool(
    await call(development, "worker_wait", {
      workerId: reportWorker.id,
      timeoutMs: 5_000,
      until: "terminal",
    }),
  );
  assert.ok(developmentWait.worker.result?.text.includes("FAKE_PI_REPORT_END"));
  const productionBytes = Buffer.byteLength(rawText(reportWait), "utf8");
  const developmentBytes = Buffer.byteLength(
    rawText(
      await call(development, "worker_wait", {
        workerId: reportWorker.id,
        timeoutMs: 5_000,
        until: "terminal",
      }),
    ),
    "utf8",
  );
  assert.ok(
    productionBytes < developmentBytes,
    `production (${productionBytes}) should be smaller than development (${developmentBytes})`,
  );
  t.diagnostic(
    `same report wait: production=${productionBytes} bytes, development=${developmentBytes} bytes`,
  );

  const askWorker = parseTool(
    await call(production, "worker_spawn", {
      cwd,
      prompt: "[scenario:ask] production input",
      notifyTarget: { channel: "none" },
    }),
  );
  const waiting = parseTool(
    await call(production, "worker_wait", {
      workerId: askWorker.id,
      timeoutMs: 15_000,
      until: "terminal",
    }),
  );
  assert.equal(waiting.worker.status, "awaiting_input");
  const pending = waiting.worker.pendingInput;
  assert.ok(pending?.requestId);
  assert.equal(pending.method, "confirm");
  assert.equal(pending.title, "Approve fake step?");
  assert.equal(pending.message, "The fake harness needs permission to continue.");
  assert.equal("pid" in waiting.worker, false);
  const answered = parseTool(
    await call(production, "worker_answer", {
      workerId: askWorker.id,
      requestId: pending.requestId,
      confirmed: true,
    }),
  );
  assert.equal(answered.status, "running");
  const askFinal = parseTool(
    await call(production, "worker_wait", {
      workerId: askWorker.id,
      timeoutMs: 15_000,
      until: "terminal",
    }),
  );
  assert.equal(askFinal.worker.status, "completed");
  assert.match(askFinal.worker.result?.text ?? "", /ANSWER:true/);

  const failedWorker = parseTool(
    await call(production, "worker_spawn", {
      cwd,
      prompt: "[scenario:error] production failure",
      notifyTarget: { channel: "none" },
    }),
  );
  const failed = parseTool(
    await call(production, "worker_wait", {
      workerId: failedWorker.id,
      timeoutMs: 15_000,
      until: "terminal",
    }),
  );
  assert.equal(failed.worker.status, "failed");
  assert.match(failed.worker.error ?? "", /FAKE_PROVIDER_ERROR/);
  assert.equal("stderrTail" in failed, false);

  const requestId = "mcp-mode-idempotent";
  const spawnArgs = {
    cwd,
    prompt: "[scenario:normal] idempotent replay",
    requestId,
    notifyTarget: { channel: "none" },
  };
  const first = parseTool(await call(production, "worker_spawn", spawnArgs));
  const replay = parseTool(await call(production, "worker_spawn", spawnArgs));
  assert.equal(replay.id, first.id, "the same requestId must replay the first acceptance");
  const conflict = await call(production, "worker_spawn", {
    ...spawnArgs,
    prompt: "[scenario:normal] different parameters",
  });
  assert.equal(conflict.isError, true);
  assert.match(rawText(conflict), /CONFLICT/);
  assert.match(rawText(conflict), new RegExp(requestId));
  assert.doesNotMatch(rawText(conflict), /firstSeenAt/, "production errors omit diagnostic details");
  parseTool(await call(production, "worker_wait", { workerId: first.id, timeoutMs: 15_000 }));
});

test("production event pagination stays lossless and explicit progress still works", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-events-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start();
  const production = await connectMcp(t, daemon.stateDir, {});

  const worker = parseTool(
    await call(production, "worker_spawn", {
      cwd,
      prompt: "[scenario:busy] event pagination",
      notifyTarget: { channel: "none" },
    }),
  );
  parseTool(
    await call(production, "worker_wait", {
      workerId: worker.id,
      timeoutMs: 20_000,
      until: "terminal",
    }),
  );

  const firstPage = parseTool(
    await call(production, "worker_events", {
      workerId: worker.id,
      sinceSeq: 0,
      limit: 2,
    }),
  );
  assert.equal(firstPage.events.length, 2);
  assert.deepEqual(Object.keys(firstPage.worker).sort(), ["id", "lastSeq", "status"]);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextSeq, firstPage.events[1].seq);
  for (const event of firstPage.events) {
    assert.deepEqual(Object.keys(event).filter((key) => key === "notifyTarget"), []);
    assert.equal("workerId" in event, false);
  }

  const secondPage = parseTool(
    await call(production, "worker_events", {
      workerId: worker.id,
      sinceSeq: firstPage.nextSeq,
      limit: 500,
    }),
  );
  const firstSeqs = new Set(firstPage.events.map((event: { seq: number }) => event.seq));
  assert.ok(secondPage.events.length > 0);
  assert.equal(
    secondPage.events.some((event: { seq: number }) => firstSeqs.has(event.seq)),
    false,
    "the cursor must not replay the first page",
  );
  assert.ok(
    secondPage.events.every((event: { seq: number }) => event.seq > firstPage.nextSeq),
  );

  const withProgress = parseTool(
    await call(production, "worker_wait", {
      workerId: worker.id,
      timeoutMs: 5_000,
      until: "terminal",
      includeProgress: true,
    }),
  );
  assert.ok(
    withProgress.events.some((event: { type: string }) => event.type === "run.progress"),
    "includeProgress=true must still deliver progress in production",
  );

  const list = parseTool(await call(production, "worker_list", {}));
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ["id", "lastSeq", "runtime", "status"]);
});

test("production notification defaults filter unacked before the limit and never hide new records", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-inbox-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  const stateDir = daemon.stateDir;
  const fakeCodex = fileURLToPath(
    new URL("../../../test/fixtures/fake-codex-queue.mjs", import.meta.url),
  );
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const legacy = Array.from({ length: 80 }, (_, index) =>
    JSON.stringify({
      id: `legacy#${index + 1}`,
      workerId: "legacy-worker",
      runtime: "pi",
      seq: index + 1,
      eventType: "run.completed",
      kind: "completed",
      createdAt: new Date(base + index * 1000).toISOString(),
      summary: { status: "completed", text: "old report" },
      delivery: { state: "delivered", channel: "none", attempts: 1 },
      ackAt: new Date(base + 100_000 + index * 1000).toISOString(),
      ackBy: "legacy-consumer",
    }),
  ).join("\n");
  await writeFile(path.join(stateDir, "notifications.jsonl"), `${legacy}\n`, "utf8");

  await daemon.start({
    env: { HARNESS_SUPERVISOR_CODEX_BIN: `"${process.execPath}" "${fakeCodex}"` },
  });
  const production = await connectMcp(t, stateDir, {});
  const development = await connectMcp(t, stateDir, { modeEnv: "development" });
  const threadId = "thread-mode-routing";

  const worker = parseTool(
    await call(production, "worker_spawn", {
      cwd,
      prompt: "[scenario:normal] routed notification",
      notifyTarget: { channel: "codex-queue", codexThreadId: threadId },
    }),
  );
  assert.deepEqual(worker.notifyTarget, { channel: "codex-queue", codexThreadId: threadId });
  parseTool(
    await call(production, "worker_wait", {
      workerId: worker.id,
      timeoutMs: 15_000,
      until: "terminal",
    }),
  );

  const inbox = parseTool(
    await call(production, "supervisor_notifications", { limit: 5 }),
  );
  assert.ok(
    inbox.notifications.some(
      (record: { workerId: string; acked: boolean }) =>
        record.workerId === worker.id && record.acked === false,
    ),
    "a new unacked notification must not be hidden by older acknowledged records",
  );
  assert.ok(inbox.notifications.every((record: { acked: boolean }) => record.acked === false));
  for (const record of inbox.notifications) {
    assert.deepEqual(Object.keys(record).sort(), ["acked", "id", "kind", "summary", "workerId"]);
  }
  assert.equal(inbox.counts.unacked >= 1, true);
  assert.equal("target" in inbox, false, "production inbox omits routing metadata");

  const legacyInbox = parseTool(
    await call(development, "supervisor_notifications", {
      state: "all",
      workerId: worker.id,
    }),
  );
  const record = legacyInbox.notifications.find(
    (item: { workerId: string }) => item.workerId === worker.id,
  );
  assert.ok(record);
  assert.deepEqual(record.target, { channel: "codex-queue", codexThreadId: threadId });
  assert.ok(record.delivery);
  assert.ok(record.createdAt);

  const client = await connectExisting(stateDir, 10_000);
  t.after(() => client.close());
  const persisted = await client.request<{ worker: { notifyTarget?: unknown } }>("status", {
    workerId: worker.id,
  });
  assert.deepEqual(persisted.worker.notifyTarget, {
    channel: "codex-queue",
    codexThreadId: threadId,
  });

  const wakeTarget = parseTool(await call(production, "supervisor_wake_target", {}));
  assert.deepEqual(wakeTarget, { channel: "none" });
  assert.equal("notifications" in wakeTarget, false, "a no-arg read must not return inbox content");

  const ids = inbox.notifications.map((item: { id: string }) => item.id);
  const acked = parseTool(await call(production, "supervisor_notifications_ack", { ids }));
  assert.ok(acked.acked >= 1);
  assert.deepEqual(acked.missing, []);
  const again = parseTool(await call(production, "supervisor_notifications_ack", { ids }));
  assert.equal(again.acked, 0);

  const afterAck = parseTool(await call(production, "supervisor_notifications", { limit: 5 }));
  assert.equal(
    afterAck.notifications.some((item: { id: string }) => ids.includes(item.id)),
    false,
  );
});
test("production surfaces UNCERTAIN over MCP and never re-executes an interrupted requestId", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-uncertain-");
  const cwd = await makeWorkspace();
  let restarted: TestDaemon | null = null;
  t.after(async () => {
    await daemon.stop().catch(() => undefined);
    await restarted?.stop().catch(() => undefined);
  });
  await daemon.start({ env: { FAKE_PI_START_DELAY_MS: "20000" } });
  const stateDir = daemon.stateDir;
  const first = await connectMcp(t, stateDir, {});
  const requestId = "mcp-mode-uncertain";
  const spawnArgs = {
    cwd,
    prompt: "[scenario:normal] interrupted admission",
    requestId,
    notifyTarget: { channel: "none" },
  };
  const inFlight = call(first, "worker_spawn", spawnArgs).catch(() => undefined);
  await waitForIdempotencyRecord(stateDir, `spawn:${requestId}`, (record) => record.state === "in_progress");
  await daemon.kill();
  await inFlight;

  restarted = new TestDaemon(stateDir);
  await restarted.start({ env: { FAKE_PI_START_DELAY_MS: "20000" } });
  const second = await connectMcp(t, stateDir, {});
  const uncertain = await call(second, "worker_spawn", spawnArgs);
  assert.equal(uncertain.isError, true);
  const text = rawText(uncertain);
  assert.match(text, /^UNCERTAIN: /);
  assert.match(text, new RegExp(requestId));
  const list = parseTool(await call(second, "worker_list", {}));
  assert.equal(list.length, 1, "the interrupted request must not be re-executed into a second worker");
});

test("production wait keeps historical completion reports across resume", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-resume-history-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start();
  const production = await connectMcp(t, daemon.stateDir, {});

  const worker = parseTool(
    await call(production, "worker_spawn", {
      cwd,
      prompt: "[scenario:normal] first round",
      notifyTarget: { channel: "none" },
    }),
  );
  const firstRound = parseTool(
    await call(production, "worker_wait", {
      workerId: worker.id,
      timeoutMs: 15_000,
      until: "terminal",
    }),
  );
  assert.equal(firstRound.worker.status, "completed");
  assert.match(firstRound.worker.result?.text ?? "", /FAKE_PI_OK/);

  const resumed = parseTool(
    await call(production, "worker_resume", {
      workerId: worker.id,
      prompt: "[scenario:normal] second round",
      requestId: "mcp-mode-resume-history",
    }),
  );
  assert.equal(resumed.id, worker.id);

  const history = parseTool(
    await call(production, "worker_wait", {
      workerId: worker.id,
      sinceSeq: 0,
      timeoutMs: 20_000,
      until: "terminal",
    }),
  );
  assert.equal(history.worker.status, "completed");
  assert.match(history.worker.result?.text ?? "", /RESUMED/);
  const completions = history.events.filter(
    (event: { type: string }) => event.type === "run.completed",
  );
  assert.ok(completions.length >= 2, "the response must include both completed rounds");
  const oldCompletion = completions[0];
  const currentCompletion = completions.at(-1);
  assert.equal(
    oldCompletion.data?.text,
    "FAKE_PI_OK",
    "the previous run's report must not be dropped after resume",
  );
  assert.equal(
    "text" in (currentCompletion.data ?? {}),
    false,
    "the current run's result is still deduplicated",
  );
  assert.ok(
    history.events.some(
      (event: { type: string; data?: { text?: string } }) =>
        event.type === "run.completed" && event.data?.text === "FAKE_PI_OK",
    ),
    "the historical completion event still carries its report",
  );
});

test("new MCP refuses production on a 0.2 daemon but development uses the legacy target read", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-old-daemon-"));
  const old = new OldDaemonFixture(stateDir);
  await old.start();
  t.after(() => old.stop());
  const baseEnv = {
    ...process.env,
    HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY,
    HARNESS_SUPERVISOR_MCP_MODE: "",
  };

  const incompatible = await runMcpProcess(
    ["--state-dir", stateDir, "--mode", "production"],
    baseEnv,
  );
  assert.equal(incompatible.code, 1);
  assert.match(incompatible.stderr, /daemon 0\.2\.0 is older than 0\.4\.0/i);
  assert.match(incompatible.stderr, /Back up/i);
  assert.match(incompatible.stderr, /no active workers/i);
  assert.match(incompatible.stderr, /never restarts or replaces/i);

  // The fixture itself behaves like the old strict IPC: the new parameter and
  // the new read-only method are rejected. No real old daemon is involved.
  const direct = new SupervisorClient({ stateDir, autoStart: false });
  await direct.connect();
  await assert.rejects(
    () => direct.request("notifications", { unacknowledgedOnly: true }),
    (error: unknown) =>
      (error as { code?: string }).code === "BAD_REQUEST" &&
      /unacknowledgedOnly/.test((error as Error).message),
  );
  await assert.rejects(
    () => direct.request("notification_target_get", {}),
    (error: unknown) =>
      (error as { code?: string }).code === "BAD_REQUEST" &&
      /Unknown IPC method/.test((error as Error).message),
  );
  direct.close();
  old.requests.length = 0;

  const development = await connectMcp(t, stateDir, { modeEnv: "development" });
  const info = parseTool(await call(development, "supervisor_info", {}));
  assert.equal(info.version, "0.2.0");
  const target = parseTool(await call(development, "supervisor_wake_target", {}));
  assert.deepEqual(target, {
    channel: "codex-queue",
    codexThreadId: "old-default-thread",
  });
  assert.equal("notifications" in target, false);
  assert.equal(JSON.stringify(target).includes("old inbox only"), false);

  const inbox = parseTool(await call(development, "supervisor_notifications", {}));
  assert.equal(inbox.notifications[0].id, "old-worker#1");

  assert.equal(
    old.requests.some((request) => request.method === "notification_target_get"),
    false,
    "development fallback must use the old notifications.target, not the new method",
  );
  for (const request of old.requests.filter((item) => item.method === "notifications")) {
    assert.equal(
      request.params && typeof request.params === "object"
        ? "unacknowledgedOnly" in request.params
        : false,
      false,
      "development must not send the new parameter to an old daemon",
    );
  }
});
