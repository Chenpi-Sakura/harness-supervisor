#!/usr/bin/env node
/**
 * The `codex` shim installed for worker processes by worker-guard.ts.
 *
 * Denies the `queue` subcommand, appends one diagnostic line, and forwards
 * every other invocation to the real CLI. It is deliberately small: no state,
 * no daemon connection, no retries.
 */
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const realBin = process.env.HARNESS_SUPERVISOR_REAL_CODEX;
const logPath = process.env.HARNESS_SUPERVISOR_GUARD_LOG;
const workerId = process.env.HARNESS_SUPERVISOR_WORKER_ID;
const argv = process.argv.slice(2);

/** The subcommand is the first token that does not start with `-`. */
function subcommand(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg === "--") return undefined;
    if (arg.startsWith("-")) continue;
    return arg.toLowerCase();
  }
  return undefined;
}

function record(event: string, extra: Record<string, unknown> = {}): void {
  if (!logPath) return;
  try {
    appendFileSync(
      logPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        workerId: workerId ?? null,
        event,
        argv,
        cwd: process.cwd(),
        ...extra,
      })}\n`,
    );
  } catch {
    // Logging must not change the command outcome.
  }
}

if (subcommand(argv) === "queue") {
  record("codex_queue_denied");
  process.stderr.write(
    `[harness-supervisor] ${workerId ?? "worker"} may not call \`codex queue\`. ` +
      "Finish the run with your final answer; Harness Supervisor forwards completion, failure and input requests.\n",
  );
  process.exit(2);
}

if (!realBin) {
  record("guard_misconfigured");
  process.stderr.write(
    "[harness-supervisor] worker command guard is misconfigured (no real codex path); refusing to recurse.\n",
  );
  process.exit(127);
}

/** Best-effort cmd.exe quoting for the forwarded command. */
function quoteCmdArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

const child =
  process.platform === "win32"
    ? spawn([realBin, ...argv].map(quoteCmdArg).join(" "), {
        shell: true,
        stdio: "inherit",
        windowsHide: true,
      })
    : spawn(realBin, argv, { stdio: "inherit" });

child.on("error", (error) => {
  record("guard_forward_failed", { error: error.message });
  process.stderr.write(`[harness-supervisor] could not run codex: ${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});