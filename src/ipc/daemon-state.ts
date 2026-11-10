import { open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SupervisorError } from "../errors.js";
import { inspectProcess } from "../util/process.js";
import { ensureDir, readJsonFile } from "../util/fsx.js";
import { randomToken, type EndpointInfo } from "./protocol.js";

export interface DaemonLock {
  path: string;
  pid: number;
  release(): Promise<void>;
}

interface LockInfo {
  pid: number;
  startedAt: string;
  stateDir: string;
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
          const current = await readJsonFile<LockInfo>(lockPath).catch(() => null);
          if (current?.pid === process.pid) {
            await unlink(lockPath).catch(() => undefined);
          }
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
        // A generic "harness-supervisor" token also matches CLI commands for the
        // same state directory; require a daemon-shaped command line as well.
        const commandLine = identity.commandLine;
        const looksLikeDaemon =
          commandLine === null ||
          commandLine.includes("daemon-entry") ||
          /\bdaemon\b/.test(commandLine);
        if (identity.alive && identity.verified !== false && looksLikeDaemon) {
          throw new SupervisorError(
            "INVALID_STATE",
            identity.verified === true
              ? `Another supervisor daemon appears to be running (pid ${existing.pid})`
              : `A live process (pid ${existing.pid}) holds the daemon lock but its identity could not be verified; refusing to recycle the lock`,
            { pid: existing.pid, lockFile: lockPath, pidVerified: identity.verified },
          );
        }
        // verified === false means the PID was reused by an unrelated process;
        // the lock is stale and can be removed without touching a daemon.
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
