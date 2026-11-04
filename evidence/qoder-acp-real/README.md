# Qoder 1.1.82 ACP real acceptance (2026-11-04)

Scope: validate the optional Qoder ACP transport
(`HARNESS_SUPERVISOR_QODER_PROTOCOL=acp`) through the real Supervisor daemon
against `qodercli 1.1.82`. Stream-json remains the default; this evidence covers
only the ACP path.

## Environment

- Windows x64, Node 24
- `qodercli 1.1.82`
- Model: `DeepSeek-Flash`
- Normal `~/.qoder` interactive login. The script removes the desktop-injected
  `QODER_CONFIG_DIR` / `QODERCN_CONFIG_DIR` overrides because they point at an
  unauthenticated config root.
- Temporary workspace and daemon state directories; no repository files were
  modified by the scenario.

## Command

```bash
QODER_REAL=1 QODER_REAL_MODEL=DeepSeek-Flash node scripts/e2e-qoder-acp.mjs
```

The script starts a daemon with:

```text
HARNESS_SUPERVISOR_QODER_PROTOCOL=acp
HARNESS_SUPERVISOR_QODER_PERMISSION_MODE=default
HARNESS_SUPERVISOR_QODER_INPUT_TIMEOUT_MS=300000
```

A second daemon with `bypass_permissions` is used only for the cancellation
scenario so the long-running command does not need an approval.

## Results

| Scenario | Observed |
| --- | --- |
| ACP spawn + prompt | `completed`, `QODER_ACP_E2E_OK`, ACP handle written |
| ACP resume / `session/load` | `completed`, `QODER_ACP_RESUME_OK`, same session id and handle, `resumeCount=1` |
| Write approval | `awaiting_input` with native options `Allow for this session / Allow / Reject`; answered `Allow`; file `acp-write-ok.txt` contained `ACP_WRITE_OK`; run `completed` |
| AskUserQuestion | `elicitation/create`, method `select`, title `确认`, options `是 / 否`; answered `是`; result `QUESTION_YES`; run `completed` |
| Cancel | status `running` before cancel, `cancelled` after; recorded PID no longer alive |
| Errors | 0 `run.error` events across all scenarios |
| Usage | 0 `run.usage` events; ACP prompt usage is all zeros, treated as unknown |

Worker/session details are in `result.json`. `events.jsonl` is a projected event
log (event type, progress kind, tool, input method/title/options/requestId) and
does not include raw assistant text, file contents, or full permission messages.

## Limits

- ACP is opt-in in 0.7.0; it is not the Qoder default.
- Qoder 1.1.82 ACP returns all-zero token counters; no Token usage is claimed.
- `steer` / queued `followUp` are not implemented. The upstream
  `_meta.qoder.promptQueueing` flag was observed but not accepted as capability
  without run-boundary verification.
- `plan` permission mode, tool allowlists, and URL elicitation are rejected or
  declined explicitly.
- The ACP session handle is HS-owned; the conversation itself stays in Qoder's
  store and is reattached with `session/load`.
- `cwd` is not a sandbox.
