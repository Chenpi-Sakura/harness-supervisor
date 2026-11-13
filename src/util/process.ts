import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
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
 *
 * The command line is not always readable: on Windows a non-elevated user cannot
 * read the `CommandLine` of a process owned by another account (a SYSTEM service),
 * even though the process itself is visible. In that case the process creation
 * time (`startedAt`) still proves that a PID was recycled: a process that was
 * created *after* a recorded timestamp cannot be the process that wrote it.
 */

export interface ProcessIdentity {
  pid: number;
  alive: boolean;
  commandLine: string | null;
  verified: boolean | null;
  /** ISO 8601 (UTC) creation time of the process, or null when it cannot be read. */
  startedAt: string | null;
}

/** Command line and creation time of one process, read with a single query. */
export interface ProcessDetails {
  commandLine: string | null;
  startedAt: string | null;
}

const COMMAND_LINE_TIMEOUT_MS = 5000;
const MAX_COMMAND_LINE_CHARS = 8000;
const MAX_PROCESS_QUERY_CHARS = 64 * 1024;
/** `/proc/<pid>/stat` reports the start time in clock ticks (USER_HZ) since boot. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

export async function readProcessCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const details = await readProcessDetails(pid);
  return details.commandLine;
}

/** Read the command line and the creation time of a process. */
export async function readProcessDetails(pid: number): Promise<ProcessDetails> {
  if (!Number.isInteger(pid) || pid <= 0) return { commandLine: null, startedAt: null };
  if (process.platform === "linux") {
    return {
      commandLine: await readLinuxCommandLine(pid),
      startedAt: await readLinuxStartedAt(pid),
    };
  }
  if (process.platform === "win32") {
    return readWindowsProcessDetails(pid);
  }
  // Other platforms keep the conservative behaviour: no start time available.
  return { commandLine: await runForStdout("ps", ["-o", "command=", "-p", String(pid)]), startedAt: null };
}

export async function inspectProcess(
  pid: number | undefined,
  identityTokens: Array<string | undefined>,
): Promise<ProcessIdentity> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return { pid: pid ?? 0, alive: false, commandLine: null, verified: null, startedAt: null };
  }
  const alive = isPidAlive(pid);
  if (!alive) return { pid, alive: false, commandLine: null, verified: null, startedAt: null };
  const details = await readProcessDetails(pid);
  const commandLine = details.commandLine;
  if (!commandLine) {
    return { pid, alive: true, commandLine: null, verified: null, startedAt: details.startedAt };
  }
  const tokens = identityTokens.filter((token): token is string => Boolean(token && token.length >= 4));
  if (tokens.length === 0) {
    return { pid, alive: true, commandLine, verified: null, startedAt: details.startedAt };
  }
  return {
    pid,
    alive: true,
    commandLine,
    verified: tokens.some((token) => commandLine.includes(token)),
    startedAt: details.startedAt,
  };
}

async function readLinuxCommandLine(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const text = raw.split("\0").join(" ").trim();
    return text ? text.slice(0, MAX_COMMAND_LINE_CHARS) : null;
  } catch {
    return null;
  }
}

/**
 * Start time of a Linux process.
 *
 * `/proc/<pid>/stat` field 22 holds the start time in clock ticks since boot; the
 * elapsed-seconds age of the process follows from the system uptime. This is the
 * numeric equivalent of `ps -o etimes=` and avoids spawning another process in
 * the hot paths that call `inspectProcess`.
 */
async function readLinuxStartedAt(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may contain spaces and parentheses, so the fields
    // after it are located relative to the last closing parenthesis.
    const commandEnd = raw.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
    // Field 3 (state) is the first field after the command name.
    const startTicks = Number.parseInt(fields[19] ?? "", 10);
    if (!Number.isFinite(startTicks)) return null;
    const ageSeconds = os.uptime() - startTicks / LINUX_CLOCK_TICKS_PER_SECOND;
    if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return null;
    return new Date(Date.now() - ageSeconds * 1000).toISOString();
  } catch {
    return null;
  }
}

/**
 * Windows process details.
 *
 * Command line and creation time come from a single CIM query: the command line
 * of a process owned by another account is not readable by a non-elevated user,
 * but its creation time always is.
 */
async function readWindowsProcessDetails(pid: number): Promise<ProcessDetails> {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue | Select-Object -First 1;`,
    `if ($null -eq $p) { '' } else {`,
    `  $started = $null;`,
    `  if ($p.CreationDate) { $started = ([DateTime]$p.CreationDate).ToUniversalTime().ToString('o') };`,
    `  @{ commandLine = $p.CommandLine; startedAt = $started } | ConvertTo-Json -Compress`,
    `}`,
  ].join(" ");
  const raw = await runForStdout("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!raw) return { commandLine: null, startedAt: null };
  let parsed: { commandLine?: unknown; startedAt?: unknown };
  try {
    parsed = JSON.parse(raw) as { commandLine?: unknown; startedAt?: unknown };
  } catch {
    return { commandLine: null, startedAt: null };
  }
  const commandLine =
    typeof parsed.commandLine === "string" && parsed.commandLine.length > 0
      ? parsed.commandLine.slice(0, MAX_COMMAND_LINE_CHARS)
      : null;
  const startedAt = typeof parsed.startedAt === "string" ? normalizeTimestamp(parsed.startedAt) : null;
  return { commandLine, startedAt };
}

/** Normalize a timestamp to an ISO 8601 UTC string, or null when unparsable. */
export function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function runForStdout(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: COMMAND_LINE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const text = String(stdout ?? "").trim();
        resolve(text ? text.slice(0, MAX_PROCESS_QUERY_CHARS) : null);
      },
    );
  });
}
