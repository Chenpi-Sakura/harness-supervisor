# Test evidence

All artifacts here were produced by actual runs between 2026-10-21 and 2026-11-10 (Windows; Node, Pi, Codex, Qoder and other runtime versions are recorded in each section).

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

## 11. Codex wake feasibility probe (2026-10-22)

- Host: Windows, `codex-cli 0.161.0` with the desktop app's `codex app-server` running, model `gpt-6-luna` (low effort, minimal prompts).
- E1: a thread created by `codex exec` was messaged with `codex queue --thread <id> --message ...` after the process exited. The message was persisted in `~/.codex/queue_1.sqlite` but no turn started and the rollout did not grow for 15+ seconds.
- E2: a probe app-server loaded a thread and finished a turn. An external `codex queue` call started a new turn automatically ~2.5s later (queue item drained).
- Conclusion: A-level wake has a supported path (`codex queue` + a host that has the thread loaded); it does not require process injection or DB edits. Desktop GUI verification (thread still loaded after the turn ends) is still pending.
- See [codex-wake-probe/README.md](codex-wake-probe/README.md), [codex-wake-probe/e1-exec-thread.jsonl.txt](codex-wake-probe/e1-exec-thread.jsonl.txt), and [codex-wake-probe/e2-auto-drain.txt](codex-wake-probe/e2-auto-drain.txt).

## 12. Real Qoder interaction E2E (executed 2026-10-22)

- Host: Windows, `qodercli 1.1.76`, model `DeepSeek-Flash`, isolated daemons (`permission mode auto` and `default`).
- Command: `QODER_REAL=1 QODER_REAL_MODEL=DeepSeek-Flash npm run e2e:qoder:interactions`.
- Verified: real Bash tool call returned `HS_QODER_TOOL_OK`; cancel during a run with a queued follow-up ended `cancelled`, process not alive, queued text never executed; `AskUserQuestion` surfaced as `run.needs_input` with options Red/Blue and the answer `Blue` reached the model (`Blue.`).
- Accepted but ineffective: steer and follow-up produced `run.message_sent` but did not change the answer or start a second turn (`extraTurns=1`); an immediate steer probe confirmed the same result.
- Not verified: permission allow/deny. Under `permission mode=default` a Bash `echo` call produced no `can_use_tool` request, so the approval path was not exercised end to end.
- See [qoder-interactions/README.md](qoder-interactions/README.md), [qoder-interactions/summary.json](qoder-interactions/summary.json), [qoder-interactions/steer-immediate.txt](qoder-interactions/steer-immediate.txt), and [qoder-interactions/run.log](qoder-interactions/run.log).

## 13. Codex wake end-to-end (executed 2026-10-22)

- Command: `npm run e2e:codex:wake` (real `codex app-server` session with the real HS MCP server attached, simulated slow worker, isolated state dirs).
- Timeline: Codex turn 1 ended 07:25:55, worker finished after that, HS delivered one notification via `codex queue` at 07:26:35, and Codex started turn 2 **by itself** at 07:26:43 and answered `Worker w-mvj7vkgn-70fba0e8 completed successfully. Result: FAKE_PI_OK.`
- Inbox: `delivered=1, pending=0, failed=0`; `turnsStarted=2`.
- See [codex-wake-e2e/README.md](codex-wake-e2e/README.md), [codex-wake-e2e/result-late-worker.json](codex-wake-e2e/result-late-worker.json) and [codex-wake-e2e/result.json](codex-wake-e2e/result.json).
- Remaining gap: confirmation that the Codex *desktop window* keeps the thread loaded after a turn ends (the mechanism itself is proven; the session here is an app-server session managed by the probe).

## 14. Task metrics phase 1-2 (executed 2026-10-27)

- Version 0.5.0, isolated daemons and temporary state directories; production daemon untouched.
- Fake Pi: spawn auto-created a task; `run.usage` recorded input=10/output=5/total=15 as `partial`; report kept token categories separate and warned that parent usage was unknown.
- Real Qoder single text-only turn: `qodercli 1.1.78`, `DeepSeek-Flash`, worker `w-mvqa1ni2-6f884c43`, task `t-mvqa1ni2-7327a31e`, final text `METRICS_REAL_OK`.
- Qoder reported all-zero token fields. The metrics record stored `null` for every token field, `confidence=unverified`, and the report counted it as unverified rather than known zero usage.
- The task's end-to-end time was 19,227ms, worker run 6,298ms, single-worker waiting 12,929ms. These are timings, not token/cost measurements.
- Automated: metrics unit 12, metrics integration 5, metrics CLI 1, metrics MCP 1; full regression 253 tests (251 pass, 0 fail, 2 skipped real-Pi E2E).
- See [metrics-phase12-261025/README.md](metrics-phase12-261025/README.md), [qoder-real-task.json](metrics-phase12-261025/qoder-real-task.json), and [qoder-real-report.json](metrics-phase12-261025/qoder-real-report.json).
- Not validated: real Pi token accounting, non-zero Qoder tokens, real main-agent usage entry, cost, acceptance, rework or intervention metrics.
- MiniMax Code: a real 0.6.13 ACP probe (2026-10-27) is archived separately; see section 15.

## 15. MiniMax Code 0.6.13 token-usage probe (executed 2026-10-27)

- One real text-only ACP turn with the latest installed MiniMax Code (`0.6.13`, matching `.minimax-code/current`), isolated temp workspace.
- `session/prompt` result contained only `stopReason: "end_turn"`; no `usage`.
- Two `usage_update` records contained context occupancy `used=20269`/`size=1000000` and `cost={amount:0,currency:"USD"}`; no input/output/reasoning/cache token breakdown.
- Conclusion: the ACP path used by HS cannot attribute Token usage for mcode; mcode tokens remain `unknown` rather than zero. The headless `exec --output-format json` usage path was not used because HS runs mcode over ACP and does not read its private session store.
- See [mcode-usage-probe-261027/README.md](mcode-usage-probe-261027/README.md) and [probe.json](mcode-usage-probe-261027/probe.json).

## 16. Qoder CLI 1.1.78 re-run (executed 2026-10-25)

- Host: Windows, `qodercli 1.1.78`, model `DeepSeek-Flash`; both runs used isolated daemons and temporary state directories, and the production daemon was untouched.
- Text-only worker `w-mvnp0m2o-ef4da8e3`: spawn returned in 7.3s, the first run completed in 7.5s with `QODER_E2E_OK`; `resume` returned `QODER_RESUME_OK` with the same session `9aae0c2c-bd76-4ad2-a871-afdbb131e7bd` and `resumeCount=1`, and the daemon stayed alive. Qoder again reported all-zero `usage` fields; that means it reported no token/cost values, not that usage was zero.
- Interaction suite (`QODER_REAL=1 QODER_REAL_MODEL=DeepSeek-Flash npm run e2e:qoder:interactions`) repeated the section 12 scenarios on 1.1.78: the real Bash tool call completed; steer and follow-up produced `run.message_sent` but did not change the answer (`reflected=false`, follow-up `extraTurns=1`); cancel with a queued follow-up ended `cancelled` with no live process; `AskUserQuestion` surfaced Red/Blue and `Blue` reached the model.
- Still not verified: permission allow/deny. No `can_use_tool` request was observed in either attempt.
- See [qoder-real-1.1.78/result.json](qoder-real-1.1.78/result.json), [qoder-real-1.1.78/events.jsonl](qoder-real-1.1.78/events.jsonl), [qoder-real-1.1.78/test-run.txt](qoder-real-1.1.78/test-run.txt), [qoder-interactions-1.1.78/summary.json](qoder-interactions-1.1.78/summary.json), and [qoder-interactions-1.1.78/run.log](qoder-interactions-1.1.78/run.log).

## 17. Persistent Worker 3-turn E2E 与 0.8.0 state compatibility (executed 2026-11-09)

- Code: `feat-261109-hs-09`, version 0.8.0, Windows 10.0.26300 x64, Node v24.22.1. All runs used isolated temporary state/work directories; the production daemon and state directory were untouched.
- Commands: `node scripts/e2e-persistent-pi.mjs --runtime pi|qoder|mcode|dsh`.
- Result: all four real harnesses completed three Turns on one stable worker and session, recalled both random codewords without restatement, exited the activation process after every Turn (`pidAlive=false`), and reported `resumeCount=2`. Pi 1.4.0, Qoder CLI 1.1.82 (ACP), MiniMax Code 0.7.0, DSH desktop bundle 0.2.1-rc.5.
- Worker ids: Pi `w-mw996096-57b21ada`, Qoder `w-mw99699n-93f73f35`, MiniMax Code `w-mw9974la-a819cf5c`, DSH `w-mw997q5i-26bce24a`.
- Real 0.8.0 state compatibility: a daemon built from `main@7649b34` wrote worker `w-mw98z9yv-6408f3dc` and its inbox record; the 0.9 RC daemon opened the same state directory, read it as `oneshot`, rejected `continue` with `UNSUPPORTED`, resumed the same session to `RESUMED FAKE_PI_OK`, and used the persisted checkpoint (`checkpointed=1, scanned=0`) on the next start without duplicating notifications.
- See [persistent-worker-261109/README.md](persistent-worker-261109/README.md), the four [run-*.json](persistent-worker-261109/) files and [legacy-state-probe.json](persistent-worker-261109/legacy-state-probe.json).
- Not covered: Stage 3 thread switch/unload/full exit (Stage 1/2 are recorded in section 18) and downgrade to an older daemon after compaction. The 331 MB production startup is recorded in section 19. The desktop acceptance steps are in `docs/2026-11-09-desktop-e2e-runbook.md`.

## 18. Codex Desktop Stage 1/2 (executed 2026-11-10)

- Real Codex Desktop threads; acceptance build `0.8.0` in `D:/tmp/hs-09-rc-state`; release version `0.9.0` differs only in the version number; the production daemon and state directory were untouched during Stage 1/2 (the target production deployment is in section 19).
- Stage 1: two Pi persistent Workers were spawned by two threads with spawn-only turns. Both threads auto-started new turns without user input, each notification stayed on its own thread, and Thread A's `worker_continue` kept the same worker/session (`resumeCount=1`, both tokens recalled).
- Stage 2: one DSH persistent Worker. Its `needs_input` wake arrived after the continue turn ended; the first run exercised the Reject path. A retry answered `Allow once` (`value`, not `confirmed`), wrote `C:\Users\Lenovo\hs-09-rc-outside.txt` with `RC_DSH_OK`, completed, and woke the thread again on the same session (`resumeCount=2`).
- All 8 notifications had `attempts=1`, were `delivered` to the correct thread, and were acknowledged. S3 was verified by automatic new turns; S4 by `worker_status` / `worker_events` plus ACK. `delivered` alone was not treated as wake evidence.
- Stage 3 (thread switch/unload/full exit) was not re-run this round; it follows the earlier verification and has no new 0.9 evidence.
- See [desktop-stage1-2-261110/README.md](desktop-stage1-2-261110/README.md) and the RC report section 16.

## 19. HS 0.9.0 production deployment and 331 MB cold start (2026-11-10, maintainer report)

- Code `cd8d5b4` / tag `v0.9.0`; target production environment: 82 workers, 0 active, daemon 0.9.0 PID 32948, `warnings=0`; backup `state-20261110-123310.zip` 37.6 MB retained.
- Cold start: 0.8.0 baseline 27s; 0.9.0 first 16.7s (`0/82`, one-time checkpoint, still above 15s); 0.9.0 again 0.48s (`82/0`; `storeInit` 433 ms, `reconcile` 10/16 ms).
- Post-upgrade checks: `list` 82/0 active; legacy records read as `oneshot` / `idle` / `restorable`; `events` `nextSeq` continuous; `inbox` 16 pending / 265 delivered / 1 superseded / 22 unacked; persistent E2E kept the same worker/session, recalled `K7QM-5652`, `resumeCount=1`, 2 closed run segments.
- Pending: `compact --dry-run` reports 2,123,215 events / 321,291,500 bytes; backup retained; not executed.
- Evidence source: maintainer deployment record for the target environment. The default state directory on this development machine is a separate 15-worker / 5.2 MB instance (0.9.0 PID 72752); it was not used for the 331 MB conclusion, and the backup was not found locally.
- See [docs/2026-11-10-0.9.0-production-deployment.md](../docs/2026-11-10-0.9.0-production-deployment.md).

> Note: the original temp state/work directories may be cleaned up; the artifacts relevant to each run are copied into these evidence folders.
