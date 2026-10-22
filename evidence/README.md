# Test evidence

All artifacts here were produced by actual runs on 2026-10-21 and 2026-10-22 (Windows, Node v24.21.0, Pi 1.3.0, codex-cli 0.161.0; qodercli 1.1.75 for the protocol probe and 1.1.76 for the real worker/resume run).

## 1. Real Pi worker

- Command: `RUN_REAL_PI=1 REAL_PI_MODEL=deepseek-v4.1-flash-1017 REAL_PI_PROVIDER=new-api node test/run.mjs e2e`
- Result: worker `w-mvi7k7co-1cee0dd5` completed, `WORKER_DONE`, exit code 0, wrote `SUPERVISOR_E2E_OK`.
- See [real-pi-worker/result.json](real-pi-worker/result.json) and [real-pi-worker/test-run.txt](real-pi-worker/test-run.txt).
- Artifacts include the supervisor record, normalized event journal, the native Pi session file, and the file created by the worker.

## 2. Native Pi session loading / resume handshake

- Command: `RUN_REAL_PI=1 node test/run.mjs e2e --test-name-pattern "loads a persisted session"`
- No model call. The production adapter loads a persisted Pi session, verifies the original session ID and file path, then terminates the harness.
- See [real-pi-resume.txt](real-pi-resume.txt).

## 3. Real parent Pi -> Supervisor CLI -> child Pi

- Command: `npm run build && node scripts/e2e-parent-pi.mjs`
- Result: parent Pi exited 0 and replied `PARENT_E2E_OK`; child Pi completed with `WORKER_DONE`; child-created file is exactly `SUPERVISOR_E2E_OK`.
- See [parent-pi/result.json](parent-pi/result.json) and [parent-pi/test-run.txt](parent-pi/test-run.txt).
- The parent invoked the supervisor CLI through its native bash tool. The exact command is in [parent-pi/run-child-worker.sh](parent-pi/run-child-worker.sh).

## 4. Real Codex -> Supervisor MCP -> real Pi

- Command: `RUN_CODEX=1 CODEX_WORKER_MODE=real npm run e2e:codex`
- Host: `codex exec --json --ephemeral` on Windows with codex-cli 0.161.0. The Supervisor daemon was started outside Codex first, and the Codex MCP config pointed at that state directory.
- Result: Codex exited 0 after 4 MCP tool calls (`worker_spawn`, `worker_wait`, `worker_send`, `worker_wait`). Exactly one worker (`w-mvieseo3-af60d80a`) was created, it ran on the real Pi model, received `CODEX_STEER` while running (`run.message_sent`, seq 7), completed at seq 12 with `REAL_CODEX_OK`, and the daemon survived the Codex exit.
- Token usage reported by Codex: 79,662 input / 301 output.
- See [codex-real-pi/test-run.txt](codex-real-pi/test-run.txt), [codex-real-pi/events.jsonl](codex-real-pi/events.jsonl), [codex-real-pi/worker.json](codex-real-pi/worker.json), and [codex-real-pi/codex.jsonl](codex-real-pi/codex.jsonl).
- This validates the tested `codex exec` flow only; interactive Codex surfaces and other Codex versions are not covered by this evidence.

## 5. Codex auto-start boundary (not the recommended deployment)

- In an earlier run the MCP server was allowed to auto-start the daemon. After Codex exited, the daemon was gone with no shutdown log, `daemon.lock` still held the old PID, and a new client could not connect.
- Conclusion: `codex exec` 0.161.0 terminates the MCP server process tree on exit, including a detached auto-started daemon. Start the daemon outside Codex when workers must outlive the host session.
- The same run also captured the pre-fix wait behavior that spawned a duplicate worker; that defect is fixed and covered by the MCP wait test.
- See [codex-auto-start/test-run.txt](codex-auto-start/test-run.txt).

## 6. Codex desktop E2E suite

All five runs used the real Codex desktop app on Windows with MCP stdio, an externally pre-started daemon, and real Pi workers. The raw Codex sessions and native Pi conversations are not copied; each folder contains only sanitized MCP calls, supervisor events, result files, and Pi session metadata.

| Flow | Result | Evidence |
| --- | --- | --- |
| Spawn / wait / completion | completed `DESKTOP_DONE`; file exactly `SUPERVISOR_DESKTOP_OK` (21 bytes); one worker | [codex-desktop](codex-desktop/test-run.txt) |
| Mid-run steer | `worker_send` while `sleep 20` was running; `run.message_sent` seq 7 before completion seq 15; file `FIRST\nSTEERED_BY_CODEX\n` | [codex-desktop-steer](codex-desktop-steer/test-run.txt) |
| Cancel | queued steer cleared (`steering:1`); PID 38304 dead; one `run.cancelled`; duplicate cancel idempotent; control worker completed | [codex-desktop-cancel](codex-desktop-cancel/test-run.txt) |
| Resume | same Pi session id/file; `resumeCount=1`; new PID; code recalled from context without being in the resume prompt; seed file not replayed | [codex-desktop-resume](codex-desktop-resume/test-run.txt) |
| Client disconnect / reconnect | daemon PID and start time unchanged; worker PID 55768 continuous across app restart; reconnect wait returned the completed result | [codex-desktop-disconnect](codex-desktop-disconnect/test-run.txt) |

Scope: these runs validate client-side lifecycle flows, not daemon-crash recovery. The supervisor remains pull-only; every completion was retrieved by `worker_wait`, and no background wake-up is claimed.

## 7. Real coding delegation (Codex -> Pi)

- Repo: `D:\tmp\hs-coding-task` (independent git repo, baseline 11 tests: 8 pass / 3 fail).
- Codex (GPT-6 Luna) inspected the repo and delegated to a real Pi worker (DeepSeek `deepseek-v4.1-flash-1017`).
- Worker `w-mviyvtgt-89e1f44b` completed in 38.0 s with 7 turns and 8 tool calls; it changed only `src/duration.js` and did not modify tests or commit.
- Final acceptance: `npm test` 11/11 pass; `git diff -- test` empty.
- Codex tool calls: 6 total (2 MCP: spawn/wait; 2 shell: inspection/acceptance; 2 host: discovery/cell wait). Codex cumulative usage: 239,581 input (199,552 cached) / 891 output. Pi usage: 45,896 total tokens.
- The run exposed a 10 KB wait payload; the post-fix compact wait on the same event log is 4,047 chars / 2 events versus 10,936 chars / 27 events with progress (25 omitted).
- See [coding-delegation/test-run.txt](coding-delegation/test-run.txt), [coding-delegation/usage.json](coding-delegation/usage.json), [coding-delegation/compact-wait-check.json](coding-delegation/compact-wait-check.json), and [coding-delegation/git-diff.patch](coding-delegation/git-diff.patch).

## 8. Automated suite

The fake harnesses are scripted implementations of the documented Pi RPC subset and the Qoder stream-json/control subset. Every fake-harness test runs the production adapter, IPC daemon, supervisor state machine, CLI, or MCP server; it does not bypass the implementation.

- Baseline run (2026-10-21, before the lifecycle/race fixes): 38 tests, 36 pass, 0 fail, 2 skipped.
  Full output: [test-suite.txt](test-suite.txt).
- Desktop interaction round (2026-10-22, after the desktop interaction round and compact-wait change): 48 tests, 46 pass, 0 fail, 2 skipped (the gated real-Pi tests), 98.9s.
  Full output: [test-suite-races.txt](test-suite-races.txt).
- Qoder adapter round (2026-10-22): 62 tests, 60 pass, 0 fail, 2 skipped (the gated real-Pi tests).
  Full output: [test-suite-qoder.txt](test-suite-qoder.txt).

The added regression coverage:

- concurrent spawn requests cannot exceed `maxWorkers`;
- `send` and duplicate `answer` are rejected once cancellation starts;
- cancellation clears queued steering before abort and records `queue_cleared`;
- cancellation during startup wins before the prompt is accepted;
- concurrent duplicate cancels are idempotent (one `run.cancelled`);
- shutdown waits out an in-flight spawn and leaves no active worker;
- concurrent resumes produce one live runtime;
- an orphaned live PID cannot be cancelled and is not falsely reported as cancelled;
- MCP exposes server instructions and read-only annotations for the query tools;
- MCP `worker_wait` without a cursor reads current status and recent events first, returns new events incrementally, does not duplicate returned seqs, and does not cause a second spawn for the same task.
- MCP `worker_wait` omits `run.progress` by default, reports `eventsOmitted`, and returns progress when `includeProgress=true` or `types=["run.progress"]` is requested.
- Qoder stream-json init/session/tool/usage events are persisted, steer does not spawn a duplicate worker, cancellation clears only CLI-confirmed queued messages and kills the PID, resume reuses the same session id/file without replay, permission approval allow/deny works, and in-band "not logged in" results are failed rather than completed.
- Qoder records a session file that appears after the first turn in a different config root; the settle-time refresh persists the real path and a `worker.session` event with `refreshed:true`.

## 9. Real Qoder CLI protocol probe (no model call)

- Host: Windows, `qodercli 1.1.75`, no login, `--no-session-persistence`, empty tool set.
- The probe sent `control_request {type:"initialize"}` and one user message.
- Observed: `system/init`; `assistant` text `Not logged in · Please run /login`; `result` with `subtype:"success"`, `is_error:true`, `terminal_reason:"completed"` and no `errors` array.
- Conclusion: the real CLI accepts the initialize handshake; unauthenticated runs must be mapped to failed from `is_error`, not from the result subtype. No model was called and no Qoder session was persisted.
- See [qoder-protocol-probe/probe.txt](qoder-protocol-probe/probe.txt).
- This is not a completed worker, steer, cancel, permission, or resume validation.

### Real adapter failure-path probe (no model call)

- A real daemon was started with fresh temporary `QODER_CONFIG_DIR`/`QODERCN_CONFIG_DIR` (the user's Qoder config/session area was not used) and `node dist/src/cli.js spawn --runtime qoder ...` was invoked without login.
- Result: spawn exit 2 with `INVALID_STATE: Not logged in · Please run /login...`; worker `w-mvj2vt5f-45bad2e8` recorded as `failed` (`startup_failed`, exit code 1, `turns=0`); no `run.completed`; events show `session_init`, the assistant login message, `worker.started`/`worker.session`, `run.failed`, and `worker.exited`. The session-path field was recorded but no session file was persisted; `resumeAvailable` was false.
- The PID was already dead when the failed worker was listed and remained dead after daemon shutdown.
- See [qoder-real-adapter-probe/probe.txt](qoder-real-adapter-probe/probe.txt), [worker.json](qoder-real-adapter-probe/worker.json), [events.jsonl](qoder-real-adapter-probe/events.jsonl), and [result.json](qoder-real-adapter-probe/result.json).
- This validates real binary launch, initialize/system-init, env isolation, in-band auth error mapping, and cleanup. It does not validate a completed real model run, steering, cancellation, permission prompts, or resume.

## 10. Real Qoder worker + resume (executed 2026-10-22)

- Host: Windows, `qodercli 1.1.76`, login state in `~/.qoder`, model `DeepSeek-Flash`.
- Command: `env -u QODERCN_CONFIG_DIR -u QODER_CONFIG_DIR QODER_REAL=1 QODER_REAL_MODEL="DeepSeek-Flash" node scripts/e2e-qoder.mjs`.
- Worker `w-mvj3cs8c-bac88ff1`; spawn returned in 9.7s; first text-only run completed in 10.0s with `QODER_E2E_OK`.
- `resume` returned `QODER_RESUME_OK` with the same session id `cd9efaad-750d-4783-b305-b3ad44e0933a` and session file, `resumeCount=1`, and no replay of the first answer. The daemon stayed alive during the run.
- Qoder reported zero `usage` / `total_credits` fields for both turns; this is not a claim of zero token/cost usage.
- See [qoder-real/result.json](qoder-real/result.json), [qoder-real/events.jsonl](qoder-real/events.jsonl), and [qoder-real/test-run.txt](qoder-real/test-run.txt).
- Not validated: real steer, cancel, tool calls, or `can_use_tool` approval. The task was intentionally text-only, so no permission prompt was auto-approved.

> Note: the original temp state/work directories may be cleaned up; the artifacts relevant to each run are copied into these evidence folders.
