#!/usr/bin/env node
/**
 * Real-harness acceptance for the 0.9.1 MCP response contract.
 *
 * Runs one minimal text-only task per runtime through the production MCP:
 * worker_spawn -> worker_wait -> worker_status -> worker_events.
 *
 * It records JSON byte sizes, response field sets, result integrity and
 * progress/thinking leakage. It never touches the production state directory:
 * a fresh temp state and workspace are used for every run.
 *
 * Usage:
 *   MCP_REAL_RUNTIMES=qoder,mcode node scripts/e2e-mcp-runtimes.mjs
 *
 * Optional:
 *   MCP_REAL_MODE=production|development   (default production)
 *   MCP_REAL_EVIDENCE_DIR=<dir>            (default evidence/mcp-runtime-acceptance-261110)
 *   MCP_REAL_WAIT_MS=300000                per-runtime terminal timeout
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SupervisorClient } from "../dist/src/ipc/client.js";
import { redactText } from "../dist/src/util/redact.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpEntry = path.join(root, "dist", "src", "mcp.js");
const evidenceDir = process.env.MCP_REAL_EVIDENCE_DIR
  ? path.resolve(process.env.MCP_REAL_EVIDENCE_DIR)
  : path.join(root, "evidence", "mcp-runtime-acceptance-261110");
const mode = process.env.MCP_REAL_MODE === "development" ? "development" : "production";
const waitMs = Number(process.env.MCP_REAL_WAIT_MS ?? 300_000);
const requested = (process.env.MCP_REAL_RUNTIMES ?? "qoder,mcode")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (process.env.MCP_REAL !== "1") {
  console.log(
    "Skipped real MCP runtime acceptance. Set MCP_REAL=1 and MCP_REAL_RUNTIMES=qoder,mcode.",
  );
  process.exit(0);
}

const RUNTIMES = {
  qoder: {
    token: "QODER_MCP_OK_261110",
    prompt:
      "不要调用任何工具，不要修改或读取文件。只回复下面这一行，不要添加其他内容：QODER_MCP_OK_261110",
  },
  mcode: {
    token: "MCODE_MCP_OK_261110",
    prompt:
      "不要调用任何工具，不要修改或读取文件。只回复下面这一行，不要添加其他内容：MCODE_MCP_OK_261110",
  },
};

const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-mcp-real-state-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "hs-mcp-real-work-"));
await writeFile(
  path.join(workspace, "README.md"),
  "# MCP real-harness acceptance\n\nThis directory only exists for the 0.9.1 MCP acceptance run.\n",
  "utf8",
);

const env = { ...process.env, HARNESS_SUPERVISOR_HOME: stateDir };
for (const key of [
  "HARNESS_SUPERVISOR_PI_ENTRY",
  "HARNESS_SUPERVISOR_PI_BIN",
  "HARNESS_SUPERVISOR_PI_ARGS",
  "FAKE_PI_SCENARIO",
  "FAKE_PI_STEP_MS",
  "FAKE_PI_SLOW_STEP_MS",
  // The desktop injects an unauthenticated Qoder root; the login lives in ~/.qoder.
  "QODER_CONFIG_DIR",
  "QODERCN_CONFIG_DIR",
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_VERSION",
  "QODER_SDK_AUTH_PAYLOAD_FILE",
  "QODER_WORKER_CWD",
  "QODER_WORKER_RUNTIME_ASSET_ROOT",
  "QODERCN_SESSION_TYPE",
]) {
  delete env[key];
}

function clean(text) {
  return redactText(String(text ?? ""))
    .replaceAll(stateDir, "%STATE_DIR%")
    .replaceAll(workspace, "%WORKSPACE%")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"]+/g, "%USERPROFILE%")
    .replace(/[A-Za-z]:\/Users\/[^/\s"]+/g, "%USERPROFILE%");
}

function fail(message) {
  throw new Error(clean(message));
}

async function connectMcp(clientMode) {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry, "--state-dir", stateDir, "--mode", clientMode],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: `hs-real-${clientMode}`, version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

function keys(value) {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function rawBytes(text) {
  return Buffer.byteLength(text, "utf8");
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) {
    fail(`${name} failed: ${text}`);
  }
  return { parsed: JSON.parse(text), text, bytes: rawBytes(text) };
}

async function waitTerminal(client, workerId) {
  const deadline = Date.now() + waitMs;
  let sinceSeq;
  let calls = 0;
  let totalBytes = 0;
  let last;
  for (;;) {
    const remaining = Math.max(1000, Math.min(120_000, deadline - Date.now()));
    last = await call(client, "worker_wait", {
      workerId,
      timeoutMs: remaining,
      until: "terminal",
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    });
    calls += 1;
    totalBytes += last.bytes;
    if (last.parsed.terminal) {
      return { ...last, calls, totalBytes };
    }
    if (last.parsed.worker?.status === "awaiting_input") {
      fail(
        `worker ${workerId} requested input unexpectedly: ${clean(
          last.parsed.worker?.pendingInput?.requestId ?? "unknown request",
        )}`,
      );
    }
    sinceSeq = last.parsed.nextSeq;
    if (Date.now() >= deadline) {
      fail(`worker ${workerId} did not reach terminal state within ${waitMs}ms`);
    }
  }
}

function runtimeVersion(runtime) {
  const options = { encoding: "utf8", env, timeout: 30_000, windowsHide: true };
  try {
    if (runtime === "qoder") {
      return String(execFileSync("qodercli", ["--version"], options)).trim();
    }
    if (runtime === "mcode") {
      const comspec = process.env.ComSpec ?? "cmd.exe";
      return String(
        execFileSync(comspec, ["/d", "/s", "/c", "mcode --version"], options),
      ).trim();
    }
  } catch (error) {
    return `unavailable: ${clean(error.message)}`;
  }
  return "unknown";
}

function productionLeakReport(responses) {
  const joined = responses.join("\n");
  const bannedKeys = [
    "cwd",
    "pid",
    "promptPreview",
    "capabilities",
    "config",
    "stats",
    "updatedAt",
    "sessionFile",
    "sessionId",
    "supervisorId",
    "stderrTail",
    "lastProgress",
    "timeline",
    "inputState",
  ];
  return {
    runProgressText: /"type":"run\.progress"|"type": "run\.progress"/.test(joined),
    thinkingText: /"thinking"|text_delta|reasoning_delta/.test(joined),
    bannedKeys: bannedKeys.filter((key) => new RegExp(`"${key}"\\s*:`).test(joined)),
  };
}

const evidence = {
  schemaVersion: 1,
  ranAt: new Date().toISOString(),
  host: `${os.platform()} ${os.release()} / Node ${process.version}`,
  mcpMode: mode,
  runtimes: {},
  assertions: {},
  limits: {
    scope:
      "One minimal text-only task per runtime through the production MCP. No Desktop-model run, no persistent multi-turn continuity, no steering/permission flow.",
    result:
      "worker_wait keeps the complete final result. result.truncated only reflects the supervisor's storage cap, not MCP presentation truncation.",
    usage:
      "Runtime-specific usage counters are not part of this acceptance; only response fields and payload leakage are checked.",
  },
};

let mcp;
let development;
let exitCode = 0;
try {
  mcp = await connectMcp("production");
  const info = await call(mcp.client, "supervisor_info", {});
  evidence.supervisor = {
    bytes: info.bytes,
    keys: keys(info.parsed),
    version: info.parsed.version,
    mcpMode: info.parsed.mcpMode,
    runtimes: info.parsed.runtimes,
  };

  for (const runtime of requested) {
    const spec = RUNTIMES[runtime];
    if (!spec) {
      evidence.runtimes[runtime] = { error: `Unsupported runtime ${runtime}` };
      exitCode = 1;
      continue;
    }
    const scenario = {
      runtime,
      version: runtimeVersion(runtime),
      prompt: spec.prompt,
      error: null,
      spawn: null,
      wait: null,
      status: null,
      events: null,
      development: null,
      checks: {},
    };
    evidence.runtimes[runtime] = scenario;
    let workerId;
    try {
      const spawn = await call(mcp.client, "worker_spawn", {
        cwd: workspace,
        prompt: spec.prompt,
        runtime,
        maxDurationMs: waitMs,
        notifyTarget: { channel: "none" },
      });
      workerId = spawn.parsed.id;
      scenario.workerId = workerId;
      scenario.spawn = { bytes: spawn.bytes, keys: keys(spawn.parsed), status: spawn.parsed.status };

      const waited = await waitTerminal(mcp.client, workerId);
      scenario.wait = {
        bytes: waited.bytes,
        calls: waited.calls,
        totalBytes: waited.totalBytes,
        keys: keys(waited.parsed),
        workerKeys: keys(waited.parsed.worker),
        status: waited.parsed.worker?.status,
        terminal: waited.parsed.terminal,
        resultLength: waited.parsed.worker?.result?.text?.length ?? null,
        resultTruncated: waited.parsed.worker?.result?.truncated ?? null,
        tokenPresent:
          typeof waited.parsed.worker?.result?.text === "string" &&
          waited.parsed.worker.result.text.includes(spec.token),
        tokenOccurrences:
          typeof waited.parsed.worker?.result?.text === "string"
            ? waited.parsed.worker.result.text.split(spec.token).length - 1
            : 0,
        eventsPresent: "events" in waited.parsed,
      };

      const status = await call(mcp.client, "worker_status", { workerId });
      scenario.status = {
        bytes: status.bytes,
        keys: keys(status.parsed),
        workerKeys: keys(status.parsed.worker),
        status: status.parsed.worker?.status,
        resultAvailable: status.parsed.worker?.resultAvailable,
        resultPreview: status.parsed.worker?.resultPreview
          ? {
              chars: status.parsed.worker.resultPreview.chars,
              truncated: status.parsed.worker.resultPreview.truncated,
              previewLength: status.parsed.worker.resultPreview.preview?.length ?? null,
            }
          : null,
        hasRecentEvents: "recentEvents" in status.parsed,
        lastEvent: status.parsed.worker?.lastEvent ?? null,
      };

      const events = await call(mcp.client, "worker_events", { workerId });
      const eventList = Array.isArray(events.parsed.events) ? events.parsed.events : [];
      scenario.events = {
        bytes: events.bytes,
        keys: keys(events.parsed),
        count: eventList.length,
        types: [...new Set(eventList.map((event) => event.type))].sort(),
        eventKeys: [...new Set(eventList.flatMap((event) => keys(event)))].sort(),
        progressOmitted: events.parsed.progressOmitted ?? null,
        hasRunProgress: eventList.some((event) => event.type === "run.progress"),
        hasRawData: eventList.some((event) => "data" in event),
      };

      const leak = productionLeakReport([waited.text, status.text, events.text]);
      scenario.checks = {
        terminal: scenario.wait.terminal === true,
        completed: scenario.wait.status === "completed",
        tokenPresent: scenario.wait.tokenPresent === true,
        tokenOccurrences: scenario.wait.tokenOccurrences,
        resultNotPresentationTruncated:
          scenario.wait.resultTruncated === null || scenario.wait.resultTruncated === false,
        waitHasNoEvents: scenario.wait.eventsPresent === false,
        statusHasNoEvents: scenario.status.hasRecentEvents === false,
        statusHasPreview: scenario.status.resultAvailable === true,
        eventsHaveNoProgress: scenario.events.hasRunProgress === false,
        eventsHaveNoRawData: scenario.events.hasRawData === false,
        noProgressText: leak.runProgressText === false,
        noThinkingDelta: leak.thinkingText === false,
        noBannedKeys: leak.bannedKeys,
      };
      if (
        !scenario.checks.terminal ||
        !scenario.checks.completed ||
        !scenario.checks.tokenPresent ||
        !scenario.checks.resultNotPresentationTruncated ||
        !scenario.checks.waitHasNoEvents ||
        !scenario.checks.statusHasNoEvents ||
        !scenario.checks.statusHasPreview ||
        !scenario.checks.eventsHaveNoProgress ||
        !scenario.checks.eventsHaveNoRawData ||
        !scenario.checks.noProgressText ||
        !scenario.checks.noThinkingDelta ||
        scenario.checks.noBannedKeys.length > 0
      ) {
        scenario.error = "Production contract assertion failed";
        exitCode = 1;
      }
    } catch (error) {
      scenario.error = clean(error.message);
      exitCode = 1;
      if (workerId) {
        try {
          await call(mcp.client, "worker_cancel", { workerId, timeoutMs: 15_000 });
        } catch {
          // The run may already be terminal.
        }
      }
    }
  }

  // Development diagnostics: what the runtime actually emitted vs. what the
  // production projection exposed. Only type summaries are kept.
  development = await connectMcp("development");
  for (const [runtime, scenario] of Object.entries(evidence.runtimes)) {
    if (!scenario.workerId || scenario.error) continue;
    try {
      const status = await call(development.client, "worker_status", {
        workerId: scenario.workerId,
        recentEvents: 20,
      });
      const events = await call(development.client, "worker_events", {
        workerId: scenario.workerId,
        includeProgress: true,
        limit: 500,
      });
      const list = Array.isArray(events.parsed.events) ? events.parsed.events : [];
      const progress = list.filter((event) => event.type === "run.progress");
      scenario.development = {
        statusBytes: status.bytes,
        statusWorkerKeys: keys(status.parsed.worker),
        eventCount: list.length,
        progressCount: progress.length,
        progressKinds: [
          ...new Set(progress.map((event) => event.data?.kind).filter(Boolean)),
        ].sort(),
        eventTypes: [...new Set(list.map((event) => event.type))].sort(),
      };
    } catch (error) {
      scenario.development = { error: clean(error.message) };
    }
  }
} catch (error) {
  evidence.fatal = clean(error.message);
  exitCode = 1;
} finally {
  try {
    await development?.client.close();
  } catch {
    // Ignore cleanup errors.
  }
  try {
    await mcp?.client.close();
  } catch {
    // Ignore cleanup errors.
  }
  try {
    const client = new SupervisorClient({ stateDir, autoStart: false });
    await client.connect();
    await client.request("shutdown", {});
    client.close();
  } catch {
    // The MCP server may have already stopped its daemon.
  }
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, "result.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  console.log(clean(JSON.stringify(evidence, null, 2)));
  console.log(`\nevidence: ${clean(evidenceDir)}`);
}

process.exit(exitCode);
