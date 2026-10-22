#!/usr/bin/env node
/**
 * Real Qoder CLI E2E: one text-only worker run plus a native resume.
 *
 * This intentionally avoids tools so it does not have to auto-approve any
 * permission prompt. It requires an existing `qodercli login` state and an
 * explicitly chosen low-cost model.
 */
import { spawn, spawnSync } from "node:child_process";
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
const evidenceDir = process.env.QODER_EVIDENCE_DIR
  ? path.resolve(process.env.QODER_EVIDENCE_DIR)
  : path.join(root, "evidence", "qoder-real");
const hostInjected = [
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_VERSION",
  "QODER_SDK_AUTH_PAYLOAD_FILE",
  "QODER_WORKER_CWD",
  "QODER_WORKER_RUNTIME_ASSET_ROOT",
  "QODERCN_SESSION_TYPE",
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
  skip(
    "Skipped real Qoder E2E. Set QODER_REAL=1 and QODER_REAL_MODEL=<low-cost model> to run it.",
  );
}

const model = process.env.QODER_REAL_MODEL?.trim();
if (!model) {
  skip(
    "QODER_REAL_MODEL is required. Pick a low-cost model from `qodercli --list-models` so the test does not call an expensive default model.",
    2,
  );
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
    `Could not run qodercli: ${version.error?.message ?? version.stderr ?? "unknown error"}. Install Qoder CLI or set HARNESS_SUPERVISOR_QODER_BIN.`,
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
      "Run `qodercli login` yourself (interactive, browser-based), then re-run:",
      '  $env:QODER_REAL="1"; $env:QODER_REAL_MODEL="<low-cost model>"; npm run e2e:qoder',
      "The supervisor never reads or prints your credentials.",
    ].join("\n"),
    2,
  );
}
if (models.error || models.status !== 0) {
  skip(
    `qodercli --list-models failed (exit=${models.status ?? "?"}): ${modelOutput.slice(0, 500)}`,
    2,
  );
}

const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-real-state-"));
const workDir = await mkdtemp(path.join(os.tmpdir(), "hs-qoder-real-work-"));
const daemon = spawn(process.execPath, [daemonEntry, "--state-dir", stateDir], {
  env: {
    ...env,
    HARNESS_SUPERVISOR_HOME: stateDir,
    HARNESS_SUPERVISOR_QODER_PERMISSION_MODE: "accept_edits",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let daemonOutput = "";
daemon.stdout?.on("data", (chunk) => {
  daemonOutput += chunk.toString("utf8");
});
daemon.stderr?.on("data", (chunk) => {
  daemonOutput += chunk.toString("utf8");
});

let client = null;
let worker = null;
let summary = null;
try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      fail(`Daemon exited before ready (${daemon.exitCode}).\n${daemonOutput}`);
    }
    const candidate = new SupervisorClient({ stateDir, autoStart: false });
    try {
      await candidate.connect();
      client = candidate;
      break;
    } catch {
      candidate.close();
      await sleep(100);
    }
  }
  if (!client) fail(`Daemon did not become ready.\n${daemonOutput}`);

  const startedAt = Date.now();
  const firstPrompt =
    "请只回复 QODER_E2E_OK，不要调用任何工具，也不要读取或修改文件。";
  worker = await client.request(
    "spawn",
    {
      runtime: "qoder",
      cwd: workDir,
      model,
      prompt: firstPrompt,
      maxDurationMs: 240_000,
    },
    { timeoutMs: 60_000 },
  );
  const spawnReturnedMs = Date.now() - startedAt;

  async function waitTerminal(sinceSeq = 0, timeoutMs = 240_000) {
    const stop = Date.now() + timeoutMs;
    let cursor = sinceSeq;
    let last = null;
    while (Date.now() < stop) {
      const remaining = Math.max(1000, Math.min(110_000, stop - Date.now()));
      last = await client.request(
        "wait",
        { workerId: worker.id, sinceSeq: cursor, timeoutMs: remaining, until: "terminal" },
        { timeoutMs: remaining + 10_000 },
      );
      cursor = last.nextSeq;
      if (last.terminal) return last;
    }
    return last;
  }

  const first = await waitTerminal(0);
  if (!first?.terminal) fail("First Qoder run did not become terminal within 240s.");
  if (first.worker.status !== "completed") {
    fail(`First Qoder run ended as ${first.worker.status}: ${first.worker.error ?? "no error"}`);
  }
  if (!/QODER_E2E_OK/.test(first.worker.result?.text ?? "")) {
    fail(`First result did not contain QODER_E2E_OK: ${first.worker.result?.text ?? "(empty)"}`);
  }
  const sessionId = first.worker.sessionId;
  if (!sessionId) fail("Qoder did not report a session id.");
  if (!first.worker.sessionFile || !existsSync(first.worker.sessionFile)) {
    fail("Qoder did not persist a usable session file; resume cannot be verified.");
  }
  const firstPid = first.worker.pid ?? null;
  const firstDurationMs = first.worker.endedAt
    ? Date.parse(first.worker.endedAt) - Date.parse(first.worker.startedAt ?? new Date().toISOString())
    : null;

  const firstEvents = await client.request(
    "events",
    { workerId: worker.id, sinceSeq: 0, limit: 500 },
    { timeoutMs: 15_000 },
  );
  const firstCursor = firstEvents.nextSeq;

  await sleep(500);
  await client.request(
    "resume",
    {
      workerId: worker.id,
      model,
      prompt: "请只回复 QODER_RESUME_OK，不要调用任何工具。",
      maxDurationMs: 240_000,
    },
    { timeoutMs: 60_000 },
  );
  const resumed = await waitTerminal(firstCursor);
  if (!resumed?.terminal) fail("Qoder resume did not become terminal within 240s.");
  if (resumed.worker.status !== "completed") {
    fail(`Qoder resume ended as ${resumed.worker.status}: ${resumed.worker.error ?? "no error"}`);
  }
  if (!/QODER_RESUME_OK/.test(resumed.worker.result?.text ?? "")) {
    fail(`Resume result did not contain QODER_RESUME_OK: ${resumed.worker.result?.text ?? "(empty)"}`);
  }
  if (resumed.worker.sessionId !== sessionId) {
    fail(`Resume changed the session id (${sessionId} -> ${resumed.worker.sessionId ?? "none"}).`);
  }
  if (!resumed.worker.sessionFile || resumed.worker.sessionFile !== first.worker.sessionFile) {
    fail("Resume changed the persisted session file path.");
  }
  if (resumed.worker.resumeCount !== 1) {
    fail(`Expected resumeCount=1, got ${resumed.worker.resumeCount}.`);
  }
  if (/QODER_E2E_OK/.test(resumed.worker.result?.text ?? "")) {
    fail("The resumed run replayed the first answer instead of using the new prompt.");
  }

  const resumedEvents = await client.request(
    "events",
    { workerId: worker.id, sinceSeq: firstCursor, limit: 500 },
    { timeoutMs: 15_000 },
  );
  const usageOf = (events) =>
    events
      .filter((event) => event.type === "run.progress" && event.data?.kind === "usage")
      .map((event) => {
        try {
          return JSON.parse(String(event.data?.detail ?? "{}"));
        } catch {
          return { raw: event.data?.detail };
        }
      });

  summary = {
    ranAt: new Date().toISOString(),
    host: `${os.platform()} ${os.release()} / Node ${process.version}`,
    qodercliVersion: cliVersion,
    model,
    permissionMode: "accept_edits",
    workerId: worker.id,
    spawnReturnedMs,
    firstRun: {
      status: first.worker.status,
      durationMs: firstDurationMs,
      result: first.worker.result?.text,
      sessionId,
      sessionFilePresent: true,
      pid: firstPid,
      usage: usageOf(firstEvents.events),
    },
    resumedRun: {
      status: resumed.worker.status,
      result: resumed.worker.result?.text,
      resumeCount: resumed.worker.resumeCount,
      sameSessionId: true,
      sameSessionFile: true,
      usage: usageOf(resumedEvents.events),
    },
    daemonSurvived: daemon.exitCode === null,
    usageNote:
      "usage arrays are the raw values reported by qodercli; zeros mean it did not report token/cost for these turns, not a claim of zero usage.",
    note: "Text-only run: no tools and no permission prompts. Raw Qoder session content was not copied.",
  };

  await mkdir(evidenceDir, { recursive: true });
  const safeSummary = JSON.parse(clean(JSON.stringify(summary, null, 2)));
  await writeFile(path.join(evidenceDir, "result.json"), `${JSON.stringify(safeSummary, null, 2)}\n`, "utf8");
  const eventLines = [...firstEvents.events, ...resumedEvents.events]
    .map((event) => clean(JSON.stringify(event)))
    .join("\n");
  await writeFile(path.join(evidenceDir, "events.jsonl"), `${eventLines}\n`, "utf8");
  await writeFile(
    path.join(evidenceDir, "test-run.txt"),
    clean(
      [
        `qodercli ${cliVersion}`,
        `model ${model}`,
        `worker ${worker.id}`,
        `spawn returned in ${spawnReturnedMs}ms`,
        `first run: ${first.worker.status}, ${firstDurationMs ?? "?"}ms, result=${first.worker.result?.text}`,
        `resume: ${resumed.worker.status}, resumeCount=${resumed.worker.resumeCount}, result=${resumed.worker.result?.text}`,
        `session ${sessionId}`,
        `daemon survived: ${daemon.exitCode === null}`,
        `evidence ${evidenceDir}`,
        "",
      ].join("\n"),
    ),
    "utf8",
  );

  console.log(`QODER_REAL_OK worker=${worker.id} session=${sessionId}`);
  console.log(`first=${first.worker.result?.text}`);
  console.log(`resume=${resumed.worker.result?.text}`);
  console.log(`evidence=${evidenceDir}`);
} catch (error) {
  console.error(clean(error instanceof Error ? error.stack ?? error.message : String(error)));
  process.exitCode = 1;
} finally {
  try {
    if (client) await client.shutdown();
  } catch {
    // Best effort.
  }
  client?.close();
  if (daemon.exitCode === null) {
    try {
      process.kill(daemon.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
