import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, readJsonFile } from "./util/fsx.js";
import { isPidAlive } from "./util/async.js";
import { readProcessDetails } from "./util/process.js";
import type { Logger } from "./util/logger.js";
import { withRuntimeCache } from "./runtime-cache.js";
import type { ProcessDetails } from "./util/process.js";

interface Host { schemaVersion: 1; pid: number; startedAt: string | null }
const registrations = new Map<string, Promise<void>>();

/** A state directory cannot simultaneously follow DSH and be an independent instance. */
export async function claimIndependentState(stateDir: string): Promise<void> {
  await withRuntimeCache(stateDir, async () => {
    if (await readJsonFile(path.join(stateDir, "dsh-host-lifecycle.json"))) {
      throw Error("这个状态目录由 DSH 专属 HS 管理；独立 HS 请使用其他 stateDir，避免随 DSH 退出。");
    }
    await atomicWriteJson(path.join(stateDir, "independent-core.json"), { schemaVersion: 1 });
  });
}

/** Application ownership survives plugin disposal; only the host process exit ends it. */
export function registerDshHost(stateDir: string): Promise<void> {
  const root = path.resolve(stateDir);
  let registration = registrations.get(root);
  if (!registration) {
    registration = withRuntimeCache(root, async () => {
      if (await readJsonFile(path.join(root, "independent-core.json"))) throw Error("独立 HS 的状态目录不能同时用作 DSH 专属实例，请使用其他 stateDir。");
      const directory = path.join(root, "dsh-hosts");
      await mkdir(directory, { recursive: true });
      const details = await readProcessDetails(process.pid);
      await atomicWriteJson(path.join(directory, `${process.pid}-${randomUUID()}.json`), {
        schemaVersion: 1, pid: process.pid, startedAt: details.startedAt,
      } satisfies Host);
      // Commit after the owner. Watcher and registration share the cache lock.
      await atomicWriteJson(path.join(root, "dsh-host-lifecycle.json"), { schemaVersion: 1, mode: "follow-dsh" });
    });
    registrations.set(root, registration);
    registration.catch(() => { if (registrations.get(root) === registration) registrations.delete(root); });
  }
  return registration;
}

/** Null means unmanaged or unverified; never stop a daemon on uncertain identity. */
export async function dshHostsAlive(stateDir: string, inspect: (pid: number, expected: string | null) => Promise<ProcessDetails> = readProcessDetails): Promise<boolean | null> {
  const config = await readJsonFile<{ schemaVersion: number; mode: string }>(path.join(stateDir, "dsh-host-lifecycle.json"));
  if (!config) return null;
  if (config.schemaVersion !== 1 || config.mode !== "follow-dsh") throw Error("Invalid DSH host lifecycle configuration");
  const directory = path.join(stateDir, "dsh-hosts");
  // Missing owner directory is uncertainty, not evidence that every host exited.
  const names = await readdir(directory);
  const details = new Map<string, ProcessDetails>();
  let alive = false;
  for (const name of names) {
    if (name.endsWith(".tmp")) continue; // Interrupted atomic writes never committed an owner.
    if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) throw Error("Unknown DSH host ownership record");
    const file = path.join(directory, name), host = await readJsonFile<Host>(file);
    if (!host) continue;
    if (host.schemaVersion !== 1 || !Number.isSafeInteger(host.pid) || host.pid <= 0 ||
      (host.startedAt !== null && (typeof host.startedAt !== "string" || !Number.isFinite(Date.parse(host.startedAt))))) throw Error("Invalid DSH host identity");
    if (isPidAlive(host.pid)) {
      if (!host.startedAt) { alive = true; continue; }
      const key = `${host.pid}:${host.startedAt}`;
      if (!details.has(key)) details.set(key, await inspect(host.pid, host.startedAt));
      const actual = details.get(key)!;
      if (!actual.startedAt || Math.abs(Date.parse(actual.startedAt) - Date.parse(host.startedAt)) < 2000) { alive = true; continue; }
    }
    await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return alive;
}

export function hostIdentityInspector(read = readProcessDetails): (pid: number, expected: string | null) => Promise<ProcessDetails> {
  const identities = new Map<number, { checkedAt: number; details: Awaited<ReturnType<typeof readProcessDetails>> }>();
  return async (pid, expected) => {
    const cached = identities.get(pid);
    if (cached && Date.now() - cached.checkedAt < 30_000 &&
      (!expected || !cached.details.startedAt || Math.abs(Date.parse(cached.details.startedAt) - Date.parse(expected)) < 2000)) return cached.details;
    const details = await read(pid);
    identities.set(pid, { checkedAt: Date.now(), details });
    return details;
  };
}

export function watchDshHosts(stateDir: string, logger: Logger, shutdown: () => Promise<void>): () => void {
  let running = false, stopped = false, warned = false;
  const inspect = hostIdentityInspector();
  const check = async () => {
    if (running || stopped) return;
    running = true;
    try {
      // Unmanaged CLI/npm instances need no process queries or cache lock.
      if (!await readJsonFile(path.join(stateDir, "dsh-host-lifecycle.json"))) return;
      await withRuntimeCache(stateDir, async () => {
        if (!stopped && await dshHostsAlive(stateDir, inspect) === false) {
          logger.info("All DSH hosts exited; stopping dedicated supervisor");
          await shutdown();
        }
      });
      warned = false;
    } catch (error) {
      if (!warned) logger.warn("DSH host exit could not be verified; supervisor remains running", { error: String(error) });
      warned = true;
    } finally { running = false; }
  };
  const timer = setInterval(() => { void check(); }, 2000);
  timer.unref();
  void check();
  return () => { stopped = true; clearInterval(timer); };
}
