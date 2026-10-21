# Test evidence

All artifacts here were produced by actual runs on 2026-10-21 (Windows, Node v24.21.0, Pi 1.3.0).

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

## 4. Automated suite

The fake harness is a scripted implementation of the documented Pi RPC subset. Every fake-harness test runs the production Pi adapter, IPC daemon, supervisor state machine, CLI, or MCP server; it does not bypass the implementation.

- Baseline run (2026-10-21, before the lifecycle/race fixes): 38 tests, 36 pass, 0 fail, 2 skipped.
  Full output: [test-suite.txt](test-suite.txt).
- Current run (2026-10-22, after the fixes): 47 tests, 45 pass, 0 fail, 2 skipped (the gated real-Pi tests).
  Full output: [test-suite-races.txt](test-suite-races.txt).

The added regression coverage:

- concurrent spawn requests cannot exceed `maxWorkers`;
- `send` and duplicate `answer` are rejected once cancellation starts;
- cancellation clears queued steering before abort and records `queue_cleared`;
- cancellation during startup wins before the prompt is accepted;
- concurrent duplicate cancels are idempotent (one `run.cancelled`);
- shutdown waits out an in-flight spawn and leaves no active worker;
- concurrent resumes produce one live runtime;
- an orphaned live PID cannot be cancelled and is not falsely reported as cancelled.

> Note: the original temp state/work directories may be cleaned up; the artifacts relevant to each run are copied into these evidence folders.
