/**
 * Caller identity supplied by the MCP host on each tool call.
 *
 * Codex 0.161.0 sends `params._meta.threadId` (and the same value in
 * `_meta["x-codex-turn-metadata"].thread_id`) for every tools/call. This is the
 * only per-call identity source the MCP protocol exposes; a shared server
 * process environment or "most recent thread" is never used.
 *
 * The value is host-provided, not cryptographically signed. Treat it as a
 * routing hint from the trusted local MCP client: validate its shape and reject
 * conflicting duplicate fields, but do not describe it as an authentication
 * boundary.
 */

const THREAD_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isThreadUuid(value: unknown): value is string {
  return typeof value === "string" && THREAD_UUID.test(value);
}

export interface CallerThread {
  /** The Codex thread that issued this MCP tool call. */
  threadId: string;
  /** Present when the host supplies it; not required for binding. */
  sessionId?: string;
}

/**
 * Extract the current caller thread from an MCP request's `_meta`.
 * Returns undefined when the identity is absent or internally inconsistent;
 * callers must then fall back to an explicit target or the unbound default.
 */
export function callerThreadFromMeta(meta: unknown): CallerThread | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const record = meta as Record<string, unknown>;
  const threadId = record.threadId;
  if (!isThreadUuid(threadId)) return undefined;

  const turn = record["x-codex-turn-metadata"];
  if (turn && typeof turn === "object" && !Array.isArray(turn)) {
    const turnThread = (turn as Record<string, unknown>).thread_id;
    // The host duplicates the same id in two places. If they disagree, the
    // identity is not reliable; do not pick one silently.
    if (typeof turnThread === "string" && turnThread !== threadId) return undefined;
  }

  const sessionId = isThreadUuid(record.sessionId) ? record.sessionId : undefined;
  return sessionId ? { threadId, sessionId } : { threadId };
}

/**
 * Explains why present caller metadata was rejected. `undefined` means either
 * no caller metadata was supplied (normal for CLI/non-Codex clients) or the
 * metadata is valid. Used to warn when a malformed identity falls back to a
 * daemon default that happens to be wakeable.
 */
export function callerMetaRejection(meta: unknown): "invalid" | "conflict" | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const record = meta as Record<string, unknown>;
  if (record.threadId === undefined) return undefined;
  if (!isThreadUuid(record.threadId)) return "invalid";
  const turn = record["x-codex-turn-metadata"];
  if (turn && typeof turn === "object" && !Array.isArray(turn)) {
    const turnThread = (turn as Record<string, unknown>).thread_id;
    if (typeof turnThread === "string" && turnThread !== record.threadId) return "conflict";
  }
  return undefined;
}