import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { SupervisorError, serializeError } from "../errors.js";
import type { Supervisor } from "../supervisor.js";
import type { ExtensionUiResponse, SendMode } from "../types.js";
import type { Logger } from "../util/logger.js";
import { JsonlDecoder, serializeJsonLine } from "../util/jsonl.js";
import {
  IPC_VERSION,
  parseEnvelope,
  parseHello,
  tokenDigest,
  type IpcHelloResponse,
  type IpcMethod,
  type IpcResponse,
} from "./protocol.js";

interface SendParams {
  workerId: string;
  message: string;
  mode?: SendMode;
}

interface AnswerParams {
  workerId: string;
  requestId: string;
  response: ExtensionUiResponse;
}

interface CancelParams {
  workerId: string;
  timeoutMs?: number;
}

export interface IpcServerOptions {
  endpoint: string;
  token: string;
  supervisor: Supervisor;
  logger: Logger;
  onShutdown: () => void;
}

export class IpcServer {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly options: IpcServerOptions;
  private readonly tokenDigest: Buffer;
  private closing = false;
  private shutdownSignalled = false;

  constructor(options: IpcServerOptions) {
    this.options = options;
    this.tokenDigest = tokenDigest(options.token);
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  async listen(): Promise<void> {
    if (process.platform !== "win32" && this.options.endpoint.endsWith(".sock")) {
      await import("node:fs/promises")
        .then(({ unlink }) => unlink(this.options.endpoint))
        .catch(() => undefined);
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.endpoint);
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    if (process.platform !== "win32" && this.options.endpoint.endsWith(".sock")) {
      await import("node:fs/promises")
        .then(({ unlink }) => unlink(this.options.endpoint))
        .catch(() => undefined);
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    let authorized = false;
    let helloFailures = 0;
    const decoder = new JsonlDecoder(
      (record) => {
        if (!authorized) {
          const hello = parseHello(record);
          if (!hello) {
            helloFailures += 1;
            this.writeHelloResponse(socket, false, "Invalid hello");
            if (helloFailures >= 3) socket.destroy();
            return;
          }
          const provided = tokenDigest(hello.token);
          const matches =
            provided.length === this.tokenDigest.length && timingSafeEqual(provided, this.tokenDigest);
          if (!matches) {
            helloFailures += 1;
            this.writeHelloResponse(socket, false, "Unauthorized");
            this.options.logger.warn("Rejected IPC client with a bad token");
            if (helloFailures >= 3) socket.destroy();
            return;
          }
          authorized = true;
          clearTimeout(helloTimer);
          this.writeHelloResponse(socket, true);
          return;
        }
        const parsed = parseEnvelope(record);
        if ("error" in parsed) {
          const rawId = (record as { id?: unknown }).id;
          const id = typeof rawId === "string" ? rawId : "unknown";
          this.writeResponse(socket, {
            v: IPC_VERSION,
            type: "response",
            id,
            ok: false,
            error: serializeError(parsed.error),
          });
          return;
        }
        void this.handleRequest(socket, parsed.envelope.id, parsed.envelope.method, parsed.params);
      },
      (raw, error) => {
        this.options.logger.warn("Malformed IPC line", {
          error: error.message,
          preview: raw.slice(0, 200),
        });
      },
      4 * 1024 * 1024,
    );
    const helloTimer = setTimeout(() => {
      if (!authorized) socket.destroy();
    }, 5000);
    helloTimer.unref?.();
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.sockets.delete(socket);
      clearTimeout(helloTimer);
      decoder.end();
    });
  }

  private async handleRequest(
    socket: net.Socket,
    id: string,
    method: IpcMethod,
    params: unknown,
  ): Promise<void> {
    let response: IpcResponse;
    try {
      const result = await this.dispatch(method, params);
      response = { v: IPC_VERSION, type: "response", id, ok: true, result };
    } catch (error) {
      response = {
        v: IPC_VERSION,
        type: "response",
        id,
        ok: false,
        error: serializeError(error),
      };
    }
    this.writeResponse(socket, response);
    if (method === "shutdown" && response.ok && !this.shutdownSignalled) {
      this.shutdownSignalled = true;
      setTimeout(() => this.options.onShutdown(), 100).unref?.();
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const supervisor = this.options.supervisor;
    switch (method) {
      case "spawn": {
        const { requestId, ...input } = params as Parameters<Supervisor["spawn"]>[0] & {
          requestId?: string;
        };
        return supervisor.spawn(input, { requestId });
      }
      case "resume": {
        const { workerId, requestId, ...input } = params as { workerId: string; requestId?: string } & Parameters<
          Supervisor["resume"]
        >[1];
        return supervisor.resume(workerId, input, { requestId });
      }
      case "status": {
        const { workerId, recentEvents } = params as {
          workerId: string;
          recentEvents?: number;
        };
        return supervisor.status(workerId, recentEvents ?? 20);
      }
      case "list": {
        return supervisor.list(params as Parameters<Supervisor["list"]>[0]);
      }
      case "events": {
        const { workerId, sinceSeq, limit } = params as {
          workerId: string;
          sinceSeq?: number;
          limit?: number;
        };
        return supervisor.events(workerId, { sinceSeq, limit });
      }
      case "wait": {
        const { workerId, ...options } = params as { workerId: string } & Parameters<
          Supervisor["wait"]
        >[1];
        return supervisor.wait(workerId, options);
      }
      case "send": {
        const { workerId, message, mode, requestId } = params as SendParams & {
          requestId?: string;
        };
        return supervisor.send(workerId, message, mode ?? "steer", { requestId });
      }
      case "answer": {
        const { workerId, requestId, response } = params as AnswerParams;
        return supervisor.answer(workerId, requestId, response);
      }
      case "cancel": {
        const { workerId, timeoutMs } = params as CancelParams;
        return supervisor.cancel(workerId, { timeoutMs });
      }
      case "info":
        return supervisor.info();
      case "notifications": {
        const { state, workerId, limit } = params as {
          state?: "pending" | "delivered" | "failed" | "all";
          workerId?: string;
          limit?: number;
        };
        return supervisor.notifications({ state, workerId, limit });
      }
      case "notification_ack": {
        const { ids, by } = params as { ids: string[]; by?: string };
        return supervisor.ackNotifications(ids, by);
      }
      case "notification_target": {
        return supervisor.setNotifyTarget(
          params as { channel?: "none" | "codex-queue"; codexThreadId?: string | null },
        );
      }
      case "prune": {
        const { olderThanDays, keep, dryRun, includeSessions } = params as {
          olderThanDays?: number;
          keep?: number;
          dryRun?: boolean;
          includeSessions?: boolean;
        };
        return supervisor.prune({ olderThanDays, keep, dryRun, includeSessions });
      }
      case "notification_retry": {
        const { states } = params as { states?: Array<"pending" | "delivered" | "failed"> };
        const retried = await supervisor.retryNotifications(states);
        return { retried };
      }
      case "ping":
        return { pong: true, pid: process.pid, uptimeMs: Date.now() - Date.parse(supervisor.startedAt) };
      case "shutdown":
        await supervisor.shutdown();
        return { stopped: true };
      default:
        throw new SupervisorError("BAD_REQUEST", `Unknown IPC method: ${method}`);
    }
  }

  private writeHelloResponse(socket: net.Socket, ok: boolean, error?: string): void {
    const response: IpcHelloResponse = {
      v: IPC_VERSION,
      type: "hello_response",
      ok,
      ...(error ? { error: { code: "UNAUTHORIZED", message: error } } : {}),
    };
    this.writeRaw(socket, response);
  }

  private writeResponse(socket: net.Socket, response: IpcResponse): void {
    this.writeRaw(socket, response);
  }

  private writeRaw(socket: net.Socket, value: unknown): void {
    if (socket.destroyed) return;
    try {
      socket.write(serializeJsonLine(value));
    } catch {
      // The client disconnected.
    }
  }
}
