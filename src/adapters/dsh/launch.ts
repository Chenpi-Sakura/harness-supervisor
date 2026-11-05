import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SupervisorError } from "../../errors.js";

export interface DshLaunch {
  file: string;
  args: string[];
  description: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

const DSH_PROFILE = "acp";

export const DSH_PERMISSION_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type DshPermissionMode = (typeof DSH_PERMISSION_MODES)[number];

/**
 * The shipped acp profile defaults to workspace-write with approval policy
 * "ask". It reads DSH_PERMISSION_MODE at boot; there is no ACP config option
 * and the desktop profile's permission picker does not apply to this process.
 */
export const DSH_DEFAULT_PERMISSION_MODE: DshPermissionMode = "workspace-write";

/**
 * Resolution order:
 *   1. HARNESS_SUPERVISOR_DSH_PERMISSION_MODE (HS-specific)
 *   2. DSH_PERMISSION_MODE inherited from the daemon environment (native)
 *   3. workspace-write, matching the shipped acp profile
 */
export function resolveDshPermissionMode(
  env: NodeJS.ProcessEnv = process.env,
): DshPermissionMode {
  const raw =
    env.HARNESS_SUPERVISOR_DSH_PERMISSION_MODE?.trim() || env.DSH_PERMISSION_MODE?.trim();
  if (!raw) return DSH_DEFAULT_PERMISSION_MODE;
  const normalized = raw.toLowerCase().replace(/_/g, "-");
  if (normalized === "readonly" || normalized === "read-only") return "read-only";
  if (normalized === "workspace" || normalized === "workspace-write") {
    return "workspace-write";
  }
  if (
    normalized === "danger-full-access" ||
    normalized === "full-access" ||
    normalized === "full" ||
    normalized === "yolo"
  ) {
    return "danger-full-access";
  }
  throw new SupervisorError(
    "BAD_REQUEST",
    `Unsupported DSH permission mode: ${raw}. Allowed: ${DSH_PERMISSION_MODES.join(", ")} (default: ${DSH_DEFAULT_PERMISSION_MODE}).`,
  );
}

/**
 * DSH ACP accepts no supervisor-managed flags from extraArgs. The profile is
 * fixed so stdout stays a pure JSON-RPC channel; a caller that needs a custom
 * profile can point HARNESS_SUPERVISOR_DSH_ENTRY at its own launcher.
 */
export function validateDshExtraArgs(extraArgs: string[] | undefined): void {
  if (!extraArgs || extraArgs.length === 0) return;
  throw new Error(
    "DSH ACP workers do not accept extraArgs; the acp profile is fixed so stdout stays protocol-only. Use HARNESS_SUPERVISOR_DSH_ENTRY for a custom launcher.",
  );
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function desktopCliEntry(root: string): string | null {
  const exe = path.join(root, "DeepSeek Harness.exe");
  const archive = path.join(root, "resources", "app.asar");
  // The CLI file lives inside app.asar. Plain Node cannot stat a path inside
  // the archive, so the desktop layout is identified by the archive itself;
  // Electron resolves the CLI path when it starts.
  return isFile(exe) && isFile(archive) ? exe : null;
}

function desktopLauncher(root: string): string | null {
  const cmd = path.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd");
  return isFile(cmd) ? cmd : null;
}

function electronLaunch(exe: string, env: NodeJS.ProcessEnv): DshLaunch {
  const cli = path.join(
    path.dirname(exe),
    "resources",
    "app.asar",
    "dsh",
    "node_modules",
    "@deepseek-ai",
    "dsh-desktop-host",
    "lib",
    "cli.js",
  );
  return {
    file: exe,
    args: ["--expose-internals", cli, "--profile", DSH_PROFILE],
    description: `DeepSeek Harness desktop CLI (${exe}) --profile ${DSH_PROFILE}`,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * Windows cannot spawn a `.cmd` shim directly since the CVE-2024-27980
 * hardening. The desktop layout has a real executable and a fixed asar CLI
 * entry, which avoids a shell entirely; other shims fall back to cmd.exe.
 */
function cmdLaunch(entry: string, env: NodeJS.ProcessEnv): DshLaunch {
  if (process.platform !== "win32") {
    throw new Error(
      `DSH entry is a Windows command shim and cannot be spawned on ${process.platform}: ${entry}`,
    );
  }
  const command = `""${entry}" --profile ${DSH_PROFILE}"`;
  return {
    file: env.ComSpec ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", command],
    description: `cmd /d /s /c "${entry}" --profile ${DSH_PROFILE}`,
    env: { ...env },
    // Node's default quoting would escape the quotes cmd.exe needs to keep a
    // path with spaces in one argument.
    windowsVerbatimArguments: true,
  };
}

function launchFromEntry(entry: string, env: NodeJS.ProcessEnv): DshLaunch {
  if (isDirectory(entry)) {
    const root = entry;
    const exe = desktopCliEntry(root);
    if (exe) return electronLaunch(exe, env);
    const cmd = desktopLauncher(root);
    if (cmd) return launchFromEntry(cmd, env);
    throw new Error(
      `HARNESS_SUPERVISOR_DSH_ENTRY points at a directory without a DeepSeek Harness CLI: ${entry}`,
    );
  }

  const ext = path.extname(entry).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return {
      file: process.execPath,
      args: [entry, "--profile", DSH_PROFILE],
      description: `node ${entry} --profile ${DSH_PROFILE}`,
      env: { ...env },
    };
  }
  if (ext === ".ps1") {
    throw new Error(
      "HARNESS_SUPERVISOR_DSH_ENTRY cannot point at a .ps1 shim; point it at dsh.cmd, the desktop install directory, or a JS entry.",
    );
  }
  if (ext === ".cmd" || ext === ".bat") {
    if (process.platform === "win32") {
      // <root>/resources/runtime/cli/bin/dsh.cmd
      const root = path.resolve(path.dirname(entry), "..", "..", "..", "..");
      const exe = desktopCliEntry(root);
      if (exe) return electronLaunch(exe, env);
    }
    return cmdLaunch(entry, env);
  }
  if (ext === ".exe") {
    if (process.platform === "win32" && /^deepseek harness\.exe$/i.test(path.basename(entry))) {
      const root = path.dirname(entry);
      if (!desktopCliEntry(root)) {
        throw new Error(
          `The DeepSeek Harness desktop executable needs its bundled CLI; point HARNESS_SUPERVISOR_DSH_ENTRY at ${path.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd")} instead.`,
        );
      }
      return electronLaunch(entry, env);
    }
    return {
      file: entry,
      args: ["--profile", DSH_PROFILE],
      description: `${entry} --profile ${DSH_PROFILE}`,
      env: { ...env },
    };
  }
  return {
    file: entry,
    args: ["--profile", DSH_PROFILE],
    description: `${entry} --profile ${DSH_PROFILE}`,
    env: { ...env },
  };
}

function findDshOnPath(): string | null {
  try {
    const output = execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      ["dsh"],
      { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((candidate) => existsSync(candidate))
      .filter((candidate) => !/\.ps1$/i.test(candidate));
    const rank = (candidate: string): number => {
      const ext = path.extname(candidate).toLowerCase();
      if (ext === ".exe" || ext === "") return 0;
      if (ext === ".cmd" || ext === ".bat") return 1;
      return 2;
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

function installRootsFromRegistry(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [];
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const reg = path.join(systemRoot, "System32", "reg.exe");
  const executable = isFile(reg) ? reg : "reg.exe";
  const roots: string[] = [];
  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const key of keys) {
    let output: string;
    try {
      output = execFileSync(
        executable,
        ["query", key, "/s", "/f", "DeepSeek Harness", "/d"],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      continue;
    }
    for (const line of output.split(/\r?\n/)) {
      const install = /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
      if (install?.[1]) roots.push(install[1].replace(/^"|"$/g, ""));
      const icon = /^\s*DisplayIcon\s+REG_(?:EXPAND_)?SZ\s+(.+?)(?:,\d+)?\s*$/i.exec(line);
      if (icon?.[1]) roots.push(path.dirname(icon[1].replace(/^"|"$/g, "")));
    }
  }
  return roots;
}

function knownInstallRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "Programs", "DeepSeek Harness"));
  if (env.ProgramFiles) roots.push(path.join(env.ProgramFiles, "DeepSeek Harness"));
  if (env.ProgramW6432) roots.push(path.join(env.ProgramW6432, "DeepSeek Harness"));
  if (env.USERPROFILE || env.HOME) {
    roots.push(
      path.join(
        env.USERPROFILE ?? env.HOME ?? os.homedir(),
        "AppData",
        "Local",
        "Programs",
        "DeepSeek Harness",
      ),
    );
  }
  return roots;
}

function findDshDesktopInstall(env: NodeJS.ProcessEnv): string | null {
  const seen = new Set<string>();
  for (const root of [...installRootsFromRegistry(env), ...knownInstallRoots(env)]) {
    if (!root) continue;
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    if (desktopLauncher(root)) return root;
    if (desktopCliEntry(root)) return root;
  }
  return null;
}

export function resolveDshLaunch(env: NodeJS.ProcessEnv = process.env): DshLaunch {
  const explicit = env.HARNESS_SUPERVISOR_DSH_ENTRY?.trim();
  if (explicit) {
    const entry = path.resolve(explicit);
    if (!existsSync(entry)) {
      throw new Error(`HARNESS_SUPERVISOR_DSH_ENTRY does not exist: ${entry}`);
    }
    return launchFromEntry(entry, env);
  }

  const onPath = findDshOnPath();
  if (onPath) return launchFromEntry(onPath, env);

  const install = findDshDesktopInstall(env);
  if (install) {
    const launcher = desktopLauncher(install);
    if (launcher) return launchFromEntry(launcher, env);
    const exe = desktopCliEntry(install);
    if (exe) return electronLaunch(exe, env);
  }

  throw new Error(
    "Could not find DeepSeek Harness. Install the desktop app or the dsh CLI, put dsh on PATH, or set HARNESS_SUPERVISOR_DSH_ENTRY to the CLI entry (for the desktop app: <install>/resources/runtime/cli/bin/dsh.cmd).",
  );
}
