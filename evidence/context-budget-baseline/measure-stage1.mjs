// Stage 1 measurement: compact defaults versus explicit full reads.
// Read-only against the production daemon. Run after building the candidate
// dist: HS_DIST_DIR=<outDir> node evidence/context-budget-baseline/measure-stage1.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = process.env.HS_DIST_DIR ? path.resolve(process.env.HS_DIST_DIR) : path.join(REPO, "dist");
const MCP_ENTRY = path.join(DIST, "src", "mcp.js");
const CLI_ENTRY = path.join(DIST, "src", "cli.js");
const FAKE_ENTRY = path.join(DIST, "test", "fixtures", "fake-harness.js");
const { TestDaemon } = await import(
  new URL("file:///" + path.join(DIST, "test", "integration", "helpers.js").replace(/\\/g, "/")).href
);

const THIRTY = "w-mvngpfbh-53b2077b"; // 30 tool calls
const LONG = "w-mvkwgs9e-4f3929b5"; // 7862 events

function sizeOf(text) {
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
}

const productionEnv = { ...process.env };
delete productionEnv.HARNESS_SUPERVISOR_HOME;
delete productionEnv.HARNESS_SUPERVISOR_MCP_MODE;

async function mcpCalls(calls, env = productionEnv) {
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
  });
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });
  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hs-stage1", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const out = [];
  let id = 100;
  for (const call of calls) {
    const message = await request(id++, "tools/call", { name: call.name, arguments: call.args });
    const text = message?.result?.content?.[0]?.text ?? JSON.stringify(message.error ?? {});
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    out.push({ label: call.label, ...sizeOf(text), parsed });
  }
  child.kill();
  if (stderr.trim() && process.env.HS_BASELINE_DEBUG) console.error(stderr.trim().slice(0, 300));
  return out;
}

function cli(args) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  const text = (result.stdout ?? "").trimEnd();
  return { label: args.join(" "), status: result.status, ...sizeOf(text), error: result.status === 0 ? undefined : (result.stderr ?? "").slice(0, 200) };
}

const rows = [];
const mcp = await mcpCalls([
  { label: "mcp status default (30 tools)", name: "worker_status", args: { workerId: THIRTY } },
  { label: "mcp status includeResult (30 tools)", name: "worker_status", args: { workerId: THIRTY, includeResult: true } },
  { label: "mcp status default (long history)", name: "worker_status", args: { workerId: LONG } },
  { label: "mcp events default (30 tools)", name: "worker_events", args: { workerId: THIRTY } },
  { label: "mcp events default (long history)", name: "worker_events", args: { workerId: LONG } },
  { label: "mcp events includeProgress (30 tools)", name: "worker_events", args: { workerId: THIRTY, includeProgress: true } },
]);
rows.push(
  ...mcp.map((row) => ({
    interface: "mcp",
    label: row.label,
    chars: row.chars,
    bytes: row.bytes,
    events: Array.isArray(row.parsed?.events) ? row.parsed.events.length : Array.isArray(row.parsed?.recentEvents) ? row.parsed.recentEvents.length : 0,
    progress: [...(row.parsed?.events ?? []), ...(row.parsed?.recentEvents ?? [])].filter((event) => event?.type === "run.progress").length,
    resultPreview: typeof row.parsed?.worker?.result?.preview === "string",
    resultText: typeof row.parsed?.worker?.result?.text === "string",
    progressOmitted: row.parsed?.progressOmitted,
    eventsOmitted: row.parsed?.eventsOmitted,
  })),
);

const progressSeq = (await mcpCalls([
  { label: "find progress", name: "worker_events", args: { workerId: THIRTY, includeProgress: true } },
]))[0].parsed.events.find((event) => event.type === "run.progress").seq;
const single = await mcpCalls([
  { label: "mcp events seq", name: "worker_events", args: { workerId: THIRTY, seq: progressSeq } },
]);
rows.push({
  interface: "mcp",
  label: `mcp events seq=${progressSeq}`,
  chars: single[0].chars,
  bytes: single[0].bytes,
  eventType: single[0].parsed?.event?.type,
  hasData: typeof single[0].parsed?.event?.data === "object",
});

const cliRows = [
  cli(["status", THIRTY, "--json"]),
  cli(["status", THIRTY, "--json", "--full"]),
  cli(["events", THIRTY, "--json"]),
  cli(["events", THIRTY, "--json", "--full"]),
  cli(["events", THIRTY, "--seq", String(progressSeq), "--json"]),
];
rows.push(...cliRows.map((row) => ({ interface: "cli", ...row })));

// The two explicit faces are independent. A production worker has a stored
// result but no pending question, so the input face uses an isolated fixture
// daemon: an 8k-char report and a 2,000-char question.
const faceDaemon = await TestDaemon.create("hs-stage1-faces-");
await faceDaemon.start({
  env: { FAKE_PI_REPORT_CHARS: "8000", FAKE_PI_UI_MESSAGE_CHARS: "2000" },
});
const faceEnv = {
  ...process.env,
  HARNESS_SUPERVISOR_HOME: faceDaemon.stateDir,
  HARNESS_SUPERVISOR_MCP_MODE: "production",
  HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY,
};
const faceCwd = mkdtempSync(path.join(os.tmpdir(), "hs-stage1-cwd-"));
const reportSpawn = await mcpCalls(
  [
    {
      label: "spawn report",
      name: "worker_spawn",
      args: {
        cwd: faceCwd,
        prompt: "[scenario:report] stage1 faces",
        notifyTarget: { channel: "none" },
      },
    },
  ],
  faceEnv,
);
const reportId = reportSpawn[0].parsed?.id;
await mcpCalls(
  [
    {
      label: "wait report",
      name: "worker_wait",
      args: { workerId: reportId, timeoutMs: 20_000, until: "terminal" },
    },
  ],
  faceEnv,
);
const askSpawn = await mcpCalls(
  [
    {
      label: "spawn ask",
      name: "worker_spawn",
      args: {
        cwd: faceCwd,
        prompt: "[scenario:ask] stage1 faces",
        notifyTarget: { channel: "none" },
      },
    },
  ],
  faceEnv,
);
const askId = askSpawn[0].parsed?.id;
const askWait = await mcpCalls(
  [
    {
      label: "wait ask",
      name: "worker_wait",
      args: { workerId: askId, timeoutMs: 20_000, until: "terminal" },
    },
  ],
  faceEnv,
);
const question = askWait[0].parsed?.worker?.pendingInput?.message ?? "";

const failedSpawn = await mcpCalls(
  [
    {
      label: "spawn failed",
      name: "worker_spawn",
      args: {
        cwd: faceCwd,
        prompt: "[scenario:error] stage1 faces",
        notifyTarget: { channel: "none" },
      },
    },
  ],
  faceEnv,
);
const failedId = failedSpawn[0].parsed?.id;
await mcpCalls(
  [
    {
      label: "wait failed",
      name: "worker_wait",
      args: { workerId: failedId, timeoutMs: 20_000, until: "terminal" },
    },
  ],
  faceEnv,
);

const faceCalls = await mcpCalls(
  [
    {
      label: "mcp status includeInput (report)",
      name: "worker_status",
      args: { workerId: reportId, includeInput: true },
    },
    {
      label: "mcp status includeInput recentEvents=100 (report)",
      name: "worker_status",
      args: { workerId: reportId, includeInput: true, recentEvents: 100 },
    },
    {
      label: "mcp status includeResult (ask)",
      name: "worker_status",
      args: { workerId: askId, includeResult: true },
    },
    {
      label: "mcp status includeResult recentEvents=100 (ask)",
      name: "worker_status",
      args: { workerId: askId, includeResult: true, recentEvents: 100 },
    },
    {
      label: "mcp status includeInput (ask)",
      name: "worker_status",
      args: { workerId: askId, includeInput: true },
    },
    {
      label: "mcp status both (report)",
      name: "worker_status",
      args: { workerId: reportId, includeResult: true, includeInput: true },
    },
    {
      label: "mcp status includeInput (failed)",
      name: "worker_status",
      args: { workerId: failedId, includeInput: true },
    },
    {
      label: "mcp status includeResult (failed)",
      name: "worker_status",
      args: { workerId: failedId, includeResult: true },
    },
    {
      label: "mcp status includeResult recentEvents=100 (report)",
      name: "worker_status",
      args: { workerId: reportId, includeResult: true, recentEvents: 100 },
    },
  ],
  faceEnv,
);

const faceRows = faceCalls.map((row) => {
  const worker = row.parsed?.worker ?? {};
  const message = worker.pendingInput?.message;
  const events = Array.isArray(row.parsed?.recentEvents) ? row.parsed.recentEvents : [];
  const eventsJson = JSON.stringify(events);
  return {
    interface: "mcp",
    label: row.label,
    chars: row.chars,
    bytes: row.bytes,
    resultText: typeof worker.result?.text === "string",
    resultLength: typeof worker.result?.text === "string" ? worker.result.text.length : undefined,
    resultPreview: typeof worker.result?.preview === "string",
    resultChars: worker.result?.chars,
    resultTruncated: worker.result?.truncated,
    errorText: typeof worker.error === "string",
    errorPreview: worker.error !== null && typeof worker.error === "object",
    errorChars:
      typeof worker.error === "string"
        ? worker.error.length
        : typeof worker.error === "object" && worker.error !== null
          ? worker.error.chars
          : undefined,
    inputText: typeof message === "string",
    inputPreview: message !== null && typeof message === "object",
    inputChars: typeof message === "string" ? message.length : message?.chars,
    inputTruncated: typeof message === "object" && message !== null ? message.truncated : undefined,
    inputPreviewLength:
      typeof message === "object" && message !== null && typeof message.preview === "string"
        ? message.preview.length
        : undefined,
    events: events.length,
    eventData: events.some((event) => event !== null && typeof event === "object" && "data" in event),
    containsReportBody: eventsJson.includes("FAKE_PI_REPORT_BEGIN"),
    containsQuestionBody: eventsJson.includes("Q".repeat(200)),
    progress: events.filter((event) => event?.type === "run.progress").length,
    eventsOmitted: row.parsed?.eventsOmitted,
  };
});
rows.push(...faceRows);
await faceDaemon.stop();

const face = (label) => faceRows.find((row) => row.label === label) ?? {};

const checks = [
  {
    name: "mcp status default <= 2048 bytes",
    pass: (rows.find((row) => row.label === "mcp status default (30 tools)")?.bytes ?? Infinity) <= 2048,
  },
  {
    name: "mcp events default <= 4096 bytes",
    pass: (rows.find((row) => row.label === "mcp events default (30 tools)")?.bytes ?? Infinity) <= 4096,
  },
  {
    name: "mcp events default has no progress",
    pass: (rows.find((row) => row.label === "mcp events default (30 tools)")?.progress ?? 1) === 0,
  },
  {
    name: "cli status default <= 2048 bytes",
    pass: (rows.find((row) => row.label.startsWith("status ") && !row.label.includes("--full"))?.bytes ?? Infinity) <= 2048,
  },
  {
    name: "cli events default <= 4096 bytes",
    pass: (rows.find((row) => row.label.startsWith("events ") && !row.label.includes("--full") && !row.label.includes("--seq"))?.bytes ?? Infinity) <= 4096,
  },
  {
    name: "cli status --full restores the full result",
    pass: rows.find((row) => row.label.includes("--full"))?.status === 0,
  },
  {
    name: "mcp includeResult is larger than the preview",
    pass:
      (rows.find((row) => row.label === "mcp status includeResult (30 tools)")?.bytes ?? 0) >
      (rows.find((row) => row.label === "mcp status default (30 tools)")?.bytes ?? 0),
  },
  {
    name: "includeResult returns the complete result",
    pass:
      face("mcp status both (report)").resultText === true &&
      (face("mcp status both (report)").resultLength ?? 0) >= 8000,
  },
  {
    name: "includeResult keeps the pending input a preview",
    pass:
      face("mcp status includeResult (ask)").inputPreview === true &&
      face("mcp status includeResult (ask)").inputText === false,
  },
  {
    name: "includeResult still marks the clipped question",
    pass:
      face("mcp status includeResult (ask)").inputChars === 2000 &&
      face("mcp status includeResult (ask)").inputTruncated === true &&
      (face("mcp status includeResult (ask)").inputPreviewLength ?? Infinity) <= 400,
  },
  {
    name: "includeInput keeps the result a preview",
    pass:
      face("mcp status includeInput (report)").resultPreview === true &&
      face("mcp status includeInput (report)").resultText === false &&
      (face("mcp status includeInput (report)").resultChars ?? 0) >= 8000,
  },
  {
    name: "includeInput preview is bounded and marked",
    pass:
      (face("mcp status includeInput (report)").resultChars ?? 0) >= 8000 &&
      face("mcp status includeInput (report)").resultTruncated === true,
  },
  {
    name: "includeInput + recentEvents never returns event payloads",
    pass:
      face("mcp status includeInput recentEvents=100 (report)").eventData === false &&
      face("mcp status includeInput recentEvents=100 (report)").containsReportBody === false &&
      (face("mcp status includeInput recentEvents=100 (report)").events ?? 1) <= 10,
  },
  {
    name: "includeResult + recentEvents never returns the full question",
    pass:
      face("mcp status includeResult recentEvents=100 (ask)").inputPreview === true &&
      face("mcp status includeResult recentEvents=100 (ask)").containsQuestionBody === false &&
      face("mcp status includeResult recentEvents=100 (ask)").eventData === false &&
      (face("mcp status includeResult recentEvents=100 (ask)").events ?? 1) <= 10,
  },
  {
    name: "includeInput keeps the failed worker error a preview",
    pass:
      face("mcp status includeInput (failed)").errorPreview === true &&
      face("mcp status includeInput (failed)").errorText === false &&
      (face("mcp status includeInput (failed)").errorChars ?? 0) > 0,
  },
  {
    name: "includeResult returns the complete failed worker error",
    pass: face("mcp status includeResult (failed)").errorText === true,
  },
  {
    name: "includeInput returns the complete question",
    pass:
      face("mcp status includeInput (ask)").inputText === true &&
      face("mcp status includeInput (ask)").inputChars === 2000 &&
      question.length === 2000,
  },
  {
    name: "includeResult with recentEvents is progress-free and summary-only",
    pass:
      (face("mcp status includeResult recentEvents=100 (report)").events ?? 1) <= 10 &&
      (face("mcp status includeResult recentEvents=100 (report)").progress ?? 1) === 0 &&
      face("mcp status includeResult recentEvents=100 (report)").eventData === false &&
      face("mcp status includeResult recentEvents=100 (report)").containsReportBody === false,
  },
];

console.log(JSON.stringify({ dist: DIST, progressSeq, rows, checks }, null, 2));
process.exitCode = checks.every((check) => check.pass) ? 0 : 1;