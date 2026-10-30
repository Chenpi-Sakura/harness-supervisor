#!/usr/bin/env node
// @ts-nocheck -- scripted protocol fixture; runtime checks cover it via the production adapter.
/**
 * Scripted Pi RPC harness for deterministic adapter/supervisor tests.
 * It implements the subset of Pi's documented RPC protocol used by the supervisor.
 * Scenario tags are embedded in the prompt, e.g. "[scenario:slow]".
 */
import { randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const sessionDirArg = takeValue("--session-dir");
const sessionArg = takeValue("--session");
const noSession = argv.includes("--no-session");

function takeValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

const stepMs = Number(process.env.FAKE_PI_STEP_MS || 40);
const slowStepMs = Number(process.env.FAKE_PI_SLOW_STEP_MS || 1800);
const acceptAfter = Date.now() + Number(process.env.FAKE_PI_START_DELAY_MS || 0);

let sessionFile: string | undefined;
let sessionId: string;
let resumed = false;

if (sessionArg && existsSync(sessionArg)) {
  sessionFile = path.resolve(sessionArg);
  const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
  sessionId = header.id;
  resumed = true;
} else {
  sessionFile = noSession
    ? undefined
    : path.resolve(
        sessionArg ??
          path.join(
            sessionDirArg ?? path.join(process.cwd(), ".fake-pi-sessions"),
            `fake_${randomUUID()}.jsonl`,
          ),
      );
  sessionId = randomUUID();
}

const messages = [];
let lastEntryId = null;
let streaming = false;
let aborted = false;
let runToken = 0;
let currentScenario = "normal";
let ignoreAbort = false;
let lastAssistantText = null;
let lastUiRequest = null;
let uiResolver = null;
const steerQueue = [];
const followUpQueue = [];

if (sessionFile && existsSync(sessionFile)) {
  const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.type === "message") {
        messages.push(record.message);
        lastEntryId = record.id;
      }
    } catch {
      // Ignore malformed synthetic session lines.
    }
  }
}

function out(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function emit(record) {
  out(record);
}

function appendSession(message) {
  if (!sessionFile) return;
  try {
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    if (!existsSync(sessionFile)) {
      writeFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        })}\n`,
      );
    }
    const id = randomBytes(4).toString("hex");
    const entry = {
      type: "message",
      id,
      parentId: lastEntryId,
      timestamp: new Date().toISOString(),
      message,
    };
    writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`, { flag: "a" });
    lastEntryId = id;
    messages.push(message);
  } catch (error) {
    process.stderr.write(`fake-pi: failed to persist session: ${error}\n`);
  }
}

function assistantMessage(text, stopReason = "stop", errorMessage) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "fake",
    provider: "fake",
    model: "fake-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function scenarioFrom(prompt) {
  const match = /\[scenario:([a-z-]+)\]/i.exec(prompt);
  return (match?.[1] ?? process.env.FAKE_PI_SCENARIO ?? "normal").toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function respond(id, command, success, data, error) {
  out({
    ...(id ? { id } : {}),
    type: "response",
    command,
    success,
    ...(data !== undefined ? { data } : {}),
    ...(error ? { error } : {}),
  });
}

function finalText(scenario, prompt) {
  if (scenario === "report") {
    const requested = Number(process.env.FAKE_PI_REPORT_CHARS || 20_000);
    const size = Math.max(1_000, Math.min(Number.isFinite(requested) ? requested : 20_000, 60 * 1024));
    return `FAKE_PI_REPORT_BEGIN\n${"R".repeat(size)}\nFAKE_PI_REPORT_END`;
  }
  if (process.env.FAKE_PI_LONG_TEXT === "1") {
    // ~200 KB final answer: exercises result truncation end to end.
    return `FAKE_PI_LONG ${"x".repeat(200 * 1024)}`;
  }
  const parts = [];
  if (resumed) parts.push("RESUMED");
  if (scenario === "no-text") return "";
  parts.push("FAKE_PI_OK");
  if (steerQueue.length) parts.push(`STEERED:${steerQueue.join("|")}`);
  if (followUpQueue.length) parts.push(`FOLLOWED:${followUpQueue.join("|")}`);
  if (lastUiRequest) parts.push(`ANSWER:${lastUiRequest.answer ?? "none"}`);
  if (scenario === "tool-error") parts.push("TOOL_HAD_ERROR");
  return parts.join(" ");
}

function execReport() {
  // Runs one shell command in the worker's own environment. Used to verify the
  // PATH-level worker command guard end to end, without a model call.
  const command = process.env.FAKE_PI_EXEC;
  if (!command) return "";
  try {
    const stdout = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    return `EXEC_OK:${stdout.trim()}`;
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 1;
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8")
      : String(error?.stderr ?? "");
    return `EXEC_FAIL:${status}:${stderr.trim()}`;
  }
}

async function runPrompt(prompt) {
  const scenario = scenarioFrom(prompt);
  currentScenario = scenario;
  ignoreAbort = scenario === "stubborn" || /\[ignore-abort\]/i.test(prompt);
  const token = ++runToken;
  const step = scenario === "slow" ? slowStepMs : stepMs;
  streaming = true;
  aborted = false;
  steerQueue.length = 0;
  followUpQueue.length = 0;
  lastUiRequest = null;

  const userMessage = { role: "user", content: prompt, timestamp: Date.now() };
  appendSession(userMessage);
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: userMessage });
  emit({ type: "message_end", message: userMessage });

  emit({ type: "tool_execution_start", toolCallId: "call_fake", toolName: "bash", args: { command: "echo fake-harness" } });
  await sleep(step);
  if (token !== runToken) return;
  if (scenario === "crash") {
    process.stderr.write("fake-pi: simulating crash\n");
    process.exit(7);
  }
  if (scenario === "partial") {
    const progress = assistantMessage("PARTIAL_PROGRESS_FROM_WORKER");
    emit({ type: "message_end", message: progress });
    await sleep(Math.max(step * 50, 1000));
    if (token !== runToken || aborted) return;
  }
  if (scenario === "ask") {
    const uiId = `ui-${randomBytes(4).toString("hex")}`;
    lastUiRequest = { id: uiId, answer: undefined };
    const answerPromise = new Promise((resolve) => {
      uiResolver = resolve;
    });
    emit({
      type: "extension_ui_request",
      id: uiId,
      method: "confirm",
      title: "Approve fake step?",
      message: process.env.FAKE_PI_UI_MESSAGE_CHARS
        ? "Q".repeat(
            Math.max(
              1,
              Math.min(Number(process.env.FAKE_PI_UI_MESSAGE_CHARS) || 1, 6000),
            ),
          )
        : "The fake harness needs permission to continue.",
      ...(process.env.FAKE_PI_UI_TIMEOUT
        ? { timeout: Number(process.env.FAKE_PI_UI_TIMEOUT) }
        : {}),
    });
    const answer = await answerPromise;
    if (token !== runToken || aborted) return;
    lastUiRequest.answer = String(answer);
    uiResolver = null;
  }
  emit({
    type: "tool_execution_end",
    toolCallId: "call_fake",
    toolName: "bash",
    result: { content: [{ type: "text", text: "fake-harness" }], details: {} },
    isError: scenario === "tool-error",
    durationMs: step,
  });

  if (scenario === "busy") {
    // Stress the event log with many progress events (no notification must be created).
    for (let index = 0; index < 150; index += 1) {
      emit({
        type: "tool_execution_start",
        toolCallId: `call_busy_${index}`,
        toolName: "bash",
        args: { command: `echo busy-${index}` },
      });
      emit({
        type: "tool_execution_end",
        toolCallId: `call_busy_${index}`,
        toolName: "bash",
        result: { content: [{ type: "text", text: `busy-${index}` }], details: {} },
        isError: false,
        durationMs: 0,
      });
    }
  }

  if (scenario === "error") {
    const message = assistantMessage("", "error", "FAKE_PROVIDER_ERROR");
    appendSession(message);
    emit({ type: "message_start", message });
    emit({ type: "message_end", message });
    emit({ type: "agent_end", messages: [message], willRetry: false });
    streaming = false;
    emit({ type: "agent_settled", aborted: false });
    return;
  }

  const text = [finalText(scenario, prompt), execReport()].filter(Boolean).join("\n");
  emit({ type: "turn_start" });
  const partial = assistantMessage("", "pending");
  emit({ type: "message_start", message: partial });
  emit({
    type: "message_update",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(0, 10) },
  });
  const message = assistantMessage(text);
  appendSession(message);
  emit({ type: "message_end", message });
  emit({ type: "turn_end", message, toolResults: [] });
  lastAssistantText = text;
  streaming = false;
  emit({ type: "agent_end", messages: [message], willRetry: false });
  emit({ type: "agent_settled", aborted: false });
}

function handleAbort(id) {
  if (!streaming) {
    respond(id, "abort", true);
    return;
  }
  if (ignoreAbort) {
    return;
  }
  if (steerQueue.length || followUpQueue.length) {
    // Pi documents that abort continues queued messages. Model the worst case:
    // the abort does not settle until the queue is cleared.
    process.stderr.write("fake-pi: abort with queued messages; not settling\n");
    return;
  }
  aborted = true;
  runToken += 1;
  streaming = false;
  const message = assistantMessage("", "aborted");
  emit({ type: "message_end", message });
  emit({ type: "agent_end", messages: [message], willRetry: false });
  emit({ type: "agent_settled", aborted: true });
  respond(id, "abort", true);
}

function handleLine(line) {
  if (Date.now() < acceptAfter) {
    setTimeout(() => handleLine(line), Math.max(1, acceptAfter - Date.now()));
    return;
  }
  if (process.env.FAKE_PI_START_FAIL === "1") {
    // Startup failure before the prompt is accepted (used to test idempotency).
    process.stderr.write("fake-pi: simulated startup failure\n");
    process.exit(9);
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    out({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
    return;
  }
  const id = typeof record.id === "string" ? record.id : undefined;
  const type = record.type;
  switch (type) {
    case "get_state":
      respond(id, "get_state", true, {
        model: { provider: "fake", id: "fake-model" },
        thinkingLevel: "off",
        isStreaming: streaming,
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        ...(sessionFile ? { sessionFile } : {}),
        ...(sessionId ? { sessionId } : {}),
        sessionName: takeValue("--name"),
        autoCompactionEnabled: false,
        messageCount: messages.length,
        pendingMessageCount: steerQueue.length + followUpQueue.length,
      });
      break;
    case "prompt": {
      if (streaming) {
        respond(id, "prompt", false, undefined, "Agent is streaming; specify streamingBehavior");
        return;
      }
      const scenario = scenarioFrom(String(record.message ?? ""));
      if (scenario === "handled") {
        respond(id, "prompt", true, { disposition: "handled" });
        return;
      }
      respond(id, "prompt", true, { disposition: "started" });
      void runPrompt(String(record.message ?? "")).catch((error) => {
        process.stderr.write(`fake-pi: run error ${error}\n`);
      });
      break;
    }
    case "steer": {
      if (!streaming) {
        respond(id, "steer", false, undefined, "Agent is not streaming");
        return;
      }
      steerQueue.push(String(record.message ?? ""));
      respond(id, "steer", true, { disposition: "queued" });
      emit({ type: "queue_update", steering: [...steerQueue], followUp: [...followUpQueue] });
      break;
    }
    case "follow_up": {
      if (!streaming) {
        respond(id, "follow_up", false, undefined, "Agent is not streaming");
        return;
      }
      followUpQueue.push(String(record.message ?? ""));
      respond(id, "follow_up", true, { disposition: "queued" });
      emit({ type: "queue_update", steering: [...steerQueue], followUp: [...followUpQueue] });
      break;
    }
    case "abort":
      handleAbort(id);
      break;
    case "clear_queue": {
      const steering = [...steerQueue];
      const followUp = [...followUpQueue];
      steerQueue.length = 0;
      followUpQueue.length = 0;
      process.stderr.write(
        `fake-pi: clear_queue steering=${steering.length} followUp=${followUp.length}\n`,
      );
      respond(id, "clear_queue", true, { steering, followUp });
      break;
    }
    case "extension_ui_response": {
      if (lastUiRequest && record.id === lastUiRequest.id && uiResolver) {
        const answer = record.cancelled ? "cancelled" : record.confirmed !== undefined ? String(record.confirmed) : String(record.value ?? "");
        const resolve = uiResolver;
        resolve(answer);
      }
      break;
    }
    case "get_last_assistant_text":
      respond(id, "get_last_assistant_text", true, { text: lastAssistantText });
      break;
    case "get_session_stats":
      respond(id, "get_session_stats", true, {
        sessionFile,
        sessionId,
        userMessages: 1,
        assistantMessages: lastAssistantText ? 1 : 0,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: messages.length,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: 0,
      });
      break;
    case "get_messages":
      respond(id, "get_messages", true, { messages });
      break;
    default:
      respond(id, String(type), false, undefined, `Unsupported fake command: ${String(type)}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim()) handleLine(line);
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

process.stderr.write(`fake-pi: ready session=${sessionFile ?? "none"} resumed=${resumed}\n`);
