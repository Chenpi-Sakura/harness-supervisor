import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupervisorError } from "../../src/errors.js";
import {
  acquireDaemonLock,
  describeLockRefusal,
  evaluateLockHolder,
  isPidReuse,
  PID_REUSE_TOLERANCE_MS,
} from "../../src/ipc/daemon-state.js";
import type { ProcessIdentity } from "../../src/util/process.js";

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

function identity(overrides: Partial<ProcessIdentity> & { pid: number }): ProcessIdentity {
  return {
    alive: true,
    commandLine: null,
    verified: null,
    startedAt: null,
    ...overrides,
  };
}

/**
 * Real world incident (Windows): the HS daemon 0.10.4 wrote the lock at
 * 06:48:43.917Z and died two seconds later. Nineteen seconds later Windows reused
 * the PID for a SYSTEM service whose command line a non-elevated user cannot
 * read, but whose creation time is readable.
 */
const RECYCLED_LOCK = { pid: 25896, startedAt: "2026-11-12T06:48:43.917Z" };
const RECYCLED_HOLDER = identity({
  pid: 25896,
  commandLine: null,
  verified: null,
  startedAt: "2026-11-12T06:49:02.000Z",
});

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

test("a lock held by a PID recycled after the lock was written is stale", () => {
  const decision = evaluateLockHolder(RECYCLED_LOCK, RECYCLED_HOLDER);
  assert.equal(decision.outcome, "recycle");
  assert.equal(decision.reason, "pid-reused");
});

test("a live daemon-shaped process that started before the lock was written is refused", () => {
  const decision = evaluateLockHolder(
    { pid: 4242, startedAt: "2026-11-12T06:48:43.917Z" },
    identity({
      pid: 4242,
      commandLine: "node C:\\hs\\dist\\src\\daemon-entry.js --state-dir C:\\hs-state",
      verified: true,
      startedAt: "2026-11-12T06:48:43.500Z",
    }),
  );
  assert.equal(decision.outcome, "refuse");
  assert.equal(decision.reason, "live-daemon");
});

test("a verified daemon is never treated as a recycled PID", () => {
  const decision = evaluateLockHolder(
    { pid: 4242, startedAt: "2026-11-12T06:48:43.917Z" },
    identity({
      pid: 4242,
      commandLine: "node C:\\hs\\dist\\src\\daemon-entry.js --state-dir C:\\hs-state",
      verified: true,
      startedAt: "2026-11-12T07:00:00.000Z",
    }),
  );
  assert.equal(decision.outcome, "refuse");
  assert.equal(decision.reason, "live-daemon");
});

test("an unverifiable holder without a start time is still refused", () => {
  const decision = evaluateLockHolder(
    { pid: 4242, startedAt: "2026-11-12T06:48:43.917Z" },
    identity({ pid: 4242, commandLine: null, verified: null, startedAt: null }),
  );
  assert.equal(decision.outcome, "refuse");
  assert.equal(decision.reason, "unverifiable-holder");
});

test("a lock without a start time is still refused", () => {
  const decision = evaluateLockHolder(
    { pid: 4242 },
    identity({ pid: 4242, commandLine: null, verified: null, startedAt: "2026-11-12T06:49:02.000Z" }),
  );
  assert.equal(decision.outcome, "refuse");
  assert.equal(decision.reason, "unverifiable-holder");
});

test("a holder that started inside the tolerance window is still refused", () => {
  const lockStartedAt = "2026-11-12T06:48:43.917Z";
  const decision = evaluateLockHolder(
    { pid: 4242, startedAt: lockStartedAt },
    identity({
      pid: 4242,
      commandLine: null,
      verified: null,
      startedAt: new Date(
        Date.parse(lockStartedAt) + PID_REUSE_TOLERANCE_MS - 500,
      ).toISOString(),
    }),
  );
  assert.equal(decision.outcome, "refuse");
  assert.equal(decision.reason, "unverifiable-holder");
});

test("a dead holder is reported as such", () => {
  const decision = evaluateLockHolder(
    { pid: 4242, startedAt: "2026-11-12T06:48:43.917Z" },
    identity({ pid: 4242, alive: false, commandLine: null, verified: null, startedAt: null }),
  );
  assert.equal(decision.outcome, "dead-holder");
});

test("a readable command line without daemon tokens is not the daemon", () => {
  const decision = evaluateLockHolder(
    { pid: 4242, startedAt: "2026-11-12T06:48:43.917Z" },
    identity({
      pid: 4242,
      commandLine: "C:\\Program Files\\clash\\clash-verge-service.exe",
      verified: false,
      startedAt: "2026-11-12T06:40:00.000Z",
    }),
  );
  assert.equal(decision.outcome, "recycle");
  assert.equal(decision.reason, "pid-reused");
});

test("PID reuse detection needs two comparable timestamps", () => {
  assert.equal(isPidReuse("2026-11-12T06:48:43.917Z", "2026-11-12T06:49:02.000Z"), true);
  assert.equal(isPidReuse("2026-11-12T06:48:43.917Z", "2026-11-12T06:48:43.917Z"), false);
  assert.equal(isPidReuse("2026-11-12T06:48:43.917Z", null), false);
  assert.equal(isPidReuse(null, "2026-11-12T06:49:02.000Z"), false);
  assert.equal(isPidReuse(undefined, undefined), false);
  assert.equal(isPidReuse("not-a-date", "2026-11-12T06:49:02.000Z"), false);
});

test("the refusal message names the lock file and the recovery step", () => {
  const lockPath = path.join(os.tmpdir(), "hs-state", "daemon.lock");
  const live = describeLockRefusal({ pid: 4242, reason: "live-daemon" }, lockPath);
  assert.match(live, /another supervisor daemon/i);
  assert.ok(live.includes(lockPath), `the lock path is missing: ${live}`);
  assert.match(live, /remove the lock file/i);

  const unverifiable = describeLockRefusal({ pid: 4242, reason: "unverifiable-holder" }, lockPath);
  assert.match(unverifiable, /could not be verified/i);
  assert.ok(unverifiable.includes(lockPath), `the lock path is missing: ${unverifiable}`);
  assert.match(unverifiable, /remove the lock file/i);
});

test("the lock refusal names the lock file", async () => {
  const stateDir = await tempDir("hs-lock-refusal-message-");
  const child = await startChild([
    "-e",
    "setInterval(()=>{},1000)",
    "daemon-entry",
    stateDir,
  ]);
  const lockPath = path.join(stateDir, "daemon.lock");
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
        error.message.includes(lockPath),
    );
  } finally {
    await stopChild(child);
    await rm(lockPath, { force: true });
  }
});

interface UnreadableHolder {
  pid: number;
  startedAt: string;
}

/**
 * Find a live Windows process whose command line cannot be read by a non-elevated
 * user (a process owned by another account) but whose creation time is readable.
 * This is the real world shape of the incident: the PID was recycled by such a
 * process and the daemon could no longer start.
 */
async function findUnreadableHolder(): Promise<UnreadableHolder | null> {
  if (process.platform !== "win32") return null;
  const script = [
    "$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue;",
    "$p = $all | Where-Object { $null -ne $_.CreationDate -and [string]::IsNullOrEmpty($_.CommandLine) } | Sort-Object CreationDate | Select-Object -First 1;",
    "if ($null -eq $p) { '' } else { @{ pid = $p.ProcessId; startedAt = ([DateTime]$p.CreationDate).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }",
  ].join(" ");
  const raw = await new Promise<string | null>((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout ?? "").trim());
      },
    );
  });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { pid?: number; startedAt?: string };
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (typeof parsed.startedAt !== "string") return null;
    return { pid: parsed.pid as number, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

test("a lock whose PID was recycled by a process with an unreadable command line is recycled", async (t) => {
  const holder = await findUnreadableHolder();
  if (!holder) {
    t.skip("no Windows process with an unreadable command line is available");
    return;
  }
  const stateDir = await tempDir("hs-lock-windows-reuse-");
  // The lock was written an hour before the current holder was created, so the
  // PID cannot belong to the daemon that wrote the lock.
  await writeLock(stateDir, {
    pid: holder.pid,
    startedAt: new Date(Date.parse(holder.startedAt) - 3600_000).toISOString(),
    stateDir,
  });
  const lock = await acquireDaemonLock(stateDir);
  assert.equal(JSON.parse(await readFile(lock.path, "utf8")).pid, process.pid);
  await lock.release();
});

test("a lock that may still belong to a live holder is refused", async (t) => {
  const holder = await findUnreadableHolder();
  if (!holder) {
    t.skip("no Windows process with an unreadable command line is available");
    return;
  }
  const stateDir = await tempDir("hs-lock-windows-refuse-");
  const lockPath = path.join(stateDir, "daemon.lock");
  // The lock was written an hour after the current holder was created, so the
  // holder may be the daemon itself: the lock must not be recycled.
  await writeLock(stateDir, {
    pid: holder.pid,
    startedAt: new Date(Date.parse(holder.startedAt) + 3600_000).toISOString(),
    stateDir,
  });
  try {
    await assert.rejects(
      () => acquireDaemonLock(stateDir),
      (error: unknown) =>
        error instanceof SupervisorError &&
        error.code === "INVALID_STATE" &&
        error.message.includes(lockPath),
    );
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, holder.pid);
  } finally {
    await rm(lockPath, { force: true });
  }
});
