#!/usr/bin/env node
/**
 * Real Qoder 1.1.82 ACP acceptance through the supervisor daemon.
 *
 * Covers: ACP spawn + prompt, resume/session.load, a Write approval surfaced as
 * awaiting_input, an AskUserQuestion surfaced as elicitation, and cancellation.
 * Requires `qodercli login` with the normal ~/.qoder state and a low-cost model.
 */
import { spawn, spawnSync } from "node:child_process";
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
const evidenceDir = process.env.QODER_ACP_EVIDENCE_DIR
  ? path.resolve(process.env.QODER_ACP_EVIDENCE_DIR)
  : path.join(root, "evidence", "qoder-acp-real");

const hostInjected = [
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_VERSION",
  "QODER_SDK_AUTH_PAYLOAD_FILE",
  "QODER_WORKER_CWD",
  "QODER_WORKER_RUNTIME_ASSET_ROOT",
  "QODERCN_SESSION_TYPE",
  // The desktop injects an unauthenticated config root. Real acceptance must
  // use the interactive ~/.qoder login, so these overrides are removed.
  "QODER_CONFIG_DIR",
  "QODERCN_CONFIG_DIR",
];

function childEnv() {
  const env = { ...process.env };
  for (const key of hostInjected) delete env[key];
  return env;
}

function clean(text) {
  return redactText(String(text ?? ""))
    .replace(/C--Users-Lenovo/g, "%USERPROFILE-ENCODED%")
    .replace(/C:\\\\Users\\\\Lenovo/g, "%USERPROFILE%")
    .replace(/C:\\Users\\Lenovo/g, "%USERPROFILE%")
    .replace(/C:\/Users\/Lenovo/g, "%USERPROFILE%");
}

function fail(message) {
  throw new Error(String(message));
}

function skip(message, code = 0) {
  console.log(clean(message));
  process.exit(code);
}

if (process.env.QODER_REAL !== "1") {
  skip("Skipped real Qoder ACP E2E. Set QODER_REAL=1 and QODER_REAL_MODEL=<low-cost model>.");
}

const model = process.env.QODER_REAL_MODEL?.trim();
if (!model) {
  skip("QODER_REAL_MODEL is required so the test does not call an expensive default model.", 2);
}

const env = childEnv();
const version = spawnSync("qodercli", ["--version"], {
  encoding: "utf8",
  env,
  windowsHide: true,
  timeout: 30_000,
});
if (version.error || version.status !== 0) {
  skip(
    `Could not run qodercli: ${version.error?.message ?? version.stderr ?? "unknown error"}.`,
    2,
  );
}
const cliVersion = String(version.stdout ?? "").trim() || "unknown";

const models = spawnSync("qodercli", ["--list-models"], {
  encoding: "utf8",
  env,
  windowsHide: true,
  timeout: 60_000,
});
const modelOutput = `${models.stdout ?? ""}\n${models.stderr ?? ""}`;
if (/not logged in|please run \/login/i.test(modelOutput)) {
  skip(
    [
      "Qoder CLI is not logged in for this OS user.",
      "Run `qodercli login` yourself, then re-run with QODER_REAL=1 and QODER_REAL_MODEL.",
      "The supervisor never reads or prints your credentials.",
    ].join("\n"),
    2,
  );
}
if (models.error || models.status !== 0) {
  skip(`qodercli --list-models failed (exit=${models.status ?? "?"}): ${modelOutput.slice(0, 500)}`, 2);
}

const workDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-acp-real-work-"));
const evidence = {
  ranAt: new Date().toISOString(),
  host: `${os.platform()} ${os.release()} / Node ${process.version}`,
  qodercliVersion: cliVersion,
  model,
  protocol: "acp",
  permissionMode: "default",
  scenarios: {},
  limits: {
    usage:
      "ACP prompt usage in Qoder 1.1.82 is all zeros; absence of run.usage events means unknown, not zero tokens.",
    steering:
      "ACP steer/follow-up are not implemented; capabilities report steer=false and followUp=false.",
  },
};

async function startDaemon(stateDir, extraEnv) {
  const output = { text: "" };
  const child = spawn(process.execPath, [daemonEntry, "--state-dir", stateDir], {
    env: { ...env, HARNESS_SUPERVISOR_HOME: stateDir, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => {
    output.text += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    output.text += chunk.toString("utf8");
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(`Daemon exited before ready (${child.exitCode}).\n${clean(output.text)}`);
    }
    const candidate = new SupervisorClient({ stateDir, autoStart: false });
    try {
      await candidate.connect();
      return { child, client: candidate, output, stateDir };
    } catch {
      candidate.close();
      await sleep(100);
    }
  }
  await killProcess(child);
  fail(`Daemon did not become ready.\n${clean(output.text)}`);
}

async function killProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3000),
  ]);
}

async function stopDaemon(child, client) {
  try {
    if (client) {
      await Promise.race([client.shutdown().catch(() => undefined), sleep(8000)]);
    }
  } finally {
    client?.close();
    await killProcess(child);
  }
}

async function waitTerminal(client, workerId, sinceSeq, timeoutMs) {
  const stop = Date.now() + timeoutMs;
  let cursor = sinceSeq;
  let last = null;
  while (Date.now() < stop) {
    const remaining = Math.max(1000, Math.min(110_000, stop - Date.now()));
    last = await client.request(
      "wait",
      { workerId, sinceSeq: cursor, timeoutMs: remaining, until: "terminal" },
      { timeoutMs: remaining + 10_000 },
    );
    cursor = last.nextSeq;
    if (last.terminal) return last;
  }
  return last;
}

async function waitForStatus(client, workerId, statuses, timeoutMs) {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    const status = await client.request("status", { workerId, recentEvents: 10 }, { timeoutMs: 15_000 });
    if (statuses.includes(status.worker.status)) return status;
    await sleep(250);
  }
  const status = await client.request("status", { workerId, recentEvents: 10 }, { timeoutMs: 15_000 });
  throw new Error(
    `Timed out waiting for ${statuses.join(",")}; current=${status.worker.status}, pendingInput=${Boolean(status.worker.pendingInput)}\n${clean(JSON.stringify(status.worker))}`,
  );
}

async function events(client, workerId, sinceSeq = 0) {
  return client.request(
    "events",
    { workerId, sinceSeq, limit: 500 },
    { timeoutMs: 15_000 },
  );
}

async function answer(client, workerId, requestId, response) {
  await client.request("answer", { workerId, requestId, response }, { timeoutMs: 30_000 });
}

function pickAllowOption(options = []) {
  const exact = options.find((option) => /^(allow|allow once|proceed_once|允许一次)$/i.test(option.trim()));
  if (exact) return exact;
  const once = options.find((option) => /proceed_once|allow once|允许一次/i.test(option));
  if (once) return once;
  const anyAllow = options.find((option) => /allow|允许/i.test(option));
  return anyAllow ?? options[0];
}

const evidenceEvents = [];

function projectEvents(scenario, list) {
  for (const event of list) {
    const data = event.data ?? {};
    const projected = { scenario, seq: event.seq, type: event.type };
    if (event.data) {
      for (const key of ["kind", "tool", "isError", "method", "title", "options", "requestId"]) {
        if (data[key] !== undefined) projected[key] = data[key];
      }
      if (event.type === "run.error" && typeof data.message === "string") {
        projected.message = clean(data.message);
      }
    }
    evidenceEvents.push(projected);
  }
}

function errorCounts(list) {
  return {
    runErrors: list.filter((event) => event.type === "run.error").length,
    fatalErrors: list.filter(
      (event) => event.type === "run.error" && event.data?.fatal === true,
    ).length,
  };
}

let daemon = null;
let client = null;
try {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-acp-real-state-"));
  const started = await startDaemon(stateDir, {
    HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "default",
    HARNESS_SUPERVISOR_QODER_INPUT_TIMEOUT_MS: "300000",
  });
  daemon = started.child;
  client = started.client;

  // 1. Spawn + prompt.
  const firstStartedAt = Date.now();
  const firstWorker = await client.request(
    "spawn",
    {
      runtime: "qoder",
      cwd: workDir,
      model,
      prompt: "请只回复 QODER_ACP_E2E_OK，不要调用任何工具。",
      maxDurationMs: 240_000,
    },
    { timeoutMs: 60_000 },
  );
  const spawnReturnedMs = Date.now() - firstStartedAt;
  const first = await waitTerminal(client, firstWorker.id, 0, 240_000);
  if (first?.worker.status !== "completed") {
    fail(`ACP spawn ended as ${first?.worker.status}: ${first?.worker.error ?? "no error"}`);
  }
  if (!/QODER_ACP_E2E_OK/.test(first.worker.result?.text ?? "")) {
    fail(`ACP spawn result did not contain the token: ${first.worker.result?.text ?? "(empty)"}`);
  }
  if (!first.worker.sessionId) fail("ACP spawn did not report a session id.");
  if (!first.worker.sessionFile?.endsWith("qoder-acp-session.json")) {
    fail(`ACP spawn reported an unexpected session file: ${first.worker.sessionFile}`);
  }
  if (!first.worker.sessionFile || !existsSync(first.worker.sessionFile)) {
    fail("ACP session handle file does not exist; resume cannot be verified.");
  }
  const firstEvents = await events(client, firstWorker.id, 0);
  const firstCursor = firstEvents.nextSeq;
  const firstPid = first.worker.pid ?? null;
  evidence.scenarios.spawn = {
    workerId: firstWorker.id,
    spawnReturnedMs,
    status: first.worker.status,
    result: first.worker.result?.text,
    sessionId: first.worker.sessionId,
    sessionFile: clean(first.worker.sessionFile),
    capabilities: first.worker.capabilities,
    pid: firstPid,
    usageEvents: firstEvents.events.filter((event) => event.type === "run.usage").length,
    ...errorCounts(firstEvents.events),
  };
  projectEvents("spawn", firstEvents.events);

  // 2. Resume through session/load.
  await client.request(
    "resume",
    {
      workerId: firstWorker.id,
      model,
      prompt: "请只回复 QODER_ACP_RESUME_OK，不要调用任何工具。",
      maxDurationMs: 240_000,
    },
    { timeoutMs: 60_000 },
  );
  const resumed = await waitTerminal(client, firstWorker.id, firstCursor, 240_000);
  if (resumed?.worker.status !== "completed") {
    fail(`ACP resume ended as ${resumed?.worker.status}: ${resumed?.worker.error ?? "no error"}`);
  }
  if (!/QODER_ACP_RESUME_OK/.test(resumed.worker.result?.text ?? "")) {
    fail(`ACP resume result did not contain the token: ${resumed.worker.result?.text ?? "(empty)"}`);
  }
  if (resumed.worker.sessionId !== first.worker.sessionId) {
    fail(`ACP resume changed the session id (${first.worker.sessionId} -> ${resumed.worker.sessionId ?? "none"}).`);
  }
  if (resumed.worker.sessionFile !== first.worker.sessionFile) {
    fail("ACP resume changed the session handle path.");
  }
  if (resumed.worker.resumeCount !== 1) {
    fail(`Expected resumeCount=1, got ${resumed.worker.resumeCount}.`);
  }
  const resumedEvents = await events(client, firstWorker.id, firstCursor);
  evidence.scenarios.resume = {
    status: resumed.worker.status,
    result: resumed.worker.result?.text,
    resumeCount: resumed.worker.resumeCount,
    sameSessionId: true,
    sameSessionFile: true,
    usageEvents: resumedEvents.events.filter((event) => event.type === "run.usage").length,
    ...errorCounts(resumedEvents.events),
  };
  projectEvents("resume", resumedEvents.events);

  // 3. Write approval.
  const writeWorker = await client.request(
    "spawn",
    {
      runtime: "qoder",
      cwd: workDir,
      model,
      prompt:
        "请在当前目录创建文件 acp-write-ok.txt，文件内容必须只有一行 ACP_WRITE_OK。完成后只回复 WRITE_DONE，不要修改其他文件。",
      maxDurationMs: 300_000,
    },
    { timeoutMs: 60_000 },
  );
  const writePending = await waitForStatus(client, writeWorker.id, ["awaiting_input"], 180_000);
  const writeInput = writePending.worker.pendingInput;
  if (!writeInput) fail("Write approval reported awaiting_input without pendingInput.");
  if (!Array.isArray(writeInput.options) || writeInput.options.length === 0) {
    fail(`Write approval exposed no options: ${clean(JSON.stringify(writeInput))}`);
  }
  const allowOption = pickAllowOption(writeInput.options);
  await answer(client, writeWorker.id, writeInput.requestId, { value: allowOption });
  const writeFinal = await waitTerminal(client, writeWorker.id, 0, 240_000);
  if (writeFinal?.worker.status !== "completed") {
    fail(`Write run ended as ${writeFinal?.worker.status}: ${writeFinal?.worker.error ?? "no error"}`);
  }
  const writtenFile = path.join(workDir, "acp-write-ok.txt");
  const written = existsSync(writtenFile) ? (await readFile(writtenFile, "utf8")).trim() : "";
  if (!written.includes("ACP_WRITE_OK")) {
    fail(`The approved Write did not create the expected file content: ${JSON.stringify(written)}`);
  }
  const writeEvents = await events(client, writeWorker.id, 0);
  evidence.scenarios.writeApproval = {
    workerId: writeWorker.id,
    status: writeFinal.worker.status,
    result: writeFinal.worker.result?.text,
    requestTitle: writeInput.title,
    options: writeInput.options,
    answeredWith: allowOption,
    fileContent: written,
    ...errorCounts(writeEvents.events),
  };
  projectEvents("writeApproval", writeEvents.events);

  // 4. AskUserQuestion via elicitation.
  const questionWorker = await client.request(
    "spawn",
    {
      runtime: "qoder",
      cwd: workDir,
      model,
      prompt:
        '请立即调用 AskUserQuestion 工具向我提出一个问题：标题为"确认"，问题为"是否继续？"，提供"是"和"否"两个选项。等待我的回答；如果我回答"是"，只回复 QUESTION_YES；如果回答"否"，只回复 QUESTION_NO。不要调用其他工具。',
      maxDurationMs: 300_000,
    },
    { timeoutMs: 60_000 },
  );
  const questionPending = await waitForStatus(client, questionWorker.id, ["awaiting_input"], 180_000);
  const questionInput = questionPending.worker.pendingInput;
  if (!questionInput) fail("AskUserQuestion reported awaiting_input without pendingInput.");
  if (questionInput.method !== "select") {
    fail(`Expected a selectable elicitation, got method=${questionInput.method}: ${clean(JSON.stringify(questionInput))}`);
  }
  if (!Array.isArray(questionInput.options) || !questionInput.options.includes("是")) {
    fail(`The elicitation options do not contain 是: ${clean(JSON.stringify(questionInput.options))}`);
  }
  await answer(client, questionWorker.id, questionInput.requestId, { value: "是" });
  const questionFinal = await waitTerminal(client, questionWorker.id, 0, 240_000);
  if (questionFinal?.worker.status !== "completed") {
    fail(`AskUserQuestion run ended as ${questionFinal?.worker.status}: ${questionFinal?.worker.error ?? "no error"}`);
  }
  if (!/QUESTION_YES/.test(questionFinal.worker.result?.text ?? "")) {
    fail(`AskUserQuestion result did not reflect the answer: ${questionFinal.worker.result?.text ?? "(empty)"}`);
  }
  const questionEvents = await events(client, questionWorker.id, 0);
  evidence.scenarios.askUserQuestion = {
    workerId: questionWorker.id,
    status: questionFinal.worker.status,
    result: questionFinal.worker.result?.text,
    method: questionInput.method,
    title: questionInput.title,
    options: questionInput.options,
    answeredWith: "是",
    ...errorCounts(questionEvents.events),
  };
  projectEvents("askUserQuestion", questionEvents.events);

  await stopDaemon(daemon, client);
  daemon = null;
  client = null;

  // 5. Cancellation under bypass mode so the long command needs no approval.
  const cancelStateDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-acp-cancel-state-"));
  const cancelStarted = await startDaemon(cancelStateDir, {
    HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "bypass_permissions",
    HARNESS_SUPERVISOR_QODER_INPUT_TIMEOUT_MS: "300000",
  });
  daemon = cancelStarted.child;
  client = cancelStarted.client;
  const cancelWorker = await client.request(
    "spawn",
    {
      runtime: "qoder",
      cwd: workDir,
      model,
      prompt:
        '请执行命令 node -e "setTimeout(()=>{},60000)"，等命令结束后回复 CANCEL_DONE。不要执行其他命令。',
      maxDurationMs: 300_000,
    },
    { timeoutMs: 60_000 },
  );
  await sleep(4000);
  const beforeCancel = await client.request("status", { workerId: cancelWorker.id, recentEvents: 5 });
  if (beforeCancel.worker.status === "completed") {
    fail("The cancellation scenario finished before it could be cancelled; use a longer command.");
  }
  await client.request("cancel", { workerId: cancelWorker.id }, { timeoutMs: 60_000 });
  const cancelFinal = await waitTerminal(client, cancelWorker.id, 0, 120_000);
  if (cancelFinal?.worker.status !== "cancelled") {
    fail(`Cancel ended as ${cancelFinal?.worker.status}: ${cancelFinal?.worker.error ?? "no error"}`);
  }
  const cancelledPid = cancelWorker.pid ?? null;
  await sleep(500);
  let pidAlive = false;
  if (cancelledPid) {
    try {
      process.kill(cancelledPid, 0);
      pidAlive = true;
    } catch {
      pidAlive = false;
    }
  }
  const cancelEvents = await events(client, cancelWorker.id, 0);
  evidence.scenarios.cancel = {
    workerId: cancelWorker.id,
    statusBeforeCancel: beforeCancel.worker.status,
    status: cancelFinal.worker.status,
    pid: cancelledPid,
    pidAliveAfterCancel: pidAlive,
    ...errorCounts(cancelEvents.events),
  };
  projectEvents("cancel", cancelEvents.events);

  await stopDaemon(daemon, client);
  daemon = null;
  client = null;

  evidence.ok = true;
  evidence.daemonSurvived = true;
  await mkdir(evidenceDir, { recursive: true });
  const safe = JSON.parse(clean(JSON.stringify(evidence, null, 2)));
  await writeFile(path.join(evidenceDir, "result.json"), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(evidenceDir, "events.jsonl"),
    `${evidenceEvents.map((event) => clean(JSON.stringify(event))).join("\n")}\n`,
    "utf8",
  );
  console.log("QODER_ACP_REAL_OK");
  console.log(clean(JSON.stringify(evidence.scenarios, null, 2)));
  console.log(`evidence=${evidenceDir}`);
} catch (error) {
  evidence.ok = false;
  evidence.error = clean(error instanceof Error ? error.stack ?? error.message : String(error));
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.join(evidenceDir, "result.json"),
    `${JSON.stringify(JSON.parse(clean(JSON.stringify(evidence, null, 2))), null, 2)}\n`,
    "utf8",
  );
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  if (daemon || client) {
    await stopDaemon(daemon, client).catch(() => undefined);
  }
}
