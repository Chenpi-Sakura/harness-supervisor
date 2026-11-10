import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupervisorError } from "../../src/errors.js";
import { acquireDaemonLock } from "../../src/ipc/daemon-state.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function startChild(args: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function writeLock(stateDir: string, info: object): Promise<void> {
  await writeFile(path.join(stateDir, "daemon.lock"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

test("acquire writes a lock and release removes only its own lock", async () => {
  const stateDir = await tempDir("hs-lock-basic-");
  const lock = await acquireDaemonLock(stateDir);
  const raw = JSON.parse(await readFile(lock.path, "utf8"));
  assert.equal(raw.pid, process.pid);
  await lock.release();
  await assert.rejects(() => access(lock.path), /ENOENT/);
});

test("a stale lock whose PID is dead is recycled", async () => {
  const stateDir = await tempDir("hs-lock-dead-");
  const child = await startChild(["-e", "setTimeout(()=>{},5000)"]);
  const deadPid = child.pid!;
  await stopChild(child);
  await writeLock(stateDir, { pid: deadPid, startedAt: new Date().toISOString(), stateDir });

  const lock = await acquireDaemonLock(stateDir);
  assert.equal(JSON.parse(await readFile(lock.path, "utf8")).pid, process.pid);
  await lock.release();
});

test("a live PID that does not match the daemon identity is a reused PID", async () => {
  const stateDir = await tempDir("hs-lock-reused-");
  const unrelatedState = path.join(stateDir, "unrelated-state-marker");
  const child = await startChild(["-e", "setInterval(()=>{},1000)"]);
  try {
    await writeLock(stateDir, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      stateDir: unrelatedState,
    });
    const lock = await acquireDaemonLock(stateDir);
    assert.equal(JSON.parse(await readFile(lock.path, "utf8")).pid, process.pid);
    await lock.release();
  } finally {
    await stopChild(child);
  }
});

test("a live process whose command line matches the lock cannot be recycled", async () => {
  const stateDir = await tempDir("hs-lock-live-");
  const child = await startChild([
    "-e",
    "setInterval(()=>{},1000)",
    "daemon-entry",
    stateDir,
  ]);
  try {
    await writeLock(stateDir, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      stateDir,
    });
    await assert.rejects(
      () => acquireDaemonLock(stateDir),
      (error: unknown) =>
        error instanceof SupervisorError &&
        error.code === "INVALID_STATE" &&
        /another supervisor daemon/i.test(error.message),
    );
    assert.equal(JSON.parse(await readFile(path.join(stateDir, "daemon.lock"), "utf8")).pid, child.pid);
  } finally {
    await stopChild(child);
    await rm(path.join(stateDir, "daemon.lock"), { force: true });
  }
});

test("an unreadable lock is not recycled", async () => {
  const stateDir = await tempDir("hs-lock-corrupt-");
  const lockPath = path.join(stateDir, "daemon.lock");
  await writeFile(lockPath, "not-json\n", "utf8");
  await assert.rejects(
    () => acquireDaemonLock(stateDir),
    (error: unknown) =>
      error instanceof SupervisorError &&
      error.code === "INVALID_STATE" &&
      /unreadable/i.test(error.message),
  );
  assert.equal(await readFile(lockPath, "utf8"), "not-json\n");
  await rm(lockPath, { force: true });
});
