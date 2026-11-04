# ACP feasibility probes (2026-11-04)

Scope: evaluate Pi / Qoder / MiniMax Code ACP migration. No Runtime code was
changed. Probes used qodercli 1.1.82 on Windows x64 with the normal `~/.qoder`
login; temporary working directories were used for each session.

## Qoder ACP

### Initialize and session/new

`qodercli --acp` (JSON-RPC over stdio) returned:

- protocolVersion 1
- agentInfo `qoder-cli` 1.1.82
- `loadSession: true`
- sessionCapabilities: resume, fork, list, delete, close
- promptCapabilities: image, embeddedContext
- mcpCapabilities: http, sse

`session/new` returned a session id, modes
`default/acceptEdits/auto/dontAsk/yolo` (current `yolo`), a model list, and
`configOptions` for `mode` and `model`.

### Tool approval (Write, mode=default)

After `session/set_config_option` set `mode=default`, a Write tool call produced:

```json
{
  "method": "session/request_permission",
  "params": {
    "options": [
      { "optionId": "proceed_always", "kind": "allow_always" },
      { "optionId": "proceed_once", "kind": "allow_once" },
      { "optionId": "cancel", "kind": "reject_once" }
    ],
    "toolCall": { "title": "Edit acp-probe.txt", "kind": "edit", "...": "..." }
  }
}
```

The client replied `{"outcome":{"outcome":"selected","optionId":"proceed_always"}}`;
the tool completed and the prompt returned `stopReason=end_turn`.

### AskUserQuestion via elicitation

The first probe did not advertise elicitation and Qoder did not send a question
request. After initialize advertised:

```json
"clientCapabilities": {
  "fs": { "readTextFile": true, "writeTextFile": false },
  "elicitation": { "form": {}, "url": {} }
}
```

the AskUserQuestion tool call produced:

```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "sessionId": "...",
    "toolCallId": "call_...",
    "message": "Answer Questions",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "q0": {
          "type": "string",
          "title": "确认",
          "description": "是否继续？\n是: ...\n否: ...",
          "oneOf": [{ "const": "是", "title": "是" }, { "const": "否", "title": "否" }]
        }
      },
      "required": ["q0"]
    }
  }
}
```

The client replied `{"action":"accept","content":{"q0":"是"}}`; the model
continued and the prompt returned `stopReason=end_turn`. This confirms Qoder ACP
can surface both tool approvals and user questions, provided the client
advertises and handles elicitation.

### Usage

The same `session/prompt` result contained only zero token counters and a
`_meta.quota` credit value. ACP did not provide a usable input/output token
breakdown in this probe.

## Pi

Official Pi 1.5.0 (npm `@earendil-works/pi-coding-agent`) documentation and CLI
offer native RPC (`--mode rpc`) and a TypeScript SDK, but no ACP entrypoint. The
installed Pi is 1.4.0.

Third-party ACP adapters found on npm:

- `pi-acp` 0.0.34 (MIT, MVP): bridges to `pi --mode rpc`; README lists no ACP
  `fs/*`/`terminal/*`, no MCP wiring, and the package contains no
  `session/request_permission` handler.
- `@automatalabs/pi-acp` 0.9.4 (Apache-2.0): embeds Pi SDK 0.87.1 in process;
  supports steering/session load/MCP/elicitation, but its package code search
  did not find an ACP `session/request_permission` handler, and the pinned Pi
  SDK is far behind the installed 1.4.0/1.5.0.

Conclusion: Pi has no official ACP and the available bridges either lose
permission/extension-UI semantics or introduce version skew. Keep Pi on native
RPC unless the goal is editor interoperability rather than HS lifecycle control.

## MiniMax Code

`src/adapters/mcode/session.ts` already uses ACP (`mcode acp`) for
initialize/session/new/session/load/prompt/cancel and
`session/request_permission`, plus mcode-specific steering/queue extensions.
No protocol migration is needed; only a shared ACP core refactor is a candidate,
and it must preserve those extensions and be revalidated against a real 0.7.0
process.
