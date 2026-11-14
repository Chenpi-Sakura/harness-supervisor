import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { claimIndependentState, dshHostsAlive, hostIdentityInspector, registerDshHost } from "../../src/dsh-host-lifecycle.js";
import { retainRuntime } from "../../src/runtime-cache.js";

const state = () => mkdtemp(path.join(os.tmpdir(), "hs-dsh-owner-"));
async function record(dir: string, pid: number, startedAt: string | null) {
  await mkdir(path.join(dir, "dsh-hosts"), { recursive: true });
  await writeFile(path.join(dir, "dsh-host-lifecycle.json"), JSON.stringify({ schemaVersion: 1, mode: "follow-dsh" }));
  await writeFile(path.join(dir, "dsh-hosts", `${pid}-${randomUUID()}.json`), JSON.stringify({ schemaVersion: 1, pid, startedAt }));
}

test("independent instances do not follow a host, and lifecycle modes cannot share a directory", async () => {
  const dir = await state();
  assert.equal(await dshHostsAlive(dir), null);
  await claimIndependentState(dir);
  assert.equal(await dshHostsAlive(dir), null);
  await assert.rejects(registerDshHost(dir), /独立 HS/);
  const dedicated = await state();
  await registerDshHost(dedicated);
  await assert.rejects(claimIndependentState(dedicated), /DSH 专属/);
});

test("plugin consumer disposal does not release application ownership", async () => {
  const dir = await state();
  await registerDshHost(dir);
  await registerDshHost(dir);
  const release = await retainRuntime(dir, dir);
  await release();
  assert.equal((await readdir(path.join(dir, "dsh-hosts"))).length, 1);
  assert.equal(await dshHostsAlive(dir), true);
});

test("all hosts must exit; unknown identity remains alive; corrupt records fail closed", async () => {
  const dir = await state();
  await record(dir, 2147483647, null);
  await record(dir, process.pid, null);
  assert.equal(await dshHostsAlive(dir), true);
  assert.equal((await readdir(path.join(dir, "dsh-hosts"))).length, 1);
  const exited = await state();
  await record(exited, 2147483647, null);
  assert.equal(await dshHostsAlive(exited), false);
  await writeFile(path.join(exited, "dsh-hosts", `${process.pid}-${randomUUID()}.json`), "broken");
  await assert.rejects(dshHostsAlive(exited));
});

test("PID identity cache never deletes a new host registered during the cache TTL", async () => {
  const first = "2026-01-01T00:00:00.000Z", second = "2026-01-02T00:00:00.000Z";
  let actual = first, reads = 0;
  const inspect = hostIdentityInspector(async () => { reads++; return { startedAt: actual, commandLine: "DSH" }; });
  assert.equal((await inspect(process.pid, first)).startedAt, first);
  actual = second;
  assert.equal((await inspect(process.pid, second)).startedAt, second);
  const dir = await state();
  await record(dir, process.pid, first);
  await record(dir, process.pid, second);
  assert.equal(await dshHostsAlive(dir, inspect), true);
  assert.equal((await readdir(path.join(dir, "dsh-hosts"))).length, 1);
  assert.ok(reads >= 2, "a different expected identity must bypass the old PID cache");
});
