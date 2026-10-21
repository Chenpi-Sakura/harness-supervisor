import net from "node:net";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SupervisorError } from "../errors.js";
import type { Logger } from "../util/logger.js";
import { ensureDir } from "../util/fsx.js";
import { JsonlDecoder, serializeJsonLine } from "../util/jsonl.js";
import { sleep } from "../util/async.js";
import { readIpcToken } from "./daemon-state.js";
import {
  IPC_VERSION,
  ipcEndpoint,
  type IpcHelloResponse,
  type IpcMethod,
  type IpcRequest,
  type IpcResponse,
} from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ClientOptions {
  stateDir: string;
  autoStart?: boolean;
  logger?: Logger;
  connectTimeoutMs?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
}

export class SupervisorClient {
  readonly stateDir: string;
  private readonly options: ClientOptions;
  private socket: net.Socket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private decoder: JsonlDecoder | null = null;
  private handshake: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private connected = false;
  private requestCounter = 0;
  private closing = false;

  constructor(options: ClientOptions) {
    this.options = options;
    this.stateDir = path.resolve(options.stateDir);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.closing = false;
    let token = await readIpcToken(this.stateDir);
    if (!token) {
      if (this.options.autoStart === false) {
        throw new SupervisorError(
          "INTERNAL",
          `Supervisor daemon is not running (no IPC token in ${this.stateDir})`,
        );
      }
      await this.startDaemon();
      token = await this.waitForToken();
    }
    try {
      await this.openSocket(token);
    } catch (error) {
      if (this.options.autoStart === false) throw error;
      this.teardownSocket();
      await this.startDaemon();
      const nextToken = await this.waitForToken();
      await this.openSocket(nextToken);
    }
  }

  async request<T = unknown>(
    method: IpcMethod,
    params: unknown = {},
    options: RequestOptions = {},
  ): Promise<T> {
    if (!this.connected || !this.socket) {
      await this.connect();
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new SupervisorError("INTERNAL", "Supervisor connection is not available");
    }
    const id = `c-${++this.requestCounter}`;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const envelope: IpcRequest = {
      v: IPC_VERSION,
      type: "request",
      id,
      method,
      params,
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SupervisorError("TIMEOUT", `Supervisor request ${method} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        socket.write(serializeJsonLine(envelope));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new SupervisorError(
            "INTERNAL",
            `Failed to send supervisor request: ${(error as Error).message}`,
          ),
        );
      }
    });
  }

  async shutdown(): Promise<unknown> {
    const result = await this.request("shutdown", {}, { timeoutMs: 60_000 });
    this.close();
    return result;
  }

  close(): void {
    this.closing = true;
    this.teardownSocket();
  }

  private async openSocket(token: string): Promise<void> {
    if (this.connected) return;
    this.teardownSocket();
    this.closing = false;
    const endpoint = ipcEndpoint(this.stateDir);
    const socket = net.createConnection(endpoint);
    this.socket = socket;
    socket.setNoDelay(true);
    this.decoder = new JsonlDecoder(
      (record) => this.handleRecord(record),
      () => {
        // Malformed IPC records make the connection unusable.
        socket.destroy();
      },
      32 * 1024 * 1024,
    );
    socket.on("data", (chunk: Buffer) => this.decoder?.push(chunk));
    socket.on("error", (error) => this.handleSocketFailure(error));
    socket.on("close", () => {
      this.connected = false;
      this.handleSocketClosed();
    });

    const waitForConnect = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new SupervisorError("TIMEOUT", "Timed out connecting to supervisor daemon"));
      }, this.options.connectTimeoutMs ?? 5000);
      timer.unref?.();
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(
          new SupervisorError("INTERNAL", `Cannot connect to supervisor daemon: ${error.message}`),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    try {
      await waitForConnect;
      const helloDone = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.handshake = null;
          reject(new SupervisorError("TIMEOUT", "Supervisor IPC handshake timed out"));
        }, 5000);
        timer.unref?.();
        this.handshake = {
          resolve: () => {
            clearTimeout(timer);
            this.handshake = null;
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            this.handshake = null;
            reject(error);
          },
        };
      });
      socket.write(
        serializeJsonLine({
          v: IPC_VERSION,
          type: "hello",
          token,
        }),
      );
      await helloDone;
      this.connected = true;
    } catch (error) {
      this.teardownSocket();
      throw error;
    }
  }

  private handleRecord(record: Record<string, unknown>): void {
    if (record.type === "hello_response") {
      const hello = record as unknown as IpcHelloResponse;
      if (hello.ok) {
        this.handshake?.resolve();
      } else {
        const message = hello.error?.message ?? "Supervisor rejected IPC authentication";
        this.handshake?.reject(new SupervisorError("UNAUTHORIZED", message));
      }
      return;
    }
    if (record.type !== "response") return;
    const response = record as unknown as IpcResponse;
    if (typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const serialized = response.error ?? { code: "INTERNAL", message: "Unknown supervisor error" };
      pending.reject(
        new SupervisorError(
          serialized.code as ConstructorParameters<typeof SupervisorError>[0],
          serialized.message,
          serialized.details,
        ),
      );
    }
  }

  private handleSocketFailure(error: Error): void {
    if (this.handshake) {
      this.handshake.reject(
        new SupervisorError("INTERNAL", `Supervisor connection failed: ${error.message}`),
      );
    }
  }

  private handleSocketClosed(): void {
    this.connected = false;
    if (this.handshake) {
      this.handshake.reject(
        new SupervisorError("INTERNAL", "Supervisor closed the connection during handshake"),
      );
    }
    const error = new SupervisorError(
      "INTERNAL",
      this.closing
        ? "Supervisor client closed"
        : "Supervisor daemon disconnected while a request was in flight",
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private teardownSocket(): void {
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    this.decoder = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
    }
    if (this.handshake) {
      this.handshake.reject(new SupervisorError("INTERNAL", "Supervisor connection was reset"));
      this.handshake = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SupervisorError("INTERNAL", "Supervisor connection was reset"));
    }
    this.pending.clear();
  }

  private async waitForToken(): Promise<string> {
    const deadline = Date.now() + (this.options.connectTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      const token = await readIpcToken(this.stateDir);
      if (token) return token;
      await sleep(100);
    }
    throw new SupervisorError(
      "TIMEOUT",
      `Supervisor did not become ready. See ${path.join(this.stateDir, "daemon.out.log")}`,
    );
  }

  private async startDaemon(): Promise<void> {
    await ensureDir(this.stateDir);
    const entry = resolveDaemonEntry();
    const logPath = path.join(this.stateDir, "daemon.out.log");
    const out = openSync(logPath, "a");
    try {
      const child = spawn(process.execPath, [entry, "--state-dir", this.stateDir], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
        env: process.env,
      });
      child.unref();
      this.options.logger?.info("Spawned supervisor daemon", { pid: child.pid, logPath });
    } catch (error) {
      throw new SupervisorError(
        "INTERNAL",
        `Failed to start supervisor daemon: ${(error as Error).message}`,
      );
    } finally {
      closeSync(out);
    }
    // If another daemon wins the lock, polling still connects to it.
    const deadline = Date.now() + (this.options.connectTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      await sleep(100);
      const token = await readIpcToken(this.stateDir);
      if (!token) continue;
      try {
        await this.openSocket(token);
        return;
      } catch {
        this.teardownSocket();
      }
    }
    throw new SupervisorError(
      "TIMEOUT",
      `Supervisor daemon did not start within the timeout. See ${logPath}`,
    );
  }
}

export function resolveDaemonEntry(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HARNESS_SUPERVISOR_DAEMON_ENTRY;
  if (explicit) return path.resolve(explicit);
  const here = fileURLToPath(import.meta.url);
  const candidate = path.resolve(path.dirname(here), "..", "daemon-entry.js");
  if (existsSync(candidate)) return candidate;
  throw new SupervisorError(
    "INTERNAL",
    `Daemon entry not found at ${candidate}. Run "npm run build" before using auto-start.`,
  );
}
