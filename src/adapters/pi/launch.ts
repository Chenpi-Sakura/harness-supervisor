import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PiLaunch {
  file: string;
  args: string[];
  description: string;
  /** Per-worker environment override; defaults to the daemon's environment. */
  env?: NodeJS.ProcessEnv;
}

function parseArgsEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HARNESS_SUPERVISOR_PI_ARGS must be a JSON array of strings");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("HARNESS_SUPERVISOR_PI_ARGS must be a JSON array of strings");
  }
  return parsed;
}

function findLauncherOnPath(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("where.exe", ["pi"], { encoding: "utf8", windowsHide: true });
    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate) continue;
      const launcher = path.join(path.dirname(candidate), "pi-launcher.js");
      if (existsSync(launcher)) return launcher;
    }
  } catch {
    // Not on PATH.
  }
  return null;
}

export function resolvePiLaunch(env: NodeJS.ProcessEnv = process.env): PiLaunch {
  const explicitEntry = env.HARNESS_SUPERVISOR_PI_ENTRY;
  if (explicitEntry) {
    const entry = path.resolve(explicitEntry);
    if (!existsSync(entry)) {
      throw new Error(`HARNESS_SUPERVISOR_PI_ENTRY does not exist: ${entry}`);
    }
    return {
      file: process.execPath,
      args: [entry, ...parseArgsEnv(env.HARNESS_SUPERVISOR_PI_ARGS)],
      description: `node ${entry}`,
    };
  }

  const explicitBin = env.HARNESS_SUPERVISOR_PI_BIN;
  if (explicitBin) {
    if (/\.(?:mjs|cjs|js)$/i.test(explicitBin)) {
      return {
        file: process.execPath,
        args: [path.resolve(explicitBin)],
        description: `node ${explicitBin}`,
      };
    }
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(explicitBin)) {
      throw new Error(
        "HARNESS_SUPERVISOR_PI_BIN cannot point at a .cmd/.bat shim. Point it at pi-launcher.js via HARNESS_SUPERVISOR_PI_ENTRY or at a real executable.",
      );
    }
    return {
      file: explicitBin,
      args: parseArgsEnv(env.HARNESS_SUPERVISOR_PI_ARGS),
      description: explicitBin,
    };
  }

  if (process.platform === "win32") {
    const homeLauncher = path.join(os.homedir(), ".pi", "agent", "bin", "pi-launcher.js");
    const launcher = existsSync(homeLauncher) ? homeLauncher : findLauncherOnPath();
    if (launcher) {
      return {
        file: process.execPath,
        args: [launcher, ...parseArgsEnv(env.HARNESS_SUPERVISOR_PI_ARGS)],
        description: `Pi launcher (${launcher})`,
      };
    }
    throw new Error(
      "Could not find Pi on Windows. Install Pi, or set HARNESS_SUPERVISOR_PI_ENTRY to pi-launcher.js / the Pi CLI JS entry.",
    );
  }

  return {
    file: "pi",
    args: parseArgsEnv(env.HARNESS_SUPERVISOR_PI_ARGS),
    description: "pi (PATH)",
  };
}

const RESERVED_ARGS = new Set([
  "--mode",
  "--session",
  "--session-dir",
  "--session-id",
  "--continue",
  "--resume",
  "--print",
  "--help",
  "--no-session",
  "--api-key",
]);

export function validateExtraArgs(extraArgs: string[] | undefined): void {
  if (!extraArgs) return;
  for (const arg of extraArgs) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new Error("extraArgs must be strings without NUL bytes");
    }
    const name = arg.split("=", 1)[0] ?? arg;
    if (RESERVED_ARGS.has(name)) {
      throw new Error(`extraArgs may not override supervisor-managed option ${name}`);
    }
  }
}
