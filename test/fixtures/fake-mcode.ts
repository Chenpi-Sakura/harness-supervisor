#!/usr/bin/env node
/**
 * A fake MiniMax Code ACP agent for tests.
 *
 * It speaks the same wire format as the real `mcode acp` server: ndJSON with
 * one JSON-RPC 2.0 message per line, `session/new` and `session/prompt` as
 * requests, `session/cancel` as a notification, and `session/update` as the
 * agent-to-client push channel.
 *
 * Scenarios are selected with FAKE_MCODE_SCENARIO:
 *   basic     - one agent_message_chunk, then end_turn
 *   tools     - one tool_call plus a tool_call_update
 *   permission- asks for permission before finishing
 *   hang      - never finishes, so the run has to be cancelled
 *   fail      - returns a JSON-RPC error for session/prompt
 *   noext     - initializes without the mcode/* extensions
 *
 * Two environment variables make the harness hostile on purpose:
 *   FAKE_MCODE_PERMISSION_ID - the id of the reverse permission request. It
 *     can be set to a number the supervisor itself uses, so a test can prove
 *     that the two id spaces stay apart.
 *   FAKE_MCODE_CONFIG_ERROR  - session/set_config_option answers with an
 *     error, so the supervisor has to report a failure instead of silently
 *     staying in the default permission mode.
 */
import { randomUUID } from "node:crypto";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const scenario = process.env.FAKE_MCODE_SCENARIO ?? "basic";
const sessionId = `mvs_${randomUUID().replace(/-/g, "")}`;

let buffer = "";
let pendingPermission: { id: number | string; options: unknown[] } | null = null;
let cancelled = false;
let turnActive = false;
let turnTimers: NodeJS.Timeout[] = [];

function emit(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method: string, params: Record<string, unknown>): void {
  emit({ jsonrpc: "2.0", method, params });
}

function later(ms: number, fn: () => void): void {
  const timer = setTimeout(() => {
    turnTimers = turnTimers.filter((item) => item !== timer);
    fn();
  }, ms);
  turnTimers.push(timer);
}

function clearTurnTimers(): void {
  for (const timer of turnTimers) clearTimeout(timer);
  turnTimers = [];
}

function ok(id: number | string, result: unknown): void {
  emit({ jsonrpc: "2.0", id, result });
}

function fail(id: number | string, code: number, message: string): void {
  emit({ jsonrpc: "2.0", id, error: { code, message } });
}

function sessionUpdate(update: Record<string, unknown>): void {
  notify("session/update", { sessionId, update });
}

const EXTENSION_METHODS = [
  "session/activate",
  "mcode/session/activate",
  "mcode/session/steer",
  "mcode/session/queue/list",
  "mcode/session/queue/enqueue",
  "mcode/session/queue/update",
  "mcode/session/queue/delete",
  "mcode/session/queue/steer",
];

function handlePrompt(id: number | string, params: Record<string, unknown>): void {
  if (scenario === "fail") {
    fail(id, -32603, "fake mcode run failed");
    return;
  }
  turnActive = true;
  cancelled = false;
  const prompt = params.prompt as Array<{ type?: string; text?: string }> | undefined;
  const text = prompt?.[0]?.text ?? "";

  const finish = (): void => {
    if (cancelled) {
      turnActive = false;
      ok(id, { stopReason: "cancelled" });
      return;
    }
    turnActive = false;
    ok(id, { stopReason: "end_turn" });
  };

  if (scenario === "hang") {
    // Never settles on its own; only session/cancel ends the turn.
    later(60_000, () => {
      /* no-op: keeps the process alive until cancelled */
    });
    return;
  }

  if (scenario === "permission") {
    later(30, () => {
      if (permissionMode === "bypassPermissions") {
        // The supervisor did not ask for the Ask mode, so no permission
        // request is raised and the run finishes on its own.
        sessionUpdate({
          sessionUpdate: "agent_message_chunk",
          messageId: randomUUID(),
          content: { type: "text", text: "FAKE_MCODE_OK" },
        });
        later(10, finish);
        return;
      }
      // MiniMax Code numbers its reverse requests from zero, so the stub does the
      // same. A fixed id would hide the case where an agent request collides
      // with one of the supervisor's own request ids.
      //
      // The worst case is the id the client itself used for the pending prompt:
      // a client that shares the numeric id space would have this request
      // mistaken for the answer to its own prompt. A client that keeps its own
      // id space (string ids) cannot collide, so the stub falls back to the
      // ordinary counter.
      const promptId = lastPromptId;
      const requestId =
        typeof promptId === "number"
          ? promptId
          : process.env.FAKE_MCODE_PERMISSION_ID !== undefined
            ? Number(process.env.FAKE_MCODE_PERMISSION_ID)
            : nextReverseRequestId++;
      pendingPermission = {
        id: requestId,
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      };
      emit({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tool-1", title: "bash", rawInput: { command: text } },
          options: pendingPermission.options,
        },
      });
      if (process.env.FAKE_MCODE_WITHDRAW_PERMISSION === "1") {
        later(350, () => {
          pendingPermission = null;
          notify("$/cancel_request", { requestId });
        });
      }
    });
    return;
  }

  later(20, () => {
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: randomUUID(),
      content: { type: "text", text: `FAKE_MCODE_OK:${text}` },
    });
    if (scenario === "tools") {
      sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "bash",
        name: "bash",
        kind: "execute",
        status: "pending",
      });
      later(10, () => {
        sessionUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
        });
      });
    }
    later(10, finish);
  });
}

function handleMessage(message: JsonRpcMessage): void {
  const { id, method, params } = message;

  // Record what the client used as its request id. A numeric id could collide
  // with this agent's own reverse-request ids, so the harness reports it.
  if (id !== undefined && method !== undefined) {
    process.stderr.write(`FAKE_MCODE_CLIENT_ID ${JSON.stringify({ id, method })}\n`);
  }

  // A client response to one of our requests (for example a permission answer).
  if (id !== undefined && method === undefined) {
    if (pendingPermission && id === pendingPermission.id) {
      pendingPermission = null;
      const outcome = message.result as
        | { outcome?: { outcome?: string; optionId?: string } }
        | undefined;
      const selected = outcome?.outcome?.outcome;
      const optionId = outcome?.outcome?.optionId ?? "";
      const denied = selected === "cancelled" || /^deny|^reject/.test(optionId);
      later(10, () => {
        sessionUpdate({
          sessionUpdate: "agent_message_chunk",
          messageId: randomUUID(),
          content: {
            type: "text",
            text: denied ? "FAKE_MCODE_DENIED" : "FAKE_MCODE_OK",
          },
        });
        later(10, () => {
          // The prompt request id is tracked separately below.
          if (lastPromptId === undefined) return;
          ok(lastPromptId, { stopReason: "end_turn" });
        });
      });
    }
    return;
  }

  switch (method) {
    case "initialize": {
      if (id === undefined) return;
      ok(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: "minimax-code", title: "MiniMax Code", version: "0.0.0-fake" },
        ...(scenario === "noext"
          ? {}
          : {
              _meta: {
                "minimax-code/extensions": {
                  version: 1,
                  methods: EXTENSION_METHODS,
                  notifications: [],
                },
              },
            }),
      });
      return;
    }
    case "session/new": {
      if (id === undefined) return;
      ok(id, {
        sessionId,
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default", description: "Work normally" }],
        },
      });
      return;
    }
    case "session/set_config_option": {
      if (id === undefined) return;
      if (process.env.FAKE_MCODE_CONFIG_ERROR === "1") {
        fail(id, -32603, "Cannot change the permission mode");
        return;
      }
      const configId = params?.configId;
      const value = params?.value;
      if (configId === "permissionMode" && typeof value === "string") {
        permissionMode = value;
        ok(id, { configOptions: [] });
        return;
      }
      fail(id, -32602, "Invalid params");
      return;
    }
    case "session/load": {
      if (id === undefined) return;
      const requested = params?.sessionId;
      if (typeof requested !== "string" || requested.length === 0) {
        fail(id, -32602, "Invalid params");
        return;
      }
      ok(id, { sessionId: requested });
      return;
    }
    case "session/prompt": {
      if (id === undefined) return;
      lastPromptId = id;
      handlePrompt(id, params ?? {});
      return;
    }
    case "session/cancel": {
      cancelled = true;
      clearTurnTimers();
      if (turnActive) {
        turnActive = false;
        if (lastPromptId !== undefined) {
          ok(lastPromptId, { stopReason: "cancelled" });
        }
      }
      return;
    }
    case "mcode/session/steer": {
      if (id === undefined) return;
      if (!turnActive) {
        fail(id, -32602, "Steering requires an admitted, active ACP prompt Turn for this Session.");
        return;
      }
      ok(id, { turnId: "turn-active", mode: "steered" });
      return;
    }
    case "mcode/session/queue/enqueue": {
      if (id === undefined) return;
      ok(id, { itemId: `queue-${randomUUID().slice(0, 8)}`, position: 1 });
      return;
    }
    case "mcode/session/queue/list": {
      if (id === undefined) return;
      ok(id, { items: [] });
      return;
    }
    case "mcode/session/queue/delete": {
      if (id === undefined) return;
      ok(id, { item: null });
      return;
    }
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method ?? "unknown"}`);
  }
}

let lastPromptId: number | string | undefined;
let nextReverseRequestId = 0;
// MiniMax Code defaults to bypassPermissions; the supervisor has to switch
// the session to the Ask mode explicitly.
let permissionMode = process.env.FAKE_MCODE_PERMISSION_MODE ?? "bypassPermissions";

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
      continue;
    }
    try {
      handleMessage(message);
    } catch (error) {
      if (message.id !== undefined) {
        fail(message.id, -32603, error instanceof Error ? error.message : "internal error");
      }
    }
  }
});

process.stdin.on("end", () => process.exit(0));
