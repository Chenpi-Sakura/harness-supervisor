import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commitActiveRuntime, prepareManagedRuntime, readActiveRuntime, writeUpdateIntent } from "../../src/managed-runtime.js";
import { retainCurrentRuntime, retainRuntime, withRuntimeCache } from "../../src/runtime-cache.js";
import { pruneManagedRuntimes } from "../../src/runtime-retention.js";
import { silentLogger } from "../../src/util/logger.js";
import { sleep } from "../../src/util/async.js";
import { spawn } from "node:child_process";

const empty = async () => [];
async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-retention-"));
  const source = path.join(dir, "source");
  await mkdir(path.join(source, "dist/src"), { recursive: true });
  await mkdir(path.join(source, "dist/web"));
  await writeFile(path.join(source, "dist/src/types.js"), "export const SCHEMA_VERSION = 1;\n");
  for (const name of ["daemon-entry", "runtime-update-helper"]) await writeFile(path.join(source, `dist/src/${name}.js`), "process.exit(0);");
  await writeFile(path.join(source, "dist/web/index.html"), "<!doctype html>");
  const versions = [];
  for (const version of ["1.0.0", "1.0.1", "1.0.2"]) {
    await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "harness-supervisor", version }));
    const runtime = await prepareManagedRuntime(dir, source);
    await commitActiveRuntime(dir, runtime.id);
    versions.push(runtime);
  }
  return { dir, a: versions[0]!, b: versions[1]!, c: versions[2]! };
}
async function backup(dir: string, name: string, runtimeId?: string) {
  const root = path.join(dir, "runtime-backups", name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "workers.json"), "important state");
  if (runtimeId) await writeFile(path.join(root, "runtime-backup.json"), JSON.stringify({ schemaVersion: 1, sourceRuntimeId: runtimeId, intentId: name }));
  return root;
}

test("three activations retain current and previous; deleting retired code also deletes its identified backup", async () => {
  const { dir, a, b, c } = await setup();
  const oldBackup = await backup(dir, "old", a.id), rollback = await backup(dir, "rollback", b.id);
  const unknown = await backup(dir, "legacy-unidentified");
  assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, empty), [a.id]);
  assert.deepEqual((await readdir(path.join(dir, "runtimes"))).sort(), [b.id, c.id].sort());
  await assert.rejects(readFile(path.join(oldBackup, "workers.json")), /ENOENT/);
  for (const root of [rollback, unknown]) assert.equal(await readFile(path.join(root, "workers.json"), "utf8"), "important state");
  assert.equal((await readActiveRuntime(dir))?.previousRuntimeId, b.id);
  await commitActiveRuntime(dir, c.id); // Recommitting/rollback must not drop the known fallback.
  assert.equal((await readActiveRuntime(dir))?.previousRuntimeId, b.id);
});

test("a live DSH/MCP lease preserves both old code and backup until released", async () => {
  const { dir, a } = await setup();
  const root = await backup(dir, "in-use", a.id);
  const release = await retainRuntime(dir, a.root);
  try { assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, empty), []); }
  finally { await release(); }
  assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, empty), [a.id]);
  await assert.rejects(readFile(path.join(root, "workers.json")), /ENOENT/);
});

test("interrupted retirement resumes, but a missing source alone never authorizes backup deletion", async () => {
  const { dir, a } = await setup();
  const old = await backup(dir, "retired", a.id);
  const unrelated = await backup(dir, "missing-source", "0.9.0-unknown");
  await writeFile(path.join(dir, "runtime-retirements.json"), JSON.stringify({ [a.id]: a.version }));
  const trash = path.join(dir, "runtimes", `.retired-${a.id}`);
  await rename(a.root, trash);
  await rm(path.join(trash, "runtime-manifest.json")); // Simulate a crash halfway through recursive deletion.
  assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, empty), [a.id]);
  await assert.rejects(readFile(path.join(old, "workers.json")), /ENOENT/);
  assert.equal(await readFile(path.join(unrelated, "workers.json"), "utf8"), "important state");
  assert.ok(!(await readdir(path.join(dir, "runtimes"))).some(name => name.startsWith(".retired-")));
});

test("legacy command-line references, unleased DSH hosts and unreadable processes fail closed", async () => {
  const { dir, a } = await setup();
  for (const commandLine of [`node "${a.root}/dist/src/mcp.js"`, `node "${a.root.replaceAll("\\", "/")}/dist/src/mcp.js"`, "node /external-package/dist/src/mcp.js", "node @deepseek-ai/dsh-desktop-host/lib/index.js", null]) {
    assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, async () => [{ pid: 4242, commandLine }]), []);
  }
  assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, async () => { throw Error("process query denied"); }), []);
  assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, empty), [a.id]);
});

test("new CLI/MCP clients installed outside the cache register protocol participation", async () => {
  const { dir, a } = await setup();
  await retainCurrentRuntime(new URL("../../src/cli.js", import.meta.url).href, dir);
  assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger,
    async () => [{ pid: process.pid, commandLine: "node /npm-install/dist/src/mcp.js" }]), [a.id]);
});

test("pending/recovery updates protect all code and backups", async () => {
  const { dir, a, b, c } = await setup();
  await backup(dir, "old", a.id);
  for (const phase of ["draining", "switching", "verifying", "recovery_required"] as const) {
    await writeUpdateIntent(dir, { schemaVersion: 1, id: "test", phase, sourceRuntimeId: b.id, targetRuntimeId: c.id, sourcePid: process.pid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, empty), []);
  }
  assert.equal(await readFile(path.join(dir, "runtime-backups/old/workers.json"), "utf8"), "important state");
});

test("redirected and corrupt trees are retained, without following backup junctions", async () => {
  const { dir, a } = await setup();
  await writeFile(path.join(a.root, "unexpected"), "corrupt");
  const outside = await mkdtemp(path.join(os.tmpdir(), "hs-retention-outside-"));
  await writeFile(path.join(outside, "sentinel"), "keep");
  await mkdir(path.join(dir, "runtime-backups"));
  await symlink(outside, path.join(dir, "runtime-backups/redirected"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, empty), []);
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "keep");
});

test("cache operations serialize concurrent owners and allow nested prepare/pin calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-cache-lock-"));
  const events: string[] = [];
  await Promise.all([1, 2, 3].map(index => withRuntimeCache(dir, async () => {
    events.push(`start${index}`);
    await withRuntimeCache(dir, async () => { await sleep(20); });
    events.push(`end${index}`);
  })));
  for (let index = 0; index < events.length; index += 2) assert.equal(events[index]?.replace("start", "end"), events[index + 1]);
});

test("a timer inheriting a released lock context must acquire a fresh ticket", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-cache-inherited-"));
  let fire!: () => void, later!: Promise<void>, entered = false;
  const gate = new Promise<void>(resolve => { fire = resolve; });
  await withRuntimeCache(dir, async () => {
    later = gate.then(() => withRuntimeCache(dir, async () => { entered = true; }));
  });
  await withRuntimeCache(dir, async () => {
    fire();
    await sleep(80);
    assert.equal(entered, false);
  });
  await later;
  assert.equal(entered, true);
});

test("a registered DSH host still needs to restart across the legacy lease epoch", async () => {
  const { dir, a, c } = await setup();
  const release = await retainRuntime(dir, c.root);
  const snapshot = async () => [{ pid: process.pid, commandLine: "node @deepseek-ai/dsh-desktop-host/lib/index.js" }];
  try {
    await writeFile(path.join(dir, "runtime-consumer-epoch.json"), JSON.stringify({ createdAt: new Date(Date.now() + 60_000).toISOString() }));
    assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, snapshot), []);
    await writeFile(path.join(dir, "runtime-consumer-epoch.json"), JSON.stringify({ createdAt: "1970-01-01T00:00:00.000Z" }));
    assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, snapshot), [a.id]);
  } finally { await release(); }
});

test("independent processes serialize cache mutations and recover dead owner tickets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-cache-process-")), log = path.join(dir, "order.log");
  await mkdir(path.join(dir, "runtime-cache-lock"));
  await writeFile(path.join(dir, "runtime-cache-lock/dead.json"), JSON.stringify({ pid: 2147483647, startedAt: null, choosing: true, number: 0 }));
  const script = `import {withRuntimeCache} from ${JSON.stringify(new URL("../../src/runtime-cache.js", import.meta.url).href)};
    import {appendFile} from 'node:fs/promises';
    await withRuntimeCache(process.argv[1],async()=>{await appendFile(process.argv[2],process.argv[3]+':start\\n');await new Promise(r=>setTimeout(r,100));await appendFile(process.argv[2],process.argv[3]+':end\\n');});`;
  await Promise.all(["one", "two"].map(name => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, log, name], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(Error(stderr)));
  })));
  const events = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(events.length, 4);
  assert.equal(events[0]!.replace(":start", ":end"), events[1]);
  assert.equal(events[2]!.replace(":start", ":end"), events[3]);
});

test("a recycled lease PID does not retain old code, malformed metadata fails closed", async () => {
  const { dir, a } = await setup();
  const directory = path.join(dir, "runtime-consumers");
  await mkdir(directory);
  const file = path.join(directory, "recycled.json");
  await writeFile(file, JSON.stringify({ pid: process.pid, startedAt: "1970-01-01T00:00:00.000Z", root: a.root }));
  assert.deepEqual(await pruneManagedRuntimes(dir, silentLogger, empty), [a.id]);
  const next = await setup();
  await mkdir(path.join(next.dir, "runtime-consumers"));
  await writeFile(path.join(next.dir, "runtime-consumers/bad.json"), "not json");
  assert.deepEqual(await pruneManagedRuntimes(next.dir, silentLogger, empty), []);
});
