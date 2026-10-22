import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isTerminal } from "./types.js";
import type { Store } from "./store.js";
import type { Notifier } from "./notify.js";
import type { Logger } from "./util/logger.js";
import { errorMessage } from "./errors.js";

/**
 * Deliberately explicit retention. Nothing is deleted automatically from the
 * lifecycle layer: `prune` is an opt-in maintenance operation with guards:
 *
 * - only terminal workers are candidates;
 * - a worker with an unacknowledged notification is never removed;
 * - `keep` newest terminal workers survive regardless of age;
 * - dry-run mode reports what would be removed without touching the disk.
 *
 * Harness session files are left alone unless `includeSessions` is set, because
 * they belong to the native runtime and may be resumed outside the supervisor.
 */
export interface PruneOptions {
  olderThanDays?: number;
  keep?: number;
  dryRun?: boolean;
  includeSessions?: boolean;
}

export interface PruneResult {
  dryRun: boolean;
  removed: string[];
  skipped: Array<{ workerId: string; reason: string }>;
  freedBytes: number;
}

const DEFAULT_OLDER_THAN_DAYS = 7;

export class Retention {
  private readonly store: Store;
  private readonly notifier: Notifier;
  private readonly logger: Logger;
  private readonly sessionsDir: string;

  constructor(options: { store: Store; notifier: Notifier; logger: Logger; sessionsDir: string }) {
    this.store = options.store;
    this.notifier = options.notifier;
    this.logger = options.logger;
    this.sessionsDir = path.resolve(options.sessionsDir);
  }

  async prune(options: PruneOptions = {}): Promise<PruneResult> {
    const olderThanDays = Math.max(0, options.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS);
    const keep = Math.max(0, Math.trunc(options.keep ?? 0));
    const dryRun = options.dryRun === true;
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    const unackedWorkers = this.notifier.unackedWorkerIds();

    const terminal = this.store
      .listWorkers()
      .filter((record) => isTerminal(record.status))
      .sort((a, b) => (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt));

    const protectedByKeep = new Set(terminal.slice(0, keep).map((record) => record.id));
    const result: PruneResult = { dryRun, removed: [], skipped: [], freedBytes: 0 };

    for (const record of terminal) {
      const endedAt = Date.parse(record.endedAt ?? record.updatedAt);
      if (protectedByKeep.has(record.id)) {
        result.skipped.push({ workerId: record.id, reason: "within keep window" });
        continue;
      }
      if (Number.isNaN(endedAt) || endedAt > cutoff) {
        result.skipped.push({ workerId: record.id, reason: "too recent" });
        continue;
      }
      if (unackedWorkers.has(record.id)) {
        result.skipped.push({ workerId: record.id, reason: "unacknowledged notification" });
        continue;
      }
      const dir = this.store.workerDir(record.id);
      const bytes = await directorySize(dir);
      if (!dryRun) {
        try {
          await rm(dir, { recursive: true, force: true });
          if (options.includeSessions) {
            await rm(path.join(this.sessionsDir, record.id), { recursive: true, force: true });
          }
          this.store.forgetWorker(record.id);
        } catch (error) {
          result.skipped.push({
            workerId: record.id,
            reason: `removal failed: ${errorMessage(error)}`,
          });
          this.logger.warn(`Failed to prune worker ${record.id}`, {
            error: errorMessage(error),
          });
          continue;
        }
      }
      result.removed.push(record.id);
      result.freedBytes += bytes;
    }

    if (!dryRun && result.removed.length > 0) {
      await this.store.flush().catch(() => undefined);
      this.logger.info("Pruned terminal workers", {
        removed: result.removed.length,
        freedBytes: result.freedBytes,
      });
    }
    return result;
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else {
      try {
        total += (await stat(full)).size;
      } catch {
        // Ignore unreadable files.
      }
    }
  }
  return total;
}