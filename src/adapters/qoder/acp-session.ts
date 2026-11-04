import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
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
  HarnessUsageReport,
} from "../../types.js";
import { Deferred, withTimeout } from "../../util/async.js";
import { ensureDir } from "../../util/fsx.js";
import { safeText } from "../../util/redact.js";
import {
  DEFAULT_INPUT_TIMEOUT_MS,
  QODER_INPUT_TIMEOUT_ENV,
  resolveRuntimeInputTimeoutMs,
} from "../../input-timeout.js";
import type { QoderLaunch, QoderPermissionMode } from "./launch.js";

export interface QoderAcpSessionOptions {
  launch: QoderLaunch;
  args: string[];
  cwd: string;
  /** Supervisor-owned directory where this worker keeps its session handle. */
  sessionDir: string;
  callbacks: HarnessCallbacks;
  permissionMode?: QoderPermissionMode;
  modelId?: string;
  thinking?: string;
  onStderr?: (text: string) => void;
  onDiagnostic?: (text: string) => void;
  requestTimeoutMs?: number;
  abortTimeoutMs?: number;
  stderrTailBytes?: number;
  /** Resume an existing Qoder ACP session instead of creating a new one. */
  resumeSessionId?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  method: string;
}

interface PermissionOption {
  optionId: string;
  /** Label shown to the caller; the native name when Qoder sends one. */
  name: string;
  kind: string;
}

interface PendingPermission {
  kind: "permission";
  requestId: string;
  /** The JSON-RPC id exactly as the agent sent it; replies must reuse it. */
  rpcId: number | string;
  toolName: string;
  title: string;
  message: string;
  options: PermissionOption[];
  timer: NodeJS.Timeout;
}

interface ElicitationOption {
  /** Native value accepted by the schema; may not be a string. */
  value: string | number | boolean;
  label: string;
}

interface ElicitationField {
  key: string;
  title: string;
  description?: string;
  type: string;
  required: boolean;
  options?: ElicitationOption[];
}

interface PendingElicitation {
  kind: "elicitation";
  requestId: string;
  rpcId: number | string;
  title: string;
  /** One field means a plain select/confirm/input; several mean a JSON object. */
  field?: ElicitationField;
  fields?: ElicitationField[];
  timer: NodeJS.Timeout;
}

type PendingInputRequest = PendingPermission | PendingElicitation;

interface SessionConfigOption {
  currentValue?: unknown;
  options?: Array<{ value: string; name?: string }>;
}

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_PERMISSION_TIMEOUT_MS = DEFAULT_INPUT_TIMEOUT_MS;
const PERMISSION_MESSAGE_MAX_CHARS = 8000;
const ELICITATION_MESSAGE_MAX_CHARS = 8000;
const MAX_FS_READ_BYTES = 5 * 1024 * 1024;

/**
 * Qoder's ACP modes are camelCase and its bypass mode is named `yolo`.
 * `plan` has no ACP equivalent in 1.1.82; it is rejected instead of being
 * mapped to another mode.
 */
const ACP_MODE_BY_PERMISSION: Record<QoderPermissionMode, string | null> = {
  bypass_permissions: "yolo",
  auto: "auto",
  dont_ask: "dontAsk",
  accept_edits: "acceptEdits",
  default: "default",
  plan: null,
};

/**
 * HS accepts Pi-style thinking levels for every runtime. Qoder exposes
 * `reasoning_effort` with none/low/high/max, so the levels are folded onto the
 * nearest offered value. An unknown level is rejected, not ignored.
 */
const REASONING_EFFORT_BY_THINKING: Record<string, string> = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

const PERMISSION_OPTION_LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow",
  reject_once: "Reject",
  reject_always: "Always reject",
};

function optionLabel(option: PermissionOption): string {
  if (option.name) return option.name;
  return PERMISSION_OPTION_LABELS[option.kind] ?? option.optionId;
}

function findExactPermissionOption(
  pending: PendingPermission,
  response: ExtensionUiResponse,
): PermissionOption | undefined {
  if (!("value" in response) || typeof response.value !== "string") return undefined;
  const value = response.value.trim().toLowerCase();
  if (!value) return undefined;
  return pending.options.find(
    (option) =>
      option.name.toLowerCase() === value ||
      option.optionId.toLowerCase() === value ||
      option.kind.toLowerCase() === value ||
      optionLabel(option).toLowerCase() === value,
  );
}

function pickPermissionOption(
  pending: PendingPermission,
  intent: "allow" | "deny",
): PermissionOption | undefined {
  const byKind = pending.options.find((option) =>
    intent === "allow" ? option.kind === "allow_once" : option.kind === "reject_once",
  );
  if (byKind) return byKind;
  const byOtherKind = pending.options.find((option) =>
    intent === "allow" ? option.kind.startsWith("allow") : option.kind.startsWith("reject"),
  );
  if (byOtherKind) return byOtherKind;
  const byId = pending.options.find((option) =>
    intent === "allow"
      ? /^(allow|proceed_always|proceed_once)/.test(option.optionId)
      : /^(deny|reject|cancel)/.test(option.optionId),
  );
  if (byId) return byId;
  return pending.options.find((option) =>
    intent === "allow"
      ? /allow|accept|yes|proceed/i.test(optionLabel(option))
      : /deny|reject|cancel|no/i.test(optionLabel(option)),
  );
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFromPromptResult(result: unknown): HarnessUsageReport | undefined {
  if (!result || typeof result !== "object") return undefined;
  const usage = (result as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens = numberValue(record.inputTokens ?? record.input_tokens);
  const outputTokens = numberValue(record.outputTokens ?? record.output_tokens);
  const cacheReadTokens = numberValue(record.cachedReadTokens ?? record.cache_read_tokens);
  const cacheWriteTokens = numberValue(record.cachedWriteTokens ?? record.cache_write_tokens);
  const total = numberValue(record.totalTokens ?? record.total_tokens);
  const positive = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, total].some(
    (value) => typeof value === "number" && value > 0,
  );
  // Qoder 1.1.82 returns all-zero counters; zeros mean "not reported", not a
  // real zero-token turn, so they are omitted rather than recorded as usage.
  if (!positive) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(total !== undefined ? { reportedTotalTokens: total } : {}),
  };
}

function parseElicitationField(
  key: string,
  raw: unknown,
  required: boolean,
): ElicitationField | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "string";
  const options: ElicitationOption[] = [];
  const addOption = (value: unknown, title: unknown): void => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      options.push({
        value,
        label: typeof title === "string" && title.length > 0 ? title : String(value),
      });
    }
  };
  if (Array.isArray(record.oneOf)) {
    for (const item of record.oneOf) {
      if (!item || typeof item !== "object") continue;
      const option = item as Record<string, unknown>;
      addOption(option.const, option.title);
    }
  }
  if (Array.isArray(record.enum)) {
    for (const item of record.enum) {
      if (item && typeof item === "object") {
        const option = item as Record<string, unknown>;
        addOption(option.const ?? option.value, option.title);
      } else {
        addOption(item, undefined);
      }
    }
  }
  return {
    key,
    title: typeof record.title === "string" && record.title.length > 0 ? record.title : key,
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    type,
    required,
    ...(options.length > 0 ? { options } : {}),
  };
}

/**
 * Qoder CLI's official ACP transport. `session/prompt` stays open for the
 * whole turn (including permission/elicitation waits). Qoder advertises prompt
 * queueing in `_meta`, but HS has not verified what a queued prompt does to
 * run boundaries, so this session refuses a second prompt while one is active.
 */
export class QoderAcpSession implements HarnessSession {
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly callbacks: HarnessCallbacks;
  private readonly onStderr?: (text: string) => void;
  private readonly onDiagnostic?: (text: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly abortTimeoutMs: number;
  private readonly maxStderrTail: number;
  private readonly cwd: string;
  private readonly sessionDir: string;
  private readonly resumeSessionId: string | undefined;
  private readonly permissionMode: QoderPermissionMode | undefined;
  private readonly modelId: string | undefined;
  private readonly thinking: string | undefined;
  private readonly closed = new Deferred<HarnessExit>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingInputs = new Map<string, PendingInputRequest>();
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly seenAssistantMessageIds = new Set<string>();
  private readonly configOptions = new Map<string, SessionConfigOption>();
  private availableModes = new Map<string, string>();
  private availableModels: Array<{ modelId: string; name?: string }> = [];
  private requestCounter = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private exitInfo: HarnessExit | null = null;
  private exited = false;
  private forced = false;
  private settledSeen = false;
  private runSeen = false;
  private abortRequested = false;
  private loadingSession = false;
  private promptActive = false;
  private sessionId: string | undefined;
  private sessionFile: string | undefined;
  private agentVersion: string | undefined;
  private loadSessionSupported = false;
  private assistantText = "";
  private assistantMessageId: string | undefined;
  private lastToolName: string | undefined;
  private readonly toolNames = new Map<string, string>();

  private constructor(child: ChildProcessWithoutNullStreams, options: QoderAcpSessionOptions) {
    this.child = child;
    this.pid = child.pid;
    this.callbacks = options.callbacks;
    this.onStderr = options.onStderr;
    this.onDiagnostic = options.onDiagnostic;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.abortTimeoutMs = options.abortTimeoutMs ?? 20_000;
    this.maxStderrTail = options.stderrTailBytes ?? 32 * 1024;
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.resumeSessionId = options.resumeSessionId;
    this.permissionMode = options.permissionMode;
    this.modelId = options.modelId;
    this.thinking = options.thinking;

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

  static async start(options: QoderAcpSessionOptions): Promise<QoderAcpSession> {
    const child = spawn(options.launch.file, [...options.launch.args, ...options.args], {
      cwd: options.cwd,
      env: options.launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const session = new QoderAcpSession(child, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(
            new SupervisorError("HARNESS_ERROR", `Failed to start qodercli --acp: ${error.message}`, {
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

  stderrTail(): string {
    return safeText(this.stderrBuffer, 16 * 1024);
  }

  async getState(): Promise<HarnessStateInfo> {
    return { sessionId: this.sessionId, sessionFile: this.sessionFile };
  }

  private get sessionHandleFile(): string {
    return path.join(this.sessionDir, "qoder-acp-session.json");
  }

  private async writeSessionHandle(sessionId: string): Promise<void> {
    const file = this.sessionHandleFile;
    const payload = {
      type: "session",
      id: sessionId,
      runtime: "qoder",
      protocol: "acp",
      cwd: this.cwd,
      // Persist the catalog so a resumed session can resolve a display-name
      // model even when session/load does not repeat the model list.
      models: this.availableModels,
      updatedAt: new Date().toISOString(),
    };
    await ensureDir(this.sessionDir);
    await writeFile(`${file}.tmp`, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(`${file}.tmp`, file);
    this.sessionFile = file;
  }

  private async seedModelsFromHandle(): Promise<void> {
    try {
      const raw = await readFile(this.sessionHandleFile, "utf8");
      const firstLine = raw.split("\n", 1)[0];
      if (!firstLine) return;
      const parsed = JSON.parse(firstLine) as { models?: unknown };
      if (!Array.isArray(parsed.models)) return;
      const models = parsed.models.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.modelId !== "string") return [];
        return [{
          modelId: record.modelId,
          ...(typeof record.name === "string" ? { name: record.name } : {}),
        }];
      });
      if (models.length > 0) this.availableModels = models;
    } catch {
      // A missing/legacy handle is not fatal: session/load may still return
      // the catalog, and an unmatched model is reported before the prompt.
    }
  }

  async prompt(message: string): Promise<{ disposition: string }> {
    if (!this.sessionId) {
      throw new SupervisorError("INVALID_STATE", "Qoder ACP session is not initialized");
    }
    if (this.promptActive) {
      throw new SupervisorError(
        "INVALID_STATE",
        "A prompt is already active for this Qoder ACP session; steering and queued follow-ups are not supported by this transport",
      );
    }
    this.promptActive = true;
    this.assistantText = "";
    this.assistantMessageId = undefined;
    this.seenAssistantMessageIds.clear();
    this.toolNames.clear();
    this.settledSeen = false;
    this.runSeen = true;
    this.emit({ type: "run_started" });
    void this.sendPrompt(message);
    return { disposition: "started" };
  }

  async steer(): Promise<void> {
    throw new SupervisorError(
      "UNSUPPORTED",
      "Qoder ACP does not expose a verified steering method; use stream-json for steering or wait for the turn to finish",
    );
  }

  async followUp(): Promise<void> {
    throw new SupervisorError(
      "UNSUPPORTED",
      "Qoder ACP does not expose a verified queued follow-up method; use stream-json for follow-ups",
    );
  }

  async clearQueue(): Promise<HarnessQueueContents> {
    return { steering: [], followUp: [] };
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    for (const request of [...this.pendingInputs.values()]) {
      this.pendingInputs.delete(request.requestId);
      clearTimeout(request.timer);
      if (request.kind === "permission") {
        await this.respondPermission(request, "cancelled").catch(() => undefined);
      } else {
        await this.respondElicitation(request, { action: "cancel" }).catch(() => undefined);
      }
    }
    if (!this.sessionId) return;
    // `session/cancel` is a notification, not a request: there is no reply.
    await this.notify("session/cancel", { sessionId: this.sessionId });
    await this.waitForPromptToSettle(Math.min(this.abortTimeoutMs, 5000));
  }

  async answer(requestId: string, response: ExtensionUiResponse): Promise<void> {
    const pending = this.pendingInputs.get(requestId);
    if (!pending) {
      throw new SupervisorError(
        "INVALID_STATE",
        "No pending Qoder ACP input request with that id",
        { requestId },
      );
    }
    // Delete only after a successful answer. An invalid answer must leave the
    // request (and its own timeout) in place instead of stranding the agent.
    if (pending.kind === "permission") {
      await this.answerPermission(pending, response);
    } else {
      await this.answerElicitation(pending, response);
    }
    this.pendingInputs.delete(requestId);
    clearTimeout(pending.timer);
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
      this.diagnostic("qodercli --acp did not exit after stdin close and forced termination");
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
        // Form elicitation is what Qoder uses for AskUserQuestion. URL
        // elicitation is deliberately not advertised because HS has no browser
        // or URL hand-off surface.
        elicitation: { form: {} },
      },
    })) as Record<string, unknown> | undefined;

    const agentInfo = init?.agentInfo as Record<string, unknown> | undefined;
    if (typeof agentInfo?.version === "string") this.agentVersion = agentInfo.version;
    const agentCapabilities = init?.agentCapabilities as Record<string, unknown> | undefined;
    this.loadSessionSupported = agentCapabilities?.loadSession === true;

    if (this.resumeSessionId) {
      if (!this.loadSessionSupported) {
        throw new SupervisorError(
          "UNSUPPORTED",
          "This Qoder ACP build does not advertise session/load; it cannot resume a persisted session.",
        );
      }
      this.sessionId = this.resumeSessionId;
      await this.seedModelsFromHandle();
      this.loadingSession = true;
      try {
        const loaded = await this.request("session/load", {
          sessionId: this.sessionId,
          cwd: this.cwd,
          mcpServers: [],
        });
        this.captureSessionConfig(loaded);
      } catch (error) {
        throw this.withLoginHint(error, "session/load");
      } finally {
        this.loadingSession = false;
      }
      await this.applySessionOptions();
      await this.writeSessionHandle(this.sessionId);
      this.emitSessionInit("resumed");
      return;
    }

    let created: unknown;
    try {
      created = await this.request("session/new", {
        cwd: this.cwd,
        mcpServers: [],
      });
    } catch (error) {
      throw this.withLoginHint(error, "session/new");
    }
    const record = created && typeof created === "object"
      ? (created as Record<string, unknown>)
      : {};
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
    if (!sessionId) {
      throw new SupervisorError(
        "HARNESS_ERROR",
        "Qoder ACP did not return a session id from session/new",
      );
    }
    this.sessionId = sessionId;
    this.captureSessionConfig(created);
    await this.applySessionOptions();
    await this.writeSessionHandle(sessionId);
    this.emitSessionInit("new");
  }

  private emitSessionInit(kind: "new" | "resumed"): void {
    this.emit({
      type: "progress",
      kind: "session_init",
      detail: safeText(
        `qoder-cli ${this.agentVersion ?? "unknown"} (acp, ${kind}, mode=${this.permissionMode ?? "default"})`,
        500,
      ),
    });
  }

  private withLoginHint(error: unknown, method: string): Error {
    const message = errorMessage(error);
    if (!/not logged in|login|authenticat/i.test(message)) {
      return error instanceof Error ? error : new Error(message);
    }
    return new SupervisorError(
      "HARNESS_ERROR",
      `${message} (run \`qodercli login\` with the same OS user, then retry the worker)`,
      { method },
    );
  }

  private async applySessionOptions(): Promise<void> {
    await this.applyPermissionMode();
    await this.applyModel();
    await this.applyThinking();
  }

  private async applyPermissionMode(): Promise<void> {
    if (!this.permissionMode || !this.sessionId) return;
    const target = ACP_MODE_BY_PERMISSION[this.permissionMode];
    if (!target) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Qoder ACP has no equivalent for permission mode "${this.permissionMode}"; use bypass_permissions, accept_edits, auto, dont_ask or default`,
        { permissionMode: this.permissionMode },
      );
    }
    if (this.availableModes.size > 0 && !this.availableModes.has(target)) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Qoder ACP does not offer mode "${target}" for permission mode "${this.permissionMode}". Available: ${[...this.availableModes.keys()].join(", ")}`,
        { permissionMode: this.permissionMode, availableModes: [...this.availableModes.keys()] },
      );
    }
    await this.applyConfigValue("mode", target, "permission mode");
  }

  private async applyModel(): Promise<void> {
    if (!this.modelId || !this.sessionId) return;
    const model = this.resolveModel(this.modelId);
    if (!model) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Qoder ACP does not offer model "${this.modelId}". Available: ${this.availableModels.map((item) => item.name ?? item.modelId).join(", ") || "unknown"}`,
        { model: this.modelId },
      );
    }
    await this.applyConfigValue("model", model.modelId, "model");
  }

  private resolveModel(value: string): { modelId: string; name?: string } | null {
    if (this.availableModels.length === 0) {
      // A loaded session may not repeat the model catalog. The value is then
      // assumed to be the native model id and the agent validates it.
      return { modelId: value };
    }
    const lowered = value.toLowerCase();
    return (
      this.availableModels.find((item) => item.modelId === value) ??
      this.availableModels.find((item) => item.modelId.toLowerCase() === lowered) ??
      this.availableModels.find((item) => item.name?.toLowerCase() === lowered) ??
      null
    );
  }

  private async applyThinking(): Promise<void> {
    if (!this.thinking || !this.sessionId) return;
    const target = REASONING_EFFORT_BY_THINKING[this.thinking];
    if (!target) {
      throw new SupervisorError(
        "BAD_REQUEST",
        `Unsupported thinking level "${this.thinking}" for Qoder ACP`,
        { thinking: this.thinking },
      );
    }
    const option = this.configOptions.get("reasoning_effort");
    if (option && option.options && !option.options.some((item) => item.value === target)) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Qoder ACP does not offer reasoning_effort "${target}". Available: ${option.options.map((item) => item.value).join(", ")}`,
        { thinking: this.thinking },
      );
    }
    await this.applyConfigValue("reasoning_effort", target, "thinking level");
  }

  private async applyConfigValue(
    configId: string,
    value: string,
    label: string,
  ): Promise<void> {
    if (!this.sessionId) return;
    let result: unknown;
    try {
      result = await this.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId,
        value,
      });
    } catch (error) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Could not set the Qoder ACP ${label} to "${value}": ${errorMessage(error)}`,
        { configId, value },
      );
    }
    this.captureSessionConfig(result);
    const current = this.configOptions.get(configId)?.currentValue;
    if (current !== undefined && String(current) !== value) {
      throw new SupervisorError(
        "UNSUPPORTED",
        `Qoder ACP accepted ${label}="${value}" but reports "${String(current)}"`,
        { configId, requested: value, actual: current },
      );
    }
  }

  private captureSessionConfig(source: unknown): void {
    if (!source || typeof source !== "object") return;
    const record = source as Record<string, unknown>;
    const configs = record.configOptions;
    if (Array.isArray(configs)) {
      this.configOptions.clear();
      for (const raw of configs) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id : "";
        if (!id) continue;
        const options = Array.isArray(item.options)
          ? item.options.flatMap((option) => {
              if (!option || typeof option !== "object") return [];
              const entry = option as Record<string, unknown>;
              if (typeof entry.value !== "string") return [];
              return [{
                value: entry.value,
                ...(typeof entry.name === "string" ? { name: entry.name } : {}),
              }];
            })
          : undefined;
        this.configOptions.set(id, {
          currentValue: item.currentValue,
          ...(options ? { options } : {}),
        });
      }
    }
    const modes = record.modes;
    if (modes && typeof modes === "object") {
      const available = (modes as Record<string, unknown>).availableModes;
      if (Array.isArray(available)) {
        this.availableModes = new Map(
          available.flatMap((raw) => {
            if (!raw || typeof raw !== "object") return [];
            const mode = raw as Record<string, unknown>;
            if (typeof mode.id !== "string") return [];
            return [[mode.id, typeof mode.name === "string" ? mode.name : mode.id] as const];
          }),
        );
      }
    }
    const models = record.models;
    if (models && typeof models === "object") {
      const available = (models as Record<string, unknown>).availableModels;
      if (Array.isArray(available)) {
        this.availableModels = available.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const model = raw as Record<string, unknown>;
          if (typeof model.modelId !== "string") return [];
          return [{
            modelId: model.modelId,
            ...(typeof model.name === "string" ? { name: model.name } : {}),
          }];
        });
      }
    }
  }

  private async sendPrompt(message: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      // ACP keeps this request open for the entire native turn, including
      // permission and elicitation waits. Only control RPCs use the short
      // request deadline; cancellation, process exit and maxDuration bound the run.
      const result = (await this.request(
        "session/prompt",
        {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: message }],
        },
        0,
      )) as Record<string, unknown> | undefined;
      const stopReason = typeof result?.stopReason === "string" ? result.stopReason : undefined;
      this.promptActive = false;
      const usage = usageFromPromptResult(result);
      if (usage) this.emit({ type: "usage", usage });
      if (stopReason === "cancelled" || this.abortRequested) {
        this.emitSettled(true, undefined, stopReason);
        return;
      }
      if (stopReason && stopReason !== "end_turn") {
        const error = safeText(`Qoder ACP turn ended with stopReason=${stopReason}`, 2000);
        this.emit({ type: "run_error", message: error, fatal: true });
        this.emitSettled(false, undefined, stopReason, error);
        return;
      }
      this.emit({ type: "progress", kind: "turn_complete" });
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
        this.diagnostic(`Invalid JSON from qodercli --acp: ${line.slice(0, 300)}`);
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    if (method) {
      if (method === "session/update") {
        this.handleSessionUpdate(message.params);
        return;
      }
      if (method === "session/request_permission") {
        void this.handlePermissionRequest(message);
        return;
      }
      if (method === "elicitation/create") {
        void this.handleElicitationRequest(message);
        return;
      }
      if (method === "fs/read_text_file") {
        void this.handleReadTextFile(message);
        return;
      }
      if (method === "$/cancel_request") {
        this.handleAgentCancelRequest(message.params);
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
                `Qoder ACP ${pending.method} failed: ${error?.message ?? "unknown error"}`,
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

  private handleAgentCancelRequest(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const obj = params as Record<string, unknown>;
    const raw = obj.requestId;
    if (raw === undefined || raw === null) return;
    const key = String(raw);
    for (const requestId of [`permission:${key}`, `elicitation:${key}`]) {
      const pending = this.pendingInputs.get(requestId);
      if (!pending) continue;
      this.pendingInputs.delete(requestId);
      clearTimeout(pending.timer);
      this.emit({
        type: "progress",
        // The supervisor clears pendingInput only when `detail` equals the
        // requestId it stored, which is the prefixed key, not the raw RPC id.
        kind: pending.kind === "permission" ? "permission_withdrawn" : "input_withdrawn",
        detail: requestId,
        ...(pending.kind === "permission" ? { tool: pending.toolName } : {}),
      });
      return;
    }
  }

  private handleSessionUpdate(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const obj = params as Record<string, unknown>;
    const update = obj.update;
    if (!update || typeof update !== "object") return;
    const record = update as Record<string, unknown>;
    const kind = typeof record.sessionUpdate === "string" ? record.sessionUpdate : "";
    if (this.loadingSession) {
      // session/load replays history. That is not progress for the new run, so
      // it is kept out of events and out of the final answer.
      return;
    }

    if (kind === "agent_message_chunk" || kind === "agent_message") {
      const content = record.content as { type?: string; text?: string } | undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      if (text) {
        const messageId = typeof record.messageId === "string" && record.messageId
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
        if (current) {
          this.assistantText = kind === "agent_message" ? text : this.assistantText + text;
        }
        this.emit({ type: "progress", kind: "assistant_message", preview: safeText(text, 4000) });
      }
      return;
    }
    if (kind === "agent_thought_chunk") {
      const content = record.content as { type?: string; text?: string } | undefined;
      const text = typeof content?.text === "string" ? content.text : "";
      if (text) {
        this.emit({ type: "progress", kind: "thinking", preview: safeText(text, 4000) });
      }
      return;
    }
    if (kind === "tool_call") {
      // Text before native tool execution is commentary, not a final reply.
      this.assistantText = "";
      this.assistantMessageId = undefined;
      const name =
        (typeof record.name === "string" && record.name) ||
        (typeof record.toolName === "string" && record.toolName) ||
        (typeof record.kind === "string" && record.kind) ||
        "tool";
      this.lastToolName = name;
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
      if (toolCallId) this.toolNames.set(toolCallId, name);
      this.emit({
        type: "progress",
        kind: "tool_start",
        tool: name,
        detail: safeText(String(record.title ?? ""), 2000),
      });
      return;
    }
    if (kind === "tool_call_update") {
      const status = typeof record.status === "string" ? record.status : "";
      if (status === "completed" || status === "failed") {
        const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
        const tool = (toolCallId ? this.toolNames.get(toolCallId) : undefined) ??
          this.lastToolName ??
          "unknown";
        if (toolCallId) this.toolNames.delete(toolCallId);
        this.emit({
          type: "progress",
          kind: "tool_end",
          tool,
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
      const modeId = typeof record.currentModeId === "string" ? record.currentModeId : "";
      this.emit({
        type: "progress",
        kind: "mode_update",
        ...(modeId ? { detail: modeId } : {}),
      });
      return;
    }
    if (kind === "config_option_update") {
      this.captureSessionConfig(record);
    }
  }

  private async handlePermissionRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (id === undefined || id === null) return;
    const rpcId = typeof id === "number" ? id : String(id);
    const requestId = `permission:${String(id)}`;
    const params = message.params;
    const obj = params && typeof params === "object" ? (params as Record<string, unknown>) : {};

    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: PermissionOption[] = [];
    for (const raw of rawOptions) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const optionId = typeof item.optionId === "string" ? item.optionId : "";
      if (!optionId) continue;
      const kind = typeof item.kind === "string" ? item.kind : "";
      const name =
        typeof item.name === "string" && item.name.length > 0
          ? item.name
          : (PERMISSION_OPTION_LABELS[kind] ?? optionId);
      options.push({ optionId, name, kind });
    }

    if (options.length === 0) {
      await this.write({
        jsonrpc: "2.0",
        id: rpcId,
        result: { outcome: { outcome: "cancelled" } },
      }).catch(() => undefined);
      this.emit({
        type: "run_error",
        message: "Qoder ACP permission request offered no selectable option",
        fatal: false,
      });
      return;
    }

    const toolCall = obj.toolCall as Record<string, unknown> | undefined;
    const toolTitle = typeof toolCall?.title === "string" ? toolCall.title : "";
    const toolName =
      toolTitle ||
      (typeof toolCall?.rawInput === "object" && toolCall.rawInput !== null
        ? String((toolCall.rawInput as Record<string, unknown>).command ?? "tool")
        : "tool");
    const title = typeof obj.title === "string" ? obj.title : `Allow ${toolName}?`;
    const messageText = [
      title,
      typeof obj.message === "string" ? obj.message : undefined,
      toolCall?.rawInput !== undefined ? `Input: ${JSON.stringify(toolCall.rawInput)}` : undefined,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");

    const pending: PendingPermission = {
      kind: "permission",
      requestId,
      rpcId,
      toolName,
      title,
      message: messageText,
      options,
      timer: setTimeout(() => undefined, 0),
    };
    const timeoutMs = resolveRuntimeInputTimeoutMs({
      specificEnv: QODER_INPUT_TIMEOUT_ENV,
      defaultMs: DEFAULT_PERMISSION_TIMEOUT_MS,
    });

    if (this.abortRequested) {
      await this.respondPermission(pending, "cancelled").catch(() => undefined);
      return;
    }

    pending.timer = setTimeout(() => {
      this.pendingInputs.delete(requestId);
      void this.respondPermission(pending, "cancelled").catch(() => undefined);
      this.emit({
        type: "run_error",
        message: "Qoder ACP permission request timed out without an answer",
        fatal: false,
      });
    }, timeoutMs);
    pending.timer.unref?.();
    this.pendingInputs.set(requestId, pending);

    this.emit({
      type: "needs_input",
      requestId,
      method: "select",
      title: safeText(title, 300),
      // The native rawInput is the only source of truth for an approval
      // decision, so it is included under a bound. A truncated payload is
      // explicitly marked by safeText; callers must not approve from a prefix.
      message: safeText(messageText, PERMISSION_MESSAGE_MAX_CHARS),
      options: options.map((option) => optionLabel(option)),
      timeoutMs,
    });
  }

  private async answerPermission(
    pending: PendingPermission,
    response: ExtensionUiResponse,
  ): Promise<void> {
    if ("cancelled" in response) {
      await this.respondPermission(pending, "cancelled");
      return;
    }

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
      allow = /^(allow|yes|true|approve|accept|允许|同意)/i.test(lowered);
    }

    if (allow) {
      const target = allowOption ?? pending.options[0];
      if (!target) {
        throw new SupervisorError("BAD_REQUEST", "Permission request has no selectable option");
      }
      await this.respondPermission(pending, target.optionId);
      return;
    }
    const target = denyOption ?? pending.options[pending.options.length - 1];
    if (!target) {
      throw new SupervisorError("BAD_REQUEST", "Permission request has no selectable option");
    }
    await this.respondPermission(pending, target.optionId);
  }

  private async respondPermission(
    pending: PendingPermission,
    outcome: string,
  ): Promise<void> {
    const result =
      outcome === "cancelled"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: outcome } };
    await this.write({ jsonrpc: "2.0", id: pending.rpcId, result });
  }

  private async handleElicitationRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (id === undefined || id === null) return;
    const rpcId = typeof id === "number" ? id : String(id);
    const requestId = `elicitation:${String(id)}`;
    const params = message.params;
    const obj = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const mode = typeof obj.mode === "string" ? obj.mode : "form";

    const pending: PendingElicitation = {
      kind: "elicitation",
      requestId,
      rpcId,
      title: typeof obj.message === "string" ? obj.message : "Qoder question",
      timer: setTimeout(() => undefined, 0),
    };

    if (mode !== "form") {
      await this.respondElicitation(pending, { action: "decline" }).catch(() => undefined);
      this.emit({
        type: "run_error",
        message: `Qoder ACP requested a "${mode}" elicitation; this client only supports form questions`,
        fatal: false,
      });
      return;
    }

    const schema = obj.requestedSchema;
    const schemaRecord =
      schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
    const rawProperties = schemaRecord.properties;
    const required = new Set(
      Array.isArray(schemaRecord.required)
        ? schemaRecord.required.filter((item): item is string => typeof item === "string")
        : [],
    );
    const fields: ElicitationField[] = [];
    if (rawProperties && typeof rawProperties === "object") {
      for (const [key, raw] of Object.entries(rawProperties as Record<string, unknown>)) {
        const field = parseElicitationField(key, raw, required.has(key));
        if (field) fields.push(field);
      }
    }
    if (fields.length === 0) {
      await this.respondElicitation(pending, { action: "decline" }).catch(() => undefined);
      this.emit({
        type: "run_error",
        message: "Qoder ACP sent an elicitation without any answerable fields",
        fatal: false,
      });
      return;
    }

    const timeoutMs = resolveRuntimeInputTimeoutMs({
      specificEnv: QODER_INPUT_TIMEOUT_ENV,
      defaultMs: DEFAULT_PERMISSION_TIMEOUT_MS,
    });

    if (this.abortRequested) {
      await this.respondElicitation(pending, { action: "cancel" }).catch(() => undefined);
      return;
    }

    pending.timer = setTimeout(() => {
      this.pendingInputs.delete(requestId);
      void this.respondElicitation(pending, { action: "cancel" }).catch(() => undefined);
      this.emit({
        type: "run_error",
        message: "Qoder ACP question timed out without an answer",
        fatal: false,
      });
    }, timeoutMs);
    pending.timer.unref?.();
    this.pendingInputs.set(requestId, pending);

    if (fields.length === 1) {
      const field = fields[0] as ElicitationField;
      pending.field = field;
      if (field.options && field.options.length > 0) {
        this.emit({
          type: "needs_input",
          requestId,
          method: "select",
          title: safeText(field.title, 300),
          message: safeText(field.description ?? pending.title, ELICITATION_MESSAGE_MAX_CHARS),
          options: field.options.map((option) => option.label),
          timeoutMs,
        });
        return;
      }
      if (field.type === "boolean") {
        this.emit({
          type: "needs_input",
          requestId,
          method: "confirm",
          title: safeText(field.title, 300),
          message: safeText(field.description ?? pending.title, ELICITATION_MESSAGE_MAX_CHARS),
          timeoutMs,
        });
        return;
      }
      this.emit({
        type: "needs_input",
        requestId,
        method: "input",
        title: safeText(field.title, 300),
        message: safeText(field.description ?? pending.title, ELICITATION_MESSAGE_MAX_CHARS),
        timeoutMs,
      });
      return;
    }

    pending.fields = fields;
    const summary = fields.map((field) => ({
      key: field.key,
      title: field.title,
      ...(field.description ? { description: field.description } : {}),
      type: field.type,
      ...(field.options ? { options: field.options.map((option) => option.label) } : {}),
      required: field.required,
    }));
    this.emit({
      type: "needs_input",
      requestId,
      method: "input",
      title: safeText(pending.title, 300),
      message: safeText(
        `${pending.title}\nAnswer with a JSON object keyed by property:\n${JSON.stringify(summary, null, 2)}`,
        ELICITATION_MESSAGE_MAX_CHARS,
      ),
      placeholder: `{"${fields[0]?.key ?? "answer"}": "..."}`,
      timeoutMs,
    });
  }

  private async answerElicitation(
    pending: PendingElicitation,
    response: ExtensionUiResponse,
  ): Promise<void> {
    if ("cancelled" in response) {
      await this.respondElicitation(pending, { action: "cancel" });
      return;
    }

    if (pending.fields) {
      const value = "value" in response ? response.value : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new SupervisorError(
          "BAD_REQUEST",
          "This Qoder question asks multiple fields; the answer must be a JSON object of property -> value.",
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SupervisorError(
          "BAD_REQUEST",
          "Answer must be a JSON object of property -> value",
        );
      }
      const content: Record<string, unknown> = {};
      for (const field of pending.fields) {
        const raw = (parsed as Record<string, unknown>)[field.key];
        if (raw === undefined) {
          if (field.required) {
            throw new SupervisorError("BAD_REQUEST", `Missing answer for required field "${field.key}"`);
          }
          continue;
        }
        content[field.key] = this.coerceElicitationValue(field, raw);
      }
      await this.respondElicitation(pending, { action: "accept", content });
      return;
    }

    const field = pending.field;
    if (!field) {
      throw new SupervisorError("INVALID_STATE", "Qoder question has no field to answer");
    }
    const content: Record<string, unknown> = {};
    if ("confirmed" in response) {
      content[field.key] = response.confirmed;
    } else if ("value" in response) {
      content[field.key] = this.coerceElicitationValue(field, response.value);
    } else {
      throw new SupervisorError("BAD_REQUEST", "Answer must contain a value");
    }
    await this.respondElicitation(pending, { action: "accept", content });
  }

  private coerceElicitationValue(field: ElicitationField, raw: unknown): unknown {
    if (field.options && field.options.length > 0) {
      const text = String(raw).trim().toLowerCase();
      const match = field.options.find(
        (option) =>
          option.label.toLowerCase() === text ||
          String(option.value).toLowerCase() === text,
      );
      if (!match) {
        throw new SupervisorError(
          "BAD_REQUEST",
          `"${String(raw)}" is not one of the offered answers for "${field.title}"`,
          { field: field.key, options: field.options.map((option) => option.label) },
        );
      }
      return match.value;
    }
    if (field.type === "boolean") {
      if (typeof raw === "boolean") return raw;
      const text = String(raw).trim().toLowerCase();
      if (text === "true" || text === "yes" || text === "1") return true;
      if (text === "false" || text === "no" || text === "0") return false;
      throw new SupervisorError("BAD_REQUEST", `"${String(raw)}" is not a boolean`);
    }
    if (field.type === "number" || field.type === "integer") {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new SupervisorError("BAD_REQUEST", `"${String(raw)}" is not a number`);
      }
      return field.type === "integer" ? Math.trunc(value) : value;
    }
    if (typeof raw === "string") return raw;
    return String(raw);
  }

  private async respondElicitation(
    pending: PendingElicitation,
    result:
      | { action: "accept"; content: Record<string, unknown> }
      | { action: "decline" }
      | { action: "cancel" },
  ): Promise<void> {
    await this.write({ jsonrpc: "2.0", id: pending.rpcId, result });
  }

  private async handleReadTextFile(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (id === undefined || id === null) return;
    const params = message.params;
    const obj = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const requestedPath = typeof obj.path === "string" ? obj.path : "";
    const file = requestedPath
      ? path.isAbsolute(requestedPath)
        ? requestedPath
        : path.resolve(this.cwd, requestedPath)
      : "";
    const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : "";
    const reject = (code: number, text: string): void => {
      void this.write({ jsonrpc: "2.0", id, error: { code, message: text } }).catch(
        () => undefined,
      );
    };
    if (!file) {
      reject(-32602, "fs/read_text_file requires a path");
      return;
    }
    if (sessionId && this.sessionId && sessionId !== this.sessionId) {
      reject(-32602, "fs/read_text_file sessionId does not match this session");
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        reject(-32602, `Not a regular file: ${file}`);
        return;
      }
      if (info.size > MAX_FS_READ_BYTES) {
        reject(-32603, `File is larger than the ${MAX_FS_READ_BYTES}-byte client read limit: ${file}`);
        return;
      }
      let content = await readFile(file, "utf8");
      const line = numberValue(obj.line);
      const limit = numberValue(obj.limit);
      if (line !== undefined || limit !== undefined) {
        const lines = content.split(/\r?\n/);
        const start = line !== undefined ? Math.max(0, Math.trunc(line) - 1) : 0;
        const end = limit !== undefined ? start + Math.max(0, Math.trunc(limit)) : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      await this.write({ jsonrpc: "2.0", id, result: { content } });
    } catch (error) {
      reject(-32603, `Failed to read ${file}: ${errorMessage(error)}`);
    }
  }

  /**
   * Request ids are strings on purpose. The agent's reverse requests use their
   * own numeric id space, so a string prefix keeps our pending requests from
   * being mistaken for an answer to one of them.
   */
  private nextId(): string {
    return `hs-${++this.requestCounter}`;
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    this.rejectPending(
      new SupervisorError(
        "HARNESS_ERROR",
        `Qoder ACP process exited (code=${code}, signal=${signal})`,
        { code, signal },
      ),
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
    for (const input of this.pendingInputs.values()) {
      clearTimeout(input.timer);
    }
    this.pendingInputs.clear();
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.isAlive()) {
      return Promise.reject(
        new SupervisorError("HARNESS_ERROR", "Qoder ACP process is not running", {
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
                `Qoder ACP request timed out after ${limit}ms: ${method}`,
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

  private async notify(method: string, params: unknown): Promise<void> {
    if (!this.isAlive()) return;
    await this.write({ jsonrpc: "2.0", method, params });
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    if (!this.isAlive()) {
      throw new SupervisorError(
        "HARNESS_ERROR",
        "Cannot write to Qoder ACP: process is not running",
      );
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(
            new SupervisorError(
              "HARNESS_ERROR",
              `Failed to write to Qoder ACP stdin: ${error.message}`,
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
    const line = `${new Date().toISOString()} [qoder-acp] ${message}\n`;
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

/**
 * Reads the ACP session id out of the handle written by this transport. The
 * first line must carry `{ "type": "session", "protocol": "acp", "id": ... }`;
 * a stream-json session file never matches because it has no protocol marker.
 */
export async function readQoderAcpSessionHandle(handleFile: string): Promise<string | null> {
  try {
    const raw = await readFile(handleFile, "utf8");
    const firstLine = raw.split("\n", 1)[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as {
      type?: unknown;
      protocol?: unknown;
      id?: unknown;
    };
    if (parsed.type !== "session" || parsed.protocol !== "acp") return null;
    return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : null;
  } catch {
    return null;
  }
}
