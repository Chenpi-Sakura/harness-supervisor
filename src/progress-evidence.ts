import type {
  WorkerEvent,
  WorkerLastProgress,
  WorkerRecord,
  WorkerRunSegment,
  WorkerStatus,
  WorkerTimeline,
} from "./types.js";

const TRUNCATION_SUFFIX = /^(.*)\n\.\.\.\[truncated (\d+) chars\]$/s;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type ProgressText = {
  text: string;
  source: WorkerLastProgress["source"];
  field: "preview" | "detail" | "text" | "partialText";
};

function textOf(event: WorkerEvent): ProgressText | undefined {
  const data = event.data;
  if (!data) return undefined;
  switch (event.type) {
    case "run.completed":
      return nonEmpty(data.text)
        ? { text: data.text, source: "final_report", field: "text" }
        : undefined;
    case "run.failed":
    case "run.cancelled":
      return nonEmpty(data.partialText)
        ? { text: data.partialText, source: "partial_text", field: "partialText" }
        : undefined;
    case "run.progress": {
      const kind = typeof data.kind === "string" ? data.kind : "";
      if (kind === "assistant_message" && nonEmpty(data.preview)) {
        return { text: data.preview, source: "assistant_message", field: "preview" };
      }
      if (kind === "thinking" && nonEmpty(data.preview)) {
        return { text: data.preview, source: "thinking", field: "preview" };
      }
      if (kind === "tool_end") {
        if (nonEmpty(data.preview)) {
          return { text: data.preview, source: "tool_output", field: "preview" };
        }
        if (nonEmpty(data.detail)) {
          return { text: data.detail, source: "tool_output", field: "detail" };
        }
      }
      if (
        (kind === "retry" || kind === "retry_failed" || kind === "compaction_start") &&
        nonEmpty(data.detail)
      ) {
        return { text: data.detail, source: "diagnostic", field: "detail" };
      }
      if (nonEmpty(data.text)) {
        return { text: data.text, source: "assistant_message", field: "text" };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Newest event a caller can use as "where the worker got to". Tool logs and
 * empty lifecycle markers are skipped, and a terminal event only qualifies when
 * it carries `partialText`; the termination reason alone is not progress.
 */
export function findLastProgressEvent(events: readonly WorkerEvent[]): WorkerEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && textOf(event)) return event;
  }
  return undefined;
}

export function buildLastProgress(
  event: WorkerEvent | undefined,
  options: { maxChars: number; scannedThroughSeq?: number },
): WorkerLastProgress {
  if (!event) {
    return {
      state: "none",
      ...(options.scannedThroughSeq !== undefined
        ? { scannedThroughSeq: options.scannedThroughSeq }
        : {}),
      note: "No stored progress text was found. This does not mean the worker made no tool calls.",
    };
  }
  const picked = textOf(event);
  if (!picked) {
    return {
      state: "none",
      ...(options.scannedThroughSeq !== undefined
        ? { scannedThroughSeq: options.scannedThroughSeq }
        : {}),
      note: "No stored progress text was found. This does not mean the worker made no tool calls.",
    };
  }
  const match = TRUNCATION_SUFFIX.exec(picked.text);
  const data = event.data ?? {};
  const metadata: Record<string, unknown> =
    picked.field === "preview"
      ? { chars: data.previewChars, truncated: data.previewTruncated }
      : picked.field === "detail"
        ? { chars: data.detailChars, truncated: data.detailTruncated }
        : picked.field === "partialText"
          ? { chars: data.partialTextChars, truncated: data.partialTextTruncated }
          : { chars: data.originalChars, truncated: data.truncated };
  const storedTruncated = metadata.truncated === true || match !== null;
  const text = match ? match[1]! : picked.text;
  const originalChars =
    typeof metadata.chars === "number"
      ? metadata.chars
      : match
        ? text.length + Number(match[2])
        : undefined;
  const view = textPreview(text, options.maxChars);
  return {
    state: "available",
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    ...(typeof data.kind === "string" ? { kind: data.kind } : {}),
    ...(typeof data.tool === "string" ? { tool: data.tool } : {}),
    ...(typeof data.isError === "boolean" ? { isError: data.isError } : {}),
    source: picked.source,
    text: view.text,
    chars: text.length,
    ...(originalChars !== undefined ? { originalChars } : {}),
    truncated: view.truncated,
    ...(storedTruncated ? { storedTruncated: true } : {}),
    evidence: picked.source === "final_report" ? "final_report" : "partial_progress",
  };
}

function textPreview(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars)), truncated: true };
}

const RUN_START = "run.accepted";
const RUN_ENDS: Partial<Record<WorkerEvent["type"], WorkerStatus>> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
  "worker.crashed": "crashed",
  "worker.interrupted": "interrupted",
  "worker.orphaned": "orphaned",
};

/**
 * Build run segments from lifecycle events. `run.accepted` is the event that
 * proves a prompt was accepted; adapter `run.started` can precede it, so it is
 * not used as the segment boundary.
 */
export function buildTimeline(
  record: WorkerRecord,
  events: readonly WorkerEvent[],
  options: { maxSegments: number },
): WorkerTimeline {
  const segments: WorkerRunSegment[] = [];
  let open: WorkerRunSegment | undefined;
  for (const event of events) {
    if (event.type === RUN_START) {
      open = {
        startSeq: event.seq,
        startedAt: event.ts,
        open: true,
      };
      segments.push(open);
      continue;
    }
    const outcome = RUN_ENDS[event.type];
    if (outcome && open) {
      open.endSeq = event.seq;
      open.endedAt = event.ts;
      open.outcome = outcome;
      open.open = false;
      open = undefined;
    }
  }
  const limited = segments.slice(Math.max(0, segments.length - Math.max(1, options.maxSegments)));
  return {
    createdAt: record.createdAt,
    firstStartedAt: record.firstStartedAt ?? segments[0]?.startedAt ?? record.startedAt,
    ...(record.startedAt !== undefined ? { currentRunStartedAt: record.startedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    resumeCount: record.resumeCount,
    segments: limited,
    segmentsTotal: segments.length,
    note:
      "currentRunStartedAt is the start of the latest run segment, not the original task start. Use firstStartedAt for the original start and segments for per-run timing.",
  };
}