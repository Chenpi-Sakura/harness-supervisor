import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TestDaemon } from "./helpers.js";
import { isPidAlive, sleep } from "../../src/util/async.js";
import type { WorkerRecord, WorkerSummary, WorkerStatusResult } from "../../src/types.js";

async function host(stateDir: string): Promise<ChildProcess> {
  const script = `import {registerDshHost} from ${JSON.stringify(new URL("../../src/dsh-host-lifecycle.js", import.meta.url).href)};await registerDshHost(process.argv[1]);console.log('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, stateDir], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error("Host registration timed out")); }, 15_000);
    child.stdout!.once("data", () => { clearTimeout(timeout); resolve(); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(Error(`Host exited early: ${code}`)); });
  });
  return child;
}
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  for (let index = 0; index < 100 && isPidAlive(child.pid); index++) await sleep(50);
  assert.equal(isPidAlive(child.pid), false);
}

test("last DSH host exit stops the dedicated daemon and its running Worker", async t => {
  const daemon = await TestDaemon.create("hs-dsh-close-");
  const first = await host(daemon.stateDir), second = await host(daemon.stateDir);
  t.after(async () => { await exited(first); await exited(second); await daemon.stop(); });
  const client = await daemon.start({ env: { HARNESS_SUPERVISOR_UI: "0", FAKE_PI_SLOW_STEP_MS: "60000" } });
  const spawned = await client.request<WorkerSummary>("spawn", { cwd: daemon.stateDir, prompt: "[scenario:slow] wait for host shutdown" });
  let worker: WorkerStatusResult | undefined;
  for (let index = 0; index < 100; index++) {
    worker = await client.request<WorkerStatusResult>("status", { workerId: spawned.id });
    if (worker.worker.pid) break;
    await sleep(50);
  }
  assert.ok(worker?.worker.pid);
  await exited(first);
  await sleep(2500);
  assert.equal(isPidAlive(daemon.child!.pid), true, "another DSH host still owns the instance");
  await exited(second);
  const deadline = Date.now() + 20_000;
  while (isPidAlive(daemon.child!.pid) && Date.now() < deadline) await sleep(100);
  assert.equal(isPidAlive(daemon.child!.pid), false);
  assert.equal(isPidAlive(worker.worker.pid), false, "Worker process must not remain in the background");
  const record: WorkerRecord = JSON.parse(await readFile(path.join(daemon.stateDir, "workers", spawned.id, "worker.json"), "utf8"));
  assert.equal(record.status, "cancelled");
  await assert.rejects(readFile(path.join(daemon.stateDir, "daemon.lock")), /ENOENT/);
});
