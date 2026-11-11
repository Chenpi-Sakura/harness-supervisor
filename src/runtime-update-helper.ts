#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorError, errorMessage } from "./errors.js";
import { readManagedRuntime, readUpdateIntent, writeUpdateIntent, type RuntimeUpdateIntent } from "./managed-runtime.js";
import { isPidAlive, sleep } from "./util/async.js";
import { readJsonFile } from "./util/fsx.js";

export interface HandoffOptions {
  stateDir: string;
  intentId: string;
  sourceExitTimeoutMs?: number;
  targetReadyTimeoutMs?: number;
}

async function lockCanBeReconciled(stateDir: string): Promise<boolean> {
  const lock = await readJsonFile<{ pid?: number }>(path.join(stateDir, "daemon.lock"));
  return !lock || (Number.isInteger(lock.pid) && !isPidAlive(lock.pid!));
}

/** A one-shot helper never kills a process or removes another daemon's lock. */
export async function runRuntimeHandoff(options: HandoffOptions): Promise<void> {
  const stateDir = path.resolve(options.stateDir);
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, "runtime-handoff.lock");
  const owner = { pid: process.pid, nonce: randomUUID(), intentId: options.intentId };
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 1) throw error;
      const raw = await readFile(file, "utf8");
      let existing: { pid?: number };
      try { existing = JSON.parse(raw) as { pid?: number }; }
      catch { throw new SupervisorError("INVALID_STATE", "Handoff lock is unreadable; manual diagnosis is required"); }
      if (!Number.isInteger(existing.pid) || existing.pid! <= 0 || isPidAlive(existing.pid!)) {
        throw new SupervisorError("CONFLICT", "Another runtime handoff helper may be running");
      }
      if (await readFile(file, "utf8") === raw) await unlink(file);
    }
  }
  try { await performHandoff(options); }
  catch (error) {
    const current = await readUpdateIntent(stateDir).catch(() => null);
    if (current?.id === options.intentId && !["complete", "failed"].includes(current.phase)) {
      current.phase = "recovery_required";
      current.error = errorMessage(error);
      await writeUpdateIntent(stateDir, current).catch(() => undefined);
    }
    throw error;
  }
  finally {
    const current = await readJsonFile<{ nonce?: string }>(file).catch(() => null);
    if (current?.nonce === owner.nonce) await unlink(file).catch(() => undefined);
  }
}

async function performHandoff(options: HandoffOptions): Promise<void> {
  const stateDir = path.resolve(options.stateDir);
  let intent = await readUpdateIntent(stateDir);
  if (!intent || intent.id !== options.intentId || !["switching", "verifying", "recovery_required"].includes(intent.phase)) {
    throw new SupervisorError("INVALID_STATE", "Managed handoff intent is no longer switchable");
  }
  const source = await readManagedRuntime(stateDir, intent.sourceRuntimeId);
  const target = await readManagedRuntime(stateDir, intent.targetRuntimeId);
  const fail = async (message: string) => {
    const current = await readUpdateIntent(stateDir);
    if (current?.id === intent!.id && current.phase !== "complete") {
      current.phase = "recovery_required";
      current.error = message;
      await writeUpdateIntent(stateDir, current);
    }
    throw new SupervisorError("UNCERTAIN", message);
  };
  // Retrying a crashed helper is safe only after every recorded process is
  // confirmed gone. A live or reused PID causes diagnosis, never a forced kill.
  if (intent.targetPid && isPidAlive(intent.targetPid)) {
    await fail("A target process may still be alive; automatic handoff recovery was stopped");
  }
  const sourceDeadline = Date.now() + (options.sourceExitTimeoutMs ?? 40_000);
  while (isPidAlive(intent.sourcePid) || !(await lockCanBeReconciled(stateDir))) {
    if (Date.now() >= sourceDeadline) await fail("Source daemon exit or lock release could not be confirmed");
    await sleep(100);
  }
  intent = (await readUpdateIntent(stateDir))!;
  if (intent.id !== options.intentId || intent.phase === "complete") return;
  intent.phase = "verifying";
  intent.error = undefined;
  await writeUpdateIntent(stateDir, intent);

  async function launch(root: string, runtimeId: string, rollback: boolean): Promise<ChildProcess> {
    const out = openSync(path.join(stateDir, "daemon.out.log"), "a");
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_SUPERVISOR_MANAGED_RUNTIME_ID: runtimeId };
      delete env.HARNESS_SUPERVISOR_UPDATE_INTENT_ID;
      delete env.HARNESS_SUPERVISOR_ROLLBACK_INTENT_ID;
      if (rollback) env.HARNESS_SUPERVISOR_ROLLBACK_INTENT_ID = options.intentId;
      else env.HARNESS_SUPERVISOR_UPDATE_INTENT_ID = options.intentId;
      const child = spawn(process.execPath, [path.join(root, "dist/src/daemon-entry.js"), "--state-dir", stateDir], {
        windowsHide: true, detached: true, stdio: ["ignore", out, out], env,
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      return child;
    } finally { closeSync(out); }
  }
  let child: ChildProcess | undefined;
  let launchError: string | undefined;
  try { child = await launch(target.root, target.id, false); }
  catch (error) { launchError = `Candidate process could not start: ${errorMessage(error)}`; }
  // The target persists its own PID during gated startup. The helper must not
  // overwrite an activation commit that can race the child spawn event.
  const deadline = Date.now() + (options.targetReadyTimeoutMs ?? 45_000);
  while (child && Date.now() < deadline) {
    const current = await readUpdateIntent(stateDir);
    if (current?.id !== intent.id) { child.unref(); await fail("Managed update intent changed during candidate startup"); }
    if (current?.phase === "complete" && current.targetPid === child.pid) { child.unref(); return; }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(100);
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.unref();
    await fail("Candidate did not confirm activation and its exit cannot be established; rollback was stopped");
  }
  const current = await readUpdateIntent(stateDir);
  if (current?.phase === "complete") return; // Admission may already have opened.
  if (!current || current.id !== intent.id || !(await lockCanBeReconciled(stateDir))) {
    await fail("Candidate exited but exclusive daemon ownership cannot be established; rollback was stopped");
  }
  intent.error = launchError ?? `Candidate exited before activation (${child!.exitCode ?? child!.signalCode}); restoring previous verified runtime`;
  intent.phase = "verifying";
  await writeUpdateIntent(stateDir, intent);
  const previous = await launch(source.root, source.id, true);
  const rollbackDeadline = Date.now() + (options.targetReadyTimeoutMs ?? 45_000);
  while (Date.now() < rollbackDeadline) {
    const result = await readUpdateIntent(stateDir);
    if (result?.id === intent.id && result.phase === "failed") { previous.unref(); return; }
    if (previous.exitCode !== null || previous.signalCode !== null) break;
    await sleep(100);
  }
  previous.unref();
  await fail("Previous verified core could not confirm restoration; manual recovery is required");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const stateDir = value("--state-dir"), intentId = value("--intent-id");
  if (!stateDir || !intentId) {
    process.stderr.write("runtime update helper requires --state-dir and --intent-id\n");
    process.exitCode = 2;
  } else {
    runRuntimeHandoff({ stateDir, intentId }).catch((error: unknown) => {
      process.stderr.write(`Managed core handoff stopped: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  }
}
