import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { SupervisorError, errorMessage } from "../../errors.js";
import type {
  ExtensionUiResponse,
  HarnessCallbacks,
  HarnessCloseResult,
  HarnessExit,
  HarnessQueueContents,
  HarnessSession,
  HarnessStateInfo,
  PendingInput,
} from "../../types.js";
import { Deferred, withTimeout } from "../../util/async.js";
import { JsonlDecoder, serializeJsonLine } from "../../util/jsonl.js";
import { safeJson, safeText } from "../../util/redact.js";
import {
  DEFAULT_INPUT_TIMEOUT_MS,
  PI_INPUT_TIMEOUT_ENV,
  pickInputTimeoutMs,
  resolveRuntimeInputTimeoutMs,
} from "../../input-timeout.js";
import type { PiLaunch } from "./launch.js";

export interface PiRpcSessionOptions {
  launch: PiLaunch;
  args: string[];
  cwd: string;
  callbacks: HarnessCallbacks;
  onStderr?: (text: string) => void;
  onDiagnostic?: (text: string) => void;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  stderrTailBytes?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

interface AssistantState {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

type PiUsageTotals = "input" | "output" | "cacheRead" | "cacheWrite" | "total";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class PiRpcSession implements HarnessSession {
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly callbacks: HarnessCallbacks;
  private readonly onStderr?: (text: string) => void;
  private readonly onDiagnostic?: (text: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly abortTimeoutMs: number;
  private readonly maxStderrTail: number;
  private readonly decoder: JsonlDecoder;
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly closed = new Deferred<HarnessExit>();
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private stderrBuffer = "";
  private exitInfo: HarnessExit | null = null;
  private exited = false;
  private forced = false;
  private settledSeen = false;
  private runSeen = false;
  private lastAssistant: AssistantState | null = null;
  private turns = 0;
  private usageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    seen: false,
  };
  private usageProvider: string | undefined;
  private usageModelId: string | undefined;

  private constructor(child: ChildProcessWithoutNullStreams, options: PiRpcSessionOptions) {
    this.child = child;
    this.pid = child.pid;
    this.callbacks = options.callbacks;
    this.onStderr = options.onStderr;
    this.onDiagnostic = options.onDiagnostic;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.abortTimeoutMs = options.abortTimeoutMs ?? 20_000;
    this.maxStderrTail = options.stderrTailBytes ?? 32 * 1024;

    this.decoder = new JsonlDecoder(
      (record) => this.handleRecord(record),
      (raw, error) => {
        this.diagnostic(`Invalid JSONL from harness (${error.message}): ${raw.slice(0, 300)}`);
      },
    );

    child.stdout.on("data", (chunk: Buffer) => this.decoder.push(chunk));
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

  static async start(options: PiRpcSessionOptions): Promise<PiRpcSession> {
    const child = spawn(options.launch.file, [...options.launch.args, ...options.args], {
      cwd: options.cwd,
      env: options.launch.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const session = new PiRpcSession(child, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(
            new SupervisorError("HARNESS_ERROR", `Failed to start Pi: ${error.message}`, {
              launch: options.launch.description,
            }),
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
    return session;
  }

  get turnCount(): number {
    return this.turns;
  }

  get lastSettled(): boolean {
    return this.settledSeen;
  }

  isAlive(): boolean {
    return !this.exited && this.child.exitCode === null;
  }

  stderrTail(): string {
    return safeText(this.stderrBuffer, 16 * 1024);
  }

  async getState(): Promise<HarnessStateInfo> {
    const data = (await this.request({ type: "get_state" }, this.requestTimeoutMs)) as
      | Record<string, unknown>
      | undefined;
    const sessionId = typeof data?.sessionId === "string" ? data.sessionId : undefined;
    const sessionFile = typeof data?.sessionFile === "string" ? data.sessionFile : undefined;
    return { sessionId, sessionFile };
  }

  async prompt(message: string): Promise<{ disposition: string }> {
    const data = (await this.request({ type: "prompt", message }, this.requestTimeoutMs)) as
      | Record<string, unknown>
      | undefined;
    return { disposition: typeof data?.disposition === "string" ? data.disposition : "started" };
  }

  async steer(message: string): Promise<void> {
    await this.request({ type: "steer", message }, this.requestTimeoutMs);
  }

  async followUp(message: string): Promise<void> {
    await this.request({ type: "follow_up", message }, this.requestTimeoutMs);
  }

  async clearQueue(): Promise<HarnessQueueContents> {
    const data = (await this.request({ type: "clear_queue" }, this.requestTimeoutMs)) as
      | Record<string, unknown>
      | undefined;
    return {
      steering: stringArray(data?.steering),
      followUp: stringArray(data?.followUp),
    };
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" }, this.abortTimeoutMs);
  }

  async answer(requestId: string, response: ExtensionUiResponse): Promise<void> {
    const record: Record<string, unknown> = {
      type: "extension_ui_response",
      id: requestId,
    };
    if ("cancelled" in response) record.cancelled = true;
    else if ("confirmed" in response) record.confirmed = response.confirmed;
    else record.value = response.value;
    await this.write(record);
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
      this.diagnostic("Harness process did not exit after stdin close and forced termination");
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

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    try {
      await withTimeout(this.closed.promise, timeoutMs, "timed out waiting for harness exit");
      return true;
    } catch {
      return false;
    }
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    this.decoder.end();
    this.rejectPending(
      new SupervisorError("HARNESS_ERROR", `Harness process exited (code=${code}, signal=${signal})`, {
        code,
        signal,
      }),
    );
    const exit = this.exitInfo;
    this.closed.resolve(exit);
    try {
      this.callbacks.onExit(exit);
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

  private request(command: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (!this.isAlive()) {
      return Promise.reject(
        new SupervisorError("HARNESS_ERROR", "Harness process is not running", {
          stderrTail: this.stderrTail(),
        }),
      );
    }
    const id = `hs-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SupervisorError(
            "HARNESS_TIMEOUT",
            `Harness command timed out after ${timeoutMs}ms: ${String(command.type)}`,
            { command: command.type },
          ),
        );
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        command: String(command.type),
      });
      this.write({ ...command, id }).catch((error: unknown) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new SupervisorError("HARNESS_ERROR", errorMessage(error)),
        );
      });
    });
  }

  private async write(record: Record<string, unknown>): Promise<void> {
    if (!this.isAlive()) {
      throw new SupervisorError("HARNESS_ERROR", "Cannot write to harness: process is not running");
    }
    const line = serializeJsonLine(record);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(
            new SupervisorError("HARNESS_ERROR", `Failed to write to harness stdin: ${error.message}`),
          );
        } else {
          resolve();
        }
      });
    });
  }

  private handleRecord(record: Record<string, unknown>): void {
    if (record.type === "response") {
      this.handleResponse(record);
      return;
    }
    if (record.type === "extension_ui_request") {
      this.handleExtensionUi(record);
      return;
    }
    switch (record.type) {
      case "agent_start": {
        if (!this.runSeen) {
          this.runSeen = true;
          // A new process may carry a previous assistant message only through
          // state; never let it become this run's cancellation fallback.
          this.lastAssistant = null;
          this.emit({ type: "run_started" });
        } else {
          this.emit({ type: "progress", kind: "agent_restart" });
        }
        break;
      }
      case "turn_end":
        this.turns += 1;
        this.emit({ type: "progress", kind: "turn_complete" });
        break;
      case "tool_execution_start": {
        const tool = typeof record.toolName === "string" ? record.toolName : "unknown";
        this.emit({
          type: "progress",
          kind: "tool_start",
          tool,
          detail: summarizeToolArgs(record.args),
        });
        break;
      }
      case "tool_execution_end": {
        const tool = typeof record.toolName === "string" ? record.toolName : "unknown";
        this.emit({
          type: "progress",
          kind: "tool_end",
          tool,
          isError: record.isError === true,
          durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
        });
        break;
      }
      case "message_end":
        this.handleMessageEnd(record);
        break;
      case "auto_retry_start": {
        this.emit({
          type: "progress",
          kind: "retry",
          detail: safeText(
            `attempt ${String(record.attempt ?? "?")}/${String(record.maxAttempts ?? "?")}: ${String(record.errorMessage ?? "")}`,
            300,
          ),
        });
        break;
      }
      case "auto_retry_end": {
        if (record.success !== true) {
          this.emit({
            type: "progress",
            kind: "retry_failed",
            isError: true,
            detail: safeText(String(record.finalError ?? "automatic retry failed"), 300),
          });
        }
        break;
      }
      case "compaction_start": {
        this.emit({ type: "progress", kind: "compaction_start", detail: String(record.reason ?? "") });
        break;
      }
      case "compaction_end": {
        this.emit({
          type: "progress",
          kind: "compaction_end",
          isError: Boolean(record.errorMessage),
          detail: record.errorMessage ? safeText(String(record.errorMessage), 300) : undefined,
        });
        break;
      }
      case "extension_error": {
        this.emit({
          type: "run_error",
          message: safeText(
            `Extension error in ${String(record.event ?? "handler")}: ${String(record.error ?? "unknown")}`,
            1000,
          ),
          fatal: false,
        });
        break;
      }
      case "agent_settled": {
        if (this.settledSeen) break;
        this.settledSeen = true;
        const aborted = record.aborted === true || this.lastAssistant?.stopReason === "aborted";
        const failed = !aborted && this.lastAssistant?.stopReason === "error";
        if (this.usageTotals.seen) {
          this.emit({
            type: "usage",
            usage: {
              ...(this.usageProvider ? { provider: this.usageProvider } : {}),
              ...(this.usageModelId ? { modelId: this.usageModelId } : {}),
              inputTokens: this.usageTotals.input,
              outputTokens: this.usageTotals.output,
              cacheReadTokens: this.usageTotals.cacheRead,
              cacheWriteTokens: this.usageTotals.cacheWrite,
              reportedTotalTokens: this.usageTotals.total,
            },
          });
        }
        this.emit({
          type: "settled",
          aborted,
          stopReason: this.lastAssistant?.stopReason,
          finalText: this.lastAssistant?.text,
          error: failed
            ? this.lastAssistant?.errorMessage ?? "Assistant run ended with an error"
            : undefined,
        });
        break;
      }
      case "agent_end":
      case "message_start":
      case "message_update":
      case "turn_start":
      case "queue_update":
      case "session_info_changed":
      case "thinking_level_changed":
      case "entry_appended":
      case "bash_execution_update":
        break;
      default:
        break;
    }
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id) {
      if (record.success === false) {
        this.diagnostic(`Harness rejected a command without an id: ${String(record.error ?? "unknown")}`);
      }
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (record.success === true) {
      pending.resolve(record.data);
    } else {
      pending.reject(
        new SupervisorError(
          "HARNESS_ERROR",
          safeText(
            `Harness command ${pending.command} failed: ${String(record.error ?? "unknown error")}`,
            2000,
          ),
          { command: pending.command },
        ),
      );
    }
  }

  private handleMessageEnd(record: Record<string, unknown>): void {
    const message = record.message;
    if (!message || typeof message !== "object") return;
    const obj = message as Record<string, unknown>;
    if (obj.role !== "assistant") return;
    this.accumulateUsage(obj);
    const text = extractAssistantText(obj);
    const stopReason = typeof obj.stopReason === "string" ? obj.stopReason : undefined;
    const errorMessage = typeof obj.errorMessage === "string" ? obj.errorMessage : undefined;
    // Pi emits a synthetic empty assistant message when abort settles. Do not
    // let it erase the last real assistant text: cancellation must still be
    // able to show what the worker had produced before it stopped.
    const carried = text.length === 0 && stopReason === "aborted" ? this.lastAssistant?.text : undefined;
    this.lastAssistant = { text: text || carried || "", stopReason, errorMessage };
    if (text) {
      this.emit({
        type: "progress",
        kind: "assistant_message",
        preview: safeText(text, 4000),
      });
    }
  }

  /**
   * Pi reports usage on each assistant message. Summing the reported fields
   * keeps the original accounting categories; cache tokens are never folded
   * into input/output. Missing fields stay absent rather than becoming zero.
   */
  private accumulateUsage(message: Record<string, unknown>): void {
    if (typeof message.provider === "string" && message.provider) {
      this.usageProvider = message.provider;
    }
    if (typeof message.model === "string" && message.model) {
      this.usageModelId = message.model;
    }
    const usage = message.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
    const raw = usage as Record<string, unknown>;
    const take = (key: string, target: PiUsageTotals): void => {
      const value = raw[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
      this.usageTotals[target] += value;
      this.usageTotals.seen = true;
    };
    take("input", "input");
    take("output", "output");
    take("cacheRead", "cacheRead");
    take("cacheWrite", "cacheWrite");
    take("totalTokens", "total");
  }

  private handleExtensionUi(record: Record<string, unknown>): void {
    const method = typeof record.method === "string" ? record.method : "";
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id) return;
    if (DIALOG_METHODS.has(method)) {
      const options = Array.isArray(record.options)
        ? record.options.filter((option): option is string => typeof option === "string")
        : undefined;
      // Pi's extension owns its dialog timeout. HS forwards a native value
      // unchanged and adds the shared 30-minute cap when the extension does not
      // provide a shorter one. HARNESS_SUPERVISOR_PI_INPUT_TIMEOUT_MS=0 is the
      // explicit opt-out for dialogs that must wait indefinitely.
      const nativeTimeout =
        typeof record.timeout === "number" && record.timeout > 0 ? record.timeout : undefined;
      const cap = resolveRuntimeInputTimeoutMs({
        specificEnv: PI_INPUT_TIMEOUT_ENV,
        defaultMs: DEFAULT_INPUT_TIMEOUT_MS,
        allowDisabled: true,
      });
      const timeoutMs = pickInputTimeoutMs(nativeTimeout, cap);
      const event: PendingInput & { type: "needs_input"; timeoutMs?: number } = {
        type: "needs_input",
        requestId: id,
        method: method as PendingInput["method"],
        title: typeof record.title === "string" ? safeText(record.title, 1000) : undefined,
        message: typeof record.message === "string" ? safeText(record.message, 2000) : undefined,
        options,
        placeholder:
          typeof record.placeholder === "string" ? safeText(record.placeholder, 500) : undefined,
        prefill: typeof record.prefill === "string" ? safeText(record.prefill, 2000) : undefined,
        createdAt: new Date().toISOString(),
        timeoutMs,
      };
      this.emit(event);
      return;
    }
    if (method === "notify" && typeof record.message === "string") {
      this.emit({
        type: "progress",
        kind: "notification",
        preview: safeText(record.message, 500),
      });
    }
  }

  private appendStderr(text: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${text}`;
    if (this.stderrBuffer.length > this.maxStderrTail) {
      this.stderrBuffer = this.stderrBuffer.slice(-this.maxStderrTail);
    }
  }

  private diagnostic(message: string): void {
    const line = `${new Date().toISOString()} [pi-rpc] ${message}\n`;
    this.appendStderr(line);
    this.onDiagnostic?.(message);
  }

  private emit(event: Parameters<HarnessCallbacks["onEvent"]>[0]): void {
    try {
      this.callbacks.onEvent(event);
    } catch {
      // Callback failures must not break RPC parsing.
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractAssistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  const candidates = [obj.command, obj.path, obj.file_path, obj.pattern, obj.url, obj.query];
  const chosen = candidates.find((value) => typeof value === "string" && value.length > 0);
  if (typeof chosen === "string") return safeText(chosen, 200);
  return safeJson(obj, 200);
}

export const PI_RPC_DEFAULTS = {
  requestTimeoutMs: 30_000,
  abortTimeoutMs: 20_000,
};
