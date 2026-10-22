import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isPidAlive } from "./async.js";

/**
 * PID reuse protection without a native addon.
 *
 * A PID that is still alive is not proof that it is *our* harness process. After a
 * daemon restart we therefore compare the live process command line with tokens
 * that are unique to the worker (worker id, session id, session file). The result
 * is deliberately tri-state:
 *
 * - `verified: true`  -> one of the expected tokens is present;
 * - `verified: false` -> the PID belongs to a different process (PID reuse);
 * - `verified: null`  -> the command line could not be read; stay conservative and
 *                        keep the old "no live control channel" semantics.
 */

export interface ProcessIdentity {
  pid: number;
  alive: boolean;
  commandLine: string | null;
  verified: boolean | null;
}

const COMMAND_LINE_TIMEOUT_MS = 5000;
const MAX_COMMAND_LINE_CHARS = 8000;

export async function readProcessCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
      const text = raw.split("\0").join(" ").trim();
      return text ? text.slice(0, MAX_COMMAND_LINE_CHARS) : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    return runForStdout("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue).CommandLine`,
    ]);
  }
  return runForStdout("ps", ["-o", "command=", "-p", String(pid)]);
}

export async function inspectProcess(
  pid: number | undefined,
  identityTokens: Array<string | undefined>,
): Promise<ProcessIdentity> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return { pid: pid ?? 0, alive: false, commandLine: null, verified: null };
  }
  const alive = isPidAlive(pid);
  if (!alive) return { pid, alive: false, commandLine: null, verified: null };
  const commandLine = await readProcessCommandLine(pid);
  if (!commandLine) return { pid, alive: true, commandLine: null, verified: null };
  const tokens = identityTokens.filter((token): token is string => Boolean(token && token.length >= 4));
  if (tokens.length === 0) return { pid, alive: true, commandLine, verified: null };
  return { pid, alive: true, commandLine, verified: tokens.some((token) => commandLine.includes(token)) };
}

function runForStdout(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: COMMAND_LINE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const text = String(stdout ?? "").trim();
        resolve(text ? text.slice(0, MAX_COMMAND_LINE_CHARS) : null);
      },
    );
  });
}