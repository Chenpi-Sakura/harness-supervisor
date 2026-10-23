#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDaemon } from "./daemon.js";
import { SupervisorError, errorMessage } from "./errors.js";
import { SupervisorClient } from "./ipc/client.js";
import { resolveStateDir } from "./ipc/protocol.js";
import type { NotifyTarget, WorkerEvent, WorkerStatus, WorkerSummary } from "./types.js";
import { VERSION } from "./version.js";
import { silentLogger } from "./util/logger.js";

const EXIT_CODES: Record<WorkerStatus, number> = {
  starting: 0,
  running: 0,
  awaiting_input: 0,
  completed: 0,
  failed: 3,
  cancelled: 4,
  crashed: 5,
  orphaned: 5,
  interrupted: 5,
};

const HELP = `harness-supervisor v${VERSION}

Usage:
  harness-supervisor <command> [options]

Daemon:
  up                         Start the local daemon (detached) if needed
  down                       Gracefully stop the daemon (cancels active workers)
  daemon [--foreground]      Run the daemon in the foreground
  info                       Show daemon and runtime capabilities

Workers:
  spawn --prompt <text> [--cwd <dir>] [--name <n>] [--model <m>] [--provider <p>]
        [--tools <a,b>] [--thinking <level>] [--max-duration-ms <n>] [--runtime pi|qoder|mcode]
        [--extra-args '["--no-extensions"]'] [--request-id <key>] [--wait] [--json]
        [--notify-thread <verified-thread-id> | --notify-none]
  list [--status running,failed] [--limit 50] [--json]
  status <workerId> [--json]
  events <workerId> [--since <seq>] [--limit 100] [--json]
  wait <workerId> [--since <seq>] [--timeout-ms 30000] [--until terminal|event]
       [--types run.completed,run.failed] [--json]
  send <workerId> --message <text> [--mode steer|follow-up] [--request-id <key>]
  answer <workerId> --request-id <id> (--value <v> | --confirmed | --denied | --cancelled)
  cancel <workerId> [--timeout-ms 10000]
  resume <workerId> --prompt <text> [--model <m>] [--provider <p>] [--json]
        [--notify-thread <verified-thread-id> | --notify-none]
        Omit notification flags to preserve the original worker binding.

Notifications:
  inbox [--state pending|delivered|failed|all] [--worker <id>] [--limit 50] [--json]
  ack --ids <id1,id2> [--by <name>]
  notify-target [--channel none|codex-queue] [--thread <codexThreadId>] [--json]
        Set the default destination for NEW workers (existing bindings are kept) through the
        official "codex queue" CLI. The Codex host only runs the message while that
        thread is loaded; delivery is at-least-once and is not a wake guarantee.
  retry-notifications [--states pending,failed]

Maintenance:
  prune [--older-than-days 7] [--keep 20] [--dry-run] [--include-sessions] [--json]
        Remove old terminal workers and compact metadata logs. Active workers and
        workers with unacknowledged notifications are never removed.

Global:
  --state-dir <dir>          Supervisor state directory
                             (default: $HARNESS_SUPERVISOR_HOME or ~/.harness-supervisor)
  --json                     Machine-readable output
  --help                     Show this help

Prompt "-" reads the prompt from stdin. Worker spawn is asynchronous by default:
it returns once the prompt is accepted, not when the task completes. Use
"wait" or "status" to observe completion. Unbound workers use the durable inbox.
Queue delivery can start a new turn when the Codex host has the target loaded.
`;

interface CliValues {
  [key: string]: unknown;
}

function intArg(value: unknown, name: string, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new SupervisorError("BAD_REQUEST", `--${name} must be a number`);
  return Math.trunc(parsed);
}

function stringArg(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new SupervisorError("BAD_REQUEST", `--${name} must be a string`);
  return value;
}

function boolArg(value: unknown): boolean {
  return value === true;
}

function workerNotifyTarget(values: CliValues): NotifyTarget | undefined {
  const thread = stringArg(values["notify-thread"], "notify-thread");
  if (thread && boolArg(values["notify-none"])) {
    throw new SupervisorError("BAD_REQUEST", "Use only one of --notify-thread or --notify-none");
  }
  if (thread) return { channel: "codex-queue", codexThreadId: thread };
  if (boolArg(values["notify-none"])) return { channel: "none" };
  return undefined;
}

function parseList(value: unknown): string[] | undefined {
  const raw = stringArg(value, "tools");
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseExtraArgs(value: unknown): string[] | undefined {
  const raw = stringArg(value, "extra-args");
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SupervisorError("BAD_REQUEST", "--extra-args must be a JSON array of strings");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new SupervisorError("BAD_REQUEST", "--extra-args must be a JSON array of strings");
  }
  return parsed;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printWorker(worker: WorkerSummary): void {
  const lines = [
    `${worker.id}  ${worker.status}  runtime=${worker.runtime}${worker.name ? `  name=${worker.name}` : ""}`,
    `  cwd: ${worker.cwd}`,
    `  created: ${worker.createdAt}${worker.endedAt ? `  ended: ${worker.endedAt}` : ""}`,
    `  pid: ${worker.pid ?? "-"}  session: ${worker.sessionId ?? "-"}  resumable: ${worker.resumeAvailable ? "yes" : "no"}`,
  ];
  if (worker.pendingInput) {
    lines.push(
      `  pending input: ${worker.pendingInput.method} ${worker.pendingInput.requestId} ${worker.pendingInput.title ?? ""}`.trim(),
    );
  }
  if (worker.statusReason) lines.push(`  reason: ${worker.statusReason}`);
  if (worker.result) {
    const preview = worker.result.text.slice(0, 1200);
    lines.push(`  result: ${preview}${worker.result.text.length > 1200 ? "\n    [truncated in CLI display]" : ""}`);
  }
  if (worker.error) lines.push(`  error: ${worker.error}`);
  lines.push(`  events: ${worker.eventCount} (cursor ${worker.lastSeq})`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function summarizeEvent(event: WorkerEvent): string {
  if (!event.data) return "";
  const text = JSON.stringify(event.data);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function printEvents(events: WorkerEvent[]): void {
  for (const event of events) {
    process.stdout.write(
      `#${String(event.seq).padStart(4, "0")} ${event.ts} ${event.type} ${summarizeEvent(event)}\n`,
    );
  }
}

function exitForStatus(worker: WorkerSummary): void {
  process.exitCode = EXIT_CODES[worker.status] ?? 0;
}

async function readPrompt(
  prompt: string | undefined,
  positionalParts: string[],
): Promise<string> {
  const value = prompt ?? positionalParts.join(" ");
  if (!value) {
    throw new SupervisorError("BAD_REQUEST", "A prompt is required (--prompt <text> or --prompt -)");
  }
  if (value !== "-") return value;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function makeClient(stateDir: string, autoStart = true): Promise<SupervisorClient> {
  const client = new SupervisorClient({
    stateDir,
    autoStart,
    logger: silentLogger,
    connectTimeoutMs: 20_000,
  });
  await client.connect();
  return client;
}

async function waitLoop(
  client: SupervisorClient,
  workerId: string,
  overallTimeoutMs: number,
  sinceSeq = 0,
  print: boolean,
): Promise<{ worker: WorkerSummary; events: WorkerEvent[]; nextSeq: number; timedOut: boolean; terminal: boolean }> {
  const deadline = Date.now() + overallTimeoutMs;
  let cursor = sinceSeq;
  const seen: WorkerEvent[] = [];
  let last;
  while (Date.now() < deadline) {
    const remaining = Math.max(1000, Math.min(120_000, deadline - Date.now()));
    last = await client.request<
      { worker: WorkerSummary; events: WorkerEvent[]; nextSeq: number; timedOut: boolean; terminal: boolean }
    >(
      "wait",
      { workerId, sinceSeq: cursor, timeoutMs: remaining, until: "terminal" },
      { timeoutMs: remaining + 10_000 },
    );
    cursor = last.nextSeq;
    if (last.events.length) {
      seen.push(...last.events);
      if (print) printEvents(last.events);
    }
    if (last.terminal) {
      return { ...last, events: seen };
    }
    if (last.worker.status === "awaiting_input") {
      return { ...last, events: seen, timedOut: false };
    }
  }
  if (!last) {
    throw new SupervisorError("TIMEOUT", "Timed out waiting for worker");
  }
  return { ...last, events: seen, timedOut: true };
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        "state-dir": { type: "string" },
        json: { type: "boolean", short: "j" },
        help: { type: "boolean", short: "h" },
        cwd: { type: "string" },
        prompt: { type: "string" },
        name: { type: "string" },
        runtime: { type: "string" },
        model: { type: "string" },
        provider: { type: "string" },
        tools: { type: "string" },
        thinking: { type: "string" },
        "max-duration-ms": { type: "string" },
        "extra-args": { type: "string" },
        wait: { type: "boolean" },
        status: { type: "string" },
        limit: { type: "string" },
        since: { type: "string" },
        "timeout-ms": { type: "string" },
        until: { type: "string" },
        types: { type: "string" },
        message: { type: "string" },
        mode: { type: "string" },
        "request-id": { type: "string" },
        value: { type: "string" },
        confirmed: { type: "boolean" },
        denied: { type: "boolean" },
        cancelled: { type: "boolean" },
        foreground: { type: "boolean" },
        ids: { type: "string" },
        by: { type: "string" },
        channel: { type: "string" },
        thread: { type: "string" },
        "notify-thread": { type: "string" },
        "notify-none": { type: "boolean" },
        "older-than-days": { type: "string" },
        keep: { type: "string" },
        "dry-run": { type: "boolean" },
        "include-sessions": { type: "boolean" },
        state: { type: "string" },
        states: { type: "string" },
        worker: { type: "string" },
      },
    });
  } catch (error) {
    process.stderr.write(`error: ${errorMessage(error)}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const values = parsed.values as CliValues;
  const positionals = parsed.positionals;
  const command = positionals[0] ?? "help";
  if (boolArg(values.help) || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const stateDir = resolveStateDir(stringArg(values["state-dir"], "state-dir"));
  const json = boolArg(values.json);

  if (command === "daemon") {
    await runDaemon({ stateDir, foreground: true });
    return;
  }

  if (command === "down") {
    let client: SupervisorClient;
    try {
      client = await makeClient(stateDir, false);
    } catch (error) {
      if (error instanceof SupervisorError && /not running|no IPC token/i.test(error.message)) {
        process.stdout.write("Supervisor daemon is not running.\n");
        return;
      }
      throw error;
    }
    const result = await client.shutdown();
    if (json) printJson(result);
    else process.stdout.write("Supervisor daemon stopped.\n");
    return;
  }

  const client = await makeClient(stateDir, true);
  try {
    switch (command) {
      case "up":
      case "info": {
        const info = await client.request("info", {});
        if (json) printJson(info);
        else {
          const typed = info as {
            pid: number;
            stateDir: string;
            version: string;
            runtimes: Array<{ runtime: string; resume: boolean; pause: boolean }>;
          };
          process.stdout.write(
            `supervisor running  pid=${typed.pid}  version=${typed.version}\nstate: ${typed.stateDir}\n` +
              typed.runtimes
                .map(
                  (runtime) =>
                    `runtime ${runtime.runtime}: resume=${runtime.resume} pause=${runtime.pause}`,
                )
                .join("\n") +
              "\n",
          );
        }
        return;
      }
      case "spawn": {
        const prompt = await readPrompt(
          stringArg(values.prompt, "prompt"),
          positionals.slice(1),
        );
        const result = await client.request<WorkerSummary>(
          "spawn",
          {
            runtime: stringArg(values.runtime, "runtime") ?? "pi",
            cwd: stringArg(values.cwd, "cwd") ?? process.cwd(),
            prompt,
            name: stringArg(values.name, "name"),
            model: stringArg(values.model, "model"),
            provider: stringArg(values.provider, "provider"),
            tools: parseList(values.tools),
            thinking: stringArg(values.thinking, "thinking"),
            maxDurationMs: intArg(values["max-duration-ms"], "max-duration-ms"),
            extraArgs: parseExtraArgs(values["extra-args"]),
            notifyTarget: workerNotifyTarget(values),
            requestId: stringArg(values["request-id"], "request-id"),
          },
          { timeoutMs: 90_000 },
        );
        if (json && !boolArg(values.wait)) printJson(result);
        if (!json) {
          printWorker(result);
          if (!boolArg(values.wait)) {
            process.stdout.write(
              `\nUse "status ${result.id}" or "wait ${result.id}" to follow this worker.\n`,
            );
          }
        }
        if (boolArg(values.wait)) {
          const waited = await waitLoop(
            client,
            result.id,
            intArg(values["timeout-ms"], "timeout-ms", 600_000) ?? 600_000,
            0,
            !json,
          );
          if (json) printJson(waited);
          else {
            process.stdout.write(`\n`);
            printWorker(waited.worker);
          }
          exitForStatus(waited.worker);
        }
        return;
      }
      case "list": {
        const statuses = stringArg(values.status, "status")
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) as WorkerStatus[] | undefined;
        const workers = await client.request<WorkerSummary[]>("list", {
          statuses,
          limit: intArg(values.limit, "limit", 50),
        });
        if (json) printJson(workers);
        else if (workers.length === 0) process.stdout.write("No workers.\n");
        else {
          process.stdout.write(
            "ID                              STATUS           RUNTIME  AGE      NAME\n",
          );
          for (const worker of workers) {
            const ageMs = Date.now() - Date.parse(worker.createdAt);
            const age = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s` : `${Math.round(ageMs / 60_000)}m`;
            process.stdout.write(
              `${worker.id.padEnd(31)} ${worker.status.padEnd(16)} ${worker.runtime.padEnd(8)} ${age.padEnd(8)} ${worker.name ?? ""}\n`,
            );
          }
        }
        return;
      }
      case "status": {
        const workerId = positionals[1];
        if (!workerId) throw new SupervisorError("BAD_REQUEST", "workerId is required");
        const result = await client.request("status", { workerId, recentEvents: 20 });
        if (json) printJson(result);
        else {
          const typed = result as { worker: WorkerSummary; recentEvents: WorkerEvent[]; stderrTail: string };
          printWorker(typed.worker);
          process.stdout.write("\nRecent events:\n");
          printEvents(typed.recentEvents);
          if (typed.stderrTail.trim()) {
            process.stdout.write(`\nHarness stderr (tail):\n${typed.stderrTail.slice(-2000)}\n`);
          }
        }
        return;
      }
      case "events": {
        const workerId = positionals[1];
        if (!workerId) throw new SupervisorError("BAD_REQUEST", "workerId is required");
        const result = await client.request<{
          worker: WorkerSummary;
          events: WorkerEvent[];
          nextSeq: number;
          hasMore: boolean;
        }>("events", {
          workerId,
          sinceSeq: intArg(values.since, "since", 0),
          limit: intArg(values.limit, "limit", 100),
        });
        if (json) printJson(result);
        else {
          printEvents(result.events);
          process.stdout.write(
            `\ncursor=${result.nextSeq} hasMore=${result.hasMore} status=${result.worker.status}\n`,
          );
        }
        return;
      }
      case "wait": {
        const workerId = positionals[1];
        if (!workerId) throw new SupervisorError("BAD_REQUEST", "workerId is required");
        const timeoutMs = intArg(values["timeout-ms"], "timeout-ms", 30_000) ?? 30_000;
        const untilRaw = stringArg(values.until, "until") ?? "terminal";
        if (untilRaw !== "terminal" && untilRaw !== "event") {
          throw new SupervisorError("BAD_REQUEST", "--until must be terminal or event");
        }
        const types = stringArg(values.types, "types")
          ?.split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        const result = await client.request<{
          worker: WorkerSummary;
          events: WorkerEvent[];
          nextSeq: number;
          timedOut: boolean;
          terminal: boolean;
          hasMore: boolean;
        }>(
          "wait",
          {
            workerId,
            sinceSeq: intArg(values.since, "since"),
            timeoutMs,
            until: untilRaw,
            types,
          },
          { timeoutMs: timeoutMs + 10_000 },
        );
        if (json) printJson(result);
        else {
          printEvents(result.events);
          process.stdout.write(
            `\nstatus=${result.worker.status} terminal=${result.terminal} timedOut=${result.timedOut} cursor=${result.nextSeq}\n`,
          );
        }
        if (result.terminal) exitForStatus(result.worker);
        return;
      }
      case "send": {
        const workerId = positionals[1];
        if (!workerId) throw new SupervisorError("BAD_REQUEST", "workerId is required");
        const message =
          stringArg(values.message, "message") ?? positionals.slice(2).join(" ");
        const mode = (stringArg(values.mode, "mode") ?? "steer") as "steer" | "follow-up";
        if (mode !== "steer" && mode !== "follow-up") {
          throw new SupervisorError("BAD_REQUEST", "--mode must be steer or follow-up");
        }
        const result = await client.request<WorkerSummary>("send", {
          workerId,
          message,
          mode,
          requestId: stringArg(values["request-id"], "request-id"),
        });
        if (json) printJson(result);
        else process.stdout.write(`Sent ${mode} to ${workerId}; status=${result.status}.\n`);
        return;
      }
      case "answer": {
        const workerId = positionals[1];
        if (!workerId) throw new SupervisorError("BAD_REQUEST", "workerId is required");
        const requestId = stringArg(values["request-id"], "request-id");
        if (!requestId) throw new SupervisorError("BAD_REQUEST", "--request-id is required");
        const cancelled = boolArg(values.cancelled);
        const confirmed = boolArg(values.confirmed);
        const denied = boolArg(values.denied);
        const value = stringArg(values.value, "value");
        const modes = [cancelled, confirmed, denied, value !== undefined].filter(Boolean).length;
        if (modes !== 1) {
          throw new SupervisorError(
            "BAD_REQUEST",
            "Provide exactly one of --value, --confirmed, --denied, --cancelled",
          );
        }
        const response = cancelled
          ? { cancelled: true as const }
          : confirmed
            ? { confirmed: true }
            : denied
              ? { confirmed: false }
              : { value: value! };
        const result = await client.request<WorkerSummary>("answer", {
          workerId,
          requestId,
          response,
        });
        if (json) printJson(result);
        else process.stdout.write(`Answered ${requestId}; status=${result.status}.\n`);
        return;
      }
      case "cancel": {
        const workerId = positionals[1];
        if (!workerId) throw new SupervisorError("BAD_REQUEST", "workerId is required");
        const timeoutMs = intArg(values["timeout-ms"], "timeout-ms", 10_000);
        const result = await client.request<WorkerSummary>(
          "cancel",
          { workerId, timeoutMs },
          { timeoutMs: (timeoutMs ?? 10_000) + 15_000 },
        );
        if (json) printJson(result);
        else printWorker(result);
        return;
      }
      case "resume": {
        const workerId = positionals[1];
        if (!workerId) throw new SupervisorError("BAD_REQUEST", "workerId is required");
        const prompt = await readPrompt(
          stringArg(values.prompt, "prompt"),
          positionals.slice(2),
        );
        const result = await client.request<WorkerSummary>(
          "resume",
          {
            workerId,
            prompt,
            notifyTarget: workerNotifyTarget(values),
            model: stringArg(values.model, "model"),
            provider: stringArg(values.provider, "provider"),
            tools: parseList(values.tools),
            thinking: stringArg(values.thinking, "thinking"),
            maxDurationMs: intArg(values["max-duration-ms"], "max-duration-ms"),
            extraArgs: parseExtraArgs(values["extra-args"]),
            requestId: stringArg(values["request-id"], "request-id"),
          },
          { timeoutMs: 90_000 },
        );
        if (json) printJson(result);
        else printWorker(result);
        return;
      }
      case "inbox": {
        const state = (stringArg(values.state, "state") ?? "pending") as
          | "pending"
          | "delivered"
          | "failed"
          | "all";
        if (!["pending", "delivered", "failed", "all"].includes(state)) {
          throw new SupervisorError("BAD_REQUEST", "--state must be pending, delivered, failed or all");
        }
        const result = await client.request("notifications", {
          state,
          workerId: stringArg(values.worker, "worker"),
          limit: intArg(values.limit, "limit", 50),
        });
        if (json) printJson(result);
        else {
          const typed = result as {
            notifications: Array<{
              id: string;
              workerId: string;
              kind: string;
              createdAt: string;
              delivery: { state: string };
              ackAt?: string;
              summary: { text?: string };
            }>;
            counts: { pending: number; delivered: number; failed: number; unacked: number };
            target: { channel: string; codexThreadId?: string };
          };
          if (typed.notifications.length === 0) {
            process.stdout.write("No notifications.\n");
          } else {
            for (const item of typed.notifications) {
              const ack = item.ackAt ? " acked" : "";
              process.stdout.write(
                `${item.id}  ${item.kind}  delivery=${item.delivery.state}${ack}  ${item.createdAt}\n  ${(item.summary.text ?? "").slice(0, 300)}\n`,
              );
            }
          }
          process.stdout.write(
            `\ncounts: pending=${typed.counts.pending} delivered=${typed.counts.delivered} failed=${typed.counts.failed} unacked=${typed.counts.unacked}\n` +
              `target: channel=${typed.target.channel}${typed.target.codexThreadId ? ` thread=${typed.target.codexThreadId}` : ""}\n`,
          );
        }
        return;
      }
      case "ack": {
        const ids = (stringArg(values.ids, "ids") ?? positionals.slice(1).join(","))
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        if (ids.length === 0) throw new SupervisorError("BAD_REQUEST", "--ids is required");
        const result = await client.request("notification_ack", {
          ids,
          by: stringArg(values.by, "by") ?? "cli",
        });
        if (json) printJson(result);
        else {
          const typed = result as { acked: number; missing: string[] };
          process.stdout.write(`acked=${typed.acked}`);
          if (typed.missing.length > 0) process.stdout.write(` missing=${typed.missing.join(",")}`);
          process.stdout.write("\n");
        }
        return;
      }
      case "notify-target": {
        const channel = stringArg(values.channel, "channel");
        if (channel !== undefined && channel !== "none" && channel !== "codex-queue") {
          throw new SupervisorError("BAD_REQUEST", "--channel must be none or codex-queue");
        }
        const thread = stringArg(values.thread, "thread");
        if (channel === undefined && thread === undefined) {
          const current = await client.request("notifications", { state: "pending", limit: 1 });
          printJson((current as { target: unknown }).target);
          return;
        }
        const target = await client.request("notification_target", {
          channel,
          codexThreadId: thread,
        });
        if (json) printJson(target);
        else {
          const typed = target as { channel: string; codexThreadId?: string };
          process.stdout.write(
            `notification target: channel=${typed.channel}${typed.codexThreadId ? ` thread=${typed.codexThreadId}` : ""}\n`,
          );
        }
        return;
      }
      case "prune": {
        const result = await client.request(
          "prune",
          {
            olderThanDays: intArg(values["older-than-days"], "older-than-days", 7),
            keep: intArg(values.keep, "keep", 0),
            dryRun: boolArg(values["dry-run"]),
            includeSessions: boolArg(values["include-sessions"]),
          },
          { timeoutMs: 120_000 },
        );
        if (json) printJson(result);
        else {
          const typed = result as {
            dryRun: boolean;
            removed: string[];
            skipped: Array<{ workerId: string; reason: string }>;
            freedBytes: number;
            compacted: unknown;
          };
          process.stdout.write(
            `${typed.dryRun ? "would remove" : "removed"}=${typed.removed.length} skipped=${typed.skipped.length} freedBytes=${typed.freedBytes}\n`,
          );
          for (const id of typed.removed) process.stdout.write(`  - ${id}\n`);
          if (typed.compacted) {
            process.stdout.write(`compacted: ${JSON.stringify(typed.compacted)}\n`);
          }
        }
        return;
      }
      case "retry-notifications": {
        const states = stringArg(values.states, "states")
          ?.split(",")
          .map((item) => item.trim())
          .filter(Boolean) as Array<"pending" | "delivered" | "failed"> | undefined;
        const result = await client.request("notification_retry", { states });
        if (json) printJson(result);
        else process.stdout.write(`retried=${(result as { retried: number }).retried}\n`);
        return;
      }
      default:
        process.stderr.write(`error: unknown command "${command}"\n\n${HELP}`);
        process.exitCode = 2;
    }
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SupervisorError) {
    process.stderr.write(`error [${error.code}]: ${error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  } else {
    process.stderr.write(`error: ${errorMessage(error)}\n`);
  }
  process.exitCode = 2;
});
