import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorError } from "./errors.js";
import { atomicWriteJson, readJsonFile } from "./util/fsx.js";
import { retainRuntime, withRuntimeCache } from "./runtime-cache.js";
import { SCHEMA_VERSION } from "./types.js";

export const MANAGED_RUNTIME_SCHEMA = 1;
export interface RuntimeManifest {
  schemaVersion: 1;
  stateSchemaVersion: number;
  id: string;
  version: string;
  files: Record<string, string>;
}
export interface ManagedRuntime extends RuntimeManifest { root: string }
export interface ActiveRuntime {
  schemaVersion: 1;
  runtimeId: string;
  previousRuntimeId?: string;
  committedAt: string;
}
export type UpdatePhase = "draining" | "switching" | "verifying" | "complete" | "cancelled" | "failed" | "recovery_required";
export interface RuntimeUpdateIntent {
  schemaVersion: 1;
  id: string;
  phase: UpdatePhase;
  sourceRuntimeId: string;
  targetRuntimeId: string;
  sourcePid: number;
  createdAt: string;
  updatedAt: string;
  helperPid?: number;
  targetPid?: number;
  error?: string;
  backupDir?: string;
}

export function packageRootFromModule(moduleUrl: string = import.meta.url): string {
  // Both development and published modules live at dist/src/*.js.
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../..");
}
export function runtimeRoot(stateDir: string, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(id)) {
    throw new SupervisorError("BAD_REQUEST", "Invalid managed runtime ID");
  }
  return path.join(path.resolve(stateDir), "runtimes", id);
}
export function intentFile(stateDir: string): string { return path.join(stateDir, "runtime-update.json"); }
export async function readUpdateIntent(stateDir: string): Promise<RuntimeUpdateIntent | null> {
  const value = await readJsonFile<RuntimeUpdateIntent>(intentFile(stateDir));
  if (!value) return null;
  if (value.schemaVersion !== 1 || typeof value.id !== "string" ||
    !["draining", "switching", "verifying", "complete", "cancelled", "failed", "recovery_required"].includes(value.phase)) {
    throw new SupervisorError("INVALID_STATE", "Managed update intent is corrupt; manual diagnosis is required");
  }
  runtimeRoot(stateDir, value.sourceRuntimeId);
  runtimeRoot(stateDir, value.targetRuntimeId);
  return value;
}
export async function writeUpdateIntent(stateDir: string, value: RuntimeUpdateIntent): Promise<void> {
  return withRuntimeCache(stateDir, () => writeUpdateIntentUnlocked(stateDir, value));
}
async function writeUpdateIntentUnlocked(stateDir: string, value: RuntimeUpdateIntent): Promise<void> {
  value.updatedAt = new Date().toISOString();
  await atomicWriteJson(intentFile(stateDir), value);
}
export async function readActiveRuntime(stateDir: string): Promise<ActiveRuntime | null> {
  const active = await readJsonFile<ActiveRuntime>(path.join(stateDir, "active-runtime.json"));
  if (!active) return null;
  if (active.schemaVersion !== 1 || typeof active.runtimeId !== "string") {
    throw new SupervisorError("INVALID_STATE", "Managed runtime pointer is invalid");
  }
  runtimeRoot(stateDir, active.runtimeId);
  if (active.previousRuntimeId !== undefined) runtimeRoot(stateDir, active.previousRuntimeId);
  return active;
}
export async function commitActiveRuntime(stateDir: string, runtimeId: string, previousRuntimeId?: string): Promise<void> {
  return withRuntimeCache(stateDir, () => commitActiveRuntimeUnlocked(stateDir, runtimeId, previousRuntimeId));
}
async function commitActiveRuntimeUnlocked(stateDir: string, runtimeId: string, previousRuntimeId?: string): Promise<void> {
  await readManagedRuntime(stateDir, runtimeId);
  const current = await readActiveRuntime(stateDir);
  previousRuntimeId ??= current?.runtimeId === runtimeId ? current.previousRuntimeId : current?.runtimeId;
  await atomicWriteJson(path.join(stateDir, "active-runtime.json"), {
    schemaVersion: 1, runtimeId, previousRuntimeId, committedAt: new Date().toISOString(),
  } satisfies ActiveRuntime);
}

async function fileHashes(root: string, prefix = ""): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const entry of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === "runtime-manifest.json") continue;
    if (entry.isSymbolicLink()) throw new SupervisorError("BAD_REQUEST", `Runtime contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) Object.assign(output, await fileHashes(root, relative));
    else if (entry.isFile()) {
      output[relative] = createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex");
    } else throw new SupervisorError("BAD_REQUEST", `Runtime contains a non-regular file: ${relative}`);
  }
  return output;
}
function runtimeId(version: string, files: Record<string, string>): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    throw new SupervisorError("BAD_REQUEST", "Runtime package version is invalid");
  }
  return `${version}-${createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 20)}`;
}
async function copyRegularTree(source: string, destination: string, omitNodeModules = false): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new SupervisorError("BAD_REQUEST", `Refusing symbolic link in runtime: ${source}`);
  if (!info.isDirectory()) throw new SupervisorError("BAD_REQUEST", `Runtime directory required: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".git" || (omitNodeModules && entry.name === "node_modules")) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new SupervisorError("BAD_REQUEST", `Refusing symbolic link in runtime: ${from}`);
    if (entry.isDirectory()) await copyRegularTree(from, to);
    else if (entry.isFile()) await cp(from, to, { dereference: false });
    else throw new SupervisorError("BAD_REQUEST", `Refusing non-regular runtime file: ${from}`);
  }
}
async function dependencyRoot(fromPackage: string, name: string): Promise<string> {
  const req = createRequire(path.join(fromPackage, "package.json"));
  // resolve() canonicalizes a junction before we can reject it. Inspect the
  // lexical package directories in Node's own lookup order instead, including
  // packages whose exports deliberately hide their package.json.
  for (const search of req.resolve.paths(name) ?? []) {
    const candidate = path.join(search, ...name.split("/"));
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new SupervisorError("BAD_REQUEST", `Refusing symbolic link dependency ${name}`);
      if (info.isDirectory() && await readJsonFile(path.join(candidate, "package.json"))) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new SupervisorError("BAD_REQUEST", `Cannot resolve production dependency ${name}`);
}
async function copyProductionDependencies(source: string, destination: string): Promise<void> {
  const global = new Map<string, string>();
  const copied = new Set<string>();
  const dependencies = async (from: string) => {
    const pkg = await readJsonFile<{ dependencies?: Record<string, string> }>(path.join(from, "package.json"));
    const result: Array<[string, string]> = [];
    for (const name of Object.keys(pkg?.dependencies ?? {}).sort()) {
      if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) throw new SupervisorError("BAD_REQUEST", "Invalid dependency name");
      const dep = await dependencyRoot(from, name);
      const canonical = await realpath(dep), lexical = path.resolve(dep);
      if ((process.platform === "win32" ? canonical.toLowerCase() !== lexical.toLowerCase() : canonical !== lexical)) {
        throw new SupervisorError("BAD_REQUEST", `Dependency is linked outside its install tree: ${name}`);
      }
      result.push([name, dep]);
    }
    return result;
  };
  const install = async (from: string, target: string, local: Map<string, string>): Promise<void> => {
    if (copied.has(target)) return;
    copied.add(target);
    await copyRegularTree(from, target, true);
    for (const [name, dep] of await dependencies(from)) {
      if ((local.get(name) ?? global.get(name)) === dep) continue;
      let nextTarget: string;
      let nextLocal: Map<string, string>;
      if (!global.has(name)) {
        global.set(name, dep);
        nextTarget = path.join(destination, "node_modules", ...name.split("/"));
        nextLocal = new Map();
      } else {
        // Preserve a conflicting version under the consuming package. All
        // non-conflicting dependencies are hoisted once into the cache root.
        nextTarget = path.join(target, "node_modules", ...name.split("/"));
        nextLocal = new Map(local);
        nextLocal.set(name, dep);
      }
      await install(dep, nextTarget, nextLocal);
    }
  };
  const direct = await dependencies(source);
  for (const [name, dep] of direct) global.set(name, dep);
  for (const [name, dep] of direct) await install(dep, path.join(destination, "node_modules", ...name.split("/")), new Map());
}

/** Copy a complete production install before exposing its immutable cache name. */
export async function prepareManagedRuntime(stateDir: string, sourceRoot: string): Promise<ManagedRuntime> {
  return withRuntimeCache(stateDir, () => prepareManagedRuntimeUnlocked(stateDir, sourceRoot));
}
async function prepareManagedRuntimeUnlocked(stateDir: string, sourceRoot: string): Promise<ManagedRuntime> {
  const source = path.resolve(sourceRoot);
  const pkg = await readJsonFile<{ name?: string; version?: string }>(path.join(source, "package.json"));
  if (pkg?.name !== "harness-supervisor" || typeof pkg.version !== "string") {
    throw new SupervisorError("BAD_REQUEST", "Candidate is not a Harness Supervisor package");
  }
  const stateSchema = /export const SCHEMA_VERSION\s*=\s*(\d+)\s*;/.exec(await readFile(path.join(source, "dist/src/types.js"), "utf8"));
  if (!stateSchema || Number(stateSchema[1]) !== SCHEMA_VERSION) {
    throw new SupervisorError("UNSUPPORTED", "Candidate state format is incompatible; use a manual maintenance migration");
  }
  const cache = path.join(path.resolve(stateDir), "runtimes");
  await mkdir(cache, { recursive: true });
  const staging = path.join(cache, `.staging-${randomUUID()}`);
  await mkdir(staging);
  try {
    await cp(path.join(source, "package.json"), path.join(staging, "package.json"));
    await copyRegularTree(path.join(source, "dist", "src"), path.join(staging, "dist", "src"));
    await copyRegularTree(path.join(source, "dist", "web"), path.join(staging, "dist", "web"));
    await copyProductionDependencies(source, staging);
    for (const file of ["dist/src/daemon-entry.js", "dist/src/runtime-update-helper.js", "dist/web/index.html"]) {
      if (!(await stat(path.join(staging, file))).isFile()) throw new SupervisorError("BAD_REQUEST", `Missing runtime artifact ${file}`);
    }
    const files = await fileHashes(staging);
    const manifest: RuntimeManifest = {
      schemaVersion: 1, stateSchemaVersion: SCHEMA_VERSION,
      id: runtimeId(pkg.version, files), version: pkg.version, files,
    };
    await writeFile(path.join(staging, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const destination = runtimeRoot(stateDir, manifest.id);
    try { await rename(staging, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await readManagedRuntime(stateDir, manifest.id);
      await rm(staging, { recursive: true, force: true });
    }
    return await readManagedRuntime(stateDir, manifest.id);
  } catch (error) {
    // Only the locally generated staging directory is removed, never source or
    // an existing cache entry, including when verification fails.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readManagedRuntime(stateDir: string, id: string): Promise<ManagedRuntime> {
  const root = runtimeRoot(stateDir, id);
  const manifest = await readJsonFile<RuntimeManifest>(path.join(root, "runtime-manifest.json"));
  if (!manifest || manifest.schemaVersion !== 1 || manifest.id !== id ||
    manifest.stateSchemaVersion !== SCHEMA_VERSION || typeof manifest.version !== "string" ||
    typeof manifest.files !== "object" || !manifest.files) {
    throw new SupervisorError("INVALID_STATE", "Managed runtime manifest is missing or incompatible", { runtimeId: id });
  }
  const hashes = await fileHashes(root);
  if (JSON.stringify(hashes) !== JSON.stringify(manifest.files) || runtimeId(manifest.version, hashes) !== id) {
    throw new SupervisorError("INVALID_STATE", "Managed runtime integrity verification failed", { runtimeId: id });
  }
  return { ...manifest, root };
}

/** All clients resolve the same committed core and never restart an old core mid-switch. */
export async function resolveManagedDaemonEntry(stateDir: string, fallback: () => string): Promise<string> {
  const intent = await readUpdateIntent(stateDir);
  if (intent && ["switching", "verifying", "recovery_required"].includes(intent.phase)) {
    throw new SupervisorError("INVALID_STATE", "Managed core handoff is in progress or requires recovery; refusing automatic daemon start", {
      intentId: intent.id, phase: intent.phase,
    });
  }
  const active = await readActiveRuntime(stateDir);
  return active ? path.join((await readManagedRuntime(stateDir, active.runtimeId)).root, "dist/src/daemon-entry.js") : fallback();
}

/** Copy and pin atomically: DSH may launch session MCP clients long after mounting. */
export async function prepareRetainedRuntime(stateDir: string, sourceRoot: string): Promise<{ runtime: ManagedRuntime; release: () => Promise<void> }> {
  return withRuntimeCache(stateDir, async () => {
    const runtime = await prepareManagedRuntime(stateDir, sourceRoot);
    return { runtime, release: await retainRuntime(stateDir, runtime.root) };
  });
}

export async function resolveRetainedDaemonEntry(stateDir: string, fallback: () => string): Promise<{ entry: string; release: () => Promise<void> }> {
  return withRuntimeCache(stateDir, async () => {
    const entry = await resolveManagedDaemonEntry(stateDir, fallback);
    const root = path.resolve(path.dirname(entry), "../..");
    return { entry, release: await retainRuntime(stateDir, root) };
  });
}
