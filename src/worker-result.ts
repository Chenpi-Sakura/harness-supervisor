import { z } from "zod";
import { SupervisorError } from "./errors.js";
import type {
  ResultExecutionEvidence,
  StructuredResultV1,
  WorkerRecord,
  WorkerTurnResult,
} from "./types.js";

/**
 * One structured result per Turn. The schema is intentionally small: large
 * detail belongs in an artifact file, not in the MCP response or the record.
 */
export const MAX_RESULT_REPORT_CHARS = 8 * 1024;
export const MAX_RESULT_SUMMARY_CHARS = 2000;
export const MAX_RESULT_TURNS_KEPT = 20;

const ShortText = z.string().min(1).max(500);
const ScalarValue = z.union([z.string().max(500), z.number(), z.boolean()]);
const ScalarMap = z.record(z.string().min(1).max(64), ScalarValue);

export const StructuredResultSchema = z
  .object({
    v: z.literal(1),
    summary: z.string().min(1).max(MAX_RESULT_SUMMARY_CHARS),
    inputs: ScalarMap.optional(),
    config: ScalarMap.optional(),
    thresholds: z
      .array(
        z
          .object({
            name: ShortText,
            requested: z.string().max(200).optional(),
            adopted: z.string().max(200).optional(),
            unit: z.string().max(50).optional(),
            met: z.boolean().optional(),
            note: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    items: z
      .array(
        z
          .object({
            name: ShortText,
            status: z.enum(["passed", "failed", "skipped", "unknown"]),
            detail: z.string().max(1000).optional(),
            artifact: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    anomalies: z.array(z.string().max(1000)).max(20).optional(),
    artifacts: z
      .array(
        z
          .object({
            name: z.string().max(200).optional(),
            path: z.string().min(1).max(500),
            note: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
  })
  .strict();

export const MAX_JOB_LINKS = 10;

export const JobAttachSchema = z
  .object({
    jobId: z.string().min(1).max(200),
    location: z.string().min(1).max(200),
    stage: z.string().max(200).optional(),
    expectedArtifacts: z.array(z.string().min(1).max(500)).max(20).optional(),
    evidencePath: z.string().min(1).max(500),
    pid: z.number().int().positive().optional(),
  })
  .strict();

export const JobEvidenceSchema = z
  .object({
    v: z.literal(1),
    jobId: z.string().min(1).max(200),
    state: z.enum(["running", "exited", "failed"]),
    updatedAt: z.string().min(1).max(64),
    exitCode: z.number().int().optional(),
    stage: z.string().max(200).optional(),
    artifacts: StructuredResultSchema.shape.artifacts,
    detail: z.string().max(2000).optional(),
  })
  .strict();

export type JobAttachInput = z.infer<typeof JobAttachSchema>;

/** Ordered-key JSON so equal reports compare byte-for-byte. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function parseStructuredResult(input: unknown): StructuredResultV1 {
  const parsed = StructuredResultSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupervisorError("BAD_REQUEST", `Invalid structured result: ${parsed.error.message}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const report = parsed.data as StructuredResultV1;
  const size = Buffer.byteLength(JSON.stringify(report), "utf8");
  if (size > MAX_RESULT_REPORT_CHARS) {
    throw new SupervisorError(
      "BAD_REQUEST",
      `Structured result is ${size} bytes, over the ${MAX_RESULT_REPORT_CHARS}-byte cap; move detail into an artifact file`,
      { size, cap: MAX_RESULT_REPORT_CHARS },
    );
  }
  return report;
}

export function parseJobAttach(input: unknown): JobAttachInput {
  const parsed = JobAttachSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupervisorError("BAD_REQUEST", `Invalid job link: ${parsed.error.message}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

/** Current Turn for new records; legacy records infer from harness turns. */
export function currentTurn(record: WorkerRecord): number {
  if (typeof record.turn === "number" && record.turn >= 1) return Math.floor(record.turn);
  return Math.max(1, Math.floor(record.stats?.turns ?? 0));
}

/**
 * Execution evidence comes only from HS's own run record. The Worker's report
 * can never set or override it.
 */
export function executionEvidence(record: WorkerRecord): ResultExecutionEvidence {
  if (record.exit) {
    return {
      exitCode: record.exit.code,
      signal: record.exit.signal,
      observedAt: record.exit.at,
      source: "worker_process",
    };
  }
  return { exitCode: null, signal: null, source: "missing" };
}

export function sameReport(left: StructuredResultV1, right: StructuredResultV1): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function trimResults(results: WorkerTurnResult[]): WorkerTurnResult[] {
  return results.length > MAX_RESULT_TURNS_KEPT ? results.slice(results.length - MAX_RESULT_TURNS_KEPT) : results;
}

/** Compact shape shared by status/wait; full detail stays behind a get call. */
export function compactTurnResult(result: WorkerTurnResult): Record<string, unknown> {
  const report = result.report;
  return {
    turn: result.turn,
    submittedAt: result.submittedAt,
    v: report.v,
    summary: report.summary,
    execution: result.execution,
    thresholds: (report.thresholds ?? []).map((threshold) => ({
      name: threshold.name,
      requested: threshold.requested ?? null,
      adopted: threshold.adopted ?? null,
      unit: threshold.unit ?? null,
      met: threshold.met ?? null,
    })),
    counts: {
      inputs: Object.keys(report.inputs ?? {}).length,
      config: Object.keys(report.config ?? {}).length,
      items: report.items?.length ?? 0,
      anomalies: report.anomalies?.length ?? 0,
      artifacts: report.artifacts?.length ?? 0,
    },
    items: (report.items ?? []).map((item) => ({
      name: item.name,
      status: item.status,
      artifact: item.artifact ?? null,
    })),
    anomalies: report.anomalies ?? [],
    artifacts: report.artifacts ?? [],
    detailAvailable: true,
  };
}
