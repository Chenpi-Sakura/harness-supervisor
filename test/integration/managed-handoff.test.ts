import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SupervisorClient } from "../../src/ipc/client.js";
import { packageRootFromModule, prepareManagedRuntime, readActiveRuntime, readUpdateIntent } from "../../src/managed-runtime.js";
import { isPidAlive, sleep } from "../../src/util/async.js";
import type { WorkerSummary } from "../../src/types.js";
import { FAKE_ENTRY, waitTerminal } from "./helpers.js";

async function cloneForCandidate(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "runtime-manifest.json") continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) await cloneForCandidate(from, to);
    else {
      // Tests share immutable files while assembling a source package. Runtime
      // preparation still copies them into an independent immutable cache.
      await link(from, to).catch(() => copyFile(from, to));
    }
  }
}

test("two self-contained cached cores hand off after draining and preserve native continuation", { timeout: 300_000 }, async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "hs-core-handoff-"));
  const packageRoot = packageRootFromModule();
  const baseline = await prepareManagedRuntime(stateDir, packageRoot);
  const candidateRoot = path.join(stateDir, "candidate-source");
  await cloneForCandidate(baseline.root, candidateRoot);
  const entry = path.join(candidateRoot, "dist/src/daemon-entry.js");
  const original = await readFile(entry, "utf8");
  await unlink(entry); // Break the test assembly hardlink before changing it.
  await writeFile(entry, `${original}\n// separate verified candidate build\n`);

  const keys = ["HARNESS_SUPERVISOR_PI_ENTRY", "FAKE_PI_STEP_MS", "FAKE_PI_SLOW_STEP_MS"] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.HARNESS_SUPERVISOR_PI_ENTRY = FAKE_ENTRY;
  process.env.FAKE_PI_STEP_MS = "10";
  process.env.FAKE_PI_SLOW_STEP_MS = "800";
  let client = new SupervisorClient({ stateDir, daemonEntry: path.join(baseline.root, "dist/src/daemon-entry.js"), connectTimeoutMs: 60_000 });
  t.after(async () => {
    client.close();
    const cleanup = new SupervisorClient({ stateDir, autoStart: false });
    try { await cleanup.shutdown(); } catch { /* A failed handoff may have no live daemon. */ }
    cleanup.close();
    for (let index = 0; index < keys.length; index++) {
      const value = previous[index];
      if (value === undefined) delete process.env[keys[index]!]; else process.env[keys[index]!] = value;
    }
  });
  await client.connect();
  const bootstrapDeadline = Date.now() + 60_000;
  while (!(await readActiveRuntime(stateDir))) {
    assert.ok(Date.now() < bootstrapDeadline, "cached core must commit its own bootstrap pointer");
    await sleep(100);
  }
  const firstInfo = await client.request<{ pid: number }>("info");
  const first = await client.request<WorkerSummary>("spawn", { cwd: stateDir, prompt: "[scenario:slow] first persistent Turn", persistence: "persistent" });
  const target = await client.request<{ id?: string; runtimeId?: string }>("runtime_prepare", { sourceRoot: candidateRoot }, { timeoutMs: 180_000 });
  const targetId = target.runtimeId ?? target.id;
  assert.ok(targetId);
  assert.notEqual(targetId, baseline.id);
  // A second slow Turn is active at the moment the update closes admission.
  await waitTerminal(client, first.id);
  await client.request("continue", { workerId: first.id, prompt: "[scenario:slow] drain this accepted Turn" });
  await client.request("runtime_update", { intentId: "real-handoff", runtimeId: targetId });
  await assert.rejects(() => client.request("spawn", { cwd: stateDir, prompt: "must be rejected while draining" }), /draining/);
  const switchDeadline = Date.now() + 100_000;
  while ((await readUpdateIntent(stateDir))?.phase !== "complete") {
    const intent = await readUpdateIntent(stateDir);
    assert.ok(!["failed", "recovery_required"].includes(intent?.phase ?? ""), JSON.stringify(intent));
    assert.ok(Date.now() < switchDeadline, `handoff must finish: ${JSON.stringify(intent)}`);
    await sleep(100);
  }
  client.close();
  client = new SupervisorClient({ stateDir, autoStart: false });
  await client.connect();
  const nextInfo = await client.request<{ pid: number }>("info");
  assert.notEqual(nextInfo.pid, firstInfo.pid);
  assert.equal(isPidAlive(firstInfo.pid), false, "old process must actually exit before activation");
  assert.equal((await readActiveRuntime(stateDir))?.runtimeId, targetId);
  const metadata = JSON.parse(await readFile(path.join(stateDir, "runtime-backups/real-handoff/runtime-backup.json"), "utf8"));
  assert.equal(metadata.sourceRuntimeId, baseline.id);
  assert.equal(metadata.targetRuntimeId, targetId);
  const second = await client.request<{ worker: WorkerSummary }>("status", { workerId: first.id });
  assert.equal(second.worker.status, "completed");
  assert.equal(second.worker.sessionId, first.sessionId);
  const continued = await client.request<WorkerSummary>("continue", { workerId: first.id, prompt: "[scenario:recall] next Turn after core update" });
  const result = await waitTerminal(client, first.id, 20_000, continued.lastSeq);
  assert.equal(result.worker.status, "completed");
  assert.equal(result.worker.id, first.id);
  assert.equal(result.worker.sessionId, first.sessionId);
  assert.equal(result.worker.resumeCount, 2);
});
