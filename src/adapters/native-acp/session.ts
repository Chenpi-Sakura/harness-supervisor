import path from "node:path";
import { SupervisorError, errorMessage } from "../../errors.js";
import type { ExtensionUiResponse, HarnessCallbacks, HarnessEvent, HarnessExit, HarnessRuntimeInfo, HarnessSession, HarnessSpawnSpec } from "../../types.js";
import { atomicWriteJson } from "../../util/fsx.js";
import { safeText } from "../../util/redact.js";
import { DEFAULT_INPUT_TIMEOUT_MS, resolveRuntimeInputTimeoutMs } from "../../input-timeout.js";
import { AcpClient } from "../acp/client.js";
import type { NativeAcpLaunch, NativeAcpRuntime } from "./launch.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const array = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
interface Permission { id: string | number; options: Obj[]; timer: NodeJS.Timeout }
export interface NativeAcpSessionOptions {
  runtime: NativeAcpRuntime; launch: NativeAcpLaunch; spec: HarnessSpawnSpec; callbacks: HarnessCallbacks;
  resumeSessionId?: string; abortTimeoutMs?: number; onStderr?: (text: string) => void;
}

/** Standard ACP v1 only. Runtime extensions are deliberately not guessed. */
export class NativeAcpSession implements HarnessSession {
  readonly pid: number | undefined;
  private sessionId = "";
  private sessionFile: string | undefined;
  private runtimeInfo: HarnessRuntimeInfo = {};
  private active = false;
  private abortRequested = false;
  private assistantText = "";
  private messageId: string | undefined;
  private seenMessages = new Set<string>();
  private turn: Promise<void> | undefined;
  private permissions = new Map<string, Permission>();
  private constructor(private client: AcpClient, private options: NativeAcpSessionOptions) { this.pid = client.pid; }
  static async start(options: NativeAcpSessionOptions): Promise<NativeAcpSession> {
    let session: NativeAcpSession | undefined;
    const client = await AcpClient.start({
      launch: { ...options.launch, cwd: options.spec.cwd }, runtimeLabel: options.runtime, diagnosticTag: `${options.runtime}-acp`, onStderr: options.onStderr,
      handlers: { onUpdate: value => session?.update(value), onRequest: (method, params, id) => session?.request(method, params, id) ?? false,
        onExit: exit => session?.exit(exit) },
    });
    session = new NativeAcpSession(client, options);
    try { await session.initialize(); return session; }
    catch (error) { await client.forceKill(); throw error; }
  }
  private emit(event: HarnessEvent) { this.options.callbacks.onEvent(event); }
  private async initialize() {
    const init = object(await this.client.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "harness-supervisor", version: "1" } }, 30_000));
    if (init.protocolVersion !== 1) throw new SupervisorError("UNSUPPORTED", "This adapter requires ACP v1");
    const { spec, resumeSessionId } = this.options;
    if (resumeSessionId && object(init.agentCapabilities).loadSession !== true) throw new SupervisorError("UNSUPPORTED", "The installed ACP adapter does not advertise session/load; refusing a fake resume");
    this.sessionId = resumeSessionId || "";
    const response = object(await this.client.request(resumeSessionId ? "session/load" : "session/new", {
      cwd: spec.cwd, mcpServers: [], ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
    }, 90_000));
    if (!resumeSessionId) this.sessionId = typeof response.sessionId === "string" ? response.sessionId : "";
    if (!this.sessionId) throw new SupervisorError("HARNESS_ERROR", "ACP returned no session id");
    let config = array(response.configOptions);
    const applyOption = async (kind: string, requested: string | undefined) => {
      if (requested === undefined) return;
      const option = config.find(item => item.id === kind || item.category === kind || (kind === "thought_level" && ["reasoning_effort", "thinking", "effort"].includes(String(item.id))));
      const choices: Obj[] = [];
      const walk = (items: Obj[]) => { for (const item of items) { if (typeof item.value === "string") choices.push(item); walk(array(item.options)); } };
      walk(array(option?.options));
      const matches = choices.filter(item => item.value === requested || item.name === requested);
      if (!option || matches.length !== 1 || typeof option.id !== "string") throw new SupervisorError("UNSUPPORTED", `ACP does not offer an unambiguous ${kind}=${requested}; available: ${choices.map(item => item.value).join(", ")}`);
      const value = matches[0]!.value;
      const result = object(await this.client.request("session/set_config_option", { sessionId: this.sessionId, configId: option.id, value }, 30_000));
      config = array(result.configOptions);
      if (config.find(item => item.id === option.id)?.currentValue !== value) throw new SupervisorError("HARNESS_ERROR", `ACP did not confirm ${kind}=${requested}`);
    };
    await applyOption("model", spec.model);
    await applyOption("thought_level", spec.thinking);
    const model = config.find(item => item.category === "model" || item.id === "model");
    const choices: Obj[] = [];
    const walk = (items: Obj[]) => { for (const item of items) { if (typeof item.value === "string") choices.push(item); walk(array(item.options)); } };
    walk(array(model?.options));
    const choice = choices.find(item => item.value === model?.currentValue);
    const effort = config.find(item => item.category === "thought_level" || ["reasoning_effort", "thinking", "effort"].includes(String(item.id)));
    const text = (value: unknown) => typeof value === "string" && value.trim() ? safeText(value, 200) : undefined;
    const agent = object(init.agentInfo);
    this.runtimeInfo = {
      modelId: text(model?.currentValue),
      // Default aliases remain explicit: a description is a native report, not an inferred backend ID.
      modelName: text(choice?.description) && model?.currentValue === "default"
        ? text(`${choice?.description} (${choice?.name ?? "default"})`) : text(choice?.name),
      reasoningEffort: text(effort?.currentValue),
      adapter: text([text(agent.name), text(agent.version)].filter(Boolean).join(" ")),
    };
    this.sessionFile = path.join(spec.sessionDir, `${this.options.runtime}-acp-session.json`);
    await atomicWriteJson(this.sessionFile, { runtime: this.options.runtime, protocol: "acp", id: this.sessionId, cwd: spec.cwd });
  }
  async getState() { return { sessionId: this.sessionId, sessionFile: this.sessionFile, runtimeInfo: { ...this.runtimeInfo } }; }
  isAlive() { return this.client.isAlive(); }
  stderrTail() { return this.client.stderrTail(); }
  async prompt(message: string) {
    if (this.active || !this.isAlive()) throw new SupervisorError("INVALID_STATE", "ACP session is busy or no longer alive");
    this.active = true; this.abortRequested = false; this.assistantText = ""; this.messageId = undefined; this.seenMessages.clear();
    this.emit({ type: "run_started" });
    this.turn = this.runPrompt(message);
    return { disposition: "started" };
  }
  private async runPrompt(message: string) {
    let stopReason: string | undefined, error: string | undefined;
    try {
      const response = object(await this.client.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: message }] }, 0));
      stopReason = typeof response.stopReason === "string" ? response.stopReason : undefined;
      if (stopReason !== "end_turn" && stopReason !== "cancelled") error = `ACP returned an unsuccessful stopReason: ${stopReason ?? "missing"}`;
    } catch (cause) { error = safeText(errorMessage(cause), 2000); }
    this.active = false;
    this.clearPermissions();
    const aborted = this.abortRequested || stopReason === "cancelled";
    if (error && !aborted) this.emit({ type: "run_error", message: error, fatal: true });
    this.emit({ type: "settled", aborted, finalText: aborted || error ? undefined : this.assistantText, error: aborted ? undefined : error, stopReason });
  }
  async steer(): Promise<void> { throw new SupervisorError("UNSUPPORTED", "Active-turn steering extensions are not enabled; continue after the current turn"); }
  async followUp(): Promise<void> { throw new SupervisorError("UNSUPPORTED", "ACP prompt queueing is not enabled"); }
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() {
    this.abortRequested = true; this.clearPermissions();
    if (this.active) {
      await this.client.notify("session/cancel", { sessionId: this.sessionId });
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([this.turn, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.abortTimeoutMs ?? 5000); })]); }
      finally { clearTimeout(timer); }
    }
  }
  async close(options?: { graceMs?: number }) { this.clearPermissions(); return this.client.close(options); }
  async forceKill() { this.clearPermissions(); await this.client.forceKill(); }
  private update(value: unknown) {
    const params = object(value);
    if (!this.active || params.sessionId !== this.sessionId) return;
    const update = object(params.update), kind = update.sessionUpdate;
    const text = object(update.content).type === "text" ? object(update.content).text : undefined;
    if (typeof text === "string" && (kind === "agent_message_chunk" || kind === "agent_thought_chunk")) {
      if (kind === "agent_message_chunk") {
        const id = typeof update.messageId === "string" ? update.messageId : undefined;
        if (id && id !== this.messageId) { if (this.seenMessages.has(id)) return; this.seenMessages.add(id); this.messageId = id; this.assistantText = ""; }
        this.assistantText += text;
      }
      this.emit({ type: "progress", kind: kind === "agent_message_chunk" ? "assistant_message" : "thinking", preview: safeText(text, 8000) });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      this.emit({ type: "progress", kind: kind === "tool_call" ? "tool_start" : "tool_end", tool: typeof update.title === "string" ? update.title : undefined, detail: safeText(JSON.stringify(update), 8000), isError: update.status === "failed" });
    }
  }
  private request(method: string, value: unknown, id: string | number): boolean {
    if (method !== "session/request_permission") return false;
    const params = object(value);
    if (!this.active || this.abortRequested || params.sessionId !== this.sessionId || this.permissions.size >= 16) {
      void this.client.reply(id, { outcome: { outcome: "cancelled" } }).catch(() => {}); return true;
    }
    const options = array(params.options).filter(item => typeof item.optionId === "string" && typeof item.name === "string");
    const key = String(id), timeoutMs = resolveRuntimeInputTimeoutMs({ specificEnv: `HARNESS_SUPERVISOR_${this.options.runtime.toUpperCase()}_INPUT_TIMEOUT_MS`, defaultMs: DEFAULT_INPUT_TIMEOUT_MS });
    const timer = setTimeout(() => { this.permissions.delete(key); void this.client.reply(id, { outcome: { outcome: "cancelled" } }).catch(() => {}); }, timeoutMs);
    timer.unref();
    this.permissions.set(key, { id, options, timer });
    const tool = object(params.toolCall);
    this.emit({ type: "needs_input", requestId: key, method: "select", title: safeText(typeof tool.title === "string" ? tool.title : "Approve native tool operation?", 300), message: safeText(JSON.stringify(tool), 16000), options: options.map(item => String(item.name)), timeoutMs });
    return true;
  }
  async answer(requestId: string, response: ExtensionUiResponse) {
    const pending = this.permissions.get(requestId);
    if (!pending) throw new SupervisorError("INVALID_STATE", "No active ACP permission request with that id");
    let option: Obj | undefined;
    if ("value" in response) option = pending.options.find(item => item.optionId === response.value || item.name === response.value);
    if ("confirmed" in response) option = pending.options.find(item => item.kind === (response.confirmed ? "allow_once" : "reject_once"));
    if (!("cancelled" in response) && !option) throw new SupervisorError("BAD_REQUEST", "Choose one of the permission options actually offered by the agent");
    this.permissions.delete(requestId); clearTimeout(pending.timer);
    await this.client.reply(pending.id, { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
  }
  private clearPermissions() { for (const pending of this.permissions.values()) { clearTimeout(pending.timer); void this.client.reply(pending.id, { outcome: { outcome: "cancelled" } }).catch(() => {}); } this.permissions.clear(); }
  private exit(exit: HarnessExit) { this.clearPermissions(); this.options.callbacks.onExit(exit); }
}
