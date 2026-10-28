import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { WorkerSummary } from "../../src/types.js";
import {
  MCP_ENTRY,
  TestDaemon,
  makeWorkspace,
} from "./helpers.js";

const THREAD_A = "01a181c6-823f-7fe0-92b9-b8cf38c5bb41";
const THREAD_B = "01a181c4-0ccf-74e3-b367-e3d72a0756bb";

interface Mcp {
  client: Client;
}

async function connectMcp(
  t: TestContext,
  stateDir: string,
  mode: "production" | "development" = "production",
): Promise<Mcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY, "--state-dir", stateDir, "--mode", mode],
    env: { ...process.env, HARNESS_SUPERVISOR_MCP_MODE: mode },
    stderr: "pipe",
  });
  const client = new Client({ name: "hs-auto-binding-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => undefined);
  });
  return { client };
}

async function call(
  mcp: Mcp,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<any> {
  const result = (await mcp.client.callTool({
    name,
    arguments: args,
    ...(meta ? { _meta: meta } : {}),
  } as any)) as any;
  const text = result.content?.find((item: any) => item.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

function meta(threadId: string, sessionId = threadId): Record<string, unknown> {
  return {
    threadId,
    sessionId,
    "x-codex-turn-metadata": { thread_id: threadId, turn_id: `turn-${threadId.slice(0, 6)}` },
  };
}

test("spawn auto-binds each Codex conversation without crossing targets", async (t) => {
  const daemon = await TestDaemon.create("hs-auto-bind-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start();
  const mcp = await connectMcp(t, daemon.stateDir);

  const [a, b] = await Promise.all([
    call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] A" }, meta(THREAD_A)),
    call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] B" }, meta(THREAD_B)),
  ]);
  const a2 = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] A2" }, meta(THREAD_A));

  assert.equal(a.notificationBinding.source, "caller");
  assert.equal(a.notificationBinding.wake, "bound");
  assert.equal(a.notificationBinding.target.codexThreadId, THREAD_A);
  assert.equal(b.notificationBinding.target.codexThreadId, THREAD_B);
  assert.equal(a2.notificationBinding.target.codexThreadId, THREAD_A);

  const explicit = await call(
    mcp,
    "worker_spawn",
    {
      cwd,
      prompt: "[scenario:slow] explicit wins",
      notifyTarget: { channel: "codex-queue", codexThreadId: THREAD_B },
    },
    meta(THREAD_A),
  );
  assert.equal(explicit.notificationBinding.source, "explicit");
  assert.equal(explicit.notificationBinding.target.codexThreadId, THREAD_B);

  for (const worker of [a, b, a2, explicit]) {
    await call(mcp, "worker_cancel", { workerId: worker.id, timeoutMs: 10_000 });
  }
});

test("a recognized caller wins over the daemon default", async (t) => {
  const daemon = await TestDaemon.create("hs-auto-bind-default-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start();
  const mcp = await connectMcp(t, daemon.stateDir);
  await call(mcp, "supervisor_wake_target", {
    channel: "codex-queue",
    codexThreadId: THREAD_B,
  });

  const caller = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] caller" }, meta(THREAD_A));
  assert.equal(caller.notificationBinding.source, "caller");
  assert.equal(caller.notificationBinding.target.codexThreadId, THREAD_A,
    "the global default must not override an identified caller");

  const fallback = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] fallback" });
  assert.equal(fallback.notificationBinding.source, "daemon-default");
  assert.equal(fallback.notificationBinding.target.codexThreadId, THREAD_B);

  const invalid = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] invalid" }, {
    threadId: "not-a-uuid",
  });
  assert.equal(invalid.notificationBinding.source, "daemon-default");
  assert.equal(invalid.notificationBinding.wake, "bound");
  assert.match(
    invalid.notificationBinding.warnings.join(" "),
    /rejected \(invalid\)/,
    "a malformed caller identity must warn even when the fallback target is wakeable",
  );

  const conflict = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] conflict" }, {
    threadId: THREAD_A,
    "x-codex-turn-metadata": { thread_id: THREAD_B },
  });
  assert.equal(conflict.notificationBinding.source, "daemon-default");
  assert.match(conflict.notificationBinding.warnings.join(" "), /rejected \(conflict\)/);

  await call(mcp, "worker_cancel", { workerId: caller.id, timeoutMs: 10_000 });
  await call(mcp, "worker_cancel", { workerId: fallback.id, timeoutMs: 10_000 });
  await call(mcp, "worker_cancel", { workerId: invalid.id, timeoutMs: 10_000 });
  await call(mcp, "worker_cancel", { workerId: conflict.id, timeoutMs: 10_000 });
});

test("no caller identity falls back to the daemon default with a warning", async (t) => {
  const daemon = await TestDaemon.create("hs-auto-bind-none-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start();
  const mcp = await connectMcp(t, daemon.stateDir);

  const noMeta = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] no meta" });
  assert.equal(noMeta.notificationBinding.source, "daemon-default");
  assert.equal(noMeta.notificationBinding.wake, "unbound");
  assert.ok(noMeta.notificationBinding.warnings.length > 0);

  const badMeta = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] bad meta" }, {
    threadId: "not-a-uuid",
  });
  assert.equal(badMeta.notificationBinding.source, "daemon-default");
  assert.equal(badMeta.notificationBinding.wake, "unbound");

  await call(mcp, "worker_cancel", { workerId: noMeta.id, timeoutMs: 10_000 });
  await call(mcp, "worker_cancel", { workerId: badMeta.id, timeoutMs: 10_000 });
});

test("resume preserves the original binding and only an explicit target rebinds", async (t) => {
  const daemon = await TestDaemon.create("hs-auto-bind-resume-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start();
  const mcp = await connectMcp(t, daemon.stateDir);

  const worker = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:report] resume" }, meta(THREAD_A));
  await call(mcp, "worker_wait", { workerId: worker.id, timeoutMs: 20_000, until: "terminal" });

  const preserved = await call(
    mcp,
    "worker_resume",
    { workerId: worker.id, prompt: "[scenario:report] keep" },
    meta(THREAD_B),
  );
  assert.equal(preserved.notificationBinding.source, "preserved");
  assert.equal(preserved.notificationBinding.target.codexThreadId, THREAD_A);
  await call(mcp, "worker_wait", { workerId: worker.id, timeoutMs: 20_000, until: "terminal" });

  const rebound = await call(
    mcp,
    "worker_resume",
    {
      workerId: worker.id,
      prompt: "[scenario:report] rebind",
      notifyTarget: { channel: "codex-queue", codexThreadId: THREAD_B },
    },
    meta(THREAD_A),
  );
  assert.equal(rebound.notificationBinding.source, "explicit");
  assert.equal(rebound.notificationBinding.target.codexThreadId, THREAD_B);
  await call(mcp, "worker_wait", { workerId: worker.id, timeoutMs: 20_000, until: "terminal" });
});

test("an idempotent spawn replay keeps its original binding snapshot", async (t) => {
  const daemon = await TestDaemon.create("hs-auto-bind-replay-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start();
  const mcp = await connectMcp(t, daemon.stateDir);

  const first = await call(
    mcp,
    "worker_spawn",
    { cwd, prompt: "[scenario:report] replay", requestId: "auto-replay-1" },
    meta(THREAD_A),
  );
  assert.equal(first.notificationBinding.target.codexThreadId, THREAD_A);
  await call(mcp, "worker_wait", { workerId: first.id, timeoutMs: 20_000, until: "terminal" });

  const rebound = await call(mcp, "worker_resume", {
    workerId: first.id,
    prompt: "[scenario:report] rebind",
    notifyTarget: { channel: "codex-queue", codexThreadId: THREAD_B },
  });
  assert.equal(rebound.notificationBinding.target.codexThreadId, THREAD_B);
  await call(mcp, "worker_wait", { workerId: first.id, timeoutMs: 20_000, until: "terminal" });

  const replay = await call(
    mcp,
    "worker_spawn",
    { cwd, prompt: "[scenario:report] replay", requestId: "auto-replay-1" },
    meta(THREAD_A),
  );
  assert.equal(replay.id, first.id);
  assert.equal(
    replay.notificationBinding.target.codexThreadId,
    THREAD_A,
    "a replay returns the original acceptance binding, not the worker's later rebind",
  );
  assert.equal(replay.notificationBinding.source, "caller");
});

test("the binding survives a client reconnect and a daemon restart", async (t) => {
  const daemon = await TestDaemon.create("hs-auto-bind-restart-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start();
  const mcp = await connectMcp(t, daemon.stateDir);

  const worker = await call(mcp, "worker_spawn", { cwd, prompt: "[scenario:slow] persist" }, meta(THREAD_A));
  await mcp.client.close();
  let dev = await connectMcp(t, daemon.stateDir, "development");
  const status = await call(dev, "worker_status", { workerId: worker.id });
  assert.equal(status.worker.notifyTarget.codexThreadId, THREAD_A);

  await dev.client.close();
  await daemon.stop();
  await daemon.start();
  dev = await connectMcp(t, daemon.stateDir, "development");
  const after = await call(dev, "worker_status", { workerId: worker.id });
  assert.equal(after.worker.notifyTarget.codexThreadId, THREAD_A);
});