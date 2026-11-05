#!/usr/bin/env node
/**
 * Real DeepSeek Harness ACP acceptance through the supervisor daemon.
 *
 * Requires a DSH desktop install (auto-discovered on Windows via the uninstall
 * registry) or HARNESS_SUPERVISOR_DSH_ENTRY pointing at the dsh launcher. The
 * script uses the desktop's normal ~/.dsh login and never reads or prints
 * credentials.
 *
 * Covers: spawn + prompt, model/reasoning config, resume via session/resume,
 * the native workspace-write default with an outside-workspace approval and
 * one-time escalation, danger-full-access without approval, and cancellation.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorClient } from "../dist/src/ipc/client.js";
import { resolveDshLaunch } from "../dist/src/adapters/dsh/launch.js";
import { sleep } from "../dist/src/util/async.js";
import { redactText } from "../dist/src/util/redact.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(root, "dist", "src", "daemon-entry.js");
const evidenceDir = process.env.DSH_ACP_EVIDENCE_DIR
  ? path.resolve(process.env.DSH_ACP_EVIDENCE_DIR)
  : path.join(root, "evidence", "dsh-acp-real");

const provider = process.env.DSH_REAL_PROVIDER?.trim() || "deepseek-official";
const model = process.env.DSH_REAL_MODEL?.trim() || "deepseek-v4-flash";
const thinking = process.env.DSH_REAL_THINKING?.trim() || "low";

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

if (process.env.DSH_REAL !== "1") {
  skip("Skipped real DSH ACP E2E. Set DSH_REAL=1 (defaults to deepseek-official/deepseek-v4-flash).");
}

let launch;
try {
  launch = resolveDshLaunch();
} catch (error) {
  skip(
    `${clean(error.message)}\nInstall DeepSeek Harness or set HARNESS_SUPERVISOR_DSH_ENTRY.`,
    2,
  );
}
if (!existsSync(launch.file)) {
  skip(`Resolved DSH launcher does not exist: ${clean(launch.file)}`, 2);
}

const workDir = await mkdtemp(path.join(os.tmpdir(), "hs-dsh-acp-real-work-"));
const evidence = {
  ranAt: new Date().toISOString(),
  host: `${os.platform()} ${os.release()} / Node ${process.version}`,
  discovery: {
    file: clean(launch.file),
    args: launch.args.map(clean),
    description: clean(launch.description),
    entryOverride: Boolean(process.env.HARNESS_SUPERVISOR_DSH_ENTRY),
  },
  model: { provider, model, thinking },
  protocol: "acp",
  scenarios: {},
  limits: {
    permissions:
      "The acp profile reads DSH_PERMISSION_MODE at boot and defaults to workspace-write with approval ask. A write inside the workspace or platform temp needs no approval; an outside write is denied and triggers session/request_permission for a one-time danger-full-access escalation. HARNESS_SUPERVISOR_DSH_PERMISSION_MODE=danger-full-access removes the file sandbox and approval, and an outside write then succeeds without a request. The desktop permission picker only configures desktop sessions and does not apply to the acp profile.",
    steering:
      "ACP has no active-turn steer; capabilities report steer=false and followUp=false.",
    usage:
      "usage_update is context occupancy, not billed token usage; HS records it as context_usage progress, not run.usage.",
  },
};

async function startDaemon(stateDir, extraEnv = {}) {
  const output = { text: "" };
  const env = { ...process.env, HARNESS_SUPERVISOR_HOME: stateDir };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, [daemonEntry, "--state-dir", stateDir], {
    env,
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

async function waitTerminal(client, workerId, sinceSeq, timeoutMs, options = {}) {
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
    if (last.worker.status === "awaiting_input") {
      if (options.allowInput) return last;
      fail(
        `DSH asked for input unexpectedly: ${clean(JSON.stringify(last.worker.pendingInput ?? {}))}`,
      );
    }
  }
  return last;
}

async function answerPermission(client, worker) {
  const pending = worker.pendingInput;
  if (!pending?.requestId) {
    fail(`Worker ${worker.id} is awaiting_input without a requestId.`);
  }
  const options = pending.options ?? [];
  const allow = options.find((name) => /allow|允许|批准/i.test(name));
  if (!allow) {
    fail(`No allow option in the DSH permission request: ${JSON.stringify(options)}`);
  }
  await client.request(
    "answer",
    { workerId: worker.id, requestId: pending.requestId, response: { value: allow } },
    { timeoutMs: 30_000 },
  );
  return {
    requestId: pending.requestId,
    method: pending.method,
    title: pending.title ?? null,
    options,
    answer: allow,
  };
}

async function waitForStatus(client, workerId, statuses, timeoutMs) {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    const status = await client.request(
      "status",
      { workerId, recentEvents: 10 },
      { timeoutMs: 15_000 },
    );
    if (statuses.includes(status.worker.status)) return status;
    await sleep(100);
  }
  const status = await client.request(
    "status",
    { workerId, recentEvents: 10 },
    { timeoutMs: 15_000 },
  );
  throw new Error(
    `Timed out waiting for ${statuses.join(",")}; current=${status.worker.status}, pendingInput=${Boolean(status.worker.pendingInput)}`,
  );
}

async function events(client, workerId, sinceSeq = 0) {
  return client.request(
    "events",
    { workerId, sinceSeq, limit: 500 },
    { timeoutMs: 15_000 },
  );
}

const evidenceEvents = [];

function projectEvents(scenario, list) {
  for (const event of list) {
    const data = event.data ?? {};
    const projected = { scenario, seq: event.seq, type: event.type };
    for (const key of ["kind", "tool", "isError", "method", "title", "options", "requestId"]) {
      if (data[key] !== undefined) projected[key] = data[key];
    }
    if (event.type === "run.error" && typeof data.message === "string") {
      projected.message = clean(data.message);
    }
    if (event.type === "run.progress" && typeof data.preview === "string") {
      projected.preview = clean(data.preview).slice(0, 200);
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
    needsInput: list.filter((event) => event.type === "run.needs_input").length,
  };
}

let daemon = null;
let client = null;
let fullDaemon = null;
let fullClient = null;
const cleanupPaths = [];
try {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-dsh-acp-real-state-"));
  const started = await startDaemon(stateDir, {
    DSH_PERMISSION_MODE: undefined,
    HARNESS_SUPERVISOR_DSH_PERMISSION_MODE: undefined,
  });
  daemon = started.child;
  client = started.client;

  // 1. Spawn + prompt + model/reasoning config.
  const firstWorker = await client.request(
    "spawn",
    {
      runtime: "dsh",
      cwd: workDir,
      provider,
      model,
      thinking,
      prompt: "请只回复 DSH_HS_E2E_OK，不要调用任何工具。",
      maxDurationMs: 240_000,
    },
    { timeoutMs: 60_000 },
  );
  const first = await waitTerminal(client, firstWorker.id, 0, 240_000);
  if (first?.worker.status !== "completed") {
    fail(`DSH spawn ended as ${first?.worker.status}: ${first?.worker.error ?? "no error"}`);
  }
  if (!/DSH_HS_E2E_OK/.test(first.worker.result?.text ?? "")) {
    fail(`DSH spawn result did not contain the token: ${first.worker.result?.text ?? "(empty)"}`);
  }
  if (!first.worker.sessionId) fail("DSH spawn did not report a session id.");
  if (!first.worker.sessionFile?.endsWith("dsh-session.json")) {
    fail(`DSH spawn reported an unexpected session file: ${first.worker.sessionFile}`);
  }
  if (!first.worker.sessionFile || !existsSync(first.worker.sessionFile)) {
    fail("DSH session handle file does not exist; resume cannot be verified.");
  }
  const firstEvents = await events(client, firstWorker.id, 0);
  const firstCursor = firstEvents.nextSeq;
  evidence.scenarios.spawn = {
    workerId: firstWorker.id,
    status: first.worker.status,
    result: first.worker.result?.text,
    sessionId: first.worker.sessionId,
    sessionFile: clean(first.worker.sessionFile),
    capabilities: first.worker.capabilities,
    pid: first.worker.pid ?? null,
    usageEvents: firstEvents.events.filter((event) => event.type === "run.usage").length,
    contextUsageEvents: firstEvents.events.filter(
      (event) => event.type === "run.progress" && event.data?.kind === "context_usage",
    ).length,
    ...errorCounts(firstEvents.events),
  };
  projectEvents("spawn", firstEvents.events);

  // 2. Resume through session/resume in a new process.
  await client.request(
    "resume",
    {
      workerId: firstWorker.id,
      provider,
      model,
      thinking,
      prompt: "请只回复你在上一轮回复的 token，不要调用任何工具。",
      maxDurationMs: 240_000,
    },
    { timeoutMs: 60_000 },
  );
  const resumed = await waitTerminal(client, firstWorker.id, firstCursor, 240_000);
  if (resumed?.worker.status !== "completed") {
    fail(`DSH resume ended as ${resumed?.worker.status}: ${resumed?.worker.error ?? "no error"}`);
  }
  if (!/DSH_HS_E2E_OK/.test(resumed.worker.result?.text ?? "")) {
    fail(
      `DSH resume did not retain the previous conversation token: ${resumed.worker.result?.text ?? "(empty)"}`,
    );
  }
  if (resumed.worker.sessionId !== first.worker.sessionId) {
    fail(
      `DSH resume changed the session id (${first.worker.sessionId} -> ${resumed.worker.sessionId ?? "none"}).`,
    );
  }
  if (resumed.worker.sessionFile !== first.worker.sessionFile) {
    fail("DSH resume changed the session handle path.");
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
    ...errorCounts(resumedEvents.events),
  };
  projectEvents("resume", resumedEvents.events);

  // 3. workspace-write allows a write inside the workspace without approval.
  const writeName = "dsh-acp-write-ok.txt";
  const writeWorker = await client.request(
    "spawn",
    {
      runtime: "dsh",
      cwd: workDir,
      provider,
      model,
      thinking,
      prompt: `请在当前目录创建文件 ${writeName}，文件内容必须只有一行 DSH_WRITE_OK。完成后只回复 WRITE_DONE，不要修改其他文件。`,
      maxDurationMs: 300_000,
    },
    { timeoutMs: 60_000 },
  );
  const writeFinal = await waitTerminal(client, writeWorker.id, 0, 300_000);
  if (writeFinal?.worker.status !== "completed") {
    fail(`DSH write ended as ${writeFinal?.worker.status}: ${writeFinal?.worker.error ?? "no error"}`);
  }
  const writeContent = await readFile(path.join(workDir, writeName), "utf8").catch(() => "");
  if (!writeContent.includes("DSH_WRITE_OK")) {
    fail(`DSH did not create ${writeName} with the expected content: ${JSON.stringify(writeContent)}`);
  }
  const writeEvents = await events(client, writeWorker.id, 0);
  evidence.scenarios.write = {
    status: writeFinal.worker.status,
    result: writeFinal.worker.result?.text,
    file: writeName,
    fileContent: writeContent.trim(),
    ...errorCounts(writeEvents.events),
  };
  projectEvents("write", writeEvents.events);

  // 4. Native workspace-write: an outside write is denied and asks for approval.
  const outsideRoot = path.join(
    process.env.LOCALAPPDATA ?? os.homedir(),
    `hs-dsh-acp-outside-${Date.now().toString(36)}`,
  );
  await mkdir(outsideRoot, { recursive: true });
  cleanupPaths.push(outsideRoot);
  const outsideName = "dsh-acp-outside-ok.txt";
  const outsideTarget = path.join(outsideRoot, outsideName);
  const outsideWorker = await client.request(
    "spawn",
    {
      runtime: "dsh",
      cwd: workDir,
      provider,
      model,
      thinking,
      prompt: `请使用写入工具创建文件 ${outsideTarget.replace(/\\/g, "/")}，文件内容必须只有一行 DSH_ESCALATION_OK。该路径在当前工作区之外。如果沙箱拒绝写入，请按提示请求一次性的完全访问提权（danger-full-access）并重试同一路径，不要改用其他路径。完成后只回复 ESCALATION_DONE。`,
      maxDurationMs: 300_000,
    },
    { timeoutMs: 60_000 },
  );
  const outsideFirst = await waitTerminal(client, outsideWorker.id, 0, 300_000, {
    allowInput: true,
  });
  if (outsideFirst?.worker.status !== "awaiting_input") {
    fail(
      `Expected an approval request for the outside write, got ${outsideFirst?.worker.status}: ${outsideFirst?.worker.error ?? "no error"}`,
    );
  }
  const outsidePermission = await answerPermission(client, outsideFirst.worker);
  const outsideFinal = await waitTerminal(
    client,
    outsideWorker.id,
    outsideFirst.nextSeq,
    300_000,
  );
  if (outsideFinal?.worker.status !== "completed") {
    fail(
      `DSH outside write ended as ${outsideFinal?.worker.status}: ${outsideFinal?.worker.error ?? "no error"}`,
    );
  }
  const outsideContent = await readFile(outsideTarget, "utf8").catch(() => "");
  if (!outsideContent.includes("DSH_ESCALATION_OK")) {
    fail(`The escalated write did not create the outside file: ${JSON.stringify(outsideContent)}`);
  }
  const outsideEvents = await events(client, outsideWorker.id, 0);
  evidence.scenarios.escalation = {
    status: outsideFinal.worker.status,
    result: outsideFinal.worker.result?.text,
    permission: outsidePermission,
    outsideFile: clean(outsideTarget),
    fileContent: outsideContent.trim(),
    ...errorCounts(outsideEvents.events),
  };
  projectEvents("escalation", outsideEvents.events);

  // 5. danger-full-access removes the sandbox: the outside write needs no approval.
  const fullWorkDir = await mkdtemp(path.join(os.tmpdir(), "hs-dsh-acp-real-full-"));
  const fullOutsideRoot = path.join(
    process.env.LOCALAPPDATA ?? os.homedir(),
    `hs-dsh-acp-full-outside-${Date.now().toString(36)}`,
  );
  await mkdir(fullOutsideRoot, { recursive: true });
  cleanupPaths.push(fullOutsideRoot);
  const fullTarget = path.join(fullOutsideRoot, "dsh-acp-full-ok.txt");
  const fullStateDir = await mkdtemp(path.join(os.tmpdir(), "hs-dsh-acp-real-fullstate-"));
  const fullStarted = await startDaemon(fullStateDir, {
    HARNESS_SUPERVISOR_DSH_PERMISSION_MODE: "danger-full-access",
    DSH_PERMISSION_MODE: undefined,
  });
  fullDaemon = fullStarted.child;
  fullClient = fullStarted.client;
  const fullWorker = await fullClient.request(
    "spawn",
    {
      runtime: "dsh",
      cwd: fullWorkDir,
      provider,
      model,
      thinking,
      prompt: `请使用写入工具创建文件 ${fullTarget.replace(/\\/g, "/")}，文件内容必须只有一行 DSH_FULL_ACCESS_OK。该路径在当前工作区之外。完成后只回复 FULL_ACCESS_DONE。`,
      maxDurationMs: 300_000,
    },
    { timeoutMs: 60_000 },
  );
  const fullFinal = await waitTerminal(fullClient, fullWorker.id, 0, 300_000);
  if (fullFinal?.worker.status !== "completed") {
    fail(
      `DSH full-access write ended as ${fullFinal?.worker.status}: ${fullFinal?.worker.error ?? "no error"}`,
    );
  }
  const fullContent = await readFile(fullTarget, "utf8").catch(() => "");
  if (!fullContent.includes("DSH_FULL_ACCESS_OK")) {
    fail(`DSH full-access did not create the outside file: ${JSON.stringify(fullContent)}`);
  }
  const fullEvents = await events(fullClient, fullWorker.id, 0);
  evidence.scenarios.fullAccess = {
    status: fullFinal.worker.status,
    result: fullFinal.worker.result?.text,
    permissionMode: "danger-full-access",
    outsideFile: clean(fullTarget),
    fileContent: fullContent.trim(),
    ...errorCounts(fullEvents.events),
  };
  projectEvents("fullAccess", fullEvents.events);

  // 6. Cancel a long turn.
  const cancelWorker = await client.request(
    "spawn",
    {
      runtime: "dsh",
      cwd: workDir,
      provider,
      model,
      thinking,
      prompt: "请不要调用任何工具，详细解释分布式系统，至少写 5000 字，写完后只回复 LONG_DONE。",
      maxDurationMs: 300_000,
    },
    { timeoutMs: 60_000 },
  );
  await waitForStatus(client, cancelWorker.id, ["running"], 30_000);
  const cancelled = await client.request(
    "cancel",
    { workerId: cancelWorker.id },
    { timeoutMs: 30_000 },
  );
  if (cancelled.status !== "cancelled") {
    fail(`DSH cancel ended as ${cancelled.status}, expected cancelled.`);
  }
  await sleep(500);
  const cancelStatus = await client.request(
    "status",
    { workerId: cancelWorker.id, recentEvents: 10 },
    { timeoutMs: 15_000 },
  );
  const cancelEvents = await events(client, cancelWorker.id, 0);
  evidence.scenarios.cancel = {
    status: cancelStatus.worker.status,
    pidAlive: cancelStatus.worker.pidAlive,
    ...errorCounts(cancelEvents.events),
  };
  projectEvents("cancel", cancelEvents.events);
} finally {
  for (const dir of cleanupPaths) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await stopDaemon(fullDaemon, fullClient);
  await stopDaemon(daemon, client);
}

await mkdir(evidenceDir, { recursive: true });
await writeFile(
  path.join(evidenceDir, "result.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(evidenceDir, "events.jsonl"),
  evidenceEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
  "utf8",
);
console.log(`DSH ACP E2E passed. Evidence: ${clean(evidenceDir)}`);
