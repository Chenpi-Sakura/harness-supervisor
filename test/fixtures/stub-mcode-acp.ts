#!/usr/bin/env node
/**
 * A stub MiniMax Code ACP agent that deliberately uses numeric reverse-request
 * ids, exactly like the real agent, which numbers them from zero.
 *
 * It records the ids the client used for its own requests on stderr, so a test
 * can assert that the supervisor keeps its id space separate.
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

let sessionId = `mvs_${randomUUID().replace(/-/g, "")}`;
let buffer = "";
let nextReverseRequestId = 0;
let promptId: number | string | undefined;
/**
 * True between an admitted prompt and its settlement. The real agent refuses to
 * steer outside that window ("Steering requires an admitted, active ACP prompt
 * Turn for this Session."), so the stub has to behave the same way.
 */
let promptActive = false;

function emit(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id: number | string, result: unknown): void {
  emit({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: Record<string, unknown>): void {
  emit({ jsonrpc: "2.0", method, params });
}

function handleMessage(message: JsonRpcMessage): void {
  const { id, method, params } = message;

  // The client answering one of our reverse requests.
  if (id !== undefined && method === undefined) {
    const outcome = message.result as { outcome?: { outcome?: string; optionId?: string } } | undefined;
    process.stderr.write(
      `STUB_CLIENT_RESPONSE ${JSON.stringify({
        id,
        outcome: outcome?.outcome,
        errorCode: message.error?.code,
      })}\n`,
    );
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: randomUUID(),
        content: { type: "text", text: "STUB_ANSWERED" },
      },
    });
    if (promptId !== undefined) {
      const settled = promptId;
      promptId = undefined;
      promptActive = false;
      setTimeout(() => ok(settled, { stopReason: "end_turn" }), 10);
    }
    return;
  }

  switch (method) {
    case "initialize": {
      if (id === undefined) return;
      // Report the client's own request id so the test can inspect it.
      process.stderr.write(`STUB_CLIENT_REQUEST_ID ${JSON.stringify({ id })}\n`);
      ok(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "minimax-code", title: "MiniMax Code", version: "0.0.0-stub" },
        _meta: {
          "minimax-code/extensions": {
            version: 1,
            methods: ["mcode/session/steer", "mcode/session/queue/enqueue"],
            notifications: [],
          },
        },
      });
      return;
    }
    case "session/new": {
      if (id === undefined) return;
      ok(id, { sessionId, modes: { currentModeId: "default", availableModes: [] } });
      return;
    }
    case "session/set_config_option": {
      if (id === undefined) return;
      if (process.env.STUB_CONFIG_ERROR === "1") {
        emit({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "Cannot change the permission mode" },
        });
        return;
      }
      ok(id, { configOptions: [] });
      return;
    }
    case "session/load": {
      if (id === undefined) return;
      ok(id, { sessionId });
      return;
    }
    case "session/prompt": {
      if (id === undefined) return;
      promptId = id;
      promptActive = true;
      if (process.env.STUB_UNKNOWN_EXTENSION === "1") {
        // An extension request the supervisor does not model. It carries an id,
        // so it has to be answered.
        setTimeout(() => {
          emit({
            jsonrpc: "2.0",
            id: 4242,
            method: "mcode/session/unknown",
            params: { sessionId },
          });
        }, 20);
      }
      // A reverse request with a numeric id, like the real agent's.
      const reverseId = nextReverseRequestId++;
      setTimeout(() => {
        emit({
          jsonrpc: "2.0",
          id: reverseId,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "tool-1", title: "bash", rawInput: { command: "echo hi" } },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        if (process.env.STUB_WITHDRAW_PERMISSION === "1") {
          // The agent changes its mind and withdraws the request.
          setTimeout(() => {
            notify("$/cancel_request", { requestId: reverseId });
          }, 30);
        }
      }, 20);
      return;
    }
    case "session/cancel": {
      return;
    }
    case "mcode/session/steer": {
      if (id === undefined) return;
      if (!promptActive) {
        // The real agent answers this way when the turn is not admitted.
        emit({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: "Steering requires an admitted, active ACP prompt Turn for this Session.",
          },
        });
        return;
      }
      // The real agent answers with the turn it joined and how it treated the
      // message.
      ok(id, { mode: "steered", turnId: "turn-stub-1" });
      return;
    }
    case "mcode/session/queue/enqueue": {
      if (id === undefined) return;
      ok(id, { itemId: "queue-stub-1", status: "queued", position: 1 });
      return;
    }
    default: {
      if (id !== undefined) emit({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
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
      continue;
    }
    handleMessage(message);
  }
});

process.stdin.on("end", () => process.exit(0));
