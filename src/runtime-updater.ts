import { withRuntimeCache } from "./runtime-cache.js";
import { pruneManagedRuntimes } from "./runtime-retention.js";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { cp, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { SupervisorError, errorMessage } from "./errors.js";
import {
  commitActiveRuntime, packageRootFromModule, prepareManagedRuntime, readActiveRuntime,
  readManagedRuntime, readUpdateIntent, writeUpdateIntent,
  type ManagedRuntime, type RuntimeUpdateIntent,
} from "./managed-runtime.js";
import type { Supervisor } from "./supervisor.js";
import { atomicWriteJson, readJsonFile } from "./util/fsx.js";
import type { Logger } from "./util/logger.js";
import { VERSION } from "./version.js";

export interface RuntimeUpdaterOptions {
  stateDir: string;
  supervisor: Supervisor;
  logger: Logger;
  shutdown: () => Promise<void>;
  packageRoot?: string;
  /** Isolated process-failure testing; normal daemons use Node's spawn. */
  spawnHelper?: typeof spawn;
}

/** One daemon-owned drain, followed by a short-lived helper using the normal daemon lock. */
export class RuntimeUpdater {
  private readonly options: RuntimeUpdaterOptions;
  private intent: RuntimeUpdateIntent | null = null;
  private timer?: NodeJS.Timeout;
  private serial: Promise<unknown> = Promise.resolve();
  private closed = false;
  private handingOff = false;
  private startupGate = false;
  private bootstrapRuntimeId?: string;

  constructor(options: RuntimeUpdaterOptions) { this.options = options; }

  async initialize(): Promise<void> {
    this.intent = await readUpdateIntent(this.options.stateDir);
    const runtimeId = process.env.HARNESS_SUPERVISOR_MANAGED_RUNTIME_ID;
    const intentId = process.env.HARNESS_SUPERVISOR_UPDATE_INTENT_ID;
    const rollbackId = process.env.HARNESS_SUPERVISOR_ROLLBACK_INTENT_ID;
    if (intentId || rollbackId) {
      const intent = this.intent;
      if (!intent || intent.id !== (intentId ?? rollbackId) || !runtimeId ||
        runtimeId !== (rollbackId ? intent.sourceRuntimeId : intent.targetRuntimeId) ||
        !["switching", "verifying", "recovery_required"].includes(intent.phase)) {
        throw new SupervisorError("INVALID_STATE", "Managed handoff startup context does not match persisted intent");
      }
      const runtime = await readManagedRuntime(this.options.stateDir, runtimeId);
      if (runtime.version !== VERSION || path.resolve(this.options.packageRoot ?? packageRootFromModule()) !== runtime.root) {
        throw new SupervisorError("INVALID_STATE", "Managed handoff started an unexpected core artifact");
      }
      this.options.supervisor.beginDrain(intent.id);
      this.startupGate = true;
      if (!rollbackId) {
        intent.phase = "verifying";
        intent.targetPid = process.pid;
        await writeUpdateIntent(this.options.stateDir, intent);
      }
      return;
    }
    if (this.intent && ["switching", "verifying", "recovery_required"].includes(this.intent.phase)) {
      throw new SupervisorError("INVALID_STATE", "A managed handoff requires recovery; refusing to start an unrelated daemon", {
        intentId: this.intent.id, phase: this.intent.phase,
      });
    }
    if (this.intent?.phase === "draining") {
      const active = await readActiveRuntime(this.options.stateDir);
      if (active?.runtimeId !== this.intent.sourceRuntimeId) {
        throw new SupervisorError("INVALID_STATE", "Draining source no longer matches the managed runtime pointer");
      }
      this.options.supervisor.beginDrain(this.intent.id);
    }
    const active = await readActiveRuntime(this.options.stateDir);
    const runningRoot = path.resolve(this.options.packageRoot ?? packageRootFromModule());
    if (active && runningRoot !== (await readManagedRuntime(this.options.stateDir, active.runtimeId)).root) {
      throw new SupervisorError("INVALID_STATE", "Start the committed managed core through the shared runtime resolver");
    }
    if (!active) {
      const manifest = await readJsonFile<{ id?: string }>(path.join(runningRoot, "runtime-manifest.json"));
      if (manifest?.id) {
        const cached = await readManagedRuntime(this.options.stateDir, manifest.id);
        if (cached.root !== runningRoot || cached.version !== VERSION) throw new SupervisorError("INVALID_STATE", "Cached bootstrap core does not match this daemon");
        this.bootstrapRuntimeId = cached.id;
        this.options.supervisor.beginDrain(`bootstrap-${cached.id}`);
      }
    }
  }

  /** Called only after IPC endpoint and normal daemon lock are live. */
  async ready(): Promise<void> {
    if (this.bootstrapRuntimeId) {
      const lock = await readJsonFile<{ pid: number }>(path.join(this.options.stateDir, "daemon.lock"));
      if (lock?.pid !== process.pid || !this.options.supervisor.drainStatus().ready) throw new SupervisorError("INVALID_STATE", "Cached bootstrap cannot establish quiescent daemon ownership");
      await this.options.supervisor.flushForHandoff();
      await commitActiveRuntime(this.options.stateDir, this.bootstrapRuntimeId);
      this.options.supervisor.cancelDrain(`bootstrap-${this.bootstrapRuntimeId}`);
      this.bootstrapRuntimeId = undefined;
    }
    if (!this.startupGate) {
      // Recovered drains may be quiescent immediately. Do not launch a helper
      // until the daemon has finished initialization and owns a live endpoint.
      if (this.intent?.phase === "draining") this.arm();
      else void pruneManagedRuntimes(this.options.stateDir, this.options.logger);
      return;
    }
    const intent = this.intent!;
    const rollback = process.env.HARNESS_SUPERVISOR_ROLLBACK_INTENT_ID === intent.id;
    const runtimeId = rollback ? intent.sourceRuntimeId : intent.targetRuntimeId;
    const lock = await readJsonFile<{ pid: number; stateDir: string }>(path.join(this.options.stateDir, "daemon.lock"));
    if (lock?.pid !== process.pid || path.resolve(lock.stateDir) !== path.resolve(this.options.stateDir)) {
      throw new SupervisorError("INVALID_STATE", "Managed target does not own the daemon lock");
    }
    if (!this.options.supervisor.drainStatus().ready) {
      throw new SupervisorError("INVALID_STATE", "Recovered state contains unresolved active or orphaned workers; refusing core activation");
    }
    await this.options.supervisor.flushForHandoff();
    if (rollback) {
      await commitActiveRuntime(this.options.stateDir, runtimeId);
      intent.phase = "failed";
      intent.error = intent.error ?? "Candidate exited before activation; previous verified runtime restored";
    } else {
      // Ordering is deliberate: a crash before the intent commit keeps every
      // client closed; a complete intent proves the selected runtime is active.
      await commitActiveRuntime(this.options.stateDir, runtimeId, intent.sourceRuntimeId);
      intent.phase = "complete";
      intent.targetPid = process.pid;
    }
    await writeUpdateIntent(this.options.stateDir, intent);
    // The previous core may predate backup metadata. Its persisted handoff
    // intent is enough to identify this one backup without guessing history.
    if (intent.backupDir) {
      try {
        const expected = path.join(path.resolve(this.options.stateDir), "runtime-backups", intent.id.replaceAll(":", "_"));
        const normalized = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
        if (normalized(path.resolve(intent.backupDir)) !== normalized(expected) ||
          (await lstat(expected)).isSymbolicLink() || normalized(await realpath(expected)) !== normalized(expected)) throw Error("Backup path is redirected");
        await atomicWriteJson(path.join(expected, "runtime-backup.json"), {
          schemaVersion: 1, sourceRuntimeId: intent.sourceRuntimeId, targetRuntimeId: intent.targetRuntimeId, intentId: intent.id,
        });
      } catch (error) { this.options.logger.warn("Runtime backup identification deferred", { intentId: intent.id, error: String(error) }); }
    }
    this.options.supervisor.cancelDrain(intent.id);
    this.startupGate = false;
    void pruneManagedRuntimes(this.options.stateDir, this.options.logger);
    this.options.logger.info(rollback ? "Previous managed core restored" : "Managed core activated", {
      intentId: intent.id, runtimeId,
    });
  }

  async status(): Promise<{
    managed: boolean;
    activeRuntimeId?: string;
    intent: RuntimeUpdateIntent | null;
    drain: ReturnType<Supervisor["drainStatus"]>;
  }> {
    const active = await readActiveRuntime(this.options.stateDir);
    return {
      managed: !!active, activeRuntimeId: active?.runtimeId,
      intent: this.intent ? structuredClone(this.intent) : null,
      drain: this.options.supervisor.drainStatus(),
    };
  }

  async prepare(sourceRoot: string): Promise<ManagedRuntime> {
    return this.exclusive(async () => {
      if (this.intent && ["draining", "switching", "verifying", "recovery_required"].includes(this.intent.phase)) {
        throw new SupervisorError("CONFLICT", "An update is already pending; finish or cancel it before preparing another core");
      }
      await this.ensureBaseline();
      return prepareManagedRuntime(this.options.stateDir, sourceRoot);
    });
  }

  async apply(input: { intentId: string; runtimeId: string }): Promise<RuntimeUpdateIntent> {
    return this.exclusive(() => withRuntimeCache(this.options.stateDir, async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(input.intentId)) {
        throw new SupervisorError("BAD_REQUEST", "Invalid update intent ID");
      }
      if (this.intent?.id === input.intentId) {
        if (this.intent.targetRuntimeId !== input.runtimeId) throw new SupervisorError("CONFLICT", "Update intent ID was already used for another core");
        return structuredClone(this.intent);
      }
      if (this.intent && ["draining", "switching", "verifying", "recovery_required"].includes(this.intent.phase)) {
        throw new SupervisorError("CONFLICT", "Another managed update is already pending", { intentId: this.intent.id });
      }
      const source = await this.ensureBaseline();
      await readManagedRuntime(this.options.stateDir, input.runtimeId);
      if (source.runtimeId === input.runtimeId) throw new SupervisorError("INVALID_STATE", "The requested core is already active");
      const intent: RuntimeUpdateIntent = {
        schemaVersion: 1, id: input.intentId, phase: "draining", sourceRuntimeId: source.runtimeId,
        targetRuntimeId: input.runtimeId, sourcePid: process.pid,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      this.options.supervisor.beginDrain(intent.id);
      try { await writeUpdateIntent(this.options.stateDir, intent); }
      catch (error) { this.options.supervisor.cancelDrain(intent.id); throw error; }
      this.intent = intent;
      this.arm();
      return structuredClone(intent);
    }));
  }

  async cancel(intentId: string): Promise<RuntimeUpdateIntent> {
    return this.exclusive(async () => {
      if (!this.intent || this.intent.id !== intentId) throw new SupervisorError("NOT_FOUND", "Managed update intent does not exist");
      if (this.intent.phase === "cancelled") return structuredClone(this.intent);
      if (this.intent.phase !== "draining") throw new SupervisorError("INVALID_STATE", "Only a draining update can be cancelled");
      this.intent.phase = "cancelled";
      await writeUpdateIntent(this.options.stateDir, this.intent);
      this.options.supervisor.cancelDrain(intentId);
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      return structuredClone(this.intent);
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async ensureBaseline() {
    const active = await readActiveRuntime(this.options.stateDir);
    if (active) return active;
    const baseline = await prepareManagedRuntime(this.options.stateDir, this.options.packageRoot ?? packageRootFromModule());
    if (baseline.version !== VERSION) throw new SupervisorError("INVALID_STATE", "Running core does not match the baseline package");
    await commitActiveRuntime(this.options.stateDir, baseline.id);
    return (await readActiveRuntime(this.options.stateDir))!;
  }

  private arm(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.exclusive(() => this.tick()).catch((error: unknown) => {
        this.options.logger.error("Managed update drain failed", { error: errorMessage(error) });
      });
    }, 500);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.closed || this.handingOff || this.intent?.phase !== "draining" || !this.options.supervisor.drainStatus().ready) return;
    const intent = this.intent;
    await this.options.supervisor.flushForHandoff();
    this.options.supervisor.sealDrain(intent.id);
    const source = await readManagedRuntime(this.options.stateDir, intent.sourceRuntimeId);
    await readManagedRuntime(this.options.stateDir, intent.targetRuntimeId);
    const backupDir = path.join(this.options.stateDir, "runtime-backups", intent.id.replaceAll(":", "_"));
    await mkdir(backupDir, { recursive: true });
    await atomicWriteJson(path.join(backupDir, "runtime-backup.json"), {
      schemaVersion: 1, sourceRuntimeId: intent.sourceRuntimeId, targetRuntimeId: intent.targetRuntimeId, intentId: intent.id,
    });
    for (const name of ["workers", "sessions", "metrics", "notifications.jsonl", "notify-target.json", "idempotency.jsonl"]) {
      try { await cp(path.join(this.options.stateDir, name), path.join(backupDir, name), { recursive: true, dereference: false, errorOnExist: false }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!this.options.supervisor.drainStatus().ready) throw new SupervisorError("INVALID_STATE", "Supervisor ceased to be quiescent during backup");
    intent.backupDir = backupDir;
    intent.phase = "switching";
    intent.sourcePid = process.pid;
    await writeUpdateIntent(this.options.stateDir, intent);
    this.handingOff = true;
    let log: number | undefined;
    let helperSpawned = false;
    try {
      log = openSync(path.join(this.options.stateDir, "runtime-update.log"), "a");
      const child = (this.options.spawnHelper ?? spawn)(process.execPath, [path.join(source.root, "dist/src/runtime-update-helper.js"), "--state-dir", this.options.stateDir, "--intent-id", intent.id], {
        detached: true, windowsHide: true, stdio: ["ignore", log, log], env: process.env,
      });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      helperSpawned = true;
      intent.helperPid = child.pid;
      await writeUpdateIntent(this.options.stateDir, intent);
      child.unref();
    } catch (error) {
      // A helper known never to have started leaves the source safe to reopen.
      // Once it started, an uncertain persistence failure needs diagnosis.
      intent.phase = helperSpawned ? "recovery_required" : "failed";
      intent.error = errorMessage(error);
      await writeUpdateIntent(this.options.stateDir, intent);
      if (!helperSpawned) {
        this.options.supervisor.cancelDrain(intent.id);
        this.handingOff = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
      }
      throw error;
    } finally { if (log !== undefined) closeSync(log); }
    this.close();
    await this.options.shutdown();
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(run);
    this.serial = next.catch(() => undefined);
    return next;
  }
}
