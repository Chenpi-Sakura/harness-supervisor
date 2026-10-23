#!/usr/bin/env node
/**
 * Real MiniMax Code E2E over ACP.
 *
 * It starts a real supervisor daemon, spawns a real `mcode acp` worker through
 * the new MiniMax Code adapter, waits for the turn to finish, and then resumes
 * the same session. The prompt is text-only and asks for a fixed reply, so no
 * tool call and no permission prompt is involved.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

async function waitForStatus(client, workerId, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.request("status", { workerId });
    if (wanted.includes(status.worker?.status)) return status.worker;
    await sleep(200);
  }
  fail(`Worker ${workerId} did not reach ${wanted.join("/")} within ${timeoutMs}ms`);
  return null;
}

async function waitForAwaitingInput(client, workerId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.request("status", { workerId, recentEvents: 20 });
    if (status.worker?.pendingInput) return status.worker;
    if (status.worker?.status === "completed" || status.worker?.status === "failed") {
      return status.worker;
    }
    await sleep(200);
  }
  fail(`Worker ${workerId} did not request input within ${timeoutMs}ms`);
  return null;
}

const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-e2e-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "hs-mcode-e2e-work-"));
const entry = resolveMcodeEntry();
await writeFile(
  path.join(workspace, "README.md"),
  "# mcode e2e\n\nA tiny workspace used by the Harness Supervisor MiniMax Code E2E.\n",
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
  runs: [],
};

let client = null;
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

  const info = await client.request("info", {});
  const mcodeRuntime = (info.runtimes ?? []).find((item) => item.runtime === "mcode");
  if (!mcodeRuntime) fail("The mcode runtime is not advertised by the daemon.");
  console.log(`mcode runtime advertised: steer=${mcodeRuntime.steer} resume=${mcodeRuntime.resume}`);

  const worker = await client.request(
    "spawn",
    {
      runtime: "mcode",
      cwd: workspace,
      prompt: "Reply with exactly: MCODE_E2E_OK",
      name: "mcode-e2e",
    },
    { timeoutMs: 120_000 },
  );
  console.log(`spawned worker ${worker.id} (pid=${worker.pid})`);

  const first = await waitForTerminal(client, worker.id, 240_000);
  const firstSummary = first.worker;
  const firstText = firstSummary.result?.text ?? "";
  console.log(`first run: status=${firstSummary.status} text=${JSON.stringify(firstText)}`);
  if (firstSummary.status !== "completed") {
    fail(`First run ended with status=${firstSummary.status}: ${firstSummary.error ?? "no error"}`);
  }
  if (!firstText.includes("MCODE_E2E_OK")) {
    fail(`First run did not return the expected marker: ${JSON.stringify(firstText)}`);
  }
  if (!firstSummary.sessionId) fail("The run did not record an ACP session id.");
  if (!firstSummary.sessionFile || !existsSync(firstSummary.sessionFile)) {
    fail("The run did not record a readable session handle file.");
  }
  const handle = JSON.parse(await readFile(firstSummary.sessionFile, "utf8"));

  const events = await client.request("events", { workerId: worker.id, sinceSeq: 0, limit: 500 });
  const eventTypes = events.events.map((event) => event.type);

  evidence.runs.push({
    phase: "first",
    workerId: worker.id,
    status: firstSummary.status,
    resultText: firstText,
    sessionId: firstSummary.sessionId,
    sessionFile: firstSummary.sessionFile,
    sessionHandle: handle,
    eventTypes,
  });

  const resumed = await client.request(
    "resume",
    { workerId: worker.id, prompt: "Reply with exactly: MCODE_E2E_RESUMED" },
    { timeoutMs: 120_000 },
  );
  console.log(`resume accepted for worker ${resumed.id}`);

  const second = await waitForTerminal(client, worker.id, 240_000);
  const secondText = second.worker.result?.text ?? "";
  console.log(`resumed run: status=${second.worker.status} text=${JSON.stringify(secondText)}`);
  if (second.worker.status !== "completed") {
    fail(`Resumed run ended with status=${second.worker.status}: ${second.worker.error ?? "no error"}`);
  }
  if (!secondText.includes("MCODE_E2E_RESUMED")) {
    fail(`Resumed run did not return the expected marker: ${JSON.stringify(secondText)}`);
  }

  const resumedEvents = await client.request("events", {
    workerId: worker.id,
    sinceSeq: 0,
    limit: 500,
  });
  evidence.runs.push({
    phase: "resumed",
    workerId: worker.id,
    status: second.worker.status,
    resultText: secondText,
    eventTypes: resumedEvents.events.map((event) => event.type),
  });

  // Real permission round-trip: MiniMax Code defaults to bypassPermissions, so
  // the session must be switched to the "Ask" mode before a command asks for
  // approval. Whether a command asks is decided by the agent runtime's own
  // risk classification, so the request is not guaranteed to appear; the
  // outcome is recorded either way.
  const permissionWorker = await client.request(
    "spawn",
    {
      runtime: "mcode",
      cwd: workspace,
      prompt:
        "Use the shell to run `echo hs-mcode-permission > permission-probe.txt` in the current directory, then verify the file exists and show its contents with `Get-Content permission-probe.txt`. Do not use any other tool.",
      name: "mcode-e2e-permission",
    },
    { timeoutMs: 120_000 },
  );
  const awaiting = await waitForAwaitingInput(client, permissionWorker.id, 240_000);
  console.log(`permission requested: ${awaiting.pendingInput?.title ?? "none"}`);
  console.log(`permission options : ${JSON.stringify(awaiting.pendingInput?.options ?? [])}`);

  let permissionOutcome = "not_requested";
  if (awaiting.pendingInput) {
    const allowOption = (awaiting.pendingInput.options ?? []).find((option) =>
      /allow/i.test(option),
    );
    await client.request(
      "answer",
      {
        workerId: permissionWorker.id,
        requestId: awaiting.pendingInput.requestId,
        response: { value: allowOption ?? "allow" },
      },
      { timeoutMs: 60_000 },
    );
    const permissionFinal = await waitForTerminal(client, permissionWorker.id, 240_000);
    permissionOutcome = permissionFinal.worker.status;
    console.log(`permission run: status=${permissionOutcome}`);
  } else {
    console.log(
      "permission round-trip: NOT TRIGGERED — the agent runtime did not ask for approval on its own",
    );
  }

  evidence.permission = {
    workerId: permissionWorker.id,
    options: awaiting.pendingInput?.options ?? [],
    title: awaiting.pendingInput?.title,
    outcome: permissionOutcome,
  };

  // Real cancellation: a turn that runs long enough to be cancelled. The
  // agent is asked to run a long ping, the worker is cancelled while the turn
  // is alive, and the run has to end in the cancelled state.
  const cancelWorker = await client.request(
    "spawn",
    {
      runtime: "mcode",
      cwd: workspace,
      prompt:
        "Use the shell to run `ping -n 30 127.0.0.1 > nul` in the current directory (about 29 seconds), then reply DONE. Do not use any other tool.",
      name: "mcode-e2e-cancel",
    },
    { timeoutMs: 120_000 },
  );
  const cancelRunning = await waitForStatus(client, cancelWorker.id, ["running"], 60_000);
  console.log(`cancel worker is running: ${cancelRunning.status}`);

  const cancelled = await client.request(
    "cancel",
    { workerId: cancelWorker.id, timeoutMs: 15_000 },
    { timeoutMs: 60_000 },
  );
  console.log(`cancel accepted: status=${cancelled.status}`);

  const cancelFinal = await waitForTerminal(client, cancelWorker.id, 60_000);
  console.log(`cancelled run: status=${cancelFinal.worker.status}`);
  const cancelEvents = await client.request("events", {
    workerId: cancelWorker.id,
    sinceSeq: 0,
    limit: 500,
  });
  evidence.cancel = {
    workerId: cancelWorker.id,
    status: cancelFinal.worker.status,
    eventTypes: cancelEvents.events.map((event) => event.type),
  };
  if (cancelFinal.worker.status !== "cancelled") {
    fail(`The cancelled run ended with status=${cancelFinal.worker.status}`);
  }

  evidence.finishedAt = new Date().toISOString();
  evidence.result = "passed";
  console.log("E2E PASSED");
} catch (error) {
  evidence.finishedAt = new Date().toISOString();
  evidence.result = "failed";
  evidence.error = clean(error instanceof Error ? error.message : String(error));
  console.error(`E2E FAILED: ${evidence.error}`);
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
    path.join(evidenceDir, "mcode-e2e.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  ).catch(() => undefined);
}
