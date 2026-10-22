export type SupervisorErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "UNSUPPORTED"
  | "HARNESS_ERROR"
  | "HARNESS_TIMEOUT"
  | "TIMEOUT"
  | "LIMIT_EXCEEDED"
  | "CONFLICT"
  | "UNCERTAIN"
  | "INTERNAL";

export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SupervisorErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function serializeError(error: unknown): {
  code: SupervisorErrorCode;
  message: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof SupervisorError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: "INTERNAL", message: errorMessage(error) };
}
