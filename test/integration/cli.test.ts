import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CLI_ENTRY, FAKE_ENTRY, makeWorkspace } from "./helpers.js";

const exec = promisify(execFile);

interface CliOptions {
  env: NodeJS.ProcessEnv;
  timeout?: number;
}

async function cli(args: string[], options: CliOptions): Promise<{ stdout: string; stderr: string }> {
  const result = await exec(process.execPath, [CLI_ENTRY, ...args], {
    env: options.env,
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

test("CLI starts the supervisor, spawns a worker, steers it, and reads terminal state", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-cli-"));
  const cwd = await makeWorkspace();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_SUPERVISOR_HOME: stateDir,
    HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY,
    FAKE_PI_STEP_MS: "20",
    FAKE_PI_SLOW_STEP_MS: "5000",
  };
  t.after(async () => {
    await cli(["down", "--json"], { env, timeout: 20_000 }).catch(() => undefined);
  });

  const up = await cli(["up"], { env });
  assert.match(up.stdout, /supervisor running/);

  const spawned = await cli(
    [
      "spawn",
      "--cwd",
      cwd,
      "--prompt",
      "[scenario:slow] CLI worker",
      "--json",
    ],
    { env, timeout: 60_000 },
  );
  const worker = JSON.parse(spawned.stdout) as {
    id: string;
    status: string;
  };
  assert.equal(worker.status, "running");

  const sent = await cli(
    ["send", worker.id, "--message", "steer from CLI", "--json"],
    { env },
  );
  assert.equal(JSON.parse(sent.stdout).status, "running");

  const waited = await cli(
    ["wait", worker.id, "--since", "0", "--timeout-ms", "15000", "--json"],
    { env, timeout: 30_000 },
  );
  const result = JSON.parse(waited.stdout) as {
    worker: { status: string; result?: { text: string } };
    terminal: boolean;
  };
  assert.equal(result.terminal, true);
  assert.equal(result.worker.status, "completed");
  assert.match(result.worker.result?.text ?? "", /STEERED:steer from CLI/);

  const listed = await cli(["list", "--json"], { env });
  const workers = JSON.parse(listed.stdout) as Array<{ id: string }>;
  assert.ok(workers.some((item) => item.id === worker.id));

  const status = await cli(["status", worker.id, "--json"], { env });
  const statusResult = JSON.parse(status.stdout) as {
    worker: { status: string; result?: { preview?: string; chars?: number; text?: string } };
    recentEvents: Array<{ type: string }>;
  };
  assert.equal(statusResult.worker.status, "completed");
  assert.ok(statusResult.recentEvents.some((event) => event.type === "run.completed"));
  assert.equal(
    statusResult.worker.result?.text,
    undefined,
    "CLI status is compact by default and does not dump the full result",
  );
  assert.equal(typeof statusResult.worker.result?.preview, "string");
  assert.equal(typeof statusResult.worker.result?.chars, "number");
  assert.ok(
    Buffer.byteLength(status.stdout, "utf8") <= 2048,
    "CLI status stays within the 2 KiB default budget",
  );

  const fullStatus = await cli(["status", worker.id, "--json", "--full"], { env });
  const fullResult = JSON.parse(fullStatus.stdout) as {
    worker: { result?: { text: string } };
    recentEvents: Array<{ type: string }>;
  };
  assert.match(fullResult.worker.result?.text ?? "", /STEERED:steer from CLI/);
  assert.equal(
    fullResult.worker.result?.text?.length,
    statusResult.worker.result?.chars,
    "--full returns exactly the result the preview measured",
  );

  const compactEvents = await cli(["events", worker.id, "--json"], { env });
  const compactRead = JSON.parse(compactEvents.stdout) as {
    events: Array<{ seq: number; type: string }>;
    progressOmitted: number;
  };
  assert.equal(
    compactRead.events.some((event) => event.type === "run.progress"),
    false,
    "CLI events is compact by default",
  );
  assert.ok(
    Buffer.byteLength(compactEvents.stdout, "utf8") <= 4096,
    "CLI events stays within the 4 KiB default budget",
  );
  assert.ok(compactRead.progressOmitted > 0, "the fixture run stores progress events");

  const fullEvents = await cli(["events", worker.id, "--json", "--full"], { env });
  const fullRead = JSON.parse(fullEvents.stdout) as {
    events: Array<{ seq: number; type: string }>;
    nextSeq: number;
  };
  const progressEvent = fullRead.events.find((event) => event.type === "run.progress");
  assert.ok(progressEvent, "--full still returns the complete stored stream");
  assert.ok(fullEvents.stdout.length > compactEvents.stdout.length);

  const single = await cli(["events", worker.id, "--seq", String(progressEvent!.seq), "--json"], { env });
  const singleResult = JSON.parse(single.stdout) as {
    event: { seq: number; type: string; data?: unknown };
  };
  assert.equal(singleResult.event.seq, progressEvent!.seq, "--seq reads exactly one stored event");
  assert.equal(singleResult.event.type, "run.progress");
  assert.equal(typeof singleResult.event.data, "object");

  const waitedDefault = await cli(["wait", worker.id, "--since", "0", "--json"], { env, timeout: 30_000 });
  const waitDefault = JSON.parse(waitedDefault.stdout) as {
    events: Array<{ type: string }>;
    eventsOmitted?: number;
  };
  assert.equal(
    waitDefault.events.some((event) => event.type === "run.progress"),
    false,
    "CLI wait is tool-call free by default",
  );
  assert.ok((waitDefault.eventsOmitted ?? 0) > 0, "the omitted progress is counted");

  const waitedFull = await cli(
    ["wait", worker.id, "--since", "0", "--include-progress", "--json"],
    { env, timeout: 30_000 },
  );
  const waitFull = JSON.parse(waitedFull.stdout) as { events: Array<{ type: string }> };
  assert.ok(waitFull.events.some((event) => event.type === "run.progress"));
});

test("CLI spawn --wait returns one final JSON document", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-cli-wait-"));
  const cwd = await makeWorkspace();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_SUPERVISOR_HOME: stateDir,
    HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY,
    FAKE_PI_STEP_MS: "20",
  };
  t.after(async () => {
    await cli(["down"], { env, timeout: 20_000 }).catch(() => undefined);
  });
  const result = await cli(
    [
      "spawn",
      "--cwd",
      cwd,
      "--prompt",
      "short CLI task",
      "--wait",
      "--json",
    ],
    { env, timeout: 60_000 },
  );
  const parsed = JSON.parse(result.stdout) as {
    worker: { status: string; result?: { text: string } };
    terminal: boolean;
  };
  assert.equal(parsed.terminal, true);
  assert.equal(parsed.worker.status, "completed");
  assert.equal(parsed.worker.result?.text, "FAKE_PI_OK");
});
