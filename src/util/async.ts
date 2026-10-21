import { randomBytes } from "node:crypto";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T | PromiseLike<T>) => void;
  private rejectFn!: (reason?: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  get isSettled(): boolean {
    return this.settled;
  }

  resolve(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFn(value);
  }

  reject(reason: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(reason);
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function newWorkerId(now = Date.now()): string {
  return `w-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
