import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_ENTRY, TestDaemon, makeWorkspace } from "./helpers.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
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

function bytes(result: ToolResult): number {
  return Buffer.byteLength(rawText(result), "utf8");
}

async function connectMcp(
  t: TestContext,
  stateDir: string,
  mode?: "production" | "development",
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY, "--state-dir", stateDir],
    env: { ...process.env, HARNESS_SUPERVISOR_MCP_MODE: mode ?? "" },
    stderr: "pipe",
  });
  const mcp = new Client({ name: `hs-budget-${mode ?? "production"}`, version: "1.0.0" });
  await mcp.connect(transport);
  t.after(async () => {
    await mcp.close().catch(() => undefined);
  });
  return mcp;
}

async function call(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await mcp.callTool({ name, arguments: args })) as ToolResult;
}

test("the master completion flow is spawn + wait and never needs status/events assembly", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-budget-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start({ env: { FAKE_PI_REPORT_CHARS: "20000", FAKE_PI_STEP_MS: "5" } });
  const production = await connectMcp(t, daemon.stateDir);
  const development = await connectMcp(t, daemon.stateDir, "development");

  const spawnCall = await call(production, "worker_spawn", {
    cwd,
    prompt: "[scenario:report] master flow budget",
    notifyTarget: { channel: "none" },
  });
  const worker = parseTool(spawnCall);
  const waitCall = await call(production, "worker_wait", {
    workerId: worker.id,
    timeoutMs: 30_000,
    until: "terminal",
  });
  const waited = parseTool(waitCall);
  assert.equal(waited.terminal, true);
  assert.equal(waited.worker.status, "completed");
  const reportText: string = waited.worker.result.text;
  assert.ok(reportText.includes("FAKE_PI_REPORT_BEGIN"));
  assert.ok(reportText.includes("FAKE_PI_REPORT_END"));
  assert.equal(
    rawText(waitCall).split("FAKE_PI_REPORT_END").length - 1,
    1,
    "the report is returned once, in the wait result",
  );
  assert.equal("events" in waited, false);
  assert.equal("progressOmitted" in waited, false);

  const statusCall = await call(production, "worker_status", { workerId: worker.id });
  const status = parseTool(statusCall);
  assert.equal(status.worker.resultAvailable, true);
  assert.equal(status.worker.resultPreview.truncated, true);
  assert.ok(status.worker.resultPreview.preview.length < reportText.length);
  assert.equal("recentEvents" in status, false);
  assert.ok(bytes(statusCall) <= 2048);

  const eventsCall = await call(production, "worker_events", { workerId: worker.id });
  const events = parseTool(eventsCall);
  assert.equal(
    events.events.some((event: { type: string }) => event.type === "run.progress"),
    false,
  );
  assert.equal(rawText(eventsCall).includes("FAKE_PI_REPORT_BEGIN"), false);

  const devWaitCall = await call(development, "worker_wait", {
    workerId: worker.id,
    timeoutMs: 5_000,
    until: "terminal",
  });
  const devWaited = parseTool(devWaitCall);
  assert.equal(devWaited.worker.result.text, reportText);
  assert.ok(bytes(devWaitCall) > bytes(waitCall));

  const devStatusCall = await call(development, "worker_status", {
    workerId: worker.id,
    recentEvents: 20,
  });
  const devStatus = parseTool(devStatusCall);
  assert.equal(devStatus.worker.result.text, reportText);
  assert.equal(Array.isArray(devStatus.recentEvents), true);
  assert.ok(bytes(devStatusCall) > bytes(statusCall));

  t.diagnostic(
    `master flow: spawn=${bytes(spawnCall)}B wait=${bytes(waitCall)}B status=${bytes(statusCall)}B events=${bytes(eventsCall)}B; ` +
      `development wait=${bytes(devWaitCall)}B status=${bytes(devStatusCall)}B`,
  );
});

test("a noisy worker does not inflate the production read path", async (t) => {
  const daemon = await TestDaemon.create("hs-mcp-budget-busy-");
  t.after(() => daemon.stop());
  const cwd = await makeWorkspace();
  await daemon.start({ env: { FAKE_PI_STEP_MS: "1" } });
  const production = await connectMcp(t, daemon.stateDir);

  const worker = parseTool(
    await call(production, "worker_spawn", {
      cwd,
      prompt: "[scenario:busy] progress volume",
      notifyTarget: { channel: "none" },
    }),
  );
  const waitCall = await call(production, "worker_wait", {
    workerId: worker.id,
    timeoutMs: 30_000,
    until: "terminal",
  });
  const waited = parseTool(waitCall);
  assert.equal(waited.worker.status, "completed");
  assert.equal("events" in waited, false);

  const statusCall = await call(production, "worker_status", { workerId: worker.id });
  const status = parseTool(statusCall);
  assert.equal("recentEvents" in status, false);
  assert.ok(bytes(statusCall) <= 2048);

  const eventsCall = await call(production, "worker_events", { workerId: worker.id });
  const events = parseTool(eventsCall);
  assert.ok(events.progressOmitted >= 200, "the busy scenario produced real progress volume");
  assert.equal(
    events.events.some((event: { type: string }) => event.type === "run.progress"),
    false,
  );
  assert.ok(
    bytes(eventsCall) <= 4096,
    `default event read stays within 4 KiB, got ${bytes(eventsCall)}`,
  );
  for (const event of events.events) {
    assert.equal("data" in event, false);
  }

  t.diagnostic(
    `busy flow: wait=${bytes(waitCall)}B status=${bytes(statusCall)}B events=${bytes(eventsCall)}B ` +
      `progressOmitted=${events.progressOmitted}`,
  );
});
