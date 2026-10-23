#!/usr/bin/env node
/**
 * Real MiniMax Code long-turn E2E over ACP.
 *
 * The 0.4.0 adapter reused the 120s control-RPC deadline for `session/prompt`,
 * so a real turn that ran longer than that was reported as a failed run even
 * though the agent was still working. The stub-based regression in
 * test/unit/mcode-acp-session.test.ts protects the code path; this script
 * protects the real runtime: it drives a turn that must last longer than the
 * old deadline and checks that the run still completes with its final report.
 *
 * The script uses its own daemon and its own state directory, so it never
 * touches the production daemon or an existing worker.
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

/** The old control-RPC deadline. A correct run must cross it. */
const OLD_CONTROL_DEADLINE_MS = 120_000;
/** The turn must clearly outlast the old deadline, otherwise it proves nothing. */
const MIN_TURN_MS = 135_000;
/** How long the whole turn may take before the run is considered stuck. */
const TURN_BUDGET_MS = 420_000;
const MARKER = "MCODE_LONG_TURN_OK";

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

const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-long-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-long-work-"));
const entry = resolveMcodeEntry();

console.log(`state dir : ${stateDir}`);
console.log(`workspace : ${workspace}`);
console.log(`mcode     : ${entry}`);

const daemon = spawn(process.execPath, [daemonEntry, "--state-dir", stateDir], {
  env: {
    ...process.env,
    HARNESS_SUPERVISOR_HOME: stateDir,
    HARNESS_SUPERVISOR_MCODE_ENTRY: entry,
    HARNESS_SUPERVISOR_ABORT_TIMEOUT_MS: "8000",
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
  oldControlDeadlineMs: OLD_CONTROL_DEADLINE_MS,
  minTurnMs: MIN_TURN_MS,
  permissions: [],
};

let client = null;
let workerId;
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
        `Use the shell to run \`ping -n 150 127.0.0.1 > nul\` in the current directory (about 149 seconds), then reply with exactly ${MARKER}. Do not use any other tool.`,
      name: "mcode-long-turn",
      maxDurationMs: TURN_BUDGET_MS,
    },
    { timeoutMs: 120_000 },
  );
  workerId = worker.id;
  console.log(`spawned worker ${worker.id} (pid=${worker.pid})`);

  const startedAt = Date.now();
  const answered = new Set();
  let final = null;

  // Poll while the turn runs: answer a native permission request if the agent
  // asks for one, and stop as soon as the worker reaches a terminal state.
  while (Date.now() - startedAt < TURN_BUDGET_MS) {
    const status = await client.request("status", { workerId: worker.id, recentEvents: 20 });
    const pending = status.worker?.pendingInput;
    if (pending && !answered.has(pending.requestId)) {
      answered.add(pending.requestId);
      const options = pending.options ?? [];
      const allowOption = options.find((option) => /allow/i.test(option));
      evidence.permissions.push({
        requestId: pending.requestId,
        title: clean(pending.title ?? ""),
        options,
        answeredWith: allowOption ?? "allow",
      });
      console.log(`permission requested: ${clean(pending.title ?? "")}`);
      console.log(`permission options : ${JSON.stringify(options)}`);
      await client.request(
        "answer",
        {
          workerId: worker.id,
          requestId: pending.requestId,
          response: { value: allowOption ?? "allow" },
        },
        { timeoutMs: 60_000 },
      );
      console.log(`permission answered: ${allowOption ?? "allow"}`);
    }
    if (["completed", "failed", "cancelled"].includes(status.worker?.status ?? "")) {
      final = status.worker;
      break;
    }
    await sleep(500);
  }

  if (!final) {
    const status = await client.request("status", { workerId: worker.id, recentEvents: 20 });
    final = status.worker;
  }
  const durationMs = Date.now() - startedAt;
  const text = final.result?.text ?? "";
  console.log(`turn finished: status=${final.status} duration=${durationMs}ms`);
  console.log(`result text  : ${JSON.stringify(clean(text))}`);

  const events = await client.request("events", { workerId: worker.id, sinceSeq: 0, limit: 500 });
  const eventTypes = events.events.map((event) => event.type);
  const errorEvents = events.events
    .filter((event) => event.type === "run.error" || event.type === "run.failed")
    .map((event) => ({ type: event.type, data: event.data }));

  evidence.run = {
    workerId: worker.id,
    status: final.status,
    durationMs,
    resultText: clean(text),
    eventTypes,
    errorEvents,
    permissions: evidence.permissions.length,
  };
  evidence.finishedAt = new Date().toISOString();

  if (final.status !== "completed") {
    evidence.result = "failed";
    fail(`The long turn ended with status=${final.status}: ${final.error ?? "no error"}`);
  }
  if (!text.includes(MARKER)) {
    evidence.result = "failed";
    fail(`The long turn did not return the expected marker: ${JSON.stringify(clean(text))}`);
  }
  if (durationMs < MIN_TURN_MS) {
    evidence.result = "failed";
    fail(
      `The turn only lasted ${durationMs}ms, which does not cross the old ${OLD_CONTROL_DEADLINE_MS}ms deadline; the check proves nothing`,
    );
  }
  if (errorEvents.length > 0) {
    evidence.result = "failed";
    fail(`The long turn reported errors: ${JSON.stringify(errorEvents)}`);
  }

  evidence.result = "passed";
  console.log("LONG TURN E2E PASSED");
} catch (error) {
  evidence.finishedAt = new Date().toISOString();
  evidence.result = "failed";
  evidence.error = clean(error instanceof Error ? error.message : String(error));
  console.error(`LONG TURN E2E FAILED: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  try {
    if (client && workerId) {
      await client.request("cancel", { workerId }, { timeoutMs: 20_000 }).catch(() => undefined);
    }
    await client?.shutdown();
  } catch {
    // Ignore.
  } finally {
    client?.close();
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
    path.join(evidenceDir, "mcode-long-turn-e2e.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  ).catch(() => undefined);
}
