import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SupervisorError } from "../../errors.js";

export interface QoderLaunch {
  file: string;
  args: string[];
  description: string;
  env: NodeJS.ProcessEnv;
}

export const QODER_PERMISSION_MODES = [
  // Qoder CLI 1.1.79 advertises exactly these three values for
  // --permission-mode. The legacy values below are kept for older CLI builds
  // and explicit configuration; an unsupported value is rejected by the CLI at
  // startup instead of being silently mapped to another mode.
  "bypass_permissions",
  "auto",
  "dont_ask",
  "accept_edits",
  "default",
  "plan",
] as const;

export const QODER_DEFAULT_PERMISSION_MODE: QoderPermissionMode = "bypass_permissions";

/**
 * Qoder accepts snake_case on the command line but reports camelCase in its
 * system/init record (`bypass_permissions` -> `bypassPermissions`). Compare the
 * normalized form so a confirmed mode is not mistaken for a downgrade.
 */
export function sameQoderPermissionMode(a: string, b: string): boolean {
  return a.replace(/[_-]/g, "").toLowerCase() === b.replace(/[_-]/g, "").toLowerCase();
}

export type QoderPermissionMode = (typeof QODER_PERMISSION_MODES)[number];

// The desktop host injects these into every shell it starts. Leaving the SDK
// entrypoint in place makes qodercli demand an SDK auth payload and reject a
// normal interactive-login child process.
const HOST_INJECTED_VARS = [
  "QODER_AGENT_SDK_ENTRYPOINT",
  "QODER_AGENT_SDK_VERSION",
  "QODER_SDK_AUTH_PAYLOAD_FILE",
  "QODER_WORKER_CWD",
  "QODER_WORKER_RUNTIME_ASSET_ROOT",
  "QODERCN_SESSION_TYPE",
];

const RESERVED_ARGS = new Set([
  "-p",
  "--print",
  "-o",
  "--output-format",
  "--input-format",
  "--session-id",
  "-r",
  "--resume",
  "-c",
  "--continue",
  "--fork-session",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--yolo",
  "--permission-prompt-tool",
  "-m",
  "--model",
  "--tools",
  "--allowed-tools",
  "--disallowed-tools",
  "--mcp-config",
  "--strict-mcp-config",
  "--config-dir",
  "--no-session-persistence",
  "-w",
  "--cwd",
  "--settings",
  "--setting-sources",
  "--remote",
  "--remote-session",
  "--remote-control",
  "--teleport",
  "--worktree",
]);

function parseArgsEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HARNESS_SUPERVISOR_QODER_ARGS must be a JSON array of strings");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("HARNESS_SUPERVISOR_QODER_ARGS must be a JSON array of strings");
  }
  return parsed;
}

function findQoderOnPath(): string | null {
  try {
    const output = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["qodercli"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(candidate)) continue;
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Not on PATH.
  }
  return null;
}

export function sanitizeQoderEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of HOST_INJECTED_VARS) delete clean[key];
  return clean;
}

export function resolveQoderPermissionMode(
  env: NodeJS.ProcessEnv = process.env,
): QoderPermissionMode {
  const raw = env.HARNESS_SUPERVISOR_QODER_PERMISSION_MODE?.trim();
  if (!raw) return QODER_DEFAULT_PERMISSION_MODE;
  const normalized = raw.replace(/-/g, "_").toLowerCase();
  if (normalized === "bypass" || normalized === "yolo") return "bypass_permissions";
  if (normalized === "accept" || normalized === "acceptedits") return "accept_edits";
  if (normalized === "dontask") return "dont_ask";
  if ((QODER_PERMISSION_MODES as readonly string[]).includes(normalized)) {
    return normalized as QoderPermissionMode;
  }
  throw new SupervisorError(
    "BAD_REQUEST",
    `Unsupported Qoder permission mode: ${raw}. Allowed: ${QODER_PERMISSION_MODES.join(", ")} (default: ${QODER_DEFAULT_PERMISSION_MODE}).`,
  );
}

export function validateQoderExtraArgs(extraArgs: string[] | undefined): void {
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

export function resolveQoderLaunch(env: NodeJS.ProcessEnv = process.env): QoderLaunch {
  const childEnv = sanitizeQoderEnv(env);
  const explicitEntry = env.HARNESS_SUPERVISOR_QODER_ENTRY;
  if (explicitEntry) {
    const entry = path.resolve(explicitEntry);
    if (!existsSync(entry)) {
      throw new Error(`HARNESS_SUPERVISOR_QODER_ENTRY does not exist: ${entry}`);
    }
    return {
      file: process.execPath,
      args: [entry, ...parseArgsEnv(env.HARNESS_SUPERVISOR_QODER_ARGS)],
      description: `node ${entry}`,
      env: childEnv,
    };
  }

  const explicitBin = env.HARNESS_SUPERVISOR_QODER_BIN;
  if (explicitBin) {
    if (/\.(?:mjs|cjs|js)$/i.test(explicitBin)) {
      return {
        file: process.execPath,
        args: [path.resolve(explicitBin), ...parseArgsEnv(env.HARNESS_SUPERVISOR_QODER_ARGS)],
        description: `node ${explicitBin}`,
        env: childEnv,
      };
    }
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(explicitBin)) {
      throw new Error(
        "HARNESS_SUPERVISOR_QODER_BIN cannot point at a .cmd/.bat shim. Point it at the real qodercli executable or a JS entry via HARNESS_SUPERVISOR_QODER_ENTRY.",
      );
    }
    return {
      file: explicitBin,
      args: parseArgsEnv(env.HARNESS_SUPERVISOR_QODER_ARGS),
      description: explicitBin,
      env: childEnv,
    };
  }

  const found = findQoderOnPath();
  if (found) {
    return {
      file: found,
      args: parseArgsEnv(env.HARNESS_SUPERVISOR_QODER_ARGS),
      description: `qodercli (${found})`,
      env: childEnv,
    };
  }
  if (process.platform !== "win32") {
    return {
      file: "qodercli",
      args: parseArgsEnv(env.HARNESS_SUPERVISOR_QODER_ARGS),
      description: "qodercli (PATH)",
      env: childEnv,
    };
  }
  throw new Error(
    "Could not find qodercli. Install Qoder CLI, or set HARNESS_SUPERVISOR_QODER_BIN to the qodercli executable.",
  );
}

export function qoderConfigRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    env.QODER_CONFIG_DIR,
    env.QODERCN_CONFIG_DIR,
    path.join(os.homedir(), ".qoder"),
    path.join(os.homedir(), ".qoder-cn"),
  ];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(resolved)) roots.push(resolved);
  }
  if (roots.length === 0) roots.push(path.join(os.homedir(), ".qoder-cn"));
  return roots;
}

export function encodeQoderProjectDir(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/[:/\\]/g, "-");
}

export function expectedQoderSessionFile(
  root: string,
  cwd: string,
  sessionId: string,
): string {
  return path.join(root, "projects", encodeQoderProjectDir(cwd), `${sessionId}.jsonl`);
}

async function isFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

export async function locateQoderSessionFile(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const roots = qoderConfigRoots(env);
  for (const root of roots) {
    const direct = expectedQoderSessionFile(root, cwd, sessionId);
    if (await isFile(direct)) return direct;
  }
  for (const root of roots) {
    const projectsDir = path.join(root, "projects");
    let entries;
    try {
      entries = await readdir(projectsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

export async function waitForQoderSessionFile(
  cwd: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 1500,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let delay = 25;
  while (true) {
    const found = await locateQoderSessionFile(cwd, sessionId, env);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(200, delay * 2);
  }
}

export function sessionIdFromFile(sessionFile: string): string | null {
  const base = path.basename(sessionFile);
  if (!base.toLowerCase().endsWith(".jsonl")) return null;
  const id = base.slice(0, -".jsonl".length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}
