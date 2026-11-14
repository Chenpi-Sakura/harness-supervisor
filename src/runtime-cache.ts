import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import os from "node:os";
import { atomicWriteJson, readJsonFile } from "./util/fsx.js";
import { isPidAlive, sleep } from "./util/async.js";
import { readProcessDetails } from "./util/process.js";

interface Owner { pid: number; startedAt: string | null }
interface Ticket extends Owner { choosing: boolean; number: number }
interface Consumer extends Owner { root: string }
const context = new AsyncLocalStorage<Map<string, { active: boolean }>>();
const exitFiles = new Set<string>();
const registry = path.join(os.homedir(), ".harness-supervisor", "runtime-consumer-registry");
process.once("exit", () => { for (const file of exitFiles) { try { unlinkSync(file); } catch { /* Best effort on exit. */ } } });
let identity: Promise<Owner> | undefined;
function owner(): Promise<Owner> {
  return identity ??= readProcessDetails(process.pid).then(value => ({ pid: process.pid, startedAt: value.startedAt }));
}
async function live(value: Owner, details = new Map<number, Promise<Awaited<ReturnType<typeof readProcessDetails>>>>()): Promise<boolean> {
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) throw Error("Invalid runtime cache owner");
  if (!isPidAlive(value.pid)) return false;
  if (!value.startedAt) return true;
  if (!Number.isFinite(Date.parse(value.startedAt))) throw Error("Invalid runtime cache owner timestamp");
  if (!details.has(value.pid)) details.set(value.pid, value.pid === process.pid
    ? owner().then(value => ({ startedAt: value.startedAt, commandLine: null })) : readProcessDetails(value.pid));
  const actual = await details.get(value.pid)!;
  return !actual.startedAt || Math.abs(Date.parse(actual.startedAt) - Date.parse(value.startedAt)) < 2000;
}

/** Unique bakery tickets avoid deleting a replacement owner's lock after a crash. */
export async function withRuntimeCache<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  const absolute = path.resolve(stateDir);
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  if (context.getStore()?.get(key)?.active) return action();
  const directory = path.join(key, "runtime-cache-lock");
  await mkdir(directory, { recursive: true });
  const name = `${process.pid}-${randomUUID()}.json`, file = path.join(directory, name);
  const ticket: Ticket = { ...await owner(), choosing: true, number: 0 };
  const details = new Map<number, Promise<Awaited<ReturnType<typeof readProcessDetails>>>>();
  const others = async () => {
    const result: Array<{ name: string; ticket: Ticket }> = [];
    for (const other of await readdir(directory)) {
      if (!other.endsWith(".json") || other === name) continue;
      const value = await readJsonFile<Ticket>(path.join(directory, other));
      if (!value) continue;
      if (typeof value.choosing !== "boolean" || !Number.isSafeInteger(value.number) || value.number < 0) throw Error("Invalid runtime cache ticket");
      if (await live(value, details)) result.push({ name: other, ticket: value });
      else await unlink(path.join(directory, other)).catch(() => undefined);
    }
    return result;
  };
  try {
    await atomicWriteJson(file, ticket);
    ticket.number = Math.max(0, ...(await others()).map(value => value.ticket.number)) + 1;
    ticket.choosing = false;
    await atomicWriteJson(file, ticket);
    const deadline = Date.now() + 120_000;
    while ((await others()).some(value => value.ticket.choosing || value.ticket.number < ticket.number ||
      (value.ticket.number === ticket.number && value.name < name))) {
      if (Date.now() >= deadline) throw Error("Runtime cache is busy; retry later");
      await sleep(30);
    }
    const token = { active: true };
    const held = new Map(context.getStore());
    held.set(key, token);
    try { return await context.run(held, action); }
    finally { token.active = false; }
  } finally { await unlink(file).catch(() => undefined); }
}

/** Held by the DSH host as well as cached MCP/CLI processes; never stored inside a hashed runtime. */
export async function retainRuntime(stateDir: string, root: string): Promise<() => Promise<void>> {
  return withRuntimeCache(stateDir, async () => {
    const directory = path.join(path.resolve(stateDir), "runtime-consumers");
    await mkdir(directory, { recursive: true });
    await mkdir(registry, { recursive: true });
    // A pre-existing host may still hold an uninstrumented closure. Its first
    // migration must survive a host restart before absence of leases is trusted.
    await writeFile(path.join(path.resolve(stateDir), "runtime-consumer-epoch.json"), JSON.stringify({ createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 })
      .catch(error => { if (error.code !== "EEXIST") throw error; });
    const name = `${process.pid}-${randomUUID()}.json`, files = [path.join(directory, name), path.join(registry, name)];
    try {
      const value: Consumer = { ...await owner(), root: path.resolve(root) };
      for (const file of files) await atomicWriteJson(file, value);
    } catch (error) {
      for (const file of files) await unlink(file).catch(() => undefined);
      throw error;
    }
    for (const file of files) exitFiles.add(file);
    return async () => {
      for (const file of files) { await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; }); exitFiles.delete(file); }
    };
  });
}

export async function runtimeConsumers(stateDir: string): Promise<{ roots: Set<string>; pids: Set<number> }> {
  const roots = new Set<string>();
  const pids = new Set<number>();
  const details = new Map<number, Promise<Awaited<ReturnType<typeof readProcessDetails>>>>();
  for (const directory of [path.join(path.resolve(stateDir), "runtime-consumers"), registry]) {
    let names: string[];
    try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name), value = await readJsonFile<Consumer>(file);
    if (!value) continue;
    if (typeof value.root !== "string" || !path.isAbsolute(value.root)) throw Error("Invalid runtime consumer");
    if (await live(value, details)) { roots.add(path.resolve(value.root)); pids.add(value.pid); }
    else await unlink(file).catch(() => undefined);
    }
  }
  return { roots, pids };
}

export async function retainCurrentRuntime(moduleUrl: string, stateDir?: string): Promise<void> {
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../..");
  const ownState = path.basename(path.dirname(root)) === "runtimes" ? path.dirname(path.dirname(root)) : undefined;
  if (ownState) await retainRuntime(ownState, root);
  if (stateDir && path.resolve(stateDir) !== ownState) await retainRuntime(stateDir, root);
}
