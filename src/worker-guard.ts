import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./util/logger.js";

/**
 * Worker command guard.
 *
 * `codex queue` lets any process inject a message into a Codex conversation.
 * A worker has the same OS user as the supervisor, so this cannot be a security
 * boundary. What it can do cheaply is make the unsupported path fail loudly for
 * the normal case: prepend a shim directory to the *worker's* PATH only, deny
 * the `queue` subcommand, and forward every other subcommand to the real CLI.
 *
 * Bypasses stay possible (absolute path, another host API, a different shell
 * that ignores PATH, a worker that removes the shim). HS does not claim more.
 */
export const WORKER_GUARD_SETTING = "HARNESS_SUPERVISOR_WORKER_GUARD";
export const GUARD_DENIAL_LOG = "worker-guard.jsonl";

export interface WorkerGuard {
  readonly dir: string;
  readonly realBin: string;
  readonly logPath: string;
  /** Environment additions for one worker process; never the daemon's own env. */
  envFor(workerId: string): NodeJS.ProcessEnv;
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** PATH lookup that never returns a shim from the guard directory itself. */
function findOnPath(name: string, env: NodeJS.ProcessEnv, guardDir: string): string[] {
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const found: string[] = [];
  const extensions =
    process.platform === "win32"
      ? /\.(?:exe|cmd|bat)$/i.test(name)
        ? [""]
        : [".exe", ".cmd", ".bat"]
      : [""];
  for (const entry of entries) {
    if (samePath(entry, guardDir) || samePath(entry, path.dirname(guardDir))) continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      if (isFile(candidate)) found.push(candidate);
    }
  }
  return found;
}

/**
 * Resolve the real `codex` executable. An explicit HARNESS_SUPERVISOR_CODEX_BIN
 * wins (the same override notification delivery uses); otherwise PATH decides.
 */
export function resolveRealCodex(
  env: NodeJS.ProcessEnv = process.env,
  guardDir?: string,
): string | null {
  const explicit = env.HARNESS_SUPERVISOR_CODEX_BIN?.trim();
  if (explicit) {
    if (explicit.includes("/") || explicit.includes("\\")) {
      const resolved = path.resolve(explicit);
      return isFile(resolved) ? resolved : null;
    }
    const viaPath = guardDir ? findOnPath(explicit, env, guardDir) : [];
    return viaPath[0] ?? null;
  }
  const viaPath = guardDir ? findOnPath("codex", env, guardDir) : [];
  return viaPath[0] ?? null;
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (readFileSync(file, "utf8") === content) return;
  } catch {
    // Missing or unreadable: write it.
  }
  writeFileSync(file, content);
}

function writeShims(dir: string): void {
  const guard = fileURLToPath(new URL("./codex-guard.js", import.meta.url));
  const node = process.execPath;
  writeIfChanged(
    path.join(dir, "codex.cmd"),
    `@echo off\r\n"${node}" "${guard}" %*\r\n`,
  );
  const shell = path.join(dir, "codex");
  writeIfChanged(shell, `#!/bin/sh\nexec "${node}" "${guard}" "$@"\n`);
  try {
    chmodSync(shell, 0o755);
  } catch {
    // Windows ignores the mode bit.
  }
  writeIfChanged(
    path.join(dir, "codex.ps1"),
    `& "${node}" "${guard}" @args\nexit $LASTEXITCODE\n`,
  );
}

/**
 * Create (or refresh) the per-state-directory shim. Returns null when the
 * guard is disabled, the Codex CLI is absent, or the directory cannot be
 * written: a guard failure must never prevent workers from starting.
 */
export async function prepareWorkerGuard(
  stateDir: string,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkerGuard | null> {
  if (env[WORKER_GUARD_SETTING] === "0") return null;
  const root = path.join(stateDir, "worker-guard");
  const bin = path.join(root, "bin");
  const realBin = resolveRealCodex(env, bin);
  if (!realBin) {
    logger?.info("Worker command guard not installed: codex CLI not found on PATH");
    return null;
  }
  try {
    mkdirSync(bin, { recursive: true });
    writeShims(bin);
  } catch (error) {
    logger?.warn("Worker command guard not installed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const logPath = path.join(root, GUARD_DENIAL_LOG);
  return {
    dir: bin,
    realBin,
    logPath,
    envFor(workerId: string): NodeJS.ProcessEnv {
      return {
        PATH: `${bin}${path.delimiter}${env.PATH ?? ""}`,
        HARNESS_SUPERVISOR_WORKER_ID: workerId,
        HARNESS_SUPERVISOR_REAL_CODEX: realBin,
        HARNESS_SUPERVISOR_GUARD_LOG: logPath,
        [WORKER_GUARD_SETTING]: "1",
      };
    },
  };
}