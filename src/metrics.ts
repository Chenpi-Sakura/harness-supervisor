import { randomBytes } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { SupervisorError, errorMessage } from "./errors.js";
import type { Logger } from "./util/logger.js";
import { ensureDir } from "./util/fsx.js";
import { redactText, redactValue, safeText } from "./util/redact.js";
import {
  isTerminal,
  type WorkerEvent,
  type WorkerRecord,
  type WorkerStatus,
} from "./types.js";

export const METRICS_SCHEMA_VERSION = 1;
export const METRICS_FILE_NAME = "metrics.jsonl";
const MAX_ID_CHARS = 120;
const MAX_TOKENS = 1_000_000_000_000_000;
const MAX_WARNINGS = 100;

export type TaskExecutionMode = "delegated" | "direct";
export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";
export type AcceptanceStatus = "pending" | "passed" | "rejected" | "not_applicable";
export type MetricsCreatedBy = "mcp" | "cli" | "spawn" | "import" | "manual";
export type UsageRole = "parent_agent" | "worker";
export type UsageSource = "runtime_reported" | "host_reported" | "manual" | "imported" | "estimated";
export type UsageAttribution = "exact" | "incremental" | "session_level" | "estimated";
export type UsageConfidence = "verified" | "partial" | "unverified" | "unknown";

export interface TaskRecord {
  schemaVersion: number;
  id: string;
  title: string;
  category?: string;
  executionMode: TaskExecutionMode;
  createdAt: string;
  updatedAt: string;
  workerIds: string[];
  parentSessionRef?: string;
  acceptanceStatus: AcceptanceStatus;
  firstAcceptancePassed?: boolean;
  reworkCount?: number;
  interventionCount?: number;
  createdBy: MetricsCreatedBy;
}

export interface UsageRecord {
  schemaVersion: number;
  id: string;
  taskId: string;
  workerId?: string;
  role: UsageRole;
  provider?: string;
  modelId?: string;
  harness?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reportedTotalTokens: number | null;
  usageSource: UsageSource;
  attribution: UsageAttribution;
  confidence: UsageConfidence;
  recordedAt: string;
  note?: string;
}

export interface TaskCreateInput {
  taskId?: string;
  title: string;
  category?: string;
  executionMode?: TaskExecutionMode;
  parentSessionRef?: string;
  createdBy?: MetricsCreatedBy;
  workerId?: string;
}

export interface UsageRecordInput {
  taskId: string;
  role: UsageRole;
  workerId?: string;
  usageId?: string;
  provider?: string;
  modelId?: string;
  harness?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reportedTotalTokens?: number | null;
  usageSource?: UsageSource;
  attribution?: UsageAttribution;
  confidence?: UsageConfidence;
  note?: string;
}

export interface TaskWorkerMetrics {
  workerId: string;
  missing: boolean;
  runtime?: string;
  status?: WorkerStatus;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  runMs?: number;
  runMsUnknownReason?: string;
}

export interface TokenFieldSummary {
  value: number | null;
  knownRecords: number;
  missingRecords: number;
}

export interface UsageSummary {
  records: number;
  usableRecords: number;
  verifiedRecords: number;
  partialRecords: number;
  unverifiedRecords: number;
  unknownRecords: number;
  inputTokens: TokenFieldSummary;
  outputTokens: TokenFieldSummary;
  cacheReadTokens: TokenFieldSummary;
  cacheWriteTokens: TokenFieldSummary;
  reportedTotalTokens: TokenFieldSummary;
}

export interface TaskMetrics {
  schemaVersion: number;
  task: TaskRecord;
  status: TaskStatus;
  timing: {
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    endToEndMs: number | null;
    waitingMs: number | null;
  };
  workers: TaskWorkerMetrics[];
  usage: UsageRecord[];
  usageSummary: {
    worker: UsageSummary;
    parentAttributable: UsageSummary;
    parentSessionLevel: UsageSummary;
    unverified: { records: number; note: string };
  };
  warnings: string[];
  unknownFields: string[];
}

export interface DurationSummary {
  knownCount: number;
  missingCount: number;
  totalMs: number | null;
  avgMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface MetricsReport {
  schemaVersion: number;
  generatedAt: string;
  period: { since: string | null; until: string | null; field: "task.createdAt" };
  taskCount: number;
  workerCount: number;
  counts: Record<TaskStatus, number>;
  usageCoverage: {
    tasks: number;
    tasksWithWorkers: number;
    tasksWithWorkerUsage: number;
    tasksWithAttributableParentUsage: number;
    tasksWithSessionLevelParentUsage: number;
    tasksWithAnyUsableUsage: number;
    tasksWithVerifiedUsage: number;
    tasksWithUnverifiedUsage: number;
    tasksWithMissingWorkers: number;
    workerUsageRecords: number;
    parentUsageRecords: number;
  };
  knownWorkerUsage: UsageSummary;
  knownParentUsage: UsageSummary;
  sessionLevelParentUsage: UsageSummary;
  unverifiedUsage: {
    records: number;
    taskCount: number;
    note: string;
  };
  durationStats: {
    endToEnd: DurationSummary;
    workerRun: DurationSummary;
    waiting: DurationSummary;
    note: string;
  };
  notTracked: {
    cost: string;
    firstPassAcceptance: string;
    rework: string;
    intervention: string;
    comparison: string;
  };
  unknownFields: string[];
  dataQualityWarnings: string[];
  tasks?: TaskMetrics[];
  tasksTruncated?: boolean;
}

export interface MetricsReportOptions {
  since?: string;
  until?: string;
  includeTasks?: boolean;
  limit?: number;
}

interface MetricsFileLine {
  schemaVersion?: unknown;
  kind?: unknown;
  task?: unknown;
  usage?: unknown;
}

const UNKNOWN_FIELDS = [
  "cost",
  "firstAcceptancePassed",
  "reworkCount",
  "interventionCount",
  "comparisonBaseline",
  "providerBillingVerification",
];

const NOT_TRACKED: MetricsReport["notTracked"] = {
  cost:
    "Not collected in phase 1-2. HS does not import provider billing or convert subscription credits into money.",
  firstPassAcceptance:
    "Not collected in phase 1-2. Worker completion is not treated as acceptance.",
  rework: "Not collected in phase 1-2. Reviewing logs or asking for a report is not counted as rework.",
  intervention:
    "Not collected in phase 1-2. Steer/follow-up events are not assumed to be human interventions.",
  comparison:
    "Not available without a comparable non-HS baseline with the same acceptance criteria and accounting.",
};

function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function newUsageId(): string {
  return `manual:${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validId(value: unknown, max = MAX_ID_CHARS): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

function tokenValue(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SupervisorError("BAD_REQUEST", `${name} must be a finite number`);
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_TOKENS) {
    throw new SupervisorError(
      "BAD_REQUEST",
      `${name} must be a non-negative integer no larger than ${MAX_TOKENS}`,
    );
  }
  return value;
}

function loadedToken(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_TOKENS
    ? value
    : null;
}

function hasKnownToken(record: UsageRecord): boolean {
  return (
    record.inputTokens !== null ||
    record.outputTokens !== null ||
    record.cacheReadTokens !== null ||
    record.cacheWriteTokens !== null ||
    record.reportedTotalTokens !== null
  );
}

function isUsable(record: UsageRecord): boolean {
  return hasKnownToken(record) && (record.confidence === "verified" || record.confidence === "partial");
}

function attributable(record: UsageRecord): boolean {
  return record.attribution === "exact" || record.attribution === "incremental";
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = safeText(redactText(value.trim()), max);
  return text.length > 0 ? text : undefined;
}

function normalizeTask(value: unknown): TaskRecord | null {
  if (!isRecordObject(value)) return null;
  if (value.schemaVersion !== METRICS_SCHEMA_VERSION) return null;
  if (!validId(value.id)) return null;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title) return null;
  const executionMode: TaskExecutionMode =
    value.executionMode === "direct" ? "direct" : "delegated";
  const createdAt = validIso(value.createdAt) ? value.createdAt : undefined;
  const updatedAt = validIso(value.updatedAt) ? value.updatedAt : undefined;
  if (!createdAt || !updatedAt) return null;
  const workerIds = Array.isArray(value.workerIds)
    ? [...new Set(value.workerIds.filter((item): item is string => validId(item)))]
    : [];
  const acceptanceStatus: AcceptanceStatus =
    value.acceptanceStatus === "passed" ||
    value.acceptanceStatus === "rejected" ||
    value.acceptanceStatus === "not_applicable"
      ? value.acceptanceStatus
      : "pending";
  const createdBy: MetricsCreatedBy =
    value.createdBy === "mcp" ||
    value.createdBy === "cli" ||
    value.createdBy === "import" ||
    value.createdBy === "manual"
      ? value.createdBy
      : "spawn";
  const category = optionalText(value.category, 50);
  const parentSessionRef = optionalText(value.parentSessionRef, 300);
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    id: value.id,
    title: safeText(redactText(title), 200),
    ...(category ? { category } : {}),
    executionMode,
    createdAt,
    updatedAt,
    workerIds,
    ...(parentSessionRef ? { parentSessionRef } : {}),
    acceptanceStatus,
    ...(typeof value.firstAcceptancePassed === "boolean"
      ? { firstAcceptancePassed: value.firstAcceptancePassed }
      : {}),
    ...(typeof value.reworkCount === "number" && Number.isInteger(value.reworkCount) && value.reworkCount >= 0
      ? { reworkCount: value.reworkCount }
      : {}),
    ...(typeof value.interventionCount === "number" &&
    Number.isInteger(value.interventionCount) &&
    value.interventionCount >= 0
      ? { interventionCount: value.interventionCount }
      : {}),
    createdBy,
  };
}

function normalizeUsage(value: unknown): UsageRecord | null {
  if (!isRecordObject(value)) return null;
  if (value.schemaVersion !== METRICS_SCHEMA_VERSION) return null;
  if (!validId(value.id) || !validId(value.taskId)) return null;
  if (value.role !== "parent_agent" && value.role !== "worker") return null;
  const confidence: UsageConfidence =
    value.confidence === "verified" ||
    value.confidence === "partial" ||
    value.confidence === "unverified"
      ? value.confidence
      : "unknown";
  const attribution: UsageAttribution =
    value.attribution === "exact" ||
    value.attribution === "incremental" ||
    value.attribution === "session_level" ||
    value.attribution === "estimated"
      ? value.attribution
      : "estimated";
  const usageSource: UsageSource =
    value.usageSource === "runtime_reported" ||
    value.usageSource === "host_reported" ||
    value.usageSource === "imported" ||
    value.usageSource === "estimated"
      ? value.usageSource
      : "manual";
  const recordedAt = validIso(value.recordedAt) ? value.recordedAt : new Date().toISOString();
  const provider = optionalText(value.provider, 200);
  const modelId = optionalText(value.modelId, 200);
  const harness = optionalText(value.harness, 100);
  const note = optionalText(value.note, 500);
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    id: value.id,
    taskId: value.taskId,
    ...(validId(value.workerId) ? { workerId: value.workerId } : {}),
    role: value.role,
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(harness ? { harness } : {}),
    inputTokens: loadedToken(value.inputTokens),
    outputTokens: loadedToken(value.outputTokens),
    cacheReadTokens: loadedToken(value.cacheReadTokens),
    cacheWriteTokens: loadedToken(value.cacheWriteTokens),
    reportedTotalTokens: loadedToken(value.reportedTotalTokens),
    usageSource,
    attribution,
    confidence,
    recordedAt,
    ...(note ? { note } : {}),
  };
}

function sameUsagePayload(left: UsageRecord, right: UsageRecord): boolean {
  return (
    left.taskId === right.taskId &&
    left.workerId === right.workerId &&
    left.role === right.role &&
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.harness === right.harness &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.reportedTotalTokens === right.reportedTotalTokens &&
    left.usageSource === right.usageSource &&
    left.attribution === right.attribution &&
    left.confidence === right.confidence &&
    left.note === right.note
  );
}

function summarizeUsage(records: UsageRecord[], filter: (record: UsageRecord) => boolean): UsageSummary {
  const matching = records.filter(filter);
  const usable = matching.filter(isUsable);
  const field = (read: (record: UsageRecord) => number | null): TokenFieldSummary => {
    let value = 0;
    let knownRecords = 0;
    for (const record of usable) {
      const item = read(record);
      if (item === null) continue;
      value += item;
      knownRecords += 1;
    }
    return {
      value: knownRecords > 0 ? value : null,
      knownRecords,
      missingRecords: usable.length - knownRecords,
    };
  };
  return {
    records: matching.length,
    usableRecords: usable.length,
    verifiedRecords: usable.filter((record) => record.confidence === "verified").length,
    partialRecords: usable.filter((record) => record.confidence === "partial").length,
    unverifiedRecords: matching.filter((record) => record.confidence === "unverified").length,
    unknownRecords: matching.filter((record) => record.confidence === "unknown").length,
    inputTokens: field((record) => record.inputTokens),
    outputTokens: field((record) => record.outputTokens),
    cacheReadTokens: field((record) => record.cacheReadTokens),
    cacheWriteTokens: field((record) => record.cacheWriteTokens),
    reportedTotalTokens: field((record) => record.reportedTotalTokens),
  };
}

function durationSummary(values: number[], population: number): DurationSummary {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      knownCount: 0,
      missingCount: Math.max(0, population),
      totalMs: null,
      avgMs: null,
      medianMs: null,
      minMs: null,
      maxMs: null,
    };
  }
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
  return {
    knownCount: sorted.length,
    missingCount: Math.max(0, population - sorted.length),
    totalMs: total,
    avgMs: Math.round(total / sorted.length),
    medianMs: median,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
  };
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function deriveStatus(workers: TaskWorkerMetrics[]): TaskStatus {
  if (workers.length === 0) return "pending";
  if (workers.some((worker) => worker.missing || worker.status === undefined)) return "unknown";
  const statuses = workers.map((worker) => worker.status!);
  if (statuses.some((status) => status === "starting" || status === "running" || status === "awaiting_input")) {
    return "running";
  }
  if (statuses.some((status) => status === "failed" || status === "crashed")) return "failed";
  if (statuses.some((status) => status === "interrupted" || status === "orphaned")) return "interrupted";
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  return "unknown";
}

export class MetricsStore {
  readonly stateDir: string;
  readonly file: string;
  readonly warnings: string[] = [];
  private readonly logger?: Logger;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly usage = new Map<string, UsageRecord>();
  private readonly usageByTask = new Map<string, Set<string>>();
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(stateDir: string, logger?: Logger) {
    this.stateDir = path.resolve(stateDir);
    this.file = path.join(this.stateDir, "metrics", METRICS_FILE_NAME);
    this.logger = logger;
  }

  get isReady(): boolean {
    return this.initialized;
  }

  async init(): Promise<string[]> {
    if (this.initialized) return [...this.warnings];
    await ensureDir(path.dirname(this.file));
    let raw = "";
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let invalid = 0;
    let incompatible = 0;
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.replace(/^\uFEFF/, "").trim();
      if (!line) continue;
      let parsed: MetricsFileLine;
      try {
        parsed = JSON.parse(line) as MetricsFileLine;
      } catch {
        invalid += 1;
        continue;
      }
      if (parsed.schemaVersion !== METRICS_SCHEMA_VERSION) {
        incompatible += 1;
        continue;
      }
      if (parsed.kind === "task") {
        const task = normalizeTask(parsed.task);
        if (!task) {
          invalid += 1;
          continue;
        }
        this.tasks.set(task.id, task);
        continue;
      }
      if (parsed.kind === "usage") {
        const usage = normalizeUsage(parsed.usage);
        if (!usage) {
          invalid += 1;
          continue;
        }
        this.usage.set(usage.id, usage);
        let ids = this.usageByTask.get(usage.taskId);
        if (!ids) {
          ids = new Set();
          this.usageByTask.set(usage.taskId, ids);
        }
        ids.add(usage.id);
        continue;
      }
      invalid += 1;
    }
    if (invalid > 0) {
      this.addWarning(`Ignored ${invalid} malformed metrics record(s); valid records were kept.`);
    }
    if (incompatible > 0) {
      this.addWarning(
        `Ignored ${incompatible} metrics record(s) with an unsupported schema version.`,
      );
    }
    this.initialized = true;
    return [...this.warnings];
  }

  getTask(taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task ? clone(task) : undefined;
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => clone(task));
  }

  listUsage(taskId?: string): UsageRecord[] {
    const records =
      taskId === undefined
        ? [...this.usage.values()]
        : [...(this.usageByTask.get(taskId) ?? [])].flatMap((id) => {
            const record = this.usage.get(id);
            return record ? [record] : [];
          });
    return records
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((record) => clone(record));
  }

  hasUsage(usageId: string): boolean {
    return this.usage.has(usageId);
  }

  async createTask(input: TaskCreateInput): Promise<TaskRecord> {
    this.assertReady();
    const title = optionalText(input.title, 200);
    if (!title) throw new SupervisorError("BAD_REQUEST", "title must be a non-empty string");
    const category = optionalText(input.category, 50);
    const parentSessionRef = optionalText(input.parentSessionRef, 300);
    const executionMode = input.executionMode ?? "delegated";
    if (executionMode !== "delegated") {
      throw new SupervisorError(
        "UNSUPPORTED",
        "Direct tasks are not implemented in phases 1-2; only delegated tasks can be recorded.",
      );
    }
    if (input.taskId !== undefined && !validId(input.taskId)) {
      throw new SupervisorError("BAD_REQUEST", "taskId is invalid");
    }
    const existing = input.taskId ? this.tasks.get(input.taskId) : undefined;
    if (existing) {
      if (
        existing.title === title &&
        (existing.category ?? undefined) === (category ?? undefined) &&
        existing.executionMode === executionMode &&
        (existing.parentSessionRef ?? undefined) === (parentSessionRef ?? undefined)
      ) {
        return clone(existing);
      }
      throw new SupervisorError("CONFLICT", `Task ${existing.id} already exists with different metadata`, {
        taskId: existing.id,
      });
    }
    const now = new Date().toISOString();
    const task: TaskRecord = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      id: input.taskId ?? newTaskId(),
      title,
      ...(category ? { category } : {}),
      executionMode,
      createdAt: now,
      updatedAt: now,
      workerIds: input.workerId ? [input.workerId] : [],
      ...(parentSessionRef ? { parentSessionRef } : {}),
      acceptanceStatus: "pending",
      createdBy: input.createdBy ?? "manual",
    };
    await this.append("task", task);
    this.tasks.set(task.id, task);
    return clone(task);
  }

  async linkWorker(taskId: string, workerId: string): Promise<TaskRecord> {
    this.assertReady();
    const task = this.tasks.get(taskId);
    if (!task) throw new SupervisorError("NOT_FOUND", `Unknown taskId: ${taskId}`, { taskId });
    if (!validId(workerId)) throw new SupervisorError("BAD_REQUEST", "workerId is invalid");
    if (task.workerIds.includes(workerId)) return clone(task);
    const updated: TaskRecord = {
      ...task,
      workerIds: [...task.workerIds, workerId],
      updatedAt: new Date().toISOString(),
    };
    await this.append("task", updated);
    this.tasks.set(taskId, updated);
    return clone(updated);
  }

  async recordUsage(input: UsageRecordInput): Promise<UsageRecord> {
    this.assertReady();
    if (!validId(input.taskId)) throw new SupervisorError("BAD_REQUEST", "taskId is invalid");
    const task = this.tasks.get(input.taskId);
    if (!task) {
      throw new SupervisorError("NOT_FOUND", `Unknown taskId: ${input.taskId}`, {
        taskId: input.taskId,
      });
    }
    if (input.role !== "parent_agent" && input.role !== "worker") {
      throw new SupervisorError("BAD_REQUEST", "role must be parent_agent or worker");
    }
    if (input.role === "worker") {
      if (!input.workerId || !validId(input.workerId)) {
        throw new SupervisorError("BAD_REQUEST", "workerId is required for worker usage");
      }
      if (!task.workerIds.includes(input.workerId)) {
        throw new SupervisorError(
          "BAD_REQUEST",
          `Worker ${input.workerId} is not linked to task ${task.id}`,
          { taskId: task.id, workerId: input.workerId },
        );
      }
    } else if (input.workerId !== undefined) {
      throw new SupervisorError("BAD_REQUEST", "workerId must be omitted for parent_agent usage");
    }
    const tokens = {
      inputTokens: tokenValue(input.inputTokens, "inputTokens"),
      outputTokens: tokenValue(input.outputTokens, "outputTokens"),
      cacheReadTokens: tokenValue(input.cacheReadTokens, "cacheReadTokens"),
      cacheWriteTokens: tokenValue(input.cacheWriteTokens, "cacheWriteTokens"),
      reportedTotalTokens: tokenValue(input.reportedTotalTokens, "reportedTotalTokens"),
    };
    if (Object.values(tokens).every((value) => value === null)) {
      throw new SupervisorError(
        "BAD_REQUEST",
        "At least one token field is required; unknown usage must stay unrecorded, not zero.",
      );
    }
    const usageSource = input.usageSource ?? "manual";
    if (
      usageSource !== "manual" &&
      usageSource !== "host_reported" &&
      usageSource !== "imported" &&
      usageSource !== "estimated"
    ) {
      throw new SupervisorError(
        "BAD_REQUEST",
        "usageSource must be manual, host_reported, imported or estimated",
      );
    }
    const attribution =
      input.attribution ?? (input.role === "parent_agent" ? "session_level" : "exact");
    if (
      attribution !== "exact" &&
      attribution !== "incremental" &&
      attribution !== "session_level" &&
      attribution !== "estimated"
    ) {
      throw new SupervisorError("BAD_REQUEST", "attribution is invalid");
    }
    const confidence = input.confidence ?? "partial";
    if (
      confidence !== "verified" &&
      confidence !== "partial" &&
      confidence !== "unverified" &&
      confidence !== "unknown"
    ) {
      throw new SupervisorError("BAD_REQUEST", "confidence is invalid");
    }
    if (input.usageId !== undefined && !validId(input.usageId, 100)) {
      throw new SupervisorError("BAD_REQUEST", "usageId is invalid");
    }
    const id = input.usageId ? `manual:${input.usageId}` : newUsageId();
    const provider = optionalText(input.provider, 200);
    const modelId = optionalText(input.modelId, 200);
    const harness = optionalText(input.harness, 100);
    const note = optionalText(input.note, 500);
    const record: UsageRecord = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      id,
      taskId: task.id,
      ...(input.workerId ? { workerId: input.workerId } : {}),
      role: input.role,
      ...(provider ? { provider } : {}),
      ...(modelId ? { modelId } : {}),
      ...(harness ? { harness } : {}),
      ...tokens,
      usageSource,
      attribution,
      confidence,
      recordedAt: new Date().toISOString(),
      ...(note
        ? { note }
        : { note: "Recorded through the metrics API; not independently verified." }),
    };
    const existing = this.usage.get(record.id);
    if (existing) {
      if (sameUsagePayload(existing, record)) return clone(existing);
      throw new SupervisorError("CONFLICT", `Usage ${record.id} already exists with different values`, {
        usageId: record.id,
      });
    }
    await this.append("usage", record);
    this.addUsage(record);
    return clone(record);
  }

  ingestEvent(worker: WorkerRecord, event: WorkerEvent): UsageRecord | null {
    if (!this.initialized || event.type !== "run.usage" || !worker.taskId) return null;
    const id = `runtime:${worker.id}:${event.seq}`;
    const existing = this.usage.get(id);
    if (existing) return clone(existing);
    const data = isRecordObject(event.data) ? event.data : {};
    const raw = {
      inputTokens: loadedToken(data.inputTokens),
      outputTokens: loadedToken(data.outputTokens),
      cacheReadTokens: loadedToken(data.cacheReadTokens),
      cacheWriteTokens: loadedToken(data.cacheWriteTokens),
      reportedTotalTokens: loadedToken(data.reportedTotalTokens),
    };
    if (Object.values(raw).every((value) => value === null)) return null;
    const allZero = Object.values(raw).every((value) => value === null || value === 0);
    const values = allZero
      ? {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reportedTotalTokens: null,
        }
      : raw;
    const provider = optionalText(data.provider, 200);
    const modelId = optionalText(data.modelId, 200) ?? optionalText(worker.config.model, 200);
    const record: UsageRecord = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      id,
      taskId: worker.taskId,
      workerId: worker.id,
      role: "worker",
      ...(provider ? { provider } : {}),
      ...(modelId ? { modelId } : {}),
      harness: worker.runtime,
      ...values,
      usageSource: "runtime_reported",
      attribution: "exact",
      confidence: allZero ? "unverified" : "partial",
      recordedAt: validIso(event.ts) ? event.ts : new Date().toISOString(),
      note: allZero
        ? "The runtime reported only zero token fields; treated as unknown, not as a verified zero. Provider billing was not checked."
        : "Runtime-reported usage; not independently verified against provider billing.",
    };
    this.addUsage(record);
    void this.append("usage", record).catch((error: unknown) => {
      this.addWarning(
        `Failed to persist usage ${record.id}: ${errorMessage(error)}`,
      );
      this.logger?.warn("Failed to persist metrics usage", {
        usageId: record.id,
        error: errorMessage(error),
      });
    });
    return clone(record);
  }

  taskMetrics(taskId: string, getWorker: (workerId: string) => WorkerRecord | undefined): TaskMetrics {
    this.assertReady();
    const task = this.tasks.get(taskId);
    if (!task) throw new SupervisorError("NOT_FOUND", `Unknown taskId: ${taskId}`, { taskId });
    return this.buildTaskMetrics(task, getWorker, this.usageForTask(task.id));
  }

  report(
    getWorker: (workerId: string) => WorkerRecord | undefined,
    options: MetricsReportOptions = {},
  ): MetricsReport {
    this.assertReady();
    const sinceMs = options.since === undefined ? undefined : parseTime(options.since);
    const untilMs = options.until === undefined ? undefined : parseTime(options.until);
    if (options.since !== undefined && sinceMs === undefined) {
      throw new SupervisorError("BAD_REQUEST", "since must be an ISO 8601 timestamp");
    }
    if (options.until !== undefined && untilMs === undefined) {
      throw new SupervisorError("BAD_REQUEST", "until must be an ISO 8601 timestamp");
    }
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
      throw new SupervisorError("BAD_REQUEST", "since must not be after until");
    }
    const selected = [...this.tasks.values()]
      .filter((task) => {
        const created = parseTime(task.createdAt);
        if (created === undefined) return false;
        if (sinceMs !== undefined && created < sinceMs) return false;
        if (untilMs !== undefined && created > untilMs) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const allMetrics = selected.map((task) =>
      this.buildTaskMetrics(task, getWorker, this.usageForTask(task.id)),
    );
    const counts: Record<TaskStatus, number> = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      unknown: 0,
    };
    for (const item of allMetrics) counts[item.status] += 1;
    const allUsage = selected.flatMap((task) => this.usageForTask(task.id));
    const workerUsage = allUsage.filter((record) => record.role === "worker" && attributable(record));
    const parentAttributable = allUsage.filter(
      (record) => record.role === "parent_agent" && attributable(record),
    );
    const parentSessionLevel = allUsage.filter(
      (record) => record.role === "parent_agent" && record.attribution === "session_level",
    );
    const unverifiedUsage = allUsage.filter((record) => record.confidence === "unverified");
    const unverifiedTaskIds = new Set(unverifiedUsage.map((record) => record.taskId));
    const workerCount = allMetrics.reduce((sum, item) => sum + item.workers.length, 0);
    const endToEndValues: number[] = [];
    const workerRunValues: number[] = [];
    const waitingValues: number[] = [];
    let waitingPopulation = 0;
    for (const item of allMetrics) {
      if (item.timing.endToEndMs !== null) endToEndValues.push(item.timing.endToEndMs);
      item.workers.forEach((worker) => {
        if (worker.runMs !== undefined) workerRunValues.push(worker.runMs);
      });
      if (item.workers.length === 1) {
        waitingPopulation += 1;
        if (item.timing.waitingMs !== null) waitingValues.push(item.timing.waitingMs);
      }
    }
    const coverage = {
      tasks: allMetrics.length,
      tasksWithWorkers: allMetrics.filter((item) => item.workers.length > 0).length,
      tasksWithWorkerUsage: allMetrics.filter(
        (item) => summarizeUsage(item.usage, (record) => record.role === "worker" && attributable(record)).usableRecords > 0,
      ).length,
      tasksWithAttributableParentUsage: allMetrics.filter(
        (item) =>
          summarizeUsage(
            item.usage,
            (record) => record.role === "parent_agent" && attributable(record),
          ).usableRecords > 0,
      ).length,
      tasksWithSessionLevelParentUsage: allMetrics.filter(
        (item) =>
          summarizeUsage(
            item.usage,
            (record) => record.role === "parent_agent" && record.attribution === "session_level",
          ).usableRecords > 0,
      ).length,
      tasksWithAnyUsableUsage: allMetrics.filter(
        (item) => summarizeUsage(item.usage, (record) => attributable(record)).usableRecords > 0,
      ).length,
      tasksWithVerifiedUsage: allMetrics.filter(
        (item) =>
          summarizeUsage(item.usage, (record) => isUsable(record) && record.confidence === "verified")
            .usableRecords > 0,
      ).length,
      tasksWithUnverifiedUsage: allMetrics.filter(
        (item) => item.usage.some((record) => record.confidence === "unverified"),
      ).length,
      tasksWithMissingWorkers: allMetrics.filter((item) =>
        item.workers.some((worker) => worker.missing),
      ).length,
      workerUsageRecords: workerUsage.length,
      parentUsageRecords: allUsage.filter((record) => record.role === "parent_agent").length,
    };
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 500)));
    const warnings = new Set<string>();
    for (const warning of this.warnings) warnings.add(warning);
    const tasksWithoutParentUsage = allMetrics.length - coverage.tasksWithAttributableParentUsage;
    if (tasksWithoutParentUsage > 0) {
      warnings.add(
        `${tasksWithoutParentUsage} task(s) have no attributable parent-agent usage; main-agent cost is unknown for them.`,
      );
    }
    const tasksWithWorkersWithoutUsage = coverage.tasksWithWorkers - coverage.tasksWithWorkerUsage;
    if (tasksWithWorkersWithoutUsage > 0) {
      warnings.add(
        `${tasksWithWorkersWithoutUsage} task(s) have workers but no usable worker usage; worker cost is unknown for them.`,
      );
    }
    if (coverage.tasksWithSessionLevelParentUsage > 0) {
      warnings.add(
        `Session-level parent usage exists for ${coverage.tasksWithSessionLevelParentUsage} task(s); it is reported separately and excluded from task totals.`,
      );
    }
    if (unverifiedUsage.length > 0) {
      warnings.add(
        `${unverifiedUsage.length} usage record(s) are unverified and excluded from known totals.`,
      );
    }
    if (coverage.tasksWithMissingWorkers > 0) {
      warnings.add(
        `${coverage.tasksWithMissingWorkers} task(s) reference worker records that are no longer present; status or duration may be unknown.`,
      );
    }
    const orphanUsageTasks = [...this.usageByTask.keys()].filter((taskId) => !this.tasks.has(taskId));
    if (orphanUsageTasks.length > 0) {
      warnings.add(
        `${orphanUsageTasks.length} task id(s) have usage records but no task record; that usage is excluded from reports.`,
      );
    }
    warnings.add(
      "Phase 1-2 do not collect cost, first-pass acceptance, rework or intervention; worker completion is not acceptance.",
    );
    if (allUsage.length > 0) {
      warnings.add(
        "Runtime and manual token values are not billing-verified unless their confidence is verified.",
      );
    }
    const report: MetricsReport = {
      schemaVersion: METRICS_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      period: {
        since: options.since ?? null,
        until: options.until ?? null,
        field: "task.createdAt",
      },
      taskCount: allMetrics.length,
      workerCount,
      counts,
      usageCoverage: coverage,
      knownWorkerUsage: summarizeUsage(
        workerUsage,
        (record) => record.role === "worker" && attributable(record),
      ),
      knownParentUsage: summarizeUsage(
        parentAttributable,
        (record) => record.role === "parent_agent" && attributable(record),
      ),
      sessionLevelParentUsage: summarizeUsage(
        parentSessionLevel,
        (record) => record.role === "parent_agent" && record.attribution === "session_level",
      ),
      unverifiedUsage: {
        records: unverifiedUsage.length,
        taskCount: unverifiedTaskIds.size,
        note: "These records are excluded from known totals; all-zero runtime reports are unknown, not verified zero.",
      },
      durationStats: {
        endToEnd: durationSummary(endToEndValues, allMetrics.length),
        workerRun: durationSummary(workerRunValues, workerCount),
        waiting: durationSummary(waitingValues, waitingPopulation),
        note: "workerRun is the sum of per-worker run times, not wall-clock time. waiting is derived only for single-worker tasks and includes process startup and supervisor overhead.",
      },
      notTracked: { ...NOT_TRACKED },
      unknownFields: [...UNKNOWN_FIELDS],
      dataQualityWarnings: [...warnings].slice(0, MAX_WARNINGS),
    };
    if (options.includeTasks) {
      report.tasks = allMetrics.slice(0, limit);
      report.tasksTruncated = allMetrics.length > limit;
      if (report.tasksTruncated) {
        report.dataQualityWarnings = [
          ...report.dataQualityWarnings,
          `Task details were truncated to ${limit} of ${allMetrics.length} tasks; aggregate counts include all selected tasks.`,
        ].slice(0, MAX_WARNINGS);
      }
    }
    return report;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private usageForTask(taskId: string): UsageRecord[] {
    return [...(this.usageByTask.get(taskId) ?? [])]
      .flatMap((id) => {
        const record = this.usage.get(id);
        return record ? [record] : [];
      })
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
  }

  private buildTaskMetrics(
    task: TaskRecord,
    getWorker: (workerId: string) => WorkerRecord | undefined,
    usage: UsageRecord[],
  ): TaskMetrics {
    const workers: TaskWorkerMetrics[] = task.workerIds.map((workerId) => {
      const record = getWorker(workerId);
      if (!record) return { workerId, missing: true };
      const started = parseTime(record.startedAt);
      const ended = parseTime(record.endedAt);
      const runMs = started !== undefined && ended !== undefined && ended >= started ? ended - started : undefined;
      return {
        workerId,
        missing: false,
        runtime: record.runtime,
        status: record.status,
        createdAt: record.createdAt,
        ...(record.startedAt ? { startedAt: record.startedAt } : {}),
        ...(record.endedAt ? { endedAt: record.endedAt } : {}),
        ...(runMs !== undefined
          ? { runMs }
          : { runMsUnknownReason: record.startedAt ? "endedAt is missing or invalid" : "startedAt is missing" }),
      };
    });
    const status = deriveStatus(workers);
    const starts = workers
      .map((worker) => parseTime(worker.startedAt))
      .filter((value): value is number => value !== undefined);
    const ends = workers
      .map((worker) => parseTime(worker.endedAt))
      .filter((value): value is number => value !== undefined);
    const allTerminal =
      workers.length > 0 &&
      workers.every((worker) => !worker.missing && worker.status !== undefined && isTerminal(worker.status));
    const finishedAt =
      allTerminal && ends.length === workers.length ? new Date(Math.max(...ends)).toISOString() : null;
    const created = parseTime(task.createdAt);
    const endToEndMs =
      finishedAt !== null && created !== undefined && parseTime(finishedAt)! >= created
        ? parseTime(finishedAt)! - created
        : null;
    const workerRunMs =
      workers.length > 0 && workers.every((worker) => worker.runMs !== undefined)
        ? workers.reduce((sum, worker) => sum + worker.runMs!, 0)
        : undefined;
    const waitingMs =
      workers.length === 1 && endToEndMs !== null && workerRunMs !== undefined
        ? Math.max(0, endToEndMs - workerRunMs)
        : null;
    const warnings: string[] = [];
    const missing = workers.filter((worker) => worker.missing);
    if (missing.length > 0) {
      warnings.push(
        `Worker record(s) missing for ${missing.map((worker) => worker.workerId).join(", ")}; status and duration may be unknown.`,
      );
    }
    if (workers.length > 0 && workers.some((worker) => worker.runMs === undefined)) {
      warnings.push("At least one worker has no usable run duration.");
    }
    if (endToEndMs === null && allTerminal) {
      warnings.push("The task is terminal but its end-to-end duration is unknown.");
    }
    if (workers.length > 0) {
      const workerUsage = summarizeUsage(
        usage,
        (record) => record.role === "worker" && attributable(record),
      );
      if (workerUsage.usableRecords === 0) {
        warnings.push("No usable worker token usage was recorded; worker cost is unknown.");
      }
    }
    const parentUsage = summarizeUsage(
      usage,
      (record) => record.role === "parent_agent" && attributable(record),
    );
    if (parentUsage.usableRecords === 0) {
      warnings.push("No attributable parent-agent usage was recorded; main-agent cost is unknown.");
    }
    const sessionParent = summarizeUsage(
      usage,
      (record) => record.role === "parent_agent" && record.attribution === "session_level",
    );
    if (sessionParent.usableRecords > 0) {
      warnings.push(
        "Session-level parent usage is present but excluded from task-level totals.",
      );
    }
    const unverified = usage.filter((record) => record.confidence === "unverified");
    if (unverified.length > 0) {
      warnings.push(
        `${unverified.length} usage record(s) are unverified and excluded from known totals.`,
      );
    }
    if (workers.length === 0) {
      warnings.push("No worker is linked yet; this task is pending.");
    }
    return {
      schemaVersion: METRICS_SCHEMA_VERSION,
      task: clone(task),
      status,
      timing: {
        createdAt: task.createdAt,
        startedAt: starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : null,
        finishedAt,
        endToEndMs,
        waitingMs,
      },
      workers,
      usage: usage.map((record) => clone(record)),
      usageSummary: {
        worker: summarizeUsage(
          usage,
          (record) => record.role === "worker" && attributable(record),
        ),
        parentAttributable: parentUsage,
        parentSessionLevel: sessionParent,
        unverified: {
          records: unverified.length,
          note: "Excluded from known totals; unknown is not zero.",
        },
      },
      warnings,
      unknownFields: [...UNKNOWN_FIELDS],
    };
  }

  private addUsage(record: UsageRecord): void {
    this.usage.set(record.id, record);
    let ids = this.usageByTask.get(record.taskId);
    if (!ids) {
      ids = new Set();
      this.usageByTask.set(record.taskId, ids);
    }
    ids.add(record.id);
  }

  private append(kind: "task" | "usage", record: TaskRecord | UsageRecord): Promise<void> {
    const line = `${JSON.stringify(redactValue({ schemaVersion: METRICS_SCHEMA_VERSION, kind, [kind]: record }))}\n`;
    return this.enqueue(async () => {
      await ensureDir(path.dirname(this.file));
      await appendFile(this.file, line, { encoding: "utf8", mode: 0o600 });
    });
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(write, write);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private addWarning(message: string): void {
    if (this.warnings.includes(message)) return;
    if (this.warnings.length >= MAX_WARNINGS) return;
    this.warnings.push(message);
  }

  private assertReady(): void {
    if (!this.initialized) {
      throw new SupervisorError("UNSUPPORTED", "Metrics storage is not initialized");
    }
  }
}
