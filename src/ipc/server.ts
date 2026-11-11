import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
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
  type ClientScope,
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
  handlers?: Partial<Record<IpcMethod, (params: unknown) => unknown | Promise<unknown>>>;
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
    let scope: ClientScope | undefined;
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
          scope = hello.scope;
          clearTimeout(helloTimer);
          this.writeHelloResponse(socket, true, undefined, scope !== undefined);
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
        void this.handleRequest(socket, parsed.envelope.id, parsed.envelope.method, parsed.params, scope);
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
    scope?: ClientScope,
  ): Promise<void> {
    let response: IpcResponse;
    try {
      const scopedParams = this.scopeParams(method, params, scope);
      const result = await this.dispatch(method, scopedParams, scope);
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

  private scopeParams(method: IpcMethod, params: unknown, scope?: ClientScope): unknown {
    if (!scope) return params;
    const input = { ...(params as Record<string, unknown>) };
    if (scope.ownerRef !== undefined) {
      const allowed = new Set(["info", "ping", "spawn", "resume", "continue", "admin", "forget", "status", "list", "events", "wait", "send", "answer", "cancel", "notifications", "notification_ack"]);
      if (!allowed.has(method)) throw new SupervisorError("UNAUTHORIZED", "Operation is unavailable to a scoped Master");
      if (typeof input.workerId === "string") this.options.supervisor.assertOwner(input.workerId, scope.ownerRef);
      if (method === "spawn") {
        if (input.taskId !== undefined) throw new SupervisorError("UNSUPPORTED", "Scoped spawn creates its own task metrics");
        input.ownerRef = scope.ownerRef;
        delete input.callerThreadId;
      }
      if (method === "list" || method === "notifications") input.ownerRef = scope.ownerRef;
      // Keys are process-independent yet disjoint across Master sessions.
      if (["spawn", "resume", "continue", "send"].includes(method) && typeof input.requestId === "string") {
        input.requestId = `owner-${createHash("sha256").update(scope.ownerRef).update("\0").update(input.requestId).digest("hex")}`;
      }
    }
    if (scope.notifyNone && ["spawn", "resume", "continue"].includes(method)) {
      input.notifyTarget = { channel: "none" };
      delete input.callerThreadId;
    }
    return input;
  }

  private async dispatch(method: IpcMethod, params: unknown, scope?: ClientScope): Promise<unknown> {
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
      case "continue": {
        const { workerId, requestId, ...input } = params as { workerId: string; requestId?: string } & Parameters<
          Supervisor["continue"]
        >[1];
        return supervisor.continue(workerId, input, { requestId });
      }
      case "admin": {
        const { workerId, action } = params as {
          workerId: string;
          action: Parameters<Supervisor["admin"]>[1];
        };
        return supervisor.admin(workerId, action);
      }
      case "forget": {
        const { workerId } = params as { workerId: string };
        return supervisor.forget(workerId);
      }
      case "compact": {
        return supervisor.compact(
          params as { workerId?: string; keepProgress?: number; dryRun?: boolean },
        );
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
      case "info": {
        const info = supervisor.info();
        if (scope?.ownerRef === undefined) return info;
        const { storage: _storage, ...view } = info;
        return { ...view, wake: { proactive: false, channel: "none", note: "Scoped Master uses worker_wait and its own inbox." }, ownerRef: scope.ownerRef };
      }
      case "notifications": {
        const { state, workerId, limit, unacknowledgedOnly, ownerRef } = params as {
          ownerRef?: string;
          state?: "pending" | "delivered" | "failed" | "all";
          workerId?: string;
          limit?: number;
          unacknowledgedOnly?: boolean;
        };
        return supervisor.notifications({ state, workerId, limit, unacknowledgedOnly, ownerRef });
      }
      case "notification_ack": {
        const { ids, by } = params as { ids: string[]; by?: string };
        return supervisor.ackNotifications(ids, by, scope?.ownerRef);
      }
      case "notification_target": {
        return supervisor.setNotifyTarget(
          params as { channel?: "none" | "codex-queue"; codexThreadId?: string | null },
        );
      }
      case "notification_target_get": {
        return supervisor.getNotifyTarget();
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
      case "metrics_task_create": {
        return supervisor.createMetricsTask(
          params as Parameters<Supervisor["createMetricsTask"]>[0],
        );
      }
      case "metrics_task_show": {
        const { taskId } = params as { taskId: string };
        return supervisor.metricsTask(taskId);
      }
      case "metrics_report": {
        return supervisor.metricsReport(params as Parameters<Supervisor["metricsReport"]>[0]);
      }
      case "metrics_usage_record": {
        return supervisor.recordMetricsUsage(
          params as Parameters<Supervisor["recordMetricsUsage"]>[0],
        );
      }
      case "ping":
        return { pong: true, pid: process.pid, uptimeMs: Date.now() - Date.parse(supervisor.startedAt) };
      case "shutdown":
        await supervisor.shutdown();
        return { stopped: true };
      default:
        if (this.options.handlers?.[method]) return this.options.handlers[method]!(params);
        throw new SupervisorError("BAD_REQUEST", `Unknown IPC method: ${method}`);
    }
  }

  private writeHelloResponse(socket: net.Socket, ok: boolean, error?: string, scopeAccepted?: boolean): void {
    const response: IpcHelloResponse = {
      v: IPC_VERSION,
      type: "hello_response",
      ok,
      ...(scopeAccepted ? { scopeAccepted: true } : {}),
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
