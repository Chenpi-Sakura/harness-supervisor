#!/usr/bin/env node
/**
 * Real MiniMax Code steering E2E over ACP.
 *
 * The capability notes claim that steering works while a turn is active. This
 * script checks that claim end to end through the supervisor: it spawns a real
 * `mcode acp` worker whose turn runs a long shell command, waits until the
 * agent has actually started a tool call (which proves the turn is admitted),
 * and then sends a steering message and a queued follow-up.
 *
 * The script reports what the agent itself answered:
 * - `steer_accepted` carries the agent's verdict (`mode`, `turnId`).
 * - `followup_queued` carries the queue receipt (`status`, `itemId`).
 * - the final result text shows whether the agent acted on the steering.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorClient } from "../dist/src/ipc/client.js";
import { sleep } from "../dist/src/util/async.js";
import { redactText } from "../dist/src/util/redact.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(root, "dist", "src", "daemon-entry.js");
// The archived evidence is refreshed deliberately: a local run writes to a
// temporary directory unless MCODE_EVIDENCE_DIR points at the archive.
const evidenceDir = process.env.MCODE_EVIDENCE_DIR
  ? path.resolve(process.env.MCODE_EVIDENCE_DIR)
  : path.join(os.tmpdir(), "hs-mcode-evidence");

const STEER_MARKER = "MCODE_STEER_OK";
const FOLLOWUP_MARKER = "MCODE_FOLLOWUP_OK";

function fail(message) {
  throw new Error(String(message));
}

function clean(text) {
  return redactText(String(text ?? "")).replace(/[A-Za-z]:\\Users\\[^\\\s"]+/g, "%USERPROFILE%");
}

function resolveMcodeEntry() {
  const explicit = process.env.HARNESS_SUPERVISOR_MCODE_ENTRY;
  if (explicit) return path.resolve(explicit);
  const pkg = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), ".npm-global"),
    "npm",
    "node_modules",
    "@minimax-ai",
    "code",
    "cli.js",
  );
  if (existsSync(pkg)) return pkg;
  fail("MiniMax Code is not installed. Set HARNESS_SUPERVISOR_MCODE_ENTRY to its cli.js.");
  return "";
}

/** Progress events carry the adapter's verdict in `data`. */
function progressEvents(events) {
  return events
    .filter((event) => event.type === "run.progress")
    .map((event) => event.data ?? {});
}

/** The event log is paged; the cap per request is 500. */
async function fetchAllEvents(client, workerId) {
  const all = [];
  let cursor = 0;
  for (;;) {
    const page = await client.request("events", {
      workerId,
      sinceSeq: cursor,
      limit: 500,
    });
    all.push(...page.events);
    if (!page.hasMore || page.events.length === 0) break;
    cursor = page.nextSeq;
  }
  return all;
}

/** A run produces many progress events, so the evidence counts them by type. */
function countEventTypes(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

async function waitForTerminal(client, workerId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    const result = await client.request("wait", {
      workerId,
      sinceSeq: cursor,
      timeoutMs: Math.min(15_000, Math.max(1000, deadline - Date.now())),
      until: "terminal",
    });
    cursor = result.nextSeq;
    if (result.terminal) return result;
  }
  fail(`Worker ${workerId} did not reach a terminal state within ${timeoutMs}ms`);
  return null;
}

const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-steer-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-steer-work-"));
const entry = resolveMcodeEntry();
await writeFile(
  path.join(workspace, "README.md"),
  "# mcode steer e2e\n\nWorkspace for the Harness Supervisor MiniMax Code steering E2E.\n",
  "utf8",
);

console.log(`state dir : ${stateDir}`);
console.log(`workspace : ${workspace}`);
console.log(`mcode     : ${entry}`);

const daemon = spawn(process.execPath, [daemonEntry, "--state-dir", stateDir], {
  env: {
    ...process.env,
    HARNESS_SUPERVISOR_HOME: stateDir,
    HARNESS_SUPERVISOR_MCODE_ENTRY: entry,
    HARNESS_SUPERVISOR_ABORT_TIMEOUT_MS: "8000",
    // This script checks steering, not permissions. The Ask mode would let a
    // shell command interrupt the turn with a permission request, which is a
    // different path (covered by scripts/e2e-mcode.mjs).
    HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "bypassPermissions",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let daemonOutput = "";
daemon.stdout.on("data", (chunk) => {
  daemonOutput += chunk.toString();
});
daemon.stderr.on("data", (chunk) => {
  daemonOutput += chunk.toString();
});

const evidence = {
  startedAt: new Date().toISOString(),
  entry,
  workspace,
  steer: {},
  followUp: {},
};

let client = null;
let spawnedWorkerId = null;
try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const candidate = new SupervisorClient({ stateDir, autoStart: false });
    try {
      await candidate.connect();
      client = candidate;
      break;
    } catch {
      candidate.close();
      await sleep(150);
    }
  }
  if (!client) fail(`Daemon did not become ready:\n${daemonOutput}`);
  console.log("daemon ready");

  const worker = await client.request(
    "spawn",
    {
      runtime: "mcode",
      cwd: workspace,
      prompt:
        "Use the shell to run `ping -n 12 127.0.0.1 > nul` in the current directory (about 11 seconds), then reply DONE. Do not use any other tool.",
      name: "mcode-steer-e2e",
    },
    { timeoutMs: 120_000 },
  );
  console.log(`spawned worker ${worker.id} (pid=${worker.pid})`);
  spawnedWorkerId = worker.id;

  // Wait until the agent has actually started a tool call. That is the point
  // where the ACP turn is admitted, which is what steering requires.
  let cursor = 0;
  let toolStarted = false;
  const steerDeadline = Date.now() + 180_000;
  while (!toolStarted && Date.now() < steerDeadline) {
    const events = await client.request("events", {
      workerId: worker.id,
      sinceSeq: cursor,
      limit: 500,
    });
    cursor = events.nextSeq;
    for (const data of progressEvents(events.events)) {
      if (data.kind === "tool_start") toolStarted = true;
    }
    if (toolStarted) break;

    const status = await client.request("status", { workerId: worker.id });
    if (status.worker?.status === "completed" || status.worker?.status === "failed") {
      fail(`The turn ended before a tool call started: ${status.worker.status}`);
    }
    await sleep(200);
  }
  if (!toolStarted) fail("The agent never started a tool call, so the turn was never active");
  console.log("tool call observed, the turn is active");

  const steer = await client.request(
    "send",
    {
      workerId: worker.id,
      message: `Stop the current command and reply with exactly: ${STEER_MARKER}`,
      mode: "steer",
    },
    { timeoutMs: 60_000 },
  );
  console.log(`steer accepted by the supervisor: ${steer.status}`);

  const followUp = await client.request(
    "send",
    {
      workerId: worker.id,
      message: `After the current turn, reply with exactly: ${FOLLOWUP_MARKER}`,
      mode: "follow-up",
    },
    { timeoutMs: 60_000 },
  );
  console.log(`follow-up accepted by the supervisor: ${followUp.status}`);

  const final = await waitForTerminal(client, worker.id, 300_000);
  const finalText = final.worker.result?.text ?? "";
  console.log(`final status=${final.worker.status} text=${JSON.stringify(finalText)}`);

  const all = await fetchAllEvents(client, worker.id);
  const progress = progressEvents(all);
  const steerEvents = progress.filter((data) => data.kind === "steer_accepted");
  const followUpEvents = progress.filter((data) => data.kind === "followup_queued");
  const messages = progress
    .filter((data) => data.kind === "assistant_message")
    .map((data) => String(data.preview ?? ""))
    .join(" ");

  evidence.steer = {
    workerId: worker.id,
    agentMode: steerEvents.at(-1)?.detail ?? null,
    agentTurnId: steerEvents.at(-1)?.preview ?? null,
    finalStatus: final.worker.status,
    finalText,
    error: final.worker.error ?? null,
    actedOnSteer: messages.includes(STEER_MARKER) || finalText.includes(STEER_MARKER),
    agentMessages: messages.slice(0, 2000),
  };
  evidence.followUp = {
    agentStatus: followUpEvents.at(-1)?.detail ?? null,
    itemId: followUpEvents.at(-1)?.preview ?? null,
  };
  evidence.permissionAnswers = 0;
  evidence.eventCounts = countEventTypes(all);
  evidence.finishedAt = new Date().toISOString();

  if (final.worker.status !== "completed") {
    fail(
      `The run ended with status=${final.worker.status}: ${final.worker.error ?? "no error"}` +
        `\nevents: ${JSON.stringify(evidence.eventCounts)}`,
    );
  }
  if (steerEvents.length === 0) fail("The agent never reported a steering receipt");
  if (evidence.steer.agentMode !== "steered") {
    fail(`The agent did not join the running turn: mode=${evidence.steer.agentMode}`);
  }
  if (followUpEvents.length === 0) fail("The agent never reported a queue receipt");
  if (!evidence.steer.actedOnSteer) {
    fail(`The agent did not act on the steering message: ${JSON.stringify(finalText)}`);
  }

  evidence.result = "passed";
  console.log("STEER E2E PASSED");
} catch (error) {
  evidence.finishedAt = new Date().toISOString();
  evidence.result = "failed";
  evidence.error = clean(error instanceof Error ? error.message : String(error));
  // Keep the diagnosis: what the worker ended with and which events it saw.
  if (client && spawnedWorkerId) {
    try {
      const status = await client.request("status", { workerId: spawnedWorkerId });
      evidence.workerStatus = status.worker?.status ?? null;
      evidence.workerError = clean(status.worker?.error ?? "");
      const all = await fetchAllEvents(client, spawnedWorkerId);
      evidence.eventCounts = countEventTypes(all);
      evidence.eventData = all
        .filter((event) => event.type !== "run.progress")
        .map((event) => ({ type: event.type, data: event.data }));
      evidence.progressKinds = all
        .filter((event) => event.type === "run.progress")
        .map((event) => event.data?.kind);
    } catch (diagnosticError) {
      evidence.diagnosticError = clean(
        diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
      );
    }
  }
  console.error(`STEER E2E FAILED: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  try {
    client?.close();
  } catch {
    // Ignore.
  }
  daemon.kill();
  await sleep(300);
  if (daemon.exitCode === null) {
    try {
      process.kill(daemon.pid, "SIGKILL");
    } catch {
      // Ignore.
    }
  }
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    path.join(evidenceDir, "mcode-steer-e2e.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  ).catch(() => undefined);
}
