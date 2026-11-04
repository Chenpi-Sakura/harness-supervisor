#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface SessionState {
  sessionId: string;
  cwd: string;
  mode: string;
  model: string;
  reasoning: string;
}

interface PromptState {
  id: string | number;
  sessionId: string;
  cancelled: boolean;
  finished: boolean;
}

const argvLog = process.env.FAKE_QODER_ARGV_LOG;
if (argvLog) {
  appendFileSync(argvLog, `${JSON.stringify(process.argv.slice(2))}\n`, "utf8");
}
const configLog = process.env.FAKE_QODER_ACP_CONFIG_LOG;
const promptLog = process.env.FAKE_QODER_ACP_PROMPT_LOG;
const loadSession = process.env.FAKE_QODER_ACP_NO_LOAD !== "1";
const configRoot =
  process.env.QODERCN_CONFIG_DIR ??
  process.env.QODER_CONFIG_DIR ??
  path.join(process.cwd(), ".qoder-fake");
const sessionRoot = path.join(configRoot, "fake-acp-sessions");

const MODES = [
  { id: "default", name: "Default", description: "Prompts for approval" },
  { id: "acceptEdits", name: "Accept Edits", description: "Auto-approves edit tools" },
  { id: "auto", name: "Auto", description: "Auto-approves via the safety classifier" },
  { id: "dontAsk", name: "Don't Ask", description: "Refuses instead of prompting" },
  { id: "yolo", name: "Bypass Permissions", description: "Auto-approves all tools" },
];
const MODELS = [
  { modelId: "fake-model-a", name: "Fake Model A", description: "test model" },
  { modelId: "fake-model-b", name: "Fake Model B", description: "test model" },
];
const REASONING = [
  { value: "high", name: "High" },
  { value: "max", name: "Max" },
  { value: "low", name: "Low" },
  { value: "none", name: "None" },
];

let session: SessionState | null = null;
let nextRequestId = 0;
let activePrompt: PromptState | null = null;
const pendingReverse = new Map<
  string | number,
  { method: string; resolve: (value: unknown) => void }
>();

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function notify(method: string, params: unknown): void {
  emit({ jsonrpc: "2.0", method, params });
}

function respond(id: string | number, result: unknown): void {
  emit({ jsonrpc: "2.0", id, result });
}

function respondError(id: string | number, code: number, message: string): void {
  emit({ jsonrpc: "2.0", id, error: { code, message } });
}

function configOptions(): Array<Record<string, unknown>> {
  const current = session;
  return [
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: current?.mode ?? "yolo",
      options: MODES.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    },
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: current?.model ?? "fake-model-a",
      options: MODELS.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description,
      })),
    },
    {
      type: "select",
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      currentValue: current?.reasoning ?? "max",
      options: REASONING,
    },
  ];
}

function sessionPayload(state: SessionState): Record<string, unknown> {
  return {
    sessionId: state.sessionId,
    modes: { currentModeId: state.mode, availableModes: MODES },
    models: { currentModelId: state.model, availableModels: MODELS },
    configOptions: configOptions(),
  };
}

function promptText(params: Record<string, unknown> | undefined): string {
  const prompt = params?.prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter(
      (item): item is { type?: string; text?: string } =>
        Boolean(item) && typeof item === "object",
    )
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function chunk(text: string): void {
  notify("session/update", {
    sessionId: session?.sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

function thought(text: string): void {
  notify("session/update", {
    sessionId: session?.sessionId,
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
  });
}

function finishPrompt(prompt: PromptState, stopReason: string): void {
  if (prompt.finished) return;
  prompt.finished = true;
  if (activePrompt === prompt) activePrompt = null;
  respond(prompt.id, {
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    _meta: { quota: { token_count: { input_tokens: 0, output_tokens: 0 } } },
  });
}

function sendReverse(method: string, params: unknown): Promise<unknown> {
  const id = `fake-acp-${++nextRequestId}`;
  return new Promise((resolve) => {
    pendingReverse.set(id, { method, resolve });
    emit({ jsonrpc: "2.0", id, method, params });
  });
}

function reverseCancelResult(method: string): unknown {
  return method === "session/request_permission"
    ? { outcome: { outcome: "cancelled" } }
    : { action: "cancel" };
}

function cancelActivePrompt(): void {
  const prompt = activePrompt;
  if (!prompt || prompt.finished) return;
  prompt.cancelled = true;
  for (const [id, pending] of [...pendingReverse.entries()]) {
    pendingReverse.delete(id);
    pending.resolve(reverseCancelResult(pending.method));
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScenario(prompt: PromptState, text: string): Promise<void> {
  thought("fake thinking");
  await delay(15);
  if (prompt.cancelled) {
    finishPrompt(prompt, "cancelled");
    return;
  }

  if (text.includes("[scenario:cancel]") || text.includes("[scenario:slow]")) {
    chunk("WORKING");
    return;
  }

  if (text.includes("[scenario:withdraw-permission]")) {
    const reverseId = `fake-acp-${++nextRequestId}`;
    pendingReverse.set(reverseId, {
      method: "session/request_permission",
      resolve: () => undefined,
    });
    emit({
      jsonrpc: "2.0",
      id: reverseId,
      method: "session/request_permission",
      params: {
        sessionId: session?.sessionId,
        toolCall: {
          toolCallId: "call_withdrawn_1",
          title: "Edit withdrawn.txt",
          kind: "edit",
          status: "pending",
          rawInput: { file_path: "withdrawn.txt" },
        },
        options: [
          { optionId: "proceed_once", kind: "allow_once" },
          { optionId: "cancel", kind: "reject_once" },
        ],
      },
    });
    await delay(150);
    pendingReverse.delete(reverseId);
    emit({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: reverseId } });
    await delay(50);
    chunk("PERMISSION_WITHDRAWN");
    finishPrompt(prompt, "end_turn");
    return;
  }

  if (text.includes("[scenario:withdraw-question]")) {
    const reverseId = `fake-acp-${++nextRequestId}`;
    pendingReverse.set(reverseId, { method: "elicitation/create", resolve: () => undefined });
    emit({
      jsonrpc: "2.0",
      id: reverseId,
      method: "elicitation/create",
      params: {
        mode: "form",
        sessionId: session?.sessionId,
        toolCallId: "call_withdrawn_2",
        message: "Answer Questions",
        requestedSchema: {
          type: "object",
          properties: {
            q0: {
              type: "string",
              title: "确认",
              oneOf: [
                { const: "是", title: "是" },
                { const: "否", title: "否" },
              ],
            },
          },
          required: ["q0"],
        },
      },
    });
    await delay(150);
    pendingReverse.delete(reverseId);
    emit({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: reverseId } });
    await delay(50);
    chunk("QUESTION_WITHDRAWN");
    finishPrompt(prompt, "end_turn");
    return;
  }

  if (text.includes("[scenario:permission]")) {
    notify("session/update", {
      sessionId: session?.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_permission_1",
        title: "Edit acp-probe.txt",
        kind: "edit",
        status: "pending",
        rawInput: { file_path: "acp-probe.txt", content: "hello" },
      },
    });
    const result = (await sendReverse("session/request_permission", {
      sessionId: session?.sessionId,
      toolCall: {
        toolCallId: "call_permission_1",
        title: "Edit acp-probe.txt",
        kind: "edit",
        status: "pending",
        rawInput: { file_path: "acp-probe.txt", content: "hello" },
      },
      // Real Qoder 1.1.82 sends option ids and kinds without display names.
      options: [
        { optionId: "proceed_always", kind: "allow_always" },
        { optionId: "proceed_once", kind: "allow_once" },
        { optionId: "cancel", kind: "reject_once" },
      ],
    })) as {
      outcome?: { outcome?: string; optionId?: string };
    };
    const outcome = result?.outcome?.outcome;
    const optionId = result?.outcome?.optionId;
    const allowed = outcome === "selected" && Boolean(optionId?.startsWith("proceed"));
    notify("session/update", {
      sessionId: session?.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_permission_1",
        status: allowed ? "completed" : "failed",
      },
    });
    if (prompt.cancelled) {
      finishPrompt(prompt, "cancelled");
      return;
    }
    chunk(allowed ? `PERMISSION_ALLOWED:${optionId}` : `PERMISSION_DENIED:${optionId ?? "cancelled"}`);
    await delay(10);
    finishPrompt(prompt, "end_turn");
    return;
  }

  if (text.includes("[scenario:elicitation]")) {
    await delay(10);
    const result = (await sendReverse("elicitation/create", {
      mode: "form",
      sessionId: session?.sessionId,
      toolCallId: "call_question_1",
      message: "Answer Questions",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "确认",
            description: "是否继续？\n是: ...\n否: ...",
            oneOf: [
              { const: "是", title: "是" },
              { const: "否", title: "否" },
            ],
          },
        },
        required: ["q0"],
      },
    })) as { action?: string; content?: Record<string, unknown> };
    if (prompt.cancelled) {
      finishPrompt(prompt, "cancelled");
      return;
    }
    if (result?.action === "accept") {
      chunk(`ANSWERED:${JSON.stringify(result.content)}`);
    } else {
      chunk(`QUESTION_${String(result?.action ?? "unknown").toUpperCase()}`);
    }
    await delay(10);
    finishPrompt(prompt, "end_turn");
    return;
  }

  if (text.includes("[scenario:multi-question]")) {
    await delay(10);
    const result = (await sendReverse("elicitation/create", {
      mode: "form",
      sessionId: session?.sessionId,
      toolCallId: "call_question_2",
      message: "Answer Questions",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "颜色",
            oneOf: [
              { const: "red", title: "Red" },
              { const: "blue", title: "Blue" },
            ],
          },
          q1: { type: "string", title: "备注", description: "自由输入" },
        },
        required: ["q0", "q1"],
      },
    })) as { action?: string; content?: Record<string, unknown> };
    if (prompt.cancelled) {
      finishPrompt(prompt, "cancelled");
      return;
    }
    chunk(`MULTI_${String(result?.action ?? "unknown").toUpperCase()}:${JSON.stringify(result?.content ?? {})}`);
    await delay(10);
    finishPrompt(prompt, "end_turn");
    return;
  }

  if (text.includes("[scenario:fail]")) {
    respondError(prompt.id, -32000, "FAKE_QODER_ACP_FAILURE");
    prompt.finished = true;
    if (activePrompt === prompt) activePrompt = null;
    return;
  }

  if (text.includes("[scenario:tool]")) {
    notify("session/update", {
      sessionId: session?.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_tool_1",
        title: "Read fake.txt",
        kind: "read",
        status: "in_progress",
      },
    });
    await delay(10);
    notify("session/update", {
      sessionId: session?.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_tool_1",
        status: "completed",
      },
    });
  }

  chunk("FAKE_");
  await delay(5);
  chunk("QODER_");
  await delay(5);
  chunk("ACP_OK");
  await delay(10);
  finishPrompt(prompt, "end_turn");
}

async function persistSession(state: SessionState): Promise<void> {
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(
    path.join(sessionRoot, `${state.sessionId}.json`),
    `${JSON.stringify(state)}\n`,
    "utf8",
  );
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  const id = message.id;
  if (id === undefined) return;
  const method = message.method ?? "";
  const params = message.params ?? {};

  if (method === "initialize") {
    respond(id, {
      protocolVersion: 1,
      authMethods: [{ id: "qodercli-login", name: "Use qodercli login" }],
      agentInfo: { name: "qoder-cli", title: "Qoder CLI", version: "fake-acp-1.0.0" },
      agentCapabilities: {
        loadSession,
        sessionCapabilities: { resume: {}, list: {}, close: {} },
        promptCapabilities: { image: false },
        mcpCapabilities: { http: false, sse: false },
        _meta: { qoder: { promptQueueing: true } },
      },
    });
    return;
  }

  if (method === "session/new") {
    session = {
      sessionId: randomUUID(),
      cwd: typeof params.cwd === "string" ? params.cwd : process.cwd(),
      mode: "yolo",
      model: "fake-model-a",
      reasoning: "max",
    };
    await persistSession(session);
    respond(id, sessionPayload(session));
    return;
  }

  if (method === "session/load") {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    if (!loadSession) {
      respondError(id, -32601, "session/load is not supported by this fake build");
      return;
    }
    try {
      const raw = await readFile(path.join(sessionRoot, `${sessionId}.json`), "utf8");
      session = JSON.parse(raw) as SessionState;
      session.sessionId = sessionId;
      respond(id, null);
    } catch {
      respondError(id, -32602, `Session not found: ${sessionId}`);
    }
    return;
  }

  if (method === "session/set_config_option") {
    if (!session) {
      respondError(id, -32602, "No active session");
      return;
    }
    const configId = typeof params.configId === "string" ? params.configId : "";
    const value = typeof params.value === "string" ? params.value : "";
    if (configId === "mode") {
      if (!MODES.some((mode) => mode.id === value)) {
        respondError(id, -32602, `Invalid value for config option mode: ${value}`);
        return;
      }
      session.mode = value;
      notify("session/update", {
        sessionId: session.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: value },
      });
    } else if (configId === "model") {
      if (!MODELS.some((model) => model.modelId === value)) {
        respondError(id, -32602, `Invalid value for config option model: ${value}`);
        return;
      }
      session.model = value;
    } else if (configId === "reasoning_effort") {
      if (!REASONING.some((option) => option.value === value)) {
        respondError(id, -32602, `Invalid value for config option reasoning_effort: ${value}`);
        return;
      }
      session.reasoning = value;
    } else {
      respondError(id, -32602, `Unknown config option: ${configId}`);
      return;
    }
    if (configLog) {
      appendFileSync(configLog, `${JSON.stringify({ configId, value })}\n`, "utf8");
    }
    await persistSession(session);
    notify("session/update", {
      sessionId: session.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: configOptions() },
    });
    respond(id, { configOptions: configOptions() });
    return;
  }

  if (method === "session/prompt") {
    if (!session) {
      respondError(id, -32602, "No active session");
      return;
    }
    if (activePrompt && !activePrompt.finished) {
      respondError(id, -32600, "A prompt is already active for this session");
      return;
    }
    const text = promptText(params);
    if (promptLog) {
      appendFileSync(promptLog, `${JSON.stringify(text)}\n`, "utf8");
    }
    const prompt: PromptState = {
      id,
      sessionId: session.sessionId,
      cancelled: false,
      finished: false,
    };
    activePrompt = prompt;
    void runScenario(prompt, text).catch((error: unknown) => {
      if (!prompt.finished) {
        prompt.finished = true;
        if (activePrompt === prompt) activePrompt = null;
        respondError(id, -32603, `fake-qoder-acp scenario failed: ${String(error)}`);
      }
    });
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

function handleNotification(message: JsonRpcRequest): void {
  if (message.method === "session/cancel") {
    cancelActivePrompt();
  }
}

function handleResponse(message: JsonRpcRequest): void {
  const id = message.id;
  if (id === undefined) return;
  const pending = pendingReverse.get(id);
  if (!pending) return;
  pendingReverse.delete(id);
  pending.resolve(message.error ? { error: message.error } : message.result);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text: string) => {
  buffer += text;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      continue;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        void handleRequest(message).catch((error: unknown) => {
          if (message.id !== undefined) {
            respondError(message.id, -32603, `fake-qoder-acp request failed: ${String(error)}`);
          }
        });
      } else {
        handleNotification(message);
      }
      continue;
    }
    handleResponse(message);
  }
});
process.stdin.on("end", () => {
  setTimeout(() => process.exit(0), 20);
});
