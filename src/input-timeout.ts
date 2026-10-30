/**
 * Native input requests are held by the runtime process, not by a database.
 * The supervisor owns the deadline for runtimes whose protocol accepts a
 * control response at any time.
 *
 * Resolution order for every runtime:
 *   1. runtime-specific environment variable
 *   2. shared HARNESS_SUPERVISOR_INPUT_TIMEOUT_MS
 *   3. the built-in shared default (30 minutes)
 *
 * Pi additionally treats 0 as "no HS deadline"; its native dialog timeout, if
 * any, still applies and the stricter value wins. The other runtimes require
 * 60s..24h.
 */
export const INPUT_TIMEOUT_ENV = "HARNESS_SUPERVISOR_INPUT_TIMEOUT_MS";
export const QODER_INPUT_TIMEOUT_ENV = "HARNESS_SUPERVISOR_QODER_INPUT_TIMEOUT_MS";
export const MCODE_INPUT_TIMEOUT_ENV = "HARNESS_SUPERVISOR_MCODE_INPUT_TIMEOUT_MS";
export const PI_INPUT_TIMEOUT_ENV = "HARNESS_SUPERVISOR_PI_INPUT_TIMEOUT_MS";
export const DEFAULT_INPUT_TIMEOUT_MS = 30 * 60_000;

const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function readTimeout(raw: string | undefined, allowDisabled: boolean): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  const rounded = Math.trunc(value);
  if (allowDisabled && rounded === 0) return 0;
  if (rounded < MIN_TIMEOUT_MS || rounded > MAX_TIMEOUT_MS) return undefined;
  return rounded;
}

export interface RuntimeTimeoutOptions {
  specificEnv: string;
  defaultMs: number;
  /** Pi accepts 0 as "do not add an HS deadline". */
  allowDisabled?: boolean;
}

export function resolveRuntimeInputTimeoutMs(options: RuntimeTimeoutOptions): number {
  const specific = readTimeout(process.env[options.specificEnv], options.allowDisabled === true);
  if (specific !== undefined) return specific;
  const shared = readTimeout(process.env[INPUT_TIMEOUT_ENV], options.allowDisabled === true);
  if (shared !== undefined) return shared;
  return options.defaultMs;
}

/** Native timeout wins only when it is stricter than the opt-in HS cap. */
export function pickInputTimeoutMs(
  nativeMs: number | undefined,
  capMs: number,
): number | undefined {
  if (capMs > 0) return nativeMs !== undefined ? Math.min(nativeMs, capMs) : capMs;
  return nativeMs;
}