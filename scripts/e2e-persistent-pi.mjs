#!/usr/bin/env node
/**
 * Real Pi persistent-worker continuity evidence.
 *
 * Three Turns on one worker/session. Turn 1 introduces nonce A, Turn 2
 * introduces nonce B, and Turn 3 asks for both without restating either. The
 * nonces are generated here, so only the native session can supply them.
 *
 * Cost control: three small flash-model Turns with a 180s deadline each.
 * Evidence goes to .evidence/persistent-pi/ (gitignored); the state dir is a
 * temp directory that can be removed after inspection.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SupervisorClient } from "../dist/src/ipc/client.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    "state-dir": { type: "string" },
    cwd: { type: "string" },
    model: { type: "string" },
    provider: { type: "string" },
    "timeout-ms": { type: "string" },
  },
});
const runtime = values.runtime ?? "pi";
if (!["pi", "qoder", "mcode", "dsh"].includes(runtime)) {
  throw new Error(`Unsupported runtime: ${runtime}`);
}
const model =
  values.model ?? (runtime === "pi" ? process.env.REAL_PI_MODEL ?? "deepseek-v4.1-flash-1017" : undefined);
const provider =
  values.provider ?? (runtime === "pi" ? process.env.REAL_PI_PROVIDER ?? "new-api" : undefined);
const turnTimeoutMs = Number(values["timeout-ms"] ?? 180_000);
const stateDir = values["state-dir"]
  ? path.resolve(values["state-dir"])
  : await mkdtemp(path.join(os.tmpdir(), `hs-persistent-${runtime}-state-`));
const cwd = values.cwd
  ? path.resolve(values.cwd)
  : await mkdtemp(path.join(os.tmpdir(), `hs-persistent-${runtime}-work-`));
await mkdir(cwd, { recursive: true });

const nonceA = `A-${randomBytes(4).toString("hex")}`;
const nonceB = `B-${randomBytes(4).toString("hex")}`;
const extraArgs =
  runtime === "pi"
    ? ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]
    : undefined;

const env = process.env;
for (const key of [
  "HARNESS_SUPERVISOR_PI_ENTRY",
  "HARNESS_SUPERVISOR_PI_BIN",
  "HARNESS_SUPERVISOR_PI_ARGS",
  "FAKE_PI_SCENARIO",
  "FAKE_PI_STEP_MS",
  "FAKE_PI_SLOW_STEP_MS",
  // The desktop injects its own Qoder config roots; the login lives in ~/.qoder.
  "QODER_CONFIG_DIR",
  "QODERCN_CONFIG_DIR",
]) {
  delete env[key];
}
env.HARNESS_SUPERVISOR_HOME = stateDir;

const client = new SupervisorClient({ stateDir });
const evidence = {
  startedAt: new Date().toISOString(),
  runtime,
  model,
  provider,
  stateDir,
  cwd,
  nonceA,
  nonceB,
  workerId: null,
  sessionId: null,
  sessionFile: null,
  turns: [],
  assertions: {},
  error: null,
};

function recordTurn(turn, accepted, settled) {
  return {
    turn,
    acceptedStatus: accepted.status,
    acceptedLifecycle: accepted.lifecycle,
    status: settled.worker.status,
    lifecycle: settled.worker.lifecycle,
    sessionId: settled.worker.sessionId,
    sessionFile: settled.worker.sessionFile,
    restorable: settled.worker.session.restorable,
    pidAlive: settled.worker.pidAlive,
    resumeCount: settled.worker.resumeCount,
    result: settled.worker.result?.text ?? null,
    error: settled.worker.error ?? null,
  };
}

async function waitTerminal(workerId, sinceSeq) {
  const deadline = Date.now() + turnTimeoutMs + 20_000;
  let cursor = sinceSeq;
  for (;;) {
    const remaining = Math.max(1000, Math.min(120_000, deadline - Date.now()));
    const waited = await client.request(
      "wait",
      { workerId, sinceSeq: cursor, timeoutMs: remaining, until: "terminal" },
      { timeoutMs: remaining + 10_000 },
    );
    cursor = waited.nextSeq;
    if (waited.terminal) return waited;
    if (Date.now() >= deadline) {
      throw new Error(`worker ${workerId} did not reach a terminal state in time`);
    }
  }
}

try {
  await client.connect();
  const worker = await client.request(
    "spawn",
    {
      runtime,
      cwd,
      prompt: `This is a persistent-session continuity test. Remember this codeword: ${nonceA}. Do not use tools. Reply exactly TURN1_READY.`,
      name: `real-${runtime}-persistent`,
      persistence: "persistent",
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(extraArgs !== undefined ? { extraArgs } : {}),
      maxDurationMs: turnTimeoutMs,
      notifyTarget: { channel: "none" },
    },
    { timeoutMs: 90_000 },
  );
  evidence.workerId = worker.id;
  const turn1 = await waitTerminal(worker.id, worker.lastSeq);
  evidence.turns.push(recordTurn(1, worker, turn1));
  evidence.sessionId = turn1.worker.sessionId ?? null;
  evidence.sessionFile = turn1.worker.sessionFile ?? null;
  evidence.assertions.turn1Completed = turn1.worker.status === "completed";
  evidence.assertions.turn1Idle = turn1.worker.lifecycle === "idle";
  evidence.assertions.turn1Session = Boolean(turn1.worker.sessionId && turn1.worker.sessionFile);

  const accepted2 = await client.request(
    "continue",
    {
      workerId: worker.id,
      prompt: `Remember this second codeword: ${nonceB}. Do not use tools. Reply exactly TURN2_READY.`,
    },
    { timeoutMs: 90_000 },
  );
  const turn2 = await waitTerminal(worker.id, accepted2.lastSeq);
  evidence.turns.push(recordTurn(2, accepted2, turn2));
  evidence.assertions.sameWorker = turn2.worker.id === worker.id;
  evidence.assertions.sameSessionAfterTurn2 = turn2.worker.sessionId === evidence.sessionId;
  evidence.assertions.turn2Completed = turn2.worker.status === "completed";

  const accepted3 = await client.request(
    "continue",
    {
      workerId: worker.id,
      prompt:
        "Without using tools and without guessing, report both codewords from our earlier conversation. " +
        "Reply with exactly both codewords separated by a comma.",
    },
    { timeoutMs: 90_000 },
  );
  const turn3 = await waitTerminal(worker.id, accepted3.lastSeq);
  evidence.turns.push(recordTurn(3, accepted3, turn3));
  const text3 = turn3.worker.result?.text ?? "";
  evidence.assertions.sameSessionAfterTurn3 = turn3.worker.sessionId === evidence.sessionId;
  evidence.assertions.contextHadNonceA = text3.includes(nonceA);
  evidence.assertions.contextHadNonceB = text3.includes(nonceB);
  evidence.assertions.turn3Idle = turn3.worker.lifecycle === "idle";
  evidence.assertions.allProcessesExited = evidence.turns.every((turn) => turn.pidAlive === false);
  evidence.assertions.resumeCount = turn3.worker.resumeCount === 2;

  const failed = Object.entries(evidence.assertions)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  if (failed.length > 0) {
    throw new Error(`persistent Pi assertions failed: ${failed.join(", ")}`);
  }
  evidence.ok = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  evidence.ok = false;
  process.exitCode = 1;
} finally {
  const evidenceDir = path.join(root, ".evidence", "persistent-pi");
  await mkdir(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `run-${runtime}-${Date.now()}.json`);
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: evidence.ok, evidence: file, runtime, workerId: evidence.workerId, sessionId: evidence.sessionId, assertions: evidence.assertions, error: evidence.error }));
  try {
    await client.request("shutdown", {}, { timeoutMs: 20_000 });
  } catch {
    // The daemon may already be gone.
  }
  client.close();
}
