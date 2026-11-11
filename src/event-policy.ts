import type { WorkerEvent, WorkerEventType } from "./types.js";

/**
 * Events a Production caller may see. Everything else is execution detail:
 * run.progress, run.usage, worker.session and run.message_sent stay available
 * to Development and through the CLI. A new event type stays hidden until it
 * is deliberately added here.
 */
export const PRODUCTION_EVENT_TYPES: ReadonlySet<WorkerEventType> = new Set<WorkerEventType>([
  "worker.starting",
  "worker.started",
  "worker.exited",
  "worker.crashed",
  "worker.orphaned",
  "worker.interrupted",
  "worker.resumed",
  "worker.continued",
  "worker.resume_failed",
  "worker.admin",
  "run.accepted",
  "run.started",
  "run.error",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.needs_input",
  "run.input_answered",
]);

export function isProductionEventType(type: string): boolean {
  return PRODUCTION_EVENT_TYPES.has(type as WorkerEventType);
}

export interface ProductionEventFilterResult {
  events: WorkerEvent[];
  /** Non-progress events withheld by the production allowlist. */
  eventsOmitted: number;
  progressOmitted: number;
}

/** Filter one batch and report both kinds of omission separately. */
export function filterProductionEvents(events: readonly WorkerEvent[]): ProductionEventFilterResult {
  const kept: WorkerEvent[] = [];
  let eventsOmitted = 0;
  let progressOmitted = 0;
  for (const event of events) {
    if (event.type === "run.progress") {
      progressOmitted += 1;
      continue;
    }
    if (!isProductionEventType(event.type)) {
      eventsOmitted += 1;
      continue;
    }
    kept.push(event);
  }
  return { events: kept, eventsOmitted, progressOmitted };
}
