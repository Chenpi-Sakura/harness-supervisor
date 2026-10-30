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
export const PI_INPUT_TIMEOUT_ENV = "HARNESS_SUPERVISOR_PI_INPUT_TIMEOUT_MS";

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

/**
 * Opt-in cap for runtimes whose native dialog already carries its own
 * `timeout`. An unset/zero value means "do not add an HS deadline"; the
 * native timeout, if any, is forwarded unchanged.
 */
export function resolveOptionalInputTimeoutMs(specificEnv: string, defaultMs = 0): number {
  return parseTimeout(process.env[specificEnv], defaultMs);
}

/** Native timeout wins only when it is stricter than the opt-in HS cap. */
export function pickInputTimeoutMs(
  nativeMs: number | undefined,
  capMs: number,
): number | undefined {
  if (capMs > 0) return nativeMs !== undefined ? Math.min(nativeMs, capMs) : capMs;
  return nativeMs;
}