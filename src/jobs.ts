import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobEvidenceV1, JobObservation, WorkerJobLink } from "./types.js";
import { JobEvidenceSchema } from "./worker-result.js";

/** A running job with no evidence update for this long is reported stale. */
export const JOB_STALE_AFTER_MS = 30 * 60 * 1000;
/** Bound a single evidence read so status/wait cannot hang on a bad path. */
export const JOB_EVIDENCE_TIMEOUT_MS = 1_000;
const MAX_EVIDENCE_BYTES = 256 * 1024;

const LOCAL_LOCATIONS = new Set(["local", "localhost", os.hostname().toLowerCase()]);

export function isLocalJobLocation(location: string): boolean {
  return LOCAL_LOCATIONS.has(location.trim().toLowerCase());
}

/**
 * Only unscoped Workers can use their cwd as a root. A scoped Master
 * controls its spawn cwd, so its Workers use daemon-configured roots.
 */
export function jobEvidenceRoots(cwd?: string): string[] {
  const configured = (process.env.HARNESS_SUPERVISOR_JOB_EVIDENCE_DIRS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry));
  return cwd === undefined ? configured : [cwd, ...configured];
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

async function readBounded(
  requested: string,
  roots: string[],
  signal: AbortSignal,
): Promise<string> {
  const canonicalRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => undefined)));
  signal.throwIfAborted();
  const allowed = (file: string) => canonicalRoots.some((root) => root !== undefined && isWithin(root, file));
  if (!canonicalRoots.some(Boolean)) throw new Error("evidence path is outside the allowed roots");
  const file = await fs.realpath(requested);
  if (!allowed(file)) throw new Error("evidence path is outside the allowed roots");
  signal.throwIfAborted();

  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const handle = await fs.open(file, flags);
  try {
    signal.throwIfAborted();
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error("evidence path is not a file");
    // Check the object we actually opened before reading it. Linux exposes
    // its canonical path directly. Elsewhere check both path and file identity.
    const openedPath = await fs.realpath(process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : file);
    if (!allowed(openedPath)) throw new Error("evidence path is outside the allowed roots");
    if (process.platform !== "linux") {
      const current = await fs.stat(openedPath, { bigint: true });
      if (current.dev !== info.dev || current.ino !== info.ino || await fs.realpath(file) !== openedPath) {
        throw new Error("evidence file changed before it could be read");
      }
    }
    signal.throwIfAborted();
    if (info.size > MAX_EVIDENCE_BYTES) {
      throw new Error(`evidence file is ${info.size} bytes, over the ${MAX_EVIDENCE_BYTES}-byte cap`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = handle.createReadStream({
      start: 0,
      end: MAX_EVIDENCE_BYTES,
      autoClose: false,
      signal,
    });
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_EVIDENCE_BYTES) {
        stream.destroy();
        throw new Error(`evidence file grew over the ${MAX_EVIDENCE_BYTES}-byte cap`);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isFreshTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readJobEvidence(
  link: WorkerJobLink,
  cwd: string,
  options: { allowedRoots?: string[]; timeoutMs?: number } = {},
): Promise<{ evidence?: JobEvidenceV1; problem?: string }> {
  const roots = options.allowedRoots ?? jobEvidenceRoots(cwd);
  const requested = path.resolve(cwd, link.evidencePath);
  const timeoutMs = options.timeoutMs ?? JOB_EVIDENCE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutError = new Error("evidence read timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: string;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError);
        controller.abort(timeoutError);
      }, timeoutMs);
    });
    raw = await Promise.race([deadline, readBounded(requested, roots, controller.signal)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    if (error === timeoutError) {
      return { problem: `evidence read exceeded ${timeoutMs}ms` };
    }
    if (message === "evidence path is outside the allowed roots" || message === "evidence file changed before it could be read") {
      return { problem: message };
    }
    if (message === "evidence path is not a file") {
      return { problem: `evidence path is not a file: ${link.evidencePath}` };
    }
    if (message.startsWith("evidence file is ") || message.startsWith("evidence file grew ")) {
      return { problem: message };
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { problem: `evidence file not found: ${link.evidencePath}` };
    return { problem: `evidence file could not be read (${code ?? "error"})` };
  } finally {
    clearTimeout(timer);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { problem: "evidence file is not valid JSON" };
  }
  const parsed = JobEvidenceSchema.safeParse(payload);
  if (!parsed.success) {
    return { problem: `evidence file does not match v1 schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  const evidence = parsed.data as JobEvidenceV1;
  if (evidence.jobId !== link.jobId) {
    return {
      problem: `evidence file belongs to job "${evidence.jobId}", not "${link.jobId}"; refusing to treat it as this job's state`,
    };
  }
  return { evidence };
}

/**
 * Derive the job projection from execution-side evidence. This never starts,
 * retries or adopts a process, and never changes the Worker's lifecycle status.
 */
export function observeJob(
  link: WorkerJobLink,
  read: { evidence?: JobEvidenceV1; problem?: string },
  pidAlive: boolean | null,
): JobObservation {
  const base: JobObservation = {
    jobId: link.jobId,
    location: link.location,
    stage: link.stage,
    workerTurn: link.turn,
    state: "unknown",
    exitCode: null,
    exitCodeKnown: false,
    artifacts: [],
    missingArtifacts: [],
    evidencePath: link.evidencePath,
    pidAlive,
  };
  if (read.problem || !read.evidence) {
    return {
      ...base,
      problem: read.problem ?? "no evidence",
      inspectStage: link.stage,
    };
  }
  const evidence = read.evidence;
  const updatedMs = isFreshTimestamp(evidence.updatedAt);
  const stage = evidence.stage ?? link.stage;
  if (updatedMs === null) {
    return {
      ...base,
      evidenceState: evidence.state,
      stage,
      problem: `evidence updatedAt is not a valid timestamp: ${evidence.updatedAt}`,
      inspectStage: stage,
    };
  }
  const exitCode = typeof evidence.exitCode === "number" ? evidence.exitCode : null;
  const artifacts = evidence.artifacts ?? [];
  const listed = new Set(artifacts.map((artifact) => artifact.name ?? artifact.path));
  const missingArtifacts = (link.expectedArtifacts ?? []).filter((name) => !listed.has(name));
  const common = {
    ...base,
    stage,
    evidenceState: evidence.state,
    exitCode,
    exitCodeKnown: exitCode !== null,
    artifacts,
    missingArtifacts,
    updatedAt: evidence.updatedAt,
  };
  if (evidence.state === "running" && pidAlive === false) {
    return {
      ...common,
      state: "unknown",
      problem: "Recorded pid is not alive, but the evidence still says running; job state cannot be confirmed from pid alone.",
      inspectStage: stage,
    };
  }
  if (evidence.state === "running" && Date.now() - updatedMs > JOB_STALE_AFTER_MS) {
    return {
      ...common,
      state: "stale",
      problem: `evidence has not been updated for ${Math.round((Date.now() - updatedMs) / 60000)} minutes; the job may still be running`,
      inspectStage: stage,
    };
  }
  if (evidence.state === "failed" || (evidence.state === "exited" && exitCode !== null && exitCode !== 0)) {
    return { ...common, state: "failed" };
  }
  if (evidence.state === "exited") {
    return {
      ...common,
      state: "exited",
      ...(exitCode === null ? { problem: "evidence has no exitCode; exit status is unknown" } : {}),
    };
  }
  return { ...common, state: "running" };
}
