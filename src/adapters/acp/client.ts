import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { SupervisorError, errorMessage } from "../../errors.js";
import type { HarnessCloseResult, HarnessExit } from "../../types.js";
import { Deferred, withTimeout } from "../../util/async.js";
import { safeText } from "../../util/redact.js";

export interface AcpLaunchSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  description?: string;
  /** Needed when a Windows cmd.exe wrapper carries its own quoting. */
  windowsVerbatimArguments?: boolean;
}

/**
 * ACP is ndJSON over stdio: one JSON-RPC 2.0 message per line. This client owns
 * only the transport and process lifecycle; runtime-specific session semantics
 * (how a session is created or resumed, which updates matter, permission
 * policy) stay in the runtime adapter.
 */
export interface AcpClientHandlers {
  /** `session/update` notification from the agent. */
  onUpdate?: (params: unknown) => void;
  /** Any other agent-to-client notification (including extension methods). */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Agent-to-client request. Returning false sends JSON-RPC method-not-found so
   * the agent does not wait forever.
   */
  onRequest?: (
    method: string,
    params: unknown,
    id: number | string,
  ) => boolean | Promise<boolean>;
  onExit?: (exit: HarnessExit) => void;
}

export interface AcpClientOptions {
  launch: AcpLaunchSpec;
  runtimeLabel: string;
  diagnosticTag: string;
  handlers?: AcpClientHandlers;
  requestTimeoutMs?: number;
  stderrTailBytes?: number;
  onStderr?: (text: string) => void;
  onDiagnostic?: (text: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

export class AcpClient {
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly runtimeLabel: string;
  private readonly diagnosticTag: string;
  private readonly handlers: AcpClientHandlers;
  private readonly onStderr?: (text: string) => void;
  private readonly onDiagnostic?: (text: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly maxStderrTail: number;
  private readonly closed = new Deferred<HarnessExit>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrDecoder = new StringDecoder("utf8");
  private requestCounter = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private exitInfo: HarnessExit | null = null;
  private exited = false;
  private forced = false;

  private constructor(child: ChildProcessWithoutNullStreams, options: AcpClientOptions) {
    this.child = child;
    this.pid = child.pid;
    this.runtimeLabel = options.runtimeLabel;
    this.diagnosticTag = options.diagnosticTag;
    this.handlers = options.handlers ?? {};
    this.onStderr = options.onStderr;
    this.onDiagnostic = options.onDiagnostic;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.maxStderrTail = options.stderrTailBytes ?? 32 * 1024;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = this.stderrDecoder.write(chunk);
      this.appendStderr(text);
      if (text) this.onStderr?.(text);
    });
    child.on("error", (error) => {
      this.diagnostic(`Harness process error: ${error.message}`);
    });
    child.on("close", (code, signal) => this.handleClose(code, signal));
  }

  static async start(options: AcpClientOptions): Promise<AcpClient> {
    const child = spawn(options.launch.file, options.launch.args, {
      cwd: options.launch.cwd,
      env: options.launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: options.launch.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    const client = new AcpClient(child, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(
            new SupervisorError(
              "HARNESS_ERROR",
              `Failed to start ${options.runtimeLabel}: ${error.message}`,
              { launch: options.launch.description },
            ),
          );
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      throw error;
    }
    return client;
  }

  isAlive(): boolean {
    return !this.exited && this.child.exitCode === null;
  }

  stderrTail(): string {
    return safeText(this.stderrBuffer, 16 * 1024);
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.isAlive()) {
      return Promise.reject(
        new SupervisorError("HARNESS_ERROR", `${this.runtimeLabel} process is not running`, {
          stderrTail: this.stderrTail(),
        }),
      );
    }
    const id = this.nextId();
    const limit = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = limit > 0
        ? setTimeout(() => {
            this.pending.delete(String(id));
            reject(
              new SupervisorError(
                "HARNESS_TIMEOUT",
                `${this.runtimeLabel} request timed out after ${limit}ms: ${method}`,
                { method },
              ),
            );
          }, limit)
        : undefined;
      timer?.unref?.();
      this.pending.set(String(id), { resolve, reject, timer, method });
      this.write({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        const entry = this.pending.get(String(id));
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(String(id));
        reject(
          error instanceof Error
            ? error
            : new SupervisorError("HARNESS_ERROR", errorMessage(error)),
        );
      });
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.isAlive()) return;
    await this.write({ jsonrpc: "2.0", method, params });
  }

  async reply(id: number | string, result: unknown): Promise<void> {
    if (!this.isAlive()) return;
    await this.write({ jsonrpc: "2.0", id, result });
  }

  async replyError(id: number | string, code: number, message: string): Promise<void> {
    if (!this.isAlive()) return;
    await this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async close(options?: { graceMs?: number }): Promise<HarnessCloseResult> {
    const graceMs = options?.graceMs ?? 1500;
    if (this.exited) return { exit: this.exitInfo, forced: this.forced };
    try {
      this.child.stdin.end();
    } catch {
      // Fall through to killing.
    }
    let exited = await this.waitForExit(graceMs);
    if (!exited) {
      this.forced = true;
      await this.forceKill();
      exited = await this.waitForExit(3000);
    }
    if (!exited) {
      this.diagnostic(`${this.runtimeLabel} process did not exit after stdin close and forced termination`);
    }
    return { exit: this.exitInfo, forced: this.forced };
  }

  async forceKill(): Promise<void> {
    if (this.exited || !this.pid) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill.exe", ["/PID", String(this.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.once("error", () => resolve());
        killer.once("close", () => resolve());
      });
    } else {
      try {
        process.kill(-this.pid, "SIGKILL");
      } catch {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await this.waitForExit(3000);
  }

  private nextId(): string {
    return `hs-${++this.requestCounter}`;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.diagnostic(`Invalid JSON from ${this.runtimeLabel}: ${line.slice(0, 300)}`);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    const rawId = message.id;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined;
    const hasId = id !== undefined;

    if (method) {
      if (method === "session/update") {
        this.handlers.onUpdate?.(message.params);
        return;
      }
      if (method === "$/cancel_request") {
        this.handlers.onNotification?.(method, message.params);
        // It is normally a notification. If the agent sent it as a request,
        // still acknowledge so the agent is not left waiting.
        if (hasId) void this.reply(id, {}).catch(() => undefined);
        return;
      }
      if (hasId) {
        void Promise.resolve(this.handlers.onRequest?.(method, message.params, id) ?? false)
          .then((handled) => {
            if (!handled) {
              return this.replyError(id, -32601, `Method not found: ${method}`);
            }
            return undefined;
          })
          .catch((error: unknown) => {
            this.diagnostic(`Failed to handle ${method}: ${errorMessage(error)}`);
            return this.replyError(id, -32603, "Internal error").catch(() => undefined);
          });
        return;
      }
      this.handlers.onNotification?.(method, message.params);
      return;
    }

    if (!hasId) return;
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) {
      this.diagnostic(`Response for unknown request id ${key}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(key);
    if (message.error) {
      const error = message.error as { code?: number; message?: string } | undefined;
      pending.reject(
        new SupervisorError(
          "HARNESS_ERROR",
          safeText(
            `${this.runtimeLabel} ${pending.method} failed: ${error?.message ?? "unknown error"}`,
            2000,
          ),
          { method: pending.method, code: error?.code },
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    this.rejectPending(
      new SupervisorError(
        "HARNESS_ERROR",
        `${this.runtimeLabel} process exited (code=${code}, signal=${signal})`,
        { code, signal },
      ),
    );
    const exit = this.exitInfo;
    this.closed.resolve(exit);
    try {
      this.handlers.onExit?.(exit);
    } catch {
      // Callback failures must not break process cleanup.
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    if (!this.isAlive()) {
      throw new SupervisorError(
        "HARNESS_ERROR",
        `Cannot write to ${this.runtimeLabel}: process is not running`,
      );
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(
            new SupervisorError(
              "HARNESS_ERROR",
              `Failed to write to ${this.runtimeLabel} stdin: ${error.message}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    try {
      await withTimeout(this.closed.promise, timeoutMs, "timed out waiting for harness exit");
      return true;
    } catch {
      return false;
    }
  }

  private appendStderr(text: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${text}`;
    if (this.stderrBuffer.length > this.maxStderrTail) {
      this.stderrBuffer = this.stderrBuffer.slice(-this.maxStderrTail);
    }
  }

  private diagnostic(message: string): void {
    const line = `${new Date().toISOString()} [${this.diagnosticTag}] ${message}\n`;
    this.appendStderr(line);
    this.onDiagnostic?.(message);
  }
}
