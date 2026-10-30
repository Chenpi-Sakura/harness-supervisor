/**
 * Native input requests are held by the runtime process, not by a database.
 * The supervisor owns the deadline for runtimes whose protocol accepts a
 * control response at any time (Qoder); a fixed five-minute window made a
 * slow parent review look like a failed call. The default can be changed with
 * a process environment variable, but only for runtimes where holding the
 * request longer has been verified.
 */
export const INPUT_TIMEOUT_ENV = "HARNESS_SUPERVISOR_INPUT_TIMEOUT_MS";

export function resolveInputTimeoutMs(defaultMs: number): number {
  const raw = process.env[INPUT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return defaultMs;
  const value = Number(raw);
  if (!Number.isFinite(value)) return defaultMs;
  const rounded = Math.trunc(value);
  if (rounded < 60_000 || rounded > 24 * 60 * 60 * 1000) return defaultMs;
  return rounded;
}