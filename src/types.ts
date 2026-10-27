export const SCHEMA_VERSION = 1;

export type WorkerStatus =
  | "starting"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "crashed"
  | "orphaned"
  | "interrupted";

export const TERMINAL_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "crashed",
  "orphaned",
  "interrupted",
]);

export const ACTIVE_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  "starting",
  "running",
  "awaiting_input",
]);

export function isTerminal(status: WorkerStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface RuntimeCapabilities {
  runtime: string;
  steer: boolean;
  followUp: boolean;
  cancel: boolean;
  resume: boolean;
  pause: false;
  interactiveInput: boolean;
  notes: string;
}

export interface WorkerConfig {
  model?: string;
  provider?: string;
  tools?: string[];
  thinking?: string;
  extraArgs?: string[];
  maxDurationMs?: number;
}

export interface WorkerStats {
  turns: number;
  toolCalls: number;
  toolErrors: number;
}

export interface PendingInput {
  requestId: string;
  /**
   * Seq of the `run.needs_input` event that produced this request.
   * Harnesses may reuse a requestId across resumed runs, so the seq (not the id)
   * is what proves a notification still describes the *current* request.
   * Missing on legacy records; consumers then fall back to a weaker check.
   */
  seq?: number;
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  at: string;
}

export interface WorkerResult {
  text: string;
  truncated: boolean;
}

export interface WorkerRecord {
  schemaVersion: number;
  id: string;
  runtime: string;
  name?: string;
  cwd: string;
  promptPreview: string;
  status: WorkerStatus;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  pid?: number;
  sessionId?: string;
  sessionFile?: string;
  exit?: ExitInfo;
  result?: WorkerResult;
  error?: string;
  pendingInput?: PendingInput;
  lastSeq: number;
  eventCount: number;
  stats: WorkerStats;
  capabilities: RuntimeCapabilities;
  config: WorkerConfig;
  resumeCount: number;
  supervisorId: string;
  /** Persisted at spawn; global defaults never move an existing worker. */
  notifyTarget?: NotifyTarget;
  /**
   * Task this worker belongs to. Optional on purpose: workers created before
   * task metrics existed are not retroactively attributed to a guessed task.
   */
  taskId?: string;
}

export interface WorkerSummary extends WorkerRecord {
  resumeAvailable: boolean;
  pidAlive: boolean | null;
}

export type WorkerEventType =
  | "worker.starting"
  | "worker.started"
  | "worker.session"
  | "run.accepted"
  | "run.started"
  | "run.progress"
  | "run.usage"
  | "run.needs_input"
  | "run.input_answered"
  | "run.message_sent"
  | "run.error"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "worker.cancel_requested"
  | "worker.exited"
  | "worker.crashed"
  | "worker.orphaned"
  | "worker.interrupted"
  | "worker.resumed"
  | "worker.resume_failed";

export interface WorkerEvent {
  seq: number;
  workerId: string;
  ts: string;
  type: WorkerEventType;
  data?: Record<string, unknown>;
  /** Historical route, including across explicit resume rebinding. */
  notifyTarget?: NotifyTarget;
}

export interface SpawnInput {
  notifyTarget?: NotifyTarget;
  runtime?: string;
  cwd: string;
  prompt: string;
  name?: string;
  model?: string;
  provider?: string;
  tools?: string[];
  thinking?: string;
  maxDurationMs?: number;
  extraArgs?: string[];
  /** Link this worker to an existing delegated task. Omit to auto-create one. */
  taskId?: string;
}

export interface ResumeInput {
  /** Omit to preserve the existing binding. Explicit value authorizes takeover. */
  notifyTarget?: NotifyTarget;
  prompt: string;
  model?: string;
  provider?: string;
  tools?: string[];
  thinking?: string;
  maxDurationMs?: number;
  extraArgs?: string[];
}

export interface ReadEventsResult {
  worker: WorkerSummary;
  events: WorkerEvent[];
  nextSeq: number;
  hasMore: boolean;
}

export interface WorkerStatusResult {
  worker: WorkerSummary;
  recentEvents: WorkerEvent[];
  stderrTail: string;
}

export interface WaitResult extends ReadEventsResult {
  timedOut: boolean;
  terminal: boolean;
}

export interface SupervisorLimits {
  maxWorkers: number;
  maxWaitMs: number;
  defaultWaitMs: number;
  closeGraceMs: number;
  abortTimeoutMs: number;
  maxResultBytes: number;
  maxEventStringBytes: number;
}

export interface SupervisorInfo {
  name: string;
  version: string;
  pid: number;
  stateDir: string;
  supervisorId: string;
  startedAt: string;
  uptimeMs: number;
  limits: SupervisorLimits;
  wake: {
    /**
     * True only when a delivery channel is configured. It means the supervisor
     * will attempt to deliver, not that the host actually woke the main agent.
     */
    proactive: boolean;
    channel: "none" | "codex-queue";
    codexThreadId?: string;
    /** channel/proactive describe the default, while workers can override it. */
    workerRouting?: boolean;
    note: string;
  };
  runtimes: RuntimeCapabilities[];
}

export type SendMode = "steer" | "follow-up";

/**
 * Important, low-frequency events that are recorded in the notification inbox.
 * Ordinary progress is intentionally excluded.
 */
export type NotificationKind =
  | "completed"
  | "failed"
  | "cancelled"
  | "crashed"
  | "needs_input"
  | "detached";

/**
 * `superseded` is terminal and never delivered: the event is real and stays in
 * the inbox/event log, but it stopped describing current state before any host
 * delivery happened (request answered, run resumed, worker gone). It must never
 * be reported as `delivered`, because nothing reached the host.
 */
export type NotificationDeliveryState = "pending" | "delivered" | "failed" | "superseded";

export interface NotificationRecord {
  /** Immutable destination for this event; missing legacy routes are inbox-only. */
  target?: NotifyTarget;
  /** Stable identity derived from worker + event seq, so one event yields one record. */
  id: string;
  workerId: string;
  runtime: string;
  seq: number;
  eventType: string;
  kind: NotificationKind;
  createdAt: string;
  summary: {
    status?: WorkerStatus;
    text?: string;
    requestId?: string;
    method?: string;
    options?: string[];
  };
  delivery: {
    state: NotificationDeliveryState;
    channel: string;
    attempts: number;
    lastAttemptAt?: string;
    /** Preparation persisted before the final ACK/freshness check; may be skipped. */
    dispatchPreparedAt?: string;
    /** Local dispatch start/end; lastAttemptAt retains its legacy end-time meaning. */
    lastAttemptStartedAt?: string;
    lastAttemptFinishedAt?: string;
    /** When the CLI reported queue acceptance, not when the host consumed it. */
    enqueuedAt?: string;
    lastError?: string;
    messageId?: string;
    /** Why the supervisor decided not to deliver this record (state=superseded). */
    supersededReason?: string;
    supersededAt?: string;
  };
  ackAt?: string;
  ackBy?: string;
}

export interface NotificationCounts {
  pending: number;
  delivered: number;
  failed: number;
  /** Resolved without delivery; absent on older daemons. */
  superseded?: number;
  /** Actionable records the consumer has not acknowledged. */
  unacked: number;
}

export interface NotificationsResult {
  notifications: NotificationRecord[];
  counts: NotificationCounts;
  target: NotifyTarget;
}

export interface NotifyTarget {
  channel: "none" | "codex-queue";
  codexThreadId?: string;
  updatedAt?: string;
}

export type ExtensionUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export interface HarnessExit {
  code: number | null;
  signal: string | null;
}

export interface HarnessStateInfo {
  sessionId?: string;
  sessionFile?: string;
}

export interface HarnessUsageReport {
  provider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reportedTotalTokens?: number;
}

export type HarnessEvent =
  | { type: "run_started" }
  | {
      type: "progress";
      kind: string;
      tool?: string;
      detail?: string;
      preview?: string;
      isError?: boolean;
      durationMs?: number;
    }
  | {
      /**
       * Structured, provider-reported usage for this run. Values are not
       * billing-verified and all-zero reports are treated as unknown later;
       * adapters must not invent numbers when the runtime did not report them.
       */
      type: "usage";
      usage: HarnessUsageReport;
    }
  | {
      type: "needs_input";
      requestId: string;
      method: PendingInput["method"];
      title?: string;
      message?: string;
      options?: string[];
      placeholder?: string;
      prefill?: string;
      timeoutMs?: number;
    }
  | { type: "run_error"; message: string; fatal?: boolean }
  | {
      type: "settled";
      aborted: boolean;
      finalText?: string;
      error?: string;
      stopReason?: string;
    }
  | { type: "exit"; code: number | null; signal: string | null };

export interface HarnessCloseResult {
  exit: HarnessExit | null;
  forced: boolean;
}

export interface HarnessQueueContents {
  steering: string[];
  followUp: string[];
}

export interface HarnessSession {
  readonly pid: number | undefined;
  getState(): Promise<HarnessStateInfo>;
  prompt(message: string): Promise<{ disposition: string }>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  clearQueue(): Promise<HarnessQueueContents>;
  abort(): Promise<void>;
  answer(requestId: string, response: ExtensionUiResponse): Promise<void>;
  close(options?: { graceMs?: number }): Promise<HarnessCloseResult>;
  forceKill(): Promise<void>;
  isAlive(): boolean;
  stderrTail(): string;
}

export interface HarnessCallbacks {
  onEvent(event: HarnessEvent): void;
  onExit(exit: HarnessExit): void;
}

export interface HarnessSpawnSpec {
  workerId: string;
  cwd: string;
  sessionDir: string;
  model?: string;
  provider?: string;
  tools?: string[];
  thinking?: string;
  extraArgs?: string[];
}

export interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  spawn(spec: HarnessSpawnSpec, callbacks: HarnessCallbacks): Promise<HarnessSession>;
  resume(
    spec: HarnessSpawnSpec,
    sessionFile: string,
    callbacks: HarnessCallbacks,
  ): Promise<HarnessSession>;
}
