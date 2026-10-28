import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  prepareWorkerGuard,
  resolveRealCodex,
} from "../../src/worker-guard.js";

async function fakeCodexDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-guard-bin-"));
  await writeFile(
    path.join(dir, "codex.cmd"),
    '@echo off\r\necho %* > "%~dp0args.txt"\r\necho FAKE_CODEX_OK\r\n',
  );
  const shell = path.join(dir, "codex");
  await writeFile(
    shell,
    '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$(dirname "$0")/args.txt"\necho FAKE_CODEX_OK\n',
  );
  await chmod(shell, 0o755);
  return dir;
}

function guardEnv(fakeBin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

test("prepareWorkerGuard installs shims and an env for one worker", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-guard-state-"));
  const fakeBin = await fakeCodexDir();
  const env = guardEnv(fakeBin);
  const guard = await prepareWorkerGuard(stateDir, undefined, env);
  assert.ok(guard, "a codex CLI on PATH installs the guard");
  assert.equal(path.dirname(guard.realBin), fakeBin, "the real CLI is outside the guard dir");
  assert.equal(resolveRealCodex(env, guard.dir), guard.realBin, "the guard dir never shadows the real CLI");
  const workerEnv = guard.envFor("w-test");
  assert.equal(workerEnv.HARNESS_SUPERVISOR_WORKER_ID, "w-test");
  assert.equal(workerEnv.HARNESS_SUPERVISOR_REAL_CODEX, guard.realBin);
  assert.ok(
    String(workerEnv.PATH).startsWith(`${guard.dir}${path.delimiter}`),
    "the worker PATH is prefixed with the shim directory",
  );

  const shim = path.join(guard.dir, process.platform === "win32" ? "codex.cmd" : "codex");
  assert.match(await readFile(shim, "utf8"), /codex-guard\.js/);
  assert.equal(
    await prepareWorkerGuard(stateDir, undefined, { ...env, HARNESS_SUPERVISOR_WORKER_GUARD: "0" }),
    null,
    "the guard can be disabled explicitly",
  );
  const empty = await mkdtemp(path.join(os.tmpdir(), "hs-guard-empty-"));
  await mkdir(empty, { recursive: true });
  assert.equal(
    await prepareWorkerGuard(stateDir, undefined, { ...env, PATH: empty }),
    null,
    "no codex CLI means no guard",
  );
});

function runShim(shim: string, args: string[], env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${shim}" ${args.join(" ")}`], {
      env,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(shim, args, { env, encoding: "utf8" });
}

test("the codex shim denies queue, logs it, and forwards other commands", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-guard-run-"));
  const fakeBin = await fakeCodexDir();
  const guard = await prepareWorkerGuard(stateDir, undefined, guardEnv(fakeBin));
  assert.ok(guard);
  const env = { ...process.env, ...guard.envFor("w-guard-test") };
  const shim = path.join(guard.dir, process.platform === "win32" ? "codex.cmd" : "codex");

  const denied = runShim(shim, ["queue", "--thread", "t-1", "--message", "hello"], env);
  assert.equal(denied.status, 2, "queue is rejected");
  assert.match(denied.stderr, /may not call `codex queue`/);
  const log = await readFile(guard.logPath, "utf8");
  assert.match(log, /codex_queue_denied/);
  assert.match(log, /w-guard-test/);

  const allowed = runShim(shim, ["--version"], env);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /FAKE_CODEX_OK/);
  const args = await readFile(path.join(fakeBin, "args.txt"), "utf8");
  assert.match(args, /--version/, "other subcommands are forwarded unchanged");
});

test("the shim refuses to recurse when the real CLI path is missing", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-guard-missing-"));
  const fakeBin = await fakeCodexDir();
  const guard = await prepareWorkerGuard(stateDir, undefined, guardEnv(fakeBin));
  assert.ok(guard);
  const env = { ...process.env, ...guard.envFor("w-guard-test"), HARNESS_SUPERVISOR_REAL_CODEX: "" };
  const shim = path.join(guard.dir, process.platform === "win32" ? "codex.cmd" : "codex");
  const result = runShim(shim, ["--version"], env);
  assert.equal(result.status, 127);
  assert.match(result.stderr, /misconfigured/);
});