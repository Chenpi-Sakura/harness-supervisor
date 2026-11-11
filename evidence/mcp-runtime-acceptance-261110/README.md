# 0.9.1 MCP response contract: real Qoder and MiniMax Code acceptance

Executed 2026-11-10 on Windows 10.0.26300 x64 / Node v24.21.0. Each runtime ran one minimal text-only task through the **production MCP** (`worker_spawn -> worker_wait -> worker_status -> worker_events`) using a fresh temporary state directory and workspace. The production daemon and state directory were untouched.

Command:

```text
MCP_REAL=1 MCP_REAL_RUNTIMES=qoder,mcode node scripts/e2e-mcp-runtimes.mjs
```

Harnesses:

- Qoder CLI 1.1.82 over ACP, normal `~/.qoder` login; desktop-injected `QODER_CONFIG_DIR` / `QODERCN_CONFIG_DIR` were removed.
- MiniMax Code 0.7.0 over ACP, auto-detected from `~/.minimax-code`.

Prompt (per runtime): reply with exactly one fixed ASCII token, no tool calls, no file access.

## Response sizes (UTF-8 bytes)

| Runtime | spawn | wait | status | events | development status |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qoder 1.1.82 | 536 | 355 | 406 | 544 | 7,211 |
| MiniMax Code 0.7.0 | 536 | 355 | 406 | 544 | 7,367 |

All four production responses stay in the hundreds of bytes for a 19-character final answer. The development status (full result plus recent raw events) is roughly 13-18x larger than the production snapshot.

## Contract checks (both runtimes passed)

- `worker_wait` returned `terminal=true`, `status=completed`, and the complete 19-character result exactly once; `result.truncated=false`. No `events` field.
- `worker_status` returned only `worker`; `resultAvailable=true`, `resultPreview.chars=19`, `truncated=false`; no `recentEvents`, `lastProgress`, `timeline`, `inputState`, `cwd`, `pid`, `sessionFile`, `sessionId`, `supervisorId`, or `stderrTail`.
- `worker_events` returned six lifecycle events (`worker.starting`, `worker.started`, `run.accepted`, `run.started`, `run.completed`, `worker.exited`). No `run.progress`, no event `data` field, and no banned management keys.
- Production responses contain no `run.progress` type, no thinking/text-delta payload, and no banned diagnostic key.

## What the runtime actually emitted (development diagnostics)

- Qoder emitted 37 progress events (kinds: `assistant_message`, `session_init`, `thinking`, `turn_complete`) plus `worker.session`; production reported `progressOmitted=37` and exposed none of them.
- MiniMax Code emitted 24 progress events (`assistant_message`, `thinking`) plus `worker.session`; production reported `progressOmitted=24`.

This is the central evidence for the contract: real Qoder produced streaming **thinking** and assistant-message chunks, and none reached the production Master-facing responses.

## Limits

- One minimal text-only task per runtime; no Desktop-model run, no persistent multi-turn continuity, no steering or permission-approval flow.
- The model output is non-deterministic; the token assertion only proves the final result arrived intact.
- Pi and DSH were not run this round (the requested scope was Qoder or MiniMax Code).
- `result.json` contains only sanitized IDs, field names, byte counts and summary data; no raw session, credentials or full model text.
