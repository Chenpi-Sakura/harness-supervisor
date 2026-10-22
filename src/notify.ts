import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SupervisorError, errorMessage } from "./errors.js";
import type {
  NotificationDeliveryState,
  NotificationKind,
  NotificationRecord,
  NotifyTarget,
  WorkerEvent,
  WorkerStatus,
} from "./types.js";
import { safeText } from "./util/redact.js";
import type { Logger } from "./util/logger.js";

/**
 * Notification kinds are the important, low-frequency lifecycle events that a
 * long-running consumer should never miss. Ordinary progress is deliberately
 * excluded: it stays in the per-worker event log and must not wake anyone.
 */
export interface NotifierOptions {
  stateDir: string;
  logger: Logger;
  /** Delivery channel; defaults to the inbox only. */
  channel?: "none" | "codex-queue";
  codexThreadId?: string;
  codexBin?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
  onNewNotification?: (notification: NotificationRecord) => void;
}

const MAX_SUMMARY_CHARS = 600;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_DELIVERY_OUTPUT = 2000;

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,120}$/;

/** Only these event types create notifications; ordinary progress never does. */
const EVENT_KIND: Record<string, NotificationKind> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "worker.crashed": "crashed",
  "run.needs_input": "needs_input",
  "worker.orphaned": "detached",
  "worker.interrupted": "detached",
};

export function notificationKindFor(eventType: string): NotificationKind | undefined {
  return EVENT_KIND[eventType];
}

export function notificationId(workerId: string, seq: number): string {
  return `${workerId}#${seq}`;
}

/**
 * Durable inbox of important worker events plus an optional delivery channel.
 *
 * Delivery semantics are explicit and not stronger than reality:
 * - a record is created exactly once per (worker, seq) because ids are derived;
 * - the inbox itself is at-least-once readable until acknowledged;
 * - `codex-queue` delivery is best effort: it records success once the Codex CLI
 *   accepted the message, and it may deliver twice if the daemon dies between
 *   the CLI call and the state write;
 * - delivery never implies that the host woke the main agent.
 */
export class Notifier {
  readonly stateDir: string;
  private readonly file: string;
  private readonly targetFile: string;
  private readonly logger: Logger;
  private readonly records = new Map<string, NotificationRecord>();
  private readonly writeChain = { current: Promise.resolve() as Promise<void> };
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private started = false;
  private target: NotifyTarget;
  private readonly codexBin: string;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly onNewNotification?: (notification: NotificationRecord) => void;

  constructor(options: NotifierOptions) {
    this.stateDir = path.resolve(options.stateDir);
    this.file = path.join(this.stateDir, "notifications.jsonl");
    this.targetFile = path.join(this.stateDir, "notify-target.json");
    this.logger = options.logger;
    this.target = {
      channel: options.channel ?? "none",
      codexThreadId: options.codexThreadId,
    };
    this.codexBin = options.codexBin ?? process.env.HARNESS_SUPERVISOR_CODEX_BIN ?? "codex";
    this.maxAttempts =
      options.maxAttempts ?? intEnv("HARNESS_SUPERVISOR_NOTIFY_MAX_ATTEMPTS", MAX_ATTEMPTS, 1, 10);
    this.retryDelayMs =
      options.retryDelayMs ??
      intEnv("HARNESS_SUPERVISOR_NOTIFY_RETRY_MS", 5_000, 200, MAX_RETRY_DELAY_MS);
    this.onNewNotification = options.onNewNotification;
  }

  async init(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await this.loadRecords();
    await this.loadTarget();
    this.started = true;
  }

  getTarget(): NotifyTarget {
    return { ...this.target };
  }

  async setTarget(input: { channel?: "none" | "codex-queue"; codexThreadId?: string | null }): Promise<NotifyTarget> {
    if (input.channel !== undefined) this.target.channel = input.channel;
    if (input.codexThreadId !== undefined) {
      if (input.codexThreadId === null) {
        this.target.codexThreadId = undefined;
      } else {
        const trimmed = input.codexThreadId.trim();
        if (!THREAD_ID_PATTERN.test(trimmed)) {
          throw new SupervisorError(
            "BAD_REQUEST",
            "codexThreadId must look like a Codex thread UUID or session name",
          );
        }
        this.target.codexThreadId = trimmed;
      }
    }
    if (this.target.channel === "codex-queue" && !this.target.codexThreadId) {
      throw new SupervisorError(
        "BAD_REQUEST",
        "channel codex-queue requires codexThreadId (use notification_target to set it)",
      );
    }
    this.target.updatedAt = new Date().toISOString();
    await this.persistTarget();
    if (this.target.channel === "codex-queue" && this.target.codexThreadId) {
      void this.retryPending(["pending"]).catch((error: unknown) => {
        this.logger.warn("Failed to retry pending notifications after target update", {
          error: errorMessage(error),
        });
      });
    }
    return this.getTarget();
  }

  /**
   * Create notifications for important events that do not have one yet.
   * Safe to call repeatedly; used both live and while reconciling after restart.
   */
  ingest(worker: { id: string; runtime: string; status: WorkerStatus }, event: WorkerEvent): NotificationRecord | null {
    const kind = notificationKindFor(event.type);
    if (!kind) return null;
    const id = notificationId(worker.id, event.seq);
    const existing = this.records.get(id);
    if (existing) return existing;
    const record: NotificationRecord = {
      id,
      workerId: worker.id,
      runtime: worker.runtime,
      seq: event.seq,
      eventType: event.type,
      kind,
      createdAt: event.ts,
      summary: summarize(event, kind, worker.status),
      delivery: { state: "pending", channel: this.target.channel, attempts: 0 },
    };
    this.records.set(id, record);
    void this.persist(record);
    this.onNewNotification?.(record);
    if (this.started && this.target.channel !== "none") {
      void this.deliver(id).catch((error: unknown) => {
        this.logger.warn(`Notification delivery failed for ${id}`, {
          error: errorMessage(error),
        });
      });
    }
    return record;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  /** Workers that still have an unacknowledged notification. */
  unackedWorkerIds(): Set<string> {
    return new Set(
      [...this.records.values()].filter((record) => !record.ackAt).map((record) => record.workerId),
    );
  }

  /**
   * Rewrite the inbox file, dropping only old *acknowledged* records.
   * Unacknowledged records are never removed, regardless of age.
   */
  async compact(options: { olderThanDays?: number } = {}): Promise<{ kept: number; dropped: number }> {
    const olderThanDays = Math.max(0, options.olderThanDays ?? 30);
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let dropped = 0;
    for (const [id, record] of [...this.records.entries()]) {
      if (!record.ackAt) continue;
      const ackMs = Date.parse(record.ackAt);
      if (!Number.isNaN(ackMs) && ackMs < cutoff) {
        this.records.delete(id);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      const snapshot = [...this.records.values()]
        .map((record) => JSON.stringify(record))
        .join("\n");
      await this.rewrite(snapshot ? `${snapshot}\n` : "");
    }
    return { kept: this.records.size, dropped };
  }

  list(filter: { state?: "pending" | "delivered" | "failed" | "all"; workerId?: string; limit?: number } = {}): NotificationRecord[] {
    const state = filter.state ?? "pending";
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    return [...this.records.values()]
      .filter((record) => {
        // The default view is the *actionable* inbox: acknowledged records must
        // never show up again, otherwise a reconnecting consumer would process
        // them forever. Acknowledged records stay readable for diagnostics via
        // state="all"/"delivered"/"failed".
        if (state === "all") return true;
        if (state === "pending") return record.delivery.state === "pending" && !record.ackAt;
        return record.delivery.state === state;
      })
      .filter((record) => (filter.workerId ? record.workerId === filter.workerId : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  counts(): { pending: number; delivered: number; failed: number; unacked: number } {
    let pending = 0;
    let delivered = 0;
    let failed = 0;
    let unacked = 0;
    for (const record of this.records.values()) {
      if (record.delivery.state === "delivered") delivered += 1;
      else if (record.delivery.state === "failed") failed += 1;
      else if (!record.ackAt) pending += 1;
      if (!record.ackAt) unacked += 1;
    }
    return { pending, delivered, failed, unacked };
  }

  async ack(ids: string[], by?: string): Promise<{ acked: number; missing: string[] }> {
    const missing: string[] = [];
    const now = new Date().toISOString();
    const changed: NotificationRecord[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) {
        missing.push(id);
        continue;
      }
      if (record.ackAt) continue;
      record.ackAt = now;
      if (by) record.ackBy = safeText(by, 100);
      changed.push(record);
    }
    for (const record of changed) void this.persist(record);
    await this.flush();
    return { acked: changed.length, missing };
  }

  /**
   * Re-deliver notifications that were never delivered (daemon restart, offline host,
   * channel switch). Acknowledged records are never re-delivered.
   *
   * `resetFailed` is the explicit manual retry path (`retry-notifications --states failed`):
   * a failed record gets a fresh attempt budget instead of being permanently stuck at
   * `attempts === maxAttempts`.
   */
  async retryPending(
    states: NotificationDeliveryState[] = ["pending"],
    options: { resetFailed?: boolean } = {},
  ): Promise<number> {
    if (this.target.channel === "none") return 0;
    const wanted = new Set(states);
    const resetFailed = options.resetFailed ?? wanted.has("failed");
    const candidates = [...this.records.values()].filter((record) => {
      if (record.ackAt) return false;
      if (!wanted.has(record.delivery.state)) return false;
      if (record.delivery.state === "failed") return resetFailed;
      return record.delivery.attempts < this.maxAttempts;
    });
    for (const record of candidates) {
      if (record.delivery.state === "failed" && resetFailed) {
        record.delivery.state = "pending";
        record.delivery.attempts = 0;
        record.delivery.lastError = undefined;
        void this.persist(record);
      }
      await this.deliver(record.id).catch((error: unknown) => {
        this.logger.warn(`Notification retry failed for ${record.id}`, {
          error: errorMessage(error),
        });
      });
    }
    return candidates.length;
  }

  async deliver(id: string): Promise<NotificationRecord | null> {
    const record = this.records.get(id);
    if (!record || this.inFlight.has(id)) return record ?? null;
    // Acknowledged notifications are finished work; never send them again.
    if (record.ackAt) return record;
    if (record.delivery.state === "delivered") return record;
    if (this.target.channel === "none") return record;
    if (this.target.channel === "codex-queue" && !this.target.codexThreadId) {
      record.delivery.lastError = "no codexThreadId configured";
      void this.persist(record);
      return record;
    }
    this.inFlight.add(id);
    try {
      const message = renderMessage(record);
      const result = await this.runCodexQueue(this.target.codexThreadId!, message);
      record.delivery.attempts += 1;
      record.delivery.lastAttemptAt = new Date().toISOString();
      record.delivery.channel = this.target.channel;
      if (result.ok) {
        record.delivery.state = "delivered";
        record.delivery.lastError = undefined;
        record.delivery.messageId = result.messageId;
        this.clearRetryTimer(id);
      } else {
        record.delivery.lastError = result.error;
        record.delivery.state =
          record.delivery.attempts >= this.maxAttempts ? "failed" : "pending";
        if (record.delivery.state === "pending") this.scheduleRetry(id, record.delivery.attempts);
      }
      void this.persist(record);
      await this.flush();
      return record;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async flush(): Promise<void> {
    await this.writeChain.current;
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private scheduleRetry(id: string, attempt: number): void {
    if (this.timers.has(id)) return;
    const delay = Math.min(this.retryDelayMs * attempt, MAX_RETRY_DELAY_MS);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const record = this.records.get(id);
      if (!record || record.delivery.state !== "pending") return;
      void this.deliver(id).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private clearRetryTimer(id: string): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(id);
  }

  private async runCodexQueue(
    threadId: string,
    message: string,
  ): Promise<{ ok: boolean; error?: string; messageId?: string }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: { ok: boolean; error?: string; messageId?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      // The Codex binary may be an npm shim (.cmd) that needs a shell on Windows,
      // and hosts may configure a command line (e.g. an absolute node + script).
      // Every argument is validated or sanitized before it reaches this point.
      const args = ["queue", "--thread", threadId, "--message", sanitizeArg(message)];
      const command = [this.codexBin, ...args.map(quoteCmdArg)].join(" ");
      const child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
        finish({ ok: false, error: "codex queue timed out" });
      }, 20_000);
      timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = cap(stdout + chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = cap(stderr + chunk.toString("utf8"));
      });
      child.on("error", (error) => finish({ ok: false, error: `codex queue failed to start: ${error.message}` }));
      child.on("close", (code) => {
        if (code === 0) {
          const match = /Queued message (\S+) for thread/.exec(stdout);
          finish({ ok: true, messageId: match?.[1] });
        } else {
          finish({
            ok: false,
            error: `codex queue exited with code ${code}: ${safeText(stderr || stdout, 400)}`,
          });
        }
      });
    });
  }

  private rewrite(content: string): Promise<void> {
    this.writeChain.current = this.writeChain.current
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.file, content))
      .catch((error: unknown) => {
        this.logger.error("Failed to compact notification inbox", { error: errorMessage(error) });
      });
    return this.writeChain.current;
  }

  private async loadRecords(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as NotificationRecord;
        if (!record || typeof record.id !== "string" || typeof record.workerId !== "string") continue;
        this.records.set(record.id, record);
      } catch {
        // A partially written trailing line is expected after a crash.
      }
    }
  }

  private async loadTarget(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.targetFile, "utf8")) as NotifyTarget;
      if (parsed && (parsed.channel === "none" || parsed.channel === "codex-queue")) {
        if (parsed.codexThreadId && !THREAD_ID_PATTERN.test(parsed.codexThreadId)) {
          this.logger.warn("Ignoring invalid persisted notification target", {
            codexThreadId: parsed.codexThreadId,
          });
        } else if (parsed.channel === "codex-queue" && !parsed.codexThreadId) {
          this.logger.warn("Ignoring persisted codex-queue target without a thread id");
          this.target = { channel: "none" };
        } else {
          this.target = { channel: parsed.channel, codexThreadId: parsed.codexThreadId, updatedAt: parsed.updatedAt };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("Failed to read notification target", { error: errorMessage(error) });
      }
    }
  }

  private async persistTarget(): Promise<void> {
    const snapshot = { ...this.target };
    this.writeChain.current = this.writeChain.current
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.targetFile, `${JSON.stringify(snapshot, null, 2)}\n`));
    await this.writeChain.current;
  }

  private persist(record: NotificationRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.writeChain.current = this.writeChain.current
      .catch(() => undefined)
      .then(() => appendFile(this.file, line, "utf8"))
      .catch((error: unknown) => {
        this.logger.error(`Failed to persist notification ${record.id}`, {
          error: errorMessage(error),
        });
      });
    return this.writeChain.current;
  }
}

function summarize(
  event: WorkerEvent,
  kind: NotificationKind,
  workerStatus: WorkerStatus,
): NotificationRecord["summary"] {
  const data = event.data ?? {};
  const summary: NotificationRecord["summary"] = { status: workerStatus };
  if (kind === "needs_input") {
    summary.requestId = typeof data.requestId === "string" ? data.requestId : undefined;
    summary.method = typeof data.method === "string" ? data.method : undefined;
    const message = pickText(data.message) ?? pickText(data.title);
    if (message) summary.text = message;
    if (Array.isArray(data.options)) {
      summary.options = data.options.filter((item): item is string => typeof item === "string").slice(0, 20);
    }
    return summary;
  }
  const text =
    pickText(data.text) ??
    pickText(data.error) ??
    pickText(data.reason) ??
    pickText(data.partialText);
  if (text) summary.text = text;
  return summary;
}

function pickText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? safeText(value, MAX_SUMMARY_CHARS) : undefined;
}

export function renderMessage(record: NotificationRecord): string {
  const label = `${record.workerId} (${record.runtime})`;
  const head = `[harness-supervisor] ${label} ${record.kind} at ${record.createdAt} (seq ${record.seq})`;
  const detail = record.summary.text ? `: ${oneLine(record.summary.text)}` : "";
  const hint =
    record.kind === "needs_input"
      ? ` | answer with worker_answer (requestId ${record.summary.requestId ?? "unknown"})`
      : ` | read with worker_status/worker_events`;
  return `${head}${detail}${hint}`;
}

/** cmd.exe does not escape arguments for us, so quote what needs quoting. */
function quoteCmdArg(arg: string): string {
  return /^[A-Za-z0-9_\-.:\/@=]+$/.test(arg) ? arg : `"${arg.replace(/"/g, "'")}"`;
}

/** Keep the delivered text on one line and free of shell-hostile characters. */
function sanitizeArg(text: string): string {
  return oneLine(text).replace(/["`]/g, "'");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cap(text: string): string {
  return text.length > MAX_DELIVERY_OUTPUT ? text.slice(-MAX_DELIVERY_OUTPUT) : text;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const { rename, writeFile } = await import("node:fs/promises");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}