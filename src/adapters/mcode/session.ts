import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { ensureDir } from "../../util/fsx.js";
import { safeText } from "../../util/redact.js";
import type { McodeLaunch } from "./launch.js";

export interface McodeAcpSessionOptions {
  launch: McodeLaunch;
  args: string[];
  cwd: string;
  /** Supervisor-owned directory where this worker keeps its session handle. */
  sessionDir: string;
  /**
   * Permission mode for the session. MiniMax Code defaults to
   * `bypassPermissions`, so a worker that should ask before acting has to say
   * so explicitly.
   */
  permissionMode?: McodePermissionMode;
  callbacks: HarnessCallbacks;
  onStderr?: (text: string) => void;
  onDiagnostic?: (text: string) => void;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  stderrTailBytes?: number;
  /** Resume an existing MiniMax Code session instead of creating a new one. */
  resumeSessionId?: string;
}

export const MCODE_PERMISSION_MODES = ["default", "auto", "bypassPermissions"] as const;

export type McodePermissionMode = (typeof MCODE_PERMISSION_MODES)[number];

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

/** A permission request the agent sent to us and is waiting on. */
interface PendingPermission {
  requestId: string;
  /** The JSON-RPC id exactly as the agent sent it; replies must reuse it. */
  rpcId: number | string;
  toolName: string;
  title: string;
  message: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  timer: NodeJS.Timeout;
}

interface QueuedMessage {
  itemId: string;
  text: string;
}

const PERMISSION_TIMEOUT_MS = 300_000;
const ACP_PROTOCOL_VERSION = 1;
/**
 * Upper bound for the permission context handed to the caller.
 *
 * The native `rawInput` is kept because it is the only source of truth for an
 * approval decision, but it is the agent's own payload: a single tool call can
 * carry a very large file body. Pi bounds its pending input at 2000 chars;
 * this adapter keeps more room because the raw input is the decision context,
 * while still refusing to let one request grow without limit.
 */
const PERMISSION_MESSAGE_MAX_CHARS = 8000;

/**
 * Finds the offered option a client named exactly, either by its display
 * label ("Always allow") or by its id ("allow-always"). Matching the offered
 * options first is what keeps "Always allow" from being answered with a
 * denial.
 */
function findExactPermissionOption(
  pending: PendingPermission,
  response: ExtensionUiResponse,
): PendingPermission["options"][number] | undefined {
  if (!("value" in response) || typeof response.value !== "string") return undefined;
  const value = response.value.trim().toLowerCase();
  if (!value) return undefined;
  return pending.options.find(
    (option) => option.name.toLowerCase() === value || option.optionId.toLowerCase() === value,
  );
}

/**
 * Picks the option that matches the requested intent.
 *
 * Real MiniMax Code permission requests offer options with ids such as
 * `allow-once`, `allow-always` and `deny`, so the option id is the reliable
 * signal; the display name is only used as a fallback.
 */
function pickPermissionOption(
  pending: PendingPermission,
  intent: "allow" | "deny",
): PendingPermission["options"][number] | undefined {
  const byId = pending.options.find((option) =>
    intent === "allow"
      ? /^allow/.test(option.optionId)
      : /^(deny|reject)/.test(option.optionId),
  );
  if (byId) return byId;
  return pending.options.find((option) =>
    intent === "allow"
      ? /allow|accept|yes/i.test(option.name)
      : /deny|reject|no/i.test(option.name),
  );
}

/**
 * MiniMax Code speaks the Agent Client Protocol over ndJSON: one JSON-RPC 2.0
 * message per line. `session/prompt` blocks until the turn ends, so a second
 * prompt on the same session is rejected while one is active; steering and
 * queued follow-ups use the `mcode/session/*` extension methods instead.
 */
export class McodeAcpSession implements HarnessSession {
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly callbacks: HarnessCallbacks;
  private readonly onStderr?: (text: string) => void;
  private readonly onDiagnostic?: (text: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly abortTimeoutMs: number;
  private readonly maxStderrTail: number;
  private readonly closed = new Deferred<HarnessExit>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly stderrDecoder = new StringDecoder("utf8");
  private requestCounter = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private exitInfo: HarnessExit | null = null;
  private exited = false;
  private forced = false;
  private settledSeen = false;
  private runSeen = false;
  private abortRequested = false;
  private promptActive = false;
  private sessionId: string | undefined;
  private sessionFile: string | undefined;
  private agentVersion: string | undefined;
  private extensions = new Set<string>();
  private assistantText = "";
  private assistantMessageId: string | undefined;
  private readonly seenAssistantMessageIds = new Set<string>();
  private lastToolName: string | undefined;
  private queued: QueuedMessage[] = [];
  private readonly cwd: string;
  private readonly sessionDir: string;
  private readonly resumeSessionId: string | undefined;
  private readonly permissionMode: McodePermissionMode | undefined;

  private constructor(child: ChildProcessWithoutNullStreams, options: McodeAcpSessionOptions) {
    this.child = child;
    this.pid = child.pid;
    this.callbacks = options.callbacks;
    this.onStderr = options.onStderr;
    this.onDiagnostic = options.onDiagnostic;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.abortTimeoutMs = options.abortTimeoutMs ?? 20_000;
    this.maxStderrTail = options.stderrTailBytes ?? 32 * 1024;
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.resumeSessionId = options.resumeSessionId;
    this.permissionMode = options.permissionMode;

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

  static async start(options: McodeAcpSessionOptions): Promise<McodeAcpSession> {
    const child = spawn(options.launch.file, [...options.launch.args, ...options.args], {
      cwd: options.cwd,
      env: options.launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const session = new McodeAcpSession(child, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(
            new SupervisorError("HARNESS_ERROR", `Failed to start MiniMax Code: ${error.message}`, {
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
    try {
      await session.initialize();
    } catch (error) {
      // The handshake failed (for example the agent refused the permission
      // mode). The child process must not survive the failed start, or it
      // would keep running with nobody driving it.
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      throw error;
    }
    return session;
  }

  isAlive(): boolean {
    return !this.exited && this.child.exitCode === null;
  }

  /**
   * MiniMax Code persists its conversations in a SQLite database, not in a
   * per-session file, so there is no upstream file to point the supervisor at.
   * The supervisor's resume contract needs a real file whose first line carries
   * the session id, so this adapter keeps its own handle file inside the
   * worker's supervisor-owned session directory. It records the ACP session id
   * and the workspace the session was created for; the conversation itself
   * still lives in MiniMax Code's own store and is reattached with
   * `session/load`.
   */
  private get sessionHandleFile(): string {
    return path.join(this.sessionDir, "mcode-session.json");
  }

  private async writeSessionHandle(sessionId: string): Promise<void> {
    const file = this.sessionHandleFile;
    const payload = {
      type: "session",
      id: sessionId,
      runtime: "mcode",
      cwd: this.cwd,
      updatedAt: new Date().toISOString(),
    };
    await ensureDir(this.sessionDir);
    await writeFile(`${file}.tmp`, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(`${file}.tmp`, file);
    this.sessionFile = file;
  }

  stderrTail(): string {
    return safeText(this.stderrBuffer, 16 * 1024);
  }

  async getState(): Promise<HarnessStateInfo> {
    return { sessionId: this.sessionId, sessionFile: this.sessionFile };
  }

  /**
   * ACP has no separate "start the run" call: `session/prompt` both submits the
   * message and waits for the turn to finish. The supervisor expects `prompt`
   * to return once the run is accepted, so the request is sent without
   * awaiting its completion and the reply is tracked in the background.
   */
  async prompt(message: string): Promise<{ disposition: string }> {
    if (!this.sessionId) {
      throw new SupervisorError("INVALID_STATE", "MiniMax Code session is not initialized");
    }
    if (this.promptActive) {
      throw new SupervisorError(
        "INVALID_STATE",
        "A prompt is already active for this MiniMax Code session; use steer or follow-up instead",
      );
    }
    this.promptActive = true;
    this.assistantText = "";
    this.assistantMessageId = undefined;
    this.seenAssistantMessageIds.clear();
    // A new turn on the same session must be able to settle again.
    this.settledSeen = false;
    this.runSeen = true;
    this.emit({ type: "run_started" });
    void this.sendPrompt(message);
    return { disposition: "started" };
  }

  async steer(message: string): Promise<void> {
    if (!this.sessionId) {
      throw new SupervisorError("INVALID_STATE", "MiniMax Code session is not initialized");
    }
    if (!this.extensions.has("mcode/session/steer")) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "This MiniMax Code build does not expose the mcode/session/steer extension",
      );
    }
    const result = (await this.request("mcode/session/steer", {
      sessionId: this.sessionId,
      text: message,
    })) as { mode?: string; turnId?: string } | undefined;
    // The agent's own verdict is worth keeping: "steered" means the message
    // joined the running turn, while any other mode means the agent accepted
    // the call without applying it. The supervisor only records that the send
    // succeeded, so this is the only place the real outcome is visible.
    this.emit({
      type: "progress",
      kind: "steer_accepted",
      detail: typeof result?.mode === "string" ? result.mode : undefined,
      preview: typeof result?.turnId === "string" ? result.turnId : undefined,
    });
  }

  async followUp(message: string): Promise<void> {
    if (!this.sessionId) {
      throw new SupervisorError("INVALID_STATE", "MiniMax Code session is not initialized");
    }
    if (!this.extensions.has("mcode/session/queue/enqueue")) {
      throw new SupervisorError(
        "UNSUPPORTED",
        "This MiniMax Code build does not expose the mcode/session/queue/enqueue extension",
      );
    }
    const result = (await this.request("mcode/session/queue/enqueue", {
      sessionId: this.sessionId,
      text: message,
    })) as { itemId?: string; status?: string; position?: number } | undefined;
    const itemId = typeof result?.itemId === "string" ? result.itemId : "";
    this.queued.push({ itemId, text: message });
    // The queue receipt says whether the message really waits for the next turn
    // and where it sits in the queue.
    this.emit({
      type: "progress",
      kind: "followup_queued",
      detail:
        typeof result?.status === "string"
          ? `${result.status}${typeof result.position === "number" ? ` @${result.position}` : ""}`
          : undefined,
      preview: itemId || undefined,
    });
  }

  async clearQueue(): Promise<HarnessQueueContents> {
    const items = [...this.queued];
    if (items.length === 0) return { steering: [], followUp: [] };
    const removed: QueuedMessage[] = [];
    for (const item of items) {
      if (!item.itemId) {
        removed.push(item);
        continue;
      }
      try {
        await this.request("mcode/session/queue/delete", {
          sessionId: this.sessionId,
          itemId: item.itemId,
        });
        removed.push(item);
      } catch (error) {
        this.diagnostic(`queue delete failed: ${errorMessage(error)}`);
      }
    }
    this.queued = this.queued.filter((item) => !removed.includes(item));
    return { steering: [], followUp: removed.map((item) => item.text) };
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    for (const request of [...this.pendingPermissions.values()]) {
      this.pendingPermissions.delete(request.requestId);
      clearTimeout(request.timer);
      await this.respondPermission(request, "cancelled").catch(() => undefined);
    }
    if (!this.sessionId) return;
    // `session/cancel` is a notification, not a request: there is no reply.
    await this.notify("session/cancel", { sessionId: this.sessionId });
    await this.waitForPromptToSettle(Math.min(this.abortTimeoutMs, 5000));
  }

  async answer(requestId: string, response: ExtensionUiResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new SupervisorError(
        "INVALID_STATE",
        "No pending MiniMax Code permission request with that id",
        { requestId },
      );
    }
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);

    if ("cancelled" in response) {
      await this.respondPermission(pending, "cancelled");
      return;
    }

    // MiniMax Code offers real options such as "Allow once", "Always allow"
    // and "Deny". A client may answer with the exact option it was shown (by
    // label or by id), so the offered options are matched first: picking the
    // first allow-looking option instead would silently turn "Always allow"
    // into a denial.
    const exact = findExactPermissionOption(pending, response);
    if (exact) {
      await this.respondPermission(pending, exact.optionId);
      return;
    }

    const allowOption = pickPermissionOption(pending, "allow");
    const denyOption = pickPermissionOption(pending, "deny");

    let allow = false;
    if ("confirmed" in response) {
      allow = response.confirmed;
    } else if ("value" in response) {
      const lowered = response.value.trim().toLowerCase();
      allow = lowered === "allow" || lowered === "yes" || lowered === "true";
    }

    if (allow) {
      const target = allowOption ?? pending.options[0];
      if (!target) {
        throw new SupervisorError("BAD_REQUEST", "Permission request has no selectable option", {
          requestId,
        });
      }
      await this.respondPermission(pending, target.optionId);
      return;
    }
    const target = denyOption ?? pending.options[pending.options.length - 1];
    if (!target) {
      throw new SupervisorError("BAD_REQUEST", "Permission request has no selectable option", {
        requestId,
      });
    }
    await this.respondPermission(pending, target.optionId);
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
      this.diagnostic("MiniMax Code process did not exit after stdin close and forced termination");
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

  private async initialize(): Promise<void> {
    const init = (await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
      },
    })) as Record<string, unknown> | undefined;

    const agentInfo = init?.agentInfo as Record<string, unknown> | undefined;
    if (typeof agentInfo?.version === "string") this.agentVersion = agentInfo.version;

    const meta = init?._meta as Record<string, unknown> | undefined;
    const extensionMeta = meta?.["minimax-code/extensions"] as Record<string, unknown> | undefined;
    const methods = extensionMeta?.methods;
    if (Array.isArray(methods)) {
      this.extensions = new Set(methods.filter((item): item is string => typeof item === "string"));
    }

    if (this.resumeSessionId) {
      this.sessionId = this.resumeSessionId;
      await this.request("session/load", {
        sessionId: this.sessionId,
        cwd: this.cwd,
        mcpServers: [],
      });
      await this.applyPermissionMode();
      await this.writeSessionHandle(this.sessionId);
      return;
    }

    const created = (await this.request("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    })) as Record<string, unknown> | undefined;
    const sessionId = typeof created?.sessionId === "string" ? created.sessionId : undefined;
    if (!sessionId) {
      throw new SupervisorError(
        "HARNESS_ERROR",
        "MiniMax Code did not return a session id from session/new",
      );
    }
    this.sessionId = sessionId;
    await this.applyPermissionMode();
    await this.writeSessionHandle(sessionId);
  }

  /**
   * MiniMax Code defaults to `bypassPermissions`, so tool calls never ask for
   * approval unless the session is switched explicitly. HS wants a worker that
   * surfaces permission requests as `awaiting_input`, so the mode is applied
   * through the ACP session config control.
   *
   * A failure here is reported instead of being swallowed: silently staying in
   * `bypassPermissions` would let a worker act without asking while the caller
   * believes approval is required.
   */
  private async applyPermissionMode(): Promise<void> {
    if (!this.permissionMode || !this.sessionId) return;
    try {
      await this.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "permissionMode",
        value: this.permissionMode,
      });
    } catch (error) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Could not set the MiniMax Code permission mode to "${this.permissionMode}": ${errorMessage(error)}`,
        { permissionMode: this.permissionMode },
      );
    }
  }

  private async sendPrompt(message: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      // ACP keeps this request open for the entire native turn, including
      // permission waits. Only control RPCs use the short request deadline;
      // cancellation, process exit and Supervisor maxDuration bound the run.
      const result = (await this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: message }],
      }, 0)) as { stopReason?: string } | undefined;
      const stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;
      this.promptActive = false;
      if (stopReason === "cancelled" || this.abortRequested) {
        this.emitSettled(true, undefined, stopReason);
        return;
      }
      if (stopReason && stopReason !== "end_turn") {
        const message = safeText(`MiniMax Code turn ended with stopReason=${stopReason}`, 2000);
        this.emit({ type: "run_error", message, fatal: true });
        this.emitSettled(false, undefined, stopReason, message);
        return;
      }
      this.emitSettled(false, this.assistantText, stopReason);
    } catch (error) {
      this.promptActive = false;
      if (this.abortRequested) {
        this.emitSettled(true, undefined, "cancelled");
        return;
      }
      const message = safeText(errorMessage(error), 2000);
      this.emit({ type: "run_error", message, fatal: true });
      this.emitSettled(false, undefined, "error", message);
    }
  }

  private async waitForPromptToSettle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.promptActive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private emitSettled(
    aborted: boolean,
    finalText: string | undefined,
    stopReason?: string,
    error?: string,
  ): void {
    if (this.settledSeen) return;
    this.settledSeen = true;
    this.emit({
      type: "settled",
      aborted,
      finalText,
      stopReason,
      error,
    });
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
        this.diagnostic(`Invalid JSON from MiniMax Code: ${line.slice(0, 300)}`);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    // A message that carries a method is a request or a notification from the
    // agent, never the answer to one of our requests. JSON-RPC gives each side
    // its own id space, and the agent's reverse requests (session/request_permission)
    // use small numeric ids that can collide with ours, so the method decides
    // how a message is routed.
    if (method) {
      if (method === "session/update") {
        this.handleSessionUpdate(message.params);
        return;
      }
      if (method === "session/request_permission") {
        void this.handlePermissionRequest(message);
        return;
      }
      if (method === "$/cancel_request") {
        this.handleAgentCancelRequest(message.params);
        return;
      }
      if (method.startsWith("mcode/")) {
        // Extension notifications (queue/goal/delegation) are not modelled yet.
        // A notification carries no id, so there is nothing to answer. An
        // extension *request* still needs an answer, otherwise the agent waits
        // for it forever.
        if (message.id !== undefined && message.id !== null) {
          void this.write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Method not found: ${method}` },
          }).catch(() => undefined);
        }
        return;
      }
      // An unknown request from the agent still needs an answer, otherwise the
      // agent waits forever for it.
      if (message.id !== undefined && message.id !== null) {
        void this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }).catch(() => undefined);
      }
      return;
    }

    const id = message.id;
    if (id !== undefined && id !== null) {
      const key = String(id);
      const pending = this.pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
        if (message.error) {
          const error = message.error as { code?: number; message?: string } | undefined;
          pending.reject(
            new SupervisorError(
              "HARNESS_ERROR",
              safeText(
                `MiniMax Code ${pending.method} failed: ${error?.message ?? "unknown error"}`,
                2000,
              ),
              { method: pending.method, code: error?.code },
            ),
          );
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  /**
   * The agent can withdraw a permission request it no longer needs. Without
   * this the worker would sit in `awaiting_input` until its own timeout even
   * though the agent has moved on.
   *
   * This is reported as progress rather than an error: the agent changed its
   * mind, nothing failed.
   */
  private handleAgentCancelRequest(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const obj = params as Record<string, unknown>;
    const requestId = obj.requestId;
    if (requestId === undefined || requestId === null) return;
    const key = String(requestId);
    const pending = this.pendingPermissions.get(key);
    if (!pending) return;
    this.pendingPermissions.delete(key);
    clearTimeout(pending.timer);
    this.emit({
      type: "progress",
      kind: "permission_withdrawn",
      detail: key,
      tool: pending.toolName,
    });
  }

  private handleSessionUpdate(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const obj = params as Record<string, unknown>;
    const update = obj.update;
    if (!update || typeof update !== "object") return;
    const record = update as Record<string, unknown>;
    const kind = typeof record.sessionUpdate === "string" ? record.sessionUpdate : "";

    if (kind === "agent_message_chunk" || kind === "agent_message") {
      const content = record.content as { type?: string; text?: string } | undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      if (text) {
        // MiniMax 0.6.12 projects native assistant ids into ACP messageId.
        // Chunks of one message form one answer; a later message replaces
        // earlier commentary. Keep progress events for every chunk, including
        // late chunks from older messages, without mixing them into the result.
        const messageId = typeof record.messageId === "string" && record.messageId
          ? record.messageId : undefined;
        let current = true;
        if (messageId && messageId !== this.assistantMessageId) {
          if (this.seenAssistantMessageIds.has(messageId)) {
            current = false;
          } else {
            this.seenAssistantMessageIds.add(messageId);
            this.assistantMessageId = messageId;
            this.assistantText = "";
          }
        }
        if (current) {
          // agent_message is a whole-message snapshot, not another delta.
          this.assistantText = kind === "agent_message" ? text : this.assistantText + text;
        }
        this.emit({ type: "progress", kind: "assistant_message", preview: safeText(text, 400) });
      }
      return;
    }
    if (kind === "agent_thought_chunk") {
      const content = record.content as { type?: string; text?: string } | undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      if (text) {
        this.emit({ type: "progress", kind: "thinking", preview: safeText(text, 400) });
      }
      return;
    }
    if (kind === "tool_call") {
      // Text before native tool execution is commentary, not a final reply.
      // Also gives older ACP builds without messageId a structural boundary.
      this.assistantText = "";
      this.assistantMessageId = undefined;
      const name = typeof record.name === "string" ? record.name : "unknown";
      this.lastToolName = name;
      this.emit({
        type: "progress",
        kind: "tool_start",
        tool: name,
        detail: safeText(String(record.title ?? ""), 300),
      });
      return;
    }
    if (kind === "tool_call_update") {
      const status = typeof record.status === "string" ? record.status : "";
      if (status === "completed" || status === "failed") {
        this.emit({
          type: "progress",
          kind: "tool_end",
          tool: this.lastToolName ?? "unknown",
          isError: status === "failed",
        });
      }
      return;
    }
    if (kind === "plan") {
      this.emit({ type: "progress", kind: "plan" });
      return;
    }
    if (kind === "current_mode_update") {
      this.emit({ type: "progress", kind: "mode_update" });
    }
  }

  private async handlePermissionRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (id === undefined || id === null) return;
    const requestId = String(id);
    const rpcId = typeof id === "number" ? id : String(id);
    const params = message.params;
    const obj = params && typeof params === "object" ? (params as Record<string, unknown>) : {};

    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: PendingPermission["options"] = [];
    for (const raw of rawOptions) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const optionId = typeof item.optionId === "string" ? item.optionId : "";
      if (!optionId) continue;
      const name =
        typeof item.name === "string"
          ? item.name
          : typeof item.kind === "string"
            ? item.kind
            : optionId;
      options.push({
        optionId,
        name,
        kind: typeof item.kind === "string" ? item.kind : "",
      });
    }

    const toolCall = obj.toolCall as Record<string, unknown> | undefined;
    const toolName =
      (typeof toolCall?.title === "string" && toolCall.title) ||
      (typeof toolCall?.rawInput === "object" && toolCall.rawInput !== null
        ? String((toolCall.rawInput as Record<string, unknown>).command ?? "tool")
        : "tool");
    const title = typeof obj.title === "string" ? obj.title : `Allow ${toolName}?`;
    const message_ = [
      title,
      typeof obj.message === "string" ? obj.message : undefined,
      toolCall?.rawInput !== undefined ? `Input: ${JSON.stringify(toolCall.rawInput)}` : undefined,
    ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");

    const pending: PendingPermission = {
      requestId,
      rpcId,
      toolName,
      title,
      message: message_,
      options,
      timer: setTimeout(() => undefined, 0),
    };

    if (this.abortRequested) {
      await this.respondPermissionById(pending, "cancelled").catch(() => undefined);
      return;
    }

    pending.timer = setTimeout(() => {
      this.pendingPermissions.delete(requestId);
      void this.respondPermissionById(pending, "cancelled").catch(() => undefined);
      this.emit({
        type: "run_error",
        message: "MiniMax Code permission request timed out without an answer",
        fatal: false,
      });
    }, PERMISSION_TIMEOUT_MS);
    pending.timer.unref?.();
    this.pendingPermissions.set(requestId, pending);

    this.emit({
      type: "needs_input",
      requestId,
      method: "select",
      title: safeText(title, 300),
      // Approval needs the actual arguments, not just an agent-written title.
      // The native rawInput is the only source of truth for that decision, so
      // it is included under a bound. A truncation marker means the arguments
      // are incomplete and the caller must not approve from the prefix alone.
      // The supervisor stores the
      // pending input verbatim and hands it to the caller, so an unbounded
      // payload would push an arbitrarily large tool input into the caller's
      // context. The bound covers common short commands, and the
      // visible truncation marker keeps the loss obvious instead of silent.
      message: safeText(message_, PERMISSION_MESSAGE_MAX_CHARS),
      options: options.map((option) => option.name),
      timeoutMs: PERMISSION_TIMEOUT_MS,
    });
  }

  private async respondPermission(pending: PendingPermission, outcome: string): Promise<void> {
    await this.respondPermissionById(pending, outcome);
  }

  /**
   * Answers a permission request. JSON-RPC replies must reuse the id the
   * agent sent, otherwise the agent waits forever for the answer.
   */
  private async respondPermissionById(
    pending: PendingPermission,
    outcome: string,
  ): Promise<void> {
    const result =
      outcome === "cancelled"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: outcome } };
    await this.write({ jsonrpc: "2.0", id: pending.rpcId, result });
  }

  /**
   * Request ids are strings on purpose. JSON-RPC gives each side its own id
   * space, and MiniMax Code numbers its reverse requests (session/request_permission)
   * from zero. Numeric ids would let an agent request collide with one of our
   * pending requests and be mistaken for its answer. A string prefix keeps the
   * two spaces apart; the agent accepts string ids.
   */
  private nextId(): string {
    return `hs-${++this.requestCounter}`;
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    this.rejectPending(
      new SupervisorError("HARNESS_ERROR", `MiniMax Code process exited (code=${code}, signal=${signal})`, {
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

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.isAlive()) {
      return Promise.reject(
        new SupervisorError("HARNESS_ERROR", "MiniMax Code process is not running", {
          stderrTail: this.stderrTail(),
        }),
      );
    }
    const id = this.nextId();
    const limit = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = limit > 0 ? setTimeout(() => {
        this.pending.delete(String(id));
        reject(
          new SupervisorError(
            "HARNESS_TIMEOUT",
            `MiniMax Code request timed out after ${limit}ms: ${method}`,
            { method },
          ),
        );
      }, limit) : undefined;
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

  private async notify(method: string, params: unknown): Promise<void> {
    if (!this.isAlive()) return;
    await this.write({ jsonrpc: "2.0", method, params });
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    if (!this.isAlive()) {
      throw new SupervisorError("HARNESS_ERROR", "Cannot write to MiniMax Code: process is not running");
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(
            new SupervisorError("HARNESS_ERROR", `Failed to write to MiniMax Code stdin: ${error.message}`),
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
    const line = `${new Date().toISOString()} [mcode-acp] ${message}\n`;
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
