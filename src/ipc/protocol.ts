import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SupervisorError } from "../errors.js";

export const IPC_VERSION = 1;
export const DEFAULT_STATE_DIR = path.join(os.homedir(), ".harness-supervisor");

export function resolveStateDir(explicit?: string): string {
  return path.resolve(explicit ?? process.env.HARNESS_SUPERVISOR_HOME ?? DEFAULT_STATE_DIR);
}

export function ipcEndpoint(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 20);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\harness-supervisor-${hash}`;
  }
  const candidate = path.join(resolved, "supervisor.sock");
  if (Buffer.byteLength(candidate) < 100) return candidate;
  return path.join(os.tmpdir(), `harness-supervisor-${hash}.sock`);
}

export function randomToken(): string {
  return randomBytes(32).toString("hex");
}

export function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export const WorkerStatusSchema = z.enum([
  "starting",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
  "crashed",
  "orphaned",
  "interrupted",
]);

const ConfigFields = {
  model: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(200).optional(),
  tools: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  maxDurationMs: z.number().int().min(1000).max(86_400_000).optional(),
  extraArgs: z.array(z.string().max(2000)).max(30).optional(),
};

const RequestIdField = {
  /**
   * Optional client-supplied idempotency key. Requests without it keep the
   * legacy "not idempotent" behaviour.
   */
  requestId: z.string().min(1).max(200).optional(),
};

export const NotifyTargetSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("none") }).strict(),
  z.object({ channel: z.literal("codex-queue"), codexThreadId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{5,120}$/) }).strict(),
]);

const NotifyTargetField = { notifyTarget: NotifyTargetSchema.optional() };

const SpawnSchema = z
  .object({
    runtime: z.string().min(1).max(50).optional(),
    cwd: z.string().min(1).max(4096),
    prompt: z.string().min(1).max(256 * 1024),
    name: z.string().min(1).max(200).optional(),
    taskId: z.string().min(1).max(120).optional(),
    ...ConfigFields,
    ...RequestIdField,
    ...NotifyTargetField,
  })
  .strict();

const ResumeSchema = z
  .object({
    workerId: z.string().min(1).max(200),
    prompt: z.string().min(1).max(256 * 1024),
    ...ConfigFields,
    ...RequestIdField,
    ...NotifyTargetField,
  })
  .strict();

const WorkerIdSchema = z.string().min(1).max(200);

const UiResponseSchema = z.union([
  z.object({ value: z.string().max(64 * 1024) }).strict(),
  z.object({ confirmed: z.boolean() }).strict(),
  z.object({ cancelled: z.literal(true) }).strict(),
]);

export const METHOD_SCHEMAS = {
  spawn: SpawnSchema,
  resume: ResumeSchema,
  status: z
    .object({ workerId: WorkerIdSchema, recentEvents: z.number().int().min(0).max(100).optional() })
    .strict(),
  list: z
    .object({
      statuses: z.array(WorkerStatusSchema).max(20).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  events: z
    .object({
      workerId: WorkerIdSchema,
      sinceSeq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  wait: z
    .object({
      workerId: WorkerIdSchema,
      sinceSeq: z.number().int().min(0).optional(),
      timeoutMs: z.number().int().min(0).max(120_000).optional(),
      until: z.enum(["terminal", "event"]).optional(),
      types: z.array(z.string().min(1).max(100)).max(30).optional(),
    })
    .strict(),
  send: z
    .object({
      workerId: WorkerIdSchema,
      message: z.string().min(1).max(64 * 1024),
      mode: z.enum(["steer", "follow-up"]).optional(),
      ...RequestIdField,
    })
    .strict(),
  answer: z
    .object({
      workerId: WorkerIdSchema,
      requestId: z.string().min(1).max(500),
      response: UiResponseSchema,
    })
    .strict(),
  cancel: z
    .object({
      workerId: WorkerIdSchema,
      timeoutMs: z.number().int().min(500).max(60_000).optional(),
    })
    .strict(),
  info: z.object({}).strict(),
  notifications: z
    .object({
      state: z.enum(["pending", "delivered", "failed", "all"]).optional(),
      workerId: WorkerIdSchema.optional(),
      limit: z.number().int().min(1).max(500).optional(),
      /** Optional view across pending/delivered/failed; legacy default stays unchanged. */
      unacknowledgedOnly: z.boolean().optional(),
    })
    .strict(),
  notification_ack: z
    .object({
      ids: z.array(z.string().min(1).max(300)).min(1).max(200),
      by: z.string().min(1).max(100).optional(),
    })
    .strict(),
  notification_target: z
    .object({
      channel: z.enum(["none", "codex-queue"]).optional(),
      codexThreadId: z.string().min(1).max(200).nullable().optional(),
    })
    .strict(),
  notification_target_get: z.object({}).strict(),
  notification_retry: z
    .object({
      states: z.array(z.enum(["pending", "delivered", "failed"])).min(1).max(3).optional(),
    })
    .strict(),
  metrics_task_create: z
    .object({
      taskId: z.string().min(1).max(120).optional(),
      title: z.string().min(1).max(200),
      category: z.string().min(1).max(50).optional(),
      parentSessionRef: z.string().min(1).max(300).optional(),
      createdBy: z.enum(["mcp", "cli", "manual", "import"]).optional(),
    })
    .strict(),
  metrics_task_show: z.object({ taskId: z.string().min(1).max(120) }).strict(),
  metrics_report: z
    .object({
      since: z.string().min(1).max(100).optional(),
      until: z.string().min(1).max(100).optional(),
      includeTasks: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),
  metrics_usage_record: z
    .object({
      taskId: z.string().min(1).max(120),
      role: z.enum(["parent_agent", "worker"]),
      workerId: z.string().min(1).max(200).optional(),
      usageId: z.string().min(1).max(100).optional(),
      provider: z.string().min(1).max(200).optional(),
      modelId: z.string().min(1).max(200).optional(),
      harness: z.string().min(1).max(100).optional(),
      inputTokens: z.number().int().min(0).max(1_000_000_000_000_000).nullable().optional(),
      outputTokens: z.number().int().min(0).max(1_000_000_000_000_000).nullable().optional(),
      cacheReadTokens: z.number().int().min(0).max(1_000_000_000_000_000).nullable().optional(),
      cacheWriteTokens: z.number().int().min(0).max(1_000_000_000_000_000).nullable().optional(),
      reportedTotalTokens: z.number().int().min(0).max(1_000_000_000_000_000).nullable().optional(),
      usageSource: z.enum(["manual", "host_reported", "imported", "estimated"]).optional(),
      attribution: z.enum(["exact", "incremental", "session_level", "estimated"]).optional(),
      confidence: z.enum(["verified", "partial", "unverified", "unknown"]).optional(),
      note: z.string().max(500).optional(),
    })
    .strict(),
  ping: z.object({}).strict(),
  prune: z
    .object({
      olderThanDays: z.number().int().min(0).max(3650).optional(),
      keep: z.number().int().min(0).max(10000).optional(),
      dryRun: z.boolean().optional(),
      includeSessions: z.boolean().optional(),
    })
    .strict(),
  shutdown: z.object({ reason: z.string().max(200).optional() }).strict(),
} as const;

export type IpcMethod = keyof typeof METHOD_SCHEMAS;

export interface IpcHello {
  v: typeof IPC_VERSION;
  type: "hello";
  token: string;
}

export interface IpcHelloResponse {
  v: typeof IPC_VERSION;
  type: "hello_response";
  ok: boolean;
  error?: { code: string; message: string };
}

export interface IpcRequest {
  v: typeof IPC_VERSION;
  type: "request";
  id: string;
  method: IpcMethod;
  params?: unknown;
}

export interface IpcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IpcResponse {
  v: typeof IPC_VERSION;
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: IpcError;
}

export interface EndpointInfo {
  endpoint: string;
  pid: number;
  stateDir: string;
  startedAt: string;
  version: string;
}

const HelloSchema = z
  .object({
    v: z.literal(IPC_VERSION),
    type: z.literal("hello"),
    token: z.string().min(1).max(500),
  })
  .strict();

const EnvelopeSchema = z
  .object({
    v: z.literal(IPC_VERSION),
    type: z.literal("request"),
    id: z.string().min(1).max(200),
    method: z.string().min(1).max(100),
    params: z.unknown().optional(),
  })
  .strict();

export function parseHello(value: unknown): IpcHello | null {
  const parsed = HelloSchema.safeParse(value);
  return parsed.success ? (parsed.data as IpcHello) : null;
}

export function parseEnvelope(
  value: unknown,
): { envelope: IpcRequest; params: unknown } | { error: SupervisorError } {
  const parsed = EnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return {
      error: new SupervisorError("BAD_REQUEST", `Invalid IPC request: ${parsed.error.message}`),
    };
  }
  const method = parsed.data.method as IpcMethod;
  if (!(method in METHOD_SCHEMAS)) {
    return { error: new SupervisorError("BAD_REQUEST", `Unknown IPC method: ${method}`) };
  }
  const paramsParsed = METHOD_SCHEMAS[method].safeParse(parsed.data.params ?? {});
  if (!paramsParsed.success) {
    return {
      error: new SupervisorError("BAD_REQUEST", `Invalid params for ${method}: ${paramsParsed.error.message}`),
    };
  }
  return {
    envelope: {
      v: IPC_VERSION,
      type: "request",
      id: parsed.data.id,
      method,
      params: paramsParsed.data,
    },
    params: paramsParsed.data,
  };
}
