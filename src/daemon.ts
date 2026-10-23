import { randomUUID } from "node:crypto";
import path from "node:path";
import { McodeAdapter } from "./adapters/mcode/adapter.js";
import { PiAdapter } from "./adapters/pi/adapter.js";
import { QoderAdapter } from "./adapters/qoder/adapter.js";
import { SupervisorError, errorMessage } from "./errors.js";
import { IpcServer } from "./ipc/server.js";
import {
  acquireDaemonLock,
  ensureIpcToken,
  removeEndpointInfoIfOwned,
  writeEndpointInfo,
} from "./ipc/daemon-state.js";
import { ipcEndpoint, resolveStateDir } from "./ipc/protocol.js";
import { Store } from "./store.js";
import { Supervisor } from "./supervisor.js";
import type { HarnessAdapter } from "./types.js";
import { Deferred, clampInt } from "./util/async.js";
import { ensureDir } from "./util/fsx.js";
import { createLogger, type Logger } from "./util/logger.js";
import { VERSION, TOOL_NAME } from "./version.js";

export interface DaemonOptions {
  stateDir?: string;
  foreground?: boolean;
  logger?: Logger;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clampInt(parsed, min, max);
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const stateDir = resolveStateDir(options.stateDir);
  await ensureDir(stateDir);
  const logger =
    options.logger ?? createLogger(path.join(stateDir, "daemon.log"), options.foreground === true);
  const done = new Deferred<void>();
  const lock = await acquireDaemonLock(stateDir);
  const token = await ensureIpcToken(stateDir);
  const endpoint = ipcEndpoint(stateDir);
  const supervisorId = randomUUID();
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
  const qoderAdapter = new QoderAdapter({
    abortTimeoutMs,
    onStderr: (workerId, text) => {
      void store.appendStderr(workerId, text).catch((error: unknown) => {
        logger.warn(`Failed to persist stderr for ${workerId}`, { error: errorMessage(error) });
      });
    },
    onDiagnostic: (workerId, message) => {
      logger.warn(`Qoder CLI diagnostic for ${workerId}`, { message });
    },
  });
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
  const supervisor = new Supervisor({
    store,
    adapters: new Map<string, HarnessAdapter>([
      ["pi", piAdapter],
      ["qoder", qoderAdapter],
      ["mcode", mcodeAdapter],
    ]),
    logger,
    supervisorId,
    stateDir,
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
  await supervisor.init();

  let server: IpcServer;
  let shuttingDown = false;
  let hardExitTimer: NodeJS.Timeout | undefined;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Supervisor daemon shutting down", { reason });
    hardExitTimer = setTimeout(() => {
      logger.error("Graceful shutdown exceeded 30 seconds; forcing exit");
      process.exit(1);
    }, 30_000);
    hardExitTimer.unref?.();
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
    await lock.release();
    logger.info("Supervisor daemon stopped");
    await logger.flush();
    if (hardExitTimer) clearTimeout(hardExitTimer);
    done.resolve();
  };

  server = new IpcServer({
    endpoint,
    token,
    supervisor,
    logger,
    onShutdown: () => {
      void shutdown("ipc_request");
    },
  });

  try {
    await server.listen();
  } catch (error) {
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
  });
  logger.info("Supervisor daemon started", {
    name: TOOL_NAME,
    version: VERSION,
    pid: process.pid,
    endpoint,
    stateDir,
  });

  let signalCount = 0;
  const onSignal = (signal: string) => {
    signalCount += 1;
    if (signalCount > 1) {
      process.exit(1);
      return;
    }
    logger.info("Received signal", { signal });
    void shutdown(`signal:${signal}`);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGBREAK", () => onSignal("SIGBREAK"));
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception in supervisor daemon", { error: errorMessage(error) });
    void shutdown("uncaught_exception").finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection in supervisor daemon", {
      error: errorMessage(reason),
    });
    void shutdown("unhandled_rejection").finally(() => process.exit(1));
  });

  await done.promise;
}
