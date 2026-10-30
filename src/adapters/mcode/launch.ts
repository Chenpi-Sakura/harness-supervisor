import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SupervisorError } from "../../errors.js";

export interface McodeLaunch {
  file: string;
  args: string[];
  description: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Options the supervisor manages itself. A caller may not smuggle them in
 * through extraArgs, otherwise the recorded runtime command would not match
 * what actually ran.
 */
const RESERVED_ARGS = new Set([
  "acp",
  "exec",
  "review",
  "login",
  "logout",
  "update",
  "init",
  "app-server",
  "--session",
  "--continue",
  "-c",
  "--model",
  "-m",
  "--effort",
  "--mode",
  "--cwd",
  "--config",
  "--permission",
  "--timeout",
  "--max-steps",
  "--output-format",
  "--output-schema",
  "--output-last-message",
  "-o",
  "--input",
  "--input-format",
  "--file",
  "--prompt-mode",
  "--system-prompt",
  "--system-prompt-file",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--diagnostics-dir",
  "--version",
  "-V",
  "--help",
  "-h",
]);

/**
 * MiniMax Code ships `mcode`/`mcode-tools` as npm bin shims. On Windows those
 * are `.cmd`/`.ps1` wrappers, and Node refuses to spawn them directly
 * (`spawn EINVAL` since the CVE-2024-27980 hardening). The reliable entry is
 * the package's own `cli.js`, launched with the current Node binary.
 */
export function findMcodePackageEntry(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  const explicit = env.HARNESS_SUPERVISOR_MCODE_ENTRY;
  if (explicit) candidates.push(path.resolve(explicit));

  // The standalone MiniMax Code installer keeps releases under
  // ~/.minimax-code and records the active version in `current`. Its entries
  // are not on the npm global prefix, so they need this separate check.
  const home = env.USERPROFILE ?? env.HOME;
  if (home) {
    const installRoot = path.join(home, ".minimax-code");
    try {
      const version = readFileSync(path.join(installRoot, "current"), "utf8").trim();
      if (/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
        candidates.push(
          path.join(
            installRoot,
            "releases",
            version,
            "node_modules",
            "@minimax-ai",
            "code",
            "cli.js",
          ),
        );
      }
    } catch {
      // No standalone install metadata; continue with the npm candidates.
    }
    candidates.push(
      path.join(installRoot, "node_modules", "@minimax-ai", "code", "cli.js"),
    );
  }

  const globalRoot = env.npm_config_prefix ?? env.APPDATA
    ? path.join(
        (env.npm_config_prefix ?? path.join(env.APPDATA ?? "", "npm")) as string,
        "node_modules",
        "@minimax-ai",
        "code",
        "cli.js",
      )
    : "";
  if (globalRoot) candidates.push(globalRoot);

  if (env.APPDATA) {
    candidates.push(
      path.join(env.APPDATA, "npm", "node_modules", "@minimax-ai", "code", "cli.js"),
    );
  }
  if (env.HOME) {
    candidates.push(
      path.join(env.HOME, ".npm-global", "lib", "node_modules", "@minimax-ai", "code", "cli.js"),
    );
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function findMcodeBinOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const output = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["mcode"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      if (process.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(candidate)) continue;
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Not on PATH.
  }
  return null;
}

/**
 * Reads the `bin` field of an installed `@minimax-ai/code` package so the
 * adapter launches the same entry point the user's shell would.
 */
export function readMcodeBinEntry(packageJsonPath: string): string | null {
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { bin?: string | Record<string, string> };
    const bin = typeof parsed.bin === "string" ? parsed.bin : parsed.bin?.mcode;
    if (!bin) return null;
    const entry = path.resolve(path.dirname(packageJsonPath), bin);
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

export function validateMcodeExtraArgs(extraArgs: string[] | undefined): void {
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

export const MCODE_PERMISSION_MODES = ["bypassPermissions", "auto", "default"] as const;

export const MCODE_DEFAULT_PERMISSION_MODE: McodePermissionMode = "bypassPermissions";

export type McodePermissionMode = (typeof MCODE_PERMISSION_MODES)[number];

/**
 * Resolves the permission mode for a MiniMax Code worker.
 *
 * MiniMax Code itself defaults to `bypassPermissions`. HS keeps that native
 * full-permission default (the user explicitly authorized full execution) and
 * only switches to Ask/auto when explicitly configured, so normal file and
 * command work does not become an approval prompt.
 */
export function resolveMcodePermissionMode(
  env: NodeJS.ProcessEnv = process.env,
): McodePermissionMode {
  const raw = env.HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE?.trim();
  if (!raw) return MCODE_DEFAULT_PERMISSION_MODE;
  const normalized = raw.replace(/-/g, "").toLowerCase();
  const match = MCODE_PERMISSION_MODES.find((mode) => mode.toLowerCase() === normalized);
  if (!match) {
    throw new SupervisorError(
      "BAD_REQUEST",
      `Unsupported MiniMax Code permission mode: ${raw}. Allowed: ${MCODE_PERMISSION_MODES.join(", ")} (default: ${MCODE_DEFAULT_PERMISSION_MODE}).`,
    );
  }
  return match;
}

export function resolveMcodeLaunch(env: NodeJS.ProcessEnv = process.env): McodeLaunch {
  const childEnv: NodeJS.ProcessEnv = { ...env };

  const explicitEntry = env.HARNESS_SUPERVISOR_MCODE_ENTRY;
  if (explicitEntry) {
    const entry = path.resolve(explicitEntry);
    if (!existsSync(entry)) {
      throw new Error(`HARNESS_SUPERVISOR_MCODE_ENTRY does not exist: ${entry}`);
    }
    return {
      file: process.execPath,
      args: [entry, "acp"],
      description: `node ${entry} acp`,
      env: childEnv,
    };
  }

  const packageEntry = findMcodePackageEntry(env);
  if (packageEntry) {
    return {
      file: process.execPath,
      args: [packageEntry, "acp"],
      description: `node ${packageEntry} acp`,
      env: childEnv,
    };
  }

  const onPath = findMcodeBinOnPath(env);
  if (onPath) {
    return {
      file: onPath,
      args: ["acp"],
      description: `mcode (${onPath}) acp`,
      env: childEnv,
    };
  }

  throw new SupervisorError(
    "UNSUPPORTED",
    "Could not find MiniMax Code. Install it with `npm install -g @minimax-ai/code`, or set HARNESS_SUPERVISOR_MCODE_ENTRY to the package cli.js.",
    {},
  );
}
