import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteJson } from "../../src/util/fsx.js";

async function lockedRecord(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-atomic-"));
  const file = path.join(dir, "worker.json");
  await atomicWriteJson(file, { original: true });
  const child = spawn(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command",
    "$f=[IO.File]::Open($env:HS_ATOMIC_TEST_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $f.Dispose() }",
  ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HS_ATOMIC_TEST_FILE: file } });
  let output = "";
  let released = false;
  const release = () => { if (!released) { released = true; child.stdin.end("release\n"); } };
  const exited = once(child, "exit");
  t.after(async () => {
    release();
    await exited;
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Lock helper did not become ready: ${output}`)), 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Lock helper exited ${code}: ${output}`)); });
    child.stderr.on("data", b => { output += b.toString(); });
    child.stdout.on("data", b => { output += b.toString(); if (output.includes("READY")) { clearTimeout(timer); resolve(); } });
  });
  return { file, release };
}

test("atomic JSON replacement writes a complete record", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hs-atomic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "record.json");
  await atomicWriteJson(file, { before: true });
  await atomicWriteJson(file, { after: "完整" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { after: "完整" });
});

test("Windows atomic replacement waits for a real transient file lock", { skip: process.platform !== "win32" }, async (t) => {
  const lock = await lockedRecord(t);
  let settled = false;
  const writing = atomicWriteJson(lock.file, { replaced: true }).finally(() => { settled = true; });
  // This must still be pending while Windows denies deletion/replacement.
  await delay(100);
  assert.equal(settled, false);
  assert.deepEqual(JSON.parse(await readFile(lock.file, "utf8")), { original: true });
  lock.release();
  await writing;
  assert.deepEqual(JSON.parse(await readFile(lock.file, "utf8")), { replaced: true });
});

test("Windows persistent file locks fail after bounded retries and preserve the old record", { skip: process.platform !== "win32" }, async (t) => {
  const lock = await lockedRecord(t);
  await assert.rejects(atomicWriteJson(lock.file, { replaced: true }), (error: NodeJS.ErrnoException) =>
    ["EPERM", "EACCES", "EBUSY"].includes(error.code ?? ""));
  assert.deepEqual(JSON.parse(await readFile(lock.file, "utf8")), { original: true });
});
