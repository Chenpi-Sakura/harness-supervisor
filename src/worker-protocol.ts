/**
 * Worker reporting protocol.
 *
 * A worker is an independent native harness: it decides how to work, but it
 * must not inject messages into the parent conversation behind the
 * supervisor's back. HS is the only supported producer of parent-side
 * notifications, so every task prompt starts with this short block.
 *
 * This is an instruction, not an enforcement boundary. The runtime guard in
 * worker-guard.ts is a best-effort backstop; neither is a security sandbox.
 */
export const WORKER_PROTOCOL_MARKER = "[harness-supervisor:worker-protocol]";

export const WORKER_PROTOCOL = `${WORKER_PROTOCOL_MARKER}
You are an independent worker managed by Harness Supervisor. Finish this run with your final answer; Harness Supervisor records progress and forwards completion, failure and input requests to the parent conversation. Do not call \`codex queue\` or any other host API to inject messages into the parent conversation, and do not start another Codex session for that purpose. When you need a decision, use your own harness's permission or input prompt.
[/harness-supervisor:worker-protocol]`;

/**
 * `HARNESS_SUPERVISOR_WORKER_PROTOCOL=0` restores the pre-protocol prompt. It
 * exists for compatibility and diagnosis, not as a normal workflow switch.
 */
export function workerProtocolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HARNESS_SUPERVISOR_WORKER_PROTOCOL !== "0";
}

/** Idempotent: a prompt that already carries the block is sent unchanged. */
export function withWorkerProtocol(prompt: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!workerProtocolEnabled(env)) return prompt;
  if (prompt.includes(WORKER_PROTOCOL_MARKER)) return prompt;
  return `${WORKER_PROTOCOL}\n\n${prompt}`;
}