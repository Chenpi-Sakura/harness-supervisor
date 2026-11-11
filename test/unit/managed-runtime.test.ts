import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  commitActiveRuntime, prepareManagedRuntime, readManagedRuntime, readUpdateIntent,
  resolveManagedDaemonEntry, writeUpdateIntent, type RuntimeUpdateIntent,
} from "../../src/managed-runtime.js";
import { runRuntimeHandoff } from "../../src/runtime-update-helper.js";
import { RuntimeUpdater } from "../../src/runtime-updater.js";
import { Store } from "../../src/store.js";
import { Supervisor } from "../../src/supervisor.js";
import { silentLogger } from "../../src/util/logger.js";
import { VERSION } from "../../src/version.js";
import { isPidAlive, sleep } from "../../src/util/async.js";

async function fixture(version = VERSION, script = "process.exit(0)"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hs-runtime-package-"));
  await mkdir(path.join(root, "dist", "src"), { recursive: true });
  await mkdir(path.join(root, "dist", "web"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "harness-supervisor", version, type: "module" }));
  await writeFile(path.join(root, "dist/src/daemon-entry.js"), script);
  await writeFile(path.join(root, "dist/src/runtime-update-helper.js"), "// helper artifact\n");
  await writeFile(path.join(root, "dist/src/types.js"), "export const SCHEMA_VERSION = 1;\n");
  await writeFile(path.join(root, "dist/web/index.html"), "<!doctype html><p>HS</p>");
  return root;
}
async function state(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), "hs-managed-state-")); }
function intent(sourceRuntimeId: string, targetRuntimeId: string, phase: RuntimeUpdateIntent["phase"] = "switching"): RuntimeUpdateIntent {
  return { schemaVersion: 1, id: "update-test", phase, sourceRuntimeId, targetRuntimeId, sourcePid: 2147483647,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test("runtime staging is reproducible, complete and independent of the original install", async () => {
  const dir = await state(), source = await fixture();
  await mkdir(path.join(source, "node_modules", "fixture-dep"), { recursive: true });
  await writeFile(path.join(source, "node_modules/fixture-dep/package.json"), JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.js" }));
  await writeFile(path.join(source, "node_modules/fixture-dep/index.js"), "exports.value=7");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "harness-supervisor", version: VERSION, dependencies: { "fixture-dep": "1.0.0" } }));
  const first = await prepareManagedRuntime(dir, source);
  assert.equal((await prepareManagedRuntime(dir, source)).id, first.id);
  assert.equal(await readFile(path.join(first.root, "node_modules/fixture-dep/index.js"), "utf8"), "exports.value=7");
  await rm(source, { recursive: true });
  assert.equal((await readManagedRuntime(dir, first.id)).id, first.id);
  await commitActiveRuntime(dir, first.id);
  assert.equal(await resolveManagedDaemonEntry(dir, () => { throw Error("fallback called"); }), path.join(first.root, "dist/src/daemon-entry.js"));
});

test("cache corruption, added files and links fail closed without replacing an existing runtime", async () => {
  const dir = await state(), source = await fixture();
  const cached = await prepareManagedRuntime(dir, source);
  await writeFile(path.join(cached.root, "dist/src/extra.js"), "tampered");
  await assert.rejects(() => readManagedRuntime(dir, cached.id), /integrity/);
  await assert.rejects(() => prepareManagedRuntime(dir, source), /integrity/);
  await rm(path.join(cached.root, "dist/src/extra.js"));
  const external = await mkdtemp(path.join(os.tmpdir(), "hs-runtime-external-"));
  await symlink(external, path.join(source, "dist/src/linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => prepareManagedRuntime(dir, source), /symbolic link/);
  assert.equal((await readManagedRuntime(dir, cached.id)).id, cached.id);
});

test("an incompatible state format is rejected before a drain can begin", async () => {
  const dir = await state(), source = await fixture();
  await writeFile(path.join(source, "dist/src/types.js"), "export const SCHEMA_VERSION = 2;\n");
  await assert.rejects(() => prepareManagedRuntime(dir, source), /state format is incompatible/);
});

test("dependency junctions cannot escape a deployable install tree", async () => {
  const dir = await state(), source = await fixture();
  const linked = await mkdtemp(path.join(os.tmpdir(), "hs-linked-dep-"));
  await writeFile(path.join(linked, "package.json"), JSON.stringify({ name: "fixture-linked", version: "1.0.0", main: "index.js" }));
  await writeFile(path.join(linked, "index.js"), "module.exports={}");
  await mkdir(path.join(source, "node_modules"));
  await symlink(linked, path.join(source, "node_modules/fixture-linked"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "harness-supervisor", version: VERSION, dependencies: { "fixture-linked": "1.0.0" } }));
  await assert.rejects(() => prepareManagedRuntime(dir, source), /symbolic link dependency/);
});

test("clients never auto-start an old runtime during handoff or uncertain recovery", async () => {
  const dir = await state(), source = await fixture();
  const cached = await prepareManagedRuntime(dir, source);
  await commitActiveRuntime(dir, cached.id);
  for (const phase of ["switching", "verifying", "recovery_required"] as const) {
    await writeUpdateIntent(dir, intent(cached.id, cached.id, phase));
    await assert.rejects(() => resolveManagedDaemonEntry(dir, () => "old-core.js"), /refusing automatic daemon start/);
  }
  await writeUpdateIntent(dir, intent(cached.id, cached.id, "draining"));
  assert.equal(await resolveManagedDaemonEntry(dir, () => "old-core.js"), path.join(cached.root, "dist/src/daemon-entry.js"));
});

test("update requests are idempotent, conflicting targets fail, draining is cancellable", async (t) => {
  const dir = await state(), source = await fixture(), candidate = await fixture("0.10.1");
  const store = new Store(dir, silentLogger);
  const supervisor = new Supervisor({ store, stateDir: dir, supervisorId: "update-test", logger: silentLogger, adapters: new Map() });
  await supervisor.init();
  const updater = new RuntimeUpdater({ stateDir: dir, supervisor, packageRoot: source, logger: silentLogger, shutdown: async () => { throw Error("should not switch"); } });
  t.after(async () => { updater.close(); await supervisor.shutdown(); });
  await updater.initialize();
  const target = await updater.prepare(candidate);
  const requests = await Promise.all([updater.apply({ intentId: "same", runtimeId: target.id }), updater.apply({ intentId: "same", runtimeId: target.id })]);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(supervisor.drainStatus().intentId, "same");
  await assert.rejects(() => updater.apply({ intentId: "different", runtimeId: target.id }), /already pending/);
  await assert.rejects(() => updater.apply({ intentId: "same", runtimeId: "different-runtime" }), /already used/);
  await assert.rejects(() => supervisor.spawn({ cwd: dir, prompt: "blocked" }), /draining/);
  await updater.cancel("same");
  assert.equal(supervisor.drainStatus().intentId, null);
  assert.equal((await readUpdateIntent(dir))?.phase, "cancelled");
});

test("a persisted drain resumes with closed admission after daemon restart", async (t) => {
  const dir = await state(), source = await fixture();
  const cached = await prepareManagedRuntime(dir, source);
  await commitActiveRuntime(dir, cached.id);
  await writeUpdateIntent(dir, intent(cached.id, cached.id, "draining"));
  const supervisor = new Supervisor({ store: new Store(dir, silentLogger), stateDir: dir, supervisorId: "recovered", logger: silentLogger, adapters: new Map() });
  await supervisor.init();
  const updater = new RuntimeUpdater({ stateDir: dir, supervisor, packageRoot: cached.root, logger: silentLogger, shutdown: async () => undefined });
  t.after(async () => { updater.close(); await supervisor.shutdown(); });
  await updater.initialize();
  await sleep(650);
  assert.equal((await readUpdateIntent(dir))?.phase, "draining", "a recovered drain cannot switch before the daemon endpoint is ready");
  assert.equal(supervisor.drainStatus().intentId, "update-test");
  await assert.rejects(() => supervisor.spawn({ cwd: dir, prompt: "must stay closed" }), /draining/);
  await updater.cancel("update-test");
});

test("failure before a helper can start safely reopens the still-running source", async (t) => {
  const dir = await state(), source = await fixture(), candidate = await fixture("0.10.1");
  const supervisor = new Supervisor({ store: new Store(dir, silentLogger), stateDir: dir, supervisorId: "helper-failure", logger: silentLogger, adapters: new Map() });
  await supervisor.init();
  const updater = new RuntimeUpdater({ stateDir: dir, supervisor, packageRoot: source, logger: silentLogger, shutdown: async () => { throw Error("source must stay alive"); }, spawnHelper: () => { throw Error("simulated helper spawn failure"); } });
  t.after(async () => { updater.close(); await supervisor.shutdown(); });
  const target = await updater.prepare(candidate);
  await updater.apply({ intentId: "cannot-spawn-helper", runtimeId: target.id });
  for (let tries = 0; tries < 100; tries++) {
    const status = await updater.status();
    if (status.intent?.phase === "failed" && status.drain.intentId === null) break;
    await sleep(20);
  }
  assert.equal((await updater.status()).intent?.phase, "failed");
  assert.equal(supervisor.drainStatus().intentId, null);
});

test("handoff never kills or replaces a source whose exit cannot be confirmed", async () => {
  const dir = await state(), source = await fixture();
  const cached = await prepareManagedRuntime(dir, source);
  await writeUpdateIntent(dir, { ...intent(cached.id, cached.id), sourcePid: process.pid });
  await assert.rejects(() => runRuntimeHandoff({ stateDir: dir, intentId: "update-test", sourceExitTimeoutMs: 1 }), /could not be confirmed/);
  assert.equal((await readUpdateIntent(dir))?.phase, "recovery_required");
});

test("a confirmed pre-activation candidate exit restores the previous verified core", async () => {
  const dir = await state();
  const rollbackScript = `import fs from 'node:fs';import path from 'node:path';const d=process.argv[process.argv.indexOf('--state-dir')+1];const f=path.join(d,'runtime-update.json');const v=JSON.parse(fs.readFileSync(f));if(!process.env.HARNESS_SUPERVISOR_ROLLBACK_INTENT_ID)process.exit(3);v.phase='failed';fs.writeFileSync(f,JSON.stringify(v));`;
  const source = await prepareManagedRuntime(dir, await fixture(VERSION, rollbackScript));
  const target = await prepareManagedRuntime(dir, await fixture("0.10.1", "process.exit(42)"));
  await writeUpdateIntent(dir, intent(source.id, target.id));
  await runRuntimeHandoff({ stateDir: dir, intentId: "update-test", targetReadyTimeoutMs: 3000 });
  const result = await readUpdateIntent(dir);
  assert.equal(result?.phase, "failed");
  assert.match(result?.error ?? "", /Candidate exited before activation/);
});

test("a live unconfirmed candidate prevents rollback and remains recoverable", async (t) => {
  const dir = await state();
  const source = await prepareManagedRuntime(dir, await fixture(VERSION, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(dir, "wrong-rollback"))},'bad');`));
  const liveScript = `import fs from 'node:fs';import path from 'node:path';const d=process.argv[process.argv.indexOf('--state-dir')+1];const f=path.join(d,'runtime-update.json');const v=JSON.parse(fs.readFileSync(f));v.targetPid=process.pid;fs.writeFileSync(f,JSON.stringify(v));setInterval(()=>{},1000);`;
  const target = await prepareManagedRuntime(dir, await fixture("0.10.1", liveScript));
  await writeUpdateIntent(dir, intent(source.id, target.id));
  t.after(async () => {
    const pid = (await readUpdateIntent(dir))?.targetPid;
    if (pid && isPidAlive(pid)) process.kill(pid, "SIGTERM");
  });
  await assert.rejects(() => runRuntimeHandoff({ stateDir: dir, intentId: "update-test", targetReadyTimeoutMs: 300 }), /exit cannot be established/);
  const pending = await readUpdateIntent(dir);
  assert.equal(pending?.phase, "recovery_required");
  assert.ok(pending?.targetPid && isPidAlive(pending.targetPid));
  await assert.rejects(() => readFile(path.join(dir, "wrong-rollback")), /ENOENT/);
});
