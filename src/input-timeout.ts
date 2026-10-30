/**
 * Native input requests are held by the runtime process, not by a database.
 * The supervisor owns the deadline for runtimes whose protocol accepts a
 * control response at any time (Qoder and MiniMax Code); a fixed five-minute
 * window made a slow parent review look like a failed call. A runtime-specific
 * environment variable takes precedence over the shared one; the host's own
 * wait limit remains the runtime's responsibility and is documented separately.
 */
export const INPUT_TIMEOUT_ENV = "HARNESS_SUPERVISOR_INPUT_TIMEOUT_MS";
export const MCODE_INPUT_TIMEOUT_ENV = "HARNESS_SUPERVISOR_MCODE_INPUT_TIMEOUT_MS";

function parseTimeout(raw: string | undefined, defaultMs: number): number {
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const value = Number(raw);
  if (!Number.isFinite(value)) return defaultMs;
  const rounded = Math.trunc(value);
  if (rounded < 60_000 || rounded > 24 * 60 * 60 * 1000) return defaultMs;
  return rounded;
}

export function resolveInputTimeoutMs(defaultMs: number, specificEnv?: string): number {
  const specific = specificEnv ? process.env[specificEnv] : undefined;
  if (specific !== undefined && specific.trim() !== "") {
    return parseTimeout(specific, defaultMs);
  }
  return parseTimeout(process.env[INPUT_TIMEOUT_ENV], defaultMs);
}