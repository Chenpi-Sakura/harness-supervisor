/**
 * Shared baseline for extra arguments accepted by Supervisor and Pi.
 * Adapters may reject additional runtime-specific options.
 */
const RESERVED_ARGS = new Set([
  "--mode",
  "--session",
  "--session-dir",
  "--session-id",
  "--continue",
  "--resume",
  "--print",
  "--help",
  "--no-session",
  "--api-key",
]);

export function validateExtraArgs(extraArgs: string[] | undefined): void {
  if (!extraArgs) return;
  for (const arg of extraArgs) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new Error("extraArgs must be strings without NUL bytes");
    }
    const name = arg.split("=", 1)[0] ?? arg;
    if (RESERVED_ARGS.has(name)) {
      throw new Error(`extraArgs may not override supervisor-managed option ${name}`);
    }
  }
}
