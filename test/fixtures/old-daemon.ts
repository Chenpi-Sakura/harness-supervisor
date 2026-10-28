import net from "node:net";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { IPC_VERSION, ipcEndpoint } from "../../src/ipc/protocol.js";
import { JsonlDecoder, serializeJsonLine } from "../../src/util/jsonl.js";

interface FixtureRequest {
  method: string;
  params: unknown;
}

/**
 * Independent old-daemon IPC fixture.
 *
 * It intentionally implements only the 0.2-era methods: unknown methods and
 * unknown notification parameters fail like the old strict zod schemas did.
 * It is never connected to a real daemon or real worker.
 */
export class OldDaemonFixture {
  readonly stateDir: string;
  readonly requests: FixtureRequest[] = [];
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(stateDir: string, private readonly version = "0.2.0") {
    this.stateDir = path.resolve(stateDir);
  }

  get endpoint(): string {
    return ipcEndpoint(this.stateDir);
  }

  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(
      path.join(this.stateDir, "ipc.token"),
      `${"f".repeat(64)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    this.server = net.createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(this.endpoint);
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== "win32") {
      await unlink(this.endpoint).catch(() => undefined);
    }
  }

  private handle(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    const decoder = new JsonlDecoder(
      (record) => this.handleRecord(socket, record),
      () => socket.destroy(),
    );
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
  }

  private handleRecord(socket: net.Socket, record: Record<string, unknown>): void {
    if (record.type === "hello") {
      socket.write(
        serializeJsonLine({
          v: IPC_VERSION,
          type: "hello_response",
          ok: record.token === `${"f".repeat(64)}`,
          ...(record.token === `${"f".repeat(64)}`
            ? {}
            : { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
        }),
      );
      return;
    }
    if (record.type !== "request") return;
    const id = typeof record.id === "string" ? record.id : "";
    const method = typeof record.method === "string" ? record.method : "";
    const params = record.params ?? {};
    this.requests.push({ method, params });
    const response = this.respond(method, params);
    socket.write(serializeJsonLine({ v: IPC_VERSION, type: "response", id, ...response }));
  }

  private respond(
    method: string,
    params: unknown,
  ): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
    if (method === "info") {
      return {
        ok: true,
        result: {
          name: "harness-supervisor",
          version: this.version,
          pid: process.pid,
          stateDir: this.stateDir,
          supervisorId: "old-fixture-supervisor",
          startedAt: "2026-01-01T00:00:00.000Z",
          uptimeMs: 1,
          limits: {
            maxWorkers: 8,
            maxWaitMs: 120_000,
            defaultWaitMs: 30_000,
            closeGraceMs: 1_500,
            abortTimeoutMs: 20_000,
            maxResultBytes: 65_536,
            maxEventStringBytes: 8_192,
          },
          wake: {
            proactive: false,
            channel: "none",
            workerRouting: true,
            note: "old fixture",
          },
          runtimes: [],
        },
      };
    }
    if (method === "spawn") {
      const input = params as Record<string, unknown>;
      const now = new Date().toISOString();
      return {
        ok: true,
        result: {
          schemaVersion: 1,
          id: "w-old-fixture",
          runtime: typeof input.runtime === "string" ? input.runtime : "pi",
          cwd: typeof input.cwd === "string" ? input.cwd : this.stateDir,
          status: "running",
          createdAt: now,
          updatedAt: now,
          lastSeq: 1,
          eventCount: 1,
          stats: { turns: 0, toolCalls: 0, toolErrors: 0 },
          capabilities: {
            runtime: "pi",
            steer: false,
            followUp: false,
            cancel: false,
            resume: false,
            pause: false,
            interactiveInput: false,
            notes: "old fixture",
          },
          config: {},
          resumeCount: 0,
          supervisorId: "old-fixture-supervisor",
          notifyTarget: input.notifyTarget ?? { channel: "none" },
          notificationBinding: {
            target: input.notifyTarget ?? { channel: "none" },
            source: "daemon-default",
            wake:
              (input.notifyTarget as { channel?: string } | undefined)?.channel === "codex-queue"
                ? "bound"
                : "unbound",
            observation:
              (input.notifyTarget as { channel?: string } | undefined)?.channel === "codex-queue"
                ? "wake"
                : "wait",
            warnings: [],
          },
          pidAlive: true,
          resumeAvailable: false,
        },
      };
    }
    if (method === "notifications") {
      if (
        params &&
        typeof params === "object" &&
        Object.prototype.hasOwnProperty.call(params, "unacknowledgedOnly")
      ) {
        // The 0.2 notifications schema was strict: this parameter did not exist.
        return {
          ok: false,
          error: {
            code: "BAD_REQUEST",
            message: "Invalid params for notifications: Unrecognized key: unacknowledgedOnly",
          },
        };
      }
      return {
        ok: true,
        result: {
          notifications: [
            {
              id: "old-worker#1",
              workerId: "old-worker",
              runtime: "pi",
              seq: 1,
              eventType: "run.completed",
              kind: "completed",
              createdAt: "2026-01-01T00:00:00.000Z",
              summary: { status: "completed", text: "old inbox only" },
              delivery: { state: "pending", channel: "none", attempts: 0 },
            },
          ],
          counts: { pending: 1, delivered: 0, failed: 0, unacked: 1 },
          target: { channel: "codex-queue", codexThreadId: "old-default-thread" },
        },
      };
    }
    if (method === "shutdown") {
      return { ok: true, result: { stopped: true } };
    }
    return {
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: `Unknown IPC method: ${method}`,
      },
    };
  }
}
