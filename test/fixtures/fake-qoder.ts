#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface InputRecord {
  type?: string;
  uuid?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  request_id?: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  priority?: string;
  [key: string]: unknown;
}

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/[:/\\]/g, "-");
}

const resumeId = argValue("--resume");
const requestedId = argValue("--session-id");
const sessionId = resumeId ?? requestedId ?? randomUUID();
const cwd = process.cwd();
const configRoot = process.env.QODERCN_CONFIG_DIR ?? process.env.QODER_CONFIG_DIR ?? path.join(cwd, ".qoder-fake");
const sessionFile = path.join(configRoot, "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
const permissionMode = argValue("--permission-mode") ?? "auto";
// Lets a test simulate a runtime that accepted the flag but reports a different
// effective mode in its init record (a silent downgrade).
const effectivePermissionMode =
  process.env.FAKE_QODER_EFFECTIVE_PERMISSION_MODE ?? permissionMode;
const argvLog = process.env.FAKE_QODER_ARGV_LOG;
if (argvLog) {
  appendFileSync(argvLog, `${JSON.stringify(process.argv.slice(2))}\n`, "utf8");
}
const notLoggedIn = process.env.FAKE_QODER_NOT_LOGGED_IN === "1";
const preemptiveAuthFail = process.env.FAKE_QODER_PREEMPTIVE_AUTH_FAIL === "1";
const lateSession = process.env.FAKE_QODER_LATE_SESSION === "1";

let sessionSeed = "";
let persisted = false;
let busy = false;
let interruptRequested = false;
let waitingPermission: string | null = null;
let currentTimers: NodeJS.Timeout[] = [];
const queued: InputRecord[] = [];
const sentUuids = new Map<string, string>();

function later(ms: number, fn: () => void): void {
  const timer = setTimeout(() => {
    currentTimers = currentTimers.filter((item) => item !== timer);
    fn();
  }, ms);
  currentTimers.push(timer);
}

function clearTimers(): void {
  for (const timer of currentTimers) clearTimeout(timer);
  currentTimers = [];
}

async function persistSession(): Promise<void> {
  if (persisted) return;
  persisted = true;
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", id: sessionId, seed: sessionSeed, cwd })}\n`,
    "utf8",
  );
}

async function ensureSessionFile(): Promise<void> {
  if (resumeId) {
    try {
      const first = (await readFile(sessionFile, "utf8")).trim().split("\n")[0] ?? "";
      const parsed = JSON.parse(first) as { seed?: unknown };
      sessionSeed = typeof parsed.seed === "string" ? parsed.seed : "";
    } catch {
      process.stderr.write(`fake-qoder: cannot resume missing session ${sessionId}\n`);
      process.exit(1);
    }
    await appendFile(sessionFile, `${JSON.stringify({ type: "session_event", event: "resume" })}\n`);
    return;
  }
  sessionSeed = `SEED-${sessionId.slice(0, 8)}`;
  if (!lateSession) await persistSession();
}

function resultRecord(text: string, options: { error?: string; aborted?: boolean } = {}): void {
  const base = {
    type: "result",
    duration_ms: 12,
    duration_api_ms: 10,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    stop_reason: options.error ? "error" : "end_turn",
    uuid: randomUUID(),
    session_id: sessionId,
  };
  if (options.error) {
    emit({
      ...base,
      subtype: "error_during_execution",
      is_error: true,
      errors: [options.error],
      terminal_reason: options.aborted ? "aborted" : "error",
    });
  } else {
    emit({ ...base, subtype: "success", is_error: false, result: text });
  }
}

function assistant(text: string): void {
  emit({
    type: "assistant",
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "fake-qoder",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  });
}

function toolUse(id: string, name: string, input: Record<string, unknown>): void {
  emit({
    type: "assistant",
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "fake-qoder",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  });
}

function toolResult(toolUseId: string, text: string, isError = false): void {
  emit({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  });
}

function promptText(record: InputRecord): string {
  const content = record.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function runTurn(record: InputRecord): void {
  busy = true;
  interruptRequested = false;
  if (lateSession) later(100, () => void persistSession());
  const text = promptText(record);
  const final = text.includes("STEER")
    ? `STEERED:${text}`
    : text.includes("recall")
      ? `RECALL:${sessionSeed}`
      : "FAKE_QODER_OK";

  if (notLoggedIn) {
    assistant("Not logged in · Please run /login");
    later(20, () => {
      busy = false;
      emit({
        type: "result",
        subtype: "success",
        is_error: true,
        duration_ms: 5,
        duration_api_ms: 0,
        num_turns: 0,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        stop_reason: null,
        terminal_reason: "completed",
        uuid: randomUUID(),
        session_id: sessionId,
      });
      drainQueue();
    });
    return;
  }

  if (text.includes("[scenario:fail]")) {
    later(60, () => {
      busy = false;
      resultRecord("", { error: "FAKE_QODER_FAILURE" });
      drainQueue();
    });
    return;
  }

  if (text.includes("[scenario:steer]")) {
    assistant("WORKING");
    later(500, () => {
      busy = false;
      resultRecord("FAKE_QODER_OK");
      drainQueue();
    });
    return;
  }

  if (text.includes("[scenario:cancel]") || text.includes("[scenario:slow]")) {
    assistant("WORKING");
    later(20_000, () => {
      busy = false;
      resultRecord("FAKE_QODER_TIMEOUT");
      drainQueue();
    });
    return;
  }

  if (text.includes("[scenario:multi-result-near]")) {
    // Two result records 200ms apart: inside the 350ms settle window, so the
    // adapter must coalesce them into ONE terminal state using the last text.
    assistant("PART1");
    later(20, () => {
      busy = false;
      resultRecord("FIRST");
      later(200, () => {
        busy = true;
        assistant("PART2");
        later(20, () => {
          busy = false;
          resultRecord("SECOND");
          drainQueue();
        });
      });
    });
    return;
  }

  if (text.includes("[scenario:multi-result-wide]")) {
    // Two result records 2000ms apart: the first one settles after the 350ms
    // quiet window, and the late result arrives after the run is finished.
    assistant("PART1");
    later(20, () => {
      busy = false;
      resultRecord("FIRST");
      later(2000, () => {
        busy = true;
        assistant("PART2");
        later(20, () => {
          busy = false;
          resultRecord("SECOND");
          drainQueue();
        });
      });
    });
    return;
  }

  if (text.includes("[scenario:permission]")) {
    const toolUseId = `tool-${randomUUID()}`;
    waitingPermission = toolUseId;
    emit({
      type: "control_request",
      request_id: `perm-${randomUUID()}`,
      session_id: sessionId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "touch permission-ok.txt" },
        tool_use_id: toolUseId,
        decision_reason: "The worker wants to run a shell command.",
        permission_suggestions: [],
      },
    });
    return;
  }

  later(30, () => {
    toolUse("tool-1", "Bash", { command: "echo hello" });
    toolResult("tool-1", "hello");
    assistant(text.includes("STEER") ? `accepted: ${text}` : "FAKE_QODER_OK");
    later(30, () => {
      busy = false;
      resultRecord(final);
      drainQueue();
    });
  });
}

function drainQueue(): void {
  if (interruptRequested) return;
  const next = queued.shift();
  if (!next) return;
  later(40, () => runTurn(next));
}

function handlePermissionResponse(response: Record<string, unknown>): void {
  if (!waitingPermission) return;
  const toolUseId = waitingPermission;
  waitingPermission = null;
  const behavior = response.behavior;
  const answers = response.updatedInput;
  if (behavior === "allow") {
    toolResult(toolUseId, `allowed:${JSON.stringify(answers ?? {})}`);
    assistant("PERMISSION_OK");
    later(20, () => {
      busy = false;
      resultRecord("PERMISSION_OK");
      drainQueue();
    });
  } else {
    toolResult(toolUseId, String(response.message ?? "denied"), true);
    later(20, () => {
      busy = false;
      resultRecord("", { error: `TOOL_DENIED: ${String(response.message ?? "denied")}` });
      drainQueue();
    });
  }
}

function handleControlRequest(record: InputRecord): void {
  const requestId = String(record.request_id ?? "");
  const request = record.request ?? {};
  const kind = String(request.type ?? request.subtype ?? "");
  if (kind === "initialize") {
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { capabilities: ["interrupt_cancel_queued_v1"] },
      },
    });
    emit({
      type: "system",
      subtype: "init",
      apiKeySource: "fake",
      qodercli_version: "fake-1.0.0",
      cwd,
      tools: ["Bash", "Read", "Edit"],
      mcp_servers: [],
      model: "fake-qoder-model",
      permissionMode: effectivePermissionMode,
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      capabilities: ["interrupt_cancel_queued_v1"],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    if (preemptiveAuthFail) {
      assistant("Not logged in · Please run /login");
      emit({
        type: "result",
        subtype: "success",
        is_error: true,
        duration_ms: 5,
        duration_api_ms: 0,
        num_turns: 0,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        stop_reason: null,
        terminal_reason: "completed",
        uuid: randomUUID(),
        session_id: sessionId,
      });
    }
    return;
  }
  if (kind === "interrupt") {
    interruptRequested = true;
    clearTimers();
    busy = false;
    waitingPermission = null;
    const cancelled = queued.map((item) => item.uuid).filter(Boolean);
    queued.length = 0;
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { still_queued: [], cancelled },
      },
    });
    resultRecord("", { error: "Interrupted by user", aborted: true });
    return;
  }
  if (kind === "cancel_async_message") {
    const messageUuid = String(request.message_uuid ?? "");
    const index = queued.findIndex((item) => item.uuid === messageUuid);
    const cancelled = index >= 0;
    if (cancelled) queued.splice(index, 1);
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { cancelled },
      },
    });
    return;
  }
  emit({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: requestId,
      error: `unsupported control request: ${kind}`,
    },
  });
}

function handleRecord(record: InputRecord): void {
  if (record.type === "control_request") {
    handleControlRequest(record);
    return;
  }
  if (record.type === "control_response") {
    const response = record.response;
    if (!response || typeof response !== "object") return;
    if (String(response.request_id ?? "").startsWith("perm-")) {
      handlePermissionResponse(response.response as Record<string, unknown>);
    }
    return;
  }
  if (record.type === "user") {
    const uuid = String(record.uuid ?? "");
    const text = promptText(record);
    if (uuid) {
      sentUuids.set(uuid, text);
      emit({
        type: "user",
        message: record.message,
        parent_tool_use_id: null,
        uuid,
        session_id: sessionId,
        isReplay: true,
      });
    }
    if (busy) {
      queued.push(record);
      return;
    }
    runTurn(record);
  }
}

async function main(): Promise<void> {
  if (process.env.FAKE_QODER_AUTH_FAIL === "1") {
    process.stderr.write("Not logged in. Run `qodercli login` to authenticate.\n");
    process.exit(42);
  }
  await ensureSessionFile();

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handleRecord(JSON.parse(line) as InputRecord);
      } catch (error) {
        process.stderr.write(`fake-qoder: invalid input: ${String(error)}\n`);
      }
    }
  });
  process.stdin.on("end", () => {
    clearTimers();
    setTimeout(() => process.exit(0), 20);
  });
}

void main();
