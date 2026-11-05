#!/usr/bin/env node
/**
 * A fake DeepSeek Harness ACP agent for tests.
 *
 * It mirrors the wire shape observed from the desktop-bundled
 * `dsh --profile acp` (0.2.1-rc.5): standard ACP v1, session/new,
 * session/list, session/resume (not load), model and reasoning_effort config
 * options, session/update notifications, numeric reverse-request ids for
 * session/request_permission, and session/cancel as a notification.
 *
 * Scenarios are selected with FAKE_DSH_SCENARIO:
 *   basic      - thought, tool lifecycle, assistant chunks, usage_update, end_turn
 *   permission - asks for allow-once/reject-once before finishing
 *   hang       - never settles until session/cancel
 *   configfail - session/set_config_option returns a JSON-RPC error
 *   resumefail - session/resume returns a JSON-RPC error
 *   promptfail - session/prompt returns a JSON-RPC error
 *   crash      - exits while a prompt is active
 *
 * FAKE_DSH_WITHDRAW_PERMISSION=1 withdraws the permission request with
 * `$/cancel_request` instead of waiting for an answer.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PersistedSession {
  sessionId: string;
  cwd: string;
  model: string;
  reasoning: string;
  prompts: string[];
}

const scenario = process.env.FAKE_DSH_SCENARIO ?? "basic";
const cwd = process.cwd();
const stateFile = path.join(cwd, ".fake-dsh-session.json");
const withdrawPermission = process.env.FAKE_DSH_WITHDRAW_PERMISSION === "1";

let sessionId = "";
let currentModel = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);
let currentReasoning = "high";
let buffer = "";
let promptId: number | string | undefined;
let promptActive = false;
let resumed = false;
let nextReverseRequestId = 0;
let pendingPermission: { id: number | string } | null = null;
const timers: NodeJS.Timeout[] = [];

function emit(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id: number | string, result: unknown): void {
  emit({ jsonrpc: "2.0", id, result });
}

function fail(id: number | string, code: number, message: string): void {
  emit({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method: string, params: Record<string, unknown>): void {
  emit({ jsonrpc: "2.0", method, params });
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function later(ms: number, fn: () => void): void {
  const timer = setTimeout(() => {
    const index = timers.indexOf(timer);
    if (index >= 0) timers.splice(index, 1);
    fn();
  }, ms);
  timers.push(timer);
}

function configOptions(): unknown[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        {
          group: "deepseek-official",
          name: "DeepSeek",
          options: [
            {
              value: JSON.stringify(["deepseek-official", "deepseek-v4-flash"]),
              name: "deepseek-v4-flash",
            },
            {
              value: JSON.stringify(["deepseek-official", "deepseek-flash"]),
              name: "DeepSeek-V4.1-Flash",
            },
          ],
        },
        {
          group: "deepseek-account",
          name: "DeepSeek Account",
          options: [
            {
              value: JSON.stringify(["deepseek-account", "deepseek-flash"]),
              name: "DeepSeek-V4.1-Flash",
            },
          ],
        },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: currentReasoning,
      options: [
        { value: "off", name: "Off" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    },
  ];
}

function readState(): PersistedSession | null {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as PersistedSession;
  } catch {
    return null;
  }
}

function writeState(prompts: string[]): void {
  if (!sessionId) return;
  const payload: PersistedSession = {
    sessionId,
    cwd,
    model: currentModel,
    reasoning: currentReasoning,
    prompts,
  };
  writeFileSync(stateFile, `${JSON.stringify(payload)}\n`, "utf8");
}

function update(text: string, kind = "agent_message_chunk", messageId?: string): void {
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: kind,
      ...(messageId ? { messageId } : {}),
      content: { type: "text", text },
    },
  });
}

function finishPrompt(text: string, stopReason = "end_turn"): void {
  if (!promptActive || promptId === undefined) return;
  const id = promptId;
  promptActive = false;
  promptId = undefined;
  const messageId = randomUUID();
  update(text, "agent_message_chunk", messageId);
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "usage_update", used: 100, size: 1000 },
  });
  ok(id, { stopReason });
}

function cancelPrompt(): void {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  pendingPermission = null;
  if (!promptActive || promptId === undefined) return;
  const id = promptId;
  promptActive = false;
  promptId = undefined;
  ok(id, { stopReason: "cancelled" });
}

function askPermission(): void {
  if (!promptActive) return;
  const id = nextReverseRequestId++;
  pendingPermission = { id };
  emit({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "call_perm_1" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  log(`FAKE_DSH_PERMISSION_ID ${JSON.stringify({ id })}`);
  if (withdrawPermission) {
    later(500, () => {
      if (!pendingPermission) return;
      pendingPermission = null;
      notify("$/cancel_request", { requestId: String(id) });
      finishPrompt("FAKE_DSH_WITHDRAWN");
    });
  }
}

function handleClientResponse(message: JsonRpcMessage): void {
  const id = message.id;
  if (!pendingPermission || String(id) !== String(pendingPermission.id)) return;
  pendingPermission = null;
  const result = message.result as
    | { outcome?: { outcome?: string; optionId?: string } }
    | undefined;
  const outcome = result?.outcome;
  log(`FAKE_DSH_PERMISSION_ANSWER ${JSON.stringify(outcome ?? null)}`);
  if (message.error || outcome?.outcome === "cancelled") {
    finishPrompt("FAKE_DSH_PERMISSION_CANCELLED");
    return;
  }
  finishPrompt(outcome?.optionId === "allow-once" ? "FAKE_DSH_ALLOWED" : "FAKE_DSH_DENIED");
}

function handlePrompt(params: Record<string, unknown> | undefined, id: number | string): void {
  if (promptActive) {
    fail(id, -32602, "a prompt is already active for this session");
    return;
  }
  const parts = Array.isArray(params?.prompt) ? params.prompt : [];
  const text = parts
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
  const state = readState();
  const prompts = state?.sessionId === sessionId ? [...state.prompts, text] : [text];
  writeState(prompts);
  promptActive = true;
  promptId = id;
  log(`FAKE_DSH_PROMPT ${JSON.stringify({ text })}`);

  if (scenario === "promptfail") {
    promptActive = false;
    promptId = undefined;
    fail(id, -32603, "fake prompt failure");
    return;
  }
  if (scenario === "crash") {
    promptActive = false;
    promptId = undefined;
    process.exit(1);
  }
  if (scenario === "hang") return;
  if (scenario === "permission") {
    later(20, askPermission);
    return;
  }

  later(10, () => {
    update("FAKE_DSH_THOUGHT", "agent_thought_chunk", randomUUID());
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "fake-tool",
        kind: "other",
        status: "in_progress",
        rawInput: { file_path: path.join(cwd, "fake.txt") },
      },
    });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
      },
    });
    const resumePrefix = resumed ? "FAKE_DSH_RESUMED:" : "FAKE_DSH_OK:";
    const messageId = randomUUID();
    update(resumePrefix, "agent_message_chunk", messageId);
    update(text, "agent_message_chunk", messageId);
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "usage_update", used: 100, size: 1000 },
    });
    promptActive = false;
    promptId = undefined;
    emit({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  });
}

function handleMessage(message: JsonRpcMessage): void {
  const { id, method, params } = message;
  if (method === undefined) {
    if (id !== undefined && id !== null) handleClientResponse(message);
    return;
  }
  if (id === undefined || id === null) {
    if (method === "session/cancel") {
      cancelPrompt();
      return;
    }
    log(`FAKE_DSH_NOTIFICATION ${JSON.stringify({ method })}`);
    return;
  }

  log(`FAKE_DSH_CLIENT_ID ${JSON.stringify({ id })}`);
  switch (method) {
    case "initialize":
      log(
        `FAKE_DSH_ENV ${JSON.stringify({
          DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? null,
        })}`,
      );
      ok(id, {
        protocolVersion: 1,
        agentInfo: { name: "deepseek-harness-acp", version: "0.0.1-fake" },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      });
      return;
    case "session/new": {
      sessionId = `dsh_${randomUUID().replace(/-/g, "")}`;
      currentModel = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);
      currentReasoning = "high";
      writeState([]);
      ok(id, { sessionId, configOptions: configOptions() });
      return;
    }
    case "session/list": {
      const state = readState();
      ok(id, { sessions: state ? [{ sessionId: state.sessionId, cwd: state.cwd }] : [] });
      return;
    }
    case "session/resume": {
      if (scenario === "resumefail") {
        fail(id, -32602, "fake resume failure");
        return;
      }
      const state = readState();
      const requested = typeof params?.sessionId === "string" ? params.sessionId : "";
      if (!state || state.sessionId !== requested) {
        fail(id, -32602, `unknown session: ${requested}`);
        return;
      }
      if (typeof params?.cwd === "string" && path.resolve(params.cwd) !== path.resolve(state.cwd)) {
        fail(id, -32602, `session cwd does not match: ${params.cwd}`);
        return;
      }
      sessionId = state.sessionId;
      currentModel = state.model;
      currentReasoning = state.reasoning;
      resumed = true;
      log(`FAKE_DSH_RESUME ${JSON.stringify({ sessionId })}`);
      ok(id, { configOptions: configOptions() });
      return;
    }
    case "session/set_config_option": {
      if (scenario === "configfail") {
        fail(id, -32602, "fake config rejected");
        return;
      }
      const configId = typeof params?.configId === "string" ? params.configId : "";
      const value = typeof params?.value === "string" ? params.value : "";
      if (configId === "model") currentModel = value;
      else if (configId === "reasoning_effort") currentReasoning = value;
      else {
        fail(id, -32602, `unknown config option: ${configId}`);
        return;
      }
      const state = readState();
      writeState(state?.prompts ?? []);
      log(`FAKE_DSH_CONFIG ${JSON.stringify({ configId, value })}`);
      ok(id, { configOptions: configOptions() });
      return;
    }
    case "session/prompt":
      handlePrompt(params, id);
      return;
    case "session/close":
      ok(id, {});
      return;
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      log(`FAKE_DSH_INVALID_JSON ${line.slice(0, 200)}`);
      continue;
    }
    handleMessage(message);
  }
});
process.stdin.on("end", () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  process.exit(0);
});
