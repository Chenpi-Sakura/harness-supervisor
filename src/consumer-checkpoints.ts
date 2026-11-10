import path from "node:path";
import { atomicWriteJson, readJsonFile } from "./util/fsx.js";

export type ConsumerName = "notifications" | "metrics";

interface CheckpointFile {
  schemaVersion: 1;
  consumer: ConsumerName;
  seq: number;
}

/**
 * Per-worker, per-consumer position in the append-only event log. A checkpoint
 * only advances after the consumer's own data is flushed, so a crash between
 * the two steps replays events instead of losing them; consumers are idempotent.
 */
export async function readConsumerCheckpoint(
  workerDir: string,
  consumer: ConsumerName,
): Promise<number> {
  const file = path.join(workerDir, `${consumer}.checkpoint.json`);
  let parsed: Partial<CheckpointFile> | null;
  try {
    parsed = await readJsonFile<Partial<CheckpointFile>>(file);
  } catch {
    // A damaged checkpoint is not a reason to fail startup; re-reading the
    // history is safe because ingest is idempotent.
    return 0;
  }
  if (!parsed || parsed.schemaVersion !== 1 || parsed.consumer !== consumer) return 0;
  const seq = parsed.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return 0;
  return seq;
}

export async function writeConsumerCheckpoint(
  workerDir: string,
  consumer: ConsumerName,
  seq: number,
): Promise<void> {
  const payload: CheckpointFile = { schemaVersion: 1, consumer, seq };
  await atomicWriteJson(path.join(workerDir, `${consumer}.checkpoint.json`), payload);
}
