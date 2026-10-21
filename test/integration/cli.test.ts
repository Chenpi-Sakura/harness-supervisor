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
    worker: { status: string };
    recentEvents: Array<{ type: string }>;
  };
  assert.equal(statusResult.worker.status, "completed");
  assert.ok(statusResult.recentEvents.some((event) => event.type === "run.completed"));
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
