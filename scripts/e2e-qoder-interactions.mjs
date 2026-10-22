#!/usr/bin/env node
/**
 * Real Qoder CLI interaction E2E: tool use, permission approval/deny,
 * steer, follow-up, cancel-with-queue-cleanup, multi-turn result and
 * (best effort) AskUserQuestion.
 *
 * Requires an existing `qodercli login` state and a LOW-COST model:
 *   QODER_REAL=1 QODER_REAL_MODEL=DeepSeek-Flash npm run e2e:qoder:interactions
 *
 * Every scenario uses a fresh, isolated state directory; the shared production
 * daemon and the user's Qoder sessions are never touched. Evidence is written to
 * evidence/qoder-interactions (redacted).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorClient } from "../dist/src/ipc/client.js";
import { sleep } from "../dist/src/util/async.js";
import { redactText } from "../dist/src/util/redact.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(root, "dist", "src", "daemon-entry.js");
const evidenceDir = process.env.QODER_EVIDENCE_DIR
  ? path.resolve(process.env.QODER_EVIDENCE_DIR)
  : path.join(root, "evidence", "qoder-interactions");
const workDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-e2e-"));

const logLines = [];
function log(line) {
  const text = `${new Date().toISOString()} ${clean(line)}`;
  logLines.push(text);
  console.log(text);
}
function clean(text) {
  return redactText(String(text ?? ""))
    .replace(/C--Users-Lenovo/g, "%USERPROFILE-ENCODED%")
    .replace(/C:\\\\Users\\\\Lenovo/g, "%USERPROFILE%")
    .replace(/C:\\Users\\Lenovo/g, "%USERPROFILE%")
    .replace(/C:\/Users\/Lenovo/g, "%USERPROFILE%");
}

const HOST_INJECTED = [
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_VERSION",
  "QODER_SDK_AUTH_PAYLOAD_FILE",
  "QODER_WORKER_CWD",
  "QODER_WORKER_RUNTIME_ASSET_ROOT",
  "QODERCN_SESSION_TYPE",
];
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of HOST_INJECTED) delete env[key];
  return env;
}

function skip(message, code = 0) {
  console.log(clean(message));
  process.exit(code);
}

if (process.env.QODER_REAL !== "1") {
  skip("Skipped. Set QODER_REAL=1 and QODER_REAL_MODEL=<low-cost model> to run the real Qoder interaction E2E.");
}
const model = process.env.QODER_REAL_MODEL?.trim();
if (!model) {
  skip("QODER_REAL_MODEL is required (pick a low-cost model from `qodercli --list-models`).", 2);
}

const version = spawnSync("qodercli", ["--version"], {
  encoding: "utf8",
  env: childEnv(),
  windowsHide: true,
  timeout: 30_000,
});
if (version.error || version.status !== 0) {
  skip(`Could not run qodercli: ${version.error?.message ?? version.stderr ?? "unknown"}`, 2);
}
const cliVersion = String(version.stdout ?? "").trim();
log(`qodercli ${cliVersion}, model ${model}`);

class Daemon {
  constructor(permissionMode) {
    this.permissionMode = permissionMode;
    this.stateDir = path.join(workDir, `state-${permissionMode}`);
    this.child = null;
    this.client = null;
  }

  async start() {
    const env = childEnv({
      HARNESS_SUPERVISOR_HOME: this.stateDir,
      HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: this.permissionMode,
      HARNESS_SUPERVISOR_ABORT_TIMEOUT_MS: "8000",
      HARNESS_SUPERVISOR_CLOSE_GRACE_MS: "800",
    });
    this.child = spawn(process.execPath, [daemonEntry, "--state-dir", this.stateDir], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk) => log(`daemon[${this.permissionMode}] ${chunk}`.trim()));
    this.child.stderr.on("data", (chunk) => log(`daemon[${this.permissionMode}] ${chunk}`.trim()));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const client = new SupervisorClient({ stateDir: this.stateDir, autoStart: false });
      try {
        await client.connect();
        this.client = client;
        return client;
      } catch {
        client.close();
        await sleep(100);
      }
    }
    throw new Error(`daemon[${this.permissionMode}] did not become ready`);
  }

  async stop() {
    try {
      await this.client?.shutdown();
    } catch {
      // Best effort.
    }
    this.client?.close();
  }
}

async function spawnWorker(client, prompt, extra = {}) {
  return client.request(
    "spawn",
    {
      runtime: "qoder",
      cwd: workDir,
      prompt,
      model,
      permissionMode: undefined,
      ...extra,
    },
    { timeoutMs: 120_000 },
  );
}

async function status(client, workerId) {
  const result = await client.request("status", { workerId, recentEvents: 100 });
  return result;
}

async function events(client, workerId) {
  const result = await client.request("events", { workerId, sinceSeq: 0, limit: 500 });
  return result.events;
}

async function waitTerminal(client, workerId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    const result = await client.request(
      "wait",
      { workerId, sinceSeq: cursor, timeoutMs: 20_000, until: "terminal" },
      { timeoutMs: 30_000 },
    );
    cursor = result.nextSeq;
    if (result.terminal) return result;
  }
  throw new Error(`worker ${workerId} did not reach a terminal state`);
}

async function waitEvent(client, workerId, types, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    const result = await client.request(
      "wait",
      { workerId, sinceSeq: cursor, timeoutMs: 10_000, until: "event", types },
      { timeoutMs: 20_000 },
    );
    cursor = result.nextSeq;
    const match = result.events.find((event) => types.includes(event.type));
    if (match) return { status: result.worker, event: match };
    if (result.terminal) return null;
  }
  return null;
}

const summary = {
  cliVersion,
  model,
  startedAt: new Date().toISOString(),
  scenarios: [],
  unverified: [],
};

function record(name, data) {
  summary.scenarios.push({ name, at: new Date().toISOString(), ...data });
}

async function runAutoScenarios(client) {
  // 1. Real tool call under permission mode "auto".
  {
    const worker = await spawnWorker(
      client,
      'Run this exact shell command once: echo HS_QODER_TOOL_OK  Then reply with the command output and nothing else.',
    );
    await waitTerminal(client, worker.id);
    const final = await status(client, worker.id);
    const evts = await events(client, worker.id);
    const toolStarts = evts.filter(
      (event) => event.type === "run.progress" && event.data?.kind === "tool_start",
    );
    record("tool-call-auto", {
      workerId: worker.id,
      status: final.worker.status,
      result: final.worker.result?.text?.slice(0, 300),
      toolStarts: toolStarts.length,
      tools: toolStarts.map((event) => event.data?.tool),
      reflected: Boolean(final.worker.result?.text?.includes("HS_QODER_TOOL_OK")),
    });
    log(`tool-call-auto: ${final.worker.status}, tools=${toolStarts.length}`);
  }

  // 2. Steer while running.
  {
    const worker = await spawnWorker(
      client,
      "Write a numbered list of 10 short facts about the ocean, then stop.",
    );
    await waitEvent(client, worker.id, ["run.started"], 60_000);
    await sleep(1_500);
    await client.request("send", {
      workerId: worker.id,
      message: "Also include the exact token STEER_SEEN in your answer.",
      mode: "steer",
    });
    const final = await waitTerminal(client, worker.id);
    const result = final.worker.result?.text ?? "";
    const evts = await events(client, worker.id);
    record("steer", {
      workerId: worker.id,
      status: final.worker.status,
      messageSent: evts.some((event) => event.type === "run.message_sent" && event.data?.mode === "steer"),
      reflected: result.includes("STEER_SEEN"),
      result: result.slice(0, 300),
    });
    log(`steer: ${final.worker.status}, reflected=${result.includes("STEER_SEEN")}`);
  }

  // 3. Follow-up runs a second turn after the current one.
  {
    const worker = await spawnWorker(
      client,
      "Write 5 short sentences about mountains, then stop.",
    );
    await waitEvent(client, worker.id, ["run.started"], 60_000);
    await sleep(1_000);
    await client.request("send", {
      workerId: worker.id,
      message: "After you finish, reply with exactly FOLLOWUP_SEEN and nothing else.",
      mode: "follow-up",
    });
    const final = await waitTerminal(client, worker.id, 240_000);
    const result = final.worker.result?.text ?? "";
    const evts = await events(client, worker.id);
    record("follow-up", {
      workerId: worker.id,
      status: final.worker.status,
      messageSent: evts.some(
        (event) => event.type === "run.message_sent" && event.data?.mode === "follow-up",
      ),
      extraTurns: evts.filter((event) => event.type === "run.started").length,
      reflected: result.includes("FOLLOWUP_SEEN"),
      result: result.slice(0, 300),
    });
    log(`follow-up: ${final.worker.status}, reflected=${result.includes("FOLLOWUP_SEEN")}`);
  }

  // 4. Cancel while a follow-up is queued: the queued message must not run.
  {
    const worker = await spawnWorker(
      client,
      "Write a very long detailed essay (at least 800 words) about the history of navigation.",
    );
    await waitEvent(client, worker.id, ["run.started"], 60_000);
    await sleep(1_500);
    await client.request("send", {
      workerId: worker.id,
      message: "Reply with exactly QUEUED_SHOULD_NOT_RUN.",
      mode: "follow-up",
    });
    const cancelled = await client.request(
      "cancel",
      { workerId: worker.id, timeoutMs: 15_000 },
      { timeoutMs: 40_000 },
    );
    await sleep(1_500);
    const evts = await events(client, worker.id);
    const text = JSON.stringify(evts);
    record("cancel-with-queued-follow-up", {
      workerId: worker.id,
      status: cancelled.status,
      queuedFollowUpRecorded: evts.some(
        (event) => event.type === "run.message_sent" && event.data?.mode === "follow-up",
      ),
      queuedTextNeverRan: !text.includes("QUEUED_SHOULD_NOT_RUN") || !evts.some(
        (event) =>
          event.type === "run.progress" &&
          typeof event.data?.preview === "string" &&
          event.data.preview.includes("QUEUED_SHOULD_NOT_RUN"),
      ),
      processAlive: cancelled.pidAlive,
    });
    log(`cancel: ${cancelled.status}, pidAlive=${cancelled.pidAlive}`);
  }
}

async function runPermissionScenarios(client) {
  // 5. Permission approval: allow.
  {
    const worker = await spawnWorker(
      client,
      'Use the shell to run: echo HS_QODER_APPROVAL_OK  Then report the exact output.',
    );
    const asked = await waitEvent(client, worker.id, ["run.needs_input"], 120_000);
    if (!asked) {
      summary.unverified.push("permission-allow: no can_use_tool request was observed");
      log("permission-allow: no request observed");
      await client.request("cancel", { workerId: worker.id, timeoutMs: 10_000 }).catch(() => undefined);
    } else {
      const pending = asked.status.pendingInput;
      const options = pending?.options ?? [];
      await client.request("answer", {
        workerId: worker.id,
        requestId: pending.requestId,
        response: options.includes("allow") ? { value: "allow" } : { confirmed: true },
      });
      const final = await waitTerminal(client, worker.id, 180_000);
      const result = final.worker.result?.text ?? "";
      record("permission-allow", {
        workerId: worker.id,
        requestedTool: pending?.title,
        options,
        status: final.worker.status,
        reflected: result.includes("HS_QODER_APPROVAL_OK"),
        result: result.slice(0, 300),
      });
      log(`permission-allow: ${final.worker.status}, reflected=${result.includes("HS_QODER_APPROVAL_OK")}`);
    }
  }

  // 6. Permission deny: the tool must not execute.
  {
    const worker = await spawnWorker(
      client,
      'Use the shell to run: echo HS_QODER_DENY_MARKER  Then report the exact output.',
    );
    const asked = await waitEvent(client, worker.id, ["run.needs_input"], 120_000);
    if (!asked) {
      summary.unverified.push("permission-deny: no can_use_tool request was observed");
      log("permission-deny: no request observed");
      await client.request("cancel", { workerId: worker.id, timeoutMs: 10_000 }).catch(() => undefined);
    } else {
      const pending = asked.status.pendingInput;
      await client.request("answer", {
        workerId: worker.id,
        requestId: pending.requestId,
        response: { value: "deny" },
      });
      const final = await waitTerminal(client, worker.id, 180_000);
      const result = final.worker.result?.text ?? "";
      record("permission-deny", {
        workerId: worker.id,
        requestedTool: pending?.title,
        status: final.worker.status,
        markerAbsent: !result.includes("HS_QODER_DENY_MARKER"),
        result: result.slice(0, 300),
      });
      log(`permission-deny: ${final.worker.status}, markerAbsent=${!result.includes("HS_QODER_DENY_MARKER")}`);
    }
  }

  // 7. AskUserQuestion (best effort; the model may decline to ask).
  {
    const worker = await spawnWorker(
      client,
      'Before answering, you must call the AskUserQuestion tool and ask which colour I prefer: "red" or "blue". Then reply with that colour only.',
    );
    const asked = await waitEvent(client, worker.id, ["run.needs_input"], 120_000);
    if (!asked) {
      summary.unverified.push("ask-user-question: the model did not emit AskUserQuestion");
      log("ask-user-question: not observed");
      await client.request("cancel", { workerId: worker.id, timeoutMs: 10_000 }).catch(() => undefined);
    } else {
      const pending = asked.status.pendingInput;
      const choice = pending?.options?.find((option) => /blue/i.test(option)) ?? "blue";
      await client.request("answer", {
        workerId: worker.id,
        requestId: pending.requestId,
        response: { value: choice },
      });
      const final = await waitTerminal(client, worker.id, 180_000);
      record("ask-user-question", {
        workerId: worker.id,
        title: pending?.title,
        options: pending?.options,
        chosen: choice,
        status: final.worker.status,
        reflected: /blue/i.test(final.worker.result?.text ?? ""),
        result: (final.worker.result?.text ?? "").slice(0, 300),
      });
      log(`ask-user-question: ${final.worker.status}, reflected=${/blue/i.test(final.worker.result?.text ?? "")}`);
    }
  }
}

const auto = new Daemon("auto");
const ask = new Daemon("default");
try {
  const autoClient = await auto.start();
  await runAutoScenarios(autoClient);
  await auto.stop();
  const askClient = await ask.start();
  await runPermissionScenarios(askClient);
  await ask.stop();
} catch (error) {
  summary.error = clean(error?.stack ?? error?.message ?? String(error));
  log(`ERROR ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await auto.stop().catch(() => undefined);
  await ask.stop().catch(() => undefined);
  summary.finishedAt = new Date().toISOString();
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(evidenceDir, "run.log"), `${logLines.join("\n")}\n`, "utf8");
  log(`evidence ${evidenceDir}`);
}