# v0.6.6 Qoder 1.1.82 compatibility evidence

Date: 2026-11-04. Upstream CLI: qodercli 1.1.82 (Windows x64).

## 1. Launch argument conflict

`--permission-prompt-tool stdio` and `--input-format stream-json` are now mutually
exclusive. The CLI exits before authentication or any model request:

```text
$ qodercli --print --output-format stream-json --input-format stream-json \
    --permission-prompt-tool stdio --permission-mode bypass_permissions ...
--permission-prompt-tool stdio cannot be combined with --input-format stream-json
exit=1
```

The same argument set against 1.1.79 did not produce this error. 1.1.79 also
continued to emit `can_use_tool` control requests **without** the legacy flag,
so removing it does not drop the permission channel on the older CLI:

- 1.1.78, no flag, real AskUserQuestion: `control=true`, answered, completed.
- 1.1.79, no flag, real AskUserQuestion: `control=true`, answered, completed.
- 1.1.82, no flag, real AskUserQuestion: `control=false`; the CLI returned
  `tool_result is_error content="Error: Answer questions?"` instead of a
  control request.
- 1.1.82, Write tool in permission mode `default` via ACP: real
  `session/request_permission` with `allow_once` / `allow_always` / `reject_once`.

## 2. Lazy session initialization

After the flag was removed, 1.1.82 still did not emit `system init` until it
received the first user message; HS previously waited for init before sending
the prompt. HS now waits 1 s for init, then sends the initial prompt once to
trigger initialization. The Supervisor prompt is deduplicated in the session,
and 1.1.79 keeps the original initialize-then-prompt order in practice.

## 3. Regression

Full suite: **328 tests / 326 pass / 0 fail / 2 skipped**, 474.8s
(`full-regression.txt`). The two skipped cases are the opt-in paid real Pi
tests; they are not counted as passing.

## 4. Real end-to-end

`qoder-real/` contains the evidence from `scripts/e2e-qoder.mjs` against
qodercli 1.1.82 with `DeepSeek-Flash`:

- first run: completed, `QODER_E2E_OK`
- resume: completed, same session id/file, `QODER_RESUME_OK`
- daemon survived
- usage is the raw `result.usage` value; zeros are reported as unknown, not zero

Raw Qoder session content and credentials were not copied.

## 5. ACP research

Official documentation: https://docs.qoder.com/cli/acp and
https://docs.qoder.com/cli/sdk (Agent SDK).

Real 1.1.82 probes:

- `qodercli --acp` responds to `initialize` (protocolVersion 1) and
  `session/new`; it reports modes `default`, `acceptEdits`, `auto`, `dontAsk`,
  `yolo` (default `yolo`), model list, and session capabilities including
  `resume`, `fork`, `list`, `delete`, and `close`.
- `session/set_config_option` with `configId=mode, value=default` took effect.
- A Write tool call produced `session/request_permission`; allowing it completed
  the turn.
- An AskUserQuestion prompt did not produce a permission request over ACP in
  this probe; the model answered without a tool interaction.

ACP is therefore a credible future transport for approvals, but it is not
enabled in 0.6.6 and AskUserQuestion behavior needs more verification.
