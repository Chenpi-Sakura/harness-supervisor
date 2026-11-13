import { readFileSync, unlinkSync } from "node:fs";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "../errors.js";
import { inspectProcess, normalizeTimestamp, type ProcessIdentity } from "../util/process.js";
import { ensureDir, readJsonFile } from "../util/fsx.js";
import { randomToken, type EndpointInfo } from "./protocol.js";

export interface DaemonLock {
  path: string;
  pid: number;
  release(): Promise<void>;
}

interface LockInfo {
  pid: number;
  /** ISO 8601 timestamp of the moment the lock was written; missing in very old locks. */
  startedAt?: string;
  stateDir: string;
}

/**
 * Tolerance for the start-time comparison. The process creation time and the
 * lock timestamp come from different clocks with a coarse resolution, so a small
 * window is required before a later creation time counts as proof of PID reuse.
 */
export const PID_REUSE_TOLERANCE_MS = 2000;

/** The lock file that has to be judged. */
export interface LockHolderLock {
  pid: number;
  startedAt?: string | null;
}

/**
 * Decision about the process that currently holds the lock file:
 *
 * - `dead-holder`    -> the PID is gone, the lock is stale;
 * - `recycle`        -> the PID provably belongs to another process, the lock is stale;
 * - `refuse`         -> the PID may still be the daemon, keep the lock.
 */
export type LockHolderDecision =
  | { outcome: "dead-holder"; pid: number }
  | { outcome: "recycle"; pid: number; reason: "pid-reused" | "not-a-daemon" }
  | { outcome: "refuse"; pid: number; reason: "live-daemon" | "unverifiable-holder" };

/**
 * Pure decision helper for the daemon lock.
 *
 * The decision only depends on the recorded lock and the observed process
 * identity, so it can be unit tested with the exact shape of a real world
 * incident (unreadable command line, PID recycled by an unrelated process).
 */
export function evaluateLockHolder(
  existing: LockHolderLock,
  identity: ProcessIdentity,
): LockHolderDecision {
  const pid = existing.pid;
  if (!identity.alive) return { outcome: "dead-holder", pid };
  // verified === false means the PID was reused by an unrelated process;
  // the lock is stale and can be removed without touching a daemon.
  if (identity.verified === false) return { outcome: "recycle", pid, reason: "pid-reused" };
  // A generic "harness-supervisor" token also matches CLI commands for the same
  // state directory; require a daemon-shaped command line as well.
  const commandLine = identity.commandLine;
  const looksLikeDaemon =
    commandLine === null ||
    commandLine.includes("daemon-entry") ||
    /\bdaemon\b/.test(commandLine);
  if (!looksLikeDaemon) return { outcome: "recycle", pid, reason: "not-a-daemon" };
  // The holder looks like a daemon. When the command line could not be read the
  // identity stays unverified, but the creation time still proves PID reuse: a
  // process created after the lock was written cannot be the daemon that wrote it.
  if (isPidReuse(existing.startedAt, identity.startedAt)) {
    return { outcome: "recycle", pid, reason: "pid-reused" };
  }
  return {
    outcome: "refuse",
    pid,
    reason: identity.verified === true ? "live-daemon" : "unverifiable-holder",
  };
}

/**
 * True when the live process was created after the lock was written, which proves
 * that the PID was recycled. Unavailable or unparsable timestamps never prove reuse.
 */
export function isPidReuse(
  lockStartedAt: string | null | undefined,
  processStartedAt: string | null | undefined,
): boolean {
  const lock = normalizeTimestamp(lockStartedAt);
  const started = normalizeTimestamp(processStartedAt);
  if (!lock || !started) return false;
  return Date.parse(started) > Date.parse(lock) + PID_REUSE_TOLERANCE_MS;
}

/** Actionable error message for a lock that must not be recycled. */
export function describeLockRefusal(
  decision: { pid: number; reason: "live-daemon" | "unverifiable-holder" },
  lockPath: string,
): string {
  const hint = `If no supervisor daemon is running, stop that process and remove the lock file ${lockPath} before starting a new daemon.`;
  if (decision.reason === "live-daemon") {
    return `Another supervisor daemon appears to be running (pid ${decision.pid}) and holds the lock file ${lockPath}. ${hint}`;
  }
  return `A live process (pid ${decision.pid}) holds the daemon lock ${lockPath} but its identity could not be verified; refusing to recycle the lock. ${hint}`;
}

/**
 * Release the daemon lock synchronously.
 *
 * The daemon exit handler runs after the event loop is gone, so it may only do
 * synchronous work. The lock is removed only when it still carries the given
 * pid, so a lock that another daemon has taken over is never deleted. Every
 * error is swallowed: a missing, unreadable or corrupt lock file must never
 * break the exit path.
 */
export function releaseDaemonLockSync(lockPath: string, pid: number): void {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const current = JSON.parse(raw) as LockInfo | null;
    if (!current || current.pid !== pid) return;
    unlinkSync(lockPath);
  } catch {
    // The lock is missing, unreadable or corrupt: there is nothing to release.
  }
}

export async function acquireDaemonLock(stateDir: string): Promise<DaemonLock> {
  await ensureDir(stateDir);
  const lockPath = path.join(stateDir, "daemon.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const info: LockInfo = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        stateDir,
      };
      await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, "utf8");
      await handle.close();
      return {
        path: lockPath,
        pid: process.pid,
        async release() {
          releaseDaemonLockSync(lockPath, process.pid);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raw = await readFile(lockPath, "utf8").catch(() => null);
      let existing: LockInfo | null = null;
      try {
        existing = raw ? (JSON.parse(raw) as LockInfo) : null;
      } catch {
        existing = null;
      }
      if (!existing || !Number.isInteger(existing.pid) || existing.pid <= 0) {
        // A corrupt lock may be mid-write by the owning daemon. Recycling it
        // here could start a second daemon on the same state directory.
        throw new SupervisorError(
          "INVALID_STATE",
          `The daemon lock is unreadable (${lockPath}). Confirm no supervisor daemon is running before removing it.`,
          { lockFile: lockPath },
        );
      }
      if (existing.pid !== process.pid) {
        const identity = await inspectProcess(existing.pid, [
          existing.stateDir ?? stateDir,
          "daemon-entry",
        ]);
        const decision = evaluateLockHolder(existing, identity);
        if (decision.outcome === "refuse") {
          throw new SupervisorError(
            "INVALID_STATE",
            describeLockRefusal(decision, lockPath),
            { pid: existing.pid, lockFile: lockPath, pidVerified: identity.verified },
          );
        }
        // The lock holder is dead or provably a different process: the lock is
        // stale and can be removed without touching a daemon.
      }
      // Do not unlink a lock that another starter replaced while we inspected
      // it; retry the exclusive create instead.
      const currentRaw = await readFile(lockPath, "utf8").catch(() => null);
      if (currentRaw !== raw) continue;
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new SupervisorError("INTERNAL", "Could not acquire the supervisor daemon lock");
}

export async function ensureIpcToken(stateDir: string): Promise<string> {
  await ensureDir(stateDir);
  const tokenFile = path.join(stateDir, "ipc.token");
  try {
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (token.length >= 32) return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomToken();
  try {
    await writeFile(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return (await readFile(tokenFile, "utf8")).trim();
    }
    throw error;
  }
}

export async function readIpcToken(stateDir: string): Promise<string | null> {
  try {
    const token = (await readFile(path.join(stateDir, "ipc.token"), "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function writeEndpointInfo(stateDir: string, info: EndpointInfo): Promise<void> {
  await ensureDir(stateDir);
  await writeFile(path.join(stateDir, "endpoint.json"), `${JSON.stringify(info, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function removeEndpointInfoIfOwned(stateDir: string): Promise<void> {
  const file = path.join(stateDir, "endpoint.json");
  const current = await readJsonFile<EndpointInfo>(file).catch(() => null);
  if (current?.pid === process.pid) {
    await unlink(file).catch(() => undefined);
  }
}
