// Stage 0 baseline measurement: what does the main agent actually receive?
// Read-only against the production daemon; all synthetic work uses a temp state dir.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// HS_DIST_DIR lets the same harness run against a candidate build (for example
// an isolated outDir) without touching the production dist used by the daemon.
const DIST = process.env.HS_DIST_DIR ? path.resolve(process.env.HS_DIST_DIR) : path.join(REPO, "dist");
const MCP_ENTRY = path.join(DIST, "src", "mcp.js");
const FAKE_ENTRY = path.join(DIST, "test", "fixtures", "fake-harness.js");
const { TestDaemon } = await import(
  new URL("file:///" + path.join(DIST, "test", "integration", "helpers.js").replace(/\\/g, "/")).href
);

function sizeOf(text) {
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
}

function summarize(label, interfaceName, workerId, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { label, interface: interfaceName, workerId, ...sizeOf(text), parse: "failed" };
  }
  const events =
    parsed?.events ?? parsed?.recentEvents ?? parsed?.result?.events ?? undefined;
  const worker = parsed?.worker ?? parsed;
  const eventList = Array.isArray(events) ? events : [];
  const progress = eventList.filter((e) => e?.type === "run.progress").length;
  const resultText = typeof worker?.result?.text === "string" ? worker.result.text : "";
  const errorText = typeof worker?.error === "string" ? worker.error : "";
  return {
    label,
    interface: interfaceName,
    workerId,
    ...sizeOf(text),
    events: eventList.length,
    progress,
    resultChars: resultText.length,
    errorChars: errorText.length,
    truncated: Boolean(worker?.result?.truncated),
    status: worker?.status,
  };
}

/** Drive one MCP stdio session and run the given tool calls in order. */
async function mcpSession(env, calls) {
  const child = spawn(process.execPath, [MCP_ENTRY, "--mode", "production"], {
    cwd: REPO,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));

  let buffer = "";
  const pending = new Map();
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
    while (waiters.length) waiters.shift()();
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });

  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hs-baseline", version: "0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const results = [];
  let id = 100;
  for (const call of calls) {
    const message = await request(id++, "tools/call", {
      name: call.name,
      arguments: call.args,
    });
    const text = message?.result?.content?.[0]?.text ?? JSON.stringify(message.result ?? message.error ?? {});
    results.push(summarize(call.label, "mcp", call.args.workerId, text));
  }
  child.kill();
  if (stderr.trim() && process.env.HS_BASELINE_DEBUG) console.error(`[mcp stderr] ${stderr.trim().slice(0, 300)}`);
  return results;
}

const productionEnv = { ...process.env };
delete productionEnv.HARNESS_SUPERVISOR_HOME;
delete productionEnv.HARNESS_SUPERVISOR_MCP_MODE;

const LONG = "w-mvkwgs9e-4f3929b5"; // 7862 events, 1.25 MB stored
const MANY = "w-mvkpf06h-23c938ce"; // 165 tool calls
const THIRTY = "w-mvngpfbh-53b2077b"; // exactly 30 tool calls
const CANCELLED = "w-mvkel4ks-fb141e1c"; // 71 tool calls, cancelled

const rows = [];
rows.push(
  ...(await mcpSession(productionEnv, [
    { label: "status default (completed, 165 tools)", name: "worker_status", args: { workerId: MANY } },
    { label: "status default (completed, 30 tools)", name: "worker_status", args: { workerId: THIRTY } },
    { label: "status default (long history)", name: "worker_status", args: { workerId: LONG } },
    { label: "status default (cancelled)", name: "worker_status", args: { workerId: CANCELLED } },
    { label: "status recentEvents=100 (165 tools)", name: "worker_status", args: { workerId: MANY, recentEvents: 100 } },
    { label: "events default (30 tools)", name: "worker_events", args: { workerId: THIRTY } },
    { label: "events default (165 tools)", name: "worker_events", args: { workerId: MANY } },
    { label: "events default (long history)", name: "worker_events", args: { workerId: LONG } },
  ]))
);

// Synthetic failed worker in an isolated state dir: production has no failed worker.
const daemon = await TestDaemon.create("hs-baseline-");
await daemon.start();
const client = daemon.client;
const cwd = mkdtempSync(path.join(os.tmpdir(), "hs-baseline-cwd-"));
const spawnResult = await client.request("spawn", {
  runtime: "pi",
  cwd,
  prompt: "[scenario:error] fail on purpose for baseline measurement",
  notifyTarget: { channel: "none" },
});
const failedId = spawnResult.id;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const status = await client.request("status", { workerId: failedId, recentEvents: 0 });
  if (["completed", "failed", "cancelled", "crashed"].includes(status.worker.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const testEnv = {
  ...process.env,
  HARNESS_SUPERVISOR_HOME: daemon.stateDir,
  HARNESS_SUPERVISOR_MCP_MODE: "production",
  HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY,
};
rows.push(
  ...(await mcpSession(testEnv, [
    { label: "status default (failed)", name: "worker_status", args: { workerId: failedId } },
    { label: "events default (failed)", name: "worker_events", args: { workerId: failedId } },
  ]))
);

console.log(JSON.stringify({ stateDir: daemon.stateDir, failedWorker: failedId, rows }, null, 2));
daemon.child?.kill();