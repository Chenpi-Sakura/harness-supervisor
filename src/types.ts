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
  /**
   * Start of the current (or most recent) run segment. A resumed worker gets a
   * new `startedAt`; `firstStartedAt` preserves the original start.
   */
  startedAt?: string;
  /** First accepted run start; never rewritten by resume. Absent on legacy records. */
  firstStartedAt?: string;
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
  /**
   * Effective notification binding for this worker, present on spawn/resume
   * responses only. It is computed, never persisted: `source` would otherwise
   * become a second truth for the same target.
   */
  notificationBinding?: NotificationBinding;
}

export type NotificationBindingSource = "explicit" | "caller" | "daemon-default" | "preserved";

export interface NotificationBinding {
  /** The target actually persisted for this worker. */
  target: NotifyTarget;
  /** Where the target came from; `preserved` means resume kept an old binding. */
  source: NotificationBindingSource;
  /** Whether a wakeable route is bound; it is not a guarantee of wake-up. */
  wake: "bound" | "unbound";
  /** Suggested way to observe: `wait` when no wake route is bound. */
  observation: "wake" | "wait";
  /** Empty when bound; always explains an unbound result. */
  warnings: string[];
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
  /**
   * Codex thread that issued this MCP call. The MCP layer fills it from the
   * per-call `_meta.threadId`; explicit notifyTarget still wins. Never persisted
   * as a separate field: the resolved target is snapshotted in notifyTarget.
   */
  callerThreadId?: string;
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

/**
 * Newest stored progress that can be shown without reading a specific event.
 * It is derived from the event log on every read (never stored separately), so
 * it cannot drift from the events it points at.
 *
 * `evidence=partial_progress` is deliberately weaker than completion: it says
 * "the worker had produced this text", not that the task was delivered.
 */
export type LastProgressEvidence = "partial_progress" | "final_report";

export interface WorkerLastProgress {
  state: "available" | "none";
  seq?: number;
  ts?: string;
  type?: WorkerEventType;
  /** `run.progress` kind when the source is a progress event. */
  kind?: string;
  tool?: string;
  isError?: boolean;
  source?: "assistant_message" | "thinking" | "tool_output" | "diagnostic" | "partial_text" | "final_report";
  /** Bounded view of the stored text. */
  text?: string;
  /** Length of the stored text this view was built from. */
  chars?: number;
  /** Original length before the storage cap, when the writer recorded it. */
  originalChars?: number;
  /** The view is shorter than the stored text. */
  truncated?: boolean;
  /** The stored event text was already clipped; reading the event cannot restore it. */
  storedTruncated?: boolean;
  evidence?: LastProgressEvidence;
  /** For `state="none"`: highest seq inspected. */
  scannedThroughSeq?: number;
  note?: string;
}

export interface WorkerRunSegment {
  startSeq: number;
  startedAt: string;
  endSeq?: number;
  endedAt?: string;
  /** Terminal status for a closed segment; absent while it is still open. */
  outcome?: WorkerStatus;
  open: boolean;
}

export interface WorkerTimeline {
  createdAt: string;
  /** Original accepted start; falls back to createdAt on legacy records. */
  firstStartedAt?: string;
  /** Start of the current or most recent run segment (`startedAt` semantics). */
  currentRunStartedAt?: string;
  endedAt?: string;
  resumeCount: number;
  segments: WorkerRunSegment[];
  segmentsTotal: number;
  note: string;
}

export type WorkerInputStateName =
  | "pending"
  | "answered"
  | "expired"
  | "withdrawn"
  | "closed"
  | "unknown";

/**
 * Read-time view of the current/last native input request. It is derived from
 * the worker record and events; nothing here is a second persisted state.
 */
export interface WorkerInputState {
  state: WorkerInputStateName;
  requestId?: string;
  method?: PendingInput["method"];
  createdAt?: string;
  expiresAt?: string;
  /** Negative once the request is past its deadline. */
  expiresInMs?: number;
  answeredAt?: string;
  outcome?: "value" | "confirmed" | "cancelled";
  /** Concrete next calls; never a promise that the old request can still be answered. */
  nextActions: string[];
  note?: string;
}

export interface WorkerStatusResult {
  worker: WorkerSummary;
  recentEvents: WorkerEvent[];
  stderrTail: string;
  /** Newest usable progress derived from the persisted event log. */
  lastProgress?: WorkerLastProgress;
  /** Per-run-segment start/end derived from lifecycle events. */
  timeline?: WorkerTimeline;
  /** Last/current input request and the actions that are still valid. */
  inputState?: WorkerInputState;
}

export interface WaitResult extends ReadEventsResult {
  timedOut: boolean;
  terminal: boolean;
  lastProgress?: WorkerLastProgress;
  timeline?: WorkerTimeline;
  inputState?: WorkerInputState;
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
  /**
   * Steering a *host* Codex turn is separate from steering a Worker. HS does
   * not expose host steering: the shared app-server cannot take over a thread
   * that Codex Desktop currently owns. RPC and model behavior were verified
   * separately, so callers can tell "not implemented" apart from "not tested".
   */
  codexSteer: {
    status: "unavailable";
    verified: {
      appServerRpc: boolean;
      modelApplied: boolean;
      desktopActiveTurn: boolean;
    };
    reason: string;
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
  /** Legacy global counts. Kept for older consumers; new callers should read both scopes. */
  counts: NotificationCounts;
  /** Counts for the same filter that produced `notifications`, before `limit`. */
  filteredCounts?: NotificationCounts;
  /** Counts over the whole inbox. */
  globalCounts?: NotificationCounts;
  /** Explains exactly which filter produced `filteredCounts`. */
  scope?: NotificationScope;
  target: NotifyTarget;
}

export interface NotificationScope {
  state: "pending" | "delivered" | "failed" | "all";
  workerId?: string;
  unacknowledgedOnly: boolean;
  limit: number;
  /** Records in this response after `limit`; may be smaller than filteredCounts. */
  returned: number;
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
  /** Extra environment for this worker process only (never the daemon's own). */
  env?: NodeJS.ProcessEnv;
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
