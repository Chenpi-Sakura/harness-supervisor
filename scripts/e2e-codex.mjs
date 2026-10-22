#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorClient } from "../dist/src/ipc/client.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerMode = process.env.CODEX_WORKER_MODE === "real" ? "real" : "fake";
const evidenceDir = path.join(
  root,
  "evidence",
  workerMode === "real" ? "codex-real-pi" : "codex",
);
const fakeEntry = path.join(root, "dist", "test", "fixtures", "fake-harness.js");

if (process.env.RUN_CODEX !== "1") {
  console.log(
    "SKIP: this test makes a real Codex model call. Run with RUN_CODEX=1 npm run e2e:codex",
  );
  process.exit(0);
}

if (workerMode === "fake") {
  process.env.HARNESS_SUPERVISOR_PI_ENTRY = fakeEntry;
  process.env.FAKE_PI_STEP_MS = "20";
  process.env.FAKE_PI_SLOW_STEP_MS = "15000";
} else {
  // Real mode uses the user's configured Pi. Do not silently inherit the
  // fixture entry from a previous test shell.
  delete process.env.HARNESS_SUPERVISOR_PI_ENTRY;
  delete process.env.FAKE_PI_STEP_MS;
  delete process.env.FAKE_PI_SLOW_STEP_MS;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function windowsPath(value) {
  return value.replaceAll("\\", "/");
}

function resolveCodex() {
  const entry = process.env.HARNESS_SUPERVISOR_CODEX_ENTRY;
  if (entry) {
    const resolved = path.resolve(entry);
    return { file: process.execPath, prefixArgs: [resolved], description: `node ${resolved}` };
  }
  const bin = process.env.HARNESS_SUPERVISOR_CODEX_BIN;
  if (bin) {
    if (/\.(?:js|mjs|cjs)$/i.test(bin)) {
      return { file: process.execPath, prefixArgs: [path.resolve(bin)], description: `node ${bin}` };
    }
    return { file: bin, prefixArgs: [], description: bin };
  }
  if (process.platform === "win32") {
    try {
      const output = execFileSync("where.exe", ["codex"], {
        encoding: "utf8",
        windowsHide: true,
      });
      for (const line of output.split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate) continue;
        const js = path.join(
          path.dirname(candidate),
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        if (existsSync(js)) {
          return { file: process.execPath, prefixArgs: [js], description: `node ${js}` };
        }
        if (/\.exe$/i.test(candidate)) {
          return { file: candidate, prefixArgs: [], description: candidate };
        }
      }
    } catch {
      // Fall through to PATH.
    }
  }
  return { file: "codex", prefixArgs: [], description: "codex (PATH)" };
}

function runCodex(entry, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(entry.file, [...entry.prefixArgs, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function connectWithRetry(stateDir, attempts = 20) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const client = new SupervisorClient({ stateDir, autoStart: false });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not connect to the supervisor");
}

async function copyIfPresent(from, to) {
  if (await fileExists(from)) await copyFile(from, to);
}

function parseJsonLines(raw) {
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Ignore malformed lines in evidence parsing.
    }
  }
  return records;
}

async function main() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-work-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-state-"));
  const outDir = await mkdtemp(path.join(os.tmpdir(), "hs-codex-out-"));
  const workToml = windowsPath(workDir);
  const stateToml = windowsPath(stateDir);
  const entry = resolveCodex();
  const failures = [];
  let codex = null;
  let workerId = "";
  let workerRecord = null;
  let events = [];
  let toolCalls = [];
  let usage = null;
  let liveDaemonVerified = false;
  let liveClient = null;
  let daemonStopped = false;

  const spawnPrompt =
    workerMode === "fake"
      ? "[scenario:slow] CODEX_E2E"
      : "Use the bash tool to sleep for 8 seconds, then reply with exactly REAL_CODEX_OK. Do not modify files.";
  const prompt = [
    "Use only the harness_supervisor MCP tools; do not use shell, file, or web tools.",
    `Call worker_spawn exactly once with cwd "${workToml}" and prompt ${JSON.stringify(spawnPrompt)}.`,
    "Do not spawn another worker.",
    "Call worker_wait without sinceSeq, until='event', types=['run.started'], timeoutMs=5000.",
    'Call worker_send with message "CODEX_STEER" and mode "steer".',
    "Call worker_wait without sinceSeq, until='terminal', timeoutMs=30000.",
    "Reply exactly one line: CODEX_E2E_OK <workerId> <status> <result.text>.",
  ].join(" ");

  const mcpArgs = [
    path.join(root, "dist", "src", "mcp.js"),
    "--state-dir",
    stateToml,
  ];
  const configPairs = [
    ["mcp_servers.harness_supervisor.command", tomlString(process.execPath)],
    ["mcp_servers.harness_supervisor.args", `[${mcpArgs.map(tomlString).join(",")}]`],
  ];
  if (workerMode === "fake") {
    configPairs.push([
      "mcp_servers.harness_supervisor.env",
      `{HARNESS_SUPERVISOR_PI_ENTRY=${tomlString(fakeEntry)},FAKE_PI_STEP_MS="20",FAKE_PI_SLOW_STEP_MS="15000"}`,
    ]);
  }
  configPairs.push(
    ["mcp_servers.harness_supervisor.startup_timeout_sec", "30"],
    ["mcp_servers.harness_supervisor.tool_timeout_sec", "90"],
    ["mcp_servers.harness_supervisor.default_tools_approval_mode", '"approve"'],
    ["mcp_servers.harness_supervisor.required", "true"],
    ["approval_policy", '"on-request"'],
    ["model_reasoning_effort", '"low"'],
  );
  const config = configPairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);

  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-C",
    workToml,
    ...config,
    "-o",
    path.join(outDir, "last-message.txt"),
    prompt,
  ];

  const version = (() => {
    try {
      return execFileSync(entry.file, [...entry.prefixArgs, "--version"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 20_000,
      }).trim();
    } catch (error) {
      return `unknown (${error instanceof Error ? error.message : String(error)})`;
    }
  })();

  try {
    // Start the daemon outside Codex. codex exec 0.161.0 terminates the MCP
    // server's process tree on exit, including a daemon it auto-started.
    const bootstrap = new SupervisorClient({
      stateDir,
      autoStart: true,
      connectTimeoutMs: 20_000,
    });
    try {
      await bootstrap.connect();
      await bootstrap.request("ping");
    } finally {
      bootstrap.close();
    }

    codex = await runCodex(entry, args, 180_000);
    await writeFile(path.join(outDir, "codex.jsonl"), codex.stdout, "utf8");
    await writeFile(path.join(outDir, "codex.stderr.txt"), codex.stderr, "utf8");
    await writeFile(path.join(outDir, "prompt.txt"), `${prompt}\n`, "utf8");

    if (codex.timedOut) failures.push("Codex exec timed out after 180000ms");
    if (codex.code !== 0) failures.push(`Codex exited with code ${codex.code} signal ${codex.signal}`);

    const lastMessagePath = path.join(outDir, "last-message.txt");
    const lastMessage = (await fileExists(lastMessagePath))
      ? (await readFile(lastMessagePath, "utf8")).trim()
      : "";
    const match = /^CODEX_E2E_OK (\S+) (\S+) (.*)$/m.exec(lastMessage);
    if (!match) {
      failures.push(`Unexpected final message: ${JSON.stringify(lastMessage)}`);
    } else {
      workerId = match[1];
      if (match[2] !== "completed") failures.push(`Reported status is ${match[2]}`);
      if (match[3].trim().length === 0) failures.push("Final text is empty");
      if (workerMode === "fake") {
        if (!match[3].includes("FAKE_PI_OK")) failures.push("Final text is missing FAKE_PI_OK");
        if (!match[3].includes("STEERED:CODEX_STEER")) {
          failures.push("Final text is missing STEERED:CODEX_STEER");
        }
      }
    }

    const codexRecords = parseJsonLines(codex.stdout);
    toolCalls = codexRecords
      .filter(
        (record) =>
          record.type === "item.completed" &&
          record.item?.type === "mcp_tool_call" &&
          record.item.server === "harness_supervisor",
      )
      .map((record) => record.item);
    usage = codexRecords.find((record) => record.type === "turn.completed")?.usage ?? null;
    for (const tool of ["worker_spawn", "worker_wait", "worker_send"]) {
      if (!toolCalls.some((call) => call.tool === tool)) {
        failures.push(`Codex never completed a ${tool} MCP call`);
      }
    }
    const toolErrors = toolCalls.filter((call) => call.error || call.status === "failed");
    if (toolErrors.length > 0) {
      failures.push(
        `Codex MCP tool errors: ${toolErrors.map((call) => `${call.tool}:${call.error ?? call.status}`).join("; ")}`,
      );
    }

    if (!workerId) {
      const workerDirs = await readdir(path.join(stateDir, "workers")).catch(() => []);
      workerId = workerDirs.sort().at(-1) ?? "";
    }

    if (workerId) {
      const workerFile = path.join(stateDir, "workers", workerId, "worker.json");
      if (await fileExists(workerFile)) {
        workerRecord = JSON.parse(await readFile(workerFile, "utf8"));
        if (workerRecord.status !== "completed") {
          failures.push(`Persisted worker status is ${workerRecord.status}`);
        }
        if (String(workerRecord.result?.text ?? "").trim().length === 0) {
          failures.push("Persisted result is empty");
        }
        if (
          workerMode === "fake" &&
          !String(workerRecord.result?.text ?? "").includes("STEERED:CODEX_STEER")
        ) {
          failures.push("Persisted result is missing the steering message");
        }
        const eventsFile = path.join(stateDir, "workers", workerId, "events.jsonl");
        if (await fileExists(eventsFile)) {
          events = parseJsonLines(await readFile(eventsFile, "utf8"));
        }
        const index = (type) => events.findIndex((event) => event.type === type);
        const accepted = index("run.accepted");
        const started = index("run.started");
        const sent = index("run.message_sent");
        const completed = index("run.completed");
        if ([accepted, started, sent, completed].some((value) => value < 0)) {
          failures.push("Required lifecycle events are missing");
        } else if (!(accepted < started && started < sent && sent < completed)) {
          failures.push("Lifecycle event ordering is incorrect");
        }
        const sentEvent = events.find((event) => event.type === "run.message_sent");
        if (sentEvent?.data?.mode !== "steer") failures.push("Steering event has the wrong mode");
      } else {
        failures.push(`Worker record not found: ${workerFile}`);
      }
    } else {
      failures.push("No worker was created");
    }

    const workerDirs = await readdir(path.join(stateDir, "workers")).catch(() => []);
    if (workerDirs.length !== 1) {
      failures.push(`Expected exactly one worker, found ${workerDirs.length}`);
    }

    try {
      liveClient = await connectWithRetry(stateDir);
      const liveStatus = await liveClient.request("status", {
        workerId,
        recentEvents: 5,
      });
      // The daemon was started before Codex and must still serve this new
      // client after Codex exited.
      if (liveStatus.worker?.status !== "completed") {
        failures.push("Daemon did not retain the completed worker after Codex exited");
      } else {
        liveDaemonVerified = true;
      }
    } catch (error) {
      failures.push(
        `Could not verify daemon survival after Codex exited: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    failures.push(`E2E setup or execution failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (liveClient && !daemonStopped) {
      try {
        await liveClient.shutdown();
        daemonStopped = true;
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch {
        // Leave the state directory in place below when shutdown fails.
      }
    }
    if (liveClient) liveClient.close();

    await mkdir(evidenceDir, { recursive: true });
    await copyIfPresent(path.join(outDir, "codex.jsonl"), path.join(evidenceDir, "codex.jsonl"));
    await copyIfPresent(
      path.join(outDir, "codex.stderr.txt"),
      path.join(evidenceDir, "codex.stderr.txt"),
    );
    await copyIfPresent(
      path.join(outDir, "last-message.txt"),
      path.join(evidenceDir, "last-message.txt"),
    );
    await copyIfPresent(path.join(outDir, "prompt.txt"), path.join(evidenceDir, "prompt.txt"));
    await copyIfPresent(path.join(stateDir, "daemon.log"), path.join(evidenceDir, "daemon.log"));
    if (workerId) {
      const workerState = path.join(stateDir, "workers", workerId);
      await copyIfPresent(path.join(workerState, "worker.json"), path.join(evidenceDir, "worker.json"));
      await copyIfPresent(path.join(workerState, "events.jsonl"), path.join(evidenceDir, "events.jsonl"));
      await copyIfPresent(path.join(workerState, "stderr.log"), path.join(evidenceDir, "worker.stderr.txt"));
      if (workerRecord?.sessionFile && (await fileExists(workerRecord.sessionFile))) {
        await copyFile(workerRecord.sessionFile, path.join(evidenceDir, "session.jsonl"));
      }
    }

    const passed = failures.length === 0;
    const lines = [
      `Codex MCP E2E: ${passed ? "PASS" : "FAIL"}`,
      `Date: ${new Date().toISOString()}`,
      `Host: ${version} on ${process.platform} ${process.arch}`,
      `Worker mode: ${workerMode} (${workerMode === "fake" ? "scripted Pi RPC fixture" : "real Pi model"})`,
      `Codex: ${entry.description}`,
      `MCP state dir: ${stateDir}`,
      `Worker: ${workerId || "(none)"}`,
      `Worker status: ${workerRecord?.status ?? "(unknown)"}`,
      `Worker result: ${workerRecord?.result?.text ?? "(none)"}`,
      `Tool calls: ${toolCalls.map((call) => call.tool).join(", ") || "(none)"}`,
      `Daemon pre-started outside Codex: yes`,
      `Daemon survived Codex exit: ${liveDaemonVerified ? "yes" : "no"}`,
      `Codex usage: ${usage ? JSON.stringify(usage) : "(unknown)"}`,
      `Assertions: ${passed ? "all passed" : failures.join(" | ")}`,
      "",
      workerMode === "fake"
        ? "Pi is the scripted protocol fixture. This validates Codex MCP transport, tool approval, pull-based waiting, steering during a run, result retrieval, and daemon survival. It does not validate a real Pi model inside the worker."
        : "Pi is the user's real Pi configuration. This validates the full Codex -> Supervisor -> real Pi path. Result text is model-generated and is not asserted beyond being non-empty; the steer is proven by the run.message_sent event.",
    ];
    await writeFile(path.join(evidenceDir, "test-run.txt"), `${lines.join("\n")}\n`, "utf8");

    console.log(lines.slice(0, 10).join("\n"));
    if (!passed) {
      console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
      process.exitCode = 1;
    }
  }

  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  if (daemonStopped || !existsSync(path.join(stateDir, "daemon.lock"))) {
    await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
  } else {
    console.error(
      `WARNING: supervisor daemon may still be running; left state dir in place: ${stateDir}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
