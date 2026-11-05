import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SupervisorError, errorMessage } from "../../errors.js";
import {
  DEFAULT_INPUT_TIMEOUT_MS,
  DSH_INPUT_TIMEOUT_ENV,
  resolveRuntimeInputTimeoutMs,
} from "../../input-timeout.js";
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
import { ensureDir } from "../../util/fsx.js";
import { safeText } from "../../util/redact.js";
import { AcpClient } from "../acp/client.js";
import {
  findDshConfigOption,
  resolveDshModelValue,
  resolveDshReasoningValue,
  type DshConfigOption,
} from "./config.js";
import type { DshLaunch } from "./launch.js";

export interface DshAcpSessionOptions {
  launch: DshLaunch;
  cwd: string;
  sessionDir: string;
  callbacks: HarnessCallbacks;
  model?: string;
  provider?: string;
  thinking?: string;
  resumeSessionId?: string;
  onStderr?: (text: string) => void;
  onDiagnostic?: (text: string) => void;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  stderrTailBytes?: number;
}

interface PendingPermission {
  requestId: string;
  rpcId: number | string;
  toolCallId: string;
  title: string;
  message: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  timer: NodeJS.Timeout;
}

interface DshToolCall {
  title?: string;
  name?: string;
  kind?: string;
}

const ACP_PROTOCOL_VERSION = 1;
const PERMISSION_MESSAGE_MAX_CHARS = 8000;

function asConfigOptions(value: unknown): DshConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is DshConfigOption => Boolean(item) && typeof item === "object",
  );
}

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
 * DeepSeek Harness speaks standard ACP v1 over ndJSON, but its surface differs
 * from Qoder and MiniMax Code: it advertises session/resume (not session/load),
 * exposes model and reasoning_effort as config options, and has no mode,
 * commands, terminal, client filesystem or elicitation surface.
 */
export class DshAcpSession implements HarnessSession {
  readonly pid: number | undefined;
  private readonly client: AcpClient;
  private readonly callbacks: HarnessCallbacks;
  private readonly abortTimeoutMs: number;
  private readonly cwd: string;
  private readonly sessionDir: string;
  private readonly model: string | undefined;
  private readonly provider: string | undefined;
  private readonly thinking: string | undefined;
  private readonly resumeSessionId: string | undefined;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private sessionId: string | undefined;
  private sessionFile: string | undefined;
  private configOptions: DshConfigOption[] = [];
  private promptActive = false;
  private abortRequested = false;
  private settledSeen = false;
  private assistantText = "";
  private assistantMessageId: string | undefined;
  private readonly seenAssistantMessageIds = new Set<string>();
  private lastToolName: string | undefined;

  private constructor(client: AcpClient, options: DshAcpSessionOptions) {
    this.client = client;
    this.pid = client.pid;
    this.callbacks = options.callbacks;
    this.abortTimeoutMs = options.abortTimeoutMs ?? 20_000;
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.model = options.model;
    this.provider = options.provider;
    this.thinking = options.thinking;
    this.resumeSessionId = options.resumeSessionId;
  }

  static async start(options: DshAcpSessionOptions): Promise<DshAcpSession> {
    let session: DshAcpSession | null = null;
    const client = await AcpClient.start({
      launch: {
        file: options.launch.file,
        args: options.launch.args,
        cwd: options.cwd,
        env: options.launch.env,
        description: options.launch.description,
        windowsVerbatimArguments: options.launch.windowsVerbatimArguments,
      },
      runtimeLabel: "DeepSeek Harness",
      diagnosticTag: "dsh-acp",
      handlers: {
        onUpdate: (params) => session?.handleSessionUpdate(params),
        onRequest: (method, params, id) =>
          session?.handleReverseRequest(method, params, id) ?? false,
        onNotification: (method, params) => session?.handleNotification(method, params),
        onExit: (exit) => session?.handleExit(exit),
      },
      requestTimeoutMs: options.requestTimeoutMs,
      stderrTailBytes: options.stderrTailBytes,
      onStderr: options.onStderr,
      onDiagnostic: options.onDiagnostic,
    });
    session = new DshAcpSession(client, options);
    try {
      await session.initialize();
    } catch (error) {
      await client.forceKill().catch(() => undefined);
      throw error;
    }
    return session;
  }

  isAlive(): boolean {
    return this.client.isAlive();
  }

  stderrTail(): string {
    return this.client.stderrTail();
  }

  async getState(): Promise<HarnessStateInfo> {
    return { sessionId: this.sessionId, sessionFile: this.sessionFile };
  }

  private get sessionHandleFile(): string {
    return path.join(this.sessionDir, "dsh-session.json");
  }

  private async writeSessionHandle(sessionId: string): Promise<void> {
    const file = this.sessionHandleFile;
    const payload = {
      type: "session",
      id: sessionId,
      runtime: "dsh",
      protocol: "acp",
      cwd: this.cwd,
      updatedAt: new Date().toISOString(),
    };
    await ensureDir(this.sessionDir);
    await writeFile(`${file}.tmp`, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(`${file}.tmp`, file);
    this.sessionFile = file;
  }

  private async initialize(): Promise<void> {
    const init = (await this.client.request(
      "initialize",
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
      30_000,
    )) as Record<string, unknown> | undefined;
    const protocolVersion = init?.protocolVersion;
    if (typeof protocolVersion === "number" && protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `DeepSeek Harness negotiated ACP protocol ${protocolVersion}; this adapter implements v${ACP_PROTOCOL_VERSION}.`,
      );
    }
    if (this.resumeSessionId) {
      this.sessionId = this.resumeSessionId;
      let resumed: Record<string, unknown> | undefined;
      try {
        resumed = (await this.client.request(
          "session/resume",
          {
            sessionId: this.sessionId,
            cwd: this.cwd,
            mcpServers: [],
          },
          60_000,
        )) as Record<string, unknown> | undefined;
      } catch (error) {
        throw new SupervisorError(
          "UNSUPPORTED",
          `DeepSeek Harness could not resume session ${this.sessionId}: ${errorMessage(error)}. ACP resume requires the same absolute cwd.`,
          { sessionId: this.sessionId, cwd: this.cwd },
        );
      }
      this.configOptions = asConfigOptions(resumed?.configOptions);
      await this.applyConfig();
      await this.writeSessionHandle(this.sessionId);
      return;
    }

    const created = (await this.client.request(
      "session/new",
      { cwd: this.cwd, mcpServers: [] },
      60_000,
    )) as Record<string, unknown> | undefined;
    const sessionId = typeof created?.sessionId === "string" ? created.sessionId : undefined;
    if (!sessionId) {
      throw new SupervisorError(
        "HARNESS_ERROR",
        "DeepSeek Harness did not return a session id from session/new",
      );
    }
    this.sessionId = sessionId;
    this.configOptions = asConfigOptions(created?.configOptions);
    await this.applyConfig();
    await this.writeSessionHandle(sessionId);
  }

  private async applyConfig(): Promise<void> {
    if (!this.sessionId) return;
    const modelValue = resolveDshModelValue(this.configOptions, {
      model: this.model,
      provider: this.provider,
    });
    if (modelValue !== undefined) {
      await this.setConfigOption("model", modelValue);
    }
    const reasoningValue = resolveDshReasoningValue(this.configOptions, this.thinking);
    if (reasoningValue !== undefined) {
      await this.setConfigOption("reasoning_effort", reasoningValue);
    }
  }

  private async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.sessionId) return;
    let result: Record<string, unknown> | undefined;
    try {
      result = (await this.client.request(
        "session/set_config_option",
        { sessionId: this.sessionId, configId, value },
        30_000,
      )) as Record<string, unknown> | undefined;
    } catch (error) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Could not set DeepSeek Harness config "${configId}" to "${value}": ${errorMessage(error)}`,
        { configId, value },
      );
    }
    const updated = asConfigOptions(result?.configOptions);
    if (updated.length > 0) this.configOptions = updated;
    const option = findDshConfigOption(this.configOptions, configId);
    if (option?.currentValue !== undefined && option.currentValue !== value) {
      throw new SupervisorError(
        "HARNESS_ERROR",
        `DeepSeek Harness reported ${configId}="${option.currentValue}" after setting "${value}".`,
        { configId, requested: value, reported: option.currentValue },
      );
    }
  }

  /**
   * `session/prompt` blocks until the whole turn, including tool approvals and
   * descendants, settles. The supervisor expects prompt() to return once the
   * run is accepted, so the request is tracked in the background.
   */
  async prompt(message: string): Promise<{ disposition: string }> {
    if (!this.sessionId) {
      throw new SupervisorError("INVALID_STATE", "DeepSeek Harness session is not initialized");
    }
    if (this.promptActive) {
      throw new SupervisorError(
        "INVALID_STATE",
        "A prompt is already active for this DeepSeek Harness session; the ACP profile accepts one prompt at a time and exposes no steer method.",
      );
    }
    this.promptActive = true;
    this.abortRequested = false;
    this.settledSeen = false;
    this.assistantText = "";
    this.assistantMessageId = undefined;
    this.seenAssistantMessageIds.clear();
    this.emit({ type: "run_started" });
    void this.sendPrompt(message);
    return { disposition: "started" };
  }

  async steer(): Promise<void> {
    throw new SupervisorError(
      "UNSUPPORTED",
      "DeepSeek Harness ACP exposes no active-turn steer method; its native agent.steer() is not part of the ACP surface.",
    );
  }

  async followUp(): Promise<void> {
    throw new SupervisorError(
      "UNSUPPORTED",
      "DeepSeek Harness ACP has no queued follow-up method; submit a new prompt after the current turn settles.",
    );
  }

  async clearQueue(): Promise<HarnessQueueContents> {
    return { steering: [], followUp: [] };
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    for (const request of [...this.pendingPermissions.values()]) {
      this.pendingPermissions.delete(request.requestId);
      clearTimeout(request.timer);
      await this.respondPermission(request, "cancelled").catch(() => undefined);
    }
    if (!this.sessionId) return;
    // `session/cancel` is a notification; there is no reply.
    await this.client.notify("session/cancel", { sessionId: this.sessionId }).catch(() => undefined);
    await this.waitForPromptToSettle(Math.min(this.abortTimeoutMs, 5000));
  }

  async close(options?: { graceMs?: number }): Promise<HarnessCloseResult> {
    return this.client.close(options);
  }

  async forceKill(): Promise<void> {
    await this.client.forceKill();
  }

  async answer(requestId: string, response: ExtensionUiResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new SupervisorError(
        "INVALID_STATE",
        "No pending DeepSeek Harness permission request with that id",
        { requestId },
      );
    }
    this.pendingPermissions.delete(requestId);
    clearTimeout(pending.timer);

    if ("cancelled" in response) {
      await this.respondPermission(pending, "cancelled");
      return;
    }

    const exact = findExactPermissionOption(pending, response);
    if (exact) {
      await this.respondPermission(pending, exact.optionId);
      return;
    }

    let allow = false;
    if ("confirmed" in response) {
      allow = response.confirmed;
    } else if ("value" in response) {
      const lowered = response.value.trim().toLowerCase();
      allow = lowered === "allow" || lowered === "yes" || lowered === "true";
    }
    const target = allow
      ? pickPermissionOption(pending, "allow") ?? pending.options[0]
      : pickPermissionOption(pending, "deny") ?? pending.options[pending.options.length - 1];
    if (!target) {
      throw new SupervisorError("BAD_REQUEST", "Permission request has no selectable option", {
        requestId,
      });
    }
    await this.respondPermission(pending, target.optionId);
  }

  private async sendPrompt(message: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      const result = (await this.client.request(
        "session/prompt",
        {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: message }],
        },
        0,
      )) as { stopReason?: string } | undefined;
      const stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;
      this.promptActive = false;
      if (stopReason === "cancelled" || this.abortRequested) {
        this.emitSettled(true, undefined, stopReason);
        return;
      }
      if (stopReason && stopReason !== "end_turn") {
        const error = safeText(
          `DeepSeek Harness turn ended with stopReason=${stopReason}`,
          2000,
        );
        this.emit({ type: "run_error", message: error, fatal: true });
        this.emitSettled(false, undefined, stopReason, error);
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
    this.emit({ type: "settled", aborted, finalText, stopReason, error });
  }

  private handleSessionUpdate(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const obj = params as Record<string, unknown>;
    if (typeof obj.sessionId === "string" && this.sessionId && obj.sessionId !== this.sessionId) {
      return;
    }
    const update = obj.update;
    if (!update || typeof update !== "object") return;
    const record = update as Record<string, unknown>;
    const kind = typeof record.sessionUpdate === "string" ? record.sessionUpdate : "";

    if (kind === "agent_message_chunk") {
      const text = this.updateText(record);
      if (text) {
        const messageId =
          typeof record.messageId === "string" && record.messageId
            ? record.messageId
            : undefined;
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
        if (current) this.assistantText += text;
        this.emit({
          type: "progress",
          kind: "assistant_message",
          preview: safeText(text, 4000),
        });
      }
      return;
    }
    if (kind === "agent_thought_chunk") {
      const text = this.updateText(record);
      if (text) {
        this.emit({ type: "progress", kind: "thinking", preview: safeText(text, 4000) });
      }
      return;
    }
    if (kind === "tool_call") {
      // Text before a tool call is commentary, not the final reply. It also
      // gives builds without a stable message id a structural boundary.
      this.assistantText = "";
      this.assistantMessageId = undefined;
      const toolCall = record as DshToolCall;
      const name =
        (typeof toolCall.title === "string" && toolCall.title) ||
        (typeof toolCall.name === "string" && toolCall.name) ||
        "tool";
      this.lastToolName = name;
      this.emit({
        type: "progress",
        kind: "tool_start",
        tool: name,
        detail: safeText(
          [toolCall.title, toolCall.kind].filter((value) => typeof value === "string").join(" / "),
          2000,
        ),
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
    if (kind === "usage_update") {
      // ACP's usage_update is context occupancy, not billed token usage. Do not
      // turn it into run.usage; keep it as observable progress.
      const used = record.used;
      const size = record.size;
      if (typeof used === "number" && typeof size === "number") {
        this.emit({
          type: "progress",
          kind: "context_usage",
          detail: `${used}/${size}`,
        });
      }
    }
  }

  private updateText(record: Record<string, unknown>): string {
    const content = record.content as { type?: string; text?: string } | undefined;
    return content?.type === "text" && typeof content.text === "string" ? content.text : "";
  }

  private handleReverseRequest(
    method: string,
    params: unknown,
    id: number | string,
  ): boolean {
    if (method === "session/request_permission") {
      void this.handlePermissionRequest(params, id).catch(() => {
        // Never leave the agent waiting on an approval we failed to surface.
        return this.client
          .reply(id, { outcome: { outcome: "cancelled" } })
          .catch(() => undefined);
      });
      return true;
    }
    return false;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "$/cancel_request") return;
    if (!params || typeof params !== "object") return;
    const requestId = (params as Record<string, unknown>).requestId;
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
      tool: pending.toolCallId,
    });
  }

  private async handlePermissionRequest(
    params: unknown,
    id: number | string,
  ): Promise<void> {
    const obj = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const toolCall =
      obj.toolCall && typeof obj.toolCall === "object"
        ? (obj.toolCall as Record<string, unknown>)
        : undefined;
    const toolCallId =
      typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : "unknown";
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: PendingPermission["options"] = [];
    for (const raw of rawOptions) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const optionId = typeof item.optionId === "string" ? item.optionId : "";
      if (!optionId) continue;
      options.push({
        optionId,
        name:
          typeof item.name === "string"
            ? item.name
            : typeof item.kind === "string"
              ? item.kind
              : optionId,
        kind: typeof item.kind === "string" ? item.kind : "",
      });
    }

    const requestId = String(id);
    const title = `Allow DeepSeek Harness tool call ${toolCallId}?`;
    // DSH's approval request carries only the tool call id and the two options;
    // it does not include a tool name or raw input.
    const message = [
      title,
      `Tool call: ${toolCallId}`,
      "The ACP approval request does not include the tool input.",
    ].join("\n");
    const pending: PendingPermission = {
      requestId,
      rpcId: id,
      toolCallId,
      title,
      message,
      options,
      timer: setTimeout(() => undefined, 0),
    };
    const timeoutMs = resolveRuntimeInputTimeoutMs({
      specificEnv: DSH_INPUT_TIMEOUT_ENV,
      defaultMs: DEFAULT_INPUT_TIMEOUT_MS,
    });

    if (this.abortRequested) {
      await this.respondPermission(pending, "cancelled").catch(() => undefined);
      return;
    }

    pending.timer = setTimeout(() => {
      this.pendingPermissions.delete(requestId);
      void this.respondPermission(pending, "cancelled").catch(() => undefined);
      this.emit({
        type: "run_error",
        message: "DeepSeek Harness permission request timed out without an answer",
        fatal: false,
      });
    }, timeoutMs);
    pending.timer.unref?.();
    this.pendingPermissions.set(requestId, pending);

    this.emit({
      type: "needs_input",
      requestId,
      method: "select",
      title: safeText(title, 300),
      message: safeText(message, PERMISSION_MESSAGE_MAX_CHARS),
      options: options.map((option) => option.name),
      timeoutMs,
    });
  }

  private async respondPermission(
    pending: PendingPermission,
    outcome: string,
  ): Promise<void> {
    const result =
      outcome === "cancelled"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: outcome } };
    await this.client.reply(pending.rpcId, result);
  }

  private handleExit(exit: HarnessExit): void {
    this.rejectPendingPermissions();
    try {
      this.callbacks.onExit(exit);
    } catch {
      // Callback failures must not break process cleanup.
    }
  }

  private rejectPendingPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer);
      void this.respondPermission(pending, "cancelled").catch(() => undefined);
    }
    this.pendingPermissions.clear();
  }

  private emit(event: Parameters<HarnessCallbacks["onEvent"]>[0]): void {
    try {
      this.callbacks.onEvent(event);
    } catch {
      // Callback failures must not break protocol parsing.
    }
  }
}

export function readDshSessionHandle(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: unknown;
      id?: unknown;
      runtime?: unknown;
      protocol?: unknown;
    };
    if (
      parsed.type === "session" &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0 &&
      parsed.runtime === "dsh" &&
      parsed.protocol === "acp"
    ) {
      return parsed.id;
    }
  } catch {
    return null;
  }
  return null;
}
