import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { SupervisorError } from "../../errors.js";

export type NativeAcpRuntime = "codex" | "claude" | "opencode";
export interface NativeAcpLaunch { file: string; args: string[]; env: NodeJS.ProcessEnv; description: string }

/** Codex and Claude adapters are optional and are not bundled; OpenCode is discovered from the user's v2 installation. */
export function resolveNativeAcpLaunch(runtime: NativeAcpRuntime, env = process.env,
  discovery?: { modules: readonly string[]; executables: readonly string[] }): NativeAcpLaunch {
  const key = `HARNESS_SUPERVISOR_${runtime.toUpperCase()}_ACP_ENTRY`;
  const explicit = env[key];
  const packageName = runtime === "opencode" ? "@opencode/cli" : `@agentclientprotocol/${runtime === "codex" ? "codex-acp" : "claude-agent-acp"}`;
  const binName = runtime === "opencode" ? "opencode2" : runtime === "codex" ? "codex-acp" : "claude-agent-acp";
  const commandArgs = runtime === "opencode" ? ["acp"] : [];
  if (explicit) {
    if (!path.isAbsolute(explicit) || !existsSync(explicit) || /\.(?:cmd|bat|ps1)$/i.test(explicit)) {
      throw new SupervisorError("BAD_REQUEST", `${key} must name an existing absolute executable or JavaScript entry, not a shell shim`);
    }
    return { file: /\.[cm]?js$/i.test(explicit) ? process.execPath : explicit, args: [...(/\.[cm]?js$/i.test(explicit) ? [explicit] : []), ...commandArgs], env: { ...env }, description: `${binName}: ${explicit}` };
  }
  const directories = [...new Set([path.dirname(process.execPath), ...(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean), ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []), ...(env.npm_config_prefix ? [env.npm_config_prefix, path.join(env.npm_config_prefix, "bin")] : [])])];
  const packageDirectories = discovery?.modules ?? [...new Set([
    ...(createRequire(import.meta.url).resolve.paths(packageName) ?? []),
    ...directories.flatMap(directory => [path.join(directory, "node_modules"), path.resolve(directory, "../lib/node_modules")]),
  ])];
  for (const modules of packageDirectories) {
    const root = path.join(modules, packageName);
    const manifestFile = path.join(root, "package.json");
    if (!existsSync(manifestFile)) continue;
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (runtime === "opencode" && !/^2\./.test(String(manifest.version))) continue;
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
    if (typeof bin !== "string") continue;
    const entry = path.resolve(root, bin);
    if (!entry.startsWith(`${path.resolve(root)}${path.sep}`) || !existsSync(entry)) continue;
    const js = runtime !== "opencode" || /\.[cm]?js$/i.test(entry);
    return { file: js ? process.execPath : entry, args: [...(js ? [entry] : []), ...commandArgs], env: { ...env }, description: `${packageName}@${manifest.version}` };
  }
  for (const command of runtime === "opencode" ? ["opencode2", "opencode"] : [binName]) {
    for (const directory of discovery?.executables ?? directories) {
      const binary = path.join(directory, process.platform === "win32" ? `${command}.exe` : command);
      if (existsSync(binary)) {
        const entry = realpathSync(binary);
        return { file: /\.[cm]?js$/i.test(entry) ? process.execPath : entry, args: [...(/\.[cm]?js$/i.test(entry) ? [entry] : []), ...commandArgs], env: { ...env }, description: entry };
      }
    }
  }
  if (runtime === "opencode") throw new SupervisorError("HARNESS_ERROR", `OpenCode v2 is not installed or its executable is unavailable. Install OpenCode v2, complete native authentication, and put opencode2/opencode on PATH or set ${key} to its absolute executable. HS does not install or download OpenCode.`);
  throw new SupervisorError("HARNESS_ERROR", `The ${binName} adapter is not installed. Install it with \`npm i -g ${packageName}\`, or set ${key} to an existing adapter entry. HS does not bundle it by default.`);
}
