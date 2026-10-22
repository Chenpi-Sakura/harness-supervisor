import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SupervisorClient } from "../../src/ipc/client.js";
import type {
  ReadEventsResult,
  WaitResult,
  WorkerStatus,
  WorkerStatusResult,
  WorkerSummary,
} from "../../src/types.js";
import { isPidAlive, sleep } from "../../src/util/async.js";

export const FAKE_ENTRY = fileURLToPath(new URL("../fixtures/fake-harness.js", import.meta.url));
export const FAKE_QODER_ENTRY = fileURLToPath(new URL("../fixtures/fake-qoder.js", import.meta.url));
export const DAEMON_ENTRY = fileURLToPath(new URL("../../src/daemon-entry.js", import.meta.url));
export const MCP_ENTRY = fileURLToPath(new URL("../../src/mcp.js", import.meta.url));
export const CLI_ENTRY = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

export interface TestDaemonOptions {
  fakeHarness?: boolean;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

export class TestDaemon {
  readonly stateDir: string;
  child: ChildProcess | null = null;
  client: SupervisorClient | null = null;
  output = "";

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  static async create(prefix = "hs-int-"): Promise<TestDaemon> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    return new TestDaemon(dir);
  }

  async start(options: TestDaemonOptions = {}): Promise<SupervisorClient> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HARNESS_SUPERVISOR_HOME: this.stateDir,
      HARNESS_SUPERVISOR_ABORT_TIMEOUT_MS: "3000",
      HARNESS_SUPERVISOR_CLOSE_GRACE_MS: "500",
      FAKE_PI_STEP_MS: "20",
      ...(options.fakeHarness === false ? {} : { HARNESS_SUPERVISOR_PI_ENTRY: FAKE_ENTRY }),
      ...(options.env ?? {}),
    };
    if (options.fakeHarness === false) {
      delete env.HARNESS_SUPERVISOR_PI_ENTRY;
    }
    const child = spawn(process.execPath, [DAEMON_ENTRY, "--state-dir", this.stateDir], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      this.output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.output += chunk.toString("utf8");
    });
    const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Daemon exited before ready (${child.exitCode}):\n${this.output}`);
      }
      const client = new SupervisorClient({ stateDir: this.stateDir, autoStart: false });
      try {
        await client.connect();
        this.client = client;
        return client;
      } catch (error) {
        lastError = error;
        client.close();
        await sleep(100);
      }
    }
    throw new Error(
      `Daemon did not become ready: ${(lastError as Error)?.message ?? "unknown"}\n${this.output}`,
    );
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.shutdown();
      } catch {
        // Fall through to a fresh shutdown connection.
      }
      this.client.close();
      this.client = null;
    }
    if (this.child && this.child.exitCode === null) {
      try {
        const client = await connectExisting(this.stateDir, 3000);
        await client.shutdown();
        client.close();
      } catch {
        // Fall through to process termination.
      }
    }
    await this.waitForExit(8000);
  }

  async kill(): Promise<void> {
    this.client?.close();
    this.client = null;
    if (!this.child || this.child.exitCode !== null) return;
    try {
      process.kill(this.child.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
    await this.waitForExit(5000);
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    await Promise.race([
      new Promise<void>((resolve) => this.child!.once("exit", () => resolve())),
      sleep(timeoutMs),
    ]);
    if (this.child.exitCode === null) {
      try {
        process.kill(this.child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

export async function connectExisting(stateDir: string, timeoutMs = 10_000): Promise<SupervisorClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new SupervisorClient({ stateDir, autoStart: false });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      client.close();
      await sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not connect to daemon");
}

export async function makeWorkspace(prefix = "hs-work-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(dir, "nested"), { recursive: true });
  return dir;
}

export async function spawnWorker(
  client: SupervisorClient,
  cwd: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<WorkerSummary> {
  return client.request<WorkerSummary>(
    "spawn",
    { runtime: "pi", cwd, prompt, ...extra },
    { timeoutMs: 60_000 },
  );
}

export async function statusOf(
  client: SupervisorClient,
  workerId: string,
): Promise<WorkerStatusResult> {
  return client.request<WorkerStatusResult>("status", { workerId, recentEvents: 100 });
}

export async function eventsOf(
  client: SupervisorClient,
  workerId: string,
  sinceSeq = 0,
): Promise<ReadEventsResult> {
  return client.request<ReadEventsResult>("events", {
    workerId,
    sinceSeq,
    limit: 500,
  });
}

export async function waitTerminal(
  client: SupervisorClient,
  workerId: string,
  timeoutMs = 30_000,
  sinceSeq = 0,
): Promise<WaitResult> {
  return client.request<WaitResult>(
    "wait",
    { workerId, sinceSeq, timeoutMs, until: "terminal" },
    { timeoutMs: timeoutMs + 10_000 },
  );
}

export async function waitTerminalLong(
  client: SupervisorClient,
  workerId: string,
  overallTimeoutMs: number,
  sinceSeq = 0,
): Promise<WaitResult> {
  const deadline = Date.now() + overallTimeoutMs;
  let cursor = sinceSeq;
  let last: WaitResult | null = null;
  while (Date.now() < deadline) {
    const remaining = Math.max(1000, Math.min(110_000, deadline - Date.now()));
    last = await waitTerminal(client, workerId, remaining, cursor);
    cursor = last.nextSeq;
    if (last.terminal) return last;
  }
  return last ?? waitTerminal(client, workerId, 1000, cursor);
}

export async function waitForStatus(
  client: SupervisorClient,
  workerId: string,
  statuses: WorkerStatus[],
  timeoutMs = 10_000,
): Promise<WorkerSummary> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await statusOf(client, workerId);
    if (statuses.includes(status.worker.status)) return status.worker;
    await sleep(25);
  }
  const status = await statusOf(client, workerId);
  throw new Error(
    `Timed out waiting for status ${statuses.join(",")}; current=${status.worker.status}`,
  );
}

export async function waitForEvent(
  client: SupervisorClient,
  workerId: string,
  type: string,
  timeoutMs = 10_000,
): Promise<WaitResult> {
  return client.request<WaitResult>(
    "wait",
    {
      workerId,
      sinceSeq: 0,
      timeoutMs,
      until: "event",
      types: [type],
    },
    { timeoutMs: timeoutMs + 10_000 },
  );
}

export async function waitPidDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(50);
  }
  throw new Error(`PID ${pid} did not exit within ${timeoutMs}ms`);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export function eventTypes(events: Array<{ type: string }>): string[] {
  return events.map((event) => event.type);
}
