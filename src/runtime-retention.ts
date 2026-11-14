import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { packageRootFromModule, readActiveRuntime, readManagedRuntime, readUpdateIntent, runtimeRoot } from "./managed-runtime.js";
import { runtimeConsumers, withRuntimeCache } from "./runtime-cache.js";
import type { Logger } from "./util/logger.js";
import { atomicWriteJson, readJsonFile } from "./util/fsx.js";
import { readProcessDetails } from "./util/process.js";

interface ProcessReference { pid: number; commandLine: string | null }
const execute = promisify(execFile);
function canonical(value: string): string { return process.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value; }
function older(version: string, current: string): boolean {
  const parse = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(BigInt) : null;
  const left = parse(version), right = parse(current);
  if (!left || !right) return false; // Unpublished/prerelease candidates need explicit handling.
  for (let index = 0; index < 3; index++) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]!;
  }
  return false;
}
async function regularTree(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw Error("Backup contains a redirected or special path");
  if (info.isDirectory()) for (const child of await readdir(root)) await regularTree(path.join(root, child));
}

/** Legacy consumers have no lease. Do not infer their absence from an empty lease directory. */
async function processReferences(): Promise<ProcessReference[]> {
  if (process.platform === "win32") {
    const { stdout } = await execute("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `@(Get-CimInstance Win32_Process -Filter "name='node.exe' OR name='DeepSeek Harness.exe'" -ErrorAction Stop | ForEach-Object { @{pid=$_.ProcessId;commandLine=$_.CommandLine} }) | ConvertTo-Json -Compress`],
    { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const value: unknown = JSON.parse(stdout);
    const rows = Array.isArray(value) ? value : [value];
    if (!rows.every(row => row && Number.isSafeInteger(row.pid) && (row.commandLine === null || typeof row.commandLine === "string"))) throw Error("Invalid process snapshot");
    return rows;
  }
  if (process.platform === "linux") {
    const { stdout } = await execute("ps", ["-u", String(process.getuid!()), "-ww", "-o", "pid=,args="], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim().split("\n").filter(Boolean).map(line => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) throw Error("Invalid process snapshot");
      return { pid: Number(match[1]), commandLine: match[2]! };
    });
  }
  throw Error("Runtime cleanup deferred: process references cannot be verified on this platform");
}

/** Best effort GC. Unknown backups, staging trees and live consumers are protected. */
export async function pruneManagedRuntimes(stateDir: string, logger: Logger,
  snapshot: () => Promise<ProcessReference[]> = processReferences): Promise<string[]> {
  try {
    return await withRuntimeCache(stateDir, async () => {
      const active = await readActiveRuntime(stateDir), intent = await readUpdateIntent(stateDir);
      if (!active || !active.previousRuntimeId || (intent && ["draining", "switching", "verifying", "recovery_required"].includes(intent.phase))) return [];
      const cache = path.join(path.resolve(stateDir), "runtimes");
      if ((await lstat(cache)).isSymbolicLink() || canonical(await realpath(cache)) !== canonical(cache)) throw Error("Runtime cache path is redirected");
      const consumers = await runtimeConsumers(stateDir), processes = await snapshot();
      if (processes.some(value => !value.commandLine ||
        (/@deepseek-ai[\\/]dsh-desktop-host|dsh-boot|[\\/]dist[\\/]src[\\/](?:cli|mcp)\.js/i.test(value.commandLine) && !consumers.pids.has(value.pid)))) {
        throw Error("Runtime cleanup deferred: a legacy or unreadable consumer may still reference cached code");
      }
      const epoch = await readJsonFile<{ createdAt: string }>(path.join(path.resolve(stateDir), "runtime-consumer-epoch.json"));
      for (const host of processes.filter(value => /@deepseek-ai[\\/]dsh-desktop-host|dsh-boot/i.test(value.commandLine!))) {
        const details = await readProcessDetails(host.pid);
        if (!epoch || !Number.isFinite(Date.parse(epoch.createdAt)) || !details.startedAt || Date.parse(details.startedAt) < Date.parse(epoch.createdAt)) {
          throw Error("Runtime cleanup deferred until legacy DSH host restarts");
        }
      }
      const keep = new Set([active.runtimeId, active.previousRuntimeId]);
      const current = await readManagedRuntime(stateDir, active.runtimeId);
      await readManagedRuntime(stateDir, active.previousRuntimeId);
      const runningRoot = canonical(packageRootFromModule());
      const journalFile = path.join(path.resolve(stateDir), "runtime-retirements.json");
      const journal = await readJsonFile<Record<string, string>>(journalFile) ?? {};
      const removed: string[] = [];
      const removeRetired = async (id: string, version: string) => {
        const root = runtimeRoot(stateDir, id), trash = path.join(cache, `.retired-${id}`);
        if (!older(version, current.version) || keep.has(id) || canonical(root) === runningRoot ||
          [...consumers.roots].some(value => canonical(value) === canonical(root)) ||
          processes.some(value => canonical(value.commandLine!).includes(canonical(root)))) return;
        try {
          await lstat(root);
          if ((await lstat(root)).isSymbolicLink() || canonical(await realpath(root)) !== canonical(root)) throw Error("Runtime path is redirected");
          const verified = await readManagedRuntime(stateDir, id);
          if (verified.version !== version) throw Error("Retired runtime version changed");
          await rename(root, trash);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try {
          if ((await lstat(trash)).isSymbolicLink() || canonical(await realpath(trash)) !== canonical(trash)) throw Error("Retired runtime path is redirected");
          await regularTree(trash);
          await rm(trash, { recursive: true, force: false });
          removed.push(id);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
      for (const [id, version] of Object.entries(journal)) {
        try { await removeRetired(id, version); }
        catch (error) { logger.warn("Retired runtime cleanup deferred", { runtimeId: id, error: String(error) }); }
      }
      for (const entry of await readdir(cache, { withFileTypes: true })) {
        if (!entry.isDirectory() || keep.has(entry.name) || entry.name.startsWith(".")) continue;
        const root = runtimeRoot(stateDir, entry.name), normalized = canonical(root);
        if (runningRoot === normalized || [...consumers.roots].some(value => canonical(value) === normalized) ||
          processes.some(value => canonical(value.commandLine!).includes(normalized))) continue;
        try {
          if ((await lstat(root)).isSymbolicLink() || canonical(await realpath(root)) !== normalized || path.dirname(root) !== cache) throw Error("Runtime path is redirected");
          const runtime = await readManagedRuntime(stateDir, entry.name); // Includes every descendant: links/corruption fail closed.
          if (!older(runtime.version, current.version)) continue;
          journal[entry.name] = runtime.version;
          await atomicWriteJson(journalFile, journal);
          await removeRetired(entry.name, runtime.version);
        } catch (error) { logger.warn("Managed runtime retained after cleanup check failed", { runtimeId: entry.name, error: String(error) }); }
      }
      const backups = path.join(path.resolve(stateDir), "runtime-backups");
      try {
        if ((await lstat(backups)).isSymbolicLink() || canonical(await realpath(backups)) !== canonical(backups)) throw Error("Backup directory is redirected");
        for (const entry of await readdir(backups, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const root = path.join(backups, entry.name);
          try {
            if ((await lstat(root)).isSymbolicLink() || canonical(await realpath(root)) !== canonical(root)) throw Error("Backup path is redirected");
            const metadata = await readJsonFile<{ schemaVersion: number; sourceRuntimeId: string; intentId: string }>(path.join(root, "runtime-backup.json"));
            if (!metadata || metadata.schemaVersion !== 1 || typeof metadata.intentId !== "string") continue;
            const source = runtimeRoot(stateDir, metadata.sourceRuntimeId);
            if (!journal[metadata.sourceRuntimeId] || !older(journal[metadata.sourceRuntimeId]!, current.version) || keep.has(metadata.sourceRuntimeId) || root === path.resolve(intent?.backupDir ?? ".") ||
              [...consumers.roots].some(value => canonical(value) === canonical(source)) ||
              processes.some(value => canonical(value.commandLine!).includes(canonical(source)))) continue;
            // Only backups of retired, absent runtimes are eligible, including retries after a partial cleanup.
            try { await lstat(source); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            try { await lstat(path.join(cache, `.retired-${metadata.sourceRuntimeId}`)); continue; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            await regularTree(root);
            await rm(root, { recursive: true, force: false });
            logger.info("Retired managed runtime backup removed", { intentId: metadata.intentId });
          } catch (error) { logger.warn("Managed runtime backup retained after cleanup check failed", { backup: entry.name, error: String(error) }); }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("Managed runtime backup cleanup deferred", { error: String(error) }); }
      if (removed.length) logger.info("Old managed runtimes removed", { runtimeIds: removed });
      return [...new Set(removed)];
    });
  } catch (error) { logger.warn("Managed runtime cleanup deferred", { error: String(error) }); return []; }
}
