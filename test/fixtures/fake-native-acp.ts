import readline from "node:readline";
let sessionId = "native-session", active: unknown;
let configOptions: { id: string; category: string; currentValue: string; options: { value: string; name: string; description?: string }[] }[] = [
  { id: "model", category: "model", currentValue: "native-model", options: [{ value: "native-model", name: "Native Model" }, { value: "gpt-6-luna", name: "GPT 6 Luna" }] },
  { id: "reasoning_effort", category: "thought_level", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }] },
];
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const update = (text: string) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  switch (request.method) {
    case "initialize": reply(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: process.env.FAKE_ACP_NO_LOAD !== "1" } }); break;
    case "session/new":
      if (process.env.FAKE_ACP_DEFAULT_MODEL === "1") configOptions[0] = { ...configOptions[0]!, currentValue: "default", options: [{ value: "default", name: "Default (recommended)", description: "Native configured model" }] };
      reply(request.id, { sessionId, ...(process.env.FAKE_ACP_NO_CONFIG === "1" ? {} : { configOptions }) }); break;
    case "session/load": sessionId = request.params.sessionId; update("REPLAY_MUST_NOT_ENTER_RESULT"); reply(request.id, { configOptions }); break;
    case "session/set_config_option":
      configOptions = configOptions.map(option => option.id === request.params.configId && process.env.FAKE_ACP_MISMATCH !== "1" ? { ...option, currentValue: request.params.value } : option);
      reply(request.id, { configOptions }); break;
    case "session/prompt": {
      const text = request.params.prompt[0].text;
      if (text === "crash") { process.exit(7); break; }
      if (text === "slow") { active = request.id; break; }
      if (text === "approve") {
        active = request.id;
        send({ jsonrpc: "2.0", id: "native-permission", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "write", title: "Write a test file", rawInput: { path: "test.txt" } }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }] } });
        break;
      }
      update("DONE "); update(text); reply(request.id, { stopReason: "end_turn" }); break;
    }
    case "session/cancel": reply(active, { stopReason: "cancelled" }); active = undefined; break;
    default:
      if (request.id === "native-permission") { update(request.result.outcome.optionId === "allow" ? "ALLOWED" : "DENIED"); reply(active, { stopReason: "end_turn" }); active = undefined; }
  }
});
