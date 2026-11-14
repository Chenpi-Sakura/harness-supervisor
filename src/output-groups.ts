/** Read-time grouping only; never changes persisted events or raw cursors. */
export interface OutputEvent {
  seq: number;
  ts: string;
  type: string;
  data?: Record<string, unknown>;
}

export function outputDeltaKind(event: OutputEvent, runtime?: string): string | undefined {
  if (!["qoder", "mcode", "dsh", "codex", "claude"].includes(runtime ?? "") || event.type !== "run.progress") return;
  const data = event.data;
  if (!data || !["thinking", "assistant_message"].includes(String(data.kind)) || typeof data.preview !== "string") return;
  // Unknown fields can represent snapshots or message boundaries. Fail closed.
  if (!Object.keys(data).every(key => ["kind", "preview"].includes(key))) return;
  return String(data.kind);
}

export function groupOutputEvents<T extends OutputEvent>(events: readonly T[], runtime?: string): T[][] {
  const groups: T[][] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    const last = previous?.at(-1);
    const kind = outputDeltaKind(event, runtime);
    if (previous && last && kind && event.seq === last.seq + 1 && outputDeltaKind(last, runtime) === kind) previous.push(event);
    else groups.push([event]);
  }
  return groups;
}

export function mergeOutputEvents<T extends OutputEvent>(events: readonly T[], runtime?: string): T[] {
  return groupOutputEvents(events, runtime).map(group => {
    const first = group[0]!;
    if (group.length === 1) return first;
    const last = group.at(-1)!;
    return { ...first, data: { ...first.data, preview: group.map(event => event.data!.preview).join(""),
      firstSeq: first.seq, lastSeq: last.seq, fragmentCount: group.length, lastTs: last.ts } };
  });
}
