import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { NotificationRecord } from "./types.js";

/** Accept only the exact short pointer format emitted by HS, not quoted reports. */
export function parseNotificationPointer(prompt: unknown): { id: string; workerId: string; seq: number; kind: string } | undefined {
  if (typeof prompt !== "string" || prompt.length > 512) return;
  const match = /^\[harness-supervisor\] (w-[A-Za-z0-9-]{1,100}) (completed|failed|cancelled|needs_input|crashed|detached) seq=([1-9][0-9]*) \| (?:read worker_status for result|read worker_status; answer current pendingInput)$/.exec(prompt);
  if (!match) return;
  const workerId = match[1]!;
  const seq = Number(match[3]);
  if (!Number.isSafeInteger(seq)) return;
  return { id: `${workerId}#${seq}`, workerId, seq, kind: match[2]! };
}

export interface NotificationGateResult {
  block: boolean;
  id?: string;
  checkedAt?: string;
  ackAt?: string;
}

/** Read durable ACK truth at the host's pre-submit boundary. Never starts a daemon. */
export async function checkNotificationPrompt(input: unknown, stateDir: string): Promise<NotificationGateResult> {
  if (!input || typeof input !== "object") return { block: false };
  const event = input as Record<string, unknown>;
  if (event.hook_event_name !== "UserPromptSubmit" || typeof event.session_id !== "string") return { block: false };
  const pointer = parseNotificationPointer(event.prompt);
  if (!pointer) return { block: false };
  const source = createReadStream(path.join(stateDir, "notifications.jsonl"), {
    encoding: "utf8", signal: AbortSignal.timeout(1500),
  });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  let record: NotificationRecord | undefined;
  try {
    // Append history may have several rows per id. Last valid row wins, exactly
    // as in Notifier.loadRecords; a torn tail must not invent an ACK.
    for await (const line of lines) {
      if (!line.includes(pointer.id)) continue;
      try {
        const parsed = JSON.parse(line.replace(/^\uFEFF/, "")) as NotificationRecord;
        if (parsed?.id === pointer.id) record = parsed;
      } catch { /* An incomplete/crashed write is not proof of an ACK. */ }
    }
  } catch {
    return { block: false }; // Unknown/offline/corrupt state must not hide real work.
  } finally {
    lines.close();
    source.destroy();
  }
  if (!record || record.workerId !== pointer.workerId || record.seq !== pointer.seq || record.kind !== pointer.kind ||
      record.target?.channel !== "codex-queue" || record.target.codexThreadId !== event.session_id) return { block: false };
  const checkedAt = new Date().toISOString();
  const ackAt = typeof record.ackAt === "string" && Number.isFinite(Date.parse(record.ackAt)) ? record.ackAt : undefined;
  // Record what this gate checked, not a fictitious UI consumedAt/model result.
  const result = { block: Boolean(ackAt), id: pointer.id, checkedAt, ...(ackAt ? { ackAt } : {}) };
  await writeFile(path.join(stateDir, "notification-gate.jsonl"), JSON.stringify({
    ...result, threadId: event.session_id,
    ...(typeof event.turn_id === "string" ? { turnId: event.turn_id } : {}),
    decision: ackAt ? "block_acknowledged" : "allow_unacknowledged",
  }) + "\n", { flag: "a", mode: 0o600, signal: AbortSignal.timeout(250) }).catch(() => undefined);
  return result;
}
