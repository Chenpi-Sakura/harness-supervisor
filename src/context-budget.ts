import type {
  PendingInput,
  ReadEventsResult,
  WorkerEvent,
  WorkerLastProgress,
  WorkerStatusResult,
  WorkerSummary,
  WorkerTimeline,
} from "./types.js";

/**
 * Context budget for the pull side.
 *
 * The push side already sends a pointer (0.4.3), but a caller that reads the
 * worker afterwards could still pull tens of kilobytes back into the model.
 * These helpers make the *default* read small and require an explicit opt-in
 * for the full payload.
 *
 * A budget is measured on the serialized JSON in UTF-8 bytes, never on a token
 * estimate: byte and char counts are only proxies for response size.
 */
export const STATUS_BUDGET_BYTES = 2 * 1024;
export const EVENTS_BUDGET_BYTES = 4 * 1024;
export const MAX_COMPACT_EVENTS = 10;
export const MAX_EVENT_SUMMARY_CHARS = 160;
export const MAX_PENDING_MESSAGE_CHARS = 400;
/**
 * Cap for the result/error preview of an explicit read that asked for the other
 * face in full. Such a read is exempt from the byte budget, so it cannot use
 * the budget as the preview length; this keeps the untouched face a preview.
 */
export const MAX_RESULT_PREVIEW_CHARS = 1000;
export const MAX_PENDING_OPTIONS = 20;
export const MAX_STATUS_REASON_CHARS = 240;
export const MAX_LAST_PROGRESS_CHARS = 400;
export const MAX_COMPACT_SEGMENTS = 3;
/** Server-side tail window used to find the newest lifecycle events. */
export const COMPACT_SCAN_WINDOW = 300;
export const COMPACT_SCAN_PAGES = 3;

const PROGRESS_TYPE = "run.progress";
const TRUNCATION_SUFFIX = /^(.*)\n\.\.\.\[truncated \d+ chars\]$/s;

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

export function isProgressEvent(event: WorkerEvent): boolean {
  return event.type === PROGRESS_TYPE;
}

export function lifecycleEvents(events: readonly WorkerEvent[]): WorkerEvent[] {
  return events.filter((event) => !isProgressEvent(event));
}

export interface TextPreview {
  preview: string;
  /** Length of the text this view was built from, not the original untruncated source. */
  chars: number;
  /** True when the caller does not hold every character of the source. */
  truncated: boolean;
  /** Set when the stored text itself was clipped by the supervisor's result cap. */
  storedTruncated?: boolean;
}

export function textPreview(text: string, maxChars: number): TextPreview {
  const chars = text.length;
  if (chars <= maxChars) return { preview: text, chars, truncated: false };
  return { preview: text.slice(0, Math.max(0, maxChars)), chars, truncated: true };
}

/**
 * A stored result may already be clipped by the supervisor's own size cap.
 * That is a different fact from "this view is shorter than the stored text":
 * `truncated` covers both, `storedTruncated` says the stored text itself is
 * incomplete and even an explicit full read cannot recover the rest.
 */
export function resultPreview(
  stored: { text: string; truncated: boolean },
  maxChars: number,
): TextPreview {
  const view = textPreview(stored.text, maxChars);
  return stored.truncated ? { ...view, truncated: true, storedTruncated: true } : view;
}

/**
 * Find the largest `chars` whose built value still fits `budgetBytes`.
 * `build` must be monotonic in `chars` (each extra char adds at least one byte).
 */
export function fitByChars(
  totalChars: number,
  build: (chars: number) => unknown,
  budgetBytes: number,
): { value: unknown; chars: number; bytes: number; overflow: boolean } {
  let low = 0;
  let high = Math.max(0, totalChars);
  let best: { value: unknown; chars: number; bytes: number } | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = build(mid);
    const bytes = jsonBytes(value);
    if (bytes <= budgetBytes) {
      best = { value, chars: mid, bytes };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best) return { ...best, overflow: false };
  const value = build(0);
  return { value, chars: 0, bytes: jsonBytes(value), overflow: true };
}

/** Event text is stored with a visible truncation suffix; compare the original prefix. */
function completionPrefix(event: WorkerEvent): string | null {
  const text = event.data?.text;
  if (typeof text !== "string") return null;
  if (event.data?.truncated !== true) return text;
  const match = TRUNCATION_SUFFIX.exec(text);
  return match ? match[1]! : text;
}

/**
 * A completion event that merely repeats the current run's `worker.result` must
 * not be sent twice. Historical completions (an older run, or an earlier seq
 * that a resume left behind) and unverifiable cases keep their text.
 */
function repeatsResult(event: WorkerEvent, worker: WorkerSummary): boolean {
  if (event.type !== "run.completed" || !worker.result || !worker.startedAt) return false;
  const startedMs = Date.parse(worker.startedAt);
  const eventMs = Date.parse(event.ts);
  if (!Number.isFinite(startedMs) || !Number.isFinite(eventMs) || eventMs < startedMs) {
    return false;
  }
  const prefix = completionPrefix(event);
  if (prefix === null) return false;
  return worker.result.text.startsWith(prefix);
}

function eventSummarySource(event: WorkerEvent): string | undefined {
  const data = event.data;
  if (!data) return undefined;
  for (const key of ["text", "error", "reason", "partialText", "preview", "detail"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (typeof data.method === "string") return data.method;
  if (typeof data.status === "string") return data.status;
  return undefined;
}

export interface CompactEvent {
  seq: number;
  ts: string;
  type: string;
  summary?: string;
}

/**
 * Compact lifecycle event: identifiers plus one short line. `summaryChars` is
 * the budget knob; callers shrink it until the batch fits.
 */
export function compactEvent(
  event: WorkerEvent,
  worker: WorkerSummary,
  summaryChars: number,
): CompactEvent {
  const out: CompactEvent = { seq: event.seq, ts: event.ts, type: event.type };
  const source = eventSummarySource(event);
  if (source === undefined || repeatsResult(event, worker)) return out;
  const preview = textPreview(source, summaryChars);
  if (preview.preview.trim()) out.summary = preview.preview;
  return out;
}

export interface PackedEvents {
  events: CompactEvent[];
  omitted: number;
  overflow: boolean;
}

/**
 * Pack the newest `limit` events into `budgetBytes`, shrinking summaries first
 * and dropping the oldest event only when even empty summaries do not fit.
 *
 * `wrap` lets the caller measure the *complete* response (worker, counters,
 * cursor) instead of the event array alone; budgeting only the array can leave
 * the final serialized object over budget.
 */
export function packCompactEvents(
  events: readonly WorkerEvent[],
  worker: WorkerSummary,
  options: {
    limit: number;
    budgetBytes: number;
    wrap?: (events: CompactEvent[], omitted: number) => unknown;
  },
): PackedEvents {
  const window = events.slice(Math.max(0, events.length - Math.max(0, options.limit)));
  const dropped = events.length - window.length;
  let kept = window;
  let omitted = dropped;
  const measure = (list: CompactEvent[]) => (options.wrap ? options.wrap(list, omitted) : list);
  for (;;) {
    const fitted = fitByChars(
      MAX_EVENT_SUMMARY_CHARS,
      (chars) => measure(kept.map((event) => compactEvent(event, worker, chars))),
      options.budgetBytes,
    );
    if (!fitted.overflow) {
      // Rebuild from the chosen summary length: `fitted.value` is the wrapped
      // envelope when `wrap` is set, not the event array.
      return {
        events: kept.map((event) => compactEvent(event, worker, fitted.chars)),
        omitted,
        overflow: false,
      };
    }
    if (kept.length === 0) return { events: [], omitted, overflow: true };
    kept = kept.slice(1);
    omitted += 1;
  }
}

/**
 * Bounded pending input: the question is a preview, options are capped but the
 * total is reported. Used by the default status view and by an explicit result
 * read, which must not also turn the input into full text.
 */
export function compactPendingInput(input: PendingInput | undefined, messageChars: number) {
  if (!input) return undefined;
  const options = input.options?.slice(0, MAX_PENDING_OPTIONS);
  return {
    requestId: input.requestId,
    ...(input.seq !== undefined ? { seq: input.seq } : {}),
    method: input.method,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.message !== undefined ? { message: textPreview(input.message, messageChars) } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(options !== undefined && (input.options?.length ?? 0) > options.length
      ? { optionsTotal: input.options!.length }
      : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

export function compactLastProgress(
  progress: WorkerLastProgress | undefined,
  maxChars: number,
  options: { omitFinalText?: boolean } = {},
): Record<string, unknown> | undefined {
  if (!progress) return undefined;
  if (progress.state === "none") {
    return {
      state: "none",
      ...(progress.scannedThroughSeq !== undefined
        ? { scannedThroughSeq: progress.scannedThroughSeq }
        : {}),
      ...(progress.note !== undefined ? { note: progress.note } : {}),
    };
  }
  const view = textPreview(progress.text ?? "", Math.min(maxChars, MAX_LAST_PROGRESS_CHARS));
  const common = {
    state: "available",
    ...(progress.seq !== undefined ? { seq: progress.seq } : {}),
    ...(progress.ts !== undefined ? { ts: progress.ts } : {}),
    ...(progress.type !== undefined ? { type: progress.type } : {}),
    ...(progress.kind !== undefined ? { kind: progress.kind } : {}),
    ...(progress.tool !== undefined ? { tool: progress.tool } : {}),
    ...(progress.isError !== undefined ? { isError: progress.isError } : {}),
    ...(progress.source !== undefined ? { source: progress.source } : {}),
    ...(progress.chars !== undefined ? { chars: progress.chars } : {}),
    ...(progress.originalChars !== undefined ? { originalChars: progress.originalChars } : {}),
    ...(progress.storedTruncated ? { storedTruncated: true } : {}),
    ...(progress.evidence !== undefined ? { evidence: progress.evidence } : {}),
  };
  if (
    options.omitFinalText &&
    progress.evidence === "final_report" &&
    progress.source === "final_report"
  ) {
    // The completed result face already carries this text; keep only the
    // event reference instead of spending the status budget twice.
    return { ...common, textInResult: true };
  }
  return {
    ...common,
    text: view.preview,
    truncated: progress.truncated === true || view.truncated,
  };
}

export function compactTimeline(
  timeline: WorkerTimeline | undefined,
  maxSegments = MAX_COMPACT_SEGMENTS,
): Record<string, unknown> | undefined {
  if (!timeline) return undefined;
  return {
    createdAt: timeline.createdAt,
    ...(timeline.firstStartedAt !== undefined ? { firstStartedAt: timeline.firstStartedAt } : {}),
    ...(timeline.currentRunStartedAt !== undefined
      ? { currentRunStartedAt: timeline.currentRunStartedAt }
      : {}),
    ...(timeline.endedAt !== undefined ? { endedAt: timeline.endedAt } : {}),
    resumeCount: timeline.resumeCount,
    segmentsTotal: timeline.segmentsTotal,
    segments: timeline.segments.slice(Math.max(0, timeline.segments.length - maxSegments)),
  };
}

interface CompactStatusOptions {
  budgetBytes: number;
  eventLimit: number;
}

/**
 * Compact status: identifiers, the lifecycle outcome, a bounded result preview
 * and at most `eventLimit` lifecycle events. Trim order is events first, then
 * the result/error preview; status and truncation markers are never dropped.
 */
export function compactStatus(
  result: WorkerStatusResult,
  options: CompactStatusOptions = { budgetBytes: STATUS_BUDGET_BYTES, eventLimit: MAX_COMPACT_EVENTS },
): Record<string, unknown> {
  const worker = result.worker;
  const body = worker.result?.text ?? worker.error ?? "";
  const candidates = lifecycleEvents(result.recentEvents);
  const wanted = Math.min(options.eventLimit, MAX_COMPACT_EVENTS);
  let events = candidates.slice(Math.max(0, candidates.length - wanted));
  let omitted = result.recentEvents.length - events.length;

  const build = (chars: number, list: WorkerEvent[]): Record<string, unknown> => {
    const reason =
      worker.statusReason !== undefined && worker.statusReason !== worker.error
        ? textPreview(worker.statusReason, Math.min(chars, MAX_STATUS_REASON_CHARS))
        : undefined;
    const out: Record<string, unknown> = {
      worker: {
        id: worker.id,
        runtime: worker.runtime,
        status: worker.status,
        lastSeq: worker.lastSeq,
        ...(worker.name !== undefined ? { name: worker.name } : {}),
        ...(worker.taskId !== undefined ? { taskId: worker.taskId } : {}),
        cwd: worker.cwd,
        ...(reason ? { statusReason: reason.preview } : {}),
        ...(worker.result
          ? { result: resultPreview(worker.result, chars) }
          : worker.error !== undefined
            ? { error: textPreview(worker.error, chars) }
            : {}),
        ...(worker.pendingInput
          ? { pendingInput: compactPendingInput(worker.pendingInput, MAX_PENDING_MESSAGE_CHARS) }
          : {}),
        resumeAvailable: worker.resumeAvailable,
      },
      recentEvents: list.map((event) => compactEvent(event, worker, Math.min(chars, MAX_EVENT_SUMMARY_CHARS))),
      ...(result.lastProgress
        ? {
            lastProgress: compactLastProgress(result.lastProgress, chars, {
              omitFinalText: worker.status === "completed" && worker.result !== undefined,
            }),
          }
        : {}),
      ...(result.timeline ? { timeline: compactTimeline(result.timeline) } : {}),
      ...(result.inputState ? { inputState: result.inputState } : {}),
    };
    if (omitted > 0) out.eventsOmitted = omitted;
    return out;
  };

  for (;;) {
    if (jsonBytes(build(0, events)) <= options.budgetBytes) break;
    if (events.length === 0) {
      const value = build(0, events);
      return { ...value, budgetExceeded: true };
    }
    events = events.slice(1);
    omitted += 1;
  }

  // When there is no result/error body the knob still has to cover the reason
  // and event summaries; starting at body.length (0) blanked both.
  const upper = Math.max(body.length, MAX_STATUS_REASON_CHARS);
  const fitted = fitByChars(upper, (chars) => build(chars, events), options.budgetBytes);
  const value = fitted.value as Record<string, unknown>;
  if (!fitted.overflow) return value;
  return { ...value, budgetExceeded: true };
}

/** One event by sequence number: full stored data, never budgeted. */
export function singleEventView(worker: WorkerSummary, event: WorkerEvent) {
  const data = event.data;
  const storedTruncated =
    data?.truncated === true ||
    data?.previewTruncated === true ||
    data?.detailTruncated === true ||
    data?.partialTextTruncated === true;
  return {
    worker: { id: worker.id, status: worker.status, lastSeq: worker.lastSeq },
    event,
    ...(storedTruncated
      ? {
          storedTruncated: true,
          note: "This stored event was clipped by the supervisor's storage cap. The runtime session file may contain the full text.",
        }
      : {}),
  };
}

export interface CompactEventsResult {
  worker: { id: string; status: string; lastSeq: number };
  events: CompactEvent[];
  eventsOmitted: number;
  progressOmitted: number;
  nextSeq: number;
  hasMore: boolean;
  budgetExceeded?: boolean;
}

/**
 * Compact event read.
 *
 * Without `sinceSeq` this is a tail snapshot: the newest lifecycle events are
 * what a caller needs after a wake-up, and scanning back from the tail avoids
 * returning the oldest 100 events (which are usually pure progress).
 * With `sinceSeq` it keeps strict cursor semantics and only filters progress.
 */
export async function readCompactEvents(
  read: (options: { sinceSeq: number; limit: number }) => Promise<ReadEventsResult>,
  options: { sinceSeq?: number; limit?: number; budgetBytes: number },
): Promise<CompactEventsResult> {
  const snapshot = options.sinceSeq === undefined;
  // The default snapshot is capped at MAX_COMPACT_EVENTS; an explicit cursor
  // keeps its own limit so existing incremental reads are not silently shrunk.
  const limit = snapshot
    ? Math.max(1, Math.min(options.limit ?? MAX_COMPACT_EVENTS, MAX_COMPACT_EVENTS))
    : Math.max(1, options.limit ?? 100);

  let scanned: ReadEventsResult | undefined;
  let collected: WorkerEvent[] = [];
  let progressOmitted = 0;

  if (options.sinceSeq !== undefined) {
    // Strict cursor reads must not over-fetch: the returned `nextSeq` is the
    // caller's next cursor, so the window has to match the requested limit.
    const result = await read({ sinceSeq: options.sinceSeq, limit });
    scanned = result;
    collected = [...result.events];
    progressOmitted = result.events.filter(isProgressEvent).length;
  } else {
    const head = await read({ sinceSeq: 0, limit: 1 });
    const lastSeq = head.worker.lastSeq;
    // Pages overlap at the boundary by one seq; dedupe by seq so a snapshot can
    // never return the same event twice (and never double-counts progress).
    const seen = new Map<number, WorkerEvent>();
    let start = Math.max(0, lastSeq - COMPACT_SCAN_WINDOW);
    for (let page = 0; page < COMPACT_SCAN_PAGES; page += 1) {
      // Each page is a fixed-size window. The IPC schema caps `limit` at 500,
      // so a window must never be expressed as `lastSeq - start + 1`.
      const window = await read({ sinceSeq: start, limit: COMPACT_SCAN_WINDOW + 1 });
      // The newest window supplies worker/nextSeq/hasMore; later pages only add
      // older lifecycle events, so scanning back must not overwrite it.
      scanned ??= window;
      for (const event of window.events) seen.set(event.seq, event);
      if (countLifecycle(seen) >= limit || start === 0) break;
      start = Math.max(0, start - COMPACT_SCAN_WINDOW);
    }
    const all = [...seen.values()].sort((a, b) => a.seq - b.seq);
    collected = lifecycleEvents(all);
    progressOmitted = all.length - collected.length;
  }
  if (!scanned) scanned = await read({ sinceSeq: 0, limit: 1 });
  const page = scanned;

  const envelope = (events: CompactEvent[], omitted: number): CompactEventsResult => ({
    worker: {
      id: page.worker.id,
      status: page.worker.status,
      lastSeq: page.worker.lastSeq,
    },
    events,
    eventsOmitted: omitted,
    progressOmitted,
    nextSeq: page.nextSeq,
    hasMore: page.hasMore,
  });

  const packed = packCompactEvents(lifecycleEvents(collected), scanned.worker, {
    limit,
    budgetBytes: options.budgetBytes,
    // Measure the whole response, not just the event array.
    wrap: envelope,
  });
  const value = envelope(packed.events, packed.omitted);
  return packed.overflow ? { ...value, budgetExceeded: true } : value;
}

function countLifecycle(events: Map<number, WorkerEvent>): number {
  let count = 0;
  for (const event of events.values()) if (!isProgressEvent(event)) count += 1;
  return count;
}