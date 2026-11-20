import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DshAdapter } from "./adapters/dsh/adapter.js";
import { NativeAcpAdapter } from "./adapters/native-acp/adapter.js";
import { McodeAdapter } from "./adapters/mcode/adapter.js";
import { PiAdapter } from "./adapters/pi/adapter.js";
import { QoderAdapter } from "./adapters/qoder/adapter.js";
import { SupervisorError, errorMessage } from "./errors.js";
import { IpcServer } from "./ipc/server.js";
import {
  acquireDaemonLock,
  ensureIpcToken,
  isPidReuse,
  removeEndpointInfoIfOwned,
  releaseDaemonLockSync,
  writeEndpointInfo,
  type DaemonLock,
} from "./ipc/daemon-state.js";
import { ipcEndpoint, resolveStateDir, type EndpointInfo } from "./ipc/protocol.js";
import { Store } from "./store.js";
import { Supervisor } from "./supervisor.js";
import type { HarnessAdapter } from "./types.js";
import { Deferred, clampInt } from "./util/async.js";
import { ensureDir, atomicWriteJson, readJsonFile } from "./util/fsx.js";
import { createLogger, type Logger } from "./util/logger.js";
import { inspectProcess } from "./util/process.js";
import { prepareWorkerGuard } from "./worker-guard.js";
import { VERSION, TOOL_NAME } from "./version.js";
import { WebUiServer } from "./web-ui.js";
import { RuntimeUpdater } from "./runtime-updater.js";
import { watchDshHosts } from "./dsh-host-lifecycle.js";

export interface DaemonOptions {
  stateDir?: string;
  foreground?: boolean;
  logger?: Logger;
}

interface DaemonExitRecord {
  instanceId: string;
  pid: number;
  version: string;
  trigger: string;
  reason: string;
  requestedAt: string;
  stoppedAt?: string;
  status: "stopping" | "stopped";
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clampInt(parsed, min, max);
}

/**
 * Release the daemon lock when the process exits.
 *
 * The graceful shutdown releases the lock, but the hard exit timer, a second
 * signal and a throw during startup end the process without running it. The
 * exit handler covers those paths: it only performs synchronous work, it never
 * throws and it never removes a lock that belongs to another pid.
 */
export function registerDaemonLockExitRelease(lock: DaemonLock): void {
  process.on("exit", () => {
    releaseDaemonLockSync(lock.path, lock.pid);
  });
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const stateDir = resolveStateDir(options.stateDir);
  await ensureDir(stateDir);
  const logger =
    options.logger ?? createLogger(path.join(stateDir, "daemon.log"), options.foreground === true);
  const instanceId = randomUUID();
  const trigger = process.env.HARNESS_SUPERVISOR_START_TRIGGER?.trim() || "direct";
  const endpointFile = path.join(stateDir, "endpoint.json");
  const exitRecordFile = path.join(stateDir, "daemon-exit.json");
  logger.info("Supervisor daemon entry", {
    instanceId,
    version: VERSION,
    pid: process.pid,
    ppid: process.ppid,
    node: process.version,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    stateDir,
    trigger,
    foreground: options.foreground === true,
  });
  const done = new Deferred<void>();
  let lock: DaemonLock;
  try {
    lock = await acquireDaemonLock(stateDir, {
      onConflict: ({ existing, identity, decision }) => {
        logger.warn("Supervisor daemon lock conflict", {
          instanceId,
          lockPid: existing.pid,
          lockStateDir: existing.stateDir,
          holderStartedAt: existing.startedAt ?? null,
          holderAlive: identity.alive,
          holderVerified: identity.verified,
          holderStartedAtObserved: identity.startedAt,
          lockFile: path.join(stateDir, "daemon.lock"),
          decision: decision.outcome,
          decisionReason: "reason" in decision ? decision.reason : undefined,
        });
      },
    });
  } catch (error) {
    // The refusal is written through an async logger queue; flush before the
    // entry point exits or the only diagnostic for the conflict is lost.
    await logger.flush();
    throw error;
  }
  logger.info("Supervisor daemon lock acquired", { instanceId, lockFile: lock.path, pid: process.pid });
  // Every exit path has to release the lock, including the ones that skip the
  // graceful shutdown (hard exit timer, second signal, throw during startup).
  registerDaemonLockExitRelease(lock);
  const previousEndpoint = await readJsonFile<EndpointInfo>(endpointFile).catch(() => null);
  const previousExitRecord = await readJsonFile<DaemonExitRecord>(exitRecordFile).catch(() => null);
  if (previousEndpoint || previousExitRecord) {
    const previousIdentity = previousEndpoint && previousEndpoint.pid !== process.pid
      ? await inspectProcess(previousEndpoint.pid, [previousEndpoint.stateDir ?? stateDir, "daemon-entry"]).catch(() => null)
      : null;
    const recordMatchesEndpoint = previousExitRecord !== null && previousExitRecord !== undefined &&
      (previousEndpoint
        ? previousEndpoint.instanceId
          ? previousExitRecord.instanceId === previousEndpoint.instanceId
          : previousExitRecord.pid === previousEndpoint.pid
        : true);
    const previousCompleted = recordMatchesEndpoint &&
      (previousExitRecord?.status === "stopped" || previousExitRecord?.status === "stopping");
    const previousPidReused = previousEndpoint !== null && previousEndpoint !== undefined &&
      (previousEndpoint.pid === process.pid ||
        isPidReuse(previousEndpoint.startedAt, previousIdentity?.startedAt));
    const previousProcess = !previousEndpoint
      ? previousCompleted ? "exited" : "no-endpoint"
      : previousPidReused
        ? "pid-reused"
        : !previousIdentity?.alive
          ? "exited"
          : previousIdentity.verified === false
            ? "pid-reused"
            : previousIdentity.verified === true
              ? "still-running"
              : "unverifiable";
    const previousExit = recordMatchesEndpoint && previousExitRecord &&
      (previousExitRecord.status === "stopped" || previousExitRecord.status === "stopping")
      ? {
          reason: previousExitRecord.reason,
          requestedAt: previousExitRecord.requestedAt,
          stoppedAt: previousExitRecord.stoppedAt ?? null,
          completed: previousExitRecord.status === "stopped",
        }
      : "unknown";
    logger.info("Supervisor daemon previous instance", {
      instanceId,
      previousPid: previousEndpoint?.pid ?? (recordMatchesEndpoint ? previousExitRecord?.pid ?? null : null),
      previousVersion: previousEndpoint?.version ?? null,
      previousInstanceId: previousEndpoint?.instanceId ?? (recordMatchesEndpoint ? previousExitRecord?.instanceId ?? null : null),
      previousStartedAt: previousEndpoint?.startedAt ?? null,
      previousProcess,
      previousProcessVerified: previousIdentity?.verified ?? null,
      previousExit,
    });
    // The record is evidence for one restart only. Keeping it would let a much
    // later crash inherit an older clean-stop reason when endpoint.json is gone.
    await rm(exitRecordFile, { force: true }).catch(() => undefined);
  }
  let shutdownStartedAt: string | null = null;
  const writeExitRecord = async (status: DaemonExitRecord["status"], reason: string): Promise<void> => {
    const now = new Date().toISOString();
    const record: DaemonExitRecord = {
      instanceId,
      pid: process.pid,
      version: VERSION,
      trigger,
      reason,
      requestedAt: shutdownStartedAt ?? now,
      status,
      ...(status === "stopped" ? { stoppedAt: now } : {}),
    };
    await atomicWriteJson(exitRecordFile, record).catch((error: unknown) => {
      logger.warn("Failed to persist daemon exit record", { instanceId, error: errorMessage(error) });
    });
  };
  const forceExit = (code: number): void => {
    const timer = setTimeout(() => process.exit(code), 500);
    timer.unref?.();
    void logger.flush().catch(() => undefined).finally(() => {
      clearTimeout(timer);
      process.exit(code);
    });
  };
  const token = await ensureIpcToken(stateDir);
  const endpoint = ipcEndpoint(stateDir);
  const supervisorId = instanceId;
  const store = new Store(stateDir, logger);
  // The harness adapters must agree with the supervisor on how long a cancel may
  // take, otherwise the adapter waits on a different budget than the caller.
  const abortTimeoutMs = intEnv("HARNESS_SUPERVISOR_ABORT_TIMEOUT_MS", 20_000, 500, 120_000);
  const piAdapter = new PiAdapter({
    abortTimeoutMs,
    onStderr: (workerId, text) => {
      void store.appendStderr(workerId, text).catch((error: unknown) => {
        logger.warn(`Failed to persist stderr for ${workerId}`, { error: errorMessage(error) });
      });
    },
    onDiagnostic: (workerId, message) => {
      logger.warn(`Pi RPC diagnostic for ${workerId}`, { message });
    },
  });
  const qoderAdapters = (["qoder", "qoder-cn"] as const).map(runtime => [runtime, new QoderAdapter({
    runtime,
    abortTimeoutMs,
    onStderr: (workerId, text) => {
      void store.appendStderr(workerId, text).catch((error: unknown) => {
        logger.warn(`Failed to persist stderr for ${workerId}`, { error: errorMessage(error) });
      });
    },
    onDiagnostic: (workerId, message) => {
      logger.warn(`${runtime} CLI diagnostic for ${workerId}`, { message });
    },
  })] as const);
  const mcodeAdapter = new McodeAdapter({
    abortTimeoutMs,
    onStderr: (workerId, text) => {
      void store.appendStderr(workerId, text).catch((error: unknown) => {
        logger.warn(`Failed to persist stderr for ${workerId}`, { error: errorMessage(error) });
      });
    },
    onDiagnostic: (workerId, message) => {
      logger.warn(`MiniMax Code ACP diagnostic for ${workerId}`, { message });
    },
  });
  const dshAdapter = new DshAdapter({
    abortTimeoutMs,
    onStderr: (workerId, text) => {
      void store.appendStderr(workerId, text).catch((error: unknown) => {
        logger.warn(`Failed to persist stderr for ${workerId}`, { error: errorMessage(error) });
      });
    },
    onDiagnostic: (workerId, message) => {
      logger.warn(`DeepSeek Harness ACP diagnostic for ${workerId}`, { message });
    },
  });
  const workerGuard = await prepareWorkerGuard(stateDir, logger).catch((error: unknown) => {
    // A guard failure must never prevent the daemon from starting workers.
    logger.warn("Worker command guard setup failed", { error: errorMessage(error) });
    return null;
  });
  if (workerGuard) {
    logger.info("Worker command guard installed", {
      realBin: workerGuard.realBin,
      dir: workerGuard.dir,
    });
  }
  const supervisor = new Supervisor({
    store,
    adapters: new Map<string, HarnessAdapter>([
      ["pi", piAdapter],
      ...qoderAdapters,
      ["mcode", mcodeAdapter],
      ["dsh", dshAdapter],
      ...(["codex", "claude", "opencode"] as const).map(runtime => [runtime, new NativeAcpAdapter(runtime, { abortTimeoutMs,
        onStderr: (workerId: string, text: string) => { void store.appendStderr(workerId, text).catch(error => logger.warn("Failed to persist native ACP stderr", { error: errorMessage(error) })); },
      })] as const),
    ]),
    logger,
    supervisorId,
    stateDir,
    ...(workerGuard ? { workerEnv: (workerId: string) => workerGuard.envFor(workerId) } : {}),
    limits: {
      maxWorkers: intEnv("HARNESS_SUPERVISOR_MAX_WORKERS", 8, 1, 64),
      maxWaitMs: intEnv("HARNESS_SUPERVISOR_MAX_WAIT_MS", 120_000, 1000, 600_000),
      defaultWaitMs: intEnv("HARNESS_SUPERVISOR_DEFAULT_WAIT_MS", 30_000, 0, 600_000),
      closeGraceMs: intEnv("HARNESS_SUPERVISOR_CLOSE_GRACE_MS", 1500, 100, 30_000),
      abortTimeoutMs,
    },
    notify: {
      channel: process.env.HARNESS_SUPERVISOR_NOTIFY_CHANNEL === "codex-queue" ? "codex-queue" : "none",
      codexThreadId: process.env.HARNESS_SUPERVISOR_CODEX_WAKE_THREAD || undefined,
    },
  });
  try {
    await supervisor.init();
  } catch (error) {
    logger.error("Supervisor daemon startup failed", {
      instanceId,
      stage: "supervisor_init",
      error: errorMessage(error),
    });
    await logger.flush();
    throw error;
  }

  let server: IpcServer;
  const webUi = new WebUiServer({ supervisor, port: intEnv("HARNESS_SUPERVISOR_UI_PORT", 61114, 1, 65535) });
  let updater: RuntimeUpdater;
  let shuttingDown = false;
  let hardExitTimer: NodeJS.Timeout | undefined;
  let stopHostWatch: (() => void) | undefined;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownStartedAt ??= new Date().toISOString();
    stopHostWatch?.();
    updater?.close();
    logger.info("Supervisor daemon shutting down", { instanceId, reason });
    // Install the deadline before touching disk: a blocked exit-record write
    // must not leave shutdown without a time limit.
    hardExitTimer = setTimeout(() => {
      logger.error("Graceful shutdown exceeded 30 seconds; forcing exit", { instanceId, reason });
      forceExit(1);
    }, 30_000);
    hardExitTimer.unref?.();
    await writeExitRecord("stopping", reason);
    try {
      await webUi.stop();
    } catch (error) {
      logger.warn("WebUI close failed", { error: errorMessage(error) });
    }
    try {
      await supervisor.shutdown();
    } catch (error) {
      logger.error("Supervisor shutdown failed", { error: errorMessage(error) });
    }
    try {
      await server.close();
    } catch (error) {
      logger.warn("IPC server close failed", { error: errorMessage(error) });
    }
    await removeEndpointInfoIfOwned(stateDir);
    // Keep the lock until both the clean-stop record and its log line are on
    // disk. Otherwise a replacement daemon can log a start before this stop.
    await writeExitRecord("stopped", reason);
    logger.info("Supervisor daemon stopped", {
      instanceId,
      reason,
      durationMs: shutdownStartedAt ? Date.now() - Date.parse(shutdownStartedAt) : null,
      version: VERSION,
    });
    await logger.flush();
    await lock.release();
    if (hardExitTimer) clearTimeout(hardExitTimer);
    done.resolve();
  };

  updater = new RuntimeUpdater({ stateDir, supervisor, logger, shutdown: () => shutdown("managed_update") });
  try {
    await updater.initialize();
  } catch (error) {
    logger.error("Supervisor daemon startup failed", {
      instanceId,
      stage: "runtime_updater",
      error: errorMessage(error),
    });
    await shutdown("managed_startup_failed");
    throw error;
  }

  server = new IpcServer({
    endpoint,
    token,
    supervisor,
    logger,
    onShutdown: () => {
      void shutdown("ipc_request");
    },
    handlers: {
      ui_start: (params) => {
        const input = params as { ownerRef?: string; preferredOwnerRef?: string; frameOrigin?: string; viewKey?: string; viewGeneration?: number };
        return webUi.launch(input);
      },
      ui_stop: async () => { await webUi.stop(); return { stopped: true }; },
      ui_status: () => webUi.status(),
      ui_context: (params) => webUi.updateMasterContext(params),
      runtime_prepare: async (params) => {
        const runtime = await updater.prepare((params as { sourceRoot: string }).sourceRoot);
        return { id: runtime.id, runtimeId: runtime.id, version: runtime.version, root: runtime.root };
      },
      runtime_update: (params) => updater.apply(params as { intentId: string; runtimeId: string }),
      runtime_update_status: () => updater.status(),
      runtime_update_cancel: (params) => updater.cancel((params as { intentId: string }).intentId),
    },
  });

  try {
    await server.listen();
  } catch (error) {
    logger.error("Supervisor daemon startup failed", {
      instanceId,
      stage: "ipc_listen",
      endpoint,
      error: errorMessage(error),
    });
    await lock.release();
    await logger.flush();
    const code = (error as NodeJS.ErrnoException).code;
    throw new SupervisorError(
      "INTERNAL",
      code === "EADDRINUSE"
        ? `Supervisor endpoint is already in use: ${endpoint}`
        : `Failed to start supervisor IPC server: ${(error as Error).message}`,
      { endpoint },
    );
  }

  await writeEndpointInfo(stateDir, {
    endpoint,
    pid: process.pid,
    stateDir,
    startedAt: supervisor.startedAt,
    version: VERSION,
    instanceId,
  });
  logger.info("Supervisor daemon IPC ready", { instanceId, endpoint, pid: process.pid });
  try {
    await updater.ready();
  } catch (error) {
    await shutdown("managed_verification_failed");
    throw error;
  }
  if (!shuttingDown && process.env.HARNESS_SUPERVISOR_UI !== "0") {
    try {
      await webUi.enable();
    } catch (error) {
      // An optional UI must never prevent the daemon from serving Workers.
      logger.warn("Default WebUI could not start; retry with the ui command", { error: errorMessage(error) });
    }
  }
  logger.info("Supervisor daemon started", {
    name: TOOL_NAME,
    version: VERSION,
    instanceId,
    trigger,
    pid: process.pid,
    // The parent pid identifies the process tree that started the daemon; it is
    // the missing evidence when a daemon dies without a trace.
    ppid: process.ppid,
    endpoint,
    stateDir,
  });
  if (!shuttingDown) stopHostWatch = watchDshHosts(stateDir, logger, () => shutdown("dsh_hosts_closed"));

  let signalCount = 0;
  const onSignal = (signal: string) => {
    signalCount += 1;
    if (signalCount > 1) {
      logger.error("Supervisor daemon forced exit after repeated signal", { instanceId, signal });
      forceExit(1);
      return;
    }
    logger.info("Received signal", { instanceId, signal });
    void shutdown(`signal:${signal}`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGBREAK", () => onSignal("SIGBREAK"));
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception in supervisor daemon", { instanceId, error: errorMessage(error) });
    void shutdown("uncaught_exception").finally(() => forceExit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection in supervisor daemon", {
      instanceId,
      error: errorMessage(reason),
    });
    void shutdown("unhandled_rejection").finally(() => forceExit(1));
  });

  await done.promise;
}
