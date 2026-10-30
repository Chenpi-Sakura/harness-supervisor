import { randomUUID } from "node:crypto";
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
  HarnessUsageReport,
} from "../../types.js";
import { Deferred, withTimeout } from "../../util/async.js";
import { JsonlDecoder, serializeJsonLine } from "../../util/jsonl.js";
import { safeJson, safeText } from "../../util/redact.js";
import { resolveInputTimeoutMs } from "../../input-timeout.js";
import {
  expectedQoderSessionFile,
  locateQoderSessionFile,
  qoderConfigRoots,
  sameQoderPermissionMode,
  waitForQoderSessionFile,
  type QoderLaunch,
} from "./launch.js";

export interface QoderSessionOptions {
  launch: QoderLaunch;
  args: string[];
  cwd: string;
  callbacks: HarnessCallbacks;
  sessionId: string;
  resumeId?: string;
  /** Requested --permission-mode; an init-time mismatch fails startup. */
  permissionMode?: string;
  requestedSessionFile?: string;
  modelId?: string;
  onStderr?: (text: string) => void;
  onDiagnostic?: (text: string) => void;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  stderrTailBytes?: number;
}

interface PendingControl {
  resolve: (value: Record<string, unknown> | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  kind: string;
}

type ToolRequestKind = "approval" | "question_select" | "question_input" | "question_multi";

interface PendingToolRequest {
  requestId: string;
  kind: ToolRequestKind;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  questions: Array<{ question: string; options: string[] }>;
  timer?: NodeJS.Timeout;
}

interface SentMessage {
  uuid: string;
  mode: "prompt" | "steer" | "follow-up";
  text: string;
  consumed: boolean;
}

interface ToolStart {
  name: string;
  startedAt: number;
}

interface LastResult {
  finalText?: string;
  stopReason?: string;
  error?: string;
}

/**
 * Qoder's control channel waits for a response; the five-minute deadline was
 * ours, not qodercli's. A real Qoder run held a pending question past five
 * minutes, so the default is 30 minutes. The supervisor receives the same
 * deadline in `needs_input`, and both timers are configurable.
 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 30 * 60_000;
const SETTLE_IDLE_MS = 350;
const SETTLE_WITH_QUEUE_MS = 1500;

function permissionTimeoutMs(): number {
  return resolveInputTimeoutMs(DEFAULT_PERMISSION_TIMEOUT_MS);
}

export class QoderCliSession implements HarnessSession {
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly callbacks: HarnessCallbacks;
  private readonly onStderr?: (text: string) => void;
  private readonly onDiagnostic?: (text: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly abortTimeoutMs: number;
  private readonly maxStderrTail: number;
  private readonly cwd: string;
  private readonly launch: QoderLaunch;
  private readonly resumeId?: string;
  private readonly requestedSessionFile?: string;
  private readonly requestedPermissionMode?: string;
  private readonly modelId?: string;
  private readonly decoder: JsonlDecoder;
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly closed = new Deferred<HarnessExit>();
  private readonly started = new Deferred<{ sessionId: string }>();
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly pendingTools = new Map<string, PendingToolRequest>();
  private readonly toolStarts = new Map<string, ToolStart>();
  private sentMessages: SentMessage[] = [];
  private requestCounter = 0;
  private sessionId: string | undefined;
  private sessionFile: string | undefined;
  private stderrBuffer = "";
  private exitInfo: HarnessExit | null = null;
  private exited = false;
  private forced = false;
  private initSeen = false;
  private promptSent = false;
  private prePromptError: string | undefined;
  private settledSeen = false;
  private abortRequested = false;
  private runSeen = false;
  private lastAssistantText: string | undefined;
  private lastResult: LastResult | null = null;
  private pendingUsage: HarnessUsageReport | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private turns = 0;

  private constructor(child: ChildProcessWithoutNullStreams, options: QoderSessionOptions) {
    this.child = child;
    this.pid = child.pid;
    this.callbacks = options.callbacks;
    this.onStderr = options.onStderr;
    this.onDiagnostic = options.onDiagnostic;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.abortTimeoutMs = options.abortTimeoutMs ?? 20_000;
    this.maxStderrTail = options.stderrTailBytes ?? 32 * 1024;
    this.cwd = options.cwd;
    this.launch = options.launch;
    this.resumeId = options.resumeId;
    this.requestedSessionFile = options.requestedSessionFile;
    this.requestedPermissionMode = options.permissionMode;
    this.modelId = options.modelId;

    this.decoder = new JsonlDecoder(
      (record) => this.handleRecord(record),
      (raw, error) => {
        this.diagnostic(`Invalid JSONL from qodercli (${error.message}): ${raw.slice(0, 300)}`);
      },
    );

    child.stdout.on("data", (chunk: Buffer) => this.decoder.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = this.stderrDecoder.write(chunk);
      this.appendStderr(text);
      if (text) this.onStderr?.(text);
    });
    child.on("error", (error) => {
      this.diagnostic(`qodercli process error: ${error.message}`);
    });
    child.on("close", (code, signal) => this.handleClose(code, signal));
  }

  static async start(options: QoderSessionOptions): Promise<QoderCliSession> {
    const child = spawn(options.launch.file, [...options.launch.args, ...options.args], {
      cwd: options.cwd,
      env: options.launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const session = new QoderCliSession(child, options);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (error) => {
          reject(
            new SupervisorError("HARNESS_ERROR", `Failed to start qodercli: ${error.message}`, {
              launch: options.launch.description,
            }),
          );
        });
      });
      await session.startup();
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

  isAlive(): boolean {
    return !this.exited && this.child.exitCode === null;
  }

  stderrTail(): string {
    return safeText(this.stderrBuffer, 16 * 1024);
  }

  async getState(): Promise<HarnessStateInfo> {
    if (this.sessionId) {
      const found = await locateQoderSessionFile(this.cwd, this.sessionId, this.launch.env);
      if (found) this.sessionFile = found;
    }
    return { sessionId: this.sessionId, sessionFile: this.sessionFile };
  }

  async prompt(message: string): Promise<{ disposition: string }> {
    await this.sendUserMessage(message, "prompt");
    if (!this.runSeen) {
      this.runSeen = true;
      this.emit({ type: "run_started" });
    }
    return { disposition: "started" };
  }

  async steer(message: string): Promise<void> {
    await this.sendUserMessage(message, "steer");
  }

  async followUp(message: string): Promise<void> {
    await this.sendUserMessage(message, "follow-up");
  }

  async clearQueue(): Promise<HarnessQueueContents> {
    const candidates = this.sentMessages.filter((message) => message.mode !== "prompt");
    if (candidates.length === 0) return { steering: [], followUp: [] };
    this.sentMessages = this.sentMessages.filter((message) => message.mode === "prompt");
    const outcomes = await Promise.allSettled(
      candidates.map(async (message) => {
        const response = await this.controlRequest(
          { subtype: "cancel_async_message", message_uuid: message.uuid },
          750,
        );
        return { message, cancelled: response?.cancelled === true };
      }),
    );
    const confirmed = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" && outcome.value.cancelled ? [outcome.value.message] : [],
    );
    return {
      steering: confirmed.filter((message) => message.mode === "steer").map((m) => m.text),
      followUp: confirmed.filter((message) => message.mode === "follow-up").map((m) => m.text),
    };
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    for (const request of [...this.pendingTools.values()]) {
      this.pendingTools.delete(request.requestId);
      clearTimeout(request.timer);
      await this.respondPermission(request, "deny", "Worker was cancelled", {}).catch(() => undefined);
    }
    await this.controlRequest(
      { type: "interrupt", cancel_queued: true },
      Math.min(this.abortTimeoutMs, 5000),
    ).catch((error: unknown) => {
      this.diagnostic(`interrupt failed: ${errorMessage(error)}`);
    });
  }

  async answer(requestId: string, response: ExtensionUiResponse): Promise<void> {
    const pending = this.pendingTools.get(requestId);
    if (!pending) {
      throw new SupervisorError("INVALID_STATE", "No pending Qoder control request with that id", {
        requestId,
      });
    }
    const cancelled = "cancelled" in response;
    let allow = !cancelled;
    let value = "";
    if ("confirmed" in response) allow = response.confirmed;
    else if ("value" in response) value = response.value;

    if (pending.kind === "approval") {
      if (!cancelled && !("confirmed" in response)) {
        allow = value.trim().toLowerCase() === "allow";
      }
      clearTimeout(pending.timer);
      try {
        await this.respondPermission(
          pending,
          allow ? "allow" : "deny",
          allow ? undefined : "Denied by the supervising client",
          {},
        );
      } catch (error) {
        throw new SupervisorError("HARNESS_ERROR", errorMessage(error), { requestId });
      }
      this.pendingTools.delete(requestId);
      return;
    }

    if (cancelled) {
      clearTimeout(pending.timer);
      this.pendingTools.delete(requestId);
      await this.respondPermission(pending, "deny", "Cancelled by the supervising client", {});
      return;
    }

    const answers: Record<string, string> = {};
    if (pending.kind === "question_multi") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new SupervisorError(
          "BAD_REQUEST",
          "This request asks multiple questions; the answer must be a JSON object of question -> answer.",
          { requestId },
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SupervisorError("BAD_REQUEST", "Answer must be a JSON object of question -> answer", {
          requestId,
        });
      }
      for (const [question, answer] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof answer !== "string") {
          throw new SupervisorError("BAD_REQUEST", "Every answer must be a string", { requestId });
        }
        answers[question] = answer;
      }
    } else {
      const question = pending.questions[0]?.question;
      if (!question) {
        throw new SupervisorError("BAD_REQUEST", "Request has no question text", { requestId });
      }
      answers[question] = value;
    }

    clearTimeout(pending.timer);
    await this.respondPermission(pending, "allow", undefined, { answers });
    this.pendingTools.delete(requestId);
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
      this.diagnostic("qodercli process did not exit after stdin close and forced termination");
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

  private async startup(): Promise<void> {
    this.sendInitialize();
    let info: { sessionId: string };
    try {
      info = await withTimeout(
        this.started.promise,
        this.requestTimeoutMs,
        "qodercli did not emit a system init message",
      );
    } catch (error) {
      const detail = this.exited
        ? `qodercli exited during startup (code=${this.exitInfo?.code ?? "?"}, signal=${this.exitInfo?.signal ?? "-"}). ${this.stderrTail()}`
        : errorMessage(error);
      throw new SupervisorError(
        "HARNESS_ERROR",
        `${detail}${this.loginHint()}`,
        { stderrTail: this.stderrTail() },
      );
    }

    if (this.resumeId && info.sessionId !== this.resumeId) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Qoder CLI did not resume the requested session id. Refusing to report a fake resume.",
        { expectedSessionId: this.resumeId, actualSessionId: info.sessionId },
      );
    }

    if (this.requestedSessionFile) {
      this.sessionFile = this.requestedSessionFile;
      return;
    }
    const found = await waitForQoderSessionFile(
      this.cwd,
      info.sessionId,
      this.launch.env,
      1500,
    );
    const root = qoderConfigRoots(this.launch.env)[0];
    this.sessionFile =
      found ?? expectedQoderSessionFile(root ?? this.cwd, this.cwd, info.sessionId);
  }

  private loginHint(): string {
    return " If this is an authentication failure, run `qodercli login` once for the same OS user, or set QODER_PERSONAL_ACCESS_TOKEN for the daemon process.";
  }

  private sendInitialize(): void {
    const requestId = this.nextRequestId();
    const payload = {
      type: "initialize",
      modelPolicyProvider: false,
      supportsCatalogReadyInitialize: true,
      supportsAvailableModelsUpdate: true,
      supportsCommandsChanged: true,
      initializeTimeoutMs: this.requestTimeoutMs,
    };
    this.trackControl(requestId, "initialize", Math.min(this.requestTimeoutMs, 10_000)).catch(
      (error: unknown) => {
        this.diagnostic(`initialize handshake failed: ${errorMessage(error)}`);
      },
    );
    this.writeControl(requestId, payload).catch((error: unknown) => {
      this.diagnostic(`failed to send initialize: ${errorMessage(error)}`);
    });
  }

  private async sendUserMessage(
    text: string,
    mode: SentMessage["mode"],
  ): Promise<void> {
    if (!this.isAlive()) {
      throw new SupervisorError("HARNESS_ERROR", "Cannot send to qodercli: process is not running");
    }
    if (this.settledSeen) {
      throw new SupervisorError(
        "INVALID_STATE",
        this.lastResult?.error ?? "The Qoder run has already settled",
      );
    }
    if (!this.promptSent && this.prePromptError) {
      throw new SupervisorError("INVALID_STATE", this.prePromptError);
    }
    const uuid = randomUUID();
    const record: Record<string, unknown> = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      shouldQuery: true,
      uuid,
      extra: { submitted_at_ms: Date.now() },
    };
    if (mode === "steer") record.priority = "next";
    else if (mode === "follow-up") record.priority = "later";
    await this.write(record);
    if (mode === "prompt") this.promptSent = true;
    this.sentMessages.push({ uuid, mode, text, consumed: false });
    this.cancelSettleTimer();
  }

  private nextRequestId(): string {
    return `hs-qoder-${++this.requestCounter}`;
  }

  private async controlRequest(
    request: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    const requestId = this.nextRequestId();
    const kind = String(request.subtype ?? request.type ?? "control");
    const promise = this.trackControl(requestId, kind, timeoutMs);
    await this.writeControl(requestId, request);
    return promise;
  }

  private trackControl(
    requestId: string,
    kind: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(
          new SupervisorError(
            "HARNESS_TIMEOUT",
            `Qoder control request timed out after ${timeoutMs}ms: ${kind}`,
            { requestId, kind },
          ),
        );
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this.pendingControls.set(requestId, { resolve, reject, timer, kind });
    });
  }

  private async writeControl(
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    await this.write({ type: "control_request", request_id: requestId, request });
  }

  private async respondPermission(
    pending: PendingToolRequest,
    behavior: "allow" | "deny",
    message: string | undefined,
    extra: { answers?: Record<string, string> },
  ): Promise<void> {
    const response: Record<string, unknown> = {
      behavior,
      toolUseID: pending.toolUseId,
    };
    if (behavior === "allow") {
      response.updatedInput =
        extra.answers && Object.keys(extra.answers).length > 0
          ? { ...pending.input, answers: extra.answers }
          : pending.input;
    } else if (message) {
      response.message = safeText(message, 1000);
    }
    await this.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: pending.requestId,
        response,
      },
    });
  }

  private async write(record: Record<string, unknown>): Promise<void> {
    if (!this.isAlive()) {
      throw new SupervisorError("HARNESS_ERROR", "Cannot write to qodercli: process is not running", {
        stderrTail: this.stderrTail(),
      });
    }
    const line = serializeJsonLine(record);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(
            new SupervisorError("HARNESS_ERROR", `Failed to write to qodercli stdin: ${error.message}`),
          );
        } else {
          resolve();
        }
      });
    });
  }

  private handleRecord(record: Record<string, unknown>): void {
    if (record.type === "control_response") {
      this.handleControlResponse(record);
      return;
    }
    if (record.type === "control_request") {
      void this.handleControlRequest(record).catch((error: unknown) => {
        this.diagnostic(`control request handling failed: ${errorMessage(error)}`);
      });
      return;
    }
    if (record.type === "control_cancel_request" || record.type === "control_cancel") {
      const requestId = typeof record.request_id === "string" ? record.request_id : "";
      const pending = this.pendingTools.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingTools.delete(requestId);
      }
      return;
    }
    if (record.type === "keep_alive") return;

    switch (record.type) {
      case "system":
        this.handleSystem(record);
        break;
      case "assistant":
        this.cancelSettleTimer();
        this.handleAssistant(record);
        break;
      case "user":
        this.cancelSettleTimer();
        this.handleUser(record);
        break;
      case "result":
        this.handleResult(record);
        break;
      default:
        break;
    }
  }

  private handleSystem(record: Record<string, unknown>): void {
    const subtype = typeof record.subtype === "string" ? record.subtype : "";
    if (subtype === "init") {
      const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;
      if (!sessionId) {
        this.diagnostic("system init message did not include a session_id");
        return;
      }
      this.sessionId = sessionId;
      if (!this.initSeen) {
        this.initSeen = true;
        const effectivePermissionMode =
          typeof record.permissionMode === "string" ? record.permissionMode : undefined;
        if (
          this.requestedPermissionMode &&
          effectivePermissionMode &&
          !sameQoderPermissionMode(effectivePermissionMode, this.requestedPermissionMode)
        ) {
          // Do not silently accept a downgrade: a different mode means the
          // authorized full-permission run did not start, and continuing would
          // turn every tool call into an approval prompt.
          this.started.reject(
            new SupervisorError(
              "UNSUPPORTED",
              `qodercli reported permission mode "${effectivePermissionMode}" but "${this.requestedPermissionMode}" was requested. The worker was not started; HS does not fall back to auto or per-call approval.`,
              {
                requested: this.requestedPermissionMode,
                effective: effectivePermissionMode,
                stderrTail: this.stderrTail(),
              },
            ),
          );
          return;
        }
        if (this.requestedPermissionMode && !effectivePermissionMode) {
          this.diagnostic(
            `qodercli init did not report permissionMode; cannot confirm "${this.requestedPermissionMode}" took effect`,
          );
        }
        this.emit({
          type: "progress",
          kind: "session_init",
          detail: safeText(
            `${String(record.model ?? "unknown model")} (${String(record.permissionMode ?? "unknown mode")})`,
            200,
          ),
        });
        this.started.resolve({ sessionId });
      }
      return;
    }
    if (subtype === "compact_boundary") {
      this.emit({ type: "progress", kind: "compaction" });
      return;
    }
    if (subtype === "mirror_error") {
      this.diagnostic(`session mirror error: ${safeJson(record, 500)}`);
    }
  }

  private handleAssistant(record: Record<string, unknown>): void {
    const message = record.message;
    if (!message || typeof message !== "object") return;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return;
    const textParts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        textParts.push(item.text);
      } else if (item.type === "tool_use") {
        const id = typeof item.id === "string" ? item.id : randomUUID();
        const name = typeof item.name === "string" ? item.name : "unknown";
        this.toolStarts.set(id, { name, startedAt: Date.now() });
        this.emit({
          type: "progress",
          kind: "tool_start",
          tool: name,
          detail: summarizeToolInput(item.input),
        });
      }
    }
    if (textParts.length > 0) {
      const text = textParts.join("\n");
      this.lastAssistantText = text;
      this.emit({
        type: "progress",
        kind: "assistant_message",
        preview: safeText(text, 4000),
      });
    }
    if (record.aborted === true) {
      this.emit({ type: "progress", kind: "assistant_aborted", isError: true });
    }
  }

  private handleUser(record: Record<string, unknown>): void {
    const uuid =
      (typeof record.uuid === "string" ? record.uuid : undefined) ??
      (() => {
        const message = record.message;
        if (!message || typeof message !== "object") return undefined;
        const value = (message as Record<string, unknown>).uuid;
        return typeof value === "string" ? value : undefined;
      })();
    if (uuid) {
      const sent = this.sentMessages.find((message) => message.uuid === uuid);
      if (sent) sent.consumed = true;
    }

    const message = record.message;
    if (!message || typeof message !== "object") return;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type !== "tool_result") continue;
      const toolUseId = typeof item.tool_use_id === "string" ? item.tool_use_id : "";
      const started = toolUseId ? this.toolStarts.get(toolUseId) : undefined;
      if (toolUseId) this.toolStarts.delete(toolUseId);
      this.emit({
        type: "progress",
        kind: "tool_end",
        tool: started?.name ?? "unknown",
        isError: item.is_error === true,
        durationMs: started ? Math.max(0, Date.now() - started.startedAt) : undefined,
        preview: summarizeToolResult(item.content),
      });
    }
  }

  private handleResult(record: Record<string, unknown>): void {
    this.cancelSettleTimer();
    const subtype = typeof record.subtype === "string" ? record.subtype : "";
    const isError = record.is_error === true || subtype !== "success";
    const stopReason = typeof record.stop_reason === "string" ? record.stop_reason : undefined;

    let errorMessage: string | undefined;
    if (isError) {
      const errors = Array.isArray(record.errors)
        ? record.errors.filter((value): value is string => typeof value === "string")
        : [];
      const reason = typeof record.terminal_reason === "string" ? record.terminal_reason : "";
      // qodercli reports some failures (notably "not logged in") as a successful
      // result with is_error=true and no errors array; the explanation is only in
      // the preceding assistant text.
      let message = errors.join("; ");
      if (!message && subtype === "success" && record.is_error === true) {
        message = this.lastAssistantText?.trim() ?? "";
      }
      if (!message) {
        message =
          reason && reason !== "completed"
            ? `Qoder run failed (${reason})`
            : `Qoder run failed (${subtype || "unknown"})`;
      }
      if (/auth|login|credential|unauthor/i.test(message)) {
        message = `${message}. Run \`qodercli login\` for the same OS user or set QODER_PERSONAL_ACCESS_TOKEN.`;
      }
      errorMessage = message;
    }

    // qodercli initializes its auth state before the first user message and can
    // emit an error result before the caller has sent a prompt. Hold that error
    // so the prompt path can fail startup after worker.started/session exist;
    // ignore a prompt-less success.
    if (!this.promptSent) {
      if (errorMessage) {
        this.prePromptError = errorMessage;
        this.diagnostic(`qodercli reported an error before the prompt: ${errorMessage}`);
      }
      return;
    }

    const usage =
      record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
        ? (record.usage as Record<string, unknown>)
        : null;
    if (usage) {
      this.emit({
        type: "progress",
        kind: "usage",
        detail: safeJson(
          {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            total_cost_usd: record.total_cost_usd,
            total_credits: record.total_credits,
          },
          300,
        ),
      });
      const token = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? Math.trunc(value)
          : undefined;
      const inputTokens = token(usage.input_tokens);
      const outputTokens = token(usage.output_tokens);
      const cacheReadTokens = token(usage.cache_read_input_tokens);
      const cacheWriteTokens = token(usage.cache_creation_input_tokens);
      const reportedTotalTokens = token(usage.total_tokens);
      const modelId =
        typeof record.model === "string" && record.model
          ? record.model
          : this.modelId;
      const structured: HarnessUsageReport = {
        ...(typeof record.provider === "string" && record.provider
          ? { provider: record.provider }
          : {}),
        ...(modelId ? { modelId } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
        ...(reportedTotalTokens !== undefined ? { reportedTotalTokens } : {}),
      };
      if (
        structured.inputTokens !== undefined ||
        structured.outputTokens !== undefined ||
        structured.cacheReadTokens !== undefined ||
        structured.cacheWriteTokens !== undefined ||
        structured.reportedTotalTokens !== undefined
      ) {
        this.pendingUsage = structured;
      }
    }
    const fallbackTurns = isError ? 0 : 1;
    const numTurns =
      typeof record.num_turns === "number" && Number.isFinite(record.num_turns)
        ? Math.min(100, Math.max(0, Math.trunc(record.num_turns)))
        : fallbackTurns;
    for (let index = 0; index < numTurns; index += 1) {
      this.turns += 1;
      this.emit({ type: "progress", kind: "turn_complete" });
    }

    if (isError && errorMessage) {
      this.lastResult = { error: errorMessage, stopReason };
      this.emit({ type: "run_error", message: safeText(errorMessage, 2000), fatal: true });
      this.emitSettled();
      return;
    }

    const finalText =
      typeof record.result === "string" && record.result.length > 0
        ? record.result
        : this.lastAssistantText;
    this.lastResult = { finalText, stopReason };
    const hasQueued = this.sentMessages.some(
      (message) => !message.consumed && message.mode !== "prompt",
    );
    this.settleTimer = setTimeout(
      () => this.emitSettled(),
      hasQueued ? SETTLE_WITH_QUEUE_MS : SETTLE_IDLE_MS,
    );
    this.settleTimer.unref?.();
  }

  private emitSettled(): void {
    if (this.settledSeen) return;
    this.cancelSettleTimer();
    this.settledSeen = true;
    // Multiple result records inside the settle window describe one terminal
    // state; emitting each result's usage would count the same turn twice. Keep
    // the newest report, and do not let a duplicate without token fields erase it.
    if (this.pendingUsage) {
      const usage = this.pendingUsage;
      this.pendingUsage = undefined;
      this.emit({ type: "usage", usage });
    }
    const result = this.lastResult;
    this.emit({
      type: "settled",
      aborted: this.abortRequested,
      finalText: result?.finalText,
      stopReason: result?.stopReason,
      error: result?.error,
    });
  }

  private cancelSettleTimer(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
  }

  private handleControlResponse(record: Record<string, unknown>): void {
    const response = record.response;
    if (!response || typeof response !== "object") return;
    const obj = response as Record<string, unknown>;
    const requestId =
      (typeof obj.request_id === "string" ? obj.request_id : undefined) ??
      (typeof record.request_id === "string" ? record.request_id : "");
    const pending = this.pendingControls.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingControls.delete(requestId);
    if (obj.subtype === "success") {
      pending.resolve(
        obj.response && typeof obj.response === "object"
          ? (obj.response as Record<string, unknown>)
          : undefined,
      );
    } else {
      pending.reject(
        new SupervisorError(
          "HARNESS_ERROR",
          safeText(
            `Qoder control request ${pending.kind} failed: ${String(obj.error ?? obj.subtype ?? "unknown error")}`,
            2000,
          ),
          { kind: pending.kind },
        ),
      );
    }
  }

  private async handleControlRequest(record: Record<string, unknown>): Promise<void> {
    const requestId = typeof record.request_id === "string" ? record.request_id : "";
    const request = record.request;
    if (!requestId || !request || typeof request !== "object") return;
    const obj = request as Record<string, unknown>;
    const subtype =
      typeof obj.subtype === "string"
        ? obj.subtype
        : typeof obj.type === "string"
          ? obj.type
          : "";
    if (subtype !== "can_use_tool") {
      await this.write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: `Unsupported Qoder control request: ${subtype || "unknown"}`,
        },
      }).catch(() => undefined);
      return;
    }

    const toolName = typeof obj.tool_name === "string" ? obj.tool_name : "unknown";
    const input =
      obj.input && typeof obj.input === "object" && !Array.isArray(obj.input)
        ? (obj.input as Record<string, unknown>)
        : {};
    const toolUseId = typeof obj.tool_use_id === "string" ? obj.tool_use_id : "";
    if (this.abortRequested) {
      const denied: PendingToolRequest = {
        requestId,
        kind: "approval",
        toolName,
        toolUseId,
        input,
        questions: [],
      };
      await this.respondPermission(denied, "deny", "Worker is being cancelled", {});
      return;
    }

    if (toolName === "AskUserQuestion") {
      this.handleAskUserQuestion(requestId, toolName, toolUseId, input);
      return;
    }

    const reason =
      (typeof obj.decision_reason === "string" && obj.decision_reason) ||
      (typeof obj.description === "string" && obj.description) ||
      summarizeToolInput(input) ||
      "This tool call needs approval.";
    const title =
      (typeof obj.title === "string" && obj.title) ||
      (typeof obj.display_name === "string" && obj.display_name) ||
      `Allow ${toolName}?`;
    const pending: PendingToolRequest = {
      requestId,
      kind: "approval",
      toolName,
      toolUseId,
      input,
      questions: [],
    };
    const timeoutMs = permissionTimeoutMs();
    pending.timer = this.permissionTimer(pending, timeoutMs);
    this.pendingTools.set(requestId, pending);
    this.emit({
      type: "needs_input",
      requestId,
      method: "select",
      title: safeText(title, 300),
      message: safeText(reason, 2000),
      options: ["allow", "deny"],
      timeoutMs,
    });
  }

  private handleAskUserQuestion(
    requestId: string,
    toolName: string,
    toolUseId: string,
    input: Record<string, unknown>,
  ): void {
    const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
    const questions: Array<{ question: string; options: string[] }> = [];
    for (const raw of rawQuestions) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const question = typeof item.question === "string" ? item.question : "";
      if (!question) continue;
      const options = Array.isArray(item.options)
        ? item.options
            .map((option) => {
              if (typeof option === "string") return option;
              if (option && typeof option === "object") {
                const label = (option as Record<string, unknown>).label;
                return typeof label === "string" ? label : "";
              }
              return "";
            })
            .filter(Boolean)
        : [];
      questions.push({ question, options });
    }
    if (questions.length === 0) {
      const denied: PendingToolRequest = {
        requestId,
        kind: "approval",
        toolName,
        toolUseId,
        input,
        questions: [],
      };
      void this.respondPermission(
        denied,
        "deny",
        "AskUserQuestion did not contain a usable question",
        {},
      );
      return;
    }

    const first = questions[0]!;
    let kind: ToolRequestKind;
    let method: "select" | "input";
    let options: string[] | undefined;
    let message = first.question;
    let placeholder: string | undefined;
    if (questions.length === 1 && first.options.length > 0) {
      kind = "question_select";
      method = "select";
      options = first.options;
    } else if (questions.length === 1) {
      kind = "question_input";
      method = "input";
      placeholder = "Answer the question";
    } else {
      kind = "question_multi";
      method = "input";
      message = questions.map((question) => question.question).join("\n");
      placeholder = 'JSON object, e.g. {"question": "answer"}';
    }

    const pending: PendingToolRequest = {
      requestId,
      kind,
      toolName,
      toolUseId,
      input,
      questions,
    };
    const timeoutMs = permissionTimeoutMs();
    pending.timer = this.permissionTimer(pending, timeoutMs);
    this.pendingTools.set(requestId, pending);
    this.emit({
      type: "needs_input",
      requestId,
      method,
      title: "Qoder needs an answer",
      message: safeText(message, 2000),
      options,
      placeholder,
      timeoutMs,
    });
  }

  private permissionTimer(pending: PendingToolRequest, timeoutMs: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.pendingTools.get(pending.requestId) !== pending) return;
      this.pendingTools.delete(pending.requestId);
      this.emit({
        type: "progress",
        kind: "permission_timeout",
        tool: pending.toolName,
        detail: pending.requestId,
        isError: true,
      });
      void this.respondPermission(
        pending,
        "deny",
        "Supervisor did not receive an answer before the permission timeout",
        {},
      ).catch(() => undefined);
    }, timeoutMs);
    timer.unref?.();
    return timer;
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    this.decoder.end();
    this.cancelSettleTimer();
    for (const pending of this.pendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new SupervisorError("HARNESS_ERROR", `qodercli exited (code=${code}, signal=${signal})`, {
          code,
          signal,
        }),
      );
    }
    this.pendingControls.clear();
    for (const pending of this.pendingTools.values()) clearTimeout(pending.timer);
    this.pendingTools.clear();
    if (!this.initSeen) {
      this.started.reject(
        new SupervisorError(
          "HARNESS_ERROR",
          `qodercli exited before session init (code=${code}, signal=${signal}).${this.loginHint()}`,
          { code, signal, stderrTail: this.stderrTail() },
        ),
      );
    } else if (!this.settledSeen && this.lastResult && !this.lastResult.error) {
      this.emitSettled();
    }
    const exit = this.exitInfo;
    this.closed.resolve(exit);
    try {
      this.callbacks.onExit(exit);
    } catch {
      // Callback failures must not break process cleanup.
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    try {
      await withTimeout(this.closed.promise, timeoutMs, "timed out waiting for qodercli exit");
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
    const line = `${new Date().toISOString()} [qoder-cli] ${message}\n`;
    this.appendStderr(line);
    this.onDiagnostic?.(message);
  }

  private emit(event: Parameters<HarnessCallbacks["onEvent"]>[0]): void {
    try {
      this.callbacks.onEvent(event);
    } catch {
      // Callback failures must not break protocol parsing.
    }
  }
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const candidates = [
    obj.command,
    obj.file_path,
    obj.path,
    obj.pattern,
    obj.url,
    obj.query,
    obj.description,
  ];
  const chosen = candidates.find((value) => typeof value === "string" && value.length > 0);
  if (typeof chosen === "string") return safeText(chosen, 2000);
  return safeJson(obj, 2000);
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return safeText(content, 4000);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    if (parts.length > 0) return safeText(parts.join("\n"), 4000);
  }
  if (content === undefined || content === null) return "";
  return safeJson(content, 4000);
}

export const QODER_DEFAULTS = {
  requestTimeoutMs: 30_000,
  abortTimeoutMs: 20_000,
};
