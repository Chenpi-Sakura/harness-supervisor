import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { SupervisorError } from "../../errors.js";

export type NativeAcpRuntime = "codex" | "claude";
export interface NativeAcpLaunch { file: string; args: string[]; env: NodeJS.ProcessEnv; description: string }

/** Resolve installed adapters without a shell, npx downloads, or a pinned runtime dependency. */
export function resolveNativeAcpLaunch(runtime: NativeAcpRuntime, env = process.env): NativeAcpLaunch {
  const key = `HARNESS_SUPERVISOR_${runtime.toUpperCase()}_ACP_ENTRY`;
  const explicit = env[key];
  const packageName = `@agentclientprotocol/${runtime === "codex" ? "codex-acp" : "claude-agent-acp"}`;
  const binName = runtime === "codex" ? "codex-acp" : "claude-agent-acp";
  if (explicit) {
    if (!path.isAbsolute(explicit) || !existsSync(explicit) || /\.(?:cmd|bat|ps1)$/i.test(explicit)) {
      throw new SupervisorError("BAD_REQUEST", `${key} must name an existing absolute executable or JavaScript entry, not a shell shim`);
    }
    return { file: /\.[cm]?js$/i.test(explicit) ? process.execPath : explicit, args: /\.[cm]?js$/i.test(explicit) ? [explicit] : [], env: { ...env }, description: `${binName}: ${explicit}` };
  }
  const directories = [...new Set([path.dirname(process.execPath), ...(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean), ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []), ...(env.npm_config_prefix ? [env.npm_config_prefix, path.join(env.npm_config_prefix, "bin")] : [])])];
  for (const directory of directories) {
    for (const modules of [path.join(directory, "node_modules"), path.resolve(directory, "../lib/node_modules")]) {
      const root = path.join(modules, packageName);
      const manifestFile = path.join(root, "package.json");
      if (!existsSync(manifestFile)) continue;
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
      if (typeof bin !== "string") continue;
      const entry = path.resolve(root, bin);
      if (!entry.startsWith(`${path.resolve(root)}${path.sep}`) || !existsSync(entry)) continue;
      return { file: process.execPath, args: [entry], env: { ...env }, description: `${packageName}@${manifest.version}` };
    }
    const binary = path.join(directory, process.platform === "win32" ? `${binName}.exe` : binName);
    if (existsSync(binary)) {
      const entry = realpathSync(binary);
      return { file: /\.[cm]?js$/i.test(entry) ? process.execPath : entry, args: /\.[cm]?js$/i.test(entry) ? [entry] : [], env: { ...env }, description: entry };
    }
  }
  throw new SupervisorError("HARNESS_ERROR", `Install the ACP adapter first: npm install -g ${packageName}@latest; or set ${key}`);
}
